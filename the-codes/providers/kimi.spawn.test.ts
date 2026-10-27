/**
 * kimi.spawn.test.ts — the Kimi adapter's process path, against a fake binary.
 *
 * WHY THIS FILE EXISTS SEPARATELY
 * ===============================
 * providers/kimi.ts captures KIMI_BINARY at module scope, exactly like the other
 * adapters. A test that sets the env var after a static import has already lost:
 * the adapter is bound to the real binary. This file assigns the fixture path
 * BEFORE the dynamic import, which is the only reliable ordering. The fixture is
 * a real executable and receives the real argv, so buildArgv, spawnWorker, the
 * translator, result assembly and cancellation are all exercised unchanged.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scaled, waitFor } from '../forge/testing/time.ts';

const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-kimi-fixture-'));
const fixtureScript = path.join(fixtureDir, 'fake-kimi.mjs');
const fixtureBinary = path.join(fixtureDir, 'kimi');

writeFileSync(fixtureScript, `
import process from 'node:process';
const argv = process.argv.slice(2);
const p = argv.indexOf('-p');
const prompt = p >= 0 ? (argv[p + 1] ?? '') : '';
const scenario = process.env.KIMI_FIXTURE_SCENARIO ?? 'ok';
const session = 'session_fixture_123';
const out = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const hint = () => out({ role: 'meta', type: 'session.resume_hint', session_id: session,
  command: 'kimi -r ' + session, content: 'To resume this session: kimi -r ' + session });

if (scenario === 'bad-json') process.stdout.write('this is not json\\n');
if (scenario === 'silent') { hint(); process.exit(0); }
if (scenario === 'bad-exit') {
  out({ role: 'assistant', content: 'partial' });
  process.stderr.write('authentication failed\\n');
  process.exit(2);
}
if (scenario === 'slow') {
  if (process.env.KIMI_FIXTURE_STARTED) (await import('node:fs')).writeFileSync(process.env.KIMI_FIXTURE_STARTED, 'started');
  setTimeout(() => { out({ role: 'assistant', content: 'late' }); hint(); process.exit(0); }, 60000);
} else {
  out({ role: 'meta', type: 'system.version', version: 'fixture-1' });
  out({ role: 'assistant', content: 'Checking.', tool_calls: [{
    type: 'function', id: 'Bash_1', function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo hi' }) },
  }] });
  out({ role: 'tool', tool_call_id: 'Bash_1', content: 'Command executed successfully.' });
  out({ role: 'assistant', content: 'DONE' });
  hint();
}
`);
writeFileSync(fixtureBinary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixtureScript)} "$@"\n`);
chmodSync(fixtureBinary, 0o755);

// MUST precede the import: the adapter reads this once at module scope.
process.env['AGENT_SMITH_KIMI_BIN'] = fixtureBinary;
const { kimiProvider } = await import('./kimi.ts');

const stateDirs: string[] = [];
const stateDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-kimi-state-'));
  stateDirs.push(dir);
  return dir;
};
const spec = (overrides: Record<string, unknown> = {}) => ({
  mode: 'implement',
  prompt: 'do the thing',
  cwd: fixtureDir,
  timeoutMs: scaled(60_000),
  unrestricted: true,
  stateDir: stateDir(),
  ...overrides,
});

test.after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
  for (const dir of stateDirs) rmSync(dir, { recursive: true, force: true });
});

test('kimi spawn maps stream-json to text and one tool step, and captures the session id', async () => {
  const dir = stateDir();
  const handle = await kimiProvider.spawn(spec({
    stateDir: dir,
    model: 'kimi-code/k3',
    conversation: 'session_existing',
    addDirs: ['/tmp/one', '/tmp/two'],
  }));
  const events = [];
  for await (const event of handle.events) events.push(event);
  const result = await handle.waitForResult();

  assert.equal(result.status, 'success');
  assert.equal(result.response, 'Checking.\nDONE');
  assert.deepEqual(result.raw, { sessionId: 'session_fixture_123' });

  const text = events.filter((e) => e.kind === 'text').map((e) => e.text);
  assert.deepEqual(text, ['Checking.', 'DONE']);
  const start = events.find((e) => e.kind === 'activity-start');
  const end = events.find((e) => e.kind === 'activity-end');
  assert.ok(start?.kind === 'activity-start');
  assert.ok(end?.kind === 'activity-end');
  assert.equal(start.activity.tool, 'Bash');
  assert.match(start.activity.input ?? '', /echo hi/);
  assert.equal(end.activity.stepIndex, start.activity.stepIndex);
  assert.equal(end.activity.output, 'Command executed successfully.');
  assert.equal(end.status, 'done');

  const argv = JSON.parse(readFileSync(path.join(dir, 'argv.json'), 'utf8')).argv;
  assert.deepEqual(argv.slice(0, 6), ['--output-format', 'stream-json', '--model', 'kimi-code/k3', '--session=session_existing', '--add-dir']);
  assert.ok(argv.includes('/tmp/one') && argv.includes('/tmp/two'));
  assert.equal(argv.at(-2), '-p');
  assert.equal(argv.at(-1), 'do the thing');
  assert.equal(argv.includes('--continue'), false);
  assert.equal(argv.includes('--effort'), false);
});

test('kimi spawn warns when an effort is requested, because the CLI has no per-run flag', async () => {
  const handle = await kimiProvider.spawn(spec({ effort: 'high' }));
  const events = [];
  for await (const event of handle.events) events.push(event);
  const result = await handle.waitForResult();
  assert.equal(result.status, 'success');
  const warning = events.find((e) => e.kind === 'notice' && /no per-run effort flag/.test(e.message));
  assert.ok(warning, 'the caller must see that effort was ignored');
});

test('kimi spawn surfaces non-JSON stdout as a warning and still completes', async () => {
  process.env['KIMI_FIXTURE_SCENARIO'] = 'bad-json';
  try {
    const handle = await kimiProvider.spawn(spec());
    const events = [];
    for await (const event of handle.events) events.push(event);
    const result = await handle.waitForResult();
    assert.equal(result.status, 'success');
    assert.ok(events.some((e) => e.kind === 'notice' && /non-JSON/.test(e.message)));
  } finally {
    delete process.env['KIMI_FIXTURE_SCENARIO'];
  }
});

test('kimi spawn maps zero exit with no assistant text to malformed', async () => {
  process.env['KIMI_FIXTURE_SCENARIO'] = 'silent';
  try {
    const handle = await kimiProvider.spawn(spec());
    for await (const _event of handle.events) { /* drain */ }
    const result = await handle.waitForResult();
    assert.equal(result.status, 'malformed');
    assert.match(result.error ?? '', /no output/);
  } finally {
    delete process.env['KIMI_FIXTURE_SCENARIO'];
  }
});

test('kimi spawn maps a non-zero exit and stderr to error', async () => {
  process.env['KIMI_FIXTURE_SCENARIO'] = 'bad-exit';
  try {
    const handle = await kimiProvider.spawn(spec());
    for await (const _event of handle.events) { /* drain */ }
    const result = await handle.waitForResult();
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /exited 2/);
    assert.match(result.error ?? '', /authentication failed/);
  } finally {
    delete process.env['KIMI_FIXTURE_SCENARIO'];
  }
});

test('kimi spawn honours cancellation and timeout', async () => {
  process.env['KIMI_FIXTURE_SCENARIO'] = 'slow';
  try {
    const started = path.join(fixtureDir, 'slow-started');
    process.env['KIMI_FIXTURE_STARTED'] = started;
    const cancelled = await kimiProvider.spawn(spec());
    const drained = (async () => { for await (const _event of cancelled.events) { /* drain */ } })();
    // Cancel once the worker is demonstrably running, not after a guessed delay.
    await waitFor(() => existsSync(started), { message: 'the slow fixture to start' });
    cancelled.cancel();
    await drained;
    const cancelledResult = await cancelled.waitForResult();
    assert.equal(cancelledResult.status, 'cancelled');

    const timedOut = await kimiProvider.spawn(spec({ timeoutMs: 100 }));
    for await (const _event of timedOut.events) { /* drain */ }
    const timeoutResult = await timedOut.waitForResult();
    assert.equal(timeoutResult.status, 'timeout');
  } finally {
    delete process.env['KIMI_FIXTURE_STARTED'];
    delete process.env['KIMI_FIXTURE_SCENARIO'];
  }
});
