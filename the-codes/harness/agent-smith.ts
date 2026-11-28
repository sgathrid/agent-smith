import { existsSafe, readJsonSafe, readTextSafe, readdirSafe } from './safe-fs.ts';
import {
  FILES,
  SCHEMA_VERSION,
  CANCEL_ORPHAN_REASON,
  ORPHAN_REASON,
  deriveOrphan,
  normalizeContinuationKind,
  normalizeDenials,
  ownerAlive,
  jobFile,
  jobsDir,
  type ForgeManifest,
} from '../forge/format.ts';
import type { JobStateReader, RawJobState } from './types.ts';
import { parseTeam } from '../surfaces/mod/hooks/canonical.ts';
import { settleTeam } from '../surfaces/mod/hooks/team.ts';

export const SMITH_PAYLOAD = {
  provider: 'provider',
  mode: 'mode',
  model: 'model',
  effort: 'effort',
  status: 'status',
  task: 'task',
  unrestricted: 'unrestricted',
  conversation: 'conversation',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  exitCode: 'exit_code',
  jobStatus: 'job_status',
  error: 'error',
  deniedActions: 'denied_actions',
  usage: 'usage',
  toolCalls: 'tool_calls',
  output: 'output',
  canceled: 'canceled',
  cancelAt: 'cancel_at',
  lastEventAt: 'last_event_at',
  lastAliveAt: 'last_alive_at',
  recentActivities: 'recent_activities',
  lastActivity: 'last_activity',
  latestText: 'latest_text',
  progressWarnings: 'progress_warnings',
  pipeline: 'pipeline',
  stage: 'stage',
  attempt: 'attempt',
  schema: 'schema',
} as const;

const CANCELED_ORPHAN = { status: 'canceled', suspicious: false, reason: CANCEL_ORPHAN_REASON } as const;

export class AgentSmithReader implements JobStateReader {
  readonly provider = 'agent-smith';

  async discover(cwd: string): Promise<string[]> {
    const entries = await readdirSafe(jobsDir(cwd));
    const ids = new Set<string>();
    for (const entry of entries) {
      if (!entry.startsWith('.')) ids.add(entry);
    }
    return [...ids].sort();
  }

  async read(cwd: string, jobId: string): Promise<RawJobState | null> {
    const cancelPath = jobFile(cwd, jobId, FILES.cancel);
    const cancelRequested = await existsSafe(cancelPath);
    let cancelAt: string | null = null;
    if (cancelRequested) {
      const raw = await readTextSafe(cancelPath);
      const t = raw?.trim();
      cancelAt = t !== undefined && t !== '' ? t : null;
    }

    const manifest = await readJsonSafe<ForgeManifest>(jobFile(cwd, jobId, FILES.job));
    const canceled = manifest === null ? cancelRequested : manifest.status === 'canceled';

    if (manifest !== null && typeof manifest.schema === 'number' && manifest.schema > SCHEMA_VERSION) {
      return {
        provider: this.provider,
        jobId,
        cwd,
        partial: true,
        payload: {
          [SMITH_PAYLOAD.schema]: manifest.schema,
          [SMITH_PAYLOAD.error]: `on-disk schema v${manifest.schema} is newer than this reader (v${SCHEMA_VERSION}); state unknown`,
          [SMITH_PAYLOAD.canceled]: canceled,
          [SMITH_PAYLOAD.cancelAt]: cancelAt,
        },
      };
    }

    const report = await readTextSafe(jobFile(cwd, jobId, FILES.report));
    const progress = await readJsonSafe<{
      lastEventAt?: string;
      lastAliveAt?: string;
      workerPid?: number;
      toolCalls?: number;
      toolErrors?: number;
      recentActivities?: unknown[];
      lastActivity?: unknown;
      latestText?: string | null;
      warnings?: string[];
      latestSummary?: string | null;
      summarySource?: 'worker' | null;
      pendingSteers?: number;
      digest?: unknown;
    }>(jobFile(cwd, jobId, FILES.progress));

    const storedTeam = parseTeam(await readJsonSafe<unknown>(jobFile(cwd, jobId, FILES.team)));

    const anyEvidence = manifest !== null || canceled || report !== null;
    if (!anyEvidence) return null;

    let orphan: ReturnType<typeof deriveOrphan> = null;
    if (manifest !== null && manifest.status === 'running' && !canceled
        && !(await existsSafe(jobFile(cwd, jobId, FILES.result)))) {
      const lastSeen = Math.max(
        Date.parse(manifest.updatedAt), Date.parse(progress?.lastEventAt ?? ''),
      );
      orphan = deriveOrphan(manifest, Number.isFinite(lastSeen) ? lastSeen : null, Date.now(), undefined, cancelRequested);
      const cancelAgeMs = cancelAt === null ? NaN : Date.now() - Date.parse(cancelAt);
      const ownerIsAlive = ownerAlive(manifest);
      if (orphan === null && cancelRequested && cancelAgeMs > 60_000 && !ownerIsAlive) orphan = CANCELED_ORPHAN;
    }

    const runStartedAt = Date.parse(manifest?.startedAt ?? manifest?.createdAt ?? '');
    const team = storedTeam === null ? null : settleTeam(storedTeam, {
      live: (orphan?.status ?? manifest?.status) === 'running',
      startedAt: Number.isFinite(runStartedAt) ? runStartedAt : null,
    });

    const legacySteeredFrom = (manifest as (ForgeManifest & { steeredFrom?: unknown }) | null)?.steeredFrom;
    const turn = typeof manifest?.turn === 'number' && Number.isInteger(manifest.turn) && manifest.turn >= 1 ? manifest.turn : 1;
    const continuedFrom =
      typeof manifest?.continuedFrom === 'string' && manifest.continuedFrom !== ''
        ? manifest.continuedFrom
        : typeof legacySteeredFrom === 'string' && legacySteeredFrom !== ''
          ? legacySteeredFrom
          : undefined;
    const continuationKind = normalizeContinuationKind(manifest?.continuationKind) ?? (continuedFrom !== undefined ? 'follow-up' : undefined);
    const chainStartedAt =
      typeof manifest?.chainStartedAt === 'string' && manifest.chainStartedAt !== ''
        ? manifest.chainStartedAt
        : (manifest?.startedAt ?? manifest?.createdAt ?? undefined);

    const payload: Record<string, unknown> = {
      [SMITH_PAYLOAD.schema]: manifest?.schema ?? null,
      [SMITH_PAYLOAD.provider]: manifest?.provider ?? null,
      name: manifest?.name ?? null,
      workerId: manifest?.workerId ?? jobId,
      turn,
      role: manifest?.role ?? manifest?.mode ?? null,
      latestSummary: progress?.latestSummary ?? manifest?.latestSummary ?? null,
      summarySource: progress?.summarySource ?? manifest?.summarySource ?? null,
      [SMITH_PAYLOAD.mode]: manifest?.mode ?? null,
      [SMITH_PAYLOAD.model]: manifest?.model ?? null,
      [SMITH_PAYLOAD.effort]: manifest?.effort ?? null,
      [SMITH_PAYLOAD.status]: orphan?.status ?? manifest?.status ?? null,
      [SMITH_PAYLOAD.task]: manifest?.task ?? null,
      [SMITH_PAYLOAD.unrestricted]: manifest?.unrestricted ?? null,
      [SMITH_PAYLOAD.conversation]: manifest?.conversation ?? null,
      [SMITH_PAYLOAD.createdAt]: manifest?.createdAt ?? null,
      [SMITH_PAYLOAD.updatedAt]: manifest?.updatedAt ?? null,
      [SMITH_PAYLOAD.startedAt]: manifest?.startedAt ?? null,
      [SMITH_PAYLOAD.finishedAt]: manifest?.finishedAt ?? null,
      [SMITH_PAYLOAD.exitCode]: manifest?.exitCode ?? null,
      [SMITH_PAYLOAD.jobStatus]: manifest?.jobStatus ?? null,
      [SMITH_PAYLOAD.error]: orphan?.reason ?? manifest?.error ?? null,
      reason: orphan?.reason ?? manifest?.reason ?? null,
      [SMITH_PAYLOAD.deniedActions]: normalizeDenials(manifest?.deniedActions),
      [SMITH_PAYLOAD.usage]: manifest?.usage ?? null,
      ...(Array.isArray(manifest?.changedFiles) && manifest.changedFilesTruncated !== true
        ? { changed_files: manifest.changedFiles } : {}),
      [SMITH_PAYLOAD.toolCalls]: progress?.toolCalls ?? manifest?.toolCalls ?? null,
      [SMITH_PAYLOAD.pipeline]: manifest?.pipeline ?? null,
      [SMITH_PAYLOAD.stage]: manifest?.stage ?? null,
      [SMITH_PAYLOAD.attempt]: manifest?.attempt ?? null,
      [SMITH_PAYLOAD.output]: report,
      [SMITH_PAYLOAD.canceled]: canceled,
      [SMITH_PAYLOAD.cancelAt]: cancelAt,
      [SMITH_PAYLOAD.lastEventAt]: progress?.lastEventAt ?? manifest?.updatedAt ?? null,
      [SMITH_PAYLOAD.lastAliveAt]: progress?.lastAliveAt ?? null,
      ...(typeof progress?.workerPid === 'number' ? { workerPid: progress.workerPid } : {}),
      ...(typeof (manifest?.toolErrors ?? progress?.toolErrors) === 'number'
        ? { toolErrors: manifest?.toolErrors ?? progress?.toolErrors } : {}),
      ...(manifest?.failedEarly === true ? { failedEarly: true } : {}),
      ...(manifest?.changedFilesUnknown === true ? { changedFilesUnknown: true } : {}),
      ...(manifest?.cwdMissingAtFinish === true ? { cwdMissingAtFinish: true } : {}),
      [SMITH_PAYLOAD.recentActivities]: progress?.recentActivities ?? [],
      [SMITH_PAYLOAD.lastActivity]: progress?.lastActivity ?? null,
      [SMITH_PAYLOAD.latestText]: progress?.latestText ?? null,
      [SMITH_PAYLOAD.progressWarnings]: progress?.warnings ?? [],
      ...(progress?.digest !== undefined ? { digest: progress.digest } : {}),
      ...(manifest?.supersededBy !== undefined ? { supersededBy: manifest.supersededBy } : {}),
      ...(typeof manifest?.followedBy === 'string' && manifest.followedBy !== '' ? { followedBy: manifest.followedBy } : {}),
      ...(continuedFrom !== undefined ? { continuedFrom } : {}),
      ...(continuationKind !== undefined ? { continuationKind } : {}),
      ...(chainStartedAt !== undefined ? { chainStartedAt } : {}),
      ...(typeof (progress?.pendingSteers ?? manifest?.pendingSteers) === 'number'
        ? { pendingSteers: progress?.pendingSteers ?? manifest?.pendingSteers }
        : {}),
      ...(Array.isArray(manifest?.staleReads) && manifest.staleReads.length > 0
        ? { staleReads: manifest.staleReads }
        : {}),
      ...(team !== null ? { team } : {}),
    };

    return {
      provider: this.provider,
      jobId,
      cwd: manifest?.cwd ?? cwd,
      payload,
      partial: manifest === null,
    };
  }
}
