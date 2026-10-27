import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { callTool, parseStages, TOOL_DEFS, type HandlerContext } from '../tools.ts';
import { readAcceptance, writeAcceptance } from '../../../../forge/checks.ts';
import { waitFor } from '../../../../forge/testing/time.ts';

const body = (r: { content: unknown }) => JSON.parse(((r.content as { text: string }[])[0]!).text);
function fake(finalStatus: string, runningReads = 0) {
  const repo = mkdtempSync(path.join(tmpdir(), 'tools-'));
  let reads = 0; let resolve!: (m: unknown) => void;
  const done = new Promise(r => { resolve = r; });
  const service = {
    repo,
    spawnJob: async () => ({ jobId: 'job-1' }),
    spawnTracked: async () => ({ ack: { jobId: 'job-1' }, done }),
    detail: async () => ({ jobId: 'job-1', status: reads++ < runningReads ? 'running' : finalStatus, report: null, warnings: [] }),
  };
  return { repo, ctx: { service: service as never, pollMs: 5, catalogs: async () => [] } as HandlerContext, finish: () => resolve({ status: finalStatus, cwd: repo }) };
}
// Checks run real shell commands: wait for the verdict, never for a fixed time.
const settled = (repo: string) => waitFor(() => !(readAcceptance(repo, 'job-1') as { pending?: boolean }).pending, { message: 'acceptance no longer pending' });

test('spawn_job with checks writes acceptance after terminal state', async () => {
  const f = fake('succeeded');
  const r = await callTool(f.ctx, 'spawn_job', { mode: 'implement', prompt: 'x', provider: 'agy', checks: [{ name: 'ok', command: 'true' }] });
  assert.equal(r.isError, undefined); assert.equal(body(r).jobId, 'job-1'); assert.deepEqual(r.structuredContent, body(r));
  assert.equal(readAcceptance(f.repo, 'job-1').state, 'unchecked');
  assert.equal(body(await callTool(f.ctx, 'status', { jobId: 'job-1' })).acceptance.pending, true);
  f.finish(); await settled(f.repo);
  const s = body(await callTool(f.ctx, 'status', { jobId: 'job-1' }));
  assert.equal(s.status, 'succeeded'); assert.equal(s.acceptance.state, 'accepted'); assert.deepEqual(s.acceptance.passed, ['ok']);
});

test('spawn_job passes context and the checks to the service so the worker brief can show them', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'tools-'));
  const seen: Record<string, unknown>[] = [];
  const service = {
    repo,
    spawnJob: async (req: Record<string, unknown>) => { seen.push(req); return { jobId: 'job-1' }; },
    spawnTracked: async (req: Record<string, unknown>) => { seen.push(req); return { ack: { jobId: 'job-2' }, done: new Promise(() => {}) }; },
  };
  const ctx = { service: service as never, catalogs: async () => [] } as HandlerContext;
  const plain = await callTool(ctx, 'spawn_job', { mode: 'implement', prompt: 'x', provider: 'agy', context: 'For the release notes.' });
  assert.equal(plain.isError, undefined);
  assert.equal(seen[0]!.context, 'For the release notes.');
  assert.equal(seen[0]!.checks, undefined);
  await callTool(ctx, 'spawn_job', { mode: 'implement', prompt: 'x', provider: 'agy', checks: [{ name: 'ok', command: 'true' }] });
  assert.deepEqual((seen[1]!.checks as { name: string; command: string }[]).map(c => [c.name, c.command]), [['ok', 'true']]);
  assert.equal(seen[1]!.context, undefined);
  for (const context of [42, '', '   ', 'x'.repeat(2_001)]) {
    const bad = await callTool(ctx, 'spawn_job', { mode: 'implement', prompt: 'x', provider: 'agy', context });
    assert.equal(bad.isError, true, `context ${JSON.stringify(context).slice(0, 20)} is rejected`);
    assert.match((bad.content as { text: string }[])[0]!.text, /context must be/);
  }
  assert.equal(seen.length, 2, 'a rejected context never reaches the service');
  const def = TOOL_DEFS.find(t => t.name === 'spawn_job')!;
  assert.equal((def.inputSchema.properties as Record<string, { type: string }>)['context']!.type, 'string');
});

test('run_pipeline stages accept a context string and reject a non-string one', () => {
  const [st] = parseStages([{ name: 'implement', provider: 'agy', context: 'Unblocks the migration.', checks: [{ name: 'unit', command: 'npm test' }] }])!;
  assert.equal(st!.context, 'Unblocks the migration.');
  assert.throws(() => parseStages([{ name: 'implement', provider: 'agy', context: 7 }]), /context must be/);
});

test('failing blocking check rejects; failed job rejects', async () => {
  const f = fake('succeeded');
  await callTool(f.ctx, 'spawn_job', { mode: 'implement', prompt: 'x', provider: 'agy', checks: [{ name: 'bad', command: 'exit 1' }] });
  f.finish(); await settled(f.repo);
  assert.equal(readAcceptance(f.repo, 'job-1').state, 'rejected');
  const g = fake('failed');
  await callTool(g.ctx, 'spawn_job', { mode: 'implement', prompt: 'x', provider: 'agy', checks: [{ name: 'ok', command: 'true' }] });
  g.finish(); await settled(g.repo);
  assert.equal(readAcceptance(g.repo, 'job-1').state, 'rejected');
});

test('no checks: unchecked acceptance on status', async () => {
  const f = fake('succeeded');
  const s = body(await callTool(f.ctx, 'status', { jobId: 'job-1' }));
  assert.deepEqual(s.acceptance, { state: 'unchecked' }); assert.equal(s.waited, undefined);
});

test('status wait_ms long-polls and is capped', async () => {
  const f = fake('succeeded', 3);
  const s = body(await callTool(f.ctx, 'status', { jobId: 'job-1', wait_ms: 2000 }));
  assert.equal(s.waited, true); assert.equal(s.stillRunning, false); assert.equal(s.status, 'succeeded');
  const g = fake('succeeded', 1000);
  const still = body(await callTool(g.ctx, 'status', { jobId: 'job-1', wait_ms: 60 }));
  assert.equal(still.stillRunning, true); // a still-running job returns after wait_ms rather than hanging
  assert.equal((await callTool(f.ctx, 'status', { jobId: 'job-1', wait_ms: 60_001 })).isError, true);
});

test('structuredContent wraps arrays; outputSchema is permissive', async () => {
  const ctx = { service: { list: async () => [{ jobId: 'a', warnings: [] }] } as never } as HandlerContext;
  const r = await callTool(ctx, 'list_jobs', {});
  assert.deepEqual(r.structuredContent, { items: [{ jobId: 'a' }] });
  for (const n of ['status', 'list_jobs', 'list_capabilities', 'spawn_job']) assert.equal(TOOL_DEFS.find(t => t.name === n)!.outputSchema!.additionalProperties, true);
});

test('spawn_job writes the checks budget into the pending placeholder', async () => {
  const f = fake('succeeded');
  await callTool(f.ctx, 'spawn_job', { mode: 'implement', prompt: 'x', provider: 'agy', checks: [{ name: 'a', command: 'true', timeoutMs: 600_000 }, { name: 'b', command: 'true', timeoutMs: 600_000 }] });
  const pending = readAcceptance(f.repo, 'job-1') as { pending?: boolean; budgetMs?: number };
  assert.equal(pending.pending, true); assert.equal(pending.budgetMs, 1_230_000);
});

test('status shows which check is running, and cancel aborts checks of an exited worker', async () => {
  const f = fake('succeeded');
  (f.ctx.service as unknown as { cancel: (id: string) => unknown }).cancel = (id: string) => ({ jobId: id, requested: true, signalled: false, note: 'x' });
  await callTool(f.ctx, 'spawn_job', { mode: 'implement', prompt: 'x', provider: 'agy', checks: [{ name: 'hang', command: 'sleep 30', timeoutMs: 60_000 }] });
  f.finish();
  const mid = await waitFor(async () => {
    const m = body(await callTool(f.ctx, 'status', { jobId: 'job-1' }));
    return m.acceptance.running === 'hang' ? m : null;
  }, { message: 'check "hang" to start running' });
  assert.equal(mid.acceptance.pending, true);
  const c = body(await callTool(f.ctx, 'cancel', { jobId: 'job-1' }));
  assert.equal(c.checksCanceled, true);
  await settled(f.repo);
  const after = readAcceptance(f.repo, 'job-1');
  assert.equal(after.state, 'unchecked'); assert.equal((after as { reason?: string }).reason, 'checks canceled');
  assert.equal((after as { pending?: boolean }).pending, undefined);
});

test('cancel under a detached supervisor does not claim it aborted the checks', async () => {
  const f = fake('succeeded');
  (f.ctx.service as unknown as { cancel: (id: string) => unknown }).cancel = (id: string) => ({ jobId: id, requested: true, signalled: false, note: 'x' });
  (f.ctx.service as unknown as { supervisorUrl: URL }).supervisorUrl = new URL('file:///unused');
  writeAcceptance(f.repo, 'job-1', { state: 'unchecked', checks: [], pending: true, budgetMs: 60_000, running: 'hang' });
  const c = body(await callTool(f.ctx, 'cancel', { jobId: 'job-1' }));
  assert.equal(c.requested, true);
  assert.equal(c.checksCanceled, false);
  assert.match(c.checksNote, /supervisor .* will stop them/);
  // Checks not running (job still executing): nothing to say about them.
  writeAcceptance(f.repo, 'job-1', { state: 'unchecked', checks: [], pending: true, budgetMs: 60_000 });
  const d = body(await callTool(f.ctx, 'cancel', { jobId: 'job-1' }));
  assert.equal('checksCanceled' in d, false);
});

test('spawn_job env reaches the service; the ack names keys only; bad env is rejected', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'tools-'));
  const seen: Record<string, unknown>[] = [];
  const service = { repo, spawnJob: async (req: Record<string, unknown>) => { seen.push(req); return { jobId: 'job-1', envKeys: Object.keys(req.env as object) }; } };
  const ctx = { service: service as never, catalogs: async () => [] } as HandlerContext;
  const ok = await callTool(ctx, 'spawn_job', { mode: 'implement', prompt: 'x', provider: 'agy', env: { CARGO_TARGET_DIR: '/tmp/t' } });
  assert.deepEqual(seen[0]!.env, { CARGO_TARGET_DIR: '/tmp/t' });
  assert.deepEqual(body(ok).envKeys, ['CARGO_TARGET_DIR']);
  assert.doesNotMatch(JSON.stringify(body(ok)), /\/tmp\/t/);
  for (const env of ['x', ['A'], { 'bad-key': '1' }, { A: 1 }]) {
    const bad = await callTool(ctx, 'spawn_job', { mode: 'implement', prompt: 'x', provider: 'agy', env });
    assert.equal(bad.isError, true);
  }
  assert.equal(seen.length, 1);
  assert.equal(parseStages([{ name: 's', provider: 'agy', prompt: 'p', env: { A: 'b' } }])![0]!.env!.A, 'b');
});
