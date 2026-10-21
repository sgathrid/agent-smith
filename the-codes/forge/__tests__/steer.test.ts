/**
 * steer.test.ts — pump-owned live worker steering (queue and interrupt).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { JobResult, Provider, ProviderEvent, SpawnSpec } from '../../providers/types.ts';
import { readAcceptance } from '../checks.ts';
import { FILES, jobFile } from '../format.ts';
import { ForgeService } from '../service.ts';
import { ForgeTasks } from '../../surfaces/channel/src/tasks.ts';
import { callTool } from '../../surfaces/channel/src/tools.ts';
import { isLive } from '../../surfaces/mod/hooks/dashboard.ts';
import { syncNativeTasks, type NativeJob } from '../../surfaces/mod/hooks/native.ts';
import { claim, claudeText, due, parseSettledRead } from '../../surfaces/mod/hooks/notice.ts';

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

function initGitRepo(dir: string) {
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  writeFileSync(path.join(dir, 'ARCHITECTURE.md'), '# Architecture v1\nShareable export.\n');
  mkdirSync(path.join(dir, 'docs'), { recursive: true });
  writeFileSync(path.join(dir, 'docs', 'brief.md'), 'Initial brief.\n');
  g('add', '.');
  g('commit', '-qm', 'init');
}

test('watched brief files: copies into worktree cwd, excludes unmodified copy from changedFiles even if read, detects staleReads when repo changes, and re-syncs on steer', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  initGitRepo(repo);

  const worktree = mkdtempSync(path.join(tmpdir(), 'agent-smith-wt-'));
  initGitRepo(worktree);

  // Edit ARCHITECTURE.md in repo before spawn so repo has v2 while worktree still has v1
  writeFileSync(path.join(repo, 'ARCHITECTURE.md'), '# Architecture v2\nPackEngine export.\n');

  const turn1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'worker-f',
    cwd: worktree,
    files: ['ARCHITECTURE.md', 'docs/brief.md'],
    prompt: 'Implement according to ARCHITECTURE.md.',
  });

  // Immediately after spawnTracked, ARCHITECTURE.md in worktree should be synced to v2
  assert.equal(readFileSync(path.join(worktree, 'ARCHITECTURE.md'), 'utf8'), '# Architecture v2\nPackEngine export.\n');

  const turn1 = await turn1Ready;
  // Wait for async gitBaseline capture on start() before simulating worker file edits
  while (!JSON.parse(readFileSync(jobFile(repo, ack.jobId, FILES.job), 'utf8')).gitBaseline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  turn1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'thread-f' });
  // Worker reads ARCHITECTURE.md (so toolInputs mentions ARCHITECTURE.md) and edits src.ts
  turn1.emit({ kind: 'activity-start', at: new Date().toISOString(), activity: { stepIndex: 1, tool: 'Read', input: 'ARCHITECTURE.md' } });
  writeFileSync(path.join(worktree, 'src.ts'), 'export const x = 1;\n');
  turn1.emit({ kind: 'activity-start', at: new Date().toISOString(), activity: { stepIndex: 2, tool: 'Write', input: 'src.ts' } });

  // While turn 1 is running, orchestrator edits ARCHITECTURE.md in main repo to v3!
  writeFileSync(path.join(repo, 'ARCHITECTURE.md'), '# Architecture v3\nUpdated export.\n');

  // Live detail() while running detects staleReads!
  const runningDetail = await service.detail(ack.jobId);
  assert.deepEqual(runningDetail.staleReads, ['ARCHITECTURE.md']);

  // Queue a steer that also adds a new watched file docs/extra.md
  writeFileSync(path.join(repo, 'docs', 'extra.md'), 'Extra spec.\n');
  await service.steer({
    worker: 'worker-f',
    prompt: 'Re-read ARCHITECTURE.md and docs/extra.md.',
    files: ['docs/extra.md'],
    delivery: 'queue',
  });

  const turn2Ready = ctrl.nextTurn();
  turn1.finish({ status: 'success', response: 'Finished initial implementation according to v2.' });

  const turn2 = await turn2Ready;
  // Parent turn finished before re-sync: parent's changedFiles must include src.ts and MUST NOT include ARCHITECTURE.md!
  const parentDetail = await service.detail(ack.jobId);
  assert.deepEqual(parentDetail.changedFiles, ['src.ts']);
  assert.deepEqual(parentDetail.staleReads, ['ARCHITECTURE.md']);

  // Before turn 2 started, pump re-synced ARCHITECTURE.md (to v3) and docs/extra.md into worktree!
  assert.equal(readFileSync(path.join(worktree, 'ARCHITECTURE.md'), 'utf8'), '# Architecture v3\nUpdated export.\n');
  assert.equal(readFileSync(path.join(worktree, 'docs', 'extra.md'), 'utf8'), 'Extra spec.\n');
  assert.match(turn2.spec.prompt, /Synced brief file\(s\) in your working tree: ARCHITECTURE\.md, docs\/extra\.md/);

  // In turn 2, wait for turn 2's gitBaseline capture, then worker modifies docs/brief.md in its worktree
  const parentAfterSteer = await service.detail(ack.jobId);
  const turn2JobId = parentAfterSteer.supersededBy!;
  while (!JSON.parse(readFileSync(jobFile(repo, turn2JobId, FILES.job), 'utf8')).gitBaseline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  writeFileSync(path.join(worktree, 'docs', 'brief.md'), 'Worker edited brief.\n');
  turn2.emit({ kind: 'activity-start', at: new Date().toISOString(), activity: { stepIndex: 1, tool: 'Write', input: 'docs/brief.md' } });
  turn2.finish({ status: 'success', response: 'Updated implementation to v3 and annotated docs/brief.md.' });

  const finalManifest = await done;
  const finalDetail = await service.detail(finalManifest.jobId);
  // Because worker modified docs/brief.md in worktree, it IS in changedFiles, and NOT in staleReads.
  // Meanwhile ARCHITECTURE.md and docs/extra.md (synced from repo, unmodified by worker) are NOT in changedFiles!
  assert.ok(finalDetail.changedFiles?.includes('docs/brief.md'), 'worker-modified watched file is in changedFiles');
  assert.equal(finalDetail.changedFiles?.includes('ARCHITECTURE.md'), false, 'unmodified synced watched file is excluded from changedFiles');
  assert.equal(finalDetail.changedFiles?.includes('docs/extra.md'), false, 'unmodified newly synced watched file is excluded from changedFiles');
  assert.equal(finalDetail.staleReads, undefined, 'no stale reads after re-sync');
});

test('watched brief files: rejects path traversal, absolute paths, and missing files', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  initGitRepo(repo);

  await assert.rejects(
    service.spawnTracked({ mode: 'implement', prompt: 'x', files: ['../outside.md'] }),
    /escapes repository root/,
  );
  await assert.rejects(
    service.spawnTracked({ mode: 'implement', prompt: 'x', files: ['/etc/passwd'] }),
    /must be a relative path/,
  );
  await assert.rejects(
    service.spawnTracked({ mode: 'implement', prompt: 'x', files: ['nonexistent.md'] }),
    /does not exist in/,
  );
});

test('watched brief files in same-root cwd (cwd === repo): reading ARCHITECTURE.md does not suppress finish-time staleReads when orchestrator edits it', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  initGitRepo(repo);

  const turnReady = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'same-root-worker',
    files: ['ARCHITECTURE.md', 'docs/brief.md'],
    prompt: 'Implement according to ARCHITECTURE.md.',
  });

  const turn = await turnReady;
  while (!JSON.parse(readFileSync(jobFile(repo, ack.jobId, FILES.job), 'utf8')).gitBaseline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  turn.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'thread-same-root' });
  // Worker reads ARCHITECTURE.md and edits src.ts in the same repository root (cwd === repo).
  turn.emit({
    kind: 'activity-start',
    at: new Date().toISOString(),
    activity: { stepIndex: 1, tool: 'Read', input: 'Read ARCHITECTURE.md' },
  });
  writeFileSync(path.join(repo, 'src.ts'), 'export const v = 1;\n');
  turn.emit({
    kind: 'activity-start',
    at: new Date().toISOString(),
    activity: { stepIndex: 2, tool: 'Write', input: 'src.ts' },
  });

  // Orchestrator edits ARCHITECTURE.md in repo while worker is running.
  writeFileSync(path.join(repo, 'ARCHITECTURE.md'), '# Architecture v2\nOrchestrator update.\n');

  const liveDetail = await service.detail(ack.jobId);
  assert.deepEqual(liveDetail.staleReads, ['ARCHITECTURE.md']);

  turn.finish({ status: 'success', response: 'Implemented based on ARCHITECTURE.md v1.' });
  await done;

  const finalDetail = await service.detail(ack.jobId);
  assert.deepEqual(finalDetail.changedFiles, ['src.ts']);
  assert.deepEqual(finalDetail.staleReads, ['ARCHITECTURE.md']);

  // Completion notice also surfaces staleReads at finish time.
  const now = Date.now();
  const owned = claim([], { kind: 'job', id: ack.jobId, repo, timeoutMs: 60_000 }, now);
  const noticeRes = due(
    owned,
    [
      {
        id: ack.jobId,
        status: 'succeeded',
        startedAt: now - 1000,
        endedAt: now,
        staleReads: finalDetail.staleReads,
      },
    ],
    new Map(),
    now,
  );
  assert.equal(noticeRes.notices.length, 1);
  assert.match(claudeText(noticeRes.notices), /stale brief: ARCHITECTURE\.md/);
});

test('watched brief files: re-sync on steer preserves worker edits in worktree when repo copy did not change, and does not clobber on both-changed', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  initGitRepo(repo);

  const worktree = mkdtempSync(path.join(tmpdir(), 'agent-smith-wt-preserve-'));
  initGitRepo(worktree);

  const turn1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'worker-preserve',
    cwd: worktree,
    files: ['ARCHITECTURE.md', 'docs/brief.md'],
    prompt: 'Turn 1.',
  });
  const turn1 = await turn1Ready;
  turn1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'thread-preserve' });

  // Worker edits docs/brief.md in its worktree; repo copy of docs/brief.md stays unchanged.
  writeFileSync(path.join(worktree, 'docs', 'brief.md'), '# worker edit\n');
  turn1.emit({
    kind: 'activity-start',
    at: new Date().toISOString(),
    activity: { stepIndex: 1, tool: 'Write', input: 'docs/brief.md' },
  });

  // Steer the worker without changing repo/docs/brief.md.
  await service.steer({
    worker: ack.jobId,
    prompt: 'Continue turn 2.',
    delivery: 'queue',
  });

  const turn2Ready = ctrl.nextTurn();
  turn1.finish({ status: 'success', response: 'Edited docs/brief.md in worktree.' });

  const turn2 = await turn2Ready;
  assert.equal(
    readFileSync(path.join(worktree, 'docs', 'brief.md'), 'utf8'),
    '# worker edit\n',
    'worker edit in worktree must not be overwritten by unchanged repo copy',
  );
  assert.doesNotMatch(turn2.spec.prompt, /Synced brief file\(s\) in your working tree/);

  // Now modify ARCHITECTURE.md in BOTH repo and worktree before turn 3 steer: worktree copy must not be clobbered.
  writeFileSync(path.join(repo, 'ARCHITECTURE.md'), '# repo conflicting edit\n');
  writeFileSync(path.join(worktree, 'ARCHITECTURE.md'), '# worktree conflicting edit\n');
  await service.steer({
    worker: ack.jobId,
    prompt: 'Continue turn 3.',
    delivery: 'queue',
  });

  const turn3Ready = ctrl.nextTurn();
  turn2.finish({ status: 'success', response: 'Finished turn 2.' });
  const turn3 = await turn3Ready;
  assert.equal(
    readFileSync(path.join(worktree, 'ARCHITECTURE.md'), 'utf8'),
    '# worktree conflicting edit\n',
    'conflicting worktree edit must not be clobbered',
  );
  turn3.finish({ status: 'success', response: 'Finished turn 3.' });
  const finalManifest = await done;
  const finalDetail = await service.detail(finalManifest.jobId);
  assert.ok(
    finalDetail.warnings.some((w) => w.message.includes('changed in both repo and worktree')),
    'expected warning when watched file changed in both repo and worktree',
  );
});

test('watched brief files: rejects symlink escaping repo, enforces 32-file cap, and drops deleted inherited file on resume_job with warning', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  initGitRepo(repo);

  const outsideDir = mkdtempSync(path.join(tmpdir(), 'agent-smith-outside-'));
  const outsideFile = path.join(outsideDir, 'secret.md');
  writeFileSync(outsideFile, 'secret\n');
  symlinkSync(outsideFile, path.join(repo, 'escape-link.md'));

  await assert.rejects(
    service.spawnTracked({ mode: 'implement', prompt: 'x', files: ['escape-link.md'] }),
    /resolves outside repository root/,
  );

  const tooMany: string[] = [];
  for (let i = 0; i < 33; i++) {
    const rel = `docs/f-${i}.md`;
    writeFileSync(path.join(repo, rel), `file ${i}\n`);
    tooMany.push(rel);
  }
  await assert.rejects(
    service.spawnTracked({ mode: 'implement', prompt: 'x', files: tooMany }),
    /exceeds maximum of 32 watched files/,
  );

  // Spawn a job with docs/brief.md, finish it, delete docs/brief.md from repo, then resume_job:
  const t1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'resume-deleted-watched',
    files: ['ARCHITECTURE.md', 'docs/brief.md'],
    prompt: 'Turn 1.',
  });
  const t1 = await t1Ready;
  t1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'thread-resume-del' });
  t1.finish({ status: 'success', response: 'Done turn 1.' });
  await done;

  unlinkSync(path.join(repo, 'docs', 'brief.md'));

  const t2Ready = ctrl.nextTurn();
  const resumeOut = await callTool(
    { service, catalogs: async () => [] },
    'resume_job',
    { worker: ack.jobId, prompt: 'Resume after docs/brief.md was deleted.' },
  );
  assert.notEqual(resumeOut.isError, true);
  const resumeAck = JSON.parse((resumeOut.content[0] as { text: string }).text);
  assert.ok(
    Array.isArray(resumeAck.warnings) &&
      resumeAck.warnings.some((w: string) => w.includes('dropped deleted watched file "docs/brief.md"')),
  );
  const t2 = await t2Ready;
  t2.finish({ status: 'success', response: 'Done turn 2.' });
});
