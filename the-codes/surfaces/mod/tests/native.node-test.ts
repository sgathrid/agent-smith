import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readNativeJobs, syncNativeTasks, type NativeTaskClient } from '../hooks/native.ts';
import type { FsLike } from '../hooks/fs.ts';

function fsFrom(files: Record<string, string>, names: readonly { name: string; kind: string }[] = []) : FsLike {
  return {
    async read(path) {
      const value = files[path];
      if (value === undefined) throw new Error(`ENOENT ${path}`);
      return value;
    },
    async exists(path) { return Object.hasOwn(files, path) || Object.keys(files).some(file => file.startsWith(path + '/')); },
    async list() { return names.map(entry => ({ ...entry, size: 0 })); },
  };
}

test('reads optional metadata and only treats explicitly sourced output as worker summary', async () => {
  const base = '/repo/.agent-smith/jobs/job-a';
  const jobs = await readNativeJobs(fsFrom({
    [`${base}/job.json`]: JSON.stringify({
      schema: 1, jobId: 'job-a', status: 'running', task: 'Implement recovery',
      resolved: { mode: 'implement' },
    }),
    [`${base}/progress.json`]: JSON.stringify({ latestSummary: 'Unverified text without provenance.' }),
  }, [{ name: 'job-a', kind: 'dir' }] as never), '/repo');

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.name, null);
  assert.equal(jobs[0]?.workerId, 'job-a');
  assert.equal(jobs[0]?.role, 'implement');
  assert.equal(jobs[0]?.latestSummary, 'Unverified text without provenance.');
  assert.equal(jobs[0]?.summarySource, null);
});

test('native completion records real outcome and latest worker output without creating old history', async () => {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const client: NativeTaskClient = {
    async create(input) {
      calls.push({ method: 'create', input });
      return { result: { task: { id: 'host-task-4' } } };
    },
    async update(input) {
      calls.push({ method: 'update', input });
      return { result: { success: true } };
    },
  };
  const live = {
    id: 'job-a', status: 'running' as const, task: 'Implement recovery',
    name: 'Codex implementer', workerId: 'codex-1', role: 'implementer',
    provider: 'codex', model: 'gpt-6-sol', latestSummary: null, summarySource: null,
  };
  const created = await syncNativeTasks([live], {}, client);
  assert.equal(created['codex-1']?.taskId, 'host-task-4');

  const completed = await syncNativeTasks([{
    ...live,
    status: 'failed',
    latestSummary: 'Build failed: missing generated source.',
    summarySource: 'worker',
  }], created, client);
  const last = calls.at(-1);
  assert.equal(last?.method, 'update');
  assert.equal(last?.input.status, 'completed');
  assert.match(String(last?.input.description), /Outcome: failed/);
  assert.match(String(last?.input.description), /Worker said:\nBuild failed/);
  assert.equal(completed['codex-1']?.status, 'completed');

  calls.length = 0;
  const untouched = await syncNativeTasks([{
    ...live, status: 'succeeded', latestSummary: null, summarySource: null,
  }], {}, client);
  assert.deepEqual(untouched, {});
  assert.deepEqual(calls, [], 'finished jobs without an existing native link must not flood TaskList');
});

test('a finished worker native task is deleted after the close delay, once', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client: NativeTaskClient = {
    async create() { return { result: { task: { id: 't1' } } }; },
    async update(input) { calls.push(input); return { result: { success: true } }; },
  };
  const job = {
    id: 'job-d', status: 'succeeded' as const, task: 'x', name: 'w', workerId: 'w', role: 'implement',
    provider: 'codex', model: null, latestSummary: null, summarySource: null,
  };
  const linked = { 'w': { taskId: 't1', status: 'in_progress' as const, fingerprint: '' } };
  const t0 = 1_000_000;
  const done = await syncNativeTasks([job], linked, client, t0);
  assert.equal(done['w']?.status, 'completed');
  assert.equal(done['w']?.doneAt, t0);
  const early = await syncNativeTasks([job], done, client, t0 + 9_999);
  assert.equal(early['w']?.status, 'completed', 'still shown inside the delay');
  const closed = await syncNativeTasks([job], early, client, t0 + 10_000);
  assert.equal(closed['w']?.status, 'deleted');
  assert.equal(calls.at(-1)?.status, 'deleted');
  const n = calls.length;
  await syncNativeTasks([job], closed, client, t0 + 60_000);
  assert.equal(calls.length, n, 'a deleted task is never touched again while finished');
});

test('acceptance settlement starts the native close delay, while failed outcomes remain inspectable', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client: NativeTaskClient = {
    async create() { return {result:{task:{id:'t1'}}}; },
    async update(input) { calls.push(input);return {result:{success:true}}; },
  };
  const job = {id:'j',status:'succeeded' as const,task:'Review',name:'Ada',workerId:'ada',role:'review',
    provider:'codex',model:null,latestSummary:null,summarySource:null,
    acceptance:{state:'unchecked' as const,pending:true,checks:[]}};
  const pending=await syncNativeTasks([job],{},client,1000);
  assert.equal(pending.ada?.status,'in_progress');
  assert.equal(pending.ada?.doneAt,undefined);
  const accepted={...job,acceptance:{state:'accepted' as const,pending:false,checks:[]}};
  const settled=await syncNativeTasks([accepted],pending,client,60_000);
  assert.equal(settled.ada?.status,'completed');
  assert.equal(settled.ada?.doneAt,60_000);
  assert.equal((await syncNativeTasks([accepted],settled,client,69_999)).ada?.status,'completed');
  assert.equal((await syncNativeTasks([accepted],settled,client,70_000)).ada?.status,'deleted');
  const failed={...accepted,status:'failed' as const};
  const failure=await syncNativeTasks([failed],pending,client,60_000);
  const later=await syncNativeTasks([failed],failure,client,100_000);
  assert.equal(later.ada?.status,'completed');
  assert.match(String(calls.at(-1)?.subject),/\[failed\]/);
});

test('a job this session does not own gets no new task, but an existing link still finishes and closes', async () => {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const client: NativeTaskClient = {
    async create(input) { calls.push({ method: 'create', input }); return { result: { task: { id: 't1' } } }; },
    async update(input) { calls.push({ method: 'update', input }); return { result: { success: true } }; },
  };
  const job = {
    id: 'job-x', status: 'running' as const, task: 'x', name: 'w', workerId: 'w', role: 'implement',
    provider: 'codex', model: null, latestSummary: null, summarySource: null,
  };
  const notMine = () => false;
  assert.deepEqual(await syncNativeTasks([job], {}, client, 1000, notMine), {});
  assert.equal(calls.length, 0);
  const linked = { 'w': { taskId: 't1', status: 'in_progress' as const, fingerprint: '' } };
  const done = await syncNativeTasks([{ ...job, status: 'succeeded' }], linked, client, 1000, notMine);
  assert.equal(done['w']?.status, 'completed');
  const closed = await syncNativeTasks([{ ...job, status: 'succeeded' }], done, client, 11_000, notMine);
  assert.equal(closed['w']?.status, 'deleted');
  assert.equal(calls.filter((c) => c.method === 'create').length, 0);
});

test('syncNativeTasks keeps 1 worker-keyed native task across steer and reopens in_progress on resume', async () => {
  let nextTask = 1;
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const client: NativeTaskClient = {
    async create(input) { calls.push({ method: 'create', input }); return { result: { task: { id: `native-${nextTask++}` } } }; },
    async update(input) { calls.push({ method: 'update', input }); return { result: { success: true } }; },
  };
  const parent = {
    id: 'turn-1', turn: 1, status: 'running' as const, task: 'Build nav', name: 'shell', workerId: 'shell', role: 'implement',
    provider: 'codex', model: null, latestSummary: null, summarySource: null,
  };
  const linked = await syncNativeTasks([parent], {}, client, 1000);
  assert.equal(linked['shell']?.taskId, 'native-1');

  const supersededParent = { ...parent, status: 'canceled' as const, supersededBy: 'turn-2' };
  const child = {
    ...parent, id: 'turn-2', turn: 2, status: 'running' as const, continuedFrom: 'turn-1', continuationKind: 'steer' as const,
    latestSummary: 'Pivoting to profile menu.', summarySource: 'worker' as const,
  };
  const steered = await syncNativeTasks([supersededParent, child], linked, client, 2000);
  assert.equal(steered['shell']?.taskId, 'native-1');
  assert.equal(steered['shell']?.status, 'in_progress');
  assert.equal(calls.filter((c) => c.method === 'create').length, 1, 'did not create a second native task on steer');
  assert.equal(calls.some((c) => c.input.status === 'completed'), false, 'did not mark parent completed');

  const finishedTurn2 = { ...child, status: 'succeeded' as const };
  const completed = await syncNativeTasks([supersededParent, finishedTurn2], steered, client, 5000);
  assert.equal(completed['shell']?.status, 'completed');
  assert.equal(completed['shell']?.doneAt, 5000);

  const resumedTurn3 = {
    ...parent, id: 'turn-3', turn: 3, status: 'running' as const, continuedFrom: 'turn-2', continuationKind: 'follow-up' as const,
  };
  const reopened = await syncNativeTasks([supersededParent, finishedTurn2, resumedTurn3], completed, client, 8000);
  assert.equal(reopened['shell']?.taskId, 'native-1');
  assert.equal(reopened['shell']?.status, 'in_progress');
  assert.equal(reopened['shell']?.doneAt, undefined, 'doneAt cleared on reopen');
  assert.equal(calls.filter((c) => c.method === 'create').length, 1, 'reused native task on resume');

  const doneTurn3 = { ...resumedTurn3, status: 'succeeded' as const };
  const settled3 = await syncNativeTasks([supersededParent, finishedTurn2, doneTurn3], reopened, client, 10_000);
  const deleted3 = await syncNativeTasks([supersededParent, finishedTurn2, doneTurn3], settled3, client, 20_000);
  assert.equal(deleted3['shell']?.status, 'deleted');

  const resumedTurn4 = {
    ...parent, id: 'turn-4', turn: 4, status: 'running' as const, continuedFrom: 'turn-3', continuationKind: 'follow-up' as const,
  };
  const recreated = await syncNativeTasks([supersededParent, finishedTurn2, doneTurn3, resumedTurn4], deleted3, client, 30_000);
  assert.equal(recreated['shell']?.taskId, 'native-2', 're-creates task after earlier task was deleted');
  assert.equal(recreated['shell']?.status, 'in_progress');
});

test('hasPendingNativeClose selects the worker head regardless of fs.list hex order', async () => {
  const { hasPendingNativeClose } = await import('../hooks/native.ts');
  const baseRadar = { task: '', warnings: [], report: null, reasoning: null, raw: {} };
  const turn2Succeeded = {
    ...baseRadar,
    id: 'implement-smith-0000', workerId: 'w1', turn: 2, name: 'Ada', provider: 'codex', role: 'implement',
    status: 'succeeded' as const, activity: 'done', toolCount: 1, startedAt: 2000, endedAt: 3000,
    continuedFrom: 'implement-smith-ffff', continuationKind: 'steer' as const,
  };
  const turn1CanceledSuperseded = {
    ...baseRadar,
    id: 'implement-smith-ffff', workerId: 'w1', turn: 1, name: 'Ada', provider: 'codex', role: 'implement',
    status: 'canceled' as const, activity: 'canceled', toolCount: 1, startedAt: 1000, endedAt: 2000,
    supersededBy: 'implement-smith-0000',
  };
  assert.equal(
    hasPendingNativeClose([turn2Succeeded, turn1CanceledSuperseded], { w1: { taskId: 't1', status: 'completed', fingerprint: 'fp', doneAt: 3000 } }),
    true,
  );
  assert.equal(
    hasPendingNativeClose([turn2Succeeded, turn1CanceledSuperseded], { w1: { taskId: 't1', status: 'deleted', fingerprint: '', doneAt: 3000 } }),
    false,
  );
  const turn2Rejected = { ...turn2Succeeded, acceptance: { state: 'rejected' as const, checks: [] } };
  assert.equal(
    hasPendingNativeClose([turn2Rejected, turn1CanceledSuperseded], { w1: { taskId: 't1', status: 'completed', fingerprint: 'fp', doneAt: 3000 } }),
    false,
  );
  const turn2Failed = { ...turn2Succeeded, status: 'failed' as const };
  assert.equal(
    hasPendingNativeClose([turn2Failed, turn1CanceledSuperseded], { w1: { taskId: 't1', status: 'completed', fingerprint: 'fp', doneAt: 3000 } }),
    false,
  );
});
