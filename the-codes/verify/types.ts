/**
 * verify/types.ts — vocabulary for executable verification gates.
 *
 * WHY THIS LAYER EXISTS (the evidence, in full, because it justifies every
 * design choice below):
 *
 *  1. A real agy job reported **"All tests pass with zero warnings"** while its
 *     own log tail showed `cargo test` exiting **CODE 1 — twice**. The model
 *     summarized its own run, the summary was fluent and confident, and it was
 *     wrong about a fact that was sitting in its own transcript. This is the
 *     single most important failure mode in an agent pipeline: **silent, fluent,
 *     wrong handoff**. A gate that reads prose inherits it exactly.
 *
 *  2. External checklist scored 10/10; the agent's own generic self-check scored
 *     **5/10 (p = 0.0325)**. The self-check was not merely worse, it was
 *     reliably distinguishable from the real thing.
 *
 *  3. Self-assessment loses half its runs, and **self-correction via prompting
 *     does not work** (TACL 2024 survey). So: do not ask a model whether the work
 *     is good, and do not ask it to fix its own work by asking nicely.
 *
 * The design consequence, applied everywhere below:
 *
 *   - A verdict is a BOOLEAN derived from an exit code. Never a judgment.
 *   - Checks run against the WORKING TREE, not against anything a model wrote
 *     about the working tree.
 *   - Output is bounded (8KB tails, like agy-staff) so a verdict cannot smuggle
 *     a wall of prose past the orchestrator.
 */

/**
 * What a check must satisfy to pass.
 *
 * `exit0` is the default and the right answer for almost every real check: a
 * compiler exits 0 or it did not compile, and no amount of interpretation should
 * sit between the tool and the verdict.
 */
export type Expectation =
  /** exit code 0 (the default for typecheck/test/lint). */
  | { readonly kind: 'exit0' }
  /** one of an explicit set of non-zero codes. For tools that use exit codes as categories. */
  | { readonly kind: 'exitN'; readonly codes: readonly number[] }
  /**
   * Arbitrary predicate, for the checks that genuinely cannot be expressed as an
   * exit code (e.g. "output contains no `TODO(unverified)`").
   *
   * Deliberately last-resort: a custom predicate is code someone has to review,
   * and the whole point of this layer is to remove review from the loop. If you
   * reach for `custom`, ask whether the tool has an exit code you are ignoring.
   */
  | { readonly kind: 'custom'; readonly describe: string; readonly test: (o: CheckObservation) => boolean };

/**
 * One executable gate.
 *
 * A command plus how to interpret it. There is no "model" field and there will
 * not be one: a check that consults a model is not a check (see the header).
 */
export interface Check {
  /** Stable identifier. Appears in the escalation context and the human report. */
  readonly name: string;
  /**
   * Shell command line, run via the platform shell.
   *
   * A string, not argv, because real check commands are pipelines
   * (`npm test -- --runInBand`). Commands come from config, never from a model's
   * output.
   */
  readonly command: string;
  /** Absolute directory to run in. Resolve against the job's working tree. */
  readonly cwd: string;
  /**
   * Hard wall-clock limit. On expiry the child is killed — by process GROUP, see
   * runner.ts — and the verdict is `passed: false`.
   */
  readonly timeoutMs: number;
  readonly expect?: Expectation | undefined;
  /** Extra env for the child. Merged over the parent env, never replacing it wholesale. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Max bytes of each stream retained in the verdict. Default 8KB. */
  readonly maxTailBytes?: number | undefined;
  /**
   * Whether failing this check should block acceptance.
   *
   * Default true. Only for checks that are informational by intent — an
   * `allowFail` check still runs and still reports, so a human sees it, but it
   * does not manufacture a failure nobody asked for.
   */
  readonly blocking?: boolean | undefined;
}

/** Raw execution facts handed to a custom predicate. */
export interface CheckObservation {
  readonly check: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/** Why a check could not run at all, as distinct from "it ran and failed". */
export type CheckSkipReason =
  /** No command configured (e.g. the repo has no `lint` script). */
  | 'not-configured'
  /** The working directory does not exist. */
  | 'missing-cwd'
  /** Spawn itself failed: no such binary, permission denied, … */
  | 'spawn-failed';

/**
 * The result of one check. This is what the orchestrator consumes.
 *
 * It is a boolean plus the evidence for the boolean. The orchestrator branches on
 * `passed` and NOTHING ELSE — in particular it never parses `stdoutTail` to
 * decide whether things are fine. That is the whole design: the temptation to
 * read the prose is exactly the failure this layer was built to prevent.
 */
export interface Verdict {
  readonly passed: boolean;
  readonly check: Check;
  /** null when the process was killed by a signal or never started. */
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  /** Bounded tail of stdout. Truncation is marked in the text. */
  readonly stdoutTail: string;
  /** Bounded tail of stderr. */
  readonly stderrTail: string;
  /** True when either tail was cut. A silently truncated log is a lie by omission. */
  readonly truncated: boolean;
  readonly durationMs: number;
  /** Set when the check never ran. Absent means "it ran". */
  readonly skipped?: CheckSkipReason | undefined;
  /** Human-readable reason for the verdict. Facts, not reassurance. */
  readonly reason: string;
  /**
   * True when this verdict should block acceptance. Mirrors `Check.blocking`.
   * Present so a caller reading only the verdict still sees the policy.
   */
  readonly blocking: boolean;
}

/** Aggregate over a set of verdicts. */
export interface CheckReport {
  readonly passed: boolean;
  readonly verdicts: readonly Verdict[];
  /** Only the failures that block. Empty when `passed`. */
  readonly failing: readonly Verdict[];
  readonly durationMs: number;
  /** True when at least one check was configured away rather than run. */
  readonly incomplete: boolean;
}