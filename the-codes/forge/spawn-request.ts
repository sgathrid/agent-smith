import { findProvider, getProvider, providerNames } from '../providers/registry.ts';
import type { ModelCatalog, Provider } from '../providers/types.js';
import { MODE_PRESETS, MODES } from './modes.ts';
import type { BriefCheck } from './brief.ts';
import type { ModePreset } from './modes.ts';
import type { StartInput } from './writer.ts';
import { DEFAULT_TIMEOUT_MS, type ContinuationKind, type LegacyContinuationKind, type ForgeManifest, type ForgeStatus, type TurnMessage, type WatchedFileSigs } from './format.ts';

export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 6 * 60 * 60_000;

export interface SpawnRequest {
  readonly name?: string;
  readonly task?: string;
  readonly workerId?: string;
  readonly turn?: number | undefined;
  readonly continuedFrom?: string | undefined;
  readonly continuationKind?: ContinuationKind | LegacyContinuationKind | undefined;
  readonly chainStartedAt?: string | undefined;
  readonly replacesParent?: boolean | undefined;
  readonly lockHeldByCaller?: boolean | undefined;
  readonly mode: string;
  readonly prompt: string;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly unrestricted?: boolean | undefined;
  readonly conversation?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly cwd?: string | undefined;
  readonly artifactPath?: string | undefined;
  readonly context?: string | undefined;
  readonly checks?: readonly BriefCheck[] | undefined;
  readonly files?: readonly string[] | undefined;
  readonly watchedFiles?: Readonly<Record<string, WatchedFileSigs>> | undefined;
  readonly notes?: readonly string[] | undefined;
  readonly pipeline?: string | undefined;
  readonly stage?: string | undefined;
  readonly attempt?: number | undefined;
  readonly onPrepared?: ((jobId: string) => void | Promise<void>) | undefined;
  readonly ownerChecks?: boolean | undefined;
  readonly messages?: readonly TurnMessage[] | undefined;
}

export interface SpawnAck {
  readonly jobId: string;
  readonly name: string;
  readonly workerId: string;
  readonly turn: number;
  readonly continuedFrom?: string;
  readonly continuationKind?: ContinuationKind;
  readonly chainStartedAt: string;
  readonly role: string;
  readonly provider: string;
  readonly status: ForgeStatus;
  readonly dir: string;
  readonly repo: string;
  readonly timeoutMs: number;
  readonly envKeys?: readonly string[];
  readonly unrestricted: boolean;
  readonly note: string;
  readonly sandbox: string;
  readonly sandboxFlags: readonly string[];
  readonly sandboxUnrestricted?: boolean;
  readonly readOnlyRequested: boolean;
  readonly readOnlyEnforced: boolean;
  readonly modelRequested: string | null;
  readonly modelResolved: string | null;
  readonly modelSource: 'requested' | 'harness-config' | 'reported' | 'unknown';
  readonly preambleApplied: boolean;
  readonly warnings?: readonly string[];
}

export interface TrackedSpawn {
  readonly ack: SpawnAck;
  readonly done: Promise<ForgeManifest>;
}

export interface MessageRequest {
  readonly worker: string;
  readonly prompt: string;
  readonly context?: string | undefined;
  readonly files?: readonly string[] | undefined;
}

export interface FollowUpRequest extends MessageRequest {
  readonly checks?: readonly BriefCheck[] | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly unrestricted?: boolean | undefined;
}

export interface SteerRequest extends MessageRequest {
  readonly allowFresh?: boolean | undefined;
}

export interface MessageAck {
  readonly jobId: string;
  readonly name: string;
  readonly workerId: string;
  readonly turn: number;
  readonly action: 'queued' | 'interrupting' | 'started';
  readonly delivery: 'next-step' | 'turn-end' | 'now';
  readonly status: 'running';
  readonly provider: string;
  readonly repo: string;
  readonly timeoutMs: number;
  readonly pendingMessages?: number;
  readonly env?: 'set' | 'kept' | 'dropped' | 'deferred';
  readonly envKeys?: readonly string[];
  readonly checks?: readonly string[];
  readonly warnings?: readonly string[];
  readonly note?: string;
}

export function resolveTimeoutMs(ms: number | undefined): number {
  if (ms === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new RangeError(`timeoutMs must be a positive finite number, got ${ms}`);
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(ms)));
}

export function requireProvider(name: string): Provider {
  if (findProvider(name) === undefined) {
    throw new Error(
      `unknown provider "${name}". Known providers: ${providerNames().join(', ')}.`,
    );
  }
  return getProvider(name);
}

export function modeError(mode: string): Error {
  const lines = MODES.map((m) => `  ${m}: ${MODE_PRESETS[m].description}`).join('\n');
  return new Error(
    `${mode === '' ? 'mode is required' : `unknown mode "${mode}"`}. Valid modes:\n${lines}`,
  );
}

export const ENV_KEYS_FILE = 'env-keys.json';
const AGY_EFFORT_SUFFIX = /-(low|medium|high)$/;

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
    const efforts = Array.isArray(target?.efforts) ? target!.efforts : [];
    if (target !== undefined && efforts.length > 0 && !efforts.includes(effort)) {
      throw new Error(
        `effort "${effort}" is not valid for ${provider} model "${target.id}". Valid efforts: ${efforts.join(', ')}.`,
      );
    }
  }
  return warnings;
}

export async function validateModelAndEffort(
  provider: Provider,
  model: string | undefined,
  effort: string | undefined,
  getCatalog?: () => Promise<ModelCatalog | undefined>,
  unrestricted?: boolean,
): Promise<{ effort: string | undefined; warnings: string[] }> {
  const warnings: string[] = [];
  if (unrestricted === false && provider.defaultUnrestricted === 'always') {
    warnings.push(
      `${provider.name} print mode force-sets the auto permission policy; unrestricted:false cannot restrict it. The ack and job.json record the effective posture.`,
    );
  }
  const effectiveEffort = provider.supportsEffort === false ? undefined : effort;
  if (effort !== undefined && provider.supportsEffort === false) {
    warnings.push(
      `${provider.name} has no per-run effort flag; effort "${effort}" was ignored.`,
    );
  }
  if ((model !== undefined || effectiveEffort !== undefined) && getCatalog !== undefined) {
    warnings.push(...checkAgainstCatalog(provider.name, model, effectiveEffort, await getCatalog()));
  }
  return { effort: effectiveEffort, warnings };
}

export interface TurnSpec {
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
  env: Readonly<Record<string, string>> | undefined;
  pipeline: string | null;
  stage: string | null;
  attempt: number | null;
  onPrepared: ((jobId: string) => void) | undefined;
  ownerChecks: boolean;
}

export function turnStartInput(
  provider: string,
  spec: TurnSpec,
  turn: {
    readonly prompt: string;
    readonly preamble: string | undefined;
    readonly preambleApplied: boolean;
    readonly conversation: string | null;
    readonly task: string | undefined;
    readonly watchedFiles: Readonly<Record<string, WatchedFileSigs>> | undefined;
    readonly turn?: number | undefined;
    readonly continuedFrom?: string | undefined;
    readonly continuationKind?: ContinuationKind | undefined;
    readonly chainStartedAt?: string | undefined;
    readonly messages?: readonly TurnMessage[] | undefined;
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
    ...(turn.turn === undefined ? {} : { turn: turn.turn }),
    ...(turn.continuedFrom === undefined ? {} : { continuedFrom: turn.continuedFrom }),
    ...(turn.continuationKind === undefined ? {} : { continuationKind: turn.continuationKind }),
    ...(turn.chainStartedAt === undefined ? {} : { chainStartedAt: turn.chainStartedAt }),
    ...(turn.watchedFiles === undefined ? {} : { watchedFiles: turn.watchedFiles }),
    ...(turn.messages !== undefined && turn.messages.length > 0 ? { messages: turn.messages } : {}),
  };
}
