import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { SpawnSpec } from '../../providers/types.ts';
import { readAcceptance } from '../checks.ts';
import { FILES, jobFile } from '../format.ts';
import { buildSteeredPrompt } from '../steer-log.ts';
import { ForgeTasks } from '../../surfaces/channel/src/tasks.ts';
import { callTool } from '../../surfaces/channel/src/tools.ts';
import { isLive } from '../../surfaces/mod/hooks/dashboard.ts';
import { controlledProvider, makeService } from '../testing/steer-harness.ts';
import { waitFor } from '../testing/time.ts';

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

  const steer1 = await service.followUp({
    worker: 'shell',
    prompt: 'Also export NavItemProps.',
    context: 'Needed by consumers.',
  });
  assert.equal(steer1.jobId, ack.jobId);
  assert.equal(steer1.status, 'running');
  assert.equal(steer1.action, 'queued');
  assert.equal(steer1.turn, 1);
  assert.equal(steer1.workerId, ack.workerId);
  assert.equal(steer1.pendingMessages, 1);
  assert.equal(steer1.delivery, 'turn-end');

  const steer2 = await service.followUp({
    worker: ack.jobId,
    prompt: 'And add keyboard shortcuts.',
  });
  assert.equal(steer2.pendingMessages, 2);

  const turn2Ready = ctrl.nextTurn();
  turn1.finish({ status: 'success', response: 'Sidebar navigation component implemented and exported with full keyboard support.' });

  const turn2 = await turn2Ready;
  assert.equal(turn2.spec.conversation, 'thread-shell');
  assert.match(turn2.spec.prompt, /^Context: Needed by consumers\./);
  assert.match(turn2.spec.prompt, /Your previous turn completed\./);
  assert.match(turn2.spec.prompt, /1\. Also export NavItemProps\.\n\n2\. And add keyboard shortcuts\./);

  turn2.finish({ status: 'success', response: 'Exported NavItemProps interface and wired keyboard shortcuts into the component.' });

  const finalManifest = await done;
  assert.notEqual(finalManifest.jobId, ack.jobId);
  assert.equal(finalManifest.status, 'succeeded');
  assert.equal(finalManifest.turn, 2);
  assert.equal(finalManifest.continuedFrom, ack.jobId);
  assert.equal(finalManifest.continuationKind, 'follow-up');
  assert.notEqual(finalManifest.chainStartedAt, ack.chainStartedAt, 'a follow-up starts a new chain clock');
  assert.equal(finalManifest.chainStartedAt, finalManifest.startedAt);
  assert.equal('steeredFrom' in finalManifest, false);
  assert.equal(finalManifest.name, 'shell');

  const parentDetail = await service.detail(ack.jobId);
  assert.equal(parentDetail.status, 'succeeded');
  assert.equal(parentDetail.supersededBy, undefined);
  assert.equal(parentDetail.followedBy, finalManifest.jobId);
  assert.equal(existsSync(jobFile(service.repo, ack.jobId, FILES.steerHead)), false, 'no steer.head for a follow-up');
  assert.equal(service.resolveTurn(ack.jobId), ack.jobId);
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
  });
  assert.equal(steerAck.status, 'running');
  assert.equal(steerAck.action, 'interrupting');
  assert.equal(steerAck.turn, 1);
  assert.equal(turn1.cancelled, true);
  assert.match(readFileSync(jobFile(repo, ack.jobId, FILES.steer), 'utf8'), /"sender":"steer"/);

  const turn2 = await turn2Ready;
  assert.equal(turn2.spec.conversation, 'thread-interrupt');
  assert.match(turn2.spec.prompt, /^Your previous turn was interrupted with updated instructions\. Inspect your working tree before repeating any completed steps\./);
  assert.match(turn2.spec.prompt, /Stop sidebar; move navigation to the profile menu\./);

  const parentManifest = JSON.parse(readFileSync(jobFile(repo, ack.jobId, FILES.job), 'utf8'));
  assert.equal(parentManifest.status, 'canceled');
  assert.ok(parentManifest.supersededBy, 'parent manifest has supersededBy set atomically');

  turn2.finish({ status: 'success', response: 'Moved the navigation links into the user profile dropdown menu and removed sidebar.' });
  const finalManifest = await done;
  assert.equal(finalManifest.jobId, parentManifest.supersededBy);
  assert.equal(finalManifest.status, 'succeeded');
  assert.equal(finalManifest.turn, 2);
  assert.equal(finalManifest.continuedFrom, ack.jobId);
  assert.equal(finalManifest.continuationKind, 'steer');
  assert.equal(finalManifest.chainStartedAt, ack.chainStartedAt);
});

test('steer(interrupt) before conversation ID arrives fails closed unless allowFresh: true is passed', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);

  const turn1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'early',
    prompt: 'Initial task.',
  });
  const turn1 = await turn1Ready;

  await assert.rejects(
    service.steer({
      worker: 'early',
      prompt: 'Updated task instructions.',
    }),
    /no resumable conversation handle.*allowFresh: true/,
  );
  assert.equal(turn1.cancelled, false);
  assert.equal(existsSync(jobFile(repo, ack.jobId, FILES.cancelSteer)), false);
  assert.equal(existsSync(jobFile(repo, ack.jobId, FILES.steer)), false);

  const turn2Ready = ctrl.nextTurn();
  const steerAck = await service.steer({
    worker: 'early',
    prompt: 'Updated task instructions.',
    allowFresh: true,
  });
  assert.equal(steerAck.status, 'running');
  assert.equal(steerAck.action, 'interrupting');

  const turn2 = await turn2Ready;
  assert.equal(turn2.spec.conversation, undefined);
  assert.match(turn2.spec.prompt, /This starts a fresh conversation\./);
  assert.match(turn2.spec.prompt, /orchestrating agent/);
  assert.match(turn2.spec.prompt, /Updated task instructions\./);

  turn2.finish({ status: 'success', response: 'Completed fresh continuation with the updated task instructions end-to-end.' });
  const finalManifest = await done;
  assert.equal(finalManifest.turn, 2);
  assert.equal(finalManifest.continuedFrom, ack.jobId);
  assert.equal(finalManifest.continuationKind, 'steer');
  assert.equal(finalManifest.chainStartedAt, ack.chainStartedAt);
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

  await service.followUp({
    worker: 'cancellable',
    prompt: 'Follow up.',
  });

  const cancelResult = service.cancel(ack.jobId);
  assert.equal(cancelResult.discarded, 1);
  assert.deepEqual(cancelResult.warnings, ['1 queued message discarded: "Follow up."']);
  const finalManifest = await done;
  assert.equal(finalManifest.jobId, ack.jobId);
  assert.equal(finalManifest.status, 'canceled');
  const canceledDetail = await service.detail(ack.jobId);
  assert.ok(canceledDetail.warnings.some((w) => w.message === '1 queued message discarded: "Follow up."'), JSON.stringify(canceledDetail.warnings));
  assert.equal(finalManifest.supersededBy, undefined);
  assert.equal(ctrl.turns.length, 1);
});

test('follow_up/steer refuse a worker with no saved conversation, pipeline stages, and an orphan with no conversation', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);

  const t1 = ctrl.nextTurn();
  const { ack: revAck, done } = await service.spawnTracked({
    mode: 'review',
    name: 'reviewer',
    prompt: 'Review.',
  });
  (await t1).finish({ status: 'success', response: 'LGTM.' });
  await done;

  await assert.rejects(
    service.followUp({ worker: 'reviewer', prompt: 'More.' }),
    new RegExp(`"reviewer" \\(${revAck.jobId}\\) has no saved conversation; spawn_job with from:"reviewer" starts it fresh`),
  );
  await assert.rejects(service.steer({ worker: 'reviewer', prompt: 'More.' }), /has no saved conversation/);

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
    service.steer({ worker: stageSpawn.ack.jobId, prompt: 'Redirect.' }),
    /is a pipeline stage/,
  );
  ctrl.turns[1]!.finish({ status: 'success', response: 'Done.' });
  await stageSpawn.done;

  const t3 = ctrl.nextTurn();
  const orphanSpawn = await service.spawnTracked({
    mode: 'implement',
    name: 'orphan-worker',
    prompt: 'Work.',
  });
  (await t3).finish({ status: 'success', response: 'Done.' });
  await orphanSpawn.done;

  try { unlinkSync(jobFile(repo, orphanSpawn.ack.jobId, FILES.result)); } catch { }
  const manifestPath = jobFile(repo, orphanSpawn.ack.jobId, FILES.job);
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  m.status = 'running';
  m.finishedAt = null;
  m.ownerPid = 999_999_999;
  writeFileSync(manifestPath, JSON.stringify(m));

  await assert.rejects(
    service.followUp({ worker: orphanSpawn.ack.jobId, prompt: 'Steer orphan.' }),
    /has no saved conversation/,
  );
  assert.equal((await service.detail(orphanSpawn.ack.jobId)).status, 'failed', 'the orphan was reconciled first');
});

test('user cancel() after steer(interrupt) wins and prevents chaining', async () => {
  const ctrl = controlledProvider();
  const { service } = makeService(ctrl.provider);

  let releaseCancel = false;
  const baseSpawn = ctrl.provider.spawn.bind(ctrl.provider);
  ctrl.provider.spawn = async (spec: SpawnSpec) => {
    const h = await baseSpawn(spec);
    return {
      ...h,
      cancel() {
        if (releaseCancel) h.cancel();
      },
    };
  };

  const turn1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'race-cancel',
    prompt: 'Start work.',
  });
  const turn1 = await turn1Ready;
  turn1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'thread-race' });

  await service.steer({
    worker: ack.jobId,
    prompt: 'Redirect before user cancel.',
  });

  service.cancel(ack.jobId);
  turn1.finish({ status: 'cancelled', exitCode: null, response: '' });

  const finalManifest = await done;
  assert.equal(finalManifest.jobId, ack.jobId);
  assert.equal(finalManifest.status, 'canceled');
  assert.equal(finalManifest.supersededBy, undefined);
  assert.equal(ctrl.turns.length, 1);
});

test('cancel(parentId) and status(parentId, { wait_ms }) follow supersededBy to the chain head', async () => {
  const ctrl = controlledProvider();
  const { service } = makeService(ctrl.provider);

  const t1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'chain-worker',
    prompt: 'Turn 1.',
  });
  const t1 = await t1Ready;
  t1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'thread-chain' });

  const t2Ready = ctrl.nextTurn();
  await service.steer({
    worker: ack.jobId,
    prompt: 'Turn 2.',
  });
  const t2 = await t2Ready;

  const waitingStatus = callTool(
    { service, pollMs: 10 },
    'status',
    { id: ack.jobId, wait_ms: 40 },
  );
  const stillRunningRes = JSON.parse(((await waitingStatus).content[0] as { text: string }).text);
  assert.equal(stillRunningRes.jobId, t2.spec.jobId);
  assert.equal(stillRunningRes.stillRunning, true);

  const cancelRes = service.cancel(ack.jobId);
  assert.equal(cancelRes.jobId, t2.spec.jobId);
  assert.equal(cancelRes.resolvedFrom, ack.jobId);
  assert.equal('supersededBy' in cancelRes, false);
  assert.equal(service.cancel(cancelRes.jobId).resolvedFrom, undefined);
  assert.equal(cancelRes.signalled, true);
  assert.equal(t2.cancelled, true);

  const finalManifest = await done;
  assert.equal(finalManifest.jobId, t2.spec.jobId);
  assert.equal(finalManifest.status, 'canceled');
});

test('checks on a steered worker mark child accepted and leave superseded parent unchecked (not live or accepted)', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);

  const t1Ready = ctrl.nextTurn();
  const spawnOut = await callTool(
    { service, catalogs: async () => [] },
    'spawn_job',
    {
      mode: 'implement',
      provider: 'codex',
      name: 'checked-worker',
      prompt: 'Turn 1.',
      checks: [{ name: 'ok', command: 'true' }],
    },
  );
  const ack = JSON.parse((spawnOut.content[0] as { text: string }).text);
  const t1 = await t1Ready;
  t1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'thread-checks' });

  const t2Ready = ctrl.nextTurn();
  await callTool(
    { service, catalogs: async () => [] },
    'steer',
    {
      worker: ack.jobId,
      prompt: 'Turn 2.',
    },
  );
  const t2 = await t2Ready;
  const childJobId = t2.spec.jobId!;

  const parentAccDuring = readAcceptance(repo, ack.jobId);
  assert.equal(parentAccDuring.state, 'unchecked');
  assert.equal('pending' in parentAccDuring && parentAccDuring.pending, false);
  assert.equal(
    isLive({
      id: ack.jobId,
      status: 'canceled',
      supersededBy: childJobId,
      acceptance: { state: 'unchecked', checks: [], pending: true },
    } as never),
    false,
  );

  t2.finish({ status: 'success', response: 'Completed turn 2 and verified checks.' });

  await waitFor(() => readAcceptance(repo, childJobId).state === 'accepted', { message: 'child acceptance to settle' });

  const childAcc = readAcceptance(repo, childJobId);
  assert.equal(childAcc.state, 'accepted');
  const parentAccFinal = readAcceptance(repo, ack.jobId);
  assert.equal(parentAccFinal.state, 'unchecked');
});

test('ForgeTasks tracks steered continuation turns through to completion', async () => {
  const ctrl = controlledProvider();
  const { service } = makeService(ctrl.provider);
  const tasks = new ForgeTasks({ service, catalogs: async () => [], pollMs: 10 });

  const t1Ready = ctrl.nextTurn();
  const created = await tasks.launch(
    { service, catalogs: async () => [], pollMs: 10 },
    'spawn_job',
    { mode: 'implement', provider: 'codex', name: 'task-steered', prompt: 'Turn 1.' },
  );
  assert.ok('taskId' in created && typeof created.taskId === 'string');
  const taskId: string = created.taskId;

  const t1 = await t1Ready;
  t1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'thread-tasks' });

  const t2Ready = ctrl.nextTurn();
  await service.steer({
    worker: 'task-steered',
    prompt: 'Turn 2.',
  });
  const t2 = await t2Ready;

  const mid = await tasks.get(taskId);
  assert.equal(mid.status, 'working');

  t2.finish({ status: 'success', response: 'Completed turn 2 cleanly via MCP Tasks.' });
  await waitFor(async () => (await tasks.get(taskId)).status !== 'working', { message: 'task to leave working' });
  const doneTask = await tasks.get(taskId);
  assert.equal(doneTask.status, 'completed');
});

test('queue steer when provider reports no conversation ID chains a fresh continuation instead of dropping', async () => {
  const ctrl = controlledProvider();
  const { service } = makeService(ctrl.provider);

  const t1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'no-conv-queue',
    prompt: 'Turn 1.',
  });
  const t1 = await t1Ready;

  const steerAck = await service.followUp({
    worker: ack.jobId,
    prompt: 'Queued follow-up without conversation ID.',
  });
  assert.equal(steerAck.action, 'queued');

  const t2Ready = ctrl.nextTurn();
  t1.finish({ status: 'success', response: 'Finished turn 1 without conversation ID.' });

  const t2 = await t2Ready;
  assert.equal(t2.spec.conversation, undefined);
  assert.match(t2.spec.prompt, /This starts a fresh conversation\./);
  assert.match(t2.spec.prompt, /Queued follow-up without conversation ID\./);

  t2.finish({ status: 'success', response: 'Finished fresh continuation turn 2.' });
  const finalManifest = await done;
  assert.equal(finalManifest.turn, 2);
  assert.equal(finalManifest.continuedFrom, ack.jobId);
  assert.equal(finalManifest.continuationKind, 'follow-up');
  assert.equal(finalManifest.status, 'succeeded');
});

test('a queued follow-up behind a failed turn is delivered as the next turn (revised D4)', async () => {
  const ctrl = controlledProvider();
  const { service } = makeService(ctrl.provider);

  const t1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'failed-queue',
    prompt: 'Work.',
  });
  const t1 = await t1Ready;
  await service.followUp({
    worker: ack.jobId,
    prompt: 'Follow up after the turn.',
  });

  const t2Ready = ctrl.nextTurn();
  t1.finish({ status: 'error', exitCode: 1, response: '' });
  const t2 = await t2Ready;
  assert.match(t2.spec.prompt, /Your previous turn ended failed\./);
  assert.match(t2.spec.prompt, /Follow up after the turn\./);
  t2.finish({ status: 'success', response: 'Recovered.' });
  const finalManifest = await done;
  assert.equal(finalManifest.continuedFrom, ack.jobId);
  assert.equal(finalManifest.status, 'succeeded');
  const detail = await service.detail(ack.jobId);
  assert.equal(detail.status, 'failed', "the failed turn's own result stands");
  assert.equal(detail.followedBy, finalManifest.jobId);
  assert.equal(detail.pendingSteers, 0);
});

test('resolveTurn crosses the finish window through steer.head before supersededBy is stamped', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  const writeManifest = (id: string, extra: Record<string, unknown>) => {
    const file = jobFile(repo, id, FILES.job);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ jobId: id, name: 'w', workerId: 'w', status: 'running', ...extra }));
  };

  writeManifest('parent', {});
  writeFileSync(jobFile(repo, 'parent', FILES.steerHead), 'child\n');
  writeManifest('child', { turn: 2, continuedFrom: 'parent', continuationKind: 'steer' });

  assert.equal(service.resolveTurn('parent'), 'child');
  assert.equal(service.resolveHead('parent'), 'child', 'the deprecated alias is resolveTurn');
});

test('a writing turn whose cwd vanished fails, and its queued follow-up is still delivered', async () => {
  const ctrl = controlledProvider();
  const { service } = makeService(ctrl.provider);
  const cwd = mkdtempSync(path.join(tmpdir(), 'agent-smith-steer-cwd-'));
  const t1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({ mode: 'implement', name: 'cwd-gone', prompt: 'Work.', cwd });
  const t1 = await t1Ready;
  await service.followUp({ worker: ack.jobId, prompt: 'Then this.' });
  rmSync(cwd, { recursive: true, force: true });
  const t2Ready = ctrl.nextTurn();
  t1.finish({ status: 'success' });
  const t2 = await t2Ready;
  assert.match(t2.spec.prompt, /ended failed/);
  t2.finish({ status: 'success' });
  await done;
  const detail = await service.detail(ack.jobId);
  assert.equal(detail.status, 'failed');
  assert.equal(ctrl.turns.length, 2);
});

test('buildSteeredPrompt emits plain sentences without bracketed tags or uppercase labels', () => {
  const singleCompleted = buildSteeredPrompt({
    wasInterrupted: false,
    priorStatus: 'succeeded',
    freshContinuation: false,
    responseTail: 'Ignored tail.',
    entries: [{ prompt: 'Fix the review findings.' }],
    brief: '',
  });
  assert.equal(
    singleCompleted.rawPrompt,
    'Your previous turn completed.\n\nFix the review findings.',
  );

  const resumedInterrupt = buildSteeredPrompt({
    wasInterrupted: true,
    freshContinuation: false,
    responseTail: 'Previous partial output that is already in thread history.',
    entries: [{ prompt: 'Switch to approach B.' }],
    syncedFiles: ['docs/spec.md'],
    verdict: 'Checks failed: test',
    brief: '',
  });
  assert.equal(
    resumedInterrupt.rawPrompt,
    [
      'Your previous turn was interrupted with updated instructions. Inspect your working tree before repeating any completed steps.',
      'Synced brief file(s) in your working tree: docs/spec.md (re-read before continuing).',
      'Checks failed: test',
      '',
      'Switch to approach B.',
    ].join('\n'),
  );

  const resumedMulti = buildSteeredPrompt({
    wasInterrupted: false,
    priorStatus: 'succeeded',
    freshContinuation: false,
    responseTail: 'Already in thread history.',
    entries: [
      { prompt: 'First update.' },
      { prompt: 'Second update.' },
    ],
    brief: '',
  });
  assert.equal(
    resumedMulti.rawPrompt,
    'Your previous turn completed.\n\n1. First update.\n\n2. Second update.',
  );

  const fresh = buildSteeredPrompt({
    wasInterrupted: false,
    priorStatus: 'failed',
    freshContinuation: true,
    responseTail: 'Tail from the previous turn.',
    entries: [{ prompt: 'Retry the fix.' }],
    brief: '',
  });
  assert.equal(
    fresh.rawPrompt,
    'Your previous turn ended failed. This starts a fresh conversation.\nLast response excerpt from previous turn:\nTail from the previous turn.\n\nRetry the fix.',
  );
});

test('a continuation turn stores its starting messages in view.json and its first label in manifest task', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  const readTask = (id: string) => (JSON.parse(readFileSync(jobFile(repo, id, FILES.job), 'utf8')) as { task?: string }).task;
  const readMessages = (id: string) => (JSON.parse(readFileSync(jobFile(repo, id, FILES.view), 'utf8')) as { messages?: unknown }).messages;

  const t1Ready = ctrl.nextTurn();
  const { ack, done: done1 } = await service.spawnTracked({ mode: 'implement', name: 'Ada', prompt: '# Refactor the links engine\n\nFull details.' });
  const t1 = await t1Ready;
  t1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'conv-1' });
  t1.finish({ status: 'success', response: 'Done.' });
  await done1;
  assert.equal(readTask(ack.jobId), 'Refactor the links engine');
  assert.equal(readMessages(ack.jobId), undefined);

  const t2Ready = ctrl.nextTurn();
  const f1 = await service.followUp({ worker: ack.jobId, prompt: '\n\n# Fix the review findings\n\nMore details.' });
  assert.equal(f1.action, 'started');
  const t2 = await t2Ready;
  t2.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'conv-1' });
  const q1 = await service.followUp({ worker: f1.jobId!, prompt: 'Interrupt with new plan\nDetails', context: 'c' });
  assert.equal(q1.action, 'queued');
  const q2 = await service.steer({ worker: f1.jobId!, prompt: 'Also check edge cases' });
  assert.equal(q2.action, 'interrupting');

  const t3Ready = ctrl.nextTurn();
  t2.finish({ status: 'cancelled', response: 'Stopped.' });
  const t3 = await t3Ready;
  t3.finish({ status: 'success', response: 'Done 3.' });
  const t3JobId = await waitFor(async () => {
    const m = JSON.parse(readFileSync(jobFile(repo, f1.jobId!, FILES.job), 'utf8')) as { supersededBy?: string };
    return m.supersededBy ?? null;
  });
  await waitFor(async () => (await service.detail(t3JobId)).status === 'succeeded');

  assert.equal(readTask(f1.jobId!), 'Fix the review findings');
  assert.deepEqual(readMessages(f1.jobId!), [{ sender: 'follow_up', text: '\n\n# Fix the review findings\n\nMore details.' }]);
  assert.equal(readTask(t3JobId), 'Interrupt with new plan');
  assert.deepEqual(readMessages(t3JobId), [
    { sender: 'follow_up', text: 'Interrupt with new plan\nDetails' },
    { sender: 'steer', text: 'Also check edge cases' },
  ]);
});

test('resolveWorker follows a steer that lands between resolveTurn and detail', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  const writeManifest = (id: string, extra: Record<string, unknown>) => {
    const file = jobFile(repo, id, FILES.job);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      schema: 1,
      jobId: id,
      name: 'w',
      workerId: 'w',
      provider: 'codex',
      mode: 'review',
      cwd: repo,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      jobStatus: null,
      error: null,
      deniedActions: [],
      usage: null,
      toolCalls: 0,
      unrestricted: false,
      conversation: null,
      task: 'work',
      promptChars: 4,
      pipeline: null,
      stage: null,
      attempt: null,
      ...extra,
    }));
  };

  writeManifest('parent', { turn: 1 });

  const svc = service as unknown as { detail: (id: string) => Promise<Awaited<ReturnType<typeof service.detail>>> };
  const origDetail = svc.detail.bind(service);
  let raced = false;
  svc.detail = async (id: string) => {
    if (!raced && id === 'parent') {
      raced = true;
      writeManifest('child', { turn: 2, continuedFrom: 'parent', continuationKind: 'steer' });
      writeFileSync(jobFile(repo, 'parent', FILES.steerHead), 'child\n');
      writeManifest('parent', {
        turn: 1,
        status: 'canceled',
        finishedAt: new Date().toISOString(),
        supersededBy: 'child',
      });
    }
    return origDetail(id);
  };

  const resolved = await service.resolveWorker('parent');
  assert.equal(resolved.jobId, 'child');
  assert.equal(resolved.status, 'running');
});
