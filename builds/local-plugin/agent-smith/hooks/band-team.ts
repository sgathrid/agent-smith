import type { RadarJob, TeamMember, TeamMemberState } from '../types/index.d.ts';
import { rowCap } from './band.ts';
import { SEP, elapsedCell, fitCell, isLiveStatus, oneLine } from './format.ts';
import { hasTeam, memberGlyph, sortMembers, tokensCell } from './team.ts';

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

const STATE_ORDER: readonly TeamMemberState[] = ['working', 'waiting', 'stopped', 'done', 'failed', 'killed'];

function count(members: readonly TeamMember[], state: TeamMemberState): number {
  return members.filter((m) => m.state === state).length;
}

export function foldText(hidden: readonly TeamMember[]): string {
  const parts: string[] = [];
  const order = [...STATE_ORDER].sort((a, b) => count(hidden, b) - count(hidden, a));
  for (const state of order) if (count(hidden, state) > 0) parts.push(`${count(hidden, state)} ${state}`);
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

export function tokenColumn(entries: readonly BandEntry[]): number {
  let w = 0;
  for (const e of entries) if (e.kind === 'member') w = Math.max(w, tokensSuffix(e.member).length);
  return w;
}

export interface ChildRow {
  readonly tree: string;
  readonly glyph: string;
  readonly label: string;
  readonly detail: string;
  readonly right: string;
  readonly plain: string;
  readonly bold: boolean;
  readonly dim: boolean;
  readonly memberId: string | null;
}

const MIN_ACTIVITY = 10;

export function childRow(
  entry: ChildEntry,
  now: number,
  columns: { readonly label: number; readonly detail: number },
  tokenWidth: number,
): ChildRow {
  if (entry.kind === 'fold') {
    const text = foldText(entry.hidden);
    return { tree: '└', glyph: '○', label: text, detail: '', right: '', plain: `└ ○ ${text}`, bold: false, dim: true, memberId: null };
  }
  const { member, last } = entry;
  const withTokens = tokenWidth > 0 && columns.detail - tokenWidth >= MIN_ACTIVITY;
  const detailWidth = withTokens ? columns.detail - tokenWidth : columns.detail;
  const tree = last ? '└' : '├';
  const glyph = memberGlyph(member.state);
  const label = fitCell(oneLine(member.name), Math.max(0, columns.label - 2));
  const detail = fitCell(oneLine(member.activity ?? member.task ?? ''), detailWidth);
  const suffix = withTokens ? tokensSuffix(member).padEnd(tokenWidth) : '';
  const right = `${memberClock(member, now)}${suffix}`.trimEnd();
  const plain = `${tree} ${glyph} ${label} ${detail} ${right}`.replace(/\s+$/, '');
  return { tree, glyph, label, detail: detail.trimEnd(), right, plain, bold: member.state === 'working', dim: member.state !== 'working', memberId: member.id };
}
