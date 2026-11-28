import type { Team } from '../types/index.d.ts';
import { toolLabel } from './progress.ts';

export const STALL_GRACE_MS = 15 * 60 * 1000;

export const HEARTBEAT_MS = 30_000;

export const ALIVE_GRACE_MS = 2 * 60_000;

export type LivenessState = 'active' | 'in-tool' | 'waiting' | 'silent' | 'dead';
export const LIVENESS_STATES: readonly LivenessState[] = ['active', 'in-tool', 'waiting', 'silent', 'dead'];

export interface Liveness {
  readonly state: LivenessState;
  readonly silentForMs: number;
  readonly since: number | null;
  readonly forMs: number;
  readonly tool?: string;
}

type Instant = string | number | null | undefined;

export interface LivenessInput {
  readonly status: string;
  readonly updatedAt?: Instant;
  readonly lastEventAt?: Instant;
  readonly lastAliveAt?: Instant;
  readonly lastActivity?: { readonly tool?: unknown; readonly input?: unknown; readonly status?: unknown } | null;
  /** The worker's own sub-agents (team.json). */
  readonly team?: Team | null;
  readonly now: number;
}

/**
 * The newest event of a team member still working. A coordinator waiting on
 * its team emits nothing itself, so its members' events are its activity.
 */
export function workingTeamAt(team: Team | null | undefined): number | null {
  let newest: number | null = null;
  for (const m of team?.members ?? []) {
    if (m.state === 'working' && typeof m.lastEventAt === 'number' && Number.isFinite(m.lastEventAt)) newest = Math.max(newest ?? m.lastEventAt, m.lastEventAt);
  }
  return newest;
}

function epoch(v: Instant): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function livenessOf(i: LivenessInput): Liveness | null {
  if (i.status !== 'running' && i.status !== 'attention') return null;
  const times = [epoch(i.lastEventAt), epoch(i.updatedAt), workingTeamAt(i.team)].filter((t): t is number => t !== null);
  const lastSeen = times.length > 0 ? Math.max(...times) : null;
  const silentForMs = lastSeen === null ? 0 : Math.max(0, i.now - lastSeen);
  const alive = epoch(i.lastAliveAt);
  const a = i.lastActivity;
  const open = a != null && a.status === 'active' && typeof a.tool === 'string' && a.tool !== '';
  const tool = open ? toolLabel(a.tool as string, typeof a.input === 'string' ? a.input : null) : undefined;
  const withTool = tool === undefined ? {} : { tool };

  if (alive !== null && i.now - alive > ALIVE_GRACE_MS) return { state: 'dead', silentForMs, since: alive, forMs: i.now - alive, ...withTool };
  if (lastSeen === null) return { state: 'silent', silentForMs, since: null, forMs: silentForMs, ...withTool };
  if (alive === null && silentForMs > STALL_GRACE_MS) return { state: 'silent', silentForMs, since: lastSeen, forMs: silentForMs, ...withTool };
  if (open) return { state: 'in-tool', silentForMs, since: lastSeen, forMs: silentForMs, ...withTool };
  if (silentForMs > STALL_GRACE_MS) return { state: 'silent', silentForMs, since: lastSeen, forMs: silentForMs };
  return { state: 'active', silentForMs, since: lastSeen, forMs: silentForMs };
}
