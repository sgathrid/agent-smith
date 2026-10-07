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
    async exists(path) { return Object.hasOwn(files, path); },
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
  assert.match(String(last?.input.description), /Latest worker output:\nBuild failed/);
  assert.equal(completed['job-a']?.status, 'completed');

  calls.length = 0;
  const untouched = await syncNativeTasks([{
    ...live, status: 'succeeded', latestSummary: null, summarySource: null,
  }], {}, client);
  assert.deepEqual(untouched, {});
  assert.deepEqual(calls, [], 'finished jobs without an existing native link must not flood TaskList');
});

test('an orphaned running job is projected as failed, not live', async () => {
  const base = '/repo/.agent-smith/jobs/job-o';
  const jobs = await readNativeJobs(fsFrom({
    [`${base}/job.json`]: JSON.stringify({ schema: 1, jobId: 'job-o', status: 'running', task: 'x' }),
    [`${base}/orphaned`]: 'x',
  }, [{ name: 'job-o', kind: 'dir' }] as never), '/repo');
  assert.equal(jobs[0]?.status, 'failed');
});
