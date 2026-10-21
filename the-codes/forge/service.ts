/**
 * service.ts — the composition root that can START a worker.
 *
 * This is the file the repo was missing. Until now:
 *   - providers/ (3,643 lines) was never imported by anything
 *   - pipeline/ had no StageRunner
 *   - core/store.ts was unused
 *   - surfaces/mod read somebody else's state and could not create any
 *
 * This module wires those together and answers four questions: spawn a job, list
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
 * SAFETY: --dangerously-skip-permissions IS OFF BY DEFAULT (EXCEPT FOR agy)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `SpawnSpec.unrestricted` is a required field and this module defaults it to
 * `false`. It has to: agy runs headless and CANNOT prompt for tool permission, so
 * in the default mode a denied tool is auto-denied, agy reports status "SUCCESS",
 * returns an empty response and exits 0 (verified live — see providers/agy.ts,
 * THE TRAP). Passing the flag by default would be "safe" for the job and
 * dangerous for the user, and the whole point of this repo is that we never
 * quietly choose for them. The one exception is agy, where restricted mode just
 * fails silently, so it defaults to unrestricted (pass unrestricted:false or set
 * AGENT_SMITH_AGY_RESTRICTED=1 to opt out). Everything else is opt-in, per call. It is recorded in
 * job.json as `unrestricted: true` so nobody has to guess later.
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

import { humanDuration } from '../providers/failure-text.ts';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { AgentSmithReader, SMITH_PAYLOAD } from '../harness/agent-smith.ts';
import { AgyStaffReader } from '../harness/agy-staff.ts';
import { readObservedJob } from '../harness/registry.ts';
import type { JobStateReader, ObservedJob } from '../harness/types.ts';
import { findProvider, getProvider, providerNames } from '../providers/registry.ts';
import { getCatalogs, getHarnessDefaults } from '../providers/catalog.ts';
import type {
  JobResult,
  ModelCatalog,
  Provider,
  SandboxInfo,
  SpawnSpec,
  WorkerHandle,
} from '../providers/types.js';
import { isMode, MODE_PRESETS, MODES, type ModePreset } from './modes.ts';
import { buildBrief, type BriefCheck } from './brief.ts';
import {
  DEFAULT_TIMEOUT_MS,
  deriveStatus,
  FILES,
  isForgeJobId,
  isPidAlive,
  jobDir,
  jobFile,
  jobsDir,
  newJobId,
  type ForgeActivity,
  type ForgeManifest,
  type ForgeStatus,
  type SteerDelivery,
  type SteerEntry,
  nextActionFor,
} from './format.ts';
import { reconcileOrphan } from './reconcile.ts';
import { JobWriter, pipeEvents, reportFor } from './writer.ts';
import { writeAtomic, writeJsonAtomic } from './atomic.ts';

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

/** Floor and ceiling on a caller-supplied timeout. */
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 6 * 60 * 60_000;

export interface SpawnRequest {
  readonly name?: string;
  readonly task?: string;
  readonly workerId?: string;
  /** Stage/role name. Becomes part of the job id and the pane's task context. */
  readonly mode: string;
  readonly prompt: string;
  /** Defaults to 'agy': the cheapest verified adapter, and the one we tested. */
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /**
   * Opt in to bypassing tool-approval prompts. FALSE unless you say otherwise.
   * See the header: in headless agy the denied path is a silent no-op, so this is
   * the difference between a job that works and a job that reports success and
   * did nothing.
   */
  readonly unrestricted?: boolean | undefined;
  /** Resume a prior conversation. Providers that cannot resume ignore this. */
  readonly conversation?: string | undefined;
  /** Overrides the repo root. Only pipeline stages set this. */
  readonly cwd?: string | undefined;
  /**
   * Absolute path of the output artifact a pipeline stage writes. A read-only job
   * may write exactly this file (claude, codex). Solo spawns leave it unset.
   */
  readonly artifactPath?: string | undefined;
  /** Why the work matters and who it is for. Shown to the worker in its brief. */
  readonly context?: string | undefined;
  /**
   * The acceptance checks, as the worker's brief describes them. The service
   * never runs these: spawn_job (tools.ts) and the pipeline runner gate
   * acceptance themselves. This is only so the worker knows its bar.
   */
  readonly checks?: readonly BriefCheck[] | undefined;
  readonly pipeline?: string | undefined;
  readonly stage?: string | undefined;
  readonly attempt?: number | undefined;
  /** Persist a protocol handle after the job anchor exists, before any worker starts. */
  readonly onPrepared?: ((jobId: string) => void) | undefined;
}

/** What spawn_job returns. Immediate, and always truthful. */
export interface SpawnAck {
  readonly jobId: string;
  readonly name: string;
  readonly workerId: string;
  readonly role: string;
  readonly provider: string;
  /** Always 'running' at ack time; read `status` later. */
  readonly status: ForgeStatus;
  /** Absolute path of the job directory. The anchor is already on disk. */
  readonly dir: string;
  readonly repo: string;
  /** The budget the job actually got, after clamping. */
  readonly timeoutMs: number;
  /** True only when the caller asked for it AND we passed it. */
  readonly unrestricted: boolean;
  /** One sentence an operator can act on. */
  readonly note: string;
  /** Effective sandbox posture reported by the provider ('unknown' when it cannot say). */
  readonly sandbox: string;
  readonly sandboxFlags: readonly string[];
  /** Whether the mode asked for read-only (false when unrestricted). */
  readonly readOnlyRequested: boolean;
  /** Whether the provider's CLI actually enforces that request. */
  readonly readOnlyEnforced: boolean;
  readonly modelRequested: string | null;
  readonly modelResolved: string | null;
  readonly modelSource: 'requested' | 'harness-config' | 'reported' | 'unknown';
  /** True when the worker's prompt starts with the brief (forge/brief.ts). */
  readonly preambleApplied: boolean;
  /** Non-fatal problems the caller should read. Omitted when none. */
  readonly warnings?: readonly string[];
}

/** A spawn plus the promise of its terminal manifest. Used by the pipeline runner. */
export interface TrackedSpawn {
  readonly ack: SpawnAck;
  readonly done: Promise<ForgeManifest>;
}

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
}

export interface CancelResult {
  readonly jobId: string;
  readonly requested: boolean;
  /** True when a live worker in THIS process was actually signalled. */
  readonly signalled: boolean;
  readonly note: string;
}

export interface SteerRequest {
  /** Active worker name or job ID. */
  readonly worker: string;
  readonly prompt: string;
  readonly context?: string | undefined;
  /** Required delivery mode: 'queue' (run after current turn) or 'interrupt' (stop current turn now and continue). */
  readonly delivery: SteerDelivery;
}

export interface SteerAck {
  /** Currently active job ID that received the steer. */
  readonly jobId: string;
  readonly name: string;
  readonly workerId: string;
  readonly provider: string;
  readonly delivery: SteerDelivery;
  readonly status: 'queued' | 'interrupting';
  readonly pendingSteers: number;
  readonly signalled: boolean;
  readonly repo: string;
  readonly dir: string;
  readonly timeoutMs: number;
  readonly note: string;
}

/**
 * Clamp a timeout into the range we are willing to enforce. Pure; unit-tested.
 *
 * ZERO IS "UNSET", NOT "NO TIMEOUT", and that is a deliberate reading of an
 * otherwise ambiguous value. `SpawnSpec.timeoutMs: 0` means "do not arm the timer"
 * to providers/ndjson.ts, so a caller passing 0 would otherwise get an unbounded
 * job whose only kill path is an operator who happens to be watching. And a
 * pipeline stage that does not name a timeout — which is every stage in
 * ARCHITECTURE.md's own example — would have no budget at all.
 *
 * So 0 resolves to the default, exactly like an absent value. Anyone who genuinely
 * wants a very long job passes MAX_TIMEOUT_MS and says so out loud.
 */
export function clampTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(ms)));
}

/**
 * The word to put in a SpawnSpec for a provider that is not installed.
 *
 * Throwing rather than defaulting: `getProvider` on an unknown name is a typo in
 * a stage config, and a typo that silently runs zero workers and reports green is
 * the exact failure class this codebase is organised against. A KNOWN provider
 * whose binary is missing is different — that becomes a `failed` job with the
 * ENOENT in it, which is a report an operator can act on.
 */
export function requireProvider(name: string): Provider {
  if (findProvider(name) === undefined) {
    throw new Error(
      `unknown provider "${name}". Known providers: ${providerNames().join(', ')}.`,
    );
  }
  return getProvider(name);
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

const STEER_CONVERSATION_WAIT_MS = 2_000;

export interface ForgeOptions {
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

/** The teaching error for a mode outside the closed set. */
export function modeError(mode: string): Error {
  const lines = MODES.map((m) => `  ${m}: ${MODE_PRESETS[m].description}`).join('\n');
  return new Error(
    `${mode === '' ? 'mode is required' : `unknown mode "${mode}"`}. Valid modes:\n${lines}`,
  );
}

const AGY_EFFORT_SUFFIX = /-(low|medium|high)$/;
const CATALOG_WAIT_MS = 2_000;

/**
 * Check model/effort against a catalog. Pure. Throws only when the catalog is
 * fresh and nonempty AND positively says the value is wrong; otherwise warns.
 */
export function checkAgainstCatalog(
  provider: string,
  model: string | undefined,
  effort: string | undefined,
  catalog: ModelCatalog | undefined,
): string[] {
  const warnings: string[] = [];
  if (model === undefined && effort === undefined) return warnings;
  const fresh =
    catalog !== undefined &&
    !catalog.stale &&
    catalog.error === undefined &&
    catalog.verified !== false &&
    catalog.source !== 'static' &&
    catalog.models.length > 0;
  if (!fresh) {
    const why =
      catalog === undefined
        ? 'no catalog available'
        : catalog.error !== undefined
          ? `catalog error: ${catalog.error}`
          : catalog.stale
            ? 'catalog is stale'
            : catalog.models.length === 0
              ? 'catalog is empty'
              : catalog.source === 'static'
                ? 'catalog is a static alias list; full model names are also valid'
                : 'catalog is unverified';
    warnings.push(
      `could not verify ${[model === undefined ? '' : `model "${model}"`, effort === undefined ? '' : `effort "${effort}"`].filter(Boolean).join(' / ')} for ${provider} (${why}); passing it through unchecked.`,
    );
    return warnings;
  }
  const ids = catalog.models.map((m) => m.id);
  let match = model === undefined ? undefined : catalog.models.find((m) => m.id === model);
  if (model !== undefined && match === undefined && provider === 'agy') {
    const base = model.replace(AGY_EFFORT_SUFFIX, '');
    if (base !== model) match = catalog.models.find((m) => m.id === base);
  }
  if (model !== undefined && match === undefined) {
    throw new Error(`unknown model "${model}" for ${provider}. Valid model ids: ${ids.join(', ')}.`);
  }
  if (effort !== undefined) {
    const target = match ?? (catalog.defaultModel === undefined ? undefined : catalog.models.find((m) => m.id === catalog.defaultModel));
    if (target !== undefined && target.efforts.length > 0 && !target.efforts.includes(effort)) {
      throw new Error(
        `effort "${effort}" is not valid for ${provider} model "${target.id}". Valid efforts: ${target.efforts.join(', ')}.`,
      );
    }
  }
  return warnings;
}

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
  private readonly live = new Map<string, LiveJob>();
  /** Job IDs spawned by this process, for `list_jobs session`. */
  readonly spawnedIds = new Set<string>();
  private readonly mirrorOn: boolean;
  private readonly flushMs: number | undefined;
  private readonly catalogSource: (providers: string[]) => Promise<ModelCatalog[]>;
  private readonly harnessDefaults: (provider: string) => { model?: string; effort?: string };
  private readonly providerSource: (name: string) => Provider;
  private readonly describeSandbox: NonNullable<ForgeOptions['describeSandbox']>;

  constructor(options: ForgeOptions) {
    this.repo = options.repo;
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
    // agy cannot prompt headless, so restricted means silent denial: default it on. Explicit false (or AGENT_SMITH_AGY_RESTRICTED=1) opts out.
    const unrestricted = request.unrestricted ?? (provider.name === 'agy' && process.env['AGENT_SMITH_AGY_RESTRICTED'] !== '1');
    const warnings: string[] = [];
    if (request.model !== undefined || request.effort !== undefined) {
      warnings.push(
        ...checkAgainstCatalog(provider.name, request.model, request.effort, await this.catalogFor(provider.name)),
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
    const canonicalConflict = findActiveIdentity(this.repo, name, workerId);
    if (canonicalConflict !== null) {
      throw new Error(`"${name}" is busy (${canonicalConflict.jobId}); wait, cancel, or use another name.`);
    }
    for (const { writer } of this.live.values()) {
      const active = writer.snapshot();
      if (active?.workerId === workerId) {
        throw new Error(`"${name}" is busy (${active.jobId}); wait, cancel, or use another name.`);
      }
      if (active?.name === name) {
        throw new Error(`"${name}" is busy (${active.jobId}); wait, cancel, or use another name.`);
      }
    }

    const writer = new JobWriter({
      repo: this.repo,
      jobId,
      mirror: this.mirrorOn,
      ...(this.flushMs === undefined ? {} : { flushMs: this.flushMs }),
    });

    // Anchor first. Everything after this point can fail loudly; nothing after
    // this point can make the job invisible.
    writer.start({
      name,
      workerId,
      task: request.task,
      provider: provider.name,
      mode,
      model: request.model ?? null,
      effort: request.effort ?? null,
      cwd,
      prompt,
      // Exactly what was prepended, so the /forge pane's "Show preamble" matches what the worker read.
      ...(prependBrief ? { preamble: brief } : {}),
      unrestricted,
      conversation: request.conversation ?? null,
      timeoutMs,
      pipeline: request.pipeline ?? null,
      stage: request.stage ?? null,
      attempt: request.attempt ?? null,
      modelRequested: request.model ?? null,
      modelResolved,
      modelSource,
      preambleApplied,
      sandbox,
      sandboxFlags: [...sandboxFlags],
      readOnlyRequested,
      readOnlyEnforced,
    });
    try {
      request.onPrepared?.(jobId);
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
        `queued · ${humanDuration(timeoutMs)} limit · ${unrestricted ? 'unrestricted' : 'approvals on'}`,
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

    const done = this.pump(writer, provider, {
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
      effort: request.effort,
      timeoutMs,
      unrestricted,
      conversation: request.conversation,
      pipeline: request.pipeline ?? null,
      stage: request.stage ?? null,
      attempt: request.attempt ?? null,
      onPrepared: request.onPrepared,
    });

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
    spec: {
      jobId: string;
      name: string;
      workerId: string;
      task: string | undefined;
      mode: string;
      preset: ModePreset | undefined;
      context: string | undefined;
      checks: readonly BriefCheck[] | undefined;
      prompt: string;
      readOnlyRequested: boolean;
      readOnlyEnforced: boolean;
      sandbox: string;
      sandboxFlags: readonly string[];
      artifactPath: string | undefined;
      cwd: string;
      model: string | undefined;
      modelRequested: string | null;
      modelResolved: string | null;
      modelSource: SpawnAck['modelSource'];
      effort: string | undefined;
      timeoutMs: number;
      unrestricted: boolean;
      conversation: string | undefined;
      pipeline: string | null;
      stage: string | null;
      attempt: number | null;
      onPrepared: ((jobId: string) => void) | undefined;
    },
  ): Promise<ForgeManifest> {
    let currentWriter = initialWriter;
    let currentJobId = spec.jobId;
    let currentPrompt = spec.prompt;
    let currentConversation = spec.conversation;
    let liveEntry: LiveJob = {
      writer: currentWriter,
      handle: null,
      timeoutMs: spec.timeoutMs,
      consumedSteers: 0,
      interruptRequested: false,
      interruptFired: false,
      userCanceled: false,
    };
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
          stateDir: writerDir(this.repo, currentJobId),
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

      const syncSteerAndCancel = (): void => {
        if ( !liveEntry.interruptFired && existsSync(jobFile(this.repo, currentJobId, FILES.cancel))
          && !existsSync(jobFile(this.repo, currentJobId, FILES.cancelSteer)) ) {
          liveEntry.userCanceled = true;
        }
        if (liveEntry.userCanceled) {
          if (!liveEntry.interruptFired) {
            liveEntry.interruptFired = true;
            currentWriter.requestCancel();
            handle.cancel();
          }
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
            currentWriter.requestCancel();
            handle.cancel();
          }
        }
      };

      const unsubSteerTap = handle.onEvent((ev) => {
        if (ev.kind === 'started' && liveEntry.interruptRequested && !liveEntry.interruptFired) {
          syncSteerAndCancel();
        }
      });

      syncSteerAndCancel();
      const cancelPoll = setInterval(syncSteerAndCancel, 100);
      cancelPoll.unref?.();

      try {
        const result: JobResult = await handle.waitForResult();
        clearInterval(cancelPoll);
        unsubSteerTap();
        unsubscribe();

        await currentWriter.prepareFinish();
        const report = reportFor(result);

        syncSteerAndCancel();
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

        if (shouldChain) {
          const conversation = currentWriter.currentConversation();
          const wasInterrupted = liveEntry.interruptRequested && verdict.status !== 'succeeded';
          if (conversation === null && !wasInterrupted) {
            currentWriter.warn('could not steer: provider did not report a resumable conversation ID');
          } else {
            liveEntry.consumedSteers = entries.length;
            const nextJobId = newJobId(spec.mode);
            const nextWriter = new JobWriter({
              repo: this.repo,
              jobId: nextJobId,
              mirror: this.mirrorOn,
              ...(this.flushMs === undefined ? {} : { flushMs: this.flushMs }),
            });
            const latestContext = [...unconsumed].reverse().find((e) => e.context !== undefined)?.context ?? spec.context;
            const resuming = conversation !== null;
            const nextBrief = buildBrief({
              preset: spec.preset,
              cwd: spec.cwd,
              context: latestContext,
              checks: spec.checks,
              pipelineStage: spec.pipeline !== null,
              resuming,
            });
            const { rawPrompt, sentPrompt, prependBrief } = buildSteeredPrompt({
              parentJobId: currentJobId,
              wasInterrupted,
              freshContinuation: !resuming,
              toolCalls: currentWriter.snapshot()?.toolCalls ?? 0,
              responseTail: result.response.trim().slice(-600),
              entries: unconsumed,
              brief: nextBrief,
            });
            const nextLiveEntry: LiveJob = {
              writer: nextWriter,
              handle: null,
              timeoutMs: spec.timeoutMs,
              consumedSteers: 0,
              interruptRequested: false,
              interruptFired: false,
              userCanceled: false,
            };

            // 1. Open child anchor on disk BEFORE finishing the parent so any reader
            //    following `supersededBy` finds the child anchor immediately.
            nextWriter.start({
              name: spec.name,
              workerId: spec.workerId,
              task: spec.task,
              provider: provider.name,
              mode: spec.mode,
              model: spec.model ?? null,
              effort: spec.effort ?? null,
              cwd: spec.cwd,
              prompt: rawPrompt,
              ...(prependBrief ? { preamble: nextBrief } : {}),
              unrestricted: spec.unrestricted,
              conversation,
              timeoutMs: spec.timeoutMs,
              pipeline: spec.pipeline,
              stage: spec.stage,
              attempt: spec.attempt,
              modelRequested: spec.modelRequested,
              modelResolved: spec.modelResolved,
              modelSource: spec.modelSource,
              preambleApplied: nextBrief !== '',
              sandbox: spec.sandbox,
              sandboxFlags: [...spec.sandboxFlags],
              readOnlyRequested: spec.readOnlyRequested,
              readOnlyEnforced: spec.readOnlyEnforced,
              steeredFrom: currentJobId,
            });

            // 2. Register child in spawnedIds and live map before removing parent.
            this.spawnedIds.add(nextJobId);
            this.live.set(nextJobId, nextLiveEntry);
            try {
              spec.onPrepared?.(nextJobId);
            } catch { /* best-effort callback for continuation turn */ }

            // 3. Stamp supersededBy on parent and write parent's terminal manifest atomically.
            currentWriter.markSuperseded(nextJobId);
            currentWriter.finish(result, report === '' ? null : report);
            this.live.delete(currentJobId);

            currentWriter = nextWriter;
            currentJobId = nextJobId;
            currentPrompt = sentPrompt;
            currentConversation = conversation ?? undefined;
            liveEntry = nextLiveEntry;
            continue;
          }
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
    const live = this.live.get(jobId);
    const writer =
      live?.writer ??
      new JobWriter({
        repo: this.repo,
        jobId,
        mirror: this.mirrorOn,
        ...(this.flushMs === undefined ? {} : { flushMs: this.flushMs }),
      });

    const known = live !== undefined || existsSync(jobDir(this.repo, jobId));
    if (!known) {
      throw new Error(`no job "${jobId}" in ${jobsDir(this.repo)}; call list_jobs for valid job IDs.`);
    }

    try {
      unlinkSync(jobFile(this.repo, jobId, FILES.cancelSteer));
    } catch { /* no steer marker present */ }
    writer.requestCancel();

    if (live === undefined) {
      return {
        jobId,
        requested: true,
        signalled: false,
        note: 'Cancel recorded; no live worker here, so the job may stay running.',
      };
    }

    live.userCanceled = true;
    live.handle?.cancel();
    return {
      jobId,
      requested: true,
      signalled: true,
      note: 'Canceled.',
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
    if (target.manifest.pipeline !== null && target.manifest.pipeline !== undefined) {
      throw new Error(
        `Cannot steer pipeline stage "${target.manifest.name}" (${target.jobId}); pipeline stages are managed by run_pipeline.`,
      );
    }
    if (target.manifest.status !== 'running') {
      throw new Error(
        `"${target.manifest.name}" (${target.jobId}) is already ${target.manifest.status}; use resume_job to continue a finished worker.`,
      );
    }

    const live = this.live.get(target.jobId);
    if (live === undefined) {
      const ownerPid = target.manifest.ownerPid;
      const ownerAlive =
        typeof ownerPid === 'number' &&
        Number.isInteger(ownerPid) &&
        ownerPid > 0 &&
        isPidAlive(ownerPid);
      if (!ownerAlive) {
        reconcileOrphan(this.repo, target.jobId);
        throw new Error(
          `"${target.manifest.name}" (${target.jobId}) has no live owner process; it cannot be steered. Use resume_job to continue it.`,
        );
      }
    }

    const at = new Date().toISOString();
    const entry: SteerEntry = {
      id: `steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: at,
      prompt,
      ...(request.context === undefined ? {} : { context: request.context }),
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
          live.writer.requestCancel(at);
          live.handle.cancel();
        }
      }
    }

    const signalled = live !== undefined;
    const status = request.delivery === 'interrupt' ? 'interrupting' : 'queued';
    const note =
      request.delivery === 'interrupt'
        ? signalled
          ? 'Interrupting current turn; continuation turn will start automatically.'
          : 'Interrupt recorded for owner process; continuation turn will start after current turn stops.'
        : `Queued behind current turn (${pendingSteers} pending).`;

    return {
      jobId: target.jobId,
      name: target.manifest.name ?? target.jobId,
      workerId: target.manifest.workerId ?? target.jobId,
      provider: target.manifest.provider,
      delivery: request.delivery,
      status,
      pendingSteers,
      signalled,
      repo: this.repo,
      dir: jobDir(this.repo, target.jobId),
      timeoutMs: live?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      note,
    };
  }

  private async resolveSteerTarget(worker: string): Promise<{ jobId: string; manifest: ForgeManifest }> {
    const trimmed = worker.trim();
    if (existsSync(pipelineRecordPath(this.repo, trimmed))) {
      throw new Error(`Cannot steer pipeline run "${trimmed}"; steer_job only applies to solo workers.`);
    }

    const readManifest = (id: string): ForgeManifest | null => {
      const inMem = this.live.get(id)?.writer.snapshot();
      if (inMem !== null && inMem !== undefined) return inMem;
      reconcileOrphan(this.repo, id);
      try {
        return JSON.parse(readFileSync(jobFile(this.repo, id, FILES.job), 'utf8')) as ForgeManifest;
      } catch {
        return null;
      }
    };

    const followChain = (startId: string): { jobId: string; manifest: ForgeManifest } | null => {
      const seen = new Set<string>();
      let curId = startId;
      let curManifest = readManifest(curId);
      if (curManifest === null) return null;
      while (curManifest.supersededBy && !seen.has(curId)) {
        seen.add(curId);
        const nextManifest = readManifest(curManifest.supersededBy);
        if (nextManifest === null) break;
        curId = curManifest.supersededBy;
        curManifest = nextManifest;
      }
      return { jobId: curId, manifest: curManifest };
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

  /** Jobs the pane would draw. Ours by default; interop history on request. */
  async list(filter: ListFilter = {}): Promise<JobSummary[]> {
    const source = filter.provider ?? 'agent-smith';
    const out: JobSummary[] = [];

    if (source === 'agent-smith' || source === 'all') {
      out.push(...(await this.readSource('agent-smith', new AgentSmithReader())));
    }
    if (source === 'agy-staff' || source === 'all') {
      // The interop source. Our own ids are filtered out because the compat
      // mirror makes them visible there too, and one job must have one verdict —
      // see harness/registry.ts for the same rule applied to the registry sweep.
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
    try { manifest = JSON.parse(readFileSync(jobFile(this.repo, jobId, FILES.job), 'utf8')) as ForgeManifest; } catch { /* partial state */ }
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
          }),
      cancellable: this.live.has(jobId),
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
      return s === 'running' || s === 'succeeded' || s === 'failed' || s === 'canceled' ? s : 'unknown';
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
      out.push(toSummary(observed, provider === 'agent-smith' ? 'agent-smith' : 'agy-staff'));
    }
    return out;
  }
}

/* ── pure helpers ───────────────────────────────────────────────────────── */

/** Project an ObservedJob onto what a list actually needs. */
export function toSummary(observed: ObservedJob, source: 'agent-smith' | 'agy-staff'): JobSummary {
  const raw = observed.raw;
  const toolCalls = typeof raw['tool_calls'] === 'number' ? raw['tool_calls'] : null;
  const task = typeof raw['task'] === 'string' && raw['task'] !== '' ? raw['task'] : null;
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
  };
}

function appendSteerEntry(repo: string, jobId: string, entry: SteerEntry): void {
  const dir = jobDir(repo, jobId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(jobFile(repo, jobId, FILES.steer), `${JSON.stringify(entry)}\n`, 'utf8');
}

function readSteerEntries(repo: string, jobId: string): SteerEntry[] {
  const file = jobFile(repo, jobId, FILES.steer);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: SteerEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<SteerEntry>;
      if (
        typeof parsed.id === 'string' &&
        typeof parsed.createdAt === 'string' &&
        typeof parsed.prompt === 'string' &&
        (parsed.delivery === 'queue' || parsed.delivery === 'interrupt')
      ) {
        out.push(parsed as SteerEntry);
      }
    } catch { /* ignore truncated line */ }
  }
  return out;
}

function buildSteeredPrompt(input: {
  parentJobId: string;
  wasInterrupted: boolean;
  freshContinuation?: boolean;
  toolCalls: number;
  responseTail: string;
  entries: readonly SteerEntry[];
  brief: string;
}): { rawPrompt: string; sentPrompt: string; prependBrief: boolean } {
  const steerBody =
    input.entries.length === 1
      ? input.entries[0]!.prompt
      : input.entries.map((e, idx) => `[Steer ${idx + 1} (${e.createdAt})]\n${e.prompt}`).join('\n\n');
  const tag = input.freshContinuation
    ? '[FRESH CONTINUATION]'
    : input.wasInterrupted
      ? '[TURN INTERRUPTED]'
      : `[FOLLOW-UP STEER · ${input.entries.length} queued update${input.entries.length === 1 ? '' : 's'}]`;
  const statusLine = input.wasInterrupted
    ? `Your previous turn (${input.parentJobId}) was interrupted after ${input.toolCalls} tool call(s) with updated instructions from the orchestrator. Inspect your working tree before repeating any completed steps.`
    : `Your previous turn (${input.parentJobId}) completed after ${input.toolCalls} tool call(s), and the orchestrator queued follow-up instructions for you.`;
  const tailBlock = input.responseTail
    ? `\nLast response excerpt from previous turn:\n${input.responseTail}\n`
    : '';
  const header = `[STEERED TURN CONTINUITY] ${tag}\n${statusLine}${tailBlock}\n[ORCHESTRATOR UPDATE]\n${steerBody}`;
  const prependBrief = input.brief !== '' && !header.startsWith(input.brief);
  const sentPrompt = prependBrief ? `${input.brief}\n\n${header}` : header;
  return { rawPrompt: header, sentPrompt, prependBrief };
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

function findActiveIdentity(repo: string, name: string, workerId: string): ForgeManifest | null {
  let entries: string[];
  try { entries = readdirSync(jobsDir(repo)); } catch { return null; }
  for (const id of entries) {
    let manifest: ForgeManifest;
    try { manifest = JSON.parse(readFileSync(jobFile(repo, id, FILES.job), 'utf8')) as ForgeManifest; } catch { continue; }
    if (manifest.status !== 'running') continue;
    if (manifest.workerId === workerId || manifest.name === name) return manifest;
  }
  return null;
}

/** The job directory, as the provider adapters are told to use it. */
function writerDir(repo: string, jobId: string): string {
  return jobDir(repo, jobId);
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/* ── pipeline run records ────────────────────────────────────────────────── */

/**
 * Where a finished PipelineRun is written.
 *
 * A pipeline outlives the MCP call that started it and usually outlives the
 * process too, so the run summary has to be a file. It sits beside the jobs,
 * not inside one: a run is not a job, and pretending otherwise would put a second
 * verdict for the same work into the pane.
 */
export function pipelineRecordPath(repo: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'pipeline';
  return path.join(repo, '.agent-smith', 'pipelines', `${safe}.json`);
}

export function writePipelineRecord(repo: string, name: string, value: unknown): void {
  writeJsonAtomic(pipelineRecordPath(repo, name), value);
}

export { humanDuration };
