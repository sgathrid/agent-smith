import type { RadarJob } from '../types/index.d.ts';

export function elapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(total / 3600)}h${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}m`;
}

export const ELAPSED_WIDTH = 6;

export function elapsedCell(ms: number): string {
  return elapsed(ms).padStart(ELAPSED_WIDTH);
}

export function effectiveStart(job: RadarJob): number | null {
  return job.chainStartedAt ?? job.startedAt;
}

export function clockCell(job: RadarJob, now: number): string {
  const start = effectiveStart(job);
  const span = start === null ? null : (job.endedAt ?? now) - start;
  return span === null ? '' : elapsedCell(span);
}
