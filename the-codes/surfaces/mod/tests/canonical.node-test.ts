import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readForgeJobs, readForgeDetail } from '../hooks/canonical.ts';
import type { FsLike } from '../hooks/jobs.ts';

function memoryFs(files: Record<string, string>, reads: string[] = []): FsLike {
  return {
    async read(p) { reads.push(p); if (!(p in files)) throw new Error('ENOENT'); return files[p]!; },
    async exists(p) { return p in files || Object.keys(files).some(key => key.startsWith(p + '/')); },
    async list(p) {
      return [...new Set(Object.keys(files).filter(k => k.startsWith(p + '/')).map(k => k.slice(p.length + 1).split('/')[0]!))]
        .map(name => ({ name, kind: 'dir', size: 0 }));
    },
  };
}
const base = '/repo/.agent-smith/jobs/job-a';
const now = Date.parse('2026-10-08T10:00:00Z');
const manifest = { schema: 1, jobId: 'job-a', name: 'Ada', workerId: 'ada', status: 'running', task: 'Review dashboard',
  provider: 'codex', model: null, updatedAt: new Date(now).toISOString(), startedAt: new Date(now - 1000).toISOString(), toolCalls: 1 };

test('canonical list ignores legacy jobs and never reads report, view or event logs', async () => {
  const reads: string[] = [];
  const jobs = await readForgeJobs(memoryFs({
    [`${base}/job.json`]: JSON.stringify(manifest),
    [`${base}/progress.json`]: JSON.stringify({ lastEventAt: manifest.updatedAt, toolCalls: 1 }),
    [`${base}/result.md`]: 'not for list', [`${base}/events.jsonl`]: 'not for list', [`${base}/view.json`]: 'not for list',
    '/repo/.agy-staff/jobs/foreign.spec.json': '{}',
  }, reads), '/repo', now);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.toolCount, 1);
  assert.equal(jobs[0]?.status, 'running');
  assert.deepEqual(reads, [`${base}/job.json`, `${base}/progress.json`]);
});
test('canonical silence and orphan markers have distinct truthful outcomes', async () => {
  const files = { [`${base}/job.json`]: JSON.stringify(manifest) };
  assert.equal((await readForgeJobs(memoryFs(files), '/repo', now + 1_000_000))[0]?.status, 'attention');
  const orphan = (await readForgeJobs(memoryFs({ ...files, [`${base}/orphaned`]: '',
    [`${base}/acceptance.json`]: JSON.stringify({state:'unchecked',pending:true,checks:[]}) }), '/repo', now))[0];
  assert.equal(orphan?.status, 'failed');
  assert.equal(orphan?.failureReason, 'server stopped');
  assert.equal(orphan?.acceptance?.pending, false, 'an exited supervisor cannot run its pending checks');
  assert.equal(orphan?.acceptance?.state, 'unchecked');
});
test('canonical: a cancel request beside the orphan marker is canceled; without the marker it is not orphaned', async () => {
  const files = { [`${base}/job.json`]: JSON.stringify(manifest), [`${base}/cancel`]: new Date(now).toISOString() };
  const canceled = (await readForgeJobs(memoryFs({ ...files, [`${base}/orphaned`]: '',
    [`${base}/acceptance.json`]: JSON.stringify({state:'unchecked',pending:true,checks:[]}) }), '/repo', now))[0];
  assert.equal(canceled?.status, 'canceled');
  assert.equal(canceled?.acceptance?.pending, false);
  assert.ok(!canceled?.warnings.some(w => w.code === 'orphaned'));
  assert.equal((await readForgeJobs(memoryFs(files), '/repo', now))[0]?.status, 'running', 'cancel alone leaves the supervisor to settle it');
  assert.equal((await readForgeJobs(memoryFs({ [`${base}/job.json`]: JSON.stringify(manifest), [`${base}/orphaned`]: '' }), '/repo', now))[0]?.status, 'failed');
});
test('canonical result snapshot prevents a stale orphan marker from overriding a live job', async () => {
  const job = (await readForgeJobs(memoryFs({
    [`${base}/job.json`]: JSON.stringify(manifest),
    [`${base}/orphaned`]: '',
    [`${base}/result.json`]: JSON.stringify({status:'running'}),
  }),'/repo',now))[0];
  assert.equal(job?.status,'running');
});

test('canonical legacy jobs use createdAt when startedAt is absent', async () => {
  const legacy = { ...manifest, startedAt: null, createdAt: new Date(now - 8_000).toISOString() };
  const job = (await readForgeJobs(memoryFs({ [`${base}/job.json`]: JSON.stringify(legacy) }), '/repo', now))[0];
  assert.equal(job?.startedAt, now - 8_000);
});
test('canonical activity prefers lastActivity chronology and falls back to highest legacy step', async () => {
  const progressPath = `${base}/progress.json`;
  const files = {
    [`${base}/job.json`]: JSON.stringify(manifest),
    [progressPath]: JSON.stringify({
      lastEventAt: manifest.updatedAt,
      recentActivities: [{stepIndex:9,tool:'view_file',input:'{"AbsolutePath":"/tmp/older.ts"}'}],
      lastActivity: {stepIndex:3,tool:'view_file',input:'{"AbsolutePath":"/tmp/latest.ts"}'},
    }),
  };
  const current = (await readForgeJobs(memoryFs(files),'/repo',now))[0];
  assert.equal(current?.activity,'reading latest.ts');
  const legacyFiles = {...files,[progressPath]:JSON.stringify({lastEventAt:manifest.updatedAt,
    recentActivities:[{stepIndex:9,tool:'view_file',input:'{"AbsolutePath":"/tmp/legacy.ts"}'}]})};
  const legacy = (await readForgeJobs(memoryFs(legacyFiles),'/repo',now))[0];
  assert.equal(legacy?.activity,'reading legacy.ts');
});

test('canonical acceptance preserves check reason, timeout, signal and skip metadata', async () => {
  const job = (await readForgeJobs(memoryFs({
    [`${base}/job.json`]: JSON.stringify({...manifest,status:'failed'}),
    [`${base}/acceptance.json`]: JSON.stringify({state:'rejected',checks:[
      {name:'tests',ok:false,outputTail:'',timedOut:true,signal:'SIGTERM',reason:'command timed out'},
      {name:'typecheck',ok:false,outputTail:'',skipped:'missing-cwd',reason:'working directory does not exist'},
    ]}),
  }),'/repo',now))[0];
  assert.deepEqual(job?.acceptance?.checks.map(check=>({reason:check.reason,timedOut:check.timedOut,signal:check.signal,skipped:check.skipped})),[
    {reason:'command timed out',timedOut:true,signal:'SIGTERM',skipped:undefined},
    {reason:'working directory does not exist',timedOut:undefined,signal:undefined,skipped:'missing-cwd'},
  ]);
});
test('acceptance remains separate from execution, and bounded detail is read once', async () => {
  const reads: string[] = [];
  const detail = await readForgeDetail(memoryFs({
    [`${base}/job.json`]: JSON.stringify({ ...manifest, status: 'succeeded' }),
    [`${base}/acceptance.json`]: JSON.stringify({ state: 'unchecked', pending: true, checks: [] }),
    [`${base}/view.json`]: JSON.stringify({ schema: 1, prompt: 'Full task', preamble: 'Review only', transcript: ['Worker output'],
      tools: [{ at: manifest.updatedAt, tool: 'Read', input: 'file.ts', output: '', state: 'active' }] }),
    [`${base}/result.md`]: 'Final report',
  }, reads), '/repo', 'job-a', now);
  assert.equal(detail?.job.status, 'succeeded');
  assert.equal(detail?.job.acceptance?.pending, true);
  assert.equal(detail?.job.prompt, 'Full task');
  assert.deepEqual(detail?.transcript, ['Worker output']);
  assert.equal(detail?.history[0]?.tool, 'Read');
  assert.equal(reads.filter(p => p.endsWith('/view.json')).length, 1);
  assert.equal(reads.some(p => p.endsWith('/events.jsonl')), false);
});
test('unreadable or malformed canonical state is not reported as an empty project', async () => {
  await assert.rejects(readForgeJobs(memoryFs({ [`${base}/job.json`]: '{broken' }), '/repo', now));
  const fs = memoryFs({ [`${base}/job.json`]: '{}' });
  fs.list = async () => { throw new Error('permission denied'); };
  await assert.rejects(readForgeJobs(fs, '/repo', now), /permission denied/);
});

test('canonical detail reports whether the writer bounded its snapshot', async () => {
  const detail = async (view: Record<string, unknown>) => readForgeDetail(memoryFs({
    [`${base}/job.json`]: JSON.stringify({ ...manifest, status: 'succeeded' }),
    [`${base}/view.json`]: JSON.stringify({ schema: 1, prompt: 'Full task', tools: [], transcript: [], timeline: [], ...view }),
  }), '/repo', 'job-a', now);
  assert.equal((await detail({ truncated: true }))?.truncated, true);
  assert.equal((await detail({ truncated: false }))?.truncated, false);
  // An older snapshot that never recorded the flag is not reported as truncated.
  assert.equal((await detail({}))?.truncated, false);
});

test('canonical: a job with a recorded short reason uses it; an old long error is classified on read', async () => {
  const base = '/repo/.agent-smith/jobs/j1';
  const read = async (extra: Record<string, unknown>) => (await readForgeJobs(memoryFs({
    [`${base}/job.json`]: JSON.stringify({ status: 'failed', startedAt: '2026-01-01T00:00:00Z', ...extra }),
  }), '/repo', Date.parse('2026-01-01T01:00:00Z')))[0];
  assert.equal((await read({ reason: 'denied view_file', error: 'a very long text' }))?.failureReason, 'denied view_file');
  assert.equal((await read({ error: 'worker soft-denied 1 tool action(s) (view_file) — exited 0' }))?.failureReason, 'worker soft-denied 1 tool action(s) (view_file) — exited 0');
});
