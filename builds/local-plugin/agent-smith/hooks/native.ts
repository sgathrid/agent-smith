/**
 * Projection of live Agent Smith workers into Claude Code's native task list.
 *
 * The mod watches Agent Smith's durable job files; it does not create Claude
 * Agent IDs or enter Claude's Agent/subagent loop. A native task ID is kept only
 * after TaskCreate returns one from the host.
 */

import type { FsLike } from './fs.ts';
import type { ContinuationKind, RadarAcceptance, RadarJob } from '../types/index.d.ts';
import { readForgeJobs, acceptanceLabel } from './canonical.ts';
import { isLiveStatus } from './format.ts';
import { firstTrimmed, record } from './guards.ts';

export type NativeJobStatus = 'running' | 'attention' | 'succeeded' | 'failed' | 'canceled';

export interface NativeJob {
  readonly id: string;
  readonly status: NativeJobStatus;
  readonly task: string;
  readonly name: string | null;
  readonly workerId: string;
  readonly turn?: number;
  readonly startedAt?: number | null;
  readonly role: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly latestSummary: string | null;
  readonly acceptance?: RadarAcceptance;
  readonly summarySource: 'worker' | null;
  readonly supersededBy?: string | null;
  readonly continuedFrom?: string | null;
  readonly continuationKind?: ContinuationKind | null;
  readonly pendingSteers?: number | null;
}

export interface NativeTaskLink {
  readonly taskId: string;
  readonly status: 'in_progress' | 'completed' | 'deleted';
  /** When this worker was first seen finished (epoch ms); starts the close delay. */
  readonly doneAt?: number;
  /** Last description/status sent successfully; lets the poll avoid no-op writes. */
  readonly fingerprint: string;
}

/** Keyed by `workerId` — one native task per worker across spawn, steer, and resume. */
export type NativeTaskLinks = Record<string, NativeTaskLink>;

export interface NativeTaskClient {
  create(input: {
    subject: string;
    description: string;
    activeForm: string;
    metadata: { source: 'agent-smith'; jobId: string; workerId: string; role: string | null };
  }): Promise<unknown>;
  update(input: {
    taskId: string;
    subject: string;
    description: string;
    activeForm?: string;
    status: 'in_progress' | 'completed' | 'deleted';
  }): Promise<unknown>;
}

/** Both native tasks and /forge use the same canonical projection and liveness. */
export function nativeJobsFromRadar(jobs: readonly RadarJob[]): NativeJob[] {
  return jobs.filter(job => job.status !== 'unknown').map(job => ({
    id: job.id, status: job.status as NativeJobStatus, task: job.task,
    name: job.name ?? null, workerId: job.workerId, turn: job.turn, startedAt: job.startedAt,
    role: job.role ?? null, provider: job.provider ?? null, model: job.model ?? null,
    latestSummary: job.latestSummary ?? null, summarySource: job.summarySource ?? null,
    acceptance: job.acceptance,
    supersededBy: job.supersededBy ?? null,
    continuedFrom: job.continuedFrom ?? null,
    continuationKind: job.continuationKind ?? null,
    pendingSteers: job.pendingSteers ?? null,
  }));
}
export async function readNativeJobs(fs: FsLike, repo: string, now = Date.now()): Promise<NativeJob[]> {
  return nativeJobsFromRadar(await readForgeJobs(fs, repo, now));
}

function subjectFor(job: NativeJob): string {
  const task = job.task.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
  const subject = job.name !== null && task !== ''
    ? `${job.name}: ${task}`
    : job.name ?? (task !== '' ? task : null) ?? job.role ?? job.id;
  const outcome = job.status === 'failed' || job.status === 'canceled' ? `[${job.status}] ` :
    job.acceptance?.state === 'rejected' && !job.acceptance.pending ? '[checks failed] ' : '';
  return (outcome + subject).slice(0, 120) || job.id;
}

function descriptionFor(job: NativeJob): string {
  const lines = [
    `Job ID: ${job.id}`,
    `Worker ID: ${job.workerId}`,
    ...((job.turn ?? 1) > 1 ? [`Turn: ${job.turn}`] : []),
    ...(job.role === null ? [] : [`Role: ${job.role}`]),
    ...(job.provider === null ? [] : [`Provider: ${job.provider}`]),
    ...(job.model === null ? [] : [`Model: ${job.model}`]),
    `Outcome: ${job.status}`,
    `Checks: ${acceptanceLabel(job.acceptance)}`,
    ...(job.task === '' ? [] : [`Task: ${job.task}`]),
  ];
  if (job.summarySource === 'worker' && job.latestSummary !== null) {
    lines.push('', 'Worker said:', job.latestSummary.slice(0, 1_000));
  }
  return lines.join('\n');
}

function activeForm(job: NativeJob): string {
  if (job.acceptance?.pending && job.status !== 'running' && job.status !== 'attention') return 'Running checks';
  if (job.status === 'attention') return `Checking ${job.role ?? 'worker'} progress`;
  return `Running ${job.role ?? 'worker'}`;
}

function nativeId(result: unknown): string | null {
  const outer = record(result);
  if (outer === null || outer.isError === true || typeof outer.deny === 'string') return null;
  const output = record(outer.result);
  const task = record(output?.task);
  return firstTrimmed(task?.id);
}

function updateSucceeded(result: unknown): boolean {
  const outer = record(result);
  if (outer === null || outer.isError === true || typeof outer.deny === 'string') return false;
  const output = record(outer.result);
  return output?.success === true;
}

/** How long a finished worker's task stays in the host list before it is closed. */
const CLOSE_DELAY_MS = 10_000;

function isLiveNative(job: NativeJob): boolean {
  if (job.supersededBy && !isLiveStatus(job.status)) return false;
  return isLiveStatus(job.status) || job.acceptance?.pending === true;
}

function taskStatus(job: NativeJob): 'in_progress' | 'completed' {
  return isLiveNative(job) ? 'in_progress' : 'completed';
}

function fingerprint(job: NativeJob): string {
  return JSON.stringify({
    subject: subjectFor(job),
    description: descriptionFor(job),
    status: taskStatus(job),
    activeForm: activeForm(job),
  });
}

function isBetterNativeHead(candidate: NativeJob, current: NativeJob): boolean {
  const cSup = Boolean(candidate.supersededBy);
  const oSup = Boolean(current.supersededBy);
  if (cSup !== oSup) return !cSup;
  const cLive = isLiveNative(candidate);
  const oLive = isLiveNative(current);
  if (cLive !== oLive) return cLive;
  const cTurn = candidate.turn ?? 1;
  const oTurn = current.turn ?? 1;
  if (cTurn !== oTurn) return cTurn > oTurn;
  const cAt = candidate.startedAt ?? 0;
  const oAt = current.startedAt ?? 0;
  if (cAt !== oAt) return cAt > oAt;
  return candidate.id.localeCompare(current.id) > 0;
}

/** Collapse turns to one head turn per worker. */
function groupNativeWorkers(jobs: readonly NativeJob[]): NativeJob[] {
  const byWorker = new Map<string, NativeJob>();
  for (const job of jobs) {
    const key = job.workerId || job.id;
    const prev = byWorker.get(key);
    if (!prev || isBetterNativeHead(job, prev)) byWorker.set(key, job);
  }
  return [...byWorker.values()];
}

/**
 * Create tasks only for currently live workers this session owns, and update
 * existing worker links across spawn, steer, and resume.
 *
 * Keyed by `workerId`: a steered or resumed worker reuses its existing native
 * task (reopening `in_progress` and clearing `doneAt` on resume, or re-creating
 * a new task if the earlier one was already deleted after the close delay).
 */
/** True when any completed native task belongs to a dismissible (succeeded, non-rejected) worker head waiting for CLOSE_DELAY_MS. */
export function hasPendingNativeClose(rows: readonly RadarJob[], links: NativeTaskLinks): boolean {
  const byWorker = new Map<string, NativeJob>();
  for (const job of groupNativeWorkers(nativeJobsFromRadar(rows))) byWorker.set(job.workerId || job.id, job);
  for (const [key, link] of Object.entries(links)) {
    if (link.status !== 'completed') continue;
    const job = byWorker.get(key);
    if (job && job.status === 'succeeded' && job.acceptance?.state !== 'rejected') return true;
  }
  return false;
}

export async function syncNativeTasks(
  jobs: readonly NativeJob[],
  previous: NativeTaskLinks,
  client: NativeTaskClient,
  now: number = Date.now(),
  owned: (id: string) => boolean = () => true,
): Promise<NativeTaskLinks> {
  const next: NativeTaskLinks = { ...previous };
  const workers = groupNativeWorkers(jobs);

  for (const job of workers) {
    // Mid-handoff: only a superseded parent is visible before its child appears;
    // keep the worker's task in_progress without marking it completed.
    if (job.supersededBy && !isLiveStatus(job.status)) continue;

    const key = job.workerId || job.id;
    const old = next[key];
    const live = isLiveNative(job);

    if (old?.status === 'deleted' && !live) continue;
    const needsCreate = old === undefined || old.status === 'deleted';
    if (needsCreate && (!live || !owned(job.id))) continue;

    const subject = subjectFor(job);
    const description = descriptionFor(job);
    const status = taskStatus(job);
    const currentFingerprint = fingerprint(job);
    let taskId = needsCreate ? undefined : old?.taskId;
    if (taskId === undefined) {
      try {
        const created = await client.create({
          subject,
          description,
          activeForm: activeForm(job),
          metadata: {
            source: 'agent-smith',
            jobId: job.id,
            workerId: job.workerId,
            role: job.role,
          },
        });
        taskId = nativeId(created) ?? undefined;
      } catch {
        // Host task APIs are an optional projection; workers keep running.
        continue;
      }
      if (taskId === undefined) continue;
      next[key] = { taskId, status: 'in_progress', fingerprint: '' };
    }

    let link = next[key]!;
    // Reopening a worker (e.g. resume_job before close delay) clears doneAt.
    if (live && link.doneAt !== undefined) {
      link = { taskId: link.taskId, status: link.status, fingerprint: link.fingerprint };
      next[key] = link;
    }

    // A finished worker's task is closed (deleted from the host list) CLOSE_DELAY_MS
    // after we first see it finished, so the list does not fill with done work.
    if (!live) {
      const doneAt = link.doneAt ?? now;
      const dismissible = job.status === 'succeeded' && job.acceptance?.state !== 'rejected';
      if (dismissible && now - doneAt >= CLOSE_DELAY_MS && link.status === 'completed') {
        try {
          const closed = await client.update({ taskId, subject, description, status: 'deleted' });
          if (updateSucceeded(closed)) next[key] = { taskId, status: 'deleted', fingerprint: '', doneAt };
        } catch {
          // Retried on the next poll.
        }
        continue;
      }
      if (link.doneAt === undefined) {
        link = { ...link, doneAt };
        next[key] = link;
      }
    }
    if (link.fingerprint === currentFingerprint) continue;
    try {
      const updated = await client.update({
        taskId,
        subject,
        description,
        ...(live ? { activeForm: activeForm(job) } : {}),
        status,
      });
      if (updateSucceeded(updated)) {
        const prior = next[key];
        next[key] = {
          taskId,
          status,
          fingerprint: currentFingerprint,
          ...(!live && prior?.doneAt !== undefined ? { doneAt: prior.doneAt } : {}),
        };
      }
    } catch {
      // Retain the old fingerprint so a later poll retries the update.
    }
  }
  return next;
}
