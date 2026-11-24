/**
 * hooks/turns.ts — one definition of "which turn is a worker's head" and "is a
 * worker idle", shared by forge (service), the channel (status, watch, notices)
 * and the mod (band, /forge, notices). Pure, structural, no imports: the mod
 * loader forbids imports outside the plugin, and forge/channel import from here.
 *
 * Vocabulary:
 * - A worker is one durable identity (workerId, name) with turns 1..n.
 * - supersededBy: set only when a steer CUT this turn short; the continuation
 *   stands in for it, so a jobId lookup follows supersededBy.
 * - followedBy: set when a follow-up turn started after this turn finished
 *   normally; this turn's result stands, so a jobId lookup does NOT follow it.
 */

export type ContinuationKind = 'follow-up' | 'steer';

/** 0.4.x / early-0.5 manifests wrote other kinds; map them on read. */
export function normalizeContinuationKind(v: unknown): ContinuationKind | null {
  if (v === 'follow-up' || v === 'steer-queue' || v === 'resume') return 'follow-up';
  if (v === 'steer' || v === 'steer-interrupt') return 'steer';
  return null;
}

export interface TurnLike {
  readonly jobId: string;
  readonly status: string;
  readonly turn?: number | null | undefined;
  readonly supersededBy?: string | null | undefined;
  readonly followedBy?: string | null | undefined;
  readonly startedAt?: string | number | null | undefined;
  readonly createdAt?: string | number | null | undefined;
  readonly updatedAt?: string | number | null | undefined;
  /** A steer.head marker exists: the turn is mid-handoff to a steered continuation. */
  readonly hasSteerHead?: boolean | undefined;
  readonly acceptancePending?: boolean | undefined;
  readonly pendingMessages?: number | null | undefined;
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'cancelled', 'unknown']);
export const isTerminalStatus = (s: string): boolean => TERMINAL.has(s);

function turnOf(t: TurnLike): number {
  return typeof t.turn === 'number' && Number.isInteger(t.turn) && t.turn >= 1 ? t.turn : 1;
}
function timeOf(t: TurnLike): number {
  for (const v of [t.startedAt, t.createdAt, t.updatedAt]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') { const ms = Date.parse(v); if (Number.isFinite(ms)) return ms; }
  }
  return 0;
}

/**
 * Sort comparator, head first:
 * (1) not handed off (no supersededBy, no followedBy, no steer.head) first
 * (2) running before terminal
 * (3) higher turn
 * (4) newer start
 * (5) jobId, for a total order
 */
export function compareTurnPriority(a: TurnLike, b: TurnLike): number {
  const aOff = Boolean(a.supersededBy) || Boolean(a.followedBy) || a.hasSteerHead === true;
  const bOff = Boolean(b.supersededBy) || Boolean(b.followedBy) || b.hasSteerHead === true;
  if (aOff !== bOff) return aOff ? 1 : -1;
  const aRun = !isTerminalStatus(a.status);
  const bRun = !isTerminalStatus(b.status);
  if (aRun !== bRun) return aRun ? -1 : 1;
  const dt = turnOf(b) - turnOf(a);
  if (dt !== 0) return dt;
  const dm = timeOf(b) - timeOf(a);
  if (dm !== 0) return dm;
  return b.jobId.localeCompare(a.jobId);
}

/** The head turn of one worker's turns, or null for none. */
export function pickHead<T extends TurnLike>(turns: readonly T[]): T | null {
  let head: T | null = null;
  for (const t of turns) if (head === null || compareTurnPriority(t, head) < 0) head = t;
  return head;
}

/**
 * THE idle rule. A worker is idle when its head turn is terminal, was not
 * handed off, has no acceptance checks running and no queued messages.
 * Notices fire on the transition to idle; status(name, wait_ms) waits for it.
 */
export function isWorkerIdle(head: TurnLike | null): boolean {
  if (head === null) return true;
  return isTerminalStatus(head.status)
    && !head.supersededBy && !head.followedBy && head.hasSteerHead !== true
    && head.acceptancePending !== true
    && !(typeof head.pendingMessages === 'number' && head.pendingMessages > 0);
}

/** Durable per-worker index, written by forge under the worker lock. */
export interface WorkerIndex {
  readonly schema: 1;
  readonly workerId: string;
  readonly name: string;
  /** Turn jobIds, oldest first. */
  readonly turns: readonly string[];
  readonly updatedAt: string;
}

export const WORKERS_DIR = '.agent-smith/workers';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function workerIndexPath(repo: string, workerId: string): string {
  if (!SAFE_ID.test(workerId) || workerId === '.' || workerId === '..') throw new Error('Invalid worker id');
  return repo.replace(/\/+$/, '') + '/' + WORKERS_DIR + '/' + workerId + '.json';
}

export function parseWorkerIndex(raw: unknown): WorkerIndex | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['schema'] !== 1 || typeof r['workerId'] !== 'string' || typeof r['name'] !== 'string' || !Array.isArray(r['turns'])) return null;
  const turns = r['turns'].filter((t): t is string => typeof t === 'string' && SAFE_ID.test(t));
  return { schema: 1, workerId: r['workerId'], name: r['name'], turns, updatedAt: typeof r['updatedAt'] === 'string' ? r['updatedAt'] : '' };
}
