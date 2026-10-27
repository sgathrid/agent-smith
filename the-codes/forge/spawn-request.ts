/**
 * spawn-request.ts — what a caller may ask the forge for, and the pure checks on it.
 *
 * Nothing here touches the job directory or a live job: it is the request and
 * ack shapes, the timeout clamp, provider/mode validation and the model catalog
 * check. forge/service.ts owns everything that has state.
 */

import { findProvider, getProvider, providerNames } from '../providers/registry.ts';
import type { ModelCatalog, Provider } from '../providers/types.js';
import { MODE_PRESETS, MODES } from './modes.ts';
import type { BriefCheck } from './brief.ts';
import type { ModePreset } from './modes.ts';
import type { StartInput } from './writer.ts';
import { DEFAULT_TIMEOUT_MS, type ForgeManifest, type ForgeStatus, type SteerDelivery, type WatchedFileSigs } from './format.ts';

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
  /** Relative paths of brief/spec files in the repository to sync into cwd and monitor for stale reads. */
  readonly files?: readonly string[] | undefined;
  /** Prior watched file signatures when resuming a worker, so unchanged repo files do not overwrite worktree edits. */
  readonly previousWatchedFiles?: Readonly<Record<string, WatchedFileSigs>> | undefined;
  readonly pipeline?: string | undefined;
  readonly stage?: string | undefined;
  readonly attempt?: number | undefined;
  /** Persist a protocol handle after the job anchor exists, before any worker starts. */
  readonly onPrepared?: ((jobId: string) => void | Promise<void>) | undefined;
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

export interface SteerRequest {
  /** Active worker name or job ID. */
  readonly worker: string;
  readonly prompt: string;
  readonly context?: string | undefined;
  /** Relative paths of brief/spec files in the repository to sync into cwd on the steered turn. */
  readonly files?: readonly string[] | undefined;
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
  /**
   * Whether a resumable conversation handle was known when the steer was
   * accepted. When false, the continuation starts fresh if no handle arrives
   * before this turn ends.
   */
  readonly resumable: boolean;
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

/** The teaching error for a mode outside the closed set. */
export function modeError(mode: string): Error {
  const lines = MODES.map((m) => `  ${m}: ${MODE_PRESETS[m].description}`).join('\n');
  return new Error(
    `${mode === '' ? 'mode is required' : `unknown mode "${mode}"`}. Valid modes:\n${lines}`,
  );
}

const AGY_EFFORT_SUFFIX = /-(low|medium|high)$/;

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
 * What stays fixed across a job's steered turns. The pump chains a continuation
 * from this plus the new turn's prompt, so a worker's identity, posture and
 * model resolution are decided once, at spawn.
 */
export interface TurnSpec {
  jobId: string;
  name: string;
  workerId: string;
  task: string | undefined;
  mode: string;
  preset: ModePreset | undefined;
  context: string | undefined;
  checks: readonly BriefCheck[] | undefined;
  /** What the provider is sent for the first turn: the brief, if any, then the caller's prompt. */
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
}

/** The anchor one turn writes: the spec's fixed fields plus what differs per turn. */
export function turnStartInput(
  provider: string,
  spec: TurnSpec,
  turn: {
    /** The prompt as the caller wrote it, without the brief. */
    readonly prompt: string;
    /** The brief that was prepended, when one was. */
    readonly preamble: string | undefined;
    readonly preambleApplied: boolean;
    readonly conversation: string | null;
    readonly task: string | undefined;
    readonly watchedFiles: Readonly<Record<string, WatchedFileSigs>> | undefined;
    /** Set on a continuation: the turn it picks up from. */
    readonly steeredFrom?: string;
  },
): StartInput {
  return {
    name: spec.name,
    workerId: spec.workerId,
    task: turn.task,
    provider,
    mode: spec.mode,
    model: spec.model ?? null,
    effort: spec.effort ?? null,
    cwd: spec.cwd,
    prompt: turn.prompt,
    ...(turn.preamble === undefined ? {} : { preamble: turn.preamble }),
    unrestricted: spec.unrestricted,
    conversation: turn.conversation,
    timeoutMs: spec.timeoutMs,
    pipeline: spec.pipeline,
    stage: spec.stage,
    attempt: spec.attempt,
    modelRequested: spec.modelRequested,
    modelResolved: spec.modelResolved,
    modelSource: spec.modelSource,
    preambleApplied: turn.preambleApplied,
    sandbox: spec.sandbox,
    sandboxFlags: [...spec.sandboxFlags],
    readOnlyRequested: spec.readOnlyRequested,
    readOnlyEnforced: spec.readOnlyEnforced,
    ...(turn.steeredFrom === undefined ? {} : { steeredFrom: turn.steeredFrom }),
    ...(turn.watchedFiles === undefined ? {} : { watchedFiles: turn.watchedFiles }),
  };
}
