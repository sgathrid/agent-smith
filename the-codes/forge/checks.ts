/**
 * forge/checks.ts — executable acceptance, shared by pipeline stages and spawn_job.
 *
 * Completion proves execution only. Acceptance is a separate fact, derived from
 * exit codes of checks run against the working tree (verify/runner.ts), never
 * from anything the worker wrote.
 *
 * Rules (`evaluateAcceptance`):
 *   - job did not succeed (failed/canceled)  -> 'rejected'  (checks are NOT run:
 *     a failed job's tree is not a candidate for acceptance)
 *   - no checks configured                    -> 'unchecked'
 *   - job succeeded, all blocking checks pass -> 'accepted'
 *   - job succeeded, a blocking check fails   -> 'rejected'
 *   Non-blocking checks (blocking: false) are reported but never gate.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runChecks } from '../verify/runner.ts';
import type { Check, CheckReport, CheckSkipReason, Verdict } from '../verify/types.ts';
import type { StageCheck } from '../pipeline/types.ts';
import { writeJsonAtomic } from './atomic.ts';
import { jobDir } from './format.ts';

export const ACCEPTANCE_FILE = 'acceptance.json';
export const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
export const OUTPUT_TAIL_MAX = 2_000;

export type AcceptanceState = 'accepted' | 'rejected' | 'unchecked';
export interface AcceptanceCheck {
  readonly name: string; readonly ok: boolean; readonly exitCode: number | null;
  readonly durationMs: number; readonly outputTail: string;
  readonly blocking: boolean;
  readonly timedOut: boolean; readonly signal: NodeJS.Signals | null;
  readonly skipped?: CheckSkipReason; readonly reason?: string;
}
export interface Acceptance {
  readonly state: AcceptanceState;
  readonly checks: readonly AcceptanceCheck[];
  readonly at?: string;
  /** True only in the placeholder written at spawn, before the job is terminal. */
  readonly pending?: boolean;
  readonly reason?: string;
}

/** Normalize a runner report into the persisted acceptance shape. */
export function acceptanceChecksFromReport(
  report: CheckReport,
  configuredChecks: readonly StageCheck[],
): AcceptanceCheck[] {
  return report.verdicts.map((v, index): AcceptanceCheck => {
    const configured = configuredChecks[index]!;
    // runCheck deliberately treats an empty command as absent/non-blocking for
    // generic callers. At an acceptance boundary, a declared required check
    // that never ran must still fail closed.
    const blocking = v.skipped === 'not-configured'
      ? configured.blocking !== false
      : v.blocking;
    return {
      name: v.check.name, ok: v.passed, exitCode: v.exitCode, durationMs: v.durationMs, blocking,
      timedOut: v.timedOut, signal: v.signal,
      ...(v.skipped === undefined ? {} : { skipped: v.skipped }),
      ...(v.reason === undefined ? {} : { reason: v.reason }),
      outputTail: `${v.stdoutTail}${v.stderrTail === '' ? '' : `\n${v.stderrTail}`}`.slice(-OUTPUT_TAIL_MAX),
    };
  });
}

/** Apply configured acceptance policy to the generic runner report. */
export function normalizeAcceptanceReport(
  report: CheckReport,
  configuredChecks: readonly StageCheck[],
): CheckReport {
  const verdicts = report.verdicts.map((verdict, index): Verdict => {
    const configured = configuredChecks[index]!;
    const blocking = verdict.skipped === 'not-configured'
      ? configured.blocking !== false
      : verdict.blocking;
    return blocking === verdict.blocking ? verdict : { ...verdict, blocking };
  });
  const failing = verdicts.filter((verdict) => !verdict.passed && verdict.blocking);
  return {
    ...report,
    verdicts,
    failing,
    passed: failing.length === 0,
    incomplete: verdicts.some((verdict) => verdict.skipped !== undefined && verdict.blocking),
  };
}

export function acceptanceState(checks: readonly AcceptanceCheck[]): AcceptanceState {
  return checks.some((check) => check.blocking && !check.ok) ? 'rejected' : 'accepted';
}

/** StageCheck -> verify Check, resolving cwd against baseDir. */
export function toVerifyChecks(checks: readonly StageCheck[], baseDir: string): Check[] {
  return checks.map((check) => ({
    name: check.name,
    command: check.command,
    cwd: path.resolve(baseDir, check.cwd ?? '.'),
    timeoutMs: check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
    ...(check.blocking === undefined ? {} : { blocking: check.blocking }),
  }));
}

/**
 * Run the checks once and return both the persisted verdict and the raw report.
 * Pipeline stages need the report (its verdicts become stage evidence); every
 * other caller only wants the Acceptance, via `evaluateAcceptance`.
 */
export async function runAcceptance(input: {
  readonly succeeded: boolean; readonly checks: readonly StageCheck[] | undefined;
  readonly baseDir: string; readonly signal?: AbortSignal; readonly now?: () => Date;
}): Promise<{ readonly acceptance: Acceptance; readonly report: CheckReport | null }> {
  const stamp = (): string => (input.now ?? (() => new Date()))().toISOString();
  if (!input.checks?.length) return { acceptance: { state: 'unchecked', checks: [], at: stamp() }, report: null };
  if (!input.succeeded) {
    return { acceptance: { state: 'rejected', checks: [], at: stamp(), reason: 'job did not succeed; checks not run' }, report: null };
  }
  const rawReport = await runChecks(toVerifyChecks(input.checks, input.baseDir), { signal: input.signal });
  const report = normalizeAcceptanceReport(rawReport, input.checks);
  const checks = acceptanceChecksFromReport(report, input.checks);
  return { acceptance: { state: acceptanceState(checks), at: stamp(), checks }, report };
}

export async function evaluateAcceptance(input: Parameters<typeof runAcceptance>[0]): Promise<Acceptance> {
  return (await runAcceptance(input)).acceptance;
}

export function writeAcceptance(repo: string, jobId: string, acceptance: Acceptance): void {
  writeJsonAtomic(path.join(jobDir(repo, jobId), ACCEPTANCE_FILE), acceptance);
}

/**
 * The placeholder written when a job is prepared, before it is terminal, so a
 * reader can tell "checks still to run" from "no checks attached".
 */
export function markAcceptancePending(repo: string, jobId: string): void {
  writeAcceptance(repo, jobId, { state: 'unchecked', checks: [], pending: true });
}

/** A steered job's earlier turns never get checks of their own; the final turn carries the verdict. */
export function markAcceptanceSuperseded(repo: string, jobId: string): void {
  writeAcceptance(repo, jobId, { state: 'unchecked', checks: [], reason: 'superseded by steered turn' });
}

/**
 * Evaluate the finished job, record the verdict on its final turn, and mark
 * every other prepared turn superseded. Returns the verdict written.
 */
export async function settleAcceptance(input: Parameters<typeof runAcceptance>[0] & {
  readonly repo: string; readonly finalJobId: string; readonly preparedJobIds: readonly string[];
}): Promise<Acceptance> {
  const acceptance = await evaluateAcceptance(input);
  writeAcceptance(input.repo, input.finalJobId, acceptance);
  for (const id of input.preparedJobIds) if (id !== input.finalJobId) markAcceptanceSuperseded(input.repo, id);
  return acceptance;
}

/** Sidecar contents, or {state:'unchecked'} when absent or unreadable. */
export function readAcceptance(repo: string, jobId: string): Acceptance | { state: 'unchecked' } {
  try {
    const parsed = JSON.parse(readFileSync(path.join(jobDir(repo, jobId), ACCEPTANCE_FILE), 'utf8')) as Acceptance;
    return typeof parsed?.state === 'string' ? parsed : { state: 'unchecked' };
  } catch { return { state: 'unchecked' }; }
}
