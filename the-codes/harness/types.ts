/**
 * types.ts — the contract between harness/ readers and their consumers.
 *
 * The whole thesis of agent-smith is that we do not need to instrument a worker
 * to see it work: workers already write a complete, continuously updated job
 * snapshot to disk, and we just read those files. This module is the seam of
 * that idea.
 *
 * Rules every consumer relies on:
 *   - `ObservedStatus` has 5 states, including `unknown`. `unknown` is
 *     load-bearing: workers mutate files live, so evidence can be contradictory,
 *     and guessing "running" or "succeeded" would draw a lie on the band.
 *     Never collapse it into a default.
 *   - `ObservedJob.warnings` is `ObservedWarning[]`; use `code` for logic and
 *     `message` for display.
 *   - `ObservedJob.raw` keeps the provider payload for the debug dump. Consumers
 *     must not parse it.
 *   - Timestamps are ISO-8601 strings or null, never Date objects.
 *   - `ObservedJob` is a snapshot, not a live handle. Two `read()` calls are two
 *     independent observations and may disagree.
 */

/** A reader for one provider's on-disk job-state layout. */
export interface JobStateReader {
  /** Stable provider key used by the registry, e.g. "agy-staff". */
  readonly provider: string;

  /**
   * List the job ids this provider knows about for a given working directory.
   *
   * MUST NOT throw. Returns `[]` when the directory is unknown to the
   * provider — that is the common case, not an error.
   */
  discover(cwd: string): Promise<string[]>;

  /**
   * Read one job's current state.
   *
   * Returns `null` when the job is unknown to this provider. Note that a
   * *known but finished* job still returns a full snapshot: see hazard A in
   * agy-staff.ts, where the live-progress file is deliberately deleted.
   */
  read(cwd: string, jobId: string): Promise<RawJobState | null>;
}

/**
 * Provider-specific state, lightly shaped.
 *
 * Deliberately loose. `payload` is `Record<string, unknown>` because every
 * provider evolves its own layout and we would be chasing it forever if this
 * type tried to pin every field. The *reader* is responsible for doing the
 * provider-specific parsing (see agy-staff.ts) and putting
 * something useful in `payload`; `normalize.ts` is responsible for mapping that
 * onto the provider-agnostic `ObservedJob`.
 */
export interface RawJobState {
  /** Which reader produced this. Used to select a normalizer. */
  readonly provider: string;
  /** Job identity as the provider spells it. */
  readonly jobId: string;
  /** Directory the job ran in, as reported by the provider (may be stale). */
  readonly cwd: string;
  /**
   * Provider-shaped fields the reader managed to extract. Keys are
   * reader-specific and documented on each reader.
   */
  readonly payload: Record<string, unknown>;
  /** True when the reader found evidence the job exists but read it partially. */
  readonly partial?: boolean;
}

/** Normalized, provider-agnostic job state. This is what consumers read. */
export interface ObservedJob {
  readonly provider: string;
  readonly jobId: string;

  /** Normalized lifecycle state. `unknown` means the evidence was contradictory. */
  readonly status: ObservedStatus;
  /** Non-fatal problems. An empty array means "nothing suspicious", NOT "clean". */
  readonly warnings: readonly ObservedWarning[];

  /** Best-available final answer, already de-polluted by the reader. */
  readonly output: string | null;

  /** ISO-8601 or null. When the provider gave no time, do not invent one. */
  readonly startedAt: string | null;
  /** ISO-8601 of the most recent evidence we saw. Good cursor for incremental reads. */
  readonly updatedAt: string | null;
  /** ISO-8601 or null; set only for terminal jobs. */
  readonly finishedAt: string | null;

  /** Provider-declared role/model/label, when the provider records them. */
  readonly mode: string | null;
  readonly model: string | null;
  readonly label: string | null;

  /** True when the output we hold is known to be incomplete or lossy. */
  readonly outputTruncated: boolean;

  /** Numeric telemetry when the provider reports it. All nullable. */
  readonly usage: ObservedUsage | null;

  /** True if this snapshot was assembled from incomplete/contradictory evidence. */
  readonly partial: boolean;
  /** The untouched provider payload, for the debug dump. consumers must not parse this. */
  readonly raw: Record<string, unknown>;
}

export type ObservedStatus =
  /** Evidence indicates the job is still progressing. */
  | "running"
  /** Job reports completion with no contradicting evidence. */
  | "succeeded"
  /** Job reports an error, or is contradicted by hard error evidence. */
  | "failed"
  /** Job was explicitly cancelled/stopped. */
  | "canceled"
  /** Evidence is missing, partial, or contradictory. NEVER collapse this. */
  | "unknown";

/**
 * A single stable warning code + human message.
 *
 * `code` is the grouping key for UI. Keep the set small and stable; the whole
 * point of "a suspicious success is not a clean success" is that a machine can
 * act on the code without string-matching a message.
 */
export type ObservedWarningCode =
  /** Provider said "done" but we found contradicting evidence. */
  | "suspicious_success"
  /** Provider reported a tool/API error somewhere during the run. */
  | "tool_error"
  /** A queued steer was dropped because the turn it waited on did not succeed. */
  | "steer_not_applied"
  /** The job was cancelled. */
  | "canceled"
  /** The result text was found polluted and had to be cleaned. */
  | "polluted_result"
  /** Final answer is empty/trivial — often a silent failure. */
  | "empty_output"
  /** A field we would normally read was absent; snapshot may be incomplete. */
  | "incomplete_state";

export interface ObservedWarning {
  readonly code: ObservedWarningCode;
  /** Human-readable, for the mod band. Do not parse this. */
  readonly message: string;
}

/** Best-effort numeric telemetry. Every field nullable — providers vary wildly. */
export interface ObservedUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly thinkingTokens?: number;
  readonly cacheTokens?: number;
  readonly durationMs?: number;
  readonly turns?: number;
}

/**
 * Normalizes a provider-specific payload into the common shape.
 *
 * Implemented in normalize.ts and registered per provider. Keeping this a
 * function (not a method on the reader) means normalize.ts owns every
 * provider-quirk rule in one file, which is where a reviewer should look.
 */
export type JobNormalizer = (raw: RawJobState) => ObservedJob;