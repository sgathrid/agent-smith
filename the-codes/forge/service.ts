import { pipelineRecordPath, readPipeline } from './execute.ts';
import { LAUNCH_ACK_MS, launchJob } from './supervisor.ts';
import { humanDuration } from '../providers/failure-text.ts';
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { AgentSmithReader, SMITH_PAYLOAD } from '../harness/agent-smith.ts';
import { readObservedJob } from '../harness/registry.ts';
import type { ObservedJob } from '../harness/types.ts';
import { getCatalogs, getHarnessDefaults } from '../providers/catalog.ts';
import { effectiveUnrestricted } from '../providers/registry.ts';
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
  isContinuationKind,
  isForgeStatus,
  normalizeContinuationKind,
  jobDir,
  jobFile,
  jobsDir,
  newJobId,
  newWorkerId,
  ownerAlive,
  readManifest,
  type ContinuationKind,
  type ForgeActivity,
  type ForgeManifest,
  type ForgeStatus,
  type MessageOverrides,
  type MessageSender,
  type SteerEntry,
  type WatchedFileSigs,
  senderOf,
  taskTitle,
} from './format.ts';
import { reconcileOrphan } from './reconcile.ts';
import { computeStaleReads, JobWriter, pipeEvents, reportFor } from './writer.ts';
import { createMarker, writeAtomic, writeJsonAtomic } from './atomic.ts';
import {
  checksAbortRequested, markAcceptancePending, markAcceptanceSuperseded, readAcceptance, runAcceptance, verdictBlock,
  writeAcceptance, type Acceptance,
} from './checks.ts';
import type { BriefCheck } from './brief.ts';
import type { StageCheck } from '../pipeline/types.ts';
import { compareTurnPriority, isTerminalStatus, isWorkerIdle, pickHead, type TurnLike } from '../surfaces/mod/hooks/turns.ts';
import { WorkerIndexStore } from './worker-index.ts';
import { LOCK_WAIT_MS, withWorkerLock } from './worker-lock.ts';
import {
  checkAgainstCatalog, validateModelAndEffort, resolveTimeoutMs, ENV_KEYS_FILE, modeError, requireProvider, turnStartInput,
  type FollowUpRequest, type MessageAck, type SpawnAck, type SpawnRequest, type SteerRequest, type TrackedSpawn, type TurnSpec,
} from './spawn-request.ts';
import { toSummary, type JobDetail, type JobSummary, type ListFilter } from './summary.ts';
import {
  appendSteerEntry, buildSteeredPrompt, discardedWarning, notSentWarning, undeliveredEntries, liveDeliverable, liveMessageText, readConsumedCount, readDiscardCut,
  readSteerEntries, readSteerHead, writeConsumedCount, writeDiscardCut,
} from './steer-log.ts';
import { syncWatchedFiles, validateWatchedFiles } from './watched-files.ts';
import { validateEnv } from '../pipeline/types.ts';

export type { ContinuationKind, FollowUpRequest, JobDetail, JobSummary, ListFilter, MessageAck, SpawnAck, SpawnRequest, SteerRequest, TrackedSpawn };
export { isContinuationKind, normalizeContinuationKind };
export { MAX_WATCHED_FILES } from './watched-files.ts';
export { ENV_KEYS_FILE };

export { DEFAULT_TIMEOUT_MS };

export interface CancelResult {
  readonly jobId: string;
  readonly resolvedFrom?: string;
  readonly requested: boolean;
  readonly signalled: boolean;
  readonly status?: ForgeStatus;
  readonly discarded?: number;
  readonly warnings?: readonly string[];
  readonly note: string;
}

interface LiveJob {
  writer: JobWriter;
  handle: WorkerHandle | null;
  timeoutMs: number;
  consumedSteers: number;
  liveSent: number;
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
    liveSent: 0,
    interruptRequested: false,
    interruptFired: false,
    userCanceled: false,
  };
}

const STEER_CONVERSATION_WAIT_MS = 2_000;
const OWNER_CHECKS_POLL_MS = 200;

interface PumpTurn {
  readonly rawPrompt: string;
  readonly prependBrief: boolean;
  readonly resuming: boolean;
  readonly context: string | undefined;
}

interface PumpEnd {
  readonly manifest: ForgeManifest;
  readonly spec: TurnSpec;
  readonly provider: Provider;
  readonly consumed: number;
  readonly ownerDone?: true;
}

function checksFollow(spec: TurnSpec): boolean {
  return spec.ownerChecks && (spec.checks?.length ?? 0) > 0;
}

function mergeOverrides(entries: readonly SteerEntry[]): MessageOverrides {
  let out: MessageOverrides = {};
  for (const e of entries) if (e.overrides !== undefined) out = { ...out, ...e.overrides };
  return out;
}

function continuationModelAndEffort(
  head: Pick<ForgeManifest, 'model' | 'modelResolved' | 'effort'>,
  entries: readonly SteerEntry[],
  spec?: Pick<TurnSpec, 'model' | 'effort'>,
): { model: string | undefined; effort: string | undefined } {
  const o = mergeOverrides(entries);
  return {
    model: o.model ?? spec?.model ?? head.model ?? head.modelResolved ?? undefined,
    effort: o.effort ?? spec?.effort ?? head.effort ?? undefined,
  };
}

function applyOverrides(spec: TurnSpec, o: MessageOverrides, provider: Provider): TurnSpec {
  if (Object.keys(o).length === 0) return spec;
  const unrestricted = effectiveUnrestricted(provider, o.unrestricted === undefined ? spec.unrestricted : o.unrestricted);
  return {
    ...spec,
    ...(o.model === undefined ? {} : { model: o.model, modelRequested: o.model, modelResolved: o.model, modelSource: 'requested' as const }),
    ...(o.effort === undefined || provider.supportsEffort === false ? {} : { effort: o.effort }),
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: resolveTimeoutMs(o.timeoutMs) }),
    ...(o.checks === undefined ? {} : { checks: o.checks }),
    unrestricted,
    readOnlyRequested: spec.preset?.readOnly === true && !unrestricted,
  };
}

export class WorkerLookupError extends Error {
  readonly kind: 'missing' | 'ambiguous';
  readonly jobIds: readonly string[];
  constructor(message: string, kind: 'missing' | 'ambiguous', jobIds: readonly string[] = []) {
    super(message);
    this.name = 'WorkerLookupError';
    this.kind = kind;
    this.jobIds = jobIds;
  }
}

export interface ForgeOptions {
  readonly supervisorUrl?: URL;
  readonly repo: string;
  readonly flushMs?: number | undefined;
  readonly catalogSource?: ((providers?: string[]) => Promise<ModelCatalog[]>) | undefined;
  readonly catalogWaitMs?: { readonly warm?: number; readonly cold?: number } | undefined;
  readonly harnessDefaults?: ((provider: string) => { model?: string; effort?: string }) | undefined;
  readonly providerSource?: ((name: string) => Provider) | undefined;
  readonly describeSandbox?:
    | ((provider: Provider, spec: Pick<SpawnSpec, 'unrestricted' | 'readOnly' | 'artifactPath'>) => SandboxInfo | undefined)
    | undefined;
  readonly hooks?: ForgeHooks | undefined;
}

export interface ForgeHooks {
  readonly afterFinalRead?: ((jobId: string) => void | Promise<void>) | undefined;
  readonly beforeOwnerDecision?: ((jobId: string) => void | Promise<void>) | undefined;
}

const CATALOG_WAIT_MS = 2_000;
const CATALOG_COLD_WAIT_MS = 5_000;

export class ForgeService {
  readonly repo: string;
  readonly supervisorUrl?: URL;
  private readonly live = new Map<string, LiveJob>();
  readonly spawnedIds = new Set<string>();
  readonly spawnedRuns = new Set<string>();
  private readonly flushMs: number | undefined;
  private readonly catalogSource: (providers?: string[]) => Promise<ModelCatalog[]>;
  private readonly catalogWaitMs: { readonly warm: number; readonly cold: number };
  private catalogSeen = false;
  private catalogWarm: Promise<ModelCatalog[]> | undefined;
  private readonly harnessDefaults: (provider: string) => { model?: string; effort?: string };
  private readonly providerSource: (name: string) => Provider;
  private readonly describeSandbox: NonNullable<ForgeOptions['describeSandbox']>;
  private readonly workers: WorkerIndexStore;
  private readonly hooks: ForgeHooks;
  private readonly envVault = new Map<string, Readonly<Record<string, string>>>();

  constructor(options: ForgeOptions) {
    this.repo = options.repo;
    this.hooks = options.hooks ?? {};
    this.workers = new WorkerIndexStore(options.repo, { readManifest: (id) => this.readManifestRaw(id) });
    this.supervisorUrl = options.supervisorUrl;
    this.flushMs = options.flushMs;
    this.providerSource = options.providerSource ?? requireProvider;
    this.catalogSource = options.catalogSource ?? ((providers) => getCatalogs({ providers, repo: this.repo }));
    this.catalogWaitMs = { warm: options.catalogWaitMs?.warm ?? CATALOG_WAIT_MS, cold: options.catalogWaitMs?.cold ?? CATALOG_COLD_WAIT_MS };
    this.harnessDefaults = options.harnessDefaults ?? getHarnessDefaults;
    this.describeSandbox = options.describeSandbox ?? ((p, spec) => p.describeSandbox?.(spec));
    try {
      for (const entry of readdirSync(jobsDir(this.repo), { withFileTypes: true })) {
        if (entry.isDirectory()) reconcileOrphan(this.repo, entry.name);
      }
    } catch {}
  }

  private newWriter(jobId: string): JobWriter {
    return new JobWriter({
      repo: this.repo,
      jobId,
      ...(this.flushMs === undefined ? {} : { flushMs: this.flushMs }),
    });
  }

  private assertNameFree(name: string, workerId: string): void {
    const busy = (jobId: string): Error =>
      new Error(`"${name}" is busy: turn ${jobId} is running.`);
    const canonicalConflict = this.findActiveIdentity(name, workerId);
    if (canonicalConflict !== null) throw busy(canonicalConflict.jobId);
    for (const { writer } of this.live.values()) {
      const active = writer.snapshot();
      if (active !== null && (active.workerId === workerId || active.name === name)) throw busy(active.jobId);
    }
  }

  private nextTurnAfter(parentId: string, parent: ForgeManifest | null, workerId: string): number {
    if (parent !== null && typeof parent.turn === 'number' && Number.isInteger(parent.turn) && parent.turn >= 1) return parent.turn + 1;
    this.workers.refresh();
    const turns = this.workers.get(workerId)?.turns ?? [];
    return turns.includes(parentId) ? turns.length + 1 : 2;
  }

  private recordTurnStart(input: {
    readonly workerId: string; readonly name: string; readonly jobId: string;
    readonly continuedFrom?: string | undefined; readonly continuationKind?: ContinuationKind | undefined;
    readonly replacesParent: boolean;
    readonly lockHeld: boolean;
  }): void {
    const parentId = input.continuedFrom;
    this.workers.recordTurnStart({
      workerId: input.workerId,
      name: input.name,
      jobId: input.jobId,
      continuation: parentId !== undefined,
      lockHeld: input.lockHeld,
      alsoLocked: () => {
        if (parentId === undefined || this.live.has(parentId)) return;
        if (!this.isSafeJobId(parentId)) return;
        let parent: ForgeManifest;
        try { parent = readManifest(this.repo, parentId); } catch { return; }
        if (!isTerminalStatus(parent.status) || parent.followedBy || parent.supersededBy) return;
        const link = input.replacesParent ? { supersededBy: input.jobId } : { followedBy: input.jobId };
        writeJsonAtomic(jobFile(this.repo, parentId, FILES.job), { ...parent, ...link, ...(parent.pendingSteers ? { pendingSteers: 0 } : {}) });
        if (parent.pendingSteers) this.setSettledPending(parentId, 0);
      },
    });
  }

  warmCatalogs(): void {
    if (this.catalogWarm !== undefined) return;
    this.catalogWarm = Promise.resolve()
      .then(() => this.catalogSource())
      .then((all) => { this.catalogSeen = true; return all; })
      .catch(() => [] as ModelCatalog[])
      .finally(() => { this.catalogWarm = undefined; });
  }

  async catalogFor(provider: string): Promise<ModelCatalog | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const waitMs = this.catalogSeen ? this.catalogWaitMs.warm : this.catalogWaitMs.cold;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), waitMs);
        timer.unref?.();
      });
      const warm = this.catalogWarm;
      const all = await Promise.race([warm ?? this.catalogSource([provider]), timeout]);
      if (all !== undefined) this.catalogSeen = true;
      return all?.find((c) => c.provider === provider) ?? (warm === undefined ? all?.[0] : undefined);
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async spawnJob(request: SpawnRequest): Promise<SpawnAck> {
    const { ack } = await this.spawnTracked(request);
    return ack;
  }

  async spawnTracked(request: SpawnRequest): Promise<TrackedSpawn> {
    const tracked = this.supervisorUrl ? await launchJob(this, request) : await this.startOwned(request);
    if (request.env !== undefined && Object.keys(request.env).length > 0) {
      this.envVault.set(tracked.ack.workerId, { ...(this.envVault.get(tracked.ack.workerId) ?? {}), ...request.env });
    }
    return tracked;
  }

  private async startOwned(request: SpawnRequest): Promise<TrackedSpawn> {
    const prepared = await this.prepareTurn(request);
    const done = this.own(this.pump(prepared.writer, prepared.provider, prepared.spec, prepared.turn));
    return { ack: prepared.ack, done };
  }

  private async prepareTurn(request: SpawnRequest): Promise<{
    ack: SpawnAck; writer: JobWriter; provider: Provider; spec: TurnSpec; turn: PumpTurn;
  }> {
    const provider = this.providerSource(request.provider ?? (() => { throw new Error('provider is required.'); })());
    const rawMode = request.mode.trim();
    const resuming = request.conversation !== undefined && request.conversation !== null;
    if (request.pipeline == null && !resuming && !isMode(rawMode)) throw modeError(rawMode);
    const mode = rawMode === '' ? 'task' : rawMode;
    const preset: ModePreset | undefined = isMode(mode) ? MODE_PRESETS[mode] : undefined;
    const prompt = request.prompt;
    if (prompt.trim() === '') {
      throw new Error('prompt is empty; there is nothing to hand the worker.');
    }
    const timeoutMs = resolveTimeoutMs(request.timeoutMs);
    const env = validateEnv(request.env);
    const envKeys = env === undefined ? [] : Object.keys(env);
    const cwd = request.cwd ?? this.repo;
    const unrestrictedRequested = request.unrestricted;
    const unrestricted = effectiveUnrestricted(provider, unrestrictedRequested);
    const warnings: string[] = [];
    const checked = await validateModelAndEffort(
      provider,
      request.model,
      request.effort,
      request.lockHeldByCaller === true ? undefined : () => this.catalogFor(provider.name),
      unrestrictedRequested,
    );
    const effort = checked.effort;
    warnings.push(...checked.warnings);
    let modelResolved: string | null = request.model ?? null;
    let modelSource: SpawnAck['modelSource'] = request.model === undefined ? 'unknown' : 'requested';
    if (request.model === undefined) {
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
      mode,
      preset,
      cwd,
      context: request.context,
      checks: request.checks,
      pipelineStage: request.pipeline !== undefined && request.pipeline !== null,
      resuming,
    });
    const prependBrief = brief !== '' && !prompt.startsWith(brief);
    const preambleApplied = brief !== '';
    const sentPrompt = prependBrief ? `${brief}\n\n${prompt}` : prompt;
    const jobId = newJobId(mode);
    const name = request.name?.trim() || `${mode}-${jobId.slice(-8)}`;
    if (name.length > 80) throw new Error('worker name must be at most 80 characters');
    const workerId = request.workerId ?? newWorkerId();
    this.assertNameFree(name, workerId);

    const writer = this.newWriter(jobId);

    warnings.push(...request.notes ?? []);
    const watchedFiles = request.watchedFiles ?? (
      request.files !== undefined && request.files.length > 0
        ? syncWatchedFiles(this.repo, cwd, request.files, undefined, (w) => warnings.push(w))
        : undefined);

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
      env,
      pipeline: request.pipeline ?? null,
      stage: request.stage ?? null,
      attempt: request.attempt ?? null,
      onPrepared: request.onPrepared,
      ownerChecks: request.ownerChecks === true,
    };

    const parentManifest = request.continuedFrom ? this.readManifestSync(request.continuedFrom) : null;
    const continuationKind = request.continuedFrom
      ? normalizeContinuationKind(request.continuationKind) ?? 'follow-up'
      : undefined;
    const turn =
      typeof request.turn === 'number' && Number.isInteger(request.turn) && request.turn >= 1
        ? request.turn
        : request.continuedFrom
          ? this.nextTurnAfter(request.continuedFrom, parentManifest, workerId)
          : 1;

    const startedManifest = writer.start(turnStartInput(provider.name, spec, {
      prompt,
      preamble: prependBrief ? brief : undefined,
      preambleApplied,
      conversation: request.conversation ?? null,
      task: request.task,
      watchedFiles,
      turn,
      continuedFrom: request.continuedFrom,
      continuationKind,
      chainStartedAt: continuationKind === 'follow-up' ? undefined : request.chainStartedAt,
      messages: request.messages,
    }));
    try {
      this.recordTurnStart({
        workerId, name, jobId,
        continuedFrom: request.continuedFrom,
        continuationKind,
        replacesParent: request.replacesParent === true,
        lockHeld: request.lockHeldByCaller === true,
      });
      if (request.checks !== undefined) writeJsonAtomic(jobFile(this.repo, jobId, FILES.checksSpec), request.checks);
      const trackedKeys = [...new Set([...(request.continuedFrom ? this.envKeysOf(request.continuedFrom) : []), ...envKeys])];
      if (trackedKeys.length > 0) writeJsonAtomic(jobFile(this.repo, jobId, ENV_KEYS_FILE), trackedKeys);
      for (const m of request.messages ?? []) writer.recordMessage(m.text, 'turn-start', m.sender);
      for (const note of request.notes ?? []) writer.warn(note);
      if (spec.ownerChecks && request.checks?.length) markAcceptancePending(this.repo, jobId, request.checks as readonly StageCheck[]);
      await request.onPrepared?.(jobId);
    } catch (error) {
      writer.abort('failed', `setup failed · ${String(error)}`);
      try { createMarker(jobFile(this.repo, jobId, FILES.ownerDone), new Date().toISOString()); } catch {}
      throw error;
    }
    this.spawnedIds.add(jobId);

    const ack: SpawnAck = {
      jobId,
      name,
      workerId,
      turn: startedManifest.turn ?? turn,
      ...(startedManifest.continuedFrom ? { continuedFrom: startedManifest.continuedFrom } : {}),
      ...(startedManifest.continuationKind ? { continuationKind: startedManifest.continuationKind } : {}),
      chainStartedAt: startedManifest.chainStartedAt ?? startedManifest.startedAt ?? startedManifest.createdAt,
      role: mode,
      provider: provider.name,
      status: 'running',
      dir: jobDir(this.repo, jobId),
      repo: this.repo,
      timeoutMs,
      ...(envKeys.length > 0 ? { envKeys } : {}),
      unrestricted,
      note:
        `queued · ${humanDuration(timeoutMs)} limit · ${
          provider.defaultUnrestricted === 'always' ? 'auto policy (cannot restrict)' : unrestricted ? 'unrestricted' : 'approvals on'
        }`,
      sandbox,
      sandboxFlags,
      ...(sandboxInfo?.unrestricted === undefined ? {} : { sandboxUnrestricted: sandboxInfo.unrestricted }),
      readOnlyRequested,
      readOnlyEnforced,
      modelRequested: request.model ?? null,
      modelResolved,
      modelSource,
      preambleApplied,
      ...(warnings.length === 0 ? {} : { warnings }),
    };

    return { ack, writer, provider, spec, turn: { rawPrompt: prompt, prependBrief, resuming, context: request.context } };
  }

  private async pump(
    initialWriter: JobWriter,
    provider: Provider,
    initialSpec: TurnSpec,
    initialTurn: PumpTurn,
    initialLive?: LiveJob,
  ): Promise<PumpEnd> {
    let spec = initialSpec;
    let currentWriter = initialWriter;
    let currentJobId = spec.jobId;
    let currentPrompt = spec.prompt;
    let currentConversation = spec.conversation;
    let currentTurn = initialTurn;
    let liveEntry = initialLive ?? newLiveJob(currentWriter, spec.timeoutMs);
    this.live.set(currentJobId, liveEntry);
    const ended = (manifest: ForgeManifest | null): PumpEnd => ({
      manifest: manifest ?? currentWriter.snapshot() ?? ({ jobId: currentJobId } as unknown as ForgeManifest),
      spec, provider, consumed: liveEntry.consumedSteers,
    });
    const abortTurn = (status: 'failed' | 'canceled', reason: string): Promise<PumpEnd> => this.ownerLocked(spec.workerId, async () => {
      const jobId = currentJobId;
      this.live.delete(jobId);
      const end = ended(currentWriter.abort(status, reason));
      writeConsumedCount(this.repo, jobId, liveEntry.consumedSteers);
      if (status === 'canceled') this.discardAtCancel(jobId, readSteerEntries(this.repo, jobId), liveEntry, (w) => this.warnSettled(jobId, w));
      const waiting = undeliveredEntries(this.repo, jobId).length;
      if (waiting > 0) {
        this.setSettledPending(jobId, waiting);
        return end;
      }
      if (checksFollow(spec)) return end;
      this.markOwnerDone(jobId);
      return { ...end, ownerDone: true };
    });

    while (true) {
      if (currentTurn.prependBrief && !currentTurn.resuming && spec.pipeline === null && currentWriter.hasPendingBaseline()) {
        const dirty = await currentWriter.awaitBaseline();
        if (liveEntry.userCanceled || currentWriter.cancelled || existsSync(jobFile(this.repo, currentJobId, FILES.cancel))) {
          currentWriter.requestCancel();
          return abortTurn('canceled', 'canceled by user');
        }
        if (dirty.length > 0) {
          const fullBrief = buildBrief({
            mode: spec.mode,
            preset: spec.preset,
            cwd: spec.cwd,
            context: currentTurn.context,
            checks: spec.checks,
            pipelineStage: false,
            resuming: false,
            dirtyFiles: dirty,
          });
          currentPrompt = `${fullBrief}\n\n${currentTurn.rawPrompt}`;
          currentWriter.updatePreamble(fullBrief);
        }
      }

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
          ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
          stateDir: jobDir(this.repo, currentJobId),
          jobId: currentJobId,
        });
      } catch (err) {
        return abortTurn('failed', `couldn't start · ${describe(err)}`);
      }

      liveEntry.handle = handle;
      const unsubscribe = pipeEvents(currentWriter, handle);

      let interruptDetectedAt: number | null = null;
      let lastPendingSteers = 0;
      let pollWarned = false;
      const live = liveEntry;
      const writer = currentWriter;
      const jobId = currentJobId;
      const liveInput = provider.liveInput === true && typeof handle.send === 'function';

      const publishConsumed = (entries: readonly SteerEntry[]): void => {
        writeConsumedCount(this.repo, jobId, live.consumedSteers);
        const pending = Math.max(0, entries.length - live.consumedSteers);
        lastPendingSteers = pending;
        writer.setPendingSteers(pending);
      };

      const syncSteerAndCancel = (): void => {
        if (existsSync(jobFile(this.repo, jobId, FILES.cancel))) {
          live.userCanceled = true;
        }
        if (live.userCanceled) {
          writer.requestCancel();
          handle.cancel();
          return;
        }
        const entries = readSteerEntries(this.repo, jobId);
        const unconsumed = entries.slice(live.consumedSteers);
        if (unconsumed.length !== lastPendingSteers) {
          lastPendingSteers = unconsumed.length;
          writer.setPendingSteers(unconsumed.length);
        }
        if (unconsumed.some((e) => e.delivery === 'interrupt') || existsSync(jobFile(this.repo, jobId, FILES.cancelSteer))) {
          live.interruptRequested = true;
        }
        if (liveInput && !live.interruptRequested) {
          for (let i = live.consumedSteers + live.liveSent; i < entries.length; i++) {
            const e = entries[i]!;
            if (!liveDeliverable(e) || handle.send!(liveMessageText(e)) !== true) break;
            live.liveSent += 1;
          }
        }
        if (live.interruptRequested && !live.interruptFired) {
          if (interruptDetectedAt === null) interruptDetectedAt = Date.now();
          const hasConversation = writer.currentConversation() !== null;
          const allowFresh = unconsumed.some((e) => e.allowFresh === true);
          const waitElapsed = Date.now() - interruptDetectedAt >= STEER_CONVERSATION_WAIT_MS;
          if (hasConversation || allowFresh || waitElapsed) {
            live.interruptFired = true;
            handle.cancel();
          }
        }
      };
      const safeSyncSteerAndCancel = (): void => {
        try { syncSteerAndCancel(); }
        catch (err) {
          if (!pollWarned) {
            pollWarned = true;
            process.stderr.write(`agent-smith steer poll ${jobId}: ${describe(err)}\n`);
          }
        }
      };
      const replayed: string[] = [];
      const markLiveRead = (texts: readonly string[], at: string): void => {
        replayed.push(...texts);
        const entries = readSteerEntries(this.repo, jobId);
        while (live.liveSent > 0) {
          const e = entries[live.consumedSteers];
          const i = e === undefined ? -1 : replayed.indexOf(liveMessageText(e));
          if (i < 0) break;
          replayed.splice(i, 1);
          writer.recordMessage(liveMessageText(e!), 'next-step', senderOf(e!), at);
          live.consumedSteers += 1;
          live.liveSent -= 1;
        }
        publishConsumed(entries);
      };
      const readAtResult = (unread: readonly string[]): string[] => {
        const left = [...unread];
        return readSteerEntries(this.repo, jobId).slice(live.consumedSteers, live.consumedSteers + live.liveSent)
          .map(liveMessageText)
          .filter((text) => {
            const i = left.indexOf(text);
            if (i < 0) return true;
            left.splice(i, 1);
            return false;
          });
      };

      const unsubSteerTap = handle.onEvent((ev) => {
        if (ev.kind === 'started' && live.interruptRequested && !live.interruptFired) {
          safeSyncSteerAndCancel();
        }
        if (ev.kind === 'user-message' && live.liveSent > 0) {
          try { markLiveRead([ev.text], ev.at); } catch (err) { process.stderr.write(`agent-smith live input ${jobId}: ${describe(err)}\n`); }
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
        if (live.liveSent > 0) markLiveRead(readAtResult(result.unreadInput ?? []), result.finishedAt);
        live.liveSent = 0;

        await writer.prepareFinish();
        const report = reportFor(result);

        const decision = await this.ownerLocked(spec.workerId, async () => {
          safeSyncSteerAndCancel();
          const entries = readSteerEntries(this.repo, jobId);
          if (live.userCanceled) this.discardAtCancel(jobId, entries, live, (w) => writer.warn(w));
          const unconsumed = entries.slice(live.consumedSteers);
          await this.hooks.afterFinalRead?.(jobId);
          const alreadyTerminal: ForgeStatus | null = result.status === 'cancelled' ? 'canceled' : null;
          const verdict = deriveStatus({
            alreadyTerminal,
            ok: result.ok,
            jobStatus: result.status,
            deniedActions: result.deniedActions ?? [],
            report: report === '' ? null : report,
            ...writer.verdictFacts(),
          });
          if (unconsumed.length > 0) {
            const next = await this.chainContinuation({
              provider, spec, parent: { writer, jobId, live },
              result, report, entries, unconsumed, verdictStatus: verdict.status, lockHeld: true,
            });
            return { next };
          }
          const manifest = writer.finish(result, report === '' ? null : report);
          writeConsumedCount(this.repo, jobId, live.consumedSteers);
          this.live.delete(jobId);
          const done = !checksFollow(spec);
          if (done) this.markOwnerDone(jobId);
          return { manifest, ownerDone: done };
        });
        if (decision.next === undefined) {
          const end = ended(decision.manifest ?? null);
          return decision.ownerDone === true ? { ...end, ownerDone: true } : end;
        }
        const next = decision.next;
        spec = next.spec;
        currentWriter = next.writer;
        currentJobId = next.jobId;
        currentPrompt = next.prompt;
        currentConversation = next.conversation;
        currentTurn = next.turn;
        liveEntry = next.live;
        continue;
      } catch (err) {
        clearInterval(cancelPoll);
        unsubSteerTap();
        unsubscribe();
        return abortTurn('failed', `crashed · ${describe(err)}`);
      }
    }
  }

  private ownerLocked<T>(workerId: string, fn: () => Promise<T>): Promise<T> {
    return withWorkerLock(this.repo, workerId, fn, {
      waitMs: Number.POSITIVE_INFINITY,
      onWait: (waitedMs, holder) => process.stderr.write(`agent-smith owner ${workerId}: waiting ${Math.round(waitedMs / 1000)} s for the worker lock held by pid ${holder}\n`),
    });
  }

  private discardAtCancel(jobId: string, entries: readonly SteerEntry[], live: { consumedSteers: number }, warn: (w: string) => void): void {
    const cut = existsSync(jobFile(this.repo, jobId, FILES.steerDiscard)) ? readDiscardCut(this.repo, jobId) : entries.length;
    const end = Math.min(cut, entries.length);
    if (end <= live.consumedSteers) return;
    warn(discardedWarning(entries.slice(live.consumedSteers, end)));
    live.consumedSteers = end;
    writeConsumedCount(this.repo, jobId, end);
  }

  private markOwnerDone(jobId: string): void {
    createMarker(jobFile(this.repo, jobId, FILES.ownerDone), new Date().toISOString());
  }

  private async own(first: Promise<PumpEnd>): Promise<ForgeManifest> {
    let end = await first;
    try {
      while (true) {
        if (end.ownerDone === true) return end.manifest;
        const head = end.manifest;
        const checks = end.spec.ownerChecks ? (end.spec.checks as readonly StageCheck[] | undefined) : undefined;
        const acceptance = checks?.length ? await this.ownerRunChecks(head, checks) : undefined;
        await this.hooks.beforeOwnerDecision?.(head.jobId);
        const next = await this.ownerLocked(end.spec.workerId, async () => {
          if (acceptance !== undefined) writeAcceptance(this.repo, head.jobId, acceptance);
          const entries = readSteerEntries(this.repo, head.jobId);
          const live = { consumedSteers: Math.max(end.consumed, readConsumedCount(this.repo, head.jobId)) };
          if (existsSync(jobFile(this.repo, head.jobId, FILES.cancel))) {
            this.discardAtCancel(head.jobId, entries, live, (w) => this.warnSettled(head.jobId, w));
          }
          const unconsumed = entries.slice(live.consumedSteers);
          if (unconsumed.length === 0) {
            this.markOwnerDone(head.jobId);
            return null;
          }
          let prepared: Awaited<ReturnType<ForgeService['prepareTurn']>>;
          try {
            const request = this.continuationRequest({
              head, spec: end.spec, provider: end.provider.name, entries: unconsumed,
              verdict: acceptance === undefined ? undefined : verdictBlock(acceptance),
              env: end.spec.env,
              replacesHead: checksAbortRequested(this.repo, head.jobId),
            });
            prepared = await this.prepareTurn(request);
          } catch (err) {
            this.warnSettled(head.jobId, notSentWarning(unconsumed, describe(err)));
            this.setSettledPending(head.jobId, 0);
            this.markOwnerDone(head.jobId);
            return null;
          }
          writeConsumedCount(this.repo, head.jobId, entries.length);
          const nextLive = newLiveJob(prepared.writer, prepared.spec.timeoutMs);
          this.live.set(prepared.spec.jobId, nextLive);
          return { prepared, live: nextLive };
        });
        if (next === null) return end.manifest;
        end = await this.pump(next.prepared.writer, next.prepared.provider, next.prepared.spec, next.prepared.turn, next.live);
      }
    } catch (err) {
      process.stderr.write(`agent-smith owner ${end.manifest.jobId}: ${describe(err)}\n`);
      try { createMarker(jobFile(this.repo, end.manifest.jobId, FILES.ownerDone), new Date().toISOString()); } catch {}
      return end.manifest;
    }
  }

  private async ownerRunChecks(head: ForgeManifest, checks: readonly StageCheck[]): Promise<Acceptance> {
    const controller = new AbortController();
    let abortedBy: 'cancel' | 'steer' | null = null;
    const poll = (): void => {
      if (abortedBy !== null) return;
      if (existsSync(jobFile(this.repo, head.jobId, FILES.cancel))) abortedBy = 'cancel';
      else if (checksAbortRequested(this.repo, head.jobId)) abortedBy = 'steer';
      if (abortedBy !== null) controller.abort();
    };
    poll();
    const timer = setInterval(poll, OWNER_CHECKS_POLL_MS);
    timer.unref?.();
    let acceptance: Acceptance;
    try {
      acceptance = await runAcceptance({
        repo: this.repo, jobId: head.jobId, succeeded: head.status === 'succeeded', checks,
        baseDir: head.cwd ?? this.repo, signal: controller.signal,
      });
    } finally {
      clearInterval(timer);
    }
    if (abortedBy === 'steer') {
      acceptance = { state: 'unchecked', checks: [], at: new Date().toISOString(), reason: 'aborted by steer' };
    }
    return acceptance;
  }

  private warnSettled(jobId: string, message: string): void {
    const file = jobFile(this.repo, jobId, FILES.progress);
    try {
      const progress = JSON.parse(readFileSync(file, 'utf8')) as { warnings?: string[] };
      const warnings = Array.isArray(progress.warnings) ? progress.warnings : [];
      if (!warnings.includes(message)) writeJsonAtomic(file, { ...progress, warnings: [...warnings, message] });
    } catch {}
  }

  private setSettledPending(jobId: string, pending: number): void {
    for (const name of [FILES.job, FILES.progress]) {
      const file = jobFile(this.repo, jobId, name);
      try {
        const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        writeJsonAtomic(file, { ...doc, pendingSteers: pending });
      } catch {}
    }
  }

  private continuationRequest(input: {
    readonly head: ForgeManifest;
    readonly spec?: TurnSpec | undefined;
    readonly provider: string;
    readonly entries: readonly SteerEntry[];
    readonly verdict?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
    readonly headChecks?: readonly BriefCheck[] | undefined;
    readonly replacesHead: boolean;
  }): SpawnRequest {
    const { head, spec, entries } = input;
    const o = mergeOverrides(entries);
    const conversation = typeof head.conversation === 'string' && head.conversation !== '' ? head.conversation : undefined;
    const steered = entries.some((e) => senderOf(e) === 'steer');
    let responseTail = '';
    if (conversation === undefined) {
      try { responseTail = readFileSync(jobFile(this.repo, head.jobId, FILES.report), 'utf8').trim().slice(-600); } catch {}
    }
    const cwd = spec?.cwd ?? head.cwd ?? this.repo;
    const { watchedFiles, syncedFiles, notes } = this.syncContinuationFiles(cwd, head.watchedFiles, entries.flatMap((e) => e.files ?? []));
    const { rawPrompt } = buildSteeredPrompt({
      wasInterrupted: false,
      priorStatus: head.status,
      verdict: input.verdict,
      freshContinuation: conversation === undefined,
      responseTail,
      entries,
      syncedFiles,
      brief: '',
    });
    const context = [...entries].reverse().find((e) => e.context !== undefined)?.context ?? spec?.context;
    const checks = o.checks ?? spec?.checks ?? input.headChecks;
    const env = input.env !== undefined && Object.keys(input.env).length > 0 ? input.env : undefined;
    const { model, effort } = continuationModelAndEffort(head, entries, spec);
    return {
      mode: spec?.mode ?? head.mode ?? 'task',
      prompt: rawPrompt,
      provider: input.provider,
      name: head.name,
      workerId: head.workerId ?? head.jobId,
      task: taskTitle(entries[0]!.prompt) || head.task || undefined,
      cwd,
      model,
      effort,
      timeoutMs: o.timeoutMs ?? spec?.timeoutMs ?? head.timeoutMs,
      unrestricted: o.unrestricted ?? spec?.unrestricted ?? head.unrestricted,
      ...(context === undefined ? {} : { context }),
      ...(checks === undefined ? {} : { checks }),
      ...(watchedFiles === undefined ? {} : { watchedFiles }),
      ...(notes.length === 0 ? {} : { notes }),
      ...(conversation === undefined ? {} : { conversation }),
      ...(env === undefined ? {} : { env }),
      continuedFrom: head.jobId,
      continuationKind: steered ? 'steer' : 'follow-up',
      ...(steered && input.replacesHead
        ? { replacesParent: true, chainStartedAt: head.chainStartedAt ?? head.startedAt ?? head.createdAt }
        : {}),
      lockHeldByCaller: true,
      ownerChecks: spec === undefined ? true : spec.ownerChecks,
      messages: entries.map((e) => ({ text: e.prompt, sender: senderOf(e) })),
    };
  }

  private withSandbox(spec: TurnSpec, before: TurnSpec, provider: Provider): TurnSpec {
    if (spec.unrestricted === before.unrestricted) return spec;
    const info = this.describeSandbox(provider, {
      unrestricted: spec.unrestricted,
      readOnly: spec.readOnlyRequested,
      ...(spec.artifactPath === undefined ? {} : { artifactPath: spec.artifactPath }),
    });
    return {
      ...spec,
      sandbox: info?.sandbox ?? 'unknown',
      sandboxFlags: [...(info?.flags ?? [])],
      readOnlyEnforced: info?.readOnlyEnforced ?? false,
    };
  }

  private syncContinuationFiles(
    cwd: string, previous: Readonly<Record<string, WatchedFileSigs>> | undefined, added: readonly string[],
  ): { watchedFiles: Record<string, WatchedFileSigs> | undefined; syncedFiles: string[]; notes: string[] } {
    const notes: string[] = [];
    const paths = [...new Set([...Object.keys(previous ?? {}), ...added])].filter((f) => {
      if (existsSync(path.resolve(this.repo, f))) return true;
      notes.push(`dropped deleted watched file "${f}" from continuation turn`);
      return false;
    });
    if (paths.length === 0) return { watchedFiles: undefined, syncedFiles: [], notes };
    let watchedFiles: Record<string, WatchedFileSigs>;
    try {
      watchedFiles = syncWatchedFiles(this.repo, cwd, paths, previous, (w) => notes.push(w));
    } catch (err) {
      notes.push(`watched file sync warning: ${describe(err)}`);
      return { watchedFiles: undefined, syncedFiles: [], notes };
    }
    const syncedFiles = Object.entries(watchedFiles)
      .filter(([rel, sigs]) => {
        const prev = previous?.[rel];
        return prev === undefined || (prev.repoSig !== sigs.repoSig && sigs.cwdSig === sigs.repoSig);
      })
      .map(([rel]) => rel);
    return { watchedFiles, syncedFiles, notes };
  }

  private async chainContinuation(input: {
    readonly provider: Provider;
    readonly spec: TurnSpec;
    readonly parent: { readonly writer: JobWriter; readonly jobId: string; readonly live: LiveJob };
    readonly result: JobResult;
    readonly report: string;
    readonly entries: readonly SteerEntry[];
    readonly unconsumed: readonly SteerEntry[];
    readonly verdictStatus: ForgeStatus;
    readonly lockHeld?: boolean;
  }): Promise<{
    spec: TurnSpec;
    writer: JobWriter;
    jobId: string;
    live: LiveJob;
    prompt: string;
    conversation: string | undefined;
    turn: { rawPrompt: string; prependBrief: boolean; resuming: boolean; context: string | undefined };
  }> {
    const { provider, parent, result, report, entries, unconsumed, verdictStatus } = input;
    const spec = this.withSandbox(applyOverrides(input.spec, mergeOverrides(unconsumed), provider), input.spec, provider);
    const conversation = parent.writer.currentConversation();
    const wasInterrupted = parent.live.interruptRequested && verdictStatus !== 'succeeded';
    if (conversation === null && !wasInterrupted) {
      parent.writer.warn('provider did not report a resumable conversation ID; continuing in a fresh session');
    }
    try {
      unlinkSync(jobFile(this.repo, parent.jobId, FILES.cancelSteer));
    } catch {}
    const nextJobId = newJobId(spec.mode);
    const nextWriter = this.newWriter(nextJobId);
    const latestContext = [...unconsumed].reverse().find((e) => e.context !== undefined)?.context ?? spec.context;
    const resuming = conversation !== null;
    const parentWatched = parent.writer.snapshot()?.watchedFiles;
    const { watchedFiles: nextWatchedFiles, syncedFiles, notes: syncWarnings } = this.syncContinuationFiles(
      spec.cwd, parentWatched, unconsumed.flatMap((e) => e.files ?? []),
    );
    const nextBrief = buildBrief({
      mode: spec.mode,
      preset: spec.preset,
      cwd: spec.cwd,
      context: latestContext,
      checks: spec.checks,
      pipelineStage: spec.pipeline !== null,
      resuming,
    });
    const { rawPrompt, sentPrompt, prependBrief } = buildSteeredPrompt({
      wasInterrupted,
      priorStatus: verdictStatus,
      freshContinuation: !resuming,
      responseTail: result.response.trim().slice(-600),
      entries: unconsumed,
      syncedFiles,
      brief: nextBrief,
    });
    const nextLiveEntry = newLiveJob(nextWriter, spec.timeoutMs);
    const parentSnap = parent.writer.snapshot();
    const nextTurn = (parentSnap?.turn ?? 1) + 1;
    const continuationKind: ContinuationKind = parent.live.interruptRequested ? 'steer' : 'follow-up';
    const chainStartedAt = continuationKind === 'steer'
      ? parentSnap?.chainStartedAt ?? parentSnap?.startedAt ?? parentSnap?.createdAt
      : undefined;

    nextWriter.start(turnStartInput(provider.name, spec, {
      prompt: rawPrompt,
      preamble: prependBrief ? nextBrief : undefined,
      preambleApplied: nextBrief !== '',
      conversation,
      task: taskTitle(unconsumed[0]!.prompt) || parentSnap?.task || spec.task,
      watchedFiles: nextWatchedFiles,
      turn: nextTurn,
      continuedFrom: parent.jobId,
      continuationKind,
      chainStartedAt,
      messages: unconsumed.map((e) => ({ text: e.prompt, sender: senderOf(e) })),
    }));
    if (spec.checks !== undefined) writeJsonAtomic(jobFile(this.repo, nextJobId, FILES.checksSpec), spec.checks);
    parent.live.consumedSteers = entries.length;
    writeConsumedCount(this.repo, parent.jobId, entries.length);
    for (const e of unconsumed) nextWriter.recordMessage(e.prompt, 'turn-start', senderOf(e));
    if (spec.ownerChecks && spec.checks?.length) markAcceptancePending(this.repo, nextJobId, spec.checks as readonly StageCheck[]);
    const trackedKeys = [...new Set([...this.envKeysOf(parent.jobId), ...Object.keys(spec.env ?? {})])];
    if (trackedKeys.length > 0) writeJsonAtomic(jobFile(this.repo, nextJobId, ENV_KEYS_FILE), trackedKeys);
    for (const w of syncWarnings) nextWriter.warn(w);
    const workerId = parentSnap?.workerId ?? spec.workerId;
    const recordChild = (): void => {
      this.workers.recordTurnStart({
        workerId, name: parentSnap?.name ?? spec.name, jobId: nextJobId, continuation: true, lockHeld: true,
      });
    };
    try {
      if (input.lockHeld === true) recordChild();
      else await withWorkerLock(this.repo, workerId, recordChild);
    } catch (err) {
      nextWriter.warn(`worker index not updated: ${describe(err)}`);
    }

    if (continuationKind === 'steer') {
      writeAtomic(jobFile(this.repo, parent.jobId, FILES.steerHead), `${nextJobId}\n`);
    }

    this.spawnedIds.add(nextJobId);
    this.live.set(nextJobId, nextLiveEntry);
    try {
      await spec.onPrepared?.(nextJobId);
    } catch {}

    if (continuationKind === 'steer') parent.writer.markSuperseded(nextJobId);
    else parent.writer.markFollowedBy(nextJobId);
    parent.writer.finish(result, report === '' ? null : report);
    this.live.delete(parent.jobId);
    if (input.spec.checks !== undefined && input.spec.checks.length > 0) {
      try {
        if (continuationKind === 'follow-up') writeAcceptance(this.repo, parent.jobId, { state: 'unchecked', checks: [], reason: 'continued by follow-up' });
        else markAcceptanceSuperseded(this.repo, parent.jobId);
      } catch (err) {
        process.stderr.write(`agent-smith acceptance ${parent.jobId}: ${describe(err)}\n`);
      }
    }

    return {
      spec: { ...spec, jobId: nextJobId },
      writer: nextWriter,
      jobId: nextJobId,
      live: nextLiveEntry,
      prompt: sentPrompt,
      conversation: conversation ?? undefined,
      turn: { rawPrompt, prependBrief: false, resuming, context: latestContext },
    };
  }

  cancel(id: string): CancelResult {
    const trimmed = id.trim();
    const isJob = this.isJobId(trimmed);
    let headId: string;
    try {
      headId = isJob ? this.resolveTurn(trimmed) : this.resolveWorkerHeadId(trimmed);
    } catch (err) {
      if (err instanceof WorkerLookupError && err.kind === 'missing') {
        throw this.notFound(id);
      }
      throw err;
    }
    const known = this.live.has(headId) || (this.isSafeJobId(headId) && existsSync(jobDir(this.repo, headId)));
    if (!known) {
      throw this.notFound(id);
    }
    const resolvedFrom = headId !== trimmed ? trimmed : null;
    const discarded = this.cutQueue(headId);
    const dropped = discarded.length === 0 ? {} : { discarded: discarded.length, warnings: [discardedWarning(discarded)] };

    const headManifest = this.readManifestSync(headId);
    if (!this.live.has(headId) && headManifest !== null && headManifest.status !== 'running') {
      const checksPending = (readAcceptance(this.repo, headId) as { pending?: boolean }).pending === true;
      if (checksPending || discarded.length > 0) createMarker(jobFile(this.repo, headId, FILES.cancel), new Date().toISOString());
      if (discarded.length > 0) this.setSettledPending(headId, 0);
      return {
        jobId: headId,
        ...(resolvedFrom === null ? {} : { resolvedFrom }),
        ...dropped,
        requested: checksPending,
        signalled: false,
        status: headManifest.status,
        note: checksPending
          ? `Already ${headManifest.status}; asked its owner to stop the acceptance checks still running.`
          : `Already ${headManifest.status}; nothing to cancel.`,
      };
    }

    const targets = new Set<string>([headId]);
    if (isJob && trimmed !== headId && (this.live.has(trimmed) || this.readManifestSync(trimmed)?.status === 'running')) {
      targets.add(trimmed);
    }
    for (const target of targets) {
      try {
        unlinkSync(jobFile(this.repo, target, FILES.cancelSteer));
      } catch {}
      const live = this.live.get(target);
      const writer =
        live?.writer ??
        this.newWriter(target);
      writer.requestCancel();
      if (live !== undefined) {
        live.userCanceled = true;
        live.handle?.cancel();
      }
    }

    const headLive = this.live.get(headId);
    if (headLive === undefined) {
      return {
        jobId: headId,
        ...(resolvedFrom === null ? {} : { resolvedFrom }),
        ...dropped,
        requested: true,
        signalled: false,
        note: 'Cancel recorded; no live worker here to signal directly. A live owning supervisor will stop it.',
      };
    }

    return {
      jobId: headId,
      ...(resolvedFrom === null ? {} : { resolvedFrom }),
      ...dropped,
      requested: true,
      signalled: headLive.handle !== null,
      note: headLive.handle === null
        ? 'Cancel recorded; the continuation has not started yet and will be cancelled before it runs.'
        : 'Canceled.',
    };
  }

  private ownerLive(jobId: string, m: ForgeManifest): boolean {
    if (this.live.has(jobId)) return true;
    if (!ownerAlive(m) || existsSync(jobFile(this.repo, jobId, FILES.ownerDone))) return false;
    if (!isTerminalStatus(m.status)) return true;
    return this.checksPending(jobId) || readSteerEntries(this.repo, jobId).length > readConsumedCount(this.repo, jobId);
  }

  private checksPending(jobId: string): boolean {
    const acc = readAcceptance(this.repo, jobId);
    return 'pending' in acc && acc.pending === true;
  }

  private cutQueue(jobId: string): SteerEntry[] {
    if (!this.isSafeJobId(jobId)) return [];
    const undelivered = undeliveredEntries(this.repo, jobId);
    writeDiscardCut(this.repo, jobId, readSteerEntries(this.repo, jobId).length);
    return undelivered;
  }

  async messageTarget(ref: string): Promise<JobDetail> {
    const { headId, head } = this.messageHead(ref.trim());
    if (!this.ownerLive(headId, head)) this.assertResumable(head);
    return this.numberedDetail(headId);
  }

  private notFound(id: string): Error {
    return new Error(`No worker "${id}".`);
  }

  private rejectPipelineRun(ref: string): void {
    if (readPipeline(this.repo, ref) !== null) {
      throw new Error(`"${ref}" is a pipeline run, not a worker.`);
    }
  }

  private messageHead(ref: string): { headId: string; head: ForgeManifest } {
    this.rejectPipelineRun(ref);
    let headId: string;
    try {
      headId = this.resolveWorkerHeadId(ref);
    } catch (err) {
      throw err instanceof WorkerLookupError ? new Error(err.message) : err;
    }
    const head = this.readManifestSync(headId);
    if (head === null) throw this.notFound(ref);
    if (head.pipeline !== null && head.pipeline !== undefined) {
      throw new Error(`"${head.name ?? headId}" is a pipeline stage (${headId}); run_pipeline manages its turns.`);
    }
    return { headId, head };
  }

  private assertResumable(head: ForgeManifest): void {
    if (typeof head.conversation === 'string' && head.conversation !== '') return;
    const name = head.name ?? head.jobId;
    throw new Error(`"${name}" (${head.jobId}) has no saved conversation to continue.`);
  }

  async followUp(request: FollowUpRequest): Promise<MessageAck> {
    return this.deliver('follow_up', request);
  }

  async steer(request: SteerRequest): Promise<MessageAck> {
    return this.deliver('steer', request);
  }

  private async deliver(sender: MessageSender, request: FollowUpRequest & SteerRequest): Promise<MessageAck> {
    const prompt = request.prompt;
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw new Error('prompt is empty; there is nothing to hand the worker.');
    }
    const ref = request.worker.trim();
    const { headId: firstHeadId, head: first } = this.messageHead(ref);
    const env = sender === 'follow_up' ? validateEnv(request.env) : undefined;
    const files = request.files !== undefined && request.files.length > 0 ? validateWatchedFiles(this.repo, request.files) : undefined;
    const workerId = first.workerId ?? firstHeadId;
    const overrides: MessageOverrides = sender === 'steer' ? {} : {
      ...(request.checks === undefined ? {} : { checks: request.checks as MessageOverrides['checks'] }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: resolveTimeoutMs(request.timeoutMs) }),
      ...(request.unrestricted === undefined ? {} : { unrestricted: request.unrestricted }),
    };
    const warnings: string[] = [];
    const checkCatalog = overrides.model !== undefined || overrides.effort !== undefined;
    const catalog = checkCatalog ? await this.catalogFor(first.provider) : undefined;
    const entry: SteerEntry = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      prompt,
      ...(request.context === undefined ? {} : { context: request.context }),
      ...(files === undefined ? {} : { files }),
      delivery: sender === 'steer' ? 'interrupt' : 'queue',
      ...(sender === 'steer' && request.allowFresh === true ? { allowFresh: true } : {}),
      sender,
      ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
    };
    return withWorkerLock(this.repo, workerId, async () => {
      const headId = this.workerHeadId(workerId) ?? firstHeadId;
      const head = this.readManifestSync(headId);
      if (head === null) throw this.notFound(ref);
      if (this.ownerLive(headId, head)) return this.enqueue(sender, headId, head, entry, env, warnings, checkCatalog, catalog);
      return this.coldStart(sender, head, entry, env, warnings, checkCatalog, catalog);
    }, { waitMs: LAUNCH_ACK_MS + LOCK_WAIT_MS });
  }

  private async enqueue(
    sender: MessageSender, headId: string, head: ForgeManifest, entry: SteerEntry,
    env: Readonly<Record<string, string>> | undefined, warnings: string[],
    checkCatalog: boolean, catalog: ModelCatalog | undefined,
  ): Promise<MessageAck> {
    const live = this.live.get(headId);
    const running = head.status === 'running';
    const name = head.name ?? headId;
    if (sender === 'steer' && running) {
      if (live?.userCanceled || existsSync(jobFile(this.repo, headId, FILES.cancel))) {
        throw new Error(`"${name}" (${headId}) is being canceled; send the message after it stops.`);
      }
      const resumable = (typeof head.conversation === 'string' && head.conversation !== '') ||
        (live !== undefined && live.writer.currentConversation() !== null);
      if (!resumable && entry.allowFresh !== true) {
        throw new Error(`Cannot interrupt "${name}" (${headId}): no resumable conversation handle exists yet, so interrupting now would discard in-flight context and start fresh (pass allowFresh: true to discard it).`);
      }
    }
    const provider = this.providerSafe(head.provider);
    const { model: effectiveModel, effort: effectiveEffort } = continuationModelAndEffort(head, [...undeliveredEntries(this.repo, headId), entry]);
    if (provider !== null) {
      const checked = await validateModelAndEffort(
        provider,
        effectiveModel,
        effectiveEffort,
        checkCatalog ? async () => catalog : undefined,
        entry.overrides?.unrestricted,
      );
      warnings.push(...checked.warnings);
    }
    const checksRunning = !running && this.checksPending(headId);
    appendSteerEntry(this.repo, headId, entry);
    const at = entry.createdAt;
    if (sender === 'steer') {
      if (running) {
        writeAtomic(jobFile(this.repo, headId, FILES.cancelSteer), `${at}\n`);
        if (live !== undefined) {
          live.interruptRequested = true;
          if (live.handle !== null && (live.writer.currentConversation() !== null || entry.allowFresh === true) && !live.interruptFired) {
            live.interruptFired = true;
            live.handle.cancel();
          }
        }
      } else if (checksRunning) {
        createMarker(jobFile(this.repo, headId, FILES.checksAbort), at);
      }
    }
    const entries = readSteerEntries(this.repo, headId);
    const consumed = live !== undefined ? live.consumedSteers : readConsumedCount(this.repo, headId);
    const pending = Math.max(1, entries.length - consumed);
    if (live !== undefined) live.writer.setPendingSteers(pending, at);
    else if (!running) this.setSettledPending(headId, pending);
    const workerId = head.workerId ?? headId;
    const { ack: envAck } = this.resolveFollowUpEnv(workerId, headId, env, true, warnings);
    const canDeliverLive = running
      && provider?.liveInput === true
      && !live?.interruptRequested
      && !existsSync(jobFile(this.repo, headId, FILES.cancelSteer))
      && !existsSync(jobFile(this.repo, headId, FILES.cancel))
      && liveDeliverable(entry)
      && entries.slice(consumed).every(liveDeliverable);
    const delivery: MessageAck['delivery'] = sender === 'steer'
      ? 'now'
      : canDeliverLive ? 'next-step' : 'turn-end';
    const checks = (entry.overrides?.checks ?? this.headChecks(headId))?.map((c) => c.name);
    const turn = typeof head.turn === 'number' && head.turn >= 1 ? head.turn : 1;
    const note = sender === 'steer'
      ? running ? 'Interrupting; the steered turn starts next.'
        : checksRunning ? 'Aborting the checks; the steered turn starts next.' : 'Queued; the steered turn starts next.'
      : delivery === 'next-step' ? 'Sent into the running turn; read at its next step.'
        : running ? 'Queued; runs when this turn ends.'
          : checksRunning ? 'Queued; runs after the checks.' : 'Queued; runs as the next turn.';
    return {
      jobId: headId, name, workerId, turn,
      action: sender === 'steer' && (running || checksRunning) ? 'interrupting' : 'queued',
      delivery, status: 'running', provider: head.provider, repo: this.repo,
      timeoutMs: entry.overrides?.timeoutMs ?? head.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      pendingMessages: pending,
      ...envAck,
      ...(checks !== undefined && checks.length > 0 ? { checks } : {}),
      ...(warnings.length === 0 ? {} : { warnings }),
      note,
    };
  }

  private async coldStart(
    sender: MessageSender, head: ForgeManifest, entry: SteerEntry,
    env: Readonly<Record<string, string>> | undefined, warnings: string[],
    checkCatalog: boolean, catalog: ModelCatalog | undefined,
  ): Promise<MessageAck> {
    this.assertResumable(head);
    const workerId = head.workerId ?? head.jobId;
    const { ack: envAck, runEnv } = this.resolveFollowUpEnv(workerId, head.jobId, env, false, warnings);
    const provider = this.providerSafe(head.provider);
    const pendingEntries = undeliveredEntries(this.repo, head.jobId);
    const { model: effectiveModel, effort: effectiveEffort } = continuationModelAndEffort(head, [...pendingEntries, entry]);
    if (checkCatalog && (effectiveModel !== undefined || (effectiveEffort !== undefined && provider?.supportsEffort !== false))) {
      warnings.push(...checkAgainstCatalog(head.provider, effectiveModel, effectiveEffort, catalog));
    }
    const acceptance = readAcceptance(this.repo, head.jobId);
    const onDisk = readSteerEntries(this.repo, head.jobId).length;
    const request = this.continuationRequest({
      head, provider: head.provider, entries: [...pendingEntries, entry],
      verdict: verdictBlock(acceptance), env: runEnv, headChecks: this.headChecks(head.jobId), replacesHead: false,
    });
    const { ack } = await this.spawnTracked({ ...request, ownerChecks: true, lockHeldByCaller: true });
    writeConsumedCount(this.repo, head.jobId, onDisk);
    const checks = request.checks?.map((c) => c.name);
    return {
      jobId: ack.jobId, name: ack.name, workerId: ack.workerId, turn: ack.turn,
      action: 'started', delivery: 'now', status: 'running', provider: ack.provider, repo: this.repo,
      timeoutMs: ack.timeoutMs,
      ...envAck,
      ...(checks !== undefined && checks.length > 0 ? { checks } : {}),
      ...((warnings.length + (ack.warnings?.length ?? 0)) === 0 ? {} : { warnings: [...warnings, ...(ack.warnings ?? [])] }),
      note: sender === 'steer' ? `Started turn ${ack.turn} with the steer.` : `Started turn ${ack.turn}.`,
    };
  }

  private resolveFollowUpEnv(
    workerId: string, headId: string, env: Readonly<Record<string, string>> | undefined,
    liveOwner: boolean, warnings: string[],
  ): { ack: Pick<MessageAck, 'env' | 'envKeys'>; runEnv?: Record<string, string> } {
    const vault = this.envVault.get(workerId);
    const passed = env !== undefined && Object.keys(env).length > 0;
    if (liveOwner) {
      if (passed) {
        const same = vault !== undefined && Object.entries(env).every(([k, v]) => vault[k] === v);
        this.envVault.set(workerId, { ...(vault ?? {}), ...env });
        if (!same) {
          warnings.push('env applies from the next new turn after this worker goes idle; the running worker keeps the environment it started with.');
          return { ack: { env: 'deferred' } };
        }
        return { ack: { env: 'kept' } };
      }
      return { ack: this.envKeysOf(headId).length > 0 || (vault !== undefined && Object.keys(vault).length > 0) ? { env: 'kept' } : {} };
    }
    const known = { ...(vault ?? {}), ...(env ?? {}) };
    const runEnv = Object.keys(known).length > 0 ? known : undefined;
    const missing = this.envKeysOf(headId).filter((k) => !(k in known));
    if (missing.length > 0) warnings.push(`env ${missing.join(', ')} not set: values live only in memory and were lost.`);
    const ack: Pick<MessageAck, 'env' | 'envKeys'> = missing.length > 0 ? { env: 'dropped', envKeys: missing }
      : passed ? { env: 'set' } : runEnv !== undefined ? { env: 'kept' } : {};
    return { ack, ...(runEnv === undefined ? {} : { runEnv }) };
  }

  private envKeysOf(jobId: string): string[] {
    try {
      const keys = JSON.parse(readFileSync(jobFile(this.repo, jobId, ENV_KEYS_FILE), 'utf8')) as unknown;
      return Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [];
    } catch {
      return [];
    }
  }

  private headChecks(jobId: string): BriefCheck[] | undefined {
    try {
      const checks = JSON.parse(readFileSync(jobFile(this.repo, jobId, FILES.checksSpec), 'utf8')) as unknown;
      return Array.isArray(checks) ? (checks as BriefCheck[]) : undefined;
    } catch {
      return undefined;
    }
  }

  private providerSafe(name: string): Provider | null {
    try { return this.providerSource(name); } catch { return null; }
  }

  private isSafeJobId(id: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) && id !== '.' && id !== '..';
  }

  private isJobId(id: string): boolean {
    return this.isSafeJobId(id) && (this.live.has(id) || existsSync(jobFile(this.repo, id, FILES.job)));
  }

  private readManifestSync(id: string): ForgeManifest | null {
    if (!this.isSafeJobId(id)) return null;
    const inMem = this.live.get(id)?.writer.snapshot();
    if (inMem !== null && inMem !== undefined) return inMem;
    reconcileOrphan(this.repo, id);
    try {
      return readManifest(this.repo, id);
    } catch {
      return null;
    }
  }

  private readManifestRaw(id: string): ForgeManifest | null {
    if (!this.isSafeJobId(id)) return null;
    const inMem = this.live.get(id)?.writer.snapshot();
    if (inMem !== null && inMem !== undefined) return inMem;
    try {
      return readManifest(this.repo, id);
    } catch {
      return null;
    }
  }

  resolveTurn(jobId: string): string {
    const trimmed = jobId.trim();
    const seen = new Set<string>();
    let curId = trimmed;
    let cur = this.readManifestSync(curId);
    if (cur === null) return trimmed;
    while (!seen.has(curId)) {
      seen.add(curId);
      const nextId = cur.supersededBy ?? readSteerHead(this.repo, curId);
      if (nextId === null || nextId === undefined || nextId === '') break;
      const next = this.readManifestSync(nextId);
      if (next === null) break;
      curId = nextId;
      cur = next;
    }
    return curId;
  }

  /**
   * @deprecated Use resolveTurn (a jobId) or resolveWorkerHead (a worker).
   * Kept for callers outside forge (channel tools/tasks): same as resolveTurn.
   */
  resolveHead(jobId: string): string {
    return this.resolveTurn(jobId);
  }

  private workerTurns(workerId: string): Array<{ jobId: string; manifest: ForgeManifest; turn: number }> {
    const index = this.workers.get(workerId);
    if (index === null) return [];
    const out: Array<{ jobId: string; manifest: ForgeManifest; turn: number }> = [];
    index.turns.forEach((jobId, pos) => {
      let m = this.readManifestRaw(jobId);
      if (m === null) return;
      if (m.status === 'running' && !this.live.has(jobId)) m = this.readManifestSync(jobId) ?? m;
      const turn = typeof m.turn === 'number' && Number.isInteger(m.turn) && m.turn >= 1 ? m.turn : pos + 1;
      out.push({ jobId, manifest: m, turn });
    });
    return out;
  }

  private turnLike(t: { jobId: string; manifest: ForgeManifest; turn: number }): TurnLike {
    return {
      jobId: t.jobId,
      status: t.manifest.status,
      turn: t.turn,
      supersededBy: t.manifest.supersededBy,
      followedBy: t.manifest.followedBy,
      startedAt: t.manifest.startedAt,
      createdAt: t.manifest.createdAt,
      updatedAt: t.manifest.updatedAt,
      hasSteerHead: readSteerHead(this.repo, t.jobId) !== null,
      acceptancePending: this.checksPending(t.jobId),
      pendingMessages: t.manifest.pendingSteers ?? 0,
    };
  }

  private workerHead(workerId: string): TurnLike | null {
    return pickHead(this.workerTurns(workerId).map((t) => this.turnLike(t)));
  }

  private workerHeadId(workerId: string): string | null {
    let turns = this.workerTurns(workerId);
    if (turns.length === 0) {
      this.workers.refresh();
      turns = this.workerTurns(workerId);
    }
    const head = pickHead(turns.map((t) => this.turnLike(t)));
    return head === null ? null : this.resolveTurn(head.jobId);
  }

  resolveWorkerHeadId(ref: string): string {
    const trimmed = ref.trim();
    if (trimmed === '') throw new WorkerLookupError('worker is empty; pass a worker name, workerId or jobId.', 'missing');
    this.rejectPipelineRun(trimmed);
    this.workers.refresh();
    if (this.isJobId(trimmed)) {
      const m = this.readManifestRaw(trimmed);
      const workerId = m?.workerId ?? trimmed;
      return this.workerHeadId(workerId) ?? this.resolveTurn(trimmed);
    }
    const byWorkerId = this.workerHeadId(trimmed);
    if (byWorkerId !== null) return byWorkerId;
    return this.resolveName(trimmed);
  }

  private resolveName(name: string): string {
    const workerIds = this.workers.workersNamed(name);
    const heads: Array<{ jobId: string; manifest: ForgeManifest; session: boolean; idle: boolean }> = [];
    for (const wid of workerIds) {
      const turns = this.workerTurns(wid);
      const head = pickHead(turns.map((t) => this.turnLike(t)));
      if (head === null) continue;
      const headId = this.resolveTurn(head.jobId);
      const manifest = this.readManifestSync(headId) ?? turns.find((t) => t.jobId === head.jobId)!.manifest;
      heads.push({ jobId: headId, manifest, session: turns.some((t) => this.spawnedIds.has(t.jobId)), idle: isWorkerIdle(head) });
    }
    if (heads.length === 0) throw new WorkerLookupError(this.notFound(name).message, 'missing');
    const startOf = (h: { manifest: ForgeManifest }): number => Date.parse(h.manifest.startedAt ?? h.manifest.createdAt ?? '') || 0;
    const latest = <T extends { manifest: ForgeManifest; jobId: string }>(xs: readonly T[]): T =>
      [...xs].sort((a, b) => startOf(b) - startOf(a) || b.jobId.localeCompare(a.jobId))[0]!;
    const running = heads.filter((h) => !h.idle);
    if (running.length === 1) return running[0]!.jobId;
    const pool = running.length > 1 ? running : heads;
    const session = pool.filter((h) => h.session);
    if (session.length > 0) return latest(session).jobId;
    if (pool.length === 1) return pool[0]!.jobId;
    const candidates = [...pool].sort((a, b) => startOf(b) - startOf(a)).map((h) =>
      isTerminalStatus(h.manifest.status)
        ? `${name} (${h.jobId}, finished ${h.manifest.finishedAt ?? h.manifest.updatedAt ?? 'unknown'})`
        : `${name} (${h.jobId}, ${h.manifest.status})`);
    throw new WorkerLookupError(
      `"${name}" matches ${pool.length} workers: ${candidates.join(', ')}; pass a jobId.`,
      'ambiguous',
      pool.map((h) => h.jobId),
    );
  }

  async resolveWorkerHead(nameOrWorkerIdOrJobId: string): Promise<JobDetail> {
    return this.resolveStableDetail(this.resolveWorkerHeadId(nameOrWorkerIdOrJobId));
  }

  async resolveWorkerTarget(nameOrId: string): Promise<{ detail: JobDetail; isWorker: boolean }> {
    const trimmed = nameOrId.trim();
    if (this.isJobId(trimmed)) {
      return { detail: await this.resolveStableDetail(this.resolveTurn(trimmed)), isWorker: false };
    }
    return { detail: await this.resolveWorkerHead(trimmed), isWorker: true };
  }

  async resolveWorker(nameOrId: string): Promise<JobDetail> {
    return (await this.resolveWorkerTarget(nameOrId)).detail;
  }

  private async resolveStableDetail(initialId: string): Promise<JobDetail> {
    const seen = new Set<string>();
    let id = initialId;
    while (true) {
      seen.add(id);
      const d = await this.numberedDetail(id);
      const next = d.supersededBy ?? this.resolveTurn(d.jobId);
      if (!next || next === d.jobId || seen.has(next)) return d;
      id = this.resolveTurn(next);
      if (seen.has(id)) return d;
    }
  }

  private async numberedDetail(jobId: string): Promise<JobDetail> {
    const d = await this.detail(jobId);
    const raw = this.readManifestRaw(jobId);
    if (raw === null || (typeof raw.turn === 'number' && raw.turn >= 1)) return d;
    const pos = this.workers.get(d.workerId)?.turns.indexOf(jobId) ?? -1;
    return pos >= 0 ? { ...d, turn: pos + 1 } : d;
  }

  async earlierTurns(headOrId: JobDetail | string, cap = 20): Promise<JobDetail[]> {
    const head = typeof headOrId === 'string' ? await this.resolveWorker(headOrId) : headOrId;
    if (cap <= 0) return [];
    let index = this.workers.get(head.workerId);
    if (index === null || !index.turns.includes(head.jobId)) {
      this.workers.refresh();
      index = this.workers.get(head.workerId);
    }
    if (index === null) return [];
    const pos = index.turns.indexOf(head.jobId);
    const before = pos >= 0 ? index.turns.slice(0, pos) : [];
    const wanted = before.slice(-cap);
    const offset = before.length - wanted.length;
    const out: JobDetail[] = [];
    for (let i = 0; i < wanted.length; i++) {
      const id = wanted[i]!;
      const d = await this.detail(id).catch(() => null);
      if (d === null) continue;
      const raw = this.readManifestRaw(id);
      const numbered = raw !== null && typeof raw.turn === 'number' && raw.turn >= 1;
      out.push(numbered ? d : { ...d, turn: offset + i + 1 });
    }
    return out;
  }

  private findActiveIdentity(name: string, workerId: string): TurnLike | null {
    const own = this.workerTurns(workerId).find((t) => t.manifest.status === 'running');
    if (own !== undefined) return this.turnLike(own);
    for (const wid of this.workers.workersNamed(name)) {
      if (wid === workerId) continue;
      const head = this.workerHead(wid);
      if (!isWorkerIdle(head)) return head;
    }
    return null;
  }

  async list(filter: ListFilter = {}): Promise<JobSummary[]> {
    for (const id of this.spawnedRuns) {
      for (const stage of Object.values(readPipeline(this.repo, id)?.stageResults ?? {})) {
        if (stage.jobId) this.spawnedIds.add(stage.jobId);
      }
    }
    const all = await this.readJobs();

    let pool = all;
    if (filter.ids !== undefined) {
      const matchedWorkers = new Set<string>();
      for (const j of all) {
        if (filter.ids.has(j.jobId) || filter.ids.has(j.workerId)) {
          matchedWorkers.add(j.workerId);
        }
      }
      pool = all.filter((j) => filter.ids!.has(j.jobId) || matchedWorkers.has(j.workerId));
    }

    const groupByWorker = filter.groupByWorker ?? true;
    let rows: JobSummary[];
    if (groupByWorker) {
      const byId = new Map<string, JobSummary>();
      const groups = new Map<string, JobSummary[]>();
      for (const j of pool) {
        byId.set(j.jobId, j);
        const list = groups.get(j.workerId);
        if (list !== undefined) list.push(j);
        else groups.set(j.workerId, [j]);
      }
      rows = [];
      for (const turns of groups.values()) {
        const sorted = [...turns].sort((a, b) =>
          compareTurnPriority(
            { ...a, hasSteerHead: readSteerHead(this.repo, a.jobId) !== null },
            { ...b, hasSteerHead: readSteerHead(this.repo, b.jobId) !== null },
          ),
        );
        let head = sorted[0]!;
        const liveHeadId = this.resolveTurn(head.jobId);
        if (liveHeadId && liveHeadId !== head.jobId) {
          const fromPool = byId.get(liveHeadId);
          if (fromPool !== undefined) {
            head = fromPool;
          } else {
            const observed = await readObservedJob(this.repo, liveHeadId);
            if (observed !== null) {
              const summary = toSummary(observed);
              const found = readAcceptance(this.repo, liveHeadId);
              const acceptance: Acceptance = 'checks' in found ? found : { state: 'unchecked', checks: [] };
              const meaningful = acceptance.state !== 'unchecked' || acceptance.pending === true || acceptance.checks.length > 0;
              head = meaningful ? { ...summary, acceptance } : summary;
            }
          }
        }
        rows.push(head);
      }
    } else {
      rows = pool;
    }

    const touched = (j: JobSummary): number => Date.parse(j.finishedAt ?? j.updatedAt ?? j.startedAt ?? '');
    const filtered = rows.filter((j) =>
      (filter.status === undefined || j.status === filter.status) &&
      (filter.sinceMs === undefined || touched(j) >= filter.sinceMs));
    filtered.sort((a, b) => {
      const rank = (s: ObservedJob['status']): number => (s === 'running' ? 0 : 1);
      const r = rank(a.status) - rank(b.status);
      if (r !== 0) return r;
      return (b.finishedAt ?? b.updatedAt ?? '').localeCompare(a.finishedAt ?? a.updatedAt ?? '');
    });
    const limit = filter.limit ?? 50;
    return filtered.slice(0, Math.max(1, limit));
  }

  async detail(jobId: string): Promise<JobDetail> {
    reconcileOrphan(this.repo, jobId);
    const observed = await readObservedJob(this.repo, jobId);
    if (observed === null) {
      throw this.notFound(jobId);
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
    try { manifest = readManifest(this.repo, jobId); } catch {}
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
      ...toSummary(observed),
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

  private async readJobs(): Promise<JobSummary[]> {
    const ids = await new AgentSmithReader().discover(this.repo);
    const out: JobSummary[] = [];
    for (const id of ids) {
      reconcileOrphan(this.repo, id);
      const observed = await readObservedJob(this.repo, id);
      if (observed === null) continue;
      const summary = toSummary(observed);
      const found = readAcceptance(this.repo, id);
      const acceptance: Acceptance = 'checks' in found ? found : { state: 'unchecked', checks: [] };
      const meaningful = acceptance.state !== 'unchecked' || acceptance.pending === true || acceptance.checks.length > 0;
      out.push(meaningful ? { ...summary, acceptance } : summary);
    }
    return out;
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export { pipelineRecordPath, writePipelineRecord } from './execute.ts';
