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

/**
 * THE sanitiser for a run id used as a file name. The record, the cancel marker
 * and the artifacts all key on it, so it must be one function: two lengths used
 * to split ids of 81-100 characters across files. 100 is also what the channel's
 * watch-source and the mod's notice code already assume.
 */
export function safeRunId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100) || 'pipeline';
}

/**
 * Where a PipelineRun's record is written.
 *
 * A pipeline outlives the MCP call that started it and usually outlives the
 * process too, so the run summary has to be a file. It sits beside the jobs,
 * not inside one: a run is not a job, and pretending otherwise would put a second
 * verdict for the same work into the pane.
 */
export function pipelineRecordPath(repo: string, runId: string): string {
  return path.join(repo, '.agent-smith', 'pipelines', `${safeRunId(runId)}.json`);
}

export function writePipelineRecord(repo: string, runId: string, value: unknown): void {
  writeJsonAtomic(pipelineRecordPath(repo, runId), value);
}

export function pipelineCancelPath(repo: string, runId: string): string {
  return path.join(repo, '.agent-smith', 'pipelines', `${safeRunId(runId)}.cancel`);
}

export function readPipeline(repo: string, runId: string): PipelineRecord | null {
  // Records written before the sanitiser was unified were truncated to 80 chars
  // even though the run id kept 100, so an 81-100 char id lives under the older name.
  const legacy = path.join(repo, '.agent-smith', 'pipelines', `${safeRunId(runId).slice(0, 80)}.json`);
  for (const file of [pipelineRecordPath(repo, runId), legacy]) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as PipelineRecord;
    } catch { /* try the next name */ }
  }
  return null;
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
  const runner = createForgeRunner({
    service, runId, unrestricted: options.unrestricted,
    onStageRunning(result) {
      current = { ...current, stageResults: { ...current.stageResults, [result.stage]: result } };
      persist();
    },
  });
  const known = new Set(providerNames());
  const poll = setInterval(() => {
    if (existsSync(pipelineCancelPath(service.repo, runId))) controller.abort('pipeline cancellation requested');
  }, 250);
  poll.unref?.();

  const done = runPipeline(spec, {
    runner: {
      id: 'forge-router',
      run(ctx) {
        // One runner serves every provider (it spawns by ctx.routing.provider), so
        // the only thing left to decide is whether the stage names one we know.
        // An unknown name must stay a throw (a retryable runner-threw), not the
        // runner's non-retryable spawn-failed.
        if (!known.has(ctx.routing.provider) && !known.has(ctx.stage.provider)) {
          throw new Error(`no forge worker available for provider ${ctx.stage.provider}`);
        }
        return runner.run(ctx);
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
