/**
 * service.ts — the composition root that can START a worker.
 *
 * It wires providers/ (adapters) and pipeline/ (StageRunner) to the job
 * directory (forge/format.ts, writer.ts), and answers four questions: spawn a job, list
 * them, describe one, cancel one. `surfaces/channel` exposes exactly these as
 * MCP tools; nothing else in the repo may call a provider directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY spawn_job RETURNS IN UNDER A MILLISECOND
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A reference job in the corpus took 28 minutes. A tool call that waits for it
 * would time out, and a tool call that blocks the MCP server would stop the
 * channel from pushing anything at all for the duration — so a 28-minute job
 * would also blind the surface that exists to report it.
 *
 * So `spawnJob` does exactly three things synchronously: validate the request,
 * write the anchor (forge/writer.ts `start`), and hand the rest to a detached
 * async pump. The job id comes back and the job exists on disk before the caller
 * has finished reading the response. The 20 real jobs took 16.3 hours at a
 * concurrency of 3; a spawn path that holds the caller is that failure again.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY: --dangerously-skip-permissions IS OFF BY DEFAULT (EXCEPT FOR agy AND kimi)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `SpawnSpec.unrestricted` is a required field and this module defaults it to
 * `false`. It has to: a provider that can prompt must not bypass prompts by
 * default. agy and kimi cannot prompt headless: agy's restricted mode silently
 * denies tools and reports success with an empty response (verified live — see
 * providers/agy.ts, THE TRAP), so it defaults to unrestricted with an env
 * opt-out. kimi's print mode force-sets the auto policy and has no restricted
 * mode, so it is always unrestricted. `job.json` records the effective posture,
 * not a request that had no effect; everything else is opt-in per call.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A CLI
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It was going to be. The arguments against, which are the only ones that matter
 * here: this product is driven FROM WITHIN a harness, not from a terminal. A
 * `agent-smith run` binary would be a second way to do the same job as the MCP
 * tool, and a user driving agent-smith from Claude Code has a shell already —
 * it has Claude. Everything below is a plain function so it can be called from a
 * tool handler, a test, or a future entrypoint, and there is exactly one
 * implementation.
 */

import { pipelineRecordPath, readPipeline } from './execute.ts';
import { launchJob } from './supervisor.ts';
import { humanDuration } from '../providers/failure-text.ts';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { AgentSmithReader, SMITH_PAYLOAD } from '../harness/agent-smith.ts';
import { AgyStaffReader } from '../harness/agy-staff.ts';
import { readObservedJob } from '../harness/registry.ts';
import type { JobStateReader, ObservedJob } from '../harness/types.ts';
import { getCatalogs, getHarnessDefaults } from '../providers/catalog.ts';
import type {
  JobResult,
  ModelCatalog,
  Provider,
  SandboxInfo,
  SpawnSpec,
  WorkerHandle,
} from '../providers/types.js';
import { isMode, MODE_PRESETS, type ModePreset } from './modes.ts';
import { buildBrief } from './brief.ts';
import {
  DEFAULT_TIMEOUT_MS,
  deriveStatus,
  FILES,
  isForgeJobId,
  isForgeStatus,
  jobDir,
  jobFile,
  jobsDir,
  newJobId,
  ownerAlive,
  readManifest,
  type ForgeActivity,
  type ForgeManifest,
  type ForgeStatus,
  type SteerEntry,
  type WatchedFileSigs,
} from './format.ts';
import { reconcileOrphan } from './reconcile.ts';
import { computeStaleReads, JobWriter, pipeEvents, reportFor } from './writer.ts';
import { writeAtomic, writeJsonAtomic } from './atomic.ts';
import { readAcceptance, type Acceptance } from './checks.ts';
import {
  checkAgainstCatalog, clampTimeout, modeError, requireProvider, turnStartInput,
  type SpawnAck, type SpawnRequest, type SteerAck, type SteerRequest, type TrackedSpawn, type TurnSpec,
} from './spawn-request.ts';
import { toSummary, type JobDetail, type JobSummary, type ListFilter } from './summary.ts';
import { appendSteerEntry, buildSteeredPrompt, readSteerEntries, readSteerHead } from './steer-log.ts';
import { syncWatchedFiles, validateWatchedFiles } from './watched-files.ts';

// The types and constants other packages import from here. Their homes are the
// modules above; this is the one place that keeps the old import path working.
export type { JobDetail, JobSummary, ListFilter, SpawnAck, SpawnRequest, SteerAck, SteerRequest, TrackedSpawn };
export { MAX_WATCHED_FILES } from './watched-files.ts';

/**
 * Default wall-clock budget for one job.
 *
 * 45 minutes, not 30, because the longest job in the real corpus took 28 and a
 * timeout that fires at minute 29 destroys an hour of work. Not 120, because a
 * run with no budget at all is indistinguishable from a hang and the caller has
 * no other lever — `cancel` is the operator's, and an operator who is not there
 * to press it should not be the reason a job runs for six hours.
 */
export { DEFAULT_TIMEOUT_MS };

export interface CancelResult {
  /** The chain head that was asked to stop (the given id when it was already the head). */
  readonly jobId: string;
  /**
   * The superseded parent id the caller passed, when it differs from `jobId`.
   * Absent when the given id was already the head.
   */
  readonly resolvedFrom?: string;
  readonly requested: boolean;
  /** True when a live worker in THIS process was actually signalled. */
  readonly signalled: boolean;
  readonly note: string;
}

interface LiveJob {
  writer: JobWriter;
  handle: WorkerHandle | null;
  timeoutMs: number;
  consumedSteers: number;
  interruptRequested: boolean;
  interruptFired: boolean;
  userCanceled: boolean;
}

function newLiveJob(writer: JobWriter, timeoutMs: number): LiveJob {
  return {
    writer,
    handle: null,
    timeoutMs,
    consumedSteers: 0,
    interruptRequested: false,
    interruptFired: false,
    userCanceled: false,
  };
}

const STEER_CONVERSATION_WAIT_MS = 2_000;

/** A worker name that no job answers to, or that more than one worker does. */
export class WorkerLookupError extends Error {
  readonly kind: 'missing' | 'ambiguous';
  /** The job ids that matched, for an ambiguous name. */
  readonly jobIds: readonly string[];
  constructor(message: string, kind: 'missing' | 'ambiguous', jobIds: readonly string[] = []) {
    super(message);
    this.name = 'WorkerLookupError';
    this.kind = kind;
    this.jobIds = jobIds;
  }
}

export interface ForgeOptions {
  /** Packaged execution entrypoint; omitted inside a supervisor and in unit tests. */
  readonly supervisorUrl?: URL;
  /** Repo whose `.agent-smith/jobs/` this service owns. */
  readonly repo: string;
  /** Write the agy-staff-shaped compat mirror. Default true. */
  readonly mirror?: boolean | undefined;
  /** Progress coalescing window, ms. Overridable so tests need not sleep. */
  readonly flushMs?: number | undefined;
  /** Model catalog source. Default: providers/catalog.ts getCatalogs. Injectable for tests. */
  readonly catalogSource?: ((providers: string[]) => Promise<ModelCatalog[]>) | undefined;
  /** Provider config-file defaults (sync, no CLI). Default: providers/catalog.ts getHarnessDefaults. Injectable for tests. */
  readonly harnessDefaults?: ((provider: string) => { model?: string; effort?: string }) | undefined;
  /** Provider lookup. Default: requireProvider. Injectable for tests. */
  readonly providerSource?: ((name: string) => Provider) | undefined;
  /** Sandbox describer. Default: provider.describeSandbox. Injectable for tests. */
  readonly describeSandbox?:
    | ((provider: Provider, spec: Pick<SpawnSpec, 'unrestricted' | 'readOnly' | 'artifactPath'>) => SandboxInfo | undefined)
    | undefined;
}

const CATALOG_WAIT_MS = 2_000;
/**
 * The forge. One instance per process; the live-handle map is per instance.
 *
 * The map is bounded by the number of jobs this process started, and it is
 * deliberately NOT the source of truth — job.json is. A restart of this server
 * loses the ability to `kill()` an in-flight worker, and that is stated in the
 * cancel result rather than papered over: an honest "I marked it cancelled but
 * there is no handle here to signal" beats a `signalled: true` that never
 * happened. Service reads recover jobs whose recorded supervisor has died,
 * provided no terminal result is already present. PID-less legacy jobs remain
 * read-only observations because the service cannot prove their writer died.
 */
export class ForgeService {
  readonly repo: string;
  readonly supervisorUrl?: URL;
  private readonly live = new Map<string, LiveJob>();
  /** Job IDs spawned by this process, for `list_jobs session`. */
  readonly spawnedIds = new Set<string>();
  readonly spawnedRuns = new Set<string>();
  private readonly mirrorOn: boolean;
  private readonly flushMs: number | undefined;
  private readonly catalogSource: (providers: string[]) => Promise<ModelCatalog[]>;
  private readonly harnessDefaults: (provider: string) => { model?: string; effort?: string };
  private readonly providerSource: (name: string) => Provider;
  private readonly describeSandbox: NonNullable<ForgeOptions['describeSandbox']>;

  constructor(options: ForgeOptions) {
    this.repo = options.repo;
    this.supervisorUrl = options.supervisorUrl;
    this.mirrorOn = options.mirror ?? true;
    this.flushMs = options.flushMs;
    this.providerSource = options.providerSource ?? requireProvider;
    this.catalogSource = options.catalogSource ?? ((providers) => getCatalogs({ providers }));
    this.harnessDefaults = options.harnessDefaults ?? getHarnessDefaults;
    this.describeSandbox = options.describeSandbox ?? ((p, spec) => p.describeSandbox?.(spec));
    // Publish abandoned-job recovery when the owner service starts, so the
    // read-only pane agrees before an operator makes its first MCP status call.
    try {
      for (const entry of readdirSync(jobsDir(this.repo), { withFileTypes: true })) {
        if (entry.isDirectory()) reconcileOrphan(this.repo, entry.name);
      }
    } catch { /* A missing job store is the ordinary fresh-repo case. */ }
  }

  /** One writer per job, configured like every other writer this service makes. */
  private newWriter(jobId: string): JobWriter {
    return new JobWriter({
      repo: this.repo,
      jobId,
      mirror: this.mirrorOn,
      ...(this.flushMs === undefined ? {} : { flushMs: this.flushMs }),
    });
  }

  /** A worker is one running job at a time: refuse a name or identity that is already busy, on disk or live here. */
  private assertNameFree(name: string, workerId: string): void {
    const busy = (jobId: string): Error =>
      new Error(`"${name}" is busy (${jobId}); wait, cancel, or use another name.`);
    const canonicalConflict = findActiveIdentity(this.repo, name, workerId);
    if (canonicalConflict !== null) throw busy(canonicalConflict.jobId);
    for (const { writer } of this.live.values()) {
      const active = writer.snapshot();
      if (active !== null && (active.workerId === workerId || active.name === name)) throw busy(active.jobId);
    }
  }

  /** Never throws, never waits long: a catalog is advice, not a gate on starting. */
  private async catalogFor(provider: string): Promise<ModelCatalog | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), CATALOG_WAIT_MS);
        timer.unref?.();
      });
      const all = await Promise.race([this.catalogSource([provider]), timeout]);
      return all?.find((c) => c.provider === provider) ?? all?.[0];
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Start one job. Returns as soon as the anchor is on disk.
   *
   * Rejects only for a bad REQUEST (unknown provider, empty prompt). Everything
   * that can go wrong afterwards — binary missing, auth expired, tool denied,
   * killed by the OS — arrives as a `failed` job, because a rejected promise has
   * no job id and therefore nothing a pane can ever draw.
   */
  async spawnJob(request: SpawnRequest): Promise<SpawnAck> {
    const { ack } = await this.spawnTracked(request);
    return ack;
  }

  /**
   * spawnJob, plus the terminal manifest promise.
   *
   * Split out for exactly one caller — forge/runner.ts, which runs a pipeline
   * stage and must wait for it. Everything else wants the ack and the channel.
   */
  async spawnTracked(request: SpawnRequest): Promise<TrackedSpawn> {
    if (this.supervisorUrl) return launchJob(this, request);
    const provider = this.providerSource(request.provider ?? 'agy');
    const rawMode = request.mode.trim();
    const resuming = request.conversation !== undefined && request.conversation !== null;
    // Closed set for fresh, non-pipeline spawns. Pipeline stages keep arbitrary
    // roles; a resume may carry a legacy mode from an older job.
    if (request.pipeline == null && !resuming && !isMode(rawMode)) throw modeError(rawMode);
    const mode = rawMode === '' ? 'task' : rawMode;
    const preset: ModePreset | undefined = isMode(mode) ? MODE_PRESETS[mode] : undefined;
    const prompt = request.prompt;
    if (prompt.trim() === '') {
      throw new Error('prompt is empty; there is nothing to hand the worker.');
    }
    const timeoutMs = clampTimeout(request.timeoutMs);
    const cwd = request.cwd ?? this.repo;
    // agy and kimi cannot prompt headless. agy has an env opt-out; kimi's print
    // mode force-sets the auto policy and has no restricted mode, so the
    // EFFECTIVE posture is always unrestricted. Record that, not the request,
    // and warn when the two differ so the durable job is not a lie.
    const unrestrictedRequested = request.unrestricted;
    const unrestricted = provider.name === 'kimi'
      ? true
      : unrestrictedRequested ?? (
          provider.name === 'agy' && process.env['AGENT_SMITH_AGY_RESTRICTED'] !== '1'
        );
    const warnings: string[] = [];
    if (unrestrictedRequested === false && provider.name === 'kimi') {
      warnings.push(
        'kimi print mode force-sets the auto permission policy; unrestricted:false cannot restrict it. The ack and job.json record the effective posture.',
      );
    }
    // A provider that cannot apply a per-run effort must not have one recorded
    // as applied. Drop it at the service boundary (so job.json is truthful) and
    // tell the caller; the adapter also emits an event for direct users.
    const effort = provider.supportsEffort === false ? undefined : request.effort;
    if (request.effort !== undefined && provider.supportsEffort === false) {
      warnings.push(
        `kimi has no per-run effort flag; effort "${request.effort}" was ignored. Set [thinking].effort or a model alias default_effort in config.toml.`,
      );
    }
    if (request.model !== undefined || effort !== undefined) {
      warnings.push(
        ...checkAgainstCatalog(provider.name, request.model, effort, await this.catalogFor(provider.name)),
      );
    }
    let modelResolved: string | null = request.model ?? null;
    let modelSource: SpawnAck['modelSource'] = request.model === undefined ? 'unknown' : 'requested';
    if (request.model === undefined) {
      // Config-file read only: no CLI, so spawn stays instant (see server.ts no-long-call rule).
      const configured = this.harnessDefaults(provider.name).model;
      if (configured) {
        modelResolved = configured;
        modelSource = 'harness-config';
      }
    }
    const readOnlyRequested = preset?.readOnly === true && !unrestricted;
    const artifactPath = readOnlyRequested ? request.artifactPath : undefined;
    const sandboxInfo = this.describeSandbox(provider, {
      unrestricted,
      readOnly: readOnlyRequested,
      ...(artifactPath === undefined ? {} : { artifactPath }),
    });
    const sandbox = sandboxInfo?.sandbox ?? 'unknown';
    const sandboxFlags = sandboxInfo?.flags ?? [];
    const readOnlyEnforced = sandboxInfo?.readOnlyEnforced ?? false;
    if (provider.name === 'agy' && preset?.runsCommands === true && !unrestricted) {
      warnings.push(
        'agy cannot prompt for permission headless; commands will be denied and the job will return an empty result. Retry with unrestricted:true if this job needs shell access.',
      );
    }
    const brief = buildBrief({
      preset,
      cwd,
      context: request.context,
      checks: request.checks,
      pipelineStage: request.pipeline !== undefined && request.pipeline !== null,
      resuming,
    });
    // A caller that already starts its prompt with the brief gets it once, not twice.
    const prependBrief = brief !== '' && !prompt.startsWith(brief);
    const preambleApplied = brief !== '';
    const sentPrompt = prependBrief ? `${brief}\n\n${prompt}` : prompt;
    const jobId = newJobId(mode);
    const name = request.name?.trim() || `${mode}-${jobId.slice(-8)}`;
    if (name.length > 80) throw new Error('worker name must be at most 80 characters');
    const workerId = request.workerId ?? jobId;
    this.assertNameFree(name, workerId);

    const writer = this.newWriter(jobId);

    const requestedFiles =
      request.files !== undefined && request.previousWatchedFiles !== undefined
        ? request.files.filter((f) => {
            if (!(f in request.previousWatchedFiles!) || existsSync(path.resolve(this.repo, f))) return true;
            warnings.push(`dropped deleted watched file "${f}" from previous turn`);
            return false;
          })
        : request.files;
    const watchedFiles =
      requestedFiles !== undefined && requestedFiles.length > 0
        ? syncWatchedFiles(this.repo, cwd, requestedFiles, request.previousWatchedFiles, (w) => warnings.push(w))
        : undefined;

    const spec: TurnSpec = {
      jobId,
      name,
      workerId,
      task: request.task,
      mode,
      preset,
      context: request.context,
      checks: request.checks,
      prompt: sentPrompt,
      readOnlyRequested,
      readOnlyEnforced,
      sandbox,
      sandboxFlags: [...sandboxFlags],
      artifactPath,
      cwd,
      model: request.model,
      modelRequested: request.model ?? null,
      modelResolved,
      modelSource,
      effort,
      timeoutMs,
      unrestricted,
      conversation: request.conversation,
      pipeline: request.pipeline ?? null,
      stage: request.stage ?? null,
      attempt: request.attempt ?? null,
      onPrepared: request.onPrepared,
    };

    // Anchor first. Everything after this point can fail loudly; nothing after
    // this point can make the job invisible.
    writer.start(turnStartInput(provider.name, spec, {
      prompt,
      // Exactly what was prepended, so the /forge pane's "Show preamble" matches what the worker read.
      preamble: prependBrief ? brief : undefined,
      preambleApplied,
      conversation: request.conversation ?? null,
      task: request.task,
      watchedFiles,
    }));
    try {
      if (request.checks !== undefined) writeJsonAtomic(jobFile(this.repo, jobId, FILES.checksSpec), request.checks);
      await request.onPrepared?.(jobId);
    } catch (error) {
      writer.abort('failed', `setup failed · ${String(error)}`);
      throw error;
    }
    this.spawnedIds.add(jobId);

    const ack: SpawnAck = {
      jobId,
      name,
      workerId,
      role: mode,
      provider: provider.name,
      status: 'running',
      dir: jobDir(this.repo, jobId),
      repo: this.repo,
      timeoutMs,
      unrestricted,
      note:
        `queued · ${humanDuration(timeoutMs)} limit · ${
          provider.name === 'kimi' ? 'auto policy (cannot restrict)' : unrestricted ? 'unrestricted' : 'approvals on'
        }`,
      sandbox,
      sandboxFlags,
      readOnlyRequested,
      readOnlyEnforced,
      modelRequested: request.model ?? null,
      modelResolved,
      modelSource,
      preambleApplied,
      ...(warnings.length === 0 ? {} : { warnings }),
    };

    const done = this.pump(writer, provider, spec);

    return { ack, done };
  }

  /**
   * The detached pump: spawn, stream, record, chain steered turns, resolve.
   *
   * Never rejects. Every exit path lands on writer.finish() or writer.abort(),
   * because a job that stops being `running` is the only promise this function
   * makes to every reader on the other side of the filesystem. When a steer is
   * queued or interrupts the turn, this loop is the sole owner that opens the
   * child anchor and marks the parent superseded.
   */
  private async pump(
    initialWriter: JobWriter,
    provider: Provider,
    spec: TurnSpec,
  ): Promise<ForgeManifest> {
    let currentWriter = initialWriter;
    let currentJobId = spec.jobId;
    let currentPrompt = spec.prompt;
    let currentConversation = spec.conversation;
    let liveEntry = newLiveJob(currentWriter, spec.timeoutMs);
    // Register synchronously before the first await so a steer or cancel arriving
    // right after spawn_job finds the live entry in this.live.
    this.live.set(currentJobId, liveEntry);

    while (true) {
      let handle: WorkerHandle;
      try {
        handle = await provider.spawn({
          mode: currentJobId,
          prompt: currentPrompt,
          cwd: spec.cwd,
          timeoutMs: spec.timeoutMs,
          unrestricted: spec.unrestricted,
          ...(spec.readOnlyRequested ? { readOnly: true } : {}),
          ...(spec.artifactPath === undefined ? {} : { artifactPath: spec.artifactPath }),
          ...(spec.model === undefined ? {} : { model: spec.model }),
          ...(spec.effort === undefined ? {} : { effort: spec.effort }),
          ...(currentConversation === undefined ? {} : { conversation: currentConversation }),
          // THE KEY LINE. Handing the provider adapter OUR job directory as its
          // stateDir means events.jsonl / argv.json / stderr.log / result.json are
          // written by the already-verified plumbing in providers/ndjson.ts, for
          // all four providers, instead of being copied across afterwards by us.
          stateDir: jobDir(this.repo, currentJobId),
          jobId: currentJobId,
        });
      } catch (err) {
        this.live.delete(currentJobId);
        return (
          currentWriter.abort('failed', `couldn't start · ${describe(err)}`) ??
          currentWriter.snapshot() ??
          ({ jobId: currentJobId } as unknown as ForgeManifest)
        );
      }

      liveEntry.handle = handle;
      const unsubscribe = pipeEvents(currentWriter, handle);

      let interruptDetectedAt: number | null = null;
      let lastPendingSteers = 0;
      let pollWarned = false;

      const syncSteerAndCancel = (): void => {
        if (existsSync(jobFile(this.repo, currentJobId, FILES.cancel))) {
          liveEntry.userCanceled = true;
        }
        if (liveEntry.userCanceled) {
          currentWriter.requestCancel();
          handle.cancel();
          return;
        }
        const entries = readSteerEntries(this.repo, currentJobId);
        const unconsumed = entries.slice(liveEntry.consumedSteers);
        if (unconsumed.length !== lastPendingSteers) {
          lastPendingSteers = unconsumed.length;
          currentWriter.setPendingSteers(unconsumed.length);
        }
        if (unconsumed.some((e) => e.delivery === 'interrupt') || existsSync(jobFile(this.repo, currentJobId, FILES.cancelSteer))) {
          liveEntry.interruptRequested = true;
        }
        if (liveEntry.interruptRequested && !liveEntry.interruptFired) {
          if (interruptDetectedAt === null) interruptDetectedAt = Date.now();
          const hasConversation = currentWriter.currentConversation() !== null;
          const waitElapsed = Date.now() - interruptDetectedAt >= STEER_CONVERSATION_WAIT_MS;
          if (hasConversation || waitElapsed) {
            liveEntry.interruptFired = true;
            handle.cancel();
          }
        }
      };
      // A poll or an event tap must not be able to reject the pump: a disk error
      // in setPendingSteers is a warning, not the end of the worker.
      const safeSyncSteerAndCancel = (): void => {
        try { syncSteerAndCancel(); }
        catch (err) {
          if (!pollWarned) {
            pollWarned = true;
            process.stderr.write(`agent-smith steer poll ${currentJobId}: ${describe(err)}\n`);
          }
        }
      };

      const unsubSteerTap = handle.onEvent((ev) => {
        if (ev.kind === 'started' && liveEntry.interruptRequested && !liveEntry.interruptFired) {
          safeSyncSteerAndCancel();
        }
      });

      safeSyncSteerAndCancel();
      const cancelPoll = setInterval(safeSyncSteerAndCancel, 100);
      cancelPoll.unref?.();

      try {
        const result: JobResult = await handle.waitForResult();
        clearInterval(cancelPoll);
        unsubSteerTap();
        unsubscribe();

        await currentWriter.prepareFinish();
        const report = reportFor(result);

        safeSyncSteerAndCancel();
        const entries = readSteerEntries(this.repo, currentJobId);
        const unconsumed = entries.slice(liveEntry.consumedSteers);
        const alreadyTerminal: ForgeStatus | null = result.status === 'cancelled' ? 'canceled' : null;
        const verdict = deriveStatus({
          alreadyTerminal,
          ok: result.ok,
          jobStatus: result.status,
          deniedActions: result.deniedActions ?? [],
          report: report === '' ? null : report,
        });

        const shouldChain =
          !liveEntry.userCanceled &&
          unconsumed.length > 0 &&
          (liveEntry.interruptRequested || verdict.status === 'succeeded');

        if (!shouldChain && !liveEntry.userCanceled && unconsumed.length > 0) {
          const count = unconsumed.length;
          currentWriter.warn(
            `${count} queued steer${count === 1 ? '' : 's'} not applied: the turn ended ${verdict.status}. ` +
            'Use resume_job or steer_job again.',
          );
        }

        if (shouldChain) {
          const next = await this.chainContinuation({
            provider, spec, parent: { writer: currentWriter, jobId: currentJobId, live: liveEntry },
            result, report, entries, unconsumed, verdictStatus: verdict.status,
          });
          currentWriter = next.writer;
          currentJobId = next.jobId;
          currentPrompt = next.prompt;
          currentConversation = next.conversation;
          liveEntry = next.live;
          continue;
        }

        const manifest = currentWriter.finish(result, report === '' ? null : report);
        this.live.delete(currentJobId);
        return manifest;
      } catch (err) {
        clearInterval(cancelPoll);
        unsubSteerTap();
        unsubscribe();
        this.live.delete(currentJobId);
        return (
          currentWriter.abort('failed', `crashed · ${describe(err)}`) ??
          currentWriter.snapshot() ??
          ({ jobId: currentJobId } as unknown as ForgeManifest)
        );
      }
    }
  }

  /**
   * Open the child turn of a steered chain and hand the job over to it.
   *
   * The order is the contract readers rely on: the child anchor is on disk
   * before the parent is finished, so anyone following `supersededBy` or
   * `steer.head` always finds a real job.
   */
  private async chainContinuation(input: {
    readonly provider: Provider;
    readonly spec: TurnSpec;
    readonly parent: { readonly writer: JobWriter; readonly jobId: string; readonly live: LiveJob };
    readonly result: JobResult;
    readonly report: string;
    /** Every steer entry the parent has seen, and the ones not yet delivered. */
    readonly entries: readonly SteerEntry[];
    readonly unconsumed: readonly SteerEntry[];
    readonly verdictStatus: ForgeStatus;
  }): Promise<{ writer: JobWriter; jobId: string; live: LiveJob; prompt: string; conversation: string | undefined }> {
    const { provider, spec, parent, result, report, entries, unconsumed, verdictStatus } = input;
    const conversation = parent.writer.currentConversation();
    const wasInterrupted = parent.live.interruptRequested && verdictStatus !== 'succeeded';
    if (conversation === null && !wasInterrupted) {
      parent.writer.warn('provider did not report a resumable conversation ID; continuing in a fresh session');
    }
    parent.live.consumedSteers = entries.length;
    try {
      unlinkSync(jobFile(this.repo, parent.jobId, FILES.cancelSteer));
    } catch { /* no steer marker present */ }
    const nextJobId = newJobId(spec.mode);
    const nextWriter = this.newWriter(nextJobId);
    const latestContext = [...unconsumed].reverse().find((e) => e.context !== undefined)?.context ?? spec.context;
    const resuming = conversation !== null;
    const parentWatched = parent.writer.snapshot()?.watchedFiles;
    const explicitSteerFiles = new Set(unconsumed.flatMap((e) => e.files ?? []));
    const inheritedWatchedPaths = Object.keys(parentWatched ?? {}).filter((f) => {
      if (existsSync(path.resolve(this.repo, f))) return true;
      parent.writer.warn(`dropped deleted watched file "${f}" from continuation turn`);
      return false;
    });
    const mergedWatchedPaths = [
      ...new Set([
        ...inheritedWatchedPaths,
        ...explicitSteerFiles,
      ]),
    ];
    let nextWatchedFiles: Record<string, WatchedFileSigs> | undefined;
    const syncedFiles: string[] = [];
    const syncWarnings: string[] = [];
    if (mergedWatchedPaths.length > 0) {
      try {
        nextWatchedFiles = syncWatchedFiles(
          this.repo,
          spec.cwd,
          mergedWatchedPaths,
          parentWatched,
          (w) => syncWarnings.push(w),
        );
        for (const [rel, sigs] of Object.entries(nextWatchedFiles)) {
          const prev = parentWatched?.[rel];
          if (prev === undefined || (prev.repoSig !== sigs.repoSig && sigs.cwdSig === sigs.repoSig)) {
            syncedFiles.push(rel);
          }
        }
      } catch (err) {
        parent.writer.warn(`watched file sync warning: ${describe(err)}`);
      }
    }
    const nextBrief = buildBrief({
      preset: spec.preset,
      cwd: spec.cwd,
      context: latestContext,
      checks: spec.checks,
      pipelineStage: spec.pipeline !== null,
      resuming,
    });
    const { rawPrompt, sentPrompt, prependBrief } = buildSteeredPrompt({
      parentJobId: parent.jobId,
      wasInterrupted,
      freshContinuation: !resuming,
      toolCalls: parent.writer.snapshot()?.toolCalls ?? 0,
      responseTail: result.response.trim().slice(-600),
      entries: unconsumed,
      syncedFiles,
      brief: nextBrief,
    });
    const nextLiveEntry = newLiveJob(nextWriter, spec.timeoutMs);

    // 1. Open child anchor on disk BEFORE finishing the parent so any reader
    //    following `supersededBy` finds the child anchor immediately.
    nextWriter.start(turnStartInput(provider.name, spec, {
      prompt: rawPrompt,
      preamble: prependBrief ? nextBrief : undefined,
      preambleApplied: nextBrief !== '',
      conversation,
      task: parent.writer.snapshot()?.task ?? spec.task,
      watchedFiles: nextWatchedFiles,
      steeredFrom: parent.jobId,
    }));
    if (spec.checks !== undefined) writeJsonAtomic(jobFile(this.repo, nextJobId, FILES.checksSpec), spec.checks);
    for (const w of syncWarnings) nextWriter.warn(w);

    // The child anchor exists; publish its id before the parent's terminal
    // write so resolveHead can cross the finish window.
    writeAtomic(jobFile(this.repo, parent.jobId, FILES.steerHead), `${nextJobId}\n`);

    // 2. Register child in spawnedIds and live map before removing parent.
    this.spawnedIds.add(nextJobId);
    this.live.set(nextJobId, nextLiveEntry);
    try {
      await spec.onPrepared?.(nextJobId);
    } catch { /* best-effort callback for continuation turn */ }

    // 3. Stamp supersededBy on parent and write parent's terminal manifest atomically.
    parent.writer.markSuperseded(nextJobId);
    parent.writer.finish(result, report === '' ? null : report);
    this.live.delete(parent.jobId);

    return { writer: nextWriter, jobId: nextJobId, live: nextLiveEntry, prompt: sentPrompt, conversation: conversation ?? undefined };
  }

  /**
   * Cancel a job.
   *
   * TWO STAGES, and the split is the honest answer rather than a hedge:
   *   - Marker written, live handle signalled. The worker is actually stopped and
   *     the state file says `canceled` within one poll interval.
   *   - Marker written, NO live handle. This process did not start the job (the
   *     server restarted, or the job belongs to another session). We record the
   * *intent* so every reader agrees the job was asked to stop, and we say so.
   *     We do NOT claim it was stopped, because we have no pid to signal and
   *     `WorkerHandle` does not expose one — inventing that field in four
   *     verified adapters for one cosmetic gain is not worth it.
   */
  cancel(jobId: string): CancelResult {
    const known = this.live.has(jobId) || existsSync(jobDir(this.repo, jobId));
    if (!known) {
      throw new Error(`no job "${jobId}" in ${jobsDir(this.repo)}; call list_jobs for valid job IDs.`);
    }

    const headId = this.resolveHead(jobId);
    for (const id of new Set([jobId, headId])) {
      try {
        unlinkSync(jobFile(this.repo, id, FILES.cancelSteer));
      } catch { /* no steer marker present */ }
      const live = this.live.get(id);
      const writer =
        live?.writer ??
        this.newWriter(id);
      writer.requestCancel();
      if (live !== undefined) {
        live.userCanceled = true;
        live.handle?.cancel();
      }
    }

    const resolvedFrom = headId !== jobId ? jobId : null;
    const headLive = this.live.get(headId);
    if (headLive === undefined) {
      return {
        jobId: headId,
        ...(resolvedFrom === null ? {} : { resolvedFrom }),
        requested: true,
        signalled: false,
        note: 'Cancel recorded; no live worker here to signal directly. A live owning supervisor will stop it.',
      };
    }

    return {
      jobId: headId,
      ...(resolvedFrom === null ? {} : { resolvedFrom }),
      requested: true,
      signalled: headLive.handle !== null,
      note: headLive.handle === null
        ? 'Cancel recorded; the continuation has not started yet and will be cancelled before it runs.'
        : 'Canceled.',
    };
  }

  /**
   * Steer a running worker by recording durable intent (`steer.jsonl`) and,
   * when `delivery: 'interrupt'`, signalling the running turn to stop so the
   * pump can open the continuation turn.
   */
  async steer(request: SteerRequest): Promise<SteerAck> {
    const prompt = request.prompt;
    if (prompt.trim() === '') {
      throw new Error('prompt is empty; there is nothing to hand the worker.');
    }
    if (request.delivery !== 'queue' && request.delivery !== 'interrupt') {
      throw new Error('delivery is required; must be "queue" or "interrupt".');
    }
    const target = await this.resolveSteerTarget(request.worker);
    const latestManifest = this.readManifestSync(target.jobId) ?? target.manifest;
    if (latestManifest.pipeline !== null && latestManifest.pipeline !== undefined) {
      throw new Error(
        `Cannot steer pipeline stage "${latestManifest.name}" (${target.jobId}); pipeline stages are managed by run_pipeline.`,
      );
    }
    if (latestManifest.status !== 'running') {
      throw new Error(
        `"${latestManifest.name}" (${target.jobId}) is already ${latestManifest.status}; use resume_job to continue a finished worker.`,
      );
    }

    const live = this.live.get(target.jobId);
    if (live?.userCanceled || existsSync(jobFile(this.repo, target.jobId, FILES.cancel))) {
      throw new Error(
        `"${latestManifest.name}" (${target.jobId}) is already canceling; use resume_job after it stops.`,
      );
    }
    if (live === undefined) {
      if (!ownerAlive(latestManifest)) {
        reconcileOrphan(this.repo, target.jobId);
        throw new Error(
          `"${latestManifest.name}" (${target.jobId}) has no live owner process; it cannot be steered. Use resume_job to continue it.`,
        );
      }
    }

    const resumable =
      (typeof latestManifest.conversation === 'string' && latestManifest.conversation !== '') ||
      (live?.writer.currentConversation() ?? null) !== null;
    const resumableNote = resumable
      ? ''
      : ' No conversation handle is known yet; if none arrives before this turn ends, the continuation starts fresh.';
    const validFiles =
      request.files !== undefined && request.files.length > 0
        ? validateWatchedFiles(this.repo, request.files)
        : undefined;

    const at = new Date().toISOString();
    const entry: SteerEntry = {
      id: `steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: at,
      prompt,
      ...(request.context === undefined ? {} : { context: request.context }),
      ...(validFiles === undefined ? {} : { files: validFiles }),
      delivery: request.delivery,
    };
    appendSteerEntry(this.repo, target.jobId, entry);

    const allEntries = readSteerEntries(this.repo, target.jobId);
    const pendingSteers = Math.max(1, allEntries.length - (live?.consumedSteers ?? 0));
    if (live !== undefined) {
      live.writer.setPendingSteers(pendingSteers, at);
    }

    if (request.delivery === 'interrupt') {
      writeAtomic(jobFile(this.repo, target.jobId, FILES.cancelSteer), `${at}\n`);
      if (live !== undefined) {
        live.interruptRequested = true;
        if (live.handle !== null && live.writer.currentConversation() !== null && !live.interruptFired) {
          live.interruptFired = true;
          live.handle.cancel();
        }
      }
    }

    const signalled = Boolean(live?.handle);
    const status = request.delivery === 'interrupt' ? 'interrupting' : 'queued';
    const note =
      request.delivery === 'interrupt'
        ? live !== undefined
          ? `Interrupting current turn; continuation turn will start automatically.${resumableNote}`
          : `Interrupt recorded for owner process; continuation turn will start after current turn stops.${resumableNote}`
        : `Queued behind current turn (${pendingSteers} pending).${resumableNote}`;

    return {
      jobId: target.jobId,
      name: latestManifest.name ?? target.jobId,
      workerId: latestManifest.workerId ?? target.jobId,
      provider: latestManifest.provider,
      delivery: request.delivery,
      status,
      pendingSteers,
      signalled,
      resumable,
      repo: this.repo,
      dir: jobDir(this.repo, target.jobId),
      timeoutMs: live?.timeoutMs ?? latestManifest.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      note,
    };
  }

  private readManifestSync(id: string): ForgeManifest | null {
    const inMem = this.live.get(id)?.writer.snapshot();
    if (inMem !== null && inMem !== undefined) return inMem;
    reconcileOrphan(this.repo, id);
    try {
      return readManifest(this.repo, id);
    } catch {
      return null;
    }
  }

  /**
   * Follow a steered chain to its latest turn.
   *
   * `supersededBy` is authoritative once the parent's terminal manifest lands,
   * but the pump writes the child anchor first. `steer.head` covers that
   * finish window, so a cancel or status arriving between the two resolves to
   * the child instead of the turn that is already exiting.
   */
  resolveHead(jobId: string): string {
    const trimmed = jobId.trim();
    const seen = new Set<string>();
    let curId = trimmed;
    let curManifest = this.readManifestSync(curId);
    if (curManifest === null) return trimmed;
    while (!seen.has(curId)) {
      seen.add(curId);
      const nextId = curManifest.supersededBy ?? readSteerHead(this.repo, curId);
      if (nextId === null || nextId === undefined || nextId === '') break;
      const nextManifest = this.readManifestSync(nextId);
      if (nextManifest === null) break;
      curId = nextId;
      curManifest = nextManifest;
    }
    return curId;
  }

  private async resolveSteerTarget(worker: string): Promise<{ jobId: string; manifest: ForgeManifest }> {
    const trimmed = worker.trim();
    if (existsSync(pipelineRecordPath(this.repo, trimmed))) {
      throw new Error(`Cannot steer pipeline run "${trimmed}"; steer_job only applies to solo workers.`);
    }

    const followChain = (startId: string): { jobId: string; manifest: ForgeManifest } | null => {
      const headId = this.resolveHead(startId);
      const manifest = this.readManifestSync(headId);
      return manifest === null ? null : { jobId: headId, manifest };
    };

    if (this.live.has(trimmed) || existsSync(jobDir(this.repo, trimmed))) {
      const resolved = followChain(trimmed);
      if (resolved !== null) return resolved;
    }

    for (const [id, live] of this.live.entries()) {
      const snap = live.writer.snapshot();
      if (snap !== null && snap.name === trimmed && snap.status === 'running') {
        return { jobId: id, manifest: snap };
      }
    }

    const candidates = (await this.list({ limit: 500 })).filter((j) => j.name === trimmed);
    if (candidates.length === 0) {
      throw new Error(`No worker "${trimmed}"; see list_jobs.`);
    }
    const running = candidates.filter((j) => j.status === 'running');
    if (running.length === 1) {
      const resolved = followChain(running[0]!.jobId);
      if (resolved !== null) return resolved;
    }
    if (running.length > 1) {
      throw new Error(`"${trimmed}" matches ${running.length} running workers; pass a job ID from list_jobs.`);
    }
    const identities = new Set(candidates.map((j) => j.workerId));
    if (identities.size !== 1) {
      throw new Error(`"${trimmed}" matches ${identities.size} workers; pass a job ID from list_jobs.`);
    }
    candidates.sort((a, b) => Date.parse(b.startedAt ?? b.updatedAt ?? '') - Date.parse(a.startedAt ?? a.updatedAt ?? ''));
    const latest = followChain(candidates[0]!.jobId);
    if (latest !== null) return latest;
    throw new Error(`No worker "${trimmed}"; see list_jobs.`);
  }

  /**
   * One worker by job id or name, as the detail of its latest turn.
   *
   * An id (any turn of a steered chain) wins; otherwise the name must belong to
   * exactly one worker, and its newest turn is returned. Throws
   * WorkerLookupError when nothing matches or the name is ambiguous.
   */
  async resolveWorker(nameOrId: string): Promise<JobDetail> {
    try { return await this.detail(this.resolveHead(nameOrId)); } catch { /* not a job id: try it as a worker name */ }
    const candidates = (await this.list({ limit: 500 })).filter((j) => j.name === nameOrId);
    const identities = new Set(candidates.map((j) => j.workerId));
    if (candidates.length === 0) throw new WorkerLookupError(`No worker "${nameOrId}"; see list_jobs.`, 'missing');
    if (identities.size !== 1) {
      throw new WorkerLookupError(
        `"${nameOrId}" matches ${identities.size} workers; pass a job ID from list_jobs.`,
        'ambiguous',
        candidates.map((j) => j.jobId),
      );
    }
    candidates.sort((a, b) => Date.parse(b.startedAt ?? b.updatedAt ?? '') - Date.parse(a.startedAt ?? a.updatedAt ?? ''));
    return this.detail(this.resolveHead(candidates[0]!.jobId));
  }

  /** Jobs the pane would draw. Ours by default; interop history on request. */
  async list(filter: ListFilter = {}): Promise<JobSummary[]> {
    for (const id of this.spawnedRuns) {
      for (const stage of Object.values(readPipeline(this.repo, id)?.stageResults ?? {})) {
        if (stage.jobId) this.spawnedIds.add(stage.jobId);
      }
    }
    for (const id of this.spawnedIds) this.spawnedIds.add(this.resolveHead(id));
    const source = filter.provider ?? 'agent-smith';
    const out: JobSummary[] = [];

    if (source === 'agent-smith' || source === 'all') {
      out.push(...(await this.readSource('agent-smith', new AgentSmithReader())));
    }
    if (source === 'agy-staff' || source === 'all') {
      // The interop source. Our own ids are filtered out because the compat
      // mirror makes them visible there too, and one job must have one verdict.
      out.push(...(await this.readSource('agy-staff', new AgyStaffReader(), isForgeJobId)));
    }

    const touched = (j: JobSummary): number => Date.parse(j.finishedAt ?? j.updatedAt ?? j.startedAt ?? '');
    const filtered = out.filter((j) =>
      (filter.status === undefined || j.status === filter.status) &&
      (filter.ids === undefined || filter.ids.has(j.jobId)) &&
      (filter.sinceMs === undefined || touched(j) >= filter.sinceMs));
    // Live first, then newest — the same ordering the band draws, so the list a
    // model reads and the list a human sees put the same job on top.
    filtered.sort((a, b) => {
      const rank = (s: ObservedJob['status']): number => (s === 'running' ? 0 : 1);
      const r = rank(a.status) - rank(b.status);
      if (r !== 0) return r;
      return (b.finishedAt ?? b.updatedAt ?? '').localeCompare(a.finishedAt ?? a.updatedAt ?? '');
    });
    const limit = filter.limit ?? 50;
    return filtered.slice(0, Math.max(1, limit));
  }

  /**
   * One job in full.
   *
   * Reads from DISK, not from the in-memory map, so `status` works for a job this
   * process did not start. The in-memory manifest is only consulted to answer
   * `cancellable`.
   */
  async detail(jobId: string): Promise<JobDetail> {
    reconcileOrphan(this.repo, jobId);
    const observed = await readObservedJob('agent-smith', this.repo, jobId);
    if (observed === null) {
      const interop = await readObservedJob('agy-staff', this.repo, jobId);
      if (interop === null) {
        throw new Error(`no job "${jobId}" in ${jobsDir(this.repo)}; call list_jobs for valid job IDs.`);
      }
      return { ...toSummary(interop, 'agy-staff'), report: interop.output, error: null, exitCode: null, unrestricted: interop.label === 'unrestricted', pipeline: null, stage: null, usage: null, conversation: null, effort: null, cwd: null, cancellable: false };
    }

    const reportPath = jobFile(this.repo, jobId, FILES.report);
    let report: string | null = null;
    try {
      report = readFileSync(reportPath, 'utf8');
    } catch {
      report = null;
    }

    const raw = observed.raw;
    let manifest: ForgeManifest | null = null;
    try { manifest = readManifest(this.repo, jobId); } catch { /* partial state */ }
    const liveStale =
      manifest?.status === 'running' && manifest.watchedFiles !== undefined
        ? computeStaleReads(
            this.repo,
            manifest.cwd,
            manifest.watchedFiles,
            this.live.get(jobId)?.writer.editedFiles(Object.keys(manifest.watchedFiles)) ?? manifest.changedFiles,
          )
        : [];
    const staleReads = [...new Set([...(manifest?.staleReads ?? []), ...liveStale])].sort();
    return {
      ...toSummary(observed, 'agent-smith'),
      report,
      error: typeof raw['error'] === 'string' ? raw['error'] : null,
      exitCode: typeof raw['exit_code'] === 'number' ? raw['exit_code'] : null,
      unrestricted: raw['unrestricted'] === true,
      pipeline: typeof raw['pipeline'] === 'string' ? raw['pipeline'] : null,
      stage: typeof raw['stage'] === 'string' ? raw['stage'] : null,
      usage: typeof raw['usage'] === 'object' && raw['usage'] !== null ? (raw['usage'] as Record<string, number>) : null,
      conversation: typeof raw['conversation'] === 'string' ? raw['conversation'] : null,
      effort: typeof raw['effort'] === 'string' ? raw['effort'] : null,
      cwd: manifest?.cwd ?? null,
      ...(manifest?.reason ? { reason: manifest.reason } : {}),
      ...(manifest === null
        ? {}
        : {
            ...(manifest.modelRequested === undefined ? {} : { modelRequested: manifest.modelRequested }),
            ...(manifest.modelResolved === undefined ? {} : { modelResolved: manifest.modelResolved }),
            ...(manifest.modelSource === undefined ? {} : { modelSource: manifest.modelSource }),
            ...(manifest.preambleApplied === undefined ? {} : { preambleApplied: manifest.preambleApplied }),
            ...(manifest.sandbox === undefined ? {} : { sandbox: manifest.sandbox }),
            ...(manifest.sandboxFlags === undefined ? {} : { sandboxFlags: manifest.sandboxFlags }),
            ...(manifest.readOnlyRequested === undefined ? {} : { readOnlyRequested: manifest.readOnlyRequested }),
            ...(manifest.readOnlyEnforced === undefined ? {} : { readOnlyEnforced: manifest.readOnlyEnforced }),
            ...(manifest.gitBaseline === undefined ? {} : { gitBaseline: manifest.gitBaseline }),
            ...(manifest.changedFiles === undefined ? {} : { changedFiles: manifest.changedFiles }),
            ...(manifest.changedFilesTruncated === undefined ? {} : { changedFilesTruncated: manifest.changedFilesTruncated }),
            ...(manifest.unattributedFiles === undefined ? {} : { unattributedFiles: manifest.unattributedFiles }),
            ...(manifest.watchedFiles === undefined ? {} : { watchedFiles: manifest.watchedFiles }),
            ...(staleReads.length === 0 ? {} : { staleReads }),
          }),
      cancellable: this.live.has(jobId) || (manifest?.status === 'running' && ownerAlive(manifest)),
    };
  }

  /**
   * The job's recent tool rows, for the pipeline runner's observation tap.
   *
   * LIVE FIRST, disk second. While the job runs this process holds the writer,
   * and asking the writer is exact. Once it is over (or if it was started by
   * another process) we fall back to reading progress.json back through the
   * reader — which is the same file the pane draws from, so the observations
   * routing.ts escalates on are literally the tool calls a human would see.
   */
  async activities(jobId: string): Promise<readonly ForgeActivity[]> {
    const live = this.live.get(jobId);
    if (live !== undefined) return live.writer.activities();
    try {
      const raw = await new AgentSmithReader().read(this.repo, jobId);
      const rows = raw?.payload[SMITH_PAYLOAD.recentActivities];
      return Array.isArray(rows) ? (rows as ForgeActivity[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * The job's current state, terminal or not.
   *
   * `unknown` is returned AS `unknown`, never coerced to `running`. The runner's
   * poll loop depends on being able to tell "still going" from "cannot tell",
   * and collapsing the second into the first is how an observation series gets
   * silently truncated.
   */
  async state(jobId: string): Promise<ForgeStatus | 'unknown'> {
    reconcileOrphan(this.repo, jobId);
    const live = this.live.get(jobId)?.writer.snapshot();
    if (live !== null && live !== undefined) return live.status;
    try {
      const raw = await new AgentSmithReader().read(this.repo, jobId);
      const s = raw?.payload[SMITH_PAYLOAD.status];
      return isForgeStatus(s) ? s : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private async readSource(
    provider: string,
    reader: JobStateReader,
    skip: (jobId: string) => boolean = () => false,
  ): Promise<JobSummary[]> {
    const ids = await reader.discover(this.repo);
    const out: JobSummary[] = [];
    for (const id of ids) {
      if (skip(id)) continue;
      if (provider === 'agent-smith') reconcileOrphan(this.repo, id);
      const observed = await readObservedJob(provider, this.repo, id);
      if (observed === null) continue;
      const summary = toSummary(observed, provider === 'agent-smith' ? 'agent-smith' : 'agy-staff');
      if (provider !== 'agent-smith') { out.push(summary); continue; }
      // Attach acceptance from the sidecar so a list row carries the verdict the
      // caller would otherwise have to poll `status` for once per job. Absent
      // (unchecked, no checks) means nothing to say: the row stays as it was.
      const found = readAcceptance(this.repo, id);
      const acceptance: Acceptance = 'checks' in found ? found : { state: 'unchecked', checks: [] };
      const meaningful = acceptance.state !== 'unchecked' || acceptance.pending === true || acceptance.checks.length > 0;
      out.push(meaningful ? { ...summary, acceptance } : summary);
    }
    return out;
  }
}

function findActiveIdentity(repo: string, name: string, workerId: string): ForgeManifest | null {
  let entries: string[];
  try { entries = readdirSync(jobsDir(repo)); } catch { return null; }
  for (const id of entries) {
    let manifest: ForgeManifest;
    try { manifest = readManifest(repo, id); } catch { continue; }
    if (manifest.status !== 'running') continue;
    if (manifest.workerId === workerId || manifest.name === name) return manifest;
  }
  return null;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export { pipelineRecordPath, writePipelineRecord } from './execute.ts';
