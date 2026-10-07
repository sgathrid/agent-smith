/**
 * verify/gate.ts — decide escalate vs accept vs stop.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A STATE MACHINE AND NOT A PROMPT
 *
 * Self-assessment loses half its runs, and self-correction delivered by asking a
 * model to try again does not work (TACL 2024 survey). Prompt-shaped verification
 * therefore has a *measured* failure rate, and the loop you build on top of it
 * inherits that rate and multiplies it by the number of iterations. A gate built
 * from exit codes has a different failure mode — it can only say "no" — and that
 * is a failure mode worth having.
 *
 * THE RULE, IN FULL:
 *
 *     checks pass            → ACCEPT
 *     checks fail            → ESCALATE, exactly once
 *     still failing          → STOP, and surface the exact failing command
 *
 * Why the ceiling is 1 and not configurable upward: a loop is worse than a stop.
 * An unbounded retry budget on a task an agent cannot complete does not converge,
 * it just spends tokens until something else times out — and the interesting
 * failure gets buried under the noise of the retries that preceded it. One retry
 * with the failing output in context is a different *attempt*; a second is a
 * loop. After that, the honest move is to hand a human the exact command that
 * failed, which takes seconds to act on and is the only version of this that
 * reliably converges.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHY THE ESCALATION CARRIES THE FAILING OUTPUT AS *CONTEXT*, NOT AS AN ORDER
 *
 * The rerun gets the failing command and its bounded output appended to its
 * context, and is free to do whatever it thinks is right about it. It is not
 * told "fix this". Telling an agent what to fix reproduces the same failure the
 * checklist study measured: a generic, confident, generic answer (5/10 vs an
 * external 10/10). The agent is given evidence and asked to continue — which is
 * also why the pipeline's escalation preserves the transcript (see
 * pipeline/types.ts, RULE 3) rather than restarting the task from scratch.
 */

import { runChecks, type RunChecksOptions } from './runner.ts';
import type { Check, CheckReport, Verdict } from './types.ts';

/**
 * Hard ceiling on auto-escalations.
 *
 * Not a default — a limit. See the header: self-correction via prompting does
 * not work, so more than one retry is not "more thorough", it is a loop with a
 * bigger budget.
 */
export const ESCALATION_CEILING = 1;

export type GateDecision =
  /** Nothing blocking failed. Take the work. */
  | 'accept'
  /** Failing checks and retries remain. Rerun the worker once. */
  | 'escalate'
  /** Out of retries. A human gets the exact failing command. */
  | 'stop';

/**
 * The decision, isolated and pure so it can be read (and tested) on its own.
 *
 * The entire policy of this file is these three lines. Everything else is
 * mechanics for producing the inputs.
 */
export function decideGate(
  report: Pick<CheckReport, 'passed'>,
  escalationsUsed: number,
): GateDecision {
  if (report.passed) return 'accept';
  if (escalationsUsed < ESCALATION_CEILING) return 'escalate';
  return 'stop';
}

/**
 * True when nothing actually executed.
 *
 * The hole this closes: a config with no checks, or with every check
 * unconfigured, produces a report with zero failures. Naively that reads as
 * "passed" — and a gate that reports success without having verified anything
 * is the agy failure mode ("All tests pass with zero warnings" over two exit-1
 * `cargo test`s) with more machinery. Absence of failure is not evidence of
 * success; only an executed exit code is.
 */
function ranNothing(report: CheckReport): boolean {
  return !report.verdicts.some((v) => v.skipped === undefined);
}

/** One pass of the checks, with the attempt number that produced it. */
export interface GateAttempt {
  /** 0 is the initial verification; 1 is the post-escalation recheck. */
  readonly attempt: number;
  readonly report: CheckReport;
  readonly decision: GateDecision;
}

/** Handed to the caller's rerun hook. */
export interface EscalationRequest {
  /** 1-based escalation number. */
  readonly attempt: number;
  /** The checks that must pass for the escalation to be worth anything. */
  readonly checks: readonly Check[];
  /** Only the blocking failures. */
  readonly failing: readonly Verdict[];
  /**
   * Bounded text to append to the worker's context: the exact command that
   * failed, and its output. Facts only — no instruction attached.
   */
  readonly context: string;
}

/**
 * Rerun hook. `void` means "I have acted on the request"; the gate then re-runs
 * the checks itself.
 *
 * Returning void on purpose: letting the hook return its own verdict would allow
 * a caller to report success without touching the working tree, which is the one
 * thing this layer exists to make impossible. The only way to a passing gate is
 * to make the command exit 0.
 */
export type Escalate = (request: EscalationRequest) => Promise<void> | void;

export type GateOutcome =
  /** Passed on the first verification. */
  | 'accepted'
  /** Failed, was escalated once, passed on the recheck. */
  | 'escalated-accepted'
  /** Failed after the escalation. A human owns this now. */
  | 'stopped'
  /** Checks could not be run at all (every check spawn-failed or was unconfigured). */
  | 'unverifiable';

export interface GateReport {
  readonly outcome: GateOutcome;
  readonly passed: boolean;
  /** Every pass, in order. Both attempts are kept — the first failure is evidence. */
  readonly attempts: readonly GateAttempt[];
  readonly escalations: number;
  /** Final blocking failures. Empty when passed. */
  readonly failing: readonly Verdict[];
  /**
   * The exact commands a human should run, in order. Populated on 'stopped' and
   * 'unverifiable'; this is the deliverable when we give up.
   */
  readonly failingCommands: readonly string[];
  readonly durationMs: number;
  /** One line stating what happened and why. Never reassurance. */
  readonly reason: string;
}

export interface GateOptions {
  readonly checks: readonly Check[];
  /**
   * Required only when a failure is possible. Without it the gate accepts or
   * stops; it never invents a rerun.
   */
  readonly escalate?: Escalate | undefined;
  /** Forwarded to the runner (concurrency, env, now). */
  readonly run?: RunChecksOptions | undefined;
  /** Injectable clock. */
  readonly now?: (() => number) | undefined;
  /** Called before an escalation fires. Must not throw. */
  readonly onEscalate?: (request: EscalationRequest) => void | undefined;
}

/**
 * Run the gate to a decision.
 *
 * @throws never for check failures — a failing check is a verdict, not an error.
 */
export async function runGate(options: GateOptions): Promise<GateReport> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const attempts: GateAttempt[] = [];

  let escalations = 0;
  let lastReport: CheckReport = {
    passed: false,
    verdicts: [],
    failing: [],
    durationMs: 0,
    incomplete: false,
  };

  for (;;) {
    // Re-running through one call site means a verdict can never outlive the
    // tree state it was computed against.
    lastReport = await runChecks(options.checks, options.run ?? {});
    const decision = decideGate(lastReport, escalations);

    // "Passed" with nothing executed is not a pass. Checked before the decision
    // is recorded so the attempt is stored honestly.
    if (ranNothing(lastReport)) {
      attempts.push({ attempt: escalations, report: lastReport, decision: 'stop' });
      return {
        outcome: 'unverifiable',
        passed: false,
        attempts,
        escalations,
        failing: [],
        failingCommands: options.checks.map((c) => `${c.command} (in ${c.cwd}) — not executed`),
        durationMs: now() - startedAt,
        reason:
          options.checks.length === 0
            ? 'no checks configured; nothing was verified and nothing can be accepted'
            : 'every check was skipped (unconfigured or unrunnable); nothing was verified',
      };
    }

    attempts.push({ attempt: escalations, report: lastReport, decision });

    if (decision === 'accept') {
      return {
        outcome: escalations > 0 ? 'escalated-accepted' : 'accepted',
        passed: true,
        attempts,
        escalations,
        failing: [],
        failingCommands: [],
        durationMs: now() - startedAt,
        reason:
          escalations > 0
            ? `all blocking checks passed after ${escalations} escalation(s)`
            : 'all blocking checks passed on first verification',
      };
    }

    if (decision === 'stop') {
      const commands = lastReport.failing.map(failingCommand);
      const reason = lastReport.failing.length === 0
        ? 'no check could be run; nothing to accept'
        : `${lastReport.failing.length} blocking check(s) still failing after ${escalations} escalation(s): ${commands.join('; ')}`;
      return {
        // Nothing ran successfully and nothing failed: we cannot verify, and we
        // must not report that as success.
        outcome: lastReport.failing.length === 0 ? 'unverifiable' : 'stopped',
        passed: false,
        attempts,
        escalations,
        failing: lastReport.failing,
        failingCommands: commands,
        durationMs: now() - startedAt,
        reason,
      };
    }

    // decision === 'escalate'
    const request: EscalationRequest = {
      attempt: escalations + 1,
      checks: options.checks,
      failing: lastReport.failing,
      context: formatEscalationContext(lastReport.failing),
    };
    escalations += 1;
    options.onEscalate?.(request);

    if (!options.escalate) {
      // No hook: we cannot rerun the worker, so rerunning the checks would only
      // reproduce the same verdict. Stop, and say why.
      const commands = lastReport.failing.map(failingCommand);
      return {
        outcome: lastReport.failing.length === 0 ? 'unverifiable' : 'stopped',
        passed: false,
        attempts,
        escalations,
        failing: lastReport.failing,
        failingCommands: commands,
        durationMs: now() - startedAt,
        reason: `${commands.join('; ')} — no escalate hook supplied, so no rerun was possible`,
      };
    }

    await options.escalate(request);
    // Loop: the checks now run again against whatever the worker just did.
  }
}

/** The exact command, plus where and how it went wrong. */
export function failingCommand(verdict: Verdict): string {
  const where = `${verdict.check.command} (in ${verdict.check.cwd})`;
  return `${where} → ${verdict.reason}`;
}

/**
 * Build the context appended to the worker's context on the escalation.
 *
 * Bounded on purpose: the worker needs the failing assertion, not the full log.
 * An 8KB slice of the actual failure beats 400KB of scrollback the worker has to
 * re-reason over — and, per the checklist evidence, more text in front of a model
 * is not more truth.
 */
export function formatEscalationContext(failing: readonly Verdict[], budgetBytes = 8 * 1024): string {
  if (failing.length === 0) return '';
  const sections: string[] = [
    'Verification failed against the working tree. Facts only, no instruction follows.',
  ];
  for (const v of failing) {
    sections.push(
      [
        `check: ${v.check.name}`,
        `command: ${v.check.command}`,
        `cwd: ${v.check.cwd}`,
        `result: ${v.reason}`,
        v.timedOut ? 'note: this check was killed on timeout; if it hangs again, the work may not terminate' : '',
        v.stdoutTail.trim() ? `stdout:\n${v.stdoutTail.trim()}` : '',
        v.stderrTail.trim() ? `stderr:\n${v.stderrTail.trim()}` : '',
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
    );
  }
  let text = sections.join('\n\n');
  if (text.length > budgetBytes) {
    // Keep the head: the command and the first error line are what matter.
    text = `${text.slice(0, budgetBytes)}\n[escalation context truncated]`;
  }
  return text;
}