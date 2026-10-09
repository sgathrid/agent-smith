/** Pure roster rules; shared by the bottom view and the optional inspector. */
import type { RadarJob } from '../types/index.d.ts';
import { elapsedCell, isTerminal, jobLabel, oneLine } from './format.ts';
import { acceptanceLabel } from './canonical.ts';

export function needsAttention(job: RadarJob): boolean {
  return job.status === 'attention' || job.status === 'failed' || job.acceptance?.state === 'rejected';
}
export function activeJob(job: RadarJob): boolean {
  return !isTerminal(job.status) || job.acceptance?.pending === true || needsAttention(job);
}
export function rosterJobs(jobs: readonly RadarJob[], tab: 'active' | 'history', hidden: readonly string[]): RadarJob[] {
  // A dismissal is a view preference, never a deletion. Running/checking work cannot be dismissed.
  return jobs.filter(job => (!hidden.includes(job.id) || !isTerminal(job.status) || job.acceptance?.pending) &&
    (tab === 'active' ? activeJob(job) : isTerminal(job.status) && !job.acceptance?.pending))
    .sort((a,b) => Number(needsAttention(b)) - Number(needsAttention(a)) ||
      (b.startedAt ?? b.endedAt ?? 0) - (a.startedAt ?? a.endedAt ?? 0) || a.id.localeCompare(b.id));
}
export function workerHeading(job: RadarJob): string {
  const role = job.role ?? job.provider;
  return `${jobLabel(job)}${role ? ` · ${role}` : ''}`;
}
export function workerStatus(job: RadarJob): string {
  if (job.acceptance?.pending && isTerminal(job.status)) return `${job.status === 'succeeded' ? 'Execution complete' : job.status} · checks pending`;
  if (job.acceptance?.state === 'rejected') return `${job.status} · checks rejected`;
  if (job.status === 'running') return job.activity ? `Running · ${job.activity}` : 'Running';
  if (job.status === 'attention') return 'Needs attention · no recent worker events';
  return `${job.status}${job.acceptance ? ` · ${acceptanceLabel(job.acceptance)}` : ''}`;
}
export function rosterSummary(jobs: readonly RadarJob[]): string {
  const live = jobs.filter(j => !isTerminal(j.status)).length;
  const checking = jobs.filter(j => isTerminal(j.status) && j.acceptance?.pending).length;
  const attention = jobs.filter(needsAttention).length;
  return `Forge · ${live} active${checking ? ` · ${checking} checking` : ''}${attention ? ` · ${attention} need attention` : ''}`;
}
export function statusLine(job: RadarJob, now: number, width: number): string {
  const elapsed = elapsedCell(job.startedAt === null ? 0 : (job.endedAt ?? now) - job.startedAt);
  const room = Math.max(1,width - elapsed.length - 3);
  return `${oneLine(workerStatus(job),room).padEnd(room)}   ${elapsed}`;
}

/** Group only recorded worker identities. The job id fallback never joins strangers. */
export function groupWorkers(jobs: readonly RadarJob[]): RadarJob[] {
  const groups = new Map<string,RadarJob>();
  for (const job of jobs) {
    const key = job.workerId ?? job.id;
    const old = groups.get(key);
    const live = !isTerminal(job.status) || job.acceptance?.pending;
    const oldLive = old && (!isTerminal(old.status) || old.acceptance?.pending);
    if (!old || (live && !oldLive) || (Boolean(live)===Boolean(oldLive) &&
      (job.startedAt??job.endedAt??0)>(old.startedAt??old.endedAt??0))) groups.set(key,job);
  }
  return [...groups.values()].sort((a,b) => Number(needsAttention(b))-Number(needsAttention(a)) ||
    (b.startedAt??b.endedAt??0)-(a.startedAt??a.endedAt??0) || a.id.localeCompare(b.id));
}
