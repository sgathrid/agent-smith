import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runChecks } from '../verify/runner.ts';
import type { Check, CheckReport, CheckSkipReason } from '../verify/types.ts';
import type { StageCheck } from '../pipeline/types.ts';
import { writeJsonAtomic } from './atomic.ts';
import { FILES, jobDir, jobFile, readManifest } from './format.ts';
import { existsSync } from 'node:fs';

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
  readonly pending?: boolean;
  readonly reason?: string;
  readonly budgetMs?: number;
  readonly running?: string;
  readonly startedAt?: string;
}

export const ACCEPTANCE_GRACE_MS = 30_000;
export const ACCEPTANCE_BUDGET_CAP_MS = 30 * 60_000;

export function acceptanceBudgetMs(checks: readonly StageCheck[]): number {
  const total = checks.reduce((sum, c) => sum + (c.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS), 0);
  return Math.min(ACCEPTANCE_BUDGET_CAP_MS, total + ACCEPTANCE_GRACE_MS);
}

export function pendingAcceptance(checks: readonly StageCheck[] | undefined): Acceptance {
  return { state: 'unchecked', checks: [], pending: true, ...(checks?.length ? { budgetMs: acceptanceBudgetMs(checks) } : {}) };
}

export function acceptanceChecksFromReport(report: CheckReport): AcceptanceCheck[] {
  return report.verdicts.map((v): AcceptanceCheck => ({
    name: v.check.name, ok: v.passed, exitCode: v.exitCode, durationMs: v.durationMs, blocking: v.blocking,
    timedOut: v.timedOut, signal: v.signal,
    ...(v.skipped === undefined ? {} : { skipped: v.skipped }),
    ...(v.reason === undefined ? {} : { reason: v.reason }),
    outputTail: `${v.stdoutTail}${v.stderrTail === '' ? '' : `\n${v.stderrTail}`}`.slice(-OUTPUT_TAIL_MAX),
  }));
}

export function acceptanceState(checks: readonly AcceptanceCheck[]): AcceptanceState {
  return checks.some((check) => check.blocking && !check.ok) ? 'rejected' : 'accepted';
}

export function toVerifyChecks(checks: readonly StageCheck[], baseDir: string): Check[] {
  return checks.map((check) => ({
    name: check.name,
    command: check.command,
    cwd: path.resolve(baseDir, check.cwd ?? '.'),
    timeoutMs: check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
    ...(check.blocking === undefined ? {} : { blocking: check.blocking }),
  }));
}

export interface AcceptanceInput {
  readonly succeeded: boolean; readonly checks: readonly StageCheck[] | undefined;
  readonly baseDir: string; readonly signal?: AbortSignal; readonly now?: () => Date;
  readonly onProgress?: (running: readonly string[]) => void;
}

export async function evaluateAcceptanceReport(input: AcceptanceInput): Promise<{ readonly acceptance: Acceptance; readonly report: CheckReport | null }> {
  const stamp = (): string => (input.now ?? (() => new Date()))().toISOString();
  if (!input.checks?.length) return { acceptance: { state: 'unchecked', checks: [], at: stamp() }, report: null };
  if (!input.succeeded) {
    return { acceptance: { state: 'rejected', checks: [], at: stamp(), reason: 'job did not succeed; checks not run' }, report: null };
  }
  const running = new Set<string>();
  const report = await runChecks(toVerifyChecks(input.checks, input.baseDir), {
    signal: input.signal,
    blockOnUnconfigured: true,
    ...(input.onProgress === undefined ? {} : {
      onCheck: ({ check, state }) => {
        if (state === 'start') running.add(check.name); else running.delete(check.name);
        input.onProgress!([...running]);
      },
    }),
  });
  const checks = acceptanceChecksFromReport(report);
  return { acceptance: { state: acceptanceState(checks), at: stamp(), checks }, report };
}

export async function evaluateAcceptance(input: AcceptanceInput): Promise<Acceptance> {
  return (await evaluateAcceptanceReport(input)).acceptance;
}

export function writeAcceptance(repo: string, jobId: string, acceptance: Acceptance): void {
  writeJsonAtomic(path.join(jobDir(repo, jobId), ACCEPTANCE_FILE), acceptance);
}

export function markAcceptancePending(repo: string, jobId: string, checks?: readonly StageCheck[]): void {
  writeAcceptance(repo, jobId, pendingAcceptance(checks));
}

export function markAcceptanceSuperseded(repo: string, jobId: string): void {
  writeAcceptance(repo, jobId, { state: 'unchecked', checks: [], reason: 'superseded by steered turn' });
}

export async function runAcceptance(input: Omit<AcceptanceInput, 'onProgress'> & {
  readonly repo: string; readonly jobId: string;
}): Promise<Acceptance> {
  const budgetMs = acceptanceBudgetMs(input.checks ?? []);
  const startedAt = new Date().toISOString();
  const acceptance = await evaluateAcceptance({
    succeeded: input.succeeded, checks: input.checks, baseDir: input.baseDir,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.now === undefined ? {} : { now: input.now }),
    onProgress: (running) => {
      try {
        writeAcceptance(input.repo, input.jobId, {
          state: 'unchecked', checks: [], pending: true, budgetMs, startedAt,
          ...(running.length > 0 ? { running: running.join(', ') } : {}),
        });
      } catch {}
    },
  });
  return input.signal?.aborted
    ? { state: 'unchecked', checks: [], at: acceptance.at ?? startedAt, reason: 'checks canceled' }
    : acceptance;
}

export async function settleAcceptance(input: Omit<AcceptanceInput, 'onProgress'> & {
  readonly repo: string; readonly finalJobId: string; readonly preparedJobIds: readonly string[];
}): Promise<Acceptance> {
  const acceptance = await runAcceptance({ ...input, jobId: input.finalJobId });
  writeAcceptance(input.repo, input.finalJobId, acceptance);
  for (const id of input.preparedJobIds) if (id !== input.finalJobId) settleEarlierTurn(input.repo, id);
  return acceptance;
}

function settleEarlierTurn(repo: string, jobId: string): void {
  const current = readAcceptance(repo, jobId) as Partial<Acceptance>;
  const placeholder = current.pending === true || !('checks' in current);
  if (!placeholder) return;
  let followed = false;
  try { followed = Boolean(readManifest(repo, jobId).followedBy); } catch {}
  if (followed) writeAcceptance(repo, jobId, { state: 'unchecked', checks: [], reason: 'continued by follow-up' });
  else markAcceptanceSuperseded(repo, jobId);
}

export const VERDICT_TAIL_CHARS = 1_000;

export function verdictBlock(acceptance: Acceptance | { state: 'unchecked' }): string | undefined {
  const a = acceptance as Partial<Acceptance>;
  if (a.pending === true) return undefined;
  const checks = a.checks ?? [];
  if (checks.length === 0) return a.reason === undefined ? undefined : `[ACCEPTANCE] ${a.state}: ${a.reason}`;
  const lines = checks.map((c) => `${c.name}: ${c.ok ? 'pass' : 'FAIL'}${c.exitCode === null ? (c.timedOut ? ' (timed out)' : '') : ` (exit ${c.exitCode})`}`);
  const tails = checks.filter((c) => !c.ok && c.outputTail.trim() !== '')
    .map((c) => `--- ${c.name} output (tail) ---\n${c.outputTail.slice(-VERDICT_TAIL_CHARS)}`);
  return [`[ACCEPTANCE] ${a.state}`, ...lines, ...tails].join('\n');
}

export function checksAbortRequested(repo: string, jobId: string): boolean {
  return existsSync(jobFile(repo, jobId, FILES.checksAbort));
}

export function readAcceptance(repo: string, jobId: string): Acceptance | { state: 'unchecked' } {
  try {
    const parsed = JSON.parse(readFileSync(path.join(jobDir(repo, jobId), ACCEPTANCE_FILE), 'utf8')) as Acceptance;
    return typeof parsed?.state === 'string' ? parsed : { state: 'unchecked' };
  } catch { return { state: 'unchecked' }; }
}
