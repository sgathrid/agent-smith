import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readNativeJobs, syncNativeTasks, type NativeTaskClient } from '../hooks/native.ts';
import type { FsLike } from '../hooks/jobs.ts';

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
  assert.equal(created['job-a']?.taskId, 'host-task-4');

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
  assert.equal(completed['job-a']?.status, 'completed');

  calls.length = 0;
  const untouched = await syncNativeTasks([{
    ...live, status: 'succeeded', latestSummary: null, summarySource: null,
  }], {}, client);
  assert.deepEqual(untouched, {});
  assert.deepEqual(calls, [], 'finished jobs without an existing native link must not flood TaskList');
});

test('a finished job native task is deleted after the close delay, once', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client: NativeTaskClient = {
    async create() { return { result: { task: { id: 't1' } } }; },
    async update(input) { calls.push(input); return { result: { success: true } }; },
  };
  const job = {
    id: 'job-d', status: 'succeeded' as const, task: 'x', name: 'w', workerId: 'w', role: 'implement',
    provider: 'codex', model: null, latestSummary: null, summarySource: null,
  };
  const linked = { 'job-d': { taskId: 't1', status: 'in_progress' as const, fingerprint: '' } };
  const t0 = 1_000_000;
  const done = await syncNativeTasks([job], linked, client, t0);
  assert.equal(done['job-d']?.status, 'completed');
  assert.equal(done['job-d']?.doneAt, t0);
  const early = await syncNativeTasks([job], done, client, t0 + 9_999);
  assert.equal(early['job-d']?.status, 'completed', 'still shown inside the delay');
  const closed = await syncNativeTasks([job], early, client, t0 + 10_000);
  assert.equal(closed['job-d']?.status, 'deleted');
  assert.equal(calls.at(-1)?.status, 'deleted');
  const n = calls.length;
  await syncNativeTasks([job], closed, client, t0 + 60_000);
  assert.equal(calls.length, n, 'a deleted task is never touched again');
});

test('an orphaned running job is projected as failed, not live', async () => {
  const base = '/repo/.agent-smith/jobs/job-o';
  const jobs = await readNativeJobs(fsFrom({
    [`${base}/job.json`]: JSON.stringify({ schema: 1, jobId: 'job-o', status: 'running', task: 'x' }),
    [`${base}/orphaned`]: 'x',
  }, [{ name: 'job-o', kind: 'dir' }] as never), '/repo');
  assert.equal(jobs[0]?.status, 'failed');
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
  assert.equal(pending.j?.status,'in_progress');
  assert.equal(pending.j?.doneAt,undefined);
  const accepted={...job,acceptance:{state:'accepted' as const,pending:false,checks:[]}};
  const settled=await syncNativeTasks([accepted],pending,client,60_000);
  assert.equal(settled.j?.status,'completed');
  assert.equal(settled.j?.doneAt,60_000);
  assert.equal((await syncNativeTasks([accepted],settled,client,69_999)).j?.status,'completed');
  assert.equal((await syncNativeTasks([accepted],settled,client,70_000)).j?.status,'deleted');
  const failed={...accepted,status:'failed' as const};
  const failure=await syncNativeTasks([failed],pending,client,60_000);
  const later=await syncNativeTasks([failed],failure,client,100_000);
  assert.equal(later.j?.status,'completed');
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
  const linked = { 'job-x': { taskId: 't1', status: 'in_progress' as const, fingerprint: '' } };
  const done = await syncNativeTasks([{ ...job, status: 'succeeded' }], linked, client, 1000, notMine);
  assert.equal(done['job-x']?.status, 'completed');
  const closed = await syncNativeTasks([{ ...job, status: 'succeeded' }], done, client, 11_000, notMine);
  assert.equal(closed['job-x']?.status, 'deleted');
  assert.equal(calls.filter((c) => c.method === 'create').length, 0);
});

test('syncNativeTasks transfers an in_progress native task across supersededBy without closing the parent task', async () => {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const client: NativeTaskClient = {
    async create(input) { calls.push({ method: 'create', input }); return { result: { task: { id: 'native-1' } } }; },
    async update(input) { calls.push({ method: 'update', input }); return { result: { success: true } }; },
  };
  const parent = {
    id: 'turn-1', status: 'running' as const, task: 'Build nav', name: 'shell', workerId: 'shell', role: 'implement',
    provider: 'codex', model: null, latestSummary: null, summarySource: null,
  };
  const linked = await syncNativeTasks([parent], {}, client, 1000);
  assert.equal(linked['turn-1']?.taskId, 'native-1');

  const supersededParent = { ...parent, status: 'canceled' as const, supersededBy: 'turn-2' };
  const child = {
    ...parent, id: 'turn-2', status: 'running' as const, steeredFrom: 'turn-1',
    latestSummary: 'Pivoting to profile menu.', summarySource: 'worker' as const,
  };
  const transferred = await syncNativeTasks([supersededParent, child], linked, client, 2000);
  assert.equal(transferred['turn-1'], undefined, 'parent link moved to child');
  assert.equal(transferred['turn-2']?.taskId, 'native-1');
  assert.equal(transferred['turn-2']?.status, 'in_progress');
  assert.equal(calls.filter((c) => c.method === 'create').length, 1, 'did not create a second native task');
  assert.equal(calls.some((c) => c.input.status === 'completed'), false, 'did not mark parent completed');
});
