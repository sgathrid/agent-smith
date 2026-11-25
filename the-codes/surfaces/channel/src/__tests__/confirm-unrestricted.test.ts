import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientCapabilities, ElicitResult } from '@modelcontextprotocol/server';
import { DECLINED_UNRESTRICTED, TOOL_DEFS, UNCONFIRMED_UNRESTRICTED, callTool, type HandlerContext } from '../tools.ts';
import { withWorkerLookup } from './service-mock.ts';
import { ForgeService } from '../../../../forge/service.ts';
import { FILES, jobFile } from '../../../../forge/format.ts';

delete process.env.AGENT_SMITH_CONFIRM_UNRESTRICTED;
const FORM: ClientCapabilities = { elicitation: { form: {} } };
const body = (r: { content: unknown }) => JSON.parse(((r.content as { text: string }[])[0]!).text);
const text = (r: { content: unknown }) => ((r.content as { text: string }[])[0]!).text;

function harness(opts: { caps?: ClientCapabilities; action?: ElicitResult['action'] | 'throw'; server?: boolean } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'smith-confirm-'));
  const spawned: Array<Record<string, unknown>> = []; const asked: string[] = [];
  const service = withWorkerLookup({
    repo,
    spawnJob: async (r: Record<string, unknown>) => { spawned.push(r); return { jobId: `job-${spawned.length}`, name: r.name ?? 'w', timeoutMs: 1_000, warnings: [] }; },
    followUp: async (r: Record<string, unknown>) => { spawned.push(r); return { jobId: `job-${spawned.length}`, name: 'Ada', workerId: 'Ada', turn: 2, action: 'started', delivery: 'now', status: 'running', provider: 'codex', repo, timeoutMs: 1_000 }; },
    detail: async () => ({ jobId: 'fixture-job', status: 'succeeded', provider: 'codex', mode: 'review', name: 'Ada', workerId: 'Ada', conversation: 'thread', cwd: repo, unrestricted: false }),
  }) as never;
  const server: HandlerContext['server'] = {
    getClientCapabilities: () => opts.caps,
    elicitInput: async (params) => {
      asked.push(params.message);
      if (opts.action === 'throw') throw new Error('Request timed out');
      return { action: opts.action ?? 'accept' };
    },
  };
  const ctx: HandlerContext = { service, catalogs: async () => [], ...(opts.server === false ? {} : { server }) };
  return { ctx, repo, spawned, asked };
}
const spawnArgs = { mode: 'review', provider: 'codex', name: 'Ada', prompt: 'x', unrestricted: true };

test('accept: asks once with provider, worker and cwd, then spawns unrestricted', async () => {
  const h = harness({ caps: FORM, action: 'accept' });
  const r = await callTool(h.ctx, 'spawn_job', spawnArgs);
  assert.equal(r.isError, undefined, text(r));
  assert.deepEqual(h.asked, [`Allow codex worker "Ada" to run without approval prompts in ${h.repo}? It will be able to run any command.`]);
  assert.equal(h.spawned[0]!.unrestricted, true);
  assert.equal((body(r).warnings ?? []).includes(UNCONFIRMED_UNRESTRICTED), false);
  const resumed = await callTool(h.ctx, 'follow_up', { worker: 'Ada', prompt: 'more', unrestricted: true });
  assert.equal(resumed.isError, undefined, text(resumed));
  assert.equal(h.asked.length, 2); assert.equal(h.spawned[1]!.unrestricted, true);
});

test('decline, cancel or no answer: isError with the next step, and nothing spawns', async () => {
  for (const action of ['decline', 'cancel', 'throw'] as const) {
    const h = harness({ caps: FORM, action });
    for (const [tool, args] of [['spawn_job', spawnArgs], ['follow_up', { worker: 'Ada', prompt: 'more', unrestricted: true }]] as const) {
      const r = await callTool(h.ctx, tool, args);
      assert.equal(r.isError, true, `${action} ${tool}`);
      if (action === 'throw') assert.match(text(r), /Could not confirm unrestricted access.*rerun without unrestricted, or ask the user\./);
      else assert.equal(text(r), DECLINED_UNRESTRICTED);
    }
    assert.equal(h.spawned.length, 0, action);
  }
});

test('no elicitation capability: proceeds as before, with a warning in the ack', async () => {
  for (const h of [harness({ caps: {} }), harness({ caps: { elicitation: { url: {} } } }), harness({ server: false })]) {
    const r = await callTool(h.ctx, 'spawn_job', spawnArgs);
    assert.equal(r.isError, undefined, text(r));
    assert.ok(body(r).warnings.includes(UNCONFIRMED_UNRESTRICTED));
    assert.equal(h.spawned[0]!.unrestricted, true);
    const resumed = await callTool(h.ctx, 'follow_up', { worker: 'Ada', prompt: 'more', unrestricted: true });
    assert.ok(body(resumed).warnings.includes(UNCONFIRMED_UNRESTRICTED));
    assert.equal(h.asked.length, 0);
  }
});

test('AGENT_SMITH_CONFIRM_UNRESTRICTED=0 disables the prompt and the warning', async () => {
  const prior = process.env.AGENT_SMITH_CONFIRM_UNRESTRICTED;
  process.env.AGENT_SMITH_CONFIRM_UNRESTRICTED = '0';
  try {
    for (const caps of [FORM, {}]) {
      const h = harness({ caps, action: 'decline' });
      const r = await callTool(h.ctx, 'spawn_job', spawnArgs);
      assert.equal(r.isError, undefined, text(r));
      assert.equal(h.asked.length, 0); assert.equal(h.spawned[0]!.unrestricted, true);
      assert.equal((body(r).warnings ?? []).includes(UNCONFIRMED_UNRESTRICTED), false);
    }
  } finally {
    if (prior === undefined) delete process.env.AGENT_SMITH_CONFIRM_UNRESTRICTED; else process.env.AGENT_SMITH_CONFIRM_UNRESTRICTED = prior;
  }
});

test('no prompt for agy, for unrestricted false or absent, or for an inherited setting on follow_up', async () => {
  const h = harness({ caps: FORM, action: 'decline' });
  for (const args of [{ ...spawnArgs, provider: 'agy' }, { ...spawnArgs, provider: 'kimi' }, { ...spawnArgs, unrestricted: false }, { mode: 'review', provider: 'claude', prompt: 'x' }]) {
    const r = await callTool(h.ctx, 'spawn_job', args);
    assert.equal(r.isError, undefined, text(r));
  }
  assert.equal((await callTool(h.ctx, 'follow_up', { worker: 'Ada', prompt: 'more' })).isError, undefined);
  assert.equal(h.asked.length, 0);
  assert.equal(h.spawned.length, 5);
});

test('the prompt names an unnamed worker generically and asks only after validation passes', async () => {
  const h = harness({ caps: FORM, action: 'accept' });
  const { name: _name, ...unnamed } = spawnArgs;
  await callTool(h.ctx, 'spawn_job', { ...unnamed, provider: 'opencode' });
  assert.match(h.asked[0]!, /^Allow a new opencode worker to run without approval prompts in /);
  const bad = await callTool(h.ctx, 'spawn_job', { ...spawnArgs, cwd: 'relative' });
  assert.equal(bad.isError, true);
  assert.equal(h.asked.length, 1, 'an invalid call must not prompt the user');
});

test('variants: one confirmation for the batch; a decline starts none', async () => {
  const variants = [{ name: 'A', model: 'codex-alias' }, { name: 'B', model: 'claude-alias' }, { name: 'C', model: 'agy-alias' }];
  const writeAliases = (repo: string) => {
    mkdirSync(path.join(repo, '.agent-smith'), { recursive: true });
    writeFileSync(path.join(repo, '.agent-smith', 'models.json'), JSON.stringify({
      aliases: {
        'codex-alias': { provider: 'codex' },
        'claude-alias': { provider: 'claude' },
        'agy-alias': { provider: 'agy' },
      },
    }));
  };
  const h = harness({ caps: FORM, action: 'accept' });
  writeAliases(h.repo);
  const r = await callTool(h.ctx, 'spawn_job', { mode: 'review', prompt: 'x', unrestricted: true, variants });
  assert.equal(r.isError, undefined, text(r));
  assert.deepEqual(h.asked, [`Allow 2 workers (A: codex, B: claude) to run without approval prompts in ${h.repo}? It will be able to run any command.`]);
  assert.deepEqual(h.spawned.map(s => s.unrestricted), [true, true, true]);
  const declined = harness({ caps: FORM, action: 'decline' });
  writeAliases(declined.repo);
  const d = await callTool(declined.ctx, 'spawn_job', { mode: 'review', prompt: 'x', unrestricted: true, variants });
  assert.equal(d.isError, true); assert.equal(declined.asked.length, 1); assert.equal(declined.spawned.length, 0);
});

test('variants: resolves providers from models.json aliases and defaultProvider before batch confirmation, and validates before asking', async () => {
  const h = harness({ caps: FORM, action: 'accept' });
  mkdirSync(path.join(h.repo, '.agent-smith'), { recursive: true });
  writeFileSync(path.join(h.repo, '.agent-smith', 'models.json'), JSON.stringify({
    aliases: { 'codex-alias': { provider: 'codex', model: 'gpt-5' } },
  }));
  const ctx: HandlerContext = {
    ...h.ctx,
    catalogs: async () => [{ provider: 'claude', models: [], defaultModel: 'm', defaultEffort: 'low', defaultSource: 'harness-config', source: 'static', stale: false, verified: true }],
  };
  const r = await callTool(ctx, 'spawn_job', {
    mode: 'review', prompt: 'x', unrestricted: true,
    variants: [{ name: 'A', model: 'codex-alias' }, { name: 'B' }],
  });
  assert.equal(r.isError, undefined, text(r));
  assert.deepEqual(h.asked, [`Allow 2 workers (A: codex, B: claude) to run without approval prompts in ${h.repo}? It will be able to run any command.`]);
  assert.deepEqual(h.spawned.map(s => s.unrestricted), [true, true]);

  const bad = await callTool(ctx, 'spawn_job', {
    mode: 'review', prompt: 'x', cwd: 'relative', unrestricted: true,
    variants: [{ name: 'A', model: 'codex-alias' }],
  });
  assert.equal(bad.isError, true);
  assert.equal(h.asked.length, 1, 'invalid shared arg must not prompt');
  assert.equal(h.spawned.length, 2);
});

test('follow_up checks its target before asking: a worker with no saved conversation, or a pipeline stage, never prompts', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'smith-confirm-target-'));
  const at = new Date().toISOString();
  for (const [jobId, extra] of [['review-smith-noconv1', { name: 'NoConv', conversation: null, pipeline: null }], ['review-smith-stage01', { name: 'Stage', conversation: 'thread', pipeline: 'run-1', stage: 'build' }]] as const) {
    const file = jobFile(repo, jobId, FILES.job);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ schema: 1, jobId, workerId: jobId, provider: 'codex', mode: 'review', cwd: repo, status: 'succeeded', createdAt: at, startedAt: at, updatedAt: at, finishedAt: at, ...extra }));
  }
  const asked: string[] = [];
  const ctx: HandlerContext = {
    service: new ForgeService({ repo }), catalogs: async () => [],
    server: { getClientCapabilities: () => FORM, elicitInput: async (p) => { asked.push(p.message); return { action: 'accept' }; } },
  };
  const noConv = await callTool(ctx, 'follow_up', { worker: 'NoConv', prompt: 'more', unrestricted: true });
  assert.match(text(noConv), /has no saved conversation/);
  const stage = await callTool(ctx, 'follow_up', { worker: 'Stage', prompt: 'more', unrestricted: true });
  assert.match(text(stage), /is a pipeline stage/);
  assert.deepEqual(asked, []);
});

test('run_pipeline: asks once for unrestricted stages and refuses on decline without starting', async () => {
  const stages = [
    { name: 'impl', provider: 'codex', role: 'implement', prompt: 'x' },
    { name: 'rev', provider: 'claude', role: 'review', prompt: 'y', dependsOn: ['impl'] },
    { name: 'agy-step', provider: 'agy', role: 'moderate', prompt: 'z', dependsOn: ['rev'] },
  ];
  const declined = harness({ caps: FORM, action: 'decline' });
  const r = await callTool(declined.ctx, 'run_pipeline', { spec: { name: 'p', workDir: declined.repo, unrestricted: true, stages } });
  assert.equal(r.isError, true, text(r));
  assert.equal(text(r), DECLINED_UNRESTRICTED);
  assert.deepEqual(declined.asked, [
    `Allow 2 pipeline stages (impl: codex, rev: claude) to run without approval prompts in ${declined.repo}? It will be able to run any command.`,
  ]);
  const pipelinesDir = path.join(declined.repo, '.agent-smith', 'pipelines');
  assert.equal(existsSync(pipelinesDir) ? readdirSync(pipelinesDir).length : 0, 0);

  const singleDeclined = harness({ caps: FORM, action: 'decline' });
  const r2 = await callTool(singleDeclined.ctx, 'run_pipeline', {
    spec: { name: 'p2', workDir: singleDeclined.repo, unrestricted: true, stages: [stages[0]!] },
  });
  assert.equal(r2.isError, true, text(r2));
  assert.deepEqual(singleDeclined.asked, [
    `Allow pipeline stage "impl" (codex) to run without approval prompts in ${singleDeclined.repo}? It will be able to run any command.`,
  ]);
});

function hasUnrestrictedProperty(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  const obj = schema as Record<string, unknown>;
  const props = obj.properties;
  if (props !== null && typeof props === 'object') {
    if ('unrestricted' in (props as Record<string, unknown>)) return true;
    return Object.values(props as Record<string, unknown>).some(hasUnrestrictedProperty);
  }
  return false;
}

test('every launching tool in TOOL_DEFS enforces the unrestricted gate on an escalating request', async () => {
  const launching = TOOL_DEFS.filter(t => t.annotations?.readOnlyHint === false && t.annotations?.openWorldHint === true);
  assert.ok(launching.length >= 4);
  const escalatingArgs: Record<string, (repo: string) => Record<string, unknown>> = {
    spawn_job: () => spawnArgs,
    follow_up: () => ({ worker: 'Ada', prompt: 'more', unrestricted: true }),
    run_pipeline: (repo) => ({ spec: { name: 'p', workDir: repo, unrestricted: true, stages: [{ name: 'impl', provider: 'codex', role: 'implement', prompt: 'x' }] } }),
  };
  for (const def of launching) {
    if (!(def.name in escalatingArgs)) {
      assert.equal(hasUnrestrictedProperty(def.inputSchema), false, `launching tool ${def.name} accepts unrestricted but is not in escalatingArgs`);
      continue;
    }
    const h = harness({ caps: FORM, action: 'decline' });
    const r = await callTool(h.ctx, def.name, escalatingArgs[def.name]!(h.repo));
    assert.equal(r.isError, true, `${def.name} must refuse on declined gate`);
    assert.equal(text(r), DECLINED_UNRESTRICTED, `${def.name} refusal message`);
    assert.equal(h.asked.length, 1, `${def.name} must ask once`);
    assert.equal(h.spawned.length, 0, `${def.name} must not spawn`);
    const pipelinesDir = path.join(h.repo, '.agent-smith', 'pipelines');
    assert.equal(existsSync(pipelinesDir) ? readdirSync(pipelinesDir).length : 0, 0, `${def.name} must not start a pipeline`);
  }
});
