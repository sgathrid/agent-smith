import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOL_DEFS, callTool, defaultMixedPipeline, type HandlerContext } from '../tools.ts';
import { readAcceptance, writeAcceptance } from '../../../../forge/checks.ts';
import { writePipelineRecord } from '../../../../forge/service.ts';
import type { ModelCatalog } from '../../../../providers/types.ts';

const cat = (provider: string, extra: Partial<ModelCatalog> = {}): ModelCatalog => ({
  provider, models: [{ id: `${provider}-m`, label: provider, efforts: ['low', 'high'], defaultEffort: 'low' }],
  defaultModel: `${provider}-m`, defaultEffort: 'high', defaultSource: 'harness-config', source: 'static', stale: false, verified: true, ...extra,
});
const ctxWith = (cats: ModelCatalog[]) => ({ service: { repo: mkdtempSync(path.join(tmpdir(), 'agent-smith-tools-')) } as never, catalogs: async () => cats }) as HandlerContext;
const body = (r: { content: unknown }) => JSON.parse(((r.content as { text: string }[])[0]!).text);

test('spawn and resume validate and forward absolute working directories', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'smith-cwd-store-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'smith-cwd-work-'));
  const seen: Array<Record<string, unknown>> = [];
  const service = { repo, spawnJob: async (request: Record<string, unknown>) => {
    seen.push(request); return { jobId: 'job-cwd' };
  }, detail: async () => ({ status: 'succeeded', provider: 'codex', mode: 'review',
    name: 'Ada', workerId: 'Ada', conversation: 'thread', cwd }) } as never;
  const ctx = { service, catalogs: async () => [cat('codex')] } as HandlerContext;
  assert.equal((await callTool(ctx, 'spawn_job', { mode: 'review', provider: 'codex', prompt: 'review', cwd })).isError, undefined);
  assert.equal(seen[0]!.cwd, cwd);
  assert.equal((await callTool(ctx, 'resume_job', { worker: 'Ada', prompt: 'continue' })).isError, undefined);
  assert.equal(seen[1]!.cwd, cwd);
  assert.equal((await callTool(ctx, 'resume_job', { worker: 'Ada', prompt: 'continue', cwd: repo })).isError, undefined);
  assert.equal(seen[2]!.cwd, repo);
  for (const invalid of ['relative', path.join(cwd, 'missing')]) {
    for (const tool of ['spawn_job', 'resume_job']) {
      const args = tool === 'spawn_job' ? { mode: 'review', provider: 'codex', prompt: 'review' } : { worker: 'Ada', prompt: 'continue' };
      assert.equal((await callTool(ctx, tool, { ...args, cwd: invalid })).isError, true);
    }
  }
  assert.equal(seen.length, 3, 'invalid cwd must not launch a worker');
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
  const cats = ['agy', 'codex', 'claude'].map(provider => ({ provider, models: [], defaultSource: 'unknown', source: 'live', stale: false, verified: true }) as never);
  const def = await defaultMixedPipeline({ name: 'p', task: 't', modelConfig }, async () => cats);
  const review = def.stages.find(s => s.name === 'review')!;
  assert.deepEqual([review.provider, review.model, review.effort], ['codex', 'gpt-6.1-sol', 'high']);
  assert.equal(def.stages.find(s => s.name === 'implement')!.model, undefined);
});

test('notifyHint: hook note always, monitorCommand only when the built monitor path is known, timeout capped', async () => {
  const { builtMonitorPath, notifyHint } = await import('../tools.ts');
  assert.equal(builtMonitorPath('/repo/the-codes/surfaces/channel/src/tools.ts'), undefined);
  assert.equal(builtMonitorPath('/repo/the-codes/surfaces/channel/dist/surfaces/channel/src/tools.js'), '/repo/the-codes/surfaces/channel/dist/monitor.js');
  assert.equal(builtMonitorPath('/plugin/runtime/dist/server.js'), '/plugin/runtime/dist/monitor.js');
  const none = notifyHint({ job: 'j1' }, '/repo', 60_000, undefined);
  assert.equal(none.mode, 'hook');
  assert.match(none.note, /announced automatically by the plugin/);
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

// ── concise responses, diff on demand, recoverable errors ────────────────────
const text = (r: { content: unknown }) => (r.content as { text: string }[])[0]!.text;
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
const LONG = 'The worker refactored the parser and then ran the full suite twice. '.repeat(20);
const summary = (i: number, extra: Record<string, unknown> = {}) => ({
  jobId: `implement-smith-${i}`, name: `w${i}`, workerId: `w${i}`, role: 'implement', latestSummary: LONG, summarySource: 'worker', source: 'agent-smith',
  status: 'succeeded', provider: 'agy', mode: 'implement', model: 'm', task: 't', toolCalls: 7, currentActivity: null,
  lastActivity: { stepIndex: 12, tool: 'Bash', input: 'npm test '.repeat(100), status: 'done' },
  startedAt: iso(60_000), updatedAt: iso(30_000), finishedAt: iso(30_000), warnings: [], nextAction: null, ...extra,
});
const detail = (extra: Record<string, unknown> = {}) => ({ ...summary(1), report: 'All done.', error: null, exitCode: 0, unrestricted: true, pipeline: null, stage: null,
  usage: { input: 1 }, conversation: 'c', effort: 'high', cwd: '/x', cancellable: false, ...extra });
const withService = (service: Record<string, unknown>) => ({ service: { repo: mkdtempSync(path.join(tmpdir(), 'smith-views-')), ...service } as never, catalogs: async () => [] }) as HandlerContext;

test('list_jobs: concise rows trim summaries on a word boundary and default to limit 20; detailed keeps the record and limit', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const ctx = withService({ list: async (f: Record<string, unknown>) => { seen.push(f); return [summary(1)]; } });
  const concise = await callTool(ctx, 'list_jobs', {});
  const row = body(concise)[0];
  assert.equal(seen[0]!.limit, 21); // one extra row detects a cut list
  assert.ok(row.summary.length <= 200 && LONG.startsWith(row.summary.slice(0, -1)) && LONG[row.summary.length - 1] === ' ', row.summary);
  assert.match(row.lastActivity, /^step 12: Bash npm test .*\(done\)$/); assert.ok(row.lastActivity.length < 120);
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

test('list_jobs: since parses ISO and relative times; session restricts to jobs this process spawned', async () => {
  const seen: Array<Record<string, unknown>> = [];
  const spawned = new Set(['implement-smith-1']);
  const ctx = withService({ spawnedIds: spawned, list: async (f: Record<string, unknown>) => { seen.push(f); return []; } });
  const before = Date.now();
  await callTool(ctx, 'list_jobs', { since: '2h', session: true });
  assert.ok(Math.abs((seen[0]!.sinceMs as number) - (before - 7_200_000)) < 5_000);
  assert.equal(seen[0]!.ids, spawned);
  await callTool(ctx, 'list_jobs', { since: '2026-10-01T00:00:00Z' });
  assert.equal(seen[1]!.sinceMs, Date.parse('2026-10-01T00:00:00Z')); assert.equal(seen[1]!.ids, undefined);
  const bad = await callTool(ctx, 'list_jobs', { since: 'yesterday' });
  assert.equal(bad.isError, true); assert.match(text(bad), /ISO time.*relative like 30m, 2h, 1d/);
});

test('status: concise merges identity, verdicts, timing and one report; detailed is the full record', async () => {
  const d = detail({ changedFiles: ['a.ts', 'b.ts'], warnings: [{ code: 'x', message: 'careful' }, { code: 'y', message: 'careful' }], latestSummary: 'All done.' });
  const ctx = withService({ detail: async () => d });
  writeAcceptance(ctx.service.repo, 'implement-smith-1', { state: 'rejected', checks: [{ name: 'tests', ok: true }, { name: 'lint', ok: false }] } as never);
  const r = await callTool(ctx, 'status', { jobId: 'implement-smith-1' });
  const b = body(r);
  assert.deepEqual(b.acceptance, { state: 'rejected', passed: ['tests'], failed: ['lint'] });
  assert.equal(b.report, 'All done.'); assert.equal('latestSummary' in b, false); assert.equal('summary' in b, false, 'summary duplicating the report is dropped');
  assert.deepEqual(b.warnings, ['careful']);
  assert.equal(b.changedFileCount, 2); assert.deepEqual(b.changedFiles, ['a.ts', 'b.ts']);
  assert.ok(b.durationMs > 25_000 && b.durationMs < 35_000);
  for (const dropped of ['usage', 'conversation', 'cwd', 'exitCode', 'sandbox']) assert.equal(dropped in b, false, dropped);
  assert.deepEqual(r.structuredContent, b, 'structuredContent matches the text');
  console.log('concise status:', JSON.stringify(b, null, 2));
  const full = body(await callTool(ctx, 'status', { jobId: 'implement-smith-1', response_format: 'detailed' }));
  assert.equal(full.usage.input, 1); assert.equal(full.latestSummary, 'All done.'); assert.equal(full.reportTruncated, false); assert.equal(full.cwd, '/x');
});

test('status: concise report is bounded with an explicit truncation note; a distinct summary is kept', async () => {
  const ctx = withService({ detail: async () => detail({ report: 'x'.repeat(5_000), latestSummary: 'Different summary.' }) });
  const b = body(await callTool(ctx, 'status', { jobId: 'j' }));
  assert.equal(b.reportTruncated, true);
  assert.match(b.report, /\[truncated: 2000 of 5000 chars; use response_format: "detailed" for more\]$/);
  assert.ok(b.report.length < 2_150); assert.equal(b.summary, 'Different summary.');
  assert.equal(body(await callTool(ctx, 'status', { jobId: 'j', response_format: 'detailed' })).report.length, 5_000);
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
  const b = body(await callTool(ctx, 'status', { jobId: 'j', include_diff: true }));
  assert.match(b.diff, /^diff --git a\/a\.txt b\/a\.txt[\s\S]*\+two/);
  assert.match(b.diffNote, /untracked files not shown.*new\.txt/);
  assert.equal('diff' in body(await callTool(ctx, 'status', { jobId: 'j' })), false, 'off by default');
  assert.equal(body(await callTool(ctx, 'status', { jobId: 'j', include_diff: true, response_format: 'detailed' })).diff, b.diff);
});

test('status include_diff: flags changed files that were already dirty at spawn', async () => {
  const { cwd, head } = gitRepo();
  writeFileSync(path.join(cwd, 'a.txt'), 'one\nmine\njob\n');
  const ctx = withService({ detail: async () => detail({ cwd, gitBaseline: { head, dirty: ['a.txt'] }, changedFiles: ['a.txt'] }) });
  assert.match(body(await callTool(ctx, 'status', { jobId: 'j', include_diff: true })).diffNote, /Already uncommitted when the job started.*a\.txt/);
});

test('status include_diff: bounded at 40000 chars on a line boundary, with a note saying how to see the rest', async () => {
  const { cwd, head } = gitRepo();
  writeFileSync(path.join(cwd, 'a.txt'), Array.from({ length: 6_000 }, (_, i) => `line ${i}`).join('\n') + '\n');
  const ctx = withService({ detail: async () => detail({ cwd, gitBaseline: { head, dirty: [] }, changedFiles: ['a.txt'] }) });
  const b = body(await callTool(ctx, 'status', { jobId: 'j', include_diff: true }));
  assert.ok(b.diff.length <= 40_000 && b.diff.endsWith('\n'));
  assert.ok(b.diffNote.includes(`Diff truncated at 40000 chars. See the rest with: git diff ${head} -- <file>`), b.diffNote);
});

test('status include_diff: says so without a baseline, while running, or with no changes, instead of failing', async () => {
  const none = await callTool(withService({ detail: async () => detail({ changedFiles: ['a'] }) }), 'status', { jobId: 'j', include_diff: true });
  assert.equal(none.isError, undefined); assert.equal(body(none).diff, null);
  assert.match(body(none).diffNote, /No git baseline was recorded/);
  const running = body(await callTool(withService({ detail: async () => detail({ status: 'running', gitBaseline: { head: 'abc', dirty: [] }, cwd: '/x' }) }), 'status', { jobId: 'j', include_diff: true }));
  assert.match(running.diffNote, /computed when the job finishes/);
  const { cwd, head } = gitRepo();
  const empty = body(await callTool(withService({ detail: async () => detail({ cwd, gitBaseline: { head, dirty: [] }, changedFiles: [] }) }), 'status', { jobId: 'j', include_diff: true }));
  assert.equal(empty.diff, ''); assert.match(empty.diffNote, /changed no files/);
});

test('tool failures are isError results that say what to do next', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'smith-err-'));
  let current: Record<string, unknown> = {};
  const service = { repo: cwd, detail: async (id: string) => { if (id === 'Ada' || id === 'ghost') throw new Error('no job'); return current; },
    list: async () => [summary(1, { name: 'Ada', workerId: 'a1' }), summary(2, { name: 'Ada', workerId: 'a2' }), summary(3, { name: 'Bob' })] } as never;
  const ctx = { service, catalogs: async () => [cat('codex')] } as HandlerContext;
  const fail = async (tool: string, args: Record<string, unknown>, expected: RegExp) => {
    const r = await callTool(ctx, tool, args); assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)}`); assert.match(text(r), expected); assert.ok(text(r).length < 200, text(r));
  };
  await fail('spawn_job', { mode: 'review', prompt: 'x', cwd: 'rel' }, /absolute path.*omit cwd/);
  await fail('spawn_job', { mode: 'review', prompt: 'x', cwd: path.join(cwd, 'nope') }, /does not exist.*omit cwd/);
  await fail('resume_job', { worker: 'ghost', prompt: 'x' }, /No worker named "ghost"; call list_jobs/);
  await fail('resume_job', { worker: 'Ada', prompt: 'x' }, /matches 2 different workers; pass one job ID from list_jobs/);
  current = detail({ name: 'Ada', status: 'running' });
  await fail('resume_job', { worker: 'job-1', prompt: 'x' }, /^Worker "Ada" is still running; wait for its completion notice or call cancel\.$/);
  current = detail({ name: 'Ada', conversation: null });
  await fail('resume_job', { worker: 'job-1', prompt: 'x' }, /no resumable conversation.*spawn_job/);
  await fail('status', {}, /jobId is required: get one from spawn_job or list_jobs/);
  await fail('cancel', {}, /jobId is required/);
  await fail('pipeline_status', { runId: 'nope' }, /No pipeline run "nope"; use the runId returned by run_pipeline/);
  await fail('pipeline_status', {}, /runId is required/);
  await fail('status', { jobId: 'j', bogus: 1 }, /Unknown field bogus; valid fields: jobId, wait_ms, include_diff, response_format/);
  await fail('nope', {}, /Unknown tool nope; available: list_capabilities/);
});

test('a failed job preparation never leaves checks pending', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'smith-prepare-fail-'));
  // Like ForgeService: onPrepared throws, the job is aborted and the error rethrown.
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

test('concise list_capabilities drops non-coding models, duplicate routes and repeated defaults', async () => {
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
  assert.equal(oc.modelCount, 31); assert.match(oc.more, /provider: "opencode"/); assert.equal(typeof oc.unverified, 'string');
  assert.equal(oc.defaultModel, undefined);
  assert.equal(caps.providers.find((p: any) => p.name === 'agy').models, undefined, 'uninstalled providers carry no models');
  assert.ok(text.length < 1_500, `concise output stays small (${text.length} chars)`);
});

test('naming a provider lists all its coding models, preferring the opencode route', async () => {
  const caps = body(await callTool(ctxWith([codex, opencode]), 'list_capabilities', { provider: 'opencode' }));
  assert.deepEqual(caps.providers.map((p: any) => p.name), ['opencode']);
  const models = caps.providers[0].models;
  assert.equal(models.length, 31);
  assert.deepEqual(models[0], { id: 'opencode/gemini-4-argon', via: ['console-google', 'google', 'opencode-go'] });
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
