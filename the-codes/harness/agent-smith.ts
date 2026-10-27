/**
 * agent-smith.ts — reads OUR OWN job state from `<repo>/.agent-smith/jobs/`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE PRIMARY READER. WHY IT EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Until now the only reader in this layer read somebody else's directory.
 * harness/agy-staff.ts is a re-implementation of a layout nobody in this repo
 * writes any more, kept because the 20 real jobs under
 * /Users/gathrid/Repos/renyi/.agy-staff/jobs are the corpus the hazard rules
 * were verified against and because any future worker that writes that layout
 * should be picked up for free.
 *
 * It is now an INTEROP reader. This one is the source of truth, and
 * registry.ts holds both:
 *
 *     "agent-smith"   PRIMARY.   Every job this repo spawned.
 *     "agy-staff"     INTEROP.   Read-only history from another harness.
 *
 * The two are kept strictly apart — see the last section, which is the one rule
 * this file has to enforce.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE IS NOT MUCH CODE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Because forge/format.ts made it not much code. That is the point of owning the
 * state format. Compare with agy-staff.ts, which needs three documented hazards
 * and a seven-suffix fallback chain to answer the same three questions:
 *
 *   - Does this job exist?        → the directory exists and holds a job.json.
 *   - What is its terminal state? → job.json.status. Written atomically, always.
 *   - Is it alive?                → job.json.updatedAt, refreshed on every event.
 *
 * agy-staff's equivalents are all "which of these seven files, some of which are
 * deleted on success, do I read, and in what order". We traded that for a
 * directory, an atomic rewrite, and the refusal to ever delete the anchor.
 *
 * The one hazard we DID keep is the cancel marker, and it is the same hazard:
 * `cancel` can exist before job.json reaches a terminal state, so it outranks it.
 */

import { existsSafe, readJsonSafe, readTextSafe, readdirSafe } from './safe-fs.ts';
import {
  FILES,
  SCHEMA_VERSION,
  CANCEL_ORPHAN_REASON,
  ORPHAN_REASON,
  deriveOrphan,
  ownerAlive,
  jobFile,
  jobsDir,
  type ForgeManifest,
} from '../forge/format.ts';
import type { JobStateReader, RawJobState } from './types.ts';

/**
 * payload keys the normalizer relies on. Cross-referenced by name from
 * harness/normalize.ts's `smithNormalizer`.
 */
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
const ORPHANED = { status: 'failed', suspicious: true, reason: ORPHAN_REASON } as const;

/**
 * Reads `.agent-smith/jobs`.
 *
 * Every method is fault-tolerant in the same way and for the same reason as
 * agy-staff.ts: a reader reads files a live process is rewriting, and one
 * unreadable job is that job's absence rather than a dead band. `discover`
 * NEVER throws; an absent jobs directory is the ordinary case for a repo that
 * has never spawned anything, not an error.
 */
export class AgentSmithReader implements JobStateReader {
  readonly provider = 'agent-smith';

  /**
   * Enumerate job ids from the jobs directory.
   *
   * Keyed on the DIRECTORY, which is the whole reason this is simpler than the
   * interop reader: there is no suffix to parse, no "which file proves this job
   * exists", and no entry that can half-qualify. A job's identity is its
   * directory, so identity cannot be lost.
   */
  async discover(cwd: string): Promise<string[]> {
    const entries = await readdirSafe(jobsDir(cwd));
    const ids = new Set<string>();
    for (const entry of entries) {
      // `readdirSafe` returns names only; a name that is not a directory will
      // simply fail the job.json read below and contribute nothing. We do not
      // stat here because a stat per entry is a syscall per entry on a path the
      // band hits every three seconds.
      if (!entry.startsWith('.')) ids.add(entry);
    }
    return [...ids].sort();
  }

  /**
   * Assemble one snapshot.
   *
   * Returns null when the job does not exist to this reader — i.e. no directory
   * and no job.json. A FINISHED job returns a full snapshot: job.json is never
   * deleted, which is the whole reason the format has a single anchor.
   */
  async read(cwd: string, jobId: string): Promise<RawJobState | null> {
    // The cancel marker outranks job.json (same hazard as agy-staff's B: the
    // marker can exist before the worker has been reaped).
    const cancelPath = jobFile(cwd, jobId, FILES.cancel);
    const cancelRequested = await existsSafe(cancelPath);
    let cancelAt: string | null = null;
    if (cancelRequested) {
      const raw = await readTextSafe(cancelPath);
      const t = raw?.trim();
      cancelAt = t !== undefined && t !== '' ? t : null;
    }

    const manifest = await readJsonSafe<ForgeManifest>(jobFile(cwd, jobId, FILES.job));
    // A marker is a request. The owner may still be working or may finish
    // successfully before it can stop; only terminal canceled state is proof.
    const canceled = manifest === null ? cancelRequested : manifest.status === 'canceled';

    // A manifest from a NEWER writer is refused rather than half-understood.
    // Reading a v2 file with v1 rules produces exactly the confident wrong
    // answers this project exists to prevent, and `unknown` is the honest state.
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

    // "Does this job exist?" is asked LAST, and includes the marker: a job
    // whose only surviving artefact is its cancel request is still a job.
    //
    // Note what is NOT consulted: the bare existence of the directory. A
    // half-created directory (crash between mkdir and the first write) and a
    // stray directory a human dropped in here are both indistinguishable from a
    // job by `stat`, and a band that draws "unknown" for a stray folder is
    // indistinguishable from one that lies. We require evidence of a job.
    const anyEvidence = manifest !== null || canceled || report !== null;
    if (!anyEvidence) return null;

    // Orphan derivation (forge/format.ts deriveOrphan): a `running` anchor with
    // no terminal result whose supervisor is gone. Derived, never written into
    // job.json. Only the service reconciler persists the verdict; this reader
    // is read-only, including when used by notifications and validation.
    let orphan: ReturnType<typeof deriveOrphan> = null;
    if (manifest !== null && manifest.status === 'running' && !canceled
        && !(await existsSafe(jobFile(cwd, jobId, FILES.result)))) {
      const markerPath = jobFile(cwd, jobId, FILES.orphaned);
      const lastSeen = Math.max(
        Date.parse(manifest.updatedAt), Date.parse(progress?.lastEventAt ?? ''),
      );
      orphan = deriveOrphan(manifest, Number.isFinite(lastSeen) ? lastSeen : null, Date.now(), undefined, cancelRequested);
      // A live supervisor honours a cancel request within seconds. A request that
      // is a minute old and still has no terminal state means nobody is listening.
      const cancelAgeMs = cancelAt === null ? NaN : Date.now() - Date.parse(cancelAt);
      const ownerIsAlive = ownerAlive(manifest);
      if (orphan === null && cancelRequested && cancelAgeMs > 60_000 && !ownerIsAlive) orphan = CANCELED_ORPHAN;
      // The marker is proof the supervisor is gone; a cancel request makes that
      // a cancellation. A live pid beside a marker plus cancel is still in flight.
      if (orphan === null && (await existsSafe(markerPath))) {
        orphan = !cancelRequested ? ORPHANED : ownerIsAlive ? null : CANCELED_ORPHAN;
      }

    }

    const payload: Record<string, unknown> = {
      [SMITH_PAYLOAD.schema]: manifest?.schema ?? null,
      [SMITH_PAYLOAD.provider]: manifest?.provider ?? null,
      name: manifest?.name ?? null,
      workerId: manifest?.workerId ?? jobId,
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
      [SMITH_PAYLOAD.deniedActions]: manifest?.deniedActions ?? [],
      [SMITH_PAYLOAD.usage]: manifest?.usage ?? null,
      ...(Array.isArray(manifest?.changedFiles) && manifest.changedFilesTruncated !== true
        ? { changed_files: manifest.changedFiles } : {}),
      // No progress.json and no manifest count is unknown, not zero: a job that
      // wrote nothing must not claim it made no tool calls.
      [SMITH_PAYLOAD.toolCalls]: progress?.toolCalls ?? manifest?.toolCalls ?? null,
      [SMITH_PAYLOAD.pipeline]: manifest?.pipeline ?? null,
      [SMITH_PAYLOAD.stage]: manifest?.stage ?? null,
      [SMITH_PAYLOAD.attempt]: manifest?.attempt ?? null,
      [SMITH_PAYLOAD.output]: report,
      [SMITH_PAYLOAD.canceled]: canceled,
      [SMITH_PAYLOAD.cancelAt]: cancelAt,
      [SMITH_PAYLOAD.lastEventAt]: progress?.lastEventAt ?? manifest?.updatedAt ?? null,
      // The process owner's heartbeat (providers/ndjson.ts). Absent for jobs
      // written by older builds: liveness then falls back to event silence.
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
      ...(manifest?.steeredFrom !== undefined ? { steeredFrom: manifest.steeredFrom } : {}),
      ...(typeof (progress?.pendingSteers ?? manifest?.pendingSteers) === 'number'
        ? { pendingSteers: progress?.pendingSteers ?? manifest?.pendingSteers }
        : {}),
      ...(Array.isArray(manifest?.staleReads) && manifest.staleReads.length > 0
        ? { staleReads: manifest.staleReads }
        : {}),
    };

    // partial=true when the anchor is missing: something is on disk for this
    // job but we could not read the file that says what state it is in. The
    // normalizer biases toward `unknown` over a guess, and `unknown` must never
    // be collapsed into `running`.
    return {
      provider: this.provider,
      jobId,
      cwd: manifest?.cwd ?? cwd,
      payload,
      partial: manifest === null,
    };
  }
}

/*
 * THE ONE RULE ABOUT THE COMPAT MIRROR: forge/mirror.ts projects our jobs into
 * `.agy-staff/jobs/` so an unmodified mod can render them. This reader never
 * reads that projection, and `AgyStaffReader` callers skip forge ids
 * (`isForgeJobId`). Otherwise every spawned job would get two independently
 * computed verdicts in a single sweep.
 */
