import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { callTool, parseStages, TOOL_DEFS, type HandlerContext } from '../tools.ts';
import { readAcceptance } from '../../../../forge/checks.ts';

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
const settle = () => new Promise(r => setTimeout(r, 300));

test('spawn_job with checks writes acceptance after terminal state', async () => {
  const f = fake('succeeded');
  const r = await callTool(f.ctx, 'spawn_job', { mode: 'implement', prompt: 'x', provider: 'agy', checks: [{ name: 'ok', command: 'true' }] });
  assert.equal(r.isError, undefined); assert.equal(body(r).jobId, 'job-1'); assert.deepEqual(r.structuredContent, body(r));
  assert.equal(readAcceptance(f.repo, 'job-1').state, 'unchecked');
  assert.equal(body(await callTool(f.ctx, 'status', { jobId: 'job-1' })).acceptance.pending, true);
  f.finish(); await settle();
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
  f.finish(); await settle();
  assert.equal(readAcceptance(f.repo, 'job-1').state, 'rejected');
  const g = fake('failed');
  await callTool(g.ctx, 'spawn_job', { mode: 'implement', prompt: 'x', provider: 'agy', checks: [{ name: 'ok', command: 'true' }] });
  g.finish(); await settle();
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
  const t = Date.now(); const still = body(await callTool(g.ctx, 'status', { jobId: 'job-1', wait_ms: 60 }));
  assert.equal(still.stillRunning, true); assert.ok(Date.now() - t < 1000);
  assert.equal((await callTool(f.ctx, 'status', { jobId: 'job-1', wait_ms: 60_001 })).isError, true);
});

test('structuredContent wraps arrays; outputSchema is permissive', async () => {
  const ctx = { service: { list: async () => [{ jobId: 'a', warnings: [] }] } as never } as HandlerContext;
  const r = await callTool(ctx, 'list_jobs', {});
  assert.deepEqual(r.structuredContent, { items: [{ jobId: 'a' }] });
  for (const n of ['status', 'list_jobs', 'list_capabilities', 'spawn_job']) assert.equal(TOOL_DEFS.find(t => t.name === n)!.outputSchema!.additionalProperties, true);
});
