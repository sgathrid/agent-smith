/**
 * agent-smith core — canonical type contract.
 *
 * This file is the seam between providers, harness readers, and surfaces. It is
 * deliberately provider-agnostic: nothing here names agy, Codex, OpenCode or
 * Claude as a required value. A provider maps its own vocabulary onto these
 * types at its own boundary, so adding a worker must never require an edit here.
 *
 * Two rules govern everything below:
 *
 *  1. The store is the single source of truth. Surfaces are read-only
 *     projections of it (see docs/ARCHITECTURE.md), so a type that only a
 *     surface would ever read does not belong in the store row.
 *  2. Timestamps are ISO-8601 UTC strings, never epoch numbers. They sort
 *     lexicographically (which is what SQLite TEXT columns rely on), they are
 *     legible in `sqlite3` dumps, and they survive being copy-pasted into a bug
 *     report. Epoch numbers are only ever derived internally, at a point where
 *     arithmetic is actually needed (see core/liveness.ts).
 */

/**
 * Which worker produced this job. Kept as a plain string (branded in spirit,
 * not in type) because the set of workers is owned by providers/, which is out
 * of this module's scope and expected to grow without a core release. The four
 * values below are the ones the architecture currently names; they exist for
 * documentation and for surfaces that want to highlight a known worker, NOT as
 * a closed union. Treating this as a union would force every new provider to
 * open a core PR, which is exactly the coupling core/ is supposed to avoid.
 */
export type ProviderName = string;

/**
 * Known provider names, for surfaces that want a friendly label or an icon.
 * Optional convenience only — never switch on this exhaustively.
 */
export const KNOWN_PROVIDERS = ['agy', 'codex', 'opencode', 'claude'] as const;
export type KnownProviderName = (typeof KNOWN_PROVIDERS)[number];

/**
 * Lifecycle state of a job, as understood by every worker.
 *
 * The important distinction is that most of these are *claims*, not facts. We
 * are inferring a worker's state by reading artifacts it wrote, and no worker
 * tells us when it has genuinely finished. So:
 *
 * - 'running'    the worker is emitting activity. The default for anything we
 *                believe is in flight.
 * - 'done'       the worker reported success (or exited 0 after we believe it
 *                finished its task).
 * - 'failed'     the worker reported failure, or exited non-zero / died.
 * - 'cancelled'  we stopped it (user action or pipeline teardown). Distinct
 *                from 'failed' on purpose: a cancelled job is not a bug, and
 *                an alert on one trains people to ignore alerts.
 * - 'attention'  the job is not finished but a human should look now. This is
 *                the state escalation targets: a stalled loop, a repeated tool
 *                call, a suspicious error rate. It is deliberately *not* a
 *                terminal state — the worker is still alive, we just want eyes.
 * - 'unknown'    we cannot tell. A reader has not found the job yet, or found
 *                state we could not parse. This exists so "no data" never has
 *                to masquerade as "running": an unknown job must not be drawn as
 *                healthy, and it must not be alerted on either. It is the
 *                honest default.
 *
 * 'unknown' is a real risk of this design and is the reason `lastEventAt`
 * exists separately (see Job.lastEventAt).
 */
export type JobStatus =
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'attention'
  | 'unknown';

/**
 * Statuses after which no further events are expected. Liveness evaluation
 * short-circuits on these: a job that finished 6 hours ago is not dead, it is
 * done, and treating it as dead would produce a permanently red list.
 */
export const TERMINAL_STATUSES: readonly JobStatus[] = ['done', 'failed', 'cancelled'];

/**
 * Statuses that mean a worker is still (or may still be) in flight. 'unknown'
 * is included because a worker we cannot read may still be running, and we must
 * keep evaluating it rather than assuming either outcome.
 */
export const ACTIVE_STATUSES: readonly JobStatus[] = [
  'running',
  'attention',
  'unknown',
];

/**
 * Type guard for terminal statuses. Exported because liveness and surfaces both
 * need it and duplicating the array membership test invites drift.
 */
export function isTerminalStatus(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * The single thing a worker is doing right now, normalized.
 *
 * A provider reader maps its own vocabulary (a Claude `tool_use` block, a Codex
 * `exec` line, an agy transcript header) into this shape. Surfaces depend on
 * this shape, not on any provider's names.
 *
 * `detail` is free text intended for a human. It is allowed to be ugly,
 * truncated, or empty — never parse it.
 */
export interface Activity {
  /** Coarse category, safe to group or filter on. */
  kind: ActivityKind;
  /** Short human label, e.g. "editing src/store.ts". */
  label: string;
  /** Optional longer text. Display only. */
  detail?: string;
}

/**
 * Coarse activity categories. Deliberately small and non-provider-specific: a
 * surface should be able to render every kind, and adding a kind is a breaking
 * change for surfaces that switch exhaustively.
 *
 * 'idle' matters: a worker that is alive but between steps should read as idle
 * rather than as "running the same thing", otherwise a surface that animates
 * 'running' makes an idle job look productive.
 */
export type ActivityKind =
  | 'thinking'
  | 'reading'
  | 'writing'
  | 'command'
  | 'network'
  | 'review'
  | 'idle'
  | 'other';

/**
 * A non-fatal signal worth showing a human, attached to a job.
 *
 * Warnings are the escape hatch for "something is off but the job is still
 * going". They are deliberately weaker than 'attention': a warning is
 * information, an attention state is a request for eyes. Escalation logic in
 * core/liveness.ts decides when the latter follows from the former.
 */
export interface Warning {
  /** Stable machine-readable code, e.g. 'repeated_tool_call'. Switch on this. */
  code: string;
  /** Human-readable sentence. Display only. */
  message: string;
  /**
   * When the warning was raised. ISO-8601, same as every other timestamp.
   */
  at: string;
  /**
   * Optional narrowing context, e.g. the tool name that repeated. Kept as
   * free-form because the interesting fields differ per warning code and a
   * union of warning shapes would be a schema migration every time we add one.
   */
  context?: Record<string, string | number | boolean>;
}

/**
 * A job as stored and rendered. One row in the `jobs` table, one JSON object
 * crossing the bus, one line in a mod. This is the widest type in the system
 * and the one a surface binds to.
 */
export interface Job {
  /**
   * Stable, unique identifier. Assigned by whoever creates the job (the
   * pipeline, or a provider reader on first sight) and never reused, even after
   * pruning. Primary key of the `jobs` table and the foreign key of `events`.
   *
   * Must be filesystem-safe and terminal-safe: it appears in filenames and in
   * mod title lines.
   */
  id: string;

  /**
   * Human-facing one-liner. Surfaces show this first. Not required to be
   * unique or stable — it may change as we learn more about the job.
   */
  title: string;

  /** Which worker produced this. See ProviderName. */
  provider: ProviderName;

  /** Current lifecycle state. See JobStatus. */
  status: JobStatus;

  /**
   * The pipeline stage this job is executing, when running under a pipeline
   * ('implement', 'review', 'moderate'). Null for standalone jobs. Optional
   * because stage names are owned by the pipeline layer, not by core.
   */
  stage?: string | null;

  /** Working directory the worker was launched in. Null if never reported. */
  cwd?: string | null;

  /** OS process id, when the worker exposes one. Null otherwise. */
  pid?: number | null;

  /** The task/prompt text, truncated to a sane length. Full text lives in the worker's own artifacts. */
  task?: string | null;

  /** ISO-8601 UTC. When the job was first seen. */
  startedAt: string;

  /** ISO-8601 UTC. When this row last changed. Advances on ANY write. */
  updatedAt: string;

  /**
   * ISO-8601 UTC. The job's *progress clock*, and the single most important
   * field in this file.
   *
   * Semantics: the timestamp of the most recent event that demonstrates the
   * worker is still doing something. It deliberately does NOT advance on
   * bookkeeping — re-reading an unchanged file, redrawing a surface, storing the
   * same row again. If it advanced on every poll, a dead worker whose state file
   * is still on disk would look alive forever, which is precisely the failure
   * mode this whole project exists to fix.
   *
   * Rule of thumb: if nothing about the *worker's behaviour* changed, nothing
   * about the job changed, and `lastEventAt` must not move.
   *
   * Liveness is computed as (now - lastEventAt) against a grace period; see
   * core/liveness.ts, which is the only place allowed to do that arithmetic.
   */
  lastEventAt: string;

  /**
   * ISO-8601 UTC. When the job reached a terminal status, else null. Kept
   * separate from updatedAt because "how long has it been finished" and "when
   * did this row last change" are different questions and surfaces ask both.
   */
  endedAt?: string | null;

  /**
   * What the worker is doing right now, normalized. Null when we do not know —
   * which is distinct from an `idle` activity, which is a positive claim.
   */
  activity?: Activity | null;

  /**
   * Non-fatal signals accumulated for this job, oldest first. Never cleared
   * automatically; a surface can decide to show only the recent tail.
   *
   * Deduplication is the writer's job, not the store's. A repeated warning is
   * usually a real change in the worker's behaviour and should be visible.
   */
  warnings?: Warning[];

  /**
   * Free-form counters the providers can supply (tokens, cost, turn count).
   * Core never computes these and never interprets them — it stores what it is
   * told so that surfaces have one place to read from. Absent rather than 0
   * when unknown, so a surface can distinguish "no usage reported" from
   * "reported zero".
   */
  metrics?: Record<string, number>;
}

/**
 * A single observable moment in a job's life. Append-only.
 *
 * The events table is the audit trail and the thing liveness is measured
 * against. We keep events even for terminal jobs so that "why did this fail"
 * is answerable after the fact — that is the whole reason a store exists
 * alongside a status column.
 */
export interface JobEvent {
  /**
   * Monotonic per-job sequence number, assigned by the store. Gaps are allowed
   * if a caller supplies an explicit value, but callers should omit it and let
   * the store assign.
   *
   * This is what makes ordering reliable when two providers write with
   * wall-clock timestamps from different machines: clocks disagree, sequences
   * cannot.
   */
  seq?: number;

  /** Owning job. */
  jobId: string;

  /** ISO-8601 UTC. When the thing happened, per the observing provider's clock. */
  at: string;

  /** Coarse event category. Surfaces filter on this to stay cheap. */
  kind: EventKind;

  /** Short human-readable summary. Display only. */
  message: string;

  /** Tool name for tool events; free-form otherwise. */
  tool?: string | null;

  /**
   * Normalized hash of a tool's input, when there is one. Stored instead of
   * raw input because (a) inputs are large and often contain source code, and
   * (b) the repeated-call stall detector only needs equality, not contents.
   * See core/liveness.ts#isRepeatedToolCall.
   */
  toolInputHash?: string | null;

  /**
   * Arbitrary structured detail. JSON-encoded in the store. Optional because
   * most events need none, and an always-present empty object invites callers
   * to write into it ad hoc.
   */
  data?: Record<string, unknown>;
}

/**
 * Event categories.
 *
 * Split into two groups by whether they prove forward progress:
 *
 *  - 'tool_call' and 'message' DO advance lastEventAt. The worker emitted
 *    something new; it is demonstrably working.
 *  - 'status' and 'note' do NOT. They record something about the job that we
 *    already know, or a diagnostic observation that does not imply the worker
 *    moved. A status flip does not need to advance the progress clock — the
 *    event that caused the flip will.
 *
 * Keeping that boundary here, on the union, is deliberate: it means the liveness
 * rule is checkable by reading one file, instead of being spread across every
 * provider reader that happens to write events.
 */
export type EventKind =
  | 'tool_call'
  | 'message'
  | 'status'
  | 'note';

/** Event kinds that count as proof the worker is still making progress. */
export const PROGRESS_EVENT_KINDS: readonly EventKind[] = ['tool_call', 'message'];

/** True if an event of this kind should advance Job.lastEventAt. */
export function isProgressEvent(kind: EventKind): boolean {
  return PROGRESS_EVENT_KINDS.includes(kind);
}

/**
 * Filter for listJobs(). All fields optional and ANDed together; omitted
 * fields do not constrain the result. This is intentionally a flat struct and
 * not a query builder — the store has exactly one caller shape and a query
 * builder would be an abstraction nobody asked for.
 */
export interface JobFilter {
  /** Exact provider match. */
  provider?: ProviderName;
  /** Exact status match. */
  status?: JobStatus;
  /** Exact stage match. */
  stage?: string;
  /**
   * Only jobs whose lastEventAt is newer than this ISO timestamp. The main
   * "what is actually alive right now" query for surfaces.
   */
  activeSince?: string;
  /** Substring match against title or id, case-insensitive. For `/`-style search. */
  search?: string;
  /** Cap on rows returned. Applied after ordering. */
  limit?: number;
}