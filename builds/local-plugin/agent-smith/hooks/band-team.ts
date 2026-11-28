import type { RadarJob, TeamMember } from '../types/index.d.ts';
import { rowCap } from './band.ts';
import { SEP, elapsedCell, fitCell, isLiveStatus, oneLine } from './format.ts';
import { MARK_ORDER, hasTeam, markCounts, memberGlyph, memberMark, shortModel, sortMembers, tokensCell, type MemberMark } from './team.ts';

export type BandEntry =
  | { readonly kind: 'job'; readonly job: RadarJob; readonly index: number }
  | { readonly kind: 'member'; readonly job: RadarJob; readonly member: TeamMember; readonly last: boolean }
  | { readonly kind: 'fold'; readonly job: RadarJob; readonly hidden: readonly TeamMember[] };

export type ChildEntry = Exclude<BandEntry, { kind: 'job' }>;

export interface BandPlan {
  readonly entries: readonly BandEntry[];
  readonly hidden: number;
}

export function showsTeam(job: RadarJob): boolean {
  return (isLiveStatus(job.status) || job.acceptance?.pending === true) && hasTeam(job.team);
}

const MIN_FOLD_MEMBERS = 2;

export function planBand(shown: readonly RadarJob[], maxRows?: number): BandPlan {
  const cap = rowCap(maxRows);
  const workers = shown.slice(0, cap);
  let spare = cap - workers.length;
  const entries: BandEntry[] = [];
  workers.forEach((job, index) => {
    entries.push({ kind: 'job', job, index });
    if (spare < MIN_FOLD_MEMBERS || !showsTeam(job)) return;
    const members = sortMembers(job.team!.members);
    if (members.length <= spare) {
      members.forEach((member, i) => entries.push({ kind: 'member', job, member, last: i === members.length - 1 }));
      spare -= members.length;
      return;
    }
    members.slice(0, spare - 1).forEach((member) => entries.push({ kind: 'member', job, member, last: false }));
    entries.push({ kind: 'fold', job, hidden: members.slice(spare - 1) });
    spare = 0;
  });
  return { entries, hidden: Math.max(0, shown.length - workers.length) };
}

export function foldText(hidden: readonly TeamMember[]): string {
  const parts: string[] = [];
  const counts = markCounts(hidden);
  const order = [...MARK_ORDER].sort((a: MemberMark, b: MemberMark) => counts[b] - counts[a]);
  for (const mark of order) if (counts[mark] > 0) parts.push(`${memberGlyph(mark)} ${counts[mark]} ${mark}`);
  let post: { name: string; seq: number } | null = null;
  for (const m of hidden) if (m.lastPost !== null && (post === null || m.lastPost.seq > post.seq)) post = { name: m.name, seq: m.lastPost.seq };
  if (post !== null) parts.push(`${oneLine(post.name)} posted #${post.seq}`);
  return parts.join(` ${SEP} `);
}

function memberClock(m: TeamMember, now: number): string {
  if (m.startedAt === null) return '';
  const end = m.state === 'working' ? now : m.lastEventAt ?? now;
  return elapsedCell(end - m.startedAt);
}

function tokensSuffix(m: TeamMember): string {
  const t = tokensCell(m.tokensOut);
  return t === '' ? '' : ` ${SEP} ↓ ${t}`;
}

const MIN_ACTIVITY = 10;

export function tokenColumn(entries: readonly BandEntry[]): number {
  let w = 0;
  for (const e of entries) if (e.kind === 'member') w = Math.max(w, tokensSuffix(e.member).length);
  return w;
}

export const CHILD_INDENT = '   ';

export interface TreeColumns {
  readonly worker: number;
  readonly child: number;
  readonly tokens: boolean;
}

export function treeColumns(columns: { readonly detail: number }, tokenWidth: number): TreeColumns {
  const tokens = tokenWidth > 0 && columns.detail - tokenWidth >= MIN_ACTIVITY;
  const worker = tokens ? columns.detail - tokenWidth : columns.detail;
  return { worker, child: Math.max(0, worker - CHILD_INDENT.length), tokens };
}

export interface ChildRow {
  readonly tree: string;
  readonly glyph: string;
  readonly label: string;
  readonly lead: string;
  readonly model: string;
  readonly detail: string;
  readonly right: string;
  readonly plain: string;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly memberId: string | null;
}

export function childRow(
  entry: ChildEntry,
  now: number,
  columns: { readonly label: number; readonly detail: number },
  tokenWidth: number,
): ChildRow {
  if (entry.kind === 'fold') {
    const text = foldText(entry.hidden);
    return { tree: '└', glyph: '', label: text, lead: '', model: '', detail: '', right: '', plain: `└ ${text}`, bold: false, dim: true, memberId: null };
  }
  const { member, last } = entry;
  const fit = treeColumns(columns, tokenWidth);
  const tree = last ? '└' : '├';
  const mark = memberMark(member);
  const glyph = memberGlyph(mark);
  const name = oneLine(member.name);
  const label = fitCell(oneLine(member.name), Math.max(0, columns.label - 2));
  const activity = oneLine(member.activity ?? member.task ?? '');
  const model = oneLine(shortModel(member));
  const text = model === '' ? activity : activity === '' ? model : `${activity} ${SEP} ${model}`;
  const detail = fitCell(text, fit.child);
  const lead = detail.slice(0, activity.length);
  const modelPart = detail.slice(lead.length);
  const suffix = fit.tokens ? tokensSuffix(member).padEnd(tokenWidth) : '';
  const right = `${memberClock(member, now)}${suffix}`.trimEnd();
  const plain = `${tree} ${glyph} ${label} ${detail} ${right}`.replace(/\s+$/, '');
  return { tree, glyph, label, lead, model: modelPart, detail, right, plain, bold: member.state === 'working', dim: member.state !== 'working', memberId: member.id };
}
