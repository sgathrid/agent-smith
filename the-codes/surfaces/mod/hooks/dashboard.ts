/** Pure roster rules; shared by the bottom view and the optional inspector. */
import type { RadarJob } from '../types/index.d.ts';
import { elapsedCell, isTerminal, jobLabel, oneLine } from './format.ts';
import { acceptanceLabel } from './canonical.ts';

export function scopedJobKey(repo: string, id: string): string {
  return JSON.stringify([repo.replace(/\/+$/, ''), id]);
}
export function belongsToRepo(key: string, repo: string): boolean {
  if (!key.startsWith('[')) return true; // legacy bare job ids have no repo to inspect
  try {
    const value: unknown = JSON.parse(key);
    return Array.isArray(value) && value[0] === repo.replace(/\/+$/, '');
  } catch {
    return false;
  }
}
export function needsAttention(job: RadarJob, acknowledged = false): boolean {
  return !acknowledged && (job.status === 'attention' || job.status === 'failed' || job.acceptance?.state === 'rejected');
}
export function activeJob(job: RadarJob, acknowledged = false): boolean {
  return !isTerminal(job.status) || job.acceptance?.pending === true || needsAttention(job, acknowledged);
}
export function rosterJobs(jobs: readonly RadarJob[], tab: 'active' | 'history', hidden: readonly string[], acknowledged: readonly string[] = [], repo = ''): RadarJob[] {
  // Settled dismissals and acknowledgements only affect this repo. Live/checking work stays visible.
  return jobs.filter(job => {
    const key = scopedJobKey(repo, job.id);
    const wasAcknowledged = acknowledged.includes(key);
    const dismissed = hidden.includes(key) || hidden.includes(job.id); // bare ids are pre-scope persisted values
    const live = !isTerminal(job.status) || job.acceptance?.pending;
    if (tab === 'history') {
      if (live || needsAttention(job,wasAcknowledged)) return false;
      return !(dismissed && !needsAttention(job));
    }
    if (live) return true;
    if (dismissed && !needsAttention(job)) return false;
    return activeJob(job,wasAcknowledged);
  }).sort((a,b) => Number(needsAttention(b,acknowledged.includes(scopedJobKey(repo,b.id)))) - Number(needsAttention(a,acknowledged.includes(scopedJobKey(repo,a.id)))) ||
      (b.startedAt ?? b.endedAt ?? 0) - (a.startedAt ?? a.endedAt ?? 0) || a.id.localeCompare(b.id));
}
export function workerHeading(job: RadarJob): string {
  const role = job.role ?? job.provider;
  return `${jobLabel(job)}${role ? ` · ${role}` : ''}`;
}
export function workerStatus(job: RadarJob): string {
  if (job.acceptance?.pending && isTerminal(job.status)) return `${job.status === 'succeeded' ? 'Execution complete' : job.status} · checks pending`;
  if (job.status === 'failed') {
    const reason = failureCode(job.failureReason ?? job.warnings.find(w => /orphan|timeout|timed out|denied/i.test(w.message))?.message);
    return `${job.status}${reason ? ` · ${reason}` : job.acceptance?.state === 'rejected' && job.acceptance.checks.length ? ' · checks rejected' : ''}`;
  }
  if (job.acceptance?.state === 'rejected') return `${job.status} · checks rejected`;
  if (job.status === 'running') return job.activity ? `Running · ${job.activity}` : 'Running';
  if (job.status === 'attention') return 'Needs attention · no recent worker events';
  const hasChecks = Boolean(job.acceptance?.pending || job.acceptance?.checks.length);
  return `${job.status}${hasChecks && job.acceptance ? ` · ${acceptanceLabel(job.acceptance)}` : ''}`;
}
function failureCode(reason?: string | null): string | null {
  if (!reason) return null;
  if (/orphan/i.test(reason)) return 'orphaned';
  if (/timeout|timed out/i.test(reason)) return 'timeout';
  if (/denied|denial/i.test(reason)) return 'denied';
  return /^[a-z][a-z0-9_-]{0,31}$/i.test(reason.trim()) ? reason.trim().toLowerCase() : 'error';
}
export function rosterSummary(jobs: readonly RadarJob[], acknowledged: readonly string[] = [], repo = ''): string {
  const live = jobs.filter(j => !isTerminal(j.status)).length;
  const checking = jobs.filter(j => isTerminal(j.status) && j.acceptance?.pending).length;
  const attention = groupWorkers(rosterJobs(jobs,'active',[],acknowledged,repo))
    .filter(job => needsAttention(job,acknowledged.includes(scopedJobKey(repo,job.id)))).length;
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
