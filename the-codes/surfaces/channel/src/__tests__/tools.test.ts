import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOL_DEFS, callTool, defaultMixedPipeline, type HandlerContext } from '../tools.ts';
import type { ModelCatalog } from '../../../../providers/types.ts';

const cat = (provider: string, extra: Partial<ModelCatalog> = {}): ModelCatalog => ({
  provider, models: [{ id: `${provider}-m`, label: provider, efforts: ['low', 'high'], defaultEffort: 'low' }],
  defaultModel: `${provider}-m`, defaultEffort: 'high', defaultSource: 'harness-config', source: 'static', stale: false, verified: true, ...extra,
});
const ctxWith = (cats: ModelCatalog[]) => ({ service: { repo: mkdtempSync(path.join(tmpdir(), 'agent-smith-tools-')) } as never, catalogs: async () => cats }) as HandlerContext;
const body = (r: { content: unknown }) => JSON.parse(((r.content as { text: string }[])[0]!).text);

test('mode enum rejects unknown modes', async () => {
  const r = await callTool(ctxWith([cat('agy')]), 'spawn_job', { mode: 'task', prompt: 'x' });
  assert.equal(r.isError, true);
  assert.match((r.content as { text: string }[])[0]!.text, /mode must be one of implement, review, moderate, verify/);
});

test('list_capabilities reports catalogs, errors and modes without throwing', async () => {
  const r = body(await callTool(ctxWith([cat('codex'), cat('claude', { models: [], error: 'boom', defaultSource: 'unknown', defaultModel: undefined })]), 'list_capabilities', {}));
  const codex = r.providers.find((p: any) => p.name === 'codex'); const claude = r.providers.find((p: any) => p.name === 'claude');
  assert.equal(codex.available, true); assert.equal(codex.models[0].id, 'codex-m'); assert.equal(codex.defaultSource, 'harness-config');
  assert.equal(claude.error, 'boom');
  assert.equal(r.providers.find((p: any) => p.name === 'agy').available, false);
  assert.deepEqual(r.modes.map((m: any) => m.name), ['implement', 'review', 'moderate', 'verify']);
  assert.equal(typeof r.efforts, 'string');
  const failing = { service: { repo: mkdtempSync(path.join(tmpdir(), 'agent-smith-tools-')) } as never, catalogs: async () => { throw new Error('x'); } } as HandlerContext;
  assert.equal((await callTool(failing, 'list_capabilities', {})).isError, undefined);
});

test('annotations are present', () => {
  const by = Object.fromEntries(TOOL_DEFS.map(t => [t.name, t.annotations]));
  for (const n of ['status', 'list_jobs', 'pipeline_status', 'list_capabilities']) assert.equal(by[n]?.readOnlyHint, true, n);
  assert.deepEqual([by.cancel?.destructiveHint, by.cancel?.idempotentHint], [true, true]);
  for (const n of ['spawn_job', 'run_pipeline', 'resume_job']) assert.deepEqual([by[n]?.readOnlyHint, by[n]?.openWorldHint], [false, true], n);
});

test('default pipeline derives providers from installed catalogs', async () => {
  const all = await defaultMixedPipeline({ name: 'p', task: 't' }, async () => [cat('agy'), cat('codex'), cat('claude', { defaultSource: 'unknown' })]);
  assert.deepEqual(all.stages.map(s => s.provider), ['agy', 'codex', 'claude']);
  assert.equal(all.stages[0]!.model, 'agy-m'); assert.equal(all.stages[0]!.effort, 'high');
  assert.equal(all.stages[2]!.model, undefined); assert.notEqual(all.stages[2]!.model, 'sonnet');
  const one = await defaultMixedPipeline({ name: 'p', task: 't' }, async () => [cat('codex')]);
  assert.deepEqual(one.stages.map(s => s.provider), ['codex', 'codex', 'codex']);
  await assert.rejects(defaultMixedPipeline({ name: 'p', task: 't' }, async () => []), /No providers installed.*agy/);
});

test('explicit stages are unchanged', async () => {
  const stages = [{ name: 'a', provider: 'opencode', prompt: 'x' }];
  const spec = await defaultMixedPipeline({ name: 'p', task: '', stages }, async () => { throw new Error('should not be called'); });
  assert.equal(spec.stages, stages);
});

test('spawn_job expands a user alias and role defaults from models.json', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-alias-'));
  mkdirSync(path.join(repo, '.agent-smith'));
  writeFileSync(path.join(repo, '.agent-smith', 'models.json'), JSON.stringify({
    aliases: { 'sol-high': { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' } },
    roleDefaults: { review: 'sol-high' },
  }));
  const seen: Array<Record<string, unknown>> = [];
  const service = { repo, spawnJob: async (r: Record<string, unknown>) => { seen.push(r); return { jobId: 'j', warnings: ['w'] }; } } as never;
  const ctx = { service, catalogs: async () => [] } as HandlerContext;
  const viaAlias = await callTool(ctx, 'spawn_job', { mode: 'implement', prompt: 'x', model: 'sol-high' });
  assert.equal(viaAlias.isError, undefined);
  assert.deepEqual([seen[0]!.provider, seen[0]!.model, seen[0]!.effort], ['codex', 'gpt-6.1-sol', 'high']);
  await callTool(ctx, 'spawn_job', { mode: 'review', prompt: 'x' });
  assert.deepEqual([seen[1]!.provider, seen[1]!.model, seen[1]!.effort], ['codex', 'gpt-6.1-sol', 'high']);
  const conflict = await callTool(ctx, 'spawn_job', { mode: 'implement', prompt: 'x', model: 'sol-high', provider: 'agy' });
  assert.equal(conflict.isError, true);
  const caps = await callTool(ctx, 'list_capabilities', {});
  assert.match((caps.content[0] as { text: string }).text, /sol-high/);
});

test('pipelines expand aliases in explicit stages and apply roleDefaults to the default pipeline', async () => {
  const { loadModelConfig } = await import('../../../../providers/aliases.ts');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-alias-pipe-'));
  mkdirSync(path.join(repo, '.agent-smith'));
  writeFileSync(path.join(repo, '.agent-smith', 'models.json'), JSON.stringify({
    aliases: { 'sol-high': { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' } },
    roleDefaults: { review: 'sol-high' },
  }));
  const modelConfig = loadModelConfig({ repo });
  const explicit = await defaultMixedPipeline({ name: 'p', task: 't', modelConfig, stages: [{ name: 'a', provider: 'codex', model: 'sol-high', role: 'implement' } as never] });
  assert.deepEqual([explicit.stages[0]!.provider, explicit.stages[0]!.model, explicit.stages[0]!.effort], ['codex', 'gpt-6.1-sol', 'high']);
  const cats = ['agy', 'codex', 'claude'].map(provider => ({ provider, models: [], defaultSource: 'unknown', source: 'live', stale: false, verified: true }) as never);
  const def = await defaultMixedPipeline({ name: 'p', task: 't', modelConfig }, async () => cats);
  const review = def.stages.find(s => s.name === 'review')!;
  assert.deepEqual([review.provider, review.model, review.effort], ['codex', 'gpt-6.1-sol', 'high']);
  assert.equal(def.stages.find(s => s.name === 'implement')!.model, undefined);
});

test('notifyHint: hook note always, monitorCommand only when the built monitor path is known, timeout capped', async () => {
  const { notifyHint } = await import('../tools.ts');
  const none = notifyHint({ job: 'j1' }, '/repo', 60_000, undefined);
  assert.equal(none.mode, 'hook');
  assert.match(none.note, /announced automatically by the plugin hook/);
  assert.equal('monitorCommand' in none, false);
  const job = notifyHint({ job: 'j1' }, '/repo', 2_700_000, '/rt/dist/monitor.js') as { monitorCommand: string; monitorTimeoutMs: number };
  assert.equal(job.monitorCommand, 'node "/rt/dist/monitor.js" --job j1 --cwd "/repo"');
  assert.equal(job.monitorTimeoutMs, 1_800_000);
  const run = notifyHint({ run: 'r1' }, '/repo', 120_000, '/rt/dist/monitor.js') as { monitorCommand: string; monitorTimeoutMs: number };
  assert.match(run.monitorCommand, /--run r1 /);
  assert.equal(run.monitorTimeoutMs, 120_000);
});

test('spawn_job ack carries a notify hint', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-notify-'));
  const service = { repo, spawnJob: async () => ({ jobId: 'j9', timeoutMs: 1000 }) } as never;
  const r = await callTool({ service, catalogs: async () => [cat('agy')] } as HandlerContext, 'spawn_job', { mode: 'implement', prompt: 'x', provider: 'agy' });
  assert.equal(r.isError, undefined);
  assert.equal(body(r).notify.mode, 'hook');
});
