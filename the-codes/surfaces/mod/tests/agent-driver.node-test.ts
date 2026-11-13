/** Tests for the pure subagent turn.step driver logic. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyTailRecord,
  coordinatorMessages,
  formatProgress,
  MAX_STATUS_WAIT_MS,
  splitLines,
  statusPollState,
  stepLines,
  nextStep,
  parseHeader,
  WAIT_MS,
  type DriverInput,
  type DriverMessage,
  type DriverToolUse,
  type TailState,
} from '../hooks/agent-driver.ts';

const PREFIX = 'mcp__plugin_agent-smith_agent-smith__';

function user(text: string): DriverMessage {
  return { role: 'user', text, toolUses: [] };
}

function assistant(toolUses: DriverToolUse[], text = ''): DriverMessage {
  return { role: 'assistant', text, toolUses };
}

function baseInput(
  messages: DriverMessage[],
  overrides: Partial<Omit<DriverInput, 'messages'>> = {},
): DriverInput {
  return {
    messages,
    toolPrefix: PREFIX,
    defaults: { provider: 'codex', model: 'gpt-5' },
    agentName: 'codex',
    ...overrides,
  };
}

test('parseHeader extracts case-insensitive leading headers and stops at first non-header', () => {
  const cases = [
    {
      name: 'plain prompt without headers',
      raw: 'Fix the failing test in foo.ts',
      headers: {},
      prompt: 'Fix the failing test in foo.ts',
    },
    {
      name: 'all supported headers, mixed case, separated by blank line',
      raw: [
        'Mode: review',
        'MODEL: o3',
        'effort: high',
        'Cwd: /abs/repo',
        'Provider: claude',
        '',
        'Review the diff carefully.',
        'model: should-stay-in-body',
      ].join('\n'),
      headers: {
        mode: 'review',
        model: 'o3',
        effort: 'high',
        cwd: '/abs/repo',
        provider: 'claude',
      },
      prompt: 'Review the diff carefully.\nmodel: should-stay-in-body',
    },
    {
      name: 'headers immediately followed by body without blank line',
      raw: 'mode: implement\nAdd unit tests',
      headers: { mode: 'implement' },
      prompt: 'Add unit tests',
    },
    {
      name: 'non-header line first leaves later header-like lines untouched',
      raw: 'Please do this:\nmode: review\nThanks',
      headers: {},
      prompt: 'Please do this:\nmode: review\nThanks',
    },
  ];

  for (const c of cases) {
    const parsed = parseHeader(c.raw);
    assert.deepEqual(parsed.headers, c.headers, c.name);
    assert.equal(parsed.prompt, c.prompt, c.name);
  }
});

test('coordinatorMessages extracts SendMessage bodies from user system-reminders only', () => {
  const messages: DriverMessage[] = [
    user('Initial task'),
    user('<system-reminder>\nUnrelated hook note.\n</system-reminder>'),
    assistant([], '<system-reminder>\nThe coordinator sent a message while you were working:\nIgnored assistant text\n</system-reminder>'),
    user(
      '<system-reminder>\nThe coordinator sent a message while you were working:\nFocus on tests first.\n</system-reminder>\n' +
      '<system-reminder>The coordinator sent a message while you were working: Also check types.</system-reminder>',
    ),
    user('<system-reminder>\nThe coordinator sent a message while you were working:\n\nKeep it small.\n</system-reminder>'),
  ];

  assert.deepEqual(coordinatorMessages(messages), [
    'Focus on tests first.',
    'Also check types.',
    'Keep it small.',
  ]);
});

test('Rule 1: no spawn_job yet spawns with merged defaults, headers, and progress text', () => {
  const cases = [
    {
      name: 'headers override defaults',
      input: baseInput([user('mode: review\nprovider: claude\nmodel: opus\neffort: high\ncwd: /tmp/w\n\nAudit auth')]),
      expectedText: 'Starting claude/opus…',
      expectedInput: {
        mode: 'review',
        prompt: 'Audit auth',
        provider: 'claude',
        model: 'opus',
        effort: 'high',
        cwd: '/tmp/w',
      },
    },
    {
      name: 'uses defaults and default mode implement',
      input: baseInput([user('Implement feature X')], { defaults: { provider: 'codex' } }),
      expectedText: 'Starting codex…',
      expectedInput: {
        mode: 'implement',
        prompt: 'Implement feature X',
        provider: 'codex',
      },
    },
    {
      name: 'model only',
      input: baseInput([user('Do work')], { defaults: { model: 'o3' } }),
      expectedText: 'Starting o3…',
      expectedInput: { mode: 'implement', prompt: 'Do work', model: 'o3' },
    },
    {
      name: 'no provider or model falls back to worker',
      input: baseInput([user('Do work')], { defaults: {} }),
      expectedText: 'Starting worker…',
      expectedInput: { mode: 'implement', prompt: 'Do work' },
    },
  ];

  for (const c of cases) {
    const step = nextStep(c.input);
    assert.equal(step.text, c.expectedText, c.name);
    assert.equal(step.tool?.name, `${PREFIX}spawn_job`, c.name);
    const { name, ...rest } = step.tool!.input;
    assert.equal(typeof name, 'string', c.name);
    assert.ok((name as string).startsWith('codex-'), c.name);
    assert.deepEqual(rest, c.expectedInput, c.name);
  }
});

test('Rule 2: failed spawn or missing jobId hands back Status: BLOCKED', () => {
  const cases = [
    {
      name: 'spawn tool isError',
      spawn: { id: 's1', name: `${PREFIX}spawn_job`, input: {}, isError: true, resultText: 'Unknown provider' },
      expectedMsg: 'Status: BLOCKED\nUnknown provider',
    },
    {
      name: 'spawn result missing jobId',
      spawn: { id: 's1', name: `${PREFIX}spawn_job`, input: {}, resultText: JSON.stringify({ error: 'No capacity' }) },
      expectedMsg: 'Status: BLOCKED\nNo capacity',
    },
    {
      name: 'spawn result invalid JSON',
      spawn: { id: 's1', name: `${PREFIX}spawn_job`, input: {}, resultText: 'gateway timeout' },
      expectedMsg: 'Status: BLOCKED\ngateway timeout',
    },
  ];

  for (const c of cases) {
    const step = nextStep(baseInput([user('Task'), assistant([c.spawn])]));
    assert.equal(step.tool?.name, 'SubagentHandback', c.name);
    assert.equal(step.tool?.input.message, c.expectedMsg, c.name);
  }
});

test('Rule 3: coordinator messages steer once per message and skip when job is terminal', () => {
  const spawnAck = JSON.stringify({ jobId: 'job-1', status: 'running' });
  const steer = (prompt: string): DriverToolUse => ({
    id: 'st',
    name: `${PREFIX}steer_job`,
    input: { worker: 'job-1', prompt, delivery: 'queue' },
    resultText: JSON.stringify({ jobId: 'job-1', status: 'queued' }),
  });

  const cases = [
    {
      name: 'new coordinator message triggers steer_job',
      messages: [
        user('Task'),
        assistant([{ id: 's1', name: `${PREFIX}spawn_job`, input: {}, resultText: spawnAck }]),
        user('<system-reminder>\nThe coordinator sent a message while you were working:\nUse strict mode.\n</system-reminder>'),
      ],
      expectedTool: `${PREFIX}steer_job`,
      expectedInput: { worker: 'job-1', prompt: 'Use strict mode.', delivery: 'queue' },
    },
    {
      name: 'already-steered message is deduplicated and falls through to status',
      messages: [
        user('Task'),
        assistant([{ id: 's1', name: `${PREFIX}spawn_job`, input: {}, resultText: spawnAck }]),
        user('<system-reminder>\nThe coordinator sent a message while you were working:\nUse strict mode.\n</system-reminder>'),
        assistant([steer('Use strict mode.')]),
      ],
      expectedTool: `${PREFIX}status`,
      expectedInput: { jobId: 'job-1', wait_ms: 20000 },
    },
    {
      name: 'duplicate message text sent a second time is steered again',
      messages: [
        user('Task'),
        assistant([{ id: 's1', name: `${PREFIX}spawn_job`, input: {}, resultText: spawnAck }]),
        user('<system-reminder>\nThe coordinator sent a message while you were working:\nPing.\n</system-reminder>'),
        assistant([steer('Ping.')]),
        user('<system-reminder>\nThe coordinator sent a message while you were working:\nPing.\n</system-reminder>'),
      ],
      expectedTool: `${PREFIX}steer_job`,
      expectedInput: { worker: 'job-1', prompt: 'Ping.', delivery: 'queue' },
    },
    {
      name: 'coordinator message after the job finished is sent as a resume, not dropped',
      messages: [
        user('Task'),
        assistant([
          { id: 's1', name: `${PREFIX}spawn_job`, input: {}, resultText: spawnAck },
          { id: 'st1', name: `${PREFIX}status`, input: { jobId: 'job-1', wait_ms: 20000 }, resultText: JSON.stringify({ jobId: 'job-1', status: 'succeeded' }) },
        ]),
        user('<system-reminder>\nThe coordinator sent a message while you were working:\nToo late.\n</system-reminder>'),
      ],
      expectedTool: `${PREFIX}resume_job`,
      expectedInput: { worker: 'job-1', prompt: 'Too late.' },
    },
  ];

  for (const c of cases) {
    const step = nextStep(baseInput(c.messages));
    assert.equal(step.tool?.name, c.expectedTool, c.name);
    assert.deepEqual(step.tool?.input, c.expectedInput, c.name);
  }
});

test('Rule 4 & job-ID following: running status and jobId change after steer', () => {
  const spawnAck = JSON.stringify({ jobId: 'job-1', status: 'running' });
  const runningStatus = JSON.stringify({
    jobId: 'job-2',
    status: 'running',
    toolCalls: 4,
    lastActivity: 'Editing src/app.ts',
    digest: { phase: 'editing' },
  });

  const stepFromAck = nextStep(baseInput([
    user('Task'),
    assistant([{ id: 's1', name: `${PREFIX}spawn_job`, input: {}, resultText: spawnAck }]),
  ]));
  assert.equal(stepFromAck.text, 'Waiting on worker…');
  assert.deepEqual(stepFromAck.tool, { name: `${PREFIX}status`, input: { jobId: 'job-1', wait_ms: 20000 } });

  const stepAfterSteerRedirect = nextStep(baseInput([
    user('Task'),
    assistant([
      { id: 's1', name: `${PREFIX}spawn_job`, input: {}, resultText: spawnAck },
      { id: 'st1', name: `${PREFIX}status`, input: { jobId: 'job-1', wait_ms: 20000 }, resultText: runningStatus },
    ]),
  ]));
  assert.equal(stepAfterSteerRedirect.text, 'editing · 4 tool calls · Editing src/app.ts');
  assert.deepEqual(stepAfterSteerRedirect.tool, {
    name: `${PREFIX}status`,
    input: { jobId: 'job-2', wait_ms: 20000 },
  });
});

test('Rules 4 -> 5 -> 6: acceptance pending, then accepted, then report handback', () => {
  const spawnAck = JSON.stringify({ jobId: 'job-1', status: 'running' });
  const pendingStatus = JSON.stringify({
    jobId: 'job-1',
    status: 'succeeded',
    acceptance: { state: 'unchecked', pending: true },
  });
  const acceptedStatus = JSON.stringify({
    jobId: 'job-1',
    status: 'succeeded',
    acceptance: { state: 'accepted', passed: ['typecheck', 'tests'], failed: [] },
  });
  const reportResult = JSON.stringify({
    jobId: 'job-1',
    status: 'succeeded',
    report: 'Status: DONE\nImplemented the feature.',
  });

  // Step A: acceptance.pending -> Rule 4 waits
  const stepPending = nextStep(baseInput([
    user('Task'),
    assistant([
      { id: 's1', name: `${PREFIX}spawn_job`, input: {}, resultText: spawnAck },
      { id: 'st1', name: `${PREFIX}status`, input: { jobId: 'job-1', wait_ms: 20000 }, resultText: pendingStatus },
    ]),
  ]));
  assert.equal(stepPending.text, 'Waiting for acceptance checks…');
  assert.deepEqual(stepPending.tool, { name: `${PREFIX}status`, input: { jobId: 'job-1', wait_ms: 20000 } });

  // Step B: acceptance settled -> Rule 5 fetches report_only
  const stepFetchReport = nextStep(baseInput([
    user('Task'),
    assistant([
      { id: 's1', name: `${PREFIX}spawn_job`, input: {}, resultText: spawnAck },
      { id: 'st1', name: `${PREFIX}status`, input: { jobId: 'job-1', wait_ms: 20000 }, resultText: pendingStatus },
      { id: 'st2', name: `${PREFIX}status`, input: { jobId: 'job-1', wait_ms: 20000 }, resultText: acceptedStatus },
    ]),
  ]));
  assert.deepEqual(stepFetchReport.tool, { name: `${PREFIX}status`, input: { jobId: 'job-1', report_only: true } });

  // Step C: report fetched -> Rule 6 hands back report + acceptance line
  const stepHandback = nextStep(baseInput([
    user('Task'),
    assistant([
      { id: 's1', name: `${PREFIX}spawn_job`, input: {}, resultText: spawnAck },
      { id: 'st2', name: `${PREFIX}status`, input: { jobId: 'job-1', wait_ms: 20000 }, resultText: acceptedStatus },
      { id: 'r1', name: `${PREFIX}status`, input: { jobId: 'job-1', report_only: true }, resultText: reportResult },
    ]),
  ]));
  assert.equal(stepHandback.tool?.name, 'SubagentHandback');
  assert.equal(
    stepHandback.tool?.input.message,
    'Status: DONE\nImplemented the feature.\nAcceptance: accepted (2/2 checks)',
  );
});

test('Rule 6: handback formatting for rejected acceptance, failed jobs, and unchecked jobs', () => {
  const spawnAck = JSON.stringify({ jobId: 'job-1', status: 'running' });

  const cases = [
    {
      name: 'succeeded with rejected acceptance names failed checks',
      status: { jobId: 'job-1', status: 'succeeded', acceptance: { state: 'rejected', passed: ['lint'], failed: ['test'] } },
      report: { jobId: 'job-1', status: 'succeeded', report: 'Done with edits.' },
      expected: 'Done with edits.\nAcceptance: rejected (1/2 checks; failed: test)',
    },
    {
      name: 'succeeded with unchecked acceptance omits acceptance line',
      status: { jobId: 'job-1', status: 'succeeded', acceptance: { state: 'unchecked' } },
      report: { jobId: 'job-1', status: 'succeeded', report: 'All good.' },
      expected: 'All good.',
    },
    {
      name: 'failed job without Status prefix gets Status: BLOCKED and error text',
      status: { jobId: 'job-1', status: 'failed', error: 'Exit code 1' },
      report: { jobId: 'job-1', status: 'failed', report: 'Partial output.' },
      expected: 'Status: BLOCKED\nPartial output.\nError: Exit code 1',
    },
    {
      name: 'failed job whose report already starts with Status: keeps single Status prefix',
      status: { jobId: 'job-1', status: 'failed', error: 'Build broke' },
      report: { jobId: 'job-1', status: 'failed', report: 'Status: BLOCKED\nBuild broke' },
      expected: 'Status: BLOCKED\nBuild broke',
    },
  ];

  for (const c of cases) {
    const step = nextStep(baseInput([
      user('Task'),
      assistant([
        { id: 's1', name: `${PREFIX}spawn_job`, input: {}, resultText: spawnAck },
        { id: 'st1', name: `${PREFIX}status`, input: { jobId: 'job-1', wait_ms: 20000 }, resultText: JSON.stringify(c.status) },
        { id: 'r1', name: `${PREFIX}status`, input: { jobId: 'job-1', report_only: true }, resultText: JSON.stringify(c.report) },
      ]),
    ]));
    assert.equal(step.tool?.name, 'SubagentHandback', c.name);
    assert.equal(step.tool?.input.message, c.expected, c.name);
  }
});

test('live shape: reminders around the task and after the spawn ack do not hide headers or the job', () => {
  const REM = '<system-reminder id="abc">\nYour final report is delivered through SubagentHandback.\n</system-reminder id="abc">';
  const task = `${REM}\nmode: review\nmodel: gemini-4-hydrogen\n\nRead the driver.`;
  const first = nextStep(baseInput([user(task)], { defaults: { provider: 'agy' }, agentName: 'agy' }));
  assert.equal(first.tool?.name, `${PREFIX}spawn_job`);
  assert.equal((first.tool!.input as { mode: string }).mode, 'review');
  assert.equal((first.tool!.input as { model: string }).model, 'gemini-4-hydrogen');
  assert.equal((first.tool!.input as { prompt: string }).prompt, 'Read the driver.');
  const ack = '{"jobId":"job-1","name":"agy-1","status":"running"}\n\n<system-reminder>\n# MCP Server Instructions\n{ not json }\n</system-reminder>';
  const next = nextStep(baseInput([user(task), assistant([{ id: 't1', name: `${PREFIX}spawn_job`, input: first.tool!.input, resultText: ack }])], { defaults: { provider: 'agy' }, agentName: 'agy' }));
  assert.equal(next.tool?.name, `${PREFIX}status`);
  assert.deepEqual(next.tool?.input, { jobId: 'job-1', wait_ms: 20000 });
});

test('review findings: failed report read, ack without status, failed steer, and following a resume', () => {
  const ack = JSON.stringify({ jobId: 'job-1', name: 'w' });
  const spawn = { id: 's1', name: `${PREFIX}spawn_job`, input: {}, resultText: ack };
  // An ack with no status is a job that just started: wait on it.
  assert.deepEqual(nextStep(baseInput([user('Task'), assistant([spawn])])).tool?.input, { jobId: 'job-1', wait_ms: 20000 });
  // A failed report read is BLOCKED with the error, not "(no report)".
  const done = { id: 'st', name: `${PREFIX}status`, input: { jobId: 'job-1', wait_ms: 20000 }, resultText: JSON.stringify({ jobId: 'job-1', status: 'succeeded' }) };
  const badReport = { id: 'r', name: `${PREFIX}status`, input: { jobId: 'job-1', report_only: true }, isError: true, resultText: 'timeout' };
  const blocked = nextStep(baseInput([user('Task'), assistant([spawn, done, badReport])]));
  assert.equal(blocked.tool?.name, 'SubagentHandback');
  assert.match(String((blocked.tool!.input as { message: string }).message), /^Status: BLOCKED\ntimeout/);
  // A steer that failed did not deliver: the message is still pending.
  const running = { ...done, resultText: JSON.stringify({ jobId: 'job-1', status: 'running' }) };
  const msg = user('<system-reminder>\nThe coordinator sent a message while you were working:\nRetry me.\n</system-reminder>');
  const failedSteer = { id: 'x', name: `${PREFIX}steer_job`, input: { worker: 'job-1', prompt: 'Retry me.', delivery: 'queue' }, isError: true, resultText: 'failed' };
  assert.equal(nextStep(baseInput([user('Task'), assistant([spawn, running]), msg, assistant([failedSteer])])).tool?.name, `${PREFIX}steer_job`);
  // After a resume, the driver waits on the resumed turn.
  const late = user('<system-reminder>\nThe coordinator sent a message while you were working:\nOne more.\n</system-reminder>');
  const resume = { id: 'rs', name: `${PREFIX}resume_job`, input: { worker: 'job-1', prompt: 'One more.' }, resultText: JSON.stringify({ jobId: 'job-2', status: 'running' }) };
  assert.deepEqual(nextStep(baseInput([user('Task'), assistant([spawn, done]), late, assistant([resume])])).tool?.input, { jobId: 'job-2', wait_ms: 20000 });
});

test('progress: a readable line from the digest and latest step, and only when it changed', () => {
  const st = { status: 'running', toolCalls: 4, digest: { phase: 'exploring', filesRead: 3 }, lastActivity: 'step 4: read_file {"Path":"/r/the-codes/agent-driver.ts"} (done)' };
  assert.equal(formatProgress(st), 'exploring · 3 files read · 4 tool calls · read_file agent-driver.ts');
  const ack = JSON.stringify({ jobId: 'job-1', status: 'running' });
  const s1 = { id: 's1', name: `${PREFIX}spawn_job`, input: {}, resultText: ack };
  const w = (id: string) => ({ id, name: `${PREFIX}status`, input: { jobId: 'job-1', wait_ms: 20000 }, resultText: JSON.stringify(st) });
  const first = nextStep(baseInput([user('Task'), assistant([s1]), assistant([w('a')])]));
  assert.equal(first.text, formatProgress(st));
  const again = nextStep(baseInput([user('Task'), assistant([s1]), assistant([w('a')], first.text), assistant([w('b')])]));
  assert.equal(again.text, '');
});

test('stepLines: one line per finished step, in order, never twice, holding back a running call', () => {
  const label = (tool: string, input: string) => `${tool.toLowerCase()} ${input}`;
  const events = [
    { sequence: 2, kind: 'tool' as const, tool: 'Read', input: 'AGENTS.md', state: 'done' },
    { sequence: 1, kind: 'assistant' as const, text: 'Looking at the versions.' },
    { sequence: 3, kind: 'tool' as const, tool: 'Bash', input: 'npm test', state: 'error' },
    { sequence: 4, kind: 'tool' as const, tool: 'Read', input: 'b.ts', state: 'active' },
  ];
  const first = stepLines(events, 0, label);
  assert.deepEqual(first.lines, ['Looking at the versions.', 'Read AGENTS.md', '✗ Bash npm test']);
  assert.equal(first.last, 3);
  assert.deepEqual(stepLines(events, first.last, label).lines, []);
  const done = events.map((e) => (e.sequence === 4 ? { ...e, state: 'done' } : e));
  assert.deepEqual(stepLines(done, first.last, label).lines, ['Read b.ts']);
});

test('splitLines: multiple lines per chunk, split across chunks, trailing partial, and CRLF', () => {
  // Multiple lines in one chunk.
  assert.deepEqual(splitLines('', 'alpha\nbeta\ngamma\n'), {
    lines: ['alpha', 'beta', 'gamma'],
    rest: '',
  });

  // A line split across several chunks.
  const c1 = splitLines('', '{"kind":"st');
  assert.deepEqual(c1, { lines: [], rest: '{"kind":"st' });
  const c2 = splitLines(c1.rest, 'ep","text":');
  assert.deepEqual(c2, { lines: [], rest: '{"kind":"step","text":' });
  const c3 = splitLines(c2.rest, '"Read a.ts"}\n');
  assert.deepEqual(c3, { lines: ['{"kind":"step","text":"Read a.ts"}'], rest: '' });

  // Trailing partial line preserved across next chunk.
  const partial = splitLines('', 'first\nsecond\nincomplete');
  assert.deepEqual(partial, { lines: ['first', 'second'], rest: 'incomplete' });
  assert.deepEqual(splitLines(partial.rest, '-end\n'), { lines: ['incomplete-end'], rest: '' });

  // CRLF within one chunk and split across \r and \n boundary.
  assert.deepEqual(splitLines('', 'one\r\ntwo\r\n'), { lines: ['one', 'two'], rest: '' });
  const cr = splitLines('', 'split-crlf\r');
  assert.deepEqual(cr, { lines: [], rest: 'split-crlf\r' });
  assert.deepEqual(splitLines(cr.rest, '\nafter\r\n'), { lines: ['split-crlf', 'after'], rest: '' });
});

test('applyTailRecord: reduces step, job, settled, and ignores malformed records', () => {
  const init: TailState = { jobId: 'job-1', settled: false, step: null };

  const s1 = applyTailRecord(init, { kind: 'step', text: 'Read AGENTS.md' });
  assert.deepEqual(s1, { jobId: 'job-1', settled: false, step: 'Read AGENTS.md' });

  // Empty or non-string step text produces no step line; subsequent job clears transient step.
  assert.equal(applyTailRecord(s1, { kind: 'step', text: '' }).step, null);
  assert.equal(applyTailRecord(s1, { kind: 'step', text: 123 }).step, null);

  const s2 = applyTailRecord(s1, { kind: 'job', jobId: 'job-2' });
  assert.deepEqual(s2, { jobId: 'job-2', settled: false, step: null });
  // Missing/empty jobId keeps current jobId.
  assert.deepEqual(applyTailRecord(s2, { kind: 'job', jobId: '' }), { jobId: 'job-2', settled: false, step: null });

  // Unknown kinds and primitives leave jobId and settled untouched and clear transient step.
  const withStep = applyTailRecord(s2, { kind: 'step', text: 'Ran npm test' });
  assert.deepEqual(applyTailRecord(withStep, { kind: 'unknown' }), { jobId: 'job-2', settled: false, step: null });
  assert.deepEqual(applyTailRecord(withStep, null), { jobId: 'job-2', settled: false, step: null });
  assert.deepEqual(applyTailRecord(withStep, 'raw'), { jobId: 'job-2', settled: false, step: null });

  const s3 = applyTailRecord(s2, { kind: 'settled', jobId: 'job-3', status: 'succeeded' });
  assert.deepEqual(s3, { jobId: 'job-3', settled: true, step: null });
});

test('statusPollState: keeps waiting while acceptance.pending is true and lengthens wait_ms when unchanged', () => {
  assert.deepEqual(statusPollState({ status: 'running' }, true), { done: false, waitMs: WAIT_MS });
  assert.deepEqual(statusPollState({ status: 'running' }, false), { done: false, waitMs: MAX_STATUS_WAIT_MS });
  assert.deepEqual(
    statusPollState({ status: 'succeeded', waited: true, stillRunning: false, acceptance: { state: 'unchecked', pending: true } }, true),
    { done: false, waitMs: MAX_STATUS_WAIT_MS },
  );
  assert.deepEqual(
    statusPollState({ status: 'succeeded', waited: true, stillRunning: false, acceptance: { state: 'accepted', pending: false } }, true),
    { done: true, waitMs: WAIT_MS },
  );
});
