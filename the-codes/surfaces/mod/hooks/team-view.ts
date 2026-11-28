/**
 * team-view.ts — the pane's words for a worker's team: one row per member and
 * the member view's two header lines. Pure: the caller supplies the clock.
 */
import type { TeamMember } from '../types/index.d.ts';
import { elapsed, fitCell, oneLine } from './format.ts';
import { memberGlyph, tokensCell } from './team.ts';

export const TEAM_ROWS = 4;
/** Hotkeys 1-9 only reach this many members. */
export const TEAM_KEYS = 9;
/** The model column is dropped below this width. */
const MODEL_MIN_WIDTH = 50;

export function memberSpan(m: TeamMember, now: number): string {
  if (m.startedAt === null) return '';
  const end = m.state === 'working' ? now : (m.lastEventAt ?? now);
  return elapsed(end - m.startedAt);
}

export function memberTokens(m: TeamMember): string {
  const t = tokensCell(m.tokensOut);
  return t === '' ? '' : `↓ ${t}`;
}

/** What the member is doing, or for a settled one the post it left. */
export function memberNow(m: TeamMember): string {
  if (m.state !== 'working' && m.lastPost) return `posted #${m.lastPost.seq}`;
  return oneLine(m.activity ?? m.task ?? '');
}

/** One row: glyph, name, model, activity; duration and tokens at the right edge. `width` excludes the hotkey. */
export function memberRow(m: TeamMember, now: number, width: number, nameWidth: number): string {
  const right = [memberSpan(m, now), memberTokens(m)].filter(Boolean).join(' · ');
  const room = Math.max(1, width - (right === '' ? 0 : right.length + 2));
  const name = fitCell(oneLine(m.name), Math.min(nameWidth, Math.max(1, room - 2)));
  // Capped so a long label cannot push the activity out of the row.
  const model = width >= MODEL_MIN_WIDTH && m.modelLabel ? `  ${oneLine(m.modelLabel, Math.max(8, Math.floor(room / 3)))}` : '';
  const mid = memberNow(m);
  const left = `${memberGlyph(m.state)} ${name}${model}${mid === '' ? '' : `  ${mid}`}`.trimEnd();
  return right === '' ? oneLine(left, width) : `${fitCell(oneLine(left, room), room)}  ${right}`;
}

/** Member names padded to the longest visible one, so the next column lines up. */
export function nameWidth(members: readonly TeamMember[], max: number): number {
  return Math.min(max, members.reduce((n, m) => Math.max(n, oneLine(m.name).length), 1));
}

/** `⏺ neon-681-core · member of Review · 14m`. */
export function memberHeading(m: TeamMember, workerLabel: string, now: number): string {
  return oneLine([`${memberGlyph(m.state)} ${m.name}`, `member of ${workerLabel}`, memberSpan(m, now)].filter(Boolean).join(' · '));
}

export function memberDetailLine(m: TeamMember): string {
  return oneLine([m.modelLabel ?? m.model ?? '', m.role, memberTokens(m), m.lastPost ? `last post #${m.lastPost.seq}` : ''].filter(Boolean).join(' · '));
}
