import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildArgv as buildClaudeArgv, buildResult as buildClaudeResult, createClaudeTranslator } from './claude.ts';
import { buildArgv as buildCodexArgv, codexStderrLevel, createCodexTranslator } from './codex.ts';
import { buildArgv as buildAgyArgv } from './agy.ts';
import { buildArgv as buildOpencodeArgv, createOpencodeTranslator } from './opencode.ts';
import { buildArgv as buildKimiArgv, buildResult as buildKimiResult, createKimiTranslator } from './kimi.ts';
import { spawnWorker } from './ndjson.ts';
import type { ProviderEvent, SpawnSpec } from './types.ts';
import { trackedTempDirs } from '../forge/testing/tmp.ts';

const tempDir = trackedTempDirs('agent-smith-provider-test-');

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

test('Codex rejects an effort the CLI adapter does not support', () => {
  assert.throws(
    () => buildCodexArgv(spec({ effort: 'maximum-ish' })),
    /codex does not support effort 'maximum-ish'/,
  );
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
  const descendantCode = `process.on('SIGTERM',()=>{}); setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(delayedMarker)},'alive'),900); setInterval(()=>{},1000)`;
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
    timeoutMs: 10_000,
    killGraceMs: 100,
    stateDir: dir,
    jobId: 'group-kill',
    mode: 'test',
    onStdoutLine() {},
    onStderr() {},
  });

  // Wait until the grandchild is live before asking the worker to stop.
  for (let i = 0; i < 100 && !existsSync(childPidFile); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(existsSync(childPidFile), 'fake worker started its descendant');
  const descendantPid = Number(readFileSync(childPidFile, 'utf8'));
  worker.terminate('cancelled');
  const exit = await worker.exited;
  worker.closeLog();
  assert.equal(worker.killReason, 'cancelled');
  assert.ok(exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL');

  // The descendant ignores SIGTERM and has no inherited pipes to keep close
  // pending, so this proves the delayed SIGKILL reaches the whole group.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
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
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('spawn failure did not settle')), 1_000)),
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
  const descendant = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),800);setInterval(()=>{},1000)`;
  writeFileSync(workerScript, `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});console.log('ready');setInterval(()=>{},1000)`);
  const moduleUrl = new URL('./ndjson.ts', import.meta.url).href;
  writeFileSync(supervisor, `import {spawnWorker} from ${JSON.stringify(moduleUrl)};
const proc=await spawnWorker({provider:'fixture',binary:process.execPath,argv:[${JSON.stringify(workerScript)}],cwd:${JSON.stringify(dir)},timeoutMs:3000,killGraceMs:150,stateDir:${JSON.stringify(dir)},jobId:'fixture',mode:'fixture',onStdoutLine(){setTimeout(()=>proc.terminate('cancelled'),100)},onStderr(){}});await proc.exited;proc.closeLog();`);
  await promisify(execFile)(process.execPath, ['--experimental-strip-types', supervisor], { timeout: 5000 });
  await new Promise(resolve => setTimeout(resolve, 900));
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

  // Subsequent events with the same sessionID do not emit duplicate started events.
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
      // Binary names are captured at module scope, so load a fresh copy of the adapter.
      const mod = (await import(`./${name}.ts?missing=${name}`)) as Record<string, import('./types.ts').Provider>;
      const handle = await mod[`${name}Provider`]!.spawn({
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
