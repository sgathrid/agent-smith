/**
 * team.ts — the shared words for a worker's own sub-agents, so the band, the
 * pane and the channel say the same thing. Pure: no filesystem, no clock.
 */
import type { Team, TeamMember, TeamMemberState } from '../types/index.d.ts';

export interface TeamCounts {
  readonly total: number;
  readonly working: number;
  readonly waiting: number;
  readonly done: number;
  readonly failed: number;
  readonly killed: number;
}

export function teamCounts(team: Team | null | undefined): TeamCounts {
  const counts = { total: 0, working: 0, waiting: 0, done: 0, failed: 0, killed: 0 };
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
  const settled = c.waiting + c.done;
  if (settled === c.total) return `${c.total} ${agentsWord(c.total)} ${c.done === c.total ? 'done' : 'waiting'}`;
  return `${c.total} ${agentsWord(c.total)}`;
}

/** The header line for the pane: `Team 9 · 4 working · 5 waiting · board #15`. */
export function teamHeaderLine(team: Team | null | undefined): string {
  if (!hasTeam(team)) return '';
  const c = teamCounts(team);
  const parts = [`Team ${c.total}`];
  for (const state of ['working', 'waiting', 'done', 'failed', 'killed'] as const) {
    if (c[state] > 0) parts.push(`${c[state]} ${state}`);
  }
  if (team.boardHead !== null && team.boardHead > 0) parts.push(`board #${team.boardHead}`);
  return parts.join(' · ');
}

const STATE_RANK: Record<TeamMemberState, number> = { working: 0, failed: 1, waiting: 2, done: 3, killed: 4 };

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
    default: return '○';
  }
}

/** Compact token count: `219k`, `1.2M`. */
export function tokensCell(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

/** The file name for a member's view: its id with anything outside [A-Za-z0-9._-] replaced. */
export function memberFileName(memberId: string): string {
  const safe = memberId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  return `${safe === '' ? '_' : safe}.json`;
}
