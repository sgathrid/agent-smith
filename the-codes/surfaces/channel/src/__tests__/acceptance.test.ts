import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { callTool, parseStages, TOOL_DEFS, type HandlerContext } from '../tools.ts';
import { readAcceptance, writeAcceptance } from '../../../../forge/checks.ts';
import { withWorkerLookup } from './service-mock.ts';

const body = (r: { content: unknown }) => JSON.parse(((r.content as { text: string }[])[0]!).text);
function fake(finalStatus: string, runningReads = 0) {
  const repo = mkdtempSync(path.join(tmpdir(), 'tools-'));
  let reads = 0;
  const seen: Record<string, unknown>[] = [];
  const service = withWorkerLookup({
    repo,
    spawnJob: async (req: Record<string, unknown>) => { seen.push(req); return { jobId: 'job-1' }; },
    detail: async () => ({ jobId: 'job-1', status: reads++ < runningReads ? 'running' : finalStatus, report: null, warnings: [] }),
  });
  return { repo, seen, ctx: { service: service as never, pollMs: 5, catalogs: async () => [] } as HandlerContext };
}

test('spawn_job with checks hands them to the worker\'s owner (ownerChecks) and the ack names them', async () => {
  const f = fake('succeeded');
  const r = await callTool(f.ctx, 'spawn_job', { mode: 'implement', prompt: 'x', provider: 'agy', checks: [{ name: 'ok', command: 'true' }] });
  assert.equal(r.isError, undefined); assert.equal(body(r).jobId, 'job-1'); assert.deepEqual(r.structuredContent, body(r));
  assert.deepEqual(body(r).checks, ['ok']);
  assert.equal(f.seen[0]!.ownerChecks, true, 'the owner runs the checks, also across follow-ups');
  assert.deepEqual((f.seen[0]!.checks as { name: string }[]).map(c => c.name), ['ok']);
  assert.equal('pending' in readAcceptance(f.repo, 'job-1'), false);
  await callTool(f.ctx, 'spawn_job', { mode: 'implement', prompt: 'x', provider: 'agy' });
  assert.equal(f.seen[1]!.ownerChecks, true);
  assert.equal(f.seen[1]!.checks, undefined);
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

test('no checks: unchecked acceptance on status', async () => {
  const f = fake('succeeded');
  const s = body(await callTool(f.ctx, 'status', { id: 'job-1' }));
  assert.deepEqual(s.acceptance, { state: 'unchecked' }); assert.equal(s.waited, undefined);
});

test('status wait_ms keeps waiting while acceptance checks run, and returns once they settle', async () => {
  const f = fake('succeeded');
  writeAcceptance(f.repo, 'job-1', { state: 'unchecked', checks: [], pending: true, budgetMs: 60_000, running: 'suite' });
  const started = Date.now();
  const timer = setTimeout(() => writeAcceptance(f.repo, 'job-1', { state: 'accepted', checks: [] }), 150);
  try {
    const s = body(await callTool(f.ctx, 'status', { id: 'job-1', wait_ms: 5_000 }));
    assert.ok(Date.now() - started >= 140, 'did not return while the checks were still running');
    assert.equal(s.stillRunning, false); assert.equal(s.acceptance.state, 'accepted');
    writeAcceptance(f.repo, 'job-1', { state: 'unchecked', checks: [], pending: true, budgetMs: 60_000, running: 'suite' });
    assert.equal(body(await callTool(f.ctx, 'status', { id: 'job-1', wait_ms: 60 })).stillRunning, true);
  } finally {
    clearTimeout(timer);
  }
});

test('status wait_ms long-polls and is capped', async () => {
  const f = fake('succeeded', 3);
  const s = body(await callTool(f.ctx, 'status', { id: 'job-1', wait_ms: 2000 }));
  assert.equal(s.waited, true); assert.equal(s.stillRunning, false); assert.equal(s.status, 'succeeded');
  const g = fake('succeeded', 1000);
  const still = body(await callTool(g.ctx, 'status', { id: 'job-1', wait_ms: 60 }));
  assert.equal(still.stillRunning, true);
  assert.equal((await callTool(f.ctx, 'status', { id: 'job-1', wait_ms: 60_001 })).isError, true);
});

test('structuredContent wraps arrays; outputSchema is permissive', async () => {
  const ctx = { service: { list: async () => [{ jobId: 'a', status: 'succeeded', warnings: [] }] } as never } as HandlerContext;
  const r = await callTool(ctx, 'list_jobs', {});
  assert.deepEqual(r.structuredContent, { items: [{ jobId: 'a', status: 'succeeded' }] });
  for (const n of ['status', 'list_jobs', 'list_capabilities', 'spawn_job']) assert.equal(TOOL_DEFS.find(t => t.name === n)!.outputSchema!.additionalProperties, true);
});

test('cancel while checks run: checksCanceled once their owner stops them, else a note that it will', async () => {
  const f = fake('succeeded');
  (f.ctx.service as unknown as { cancel: (id: string) => unknown }).cancel = (id: string) => ({ jobId: id, requested: true, signalled: false, note: 'x' });
  writeAcceptance(f.repo, 'job-1', { state: 'unchecked', checks: [], pending: true, budgetMs: 60_000, running: 'hang' });
  assert.equal(body(await callTool(f.ctx, 'status', { id: 'job-1' })).acceptance.running, 'hang');
  const timer = setTimeout(() => writeAcceptance(f.repo, 'job-1', { state: 'unchecked', checks: [], reason: 'checks canceled' }), 50);
  try {
    const c = body(await callTool({ ...f.ctx, cancelSettleMs: 5_000 }, 'cancel', { id: 'job-1' }));
    assert.deepEqual([c.settled, c.checksCanceled], [true, true]);
  } finally { clearTimeout(timer); }
  writeAcceptance(f.repo, 'job-1', { state: 'unchecked', checks: [], pending: true, budgetMs: 60_000, running: 'hang' });
  const late = body(await callTool({ ...f.ctx, cancelSettleMs: 60 }, 'cancel', { id: 'job-1' }));
  assert.deepEqual([late.settled, late.checksCanceled], [false, false]);
  assert.match(late.checksNote, /will stop them/);
  writeAcceptance(f.repo, 'job-1', { state: 'unchecked', checks: [], pending: true, budgetMs: 60_000 });
  const d = body(await callTool({ ...f.ctx, cancelSettleMs: 60 }, 'cancel', { id: 'job-1' }));
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
