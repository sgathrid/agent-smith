import type { ContinuationKind } from '../../mod/hooks/turns.ts';
import { type NoticeJob, claudeText } from '../../mod/hooks/notice.ts';
import { reasonFromText } from '../../mod/hooks/reasons.ts';

export type PushKind = 'finished' | 'failed' | 'attention' | 'cancelled';

export type WatchStatus = 'running' | 'succeeded' | 'failed' | 'canceled' | 'attention' | 'unknown';

export interface WatchableJob {
  readonly id: string;
  readonly workerId?: string;
  readonly name?: string;
  readonly turn?: number;
  readonly role?: string;
  readonly provider?: string;
  readonly startedAt?: string | null;
  readonly chainStartedAt?: string | null;
  readonly changedFileCount?: number;
  readonly latestSummary?: string | null;
  readonly summarySource?: 'worker' | null;
  readonly outcome?: string;
  readonly failureReason?: string | null;
  readonly failureDetail?: string | null;
  readonly checks?: { readonly passed: number; readonly total: number; readonly failed?: readonly string[] } | null;
  readonly checksRunning?: string | true;
  readonly acceptancePending?: boolean;
  readonly status: WatchStatus;
  readonly lastEventAt: string | null;
  readonly finishedAt: string | null;
  readonly warned: boolean;
  readonly supersededBy?: string | null;
  readonly followedBy?: string | null;
  readonly pendingMessages?: number | null;
  readonly continuedFrom?: string | null;
  readonly continuationKind?: ContinuationKind | null;
  readonly steerNotApplied?: boolean;
  readonly droppedMessage?: string;
  readonly alsoRan?: { readonly from: number; readonly to: number };
  readonly staleReads?: readonly string[] | null;
  readonly liveness?: { readonly state: 'silent' | 'dead'; readonly silentForMs: number; readonly since: number | null; readonly tool?: string };
}

export function pushKindFor(job: WatchableJob): PushKind | null {
  switch (job.status) {
    case 'succeeded':
      return 'finished';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'cancelled';
    case 'attention':
      return 'attention';
    default:
      return null;
  }
}

export function dedupeKey(job: WatchableJob): string {
  const dead = job.status === 'attention' && job.liveness?.state === 'dead' ? '#dead' : '';
  return `${job.id}#${job.status}${dead}${job.checksRunning === undefined ? '' : '#checks'}`;
}

export interface Candidate {
  readonly job: WatchableJob;
  readonly seen: ReadonlySet<string>;
  readonly observedInPriorPoll: boolean;
}

export function shouldPush(candidate: Candidate): boolean {
  const { job, seen } = candidate;

  if (job.supersededBy || job.followedBy || job.acceptancePending) return false;

  const kind = pushKindFor(job);
  if (kind === null) return false;

  if (seen.has(dedupeKey(job))) return false;

  if (kind === 'finished' || kind === 'failed' || kind === 'cancelled') {
    if (job.finishedAt === null) return false;
  }

  if (kind === 'attention') {
    if (!candidate.observedInPriorPoll) return false;
    if (job.lastEventAt === null && job.liveness?.state !== 'dead') return false;
  }

  return true;
}

export interface Batch {
  readonly content: string | null;
  readonly keys: readonly string[];
}

export function buildBatch(candidates: readonly Candidate[], now: number): Batch {
  const pushable = candidates.filter(shouldPush);

  if (pushable.length === 0) {
    return { content: null, keys: [] };
  }

  const keys = pushable.map((c) => dedupeKey(c.job));
  const content = claudeText(pushable.map((c) => toNotice(c.job, pushKindFor(c.job)!, now)));

  return { content, keys };
}

export function toNotice(job: WatchableJob, kind: PushKind, now: number): NoticeJob {
  const run = job.role === 'pipeline' && job.outcome !== undefined;
  const dead = kind === 'attention' && job.liveness?.state === 'dead';
  const start = job.chainStartedAt ?? job.startedAt;
  const span = dead
    ? (job.liveness?.since == null ? NaN : now - job.liveness.since)
    : kind === 'attention'
      ? (job.lastEventAt === null ? NaN : now - Date.parse(job.lastEventAt))
      : (start && job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(start) : NaN);
  return {
    id: job.id, kind, name: job.name ?? null, provider: job.provider ?? null, role: job.role ?? null,
    run,
    durationMs: Number.isFinite(span) ? span : null,
    changedFiles: job.changedFileCount ?? null,
    checks: job.checks ?? null,
    reason: run ? job.outcome! : kind === 'failed' ? job.failureDetail || reasonFromText(job.failureReason) : null,
    summary: job.summarySource === 'worker' ? job.latestSummary ?? null : null,
    ...(job.staleReads && job.staleReads.length > 0 ? { staleReads: job.staleReads } : {}),
    ...(job.continuationKind ? { continuationKind: job.continuationKind } : {}),
    ...(job.steerNotApplied ? { steerNotApplied: true } : {}),
    ...(job.droppedMessage ? { droppedMessage: job.droppedMessage } : {}),
    ...(job.alsoRan ? { alsoRan: job.alsoRan } : {}),
    ...(kind === 'finished' && job.checksRunning !== undefined ? { checksRunning: job.checksRunning } : {}),
    ...(kind === 'attention' && job.liveness ? { liveness: { state: job.liveness.state, ...(job.liveness.tool ? { tool: job.liveness.tool } : {}) } } : {}),
  };
}
