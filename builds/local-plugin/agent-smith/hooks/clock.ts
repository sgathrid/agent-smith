/** Elapsed-time clock cells: the volatile field, kept fixed-width. */

import type { RadarJob } from '../types/index.d.ts';

/**
 * Duration in ms → a compact clock string.
 *
 * `48s`, `12m04s`, `1h02m`. The seconds field is `padStart(2,'0')` because
 * TERMINAL-UI.md §Width calls for tabular alignment and names the terminal
 * equivalent of `font-variant-numeric: tabular-nums` as fixed-width padding:
 * without it `9s` and `12s` occupy different widths and the column tears.
 *
 * Hours deliberately drop the seconds (`1h02m`, not `1h02m03s`). A band that
 * needs 8 columns for a clock is a band that cannot afford 8 columns; at that
 * scale the seconds digit is noise anyway. See ELAPSED_WIDTH.
 */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(total / 3600)}h${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
}

/**
 * Column width for `elapsed()`, in terminal columns.
 *
 * WIDTH IS A CORRECTNESS PROPERTY HERE. `48s`, `12m04s` and `1h02m` are 3, 6 and
 * 5 wide; padStart(6) makes all three occupy 6, so the second that changes is
 * the last character of a constant-width cell and nothing to its right moves
 * when the clock ticks. Remove the padding and the row tears every second.
 */
export const ELAPSED_WIDTH = 6;

/** elapsed(), right-aligned into ELAPSED_WIDTH. */
export function elapsedCell(ms: number): string {
  return elapsed(ms).padStart(ELAPSED_WIDTH);
}

/** The clock cell for one job, or a BLANK cell when the start is unknown. */
export function clockCell(job: RadarJob, now: number): string {
  const span = job.startedAt === null ? null : (job.endedAt ?? now) - job.startedAt;
  // BLANK, never `0s`: harness/normalize.ts refuses to invent a start time for
  // agy-staff and neither do we. A confident `0s` about a job that has been
  // working for half an hour is the one lie this surface must not tell.
  return span === null ? '' : elapsedCell(span);
}
