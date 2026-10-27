/**
 * Every structured tool's real output must validate against the outputSchema it declares: MCP
 * clients validate structuredContent, so a wrong schema breaks the tool for every caller. The
 * validator is the SDK's own (the one its Client uses). Fixtures are typed as the service's real
 * record types, so tsc keeps them complete as those types grow.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { TOOL_DEFS, callTool, type HandlerContext, type ToolOutcome } from '../tools.ts';
import { writeAcceptance } from '../../../../forge/checks.ts';
import type { JobDetail, JobSummary, SpawnAck } from '../../../../forge/service.ts';
import type { ModelCatalog } from '../../../../providers/types.ts';
import { withWorkerLookup } from './service-mock.ts';

const validator = new AjvJsonSchemaValidator();
function assertValid(tool: string, result: ToolOutcome, label: string): Record<string, unknown> {
  assert.equal(result.isError, undefined, `${label}: ${JSON.stringify(result.content)}`);
  const schema = TOOL_DEFS.find(t => t.name === tool)?.outputSchema;
  assert.ok(schema, `${tool} declares an outputSchema`);
  assert.ok(result.structuredContent, `${label}: structuredContent present`);
  // What the client sees: the JSON wire form, where undefined keys are dropped.
  const wire = JSON.parse(JSON.stringify(result.structuredContent)) as Record<string, unknown>;
  const check = validator.getValidator(schema as never)(wire);
  assert.ok(check.valid, `${label}: ${check.errorMessage}\n${JSON.stringify(wire, null, 2)}`);
  return wire;
}

const repo = mkdtempSync(path.join(tmpdir(), 'smith-schema-'));
const ack: SpawnAck = {
  jobId: 'job-1', name: 'Ada', workerId: 'Ada', role: 'review', provider: 'codex', status: 'running',
  dir: path.join(repo, '.agent-smith', 'jobs', 'job-1'), repo, timeoutMs: 2_700_000, unrestricted: false,
  note: 'spawned', sandbox: 'codex -s read-only', sandboxFlags: ['-s', 'read-only'], readOnlyRequested: true, readOnlyEnforced: true,
  modelRequested: null, modelResolved: 'gpt-x', modelSource: 'harness-config', preambleApplied: true, warnings: ['effort typo'],
};
const summary: JobSummary = {
  jobId: 'job-1', name: 'Ada', workerId: 'Ada', role: 'review', latestSummary: 'Found two bugs in the parser.', summarySource: 'worker',
  source: 'agent-smith', status: 'succeeded', provider: 'codex', mode: 'review', model: 'gpt-x', task: 'Review parser', toolCalls: 4,
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
const running: JobDetail = { ...detail, jobId: 'job-2', name: 'Bo', status: 'running', finishedAt: null, report: null, exitCode: null, latestSummary: null, summarySource: null, lastActivity: null, toolCalls: null, changedFiles: undefined, gitBaseline: undefined, warnings: [] };
const unknown: JobDetail = { ...running, jobId: 'job-3', name: 'Cy', status: 'unknown' };
// The sparsest record: an agy-staff interop job (forge/service.ts detail()).
const interop: JobDetail = {
  jobId: 'staff-1', name: 'staff-1', workerId: 'staff-1', role: null, latestSummary: null, summarySource: null, source: 'agy-staff',
  status: 'failed', provider: 'agy', mode: null, model: null, task: null, toolCalls: null, currentActivity: null, lastActivity: null,
  startedAt: null, updatedAt: null, finishedAt: null, warnings: [], nextAction: 'rerun', report: null, error: null, exitCode: null,
  unrestricted: true, pipeline: null, stage: null, usage: null, conversation: null, effort: null, cwd: null, cancellable: false,
};
const details = [detail, running, unknown, interop];
const service = withWorkerLookup({
  repo, spawnedIds: new Set(['job-1']),
  spawnJob: async () => ack,
  spawnTracked: async (spec: { continuedFrom?: string }) => ({
    ack: { ...ack, ...(spec?.continuedFrom ? { continuedFrom: spec.continuedFrom } : {}) },
    done: new Promise(() => {}),
  }),
  steer: async () => ({
    jobId: 'job-2', name: 'Bo', workerId: 'Bo', provider: 'codex', delivery: 'interrupt' as const,
    status: 'interrupting' as const, pendingSteers: 1, signalled: true, resumable: true, repo,
    dir: path.join(repo, '.agent-smith', 'jobs', 'job-2'), timeoutMs: 2_700_000, note: 'Interrupting.',
  }),
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
  assert.deepEqual(declared, ['list_capabilities', 'list_jobs', 'resume_job', 'spawn_job', 'status', 'steer_job']);
  for (const t of TOOL_DEFS.filter(d => d.outputSchema)) assert.equal(t.outputSchema!.additionalProperties, true, t.name);
});

test('spawn_job acks validate, with and without checks and warnings', async () => {
  const plain = assertValid('spawn_job', await callTool(ctx, 'spawn_job', { mode: 'review', provider: 'codex', prompt: 'x' }), 'spawn_job');
  assert.deepEqual(plain.taskHandle, { taskId: 'job-1', status: 'working', pollIntervalMs: 5_000 });
  const gated = assertValid('spawn_job', await callTool(ctx, 'spawn_job', { mode: 'review', provider: 'codex', prompt: 'x', checks: [{ name: 'tests', command: 'true' }] }), 'spawn_job checks');
  assert.deepEqual(gated.checks, ['tests']);
  const prior = process.env.AGENT_SMITH_CONFIRM_UNRESTRICTED; delete process.env.AGENT_SMITH_CONFIRM_UNRESTRICTED;
  try {
    const warned = assertValid('spawn_job', await callTool(ctx, 'spawn_job', { mode: 'review', provider: 'codex', prompt: 'x', unrestricted: true }), 'spawn_job unconfirmed');
    assert.ok((warned.warnings as string[]).some(w => /not confirmed/.test(w)));
  } finally { if (prior !== undefined) process.env.AGENT_SMITH_CONFIRM_UNRESTRICTED = prior; }
});

test('status validates concise and detailed, for every lifecycle, with wait_ms and include_diff', async () => {
  writeAcceptance(repo, 'job-1', { state: 'accepted', checks: [{ name: 'tests', ok: true, exitCode: 0, durationMs: 5, outputTail: 'ok', blocking: true, timedOut: false, signal: null }, { name: 'lint', ok: false, exitCode: 1, durationMs: 5, outputTail: 'bad', blocking: false, timedOut: false, signal: null }], at: '2026-10-11T09:06:00.000Z' });
  writeAcceptance(repo, 'job-2', { state: 'unchecked', checks: [], pending: true });
  for (const d of details) {
    for (const response_format of ['concise', 'detailed']) {
      const label = `status ${d.jobId} ${response_format}`;
      const out = assertValid('status', await callTool(ctx, 'status', { jobId: d.jobId, response_format }), label);
      assert.equal(out.taskStatus, { running: 'working', unknown: 'working', succeeded: 'completed', failed: 'failed' }[d.status as string], label);
      assertValid('status', await callTool(ctx, 'status', { jobId: d.jobId, response_format, include_diff: true }), `${label} include_diff`);
    }
  }
  const waited = assertValid('status', await callTool({ ...ctx, pollMs: 1 }, 'status', { jobId: 'job-2', wait_ms: 5 }), 'status wait_ms');
  assert.deepEqual([waited.waited, waited.stillRunning], [true, true]);
});

test('list_jobs validates concise (bare and cut) and detailed', async () => {
  const concise = assertValid('list_jobs', await callTool(ctx, 'list_jobs', {}), 'list_jobs concise');
  assert.equal((concise.items as unknown[]).length, details.length); assert.equal(concise.more, undefined);
  const cut = assertValid('list_jobs', await callTool(ctx, 'list_jobs', { limit: 2 }), 'list_jobs concise cut');
  assert.equal((cut.items as unknown[]).length, 2); assert.equal(typeof cut.more, 'string');
  const detailed = assertValid('list_jobs', await callTool(ctx, 'list_jobs', { response_format: 'detailed' }), 'list_jobs detailed');
  assert.deepEqual((detailed.items as { taskStatus: string }[]).map(r => r.taskStatus), ['completed', 'working', 'working', 'failed']);
  assert.deepEqual((concise.items as { taskStatus: string }[]).map(r => r.taskStatus), ['completed', 'working', 'working', 'failed']);
});

test('list_jobs concise rows validate digest, acceptance, changedFileCount and stalled', async () => {
  const rich: JobSummary = {
    ...summary, jobId: 'job-4', name: 'Dee', status: 'running', finishedAt: null,
    updatedAt: '2026-10-11T09:00:00.000Z', changedFileCount: 2,
    digest: { phase: 'testing', filesRead: 3, searches: 1, edited: ['src/a.ts', 'src/b.ts'], editedCount: 2, commands: 2, testRuns: 1, lastTestFailed: true, repeat: null },
    acceptance: { state: 'rejected', checks: [{ name: 'tests', ok: false, exitCode: 1, durationMs: 5, outputTail: 'bad', blocking: true, timedOut: false, signal: null }], at: '2026-10-11T09:06:00.000Z' },
  };
  const listService = { repo, spawnedIds: new Set<string>(), list: async () => [rich] };
  const out = assertValid('list_jobs', await callTool({ ...ctx, service: listService as never }, 'list_jobs', {}), 'list_jobs fleet row');
  const row = (out.items as Record<string, unknown>[])[0]!;
  assert.equal(row.stalled, true);
  assert.equal(row.changedFileCount, 2);
  assert.deepEqual(row.acceptance, { state: 'rejected', failed: ['tests'] });
  assert.deepEqual(row.digest, { phase: 'testing', filesRead: 3, edited: ['src/a.ts', 'src/b.ts'], editedCount: 2, testRuns: 1, lastTestFailed: true });
});

test('list_capabilities validates with installed, errored and uninstalled providers', async () => {
  const caps = assertValid('list_capabilities', await callTool(ctx, 'list_capabilities', {}), 'list_capabilities');
  assert.ok((caps.providers as { available: boolean }[]).some(p => !p.available));
  assertValid('list_capabilities', await callTool({ ...ctx, catalogs: async () => [] }, 'list_capabilities', {}), 'list_capabilities none installed');
  assertValid('list_capabilities', await callTool(ctx, 'list_capabilities', { response_format: 'detailed' }), 'list_capabilities detailed');
});

test('resume_job and steer_job acks validate against their outputSchemas', async () => {
  const resumed = assertValid('resume_job', await callTool(ctx, 'resume_job', { worker: 'job-1', prompt: 'Continue.' }), 'resume_job');
  assert.equal(resumed.jobId, 'job-1');
  const steered = assertValid('steer_job', await callTool(ctx, 'steer_job', { worker: 'job-2', prompt: 'Pivot.', delivery: 'interrupt' }), 'steer_job');
  assert.equal(steered.status, 'interrupting');
});

test('a schema violation is caught (the harness can fail)', () => {
  const schema = TOOL_DEFS.find(t => t.name === 'status')!.outputSchema!;
  assert.equal(validator.getValidator(schema as never)({ jobId: 'j', status: 'done', taskStatus: 'working' }).valid, false);
  assert.equal(validator.getValidator(schema as never)({ jobId: 'j', status: 'running' }).valid, false);
});
