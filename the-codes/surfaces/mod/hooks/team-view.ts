import type { TeamMember } from '../types/index.d.ts';
import { elapsed, fitCell, oneLine } from './format.ts';
import { memberGlyph, tokensCell } from './team.ts';

export const TEAM_ROWS = 4;
export const TEAM_KEYS = 9;
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

export function memberNow(m: TeamMember): string {
  if (m.state !== 'working' && m.lastPost) return `posted #${m.lastPost.seq}`;
  return oneLine(m.activity ?? m.task ?? '');
}

export function memberRow(m: TeamMember, now: number, width: number, nameWidth: number): string {
  const right = [memberSpan(m, now), memberTokens(m)].filter(Boolean).join(' · ');
  const room = Math.max(1, width - (right === '' ? 0 : right.length + 2));
  const name = fitCell(oneLine(m.name), Math.min(nameWidth, Math.max(1, room - 2)));
  const model = width >= MODEL_MIN_WIDTH && m.modelLabel ? `  ${oneLine(m.modelLabel, Math.max(8, Math.floor(room / 3)))}` : '';
  const mid = memberNow(m);
  const left = `${memberGlyph(m.state)} ${name}${model}${mid === '' ? '' : `  ${mid}`}`.trimEnd();
  return right === '' ? oneLine(left, width) : `${fitCell(oneLine(left, room), room)}  ${right}`;
}

export function nameWidth(members: readonly TeamMember[], max: number): number {
  return Math.min(max, members.reduce((n, m) => Math.max(n, oneLine(m.name).length), 1));
}

export function memberHeading(m: TeamMember, workerLabel: string, now: number): string {
  return oneLine([`${memberGlyph(m.state)} ${m.name}`, `member of ${workerLabel}`, memberSpan(m, now)].filter(Boolean).join(' · '));
}

export function memberDetailLine(m: TeamMember): string {
  return oneLine([m.modelLabel ?? m.model ?? '', m.role, memberTokens(m), m.lastPost ? `last post #${m.lastPost.seq}` : ''].filter(Boolean).join(' · '));
}
