/** spawn_job from and variants, and cancel's settle wait. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { ACCEPTANCE_FILE } from '../../../../forge/checks.ts';
import { FILES, jobDir, jobFile } from '../../../../forge/format.ts';
import { claimMarkerPath } from '../../../mod/hooks/notice.ts';
import type { ModelCatalog } from '../../../../providers/types.ts';
import { TOOL_DEFS, callTool, type HandlerContext } from '../tools.ts';
import { withWorkerLookup } from './service-mock.ts';

const cat = (provider: string): ModelCatalog => ({
  provider, models: [{ id: `${provider}-m`, label: provider, efforts: ['low', 'high'], defaultEffort: 'low' }, { id: `${provider}-n`, label: provider, efforts: ['low', 'high'], defaultEffort: 'low' }],
  defaultModel: `${provider}-m`, defaultEffort: 'high', defaultSource: 'harness-config', source: 'static', stale: false, verified: true,
});
const body = (r: { content: unknown }) => JSON.parse(((r.content as { text: string }[])[0]!).text);
const errText = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;

function fixture(opts: { failNames?: string[]; status?: () => string; cancelSettleMs?: number; onJobPrepared?: (id: string) => void } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'smith-from-'));
  const seen: Record<string, unknown>[] = [];
  let n = 0;
  const start = (req: Record<string, unknown>) => {
    if (opts.failNames?.includes(String(req.name))) throw new Error(`boom ${String(req.name)}`);
    const jobId = `job-${++n}`; seen.push(req); mkdirSync(jobDir(repo, jobId), { recursive: true });
    if (req.checks !== undefined) writeFileSync(jobFile(repo, jobId, FILES.checksSpec), JSON.stringify(req.checks));
    return { jobId, name: req.name ?? `w${n}`, provider: req.provider };
  };
  const service = withWorkerLookup({
    repo,
    spawnJob: async (req: Record<string, unknown>) => start(req),
    spawnTracked: async (req: Record<string, unknown>) => ({ ack: start(req), done: new Promise(() => {}) }),
    detail: async (id: string) => { if (!existsSync(jobDir(repo, id))) throw new Error('no job'); return { jobId: id, name: `n-${id}`, workerId: id, status: opts.status?.() ?? 'succeeded', report: null, warnings: [] }; },
    list: async () => [],
    cancel: (id: string) => ({ jobId: id, requested: true, signalled: true, note: 'x' }),
  });
  const ctx = { service, pollMs: 5, cancelSettleMs: opts.cancelSettleMs ?? 100, catalogs: async () => [cat('codex'), cat('agy')], onJobPrepared: opts.onJobPrepared } as unknown as HandlerContext;
  return { repo, seen, ctx };
}

const base = { mode: 'review', prompt: 'look closely', context: 'ctx text', provider: 'codex', model: 'codex-m', effort: 'high', checks: [{ name: 't', command: 'true' }], name: 'Ada' };

test('from reuses mode, prompt, context, provider, model and checks; arguments override; the name is not inherited', async () => {
  const f = fixture();
  assert.equal((await callTool(f.ctx, 'spawn_job', base)).isError, undefined);
  const r = await callTool(f.ctx, 'spawn_job', { from: 'job-1', prompt: 'new prompt', effort: 'low' });
  assert.equal(r.isError, undefined, errText(r));
  const second = f.seen[1]!;
  assert.equal(second.mode, 'review'); assert.equal(second.context, 'ctx text');
  assert.equal(second.provider, 'codex'); assert.equal(second.model, 'codex-m');
  assert.equal(second.prompt, 'new prompt'); assert.equal(second.effort, 'low');
  assert.equal(second.name, undefined);
  assert.deepEqual((second as { checks: { name: string }[] }).checks.map(c => c.name), ['t']);
  assert.deepEqual(body(r).checks, ['t']);
});

test('from a worker name resolves to its first turn', async () => {
  const f = fixture();
  await callTool(f.ctx, 'spawn_job', { ...base, checks: undefined });
  (f.ctx.service as unknown as { list: () => unknown }).list = async () => [{ jobId: 'job-1', name: 'Ada', workerId: 'job-1', startedAt: '2026-01-01T00:00:00Z' }];
  const r = await callTool(f.ctx, 'spawn_job', { from: 'Ada' });
  assert.equal(r.isError, undefined, errText(r));
  assert.equal(f.seen[1]!.prompt, 'look closely');
});

test('from with a different provider drops the inherited model, effort and unrestricted', async () => {
  const f = fixture();
  await callTool(f.ctx, 'spawn_job', { ...base, checks: undefined, model: 'codex-n', unrestricted: false });
  const r = await callTool(f.ctx, 'spawn_job', { from: 'job-1', provider: 'agy' });
  assert.equal(r.isError, undefined, errText(r));
  const second = f.seen[1]!;
  assert.equal(second.provider, 'agy'); assert.notEqual(second.model, 'codex-n'); assert.equal(second.unrestricted, undefined);
  // Same provider restated keeps them.
  await callTool(f.ctx, 'spawn_job', { from: 'job-1', provider: 'codex' });
  assert.equal(f.seen[2]!.model, 'codex-n');
});

test('from a job without a saved request fails clearly, and mode is still required without from', async () => {
  const f = fixture();
  await callTool(f.ctx, 'spawn_job', { ...base, checks: undefined });
  rmSync(jobFile(f.repo, 'job-1', FILES.request));
  const r = await callTool(f.ctx, 'spawn_job', { from: 'job-1' });
  assert.equal(r.isError, true); assert.match(errText(r), /no saved request to reuse/);
  const none = await callTool(f.ctx, 'spawn_job', { prompt: 'x', provider: 'codex' });
  assert.equal(none.isError, true); assert.match(errText(none), /mode is required/);
  assert.equal(f.seen.length, 1);
});

test('variants start one job per entry with distinct derived names', async () => {
  const f = fixture();
  const r = await callTool(f.ctx, 'spawn_job', { mode: 'review', prompt: 'x', variants: [{ provider: 'codex' }, { provider: 'agy' }, { provider: 'codex', model: 'codex-n' }] });
  assert.equal(r.isError, undefined, errText(r));
  assert.deepEqual(f.seen.map(s => s.name), ['review-codex', 'review-agy', 'review-codex-codex-n']);
  assert.deepEqual(f.seen.map(s => s.provider), ['codex', 'agy', 'codex']);
  assert.equal(body(r).jobs.length, 3); assert.deepEqual(body(r).jobs.map((j: { jobId: string }) => j.jobId), ['job-1', 'job-2', 'job-3']);
  const named = fixture();
  await callTool(named.ctx, 'spawn_job', { mode: 'review', prompt: 'x', name: 'dup', variants: [{ provider: 'codex' }, { provider: 'agy' }] });
  assert.deepEqual(named.seen.map(s => s.name), ['dup-codex', 'dup-agy']);
});

test('variants with from inherit the earlier request, then vary', async () => {
  const f = fixture();
  await callTool(f.ctx, 'spawn_job', { ...base, checks: undefined });
  const r = await callTool(f.ctx, 'spawn_job', { from: 'job-1', variants: [{ provider: 'agy' }, { effort: 'low', name: 'cheap' }] });
  assert.equal(r.isError, undefined, errText(r));
  assert.equal(f.seen[1]!.prompt, 'look closely'); assert.equal(f.seen[1]!.provider, 'agy'); assert.notEqual(f.seen[1]!.model, 'codex-m');
  assert.equal(f.seen[2]!.name, 'cheap'); assert.equal(f.seen[2]!.provider, 'codex'); assert.equal(f.seen[2]!.model, 'codex-m'); assert.equal(f.seen[2]!.effort, 'low');
});

test('variants reject duplicate names, more than eight, and an empty list, starting nothing', async () => {
  const f = fixture();
  const dup = await callTool(f.ctx, 'spawn_job', { mode: 'review', prompt: 'x', provider: 'codex', variants: [{ name: 'a' }, { name: 'a' }] });
  assert.equal(dup.isError, true); assert.match(errText(dup), /distinct names/);
  const same = await callTool(f.ctx, 'spawn_job', { mode: 'review', prompt: 'x', provider: 'codex', variants: [{ model: 'codex-m' }, { model: 'codex-m' }] });
  assert.equal(same.isError, true); assert.match(errText(same), /distinct names/);
  const many = await callTool(f.ctx, 'spawn_job', { mode: 'review', prompt: 'x', provider: 'codex', variants: Array.from({ length: 9 }, (_, i) => ({ name: `v${i}` })) });
  assert.equal(many.isError, true); assert.match(errText(many), /1 to 8/);
  const empty = await callTool(f.ctx, 'spawn_job', { mode: 'review', prompt: 'x', provider: 'codex', variants: [] });
  assert.equal(empty.isError, true);
  const eight = await callTool(f.ctx, 'spawn_job', { mode: 'review', prompt: 'x', provider: 'codex', variants: Array.from({ length: 8 }, (_, i) => ({ name: `v${i}` })) });
  assert.equal(eight.isError, undefined, errText(eight));
  assert.equal(f.seen.length, 8);
});

test('one failing variant yields {name, error} while the others start', async () => {
  const f = fixture({ failNames: ['bad'] });
  const r = await callTool(f.ctx, 'spawn_job', { mode: 'review', prompt: 'x', provider: 'codex', variants: [{ name: 'good' }, { name: 'bad' }, { name: 'fine' }] });
  assert.equal(r.isError, undefined, errText(r));
  const jobs = body(r).jobs;
  assert.equal(jobs[0].jobId, 'job-1'); assert.equal(jobs[1].name, 'bad'); assert.match(jobs[1].error, /boom bad/); assert.equal(jobs[1].jobId, undefined); assert.equal(jobs[2].jobId, 'job-2');
});

test('variants are rejected under a task-augmented call', async () => {
  const f = fixture({ onJobPrepared: () => {} });
  const r = await callTool(f.ctx, 'spawn_job', { mode: 'review', prompt: 'x', provider: 'codex', variants: [{ name: 'a' }] });
  assert.equal(r.isError, true); assert.match(errText(r), /task-augmented/);
  assert.equal(f.seen.length, 0);
});

test('a variants ack validates against the spawn_job outputSchema', async () => {
  const f = fixture({ failNames: ['bad'] });
  const r = await callTool(f.ctx, 'spawn_job', { mode: 'review', prompt: 'x', provider: 'codex', variants: [{ name: 'good' }, { name: 'bad' }] });
  const schema = TOOL_DEFS.find(t => t.name === 'spawn_job')!.outputSchema;
  const wire = JSON.parse(JSON.stringify(r.structuredContent));
  const check = new AjvJsonSchemaValidator().getValidator(schema as never)(wire);
  assert.ok(check.valid, `${check.errorMessage}\n${JSON.stringify(wire)}`);
  const input = TOOL_DEFS.find(t => t.name === 'spawn_job')!.inputSchema as { required?: string[] };
  assert.equal(input.required?.includes('mode') ?? false, false); assert.equal(input.required?.includes('prompt') ?? false, false);
});

test('cancel returns the settled status within the window and marks the notice claimed', async () => {
  let reads = 0;
  const f = fixture({ status: () => (reads++ < 3 ? 'running' : 'canceled'), cancelSettleMs: 2_000 });
  await callTool(f.ctx, 'spawn_job', { mode: 'review', prompt: 'x', provider: 'codex' });
  reads = 0;
  const c = body(await callTool(f.ctx, 'cancel', { jobId: 'job-1' }));
  assert.equal(c.status, 'canceled'); assert.equal(c.settled, true); assert.equal(c.requested, undefined);
  assert.ok(existsSync(claimMarkerPath(f.repo, 'job', 'job-1')));
});

test('cancel of a finished job returns its final status, settled', async () => {
  const f = fixture({ status: () => 'succeeded' });
  await callTool(f.ctx, 'spawn_job', { mode: 'review', prompt: 'x', provider: 'codex' });
  const c = body(await callTool(f.ctx, 'cancel', { jobId: 'job-1' }));
  assert.equal(c.status, 'succeeded'); assert.equal(c.settled, true);
});

test('cancel gives up after the window with settled:false and no claim marker', async () => {
  const f = fixture({ status: () => 'running', cancelSettleMs: 60 });
  await callTool(f.ctx, 'spawn_job', { mode: 'review', prompt: 'x', provider: 'codex' });
  const t0 = Date.now();
  const c = body(await callTool(f.ctx, 'cancel', { jobId: 'job-1' }));
  assert.equal(c.status, 'running'); assert.equal(c.settled, false);
  assert.ok(Date.now() - t0 < 2_000, 'waits only the window');
  assert.equal(existsSync(claimMarkerPath(f.repo, 'job', 'job-1')), false);
});

test('variants reject invalid shared args and invalid variant provider/model/effort as isError with nothing started', async () => {
  const f = fixture();
  for (const args of [
    { prompt: 'x', variants: [{ name: 'a' }] },
    { mode: 'review', variants: [{ name: 'a' }] },
    { mode: 'review', prompt: 'x', cwd: 'relative', variants: [{ name: 'a' }] },
    { mode: 'review', prompt: 'x', checks: 'bad', variants: [{ name: 'a' }] },
    { mode: 'review', prompt: 'x', env: { BAD: 123 }, variants: [{ name: 'a' }] },
    { mode: 'review', prompt: 'x', variants: [{ name: 'a', provider: 'bogus' }] },
    { mode: 'review', prompt: 'x', variants: [{ name: 'a', effort: 'bogus' }] },
    { mode: 'review', prompt: 'x', variants: [{ name: 'a', model: '' }] },
  ]) {
    const r = await callTool(f.ctx, 'spawn_job', args);
    assert.equal(r.isError, true, JSON.stringify(args));
  }
  assert.equal(f.seen.length, 0);
});

test('cancel writes the claim marker before signalling, removes it if unsettled, and keeps pre-existing markers', async () => {
  const f = fixture({ status: () => 'running', cancelSettleMs: 30 });
  await callTool(f.ctx, 'spawn_job', { mode: 'review', prompt: 'x', provider: 'codex' });
  let sawMarkerDuringCancel = false;
  const origCancel = f.ctx.service.cancel;
  (f.ctx.service as unknown as { cancel: (id: string) => unknown }).cancel = (id: string) => {
    sawMarkerDuringCancel = existsSync(claimMarkerPath(f.repo, 'job', id));
    return origCancel(id);
  };
  const unsettled = body(await callTool(f.ctx, 'cancel', { jobId: 'job-1' }));
  assert.equal(sawMarkerDuringCancel, true);
  assert.equal(unsettled.settled, false);
  assert.equal(existsSync(claimMarkerPath(f.repo, 'job', 'job-1')), false);

  // A pre-existing marker (e.g. claimed by the mod) is not removed when cancel times out.
  const preExisting = claimMarkerPath(f.repo, 'job', 'job-1');
  mkdirSync(path.dirname(preExisting), { recursive: true });
  writeFileSync(preExisting, 'mod\n');
  const stillRunning = body(await callTool(f.ctx, 'cancel', { jobId: 'job-1' }));
  assert.equal(stillRunning.settled, false);
  assert.equal(existsSync(preExisting), true);
});

test('cancel by an earlier turn marks both IDs and reads acceptance on the final jobId', async () => {
  const f = fixture({ cancelSettleMs: 200 });
  mkdirSync(jobDir(f.repo, 'turn-1'), { recursive: true });
  mkdirSync(jobDir(f.repo, 'turn-2'), { recursive: true });
  mkdirSync(jobDir(f.repo, 'turn-3'), { recursive: true });
  writeFileSync(path.join(jobDir(f.repo, 'turn-3'), ACCEPTANCE_FILE), JSON.stringify({ state: 'unchecked', pending: true, running: 'check-3' }));
  let reads = 0;
  const svc = f.ctx.service as unknown as {
    cancel: (id: string) => unknown;
    resolveHead: (id: string) => string;
    detail: (id: string) => Promise<unknown>;
  };
  svc.cancel = (id: string) => (id === 'turn-1' ? { jobId: 'turn-2', resolvedFrom: id, requested: true, signalled: true, note: 'x' } : { jobId: id, requested: true, signalled: true, note: 'x' });
  svc.resolveHead = () => (reads === 0 ? 'turn-2' : 'turn-3');
  svc.detail = async (id: string) => {
    reads++;
    return { jobId: id, name: 'w', workerId: 'turn-1', status: id === 'turn-3' ? 'canceled' : 'running', report: null, warnings: [] };
  };
  const c = body(await callTool(f.ctx, 'cancel', { jobId: 'turn-1' }));
  assert.equal(c.jobId, 'turn-3');
  assert.equal(c.resolvedFrom, 'turn-1');
  assert.equal(c.settled, false);
  assert.equal(c.checksCanceled, false);
  assert.equal(existsSync(claimMarkerPath(f.repo, 'job', 'turn-1')), false);
  assert.equal(existsSync(claimMarkerPath(f.repo, 'job', 'turn-2')), false);
  assert.equal(existsSync(claimMarkerPath(f.repo, 'job', 'turn-3')), false);

  // Once acceptance finishes, cancel settles and keeps markers for both IDs.
  writeFileSync(path.join(jobDir(f.repo, 'turn-3'), ACCEPTANCE_FILE), JSON.stringify({ state: 'accepted', pending: false }));
  const settled = body(await callTool(f.ctx, 'cancel', { jobId: 'turn-1' }));
  assert.equal(settled.jobId, 'turn-3');
  assert.equal(settled.resolvedFrom, 'turn-1');
  assert.equal(settled.settled, true);
  assert.ok(existsSync(claimMarkerPath(f.repo, 'job', 'turn-1')));
  assert.ok(existsSync(claimMarkerPath(f.repo, 'job', 'turn-2')));
  assert.ok(existsSync(claimMarkerPath(f.repo, 'job', 'turn-3')));
});

test('from preserves raw provider so role defaults re-apply and another-provider aliases work', async () => {
  const f = fixture();
  mkdirSync(path.join(f.repo, '.agent-smith'), { recursive: true });
  writeFileSync(path.join(f.repo, '.agent-smith', 'models.json'), JSON.stringify({
    aliases: {
      'rev-codex': { provider: 'codex', model: 'gpt-5.4', effort: 'high' },
      'alt-agy': { provider: 'agy', model: 'gemini-2.5', effort: 'low' },
    },
    roleDefaults: { review: 'rev-codex' },
  }));
  const first = await callTool(f.ctx, 'spawn_job', { mode: 'review', prompt: 'x' });
  assert.equal(first.isError, undefined, errText(first));
  assert.equal(f.seen[0]!.provider, 'codex');
  assert.equal(f.seen[0]!.model, 'gpt-5.4');
  assert.equal(f.seen[0]!.effort, 'high');

  const rerun = await callTool(f.ctx, 'spawn_job', { from: 'job-1' });
  assert.equal(rerun.isError, undefined, errText(rerun));
  assert.equal(f.seen[1]!.provider, 'codex');
  assert.equal(f.seen[1]!.model, 'gpt-5.4');
  assert.equal(f.seen[1]!.effort, 'high');

  const switched = await callTool(f.ctx, 'spawn_job', { from: 'job-1', model: 'alt-agy' });
  assert.equal(switched.isError, undefined, errText(switched));
  assert.equal(f.seen[2]!.provider, 'agy');
  assert.equal(f.seen[2]!.model, 'gemini-2.5');
});

test('overlay drops base model, effort and unrestricted when a variant names a different or unresolved provider', async () => {
  const f = fixture();
  const r = await callTool(f.ctx, 'spawn_job', {
    mode: 'review', prompt: 'x', model: 'gpt-5.4', effort: 'high', unrestricted: false,
    variants: [{ provider: 'codex' }, { provider: 'agy' }, { name: 'agy-low', provider: 'agy', effort: 'low' }],
  });
  assert.equal(r.isError, undefined, errText(r));
  assert.equal(f.seen[0]!.provider, 'codex');
  assert.equal(f.seen[0]!.model, undefined);
  assert.equal(f.seen[0]!.effort, undefined);
  assert.equal(f.seen[0]!.unrestricted, undefined);
  assert.equal(f.seen[1]!.provider, 'agy');
  assert.equal(f.seen[1]!.model, undefined);
  assert.equal(f.seen[1]!.effort, undefined);
  assert.equal(f.seen[1]!.unrestricted, undefined);
  assert.equal(f.seen[2]!.provider, 'agy');
  assert.equal(f.seen[2]!.effort, 'low');
});

test('cancel waits for supersededBy to settle and cancels the new head that appears during the wait', async () => {
  const f = fixture({ cancelSettleMs: 200 });
  mkdirSync(jobDir(f.repo, 'turn-1'), { recursive: true });
  mkdirSync(jobDir(f.repo, 'turn-2'), { recursive: true });
  const canceledCalls: string[] = [];
  let turn2Status = 'running';
  const svc = f.ctx.service as unknown as {
    cancel: (id: string) => unknown;
    resolveHead: (id: string) => string;
    detail: (id: string) => Promise<unknown>;
  };
  svc.cancel = (id: string) => {
    canceledCalls.push(id);
    if (id === 'turn-2') turn2Status = 'canceled';
    return { jobId: id, requested: true, signalled: true, note: 'x' };
  };
  svc.resolveHead = () => 'turn-2';
  svc.detail = async (id: string) => (
    id === 'turn-1'
      ? { jobId: 'turn-1', name: 'w', workerId: 'turn-1', status: 'canceled', supersededBy: 'turn-2', report: null, warnings: [] }
      : { jobId: 'turn-2', name: 'w', workerId: 'turn-1', status: turn2Status, report: null, warnings: [] }
  );
  const c = body(await callTool(f.ctx, 'cancel', { jobId: 'turn-1' }));
  assert.deepEqual(canceledCalls, ['turn-1', 'turn-2']);
  assert.equal(c.jobId, 'turn-2');
  assert.equal(c.settled, true);
  assert.ok(existsSync(claimMarkerPath(f.repo, 'job', 'turn-1')));
  assert.ok(existsSync(claimMarkerPath(f.repo, 'job', 'turn-2')));
});
