/**
 * steer-harness.ts — shared fakes for the steer test files: a controllable
 * provider (tests emit events and finish turns by hand) and a ForgeService
 * over a fresh temp repo.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { JobResult, Provider, ProviderEvent, SpawnSpec } from '../../providers/types.ts';
import { ForgeService } from '../service.ts';
import { scaled } from './time.ts';
export interface ControlledTurn {
  spec: SpawnSpec;
  emit(event: ProviderEvent): void;
  finish(result: Partial<JobResult>): void;
  cancelled: boolean;
}

export function controlledProvider(name = 'codex') {
  const turns: ControlledTurn[] = [];
  const waiters: Array<(turn: ControlledTurn) => void> = [];

  const provider: Provider = {
    name,
    async spawn(spec: SpawnSpec) {
      const listeners = new Set<(event: ProviderEvent) => void>();
      let resolveResult!: (res: JobResult) => void;
      const resultPromise = new Promise<JobResult>((r) => {
        resolveResult = r;
      });
      const turn: ControlledTurn = {
        spec,
        cancelled: false,
        emit(event: ProviderEvent) {
          for (const l of listeners) l(event);
        },
        finish(partial: Partial<JobResult>) {
          const status = partial.status ?? 'success';
          resolveResult({
            jobId: spec.jobId ?? 'job',
            provider: name,
            ok: status === 'success',
            status,
            exitCode: partial.exitCode ?? 0,
            signal: null,
            response: partial.response ?? 'Completed the requested implementation work cleanly and verified all edge cases.',
            deniedActions: partial.deniedActions ?? [],
            durationMs: partial.durationMs ?? 100,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            stateDir: spec.stateDir ?? '',
            ...partial,
          });
        },
      };
      turns.push(turn);
      const w = waiters.shift();
      if (w) w(turn);

      return {
        id: spec.jobId ?? 'job',
        stateDir: spec.stateDir ?? '',
        cancel() {
          turn.cancelled = true;
          turn.finish({
            status: 'cancelled',
            exitCode: null,
            response: '',
          });
        },
        onEvent(cb: (event: ProviderEvent) => void) {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
        waitForResult() {
          return resultPromise;
        },
      };
    },
  } as unknown as Provider;

  function nextTurn(): Promise<ControlledTurn> {
    return new Promise<ControlledTurn>((resolve, reject) => {
      // The fake has no child-process handles. Keep this awaited transition
      // alive on Node 22 and report a missing turn instead of canceling the file.
      const deadline = setTimeout(() => reject(new Error('controlled provider did not start the next turn within the deadline')), scaled(60_000));
      waiters.push((turn) => {
        clearTimeout(deadline);
        resolve(turn);
      });
    });
  }

  return { provider, turns, nextTurn };
}

export function makeService(provider: Provider) {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-steer-'));
  const service = new ForgeService({
    repo,
   
    flushMs: 5,
    providerSource: () => provider,
    catalogSource: async () => [],
  });
  return { service, repo };
}
