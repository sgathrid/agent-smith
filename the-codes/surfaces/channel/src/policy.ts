/**
 * policy.ts — when the channel is allowed to speak into Claude's context.
 *
 * This file is the whole point of Surface 2, and it is pure so it can be tested
 * exhaustively. If this logic is wrong the channel is not merely noisy, it is
 * actively harmful: every pushed event is tokens the user pays for on every
 * subsequent turn, and a channel that pushes progress ticks would push more
 * context than the conversation it is meant to inform.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DESIGN RULE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   PUSH STATE CHANGES ONLY. NEVER PROGRESS TICKS.
 *
 * The mod already shows progress, for free, every second, to the human. A channel
 * cannot draw and a human cannot read Claude's context. So the channel's only
 * job is the one thing the mod cannot do: wake Claude when something CHANGED that
 * Claude would otherwise not notice.
 *
 * Four pushable events. That is the entire vocabulary:
 *
 *   finished  the job reached a terminal success
 *   failed    it reached a terminal failure, or a suspicious success
 *   attention it went silent past the grace period and is not coming back
 *   cancelled a human stopped it
 *
 * Not pushable, and the reasoning matters:
 *   running     — this is a progress tick. The definition of the thing we forbid.
 *   unknown     — we do not know what happened. Telling Claude "something
 *                 happened and I don't know what" costs tokens and buys nothing.
 *   succeeded→? — a re-read of an unchanged terminal job is not a change.
 *
 * Budget: one short line per job plus a closing next step (the text is
 * mod/hooks/notice.ts claudeText). Worker prose is excerpted, never pasted whole.
 */

// The words live in the mod (hooks/notice.ts), which announces the same jobs
// when it is loaded: one renderer, so the hook and the mod cannot drift apart.
import { type NoticeJob, claudeText, compactExcerpt } from '../../mod/hooks/notice.ts';

export { compactExcerpt };

// ── what we are allowed to say ──────────────────────────────────────────────

/** The event kinds this channel may ever emit. */
export type PushKind = 'finished' | 'failed' | 'attention' | 'cancelled';

/** A job state, as far as the channel is concerned. Mirrors RadarStatus. */
export type WatchStatus = 'running' | 'succeeded' | 'failed' | 'canceled' | 'attention' | 'unknown';

/** Everything the policy needs to know about one job. No I/O, no types from core. */
export interface WatchableJob {
  readonly id: string;
  readonly name?: string;
  readonly role?: string;
  readonly provider?: string;
  readonly startedAt?: string | null;
  readonly changedFileCount?: number;
  readonly latestSummary?: string | null;
  readonly summarySource?: 'worker' | null;
  /** Runtime-owned outcome, separate from worker-authored prose. */
  readonly outcome?: string;
  /** Runtime-owned failure reason (job.json error), when recorded. */
  readonly failureReason?: string | null;
  /** Acceptance check tally, when checks ran. */
  readonly checks?: { readonly passed: number; readonly total: number } | null;
  /** `agy-staff` for a legacy interop job; absent for Forge jobs and runs. */
  readonly source?: 'agy-staff';
  readonly status: WatchStatus;
  /** ISO-8601 of the last evidence of real work. Null ⇒ we have no evidence. */
  readonly lastEventAt: string | null;
  /** ISO-8601 the job reached a terminal state. Null while it has not. */
  readonly finishedAt: string | null;
  /** Whether the provider flagged warnings. Meaningful only once terminal; not rendered. */
  readonly warned: boolean;
}

/**
 * Which pushable event, if any, this job's current state represents.
 *
 * Returns null for every state we refuse to speak about. Keeping the refusal in
 * one function means "did we push a tick?" is answerable by reading one map.
 */
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
    // 'running' and 'unknown' deliberately fall through to null.
    default:
      return null;
  }
}

// ── dedupe ──────────────────────────────────────────────────────────────────

/**
 * The dedupe key: identity + the specific state we announced.
 *
 * WHY THE STATE IS PART OF THE KEY AND NOT JUST THE JOB ID:
 * a job that fails and is then re-run to success is two distinct facts. If the
 * key were just the job id, the success would be swallowed as a duplicate of the
 * failure, and Claude would sit on a stale "this failed" belief. Including the
 * state lets a job speak twice, but only if it genuinely changed its mind.
 *
 * WHY `finishedAt` IS NOT IN THE KEY:
 * it is the natural instinct and it is wrong. A finished job's status.json is
 * rewritten on cleanup in some agy-staff versions, and the file's mtime moves.
 * Keying on a timestamp that the worker does not promise to be stable converts a
 * re-read into a fake "new" event. The state is the fact; the timestamp is not.
 *
 * WHY `attention` IS NOT IN THE KEY:
 * a stall can be detected, resolve, and be detected again. That IS one story
 * ("this job stalls"), and the user needs to hear it once. The `epoch` argument
 * exists only so a caller can deliberately re-announce a job that recovered and
 * stalled again, and the default epoch never changes.
 */
export function dedupeKey(job: WatchableJob, epoch: number = 0): string {
  return `${job.id}#${job.status}#${epoch}`;
}

// ── the decision ────────────────────────────────────────────────────────────

/** One job's contribution to a poll. Constructed by the caller. */
export interface Candidate {
  readonly job: WatchableJob;
  /** Keys already pushed, for this job. The caller owns the memory. */
  readonly seen: ReadonlySet<string>;
  /**
   * Did a PREVIOUS poll see this job at all?
   *
   * This is what makes "first sighting is baseline, not news" expressible. The
   * `seen` key-set alone cannot answer it: a job pushed once and then re-pushed is
   * a different question from a job the channel has never encountered.
   *
   * The first poll sets this false for everything on disk. That is deliberate:
   * starting the channel against a directory of 16 already-finished jobs must not
   * greet the user with 16 notifications about work that completed before the
   * channel existed. From poll two onward it is true for anything still present.
   */
  readonly knownBefore: boolean;
}

/**
 * True if this job should be pushed right now.
 *
 * FOUR GATES, in order. Each one alone is insufficient, which is why they stack:
 *
 *  1. the state must be pushable        — kills progress ticks and `unknown`
 *  2. the key must be new                — kills a re-read of the same terminal state
 *  3. a terminal state must be *settled* — kills the mid-flight flap where a
 *     finished job is briefly unreadable and normalizes to `unknown` and back
 *  4. attention must be a transition     — a job that has been stalled since the
 *     channel started is a known quantity, not news
 *
 * GATE 3 EXISTS BECAUSE OF A REAL HAZARD. agy-staff deletes progress.json when a
 * job finishes cleanly (hazard A), and there is a window in which the terminal
 * status file is being written while we read. A reader that samples that window
 * sees a finished job as `running`, then `succeeded` again. Without gate 3 that
 * flaps as push, silence, push. With it, a push requires the job to have actually
 * finished — a finished_at that exists — so a flap cannot produce a second event.
 */
export function shouldPush(candidate: Candidate, now: number): boolean {
  const { job, seen } = candidate;

  // Gate 1 — is this state speakable at all?
  const kind = pushKindFor(job);
  if (kind === null) return false;

  // Gate 2 — have we already said this exact thing?
  if (seen.has(dedupeKey(job))) return false;

  // Gate 3 — terminal claims must be backed by a terminal timestamp.
  if (kind === 'finished' || kind === 'failed' || kind === 'cancelled') {
    if (job.finishedAt === null) return false;
  }

  // Gate 4 — `attention` is only news if it is NEW. A channel that connects to a
  // directory which already contains stalled jobs says nothing about them: it did
  // not observe them stall, so it has no news, only a backlog. Announcing the
  // backlog would be the channel's first impression being 16 lines of alarm.
  if (kind === 'attention') {
    if (!candidate.knownBefore) return false;
    // A stall with no last_event_at is not a stall we can describe. We know the job
    // exists and that it is not reporting; we do not know that it went quiet, and
    // a reader that just started will produce exactly this state for every job.
    // Saying "has stopped making progress" about a job whose progress we have
    // never observed would be a confident sentence about nothing.
    if (job.lastEventAt === null) return false;
  }

  return true;
}

// ── batching ────────────────────────────────────────────────────────────────

/**
 * What the channel will actually send for one poll.
 *
 * THE ANTI-SPAM RULE: N simultaneous events become at most ONE notification.
 * If five jobs fail in the same tick, Claude gets one block: a counted headline
 * and a line per job. Not five wakes. This is not a formatting preference — it is the difference
 * between an event feed and a firehose, and a firehome gets muted, and a muted
 * channel costs the user the one thing they installed it for.
 */
export interface Batch {
  /** The notification to send, or null if there is nothing to say. */
  readonly content: string | null;
  /** Identifier-safe metadata. Keys are [A-Za-z0-9_] only — see assertMetaSafe. */
  readonly meta: Record<string, string>;
  /** Keys to add to `seen` AFTER a successful send. */
  readonly keys: readonly string[];
}

/**
 * Collapse a poll's candidates into at most one notification.
 *
 * PURE. Given the same candidates and the same `seen`, always the same batch.
 *
 * The headline counts by KIND. "three succeeded, one failed" is a different
 * piece of news from "four failed", and Claude's useful next action differs:
 * several successes is usually "carry on", several failures is usually "stop
 * and look". Each job still gets its own line so Claude can act on its id.
 */
export function buildBatch(candidates: readonly Candidate[], now: number): Batch {
  const pushable = candidates.filter((c) => shouldPush(c, now));

  if (pushable.length === 0) {
    return { content: null, meta: {}, keys: [] };
  }

  const keys = pushable.map((c) => dedupeKey(c.job));
  const content = claudeText(pushable.map((c) => toNotice(c.job, pushKindFor(c.job)!, now)));

  // Single event: its own kind. Several at once: the batch is one notice, and
  // its meta lists every job.
  if (pushable.length === 1) {
    const only = pushable[0]!;
    return { content, meta: metaFor(pushKindFor(only.job)!, [only.job]), keys };
  }
  return { content, meta: metaFor('failed', pushable.map((c) => c.job)), keys };
}

/**
 * A watched job as the shared notice shape. A pipeline run (role `pipeline`)
 * carries its stage verdicts as `outcome`; a job carries its failure reason.
 */
export function toNotice(job: WatchableJob, kind: PushKind, now: number): NoticeJob {
  const run = job.role === 'pipeline' && job.outcome !== undefined;
  const span = kind === 'attention'
    ? (job.lastEventAt === null ? NaN : now - Date.parse(job.lastEventAt))
    : (job.startedAt && job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : NaN);
  return {
    id: job.id, kind, name: job.name ?? null, provider: job.provider ?? null, role: job.role ?? null,
    source: job.source ?? null, run,
    durationMs: Number.isFinite(span) ? span : null,
    changedFiles: job.changedFileCount ?? null,
    checks: job.checks ?? null,
    reason: run ? job.outcome! : kind === 'failed' ? job.failureReason ?? null : null,
    summary: job.summarySource === 'worker' ? job.latestSummary ?? null : null,
  };
}

// ── meta ────────────────────────────────────────────────────────────────────

/**
 * Identifier-safe `meta` for the notification.
 *
 * THE CONTRACT: meta keys must match [A-Za-z0-9_]+. Values are strings.
 *
 * Job ids contain hyphens (`implement-musm82da-f1dc1fe4`), which are NOT
 * identifier-safe. The `jobs` value is therefore sanitised by replacing every
 * illegal character with `_`. The human-readable `content` keeps the real ids
 * with their hyphens, because that text is for a person and a model, and neither
 * cares about a metacharacter. Only `meta` is machine-facing, so only `meta` is
 * sanitised.
 */
export function metaFor(kind: PushKind, jobs: readonly WatchableJob[]): Record<string, string> {
  return {
    kind,
    count: String(jobs.length),
    jobs: jobs.map((j) => safeId(j.id)).join(','),
  };
}

/**
 * Make an identifier safe for a `meta` value.
 *
 * Note this is deliberately lossy and deliberately NOT injective: two different
 * job ids could sanitise to the same string. That is acceptable, because `meta` is
 * for coarse filtering ("which jobs?") and `content` carries the exact text. A
 * perfect encoding here would cost more tokens than it is worth.
 */
export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Assert a meta object is identifier-safe. Exported for tests and for the
 * startup self-check: a malformed meta makes the notification undeliverable, and
 * an undeliverable notification fails SILENTLY, which is the worst possible
 * failure for a channel whose entire value is being reliably heard.
 */
export function assertMetaSafe(meta: Record<string, string>): boolean {
  return Object.entries(meta).every(
    ([k, v]) => /^[A-Za-z0-9_]+$/.test(k) && typeof v === 'string' && /^[A-Za-z0-9_,]*$/.test(v),
  );
}
