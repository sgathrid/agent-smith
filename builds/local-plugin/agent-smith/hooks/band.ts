import {
  bandColumns,
  elapsedCell,
  fitBandColumns,
  formatJobRow,
  isTerminal,
  paneColumns,
  pickColor,
  pickGlyph,
  type RowOptions,
} from './format.ts';
import type { RadarJob } from '../types/index.d.ts';

export { elapsedCell, isTerminal, pickColor, pickGlyph } from './format.ts';

export const LINGER_MS = 10_000;

export const BAND_ROWS = 4;

export function noColor(env: {
  readonly NO_COLOR?: string;
  readonly FORCE_COLOR?: string;
  readonly TERM?: string;
}): boolean {
  // no-color.org: present AND non-empty means "no colour". An exported-but-blank
  // NO_COLOR= is explicitly not a request, so it must not disable colour.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return true;
  const force = env.FORCE_COLOR;
  if (force === '0' || force === 'false') return true;
  if (env.TERM === 'dumb') return true;
  return false;
}

export type BandLine = import('./format.ts').JobRow;

export function buildLine(
  job: RadarJob,
  now: number,
  options: { readonly colour?: boolean; readonly width?: number; readonly longestLabel?: number; readonly detail?: number } = {},
): BandLine {
  const columns = options.width === undefined ? bandColumns()
    : options.longestLabel === undefined ? { ...paneColumns(options.width), tools: false }
    : { ...fitBandColumns(options.width, options.longestLabel), tools: false };
  const aligned = options.detail === undefined ? {} : { detail: options.detail, padDetail: true };
  const row = formatJobRow(job, { now, ...columns, ...aligned } satisfies RowOptions);
  const colour = options.colour !== false;
  return {
    ...row,
    accent: colour ? row.accent : undefined,
  };
}

export function isShown(job: RadarJob, now: number): boolean {
  if ((job.supersededBy || job.followedBy) && isTerminal(job.status)) return false;
  if (!isTerminal(job.status) || job.acceptance?.pending) return true;
  if (job.endedAt === null) return false;
  return now - job.endedAt < LINGER_MS;
}

export interface BandBudget {
  readonly rows: readonly RadarJob[];
  readonly hidden: number;
}

export function rowCap(maxRows?: number): number {
  if (typeof maxRows !== 'number' || !Number.isFinite(maxRows)) return BAND_ROWS;
  return Math.max(1, Math.min(BAND_ROWS, Math.floor(maxRows) - 1));
}

export function rowBudget(shown: readonly RadarJob[], maxRows?: number): BandBudget {
  const cap = rowCap(maxRows);
  return { rows: shown.slice(0, cap), hidden: Math.max(0, shown.length - cap) };
}

export function overflowLine(hidden: number): string {
  return `   +${hidden} more ∙ /forge`;
}
