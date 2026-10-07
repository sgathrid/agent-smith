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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runChecks } from '../verify/runner.ts';
import type { Check } from '../verify/types.ts';
import type { StageCheck } from '../pipeline/types.ts';
import { jobDir } from './format.ts';

export const ACCEPTANCE_FILE = 'acceptance.json';
export const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
export const OUTPUT_TAIL_MAX = 2_000;

export type AcceptanceState = 'accepted' | 'rejected' | 'unchecked';
export interface AcceptanceCheck {
  readonly name: string; readonly ok: boolean; readonly exitCode: number | null;
  readonly durationMs: number; readonly outputTail: string;
  readonly blocking: boolean;
}
export interface Acceptance {
  readonly state: AcceptanceState;
  readonly checks: readonly AcceptanceCheck[];
  readonly at?: string;
  /** True only in the placeholder written at spawn, before the job is terminal. */
  readonly pending?: boolean;
  readonly reason?: string;
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

export async function evaluateAcceptance(input: {
  readonly succeeded: boolean; readonly checks: readonly StageCheck[] | undefined;
  readonly baseDir: string; readonly signal?: AbortSignal; readonly now?: () => Date;
}): Promise<Acceptance> {
  const at = (input.now ?? (() => new Date()))().toISOString();
  if (!input.checks?.length) return { state: 'unchecked', checks: [], at };
  if (!input.succeeded) return { state: 'rejected', checks: [], at, reason: 'job did not succeed; checks not run' };
  const report = await runChecks(toVerifyChecks(input.checks, input.baseDir), { signal: input.signal });
  return {
    state: report.passed ? 'accepted' : 'rejected',
    at,
    checks: report.verdicts.map((v) => ({
      name: v.check.name, ok: v.passed, exitCode: v.exitCode, durationMs: v.durationMs, blocking: v.blocking,
      outputTail: `${v.stdoutTail}${v.stderrTail === '' ? '' : `\n${v.stderrTail}`}`.slice(-OUTPUT_TAIL_MAX),
    })),
  };
}

export function writeAcceptance(repo: string, jobId: string, acceptance: Acceptance): void {
  const dir = jobDir(repo, jobId);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, ACCEPTANCE_FILE);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(acceptance, null, 2)}\n`);
  renameSync(tmp, target);
}

/** Sidecar contents, or {state:'unchecked'} when absent or unreadable. */
export function readAcceptance(repo: string, jobId: string): Acceptance | { state: 'unchecked' } {
  try {
    const parsed = JSON.parse(readFileSync(path.join(jobDir(repo, jobId), ACCEPTANCE_FILE), 'utf8')) as Acceptance;
    return typeof parsed?.state === 'string' ? parsed : { state: 'unchecked' };
  } catch { return { state: 'unchecked' }; }
}
