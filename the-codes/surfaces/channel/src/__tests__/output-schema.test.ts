import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { TOOL_DEFS, callTool, type HandlerContext, type ToolOutcome } from '../tools.ts';
import { writeAcceptance } from '../../../../forge/checks.ts';
import type { JobDetail, JobSummary, MessageAck, SpawnAck } from '../../../../forge/service.ts';
import type { ModelCatalog } from '../../../../providers/types.ts';
import { withWorkerLookup } from './service-mock.ts';

const validator = new AjvJsonSchemaValidator();
function assertValid(tool: string, result: ToolOutcome, label: string): Record<string, unknown> {
  assert.equal(result.isError, undefined, `${label}: ${JSON.stringify(result.content)}`);
  const schema = TOOL_DEFS.find(t => t.name === tool)?.outputSchema;
  assert.ok(schema, `${tool} declares an outputSchema`);
  assert.ok(result.structuredContent, `${label}: structuredContent present`);
  const wire = JSON.parse(JSON.stringify(result.structuredContent)) as Record<string, unknown>;
  const check = validator.getValidator(schema as never)(wire);
  assert.ok(check.valid, `${label}: ${check.errorMessage}\n${JSON.stringify(wire, null, 2)}`);
  return wire;
}

const repo = mkdtempSync(path.join(tmpdir(), 'smith-schema-'));
const ack: SpawnAck = {
  jobId: 'job-1', name: 'Ada', workerId: 'Ada', turn: 1, role: 'review', provider: 'codex', status: 'running',
  dir: path.join(repo, '.agent-smith', 'jobs', 'job-1'), repo, timeoutMs: 2_700_000, unrestricted: false,
  note: 'spawned', sandbox: 'codex -s read-only', sandboxFlags: ['-s', 'read-only'], readOnlyRequested: true, readOnlyEnforced: true,
  modelRequested: null, modelResolved: 'gpt-x', modelSource: 'harness-config', preambleApplied: true, warnings: ['effort typo'],
  chainStartedAt: '2026-10-11T09:00:00.000Z',
};
const summary: JobSummary = {
  jobId: 'job-1', name: 'Ada', workerId: 'Ada', turn: 1, role: 'review', latestSummary: 'Found two bugs in the parser.', summarySource: 'worker',
  status: 'succeeded', provider: 'codex', mode: 'review', model: 'gpt-x', task: 'Review parser', toolCalls: 4,
  currentActivity: null, lastActivity: { stepIndex: 3, tool: 'shell', input: 'npm test', status: 'done' },
  startedAt: '2026-10-11T09:00:00.000Z', updatedAt: '2026-10-11T09:05:00.000Z', finishedAt: '2026-10-11T09:05:00.000Z',
  warnings: [{ code: 'slow', message: 'took a while' }], nextAction: null, unrestricted: false,
};
const detail: JobDetail = {
  ...summary, report: 'Report body. '.repeat(400), error: null, exitCode: 0, unrestricted: false, pipeline: null, stage: null,
  usage: { input_tokens: 12, output_tokens: 3 }, conversation: 'thread-1', effort: 'high', cwd: repo,
  modelRequested: null, modelResolved: 'gpt-x', modelSource: 'harness-config', preambleApplied: true,
  sandbox: 'codex -s read-only', sandboxFlags: ['-s', 'read-only'], readOnlyRequested: true, readOnlyEnforced: true, cancellable: false,
  gitBaseline: { head: null, dirty: [] }, changedFiles: ['src/a.ts'], changedFilesTruncated: false,
};
const running: JobDetail = { ...detail, jobId: 'job-2', name: 'Bo', workerId: 'Bo', status: 'running', finishedAt: null, report: null, exitCode: null, latestSummary: null, summarySource: null, lastActivity: null, toolCalls: null, changedFiles: undefined, gitBaseline: undefined, warnings: [] };
const unknown: JobDetail = { ...running, jobId: 'job-3', name: 'Cy', workerId: 'Cy', status: 'unknown' };
const failed: JobDetail = { ...running, jobId: 'job-4', name: 'Di', workerId: 'Di', status: 'failed', finishedAt: '2026-10-11T09:06:00.000Z', exitCode: 1, error: 'exit 1', nextAction: 'rerun' };
const details = [detail, running, unknown, failed];
const messageAck: MessageAck = {
  jobId: 'job-2', name: 'Bo', workerId: 'Bo', turn: 1, action: 'queued', delivery: 'turn-end', status: 'running',
  provider: 'codex', repo, timeoutMs: 2_700_000, pendingMessages: 1, note: 'Queued; runs when this turn ends.',
};
const service = withWorkerLookup({
  repo, spawnedIds: new Set(['job-1']),
  spawnJob: async () => ack,
  followUp: async (req: { worker: string; env?: unknown }): Promise<MessageAck> => (req.worker === 'Bo'
    ? { ...messageAck, action: 'queued', delivery: 'next-step', pendingMessages: 2, note: 'Sent into the running turn; read at its next step.' }
    : { ...messageAck, jobId: 'job-1-t2', name: 'Ada', workerId: 'Ada', turn: 2, action: 'started', delivery: 'now', env: 'dropped', envKeys: ['CARGO_TARGET_DIR'], checks: ['tests'], warnings: ['env CARGO_TARGET_DIR not set: values live only in memory and were lost; pass env again.'], note: 'Started turn 2.' }),
  steer: async (): Promise<MessageAck> => ({ ...messageAck, action: 'interrupting', delivery: 'now', note: 'Interrupting; the steered turn starts next.' }),
  detail: async (id: string) => { const d = details.find(x => x.jobId === id); if (!d) throw new Error('no job'); return d; },
  list: async ({ limit }: { limit?: number }) => (details as JobSummary[]).slice(0, limit),
}) as never;
const cat = (provider: string, extra: Partial<ModelCatalog> = {}): ModelCatalog => ({
  provider, models: [{ id: `${provider}-m`, label: provider, efforts: ['low', 'high'], defaultEffort: 'low' }],
  defaultModel: `${provider}-m`, defaultEffort: 'high', defaultSource: 'harness-config', source: 'live', stale: false, verified: true, ...extra,
});
const ctx: HandlerContext = { service, catalogs: async () => [cat('codex'), cat('claude', { models: [], error: 'boom', defaultSource: 'unknown', defaultModel: undefined, defaultEffort: undefined })] };

test('exactly the structured tools declare an outputSchema, all open to new fields', () => {
  const declared = TOOL_DEFS.filter(t => t.outputSchema).map(t => t.name).sort();
  assert.deepEqual(declared, ['follow_up', 'list_capabilities', 'list_jobs', 'spawn_job', 'status', 'steer']);
  for (const t of TOOL_DEFS.filter(d => d.outputSchema)) assert.equal(t.outputSchema!.additionalProperties, true, t.name);
});

test('spawn_job acks validate, with and without checks and warnings', async () => {
  const plain = assertValid('spawn_job', await callTool(ctx, 'spawn_job', { mode: 'review', provider: 'codex', prompt: 'x' }), 'spawn_job');
  assert.equal(plain.jobId, 'job-1'); assert.equal('taskHandle' in plain, false);
  const gated = assertValid('spawn_job', await callTool(ctx, 'spawn_job', { mode: 'review', provider: 'codex', prompt: 'x', checks: [{ name: 'tests', command: 'true' }] }), 'spawn_job checks');
  assert.deepEqual(gated.checks, ['tests']);
  const prior = process.env.AGENT_SMITH_CONFIRM_UNRESTRICTED; process.env.AGENT_SMITH_CONFIRM_UNRESTRICTED = '1';
  try {
    const warned = assertValid('spawn_job', await callTool(ctx, 'spawn_job', { mode: 'review', provider: 'codex', prompt: 'x', unrestricted: true }), 'spawn_job unconfirmed');
    assert.ok((warned.warnings as string[]).some(w => /not confirmed/.test(w)));
  } finally { if (prior === undefined) delete process.env.AGENT_SMITH_CONFIRM_UNRESTRICTED; else process.env.AGENT_SMITH_CONFIRM_UNRESTRICTED = prior; }
});

test('status validates concise and detailed, for every lifecycle, with wait_ms and include_diff', async () => {
  writeAcceptance(repo, 'job-1', { state: 'accepted', checks: [{ name: 'tests', ok: true, exitCode: 0, durationMs: 5, outputTail: 'ok', blocking: true, timedOut: false, signal: null }, { name: 'lint', ok: false, exitCode: 1, durationMs: 5, outputTail: 'bad', blocking: false, timedOut: false, signal: null }], at: '2026-10-11T09:06:00.000Z' });
  writeAcceptance(repo, 'job-2', { state: 'unchecked', checks: [], pending: true });
  for (const d of details) {
    for (const response_format of ['concise', 'detailed']) {
      const label = `status ${d.jobId} ${response_format}`;
      const out = assertValid('status', await callTool(ctx, 'status', { id: d.jobId, response_format }), label);
      assert.equal(out.taskStatus, response_format === 'concise' ? undefined : { running: 'working', unknown: 'working', succeeded: 'completed', failed: 'failed' }[d.status as string], label);
      if (response_format === 'concise') for (const k of ['resumable', 'chainStartedAt', 'continuedFrom', 'continuationKind', 'followedBy']) assert.equal(k in out, false, `${label} ${k}`);
      assertValid('status', await callTool(ctx, 'status', { id: d.jobId, response_format, include_diff: true }), `${label} include_diff`);
    }
  }
  const waited = assertValid('status', await callTool({ ...ctx, pollMs: 1 }, 'status', { id: 'job-2', wait_ms: 5 }), 'status wait_ms');
  assert.deepEqual([waited.waited, waited.stillRunning], [true, true]);
});

test('list_jobs validates concise (bare and cut) and detailed', async () => {
  const concise = assertValid('list_jobs', await callTool(ctx, 'list_jobs', {}), 'list_jobs concise');
  assert.equal((concise.items as unknown[]).length, details.length); assert.equal(concise.more, undefined);
  const cut = assertValid('list_jobs', await callTool(ctx, 'list_jobs', { limit: 2 }), 'list_jobs concise cut');
  assert.equal((cut.items as unknown[]).length, 2); assert.equal(typeof cut.more, 'string');
  const detailed = assertValid('list_jobs', await callTool(ctx, 'list_jobs', { response_format: 'detailed' }), 'list_jobs detailed');
  assert.deepEqual((detailed.items as { taskStatus: string }[]).map(r => r.taskStatus), ['completed', 'working', 'working', 'failed']);
  assert.ok((concise.items as Record<string, unknown>[]).every(r => !('taskStatus' in r) && !('workerId' in r)));
});

test('list_jobs concise rows validate digest, acceptance, changedFileCount and liveness (no stalled)', async () => {
  const rich: JobSummary = {
    ...summary, jobId: 'job-4', name: 'Dee', workerId: 'Dee', status: 'running', finishedAt: null,
    updatedAt: '2026-10-11T09:00:00.000Z', changedFileCount: 2,
    digest: { phase: 'testing', filesRead: 3, searches: 1, edited: ['src/a.ts', 'src/b.ts'], editedCount: 2, commands: 2, testRuns: 1, lastTestFailed: true, repeat: null },
    acceptance: { state: 'rejected', checks: [{ name: 'tests', ok: false, exitCode: 1, durationMs: 5, outputTail: 'bad', blocking: true, timedOut: false, signal: null }], at: '2026-10-11T09:06:00.000Z' },
  };
  const settled: JobSummary = { ...rich, jobId: 'job-5', name: 'Eve', workerId: 'Eve', status: 'failed', finishedAt: '2026-10-11T09:06:00.000Z' };
  const listService = { repo, spawnedIds: new Set<string>(), list: async () => [rich, settled] };
  const out = assertValid('list_jobs', await callTool({ ...ctx, service: listService as never }, 'list_jobs', {}), 'list_jobs fleet row');
  const [row, done] = out.items as Record<string, unknown>[];
  assert.equal('stalled' in row!, false);
  assert.equal((row!.liveness as { state: string }).state, 'silent');
  assert.equal('changedFileCount' in row!, false);
  assert.equal(done!.changedFileCount, 2);
  assert.deepEqual(done!.acceptance, { state: 'rejected', failed: ['tests'] });
  assert.deepEqual(row!.digest, { phase: 'testing', filesRead: 3, edited: ['src/a.ts', 'src/b.ts'], editedCount: 2, testRuns: 1, lastTestFailed: true });
});

test('list_capabilities validates with installed, errored and uninstalled providers', async () => {
  const caps = assertValid('list_capabilities', await callTool(ctx, 'list_capabilities', {}), 'list_capabilities');
  assert.ok((caps.providers as { available: boolean }[]).some(p => !p.available));
  assertValid('list_capabilities', await callTool({ ...ctx, catalogs: async () => [] }, 'list_capabilities', {}), 'list_capabilities none installed');
  assertValid('list_capabilities', await callTool(ctx, 'list_capabilities', { response_format: 'detailed' }), 'list_capabilities detailed');
});

test('follow_up and steer acks validate against their outputSchemas, for every action and delivery', async () => {
  const queued = assertValid('follow_up', await callTool(ctx, 'follow_up', { worker: 'Bo', prompt: 'Also cover the edge case.' }), 'follow_up live');
  assert.deepEqual([queued.action, queued.delivery, queued.pendingMessages], ['queued', 'next-step', 2]);
  const started = assertValid('follow_up', await callTool(ctx, 'follow_up', { worker: 'Ada', prompt: 'Next.' }), 'follow_up cold');
  assert.deepEqual([started.action, started.delivery, started.jobId, started.turn, started.env], ['started', 'now', 'job-1-t2', 2, 'dropped']);
  assert.deepEqual(started.envKeys, ['CARGO_TARGET_DIR']);
  const steered = assertValid('steer', await callTool(ctx, 'steer', { worker: 'job-2', prompt: 'Pivot.' }), 'steer');
  assert.deepEqual([steered.action, steered.status, steered.workerId], ['interrupting', 'running', 'Bo']);
  for (const a of [queued, started, steered]) for (const k of ['jobId', 'workerId', 'status', 'repo', 'timeoutMs', 'action']) assert.ok(k in a, k);
});

test('a schema violation is caught (the harness can fail)', () => {
  const schema = TOOL_DEFS.find(t => t.name === 'status')!.outputSchema!;
  assert.equal(validator.getValidator(schema as never)({ jobId: 'j', status: 'done', taskStatus: 'working' }).valid, false);
  assert.equal(validator.getValidator(schema as never)({ jobId: 'j' }).valid, false);
  const ackSchema = TOOL_DEFS.find(t => t.name === 'follow_up')!.outputSchema!;
  assert.equal(validator.getValidator(ackSchema as never)({ ...messageAck, delivery: 'queue' }).valid, false);
  assert.equal(validator.getValidator(ackSchema as never)({ ...messageAck, action: 'resumed' }).valid, false);
});

test('liveness and finish evidence validate in list_jobs and status without stalled', async () => {
  const now = Date.now(); const iso = (ms: number) => new Date(now - ms).toISOString();
  const open = { stepIndex: 5, tool: 'Bash', input: '{"command":"cargo test --workspace"}', status: 'active' as const };
  const inTool: JobDetail = { ...running, jobId: 'job-l1', name: 'Lu', workerId: 'Lu', updatedAt: iso(40 * 60_000), lastEventAt: iso(40 * 60_000), lastAliveAt: iso(5_000), lastActivity: open };
  const dead: JobDetail = { ...running, jobId: 'job-l2', name: 'Mo', workerId: 'Mo', updatedAt: iso(60_000), lastEventAt: iso(60_000), lastAliveAt: iso(3 * 60_000) };
  const evidence: JobDetail = { ...detail, jobId: 'job-l3', name: 'Ny', workerId: 'Ny', status: 'failed', toolErrors: 2, failedEarly: true, changedFilesUnknown: true, cwdMissingAtFinish: true, changedFiles: undefined };
  const rows = [inTool, dead, evidence];
  const svc = withWorkerLookup({ repo, spawnedIds: new Set<string>(), list: async () => rows, detail: async (id: string) => rows.find(r => r.jobId === id)! });
  const c = { ...ctx, service: svc as never };
  const listed = assertValid('list_jobs', await callTool(c, 'list_jobs', {}), 'list_jobs liveness');
  const [a, b, e] = listed.items as Record<string, unknown>[];
  assert.deepEqual(a!.liveness, { state: 'in-tool', silentForMs: (a!.liveness as { silentForMs: number }).silentForMs, tool: 'cargo test --workspace' });
  assert.equal('stalled' in a!, false);
  assert.equal((b!.liveness as { state: string }).state, 'dead');
  assert.equal('stalled' in b!, false);
  assert.deepEqual([e!.toolErrors, e!.failedEarly, e!.changedFilesUnknown, e!.cwdMissingAtFinish, e!.liveness], [2, true, true, true, undefined]);
  assertValid('list_jobs', await callTool(c, 'list_jobs', { response_format: 'detailed' }), 'list_jobs liveness detailed');
  for (const response_format of ['concise', 'detailed']) {
    const s = assertValid('status', await callTool(c, 'status', { id: 'job-l2', response_format }), `status dead ${response_format}`);
    assert.equal((s.liveness as { state: string }).state, 'dead');
    assert.equal('stalled' in s, false);
    const f = assertValid('status', await callTool(c, 'status', { id: 'job-l3', response_format }), `status evidence ${response_format}`);
    assert.deepEqual([f.toolErrors, f.failedEarly, f.changedFilesUnknown, f.cwdMissingAtFinish], [2, true, true, true]);
  }
});
