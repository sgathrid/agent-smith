/**
 * team.ts — the shared words for a worker's own sub-agents, so the band, the
 * pane and the channel say the same thing. Pure: no filesystem, no clock.
 */
import type { Team, TeamMember, TeamMemberState } from '../types/index.d.ts';

export interface TeamCounts {
  readonly total: number;
  readonly working: number;
  readonly waiting: number;
  readonly stopped: number;
  readonly done: number;
  readonly failed: number;
  readonly killed: number;
}

export function teamCounts(team: Team | null | undefined): TeamCounts {
  const counts = { total: 0, working: 0, waiting: 0, stopped: 0, done: 0, failed: 0, killed: 0 };
  for (const member of team?.members ?? []) {
    counts.total += 1;
    counts[member.state] += 1;
  }
  return counts;
}

export function hasTeam(team: Team | null | undefined): team is Team {
  return team != null && team.members.length > 0;
}

/** `agents` for a swarm or sub-agents alike; one word keeps the band narrow. */
export function agentsWord(n: number): string {
  return n === 1 ? 'agent' : 'agents';
}

/**
 * The team in a few words, count first because the band cuts from the end:
 * `4/9 agents working`, or `9 agents waiting` when none is working.
 */
export function teamPhrase(team: Team | null | undefined): string {
  if (!hasTeam(team)) return '';
  const c = teamCounts(team);
  if (c.working > 0) return `${c.working}/${c.total} ${agentsWord(c.total)} working`;
  if (c.stopped === c.total) return `${c.total} ${agentsWord(c.total)} stopped`;
  const settled = c.waiting + c.done;
  if (settled === c.total) return `${c.total} ${agentsWord(c.total)} ${c.done === c.total ? 'done' : 'waiting'}`;
  return `${c.total} ${agentsWord(c.total)}`;
}

/** The header line for the pane: `Team 9 · 4 working · 5 waiting · board #15`. */
export function teamHeaderLine(team: Team | null | undefined): string {
  if (!hasTeam(team)) return '';
  const c = teamCounts(team);
  const parts = [`Team ${c.total}`];
  for (const state of ['working', 'waiting', 'stopped', 'done', 'failed', 'killed'] as const) {
    if (c[state] > 0) parts.push(`${c[state]} ${state}`);
  }
  if (team.boardHead !== null && team.boardHead > 0) parts.push(`board #${team.boardHead}`);
  return parts.join(' · ');
}

const STATE_RANK: Record<TeamMemberState, number> = { working: 0, failed: 1, stopped: 2, waiting: 3, done: 4, killed: 5 };

/** Working members first, then by newest event, then by name. */
export function sortMembers(members: readonly TeamMember[]): TeamMember[] {
  return [...members].sort((a, b) =>
    STATE_RANK[a.state] - STATE_RANK[b.state] ||
    (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0) ||
    a.name.localeCompare(b.name));
}

export function memberGlyph(state: TeamMemberState): string {
  switch (state) {
    case 'working': return '⏺';
    case 'failed':
    case 'killed': return '✗';
    case 'stopped':
    case 'waiting':
    case 'done': return '○';
  }
}

/** Compact token count: `219k`, `1.2M`. */
export function tokensCell(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/** A member can be `working` only while its worker's run is live and it has acted since that run began. */
export function settleTeam(team: Team, run: { readonly live: boolean; readonly startedAt: number | null }): Team {
  const ended = (m: TeamMember): boolean => {
    if (!run.live) return true;
    const acted = m.lastEventAt ?? m.startedAt;
    return acted !== null && run.startedAt !== null && acted < run.startedAt;
  };
  if (!team.members.some((m) => m.state === 'working' && ended(m))) return team;
  return { ...team, members: team.members.map((m): TeamMember => (m.state === 'working' && ended(m) ? { ...m, state: 'stopped' } : m)) };
}

const MEMBER_FILE_MAX = 100;

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The file name for a member's view: its id with anything outside [A-Za-z0-9._-]
 * replaced, at most 100 characters; a cut name ends in a hash of the whole id.
 */
export function memberFileName(memberId: string): string {
  const safe = memberId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_';
  const ext = '.json';
  if (safe.length + ext.length <= MEMBER_FILE_MAX) return `${safe}${ext}`;
  const hash = fnv1a(memberId);
  return `${safe.slice(0, MEMBER_FILE_MAX - ext.length - hash.length - 1)}-${hash}${ext}`;
}
