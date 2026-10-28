/**
 * summary.ts — the read-side shapes (a list row, one job in full) and the pure
 * projection from an ObservedJob onto them.
 */

import type { ObservedJob } from '../harness/types.ts';
import type { ProgressDigest } from '../surfaces/mod/hooks/progress.ts';
import { nextActionFor, type ForgeActivity, type ForgeStatus, type WatchedFileSigs } from './format.ts';
import type { Acceptance } from './checks.ts';

export interface ListFilter {
  /** 'agent-smith' (ours, default), 'agy-staff' (interop history), or 'all'. */
  readonly provider?: string | undefined;
  /** Only jobs in this state. */
  readonly status?: ForgeStatus | undefined;
  readonly limit?: number | undefined;
  /** Only jobs last touched (finished, updated or started) at or after this epoch ms. */
  readonly sinceMs?: number | undefined;
  /** Only these job IDs (e.g. the ones this process spawned). */
  readonly ids?: ReadonlySet<string> | undefined;
}

export interface JobSummary {
  readonly jobId: string;
  readonly name: string;
  readonly workerId: string;
  readonly role: string | null;
  readonly latestSummary: string | null;
  readonly summarySource: 'worker' | null;
  readonly source: 'agent-smith' | 'agy-staff';
  readonly status: ObservedJob['status'];
  readonly provider: string | null;
  readonly mode: string | null;
  readonly model: string | null;
  readonly task: string | null;
  readonly toolCalls: number | null;
  readonly currentActivity: ForgeActivity | null;
  readonly lastActivity: ForgeActivity | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly finishedAt: string | null;
  readonly warnings: readonly { code: string; message: string }[];
  /** Derived (never stored) imperative for the orchestrator on failed/canceled jobs; null otherwise. */
  readonly nextAction: string | null;
  /** True when the job ran with the approval prompt bypassed. */
  readonly unrestricted?: boolean;
  /** Set when this job turn was superseded by a steered continuation turn. */
  readonly supersededBy?: string | null;
  /** Set when this job turn was spawned by steering an earlier turn. */
  readonly steeredFrom?: string | null;
  /** Count of unconsumed queued steers waiting for the current turn to finish. */
  readonly pendingSteers?: number;
  /** Files changed since the spawn baseline, once the job has finished. */
  readonly changedFileCount?: number | null;
  /** What the worker has done so far, read from progress.json (pure projection of the file). */
  readonly digest?: ProgressDigest | null;
  /** Acceptance results attached to the job, when checks have been configured or have run. */
  readonly acceptance?: Acceptance | null;
  /** Tool calls that ended in an error state; evidence, not a verdict. Absent when none. */
  readonly toolErrors?: number;
  /** Failed before any tool call (route, model or account). Absent otherwise. */
  readonly failedEarly?: boolean;
  /** changedFiles could not be computed at finish; absent changedFiles then means unknown, not none. */
  readonly changedFilesUnknown?: boolean;
  /** The cwd no longer existed at finish. */
  readonly cwdMissingAtFinish?: boolean;
  /** Last provider event (progress.json lastEventAt). */
  readonly lastEventAt?: string | null;
  /** Last heartbeat from the worker's process owner; null for jobs from older builds. */
  readonly lastAliveAt?: string | null;
}

export interface JobDetail extends JobSummary {
  readonly report: string | null;
  readonly error: string | null;
  /** Why it failed, in two to four words; null unless failed. */
  readonly reason?: string | null;
  readonly exitCode: number | null;
  readonly unrestricted: boolean;
  readonly pipeline: string | null;
  readonly stage: string | null;
  readonly usage: Readonly<Record<string, number>> | null;
  readonly conversation: string | null;
  readonly effort: string | null;
  readonly cwd: string | null;
  readonly modelRequested?: string | null;
  readonly modelResolved?: string | null;
  readonly modelSource?: 'requested' | 'harness-config' | 'reported' | 'unknown';
  readonly preambleApplied?: boolean;
  readonly sandbox?: string;
  readonly sandboxFlags?: readonly string[];
  readonly readOnlyRequested?: boolean;
  readonly readOnlyEnforced?: boolean;
  /** False when a cancel was requested but this process holds no live handle. */
  readonly cancellable: boolean;
  /** Git reference at spawn (only when cwd was a git repo). */
  readonly gitBaseline?: { readonly head: string | null; readonly dirty: readonly string[] };
  /**
   * Paths changed since the baseline (set at finish). A worktree diff, so
   * concurrent jobs in one worktree can attribute each other's edits.
   */
  readonly changedFiles?: readonly string[];
  readonly changedFilesTruncated?: boolean;
  readonly unattributedFiles?: readonly string[];
  readonly watchedFiles?: Readonly<Record<string, WatchedFileSigs>>;
  /** Watched brief files whose repository or external cwd copy changed after the turn started. */
  readonly staleReads?: readonly string[];
}

/** Project an ObservedJob onto what a list actually needs. */
export function toSummary(observed: ObservedJob, source: 'agent-smith' | 'agy-staff'): JobSummary {
  const raw = observed.raw;
  const toolCalls = typeof raw['tool_calls'] === 'number' ? raw['tool_calls'] : null;
  const task = typeof raw['task'] === 'string' && raw['task'] !== '' ? raw['task'] : null;
  const changedFiles = raw['changed_files'];
  const digest = readDigest(raw['digest']);
  const activities = Array.isArray(raw['recent_activities']) ? raw['recent_activities'] : [];
  const currentActivity = observed.status === 'running'
    ? [...activities].reverse().find(isActiveForgeActivity) ?? null
    : null;
  return {
    jobId: observed.jobId,
    name: typeof raw['name'] === 'string' && raw['name'] ? raw['name'] : observed.jobId,
    workerId: typeof raw['workerId'] === 'string' ? raw['workerId'] : observed.jobId,
    role: typeof raw['role'] === 'string' ? raw['role'] : observed.mode,
    latestSummary: raw['summarySource'] === 'worker' && typeof raw['latestSummary'] === 'string' ? raw['latestSummary'] : null,
    summarySource: raw['summarySource'] === 'worker' ? 'worker' : null,
    source,
    status: observed.status,
    // `raw.provider` for OUR jobs. Interop jobs carry no provider field: they are
    // agy-staff's, i.e. agy. Their `profile` ("unrestricted") is a permission
    // word, not a provider, so it goes to the unrestricted flag.
    provider: typeof raw['provider'] === 'string' ? raw['provider'] : source === 'agy-staff' ? 'agy' : observed.label,
    unrestricted: raw['unrestricted'] === true || (source === 'agy-staff' && observed.label === 'unrestricted'),
    nextAction: nextActionFor({
      status: observed.status,
      jobStatus: typeof raw['job_status'] === 'string' ? raw['job_status'] : null,
      error: [typeof raw['error'] === 'string' ? raw['error'] : '', ...observed.warnings.map((w) => w.message)].join(' — '),
      report: observed.output,
      exitCode: typeof raw['exit_code'] === 'number' ? raw['exit_code'] : null,
      deniedCount: Array.isArray(raw['denied_actions']) ? raw['denied_actions'].length : 0,
      unrestricted: raw['unrestricted'] === true,
      steerNotApplied: observed.warnings.some((w) => w.code === 'steer_not_applied'),
      failedEarly: raw['failedEarly'] === true,
    }),
    mode: observed.mode,
    model: observed.model,
    task,
    toolCalls,
    currentActivity,
    lastActivity: isForgeActivity(raw['last_activity']) ? raw['last_activity']
      : [...activities].reverse().find(isForgeActivity) ?? null,
    startedAt: observed.startedAt,
    updatedAt: observed.updatedAt,
    finishedAt: observed.finishedAt,
    warnings: observed.warnings.map((w) => ({ code: w.code, message: w.message })),
    ...(typeof raw['supersededBy'] === 'string' || raw['supersededBy'] === null
      ? { supersededBy: raw['supersededBy'] as string | null }
      : {}),
    ...(typeof raw['steeredFrom'] === 'string' || raw['steeredFrom'] === null
      ? { steeredFrom: raw['steeredFrom'] as string | null }
      : {}),
    ...(typeof raw['pendingSteers'] === 'number'
      ? { pendingSteers: raw['pendingSteers'] }
      : {}),
    ...(Array.isArray(changedFiles) ? { changedFileCount: changedFiles.length } : {}),
    ...(digest !== null ? { digest } : {}),
    ...(typeof raw['toolErrors'] === 'number' && raw['toolErrors'] > 0 ? { toolErrors: raw['toolErrors'] } : {}),
    ...(raw['failedEarly'] === true ? { failedEarly: true } : {}),
    ...(raw['changedFilesUnknown'] === true ? { changedFilesUnknown: true } : {}),
    ...(raw['cwdMissingAtFinish'] === true ? { cwdMissingAtFinish: true } : {}),
    ...(typeof raw['last_event_at'] === 'string' ? { lastEventAt: raw['last_event_at'] } : {}),
    ...(typeof raw['last_alive_at'] === 'string' ? { lastAliveAt: raw['last_alive_at'] } : {}),
  };
}

/** progress.json `digest`, accepted only when it has the shape the writer produces. */
function readDigest(v: unknown): ProgressDigest | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  if (typeof d['phase'] !== 'string' || !Array.isArray(d['edited'])) return null;
  const n = (key: string): number => typeof d[key] === 'number' ? d[key] as number : 0;
  const repeat = d['repeat'];
  const r = repeat !== null && typeof repeat === 'object' && !Array.isArray(repeat)
    ? repeat as Record<string, unknown> : null;
  return {
    phase: (['starting', 'exploring', 'editing', 'testing', 'running'].includes(d['phase'])
      ? d['phase'] : 'running') as ProgressDigest['phase'],
    filesRead: n('filesRead'),
    searches: n('searches'),
    commands: n('commands'),
    testRuns: n('testRuns'),
    edited: d['edited'].filter((e): e is string => typeof e === 'string'),
    editedCount: n('editedCount'),
    lastTestFailed: d['lastTestFailed'] === true,
    repeat: r !== null && typeof r['label'] === 'string' && typeof r['count'] === 'number'
      ? { label: r['label'], count: r['count'] } : null,
  };
}

function isForgeActivity(value: unknown): value is ForgeActivity {
  if (typeof value !== 'object' || value === null) return false;
  const activity = value as Record<string, unknown>;
  return typeof activity['stepIndex'] === 'number' && typeof activity['tool'] === 'string'
    && ['active', 'done', 'denied', 'error'].includes(String(activity['status']));
}

function isActiveForgeActivity(value: unknown): value is ForgeActivity {
  if (typeof value !== 'object' || value === null) return false;
  const activity = value as Record<string, unknown>;
  return typeof activity['stepIndex'] === 'number' && typeof activity['tool'] === 'string' && activity['status'] === 'active';
}
