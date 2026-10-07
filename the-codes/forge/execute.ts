/** Shared pipeline lifecycle for MCP and the optional local CLI. */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { PipelineRun, PipelineSpec, StageResult } from '../pipeline/types.ts';
import { runPipeline } from '../pipeline/pipeline.ts';
import type { ProviderLadder } from '../pipeline/routing.ts';
import { providerNames } from '../providers/registry.ts';
import { createMarker, writeJsonAtomic } from './atomic.ts';
import { createForgeRunner } from './runner.ts';
import type { ForgeService } from './service.ts';
import { pipelineRecordPath } from './service.ts';

export interface StartPipelineOptions {
  readonly runId?: string | undefined;
  readonly unrestricted?: boolean | undefined;
  readonly concurrency?: number | undefined;
  readonly ladders?: Readonly<Record<string, ProviderLadder>> | undefined;
  /** Adopt the matching running record prepared by a detached supervisor parent. */
  readonly adoptExisting?: boolean | undefined;
}

export interface PipelineRecord {
  readonly runId: string;
  readonly pipeline: string;
  readonly status: 'running' | 'passed' | 'partial' | 'failed';
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly stageResults: Readonly<Record<string, StageResult>>;
  readonly error?: string | undefined;
}

export interface StartedPipeline {
  readonly runId: string;
  readonly recordPath: string;
  readonly done: Promise<PipelineRun>;
  cancel(): void;
}

function safeRunId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100) || 'pipeline';
}

export function pipelineCancelPath(repo: string, runId: string): string {
  return path.join(repo, '.agent-smith', 'pipelines', `${safeRunId(runId)}.cancel`);
}

export function readPipeline(repo: string, runId: string): PipelineRecord | null {
  try {
    return JSON.parse(readFileSync(pipelineRecordPath(repo, safeRunId(runId)), 'utf8')) as PipelineRecord;
  } catch {
    return null;
  }
}

export function cancelPipeline(repo: string, runId: string): { requested: boolean; runId: string; note: string } {
  const record = readPipeline(repo, runId);
  if (record === null) throw new Error(`no pipeline run "${runId}"`);
  if (record.status !== 'running') {
    return { requested: false, runId, note: `pipeline already ${record.status}` };
  }
  const created = createMarker(pipelineCancelPath(repo, runId), new Date().toISOString());
  return {
    requested: true,
    runId,
    note: created
      ? 'cancellation requested; a live pipeline owner will stop active stages, but a run without an owner may remain marked running'
      : 'cancellation was already requested; the run may remain marked running if its owner exited',
  };
}

/**
 * Start and durably record one uniquely identified pipeline invocation.
 *
 * The record deliberately reflects only writes from this live owner. There is
 * no PID/lease protocol to distinguish an orphan from a slow stage after the
 * supervisor exits, so a process crash can leave the record `running`. Recovery
 * needs an owner lease before that state can be reconciled safely.
 */
export function startPipeline(
  service: ForgeService,
  spec: PipelineSpec,
  options: StartPipelineOptions = {},
): StartedPipeline {
  const runId = safeRunId(options.runId ?? `${Date.now()}-${randomBytes(5).toString('hex')}`);
  const recordPath = pipelineRecordPath(service.repo, runId);
  if (existsSync(recordPath)) {
    const existing = readPipeline(service.repo, runId);
    if (
      options.adoptExisting !== true || existing?.runId !== runId ||
      existing.pipeline !== spec.name || existing.status !== 'running'
    ) {
      throw new Error(`pipeline run id "${runId}" already exists`);
    }
  }

  const startedAt = Date.now();
  let current: PipelineRecord = {
    runId,
    pipeline: spec.name,
    status: 'running',
    startedAt,
    finishedAt: null,
    stageResults: {},
  };
  const persist = (): void => writeJsonAtomic(recordPath, current);
  persist();

  const controller = new AbortController();
  if (existsSync(pipelineCancelPath(service.repo, runId))) controller.abort('pipeline cancellation requested');
  const runner = createForgeRunner({ service, runId, unrestricted: options.unrestricted });
  const runners = Object.fromEntries(providerNames().map((provider) => [provider, runner]));
  const poll = setInterval(() => {
    if (existsSync(pipelineCancelPath(service.repo, runId))) controller.abort('pipeline cancellation requested');
  }, 250);
  poll.unref?.();

  const done = runPipeline(spec, {
    runner: {
      id: 'forge-router',
      run(ctx) {
        const selected = runners[ctx.routing.provider] ?? runners[ctx.stage.provider];
        if (!selected) throw new Error(`no forge worker available for provider ${ctx.stage.provider}`);
        return selected.run(ctx);
      },
    },
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    workDir: spec.workDir ?? service.repo,
    signal: controller.signal,
    ladders: options.ladders ?? Object.fromEntries(providerNames().map((provider) => [provider, { label: provider }])),
    onStageEnd(result) {
      current = { ...current, stageResults: { ...current.stageResults, [result.stage]: result } };
      persist();
    },
  }).then((run) => {
    current = {
      ...current,
      status: run.status,
      finishedAt: run.finishedAt,
      stageResults: run.outcomes,
    };
    persist();
    return run;
  }, (error: unknown) => {
    current = {
      ...current,
      status: 'failed',
      finishedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    };
    persist();
    throw error;
  }).finally(() => clearInterval(poll));

  return { runId, recordPath, done, cancel: () => { cancelPipeline(service.repo, runId); } };
}
