import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildArgv as buildClaudeArgv, buildResult as buildClaudeResult, ClaudeLiveInput, claudeProvider, createClaudeTranslator } from './claude.ts';
import { buildArgv as buildCodexArgv, buildResult as buildCodexResult, codexStderrLevel, createCodexTranslator } from './codex.ts';
import { buildArgv as buildAgyArgv, buildResult as buildAgyResult, createAgyTranslator } from './agy.ts';
import { buildArgv as buildOpencodeArgv, buildResult as buildOpencodeResult, createOpencodeTranslator } from './opencode.ts';
import { buildArgv as buildKimiArgv, buildResult as buildKimiResult, createKimiTranslator } from './kimi.ts';
import { recoveredErrorNotice, spawnWorker } from './ndjson.ts';
import { getProvider } from './registry.ts';
import type { ProviderEvent, SpawnSpec } from './types.ts';
import { classify } from '../surfaces/mod/hooks/progress.ts';
import { scaled, waitFor } from '../forge/testing/time.ts';
import { trackedTempDirs } from '../forge/testing/tmp.ts';

const tempDir = trackedTempDirs('agent-smith-provider-test-');

const pidAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
};

test('Codex model-refresh timeout is informational; unrelated stderr errors remain warnings', () => {
  assert.equal(codexStderrLevel('ERROR codex_core::models_manager: failed to refresh available models: request timed out'), 'info');
  assert.equal(codexStderrLevel('ERROR failed to refresh available models: unauthorized'), 'warn');
  assert.equal(codexStderrLevel('ERROR authentication failed\nfailed to refresh available models: request timed out'), 'warn');
  assert.equal(codexStderrLevel('ERROR authentication failed; failed to refresh available models: request timed out'), 'warn');
  assert.equal(codexStderrLevel('Not inside a trusted directory'), 'warn');
});

function spec(overrides: Partial<SpawnSpec> = {}): SpawnSpec {
  return {
    mode: 'implement',
    prompt: 'continue the work',
    cwd: process.cwd(),
    timeoutMs: 5_000,
    unrestricted: false,
    ...overrides,
  };
}

test('Codex argv applies effort and resumes the supplied thread', () => {
  const argv = buildCodexArgv(spec({
    model: 'gpt-6-sol',
    effort: 'xhigh',
    conversation: 'thread-123',
  }));

  assert.deepEqual(argv.slice(0, 3), ['exec', 'resume', 'thread-123']);
  assert.ok(argv.includes('--model') && argv[argv.indexOf('--model') + 1] === 'gpt-6-sol');
  assert.ok(argv.includes('model_reasoning_effort="xhigh"'));
  assert.equal(argv.at(-1), 'continue the work');
});

test('Codex argv pins approval_policy="never" for exec and exec resume across every sandbox branch', () => {
  const saved = process.env['AGENT_SMITH_CODEX_SANDBOX'];
  delete process.env['AGENT_SMITH_CODEX_SANDBOX'];
  const hasApprovalNever = (argv: string[]): boolean =>
    argv.some((a, i) => a === '-c' && argv[i + 1] === 'approval_policy="never"');
  try {
    const branches: Partial<SpawnSpec>[] = [
      { unrestricted: false },
      { unrestricted: false, readOnly: true },
      { unrestricted: false, readOnly: true, artifactPath: '/tmp/out.md' },
      { unrestricted: true },
    ];
    for (const conversation of [undefined, 'thread-123']) {
      for (const branch of branches) {
        const argv = buildCodexArgv(spec({ ...branch, ...(conversation === undefined ? {} : { conversation }) }));
        assert.ok(hasApprovalNever(argv), `missing -c approval_policy="never" in ${JSON.stringify(argv)}`);
      }
    }
    process.env['AGENT_SMITH_CODEX_SANDBOX'] = 'read-only';
    for (const conversation of [undefined, 'thread-123']) {
      const argv = buildCodexArgv(spec(conversation === undefined ? {} : { conversation }));
      assert.ok(hasApprovalNever(argv), `missing -c approval_policy="never" with env sandbox in ${JSON.stringify(argv)}`);
    }
  } finally {
    if (saved === undefined) delete process.env['AGENT_SMITH_CODEX_SANDBOX'];
    else process.env['AGENT_SMITH_CODEX_SANDBOX'] = saved;
  }
});

test('Codex rejects an effort the CLI adapter does not support', () => {
  assert.throws(
    () => buildCodexArgv(spec({ effort: 'maximum-ish' })),
    /codex does not support effort 'maximum-ish'/,
  );
});

test('Codex translator maps exec_events.rs item schemas: reasoning, collab, file_change, mcp, web_search, statuses, unknown', () => {
  const tx = createCodexTranslator(200);

  const reasoning = tx.onEvent({
    type: 'item.completed',
    item: { id: 'r1', type: 'reasoning', text: 'Checking auth middleware first.' },
  });
  assert.equal(reasoning.length, 1);
  assert.ok(reasoning[0]?.kind === 'text');
  assert.equal(reasoning[0].stream, 'thinking');
  assert.equal(reasoning[0].text, 'Checking auth middleware first.');
  assert.deepEqual(
    tx.onEvent({ type: 'item.completed', item: { id: 'r2', type: 'reasoning', text: '' } }),
    [],
  );

  const collabStart = tx.onEvent({
    type: 'item.started',
    item: {
      id: 'c1',
      type: 'collab_tool_call',
      tool: 'spawn_agent',
      sender_thread_id: 'thr_parent',
      receiver_thread_ids: ['thr_child'],
      prompt: 'Audit the parser',
      agents_states: {},
      status: 'in_progress',
    },
  });
  assert.equal(collabStart.length, 1);
  assert.ok(collabStart[0]?.kind === 'activity-start');
  assert.equal(collabStart[0].activity.tool, 'collab/spawn_agent');
  assert.equal(collabStart[0].activity.input, 'thr_child: Audit the parser');

  const collabEnd = tx.onEvent({
    type: 'item.completed',
    item: {
      id: 'c1',
      type: 'collab_tool_call',
      tool: 'spawn_agent',
      sender_thread_id: 'thr_parent',
      receiver_thread_ids: ['thr_child'],
      prompt: 'Audit the parser',
      agents_states: { thr_child: { status: 'completed', message: 'clean' } },
      status: 'completed',
    },
  });
  assert.equal(collabEnd.length, 1);
  assert.ok(collabEnd[0]?.kind === 'activity-end');
  assert.equal(collabEnd[0].activity.stepIndex, collabStart[0].activity.stepIndex);
  assert.equal(collabEnd[0].activity.tool, 'collab/spawn_agent');
  assert.equal(collabEnd[0].activity.output, 'thr_child: completed (clean)');
  assert.equal(collabEnd[0].status, 'done');

  const collabFail = tx.onEvent({
    type: 'item.completed',
    item: {
      id: 'c2',
      type: 'collab_tool_call',
      tool: 'wait',
      sender_thread_id: 'thr_parent',
      receiver_thread_ids: ['thr_child'],
      prompt: null,
      agents_states: {},
      status: 'failed',
    },
  });
  assert.ok(collabFail[0]?.kind === 'activity-end');
  assert.equal(collabFail[0].activity.tool, 'collab/wait');
  assert.equal(collabFail[0].activity.input, 'thr_child');
  assert.equal(collabFail[0].status, 'error');

  const fileOk = tx.onEvent({
    type: 'item.completed',
    item: {
      id: 'f1',
      type: 'file_change',
      changes: [
        { path: 'src/a.ts', kind: 'update' },
        { path: 'src/b.ts', kind: 'add' },
      ],
      status: 'completed',
    },
  });
  assert.ok(fileOk[0]?.kind === 'activity-end');
  assert.equal(fileOk[0].activity.tool, 'file_change');
  assert.deepEqual(JSON.parse(fileOk[0].activity.input ?? ''), {
    changes: [
      { path: 'src/a.ts', kind: 'update' },
      { path: 'src/b.ts', kind: 'add' },
    ],
  });
  assert.deepEqual(classify(fileOk[0].activity.tool, fileOk[0].activity.input), {
    kind: 'edit',
    label: 'editing a.ts',
    path: 'src/a.ts',
  });
  assert.equal(fileOk[0].status, 'done');

  const fileFail = tx.onEvent({
    type: 'item.completed',
    item: {
      id: 'f2',
      type: 'file_change',
      changes: [{ path: 'src/c.ts', kind: 'delete' }],
      status: 'failed',
    },
  });
  assert.ok(fileFail[0]?.kind === 'activity-end');
  assert.deepEqual(JSON.parse(fileFail[0].activity.input ?? ''), {
    changes: [{ path: 'src/c.ts', kind: 'delete' }],
  });
  assert.equal(fileFail[0].status, 'error');

  const mcpStart = tx.onEvent({
    type: 'item.started',
    item: {
      id: 'm1',
      type: 'mcp_tool_call',
      server: 'github',
      tool: 'get_pr',
      arguments: { number: 42 },
      result: null,
      error: null,
      status: 'in_progress',
    },
  });
  assert.ok(mcpStart[0]?.kind === 'activity-start');
  assert.equal(mcpStart[0].activity.tool, 'github/get_pr');
  assert.equal(mcpStart[0].activity.input, '{"number":42}');

  const mcpEnd = tx.onEvent({
    type: 'item.completed',
    item: {
      id: 'm1',
      type: 'mcp_tool_call',
      server: 'github',
      tool: 'get_pr',
      arguments: { number: 42 },
      result: { content: [{ type: 'text', text: 'PR #42' }], structured_content: null },
      error: null,
      status: 'completed',
    },
  });
  assert.ok(mcpEnd[0]?.kind === 'activity-end');
  assert.equal(mcpEnd[0].activity.stepIndex, mcpStart[0].activity.stepIndex);
  assert.equal(mcpEnd[0].activity.tool, 'github/get_pr');
  assert.match(mcpEnd[0].activity.output ?? '', /PR #42/);
  assert.equal(mcpEnd[0].status, 'done');

  const searchStart = tx.onEvent({
    type: 'item.started',
    item: { id: 'w1', type: 'web_search', query: 'codex exec jsonl schema', action: { type: 'search' } },
  });
  assert.ok(searchStart[0]?.kind === 'activity-start');
  assert.equal(searchStart[0].activity.tool, 'web_search');
  assert.deepEqual(JSON.parse(searchStart[0].activity.input ?? ''), { query: 'codex exec jsonl schema' });
  assert.deepEqual(classify(searchStart[0].activity.tool, searchStart[0].activity.input), {
    kind: 'search',
    label: 'searching codex exec jsonl schema',
  });

  const searchEnd = tx.onEvent({
    type: 'item.completed',
    item: {
      id: 'w1',
      type: 'web_search',
      query: 'codex exec jsonl schema',
      action: { type: 'search' },
      results: [{ title: 'exec_events.rs' }],
    },
  });
  assert.ok(searchEnd[0]?.kind === 'activity-end');
  assert.deepEqual(JSON.parse(searchEnd[0].activity.input ?? ''), { query: 'codex exec jsonl schema' });
  assert.match(searchEnd[0].activity.output ?? '', /exec_events\.rs/);
  assert.equal(searchEnd[0].status, 'done');

  const cmdFail = tx.onEvent({
    type: 'item.completed',
    item: { id: 'cmd-fail', type: 'command_execution', command: 'false', aggregated_output: 'boom', exit_code: 1, status: 'failed' },
  });
  assert.ok(cmdFail[0]?.kind === 'activity-end');
  assert.equal(cmdFail[0].status, 'error');
  assert.equal(cmdFail[0].activity.output, 'boom');

  const cmdDeclined = tx.onEvent({
    type: 'item.completed',
    item: { id: 'cmd-dec', type: 'command_execution', command: 'rm -rf /', aggregated_output: '', exit_code: null, status: 'declined' },
  });
  assert.ok(cmdDeclined[0]?.kind === 'activity-end');
  assert.equal(cmdDeclined[0].status, 'denied');
  assert.equal(cmdDeclined[0].activity.denied, true);

  const unknown = tx.onEvent({
    type: 'item.completed',
    item: { id: 'u1', type: 'future_tool_kind', payload: 1 },
  });
  assert.equal(unknown.length, 1);
  assert.ok(unknown[0]?.kind === 'notice');
  assert.equal(unknown[0].level, 'info');
  assert.match(unknown[0].message, /unrecognised item type "future_tool_kind"/);
});

test('Codex completed file and MCP items without exit codes are successful activities', () => {
  const tx = createCodexTranslator(200);
  for (const [id, type] of [['file-1', 'file_change'], ['mcp-1', 'mcp_tool_call']] as const) {
    const events = tx.onEvent({ type: 'item.completed', item: { id, type, output: 'done' } });
    const end = events.at(-1);
    assert.ok(end?.kind === 'activity-end');
    assert.equal(end.status, 'done');
  }
  const command = tx.onEvent({ type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', exit_code: 0 } });
  const commandEnd = command.at(-1);
  assert.ok(commandEnd?.kind === 'activity-end');
  assert.equal(commandEnd.status, 'done');
});

test('Codex output mentioning denied requests does not mark the activity denied', () => {
  const tx = createCodexTranslator(200);
  const events = tx.onEvent({
    type: 'item.completed',
    item: { id: 'mcp-1', type: 'mcp_tool_call', output: 'No denied requests were found.' },
  });
  const end = events.at(-1);
  assert.ok(end?.kind === 'activity-end');
  assert.equal(end.status, 'done');
});

test('Codex MCP errors use structured results, including a null error on success', () => {
  for (const [fields, expected] of [
    [{ error: null, result: { content: [] } }, 'done'],
    [{ error: { message: 'server disconnected' } }, 'error'],
    [{ result: { isError: true, content: [] } }, 'error'],
    [{ status: 'failed', error: { message: 'permission denied' } }, 'denied'],
  ] as const) {
    const tx = createCodexTranslator(200);
    const end = tx.onEvent({ type: 'item.completed', item: { id: 'mcp', type: 'mcp_tool_call', ...fields } }).at(-1);
    assert.ok(end?.kind === 'activity-end');
    assert.equal(end.status, expected);
  }
});

test('Codex declined or user-rejected commands render as denied, not done', () => {
  for (const fields of [
    { status: 'declined' },
    { message: 'exec command rejected by the user' },
    { error: { message: 'Command declined by user' } },
  ]) {
    const tx = createCodexTranslator(200);
    const end = tx.onEvent({ type: 'item.completed', item: { id: 'cmd', type: 'command_execution', command: 'rm -rf build', ...fields } }).at(-1);
    assert.ok(end?.kind === 'activity-end');
    assert.equal(end.status, 'denied', JSON.stringify(fields));
  }
});

test('Claude structured permission denials are deduplicated and retained on successful reports', () => {
  const tx = createClaudeTranslator(200);
  tx.onEvent({ type: 'system', subtype: 'permission_denied', tool_name: 'Write', tool_use_id: 'toolu-1' });
  tx.onEvent({ type: 'result', subtype: 'success', is_error: false, result: 'Report', permission_denials: [
    { tool_name: 'Write', tool_use_id: 'toolu-1' }, { tool_name: 'Bash', tool_use_id: 'toolu-2' },
  ] });
  const result = buildClaudeResult({
    jobId: 'claude-denied-success', startedAtMs: Date.now() - 1, stateDir: '/tmp',
    exit: { code: 0, signal: null, killReason: undefined, stderr: '' }, tx,
  });
  assert.equal(result.status, 'success');
  assert.equal(result.deniedActions?.length, 2);
});

test('Claude structured permission denials block a failed report', () => {
  const tx = createClaudeTranslator(200);
  tx.onEvent({ type: 'result', subtype: 'error_during_execution', is_error: true, permission_denials: [
    { tool_name: 'Bash', tool_use_id: 'toolu-2' },
  ] });
  const result = buildClaudeResult({
    jobId: 'claude-denied-failure', startedAtMs: Date.now() - 1, stateDir: '/tmp',
    exit: { code: 1, signal: null, killReason: undefined, stderr: '' }, tx,
  });
  assert.equal(result.status, 'denied');
});

test('Claude final-only denials produce activity evidence once per call, not once per tool', () => {
  const tx = createClaudeTranslator(200);
  const result = { type: 'result', subtype: 'success', result: 'Report', permission_denials: [
    { tool_name: 'Bash', tool_use_id: 'one' }, { tool_name: 'Bash', tool_use_id: 'two' },
  ] };
  const events = tx.onEvent(result).filter(e => e.kind === 'activity-end');
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.activity.toolCallId), ['one', 'two']);
  assert.ok(events.every(e => e.status === 'denied'));
  assert.equal(tx.onEvent(result).filter(e => e.kind === 'activity-end').length, 0);
  assert.deepEqual(tx.deniedTools, ['one', 'two']);
});

test('Claude argv applies effort and uses --resume for continuation', () => {
  const argv = buildClaudeArgv(spec({ effort: 'high', conversation: 'session-123' }));
  assert.ok(argv.includes('--effort') && argv[argv.indexOf('--effort') + 1] === 'high');
  assert.ok(argv.includes('--resume') && argv[argv.indexOf('--resume') + 1] === 'session-123');
  assert.ok(!argv.includes('--session-id'));
});

test('Claude argv takes the prompt on stdin: stream-json input, replayed user messages, no prompt positional', () => {
  const argv = buildClaudeArgv(spec({ prompt: 'secret-ish prompt text' }));
  assert.ok(!argv.includes('secret-ish prompt text'));
  assert.equal(argv[argv.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(argv.includes('--replay-user-messages') && argv.includes('--verbose'));
  assert.equal(claudeProvider.liveInput, true);
});

test('Claude translator reports only replays of sent messages, never the prompt, subagent text or a tool result', () => {
  const written: string[] = [];
  let ended = false;
  const stdin = { destroyed: false, writableEnded: false, on() { return this; }, write(s: string) { written.push(s); return true; }, end() { ended = true; this.writableEnded = true; } };
  const input = new ClaudeLiveInput('the prompt');
  input.attach(stdin as unknown as import('node:stream').Writable);
  assert.deepEqual(JSON.parse(written[0]!), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'the prompt' }] } });
  assert.equal(input.send('  '), false, 'an empty message is refused');
  assert.equal(input.send('also do B'), true);
  const tx = createClaudeTranslator(200, input);
  const replay = (text: string, extra: Record<string, unknown> = {}) =>
    tx.onEvent({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, ...extra }).filter((e) => e.kind === 'user-message');
  assert.deepEqual(replay('the prompt', { parent_tool_use_id: null }), [], 'the initial prompt is not a follow-up');
  assert.deepEqual(replay('also do B', { parent_tool_use_id: 'toolu_sub' }), [], 'forwarded subagent text is not a replay');
  assert.deepEqual(replay('something claude injected'), []);
  const read = replay('also do B', { parent_tool_use_id: null, isReplay: true });
  assert.equal(read.length, 1);
  assert.ok(read[0]!.kind === 'user-message' && read[0]!.text === 'also do B');
  assert.deepEqual(replay('also do B'), [], 'a message is reported read once');
  assert.equal(input.send('then C'), true);
  assert.deepEqual(input.unread(), ['then C']);
  tx.onEvent({ type: 'result', subtype: 'success', result: 'ok' });
  assert.ok(ended, 'the result ends stdin');
  assert.equal(input.send('too late'), false);
  assert.deepEqual(input.unread(), ['then C'], 'unread after the result: undelivered');
  assert.equal(tx.onEvent({ type: 'user', message: { role: 'user', content: 'then C' } }).filter((e) => e.kind === 'user-message').length, 1);
  assert.deepEqual(input.unread(), []);
});

test('Claude rejects an effort the CLI does not support', () => {
  assert.throws(
    () => buildClaudeArgv(spec({ effort: 'ultra' })),
    /claude does not support effort 'ultra'/,
  );
});

test('agy refuses contradictory model effort suffixes', () => {
  assert.throws(() => buildAgyArgv(spec({ model: 'fixture-low', effort: 'high' })), /conflicting/);
  assert.equal(buildAgyArgv(spec({ model: 'fixture-high', effort: 'high' })).includes('--effort'), false);
});

test('cancellation kills a worker process group including a surviving descendant', async () => {
  if (process.platform === 'win32') return;
  const dir = tempDir();
  const delayedMarker = path.join(dir, 'descendant-survived');
  const childPidFile = path.join(dir, 'child.pid');
  const descendantCode = `process.on('SIGTERM',()=>{}); setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(delayedMarker)},'alive'),600000); setInterval(()=>{},1000)`;
  const workerCode = [
    "const {spawn}=require('node:child_process');",
    "const fs=require('node:fs');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore'});`,
    `fs.writeFileSync(${JSON.stringify(childPidFile)},String(child.pid));`,
    "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);",
  ].join('');
  const worker = await spawnWorker({
    provider: 'fake',
    binary: process.execPath,
    argv: ['-e', workerCode],
    cwd: dir,
    timeoutMs: scaled(60_000),
    killGraceMs: 100,
    stateDir: dir,
    jobId: 'group-kill',
    mode: 'test',
    onStdoutLine() {},
    onStderr() {},
  });

  const descendantPid = await waitFor(() => {
    const pid = existsSync(childPidFile) ? Number(readFileSync(childPidFile, 'utf8')) : 0;
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  }, { message: 'fake worker to record its descendant pid' });
  worker.terminate('cancelled');
  const exit = await worker.exited;
  worker.closeLog();
  assert.equal(worker.killReason, 'cancelled');
  assert.ok(exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL');

  await waitFor(() => !pidAlive(descendantPid), { message: `descendant ${descendantPid} to die with its group` });
  assert.equal(existsSync(delayedMarker), false, `descendant ${descendantPid} survived cancellation`);
});

test('spawn failures settle through exited instead of hanging', async () => {
  const dir = tempDir();
  const messages: string[] = [];
  const worker = await spawnWorker({
    provider: 'fake',
    binary: path.join(dir, 'missing-worker'),
    argv: [],
    cwd: dir,
    timeoutMs: 1_000,
    stateDir: dir,
    jobId: 'missing-binary',
    mode: 'test',
    onStdoutLine() {},
    onStderr(message) { messages.push(message); },
  });
  const exit = await Promise.race([
    worker.exited,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('spawn failure did not settle')), scaled(30_000))),
  ]);
  worker.closeLog();
  assert.equal(exit.code, null);
  assert.ok(messages.some((message) => /spawn error/.test(message)));
});

test('a cancelled supervisor does not abandon detached-stdio descendants', async () => {
  if (process.platform === 'win32') return;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const dir = tempDir();
  const marker = path.join(dir, 'orphan-alive');
  const workerScript = path.join(dir, 'worker.cjs');
  const supervisor = path.join(dir, 'supervisor.mjs');
  const pidFile = path.join(dir, 'descendant.pid');
  const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),600000);setInterval(()=>{},1000)`;
  writeFileSync(workerScript, `const fs=require('node:fs'),{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(t);console.log('ready');}},10);setInterval(()=>{},1000)`);
  const moduleUrl = new URL('./ndjson.ts', import.meta.url).href;
  writeFileSync(supervisor, `import {spawnWorker} from ${JSON.stringify(moduleUrl)};
const proc=await spawnWorker({provider:'fixture',binary:process.execPath,argv:[${JSON.stringify(workerScript)}],cwd:${JSON.stringify(dir)},timeoutMs:30000,killGraceMs:150,stateDir:${JSON.stringify(dir)},jobId:'fixture',mode:'fixture',onStdoutLine(){proc.terminate('cancelled')},onStderr(){}});await proc.exited;proc.closeLog();`);
  await promisify(execFile)(process.execPath, ['--experimental-strip-types', supervisor], { timeout: scaled(60_000) });
  const descendantPid = await waitFor(() => {
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0;
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  }, { message: 'the descendant to record its pid' });
  await waitFor(() => !pidAlive(descendantPid), { message: `descendant ${descendantPid} to die with the cancelled supervisor` });
  assert.equal(existsSync(marker), false, 'the supervisor exited while its tool continued running');
});

test('kimi: assistant text and tool calls resolve to one activity step closed by the tool result', () => {
  const tx = createKimiTranslator(200);
  const first = tx.onEvent({
    role: 'assistant',
    content: 'Checking the tree.',
    tool_calls: [{
      type: 'function',
      id: 'call-1',
      function: { name: 'Bash', arguments: '{"command":"git status"}' },
    }],
  });
  const text = first.find((e) => e.kind === 'text');
  assert.ok(text?.kind === 'text');
  assert.equal(text.text, 'Checking the tree.');
  const start = first.find((e) => e.kind === 'activity-start');
  assert.ok(start?.kind === 'activity-start');
  assert.equal(start.activity.tool, 'Bash');
  assert.equal(start.activity.toolCallId, 'call-1');
  assert.match(start.activity.input ?? '', /git status/);

  const second = tx.onEvent({ role: 'tool', tool_call_id: 'call-1', content: 'clean' });
  const end = second.find((e) => e.kind === 'activity-end');
  assert.ok(end?.kind === 'activity-end');
  assert.equal(end.activity.stepIndex, start.activity.stepIndex, 'the result closes the call it belongs to');
  assert.equal(end.activity.tool, 'Bash', 'the result line carries no name; the start supplies it');
  assert.equal(end.activity.output, 'clean');
  assert.equal(end.status, 'done');
});

test('kimi: the resume hint supplies the session id without leaking its prose into the report', () => {
  const tx = createKimiTranslator(200);
  const events = tx.onEvent({
    role: 'meta',
    type: 'session.resume_hint',
    session_id: 'sess-9',
    command: 'kimi -r sess-9',
    content: 'To resume this session: kimi -r sess-9',
  });
  const started = events.find((e) => e.kind === 'started');
  assert.ok(started?.kind === 'started');
  assert.equal(started.conversationId, 'sess-9');
  assert.equal(tx.finalText, '', 'the hint is not assistant text');
  assert.equal(events.some((e) => e.kind === 'text'), false);
  assert.equal(
    tx.onEvent({ role: 'meta', type: 'session.resume_hint', session_id: 'sess-9' }).some((e) => e.kind === 'started'),
    false,
    'a duplicate hint does not emit a second started event',
  );
  const changed = tx.onEvent({ role: 'meta', type: 'session.resume_hint', session_id: 'sess-other' });
  assert.equal(changed.some((e) => e.kind === 'started'), false);
  assert.ok(changed.some((e) => e.kind === 'notice' && e.level === 'warn' && /changed the session id/.test(e.message)));
  assert.equal(tx.sessionId, 'sess-9', 'the first issued id wins');

  const result = buildKimiResult({
    jobId: 'kimi-resume',
    startedAtMs: Date.now() - 1,
    stateDir: '/tmp',
    exit: { code: 0, signal: null, killReason: undefined, stderr: '' },
    tx,
  });
  assert.equal(result.status, 'malformed', 'a session id is not a report');
  assert.deepEqual(result.raw, { sessionId: 'sess-9' });
});

test('kimi: retry meta warns, and unknown lines are preserved rather than dropped', () => {
  const tx = createKimiTranslator(200);
  const retry = tx.onEvent({
    role: 'meta',
    type: 'turn.step.retrying',
    failed_attempt: 1,
    next_attempt: 2,
    max_attempts: 10,
    delay_ms: 500,
    error_name: 'RateLimitError',
    error_message: 'slow down',
  })[0];
  assert.ok(retry?.kind === 'notice');
  assert.equal(retry.level, 'warn');
  assert.match(retry.message, /RateLimitError/);
  assert.equal(tx.sawError, false, 'a retried step is not yet a failed job');

  const unknown = tx.onEvent({ role: 'system', content: 'hi' })[0];
  assert.ok(unknown?.kind === 'notice');
  assert.match(unknown.message, /unrecognised line "system"/);
  assert.deepEqual([...tx.unrecognised], ['role:system']);
});

test('kimi: a structured tool error marks the activity, never the whole job', () => {
  const tx = createKimiTranslator(200);
  tx.onEvent({ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'Bash', arguments: '{}' } }] });
  const end = tx.onEvent({ role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ isError: true, output: 'boom' }) }).at(-1);
  assert.ok(end?.kind === 'activity-end');
  assert.equal(end.status, 'error');
  assert.equal(tx.sawError, false, 'the agent may recover from a failed tool');
});

test('kimi: success needs assistant text; a non-zero exit is an error', () => {
  const good = createKimiTranslator(200);
  good.onEvent({ role: 'assistant', content: 'Done.' });
  const success = buildKimiResult({
    jobId: 'kimi-ok', startedAtMs: Date.now() - 1, stateDir: '/tmp',
    exit: { code: 0, signal: null, killReason: undefined, stderr: '' }, tx: good,
  });
  assert.equal(success.status, 'success');
  assert.equal(success.response, 'Done.');

  const failed = createKimiTranslator(200);
  failed.onEvent({ role: 'assistant', content: 'Partial.' });
  const error = buildKimiResult({
    jobId: 'kimi-fail', startedAtMs: Date.now() - 1, stateDir: '/tmp',
    exit: { code: 2, signal: null, killReason: undefined, stderr: 'auth failed' }, tx: failed,
  });
  assert.equal(error.status, 'error');
  assert.match(error.error!, /exited 2/);
  assert.match(error.error!, /auth failed/);
});

test('kimi: spawn failures and signal deaths carry a cause, not "exited null"', () => {
  const blank = () => createKimiTranslator(200);
  const spawn = buildKimiResult({
    jobId: 'kimi-spawn', startedAtMs: Date.now() - 1, stateDir: '/tmp',
    exit: { code: null, signal: null, killReason: undefined, stderr: '', spawnError: 'spawn error: ENOENT' },
    tx: blank(),
  });
  assert.equal(spawn.status, 'spawn-failed');
  assert.match(spawn.error!, /ENOENT/);

  const signal = buildKimiResult({
    jobId: 'kimi-signal', startedAtMs: Date.now() - 1, stateDir: '/tmp',
    exit: { code: null, signal: 'SIGTERM', killReason: undefined, stderr: '' },
    tx: blank(),
  });
  assert.equal(signal.status, 'error');
  assert.match(signal.error!, /exited on SIGTERM, no result/);
});

test('kimi: add-dir is repeatable and the prompt stays last', () => {
  const argv = buildKimiArgv(spec({
    model: 'kimi-code/k3',
    conversation: 'sess-1',
    addDirs: ['/tmp/one', '/tmp/two'],
  }));
  assert.deepEqual(argv, [
    '--output-format', 'stream-json',
    '--model', 'kimi-code/k3',
    '--session=sess-1',
    '--add-dir', '/tmp/one',
    '--add-dir', '/tmp/two',
    '-p', 'continue the work',
  ]);
  assert.equal(argv.includes('--effort'), false);
  assert.equal(argv.includes('--continue'), false);
});

test('kimi: duplicate ids keep one step, and an orphan result is still visible', () => {
  const tx = createKimiTranslator(200);
  const first = tx.onEvent({ role: 'assistant', tool_calls: [{ id: 'same', function: { name: 'Read', arguments: '{"path":"a"}' } }] });
  const second = tx.onEvent({ role: 'assistant', tool_calls: [{ id: 'same', function: { name: 'Read', arguments: '{"path":"b"}' } }] });
  assert.equal(first.filter((e) => e.kind === 'activity-start').length, 1);
  assert.equal(second.filter((e) => e.kind === 'activity-start').length, 0, 'the same call id is not opened twice');
  const orphan = tx.onEvent({ role: 'tool', tool_call_id: 'missing', content: 'orphan output' }).find((e) => e.kind === 'activity-end');
  assert.ok(orphan?.kind === 'activity-end');
  assert.equal(orphan.activity.tool, 'tool');
  assert.equal(orphan.activity.output, 'orphan output');
  const late = tx.onEvent({ role: 'assistant', tool_calls: [{ id: 'missing', function: { name: 'Bash', arguments: '{}' } }] });
  assert.equal(late.filter((e) => e.kind === 'activity-start').length, 0, 'a late call must not reopen a finished activity');
});

test('kimi: malformed tool_calls and non-string results are visible, not silent', () => {
  const tx = createKimiTranslator(200);
  const badCalls = tx.onEvent({ role: 'assistant', content: 'x', tool_calls: { id: 'c1' } });
  assert.ok(badCalls.some((e) => e.kind === 'notice' && /tool_calls was not an array/.test(e.message)));

  tx.onEvent({ role: 'assistant', tool_calls: [{ id: 'c2', function: { name: 'Bash', arguments: '{}' } }] });
  const end = tx.onEvent({ role: 'tool', tool_call_id: 'c2', content: { isError: true, output: 'object content' } }).find((e) => e.kind === 'activity-end');
  assert.ok(end?.kind === 'activity-end');
  assert.equal(end.status, 'error');
  assert.match(end.activity.output ?? '', /object content/);

  const repeated = tx.onEvent({ role: 'tool', tool_call_id: 'c2', content: 'again' });
  assert.ok(repeated.some((e) => e.kind === 'notice' && /repeated tool result/.test(e.message)));
  assert.equal(repeated.some((e) => e.kind === 'activity-end'), false);
});

test('kimi: missing ids get distinct steps, and session ids are trusted only on the resume hint', () => {
  const tx = createKimiTranslator(200);
  const hint = tx.onEvent({ role: 'meta', type: 'session.resume_hint', sessionId: 'sess-camel' });
  assert.ok(hint.some((e) => e.kind === 'started' && e.conversationId === 'sess-camel'));

  const ignored = tx.onEvent({ role: 'assistant', sessionId: 'evil', content: 'x' });
  assert.equal(ignored.some((e) => e.kind === 'started'), false, 'a non-hint session id is not a resume handle');
  const events = tx.onEvent({
    role: 'assistant',
    usage: { prompt_tokens: 3, completion_tokens: 4 },
    tool_calls: [
      { function: { name: 'Read', arguments: '{}' } },
      { function: { name: 'Bash', arguments: '{}' } },
    ],
  });
  const starts = events.filter((e) => e.kind === 'activity-start');
  assert.equal(starts.length, 2);
  assert.notEqual(starts[0]!.activity.stepIndex, starts[1]!.activity.stepIndex);
  const usage = events.find((e) => e.kind === 'usage');
  assert.ok(usage?.kind === 'usage');
  assert.deepEqual(usage.usage, { inputTokens: 3, outputTokens: 4 });
  const negative = tx.onEvent({ role: 'assistant', usage: { prompt_tokens: -1, output_tokens: 2 } }).find((e) => e.kind === 'usage');
  assert.ok(negative?.kind === 'usage');
  assert.deepEqual(negative.usage, { outputTokens: 2 }, 'negative counters are not real usage');
});

test('kimi: structured error variants close the activity as error, null does not', () => {
  for (const content of [JSON.stringify({ is_error: true }), JSON.stringify({ status: 'error' }), JSON.stringify({ error: 'boom' })]) {
    const tx = createKimiTranslator(200);
    tx.onEvent({ role: 'assistant', tool_calls: [{ id: 'e', function: { name: 'Bash', arguments: '{}' } }] });
    const end = tx.onEvent({ role: 'tool', tool_call_id: 'e', content }).find((e) => e.kind === 'activity-end');
    assert.ok(end?.kind === 'activity-end');
    assert.equal(end.status, 'error', content);
    assert.equal(tx.sawError, false, 'a tool error is not automatically a job error');
  }
  const tx = createKimiTranslator(200);
  tx.onEvent({ role: 'assistant', tool_calls: [{ id: 'ok', function: { name: 'Bash', arguments: '{}' } }] });
  const ok = tx.onEvent({ role: 'tool', tool_call_id: 'ok', content: JSON.stringify({ error: null, isError: false }) }).find((e) => e.kind === 'activity-end');
  assert.ok(ok?.kind === 'activity-end');
  assert.equal(ok.status, 'done');
});

test('kimi: a meta error line is fatal, and leading-dash values stay argv values', () => {
  const tx = createKimiTranslator(200);
  const events = tx.onEvent({ role: 'meta', type: 'error', error: { message: 'quota exhausted' } });
  assert.equal(tx.sawError, true);
  assert.equal(tx.error, 'quota exhausted');
  assert.ok(events.some((e) => e.kind === 'notice' && e.level === 'error'));

  const argv = buildKimiArgv(spec({ model: '-m', prompt: '- fix it' }));
  assert.deepEqual(argv, ['--output-format', 'stream-json', '--model', '-m', '-p', '- fix it']);
  assert.throws(() => buildKimiArgv(spec({ conversation: '-s' })), /must not start with/);
});

test('opencode: addDirs must NOT emit --dir, which the CLI rejects', () => {
  // `opencode run` on v2.0.26 has no --dir flag; passing it prints usage and
  // exits non-zero, failing the whole job. The v2 docs still list it, so this
  // is a regression guard against "fixing" the adapter to match stale docs.
  const argv = buildOpencodeArgv(spec({ addDirs: ['/tmp/extra-a', '/tmp/extra-b'] }));
  assert.equal(argv.includes('--dir'), false, `argv must not contain --dir: ${argv.join(' ')}`);
  assert.equal(argv.includes('/tmp/extra-a'), false);
  assert.equal(argv.includes('/tmp/extra-b'), false);
});

test('opencode translator emits a started event with conversationId on first sessionID', () => {
  const tx = createOpencodeTranslator(10_000);
  const first = tx.onEvent({ type: 'step_start', sessionID: 'ses_opencode_123' });
  assert.equal(first[0]?.kind, 'started');
  if (first[0]?.kind === 'started') {
    assert.equal(first[0].conversationId, 'ses_opencode_123');
  }

  const second = tx.onEvent({
    type: 'text',
    sessionID: 'ses_opencode_123',
    part: { type: 'text', text: 'hello' },
  });
  assert.equal(second.some((ev) => ev.kind === 'started'), false);
});

test('opencode: a tool_use part reports its state input and output on one step', () => {
  const tx = createOpencodeTranslator(10_000);
  const events = tx.onEvent({
    type: 'tool_use',
    timestamp: 1791335768123,
    sessionID: 'ses_tool_1',
    part: {
      partID: 'prt_1',
      id: 'call_1',
      type: 'tool',
      tool: 'bash',
      state: { status: 'completed', input: { command: 'cargo test' }, output: 'ok', title: 'bash' },
    },
  });

  const start = events.find((e) => e.kind === 'activity-start');
  const end = events.find((e) => e.kind === 'activity-end');
  assert.ok(start?.kind === 'activity-start');
  assert.ok(end?.kind === 'activity-end');
  assert.equal(end.activity.tool, 'bash');
  assert.equal(end.activity.stepIndex, start.activity.stepIndex, 'start and end share one step');
  assert.match(start.activity.input ?? '', /cargo test/);
  assert.match(end.activity.input ?? '', /cargo test/, 'the completed part keeps the parameters it was invoked with');
  assert.equal(end.activity.output, 'ok');
  assert.equal(end.status, 'done');
});

test('opencode: a failed tool call is a warning; a delivered report still succeeds', () => {
  const tx = createOpencodeTranslator(10_000);
  const events = [
    ...tx.onEvent({
      type: 'tool_use',
      sessionID: 'ses_toolerr',
      part: {
        id: 'call_2264873',
        type: 'tool',
        tool: 'read',
        state: { status: 'error', input: { path: '/repo/src/manager.rs' }, error: 'File not found: /repo/src/manager.rs' },
      },
    }),
    ...tx.onEvent({ type: 'text', sessionID: 'ses_toolerr', part: { type: 'text', text: '### Defects Found\n\n1. A real finding.' } }),
  ];
  const end = events.find((e) => e.kind === 'activity-end');
  assert.ok(end?.kind === 'activity-end');
  assert.equal(end.status, 'error', 'the activity itself still shows the failure');
  const warn = events.find((e) => e.kind === 'notice');
  assert.ok(warn?.kind === 'notice');
  assert.equal(warn.level, 'warn');
  assert.match(warn.message, /tool read failed.*File not found/);
  assert.equal(tx.sawError, false);
  assert.equal(tx.toolErrors, 1);

  const exit = { code: 0, signal: null, killReason: undefined, stderr: '' };
  const ok = buildOpencodeResult({ jobId: 'j', startedAtMs: Date.now(), stateDir: '/tmp/x', exit, tx });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 'success');
  assert.equal(ok.error, undefined);

  const failed = buildOpencodeResult({ jobId: 'j', startedAtMs: Date.now(), stateDir: '/tmp/x', exit: { ...exit, code: 1 }, tx });
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? '', /exited 1 · 1 tool error\(s\)/);

  const flaky = createOpencodeTranslator(10_000);
  const notices = [];
  for (let i = 0; i < 7; i += 1) {
    notices.push(...flaky.onEvent({ type: 'tool_use', part: { id: `c${i}`, type: 'tool', tool: 'bash', state: { status: 'error', error: 'boom' } } })
      .filter((e) => e.kind === 'notice'));
  }
  assert.equal(flaky.toolErrors, 7);
  assert.equal(notices.length, 5, 'per-call warnings are capped; the count carries the rest');
});

test('opencode: a real error event still fails the job, report or not', () => {
  const tx = createOpencodeTranslator(10_000);
  tx.onEvent({ type: 'text', part: { type: 'text', text: 'partial' } });
  tx.onEvent({ type: 'error', error: { type: 'provider.quota', data: { statusCode: 402, message: 'Insufficient account funds' } } });
  const r = buildOpencodeResult({ jobId: 'j', startedAtMs: Date.now(), stateDir: '/tmp/x', exit: { code: 0, signal: null, killReason: undefined, stderr: '' }, tx });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /HTTP 402: Insufficient account funds/);
});

test('opencode: one tool call keeps one step from running to completed', () => {
  const tx = createOpencodeTranslator(10_000);
  const running = tx.onEvent({
    type: 'tool_use',
    part: {
      partID: 'prt_run',
      id: 'call_123',
      type: 'tool',
      tool: 'bash',
      state: { status: 'running', input: { command: 'npm test' } },
    },
  });
  const completed = tx.onEvent({
    type: 'tool_use',
    part: {
      partID: 'prt_done',
      id: 'call_123',
      type: 'tool',
      tool: 'bash',
      state: { status: 'completed', output: 'pass' },
    },
  });

  const activities = [...running, ...completed].flatMap((e) =>
    e.kind === 'activity-start' || e.kind === 'activity-update' || e.kind === 'activity-end' ? [e] : []);
  assert.deepEqual(activities.map((e) => e.kind), ['activity-start', 'activity-update', 'activity-end']);
  assert.deepEqual(
    [...new Set(activities.map((e) => e.activity.stepIndex))],
    [0],
    'a changed partID must not split the same call into two steps',
  );
  const end = activities.at(-1);
  assert.ok(end?.kind === 'activity-end');
  assert.equal(end.activity.output, 'pass');
});

test('opencode: step_finish counters accumulate across steps without per-step noise', () => {
  const tx = createOpencodeTranslator(10_000);
  const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 } };
  const events: ProviderEvent[] = [];
  for (let i = 0; i < 2; i += 1) {
    events.push(...tx.onEvent({
      type: 'step_start',
      sessionID: 'ses_steps',
      part: { partID: `prt_s${i}`, type: 'step-start' },
    }));
    events.push(...tx.onEvent({
      type: 'step_finish',
      sessionID: 'ses_steps',
      part: { partID: `prt_f${i}`, type: 'step-finish', tokens },
    }));
  }

  assert.deepEqual(events.filter((e) => e.kind === 'notice'), [], 'step boundaries are not unrecognised events');
  const usages = events.filter((e) => e.kind === 'usage');
  assert.equal(usages.length, 2);
  const last = usages.at(-1);
  assert.ok(last?.kind === 'usage');
  assert.deepEqual(last.usage, {
    inputTokens: 200,
    outputTokens: 40,
    thinkingTokens: 10,
    cacheReadTokens: 100,
    cacheWriteTokens: 20,
  });
});

for (const name of ['agy', 'codex', 'claude', 'opencode'] as const) {
  test(`${name}: a missing binary yields spawn-failed with the spawn error`, async () => {
    const dir = tempDir();
    const missing = path.join(dir, 'missing-worker');
    const key = `AGENT_SMITH_${name.toUpperCase()}_BIN`;
    const saved = process.env[key];
    process.env[key] = missing;
    try {
      const handle = await getProvider(name).spawn({
        mode: 'test',
        prompt: 'x',
        cwd: dir,
        timeoutMs: 5_000,
        unrestricted: true,
        stateDir: dir,
      });
      const result = await handle.waitForResult();
      assert.equal(result.status, 'spawn-failed');
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /^spawn error: .*ENOENT/);
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  });
}

test('spawnWorker heartbeats while the child runs (pid included), stops at exit, and writes nothing to events.jsonl', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-heartbeat-'));
  const beats: { at: string; pid: number | undefined }[] = [];
  const release = path.join(dir, 'release');
  const child = `setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(release)})){process.exit(0)}},20);setTimeout(()=>process.exit(0),120000)`;
  const worker = await spawnWorker({
    provider: 'fake', binary: process.execPath, argv: ['-e', child],
    cwd: dir, timeoutMs: scaled(60_000), stateDir: dir, jobId: 'heartbeat', mode: 'test',
    heartbeatMs: 50, onHeartbeat: (at, pid) => beats.push({ at, pid }),
    onStdoutLine() {}, onStderr() {},
  });
  await waitFor(() => beats.length >= 3, { message: 'three heartbeats while the child runs' });
  writeFileSync(release, '');
  await worker.exited;
  worker.closeLog();
  const atExit = beats.length;
  assert.ok(atExit >= 3, `expected several beats while the child ran, got ${atExit}`);
  assert.ok(beats.every((b) => b.pid === worker.child.pid && Number.isFinite(Date.parse(b.at))));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(beats.length, atExit, 'no beats after exit');
  assert.equal(existsSync(path.join(dir, 'events.jsonl')), false, 'heartbeats are liveness, not events');
  rmSync(dir, { recursive: true, force: true });
});

test('spawnWorker stops heartbeats when the worker exits, even while a descendant holds stdout open', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-heartbeat-orphan-'));
  const beats: number[] = [];
  const release = path.join(dir, 'release');
  const workerRelease = path.join(dir, 'worker-release');
  const grandchild = `setInterval(()=>{ if (require('node:fs').existsSync(${JSON.stringify(release)})) process.exit(0); }, 20); setTimeout(()=>process.exit(0), 120000)`;
  const script = [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref();`,
    `const t = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(workerRelease)})) process.exit(0); }, 20);`,
  ].join('\n');
  const worker = await spawnWorker({
    provider: 'fake', binary: process.execPath, argv: ['-e', script],
    cwd: dir, timeoutMs: scaled(60_000), stateDir: dir, jobId: 'heartbeat-orphan', mode: 'test',
    heartbeatMs: 30, onHeartbeat: () => beats.push(Date.now()),
    onStdoutLine() {}, onStderr() {},
  });
  let closed = false;
  void worker.exited.then(() => { closed = true; });
  await waitFor(() => beats.length >= 1, { message: 'a heartbeat while the worker runs' });
  writeFileSync(workerRelease, '');
  await once(worker.child, 'exit');
  const atExit = beats.length;
  assert.ok(atExit >= 1, 'beats while the worker ran');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(closed, false, 'stdout is still held open by the grandchild');
  assert.equal(beats.length, atExit, 'no heartbeat after the worker exited');
  writeFileSync(release, '');
  await worker.exited;
  worker.closeLog();
  rmSync(dir, { recursive: true, force: true });
});

test('runNdjsonWorker routes heartbeats to the bus, never to the event log', () => {
  const src = readFileSync(new URL('./ndjson.ts', import.meta.url), 'utf8');
  assert.match(src, /onHeartbeat: \(at, pid\) => bus\.emit\(\{ kind: 'heartbeat'/);
  for (const name of ['agy', 'claude', 'codex', 'kimi', 'opencode']) {
    const adapter = readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8');
    assert.match(adapter, /runNdjsonWorker\(/, name);
  }
});

const TRANSPORT_ERROR = {
  type: 'error',
  sessionID: 'ses_transport',
  error: { type: 'provider.transport', message: 'Connection lost while reading the response: ECONNRESET: The socket connection was closed unexpectedly.' },
};
const toolCall = (id: string) => ({
  type: 'tool_use',
  sessionID: 'ses_transport',
  part: { id, type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'ok' } },
});
const textPart = (text: string) => ({ type: 'text', sessionID: 'ses_transport', part: { type: 'text', text } });
const failedExit = { code: 1, signal: null, killReason: undefined, stderr: '' } as const;
const buildOc = (tx: ReturnType<typeof createOpencodeTranslator>, exit: typeof failedExit | { code: number; signal: null; killReason: undefined; stderr: string }) =>
  buildOpencodeResult({ jobId: 'j', startedAtMs: Date.now(), stateDir: '/tmp/x', exit, tx });

test('opencode: a transport error is a retrying warning, not an environment failure', () => {
  const tx = createOpencodeTranslator(10_000);
  const notice = tx.onEvent(TRANSPORT_ERROR).find((e) => e.kind === 'notice');
  assert.ok(notice?.kind === 'notice');
  assert.equal(notice.level, 'warn');
  assert.match(notice.message, /^provider connection error \(retrying\): Connection lost.*ECONNRESET/);
  assert.doesNotMatch(notice.message, /environment failure/);

  const quota = createOpencodeTranslator(10_000)
    .onEvent({ type: 'error', error: { type: 'provider.quota', message: 'out of credit' } })
    .find((e) => e.kind === 'notice');
  assert.ok(quota?.kind === 'notice');
  assert.equal(quota.level, 'error');
  assert.equal(quota.message, 'environment failure — provider.quota: out of credit');
});

test('opencode: a transport error followed by more work and a report is recovered, despite exit 1', () => {
  const tx = createOpencodeTranslator(10_000);
  tx.onEvent(textPart('Starting the review.'));
  tx.onEvent(toolCall('c1'));
  tx.onEvent(TRANSPORT_ERROR);
  tx.onEvent(toolCall('c2'));
  tx.onEvent(textPart('Final report: no defects.'));
  tx.onEvent({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } });
  const r = buildOc(tx, failedExit);
  assert.equal(r.status, 'success');
  assert.equal(r.ok, true);
  assert.equal(r.error, undefined);
  assert.equal(r.exitCode, 1);
  assert.match(r.response, /Final report/);

  const warning = recoveredErrorNotice(tx.recovery.recovered(tx.finalText, r.exitCode), r);
  assert.ok(warning?.kind === 'notice');
  assert.equal(warning.level, 'warn');
  assert.match(warning.message, /^recovered from a provider connection error at \d\d:\d\d UTC: Connection lost.*ECONNRESET/);
});

test('opencode: a transport error as the last event still fails', () => {
  const tx = createOpencodeTranslator(10_000);
  tx.onEvent(textPart('Starting the review.'));
  tx.onEvent(toolCall('c1'));
  tx.onEvent(TRANSPORT_ERROR);
  const r = buildOc(tx, failedExit);
  assert.equal(r.status, 'error');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /ECONNRESET/);
  assert.equal(recoveredErrorNotice(tx.recovery.recovered(tx.finalText, r.exitCode), r), undefined);
});

test('opencode: tool activity after the error without a report is not a recovery; a later error is not either', () => {
  const noReport = createOpencodeTranslator(10_000);
  noReport.onEvent(textPart('Starting.'));
  noReport.onEvent(TRANSPORT_ERROR);
  noReport.onEvent(toolCall('c1'));
  assert.equal(buildOc(noReport, failedExit).status, 'error');

  const laterError = createOpencodeTranslator(10_000);
  laterError.onEvent(TRANSPORT_ERROR);
  laterError.onEvent(textPart('A report.'));
  laterError.onEvent({ type: 'error', error: { type: 'provider.quota', message: 'out of credit' } });
  const r = buildOc(laterError, failedExit);
  assert.equal(r.status, 'error');
  assert.match(r.error ?? '', /out of credit/);

  const killed = createOpencodeTranslator(10_000);
  killed.onEvent(TRANSPORT_ERROR);
  killed.onEvent(textPart('A report.'));
  assert.equal(buildOc(killed, { code: null, signal: null, killReason: undefined, stderr: '' } as never).status, 'error');
});

test('kimi: an error followed by assistant text recovers on a clean exit', () => {
  const tx = createKimiTranslator(200);
  tx.onEvent({ role: 'assistant', content: 'Starting.' });
  tx.onEvent({ role: 'meta', type: 'error', error: { message: 'stream dropped' } });
  tx.onEvent({ role: 'assistant', content: 'Final report.' });
  const exit = { code: 0, signal: null, killReason: undefined, stderr: '' } as const;
  const r = buildKimiResult({ jobId: 'j', startedAtMs: Date.now(), stateDir: '/tmp/x', exit, tx });
  assert.equal(r.status, 'success');
  assert.equal(r.ok, true);
  assert.equal(r.error, undefined);
  const warning = recoveredErrorNotice(tx.recovery.recovered(tx.finalText, r.exitCode), r);
  assert.ok(warning?.kind === 'notice');
  assert.equal(warning.level, 'warn');
  assert.match(warning.message, /^recovered from a worker error at \d\d:\d\d UTC: stream dropped/);
});

test('kimi: an error as the last meaningful event still fails', () => {
  const tx = createKimiTranslator(200);
  tx.onEvent({ role: 'assistant', content: 'Starting.' });
  tx.onEvent({ role: 'meta', type: 'error', error: { message: 'stream dropped' } });
  const exit = { code: 0, signal: null, killReason: undefined, stderr: '' } as const;
  const r = buildKimiResult({ jobId: 'j', startedAtMs: Date.now(), stateDir: '/tmp/x', exit, tx });
  assert.equal(r.status, 'error');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /stream dropped/);
  assert.equal(recoveredErrorNotice(tx.recovery.recovered(tx.finalText, r.exitCode), r), undefined);
});

test('opencode: retry prose and unfinished tools do not recover a crashed worker', () => {
  const tx = createOpencodeTranslator(10_000);
  tx.onEvent(TRANSPORT_ERROR);
  tx.onEvent(textPart('I will retry and inspect the remaining files.'));
  tx.onEvent({ type: 'tool_use', part: {
    id: 'unfinished', type: 'tool', tool: 'bash',
    state: { status: 'running', input: { command: 'npm test' } },
  } });
  const r = buildOc(tx, { ...failedExit, stderr: 'fatal: unhandled exception' });
  assert.equal(r.status, 'error');
  assert.equal(r.ok, false);
  assert.equal(recoveredErrorNotice(tx.recovery.recovered(tx.finalText, r.exitCode), r), undefined);
});

test('opencode: only a normal step finish can recover a failed exit', () => {
  for (const reason of [undefined, 'tool-calls', 'length', 'error', 'stop']) {
    const tx = createOpencodeTranslator(10_000);
    tx.onEvent(TRANSPORT_ERROR);
    tx.onEvent(textPart('Partial or final report.'));
    tx.onEvent({ type: 'step_finish', part: { type: 'step-finish', reason } });
    assert.equal(buildOc(tx, failedExit).status, reason === 'stop' ? 'success' : 'error', String(reason));
  }
});

test('opencode: later work or errors invalidate an earlier completion', () => {
  const laterEvents = [
    textPart('One more thing to investigate.'),
    toolCall('later'),
    { type: 'step_start', part: { type: 'step-start' } },
    { type: 'error', error: { type: 'provider.quota', message: 'out of credit' } },
  ];
  for (const event of laterEvents) {
    const tx = createOpencodeTranslator(10_000);
    tx.onEvent(TRANSPORT_ERROR);
    tx.onEvent(textPart('A report.'));
    tx.onEvent({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } });
    tx.onEvent(event);
    assert.equal(buildOc(tx, failedExit).status, 'error', event.type);
  }
});

test('kimi: assistant text cannot recover a nonzero exit without a verified completion marker', () => {
  const tx = createKimiTranslator(200);
  tx.onEvent({ role: 'meta', type: 'error', error: { message: 'stream dropped' } });
  tx.onEvent({ role: 'assistant', content: 'I will retry.', tool_calls: [
    { id: 'unfinished', type: 'function', function: { name: 'Bash', arguments: '{"command":"npm test"}' } },
  ] });
  const r = buildKimiResult({ jobId: 'j', startedAtMs: Date.now(), stateDir: '/tmp/x', exit: failedExit, tx });
  assert.equal(r.status, 'error');
  assert.equal(r.ok, false);
});

test('opencode: completion before post-error text cannot corroborate a failed exit', () => {
  const tx = createOpencodeTranslator(10_000);
  tx.onEvent(TRANSPORT_ERROR);
  tx.onEvent({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } });
  tx.onEvent(textPart('Still working.'));
  assert.equal(buildOc(tx, failedExit).status, 'error');
});

test('opencode: explicit session completion corroborates a recovered report', () => {
  const tx = createOpencodeTranslator(10_000);
  tx.onEvent(TRANSPORT_ERROR);
  tx.onEvent(textPart('Final report.'));
  tx.onEvent({ type: 'session.completed' });
  assert.equal(buildOc(tx, failedExit).status, 'success');
});

test('all provider adapters: prose, tool call, final prose returns only final prose', async (t) => {
  const exit = { code: 0, signal: null, killReason: undefined, stderr: '' };

  await t.test('agy', () => {
    const tx = createAgyTranslator(2000);
    tx.onEvent({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'earlier prose' } });
    tx.onEvent({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: {} } });
    tx.onEvent({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { output: 'ok' } } });
    tx.onEvent({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: 'final prose' } });
    const res = buildAgyResult({
      jobId: 'j',
      resultEvent: { status: 'SUCCESS', response: 'earlier prose\nfinal prose' },
      exit,
      startedAtMs: Date.now() - 10,
      stateDir: '/tmp',
      denials: tx.denials,
      sawAnyToolCall: tx.stepsWereTools(),
      errorIsStale: tx.errorIsStale(),
      answer: tx.answer,
    });
    assert.equal(res.response, 'final prose');
  });

  await t.test('claude', () => {
    const tx = createClaudeTranslator(2000);
    tx.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'earlier prose' }] } });
    tx.onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
    tx.onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
    tx.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'final prose' }] } });
    tx.onEvent({ type: 'result', subtype: 'success', result: 'final prose' });
    const res = buildClaudeResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit, tx });
    assert.equal(res.response, 'final prose');
  });

  await t.test('codex', () => {
    const tx = createCodexTranslator(2000);
    tx.onEvent({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'earlier prose' } });
    tx.onEvent({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } });
    tx.onEvent({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', exit_code: 0 } });
    tx.onEvent({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'final prose' } });
    tx.onEvent({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    const res = buildCodexResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit, tx });
    assert.equal(res.response, 'final prose');
  });

  await t.test('opencode', () => {
    const tx = createOpencodeTranslator(2000);
    tx.onEvent({ type: 'text', text: 'earlier prose' });
    tx.onEvent({ type: 'tool.started', part: { id: 'p1', tool: 'bash', state: { status: 'running', input: {} } } });
    tx.onEvent({ type: 'tool.completed', part: { id: 'p1', tool: 'bash', state: { status: 'completed', output: 'ok' } } });
    tx.onEvent({ type: 'text', text: 'final prose' });
    tx.onEvent({ type: 'session.completed' });
    const res = buildOpencodeResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit, tx });
    assert.equal(res.response, 'final prose');
  });

  await t.test('kimi', () => {
    const tx = createKimiTranslator(2000);
    tx.onEvent({ role: 'assistant', content: 'earlier prose' });
    tx.onEvent({ role: 'assistant', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] });
    tx.onEvent({ role: 'tool', tool_call_id: 'tc1', content: 'ok' });
    tx.onEvent({ role: 'assistant', content: 'final prose' });
    const res = buildKimiResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit, tx });
    assert.equal(res.response, 'final prose');
  });
});

test('all provider adapters: prose then tool call and nothing after returns empty response and not success', async (t) => {
  const exit = { code: 0, signal: null, killReason: undefined, stderr: '' };

  await t.test('agy', () => {
    const tx = createAgyTranslator(2000);
    tx.onEvent({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'earlier prose' } });
    tx.onEvent({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: {} } });
    tx.onEvent({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { output: 'ok' } } });
    const res = buildAgyResult({
      jobId: 'j',
      resultEvent: { status: 'SUCCESS', response: '' },
      exit,
      startedAtMs: Date.now() - 10,
      stateDir: '/tmp',
      denials: tx.denials,
      sawAnyToolCall: tx.stepsWereTools(),
      errorIsStale: tx.errorIsStale(),
      answer: tx.answer,
    });
    assert.equal(res.response, '');
    assert.notEqual(res.status, 'success');
  });

  await t.test('claude', () => {
    const tx = createClaudeTranslator(2000);
    tx.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'earlier prose' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
    tx.onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
    tx.onEvent({ type: 'result', subtype: 'success', is_error: false, result: '' });
    const res = buildClaudeResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit, tx });
    assert.equal(res.response, '');
    assert.notEqual(res.status, 'success');
  });

  await t.test('codex', () => {
    const tx = createCodexTranslator(2000);
    tx.onEvent({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'earlier prose' } });
    tx.onEvent({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } });
    tx.onEvent({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', exit_code: 0 } });
    tx.onEvent({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    const res = buildCodexResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit, tx });
    assert.equal(res.response, '');
    assert.notEqual(res.status, 'success');
  });

  await t.test('opencode', () => {
    const tx = createOpencodeTranslator(2000);
    tx.onEvent({ type: 'step_start' });
    tx.onEvent({ type: 'text', text: 'earlier prose' });
    tx.onEvent({ type: 'tool.started', part: { id: 'p1', tool: 'bash', state: { status: 'running', input: {} } } });
    tx.onEvent({ type: 'tool.completed', part: { id: 'p1', tool: 'bash', state: { status: 'completed', output: 'ok' } } });
    const res = buildOpencodeResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit, tx });
    assert.equal(res.response, '');
    assert.notEqual(res.status, 'success');
  });

  await t.test('kimi', () => {
    const tx = createKimiTranslator(2000);
    tx.onEvent({ role: 'assistant', content: 'earlier prose', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] });
    tx.onEvent({ role: 'tool', tool_call_id: 'tc1', content: 'ok' });
    const res = buildKimiResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit, tx });
    assert.equal(res.response, '');
    assert.notEqual(res.status, 'success');
  });
});

test('all provider adapters: prose, tool call, then empty final message returns empty response and not success', async (t) => {
  const exit = { code: 0, signal: null, killReason: undefined, stderr: '' };

  await t.test('agy', () => {
    const tx = createAgyTranslator(2000);
    tx.onEvent({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'earlier prose' } });
    tx.onEvent({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: {} } });
    tx.onEvent({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { output: 'ok' } } });
    tx.onEvent({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: '' } });
    const res = buildAgyResult({
      jobId: 'j',
      resultEvent: { status: 'SUCCESS', response: '' },
      exit,
      startedAtMs: Date.now() - 10,
      stateDir: '/tmp',
      denials: tx.denials,
      sawAnyToolCall: tx.stepsWereTools(),
      errorIsStale: tx.errorIsStale(),
      answer: tx.answer,
    });
    assert.equal(res.response, '');
    assert.notEqual(res.status, 'success');
  });

  await t.test('claude', () => {
    const tx = createClaudeTranslator(2000);
    tx.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'earlier prose' }] } });
    tx.onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
    tx.onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
    tx.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '' }] } });
    tx.onEvent({ type: 'result', subtype: 'success', is_error: false, result: '' });
    const res = buildClaudeResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit, tx });
    assert.equal(res.response, '');
    assert.notEqual(res.status, 'success');
  });

  await t.test('codex', () => {
    const tx = createCodexTranslator(2000);
    tx.onEvent({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'earlier prose' } });
    tx.onEvent({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } });
    tx.onEvent({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', exit_code: 0 } });
    tx.onEvent({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: '' } });
    tx.onEvent({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    const res = buildCodexResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit, tx });
    assert.equal(res.response, '');
    assert.notEqual(res.status, 'success');
  });

  await t.test('opencode', () => {
    const tx = createOpencodeTranslator(2000);
    tx.onEvent({ type: 'step_start' });
    tx.onEvent({ type: 'text', text: 'earlier prose' });
    tx.onEvent({ type: 'tool.started', part: { id: 'p1', tool: 'bash', state: { status: 'running', input: {} } } });
    tx.onEvent({ type: 'tool.completed', part: { id: 'p1', tool: 'bash', state: { status: 'completed', output: 'ok' } } });
    tx.onEvent({ type: 'text', text: '' });
    const res = buildOpencodeResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit, tx });
    assert.equal(res.response, '');
    assert.notEqual(res.status, 'success');
  });

  await t.test('kimi', () => {
    const tx = createKimiTranslator(2000);
    tx.onEvent({ role: 'assistant', content: 'earlier prose' });
    tx.onEvent({ role: 'assistant', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] });
    tx.onEvent({ role: 'tool', tool_call_id: 'tc1', content: 'ok' });
    tx.onEvent({ role: 'assistant', content: '' });
    const res = buildKimiResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit, tx });
    assert.equal(res.response, '');
    assert.notEqual(res.status, 'success');
  });
});

test('claude: denied tool after prose with empty result is denied, and multi-turn crash keeps only final message', () => {
  const exit = { code: 0, signal: null, killReason: undefined, stderr: '' };
  const deniedTx = createClaudeTranslator(2000);
  deniedTx.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me run bash' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf /' } }] } });
  deniedTx.onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Permission denied' }] } });
  deniedTx.onEvent({ type: 'result', subtype: 'success', is_error: false, result: '', permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1' }] });
  const deniedRes = buildClaudeResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit, tx: deniedTx });
  assert.equal(deniedRes.status, 'denied');
  assert.equal(deniedRes.response, '');

  const crashTx = createClaudeTranslator(2000);
  crashTx.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } });
  crashTx.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } });
  const crashRes = buildClaudeResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit: { code: 1, signal: null, killReason: undefined, stderr: 'boom' }, tx: crashTx });
  assert.equal(crashRes.response, 'second');
});

test('opencode: error then prose then tool call does not recover as success', () => {
  const tx = createOpencodeTranslator(2000);
  tx.onEvent({ type: 'error', error: { message: 'temporary failure' } });
  tx.onEvent({ type: 'text', text: 'Retrying now...' });
  tx.onEvent({ type: 'tool.started', part: { id: 'p1', tool: 'bash', state: { status: 'running', input: {} } } });
  tx.onEvent({ type: 'tool.completed', part: { id: 'p1', tool: 'bash', state: { status: 'completed', output: 'ok' } } });
  const res = buildOpencodeResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit: { code: 0, signal: null, killReason: undefined, stderr: '' }, tx });
  assert.equal(res.status, 'error');
  assert.equal(res.response, '');

  const stopTx = createOpencodeTranslator(2000);
  stopTx.onEvent({ type: 'step_start' });
  stopTx.onEvent({ type: 'text', text: 'I will check.' });
  stopTx.onEvent({ type: 'tool.completed', part: { id: 'p2', tool: 'bash', state: { status: 'completed', output: 'ok' } } });
  stopTx.onEvent({ type: 'step_start' });
  stopTx.onEvent({ type: 'step_finish', part: { reason: 'stop' } });
  const stopRes = buildOpencodeResult({ jobId: 'j2', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit: { code: 0, signal: null, killReason: undefined, stderr: '' }, tx: stopTx });
  assert.equal(stopRes.status, 'malformed');
  assert.equal(stopRes.response, '');
});

test('codex and kimi: empty final message after earlier prose clears finalText', () => {
  const exit = { code: 0, signal: null, killReason: undefined, stderr: '' };

  const codexTx = createCodexTranslator(2000);
  codexTx.onEvent({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Working...' } });
  codexTx.onEvent({ type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: '' } });
  codexTx.onEvent({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  const codexRes = buildCodexResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit, tx: codexTx });
  assert.equal(codexRes.response, '');
  assert.notEqual(codexRes.status, 'success');

  const kimiTx = createKimiTranslator(2000);
  kimiTx.onEvent({ role: 'assistant', content: 'Checking...' });
  kimiTx.onEvent({ role: 'assistant', content: '' });
  const kimiRes = buildKimiResult({ jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit, tx: kimiTx });
  assert.equal(kimiRes.response, '');
  assert.notEqual(kimiRes.status, 'success');
});

test('all provider adapters: response rule table', async (t) => {
  const exit = { code: 0, signal: null, killReason: undefined, stderr: '' };
  const startedAtMs = Date.now() - 10;
  const base = { jobId: 'j', startedAtMs, stateDir: '/tmp', exit };

  const runAgy = (events: Record<string, unknown>[], resultEvent?: Record<string, unknown>) => {
    const tx = createAgyTranslator(2000);
    for (const ev of events) tx.onEvent(ev);
    return buildAgyResult({
      ...base,
      resultEvent,
      denials: tx.denials,
      sawAnyToolCall: tx.stepsWereTools(),
      errorIsStale: tx.errorIsStale(),
      answer: tx.answer,
    });
  };
  const runClaude = (events: Record<string, unknown>[]) => {
    const tx = createClaudeTranslator(2000);
    for (const ev of events) tx.onEvent(ev);
    return buildClaudeResult({ ...base, tx });
  };
  const runCodex = (events: Record<string, unknown>[]) => {
    const tx = createCodexTranslator(2000);
    for (const ev of events) tx.onEvent(ev);
    return buildCodexResult({ ...base, tx });
  };
  const runOpencode = (events: Record<string, unknown>[]) => {
    const tx = createOpencodeTranslator(2000);
    for (const ev of events) tx.onEvent(ev);
    return buildOpencodeResult({ ...base, tx });
  };
  const runKimi = (events: Record<string, unknown>[]) => {
    const tx = createKimiTranslator(2000);
    for (const ev of events) tx.onEvent(ev);
    return buildKimiResult({ ...base, tx });
  };

  await t.test('1. prose, real tool, final prose -> final prose; success', async (st) => {
    await st.test('agy', () => {
      const res = runAgy(
        [
          { event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'earlier' } },
          { event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: {} } },
          { event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { output: 'ok' } } },
          { event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: 'final' } },
        ],
        { status: 'SUCCESS', response: 'earlier\nfinal' },
      );
      assert.equal(res.status, 'success');
      assert.equal(res.response, 'final');
    });
    await st.test('claude', () => {
      const res = runClaude([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'earlier' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'final' }] } },
        { type: 'result', subtype: 'success', is_error: false },
      ]);
      assert.equal(res.status, 'success');
      assert.equal(res.response, 'final');
    });
    await st.test('codex', () => {
      const res = runCodex([
        { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'earlier' } },
        { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } },
        { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', exit_code: 0 } },
        { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: 'final' } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ]);
      assert.equal(res.status, 'success');
      assert.equal(res.response, 'final');
    });
    await st.test('opencode', () => {
      const res = runOpencode([
        { type: 'step_start' },
        { type: 'text', part: { type: 'text', text: 'earlier' } },
        { type: 'tool.started', part: { id: 'p1', tool: 'bash', state: { status: 'running', input: {} } } },
        { type: 'tool.completed', part: { id: 'p1', tool: 'bash', state: { status: 'completed', output: 'ok' } } },
        { type: 'step_start' },
        { type: 'text', part: { type: 'text', text: 'final' } },
        { type: 'step_finish', part: { reason: 'stop' } },
      ]);
      assert.equal(res.status, 'success');
      assert.equal(res.response, 'final');
    });
    await st.test('kimi', () => {
      const res = runKimi([
        { role: 'assistant', content: 'earlier' },
        { role: 'assistant', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'tc1', content: 'ok' },
        { role: 'assistant', content: 'final' },
      ]);
      assert.equal(res.status, 'success');
      assert.equal(res.response, 'final');
    });
  });

  await t.test('2. prose, real tool, nothing after -> empty; not success', async (st) => {
    await st.test('agy', () => {
      const res = runAgy(
        [
          { event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'earlier' } },
          { event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: {} } },
          { event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { output: 'ok' } } },
        ],
        { status: 'SUCCESS', response: 'earlier' },
      );
      assert.equal(res.response, '');
      assert.notEqual(res.status, 'success');
    });
    await st.test('claude', () => {
      const res = runClaude([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'earlier' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
        { type: 'result', subtype: 'success', is_error: false },
      ]);
      assert.equal(res.response, '');
      assert.notEqual(res.status, 'success');
    });
    await st.test('codex', () => {
      const res = runCodex([
        { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'earlier' } },
        { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } },
        { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', exit_code: 0 } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ]);
      assert.equal(res.response, '');
      assert.notEqual(res.status, 'success');
    });
    await st.test('opencode', () => {
      const res = runOpencode([
        { type: 'step_start' },
        { type: 'text', part: { type: 'text', text: 'earlier' } },
        { type: 'tool.started', part: { id: 'p1', tool: 'bash', state: { status: 'running', input: {} } } },
        { type: 'tool.completed', part: { id: 'p1', tool: 'bash', state: { status: 'completed', output: 'ok' } } },
        { type: 'step_finish', part: { reason: 'stop' } },
      ]);
      assert.equal(res.response, '');
      assert.notEqual(res.status, 'success');
    });
    await st.test('kimi', () => {
      const res = runKimi([
        { role: 'assistant', content: 'earlier' },
        { role: 'assistant', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'tc1', content: 'ok' },
      ]);
      assert.equal(res.response, '');
      assert.notEqual(res.status, 'success');
    });
  });

  await t.test('3. prose, real tool, empty final message -> empty; not success', async (st) => {
    await st.test('agy', () => {
      const res = runAgy(
        [
          { event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'earlier' } },
          { event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: {} } },
          { event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { output: 'ok' } } },
          { event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: '' } },
        ],
        { status: 'SUCCESS', response: '' },
      );
      assert.equal(res.response, '');
      assert.notEqual(res.status, 'success');
    });
    await st.test('claude', () => {
      const res = runClaude([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'earlier' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: '' },
      ]);
      assert.equal(res.response, '');
      assert.notEqual(res.status, 'success');
    });
    await st.test('codex', () => {
      const res = runCodex([
        { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'earlier' } },
        { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } },
        { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', exit_code: 0 } },
        { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: '' } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ]);
      assert.equal(res.response, '');
      assert.notEqual(res.status, 'success');
    });
    await st.test('opencode', () => {
      const res = runOpencode([
        { type: 'step_start' },
        { type: 'text', part: { type: 'text', text: 'earlier' } },
        { type: 'tool.started', part: { id: 'p1', tool: 'bash', state: { status: 'running', input: {} } } },
        { type: 'tool.completed', part: { id: 'p1', tool: 'bash', state: { status: 'completed', output: 'ok' } } },
        { type: 'text', part: { type: 'text', text: '' } },
      ]);
      assert.equal(res.response, '');
      assert.notEqual(res.status, 'success');
    });
    await st.test('kimi', () => {
      const res = runKimi([
        { role: 'assistant', content: 'earlier' },
        { role: 'assistant', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'tc1', content: 'ok' },
        { role: 'assistant', content: '' },
      ]);
      assert.equal(res.response, '');
      assert.notEqual(res.status, 'success');
    });
  });

  await t.test('4. prose, then empty final message with no tool -> empty; not success', async (st) => {
    await st.test('agy', () => {
      const res = runAgy(
        [
          { event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'Narration' } },
          { event: 'step_update', step_update: { step_index: 2, step_type: 'agent_response', state: 'DONE', text_delta: '' } },
        ],
        { status: 'SUCCESS', response: '' },
      );
      assert.equal(res.response, '');
      assert.notEqual(res.status, 'success');
    });
    await st.test('claude', () => {
      const res = runClaude([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Narration' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '' }] } },
        { type: 'result', subtype: 'success', is_error: false },
      ]);
      assert.equal(res.response, '');
      assert.notEqual(res.status, 'success');
    });
    await st.test('codex', () => {
      const res = runCodex([
        { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Narration' } },
        { type: 'item.completed', item: { id: 'm2', type: 'agent_message', text: '' } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ]);
      assert.equal(res.response, '');
      assert.notEqual(res.status, 'success');
    });
    await st.test('opencode', () => {
      const res = runOpencode([
        { type: 'text', part: { type: 'text', text: 'Narration' } },
        { type: 'text', part: { type: 'text', text: '' } },
      ]);
      assert.equal(res.response, '');
      assert.notEqual(res.status, 'success');
    });
    await st.test('kimi', () => {
      const res = runKimi([
        { role: 'assistant', content: 'Narration' },
        { role: 'assistant', content: '' },
      ]);
      assert.equal(res.response, '');
      assert.notEqual(res.status, 'success');
    });
  });

  await t.test('5. answer, then only todo/plan tool -> answer; success', async (st) => {
    await st.test('claude', () => {
      const res = runClaude([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [] } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
        { type: 'result', subtype: 'success', is_error: false },
      ]);
      assert.equal(res.status, 'success');
      assert.equal(res.response, 'answer');
    });
    await st.test('codex', () => {
      const res = runCodex([
        { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'answer' } },
        { type: 'item.completed', item: { id: 't1', type: 'todo_list', items: [{ text: 'done', completed: true }] } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ]);
      assert.equal(res.status, 'success');
      assert.equal(res.response, 'answer');
    });
    await st.test('opencode', () => {
      const res = runOpencode([
        { type: 'step_start' },
        { type: 'text', part: { type: 'text', text: 'answer' } },
        { type: 'tool.completed', part: { id: 'p1', callID: 'c1', type: 'tool', tool: 'todowrite', state: { status: 'completed', input: { todos: [] }, output: 'ok' } } },
        { type: 'step_start' },
        { type: 'step_finish', part: { reason: 'stop' } },
      ]);
      assert.equal(res.status, 'success');
      assert.equal(res.response, 'answer');
    });
    await st.test('kimi', () => {
      const res = runKimi([
        { role: 'assistant', content: 'answer' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'SetTodoList', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'tc1', content: 'ok' },
        { role: 'tool', tool_call_id: 'tc1', content: 'ok' },
      ]);
      assert.equal(res.status, 'success');
      assert.equal(res.response, 'answer');
    });
    await st.test('kimi duplicate tool result after answer', () => {
      const res = runKimi([
        { role: 'assistant', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'tc1', content: 'ok' },
        { role: 'assistant', content: 'answer' },
        { role: 'tool', tool_call_id: 'tc1', content: 'ok' },
      ]);
      assert.equal(res.status, 'success');
      assert.equal(res.response, 'answer');
    });
  });

  await t.test('6. one message delivered in several fragments -> joined without separator', async (st) => {
    await st.test('agy', () => {
      const res = runAgy(
        [
          { event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'hel' } },
          { event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'lo' } },
        ],
        { status: 'SUCCESS', response: 'hello' },
      );
      assert.equal(res.status, 'success');
      assert.equal(res.response, 'hello');
    });
    await st.test('claude', () => {
      const res = runClaude([
        { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'First part. ' }] } },
        { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Second part.' }] } },
        { type: 'result', subtype: 'success', is_error: false },
      ]);
      assert.equal(res.status, 'success');
      assert.equal(res.response, 'First part. Second part.');
    });
    await st.test('opencode', () => {
      const res = runOpencode([
        { type: 'step_start' },
        { type: 'text', part: { type: 'text', messageID: 'm1', text: 'hel' } },
        { type: 'text', part: { type: 'text', messageID: 'm1', text: 'lo' } },
        { type: 'step_finish', part: { reason: 'stop' } },
      ]);
      assert.equal(res.status, 'success');
      assert.equal(res.response, 'hello');
    });
  });

  await t.test('7. denied tool after prose with repeated final field -> empty; denied', async (st) => {
    await st.test('agy', () => {
      const res = runAgy(
        [
          { event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'I will try the tool.' } },
          { event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ERROR', tool_name: 'run_command', tool_info: { error: { message: 'permission check failed' } } } },
        ],
        { status: 'SUCCESS', response: 'I will try the tool.' },
      );
      assert.equal(res.status, 'denied');
      assert.equal(res.response, '');
    });
    await st.test('claude', () => {
      const res = runClaude([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'I will try the tool.' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Permission denied' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: 'I will try the tool.', permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1' }] },
      ]);
      assert.equal(res.status, 'denied');
      assert.equal(res.response, '');
    });
    await st.test('codex', () => {
      const res = runCodex([
        { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'I will try the tool.' } },
        { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', status: 'declined' } },
        { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
      ]);
      assert.notEqual(res.status, 'success');
      assert.equal(res.response, '');
    });
    await st.test('opencode', () => {
      const res = runOpencode([
        { type: 'step_start' },
        { type: 'text', part: { type: 'text', text: 'I will try the tool.' } },
        { type: 'tool.error', part: { id: 'p1', tool: 'bash', state: { status: 'error', error: 'permission denied' } } },
      ]);
      assert.equal(res.status, 'denied');
      assert.equal(res.response, '');
    });
  });

  await t.test('8. claude only: subagent text with parent_tool_use_id on block or envelope never becomes response', () => {
    const blockRes = runClaude([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Subagent block', parent_tool_use_id: 'tu1' }] } },
      { type: 'result', subtype: 'success', is_error: false },
    ]);
    assert.equal(blockRes.response, '');
    assert.notEqual(blockRes.status, 'success');

    const envRes = runClaude([
      { type: 'assistant', parent_tool_use_id: 'tu1', message: { content: [{ type: 'text', text: 'Subagent envelope' }] } },
      { type: 'result', subtype: 'success', is_error: false },
    ]);
    assert.equal(envRes.response, '');
    assert.notEqual(envRes.status, 'success');
  });
});

test('opencode: 402 error.status envelope preserves HTTP 402 in error text', () => {
  const tx = createOpencodeTranslator(2000);
  tx.onEvent({
    type: 'error',
    sessionID: 'ses_1',
    error: {
      type: 'provider.quota',
      message: 'Upstream request failed: Insufficient account funds',
      status: 402,
    },
  });
  const res = buildOpencodeResult({
    jobId: 'j',
    startedAtMs: Date.now() - 10,
    stateDir: '/tmp',
    exit: { code: 1, signal: null, killReason: undefined, stderr: '' },
    tx,
  });
  assert.equal(res.status, 'error');
  assert.match(res.error ?? '', /^HTTP 402: /);
});

test('reviewers: agy/claude final field and opencode/kimi mapping regressions', async (t) => {
  const exit = { code: 0, signal: null, killReason: undefined, stderr: '' };
  const base = { jobId: 'j', startedAtMs: Date.now() - 10, stateDir: '/tmp', exit };

  await t.test('agy: trimmed/newline pre-tool narration repeated in result.response stays empty', () => {
    const tx1 = createAgyTranslator(2000);
    tx1.onEvent({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'I will inspect.' } });
    tx1.onEvent({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: {} } });
    tx1.onEvent({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { output: 'ok' } } });
    const res1 = buildAgyResult({ ...base, resultEvent: { status: 'SUCCESS', response: 'I will inspect' }, denials: tx1.denials, sawAnyToolCall: tx1.stepsWereTools(), errorIsStale: tx1.errorIsStale(), answer: tx1.answer });
    assert.equal(res1.response, '');
    assert.notEqual(res1.status, 'success');

    const tx2 = createAgyTranslator(2000);
    tx2.onEvent({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'ACTIVE', text_delta: '\n' } });
    tx2.onEvent({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'Let me run tests.' } });
    tx2.onEvent({ event: 'step_update', step_update: { step_index: 2, step_type: 'tool', state: 'ERROR', tool_name: 'run_command', tool_info: { error: { message: 'permission check failed' } } } });
    const res2 = buildAgyResult({ ...base, resultEvent: { status: 'SUCCESS', response: '\nLet me run tests.' }, denials: tx2.denials, sawAnyToolCall: tx2.stepsWereTools(), errorIsStale: tx2.errorIsStale(), answer: tx2.answer });
    assert.equal(res2.status, 'denied');
    assert.equal(res2.response, '');
  });

  await t.test('claude: authoritative result replaces post-denial text and stays empty when no post-tool text ran', () => {
    const tx1 = createClaudeTranslator(2000);
    tx1.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Short final' }] } });
    tx1.onEvent({ type: 'result', subtype: 'success', is_error: false, result: 'Full authoritative report', permission_denials: [{ tool_name: 'Bash', tool_use_id: 't1' }] });
    const res1 = buildClaudeResult({ ...base, tx: tx1 });
    assert.equal(res1.status, 'success');
    assert.equal(res1.response, 'Full authoritative report');

    const tx2 = createClaudeTranslator(2000);
    tx2.onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will run tests.' }] } });
    tx2.onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } });
    tx2.onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'exit 1' }] } });
    tx2.onEvent({ type: 'result', subtype: 'success', is_error: false, result: 'I will run tests.' });
    const res2 = buildClaudeResult({ ...base, tx: tx2 });
    assert.equal(res2.response, '');
    assert.notEqual(res2.status, 'success');
  });

  await t.test('opencode: messageID grouping, reasoning part, open tool / tool-calls finish', () => {
    const tx1 = createOpencodeTranslator(2000);
    tx1.onEvent({ type: 'step_start' });
    tx1.onEvent({ type: 'text', part: { type: 'text', messageID: 'm1', text: 'Earlier answer' } });
    tx1.onEvent({ type: 'text', part: { type: 'text', messageID: 'm2', text: 'Real answer' } });
    tx1.onEvent({ type: 'step_finish', part: { reason: 'stop' } });
    assert.equal(buildOpencodeResult({ ...base, tx: tx1 }).response, 'Real answer');

    const tx2 = createOpencodeTranslator(2000);
    tx2.onEvent({ type: 'step_start' });
    tx2.onEvent({ type: 'text', part: { type: 'text', messageID: 'm1', text: 'First' } });
    tx2.onEvent({ type: 'tool.completed', part: { id: 'p1', tool: 'todowrite', state: { status: 'completed', output: 'ok' } } });
    tx2.onEvent({ type: 'text', part: { type: 'text', messageID: 'm1', text: 'Second' } });
    tx2.onEvent({ type: 'step_finish', part: { reason: 'stop' } });
    assert.equal(buildOpencodeResult({ ...base, tx: tx2 }).response, 'FirstSecond');

    const tx3 = createOpencodeTranslator(2000);
    tx3.onEvent({ type: 'step_start' });
    tx3.onEvent({ type: 'text', part: { type: 'text', messageID: 'm1', text: 'Final answer.' } });
    tx3.onEvent({ type: 'text', part: { type: 'text', messageID: 'm1', text: '' } });
    tx3.onEvent({ type: 'step_finish', part: { reason: 'stop' } });
    assert.equal(buildOpencodeResult({ ...base, tx: tx3 }).response, 'Final answer.');

    const tx4 = createOpencodeTranslator(2000);
    tx4.onEvent({ type: 'step_start' });
    tx4.onEvent({ type: 'message.part.updated', part: { type: 'reasoning', text: 'Thinking only, no answer.' } });
    tx4.onEvent({ type: 'step_finish', part: { reason: 'stop' } });
    const res4 = buildOpencodeResult({ ...base, tx: tx4 });
    assert.equal(res4.response, '');
    assert.notEqual(res4.status, 'success');

    const tx5 = createOpencodeTranslator(2000);
    tx5.onEvent({ type: 'step_start' });
    tx5.onEvent({ type: 'tool.started', part: { id: 'p1', tool: 'bash', state: { status: 'running', input: {} } } });
    tx5.onEvent({ type: 'text', part: { type: 'text', messageID: 'm1', text: 'Still waiting.' } });
    tx5.onEvent({ type: 'step_finish', part: { reason: 'tool-calls' } });
    const res5 = buildOpencodeResult({ ...base, tx: tx5 });
    assert.equal(res5.response, '');
    assert.notEqual(res5.status, 'success');
  });

  await t.test('kimi: whitespace-only content on SetTodoList-only assistant record keeps prior answer', () => {
    const tx = createKimiTranslator(2000);
    tx.onEvent({ role: 'assistant', content: 'All done.' });
    tx.onEvent({ role: 'assistant', content: '   ', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'SetTodoList', arguments: '{}' } }] });
    tx.onEvent({ role: 'tool', tool_call_id: 'tc1', content: 'ok' });
    const res = buildKimiResult({ ...base, tx });
    assert.equal(res.status, 'success');
    assert.equal(res.response, 'All done.');
  });
});
