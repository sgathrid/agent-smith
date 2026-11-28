import type { ContinuationKind, RadarJob, RadarStatus } from '../types/index.d.ts';
import { REASONS, checksReason, reasonFromText } from './reasons.ts';
import { ELAPSED_WIDTH, clockCell, effectiveStart, elapsed, elapsedCell } from './clock.ts';
import { fitCell, oneLine, sanitizeText } from './text.ts';
import { durationWords } from './notice.ts';
import { agentsWord, hasTeam, teamCounts, teamPhrase } from './team.ts';

export { ELAPSED_WIDTH, clockCell, effectiveStart, elapsed, elapsedCell, fitCell, oneLine, sanitizeText };

export function pickGlyph(status: RadarStatus): string {
  switch (status) {
    case 'running':
      return '⏺';
    case 'succeeded':
      return '✓';
    case 'failed':
      return '✗';
    case 'attention':
      return '!';
    case 'canceled':
      return '∙';
    default:
      return '?';
  }
}

export function pickColor(
  status: RadarStatus,
): 'blue' | 'green' | 'red' | 'cyan' | undefined {
  switch (status) {
    case 'running':
      return 'blue';
    case 'succeeded':
      return 'green';
    case 'failed':
      return 'red';
    case 'attention':
      return 'cyan';
    default:
      return undefined;
  }
}

export function isTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

export function isLiveStatus(status: string): boolean {
  return status === 'running' || status === 'attention';
}

export function isRecessive(status: RadarStatus): boolean {
  return status === 'succeeded' || status === 'canceled' || status === 'unknown';
}

const BAND_LABEL_WIDTH = 44;

const BAND_DETAIL_WIDTH = 22;

const GUTTER = ' ';

const LEAD = ' ';

export const SEP = '∙';

function unmarkdown(s: string): string {
  return s.replace(/`+/g, '').replace(/\*\*?|__/g, '');
}

function firstLine(task: string): string {
  for (const raw of sanitizeText(task).split('\n')) {
    const line = unmarkdown(raw).replace(/\s+/g, ' ').trim();
    if (line.length > 0) return line;
  }
  return '';
}

export function deriveTaskLabel(task: string): string {
  const line = firstLine(task).replace(/^#+\s*/, '');
  if (line === '') return '';

  const review = /^review of\s+([^:]{1,40}):/i.exec(line);
  if (review !== null) {
    const subject = unmarkdown(review[1] ?? '').replace(/\s+/g, ' ').trim();
    if (subject !== '') return `follow-up ∙ ${subject.toLowerCase()}`;
  }

  let id = '';
  let rest = line;
  const marker = /^task\s*(?:([0-9a-z]{1,4}(?:-[a-z]{1,4})?)\s*)?:/i.exec(line);
  if (marker !== null) {
    id = (marker[1] ?? '').toLowerCase();
    rest = line.slice(marker[0].length).trim();
  }

  const paren = rest.indexOf(' (');
  if (paren >= 12) rest = rest.slice(0, paren);

  const sentence = /^([\s\S]*?[^0-9.]\.)(?:\s+[A-Z]|$)/.exec(rest);
  if (sentence !== null) rest = sentence[1] ?? rest;

  rest = rest.replace(/[\s,;:—–-]+$/, '').trim();
  if (rest === '') return id === '' ? '' : id;
  if (id !== '') rest = `${id} ∙ ${rest}`;

  return /^[A-Z][a-z]/.test(rest) ? rest[0]!.toLowerCase() + rest.slice(1) : rest;
}

export function fallbackLabel(id: string): string {
  const parts = id.split('-');
  if (parts.length >= 3) return parts[1] ?? id;
  return id;
}

export function jobLabel(job: RadarJob): string {
  if (typeof job.name === 'string') {
    const clean = oneLine(job.name);
    if (clean !== '') return clean;
  }
  const label = deriveTaskLabel(job.task);
  return label === '' ? oneLine(fallbackLabel(job.id)) : label;
}

export function failureWords(job: RadarJob): string {
  const first = job.warnings[0];
  const text = job.failureReason ?? first?.message ?? null;
  if (text !== null && text.trim() !== '') {
    const words = oneLine(reasonFromText(text));
    if (words !== REASONS.workerError) return words;
  }
  switch (first?.code ?? '') {
    case 'suspicious_success':
    case 'empty_output':
      return REASONS.noOutput;
    case 'timeout':
      return REASONS.timedOut;
    case 'canceled':
      return 'canceled';
    case 'tool_error':
      return REASONS.workerError;
    case '':
      break;
    default:
      return oneLine((first?.code ?? '').replace(/_/g, ' '));
  }
  if (job.acceptance?.state === 'rejected' && job.acceptance.checks.length > 0) return failedChecks(job);
  return text !== null && text.trim() !== '' ? REASONS.workerError : '';
}

export function failedChecks(job: RadarJob): string {
  return oneLine(checksReason((job.acceptance?.checks ?? []).filter((c) => !c.ok).map((c) => oneLine(c.name))));
}

const SWARM_WAIT = /\bswarm_wait\b|^waiting on team$/i;

const IN_TOOL_SHOWN_MS = 60_000;

export function livenessWords(job: RadarJob): string {
  const l = job.liveness;
  if (!l) return job.status === 'attention' ? 'no output' : '';
  const d = l.forMs > 0 ? durationWords(l.forMs) : '';
  switch (l.state) {
    case 'dead': return `process gone${d ? ` ${d}` : ''}`;
    case 'silent': return `no output${d ? ` ${d}` : ''}`;
    case 'in-tool': return l.tool && l.forMs >= IN_TOOL_SHOWN_MS ? `in \`${oneLine(l.tool, 40)}\`${d ? ` ${d}` : ''}` : '';
    default: return '';
  }
}

export function pendingSteersLabel(count: number | null | undefined): string {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return '';
  return `${Math.floor(count)} queued`;
}

export function continuationLabel(kind: ContinuationKind | null | undefined): string {
  if (kind === 'follow-up') return 'follow-up';
  if (kind === 'steer') return 'steered';
  return '';
}

export function jobDetail(job: RadarJob, options: { tools?: boolean } = {}): string {
  const withTools = options.tools !== false;
  if (isTerminal(job.status)) {
    if (job.acceptance?.pending && !job.supersededBy) {
      const checking = job.turn > 1 ? `checking ${SEP} turn ${job.turn}` : 'checking';
      return hasTeam(job.team) ? `${teamPhrase(job.team)} ${SEP} ${checking}` : checking;
    }
    return outcome(job);
  }
  const parts: string[] = [];
  const counts = teamCounts(job.team);
  const swarmWait = counts.working > 0 && (SWARM_WAIT.test(job.liveness?.tool ?? '') || SWARM_WAIT.test(job.activity));
  if (swarmWait) parts.push(`waiting on ${counts.working} of ${counts.total} ${agentsWord(counts.total)}`);
  else if (hasTeam(job.team)) parts.push(teamPhrase(job.team));
  const quiet = swarmWait && job.liveness?.state === 'in-tool' ? '' : livenessWords(job);
  if (quiet !== '') parts.push(quiet);
  const steers = pendingSteersLabel(job.pendingSteers);
  if (steers !== '') parts.push(steers);
  if (job.turn > 1) parts.push(`turn ${job.turn}`);
  const activity = swarmWait || (job.liveness?.state === 'in-tool' && quiet !== '') ? '' : oneLine(job.activity);
  if (activity !== '') parts.push(activity);
  if (withTools && job.toolCount !== null) parts.push(`${job.toolCount} tools`);
  return parts.join(` ${SEP} `);
}

export function outcome(job: RadarJob): string {
  if (job.supersededBy && isTerminal(job.status)) return 'steered';
  let base: string;
  switch (job.status) {
    case 'running':
      return '';
    case 'attention':
      return livenessWords(job) || 'no output';
    case 'succeeded':
      if (job.acceptance?.state === 'rejected' && !job.acceptance.pending && job.acceptance.checks.length > 0) base = failedChecks(job);
      else base = job.warnings.length > 0 ? `done ${SEP} warnings` : 'done';
      break;
    case 'failed': {
      const why = failureWords(job);
      base = why === '' ? 'failed' : `failed ${SEP} ${why}`;
      break;
    }
    case 'canceled':
      base = 'canceled';
      break;
    case 'unknown':
      return 'unknown';
  }
  const parts = [base];
  if (job.turn > 1) parts.push(`turn ${job.turn}`);
  const cont = continuationLabel(job.continuationKind);
  if (cont !== '') parts.push(cont);
  return parts.join(` ${SEP} `);
}

export interface RowOptions {
  readonly now?: number;
  readonly label?: number;
  readonly detail?: number;
  readonly tools?: boolean;
}

export function formatJobLine(job: RadarJob, options: RowOptions = {}): string {
  const {
    now = job.endedAt ?? 0,
    label: labelWidth = BAND_LABEL_WIDTH,
    detail: detailWidth = BAND_DETAIL_WIDTH,
    tools = true,
  } = options;
  const clock = clockCell(job, now);
  const label = fitCell(jobLabel(job), labelWidth);
  const detail = fitCell(jobDetail(job, { tools }), detailWidth).trimEnd();
  return `${LEAD}${pickGlyph(job.status)}${GUTTER}${label}${GUTTER}${detail}${GUTTER}${clock}`.replace(
    /\s+$/,
    '',
  );
}

export interface JobRow {
  readonly glyph: string;
  readonly label: string;
  readonly detail: string;
  readonly clock: string;
  readonly plain: string;
  readonly accent: 'blue' | 'green' | 'red' | 'cyan' | undefined;
  readonly bold: boolean;
  readonly recessive: boolean;
}

export function formatJobRow(job: RadarJob, options: RowOptions = {}): JobRow {
  const {
    now = job.endedAt ?? 0,
    label: labelWidth = BAND_LABEL_WIDTH,
    detail: detailWidth = BAND_DETAIL_WIDTH,
    tools = true,
  } = options;
  const glyph = pickGlyph(job.status);
  const label = fitCell(jobLabel(job), labelWidth);
  const detail = fitCell(jobDetail(job, { tools }), detailWidth).trimEnd();
  const clock = clockCell(job, now);
  const plain = formatJobLine(job, options);
  return {
    glyph,
    label,
    detail,
    clock,
    plain,
    accent: pickColor(job.status),
    bold: isLiveStatus(job.status),
    recessive: isRecessive(job.status),
  };
}

const ROW_OVERHEAD = ELAPSED_WIDTH + 4;

const LABEL_MAX = 72;
const DETAIL_MAX = 30;

export function paneColumns(bodyColumns: number): { label: number; detail: number } {
  const cols = Number.isFinite(bodyColumns) && bodyColumns > 0 ? Math.floor(bodyColumns) : 80;
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  const label = clamp(Math.min(clamp(cols - 40, 12, LABEL_MAX), Math.max(0, cols - ROW_OVERHEAD - 8)), 0, LABEL_MAX);
  let detail = clamp(cols - label - ROW_OVERHEAD, 0, DETAIL_MAX);
  if (label + detail + ROW_OVERHEAD > cols) detail = Math.max(0, cols - label - ROW_OVERHEAD);
  return { label, detail };
}

const BAND_DETAIL_MAX = 64;

export function fitBandColumns(bodyColumns: number, longestLabel: number): { label: number; detail: number } {
  const base = paneColumns(bodyColumns);
  const label = Math.min(base.label, Math.max(12, longestLabel));
  const detail = Math.max(base.detail, Math.min(BAND_DETAIL_MAX, Math.floor(bodyColumns) - label - ROW_OVERHEAD));
  return { label, detail };
}

export function bandColumns(): { label: number; detail: number; tools: boolean } {
  return { label: BAND_LABEL_WIDTH, detail: BAND_DETAIL_WIDTH, tools: false };
}

export function formatHeaderLine(summary: {
  running: number;
  failed: number;
  finished: number;
}): string {
  const shown = [
    { label: 'running', n: summary.running },
    { label: 'failed', n: summary.failed },
    { label: 'done', n: summary.finished },
  ].filter((c) => c.n > 0 || c.label === 'done');
  const width = Math.max(2, ...shown.map((c) => String(c.n).length));
  return shown.map((c) => `${String(c.n).padStart(width)} ${c.label}`).join(` ${SEP} `);
}

export const EMPTY_STATE = 'No workers yet';

export function sortJobs(jobs: readonly RadarJob[]): RadarJob[] {
  const rank = (s: RadarStatus): number =>
    s === 'running' ? 0 : s === 'attention' ? 1 : s === 'failed' ? 2 : 3;
  return [...jobs].sort((a, b) => {
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    return (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0);
  });
}

export function sortForBand(jobs: readonly RadarJob[]): RadarJob[] {
  const rank = (j: RadarJob): number => (isLiveStatus(j.status) || j.acceptance?.pending === true ? 0 : 1);
  return [...jobs].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0);
  });
}

export function countSummary(jobs: readonly RadarJob[]): {
  running: number;
  failed: number;
  finished: number;
} {
  let running = 0;
  let failed = 0;
  let finished = 0;
  for (const j of jobs) {
    if (isLiveStatus(j.status)) running += 1;
    else if (j.status === 'failed') failed += 1;
    else finished += 1;
  }
  return { running, failed, finished };
}
