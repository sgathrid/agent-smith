import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { spawnSync } from 'node:child_process';
import { readAcceptance, writeAcceptance } from '../checks.ts';
import { appendSteerEntry } from '../steer-log.ts';
import { LOCK_WAIT_MS, withWorkerLock } from '../worker-lock.ts';
import { STEER_NOT_APPLIED_RE } from '../../surfaces/mod/hooks/reasons.ts';
import { FILES, jobFile, readManifest } from '../format.ts';
import { ForgeService, type ForgeHooks } from '../service.ts';
import { controlledProvider, withDefaultProvider } from '../testing/steer-harness.ts';
import type { JobResult, Provider, ProviderEvent, SpawnSpec } from '../../providers/types.ts';
import { waitFor } from '../testing/time.ts';

function serviceOn(repo: string, provider: Provider, hooks?: ForgeHooks): ForgeService {
  return withDefaultProvider(new ForgeService({ repo, flushMs: 5, providerSource: () => provider, catalogSource: async () => [], ...(hooks ? { hooks } : {}) }));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newRepo = () => mkdtempSync(path.join(tmpdir(), 'agent-smith-delivery-'));
const now = () => new Date().toISOString();
const ownerDone = (repo: string, jobId: string) => existsSync(jobFile(repo, jobId, FILES.ownerDone));

async function startWorker(service: ForgeService, ctrl: ReturnType<typeof controlledProvider>, extra: Record<string, unknown> = {}) {
  const ready = ctrl.nextTurn();
  const tracked = await service.spawnTracked({ mode: 'implement', name: 'w', prompt: 'Turn one.', ...extra });
  const t1 = await ready;
  t1.emit({ kind: 'started', at: now(), conversationId: 'conv-w' });
  return { ...tracked, t1 };
}

async function settle(repo: string, turn: { finish(r: Partial<JobResult>): void; spec: SpawnSpec }, result: Partial<JobResult> = { status: 'success', response: 'ok' }) {
  turn.finish(result);
  await waitFor(() => ownerDone(repo, turn.spec.jobId!), { message: 'owner.done' });
}

test('a message sent while the owner is between its final read and finish is delivered, not lost', async () => {
  const repo = newRepo();
  const ctrl = controlledProvider();
  let caller!: ForgeService;
  let sent: Promise<unknown> | undefined;
  const owner = serviceOn(repo, ctrl.provider, {
    afterFinalRead: async () => {
      if (sent !== undefined) return;
      sent = caller.followUp({ worker: 'w', prompt: 'LATE-MESSAGE' });
      await Promise.race([sent, sleep(100)]);
    },
  });
  caller = serviceOn(repo, ctrl.provider);
  const t1Ready = ctrl.nextTurn();
  await owner.spawnTracked({ mode: 'implement', name: 'w', prompt: 'Turn one.' });
  const t1 = await t1Ready;
  t1.emit({ kind: 'started', at: now(), conversationId: 'conv-w' });
  const t2Ready = ctrl.nextTurn();
  t1.finish({ status: 'success', response: 'Done with turn one.' });
  await waitFor(() => sent !== undefined, { message: 'the owner reached its final read' });
  const ack = await sent;
  assert.ok(ack, 'the caller got an ack');
  const t2 = await Promise.race([t2Ready, sleep(3_000).then(() => null)]);
  assert.ok(t2 !== null, 'the acked message never reached the worker: no turn carried it');
  assert.match(t2.spec.prompt, /LATE-MESSAGE/);
  t2.finish({ status: 'success', response: 'ok' });
  assert.equal(ctrl.turns.filter((t) => t.spec.prompt.includes('LATE-MESSAGE')).length, 1);
});

test('a follow_up sent the moment a turn without checks settles starts a new turn', async () => {
  const repo = newRepo();
  const ctrl = controlledProvider();
  let caller!: ForgeService;
  let sent: Promise<Awaited<ReturnType<ForgeService['followUp']>>> | undefined;
  const owner = serviceOn(repo, ctrl.provider, {
    beforeOwnerDecision: async () => {
      sent ??= caller.followUp({ worker: 'w', prompt: 'RIGHT-AFTER', env: { K: 'v' } });
      await Promise.race([sent, sleep(100)]);
    },
  });
  caller = serviceOn(repo, ctrl.provider);
  const t1Ready = ctrl.nextTurn();
  const { ack } = await owner.spawnTracked({ mode: 'implement', name: 'w', prompt: 'Turn one.' });
  const t1 = await t1Ready;
  t1.emit({ kind: 'started', at: now(), conversationId: 'conv-w' });
  const t2Ready = ctrl.nextTurn();
  t1.finish({ status: 'success', response: 'ok' });
  await waitFor(() => sent !== undefined || ownerDone(repo, ack.jobId), { message: 'turn one settled' });
  sent ??= caller.followUp({ worker: 'w', prompt: 'RIGHT-AFTER', env: { K: 'v' } });
  const fu = await sent;
  const t2 = await t2Ready;
  assert.deepEqual({ action: fu.action, delivery: fu.delivery, jobId: fu.jobId, note: fu.note }, { action: 'started', delivery: 'now', jobId: t2.spec.jobId, note: 'Started turn 2.' });
  assert.equal(t2.spec.env?.['K'], 'v');
  t2.finish({ status: 'success', response: 'ok' });
});

test('a follow_up sent the moment the checks end is queued only while the head still shows them pending', async () => {
  const repo = newRepo();
  const ctrl = controlledProvider();
  let caller!: ForgeService;
  let sent: Promise<Awaited<ReturnType<ForgeService['followUp']>>> | undefined;
  let pendingAtAck: boolean | undefined;
  const owner = serviceOn(repo, ctrl.provider, {
    beforeOwnerDecision: async (jobId) => {
      if (sent !== undefined) return;
      sent = caller.followUp({ worker: 'w', prompt: 'AFTER-CHECKS' }).then((a) => {
        pendingAtAck = (readAcceptance(repo, jobId) as { pending?: boolean }).pending === true;
        return a;
      });
      await Promise.race([sent, sleep(100)]);
    },
  });
  caller = serviceOn(repo, ctrl.provider);
  const t1Ready = ctrl.nextTurn();
  await owner.spawnTracked({ mode: 'implement', name: 'w', prompt: 'Turn one.', checks: [{ name: 'ok', command: 'true' }], ownerChecks: true });
  const t1 = await t1Ready;
  t1.emit({ kind: 'started', at: now(), conversationId: 'conv-w' });
  const t2Ready = ctrl.nextTurn();
  t1.finish({ status: 'success', response: 'ok' });
  await waitFor(() => sent !== undefined, { message: 'the owner reached its decision' });
  const fu = await sent!;
  assert.deepEqual({ action: fu.action, note: fu.note, pendingAtAck }, { action: 'queued', note: 'Queued; runs after the checks.', pendingAtAck: true });
  const t2 = await t2Ready;
  assert.match(t2.spec.prompt, /AFTER-CHECKS/);
  assert.match(t2.spec.prompt, /\[ACCEPTANCE\] accepted/);
  t2.finish({ status: 'success', response: 'ok' });
});

test('a dead owner with queued messages: reconcile clears the count and warns; the next follow_up delivers them once', async () => {
  for (const state of ['running', 'checks', 'unpublished'] as const) {
    const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
    const { ack, t1 } = await startWorker(s, ctrl);
    await settle(repo, t1);
    unlinkSync(jobFile(repo, ack.jobId, FILES.ownerDone));
    const m = readManifest(repo, ack.jobId);
    const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString());
    const published = state === 'unpublished' ? 0 : 1;
    writeFileSync(jobFile(repo, ack.jobId, FILES.job), JSON.stringify({ ...m, ownerPid: dead, pendingSteers: published, ...(state === 'checks' ? {} : { status: 'running', finishedAt: null }) }));
    const progressFile = jobFile(repo, ack.jobId, FILES.progress);
    writeFileSync(progressFile, JSON.stringify({ ...JSON.parse(readFileSync(progressFile, 'utf8')), pendingSteers: published }));
    if (state === 'checks') writeAcceptance(repo, ack.jobId, { state: 'unchecked', checks: [], pending: true });
    appendSteerEntry(repo, ack.jobId, { id: 'msg-old', createdAt: now(), prompt: 'OLD-QUEUED message', delivery: 'queue', sender: 'follow_up' });

    const restarted = serviceOn(repo, ctrl.provider);
    const head = await restarted.resolveWorkerHead('w');
    assert.equal(head.pendingSteers ?? 0, 0, `${state}: job.json pending count`);
    const progress = JSON.parse(readFileSync(progressFile, 'utf8'));
    assert.equal(progress.pendingSteers, 0, `${state}: progress.json pending count`);
    const warning = '1 queued message not sent (owner stopped): "OLD-QUEUED message"';
    assert.ok(progress.warnings.includes(warning), `${state}: warning`);
    assert.match(warning, STEER_NOT_APPLIED_RE);
    assert.ok(ownerDone(repo, ack.jobId), `${state}: the reconciled turn is marked ownerless`);
    writeFileSync(jobFile(repo, ack.jobId, FILES.job), JSON.stringify({ ...readManifest(repo, ack.jobId), ownerPid: process.pid }));

    const t2Ready = ctrl.nextTurn();
    const fu = await restarted.followUp({ worker: 'w', prompt: 'NEW-ONE' });
    const t2 = await t2Ready;
    assert.equal(fu.action, 'started');
    assert.match(t2.spec.prompt, /OLD-QUEUED message[\s\S]*NEW-ONE/);
    t2.emit({ kind: 'started', at: now(), conversationId: 'conv-w' });
    await settle(repo, t2);
    const t3Ready = ctrl.nextTurn();
    await restarted.followUp({ worker: 'w', prompt: 'THIRD' });
    const t3 = await t3Ready;
    assert.doesNotMatch(t3.spec.prompt, /OLD-QUEUED/);
    t3.finish({ status: 'success', response: 'ok' });
  }
});

test('a worker running checks with a queued message keeps its name busy', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const gate = { name: 'gate', command: 'while [ ! -f GO ]; do sleep 0.02; done' };
  const { ack, t1 } = await startWorker(s, ctrl, { checks: [gate], ownerChecks: true, cwd: repo });
  t1.finish({ status: 'success', response: 'ok' });
  await waitFor(() => (readAcceptance(repo, ack.jobId) as { running?: string }).running === 'gate', { message: 'checks running' });
  await s.followUp({ worker: 'w', prompt: 'QUEUED' });
  await assert.rejects(serviceOn(repo, ctrl.provider).spawnJob({ mode: 'implement', name: 'w', prompt: 'Another w.' }), /"w" is busy.*follow_up/);
  const t2Ready = ctrl.nextTurn();
  writeFileSync(path.join(repo, 'GO'), '');
  const t2 = await t2Ready;
  assert.match(t2.spec.prompt, /QUEUED/);
  t2.finish({ status: 'success', response: 'ok' });
});

test('queued messages survive a continuation that cannot start; the next follow_up delivers them', async () => {
  const repo = newRepo(); const ctrl = controlledProvider();
  let broken = false;
  const s = withDefaultProvider(new ForgeService({ repo, flushMs: 5, catalogSource: async () => [], providerSource: () => {
    if (broken) throw new Error('provider unavailable');
    return ctrl.provider;
  } }));
  const gate = { name: 'gate', command: 'while [ ! -f GO ]; do sleep 0.02; done' };
  const { ack, t1 } = await startWorker(s, ctrl, { checks: [gate], ownerChecks: true, cwd: repo });
  t1.finish({ status: 'success', response: 'ok' });
  await waitFor(() => (readAcceptance(repo, ack.jobId) as { running?: string }).running === 'gate', { message: 'checks running' });
  await s.followUp({ worker: 'w', prompt: 'KEPT-1' });
  broken = true;
  writeFileSync(path.join(repo, 'GO'), '');
  await waitFor(() => ownerDone(repo, ack.jobId), { message: 'owner gave up' });
  broken = false;
  assert.equal(readManifest(repo, ack.jobId).pendingSteers, 0);
  const t2Ready = ctrl.nextTurn();
  const fu = await serviceOn(repo, ctrl.provider).followUp({ worker: 'w', prompt: 'KEPT-2' });
  const t2 = await t2Ready;
  assert.equal(fu.action, 'started');
  assert.match(t2.spec.prompt, /KEPT-1[\s\S]*KEPT-2/);
  t2.finish({ status: 'success', response: 'ok' });
});

test('cancel discards messages a stopped owner left undelivered; the next follow_up does not resurrect them', async () => {
  const repo = newRepo(); const ctrl = controlledProvider();
  let broken = false;
  const s = withDefaultProvider(new ForgeService({ repo, flushMs: 5, catalogSource: async () => [], providerSource: () => {
    if (broken) throw new Error('provider unavailable');
    return ctrl.provider;
  } }));
  const gate = { name: 'gate', command: 'while [ ! -f GO ]; do sleep 0.02; done' };
  const { ack, t1 } = await startWorker(s, ctrl, { checks: [gate], ownerChecks: true, cwd: repo });
  t1.finish({ status: 'success', response: 'ok' });
  await waitFor(() => (readAcceptance(repo, ack.jobId) as { running?: string }).running === 'gate', { message: 'checks running' });
  await s.followUp({ worker: 'w', prompt: 'STALE-QUEUED-MSG' });
  broken = true;
  writeFileSync(path.join(repo, 'GO'), '');
  await waitFor(() => ownerDone(repo, ack.jobId), { message: 'owner gave up' });
  broken = false;
  const caller = serviceOn(repo, ctrl.provider);
  const c = caller.cancel('w');
  assert.deepEqual({ discarded: c.discarded, warnings: c.warnings }, { discarded: 1, warnings: ['1 queued message discarded: "STALE-QUEUED-MSG"'] });
  const t2Ready = ctrl.nextTurn();
  await caller.followUp({ worker: 'w', prompt: 'FRESH-MSG' });
  const t2 = await t2Ready;
  assert.match(t2.spec.prompt, /FRESH-MSG/);
  assert.doesNotMatch(t2.spec.prompt, /STALE-QUEUED-MSG/);
  t2.finish({ status: 'success', response: 'ok' });
});

test('a turn that crashes with a queued message never reads idle before its continuation starts', async () => {
  const repo = newRepo(); const ctrl = controlledProvider();
  let pendingAtDecision: number | undefined;
  let crash!: (err: Error) => void;
  const baseSpawn = ctrl.provider.spawn.bind(ctrl.provider);
  let first = true;
  ctrl.provider.spawn = async (spec: SpawnSpec) => {
    const h = await baseSpawn(spec);
    if (!first) return h;
    first = false;
    const crashed = new Promise<never>((_, reject) => { crash = reject; });
    return { ...h, waitForResult: () => crashed };
  };
  const s = serviceOn(repo, ctrl.provider, { beforeOwnerDecision: (jobId) => { pendingAtDecision ??= readManifest(repo, jobId).pendingSteers; } });
  const { ack } = await startWorker(s, ctrl);
  await s.followUp({ worker: 'w', prompt: 'AFTER-CRASH' });
  const t2Ready = ctrl.nextTurn();
  crash(new Error('boom'));
  const t2 = await t2Ready;
  assert.equal(pendingAtDecision, 1, 'the crashed head still shows its queued message');
  assert.equal(readManifest(repo, ack.jobId).followedBy, t2.spec.jobId);
  assert.match(t2.spec.prompt, /AFTER-CRASH/);
  t2.finish({ status: 'success', response: 'ok' });
});

test('a watched file deleted while messages wait for the checks is a warning; both messages are delivered', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const gate = { name: 'gate', command: 'while [ ! -f GO ]; do sleep 0.02; done' };
  const { ack, t1 } = await startWorker(s, ctrl, { checks: [gate], ownerChecks: true, cwd: repo });
  t1.finish({ status: 'success', response: 'ok' });
  await waitFor(() => (readAcceptance(repo, ack.jobId) as { running?: string }).running === 'gate', { message: 'checks running' });
  writeFileSync(path.join(repo, 'temp.md'), 'brief');
  await s.followUp({ worker: 'w', prompt: 'PLAIN' });
  await s.followUp({ worker: 'w', prompt: 'WITH-FILE', files: ['temp.md'] });
  unlinkSync(path.join(repo, 'temp.md'));
  const t2Ready = ctrl.nextTurn();
  writeFileSync(path.join(repo, 'GO'), '');
  const t2 = await Promise.race([t2Ready, sleep(5_000).then(() => null)]);
  assert.ok(t2 !== null, 'no turn carried the acked messages');
  assert.match(t2.spec.prompt, /PLAIN[\s\S]*WITH-FILE/);
  await settle(repo, t2);
  const progress = JSON.parse(readFileSync(jobFile(repo, t2.spec.jobId!, FILES.progress), 'utf8'));
  assert.ok(progress.warnings.includes('dropped deleted watched file "temp.md" from continuation turn'), 'the dropped file is reported');
});

test('a cold follow_up syncs watched files first and names the synced ones in the prompt', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const cwd = mkdtempSync(path.join(tmpdir(), 'agent-smith-delivery-cwd-'));
  writeFileSync(path.join(repo, 'brief.md'), 'v1');
  const { t1 } = await startWorker(s, ctrl, { cwd, files: ['brief.md'] });
  await settle(repo, t1);
  writeFileSync(path.join(repo, 'brief.md'), 'v2');
  const t2Ready = ctrl.nextTurn();
  await s.followUp({ worker: 'w', prompt: 'READ-IT' });
  const t2 = await t2Ready;
  assert.match(t2.spec.prompt, /Synced brief file\(s\) in your working tree: brief\.md \(re-read before continuing\)/);
  assert.equal(readFileSync(path.join(cwd, 'brief.md'), 'utf8'), 'v2');
  t2.finish({ status: 'success', response: 'ok' });
});

test('a follow_up waits out a cold start that holds the worker lock longer than the default lock wait', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const { ack, t1 } = await startWorker(s, ctrl);
  await settle(repo, t1);
  const slowStart = withWorkerLock(repo, ack.workerId, () => sleep(LOCK_WAIT_MS + 1_000));
  await sleep(20);
  const t2Ready = ctrl.nextTurn();
  const fu = await s.followUp({ worker: 'w', prompt: 'AFTER-SLOW-START' });
  await slowStart;
  assert.equal(fu.action, 'started');
  (await t2Ready).finish({ status: 'success', response: 'ok' });
});

test('follow_up R: queued behind the running turn, delivered as the next turn', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const { ack, t1, done } = await startWorker(s, ctrl);
  const fu = await s.followUp({ worker: 'w', prompt: 'NEXT' });
  assert.deepEqual({ action: fu.action, jobId: fu.jobId, delivery: fu.delivery, pending: fu.pendingMessages, turn: fu.turn }, { action: 'queued', jobId: ack.jobId, delivery: 'turn-end', pending: 1, turn: 1 });
  const t2Ready = ctrl.nextTurn();
  t1.finish({ status: 'success', response: 'ok' });
  const t2 = await t2Ready;
  assert.match(t2.spec.prompt, /NEXT/);
  t2.finish({ status: 'success', response: 'ok' });
  const last = await done;
  assert.equal(last.turn, 2);
  assert.equal(last.continuationKind, 'follow-up');
});

test('follow_up C: queued during checks; the next turn gets the verdict block', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const gate = { name: 'gate', command: 'while [ ! -f GO ]; do sleep 0.02; done; echo boom-tail; exit 3' };
  const { ack, t1, done } = await startWorker(s, ctrl, { checks: [gate], ownerChecks: true, cwd: repo });
  t1.finish({ status: 'success', response: 'ok' });
  await waitFor(() => (readAcceptance(repo, ack.jobId) as { running?: string }).running === 'gate', { message: 'checks running' });
  const fu = await s.followUp({ worker: 'w', prompt: 'AFTER-VERDICT' });
  assert.equal(fu.action, 'queued');
  assert.equal(fu.jobId, ack.jobId);
  assert.equal(fu.delivery, 'turn-end');
  assert.deepEqual(fu.checks, ['gate']);
  assert.equal(readManifest(repo, ack.jobId).pendingSteers, 1, 'pendingMessages is published on the settled head');
  const t2Ready = ctrl.nextTurn();
  writeFileSync(path.join(repo, 'GO'), '');
  const t2 = await t2Ready;
  assert.match(t2.spec.prompt, /\[ACCEPTANCE\] rejected\ngate: FAIL \(exit 3\)/);
  assert.match(t2.spec.prompt, /boom-tail/);
  assert.match(t2.spec.prompt, /AFTER-VERDICT/);
  assert.equal(readAcceptance(repo, ack.jobId).state, 'rejected', "turn 1's verdict stands");
  assert.equal(readManifest(repo, ack.jobId).followedBy, t2.spec.jobId);
  t2.finish({ status: 'success', response: 'ok' });
  const last = await done;
  assert.equal(last.jobId, t2.spec.jobId);
  assert.equal(readAcceptance(repo, last.jobId).state, 'rejected', 'checks ran again when the worker went idle');
});

test('follow_up G: idle worker, owner gone -> started (cold), inheriting timeout, model, effort, checks', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const { ack, t1 } = await startWorker(s, ctrl, { timeoutMs: 4_000, model: 'm-1', effort: 'high', checks: [{ name: 'ok', command: 'true' }], ownerChecks: true });
  await settle(repo, t1);
  const t2Ready = ctrl.nextTurn();
  const fu = await s.followUp({ worker: 'w', prompt: 'COLD' });
  const t2 = await t2Ready;
  assert.equal(fu.action, 'started');
  assert.equal(fu.delivery, 'now');
  assert.equal(fu.jobId, t2.spec.jobId);
  assert.equal(fu.turn, 2);
  assert.equal(fu.timeoutMs, 4_000);
  assert.deepEqual(fu.checks, ['ok']);
  assert.equal(t2.spec.timeoutMs, 4_000);
  assert.equal(t2.spec.model, 'm-1');
  assert.equal(t2.spec.effort, 'high');
  assert.equal(t2.spec.conversation, 'conv-w');
  assert.match(t2.spec.prompt, /\[ACCEPTANCE\] accepted\nok: pass \(exit 0\)/);
  assert.match(t2.spec.prompt, /COLD/);
  const parent = readManifest(repo, ack.jobId);
  assert.equal(parent.followedBy, t2.spec.jobId);
  const view = JSON.parse(readFileSync(jobFile(repo, t2.spec.jobId!, FILES.view), 'utf8'));
  assert.deepEqual(view.timeline.filter((e: { kind: string }) => e.kind === 'message').map((e: Record<string, unknown>) => [e.text, e.delivery, e.sender]), [['COLD', 'turn-start', 'follow_up']]);
  await settle(repo, t2);
  assert.equal(readAcceptance(repo, t2.spec.jobId!).state, 'accepted', 'the cold start ran the inherited checks in its owner');
});

test('follow_up overrides apply to the next turn (timeoutMs, model) on a queued message', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const { t1 } = await startWorker(s, ctrl, { timeoutMs: 4_000 });
  const fu = await s.followUp({ worker: 'w', prompt: 'X', timeoutMs: 9_000, model: 'm-2' });
  assert.equal(fu.timeoutMs, 9_000);
  const t2Ready = ctrl.nextTurn();
  t1.finish({ status: 'success', response: 'ok' });
  const t2 = await t2Ready;
  assert.equal(t2.spec.timeoutMs, 9_000);
  assert.equal(t2.spec.model, 'm-2');
  assert.equal(readManifest(repo, t2.spec.jobId!).timeoutMs, 9_000);
  t2.finish({ status: 'success', response: 'ok' });
});

test('follow_up F: failed head with a conversation -> started (cold)', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const { ack, t1 } = await startWorker(s, ctrl);
  await settle(repo, t1, { status: 'error', exitCode: 1, response: '' });
  assert.equal(readManifest(repo, ack.jobId).status, 'failed');
  const t2Ready = ctrl.nextTurn();
  const fu = await s.followUp({ worker: 'w', prompt: 'RETRY' });
  const t2 = await t2Ready;
  assert.equal(fu.action, 'started');
  assert.match(t2.spec.prompt, /ended failed/);
  t2.finish({ status: 'success', response: 'ok' });
});

test('follow_up N and steer N: no saved conversation -> the spawn_job from: error', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const ready = ctrl.nextTurn();
  await s.spawnTracked({ mode: 'implement', name: 'w', prompt: 'Turn one.' });
  const t1 = await ready;
  await settle(repo, t1);
  await assert.rejects(s.followUp({ worker: 'w', prompt: 'x' }), /no saved conversation; spawn_job with from:"w" starts it fresh with the original brief/);
  await assert.rejects(s.steer({ worker: 'w', prompt: 'x' }), /no saved conversation/);
});

test('steer R: interrupting the running turn; the steered turn replaces it', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const { ack, t1, done } = await startWorker(s, ctrl);
  const t2Ready = ctrl.nextTurn();
  const st = await s.steer({ worker: 'w', prompt: 'REDIRECT' });
  assert.deepEqual({ action: st.action, jobId: st.jobId, delivery: st.delivery }, { action: 'interrupting', jobId: ack.jobId, delivery: 'now' });
  assert.equal(t1.cancelled, true);
  const t2 = await t2Ready;
  assert.match(t2.spec.prompt, /REDIRECT/);
  assert.equal(readManifest(repo, ack.jobId).supersededBy, t2.spec.jobId);
  t2.finish({ status: 'success', response: 'ok' });
  assert.equal((await done).continuationKind, 'steer');
});

test('steer C: aborts the running checks (aborted by steer) and chains the steered turn', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const slow = { name: 'slow', command: 'sleep 30' };
  const { ack, t1, done } = await startWorker(s, ctrl, { checks: [slow], ownerChecks: true });
  t1.finish({ status: 'success', response: 'ok' });
  await waitFor(() => (readAcceptance(repo, ack.jobId) as { running?: string }).running === 'slow', { message: 'checks running' });
  const t2Ready = ctrl.nextTurn();
  const st = await s.steer({ worker: 'w', prompt: 'STOP-CHECKS' });
  assert.equal(st.action, 'interrupting');
  assert.equal(st.jobId, ack.jobId, 'no new jobId to watch: the owner starts the steered turn');
  const t2 = await t2Ready;
  assert.deepEqual(readAcceptance(repo, ack.jobId), { ...readAcceptance(repo, ack.jobId), state: 'unchecked', reason: 'aborted by steer' });
  assert.match(t2.spec.prompt, /STOP-CHECKS/);
  const m2 = readManifest(repo, t2.spec.jobId!);
  assert.equal(m2.continuationKind, 'steer');
  assert.equal(readManifest(repo, ack.jobId).supersededBy, t2.spec.jobId, 'the steer replaced turn 1\'s checks phase');
  assert.equal(readManifest(repo, ack.jobId).followedBy, undefined);
  assert.equal(s.resolveTurn(st.jobId), t2.spec.jobId, 'the acked jobId leads to the steered turn');
  t2.finish({ status: 'success', response: 'ok' });
  await waitFor(() => (readAcceptance(repo, t2.spec.jobId!) as { running?: string }).running === 'slow', { message: 'checks again' });
  assert.equal(s.cancel(st.jobId).jobId, t2.spec.jobId);
  await done;
});

test('steer G and F: idle worker -> started (cold)', async () => {
  for (const result of [{ status: 'success' as const, response: 'ok' }, { status: 'error' as const, exitCode: 1, response: '' }]) {
    const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
    const { t1 } = await startWorker(s, ctrl);
    await settle(repo, t1, result);
    const t2Ready = ctrl.nextTurn();
    const st = await s.steer({ worker: 'w', prompt: 'NEW-DIRECTION' });
    const t2 = await t2Ready;
    assert.equal(st.action, 'started');
    assert.equal(st.jobId, t2.spec.jobId);
    const m2 = readManifest(repo, t2.spec.jobId!);
    assert.equal(m2.continuationKind, 'steer');
    assert.equal(m2.chainStartedAt, m2.startedAt, 'idle time before a cold steer is not part of the chain');
    t2.finish({ status: 'success', response: 'ok' });
  }
});

test('two concurrent follow_ups to an idle worker: one started, one queued, each delivered once', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const { t1 } = await startWorker(s, ctrl);
  await settle(repo, t1);
  const t2Ready = ctrl.nextTurn();
  const acks = await Promise.all([s.followUp({ worker: 'w', prompt: 'ALPHA' }), s.followUp({ worker: 'w', prompt: 'BETA' })]);
  assert.deepEqual(acks.map((a) => a.action).sort(), ['queued', 'started']);
  const t2 = await t2Ready;
  const t3Ready = ctrl.nextTurn();
  t2.emit({ kind: 'started', at: now(), conversationId: 'conv-w' });
  t2.finish({ status: 'success', response: 'ok' });
  const t3 = await t3Ready;
  t3.finish({ status: 'success', response: 'ok' });
  const prompts = ctrl.turns.map((t) => t.spec.prompt).join('\n');
  assert.equal(prompts.match(/ALPHA/g)?.length, 1);
  assert.equal(prompts.match(/BETA/g)?.length, 1);
});

test('env: set (passed), kept (vault, same service), dropped (fresh service = restart)', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const { t1 } = await startWorker(s, ctrl, { env: { TOKEN: 'v1' } });
  assert.equal(t1.spec.env?.['TOKEN'], 'v1');
  await settle(repo, t1);

  let ready = ctrl.nextTurn();
  const kept = await s.followUp({ worker: 'w', prompt: 'a' });
  const t2 = await ready;
  assert.equal(kept.env, 'kept');
  assert.equal(t2.spec.env?.['TOKEN'], 'v1');
  await settle(repo, t2);

  ready = ctrl.nextTurn();
  const set = await s.followUp({ worker: 'w', prompt: 'b', env: { OTHER: 'v2' } });
  const t3 = await ready;
  assert.equal(set.env, 'set');
  assert.deepEqual(t3.spec.env, { TOKEN: 'v1', OTHER: 'v2' });
  await settle(repo, t3);

  const restarted = serviceOn(repo, ctrl.provider);
  ready = ctrl.nextTurn();
  const dropped = await restarted.followUp({ worker: 'w', prompt: 'c' });
  const t4 = await ready;
  assert.equal(dropped.env, 'dropped');
  assert.deepEqual(dropped.envKeys, ['TOKEN', 'OTHER']);
  assert.match(dropped.warnings?.join('\n') ?? '', /env TOKEN, OTHER not set/);
  assert.equal(t4.spec.env, undefined);
  assert.equal(JSON.stringify(readManifest(repo, t4.spec.jobId!)).includes('v1'), false, 'no env value on disk');
  t4.finish({ status: 'success', response: 'ok' });
});

test('env: keys a worker ever had stay tracked; kept only when every key has a value', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const { t1 } = await startWorker(s, ctrl, { env: { A: '1' } });
  await settle(repo, t1);
  const restarted = serviceOn(repo, ctrl.provider);
  let ready = ctrl.nextTurn();
  const set = await restarted.followUp({ worker: 'w', prompt: 'b', env: { B: '2' } });
  const t2 = await ready;
  assert.deepEqual({ env: set.env, envKeys: set.envKeys }, { env: 'dropped', envKeys: ['A'] });
  assert.deepEqual(t2.spec.env, { B: '2' });
  await settle(repo, t2);
  ready = ctrl.nextTurn();
  const later = await restarted.followUp({ worker: 'w', prompt: 'c' });
  const t3 = await ready;
  assert.deepEqual({ env: later.env, envKeys: later.envKeys }, { env: 'dropped', envKeys: ['A'] });
  assert.deepEqual(t3.spec.env, { B: '2' });
  await settle(repo, t3);
  ready = ctrl.nextTurn();
  const full = await restarted.followUp({ worker: 'w', prompt: 'd', env: { A: '3' } });
  const t4 = await ready;
  assert.deepEqual({ env: full.env, envKeys: full.envKeys }, { env: 'set', envKeys: undefined });
  assert.deepEqual(t4.spec.env, { A: '3', B: '2' });
  t4.finish({ status: 'success', response: 'ok' });
});

test('env passed with a queued follow_up is kept for the next owner, with a warning', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const { t1 } = await startWorker(s, ctrl);
  const fu = await s.followUp({ worker: 'w', prompt: 'q', env: { K: 'v' } });
  assert.equal(fu.action, 'queued');
  assert.equal(fu.env, 'kept');
  assert.match(fu.warnings?.join('\n') ?? '', /env applies from the next new turn/);
  const t2Ready = ctrl.nextTurn();
  t1.finish({ status: 'success', response: 'ok' });
  (await t2Ready).finish({ status: 'success', response: 'ok' });
});

test('cancel discards queued messages and says how many; a message sent after cancel is delivered', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const caller = serviceOn(repo, ctrl.provider);
  const { ack, t1 } = await startWorker(s, ctrl);
  await caller.followUp({ worker: 'w', prompt: 'DROP-ME please, this is long enough to be quoted' });
  const c = caller.cancel('w');
  assert.equal(c.discarded, 1);
  assert.deepEqual(c.warnings, ['1 queued message discarded: "DROP-ME please, this is long enough to be quoted"']);
  const after = await caller.followUp({ worker: 'w', prompt: 'KEEP-ME' });
  assert.equal(after.action, 'queued');
  const t2Ready = ctrl.nextTurn();
  await waitFor(() => t1.cancelled, { message: 'turn 1 canceled' });
  const t2 = await t2Ready;
  assert.match(t2.spec.prompt, /KEEP-ME/);
  assert.doesNotMatch(t2.spec.prompt, /DROP-ME/);
  assert.equal(readManifest(repo, ack.jobId).status, 'canceled');
  t2.finish({ status: 'success', response: 'ok' });
});

test('cancel with an empty queue: a follow_up sent before the turn settles is delivered, nothing discarded', async () => {
  const repo = newRepo(); const ctrl = controlledProvider(); const s = serviceOn(repo, ctrl.provider);
  const caller = serviceOn(repo, ctrl.provider);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const baseSpawn = ctrl.provider.spawn.bind(ctrl.provider);
  ctrl.provider.spawn = async (spec: SpawnSpec) => {
    const h = await baseSpawn(spec);
    return { ...h, cancel() { void gate.then(() => h.cancel()); } };
  };
  await startWorker(s, ctrl);
  const c = caller.cancel('w');
  assert.equal(c.discarded, undefined);
  const fu = await caller.followUp({ worker: 'w', prompt: 'AFTER-CANCEL' });
  assert.equal(fu.action, 'queued');
  const t2Ready = ctrl.nextTurn();
  release();
  const t2 = await t2Ready;
  assert.match(t2.spec.prompt, /AFTER-CANCEL/);
  t2.finish({ status: 'success', response: 'ok' });
});

function selfDrivingProvider(rand: () => number, opts: { liveInput: boolean; turnMs: number; replayMs?: number }) {
  const prompts: string[] = [];
  const replayed: string[] = [];
  let seq = 0;
  const provider = {
    name: 'fake',
    ...(opts.liveInput ? { liveInput: true } : {}),
    async spawn(spec: SpawnSpec) {
      prompts.push(spec.prompt);
      const listeners = new Set<(e: ProviderEvent) => void>();
      const emit = (e: ProviderEvent) => { for (const l of listeners) l(e); };
      let finished = false;
      const unread: string[] = [];
      let resolve!: (r: JobResult) => void;
      const result = new Promise<JobResult>((r) => { resolve = r; });
      const finish = (status: JobResult['status']) => {
        if (finished) return;
        finished = true;
        resolve({ jobId: spec.jobId ?? 'j', provider: 'fake', ok: status === 'success', status, exitCode: status === 'success' ? 0 : null, signal: null,
          response: `turn ${++seq} done`, deniedActions: [], durationMs: 1, startedAt: now(), finishedAt: now(), stateDir: spec.stateDir ?? '',
          ...(unread.length > 0 ? { unreadInput: [...unread] } : {}) });
      };
      setTimeout(() => emit({ kind: 'started', at: now(), conversationId: 'conv-fuzz' }), 0);
      setTimeout(() => finish('success'), Math.floor(rand() * opts.turnMs));
      return {
        id: spec.jobId ?? 'j', stateDir: spec.stateDir ?? '',
        cancel() { setTimeout(() => finish('cancelled'), Math.floor(rand() * 5)); },
        onEvent(cb: (e: ProviderEvent) => void) { listeners.add(cb); return () => listeners.delete(cb); },
        waitForResult() { return result; },
        events: (async function* () {})(),
        ...(opts.liveInput ? {
          send(text: string) {
            if (finished) return false;
            unread.push(text);
            setTimeout(() => {
              if (finished) return;
              const i = unread.indexOf(text);
              if (i < 0) return;
              unread.splice(i, 1);
              replayed.push(text);
              emit({ kind: 'user-message', at: now(), text });
            }, Math.floor(rand() * (opts.replayMs ?? opts.turnMs)));
            return true;
          },
        } : {}),
      };
    },
  } as unknown as Provider;
  return { provider, prompts, replayed };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('live input: a plain follow_up is written into the running turn; read once, recorded as next-step', async () => {
  const repo = newRepo();
  const ctrl = controlledProvider();
  const sent: string[] = [];
  const baseSpawn = ctrl.provider.spawn.bind(ctrl.provider);
  (ctrl.provider as { liveInput?: boolean }).liveInput = true;
  ctrl.provider.spawn = async (spec: SpawnSpec) => ({ ...(await baseSpawn(spec)), send: (text: string) => { sent.push(text); return true; } });
  const s = serviceOn(repo, ctrl.provider);
  const { ack, t1, done } = await startWorker(s, ctrl);
  const fu = await s.followUp({ worker: 'w', prompt: 'LIVE-1' });
  assert.equal(fu.delivery, 'next-step');
  const queued = await s.followUp({ worker: 'w', prompt: 'NOT-LIVE', model: 'm-2' });
  assert.equal(queued.delivery, 'turn-end', 'a message with overrides waits for the turn end');
  await waitFor(() => sent.length === 1, { message: 'the owner wrote the message to the worker' });
  assert.deepEqual(sent, ['LIVE-1']);
  t1.emit({ kind: 'user-message', at: now(), text: 'LIVE-1' });
  await waitFor(() => readManifest(repo, ack.jobId).pendingSteers === 1, { message: 'pending drops on the replay' });
  const view = JSON.parse(readFileSync(jobFile(repo, ack.jobId, FILES.view), 'utf8'));
  const msg = view.timeline.find((e: { kind: string }) => e.kind === 'message');
  assert.deepEqual([msg.text, msg.delivery, msg.sender], ['LIVE-1', 'next-step', 'follow_up']);
  const t2Ready = ctrl.nextTurn();
  t1.finish({ status: 'success', response: 'ok' });
  const t2 = await t2Ready;
  assert.match(t2.spec.prompt, /NOT-LIVE/);
  assert.doesNotMatch(t2.spec.prompt, /LIVE-1/, 'read once: not delivered again');
  t2.finish({ status: 'success', response: 'ok' });
  await done;
});

test('live input: a follow_up sent after a cancel from another process waits for the next turn', async () => {
  const repo = newRepo();
  const ctrl = controlledProvider();
  const baseSpawn = ctrl.provider.spawn.bind(ctrl.provider);
  (ctrl.provider as { liveInput?: boolean }).liveInput = true;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  ctrl.provider.spawn = async (spec: SpawnSpec) => {
    const h = await baseSpawn(spec);
    return { ...h, send: () => true, cancel() { void gate.then(() => h.cancel()); } };
  };
  const s = serviceOn(repo, ctrl.provider);
  const caller = serviceOn(repo, ctrl.provider);
  await startWorker(s, ctrl);
  caller.cancel('w');
  const fu = await caller.followUp({ worker: 'w', prompt: 'AFTER-CANCEL' });
  assert.equal(fu.delivery, 'turn-end');
  const t2Ready = ctrl.nextTurn();
  release();
  (await t2Ready).finish({ status: 'success', response: 'ok' });
});

test('live input: a replay is matched to its message by text, not taken as the next one sent', async () => {
  const repo = newRepo();
  const ctrl = controlledProvider();
  const sent: string[] = [];
  const baseSpawn = ctrl.provider.spawn.bind(ctrl.provider);
  (ctrl.provider as { liveInput?: boolean }).liveInput = true;
  ctrl.provider.spawn = async (spec: SpawnSpec) => ({ ...(await baseSpawn(spec)), send: (text: string) => { sent.push(text); return true; } });
  const s = serviceOn(repo, ctrl.provider);
  const { ack, t1, done } = await startWorker(s, ctrl);
  await s.followUp({ worker: 'w', prompt: 'LIVE-A' });
  await s.followUp({ worker: 'w', prompt: 'LIVE-B' });
  await waitFor(() => sent.length === 2, { message: 'both written to the worker' });
  const read = () => JSON.parse(readFileSync(jobFile(repo, ack.jobId, FILES.view), 'utf8')).timeline
    .filter((e: { kind: string }) => e.kind === 'message').map((e: { text: string }) => e.text);
  t1.emit({ kind: 'user-message', at: now(), text: 'LIVE-B' });
  await sleep(50);
  assert.deepEqual(read(), [], 'LIVE-A was not replayed, so it is not read');
  t1.emit({ kind: 'user-message', at: now(), text: 'LIVE-A' });
  await waitFor(() => read().length === 2, { message: 'both read' });
  assert.deepEqual(read(), ['LIVE-A', 'LIVE-B']);
  t1.finish({ status: 'success', response: 'ok' });
  await done;
  assert.equal(ctrl.turns.length, 1, 'nothing left for another turn');
});

test('live input: a message sent but never read (unreadInput) is delivered as the next turn', async () => {
  const repo = newRepo();
  const ctrl = controlledProvider();
  const baseSpawn = ctrl.provider.spawn.bind(ctrl.provider);
  (ctrl.provider as { liveInput?: boolean }).liveInput = true;
  let sent = 0;
  ctrl.provider.spawn = async (spec: SpawnSpec) => ({ ...(await baseSpawn(spec)), send: () => { sent += 1; return true; } });
  const s = serviceOn(repo, ctrl.provider);
  const { t1 } = await startWorker(s, ctrl);
  await s.followUp({ worker: 'w', prompt: 'UNREAD' });
  await waitFor(() => sent === 1, { message: 'sent' });
  const t2Ready = ctrl.nextTurn();
  t1.finish({ status: 'success', response: 'ok', unreadInput: ['UNREAD'] });
  const t2 = await t2Ready;
  assert.match(t2.spec.prompt, /UNREAD/);
  t2.finish({ status: 'success', response: 'ok' });
});

test('live input: a plain follow_up behind a turn-end message reports delivery turn-end', async () => {
  const repo = newRepo();
  const ctrl = controlledProvider();
  const sent: string[] = [];
  const baseSpawn = ctrl.provider.spawn.bind(ctrl.provider);
  (ctrl.provider as { liveInput?: boolean }).liveInput = true;
  ctrl.provider.spawn = async (spec: SpawnSpec) => ({ ...(await baseSpawn(spec)), send: (text: string) => { sent.push(text); return true; } });
  const s = serviceOn(repo, ctrl.provider);
  const { t1, done } = await startWorker(s, ctrl);
  const first = await s.followUp({ worker: 'w', prompt: 'TURN-END-FIRST', model: 'm-2' });
  assert.equal(first.delivery, 'turn-end');
  const second = await s.followUp({ worker: 'w', prompt: 'PLAIN-BEHIND' });
  assert.equal(second.delivery, 'turn-end', 'blocked behind an earlier turn-end message');
  const t2Ready = ctrl.nextTurn();
  t1.finish({ status: 'success', response: 'ok' });
  const t2 = await t2Ready;
  assert.deepEqual(sent, [], 'neither message was written to stdin');
  assert.match(t2.spec.prompt, /TURN-END-FIRST/);
  assert.match(t2.spec.prompt, /PLAIN-BEHIND/);
  t2.finish({ status: 'success', response: 'ok' });
  await done;
});

test('legacy terminal head with an alive ownerPid and no owner.done starts a new turn on follow_up', async () => {
  const repo = newRepo();
  const ctrl = controlledProvider();
  const s = serviceOn(repo, ctrl.provider);
  const legacyId = 'implement-smith-legacy01';
  const dir = path.dirname(jobFile(repo, legacyId, FILES.job));
  mkdirSync(dir, { recursive: true });
  const ts = now();
  writeFileSync(jobFile(repo, legacyId, FILES.job), JSON.stringify({
    schema: 1,
    jobId: legacyId,
    name: 'legacy-w',
    workerId: legacyId,
    provider: 'fake',
    mode: 'implement',
    model: 'm-1',
    effort: null,
    cwd: repo,
    task: 'legacy task',
    promptChars: 11,
    unrestricted: false,
    conversation: 'conv-legacy',
    ownerPid: process.pid,
    status: 'succeeded',
    createdAt: ts,
    updatedAt: ts,
    startedAt: ts,
    finishedAt: ts,
    exitCode: 0,
    jobStatus: 'success',
    error: null,
    deniedActions: [],
    usage: null,
    toolCalls: 1,
    pipeline: null,
    stage: null,
    attempt: null,
  }));
  const t2Ready = ctrl.nextTurn();
  const fu = await s.followUp({ worker: 'legacy-w', prompt: 'AFTER-LEGACY' });
  const t2 = await t2Ready;
  assert.equal(fu.action, 'started');
  assert.equal(fu.delivery, 'now');
  assert.equal(fu.jobId, t2.spec.jobId);
  assert.equal(fu.turn, 2);
  assert.match(t2.spec.prompt, /AFTER-LEGACY/);
  t2.finish({ status: 'success', response: 'ok' });
});

test('terminal 0.5 head with an alive ownerPid, no owner.done, and finishedAt past grace starts a new turn', async () => {
  const repo = newRepo();
  const ctrl = controlledProvider();
  const s = serviceOn(repo, ctrl.provider);
  const { ack, t1 } = await startWorker(s, ctrl);
  await settle(repo, t1);
  unlinkSync(jobFile(repo, ack.jobId, FILES.ownerDone));
  const old = new Date(Date.now() - 15_000).toISOString();
  const m = readManifest(repo, ack.jobId);
  writeFileSync(jobFile(repo, ack.jobId, FILES.job), JSON.stringify({ ...m, ownerPid: process.pid, finishedAt: old, updatedAt: old }));
  const t2Ready = ctrl.nextTurn();
  const fu = await s.followUp({ worker: 'w', prompt: 'AFTER-GRACE' });
  const t2 = await t2Ready;
  assert.equal(fu.action, 'started');
  assert.equal(fu.jobId, t2.spec.jobId);
  assert.match(t2.spec.prompt, /AFTER-GRACE/);
  t2.finish({ status: 'success', response: 'ok' });
});

test('fuzz: messages at random points across turn end, checks and owner exit are delivered exactly once', async () => {
  const started = Date.now();
  const seeds = Number(process.env['AGENT_SMITH_FUZZ_SEEDS'] ?? 24);
  for (let seed = 1; seed <= seeds; seed++) {
    const rand = mulberry32(seed);
    const liveInput = rand() < 0.5;
    const withChecks = rand() < 0.5;
    const repo = newRepo();
    const fake = selfDrivingProvider(rand, { liveInput, turnMs: 30 });
    const jitter: ForgeHooks = { afterFinalRead: async () => { if (rand() < 0.5) await sleep(Math.floor(rand() * 15)); } };
    const owner = serviceOn(repo, fake.provider, jitter);
    const caller = serviceOn(repo, fake.provider);
    await owner.spawnTracked({
      mode: 'implement', name: 'w', prompt: 'Turn one.',
      ...(withChecks ? { checks: [{ name: 'c', command: 'sleep 0.03' }], ownerChecks: true } : {}),
    });
    const n = 3 + Math.floor(rand() * 4);
    const tokens: string[] = [];
    const sends: Promise<unknown>[] = [];
    for (let i = 0; i < n; i++) {
      await sleep(Math.floor(rand() * 60));
      const token = `TOKEN-${seed}-${i}-END`;
      tokens.push(token);
      const svc = rand() < 0.7 ? caller : owner;
      const steer = rand() < 0.2;
      sends.push(steer ? svc.steer({ worker: 'w', prompt: token }) : svc.followUp({ worker: 'w', prompt: token }));
    }
    const acks = await Promise.all(sends);
    assert.equal(acks.length, n);
    await waitFor(() => {
      const head = caller.resolveWorkerHeadId('w');
      return ownerDone(repo, head) && readManifest(repo, head).status !== 'running';
    }, { timeoutMs: 20_000, message: `seed ${seed}: worker idle` });
    const seen = [...fake.prompts, ...fake.replayed].join('\n');
    for (const t of tokens) {
      const count = seen.split(t).length - 1;
      assert.equal(count, 1, `seed ${seed} (liveInput ${liveInput}, checks ${withChecks}): ${t} delivered ${count} times`);
    }
  }
  process.stderr.write(`fuzz: ${seeds} seeds in ${Date.now() - started} ms\n`);
});
