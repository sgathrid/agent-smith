import type { ObservedJob } from '../harness/types.ts';
import type { ProgressDigest } from '../surfaces/mod/hooks/progress.ts';
import { reasonFromText } from '../surfaces/mod/hooks/reasons.ts';
import { normalizeContinuationKind, type ContinuationKind, type ForgeActivity, type ForgeStatus, type WatchedFileSigs } from './format.ts';
import type { Acceptance } from './checks.ts';

export interface ListFilter {
  readonly status?: ForgeStatus | undefined;
  readonly limit?: number | undefined;
  readonly sinceMs?: number | undefined;
  readonly ids?: ReadonlySet<string> | undefined;
  readonly groupByWorker?: boolean | undefined;
}

export interface JobSummary {
  readonly jobId: string;
  readonly name: string;
  readonly workerId: string;
  readonly turn: number;
  readonly role: string | null;
  readonly latestSummary: string | null;
  readonly summarySource: 'worker' | null;
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
  readonly reason?: string | null;
  readonly resumable?: boolean;
  readonly unrestricted?: boolean;
  readonly supersededBy?: string | null;
  readonly followedBy?: string;
  readonly continuedFrom?: string;
  readonly continuationKind?: ContinuationKind;
  readonly chainStartedAt?: string;
  readonly pendingSteers?: number;
  readonly changedFileCount?: number | null;
  readonly digest?: ProgressDigest | null;
  readonly acceptance?: Acceptance | null;
  readonly toolErrors?: number;
  readonly failedEarly?: boolean;
  readonly changedFilesUnknown?: boolean;
  readonly cwdMissingAtFinish?: boolean;
  readonly lastEventAt?: string | null;
  readonly lastAliveAt?: string | null;
}

export interface JobDetail extends JobSummary {
  readonly report: string | null;
  readonly error: string | null;
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
  readonly cancellable: boolean;
  readonly gitBaseline?: { readonly head: string | null; readonly dirty: readonly string[] };
  readonly changedFiles?: readonly string[];
  readonly changedFilesTruncated?: boolean;
  readonly unattributedFiles?: readonly string[];
  readonly watchedFiles?: Readonly<Record<string, WatchedFileSigs>>;
  readonly staleReads?: readonly string[];
}

export function failedReason(d: { readonly status: string; readonly reason?: string | null; readonly error?: string | null }): string | null {
  if (d.status !== 'failed') return null;
  const stored = d.reason;
  return stored ? stored : reasonFromText(d.error);
}

export function toSummary(observed: ObservedJob): JobSummary {
  const raw = observed.raw;
  const toolCalls = typeof raw['tool_calls'] === 'number' ? raw['tool_calls'] : null;
  const task = typeof raw['task'] === 'string' && raw['task'] !== '' ? raw['task'] : null;
  const changedFiles = raw['changed_files'];
  const digest = readDigest(raw['digest']);
  const activities = Array.isArray(raw['recent_activities']) ? raw['recent_activities'] : [];
  const currentActivity = observed.status === 'running'
    ? [...activities].reverse().find(isActiveForgeActivity) ?? null
    : null;
  const turn = typeof raw['turn'] === 'number' && Number.isInteger(raw['turn']) && raw['turn'] >= 1 ? raw['turn'] : 1;
  const continuedFrom = typeof raw['continuedFrom'] === 'string' && raw['continuedFrom'] !== '' ? raw['continuedFrom'] : undefined;
  const continuationKind = normalizeContinuationKind(raw['continuationKind']) ?? (continuedFrom !== undefined ? 'follow-up' : undefined);
  const chainStartedAt =
    typeof raw['chainStartedAt'] === 'string' && raw['chainStartedAt'] !== ''
      ? raw['chainStartedAt']
      : (observed.startedAt ?? undefined);
  const reason = failedReason({
    status: observed.status,
    reason: typeof raw['reason'] === 'string' && raw['reason'] !== '' ? raw['reason'] : null,
    error: typeof raw['error'] === 'string' ? raw['error'] : null,
  });
  return {
    jobId: observed.jobId,
    name: typeof raw['name'] === 'string' && raw['name'] ? raw['name'] : observed.jobId,
    workerId: typeof raw['workerId'] === 'string' && raw['workerId'] !== '' ? raw['workerId'] : observed.jobId,
    turn,
    role: typeof raw['role'] === 'string' ? raw['role'] : observed.mode,
    latestSummary: raw['summarySource'] === 'worker' && typeof raw['latestSummary'] === 'string' ? raw['latestSummary'] : null,
    summarySource: raw['summarySource'] === 'worker' ? 'worker' : null,
    status: observed.status,
    provider: typeof raw['provider'] === 'string' ? raw['provider'] : observed.label,
    unrestricted: raw['unrestricted'] === true,
    resumable: typeof raw['conversation'] === 'string' && raw['conversation'] !== '',
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
    ...(reason !== null ? { reason } : {}),
    ...(typeof raw['supersededBy'] === 'string' || raw['supersededBy'] === null
      ? { supersededBy: raw['supersededBy'] as string | null }
      : {}),
    ...(typeof raw['followedBy'] === 'string' && raw['followedBy'] !== '' ? { followedBy: raw['followedBy'] } : {}),
    ...(continuedFrom !== undefined ? { continuedFrom } : {}),
    ...(continuationKind !== undefined ? { continuationKind } : {}),
    ...(chainStartedAt !== undefined ? { chainStartedAt } : {}),
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
