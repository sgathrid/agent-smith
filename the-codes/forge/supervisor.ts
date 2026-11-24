import { FILES, jobFile, ownerAlive, readManifest } from './format.ts';
import { existsSync } from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ForgeService, SpawnRequest, TrackedSpawn } from './service.ts';
import type { PipelineSpec } from '../pipeline/types.ts';
import { cancelPipeline, readPipeline, type StartPipelineOptions } from './execute.ts';
import { setTimeout as delay } from 'node:timers/promises';

export const LAUNCH_ACK_MS = 15_000;

export type SupervisorRequest =
  | { kind: 'job'; repo: string; request: Omit<SpawnRequest, 'onPrepared'> }
  | { kind: 'pipeline'; repo: string; spec: PipelineSpec; options: StartPipelineOptions };

async function launch<T>(url: URL, payload: SupervisorRequest, onPrepared?: SpawnRequest['onPrepared']): Promise<T> {
  const child = fork(fileURLToPath(url), [], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: url.pathname.endsWith('.ts') ? ['--experimental-strip-types'] : [],
  });
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(new Error(`execution supervisor did not acknowledge launch within ${LAUNCH_ACK_MS / 1000}s`)), LAUNCH_ACK_MS);
    function fail(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(error);
    }
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`execution supervisor exited before launch (exit ${code})`)));
    child.on('message', async (raw) => {
      const m = raw as { kind: string; jobId?: string; value?: T; error?: string };
      if (settled) return;
      if (m.kind === 'prepared') {
        try {
          await onPrepared?.(m.jobId!);
          if (!settled && child.connected) child.send({ kind: 'start' });
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      } else if (m.kind === 'error') fail(new Error(m.error));
      else if (m.kind === 'ack') {
        settled = true;
        clearTimeout(timer);
        child.disconnect();
        child.unref();
        resolve(m.value!);
      }
    });
    child.send(payload);
  });
}

export async function launchJob(service: ForgeService, request: SpawnRequest): Promise<TrackedSpawn> {
  const { onPrepared, ...serializable } = request;
  const ack = await launch<TrackedSpawn['ack']>(service.supervisorUrl!, { kind: 'job', repo: service.repo, request: serializable }, onPrepared);
  service.spawnedIds.add(ack.jobId);
  const done = (async () => {
    let id = ack.jobId;
    while (true) {
      id = service.resolveTurn(id);
      const detail = await service.detail(id);
      if (detail.followedBy) { id = detail.followedBy; continue; }
      if (detail.status !== 'running' && !detail.supersededBy) {
        const manifest = readManifest(service.repo, id);
        if (existsSync(jobFile(service.repo, id, FILES.ownerDone)) || !ownerAlive(manifest)) {
          return manifest as Awaited<TrackedSpawn['done']>;
        }
      }
      await delay(100);
    }
  })();
  void done.catch(() => {});
  return { ack, done };
}

export async function launchPipeline(service: ForgeService, spec: PipelineSpec, options: StartPipelineOptions): Promise<{ runId: string; recordPath: string; done: Promise<void>; cancel(): void }> {
  const ack = await launch<{ runId: string; recordPath: string }>(service.supervisorUrl!, { kind: 'pipeline', repo: service.repo, spec, options });
  service.spawnedRuns.add(ack.runId);
  const done = (async () => {
    while (true) {
      const record = readPipeline(service.repo, ack.runId);
      if (record && record.status !== 'running') return;
      await delay(100);
    }
  })();
  return { ...ack, done, cancel: () => { cancelPipeline(service.repo, ack.runId); } };
}
