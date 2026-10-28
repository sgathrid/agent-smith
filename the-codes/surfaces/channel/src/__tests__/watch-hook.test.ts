import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runJobWatch } from '../monitor.ts';
import { toNotice, type WatchableJob } from '../policy.ts';
import { parseHookInput, runHook } from '../watch-hook.ts';
import { claimMarkerPath, headline } from '../../../mod/hooks/notice.ts';
import { clearReadCache, readAll, readJob as readJobFile } from '../watch-source.ts';

const T0 = Date.parse('2026-10-07T12:00:00.000Z');
const job = (id: string, status: WatchableJob['status'], extra: Partial<WatchableJob> = {}): WatchableJob => ({
  id, name: `W-${id}`, role: 'implementer', status, lastEventAt: new Date(T0).toISOString(),
  finishedAt: status === 'running' ? null : new Date(T0 + 1000).toISOString(), warned: false, ...extra,
});

function watch(script: Record<string, WatchableJob[]>, opts: { jobIds?: string[]; runIds?: string[]; timeoutMs?: number } = {}) {
  const lines: string[] = [];
  const tick: Record<string, number> = {};
  let clock = T0;
  const read = async (_c: string, id: string) => {
    const seq = script[id]; if (!seq) return null;
    const i = Math.min(tick[id] ?? 0, seq.length - 1); tick[id] = (tick[id] ?? 0) + 1;
    return seq[i]!;
  };
  const p = runJobWatch({
    cwd: '/repo', ...opts, intervalMs: 50, now: () => (clock += 1000), readJob: read,
    readRun: async (_c, id) => { const j = await read(_c, id); return j ? { job: j, stageJobIds: [] } : null; },
    emit: (l) => { lines.push(l); },
  });
  return { p, lines };
}

test('already-terminal job is reported once and watch exits', async () => {
  const { p, lines } = watch({ a: [job('a', 'succeeded')] }, { jobIds: ['a'] });
  assert.equal(await p, 'done');
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^Agent Smith · ✓ .*done/);
});

test('running then succeeded', async () => {
  const { p, lines } = watch({ a: [job('a', 'running'), job('a', 'running'), job('a', 'succeeded')] }, { jobIds: ['a'] });
  assert.equal(await p, 'done');
  assert.equal(lines.length, 1);
});

test('failed and canceled are terminal', async () => {
  for (const status of ['failed', 'canceled'] as const) {
    const { p, lines } = watch({ a: [job('a', 'running'), job('a', status)] }, { jobIds: ['a'] });
    assert.equal(await p, 'done');
    assert.equal(lines.length, 1);
  }
});

test('two ids wait for both', async () => {
  const { p, lines } = watch({ a: [job('a', 'succeeded')], b: [job('b', 'running'), job('b', 'running'), job('b', 'failed')] }, { jobIds: ['a', 'b'] });
  assert.equal(await p, 'done');
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /b/);
});

test('run mode finishes with the pipeline record', async () => {
  const { p, lines } = watch({ r1: [job('r1', 'running', { role: 'pipeline' }), job('r1', 'failed', { role: 'pipeline', outcome: 'Pipeline failed; x.' })] }, { runIds: ['r1'] });
  assert.equal(await p, 'done');
  assert.equal(lines.length, 1);
});

test('timeout prints still running', async () => {
  const { p, lines } = watch({ a: [job('a', 'running')] }, { jobIds: ['a'], timeoutMs: 3000 });
  assert.equal(await p, 'timeout');
  assert.match(lines.at(-1)!, /Agent Smith · still running: a/);
});

const ack = { jobId: 'j1', repo: '/some/repo', dir: '/some/repo/.agent-smith/jobs/j1' };
const wrap = (tool: string, resp: unknown, extra: object = {}) => ({ tool_name: tool, tool_response: resp, cwd: '/cwd', ...extra });

test('hook input parsing handles each response shape', () => {
  const shapes: unknown[] = [
    { structuredContent: ack, content: [] },
    { content: [{ type: 'text', text: JSON.stringify(ack) }] },
    [{ type: 'text', text: JSON.stringify(ack) }],
    ack,
    JSON.stringify(ack),
  ];
  for (const s of shapes) {
    const t = parseHookInput(wrap('mcp__plugin_agent-smith_agent-smith__spawn_job', s));
    assert.deepEqual({ kind: t?.kind, id: t?.id, cwd: t?.cwd }, { kind: 'job', id: 'j1', cwd: '/some/repo' });
  }
  assert.equal(parseHookInput(wrap('resume_job', ack))?.kind, 'job');
  const run = parseHookInput(wrap('mcp__x__run_pipeline', { runId: 'r1', recordPath: '/p/.agent-smith/pipelines/r1.json' }));
  assert.deepEqual({ kind: run?.kind, id: run?.id, cwd: run?.cwd }, { kind: 'run', id: 'r1', cwd: '/p' });
});

test('repo falls back to dir then input.cwd', () => {
  assert.equal(parseHookInput(wrap('spawn_job', { jobId: 'j', dir: '/q/.agent-smith/jobs/j' }))?.cwd, '/q');
  assert.equal(parseHookInput(wrap('spawn_job', { jobId: 'j' }))?.cwd, '/cwd');
});

test('non-matching tool and error responses are ignored', async () => {
  assert.equal(parseHookInput(wrap('mcp__x__status', ack)), null);
  assert.equal(parseHookInput(wrap('spawn_job', { isError: true, content: [{ type: 'text', text: JSON.stringify(ack) }] })), null);
  assert.equal(parseHookInput(wrap('spawn_job', { content: [{ type: 'text', text: 'boom' }] })), null);
  assert.equal(parseHookInput(wrap('spawn_job', { error: 'x' })), null);
  let wrote = false;
  assert.equal(await runHook('not json', () => { wrote = true; }), 0);
  assert.equal(await runHook(JSON.stringify(wrap('status', ack)), () => { wrote = true; }), 0);
  assert.equal(wrote, false);
});

test('runHook exits 2 with the line for a finished job', async () => {
  let out = '';
  const code = await runHook(JSON.stringify(wrap('spawn_job', ack)), (s) => { out += s; }, {
    readJob: async () => job('j1', 'succeeded'), intervalMs: 50,
  });
  assert.equal(code, 2);
  assert.match(out, /^Agent Smith · ✓ W-j1 \(implementer\) · done\nstatus j1\n/);
  assert.match(out, /\(notice, not an error\)\n$/);
});

test('runHook stays silent for a launch the mod claimed', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-claim-'));
  const marker = claimMarkerPath(repo, 'job', 'j1');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, 'claimed\n');
  let out = '';
  const code = await runHook(JSON.stringify(wrap('spawn_job', { ...ack, repo })), (s) => { out += s; }, {
    readJob: async () => job('j1', 'succeeded'), intervalMs: 50,
  });
  assert.equal(code, 0);
  assert.equal(out, '');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('runHook finds the claim through a symlinked repo path', async () => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-claim-real-')));
  const link = `${real}-link`;
  fs.symlinkSync(real, link);
  const marker = claimMarkerPath(real, 'job', 'j1');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, 'claimed\n');
  const code = await runHook(JSON.stringify(wrap('spawn_job', { ...ack, repo: link })), () => {}, {
    readJob: async () => job('j1', 'succeeded'), intervalMs: 50,
  });
  assert.equal(code, 0);
  fs.rmSync(link); fs.rmSync(real, { recursive: true, force: true });
});

test('the watch-hook notice carries after-steer and dropped-steer markers', async () => {
  clearReadCache();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'steer-notice-'));
  const dir = path.join(repo, '.agent-smith', 'jobs', 'turn-2');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    schema: 1, jobId: 'turn-2', status: 'failed', provider: 'codex', name: 'Ada', steeredFrom: 'turn-1', error: 'timed out after 4s',
    startedAt: new Date(T0).toISOString(), finishedAt: new Date(T0 + 4000).toISOString(),
  }));
  fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify({
    warnings: ['1 queued steer not applied: the turn ended failed. Use resume_job or steer_job again.'],
  }));
  const found = (await readAll(repo)).find((j) => j.id === 'turn-2');
  assert.ok(found, 'job is read');
  assert.equal(found.steerNotApplied, true);
  const text = toNotice(found, 'failed', T0 + 5000);
  assert.equal(text.steered, true);
  assert.equal(text.steerNotApplied, true);
  assert.match(headline(text), /· after steer · queued steer not applied/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('full scan caches terminal jobs instead of re-reading them', async () => {
  clearReadCache();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cache-'));
  const runs = path.join(repo, '.agent-smith', 'pipelines');
  fs.mkdirSync(runs, { recursive: true });
  const file = path.join(runs, 'r1.json');
  const rec = (status: string) => JSON.stringify({ runId: 'r1', pipeline: 'p', status, startedAt: T0, finishedAt: T0 + 5, stageResults: {} });
  fs.writeFileSync(file, rec('passed'));
  assert.equal((await readAll(repo))[0]!.status, 'succeeded');
  fs.writeFileSync(file, rec('failed'));
  assert.equal((await readAll(repo))[0]!.status, 'succeeded', 'terminal record served from cache');
  clearReadCache();
  assert.equal((await readAll(repo))[0]!.status, 'failed');
  fs.rmSync(repo, { recursive: true, force: true });
});

test('hook watch budget follows the ack timeout, with a 6h cap fallback for pipelines', async () => {
  const { parseHookInput } = await import('../watch-hook.ts');
  const job = parseHookInput({ tool_name: 'mcp__x__spawn_job', tool_response: { jobId: 'j1', repo: '/tmp/r', timeoutMs: 120_000 } });
  assert.equal(job?.timeoutMs, 180_000);
  const run = parseHookInput({ tool_name: 'mcp__x__run_pipeline', tool_response: { runId: 'r1', repo: '/tmp/r' } });
  assert.equal(run?.timeoutMs, 6 * 60 * 60_000 + 60_000);
});

test('runJobWatch follows supersededBy without emitting an intermediate parent notice and resets the timeout budget', async () => {
  const { p, lines } = watch({
    a: [job('a', 'running'), job('a', 'canceled', { supersededBy: 'b' })],
    b: [job('b', 'running'), job('b', 'running'), job('b', 'succeeded')],
  }, { jobIds: ['a'], timeoutMs: 3500 });
  assert.equal(await p, 'done');
  assert.equal(lines.length, 1, 'only the final turn emits a notice');
  assert.match(lines[0]!, /W-b/);
  assert.match(lines[0]!, /status b/);
});

test('a watcher holds a job whose checks are inside their budget, then says exited with checks running, then the verdict', async () => {
  clearReadCache();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-notice-'));
  const dir = path.join(repo, '.agent-smith', 'jobs', 'j-1');
  fs.mkdirSync(dir, { recursive: true });
  const finished = Date.now() - 10 * 60_000;
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    schema: 1, jobId: 'j-1', status: 'succeeded', provider: 'codex', name: 'Ada',
    startedAt: new Date(finished - 60_000).toISOString(), finishedAt: new Date(finished).toISOString(),
  }));
  const acceptance = (extra: object) => fs.writeFileSync(path.join(dir, 'acceptance.json'), JSON.stringify(extra));
  const { readJob } = await import('../watch-source.ts');
  // 10 minutes after exit: past the flat 5-minute default, inside a 20-minute budget.
  acceptance({ state: 'unchecked', checks: [], pending: true, budgetMs: 20 * 60_000, running: 'ui-suite' });
  const held = await readJob(repo, 'j-1', Date.now());
  assert.equal(held?.status, 'running');
  // No budget on the placeholder: the 5-minute default has passed.
  acceptance({ state: 'unchecked', checks: [], pending: true, running: 'ui-suite' });
  const late = await readJob(repo, 'j-1', Date.now());
  assert.equal(late?.status, 'succeeded');
  assert.equal(late?.checksRunning, 'ui-suite');
  const text = headline(toNotice(late!, 'finished', Date.now()));
  assert.match(text, /exited · checks running: ui-suite/);
  assert.doesNotMatch(text, /done|✓/);
  const { dedupeKey } = await import('../policy.ts');
  acceptance({ state: 'accepted', checks: [{ name: 'ui-suite', ok: true }] });
  const verdict = await readJob(repo, 'j-1', Date.now());
  assert.notEqual(dedupeKey(late!), dedupeKey(verdict!), 'the verdict is announced again');
  assert.match(headline(toNotice(verdict!, 'finished', Date.now())), /✓ .*done · checks 1\/1/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test('announceOnce: the exited-with-checks notice is the only one; the default still sends the verdict as a second notice', async () => {
  const script = {
    a: [
      job('a', 'running'),
      job('a', 'succeeded', { checksRunning: 'ui-suite' }),
      job('a', 'succeeded', { checks: { passed: 1, total: 1 } as never }),
    ],
  };
  const once = (() => {
    const lines: string[] = []; const tick = { n: 0 }; let clock = T0;
    const p = runJobWatch({ cwd: '/repo', jobIds: ['a'], intervalMs: 50, now: () => (clock += 1000), announceOnce: true,
      readJob: async () => script.a[Math.min(tick.n++, 2)]!, emit: (l) => { lines.push(l); } });
    return { p, lines };
  })();
  assert.equal(await once.p, 'done');
  assert.equal(once.lines.length, 1);
  assert.match(once.lines[0]!, /exited · checks running: ui-suite/);
  const twice = watch(script, { jobIds: ['a'] });
  assert.equal(await twice.p, 'done');
  assert.equal(twice.lines.length, 2, 'the mod-style default keeps watching for the verdict');
});

function hookRepo(budgetMs: number | undefined, extra: object, finishedAgoMs: number) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-budget-'));
  const dir = path.join(repo, '.agent-smith', 'jobs', 'j-1');
  fs.mkdirSync(dir, { recursive: true });
  const finished = Date.now() - finishedAgoMs;
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    schema: 1, jobId: 'j-1', status: 'succeeded', provider: 'codex', name: 'Ada',
    startedAt: new Date(finished - 60_000).toISOString(), finishedAt: new Date(finished).toISOString(),
  }));
  fs.writeFileSync(path.join(dir, 'acceptance.json'), JSON.stringify({ state: 'unchecked', checks: [], pending: true, ...(budgetMs === undefined ? {} : { budgetMs }), ...extra }));
  return { repo, dir };
}
const launchInput = (repo: string, timeoutMs = 60_000) =>
  JSON.stringify({ tool_name: 'mcp__x__spawn_job', tool_response: { jobId: 'j-1', repo, timeoutMs } });

test('announceOnce: a pipeline stage that exited with checks running contributes no "checks running" line; its verdict comes with the run', async () => {
  const stage = [job('s1', 'succeeded', { checksRunning: 'slow' }), job('s1', 'succeeded', { checksRunning: 'slow' }), job('s1', 'failed', { outcome: 'checks failed: slow' })];
  const run = [job('r1', 'running', { role: 'pipeline' }), job('r1', 'running', { role: 'pipeline' }), job('r1', 'failed', { role: 'pipeline', outcome: 'Pipeline failed; s1.' })];
  const go = (announceOnce: boolean) => {
    const lines: string[] = []; const tick: Record<string, number> = {}; let clock = T0;
    const seq = (id: string) => { const s = id === 's1' ? stage : run; const i = Math.min(tick[id] ?? 0, s.length - 1); tick[id] = (tick[id] ?? 0) + 1; return s[i]!; };
    return runJobWatch({ cwd: '/repo', runIds: ['r1'], intervalMs: 20, now: () => (clock += 1000), announceOnce,
      readJob: async (_c, id) => seq(id), readRun: async (_c, id) => ({ job: seq(id), stageJobIds: ['s1'] }), emit: (l) => { lines.push(l); } }).then((r) => ({ r, lines }));
  };
  const twice = await go(false);
  assert.equal(twice.r, 'done');
  assert.ok(twice.lines.some((l) => /checks running: slow/.test(l)), 'default behaviour still reports the stage exited with checks running');
  const once = await go(true);
  assert.equal(once.r, 'done');
  assert.ok(once.lines.every((l) => !/checks running/.test(l)), `no "checks running" line: ${once.lines.join(' | ')}`);
  assert.ok(once.lines.some((l) => /checks failed: slow|Pipeline failed/.test(l)), 'the verdict is still announced');
});

test('hook deadline = job timeout + acceptance budget + grace, capped below the hook timeout', () => {
  const { repo } = hookRepo(10 * 60_000, { running: 'slow' }, 0);
  try {
    const t = parseHookInput(JSON.parse(launchInput(repo)));
    assert.equal(t?.timeoutMs, 60_000 + 10 * 60_000 + 60_000);
    const huge = hookRepo(30 * 60_000, {}, 0);
    const c = parseHookInput(JSON.parse(launchInput(huge.repo, 6 * 60 * 60_000)));
    assert.equal(c?.timeoutMs, 21_900_000 - 60_000, 'never outlives the hook');
    fs.rmSync(huge.repo, { recursive: true, force: true });
    // No checks, no placeholder budget: unchanged.
    const bare = hookRepo(undefined, {}, 0);
    assert.equal(parseHookInput(JSON.parse(launchInput(bare.repo)))?.timeoutMs, 120_000);
    fs.rmSync(bare.repo, { recursive: true, force: true });
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('hook with checks: one write at the verdict, never "checks running" and the verdict together', async () => {
  clearReadCache();
  const { repo, dir } = hookRepo(20 * 60_000, { running: 'slow' }, 5_000);
  try {
    let out = '';
    // The verdict lands while the hook is still holding the job: it is written when the hook
    // starts its SECOND read, i.e. after the first read (checks pending) was fully handled.
    let reads = 0;
    const readJob: NonNullable<Parameters<typeof runHook>[2]>['readJob'] = (cwd, id, now) => {
      if (++reads === 2) fs.writeFileSync(path.join(dir, 'acceptance.json'), JSON.stringify({ state: 'accepted', checks: [{ name: 'slow', ok: true, blocking: true }] }));
      return readJobFile(cwd, id, now);
    };
    const code = await runHook(launchInput(repo), (s) => { out += s; }, { intervalMs: 50, readJob });
    assert.equal(code, 2);
    assert.match(out, /done · checks 1\/1/);
    assert.doesNotMatch(out, /checks running/);
    assert.equal(out.split('Agent Smith').length - 1, 1, 'a single notice');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('hook with checks that outlive their budget: one "exited · checks running" notice, then it ends', async () => {
  clearReadCache();
  // Exited 10 min ago, 1-min budget: expired.
  const { repo } = hookRepo(60_000, { running: 'slow' }, 10 * 60_000);
  try {
    let out = '';
    const code = await runHook(launchInput(repo), (s) => { out += s; }, { intervalMs: 50 });
    assert.equal(code, 2);
    assert.match(out, /exited · checks running: slow/);
    assert.equal(out.split('Agent Smith').length - 1, 1);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
