/**
 * Liveness and stall evaluation — pure functions, no I/O, no clock reads.
 *
 * "Now" is always a parameter. A function that called Date.now() itself would be
 * untestable at a boundary (is 5 minutes exactly alive or stalled?) and would
 * force every caller to build its own fake clock. So: pass `now`, get a verdict.
 *
 * Two separate questions are answered here, and keeping them apart is the point:
 *
 *  1. Has the worker stopped?      -> `evaluateLiveness`, from `lastEventAt`.
 *  2. Is the worker going in circles? -> `detectToolLoop`, from recent events.
 *
 * They are separate because they escalate differently. A silent job is probably
 * just slow or mid long tool call. A job emitting the *same* tool call over and
 * over is making progress that never terminates, and waiting does not help it —
 * it needs eyes, or a kill. The architecture's own escalation argument applies:
 * generative agreement is not verification, so do not sit and watch a loop
 * hoping it resolves. That is why the repeated-tool rule lives here and not as
 * a special case inside the store.
 */

import type { EventKind, Job, JobEvent } from './types.ts';
import { isTerminalStatus } from './types.ts';

/**
 * Verdict for a job.
 *
 * - 'alive'      recent activity; nothing to do.
 * - 'stalled'    no progress for longer than the grace period, but not past the
 *                hard-dead threshold. Worth surfacing, not worth interrupting.
 * - 'dead'       no progress past the hard threshold. The worker is presumed
 *                gone. Terminal statuses never reach this — see `evaluateLiveness`.
 * - 'done'       reached a terminal status normally.
 * - 'attention'  job is still alive (or unclassified) but needs a human now.
 */
export type Liveness = 'alive' | 'stalled' | 'dead' | 'done' | 'attention';

/**
 * Grace period before a silent job is called stalled. Default 15 minutes.
 *
 * Generous on purpose. Cheap workers take minutes of silence on a single large
 * tool call, and a stall flag that fires on every slow command gets muted by
 * the first week. Being late to notice a stall costs nothing; being noisy costs
 * the whole signal.
 */
export const DEFAULT_GRACE_MS = 15 * 60 * 1000;

/**
 * Hard threshold after which a silent job is presumed dead. Default 60 minutes.
 *
 * Four times the grace period, so a job must stay silent well past 'stalled'
 * before anything irreversible (a restart, an escalation) is justified.
 */
export const DEFAULT_DEAD_MS = 60 * 60 * 1000;

/**
 * Default repeat count that constitutes a tool loop.
 *
 * Two identical calls in a row is the minimum evidence that distinguishes "retry"
 * from "loop", and it is the signal the architecture calls out for escalation.
 * A single repeated call is normal recovery behaviour — a flaky test, a
 * re-read after an edit — and flagging it would produce noise on healthy jobs.
 * Two in a row with identical input means the second attempt could not have
 * learned anything from the first.
 */
export const DEFAULT_REPEAT_THRESHOLD = 2;

/** Inputs for `evaluateLiveness`. */
export interface LivenessOptions {
  /** Silence before 'stalled'. Defaults to DEFAULT_GRACE_MS. */
  graceMs?: number;
  /** Silence before 'dead'. Defaults to DEFAULT_DEAD_MS. */
  deadMs?: number;
  /** Whether the job's own status can force 'attention'. Default true. */
  honorAttention?: boolean;
}

/**
 * How long since the job last demonstrated progress, in ms.
 *
 * Parsed via Date.parse, which returns NaN for a malformed timestamp. A NaN is
 * returned as Infinity (maximally stale) rather than 0 (maximally fresh),
 * because a corrupt timestamp means we do not know, and "we do not know" must
 * never read as healthy. That asymmetry is the whole point.
 */
export function silenceMs(lastEventAt: string, now: Date | string | number): number {
  const then = Date.parse(lastEventAt);
  const current = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (Number.isNaN(then) || Number.isNaN(current)) return Number.POSITIVE_INFINITY;
  return current - then;
}

/**
 * Decide whether a job is alive, stalled, dead, done, or needs attention.
 *
 * Terminal check comes first and wins: a job that finished is `done`, however
 * long ago. Ordering it first is what stops the job list from filling with red
 * entries for work that successfully completed hours ago.
 */
export function evaluateLiveness(
  job: Pick<Job, 'status' | 'lastEventAt'>,
  now: Date | string | number = new Date(),
  options: LivenessOptions = {},
): Liveness {
  const grace = options.graceMs ?? DEFAULT_GRACE_MS;
  const dead = options.deadMs ?? DEFAULT_DEAD_MS;

  if (isTerminalStatus(job.status)) {
    // 'cancelled' and 'failed' both end here too. We report 'done' for all
    // terminal statuses rather than inventing four verdicts: liveness is a
    // question about *activity*, and all terminal states share the answer
    // "no longer active". The specific status stays available on job.status.
    return 'done';
  }

  if ((options.honorAttention ?? true) && job.status === 'attention') {
    return 'attention';
  }

  const silent = silenceMs(job.lastEventAt, now);
  if (silent > dead) return 'dead';
  if (silent > grace) return 'stalled';
  return 'alive';
}

/** A detected repetition, with the evidence attached. */
export interface ToolLoop {
  /** The tool being called repeatedly. */
  tool: string;
  /** How many identical calls in a row were seen. */
  count: number;
  /** The normalized input hash all of them shared, if any. */
  inputHash: string | null;
  /** ISO timestamp of the most recent call in the run. */
  lastAt: string;
}

/** Inputs for `detectToolLoop`. */
export interface ToolLoopOptions {
  /** Consecutive identical calls needed to count as a loop. Default 2. */
  threshold?: number;
  /**
   * Event categories considered for repetition. Default `['tool_call']`.
   *
   * Narrow on purpose. Counting a repeated `message` would flag an agent that
   * legitimately says "I'll check the tests" several times while it works, and
   * that is healthy behaviour, not a loop.
   */
  kinds?: readonly EventKind[];
}

/**
 * Stable hash of a tool input, for equality comparison only.
 *
 * Deliberately not a cryptographic hash. We need "are these two strings
 * identical", not "is this attacker-controlled input being smuggled somewhere",
 * and there is no untrusted-input-to-execution path here — this value only ever
 * round-trips through our own SQLite file. FNV-1a in 32 bits is a few lines,
 * has no dependencies, and is plenty for comparing values that already came
 * from a single process. Callers that want to persist the exact input
 * themselves should not use this; there is no API for it on purpose.
 *
 * JSON.stringify is applied first so that key order in an object input does not
 * produce a false "different input" verdict.
 */
export function hashToolInput(input: unknown): string {
  const text = typeof input === 'string' ? input : safeStringify(input);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // 32-bit FNV prime multiply, done in halves to stay inside float32 exactness.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Canonical serialization for hashing: keys sorted at every level, cycles and
 * BigInts handled, and never throws.
 *
 * Hand-rolled rather than JSON.stringify-with-a-replacer because the two
 * requirements fight each other. A replacer that sorts keys runs *before* the
 * serializer descends, so it cannot see the ancestors that make a cycle; and
 * the usual `this`-based cycle trick needs the un-sorted traversal order.
 * Writing it out is ~15 lines and has no hidden interaction to reason about.
 *
 * Sorting matters: a provider that builds `{a, b}` one way and `{b, a}` another
 * would look like two different tool inputs and hide a real loop.
 */
function safeStringify(value: unknown, ancestors: Set<object> = new Set()): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return 'null';
  }

  if (Array.isArray(value)) {
    // `ancestors` is copied so a repeated (non-cyclic) sibling reference still
    // serializes as its value rather than as '[circular]'.
    const next = new Set(ancestors).add(value);
    return `[${value.map((item) => safeStringify(item, next)).join(',')}]`;
  }

  const object = value as Record<string, unknown>;
  if (ancestors.has(object)) return '"[circular]"';
  const next = new Set(ancestors).add(object);

  const parts: string[] = [];
  for (const key of Object.keys(object).sort()) {
    parts.push(`${JSON.stringify(key)}:${safeStringify(object[key], next)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Detect a run of identical consecutive tool calls.
 *
 * "Identical" means same tool name AND same normalized input hash. The rule
 * walks the *tail* of the event list backwards, counts the run, and stops at the
 * first event that does not match — so it costs O(run length), never O(history).
 * A job looping 50 times reports 50, not 2: the count is what tells an operator
 * whether to interrupt or just look, so it is measured rather than truncated at
 * the threshold.
 *
 * A call with no `toolInputHash` is only treated as identical to another such
 * call if the tool names match. Guessing equality from messages would produce
 * false loops; treating unknown input as always-distinct would make the rule
 * silently never fire for providers that do not hash their inputs. Matching on
 * the tool name alone is the weaker but honest reading.
 *
 * Events must be in ascending `at` order; `recentEvents` returns them that way.
 */
export function detectToolLoop(
  events: readonly JobEvent[],
  options: ToolLoopOptions = {},
): ToolLoop | null {
  const threshold = options.threshold ?? DEFAULT_REPEAT_THRESHOLD;
  const kinds = options.kinds ?? (['tool_call'] as const);
  if (threshold < 2) {
    // A threshold of 1 would report every single call as a loop. That is never
    // what a caller means, so treat it as the minimum instead of returning a
    // guaranteed-false positive.
    throw new RangeError('threshold must be >= 2');
  }

  let count = 0;
  let tool: string | null = null;
  let inputHash: string | null = null;
  let lastAt = '';

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    // noUncheckedIndexedAccess: a holey array is a legitimate input, not a bug.
    if (event === undefined) continue;
    if (!kinds.includes(event.kind)) continue;
    // An event with no tool cannot be a repeated *tool* call.
    if (event.tool === undefined || event.tool === null) continue;

    const eventHash = event.toolInputHash ?? null;

    if (tool === null) {
      // Seed the run with the newest qualifying event.
      tool = event.tool;
      inputHash = eventHash;
      lastAt = event.at;
      count = 1;
    } else if (event.tool === tool && eventHash === inputHash) {
      count++;
    } else {
      // The run ended: this event belongs to a different call. We scan backwards
      // from the tail, so nothing older can extend this run.
      break;
    }
  }

  if (count >= threshold && tool !== null) {
    return { tool, count, inputHash, lastAt };
  }
  return null;
}

/**
 * Convenience: the full escalation picture for one job.
 *
 * Liveness first, because it is the cheap question and the common answer. A
 * detected loop escalates a live job to 'attention' — the worker is not broken,
 * it is looping, and a human (or the pipeline) should decide whether to keep
 * feeding it. Escalating a *dead* job is pointless; it needs restarting, not
 * watching.
 */
export function assessJob(
  job: Job,
  events: readonly JobEvent[],
  now: Date | string | number = new Date(),
  options: LivenessOptions & ToolLoopOptions = {},
): { liveness: Liveness; loop: ToolLoop | null } {
  const liveness = evaluateLiveness(job, now, options);
  // 'alive' must NOT short-circuit: a job that is emitting activity *and*
  // repeating the same call is the most important case there is, and it is
  // alive by the clock. Only finished and presumed-dead jobs skip the scan.
  if (liveness === 'done' || liveness === 'dead') {
    return { liveness, loop: null };
  }
  const loop = detectToolLoop(events, options);
  return { liveness: loop ? 'attention' : liveness, loop };
}