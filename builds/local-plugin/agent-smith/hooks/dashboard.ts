/** Pure rules for the Forge sidebar: which workers it lists and how it labels them. */
import type { RadarAcceptance, RadarJob } from '../types/index.d.ts';
import { countSummary, elapsedCell, failedChecks, failureWords, isTerminal, jobLabel, oneLine } from './format.ts';

/** A settled failure or rejection stops asking for attention this long after it ended. */
export const ATTENTION_TTL_MS = 24 * 60 * 60 * 1000;

/** Before the host measures the terminal, ask for a compact pane width. */
export const PANE_FALLBACK_COLUMNS = 60;
export const PANE_MIN_COLUMNS = 24;

/** A pane request for the rightmost third, respecting the host's 24-column floor. */
export function paneWidthRequest(viewportColumns: number | null): number {
  if (viewportColumns === null || !Number.isFinite(viewportColumns) || viewportColumns <= 0) {
    return PANE_FALLBACK_COLUMNS;
  }
  return Math.max(PANE_MIN_COLUMNS, Math.floor(viewportColumns / 3));
}

/**
 * Reconstruct whole-terminal width from a Pane render event.
 *
 * When `placement === 'dock'`, Claude Code sets `viewport.columns` on the Pane
 * render event to `conversationColumns` (`terminalColumns - (bodyColumns + 1)`),
 * not `terminalColumns`. Treating `viewport.columns` as the full terminal width
 * feeds `conversationColumns` back into `paneWidthRequest` on every Pane render
 * and causes a self-cancelling resize loop.
 */
export function measurePaneTerminalColumns(
  viewport: { readonly columns?: number } | undefined,
  props: { readonly bodyColumns?: number; readonly placement?: string } | undefined,
): number | undefined {
  const viewportColumns = viewport?.columns;
  if (typeof viewportColumns !== 'number' || !Number.isFinite(viewportColumns) || viewportColumns <= 0) {
    return undefined;
  }
  if (props?.placement === 'dock') {
    const bodyColumns = props.bodyColumns;
    if (typeof bodyColumns === 'number' && Number.isFinite(bodyColumns) && bodyColumns > 0) {
      return Math.floor(viewportColumns) + Math.floor(bodyColumns) + 1;
    }
    return undefined;
  }
  return Math.floor(viewportColumns);
}

/**
 * Settled (terminal, checks not pending) work ages out of attention so a stale
 * failure stops being drawn as one. Running, pending and stalled (`attention`)
 * jobs never expire. Without `now` or a timestamp nothing expires.
 */
function expired(job: RadarJob, now?: number): boolean {
  if (now === undefined || !isTerminal(job.status) || job.acceptance?.pending) return false;
  const at = job.endedAt ?? job.startedAt;
  return at !== null && now - at > ATTENTION_TTL_MS;
}
export function needsAttention(job: RadarJob, now?: number): boolean {
  return !expired(job, now) && (job.status === 'attention' || job.status === 'failed' || job.acceptance?.state === 'rejected');
}
/** Still executing, or finished with checks still running (unless superseded by a steered turn). */
export function isLive(job: RadarJob): boolean {
  if (job.supersededBy && isTerminal(job.status)) return false;
  return !isTerminal(job.status) || job.acceptance?.pending === true;
}
/** The sidebar list: one row per worker, running first, then settled work, most recent first. */
export function forgeList(jobs: readonly RadarJob[]): RadarJob[] {
  const workers = groupWorkers(jobs);
  const ended = (job: RadarJob) => job.endedAt ?? job.startedAt ?? 0;
  return [...workers.filter(isLive), ...workers.filter((job) => !isLive(job)).sort((a, b) => ended(b) - ended(a) || a.id.localeCompare(b.id))];
}
/** `/forge <query>`: an exact job id, else a worker name or id (any case), preferring live work. */
export function findWorker(jobs: readonly RadarJob[], query: string): RadarJob | undefined {
  const q = query.trim().toLowerCase();
  return jobs.find((job) => job.id === query.trim()) ??
    forgeList(jobs).find((job) => job.name?.trim().toLowerCase() === q || job.workerId?.toLowerCase() === q);
}
export function workerHeading(job: RadarJob): string {
  const role = oneLine(job.role ?? job.provider ?? '');
  return `${jobLabel(job)}${role ? ` · ${role}` : ''}`;
}
export function workerStatus(job: RadarJob): string {
  if (job.supersededBy && isTerminal(job.status)) return 'steered';
  if (job.acceptance?.pending && isTerminal(job.status)) return `${job.status === 'succeeded' ? 'done' : job.status} · checking`;
  if (job.status === 'failed') {
    const why = failureWords(job);
    return why === '' ? 'failed' : `failed · ${why}`;
  }
  if (job.status === 'succeeded' && job.acceptance?.state === 'rejected' && job.acceptance.checks.length > 0) return failedChecks(job);
  if (job.acceptance?.state === 'rejected') return `${job.status} · checks failed`;
  if (job.status === 'running') {
    const act = oneLine(job.activity);
    return act ? `Running · ${act}` : 'Running';
  }
  if (job.status === 'attention') return 'stalled';
  return job.status === 'succeeded' ? 'done' : job.status;
}
/** `checks ✓ 2/2`, `✗ lint, tests`, `checking`, or '' when no checks ran. */
export function checksLabel(acceptance?: RadarAcceptance): string {
  if (!acceptance) return '';
  if (acceptance.pending) return 'checking';
  const failed = acceptance.checks.filter((check) => !check.ok);
  if (failed.length > 0) return `✗ ${failed.map((check) => oneLine(check.name)).join(', ')}`;
  if (acceptance.checks.length > 0) return `checks ✓ ${acceptance.checks.length}/${acceptance.checks.length}`;
  return acceptance.state === 'rejected' ? 'checks failed' : '';
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
    const live = isLive(job);
    const oldLive = old !== undefined && isLive(old);
    if (!old || (live && !oldLive) || (live===oldLive &&
      (job.startedAt??job.endedAt??0)>(old.startedAt??old.endedAt??0))) groups.set(key,job);
  }
  return [...groups.values()].sort((a,b) =>
    (b.startedAt??b.endedAt??0)-(a.startedAt??a.endedAt??0) || a.id.localeCompare(b.id));
}

/** What this session launched: job ids and pipeline run ids, kept for the whole session. */
export interface Launched { readonly jobs: readonly string[]; readonly runs: readonly string[] }
export function recordLaunch(prev: Launched, launch: { readonly kind: 'job' | 'run'; readonly id: string }): Launched {
  const key = launch.kind === 'job' ? 'jobs' : 'runs';
  return prev[key].includes(launch.id) ? prev : { ...prev, [key]: [...prev[key], launch.id] };
}
/** The jobs this session launched (including steered continuations), and the stage jobs of the pipeline runs it launched. */
export function sessionJobs(jobs: readonly RadarJob[], launched: Launched): RadarJob[] {
  const ownedIds = new Set(launched.jobs);
  let changed = true;
  while (changed) {
    changed = false;
    for (const job of jobs) {
      if (ownedIds.has(job.id) && job.supersededBy && !ownedIds.has(job.supersededBy)) {
        ownedIds.add(job.supersededBy);
        changed = true;
      }
      if (job.steeredFrom && ownedIds.has(job.steeredFrom) && !ownedIds.has(job.id)) {
        ownedIds.add(job.id);
        changed = true;
      }
    }
  }
  return jobs.filter((job) => ownedIds.has(job.id) || (job.pipeline != null && launched.runs.includes(job.pipeline)));
}
/** `2 running · 1 failed · 3 finished`: one count per listed worker, zeros left out; '' for none. */
export function countLine(jobs: readonly RadarJob[]): string {
  const c = countSummary(forgeList(jobs));
  return ([['running', c.running], ['failed', c.failed], ['done', c.finished]] as const)
    .filter(([, n]) => n > 0).map(([label, n]) => `${n} ${label}`).join(' · ');
}
/** The /forge reply and list header: this session's counts, or the repository's, labelled. */
export function scopeLine(jobs: readonly RadarJob[], scope: 'session' | 'all'): string {
  const line = countLine(jobs);
  return scope === 'all' ? `repository: ${line || 'no workers yet'}` : line || 'No workers in this session';
}
