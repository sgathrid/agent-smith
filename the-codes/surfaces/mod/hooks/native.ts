/**
 * Projection of live Agent Smith workers into Claude Code's native task list.
 *
 * The mod watches Agent Smith's durable job files; it does not create Claude
 * Agent IDs or enter Claude's Agent/subagent loop. A native task ID is kept only
 * after TaskCreate returns one from the host.
 */

import type { FsLike } from './jobs.ts';

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
  readonly summarySource: 'worker' | null;
}

export interface NativeTaskLink {
  readonly taskId: string;
  readonly status: 'in_progress' | 'completed';
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
    status: 'in_progress' | 'completed';
  }): Promise<unknown>;
}

const VALID_STATUSES = new Set<NativeJobStatus>([
  'running',
  'attention',
  'succeeded',
  'failed',
  'canceled',
]);

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

async function jsonFile(fs: FsLike, path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.read(path));
    return record(parsed);
  } catch {
    return null;
  }
}

/** Read only Agent Smith's durable jobs; legacy files are projected elsewhere. */
export async function readNativeJobs(fs: FsLike, repo: string): Promise<NativeJob[]> {
  const dir = `${repo.replace(/\/+$/, '')}/.agent-smith/jobs`;
  let entries: readonly { name: string; kind: string }[];
  try {
    entries = await fs.list(dir);
  } catch {
    return [];
  }

  const jobs: NativeJob[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'dir' || entry.name.startsWith('.')) continue;
    const base = `${dir}/${entry.name}`;
    const manifest = await jsonFile(fs, `${base}/job.json`);
    if (manifest === null) continue;
    // This projection needs only schema v1 fields. A future layout is left to
    // its matching reader rather than guessed at by a stale plugin.
    if (typeof manifest.schema === 'number' && manifest.schema > 1) continue;
    const status = manifest.status;
    if (typeof status !== 'string' || !VALID_STATUSES.has(status as NativeJobStatus)) continue;
    const progress = await jsonFile(fs, `${base}/progress.json`);
    // `orphaned` is left by the node reader once it proves the supervisor pid is
    // dead (forge/format.ts deriveOrphan); a running anchor with it is failed.
    const orphaned = status === 'running' || status === 'attention'
      ? await fs.exists(`${base}/orphaned`).catch(() => false)
      : false;
    const resolved = record(manifest.resolved);
    const latestSummary = text(progress?.latestSummary, manifest.latestSummary);
    const summarySource = (progress?.summarySource ?? manifest.summarySource) === 'worker' && latestSummary !== null
      ? 'worker'
      : null;

    jobs.push({
      id: text(manifest.jobId) ?? entry.name,
      status: orphaned ? 'failed' : status as NativeJobStatus,
      task: text(manifest.task) ?? '',
      name: text(manifest.name, resolved?.name, progress?.name),
      workerId: text(manifest.workerId, resolved?.workerId, progress?.workerId) ?? entry.name,
      role: text(manifest.role, resolved?.role, progress?.role, resolved?.mode, manifest.mode),
      provider: text(manifest.provider),
      model: text(manifest.model),
      latestSummary,
      summarySource,
    });
  }
  return jobs;
}

function subjectFor(job: NativeJob): string {
  const task = job.task.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
  const subject = job.name !== null && task !== ''
    ? `${job.name}: ${task}`
    : job.name ?? (task !== '' ? task : null) ?? job.role ?? job.id;
  return subject.slice(0, 120) || job.id;
}

function descriptionFor(job: NativeJob): string {
  const lines = [
    'Agent Smith worker',
    `Job ID: ${job.id}`,
    `Worker ID: ${job.workerId}`,
    ...(job.role === null ? [] : [`Role: ${job.role}`]),
    ...(job.provider === null ? [] : [`Provider: ${job.provider}`]),
    ...(job.model === null ? [] : [`Model: ${job.model}`]),
    `Outcome: ${job.status}`,
    ...(job.task === '' ? [] : [`Task: ${job.task}`]),
  ];
  if (job.summarySource === 'worker' && job.latestSummary !== null) {
    lines.push('', 'Latest worker output:', job.latestSummary.slice(0, 1_000));
  }
  return lines.join('\n');
}

function activeForm(job: NativeJob): string {
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

function taskStatus(job: NativeJob): NativeTaskLink['status'] {
  return job.status === 'running' || job.status === 'attention' ? 'in_progress' : 'completed';
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
 * Create tasks only for currently live jobs, and update only jobs already
 * represented in the host task list. That keeps old finished jobs from flooding
 * TaskList when a session starts.
 */
export async function syncNativeTasks(
  jobs: readonly NativeJob[],
  previous: NativeTaskLinks,
  client: NativeTaskClient,
): Promise<NativeTaskLinks> {
  const next: NativeTaskLinks = { ...previous };
  for (const job of jobs) {
    const old = next[job.id];
    const live = job.status === 'running' || job.status === 'attention';
    if (old === undefined && !live) continue;

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
    if (link.fingerprint === currentFingerprint) continue;
    try {
      const updated = await client.update({
        taskId,
        subject,
        description,
        ...(live ? { activeForm: activeForm(job) } : {}),
        status,
      });
      if (updateSucceeded(updated)) next[job.id] = { taskId, status, fingerprint: currentFingerprint };
    } catch {
      // Retain the old fingerprint so a later poll retries the update.
    }
  }
  return next;
}
