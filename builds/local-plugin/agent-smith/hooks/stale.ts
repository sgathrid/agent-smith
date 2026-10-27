import { toolLabel } from './progress.ts';

/**
 * The one place the stall threshold is defined.
 *
 * WHY THIS FILE EXISTS: two surfaces (the mod pane and the channel) each need to
 * answer "is this running job actually working?", and if they disagree the user
 * gets a band that says a job is fine while the channel tells Claude it is stuck.
 * That contradiction is the exact failure this project exists to eliminate, so the
 * number is stated once.
 *
 * WHY ONE CONSTANT HERE: the mod cannot resolve a bare specifier for a sibling
 * package, and duplicating the literal in two files is how they drift. So: one
 * constant, here, imported by both surfaces.
 *
 * Value: 15 minutes.
 * Reasoning that number is defensible: agy-staff's own default timeout is 60m
 * (every real spec.json in the corpus says `timeout: "60m"`), so 15m of silence
 * is a quarter of the budget gone with nothing to show, while still leaving ample
 * room for a genuinely long single command like `cargo test --workspace` on a
 * cold target directory.
 */
export const STALL_GRACE_MS = 15 * 60 * 1000;

/**
 * How often the process owner (providers/ndjson.ts) records that the worker's
 * CLI process is still running: progress.json `lastAliveAt`.
 */
export const HEARTBEAT_MS = 30_000;

/** A heartbeat older than this, on a job still marked running, means nobody is running it. */
export const ALIVE_GRACE_MS = 2 * 60_000;

/**
 * What a running job is doing, as far as the harness can prove:
 *   active   an event within STALL_GRACE_MS
 *   in-tool  the latest tool call has started and not ended (a long command is not a stall)
 *   waiting  RESERVED for known live child workers (agy team members, Claude
 *            subagents). Not produced yet: it needs child tracking, and the
 *            harness does not claim what it cannot see.
 *   silent   no event for STALL_GRACE_MS, but the process heartbeat is fresh
 *            (or, for a job from an older build with no heartbeat, simply silent)
 *   dead     the heartbeat is older than ALIVE_GRACE_MS while the job is still running
 */
export type LivenessState = 'active' | 'in-tool' | 'waiting' | 'silent' | 'dead';
export const LIVENESS_STATES: readonly LivenessState[] = ['active', 'in-tool', 'waiting', 'silent', 'dead'];

export interface Liveness {
  readonly state: LivenessState;
  /** Since the last provider event (0 when no event time is known). */
  readonly silentForMs: number;
  /** Epoch ms the current state is measured from: the last heartbeat for `dead`, else the last event. Null when unknown. */
  readonly since: number | null;
  /** How long the state has held: since the last heartbeat for `dead`, else silentForMs. */
  readonly forMs: number;
  /** The open tool call, for `in-tool` (and a silent job from an older build that is mid-call). */
  readonly tool?: string;
}

/** A time from either surface: ISO string (channel) or epoch ms (mod). */
type Instant = string | number | null | undefined;

export interface LivenessInput {
  readonly status: string;
  readonly updatedAt?: Instant;
  readonly lastEventAt?: Instant;
  readonly lastAliveAt?: Instant;
  readonly lastActivity?: { readonly tool?: unknown; readonly input?: unknown; readonly status?: unknown } | null;
  readonly now: number;
}

function epoch(v: Instant): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * The one liveness rule. Both surfaces call it (the channel for `status` and
 * `list_jobs` and its attention push, the mod for the band, pane and notices),
 * so they cannot disagree. Null for a job that is not running.
 */
export function livenessOf(i: LivenessInput): Liveness | null {
  if (i.status !== 'running' && i.status !== 'attention') return null;
  const times = [epoch(i.lastEventAt), epoch(i.updatedAt)].filter((t): t is number => t !== null);
  const lastSeen = times.length > 0 ? Math.max(...times) : null;
  const silentForMs = lastSeen === null ? 0 : Math.max(0, i.now - lastSeen);
  const alive = epoch(i.lastAliveAt);
  const a = i.lastActivity;
  const open = a != null && a.status === 'active' && typeof a.tool === 'string' && a.tool !== '';
  const tool = open ? toolLabel(a.tool as string, typeof a.input === 'string' ? a.input : null) : undefined;
  const withTool = tool === undefined ? {} : { tool };

  if (alive !== null && i.now - alive > ALIVE_GRACE_MS) return { state: 'dead', silentForMs, since: alive, forMs: i.now - alive, ...withTool };
  // No event time at all: unknown is never drawn as healthy.
  if (lastSeen === null) return { state: 'silent', silentForMs, since: null, forMs: silentForMs, ...withTool };
  // An older build wrote no heartbeat: only the old silence rule is provable.
  if (alive === null && silentForMs > STALL_GRACE_MS) return { state: 'silent', silentForMs, since: lastSeen, forMs: silentForMs, ...withTool };
  if (open) return { state: 'in-tool', silentForMs, since: lastSeen, forMs: silentForMs, ...withTool };
  if (silentForMs > STALL_GRACE_MS) return { state: 'silent', silentForMs, since: lastSeen, forMs: silentForMs };
  return { state: 'active', silentForMs, since: lastSeen, forMs: silentForMs };
}

/** The old boolean, derived: true for `silent` or `dead`. */
export function isStalled(l: Liveness | null): boolean {
  return l !== null && (l.state === 'silent' || l.state === 'dead');
}
