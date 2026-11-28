import type { ProgressDigest } from '../surfaces/mod/types/index.d.ts';
import type { ContinuationKind } from '../surfaces/mod/hooks/turns.ts';
import {
  DENIED_RE, REASONS, deniedReason, reasonFromText,
} from '../surfaces/mod/hooks/reasons.ts';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export const JOBS_DIR_SEGMENTS = ['.agent-smith', 'jobs'] as const;

export const SCHEMA_VERSION = 1;

export const PROGRESS_FLUSH_MS = 250;

export const FILES = {
  job: 'job.json',
  progress: 'progress.json',
  view: 'view.json',
  events: 'events.jsonl',
  argv: 'argv.json',
  stderr: 'stderr.log',
  result: 'result.json',
  report: 'result.md',
  cancel: 'cancel',
  cancelSteer: 'cancel.steer',
  steer: 'steer.jsonl',
  steerHead: 'steer.head',
  checksSpec: 'checks-spec.json',
  request: 'request.json',
  ownerDone: 'owner.done',
  checksAbort: 'checks.abort',
  steerConsumed: 'steer.consumed',
  steerDiscard: 'steer.discard',
  /** Latest `Team` snapshot (atomic rewrite), present only when the worker has sub-agents. */
  team: 'team.json',
  /** Directory of `MemberView` files, `<memberId>.json`. */
  members: 'members',
} as const;

export type SteerDelivery = 'queue' | 'interrupt';

export type { ContinuationKind } from '../surfaces/mod/hooks/turns.ts';
export { normalizeContinuationKind } from '../surfaces/mod/hooks/turns.ts';

export type LegacyContinuationKind = 'steer-queue' | 'steer-interrupt' | 'resume';

export function isContinuationKind(v: unknown): v is ContinuationKind {
  return v === 'follow-up' || v === 'steer';
}

export interface WatchedFileSigs {
  readonly repoSig: string;
  readonly cwdSig: string;
}

export interface SteerEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly prompt: string;
  readonly context?: string | undefined;
  readonly files?: readonly string[] | undefined;
  readonly delivery: SteerDelivery;
  readonly allowFresh?: boolean | undefined;
  readonly sender?: MessageSender | undefined;
  readonly overrides?: MessageOverrides | undefined;
}

export type MessageSender = 'follow_up' | 'steer';

export interface TurnMessage {
  readonly sender: MessageSender;
  readonly text: string;
}

export interface MessageOverrides {
  readonly checks?: readonly { readonly name: string; readonly command: string; readonly cwd?: string; readonly timeoutMs?: number; readonly blocking?: boolean }[] | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly unrestricted?: boolean | undefined;
}

export function senderOf(e: Pick<SteerEntry, 'sender' | 'delivery'>): MessageSender {
  return e.sender ?? (e.delivery === 'interrupt' ? 'steer' : 'follow_up');
}

export const ID_MARKER = 'smith';

export type ForgeStatus = 'running' | 'succeeded' | 'failed' | 'canceled';

export function isForgeStatus(v: unknown): v is ForgeStatus {
  return v === 'running' || v === 'succeeded' || v === 'failed' || v === 'canceled';
}

export function isTerminalForgeStatus(s: unknown): s is Exclude<ForgeStatus, 'running'> {
  return s === 'succeeded' || s === 'failed' || s === 'canceled';
}

export interface ForgeActivity {
  readonly stepIndex: number;
  readonly tool: string;
  readonly input?: string | undefined;
  readonly status: 'active' | 'done' | 'error' | 'denied';
}

export interface ForgeDenial {
  readonly action?: string | undefined;
  readonly displayName?: string | undefined;
  readonly nonfatal?: boolean | undefined;
}

export interface ForgeManifest {
  readonly schema: number;
  readonly jobId: string;
  readonly name?: string;
  readonly workerId?: string;
  readonly turn?: number;
  readonly role?: string;
  readonly latestSummary?: string | null;
  readonly summarySource?: 'worker' | null;
  readonly provider: string;
  readonly mode: string;
  readonly model: string | null;
  readonly modelRequested?: string | null;
  readonly modelResolved?: string | null;
  readonly modelSource?: 'requested' | 'harness-config' | 'reported' | 'unknown';
  readonly preambleApplied?: boolean;
  readonly sandbox?: string;
  readonly sandboxFlags?: readonly string[];
  readonly readOnlyRequested?: boolean;
  readonly readOnlyEnforced?: boolean;
  readonly effort: string | null;
  readonly cwd: string;
  readonly task: string;
  readonly promptChars: number;
  readonly unrestricted: boolean;
  readonly conversation: string | null;

  readonly ownerPid?: number;

  readonly status: ForgeStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;

  readonly jobStatus: string | null;
  readonly error: string | null;
  readonly reason?: string | null;
  readonly deniedActions: readonly ForgeDenial[];
  readonly usage: Readonly<Record<string, number>> | null;
  readonly toolCalls: number;
  readonly toolErrors?: number;
  readonly failedEarly?: boolean;

  readonly pipeline: string | null;
  readonly stage: string | null;
  readonly attempt: number | null;

  readonly gitBaseline?: GitBaseline;
  readonly changedFiles?: readonly string[];
  readonly changedFilesTruncated?: boolean;
  readonly changedFilesUnknown?: boolean;
  readonly cwdMissingAtFinish?: boolean;
  readonly unattributedFiles?: readonly string[];
  readonly timeoutMs?: number;
  readonly supersededBy?: string | null;
  readonly followedBy?: string | null;
  readonly continuedFrom?: string;
  readonly continuationKind?: ContinuationKind;
  readonly chainStartedAt?: string;
  readonly pendingSteers?: number;
  readonly watchedFiles?: Readonly<Record<string, WatchedFileSigs>>;
  readonly staleReads?: readonly string[];
}

export interface GitBaseline {
  readonly head: string | null;
  readonly dirty: readonly string[];
}

export function attributeChanged(
  files: readonly string[],
  toolInputs: string,
): { mine: string[]; other: string[] } {
  if (toolInputs === '') return { mine: [...files], other: [] };
  const mine: string[] = [];
  const other: string[] = [];
  for (const p of files) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    (toolInputs.includes(p) || (base !== '' && toolInputs.includes(base)) ? mine : other).push(p);
  }
  return { mine, other };
}

export const CHANGED_FILES_CAP = 200;

export function isForgeStatePath(p: string): boolean {
  return p === '.agent-smith' || p.startsWith('.agent-smith/');
}

export function diffChangedFiles(
  baseline: GitBaseline,
  nowDirty: readonly string[],
  modifiedBaseline: readonly string[] = [],
  committed: readonly string[] = [],
): { files: string[]; truncated: boolean } {
  const was = new Set(baseline.dirty);
  const out = new Set<string>();
  for (const p of nowDirty) if (!was.has(p)) out.add(p);
  const now = new Set(nowDirty);
  for (const p of baseline.dirty) if (!now.has(p)) out.add(p);
  for (const p of modifiedBaseline) out.add(p);
  for (const p of committed) out.add(p);
  const all = [...out].filter((p) => !isForgeStatePath(p)).sort();
  return { files: all.slice(0, CHANGED_FILES_CAP), truncated: all.length > CHANGED_FILES_CAP };
}

export interface ForgeProgress {
  readonly jobId: string;
  readonly name?: string;
  readonly workerId?: string;
  readonly role?: string;
  readonly latestSummary?: string | null;
  readonly summarySource?: 'worker' | null;
  readonly lastEventAt: string;
  readonly recentActivities: readonly ForgeActivity[];
  readonly lastActivity?: ForgeActivity | null;
  readonly latestText: string | null;
  readonly toolCalls: number;
  readonly editsCompleted?: number;
  readonly toolErrors?: number;
  readonly lastAliveAt?: string;
  readonly workerPid?: number;
  readonly warnings: readonly string[];
  readonly digest?: ProgressDigest;
  readonly pendingSteers?: number;
}

export type ForgeViewEvent =
  | { sequence: number; kind: 'assistant'; at: string; text: string }
  | { sequence: number; kind: 'tool'; at: string; stepIndex: number; tool: string; input: string; output: string; state: 'active' | 'done' | 'error' }
  | { sequence: number; kind: 'message'; at: string; text: string; delivery: 'next-step' | 'turn-start'; sender: MessageSender };

export interface ForgeView {
  readonly schema: 1;
  readonly prompt: string;
  readonly preamble: string | null;
  readonly messages?: readonly TurnMessage[];
  readonly truncated: boolean;
  readonly transcript: readonly string[];
  readonly timeline?: readonly ForgeViewEvent[];
  readonly tools: readonly {
    stepIndex: number; at: string; tool: string; input: string; output: string;
    state: 'active' | 'done' | 'error';
  }[];
}

export function jobsDir(repo: string): string {
  return path.join(repo, ...JOBS_DIR_SEGMENTS);
}

export function archivedJobsDir(repo: string): string {
  return path.join(repo, '.agent-smith', 'archive', 'jobs');
}

export function jobDir(repo: string, jobId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(jobId) || jobId === '.' || jobId === '..') {
    throw new Error(`invalid job id "${jobId}"`);
  }
  return path.join(jobsDir(repo), jobId);
}

export function jobFile(repo: string, jobId: string, name: string): string {
  return path.join(jobDir(repo, jobId), name);
}

export function normalizeDenials(denials: readonly ForgeDenial[] | undefined): ForgeDenial[] {
  return (denials ?? []).map((d) =>
    d.nonfatal === undefined && d.action === 'tool' ? { ...d, nonfatal: true } : d,
  );
}

export function readManifest(repo: string, jobId: string): ForgeManifest {
  const manifest = JSON.parse(readFileSync(jobFile(repo, jobId, FILES.job), 'utf8')) as ForgeManifest;
  if (!Array.isArray(manifest.deniedActions) || !manifest.deniedActions.some((d) => d.nonfatal === undefined && d.action === 'tool')) {
    return manifest;
  }
  return { ...manifest, deniedActions: normalizeDenials(manifest.deniedActions) };
}

export function newJobId(mode: string): string {
  const safeMode = mode.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120).replace(/-+$/g, '');
  const prefix = safeMode === '' ? 'job' : safeMode;
  return `${prefix}-${ID_MARKER}-${randomBytes(4).toString('hex')}`;
}

export function newWorkerId(): string {
  return `w-${randomBytes(6).toString('hex')}`;
}

export function taskTitle(prompt: string): string {
  const first = prompt.split('\n').find((l) => l.trim().length > 0) ?? '';
  return first.replace(/^#\s*/, '').trim().slice(0, 200);
}

export const MIN_USEFUL_CHARS = 1;

export function looksEmpty(text: string | null | undefined): boolean {
  if (text === null || text === undefined) return true;
  return text.trim().length < MIN_USEFUL_CHARS;
}

export interface StatusDerivation {
  readonly alreadyTerminal?: ForgeStatus | null | undefined;
  readonly ok?: boolean | null | undefined;
  readonly jobStatus?: string | null | undefined;
  readonly deniedActions?: readonly ForgeDenial[] | null | undefined;
  readonly report?: string | null | undefined;
  readonly cwdMissing?: boolean | undefined;
  readonly writing?: boolean | undefined;
}

export const CWD_GONE_REASON = 'working directory gone; nothing could be verified';

export const FAILED_EARLY_MS = 20_000;

export function isWritingMode(mode: string | null | undefined): boolean {
  return mode === 'implement' || mode === 'verify';
}

export function cwdFacts(cwd: string | null | undefined, mode: string | null | undefined, edited = false): { cwdMissing: boolean; writing: boolean } {
  return { cwdMissing: typeof cwd === 'string' && cwd !== '' && !existsSync(cwd), writing: isWritingMode(mode) || edited };
}

export interface StatusVerdict {
  readonly status: ForgeStatus;
  readonly suspicious: boolean;
  readonly reason: string | null;
  readonly note?: string | null;
}

function denialNames(denials: readonly ForgeDenial[]): string[] {
  return denials
    .map((x) => x.displayName ?? x.action)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

function deniedNames(denials: readonly ForgeDenial[]): string {
  const names = [...new Set(denialNames(denials))];
  if (names.length === 0) return '';
  return names.length === 1 ? names[0]! : `${names[0]} +${names.length - 1}`;
}

function elide(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  return `${text.slice(0, head)} … ${text.slice(text.length - (max - head - 3))}`;
}

export function failureFields(
  verdict: StatusVerdict,
  result: { readonly status: string; readonly error?: string | undefined; readonly deniedActions?: readonly ForgeDenial[] | undefined },
  maxError = 1_200,
): { error: string | null; reason: string | null } {
  const adapterError = (result.error ?? '').trim();
  const error = adapterError !== '' ? elide(adapterError, maxError) : verdict.reason;
  if (verdict.status !== 'failed') return { error, reason: null };
  const denials = result.deniedActions ?? [];
  const fatal = denials.length > 0 && verdict.reason !== null && DENIED_RE.test(verdict.reason);
  let reason: string;
  if (fatal) reason = deniedReason(denialNames(denials));
  else if (result.status === 'timeout') reason = REASONS.timedOut;
  else if (verdict.reason === REASONS.noOutput) reason = REASONS.noOutput;
  else if (verdict.reason === CWD_GONE_REASON && adapterError === '') reason = 'working directory gone';
  else reason = reasonFromText(adapterError !== '' ? adapterError : verdict.reason);
  return { error, reason };
}

export function deriveStatus(d: StatusDerivation): StatusVerdict {
  const terminal = d.alreadyTerminal ?? null;
  if (terminal === 'canceled') return { status: 'canceled', suspicious: false, reason: 'canceled' };
  if (terminal === 'succeeded') return { status: 'succeeded', suspicious: false, reason: null };
  if (terminal === 'failed') {
    return { status: 'failed', suspicious: false, reason: REASONS.workerError };
  }

  if (d.ok === null || d.ok === undefined) {
    return { status: 'running', suspicious: false, reason: null };
  }

  const denials = d.deniedActions ?? [];
  const nonfatalOnly = denials.length > 0 && d.ok === true && !looksEmpty(d.report) && denials.every((x) => x.nonfatal === true);
  if (denials.length > 0 && !nonfatalOnly) {
    return { status: 'failed', suspicious: true, reason: deniedReason(denialNames(denials)) };
  }

  if (d.ok === false) {
    return {
      status: 'failed',
      suspicious: false,
      reason: d.jobStatus === 'timeout' ? REASONS.timedOut : REASONS.workerError,
    };
  }

  if (d.cwdMissing === true && d.writing === true) {
    return { status: 'failed', suspicious: true, reason: CWD_GONE_REASON };
  }

  if (nonfatalOnly) {
    return {
      status: 'succeeded',
      suspicious: false,
      reason: null,
      note: `${denials.length} ${denials.length === 1 ? 'call' : 'calls'} denied` + (deniedNames(denials) === '' ? '' : `: ${deniedNames(denials)}`),
    };
  }

  if (looksEmpty(d.report)) {
    return {
      status: 'failed',
      suspicious: true,
      reason: REASONS.noOutput,
    };
  }

  return { status: 'succeeded', suspicious: false, reason: null };
}

export function warningsFor(v: StatusVerdict, progress: ForgeProgress | null): string[] {
  const out: string[] = [];
  if (v.suspicious) out.push(v.reason ?? 'suspicious success');
  if (v.note) out.push(v.note);
  for (const w of progress?.warnings ?? []) out.push(w);
  return out;
}

export function shouldFlush(lastFlushMs: number, nowMs: number, minMs = PROGRESS_FLUSH_MS): boolean {
  return nowMs - lastFlushMs >= minMs;
}

export const DEFAULT_TIMEOUT_MS = 45 * 60_000;

export const LEGACY_ORPHAN_AFTER_MS = 2 * DEFAULT_TIMEOUT_MS;

export const ORPHAN_REASON = REASONS.serverStopped;
export const CANCEL_ORPHAN_REASON = 'canceled; server stopped before confirming';

/** `kill(pid, 0)`: ESRCH means gone; EPERM means it exists but is not ours. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function validOwnerPid(m: { readonly ownerPid?: unknown }): number | null {
  const pid = m.ownerPid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function ownerAlive(m: { readonly ownerPid?: unknown }): boolean {
  const pid = validOwnerPid(m);
  return pid !== null && isPidAlive(pid);
}

export function deriveOrphan(
  m: { readonly status: string; readonly ownerPid?: number | undefined; readonly createdAt?: string | undefined },
  lastSeenMs: number | null,
  nowMs: number,
  alive: (pid: number) => boolean = isPidAlive,
  cancelRequested = false,
): StatusVerdict | null {
  if (m.status !== 'running') return null;
  const verdict: StatusVerdict = cancelRequested
    ? { status: 'canceled', suspicious: false, reason: CANCEL_ORPHAN_REASON }
    : { status: 'failed', suspicious: true, reason: ORPHAN_REASON };
  if (typeof m.ownerPid === 'number') return alive(m.ownerPid) ? null : verdict;
  const times = [lastSeenMs, m.createdAt === undefined ? null : Date.parse(m.createdAt)]
    .filter((t): t is number => t !== null && Number.isFinite(t));
  if (times.length === 0) return null;
  const ref = Math.max(...times);
  return nowMs - ref > LEGACY_ORPHAN_AFTER_MS ? verdict : null;
}
