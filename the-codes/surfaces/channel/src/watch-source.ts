import { AgentSmithReader } from '../../../harness/agent-smith.ts';
import { normalize } from '../../../harness/normalize.ts';
import { readJsonSafe } from '../../../harness/safe-fs.ts';
import { pipelineRecordPath, type PipelineRecord } from '../../../forge/execute.ts';
import type { ObservedJob } from '../../../harness/types.ts';
import { isTerminalForgeStatus } from '../../../forge/format.ts';
import { readAcceptance } from '../../../forge/checks.ts';
import { livenessOf, type Liveness } from '../../mod/hooks/stale.ts';
import { ACCEPTANCE_HOLD_MS, droppedMessageQuote, pipelineOutcome } from '../../mod/hooks/notice.ts';
import { normalizeContinuationKind, type ContinuationKind } from '../../mod/hooks/turns.ts';
import { reportSummary } from '../../mod/hooks/text.ts';
import type { WatchableJob, WatchStatus } from './policy.ts';
import type { Team } from '../../mod/types/index.d.ts';

const reader = new AgentSmithReader();

export { ACCEPTANCE_HOLD_MS };

function isAcceptancePending(finishedAt: string | null, placeholder: PendingAcceptance, now: number): boolean {
  if (finishedAt === null || placeholder.pending !== true) return false;
  const finished = Date.parse(finishedAt);
  const budget = typeof placeholder.budgetMs === 'number' && placeholder.budgetMs > 0 ? placeholder.budgetMs : ACCEPTANCE_HOLD_MS;
  return !(Number.isFinite(finished) && now - finished > budget);
}
type PendingAcceptance = { pending?: boolean; budgetMs?: unknown; running?: unknown };

export function pipelineToWatchable(run: PipelineRecord | null): WatchableJob | null {
  if (!run || typeof run.runId !== 'string' || typeof run.pipeline !== 'string' ||
      !Number.isFinite(run.startedAt) || (run.finishedAt !== null && !Number.isFinite(run.finishedAt)) ||
      !['running', 'passed', 'partial', 'failed'].includes(run.status) ||
      run.stageResults === null || typeof run.stageResults !== 'object') return null;
  return {
    id: run.runId, name: run.pipeline, role: 'pipeline',
    status: run.status === 'running' ? 'running' : run.status === 'passed' ? 'succeeded' : 'failed',
    startedAt: new Date(run.startedAt).toISOString(),
    lastEventAt: new Date(run.startedAt).toISOString(),
    finishedAt: run.finishedAt === null ? null : new Date(run.finishedAt).toISOString(),
    warned: run.status !== 'passed' && run.status !== 'running',
    outcome: run.status === 'running' ? undefined : pipelineOutcome(run),
  };
}

export async function readPipelineRecord(cwd: string, runId: string): Promise<{ job: WatchableJob; stageJobIds: string[] } | null> {
  const run = await readJsonSafe<PipelineRecord>(pipelineRecordPath(cwd, runId));
  const job = pipelineToWatchable(run);
  if (job === null || run === null) return null;
  const stageJobIds = Object.values(run.stageResults).flatMap(s => (s && typeof s.jobId === 'string' ? [s.jobId] : []));
  return { job, stageJobIds };
}

export async function readJob(cwd: string, jobId: string, now: number = Date.now()): Promise<WatchableJob | null> {
  return readOne(cwd, jobId, now);
}

async function readOne(cwd: string, jobId: string, now: number): Promise<WatchableJob | null> {
  let observed: ObservedJob;
  try {
    const raw = await reader.read(cwd, jobId);
    if (raw === null) return null;
    observed = normalize(raw);
  } catch {
    return null;
  }

  const warned = observed.warnings.length > 0;
  const raw = observed.raw;
  const acceptance = readAcceptance(cwd, observed.jobId) as PendingAcceptance & { checks?: readonly { ok?: unknown; name?: unknown }[] };
  const checks = Array.isArray(acceptance.checks) && acceptance.checks.length > 0
    ? {
      passed: acceptance.checks.filter((c) => c?.ok === true).length, total: acceptance.checks.length,
      failed: acceptance.checks.flatMap((c) => (c?.ok !== true && typeof c?.name === 'string' ? [c.name] : [])),
    } : null;

  const continuedFrom = typeof raw['continuedFrom'] === 'string' && raw['continuedFrom'] !== '' ? raw['continuedFrom'] : null;
  const continuationKind: ContinuationKind | null =
    normalizeContinuationKind(raw['continuationKind']) ?? (continuedFrom !== null ? 'follow-up' : null);
  const dropped = observed.warnings.find((w) => w.code === 'steer_not_applied');
  const droppedMessage = dropped ? droppedMessageQuote(dropped.message) : null;
  const pending = raw['pendingSteers'];

  const status = toWatchStatus(observed, now);
  const latestSummary = isTerminalForgeStatus(observed.status)
    ? reportSummary(observed.output ?? '') || null
    : typeof raw['latestSummary'] === 'string' ? raw['latestSummary'] : null;
  const acceptancePending = isTerminalForgeStatus(status) && isAcceptancePending(observed.finishedAt, acceptance, now);

  return {
    id: observed.jobId,
    workerId: typeof raw['workerId'] === 'string' && raw['workerId'] !== '' ? raw['workerId'] : observed.jobId,
    name: typeof observed.raw['name'] === 'string' ? observed.raw['name'] : undefined,
    turn: typeof raw['turn'] === 'number' && Number.isInteger(raw['turn']) && raw['turn'] >= 1 ? raw['turn'] : 1,
    role: typeof observed.raw['role'] === 'string' ? observed.raw['role'] : observed.mode ?? undefined,
    provider: typeof observed.raw['provider'] === 'string' ? observed.raw['provider'] : undefined,
    startedAt: observed.startedAt,
    chainStartedAt: typeof raw['chainStartedAt'] === 'string' && raw['chainStartedAt'] !== '' ? raw['chainStartedAt'] : observed.startedAt,
    changedFileCount: Array.isArray(observed.raw['changed_files']) ? observed.raw['changed_files'].length : undefined,
    latestSummary,
    failureReason: [raw['reason'], raw['error']].find((v): v is string => typeof v === 'string' && v !== '') ?? null,
    failureDetail: typeof raw['error'] === 'string' ? raw['error'] : null,
    checks,
    ...(observed.status === 'succeeded' && acceptance.pending === true
      ? { checksRunning: typeof acceptance.running === 'string' && acceptance.running !== '' ? acceptance.running : true as const } : {}),
    ...(acceptancePending ? { acceptancePending: true } : {}),
    summarySource: latestSummary !== null && (isTerminalForgeStatus(observed.status) || raw['summarySource'] === 'worker') ? 'worker' : null,
    status,
    ...livenessField(watchLiveness(observed, now)),
    lastEventAt: observed.updatedAt,
    finishedAt: observed.finishedAt,
    warned,
    supersededBy: typeof raw['supersededBy'] === 'string' && raw['supersededBy'] !== '' ? raw['supersededBy'] : null,
    followedBy: typeof raw['followedBy'] === 'string' && raw['followedBy'] !== '' ? raw['followedBy'] : null,
    ...(typeof pending === 'number' && Number.isFinite(pending) && pending > 0 ? { pendingMessages: pending } : {}),
    continuedFrom,
    continuationKind,
    ...(dropped ? { steerNotApplied: true } : {}),
    ...(droppedMessage ? { droppedMessage } : {}),
    ...(Array.isArray(raw['staleReads']) && raw['staleReads'].length > 0
      ? { staleReads: raw['staleReads'].filter((f): f is string => typeof f === 'string' && f.trim() !== '') }
      : {}),
  };
}

export function watchLiveness(observed: ObservedJob, now: number): Liveness | null {
  const raw = observed.raw;
  const activity = raw['last_activity'];
  return livenessOf({
    status: observed.status, updatedAt: observed.updatedAt, now,
    lastEventAt: typeof raw['last_event_at'] === 'string' ? raw['last_event_at'] : null,
    lastAliveAt: typeof raw['last_alive_at'] === 'string' ? raw['last_alive_at'] : null,
    lastActivity: activity !== null && typeof activity === 'object' ? activity as { tool?: unknown; input?: unknown; status?: unknown } : null,
    team: (raw['team'] ?? null) as Team | null,
  });
}

function livenessField(l: Liveness | null): { liveness?: { state: 'silent' | 'dead'; silentForMs: number; since: number | null; tool?: string } } {
  if (l === null || (l.state !== 'silent' && l.state !== 'dead')) return {};
  return { liveness: { state: l.state, silentForMs: l.silentForMs, since: l.since, ...(l.tool ? { tool: l.tool } : {}) } };
}

export function toWatchStatus(observed: ObservedJob, now: number): WatchStatus {
  if (observed.status !== 'running') return observed.status;
  const live = watchLiveness(observed, now);
  return live !== null && (live.state === 'silent' || live.state === 'dead') ? 'attention' : 'running';
}
