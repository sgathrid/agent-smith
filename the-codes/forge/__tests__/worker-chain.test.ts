import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { readAcceptance } from '../checks.ts';
import { FILES, jobFile } from '../format.ts';
import { ForgeService } from '../service.ts';
import { compareTurnPriority, workerIndexPath } from '../../surfaces/mod/hooks/turns.ts';
import { controlledProvider, makeService, withDefaultProvider } from '../testing/steer-harness.ts';
import type { Provider } from '../../providers/types.ts';

const tick = () => new Promise((r) => setTimeout(r, 10));

function serviceOn(repo: string, provider: Provider): ForgeService {
  return withDefaultProvider(new ForgeService({ repo, flushMs: 5, providerSource: () => provider, catalogSource: async () => [] }));
}

test('turn chain: spawn -> follow-up -> steer -> cold follow-up -> follow-up; kinds, clocks, resolvers, index', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);

  const t1Ready = ctrl.nextTurn();
  const { ack: t1Ack, done: t1ChainDone } = await service.spawnTracked({ mode: 'implement', name: 'builder', prompt: 'Build feature v1.' });
  assert.equal(t1Ack.turn, 1);
  assert.equal(t1Ack.continuedFrom, undefined);
  assert.equal(t1Ack.continuationKind, undefined);
  const t1 = await t1Ready;
  t1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'conv-builder' });

  await tick();
  const t2Ready = ctrl.nextTurn();
  await service.followUp({ worker: 'builder', prompt: 'Add tests.' });
  t1.finish({ status: 'success', response: 'Built feature v1.' });
  const t2 = await t2Ready;
  t2.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'conv-builder' });
  const t2Id = t2.spec.jobId!;

  const t3Ready = ctrl.nextTurn();
  await service.steer({ worker: t1Ack.workerId, prompt: 'Switch to streaming API.' });
  const t3 = await t3Ready;
  t3.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'conv-builder' });
  t3.finish({ status: 'success', response: 'Implemented streaming API with tests.' });

  const t3Manifest = await t1ChainDone;
  const t2Manifest = JSON.parse(readFileSync(jobFile(repo, t2Id, FILES.job), 'utf8'));
  assert.equal(t2Manifest.continuationKind, 'follow-up');
  assert.notEqual(t2Manifest.chainStartedAt, t1Ack.chainStartedAt, 'a follow-up resets the chain clock');
  assert.equal(t2Manifest.supersededBy, t3Manifest.jobId, 'the steer cut turn 2 short');
  assert.equal(t3Manifest.turn, 3);
  assert.equal(t3Manifest.continuedFrom, t2Id);
  assert.equal(t3Manifest.continuationKind, 'steer');
  assert.equal(t3Manifest.chainStartedAt, t2Manifest.chainStartedAt, 'a steer inherits the chain clock');

  await tick();

  const t4Ready = ctrl.nextTurn();
  const { ack: t4Ack, done: t4ChainDone } = await service.spawnTracked({
    mode: 'implement', name: 'builder', workerId: t1Ack.workerId, conversation: 'conv-builder',
    continuedFrom: t3Manifest.jobId, continuationKind: 'resume', prompt: 'Add benchmarks.',
  });
  assert.equal(t4Ack.turn, 4);
  assert.equal(t4Ack.continuationKind, 'follow-up', 'legacy "resume" is normalized before it is written');
  assert.notEqual(t4Ack.chainStartedAt, t1Ack.chainStartedAt);

  const t3Detail = await service.detail(t3Manifest.jobId);
  assert.equal(t3Detail.supersededBy, undefined);
  assert.equal(t3Detail.followedBy, t4Ack.jobId);

  assert.equal(service.resolveTurn(t1Ack.jobId), t1Ack.jobId);
  assert.equal(service.resolveTurn(t2Id), t3Manifest.jobId);
  assert.equal(service.resolveTurn(t3Manifest.jobId), t3Manifest.jobId);
  assert.equal((await service.resolveWorkerHead(t1Ack.jobId)).jobId, t4Ack.jobId);
  assert.equal((await service.resolveWorkerHead(t3Manifest.jobId)).jobId, t4Ack.jobId);
  assert.equal((await service.resolveWorkerHead(t1Ack.workerId)).jobId, t4Ack.jobId);
  assert.equal((await service.resolveWorkerHead('builder')).jobId, t4Ack.jobId);
  assert.equal((await service.resolveWorker(t1Ack.jobId)).jobId, t1Ack.jobId);
  assert.equal((await service.resolveWorker('builder')).jobId, t4Ack.jobId);

  const t4 = await t4Ready;
  t4.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'conv-builder' });

  const t5Ready = ctrl.nextTurn();
  const queued = await service.followUp({ worker: t1Ack.jobId, prompt: 'Include p99 latency.' });
  assert.equal(queued.jobId, t4Ack.jobId);
  assert.equal(queued.turn, 4);
  t4.finish({ status: 'success', response: 'Added benchmarks.' });
  const t5 = await t5Ready;
  t5.finish({ status: 'success', response: 'Added benchmarks with p99 latency.' });

  const t5Manifest = await t4ChainDone;
  assert.equal(t5Manifest.turn, 5);
  assert.equal(t5Manifest.continuedFrom, t4Ack.jobId);
  assert.equal(t5Manifest.continuationKind, 'follow-up');

  const earlier = await service.earlierTurns(t5Manifest.jobId);
  assert.deepEqual(
    earlier.map((t) => ({ jobId: t.jobId, turn: t.turn, kind: t.continuationKind })),
    [
      { jobId: t1Ack.jobId, turn: 1, kind: undefined },
      { jobId: t2Id, turn: 2, kind: 'follow-up' },
      { jobId: t3Manifest.jobId, turn: 3, kind: 'steer' },
      { jobId: t4Ack.jobId, turn: 4, kind: 'follow-up' },
    ],
  );
  assert.deepEqual((await service.earlierTurns(t5Manifest.jobId, 2)).map((t) => t.turn), [3, 4]);
  assert.deepEqual((await service.earlierTurns(await service.detail(t2Id))).map((t) => t.turn), [1]);

  const index = JSON.parse(readFileSync(workerIndexPath(repo, t1Ack.workerId), 'utf8'));
  assert.equal(index.schema, 1);
  assert.equal(index.name, 'builder');
  assert.deepEqual(index.turns, [t1Ack.jobId, t2Id, t3Manifest.jobId, t4Ack.jobId, t5Manifest.jobId]);
});

test('after a follow-up, status/detail(turn 1 jobId) is turn 1, and cancel(turn 1 jobId) leaves the running turn 2 alone', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  const t1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement', name: 'ada', prompt: 'Turn 1.', checks: [{ name: 'ok', command: 'true' }],
  });
  const t1 = await t1Ready;
  t1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'conv-ada' });
  await service.followUp({ worker: 'ada', prompt: 'Then turn 2.' });
  const t2Ready = ctrl.nextTurn();
  t1.finish({ status: 'success', response: 'Turn one report: the parser is done.' });
  const t2 = await t2Ready;

  const viaStatus = await service.resolveWorker(ack.jobId);
  assert.equal(viaStatus.jobId, ack.jobId);
  assert.equal(viaStatus.status, 'succeeded');
  assert.equal(viaStatus.turn, 1);
  assert.match(viaStatus.report ?? '', /Turn one report/);
  assert.equal((await service.detail(ack.jobId)).followedBy, t2.spec.jobId);
  assert.equal(service.resolveTurn(ack.jobId), ack.jobId);
  assert.deepEqual(readAcceptance(repo, ack.jobId), { state: 'unchecked', checks: [], reason: 'continued by follow-up' });

  const res = service.cancel(ack.jobId);
  assert.equal(res.jobId, ack.jobId);
  assert.equal(res.requested, false);
  assert.equal(res.signalled, false);
  assert.equal(res.status, 'succeeded');
  assert.equal(t2.cancelled, false);
  assert.equal(existsSync(jobFile(repo, ack.jobId, FILES.cancel)), false);
  assert.equal(existsSync(jobFile(repo, t2.spec.jobId!, FILES.cancel)), false);

  const byName = service.cancel('ada');
  assert.equal(byName.jobId, t2.spec.jobId);
  assert.equal(byName.requested, true);
  assert.equal(byName.signalled, true);
  assert.equal(t2.cancelled, true);
  const final = await done;
  assert.equal(final.jobId, t2.spec.jobId);
  assert.equal(final.status, 'canceled');
  assert.equal((await service.detail(ack.jobId)).status, 'succeeded', 'turn 1 was never touched');
});

test('list() groups by workerId by default BEFORE status/sinceMs/limit and expands filter.ids by workerId', async () => {
  const ctrl = controlledProvider();
  const { service } = makeService(ctrl.provider);

  const a1Ready = ctrl.nextTurn();
  const { ack: a1Ack, done: a1Done } = await service.spawnTracked({ mode: 'implement', name: 'worker-a', prompt: 'Task A1.' });
  const a1 = await a1Ready;
  a1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'conv-a' });
  a1.finish({ status: 'success', response: 'A1 ok.' });
  await a1Done;

  const a2Ready = ctrl.nextTurn();
  const { ack: a2Ack, done: a2Done } = await service.spawnTracked({
    mode: 'implement', name: 'worker-a', workerId: a1Ack.workerId, conversation: 'conv-a',
    continuedFrom: a1Ack.jobId, continuationKind: 'follow-up', prompt: 'Task A2.',
  });
  (await a2Ready).finish({ status: 'error', exitCode: 1, response: '' });
  await a2Done;

  const b1Ready = ctrl.nextTurn();
  const { ack: b1Ack, done: b1Done } = await service.spawnTracked({ mode: 'review', name: 'worker-b', prompt: 'Task B1.' });
  (await b1Ready).finish({ status: 'success', response: 'B1 ok.' });
  await b1Done;

  const grouped = await service.list();
  assert.equal(grouped.length, 2);
  assert.deepEqual(
    new Set(grouped.map((j) => `${j.workerId}:${j.jobId}:${j.turn}`)),
    new Set([`${a1Ack.workerId}:${a2Ack.jobId}:2`, `${b1Ack.workerId}:${b1Ack.jobId}:1`]),
  );
  assert.equal((await service.list({ groupByWorker: false })).length, 3);
  assert.deepEqual((await service.list({ status: 'succeeded' })).map((j) => j.jobId), [b1Ack.jobId]);
  assert.deepEqual((await service.list({ status: 'failed' })).map((j) => j.jobId), [a2Ack.jobId]);
  assert.deepEqual((await service.list({ ids: new Set([a1Ack.jobId]) })).map((j) => j.jobId), [a2Ack.jobId]);
});

test('cancel(workerId) hits the head across a cold follow-up without touching finished turn 1', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);

  const t1Ready = ctrl.nextTurn();
  const { ack: t1Ack, done: t1Done } = await service.spawnTracked({ mode: 'implement', name: 'cancel-resume', workerId: 'custom-worker-id', prompt: 'Turn 1.' });
  const t1 = await t1Ready;
  t1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'conv-cr' });
  t1.finish({ status: 'success', response: 'Done 1.' });
  await t1Done;

  const t2Ready = ctrl.nextTurn();
  const { ack: t2Ack, done: t2Done } = await service.spawnTracked({
    mode: 'implement', name: 'cancel-resume', workerId: 'custom-worker-id', conversation: 'conv-cr',
    continuedFrom: t1Ack.jobId, continuationKind: 'resume', prompt: 'Turn 2.',
  });
  const t2 = await t2Ready;

  assert.equal(service.cancel(t1Ack.jobId).requested, false);
  assert.equal(t2.cancelled, false);

  const res = service.cancel('custom-worker-id');
  assert.equal(res.jobId, t2Ack.jobId);
  assert.equal(res.resolvedFrom, 'custom-worker-id');
  assert.equal(res.signalled, true);
  assert.equal(t2.cancelled, true);
  assert.equal(existsSync(jobFile(repo, t1Ack.jobId, FILES.cancel)), false, 'finished Turn 1 must not be marked canceled');
  assert.equal(existsSync(path.join(repo, '.agent-smith/jobs/custom-worker-id')), false, 'synthetic workerId must not create a job dir');
  assert.equal((await t2Done).status, 'canceled');
});

test('legacy workers (no index) are indexed on first lookup; turns ordered and numbered by start time', async () => {
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
  writeLegacy('legacy-t3', { startedAt: '2026-11-23T09:13:00.000Z', finishedAt: '2026-11-23T09:15:00.000Z', steeredFrom: 'legacy-t2' });
  writeLegacy('legacy-t1', { startedAt: '2026-11-23T09:00:00.000Z', finishedAt: '2026-11-23T09:02:00.000Z' });
  writeLegacy('legacy-t2', { startedAt: '2026-11-23T09:10:00.000Z', finishedAt: '2026-11-23T09:12:00.000Z' });
  assert.equal(existsSync(workerIndexPath(repo, 'legacy-w1')), false);

  assert.equal(service.resolveTurn('legacy-t1'), 'legacy-t1');
  const head = await service.resolveWorkerHead('legacy-w1');
  assert.equal(head.jobId, 'legacy-t3');
  assert.equal(head.turn, 3, 'a legacy turn is numbered by its start order');
  assert.equal((await service.resolveWorkerHead('legacy-t1')).jobId, 'legacy-t3');
  assert.equal((await service.resolveWorkerHead('legacy-w')).jobId, 'legacy-t3', 'by name too');
  const index = JSON.parse(readFileSync(workerIndexPath(repo, 'legacy-w1'), 'utf8'));
  assert.deepEqual(index.turns, ['legacy-t1', 'legacy-t2', 'legacy-t3']);

  const earlier = await service.earlierTurns('legacy-w1');
  assert.deepEqual(earlier.map((t) => [t.jobId, t.turn]), [['legacy-t1', 1], ['legacy-t2', 2]]);
  assert.equal((await service.resolveWorker('legacy-t2')).turn, 2);
});

test('a continuation of a legacy worker builds the full index first, so earlier turns are never hidden', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  for (const [id, at] of [['old-1', '2026-11-20T09:00:00.000Z'], ['old-2', '2026-11-20T10:00:00.000Z'], ['old-3', '2026-11-20T11:00:00.000Z']] as const) {
    const file = jobFile(repo, id, FILES.job);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      schema: 1, jobId: id, name: 'veteran', workerId: 'old-1', provider: 'codex', mode: 'implement', cwd: repo,
      status: 'succeeded', startedAt: at, createdAt: at, finishedAt: at,
    }));
  }
  const ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({ mode: 'implement', name: 'veteran', workerId: 'old-1', continuedFrom: 'old-3', prompt: 'Again.' });
  assert.equal(ack.turn, 4, 'numbered after the legacy turns, in start order');
  (await ready).finish({ status: 'success', response: 'ok' });
  await done;
  const index = JSON.parse(readFileSync(workerIndexPath(repo, 'old-1'), 'utf8'));
  assert.deepEqual(index.turns, ['old-1', 'old-2', 'old-3', ack.jobId]);
  assert.deepEqual((await service.earlierTurns(ack.jobId)).map((t) => [t.jobId, t.turn]), [['old-1', 1], ['old-2', 2], ['old-3', 3]]);
});

test('name rules (D5): running > spawned by this service (latest) > the single match > error listing candidates', async () => {
  const ctrl = controlledProvider();
  const { service: mine, repo } = makeService(ctrl.provider);
  const finish = async (svc: ForgeService, name: string, workerId?: string) => {
    const ready = ctrl.nextTurn();
    const { ack, done } = await svc.spawnTracked({ mode: 'review', name, prompt: 'x', ...(workerId ? { workerId } : {}) });
    (await ready).finish({ status: 'success', response: 'ok' });
    await done;
    await tick();
    return ack;
  };
  const a = await finish(mine, 'dup', 'dup-a');
  const b = await finish(mine, 'dup', 'dup-b');
  const solo = await finish(mine, 'solo');

  assert.equal((await mine.resolveWorkerHead('dup')).jobId, b.jobId);

  const other = serviceOn(repo, ctrl.provider);
  assert.equal((await other.resolveWorkerHead('solo')).jobId, solo.jobId);
  await assert.rejects(other.resolveWorkerHead('dup'), (e: Error) => {
    assert.equal(e.name, 'WorkerLookupError');
    assert.match(e.message, /"dup" matches 2 workers: dup \(\S+, finished \S+\), dup \(\S+, finished \S+\)/);
    assert.ok(e.message.includes(a.jobId) && e.message.includes(b.jobId));
    return true;
  });
  await assert.rejects(other.resolveWorkerHead('nobody'), /No worker "nobody"/);

  const runningReady = ctrl.nextTurn();
  const { ack: c, done: cDone } = await other.spawnTracked({ mode: 'review', name: 'dup', workerId: 'dup-c', prompt: 'x' });
  const running = await runningReady;
  assert.equal((await mine.resolveWorkerHead('dup')).jobId, c.jobId);
  running.finish({ status: 'success', response: 'ok' });
  await cDone;
});

test('compareTurnPriority (turns.ts): not handed off, running, higher turn, then newer start', () => {
  const items = [
    { jobId: 'a', status: 'succeeded', turn: 5, supersededBy: 'b', startedAt: '2026-11-23T12:00:00.000Z' },
    { jobId: 'f', status: 'succeeded', turn: 6, followedBy: 'g', startedAt: '2026-11-23T12:30:00.000Z' },
    { jobId: 'b', status: 'succeeded', turn: 2, startedAt: '2026-11-23T10:00:00.000Z' },
    { jobId: 'c', status: 'succeeded', turn: 3, startedAt: '2026-11-23T09:00:00.000Z' },
    { jobId: 'd', status: 'succeeded', turn: 3, startedAt: '2026-11-23T11:00:00.000Z' },
    { jobId: 'e', status: 'running', turn: 1, startedAt: '2026-11-23T08:00:00.000Z' },
  ];
  items.sort(compareTurnPriority);
  assert.deepEqual(items.map((x) => x.jobId), ['e', 'd', 'c', 'b', 'f', 'a']);
});
