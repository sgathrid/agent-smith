import type { TeamMember } from '../types/index.d.ts';
import { elapsed, fitCell, oneLine } from './format.ts';
import { memberGlyph, memberMark, shortModel, tokensCell } from './team.ts';

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

export interface TeamColumns {
  readonly name: number;
  readonly model: 'full' | 'short' | 'none';
  readonly modelWidth: number;
  readonly right: number;
}

const NAME_MAX = 24;
const MIN_ACTIVITY = 12;
const longest = (members: readonly TeamMember[], cell: (m: TeamMember) => string): number =>
  members.reduce((n, m) => Math.max(n, cell(m).length), 0);
const fullModel = (m: TeamMember): string => oneLine(m.modelLabel ?? m.model ?? '');
const rightCell = (m: TeamMember, now: number): string => [memberSpan(m, now), memberTokens(m)].filter(Boolean).join(' · ');

export function teamColumns(members: readonly TeamMember[], now: number, width: number): TeamColumns {
  const right = longest(members, (m) => rightCell(m, now));
  const room = Math.max(1, width - (right === 0 ? 0 : right + 2));
  const name = Math.min(NAME_MAX, Math.max(1, longest(members, (m) => oneLine(m.name))), Math.max(1, room - 2));
  const left = room - 2 - name;
  const activity = Math.min(MIN_ACTIVITY, longest(members, memberNow));
  const fits = (w: number): boolean => w > 0 && left - 2 - w - 2 >= activity;
  const full = longest(members, fullModel);
  const short = longest(members, (m) => oneLine(shortModel(m)));
  if (width >= MODEL_MIN_WIDTH && fits(full)) return { name, model: 'full', modelWidth: full, right };
  if (width >= MODEL_MIN_WIDTH && fits(short)) return { name, model: 'short', modelWidth: short, right };
  return { name, model: 'none', modelWidth: 0, right };
}

export function memberRow(m: TeamMember, now: number, width: number, columns: TeamColumns): string {
  const right = rightCell(m, now).padStart(columns.right);
  const room = Math.max(1, width - (columns.right === 0 ? 0 : columns.right + 2));
  const model = columns.model === 'none' ? ''
    : `  ${fitCell(oneLine(columns.model === 'full' ? fullModel(m) : shortModel(m), columns.modelWidth), columns.modelWidth)}`;
  const used = 2 + columns.name + model.length + 2;
  const mid = fitCell(memberNow(m), Math.max(0, room - used)).trimEnd();
  const left = `${memberGlyph(memberMark(m))} ${fitCell(oneLine(m.name), columns.name)}${model}  ${mid}`;
  return columns.right === 0 ? fitCell(left, width).trimEnd() : `${fitCell(left, room)}  ${right}`;
}

export function memberHeading(m: TeamMember, workerLabel: string, now: number): string {
  return oneLine([`${memberGlyph(memberMark(m))} ${m.name}`, `member of ${workerLabel}`, memberSpan(m, now)].filter(Boolean).join(' · '));
}

export function memberDetailLine(m: TeamMember): string {
  return oneLine([m.modelLabel ?? m.model ?? '', m.role, memberTokens(m), m.lastPost ? `last post #${m.lastPost.seq}` : ''].filter(Boolean).join(' · '));
}
