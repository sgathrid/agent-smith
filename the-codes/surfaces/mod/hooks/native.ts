/**
 * Projection of live Agent Smith workers into Claude Code's native task list.
 *
 * The mod watches Agent Smith's durable job files; it does not create Claude
 * Agent IDs or enter Claude's Agent/subagent loop. A native task ID is kept only
 * after TaskCreate returns one from the host.
 */

import type { FsLike } from './jobs.ts';
import type { RadarJob, RadarAcceptance } from '../types/index.d.ts';
import { readForgeJobs, acceptanceLabel } from './canonical.ts';

export type NativeJobStatus = 'running' | 'attention' | 'succeeded' | 'failed' | 'canceled';

export interface NativeJob {
  readonly id: string;
  readonly status: NativeJobStatus;
  readonly task: string;
  readonly name: string | null;
  readonly workerId: string;
  readonly role: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly latestSummary: string | null;
  readonly acceptance?: RadarAcceptance;
  readonly summarySource: 'worker' | null;
}

export interface NativeTaskLink {
  readonly taskId: string;
  readonly status: 'in_progress' | 'completed' | 'deleted';
  /** When this job was first seen finished (epoch ms); starts the close delay. */
  readonly doneAt?: number;
  /** Last description/status sent successfully; lets the poll avoid no-op writes. */
  readonly fingerprint: string;
}

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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** Both native tasks and /forge use the same canonical projection and liveness. */
export function nativeJobsFromRadar(jobs: readonly RadarJob[]): NativeJob[] {
  return jobs.filter(job => job.status !== 'unknown').map(job => ({
    id: job.id, status: job.status as NativeJobStatus, task: job.task,
    name: job.name ?? null, workerId: job.workerId ?? job.id, role: job.role ?? null,
    provider: job.provider ?? null, model: job.model ?? null,
    latestSummary: job.latestSummary ?? null, summarySource: job.summarySource ?? null,
    acceptance: job.acceptance,
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
  return text(task?.id);
}

function updateSucceeded(result: unknown): boolean {
  const outer = record(result);
  if (outer === null || outer.isError === true || typeof outer.deny === 'string') return false;
  const output = record(outer.result);
  return output?.success === true;
}

/** How long a finished job's task stays in the host list before it is closed. */
export const CLOSE_DELAY_MS = 10_000;

function taskStatus(job: NativeJob): 'in_progress' | 'completed' {
  return job.status === 'running' || job.status === 'attention' || job.acceptance?.pending ? 'in_progress' : 'completed';
}

function fingerprint(job: NativeJob): string {
  return JSON.stringify({
    subject: subjectFor(job),
    description: descriptionFor(job),
    status: taskStatus(job),
    activeForm: activeForm(job),
  });
}

/**
 * Create tasks only for currently live jobs this session owns, and update only
 * jobs already represented in the host task list. That keeps old finished jobs
 * and other sessions' work from flooding TaskList; a task already linked runs
 * to completion and closes as before, whoever owns its job.
 */
export async function syncNativeTasks(
  jobs: readonly NativeJob[],
  previous: NativeTaskLinks,
  client: NativeTaskClient,
  now: number = Date.now(),
  owned: (id: string) => boolean = () => true,
): Promise<NativeTaskLinks> {
  const next: NativeTaskLinks = { ...previous };
  for (const job of jobs) {
    const old = next[job.id];
    if (old?.status === 'deleted') continue;
    const live = job.status === 'running' || job.status === 'attention' || job.acceptance?.pending === true;
    if (old === undefined && (!live || !owned(job.id))) continue;

    const subject = subjectFor(job);
    const description = descriptionFor(job);
    const status = taskStatus(job);
    const currentFingerprint = fingerprint(job);
    let taskId = old?.taskId;
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
      next[job.id] = { taskId, status: 'in_progress', fingerprint: '' };
    }

    const link = next[job.id]!;
    // A finished job's task is closed (deleted from the host list) CLOSE_DELAY_MS
    // after we first see it finished, so the list does not fill with done work.
    if (!live) {
      const doneAt = link.doneAt ?? now;
      const dismissible = job.status === 'succeeded' && job.acceptance?.state !== 'rejected';
      if (dismissible && now - doneAt >= CLOSE_DELAY_MS && link.status === 'completed') {
        try {
          const closed = await client.update({ taskId, subject, description, status: 'deleted' });
          if (updateSucceeded(closed)) next[job.id] = { taskId, status: 'deleted', fingerprint: '', doneAt };
        } catch {
          // Retried on the next poll.
        }
        continue;
      }
      if (link.doneAt === undefined) next[job.id] = { ...link, doneAt };
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
        const prior = next[job.id];
        next[job.id] = { taskId, status, fingerprint: currentFingerprint, ...(prior?.doneAt === undefined ? {} : { doneAt: prior.doneAt }) };
      }
    } catch {
      // Retain the old fingerprint so a later poll retries the update.
    }
  }
  return next;
}
