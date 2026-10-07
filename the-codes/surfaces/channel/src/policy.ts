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
 * Budget: ~50 tokens per event. That is one short sentence plus a `meta` object.
 * A push longer than that is a bug, not a feature.
 */

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
  readonly latestSummary?: string | null;
  readonly summarySource?: 'worker' | null;
  /** Runtime-owned outcome, separate from worker-authored prose. */
  readonly outcome?: string;
  readonly status: WatchStatus;
  /** ISO-8601 of the last evidence of real work. Null ⇒ we have no evidence. */
  readonly lastEventAt: string | null;
  /** ISO-8601 the job reached a terminal state. Null while it has not. */
  readonly finishedAt: string | null;
  /** Whether the provider flagged warnings. Meaningful only once terminal. */
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
 * If five jobs fail in the same tick, the user gets one line naming five jobs.
 * Not five lines. This is not a formatting preference — it is the difference
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
 * The grouping is by KIND, not by job. "three finished, one failed" is a
 * different piece of news from "four failed", and Claude's useful next action
 * differs: several successes is usually "carry on", several failures is usually
 * "stop and look". Collapsing them into one undifferentiated list would throw
 * that away.
 */
export function buildBatch(candidates: readonly Candidate[], now: number): Batch {
  const pushable = candidates.filter((c) => shouldPush(c, now));

  if (pushable.length === 0) {
    return { content: null, meta: {}, keys: [] };
  }

  const keys = pushable.map((c) => dedupeKey(c.job));

  // Single event: the specific, terse, per-event message. This is the common
  // case and it is the one that earns its tokens by being actionable.
  if (pushable.length === 1) {
    const only = pushable[0]!;
    const kind = pushKindFor(only.job)!;
    return {
      content: renderOne(kind, only.job),
      meta: metaFor(kind, [only.job]),
      keys,
    };
  }

  // Several at once: one line per KIND, joined. Never one line per job.
  const byKind = new Map<PushKind, WatchableJob[]>();
  for (const c of pushable) {
    const kind = pushKindFor(c.job)!;
    const list = byKind.get(kind);
    if (list) list.push(c.job);
    else byKind.set(kind, [c.job]);
  }

  const clauses: string[] = [];
  const metaJobs: WatchableJob[] = [];
  for (const [kind, jobs] of byKind) {
    clauses.push(`${jobs.length} ${PLURAL[kind]}`);
    metaJobs.push(...jobs);
  }
  const failedCount = byKind.get('failed')?.length ?? 0;

  // Failures are named even in a batch. "4 failed" does not tell Claude which
  // four, and the whole value of the channel is that Claude can act without the
  // user retyping a job id. Names cost ~4 tokens each; four of them is worth it.
  const named = (byKind.get('failed') ?? []).map((j) => j.name ? `${j.name} (${j.id})` : j.id).join(', ');

  const content =
    `agy: ${clauses.join(', ')}` +
    (failedCount > 0 ? ` (${named})` : '') +
    (pushable.some(c => c.job.name) ? '. /forge to inspect.' : '. /agy-radar to inspect.') + pushable.filter(c => c.job.name).slice(0, 3).map(c => {
      const job = c.job;
      const evidence = job.outcome ?? (job.summarySource === 'worker' ? job.latestSummary : null);
      return evidence ? ` ${job.name}: ${job.outcome ? 'Runtime outcome' : 'Worker output'}: ${evidence.replace(/\s+/g, ' ').slice(0, 250)}` : '';
    }).join('');

  return { content, meta: metaFor('failed', metaJobs), keys };
}

/** Plural noun for each kind, used only in batch headlines. */
const PLURAL: Record<PushKind, string> = {
  finished: 'finished',
  failed: 'failed',
  attention: 'need attention',
  cancelled: 'cancelled',
};

/**
 * The single-event message.
 *
 * The required shape:
 *
 *   agy job implement-musm82da finished after 28m with warnings. cargo test
 *   exited 1. It reported tests passing. /agy-radar to inspect.
 *
 * Every clause is a fact we actually hold, and the order is chosen so the most
 * decision-relevant fact comes first: what happened, then how long, then the
 * evidence, then the contradiction. It ends with the escape hatch, because the
 * channel's job is to make Claude aware, not to make Claude do the work.
 */
function renderOne(kind: PushKind, job: WatchableJob): string {
  if (job.name) {
    const state = kind === 'finished' ? 'completed execution' : kind === 'attention' ? 'needs attention' : kind;
    const summary = job.summarySource === 'worker' && job.latestSummary
      ? ` Worker output: ${job.latestSummary.replace(/\s+/g, ' ').slice(0, 600)}` : '';
    return `${job.name}${job.role ? ` (${job.role})` : ''} ${state}. ID ${job.id}.${job.outcome ? ` Runtime outcome: ${job.outcome.slice(0, 600)}` : ''}${summary} /forge or status to inspect.`;
  }
  const id = job.id;
  const dur = durationWords(job.finishedAt, job.lastEventAt);

  switch (kind) {
    case 'finished':
      return (
        `agy job ${id} finished${dur}${job.warned ? ' with warnings' : ''}. ` +
        `/agy-radar to inspect.`
      );
    case 'failed':
      return (
        `agy job ${id} failed${dur}${job.warned ? ' with warnings' : ''}. ` +
        `It may have claimed otherwise — /agy-radar to inspect.`
      );
    case 'cancelled':
      return `agy job ${id} was cancelled. /agy-radar to inspect.`;
    case 'attention':
      return (
        `agy job ${id} has stopped making progress${dur}. ` +
        `It may be stuck — /agy-radar to inspect.`
      );
  }
}

/**
 * " after 28m" from the two timestamps, or '' when we cannot say.
 *
 * We only speak about a duration we can actually derive. job.finishedAt minus
 * job.lastEventAt is not the runtime — lastEventAt is the last EVENT, which for a
 * fast job is seconds before it ended. So we do not pretend: if the only two
 * times we hold are within a minute of each other, the honest rendering is no
 * duration at all rather than "after 4s" for a 28-minute job.
 */
function durationWords(finishedAt: string | null, lastEventAt: string | null): string {
  if (finishedAt === null) return '';
  const end = Date.parse(finishedAt);
  if (Number.isNaN(end)) return '';
  if (lastEventAt === null) return '';
  const start = Date.parse(lastEventAt);
  if (Number.isNaN(start)) return '';
  const ms = end - start;
  // Under a minute apart is not a runtime; it is a measurement artifact.
  if (ms <= 0 || ms < 60_000) return '';
  const mins = Math.round(ms / 60_000);
  return mins >= 1 ? ` after ${mins}m` : '';
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
