import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readForgeJobs, readForgeDetail } from '../hooks/canonical.ts';
import type { FsLike } from '../hooks/fs.ts';

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

test('canonical list never reads report, view or event logs', async () => {
  const reads: string[] = [];
  const jobs = await readForgeJobs(memoryFs({
    [`${base}/job.json`]: JSON.stringify(manifest),
    [`${base}/progress.json`]: JSON.stringify({ lastEventAt: manifest.updatedAt, toolCalls: 1 }),
    [`${base}/result.md`]: 'not for list', [`${base}/events.jsonl`]: 'not for list', [`${base}/view.json`]: 'not for list',
  }, reads), '/repo', now);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.toolCount, 1);
  assert.equal(jobs[0]?.status, 'running');
  assert.deepEqual(reads, [`${base}/job.json`, `${base}/progress.json`]);
});
test('canonical reads followedBy, normalizes legacy continuation kinds, and keeps the raw queued count for the idle rule', async () => {
  const done = { ...manifest, status: 'succeeded', finishedAt: new Date(now).toISOString() };
  const read = async (m: Record<string, unknown>, progress?: Record<string, unknown>) => (await readForgeJobs(memoryFs({
    [`${base}/job.json`]: JSON.stringify(m),
    ...(progress ? { [`${base}/progress.json`]: JSON.stringify(progress) } : {}),
  }), '/repo', now))[0]!;
  const followed = await read({ ...done, followedBy: 'job-b', continuedFrom: 'job-0', continuationKind: 'resume' });
  assert.deepEqual([followed.followedBy, followed.continuationKind], ['job-b', 'follow-up']);
  assert.equal((await read({ ...done, continuedFrom: 'job-0', continuationKind: 'steer-interrupt' })).continuationKind, 'steer');
  assert.equal((await read({ ...done, continuedFrom: 'job-0', continuationKind: 'steer-queue' })).continuationKind, 'follow-up');
  assert.equal((await read({ ...done, steeredFrom: 'job-0' })).continuationKind, 'follow-up', '0.4.x steeredFrom');
  assert.equal((await read({ ...done, continuedFrom: 'job-0', continuationKind: 'steer' })).continuationKind, 'steer');
  const queued = await read({ ...done }, { pendingSteers: 2 });
  assert.deepEqual([queued.pendingSteers, queued.pendingMessages], [null, 2]);
});

test('canonical detail parses a read message event and tolerates its absence', async () => {
  const timeline = [
    { kind: 'assistant', sequence: 0, at: '2026-10-08T10:00:00Z', text: 'Working.' },
    { kind: 'message', sequence: 1, at: '2026-10-08T10:00:01Z', text: 'Stop and fix lint first.', delivery: 'next-step', sender: 'steer' },
    { kind: 'message', sequence: 2, at: '2026-10-08T10:00:02Z' },
  ];
  const detail = await readForgeDetail(memoryFs({
    [`${base}/job.json`]: JSON.stringify(manifest),
    [`${base}/view.json`]: JSON.stringify({ schema: 1, timeline, messages: [{ sender: 'follow_up', text: 'Fix lint first.' }] }),
  }), '/repo', 'job-a', now);
  assert.deepEqual(detail?.timeline.map((e) => e.kind), ['assistant', 'message']);
  assert.deepEqual(detail?.timeline[1], { kind: 'message', sequence: 1, at: '2026-10-08T10:00:01Z', text: 'Stop and fix lint first.', delivery: 'next-step', sender: 'steer' });
  assert.deepEqual(detail?.job.messages, [{ sender: 'follow_up', text: 'Fix lint first.' }]);
});

test('canonical silence is attention, not failure', async () => {
  const files = { [`${base}/job.json`]: JSON.stringify(manifest) };
  assert.equal((await readForgeJobs(memoryFs(files), '/repo', now + 1_000_000))[0]?.status, 'attention');
  assert.equal((await readForgeJobs(memoryFs({ ...files, [`${base}/cancel`]: new Date(now).toISOString() }), '/repo', now))[0]?.status, 'running', 'cancel alone leaves the supervisor to settle it');
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
    [`${base}/view.json`]: JSON.stringify({ schema: 1, prompt: 'Full task', preamble: 'Review only',
      timeline: [
        { kind: 'assistant', sequence: 0, at: manifest.updatedAt, text: 'Worker output' },
        { kind: 'tool', sequence: 1, at: manifest.updatedAt, stepIndex: 0, tool: 'Read', input: 'file.ts', output: '', state: 'active' },
      ] }),
    [`${base}/result.md`]: 'Final report',
  }, reads), '/repo', 'job-a', now);
  assert.equal(detail?.job.status, 'succeeded');
  assert.equal(detail?.job.acceptance?.pending, true);
  assert.equal(detail?.job.prompt, 'Full task');
  assert.equal(detail?.timeline.length, 2);
  assert.equal(detail?.timeline[0]?.kind, 'assistant');
  assert.equal(detail?.timeline[1]?.kind, 'tool');
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
    [`${base}/view.json`]: JSON.stringify({ schema: 1, prompt: 'Full task', timeline: [], ...view }),
  }), '/repo', 'job-a', now);
  assert.equal((await detail({ truncated: true }))?.truncated, true);
  assert.equal((await detail({ truncated: false }))?.truncated, false);
  assert.equal((await detail({}))?.truncated, false);
});

test('canonical: unified turn-chain fields and defensive 0.4.x fallback', async () => {
  const t1 = new Date(now - 60_000).toISOString();
  const t2 = new Date(now - 10_000).toISOString();
  const jobs = await readForgeJobs(memoryFs({
    [`/repo/.agent-smith/jobs/turn-2/job.json`]: JSON.stringify({
      ...manifest, jobId: 'turn-2', workerId: 'ada', turn: 2,
      continuedFrom: 'turn-1', continuationKind: 'steer',
      startedAt: t2, chainStartedAt: t1, pendingSteers: 1,
    }),
    [`/repo/.agent-smith/jobs/legacy-steer/job.json`]: JSON.stringify({
      ...manifest, jobId: 'legacy-steer', workerId: 'bo',
      steeredFrom: 'legacy-1', startedAt: t2,
    }),
  }), '/repo', now);
  const v5 = jobs.find((j) => j.id === 'turn-2')!;
  assert.equal(v5.turn, 2);
  assert.equal(v5.continuedFrom, 'turn-1');
  assert.equal(v5.continuationKind, 'steer');
  assert.equal(v5.chainStartedAt, Date.parse(t1));
  assert.equal(v5.pendingSteers, 1);

  const legacy = jobs.find((j) => j.id === 'legacy-steer')!;
  assert.equal(legacy.turn, 1);
  assert.equal(legacy.continuedFrom, 'legacy-1');
  assert.equal(legacy.continuationKind, 'follow-up');
  assert.equal(legacy.chainStartedAt, Date.parse(t2));
});

test('canonical settled-job cache: O(active) disk reads, pruning, and steer-handoff self-heal', async () => {
  const reads: string[] = [];
  const files: Record<string, string> = {
    [`/repo/.agent-smith/jobs/done-1/job.json`]: JSON.stringify({
      ...manifest, jobId: 'done-1', workerId: 'w1', status: 'succeeded', finishedAt: new Date(now).toISOString(),
    }),
    [`/repo/.agent-smith/jobs/live-1/job.json`]: JSON.stringify({
      ...manifest, jobId: 'live-1', workerId: 'w2', status: 'running',
    }),
  };
  const fs = memoryFs(files, reads);
  const cache = new Map();

  const first = await readForgeJobs(fs, '/repo', now, cache);
  assert.equal(first.length, 2);
  assert.ok(reads.includes('/repo/.agent-smith/jobs/done-1/job.json'));
  assert.ok(reads.includes('/repo/.agent-smith/jobs/live-1/job.json'));

  reads.length = 0;
  const second = await readForgeJobs(fs, '/repo', now + 1000, cache);
  assert.equal(second.length, 2);
  assert.equal(reads.includes('/repo/.agent-smith/jobs/done-1/job.json'), false, 'settled job served from cache');
  assert.equal(reads.includes('/repo/.agent-smith/jobs/live-1/job.json'), true, 'live job re-read');

  files['/repo/.agent-smith/jobs/done-1/job.json'] = JSON.stringify({
    ...manifest, jobId: 'done-1', workerId: 'w1', status: 'succeeded', finishedAt: new Date(now).toISOString(), supersededBy: 'done-2',
  });
  files['/repo/.agent-smith/jobs/done-2/job.json'] = JSON.stringify({
    ...manifest, jobId: 'done-2', workerId: 'w1', turn: 2, status: 'running', continuedFrom: 'done-1', continuationKind: 'follow-up',
  });
  reads.length = 0;
  const third = await readForgeJobs(fs, '/repo', now + 2000, cache);
  assert.equal(third.find((j) => j.id === 'done-1')?.supersededBy, 'done-2');
  assert.equal(reads.includes('/repo/.agent-smith/jobs/done-1/job.json'), true, 'parent re-read once to pick up supersededBy');

  delete files['/repo/.agent-smith/jobs/done-1/job.json'];
  await readForgeJobs(fs, '/repo', now + 3000, cache);
  assert.equal(cache.has('/repo\0done-1'), false);
});

test('canonical: a job with a recorded short reason uses it; an old long error is classified on read', async () => {
  const base = '/repo/.agent-smith/jobs/j1';
  const read = async (extra: Record<string, unknown>) => (await readForgeJobs(memoryFs({
    [`${base}/job.json`]: JSON.stringify({ status: 'failed', startedAt: '2026-01-01T00:00:00Z', ...extra }),
  }), '/repo', Date.parse('2026-01-01T01:00:00Z')))[0];
  assert.equal((await read({ reason: 'denied view_file', error: 'a very long text' }))?.failureReason, 'denied view_file');
  assert.equal((await read({ error: 'worker soft-denied 1 tool action(s) (view_file) — exited 0' }))?.failureReason, 'worker soft-denied 1 tool action(s) (view_file) — exited 0');
});
test('canonical liveness: a long open command stays running, a stopped heartbeat is attention (dead)', async () => {
  const at = (ms: number) => new Date(ms).toISOString();
  const later = now + 20 * 60_000;
  const quiet = { lastEventAt: manifest.updatedAt, toolCalls: 1,
    lastActivity: { stepIndex: 1, tool: 'Bash', input: '{"command":"cargo test --workspace"}', status: 'active' } };
  const inTool = (await readForgeJobs(memoryFs({ [`${base}/job.json`]: JSON.stringify(manifest),
    [`${base}/progress.json`]: JSON.stringify({ ...quiet, lastAliveAt: at(later - 10_000) }) }), '/repo', later))[0];
  assert.equal(inTool?.status, 'running');
  assert.equal(inTool?.liveness?.state, 'in-tool');
  assert.equal(inTool?.liveness?.tool, 'cargo test --workspace');
  const dead = (await readForgeJobs(memoryFs({ [`${base}/job.json`]: JSON.stringify(manifest),
    [`${base}/progress.json`]: JSON.stringify({ ...quiet, lastAliveAt: at(later - 3 * 60_000) }) }), '/repo', later))[0];
  assert.equal(dead?.status, 'attention');
  assert.equal(dead?.liveness?.state, 'dead');
});
