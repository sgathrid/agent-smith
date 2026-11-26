import assert from 'node:assert/strict';
import test from 'node:test';
import type { JobDetail, JobSummary } from '../../../../forge/summary.ts';
import type { Acceptance } from '../../../../forge/checks.ts';
import { conciseRow, conciseStatus, earlierTurn } from '../views.ts';
import { TOOL_DEFS, callTool, type HandlerContext } from '../tools.ts';
import type { MessageAck } from '../../../../forge/service.ts';
import { withWorkerLookup } from './service-mock.ts';

const NOW = Date.parse('2026-11-23T21:40:00.000Z');
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString();
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

const FORBIDDEN_ROW_FIELDS = [
  'workerId', 'taskStatus', 'chainStartedAt', 'startedAt',
  'continuedFrom', 'continuationKind', 'supersededBy', 'followedBy',
] as const;

function makeSummary(i: number, extra: Partial<JobSummary> = {}): JobSummary {
  return {
    jobId: `implement-smith-${i}`,
    name: `worker-${i}`,
    workerId: `w-${i}`,
    turn: 1,
    role: 'implement',
    latestSummary: 'Implemented view budgets and added tests.',
    summarySource: 'worker',
    status: 'succeeded',
    provider: 'codex',
    mode: 'implement',
    model: 'gpt-5.4',
    task: 'Implement view budgets',
    toolCalls: 9,
    currentActivity: null,
    lastActivity: { stepIndex: 9, tool: 'Edit', input: 'the-codes/surfaces/channel/src/views.ts', status: 'done' },
    startedAt: isoAgo(90_000),
    updatedAt: isoAgo(15_000),
    finishedAt: isoAgo(15_000),
    warnings: [],
    ...extra,
  };
}

function makeDetail(i: number, extra: Partial<JobDetail> & { resolvedFrom?: string | null } = {}): JobDetail & { resolvedFrom?: string | null } {
  return {
    ...makeSummary(i),
    report: 'Completed the requested changes and ran the targeted tests.',
    error: null,
    exitCode: 0,
    unrestricted: false,
    pipeline: null,
    stage: null,
    usage: { input: 1000, output: 200 },
    conversation: 'conv-1',
    effort: 'medium',
    cwd: '/repo',
    cancellable: false,
    ...extra,
  };
}

test('conciseRow: settled row shape and <= 450 byte budget with a full-length summary', () => {
  const row = conciseRow(makeSummary(1, {
    latestSummary: 'word '.repeat(60),
    turn: 2,
    changedFileCount: 3,
    continuedFrom: 'implement-smith-0',
    continuationKind: 'follow-up',
    supersededBy: null,
    chainStartedAt: isoAgo(120_000),
    acceptance: { state: 'accepted', checks: [{ name: 'tests', ok: true, exitCode: 0, durationMs: 10, outputTail: '', blocking: true, timedOut: false, signal: null }] },
  }), NOW) as Record<string, unknown>;

  const b = bytes(row);
  console.log(`settled row bytes: ${b}`);
  assert.ok(b <= 450, `settled row ${b} bytes > 450: ${JSON.stringify(row)}`);
  assert.equal(row.turn, 2);
  assert.equal(row.durationMs, 75_000);
  assert.equal(row.changedFileCount, 3);
  assert.deepEqual(row.acceptance, { state: 'accepted', passed: ['tests'] });
  for (const k of [...FORBIDDEN_ROW_FIELDS, 'liveness', 'lastActivity', 'digest', 'elapsedMs', 'toolCalls', 'pendingMessages']) {
    assert.equal(k in row, false, `unexpected field in settled row: ${k}`);
  }

  const turn1ZeroFiles = conciseRow(makeSummary(2, {
    turn: 1,
    changedFileCount: 0,
    latestSummary: 'word '.repeat(60),
  }), NOW) as Record<string, unknown>;
  assert.equal('turn' in turn1ZeroFiles, false);
  assert.equal('changedFileCount' in turn1ZeroFiles, false);
  assert.ok((turn1ZeroFiles.summary as string).length <= 160);

  const failedRow = conciseRow(makeSummary(3, {
    status: 'failed',
    reason: 'timed out',
    resumable: true,
  }), NOW) as Record<string, unknown>;
  assert.equal(failedRow.reason, 'timed out');
  assert.equal(failedRow.resumable, true);
});

test('conciseRow: running row shape and <= 480 byte budget', () => {
  const row = conciseRow(makeSummary(2, {
    turn: 2,
    status: 'running',
    finishedAt: null,
    pendingSteers: 2,
    lastEventAt: isoAgo(5_000),
    lastAliveAt: isoAgo(2_000),
    lastActivity: { stepIndex: 14, tool: 'Edit', input: 'the-codes/surfaces/channel/src/views.ts', status: 'active' },
    digest: {
      phase: 'editing', filesRead: 5, searches: 2,
      edited: ['views.ts', 'budget.test.ts'], editedCount: 2,
      commands: 1, testRuns: 0, lastTestFailed: false, repeat: null,
    },
  }), NOW) as Record<string, unknown>;

  const b = bytes(row);
  console.log(`running row bytes: ${b}`);
  assert.ok(b <= 480, `running row ${b} bytes > 480: ${JSON.stringify(row)}`);
  assert.equal(row.turn, 2);
  assert.equal(row.elapsedMs, 90_000);
  assert.equal(row.toolCalls, 9);
  assert.equal(row.pendingMessages, 2);
  assert.equal((row.liveness as { state: string }).state, 'in-tool');
  for (const k of [...FORBIDDEN_ROW_FIELDS, 'finishedAt', 'durationMs', 'summary', 'acceptance', 'changedFileCount']) {
    assert.equal(k in row, false, `unexpected field in running row: ${k}`);
  }
});

test('conciseRow: 20-row list <= 8.5 KB budget with full-length summaries', () => {
  const rows = Array.from({ length: 20 }, (_, idx) => {
    const i = idx + 1;
    if (i <= 4) {
      return conciseRow(makeSummary(i, {
        turn: 2,
        status: 'running',
        finishedAt: null,
        pendingSteers: i === 1 ? 1 : 0,
        lastEventAt: isoAgo(5_000),
        lastAliveAt: isoAgo(2_000),
        digest: { phase: 'editing', filesRead: 3, searches: 1, edited: ['views.ts'], editedCount: 1, commands: 0, testRuns: 0, lastTestFailed: false, repeat: null },
      }), NOW);
    }
    return conciseRow(makeSummary(i, {
      latestSummary: 'word '.repeat(60),
      changedFileCount: 2,
      acceptance: { state: 'accepted', checks: [{ name: 'tests', ok: true, exitCode: 0, durationMs: 10, outputTail: '', blocking: true, timedOut: false, signal: null }] },
    }), NOW);
  });

  const b = bytes(rows);
  console.log(`20-row list bytes: ${b}`);
  assert.ok(b <= 8704, `20-row list ${b} bytes > 8704`);
});

test('conciseStatus + earlierTurn: 4-turn status overhead (report text excluded) <= 1.6 KB', () => {
  const earlier = [1, 2, 3].map(t => makeDetail(t, {
    turn: t,
    latestSummary: t < 3 ? `Turn ${t} completed its piece of the work. `.repeat(4) : null,
    report: t === 3 ? '\nFirst line of turn 3 report should become summary.\nSecond line ignored.' : `Full report for turn ${t}.`,
  }));
  const head = makeDetail(4, {
    turn: 4,
    resolvedFrom: 'worker-4',
    report: 'Head turn report: '.repeat(120),
  });
  const acceptance: Acceptance = { state: 'unchecked', checks: [], pending: true, running: 'tests' };
  const payload = {
    ...conciseStatus(head, acceptance),
    reportPath: '/repo/.agent-smith/jobs/implement-smith-4/result.md',
    earlierTurns: earlier.map(t => earlierTurn(t, `/repo/.agent-smith/jobs/${t.jobId}/result.md`, 'concise')),
  };

  const b = bytes({ ...payload, report: '' });
  console.log(`4-turn status bytes (without report text): ${b}`);
  assert.ok(b <= Math.floor(1.6 * 1024), `4-turn status ${b} bytes > 1638: ${JSON.stringify(payload)}`);

  assert.equal(payload.jobId, 'implement-smith-4');
  assert.equal(payload.workerId, 'w-4');
  assert.equal(payload.name, 'worker-4');
  assert.equal(payload.status, 'succeeded');
  assert.equal(payload.turn, 4);
  assert.equal(payload.resolvedFrom, 'worker-4');
  assert.equal('supersededBy' in payload, false);
  assert.deepEqual(payload.acceptance, { state: 'unchecked', pending: true, running: 'tests' });

  for (const et of payload.earlierTurns) {
    assert.ok((et.summary as string).length <= 120);
    assert.equal('report' in et, false);
    assert.equal('reportPath' in et, false);
  }
  assert.equal(payload.earlierTurns[2]!.summary, 'First line of turn 3 report should become summary.');

  const detailedEarlier = earlierTurn(earlier[2]!, '/repo/.agent-smith/jobs/implement-smith-3/result.md', 'detailed') as Record<string, unknown>;
  assert.equal(detailedEarlier.report, earlier[2]!.report);
  assert.equal(detailedEarlier.reportPath, '/repo/.agent-smith/jobs/implement-smith-3/result.md');
});

test('conciseStatus: a failed turn keeps why it failed; a running turn keeps liveness', () => {
  const failed = conciseStatus(makeDetail(9, { status: 'failed', error: 'provider exited 1: auth expired', warnings: [{ code: 'tool_error', message: 'auth expired' }], conversation: 'conv-9' }), null) as Record<string, unknown>;
  assert.ok(typeof failed.error === 'string' && (failed.error as string).includes('auth expired'));
  assert.equal(failed.reason, 'exit 1');
  assert.equal(failed.resumable, true);
  assert.equal(failed.provider, 'codex');
  const running = conciseStatus(makeDetail(10, { status: 'running', finishedAt: null, lastEventAt: isoAgo(5_000), lastAliveAt: isoAgo(2_000), lastActivity: { stepIndex: 3, tool: 'Edit', input: 'a.ts', status: 'active' } }), null, {}, NOW) as Record<string, unknown>;
  assert.ok(running.liveness, 'running status carries liveness');
  assert.ok(running.lastActivity, 'running status carries lastActivity');
  const long = conciseStatus(makeDetail(11, { report: 'x'.repeat(5_000) }), null) as Record<string, unknown>;
  assert.ok((long.report as string).startsWith('x'.repeat(2_000)));
});

test('tool descriptions + input schemas: <= 14,000 chars across all tools (Claude reads them every session)', () => {
  const chars = (t: (typeof TOOL_DEFS)[number]) => t.description.length + JSON.stringify(t.inputSchema).length;
  const per = Object.fromEntries(TOOL_DEFS.map(t => [t.name, chars(t)]));
  const total = Object.values(per).reduce((a, b) => a + b, 0);
  console.log(`tool text chars: ${total} ${JSON.stringify(per)}`);
  assert.ok(total <= 14_000, `tool descriptions + input schemas ${total} chars > 14000: ${JSON.stringify(per)}`);
});

test('follow_up / steer ack: compact JSON <= 400 bytes with realistic content', async () => {
  const repo = '/Users/someone/Repos/some-project-with-a-long-name';
  const base: MessageAck = {
    jobId: 'implement-smith-3f9a2c71', name: 'parser-refactor', workerId: 'implement-smith-0b7e41d9', turn: 3,
    action: 'queued', delivery: 'turn-end', status: 'running', provider: 'codex', repo, timeoutMs: 2_700_000, pendingMessages: 2,
  };
  const acks: Record<string, MessageAck> = {
    queued: { ...base, checks: ['unit-tests', 'typecheck'], env: 'kept', note: 'Queued; runs when this turn ends.' },
    live: { ...base, delivery: 'next-step', note: 'Sent into the running turn; read at its next step.' },
    started: { ...base, action: 'started', delivery: 'now', pendingMessages: undefined, checks: ['unit-tests', 'typecheck'], env: 'set', note: 'Started turn 3.' },
    steer: { ...base, action: 'interrupting', delivery: 'now', pendingMessages: 1, note: 'Interrupting; the steered turn starts next.' },
  };
  for (const [label, ack] of Object.entries(acks)) {
    const tool = label === 'steer' ? 'steer' : 'follow_up';
    const service = withWorkerLookup({ repo, followUp: async () => ack, steer: async () => ack });
    const r = await callTool({ service: service as never, catalogs: async () => [] } as HandlerContext, tool, { worker: 'parser-refactor', prompt: 'Next.' });
    const text = (r.content as { text: string }[])[0]!.text;
    const b = Buffer.byteLength(text, 'utf8');
    console.log(`${label} ack bytes: ${b} ${text}`);
    assert.ok(b <= 400, `${label} ack ${b} bytes > 400: ${text}`);
  }
});
