/**
 * steer.test.ts — pump-owned live worker steering (queue and interrupt).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { SpawnSpec } from '../../providers/types.ts';
import { readAcceptance } from '../checks.ts';
import { FILES, jobFile } from '../format.ts';
import { ForgeTasks } from '../../surfaces/channel/src/tasks.ts';
import { callTool } from '../../surfaces/channel/src/tools.ts';
import { isLive } from '../../surfaces/mod/hooks/dashboard.ts';
import { syncNativeTasks, type NativeJob } from '../../surfaces/mod/hooks/native.ts';
import { claim, due, parseSettledRead } from '../../surfaces/mod/hooks/notice.ts';
import { controlledProvider, makeService } from '../testing/steer-harness.ts';

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
  assert.equal(steer1.resumable, true, 'the started event supplied a conversation handle');

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
        // Delay exit until after user cancel() arrives while interruptFired is already true.
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
    delivery: 'interrupt',
  });

  // Now the user calls cancel() after steer(interrupt) already set interruptFired = true.
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
    delivery: 'interrupt',
  });
  const t2 = await t2Ready;

  // status(parentId, { wait_ms }) while child is still running must wait on child, not return settled parent
  const waitingStatus = callTool(
    { service, pollMs: 10 },
    'status',
    { jobId: ack.jobId, wait_ms: 40 },
  );
  const stillRunningRes = JSON.parse(((await waitingStatus).content[0] as { text: string }).text);
  assert.equal(stillRunningRes.jobId, t2.spec.jobId);
  assert.equal(stillRunningRes.stillRunning, true);

  // cancel(parentId) must cancel the running child turn
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

test('parseSettledRead ignores superseded parent and due() deduplicates notices across steered turns', () => {
  const supersededParentStatus = {
    jobId: 'implement-parent',
    status: 'canceled',
    supersededBy: 'implement-child',
  };
  assert.equal(
    parseSettledRead('mcp__agent-smith__status', supersededParentStatus),
    null,
    'reading a superseded parent must not unclaim the live chain',
  );

  const settledChildStatus = {
    jobId: 'implement-child',
    status: 'succeeded',
  };
  assert.deepEqual(parseSettledRead('mcp__agent-smith__status', settledChildStatus), {
    kind: 'job',
    id: 'implement-child',
  });

  // Claim both parent and child (e.g. if both were recorded) and verify due() emits exactly 1 notice.
  const now = 1_000_000;
  let owned = claim([], { kind: 'job', id: 'implement-parent', repo: '/repo', timeoutMs: 60_000 }, now);
  owned = claim(owned, { kind: 'job', id: 'implement-child', repo: '/repo', timeoutMs: 60_000 }, now);
  const res = due(
    owned,
    [
      {
        id: 'implement-parent',
        status: 'canceled',
        supersededBy: 'implement-child',
        startedAt: now - 2000,
        endedAt: now - 1000,
      },
      {
        id: 'implement-child',
        status: 'succeeded',
        steeredFrom: 'implement-parent',
        startedAt: now - 1000,
        endedAt: now,
      },
    ],
    new Map(),
    now,
  );
  assert.equal(res.notices.length, 1);
  assert.equal(res.notices[0]?.id, 'implement-child');
  assert.equal(res.owned.length, 0);
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
    'steer_job',
    {
      worker: ack.jobId,
      prompt: 'Turn 2.',
      delivery: 'interrupt',
    },
  );
  const t2 = await t2Ready;
  const childJobId = t2.spec.jobId!;

  // While turn 2 is running, parent's pending acceptance is cleared so isLive(parent) is false.
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

  // Wait for gateAcceptance to settle on childJobId
  for (let i = 0; i < 50; i++) {
    const childAcc = readAcceptance(repo, childJobId);
    if (childAcc.state === 'accepted') break;
    await new Promise((r) => setTimeout(r, 20));
  }

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
    delivery: 'interrupt',
  });
  const t2 = await t2Ready;

  // While child turn is running, tasks.get(taskId) must still report working (not canceled from parent!)
  const mid = await tasks.get(taskId);
  assert.equal(mid.status, 'working');

  t2.finish({ status: 'success', response: 'Completed turn 2 cleanly via MCP Tasks.' });
  // Wait for pump to finish writing child manifest
  for (let i = 0; i < 50; i++) {
    const cur = await tasks.get(taskId);
    if (cur.status !== 'working') break;
    await new Promise((r) => setTimeout(r, 20));
  }
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

  const steerAck = await service.steer({
    worker: ack.jobId,
    prompt: 'Queued follow-up without conversation ID.',
    delivery: 'queue',
  });
  assert.equal(steerAck.resumable, false);
  assert.match(steerAck.note, /continuation starts fresh/);

  const t2Ready = ctrl.nextTurn();
  t1.finish({ status: 'success', response: 'Finished turn 1 without conversation ID.' });

  const t2 = await t2Ready;
  assert.equal(t2.spec.conversation, undefined);
  assert.match(t2.spec.prompt, /\[FRESH CONTINUATION\]/);
  assert.match(t2.spec.prompt, /Queued follow-up without conversation ID\./);

  t2.finish({ status: 'success', response: 'Finished fresh continuation turn 2.' });
  const finalManifest = await done;
  assert.equal(finalManifest.steeredFrom, ack.jobId);
  assert.equal(finalManifest.status, 'succeeded');
});

test('syncNativeTasks walks multi-hop supersededBy chains in one poll', async () => {
  const updates: string[] = [];
  const client = {
    async create() {
      return { result: { task: { id: 'native-1' } } };
    },
    async update(input: { taskId: string; subject: string }) {
      updates.push(`${input.taskId}:${input.subject}`);
      return { result: { success: true } };
    },
  };
  const jobs: NativeJob[] = [
    {
      id: 'job-a',
      status: 'canceled',
      task: 'Original task',
      name: 'shell',
      workerId: 'w1',
      role: 'implement',
      provider: 'codex',
      model: null,
      latestSummary: null,
      summarySource: null,
      supersededBy: 'job-b',
      steeredFrom: null,
    },
    {
      id: 'job-b',
      status: 'canceled',
      task: 'Original task',
      name: 'shell',
      workerId: 'w1',
      role: 'implement',
      provider: 'codex',
      model: null,
      latestSummary: null,
      summarySource: null,
      supersededBy: 'job-c',
      steeredFrom: 'job-a',
    },
    {
      id: 'job-c',
      status: 'running',
      task: 'Original task',
      name: 'shell',
      workerId: 'w1',
      role: 'implement',
      provider: 'codex',
      model: null,
      latestSummary: null,
      summarySource: null,
      supersededBy: null,
      steeredFrom: 'job-b',
    },
  ];
  const next = await syncNativeTasks(
    jobs,
    { 'job-a': { taskId: 'native-1', status: 'in_progress', fingerprint: 'old' } },
    client,
  );
  assert.equal(next['job-a'], undefined);
  assert.equal(next['job-b'], undefined);
  assert.equal(next['job-c']?.taskId, 'native-1');
});

test('a queued steer on a failed turn is reported, not silently dropped', async () => {
  const ctrl = controlledProvider();
  const { service } = makeService(ctrl.provider);

  const t1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'failed-queue',
    prompt: 'Work.',
  });
  const t1 = await t1Ready;
  await service.steer({
    worker: ack.jobId,
    prompt: 'Follow up after the turn.',
    delivery: 'queue',
  });

  t1.finish({ status: 'error', exitCode: 1, response: '' });
  const finalManifest = await done;
  assert.equal(finalManifest.jobId, ack.jobId);
  assert.equal(finalManifest.status, 'failed');

  const detail = await service.detail(ack.jobId);
  assert.ok(
    detail.warnings.some((w) => /queued steer not applied/.test(w.message)),
    `expected a dropped-steer warning, got ${JSON.stringify(detail.warnings)}`,
  );
  assert.equal(detail.pendingSteers, 0);
  assert.equal(ctrl.turns.length, 1, 'a failed turn is not chained');
});

test('resolveHead crosses the finish window through steer.head before supersededBy is stamped', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  const writeManifest = (id: string, extra: Record<string, unknown>) => {
    const file = jobFile(repo, id, FILES.job);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ jobId: id, name: 'w', workerId: 'w', status: 'running', ...extra }));
  };

  writeManifest('parent', {});
  writeFileSync(jobFile(repo, 'parent', FILES.steerHead), 'child\n');
  writeManifest('child', { steeredFrom: 'parent' });

  assert.equal(service.resolveHead('parent'), 'child');
});

test('a writing turn whose cwd vanished does not chain its queued steer', async () => {
  const ctrl = controlledProvider();
  const { service } = makeService(ctrl.provider);
  const cwd = mkdtempSync(path.join(tmpdir(), 'agent-smith-steer-cwd-'));
  const t1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({ mode: 'implement', name: 'cwd-gone', prompt: 'Work.', cwd });
  const t1 = await t1Ready;
  await service.steer({ worker: ack.jobId, prompt: 'Then this.', delivery: 'queue' });
  rmSync(cwd, { recursive: true, force: true });
  t1.finish({ status: 'success' });
  const finalManifest = await done;
  assert.equal(finalManifest.jobId, ack.jobId);
  assert.equal(finalManifest.status, 'failed');
  assert.equal(finalManifest.cwdMissingAtFinish, true);
  assert.equal(ctrl.turns.length, 1, 'no continuation on an unverifiable turn');
  const detail = await service.detail(ack.jobId);
  assert.ok(detail.warnings.some((w) => /queued steer not applied/.test(w.message)));
});
