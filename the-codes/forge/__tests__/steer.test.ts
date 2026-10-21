/**
 * steer.test.ts — pump-owned live worker steering (queue and interrupt).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { JobResult, Provider, ProviderEvent, SpawnSpec } from '../../providers/types.ts';
import { FILES, jobFile } from '../format.ts';
import { ForgeService } from '../service.ts';

interface ControlledTurn {
  spec: SpawnSpec;
  emit(event: ProviderEvent): void;
  finish(result: Partial<JobResult>): void;
  cancelled: boolean;
}

function controlledProvider(name = 'codex') {
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
    return new Promise<ControlledTurn>((resolve) => {
      waiters.push(resolve);
    });
  }

  return { provider, turns, nextTurn };
}

function makeService(provider: Provider) {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-steer-'));
  const service = new ForgeService({
    repo,
    mirror: false,
    flushMs: 5,
    providerSource: () => provider,
    catalogSource: async () => [],
  });
  return { service, repo };
}

test('steer(queue): coalesces multiple queued steers, opens child anchor before parent finishes, and resolves done with final manifest', async () => {
  const ctrl = controlledProvider();
  const { service } = makeService(ctrl.provider);

  const turn1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'shell',
    prompt: 'Build the sidebar navigation.',
  });
  const turn1 = await turn1Ready;
  turn1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'thread-shell' });

  const steer1 = await service.steer({
    worker: 'shell',
    prompt: 'Also export NavItemProps.',
    context: 'Needed by consumers.',
    delivery: 'queue',
  });
  assert.equal(steer1.jobId, ack.jobId);
  assert.equal(steer1.status, 'queued');
  assert.equal(steer1.pendingSteers, 1);

  const steer2 = await service.steer({
    worker: ack.jobId,
    prompt: 'And add keyboard shortcuts.',
    delivery: 'queue',
  });
  assert.equal(steer2.pendingSteers, 2);

  const turn2Ready = ctrl.nextTurn();
  turn1.finish({ status: 'success', response: 'Sidebar navigation component implemented and exported with full keyboard support.' });

  const turn2 = await turn2Ready;
  assert.equal(turn2.spec.conversation, 'thread-shell');
  assert.match(turn2.spec.prompt, /^Context: Needed by consumers\./);
  assert.match(turn2.spec.prompt, /\[FOLLOW-UP STEER · 2 queued updates\]/);
  assert.match(turn2.spec.prompt, /\[Steer 1 \([^)]+\)\]\nAlso export NavItemProps\./);
  assert.match(turn2.spec.prompt, /\[Steer 2 \([^)]+\)\]\nAnd add keyboard shortcuts\./);

  turn2.finish({ status: 'success', response: 'Exported NavItemProps interface and wired keyboard shortcuts into the component.' });

  const finalManifest = await done;
  assert.notEqual(finalManifest.jobId, ack.jobId);
  assert.equal(finalManifest.status, 'succeeded');
  assert.equal(finalManifest.steeredFrom, ack.jobId);
  assert.equal(finalManifest.name, 'shell');

  const parentDetail = await service.detail(ack.jobId);
  assert.equal(parentDetail.status, 'succeeded');
  assert.equal(parentDetail.supersededBy, finalManifest.jobId);
});

test('steer(interrupt): cancels active turn, records supersededBy on parent, and chains continuation with conversation', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);

  const turn1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'shell',
    prompt: 'Build the sidebar navigation.',
  });
  const turn1 = await turn1Ready;
  turn1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'thread-interrupt' });

  const turn2Ready = ctrl.nextTurn();
  const steerAck = await service.steer({
    worker: 'shell',
    prompt: 'Stop sidebar; move navigation to the profile menu.',
    delivery: 'interrupt',
  });
  assert.equal(steerAck.status, 'interrupting');
  assert.equal(turn1.cancelled, true);
  assert.equal(existsSync(jobFile(repo, ack.jobId, FILES.cancelSteer)), true);

  const turn2 = await turn2Ready;
  assert.equal(turn2.spec.conversation, 'thread-interrupt');
  assert.match(turn2.spec.prompt, /\[TURN INTERRUPTED\]/);
  assert.match(turn2.spec.prompt, /Stop sidebar; move navigation to the profile menu\./);

  // While turn 2 is running, the parent is already terminal with supersededBy pointing to turn 2.
  const parentManifest = JSON.parse(readFileSync(jobFile(repo, ack.jobId, FILES.job), 'utf8'));
  assert.equal(parentManifest.status, 'canceled');
  assert.ok(parentManifest.supersededBy, 'parent manifest has supersededBy set atomically');

  turn2.finish({ status: 'success', response: 'Moved the navigation links into the user profile dropdown menu and removed sidebar.' });
  const finalManifest = await done;
  assert.equal(finalManifest.jobId, parentManifest.supersededBy);
  assert.equal(finalManifest.status, 'succeeded');
  assert.equal(finalManifest.steeredFrom, ack.jobId);
});

test('steer(interrupt) before conversation ID arrives falls back to fresh continuation with full brief', async () => {
  const ctrl = controlledProvider();
  const { service } = makeService(ctrl.provider);

  const turn1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'early',
    prompt: 'Initial task.',
  });
  await turn1Ready;
  // Do NOT emit a started event with conversationId.

  const turn2Ready = ctrl.nextTurn();
  await service.steer({
    worker: 'early',
    prompt: 'Updated task instructions.',
    delivery: 'interrupt',
  });

  const turn2 = await turn2Ready;
  assert.equal(turn2.spec.conversation, undefined);
  assert.match(turn2.spec.prompt, /\[FRESH CONTINUATION\]/);
  assert.match(turn2.spec.prompt, /orchestrating agent/);
  assert.match(turn2.spec.prompt, /Updated task instructions\./);

  turn2.finish({ status: 'success', response: 'Completed fresh continuation with the updated task instructions end-to-end.' });
  const finalManifest = await done;
  assert.equal(finalManifest.steeredFrom, ack.jobId);
  assert.equal(finalManifest.status, 'succeeded');
});

test('hard user cancel() wins over queued steers and does not chain', async () => {
  const ctrl = controlledProvider();
  const { service } = makeService(ctrl.provider);

  const turn1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'cancellable',
    prompt: 'Work.',
  });
  await turn1Ready;

  await service.steer({
    worker: 'cancellable',
    prompt: 'Follow up.',
    delivery: 'queue',
  });

  await service.cancel(ack.jobId);
  const finalManifest = await done;
  assert.equal(finalManifest.jobId, ack.jobId);
  assert.equal(finalManifest.status, 'canceled');
  assert.equal(finalManifest.supersededBy, undefined);
  assert.equal(ctrl.turns.length, 1);
});

test('steer rejects finished workers, pipeline stages, and orphaned jobs with actionable errors', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);

  // 1. Finished worker -> points to resume_job
  const t1 = ctrl.nextTurn();
  const { done } = await service.spawnTracked({
    mode: 'review',
    name: 'reviewer',
    prompt: 'Review.',
  });
  (await t1).finish({ status: 'success', response: 'LGTM.' });
  await done;

  await assert.rejects(
    service.steer({ worker: 'reviewer', prompt: 'More.', delivery: 'queue' }),
    /is already succeeded; use resume_job to continue a finished worker/,
  );

  // 2. Pipeline stage -> rejected
  const t2 = ctrl.nextTurn();
  const stageSpawn = await service.spawnTracked({
    mode: 'implement',
    name: 'stage-worker',
    pipeline: 'pipe-1',
    stage: 'impl',
    prompt: 'Stage.',
  });
  await t2;
  await assert.rejects(
    service.steer({ worker: stageSpawn.ack.jobId, prompt: 'Redirect.', delivery: 'interrupt' }),
    /Cannot steer pipeline stage/,
  );
  ctrl.turns[1]!.finish({ status: 'success', response: 'Done.' });
  await stageSpawn.done;

  // 3. Orphaned running worker (dead ownerPid) -> rejected
  const t3 = ctrl.nextTurn();
  const orphanSpawn = await service.spawnTracked({
    mode: 'implement',
    name: 'orphan-worker',
    prompt: 'Work.',
  });
  (await t3).finish({ status: 'success', response: 'Done.' });
  await orphanSpawn.done;

  // Simulate a stale running manifest on disk with a dead ownerPid and no result.json
  try { unlinkSync(jobFile(repo, orphanSpawn.ack.jobId, FILES.result)); } catch { /* ignore */ }
  const manifestPath = jobFile(repo, orphanSpawn.ack.jobId, FILES.job);
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  m.status = 'running';
  m.finishedAt = null;
  m.ownerPid = 999_999_999;
  writeFileSync(manifestPath, JSON.stringify(m));

  await assert.rejects(
    service.steer({ worker: orphanSpawn.ack.jobId, prompt: 'Steer orphan.', delivery: 'queue' }),
    /is already failed|has no live owner process/,
  );
});
