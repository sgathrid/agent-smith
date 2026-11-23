/**
 * worker-chain.test.ts — unified Worker/Turn chain model across steers and resumes.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { FILES, jobFile } from '../format.ts';
import { compareTurnPriority } from '../service.ts';
import { controlledProvider, makeService } from '../testing/steer-harness.ts';

test('unified turn chain: turn, continuedFrom, continuationKind, and chainStartedAt across spawn -> steer -> resume -> steer', async () => {
  const ctrl = controlledProvider();
  const { service } = makeService(ctrl.provider);

  // Turn 1: fresh spawn
  const t1Ready = ctrl.nextTurn();
  const { ack: t1Ack, done: t1ChainDone } = await service.spawnTracked({
    mode: 'implement',
    name: 'builder',
    prompt: 'Build feature v1.',
  });
  assert.equal(t1Ack.turn, 1);
  assert.equal(t1Ack.continuedFrom, undefined);
  assert.equal(t1Ack.continuationKind, undefined);
  assert.ok(t1Ack.chainStartedAt);
  const t1 = await t1Ready;
  t1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'conv-builder' });

  // Turn 2: steer(queue) inherits chainStartedAt
  const t2Ready = ctrl.nextTurn();
  await service.steer({ worker: 'builder', prompt: 'Add tests.', delivery: 'queue' });
  t1.finish({ status: 'success', response: 'Built feature v1.' });
  const t2 = await t2Ready;
  t2.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'conv-builder' });

  // Turn 3: steer(interrupt) still inherits Turn 1's chainStartedAt
  const t3Ready = ctrl.nextTurn();
  await service.steer({ worker: t1Ack.workerId, prompt: 'Switch to streaming API.', delivery: 'interrupt' });
  const t3 = await t3Ready;
  t3.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'conv-builder' });
  t3.finish({ status: 'success', response: 'Implemented streaming API with tests.' });

  const t3Manifest = await t1ChainDone;
  assert.equal(t3Manifest.workerId, t1Ack.workerId);
  assert.equal(t3Manifest.turn, 3);
  assert.equal(t3Manifest.continuedFrom, t2.spec.jobId);
  assert.equal(t3Manifest.continuationKind, 'steer-interrupt');
  assert.equal(t3Manifest.chainStartedAt, t1Ack.chainStartedAt);

  // Wait a couple ms so resumed Turn 4 gets a strictly newer startedAt.
  await new Promise((r) => setTimeout(r, 10));

  // Turn 4: resume (omitting explicit turn to verify auto-increment from continuedFrom)
  const t4Ready = ctrl.nextTurn();
  const { ack: t4Ack, done: t4ChainDone } = await service.spawnTracked({
    mode: 'implement',
    name: 'builder',
    workerId: t1Ack.workerId,
    conversation: 'conv-builder',
    continuedFrom: t3Manifest.jobId,
    continuationKind: 'resume',
    prompt: 'Add benchmarks.',
  });
  assert.equal(t4Ack.workerId, t1Ack.workerId);
  assert.equal(t4Ack.turn, 4);
  assert.equal(t4Ack.continuedFrom, t3Manifest.jobId);
  assert.equal(t4Ack.continuationKind, 'resume');
  assert.notEqual(t4Ack.chainStartedAt, t1Ack.chainStartedAt, 'resume resets chainStartedAt after idle gap');

  // Turn 3 was resumed, NOT steered: supersededBy must NEVER be set on Turn 3.
  const t3Detail = await service.detail(t3Manifest.jobId);
  assert.equal(t3Detail.supersededBy, undefined);

  // Resolution by any turn's jobId, workerId, or name lands on Turn 4 while running.
  assert.equal(service.resolveHead(t1Ack.jobId), t4Ack.jobId);
  assert.equal(service.resolveHead(t3Manifest.jobId), t4Ack.jobId);
  assert.equal(service.resolveHead(t1Ack.workerId), t4Ack.jobId);
  assert.equal((await service.resolveWorker(t1Ack.jobId)).jobId, t4Ack.jobId);
  assert.equal((await service.resolveWorker(t1Ack.workerId)).jobId, t4Ack.jobId);
  assert.equal((await service.resolveWorker('builder')).jobId, t4Ack.jobId);

  const t4 = await t4Ready;
  t4.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'conv-builder' });

  // Turn 5: steer(queue) on resumed Turn 4 inherits Turn 4's fresh chainStartedAt
  const t5Ready = ctrl.nextTurn();
  const steerOnResumed = await service.steer({ worker: t1Ack.jobId, prompt: 'Include p99 latency.', delivery: 'queue' });
  assert.equal(steerOnResumed.jobId, t4Ack.jobId);
  assert.equal(steerOnResumed.turn, 4);
  assert.equal(steerOnResumed.chainStartedAt, t4Ack.chainStartedAt);
  t4.finish({ status: 'success', response: 'Added benchmarks.' });
  const t5 = await t5Ready;
  t5.finish({ status: 'success', response: 'Added benchmarks with p99 latency.' });

  const t5Manifest = await t4ChainDone;
  assert.equal(t5Manifest.turn, 5);
  assert.equal(t5Manifest.continuedFrom, t4Ack.jobId);
  assert.equal(t5Manifest.continuationKind, 'steer-queue');
  assert.equal(t5Manifest.chainStartedAt, t4Ack.chainStartedAt);

  // earlierTurns returns Turn 1..4 oldest-first across both steers and resumes.
  const earlier = await service.earlierTurns(t5Manifest.jobId);
  assert.deepEqual(
    earlier.map((t) => ({ jobId: t.jobId, turn: t.turn, kind: t.continuationKind })),
    [
      { jobId: t1Ack.jobId, turn: 1, kind: undefined },
      { jobId: t2.spec.jobId, turn: 2, kind: 'steer-queue' },
      { jobId: t3Manifest.jobId, turn: 3, kind: 'steer-interrupt' },
      { jobId: t4Ack.jobId, turn: 4, kind: 'resume' },
    ],
  );

  // Cap keeps the most recent N earlier turns, oldest-first.
  const capped = await service.earlierTurns(t5Manifest.jobId, 2);
  assert.deepEqual(capped.map((t) => t.turn), [3, 4]);

  // Querying an intermediate turn never leaks later turns into earlierTurns.
  const midEarlier = await service.earlierTurns(await service.detail(t2.spec.jobId!));
  assert.deepEqual(midEarlier.map((t) => t.turn), [1]);
});

test('list() groups by workerId by default BEFORE status/sinceMs/limit and expands filter.ids by workerId', async () => {
  const ctrl = controlledProvider();
  const { service } = makeService(ctrl.provider);

  // Worker A: Turn 1 succeeded, Turn 2 (resumed) failed
  const a1Ready = ctrl.nextTurn();
  const { ack: a1Ack, done: a1Done } = await service.spawnTracked({
    mode: 'implement',
    name: 'worker-a',
    prompt: 'Task A1.',
  });
  const a1 = await a1Ready;
  a1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'conv-a' });
  a1.finish({ status: 'success', response: 'A1 ok.' });
  await a1Done;

  const a2Ready = ctrl.nextTurn();
  const { ack: a2Ack, done: a2Done } = await service.spawnTracked({
    mode: 'implement',
    name: 'worker-a',
    workerId: a1Ack.workerId,
    conversation: 'conv-a',
    continuedFrom: a1Ack.jobId,
    continuationKind: 'resume',
    prompt: 'Task A2.',
  });
  (await a2Ready).finish({ status: 'error', exitCode: 1, response: '' });
  await a2Done;

  // Worker B: single succeeded turn
  const b1Ready = ctrl.nextTurn();
  const { ack: b1Ack, done: b1Done } = await service.spawnTracked({
    mode: 'review',
    name: 'worker-b',
    prompt: 'Task B1.',
  });
  (await b1Ready).finish({ status: 'success', response: 'B1 ok.' });
  await b1Done;

  // Default list: 1 row per worker (2 workers, not 3 turns)
  const grouped = await service.list();
  assert.equal(grouped.length, 2);
  assert.deepEqual(
    new Set(grouped.map((j) => `${j.workerId}:${j.jobId}:${j.turn}`)),
    new Set([`${a1Ack.workerId}:${a2Ack.jobId}:2`, `${b1Ack.workerId}:${b1Ack.jobId}:1`]),
  );

  // Ungrouped list: all 3 turns
  const ungrouped = await service.list({ groupByWorker: false });
  assert.equal(ungrouped.length, 3);

  // Status filter runs AFTER grouping: worker-a's head is failed, so it must NOT show under status: 'succeeded'
  const succeeded = await service.list({ status: 'succeeded' });
  assert.deepEqual(succeeded.map((j) => j.jobId), [b1Ack.jobId]);

  const failed = await service.list({ status: 'failed' });
  assert.deepEqual(failed.map((j) => j.jobId), [a2Ack.jobId]);

  // ids filter expands by workerId: passing only Turn 1's jobId finds Turn 2 (head)
  const byTurn1Id = await service.list({ ids: new Set([a1Ack.jobId]) });
  assert.deepEqual(byTurn1Id.map((j) => j.jobId), [a2Ack.jobId]);
});

test('cancel() accepts workerId or Turn 1 jobId across resumes without touching finished Turn 1', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);

  const t1Ready = ctrl.nextTurn();
  const { ack: t1Ack, done: t1Done } = await service.spawnTracked({
    mode: 'implement',
    name: 'cancel-resume',
    workerId: 'custom-worker-id',
    prompt: 'Turn 1.',
  });
  const t1 = await t1Ready;
  t1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'conv-cr' });
  t1.finish({ status: 'success', response: 'Done 1.' });
  await t1Done;

  const t2Ready = ctrl.nextTurn();
  const { ack: t2Ack, done: t2Done } = await service.spawnTracked({
    mode: 'implement',
    name: 'cancel-resume',
    workerId: 'custom-worker-id',
    conversation: 'conv-cr',
    continuedFrom: t1Ack.jobId,
    continuationKind: 'resume',
    prompt: 'Turn 2.',
  });
  const t2 = await t2Ready;

  const res = service.cancel('custom-worker-id');
  assert.equal(res.jobId, t2Ack.jobId);
  assert.equal(res.resolvedFrom, 'custom-worker-id');
  assert.equal(res.signalled, true);
  assert.equal(t2.cancelled, true);
  assert.equal(existsSync(jobFile(repo, t1Ack.jobId, FILES.cancel)), false, 'finished Turn 1 must not be marked canceled');
  assert.equal(existsSync(path.join(repo, '.agent-smith/jobs/custom-worker-id')), false, 'synthetic workerId must not create a job dir');

  const final = await t2Done;
  assert.equal(final.status, 'canceled');
});

test('earlierTurns falls back to workerId-matched turns for 0.4.x resumes without continuedFrom', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  const writeLegacy = (id: string, extra: Record<string, unknown>) => {
    const file = jobFile(repo, id, FILES.job);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      schema: 1, jobId: id, name: 'legacy-w', workerId: 'legacy-w1', provider: 'codex', mode: 'implement',
      model: null, effort: null, cwd: repo, task: 't', promptChars: 1, unrestricted: false, conversation: 'c1',
      status: 'succeeded', createdAt: '2026-11-23T09:00:00.000Z', updatedAt: '2026-11-23T09:05:00.000Z',
      startedAt: '2026-11-23T09:00:00.000Z', finishedAt: '2026-11-23T09:05:00.000Z',
      exitCode: 0, jobStatus: 'success', error: null, deniedActions: [], usage: null, toolCalls: 1,
      pipeline: null, stage: null, attempt: null, ...extra,
    }));
  };

  // Turn 1 (0.4.x spawn, no turn/continuedFrom)
  writeLegacy('legacy-t1', { startedAt: '2026-11-23T09:00:00.000Z', finishedAt: '2026-11-23T09:02:00.000Z' });
  // Turn 2 (0.4.x resume, shared workerId, no continuedFrom, no turn)
  writeLegacy('legacy-t2', { startedAt: '2026-11-23T09:10:00.000Z', finishedAt: '2026-11-23T09:12:00.000Z' });
  // Turn 3 (0.4.x steer with legacy steeredFrom)
  writeLegacy('legacy-t3', { startedAt: '2026-11-23T09:13:00.000Z', finishedAt: '2026-11-23T09:15:00.000Z', steeredFrom: 'legacy-t2' });

  assert.equal(service.resolveHead('legacy-t1'), 'legacy-t3');
  assert.equal(service.resolveHead('legacy-w1'), 'legacy-t3');
  const earlier = await service.earlierTurns('legacy-w1');
  assert.deepEqual(earlier.map((t) => t.jobId), ['legacy-t1', 'legacy-t2']);
});

test('compareTurnPriority orders by !supersededBy, running, higher turn, then newer timestamp', () => {
  const items = [
    { jobId: 'a', status: 'succeeded', turn: 5, supersededBy: 'b', startedAt: '2026-11-23T12:00:00.000Z' },
    { jobId: 'b', status: 'succeeded', turn: 2, startedAt: '2026-11-23T10:00:00.000Z' },
    { jobId: 'c', status: 'succeeded', turn: 3, startedAt: '2026-11-23T09:00:00.000Z' },
    { jobId: 'd', status: 'succeeded', turn: 3, startedAt: '2026-11-23T11:00:00.000Z' },
    { jobId: 'e', status: 'running', turn: 1, startedAt: '2026-11-23T08:00:00.000Z' },
  ];
  items.sort(compareTurnPriority);
  assert.deepEqual(items.map((x) => x.jobId), ['e', 'd', 'c', 'b', 'a']);
});
