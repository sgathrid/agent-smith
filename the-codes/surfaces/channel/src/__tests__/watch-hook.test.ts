import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runJobWatch } from '../monitor.ts';
import type { WatchableJob } from '../policy.ts';
import { parseHookInput, runHook } from '../watch-hook.ts';
import { clearReadCache, readAll } from '../watch-source.ts';

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
  assert.match(lines[0]!, /^Agent Smith: .*completed execution/);
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
  assert.match(lines.at(-1)!, /still running; check status a/);
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
  assert.match(out, /^Agent Smith: /);
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
