import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientCapabilities, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { DECLINED_UNRESTRICTED, UNCONFIRMED_UNRESTRICTED, callTool, type HandlerContext } from '../tools.ts';

// The prompt is the behaviour under test; an outer AGENT_SMITH_CONFIRM_UNRESTRICTED=0 would hide it (each test file runs in its own process).
delete process.env.AGENT_SMITH_CONFIRM_UNRESTRICTED;
const FORM: ClientCapabilities = { elicitation: { form: {} } };
const body = (r: { content: unknown }) => JSON.parse(((r.content as { text: string }[])[0]!).text);
const text = (r: { content: unknown }) => ((r.content as { text: string }[])[0]!).text;

/** A fake forge service plus a fake MCP server that records what it was asked and answers with `action`. */
function harness(opts: { caps?: ClientCapabilities; action?: ElicitResult['action'] | 'throw'; server?: boolean } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), 'smith-confirm-'));
  const spawned: Array<Record<string, unknown>> = []; const asked: string[] = [];
  const service = {
    repo,
    spawnJob: async (r: Record<string, unknown>) => { spawned.push(r); return { jobId: `job-${spawned.length}`, name: r.name ?? 'w', timeoutMs: 1_000, warnings: [] }; },
    detail: async () => ({ status: 'succeeded', provider: 'codex', mode: 'review', name: 'Ada', workerId: 'Ada', conversation: 'thread', cwd: repo, unrestricted: false }),
  } as never;
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
  const resumed = await callTool(h.ctx, 'resume_job', { worker: 'Ada', prompt: 'more', unrestricted: true });
  assert.equal(resumed.isError, undefined, text(resumed));
  assert.equal(h.asked.length, 2); assert.equal(h.spawned[1]!.unrestricted, true);
});

test('decline, cancel or no answer: isError with the next step, and nothing spawns', async () => {
  for (const action of ['decline', 'cancel', 'throw'] as const) {
    const h = harness({ caps: FORM, action });
    for (const [tool, args] of [['spawn_job', spawnArgs], ['resume_job', { worker: 'Ada', prompt: 'more', unrestricted: true }]] as const) {
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
    const resumed = await callTool(h.ctx, 'resume_job', { worker: 'Ada', prompt: 'more', unrestricted: true });
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

test('no prompt for agy, for unrestricted false or absent, or for an inherited setting on resume', async () => {
  const h = harness({ caps: FORM, action: 'decline' });
  for (const args of [{ ...spawnArgs, provider: 'agy' }, { ...spawnArgs, unrestricted: false }, { mode: 'review', provider: 'claude', prompt: 'x' }]) {
    const r = await callTool(h.ctx, 'spawn_job', args);
    assert.equal(r.isError, undefined, text(r));
  }
  assert.equal((await callTool(h.ctx, 'resume_job', { worker: 'Ada', prompt: 'more' })).isError, undefined);
  assert.equal(h.asked.length, 0);
  assert.equal(h.spawned.length, 4);
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
