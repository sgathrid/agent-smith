import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scaled, waitFor } from '../forge/testing/time.ts';
import { claudeProvider } from './claude.ts';
import type { ProviderEvent, WorkerHandle } from './types.ts';

const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-claude-live-fixture-'));
const fixtureScript = path.join(fixtureDir, 'fake-claude.mjs');
const fixtureBinary = path.join(fixtureDir, 'fake-claude');

writeFileSync(fixtureScript, `
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const dir = process.cwd();
const scenario = process.env.CLAUDE_LIVE_SCENARIO;
const followUps = Number(process.env.CLAUDE_LIVE_FOLLOWUPS ?? '1');
const out = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
const replay = (text) => out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: 's1', isReplay: true });
const result = (text) => out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 } });
fs.writeFileSync(path.join(dir, 'argv.json'), JSON.stringify(process.argv.slice(2)));
const msgs = [];
let ended = false;
let wake = () => {};
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => { msgs.push(JSON.parse(line).message.content[0].text); wake(); });
rl.on('close', () => { ended = true; fs.writeFileSync(path.join(dir, 'stdin-closed'), String(msgs.length)); wake(); });
const until = (pred) => new Promise((resolve) => { const check = () => { if (pred()) resolve(); else wake = check; }; check(); });

await until(() => msgs.length >= 1);
out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake' });
replay(msgs[0]);
// A forwarded subagent message with the same text as the prompt must stay invisible.
out({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: msgs[0] }] }, parent_tool_use_id: 'toolu_sub', session_id: 's1' });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep' } }] }, session_id: 's1' });
await until(() => msgs.length >= 1 + followUps);
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'slept', is_error: false }] }, session_id: 's1' });
if (scenario === 'read') for (const m of msgs.slice(1)) replay(m);
if (scenario === 'trimmed') for (const m of msgs.slice(1)) replay(m.trim());
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] }, session_id: 's1' });
result('turn one');
await until(() => ended);
// The CLI runs a message that was already in the pipe at the turn's end as a further turn.
if (scenario === 'late') { for (const m of msgs.slice(1)) replay(m); result('turn two'); }
process.exit(0);
`);
writeFileSync(fixtureBinary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixtureScript)} "$@"\n`);
chmodSync(fixtureBinary, 0o755);

process.env['AGENT_SMITH_CLAUDE_BIN'] = fixtureBinary;

const dirs: string[] = [];
test.after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function start(scenario: string, followUps: number): Promise<{ handle: WorkerHandle; events: ProviderEvent[]; cwd: string }> {
  process.env['CLAUDE_LIVE_SCENARIO'] = scenario;
  process.env['CLAUDE_LIVE_FOLLOWUPS'] = String(followUps);
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-claude-live-'));
  dirs.push(cwd);
  const handle = await claudeProvider.spawn({
    mode: 'implement', prompt: 'the initial prompt', cwd, stateDir: cwd, timeoutMs: scaled(30_000), unrestricted: true,
  });
  const events: ProviderEvent[] = [];
  handle.onEvent((e) => events.push(e));
  return { handle, events, cwd };
}

const reads = (events: ProviderEvent[]) => events.flatMap((e) => (e.kind === 'user-message' ? [e.text] : []));

test('claude live input: messages sent before and during a tool are read in the same turn; the prompt is not a follow-up', async () => {
  const { handle, events, cwd } = await start('read', 2);
  assert.equal(typeof handle.send, 'function');
  assert.equal(handle.send!('before the tool'), true);
  await waitFor(() => events.some((e) => e.kind === 'activity-start'), { message: 'the fake tool started' });
  assert.equal(handle.send!('during the tool'), true);
  let afterResult: boolean | undefined;
  handle.onEvent((e) => { if (e.kind === 'usage' && afterResult === undefined) afterResult = handle.send!('after the result'); });
  const result = await handle.waitForResult();

  assert.equal(result.status, 'success');
  assert.equal(result.response, 'turn one');
  assert.deepEqual(reads(events), ['before the tool', 'during the tool']);
  const toolEnd = events.findIndex((e) => e.kind === 'activity-end');
  const firstRead = events.findIndex((e) => e.kind === 'user-message');
  assert.ok(toolEnd >= 0 && firstRead > toolEnd, 'read at the next tool round, after the tool result');
  assert.equal(afterResult, false, 'send after the result event returns false');
  assert.equal(handle.send!('after exit'), false);
  assert.equal(result.unreadInput, undefined);
  assert.equal(readFileSync(path.join(cwd, 'stdin-closed'), 'utf8'), '3', 'stdin ended after the result, with nothing written after it');
  const argv = JSON.parse(readFileSync(path.join(cwd, 'argv.json'), 'utf8')) as string[];
  assert.ok(!argv.includes('the initial prompt'), 'the prompt travels on stdin, not argv');
  assert.ok(argv.includes('--replay-user-messages'));
  const persisted = readFileSync(path.join(cwd, 'events.jsonl'), 'utf8');
  assert.match(persisted, /"kind":"user-message","at":"[^"]+","text":"during the tool"/);
});

test('claude live input: a replay the CLI trimmed is reported with the text that was sent', async () => {
  const { handle, events } = await start('trimmed', 1);
  await waitFor(() => events.some((e) => e.kind === 'activity-start'), { message: 'the fake tool started' });
  assert.equal(handle.send!('with a trailing newline\n'), true);
  const result = await handle.waitForResult();
  assert.deepEqual(reads(events), ['with a trailing newline\n']);
  assert.equal(result.unreadInput, undefined);
});

test('claude live input: a message never replayed before exit is reported unread, not read', async () => {
  const { handle, events } = await start('unread', 1);
  await waitFor(() => events.some((e) => e.kind === 'activity-start'), { message: 'the fake tool started' });
  assert.equal(handle.send!('never read'), true);
  const result = await handle.waitForResult();
  assert.equal(result.status, 'success');
  assert.deepEqual(reads(events), []);
  assert.deepEqual(result.unreadInput, ['never read']);
});

test('claude live input: a replay after the first result still counts as read (decide at exit, not at the result)', async () => {
  const { handle, events } = await start('late', 1);
  await waitFor(() => events.some((e) => e.kind === 'activity-start'), { message: 'the fake tool started' });
  assert.equal(handle.send!('buffered at turn end'), true);
  const result = await handle.waitForResult();
  assert.equal(result.status, 'success');
  assert.equal(result.response, 'turn two');
  assert.deepEqual(reads(events), ['buffered at turn end']);
  assert.equal(result.unreadInput, undefined);
});

test('claude live input: a missing stdin reader (worker exits at once) neither crashes nor accepts messages', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-claude-live-gone-'));
  dirs.push(cwd);
  const saved = process.env['AGENT_SMITH_CLAUDE_BIN'];
  process.env['AGENT_SMITH_CLAUDE_BIN'] = path.join(cwd, 'missing-claude');
  try {
    const handle = await claudeProvider.spawn({ mode: 'test', prompt: 'x', cwd, stateDir: cwd, timeoutMs: scaled(30_000), unrestricted: true });
    const result = await handle.waitForResult();
    assert.equal(result.status, 'spawn-failed');
    assert.equal(handle.send!('anyone?'), false);
    assert.equal(existsSync(path.join(cwd, 'stdin-closed')), false);
  } finally {
    process.env['AGENT_SMITH_CLAUDE_BIN'] = saved;
  }
});
