import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOL_DEFS, callTool, defaultMixedPipeline, type HandlerContext } from '../tools.ts';
import { readAcceptance, writeAcceptance } from '../../../../forge/checks.ts';
import { writePipelineRecord } from '../../../../forge/execute.ts';
import type { ModelCatalog } from '../../../../providers/types.ts';
import { withWorkerLookup } from './service-mock.ts';

const cat = (provider: string, extra: Partial<ModelCatalog> = {}): ModelCatalog => ({
  provider, models: [{ id: `${provider}-m`, label: provider, efforts: ['low', 'high'], defaultEffort: 'low' }],
  defaultModel: `${provider}-m`, defaultEffort: 'high', defaultSource: 'harness-config', source: 'static', stale: false, verified: true, ...extra,
});
const ctxWith = (cats: ModelCatalog[]) => ({ service: { repo: mkdtempSync(path.join(tmpdir(), 'agent-smith-tools-')) } as never, catalogs: async () => cats }) as HandlerContext;
const body = (r: { content: unknown }) => JSON.parse(((r.content as { text: string }[])[0]!).text);

test('spawn_job validates and forwards an absolute working directory', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'smith-cwd-store-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'smith-cwd-work-'));
  const seen: Array<Record<string, unknown>> = [];
  const service = withWorkerLookup({ repo, spawnJob: async (request: Record<string, unknown>) => {
    seen.push(request); return { jobId: 'job-cwd' };
  }, detail: async () => ({ jobId: 'fixture-job', status: 'succeeded', provider: 'codex', mode: 'review',
    name: 'Ada', workerId: 'Ada', conversation: 'thread', cwd }) }) as never;
  const ctx = { service, catalogs: async () => [cat('codex')] } as HandlerContext;
  assert.equal((await callTool(ctx, 'spawn_job', { mode: 'review', provider: 'codex', prompt: 'review', cwd })).isError, undefined);
  assert.equal(seen[0]!.cwd, cwd);
  for (const invalid of ['relative', path.join(cwd, 'missing')]) {
    assert.equal((await callTool(ctx, 'spawn_job', { mode: 'review', provider: 'codex', prompt: 'review', cwd: invalid })).isError, true);
  }
  assert.match(text(await callTool(ctx, 'follow_up', { worker: 'Ada', prompt: 'continue', cwd })), /Unknown field cwd/);
  assert.equal(seen.length, 1, 'invalid cwd must not launch a worker');
});

test('spawn_job with no configured default: the only installed provider, else a short error', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-prov-'));
  const service = withWorkerLookup({ repo, spawnJob: async (req: Record<string, unknown>) => { seen.push(req); return { jobId: 'j' }; } });
  const one = await callTool({ service, catalogs: async () => [cat('kimi')] } as unknown as HandlerContext, 'spawn_job', { mode: 'review', prompt: 'x' });
  assert.equal(one.isError, undefined); assert.equal(seen[0]!.provider, 'kimi'); assert.equal(body(one).provider, 'kimi');
  const many = await callTool({ service, catalogs: async () => [cat('agy'), cat('codex')] } as unknown as HandlerContext, 'spawn_job', { mode: 'review', prompt: 'x' });
  assert.equal(many.isError, true); assert.match((many.content as { text: string }[])[0]!.text, /provider is required: installed are agy, codex\./);
  const none = await callTool({ service, catalogs: async () => [] } as unknown as HandlerContext, 'spawn_job', { mode: 'review', prompt: 'x' });
  assert.equal(none.isError, true); assert.match((none.content as { text: string }[])[0]!.text, /No coding agent installed/);
  assert.equal(seen.length, 1);
});

test('mode enum rejects unknown modes', async () => {
  const r = await callTool(ctxWith([cat('agy')]), 'spawn_job', { mode: 'task', prompt: 'x' });
  assert.equal(r.isError, true);
  assert.match((r.content as { text: string }[])[0]!.text, /mode must be one of implement, review, moderate, verify/);
});

test('list_capabilities reports catalogs, errors and modes without throwing', async () => {
  const r = body(await callTool(ctxWith([cat('codex'), cat('claude', { models: [], error: 'boom', defaultSource: 'unknown', defaultModel: undefined })]), 'list_capabilities', { response_format: 'detailed' }));
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
  assert.equal(by.steer?.destructiveHint, true, 'steer can interrupt a running turn');
  assert.equal(by.follow_up?.destructiveHint, undefined, 'follow_up never cuts a turn');
  for (const n of ['spawn_job', 'run_pipeline', 'follow_up', 'steer']) assert.deepEqual([by[n]?.readOnlyHint, by[n]?.openWorldHint], [false, true], n);
});

test('files is bounded in the schema, matching the service cap', () => {
  for (const name of ['spawn_job', 'follow_up', 'steer']) {
    const files = (TOOL_DEFS.find(t => t.name === name)!.inputSchema as any).properties.files;
    assert.equal(files?.maxItems, 32, name);
  }
});

test('default pipeline derives providers from installed catalogs', async () => {
  await assert.rejects(defaultMixedPipeline({ name: 'p', task: 't' }, async () => [cat('agy'), cat('codex')]), /^Error: pass stages with a provider each: installed are agy, codex\.$/);
  const one = await defaultMixedPipeline({ name: 'p', task: 't' }, async () => [cat('codex')]);
  assert.deepEqual(one.stages.map(s => s.provider), ['codex', 'codex', 'codex']);
  assert.equal(one.stages[0]!.model, 'codex-m'); assert.equal(one.stages[0]!.effort, 'high');
  await assert.rejects(defaultMixedPipeline({ name: 'p', task: 't' }, async () => []), /No coding agent installed: install one of agy, codex, opencode, claude, kimi\./);
});

test('run_pipeline stages accept continues, inherit its provider, and reject a bad spec before starting anything', async () => {
  const stageSchema = (TOOL_DEFS.find(t => t.name === 'run_pipeline')!.inputSchema as any).properties.spec.properties.stages.items;
  assert.ok(stageSchema.properties.continues);
  assert.deepEqual(stageSchema.required, ['name']);
  const ctx = ctxWith([cat('agy'), cat('codex')]);
  const run = (fix: Record<string, unknown>) => callTool(ctx, 'run_pipeline', { spec: { name: 'p', stages: [
    { name: 'build', provider: 'agy', prompt: 'b' }, { name: 'review', provider: 'codex', prompt: 'r', dependsOn: ['build'] },
    { name: 'fix', prompt: 'f', dependsOn: ['review'], ...fix }] } });
  const text = (r: { content: unknown }) => ((r.content as { text: string }[])[0]!).text;
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{}, /stage 'fix' needs a provider/],
    [{ continues: 'ghost' }, /continues 'ghost', which does not exist/],
    [{ continues: 'ghost', provider: 'agy' }, /continues 'ghost', which does not exist/],
    [{ continues: 'build', provider: 'codex' }, /cannot move between providers \(codex vs agy\)/],
    [{ continues: 'build', conversation: 'c' }, /also sets conversation/],
  ];
  for (const [fix, message] of cases) {
    const r = await run(fix);
    assert.equal(r.isError, true); assert.match(text(r), message);
  }
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
  const cats = ['codex'].map(provider => ({ provider, models: [], defaultSource: 'unknown', source: 'live', stale: false, verified: true }) as never);
  const def = await defaultMixedPipeline({ name: 'p', task: 't', modelConfig }, async () => cats);
  const review = def.stages.find(s => s.name === 'review')!;
  assert.deepEqual([review.provider, review.model, review.effort], ['codex', 'gpt-6.1-sol', 'high']);
  assert.equal(def.stages.find(s => s.name === 'implement')!.model, undefined);
});

test('spawn_job ack is slim: identity, budget, permissions and warnings only', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-ack-'));
  const full = { jobId: 'j9', name: 'Ada', workerId: 'j9', turn: 1, role: 'review', provider: 'codex', status: 'running', dir: `${repo}/.agent-smith/jobs/j9`, repo, timeoutMs: 1000,
    unrestricted: false, note: 'queued', sandbox: 'codex -s read-only', sandboxFlags: ['-s', 'read-only'], readOnlyRequested: true, readOnlyEnforced: true,
    modelRequested: null, modelResolved: 'gpt-x', modelSource: 'harness-config', preambleApplied: true };
  const service = { repo, spawnJob: async () => full } as never;
  const r = await callTool({ service, catalogs: async () => [cat('codex')] } as HandlerContext, 'spawn_job', { mode: 'review', prompt: 'x', provider: 'codex' });
  assert.equal(r.isError, undefined);
  assert.deepEqual(body(r), { jobId: 'j9', name: 'Ada', workerId: 'j9', turn: 1, provider: 'codex', model: 'gpt-x', status: 'running', timeoutMs: 1000, repo, unrestricted: false, readOnlyEnforced: true });
  assert.ok(text(r).length < 280, text(r));
});

test('an unrestricted review ack still says whether read-only is enforced', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-ack-'));
  const full = { jobId: 'j8', name: 'Bo', workerId: 'j8', role: 'review', provider: 'agy', status: 'running', repo, timeoutMs: 1000,
    unrestricted: true, readOnlyRequested: false, readOnlyEnforced: false, modelResolved: null };
  const service = { repo, spawnJob: async () => full } as never;
  const r = await callTool({ service, catalogs: async () => [cat('agy')] } as HandlerContext, 'spawn_job', { mode: 'review', prompt: 'x', provider: 'agy' });
  assert.equal(body(r).readOnlyEnforced, false);
});

test('cancel of a job it cannot read is not reported as settled', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-cancel-'));
  const service = withWorkerLookup({ repo, cancel: (id: string) => ({ jobId: id, requested: true, signalled: false, note: 'x' }), detail: async () => { throw new Error('gone'); } }) as never;
  const r = await callTool({ service, cancelSettleMs: 0 } as HandlerContext, 'cancel', { id: 'j1' });
  assert.deepEqual(body(r), { jobId: 'j1', status: 'unknown', settled: false });
});

test('cancel by worker name stops its head turn, claims that job (never the name), and reports discarded messages', async () => {
  const { existsSync } = await import('node:fs');
  const { claimMarkerPath } = await import('../../../mod/hooks/notice.ts');
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-cancel-name-'));
  const asked: string[] = [];
  const service = withWorkerLookup({
    repo,
    resolveWorker: async () => ({ jobId: 'implement-smith-2', status: 'running' }),
    cancel: (id: string) => { asked.push(id); return { jobId: 'implement-smith-2', resolvedFrom: id, requested: true, signalled: true, discarded: 1, warnings: ['1 queued message discarded: "add the edge-case test"'], note: 'Canceled.' }; },
    detail: async () => ({ jobId: 'implement-smith-2', workerId: 'implement-smith-1', status: 'canceled', warnings: [] }),
  }) as never;
  const r = await callTool({ service, cancelSettleMs: 1_000 } as HandlerContext, 'cancel', { id: 'Ada' });
  assert.deepEqual(asked, ['Ada'], 'the service resolves the name');
  assert.deepEqual(body(r), { jobId: 'implement-smith-2', workerId: 'implement-smith-1', resolvedFrom: 'Ada', status: 'canceled', settled: true, discarded: 1, warnings: ['1 queued message discarded: "add the edge-case test"'] });
  assert.ok(existsSync(claimMarkerPath(repo, 'job', 'implement-smith-2')));
  assert.equal(existsSync(claimMarkerPath(repo, 'job', 'Ada')), false);
});

test('concise status and list_jobs are compact JSON; detailed stays indented', async () => {
  const ctx = withService({ list: async () => [summary(1)], detail: async () => detail() });
  for (const [tool, args] of [['status', { id: 'implement-smith-1' }], ['list_jobs', {}]] as const) {
    assert.equal(text(await callTool(ctx, tool, args)).includes('\n'), false, tool);
    assert.equal(text(await callTool(ctx, tool, { ...args, response_format: 'detailed' })).includes('\n'), true, tool);
  }
});

const text = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
const LONG = 'The worker refactored the parser and then ran the full suite twice. '.repeat(20);
const summary = (i: number, extra: Record<string, unknown> = {}) => ({
  jobId: `implement-smith-${i}`, name: `w${i}`, workerId: `w${i}`, role: 'implement', latestSummary: LONG, summarySource: 'worker',
  status: 'succeeded', provider: 'agy', mode: 'implement', model: 'm', task: 't', toolCalls: 7, currentActivity: null,
  lastActivity: { stepIndex: 12, tool: 'Bash', input: 'npm test '.repeat(100), status: 'done' },
  startedAt: iso(60_000), updatedAt: iso(30_000), finishedAt: iso(30_000), warnings: [], nextAction: null, ...extra,
});
const detail = (extra: Record<string, unknown> = {}) => ({ ...summary(1), report: 'All done.', error: null, exitCode: 0, unrestricted: true, pipeline: null, stage: null,
  usage: { input: 1 }, conversation: 'c', effort: 'high', cwd: '/x', cancellable: false, ...extra });
const withService = (service: Record<string, unknown>) => ({ service: withWorkerLookup({ repo: mkdtempSync(path.join(tmpdir(), 'smith-views-')), ...service }) as never, catalogs: async () => [] }) as HandlerContext;

test('list_jobs: concise rows trim summaries on a word boundary and default to limit 20; detailed keeps the record and limit', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const ctx = withService({ list: async (f: Record<string, unknown>) => { seen.push(f); return [summary(1)]; } });
  const concise = await callTool(ctx, 'list_jobs', {});
  const row = body(concise)[0];
  assert.equal(seen[0]!.limit, 21);
  assert.ok(row.summary.length <= 160 && LONG.startsWith(row.summary.slice(0, -1)) && LONG[row.summary.length - 1] === ' ', row.summary);
  assert.equal('lastActivity' in row, false);
  assert.equal('latestSummary' in row, false);
  assert.deepEqual(concise.structuredContent, { items: body(concise) });
  const detailed = await callTool(ctx, 'list_jobs', { response_format: 'detailed' });
  assert.equal(seen[1]!.limit, undefined);
  assert.equal(body(detailed)[0].latestSummary, LONG);
  await callTool(ctx, 'list_jobs', { limit: 5 }); assert.equal(seen[2]!.limit, 6);
});

test('list_jobs: a concise list cut by its limit says so; an uncut one stays a plain list', async () => {
  const ctx = withService({ list: async (f: { limit: number }) => Array.from({ length: Math.min(f.limit, 3) }, (_, i) => summary(i)) });
  const cut = await callTool(ctx, 'list_jobs', { limit: 2 });
  assert.equal(body(cut).items.length, 2);
  assert.match(body(cut).more, /More than 2 jobs match; narrow with since, status or session/);
  assert.deepEqual(cut.structuredContent, body(cut));
  const whole = await callTool(ctx, 'list_jobs', { limit: 3 });
  assert.equal(body(whole).length, 3);
});

test('list_jobs: asks the service for one row per worker and keeps its rows and order', async () => {
  const seenFilter: Record<string, unknown>[] = [];
  const ctx = withService({
    list: async (f: Record<string, unknown>) => {
      seenFilter.push(f);
      return [
        summary(2, { workerId: 'w1', turn: 2, continuedFrom: 'implement-smith-1', continuationKind: 'steer' }),
        summary(4, { workerId: 'w2', turn: 3, continuedFrom: 'implement-smith-3', continuationKind: 'follow-up' }),
      ];
    },
  });
  const concise = body(await callTool(ctx, 'list_jobs', {}));
  assert.equal(seenFilter[0]!.groupByWorker, true);
  assert.deepEqual(concise.map((r: any) => [r.jobId, r.turn]), [['implement-smith-2', 2], ['implement-smith-4', 3]]);
  for (const r of concise) for (const k of ['workerId', 'continuedFrom', 'continuationKind', 'taskStatus']) assert.equal(k in r, false, k);
  const detailed = body(await callTool(ctx, 'list_jobs', { response_format: 'detailed' }));
  assert.deepEqual(detailed.map((r: any) => r.jobId), ['implement-smith-2', 'implement-smith-4']);
});

test('status names the id it resolved from when it answers with another turn', async () => {
  const ctx = withService({ detail: async () => detail() });
  assert.equal(body(await callTool(ctx, 'status', { id: 'w1' })).resolvedFrom, 'w1');
  assert.equal(body(await callTool(ctx, 'status', { id: 'w1', response_format: 'detailed' })).resolvedFrom, 'w1');
  assert.equal('resolvedFrom' in body(await callTool(ctx, 'status', { id: 'implement-smith-1' })), false);
});

test('a running job with no progress time reports liveness silent in list_jobs and status (no stalled alias)', async () => {
  const running = { status: 'running', finishedAt: null, updatedAt: null };
  const ctx = withService({ list: async () => [summary(1, running)], detail: async () => detail(running) });
  const listed = body(await callTool(ctx, 'list_jobs', {}))[0];
  assert.equal(listed.liveness.state, 'silent');
  assert.equal('stalled' in listed, false);
  const stConcise = body(await callTool(ctx, 'status', { id: 'implement-smith-1' }));
  assert.equal(stConcise.liveness.state, 'silent');
  assert.equal('stalled' in stConcise, false);
  const stDetailed = body(await callTool(ctx, 'status', { id: 'implement-smith-1', response_format: 'detailed' }));
  assert.equal(stDetailed.liveness.state, 'silent');
  assert.equal('stalled' in stDetailed, false);
  const done = withService({ list: async () => [summary(1, { updatedAt: null })] });
  const doneRow = body(await callTool(done, 'list_jobs', {}))[0];
  assert.equal('liveness' in doneRow, false);
  assert.equal('stalled' in doneRow, false);
});

test('list_jobs: a concise row carries digest and liveness when running, and acceptance and changedFileCount when settled', async () => {
  const digest = {
    phase: 'testing', filesRead: 3, searches: 0, edited: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
    editedCount: 6, commands: 2, testRuns: 1, lastTestFailed: false, repeat: { label: 'Bash npm test', count: 3 },
  };
  const ctx = withService({ list: async () => [
    summary(1, { status: 'running', finishedAt: null, updatedAt: iso(20 * 60_000), digest }),
    summary(2, {
      status: 'succeeded', changedFileCount: 2,
      acceptance: { state: 'rejected', checks: [{ name: 'tests', ok: false }, { name: 'lint', ok: true }] },
    }),
  ] });
  const [runningRow, settledRow] = body(await callTool(ctx, 'list_jobs', {}));
  assert.equal(runningRow.liveness.state, 'silent');
  assert.equal('stalled' in runningRow, false);
  assert.deepEqual(runningRow.digest, {
    phase: 'testing', filesRead: 3, edited: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'],
    editedCount: 6, testRuns: 1, repeat: { label: 'Bash npm test', count: 3 },
  });
  assert.equal(settledRow.changedFileCount, 2);
  assert.deepEqual(settledRow.acceptance, { state: 'rejected', passed: ['lint'], failed: ['tests'] });

  const quiet = body(await callTool(withService({ list: async () => [summary(3, {
    status: 'running', finishedAt: null, updatedAt: iso(30_000),
    acceptance: { state: 'unchecked', checks: [] },
    digest: { phase: 'starting', filesRead: 0, searches: 0, edited: [], editedCount: 0, commands: 0, testRuns: 0, lastTestFailed: false, repeat: null },
  })] }), 'list_jobs', {}))[0];
  assert.deepEqual(quiet.digest, { phase: 'starting' });
  assert.equal(quiet.liveness.state, 'active');
  for (const dropped of ['stalled', 'changedFileCount', 'acceptance']) assert.equal(dropped in quiet, false, dropped);
});

test('status: resolves any turn/worker to latest head and lists unified earlierTurns across steers and resumes oldest first', async () => {
  const turns: Record<string, Record<string, unknown>> = {
    'implement-smith-3': detail({ jobId: 'implement-smith-3', workerId: 'w-ada', turn: 3, continuedFrom: 'implement-smith-2', continuationKind: 'follow-up', chainStartedAt: iso(10_000), report: 'Third.' }),
    'implement-smith-2': detail({ jobId: 'implement-smith-2', workerId: 'w-ada', turn: 2, continuedFrom: 'implement-smith-1', continuationKind: 'steer', followedBy: 'implement-smith-3', report: 'Second.' }),
    'implement-smith-1': detail({ jobId: 'implement-smith-1', workerId: 'w-ada', turn: 1, supersededBy: 'implement-smith-2', report: LONG }),
  };
  const asked: string[] = [];
  const ctx = withService({
    resolveWorker: async (id: string) => { asked.push(id); return turns['implement-smith-3']; },
    earlierTurns: async (head: { jobId: string }) => (head.jobId === 'implement-smith-3' ? [turns['implement-smith-1'], turns['implement-smith-2']] : []),
    detail: async (id: string) => turns[id],
  });
  const st = body(await callTool(ctx, 'status', { id: 'w-ada' }));
  assert.deepEqual(asked, ['w-ada']);
  assert.equal(st.jobId, 'implement-smith-3'); assert.equal(st.turn, 3);
  assert.equal('continuedFrom' in st, false); assert.equal('continuationKind' in st, false);
  assert.equal(st.report, 'Third.');
  assert.deepEqual(st.earlierTurns.map((t: any) => [t.jobId, t.turn, t.status]), [
    ['implement-smith-1', 1, 'succeeded'],
    ['implement-smith-2', 2, 'succeeded'],
  ]);
  assert.ok(st.earlierTurns[0].summary.length <= 120 && st.earlierTurns[0].summary.endsWith('…'));
  assert.equal('report' in st.earlierTurns[0], false);
  assert.equal('reportPath' in st.earlierTurns[1], false);
  const full = body(await callTool(ctx, 'status', { id: 'w-ada', response_format: 'detailed' }));
  assert.equal(full.earlierTurns[0].report, LONG);
  assert.match(full.earlierTurns[1].reportPath, /implement-smith-2/);
  const plain = body(await callTool(withService({ detail: async () => detail() }), 'status', { id: 'implement-smith-1' }));
  assert.equal('earlierTurns' in plain, false);
});

test('list_jobs: since parses ISO and relative times; session restricts to jobs this process spawned', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const spawned = new Set(['implement-smith-1']);
  const ctx = withService({ spawnedIds: spawned, list: async (f: Record<string, unknown>) => { seen.push(f); return []; } });
  const before = Date.now();
  await callTool(ctx, 'list_jobs', { since: '2h', session: true });
  const after = Date.now();
  assert.ok((seen[0]!.sinceMs as number) >= before - 7_200_000 && (seen[0]!.sinceMs as number) <= after - 7_200_000);
  assert.equal(seen[0]!.ids, spawned);
  await callTool(ctx, 'list_jobs', { since: '2026-10-01T00:00:00Z' });
  assert.equal(seen[1]!.sinceMs, Date.parse('2026-10-01T00:00:00Z')); assert.equal(seen[1]!.ids, undefined);
  const bad = await callTool(ctx, 'list_jobs', { since: 'yesterday' });
  assert.equal(bad.isError, true); assert.match(text(bad), /ISO time or 30m, 2h, 1d/);
});

test('status: concise merges identity, verdicts, timing and one report; detailed is the full record', async () => {
  const d = detail({ changedFiles: ['a.ts', 'b.ts'], warnings: [{ code: 'x', message: 'careful' }, { code: 'y', message: 'careful' }], latestSummary: 'All done.' });
  const ctx = withService({ detail: async () => d });
  writeAcceptance(ctx.service.repo, 'implement-smith-1', { state: 'rejected', checks: [{ name: 'tests', ok: true }, { name: 'lint', ok: false }] } as never);
  const r = await callTool(ctx, 'status', { id: 'implement-smith-1' });
  const b = body(r);
  assert.deepEqual(b.acceptance, { state: 'rejected', passed: ['tests'], failed: ['lint'] });
  assert.equal(b.report, 'All done.'); assert.equal('latestSummary' in b, false); assert.equal('summary' in b, false, 'summary duplicating the report is dropped');
  assert.deepEqual(b.warnings, ['careful']);
  assert.equal(b.changedFileCount, 2); assert.deepEqual(b.changedFiles, ['a.ts', 'b.ts']);
  assert.ok(b.durationMs > 25_000 && b.durationMs < 35_000);
  for (const dropped of ['usage', 'conversation', 'cwd', 'exitCode', 'sandbox']) assert.equal(dropped in b, false, dropped);
  assert.deepEqual(r.structuredContent, b, 'structuredContent matches the text');
  console.log('concise status:', JSON.stringify(b, null, 2));
  const full = body(await callTool(ctx, 'status', { id: 'implement-smith-1', response_format: 'detailed' }));
  assert.equal(full.usage.input, 1); assert.equal(full.latestSummary, 'All done.'); assert.equal(full.reportTruncated, false); assert.equal(full.cwd, '/x');
});

test('status: concise report is bounded with an explicit truncation note; a distinct summary is kept', async () => {
  const ctx = withService({ detail: async () => detail({ report: 'x'.repeat(5_000), latestSummary: 'Different summary.' }) });
  const b = body(await callTool(ctx, 'status', { id: 'j' }));
  assert.equal(b.reportTruncated, true);
  assert.match(b.report, /\[truncated: 2000 of 5000 chars; use response_format: "detailed" for more\]$/);
  assert.ok(b.report.length < 2_150); assert.equal(b.summary, 'Different summary.');
  assert.equal(body(await callTool(ctx, 'status', { id: 'j', response_format: 'detailed' })).report.length, 5_000);
});

test('pipeline_status: concise drops observations and repeats; detailed is the raw record', async () => {
  const ctx = withService({});
  const cmd = 'node -e "' + 'x'.repeat(2_000) + '"';
  const record = { runId: 'r1', pipeline: 'p', status: 'failed', startedAt: 1_000, finishedAt: 6_000, stageResults: {
    implement: { stage: 'implement', jobId: 'j1', acceptance: 'failed', provider: 'agy', status: 'passed', startedAt: 1_000, finishedAt: 5_000, durationMs: 4_000, resultPath: '/out/a.md',
      outputTail: 'y'.repeat(900), observations: [1, 2, 3].map(i => ({ tool: 'Bash', target: cmd, status: 'error', error: cmd + i })),
      verification: { passed: false, verdicts: [{ passed: true, check: { name: 'build' } }, { passed: false, check: { name: 'tests', command: cmd } }] } },
    review: { stage: 'review', provider: 'codex', status: 'failed', startedAt: 5_000, finishedAt: 6_000, durationMs: 1_000, failure: { code: 'exit-1', message: 'boom' } } } };
  writePipelineRecord(ctx.service.repo, 'r1', record);
  const r = await callTool(ctx, 'pipeline_status', { runId: 'r1' });
  const b = body(r);
  assert.ok(text(r).length < 1_500, `concise is small: ${text(r).length}`);
  assert.deepEqual(b.stageResults.implement, { status: 'passed', acceptance: 'failed', durationMs: 4_000, jobId: 'j1', checks: { passed: ['build'], failed: ['tests'] }, artifact: '/out/a.md', outputTail: 'y'.repeat(500) });
  assert.equal(b.stageResults.review.failure, 'exit-1: boom'); assert.equal(b.durationMs, 5_000);
  assert.equal(text(r).includes('observations'), false);
  assert.deepEqual(body(await callTool(ctx, 'pipeline_status', { runId: 'r1', response_format: 'detailed' })), record);
});

test('pipeline_status: concise shows a running stage by job and start, and an unwritten artifact as a warning', async () => {
  const ctx = withService({});
  writePipelineRecord(ctx.service.repo, 'r2', { runId: 'r2', pipeline: 'p', status: 'running', startedAt: 1_000, finishedAt: null, stageResults: {
    implement: { stage: 'implement', jobId: 'j1', provider: 'agy', status: 'running', startedAt: 1_000, finishedAt: 1_000, durationMs: 0 },
    review: { stage: 'review', provider: 'codex', status: 'failed', startedAt: 1_000, finishedAt: 2_000, durationMs: 1_000, artifacts: [], warnings: ['review/result.md not found on disk; the stage wrote no artifact'] } } });
  const b = body(await callTool(ctx, 'pipeline_status', { runId: 'r2' }));
  assert.deepEqual(b.stageResults.implement, { status: 'running', startedAt: 1_000, provider: 'agy', jobId: 'j1' });
  assert.deepEqual(b.stageResults.review.warnings, ['review/result.md not found on disk; the stage wrote no artifact']);
});

function gitRepo(): { cwd: string; head: string } {
  const cwd = mkdtempSync(path.join(tmpdir(), 'smith-diff-'));
  const g = (...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(path.join(cwd, 'a.txt'), 'one\n'); g('add', '.'); g('commit', '-qm', 'base');
  return { cwd, head: g('rev-parse', 'HEAD') };
}

test('status include_diff: returns the diff of changedFiles against the baseline head, and lists untracked files', async () => {
  const { cwd, head } = gitRepo();
  writeFileSync(path.join(cwd, 'a.txt'), 'one\ntwo\n'); writeFileSync(path.join(cwd, 'new.txt'), 'n\n');
  const ctx = withService({ detail: async () => detail({ cwd, gitBaseline: { head, dirty: [] }, changedFiles: ['a.txt', 'new.txt'] }) });
  const b = body(await callTool(ctx, 'status', { id: 'j', include_diff: true }));
  assert.match(b.diff, /^diff --git a\/a\.txt b\/a\.txt[\s\S]*\+two/);
  assert.match(b.diffNote, /Untracked, not in diff.*new\.txt/);
  assert.equal('diff' in body(await callTool(ctx, 'status', { id: 'j' })), false, 'off by default');
  assert.equal(body(await callTool(ctx, 'status', { id: 'j', include_diff: true, response_format: 'detailed' })).diff, b.diff);
});

test('status include_diff: flags changed files that were already dirty at spawn', async () => {
  const { cwd, head } = gitRepo();
  writeFileSync(path.join(cwd, 'a.txt'), 'one\nmine\njob\n');
  const ctx = withService({ detail: async () => detail({ cwd, gitBaseline: { head, dirty: ['a.txt'] }, changedFiles: ['a.txt'] }) });
  assert.match(body(await callTool(ctx, 'status', { id: 'j', include_diff: true })).diffNote, /Dirty before the job.*a\.txt/);
});

test('status include_diff: bounded at 40000 chars on a line boundary, with a note saying how to see the rest', async () => {
  const { cwd, head } = gitRepo();
  writeFileSync(path.join(cwd, 'a.txt'), Array.from({ length: 6_000 }, (_, i) => `line ${i}`).join('\n') + '\n');
  const ctx = withService({ detail: async () => detail({ cwd, gitBaseline: { head, dirty: [] }, changedFiles: ['a.txt'] }) });
  const b = body(await callTool(ctx, 'status', { id: 'j', include_diff: true }));
  assert.ok(b.diff.length <= 40_000 && b.diff.endsWith('\n'));
  assert.ok(b.diffNote.includes(`Diff cut at 40000 chars. Rest: git diff ${head} -- <file>`), b.diffNote);
});

test('status include_diff: says so without a baseline, while running, or with no changes, instead of failing', async () => {
  const none = await callTool(withService({ detail: async () => detail({ changedFiles: ['a'] }) }), 'status', { id: 'j', include_diff: true });
  assert.equal(none.isError, undefined); assert.equal(body(none).diff, null);
  assert.match(body(none).diffNote, /No diff: no git commit at spawn/);
  const running = body(await callTool(withService({ detail: async () => detail({ status: 'running', gitBaseline: { head: 'abc', dirty: [] }, cwd: '/x' }) }), 'status', { id: 'j', include_diff: true }));
  assert.match(running.diffNote, /No diff yet/);
  const { cwd, head } = gitRepo();
  const empty = body(await callTool(withService({ detail: async () => detail({ cwd, gitBaseline: { head, dirty: [] }, changedFiles: [] }) }), 'status', { id: 'j', include_diff: true }));
  assert.equal(empty.diff, ''); assert.match(empty.diffNote, /No files changed/);
});

test('tool failures are isError results that say what to do next', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'smith-err-'));
  let current: Record<string, unknown> = {};
  const service = withWorkerLookup({ repo: cwd, detail: async (id: string) => { if (id === 'Ada' || id === 'ghost') throw new Error('no job'); return current; },
    list: async () => [summary(1, { name: 'Ada', workerId: 'a1' }), summary(2, { name: 'Ada', workerId: 'a2' }), summary(3, { name: 'Bob' })] }) as never;
  const ctx = { service, catalogs: async () => [cat('codex')] } as HandlerContext;
  const fail = async (tool: string, args: Record<string, unknown>, expected: RegExp) => {
    const r = await callTool(ctx, tool, args); assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)}`); assert.match(text(r), expected); assert.ok(text(r).length < 200, text(r));
  };
  await fail('spawn_job', { mode: 'review', prompt: 'x', cwd: 'rel' }, /absolute path/);
  await fail('spawn_job', { mode: 'review', prompt: 'x', cwd: path.join(cwd, 'nope') }, /is not a directory/);
  await fail('follow_up', { worker: 'ghost', prompt: 'x', model: 'm' }, /No worker "ghost"; see list_jobs/);
  await fail('follow_up', { worker: 'Ada', prompt: 'x', model: 'm' }, /matches 2 workers; pass a jobId/);
  for (const tool of ['follow_up', 'steer']) {
    await fail(tool, { prompt: 'x' }, /worker is required/);
    await fail(tool, { worker: 'Ada' }, /prompt is required/);
  }
  await fail('steer', { worker: 'Ada', prompt: 'x', delivery: 'queue' }, /Unknown field delivery/);
  await fail('follow_up', { worker: 'Ada', prompt: 'x', checks: 'npm test' }, /checks must be an array/);
  await fail('status', {}, /id is required: a worker name or job ID/);
  await fail('cancel', {}, /id is required/);
  await fail('pipeline_status', { runId: 'nope' }, /No pipeline run "nope"/);
  await fail('pipeline_status', {}, /runId is required/);
  await fail('status', { id: 'j', bogus: 1 }, /Unknown field bogus; valid fields: id, wait_ms, include_diff, response_format/);
  await fail('nope', {}, /Unknown tool nope; available: list_capabilities/);
});

test('a failed job preparation never leaves checks pending', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'smith-prepare-fail-'));
  const service = { repo, spawnTracked: async (request: { onPrepared: (id: string) => void }) => {
    request.onPrepared('job-prep');
    throw new Error('unreachable');
  } } as never;
  const ctx = { service, catalogs: async () => [cat('codex')],
    onJobPrepared: () => { throw new Error('Task store capacity reached'); } } as HandlerContext;
  const result = await callTool(ctx, 'spawn_job', { mode: 'review', provider: 'codex', prompt: 'review', checks: [{ name: 'tests', command: 'true' }] });
  assert.equal(result.isError, true);
  const acceptance = readAcceptance(repo, 'job-prep');
  assert.equal('pending' in acceptance && acceptance.pending, false);
});

const ROUTES = ['console-google', 'google', 'opencode', 'opencode-go'];
const NAMES = ['gemini-4-argon', 'gemini-embedding-2', 'gemini-2.5-flash-preview-tts', 'gemini-3.1-flash-image', 'veo-3.1-generate-preview',
  'lyria-3-pro-preview', 'gemini-3.1-flash-live-preview', 'gemini-2.5-computer-use-preview-10-2025', 'deep-research-preview-04-2026',
  ...Array.from({ length: 30 }, (_, i) => `coder-${i}`)];
const opencode = cat('opencode', { defaultModel: undefined, defaultSource: 'unknown', verified: false,
  models: ROUTES.flatMap(route => NAMES.map(name => ({ id: `${route}/${name}`, label: `${route}/${name}`, efforts: [] }))) });
const codex = cat('codex', { models: [
  { id: 'sol', label: 'Sol', efforts: ['low', 'high'], defaultEffort: 'high' },
  { id: 'luna', label: 'Luna', efforts: ['low', 'high'], defaultEffort: 'low' },
  { id: 'mini', label: 'Mini', efforts: ['low'], defaultEffort: 'low' },
] });

test('concise list_capabilities drops non-coding models and repeated defaults, preserving exact route IDs', async () => {
  const ctx = ctxWith([codex, opencode]);
  const r = await callTool(ctx, 'list_capabilities', {});
  const text = (r.content as { text: string }[])[0]!.text;
  assert.equal(text.includes('\n'), false, 'concise text is unindented');
  const caps = JSON.parse(text);
  assert.equal(caps.modes, undefined); assert.equal(caps.efforts, undefined); assert.equal(caps.aliases, undefined);

  const cx = caps.providers.find((p: any) => p.name === 'codex');
  assert.deepEqual(cx.efforts, ['low', 'high'], 'the shared effort list is stated once');
  assert.deepEqual(cx.models, [{ id: 'sol' }, { id: 'luna', defaultEffort: 'low' }, { id: 'mini', efforts: ['low'], defaultEffort: 'low' }]);
  assert.equal(cx.stale, undefined); assert.equal(cx.verified, undefined); assert.equal(cx.defaultSource, undefined);

  const oc = caps.providers.find((p: any) => p.name === 'opencode');
  assert.equal(oc.models, undefined, 'over the cap: a count, not a list');
  assert.equal(oc.modelCount, 124); assert.match(oc.more, /provider: "opencode"/); assert.equal(typeof oc.unverified, 'string');
  assert.equal(oc.defaultModel, undefined);
  assert.equal(caps.providers.find((p: any) => p.name === 'agy').models, undefined, 'uninstalled providers carry no models');
  assert.ok(text.length < 1_500, `concise output stays small (${text.length} chars)`);
});

test('naming a provider lists every exact coding model route', async () => {
  const caps = body(await callTool(ctxWith([codex, opencode]), 'list_capabilities', { provider: 'opencode' }));
  assert.deepEqual(caps.providers.map((p: any) => p.name), ['opencode']);
  const models = caps.providers[0].models;
  assert.equal(models.length, 124);
  for (const route of ROUTES) assert.ok(models.some((m: any) => m.id === `${route}/gemini-4-argon`));
  assert.ok(models.every((m: any) => m.via === undefined));
  for (const dropped of ['embedding', 'tts', 'image', 'veo', 'lyria', 'live', 'computer-use', 'deep-research']) {
    assert.equal(models.some((m: any) => m.id.includes(dropped)), false, dropped);
  }
});

test('detailed list_capabilities keeps every discovered model, label, mode and the efforts text', async () => {
  const caps = body(await callTool(ctxWith([codex, opencode]), 'list_capabilities', { response_format: 'detailed' }));
  assert.equal(caps.providers.find((p: any) => p.name === 'opencode').models.length, ROUTES.length * NAMES.length);
  assert.equal(caps.providers.find((p: any) => p.name === 'codex').models[0].label, 'Sol');
  assert.deepEqual(caps.modes.map((m: any) => m.name), ['implement', 'review', 'moderate', 'verify']);
  assert.equal(typeof caps.efforts, 'string');
});

test('status: a failed job carries a short reason (derived from old errors, stored ones pass through) and warnings do not repeat the error', async () => {
  const longError = 'agy soft-denied 2 tool action(s) (run_command, RunCommand). agy exited with an empty response.';
  const old = body(await callTool(withService({ detail: async () => detail({ status: 'failed', error: longError, warnings: [{ code: 'x', message: longError }, { code: 'y', message: 'other note' }] }) }), 'status', { id: 'j' }));
  assert.match(old.reason, /^denied/);
  assert.ok(old.reason.length < 40);
  assert.equal(old.error, longError);
  assert.deepEqual(old.warnings, ['other note']);
  const fresh = body(await callTool(withService({ detail: async () => detail({ status: 'failed', error: longError, reason: 'exit 1' }) }), 'status', { id: 'j' }));
  assert.equal(fresh.reason, 'exit 1');
  const ok = body(await callTool(withService({ detail: async () => detail() }), 'status', { id: 'j' }));
  assert.equal(ok.reason, undefined);
});

const messageAck = (extra: Record<string, unknown> = {}) => ({
  jobId: 'implement-smith-1', name: 'Ada', workerId: 'w-ada', turn: 1, action: 'queued', delivery: 'turn-end', status: 'running',
  provider: 'codex', repo: '/tmp/r', timeoutMs: 60_000, pendingMessages: 1, note: 'Queued; runs when this turn ends.', ...extra,
});

test('follow_up forwards the message and its next-turn settings to the service and returns its ack compact', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const ctx = withService({
    followUp: async (req: Record<string, unknown>) => { seen.push(req); return messageAck(); },
    detail: async () => detail({ name: 'Ada', provider: 'codex', status: 'running' }),
  });
  const res = await callTool(ctx, 'follow_up', {
    worker: 'Ada', prompt: 'Add the edge-case test.', context: 'Review found it.', files: ['brief.md'],
    checks: [{ name: 'unit', command: 'npm test' }], timeoutMs: 120_000, env: { CARGO_TARGET_DIR: '/tmp/t' },
  });
  assert.equal(res.isError, undefined, text(res));
  assert.deepEqual(seen[0], {
    worker: 'Ada', prompt: 'Add the edge-case test.', context: 'Review found it.', files: ['brief.md'],
    checks: [{ name: 'unit', command: 'npm test', cwd: undefined, timeoutMs: undefined, blocking: undefined }],
    model: undefined, effort: undefined, timeoutMs: 120_000, env: { CARGO_TARGET_DIR: '/tmp/t' }, unrestricted: undefined,
  });
  assert.deepEqual(body(res), messageAck());
  assert.equal(text(res).includes('\n'), false, 'the ack is compact');
  assert.deepEqual(res.structuredContent, body(res));
});

test('follow_up expands a model alias for the worker\'s provider before it reaches the service', async () => {
  const { mkdirSync } = await import('node:fs');
  const seen: Array<Record<string, unknown>> = [];
  const ctx = withService({
    followUp: async (req: Record<string, unknown>) => { seen.push(req); return messageAck({ action: 'started', delivery: 'now', jobId: 'implement-smith-2', turn: 2 }); },
    detail: async () => detail({ name: 'Ada', provider: 'codex' }),
  });
  mkdirSync(path.join(ctx.service.repo, '.agent-smith'));
  writeFileSync(path.join(ctx.service.repo, '.agent-smith', 'models.json'), JSON.stringify({ aliases: { 'sol-high': { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' } } }));
  const res = await callTool(ctx, 'follow_up', { worker: 'Ada', prompt: 'Next.', model: 'sol-high' });
  assert.equal(res.isError, undefined, text(res));
  assert.deepEqual([seen[0]!.model, seen[0]!.effort], ['gpt-6.1-sol', 'high']);
  assert.deepEqual([body(res).action, body(res).delivery, body(res).jobId], ['started', 'now', 'implement-smith-2']);
});

test('steer forwards worker, prompt, context, files and allowFresh, and passes service errors through', async () => {
  const seen: Array<Record<string, unknown>> = [];
  let fail: Error | null = null;
  const ctx = withService({
    steer: async (req: Record<string, unknown>) => { seen.push(req); if (fail) throw fail; return messageAck({ action: 'interrupting', delivery: 'now', note: 'Interrupting; the steered turn starts next.' }); },
  });
  const res = await callTool(ctx, 'steer', { worker: 'Ada', prompt: 'Pivot to the profile menu.', context: 'Sidebar dropped.', files: ['brief.md'], allowFresh: true });
  assert.equal(res.isError, undefined, text(res));
  assert.deepEqual(seen[0], { worker: 'Ada', prompt: 'Pivot to the profile menu.', context: 'Sidebar dropped.', files: ['brief.md'], allowFresh: true });
  assert.equal(body(res).action, 'interrupting');
  await callTool(ctx, 'steer', { worker: 'Ada', prompt: 'x' });
  assert.equal('allowFresh' in seen[1]!, false, 'allowFresh is sent only when passed');
  fail = new Error('"Ada" (implement-smith-1) has no saved conversation; spawn_job with from:"Ada" starts it fresh with the original brief.');
  const err = await callTool(ctx, 'steer', { worker: 'Ada', prompt: 'x' });
  assert.equal(err.isError, true);
  assert.equal(text(err), fail.message);
});

test('status wait_ms on a worker waits until it is idle; on a job ID only until that turn settles', async () => {
  let head = detail({ jobId: 'implement-smith-1', workerId: 'w-ada', status: 'succeeded', pendingSteers: 1 });
  const turn1 = head;
  const ctx = { ...withService({
    resolveWorker: async (id: string) => (id === 'implement-smith-1' ? turn1 : head),
    resolveTurn: (id: string) => id,
  }), pollMs: 5 } as HandlerContext;
  setTimeout(() => { head = detail({ jobId: 'implement-smith-2', workerId: 'w-ada', turn: 2, status: 'succeeded' }); }, 60);
  const byJob = body(await callTool(ctx, 'status', { id: 'implement-smith-1', wait_ms: 2_000 }));
  assert.deepEqual([byJob.jobId, byJob.stillRunning], ['implement-smith-1', false], 'a jobId settles with its own turn');
  const started = Date.now();
  head = turn1;
  setTimeout(() => { head = detail({ jobId: 'implement-smith-2', workerId: 'w-ada', turn: 2, status: 'succeeded' }); }, 60);
  const byWorker = body(await callTool(ctx, 'status', { id: 'w-ada', wait_ms: 2_000 }));
  assert.ok(Date.now() - started >= 50, 'did not return while a follow-up was queued');
  assert.deepEqual([byWorker.jobId, byWorker.turn, byWorker.stillRunning], ['implement-smith-2', 2, false]);
});
