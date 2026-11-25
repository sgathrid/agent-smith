import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scaled, waitFor } from '../forge/testing/time.ts';
import { spawnWorker } from './ndjson.ts';

const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-codex-sig-fixture-'));
const fixtureScript = path.join(fixtureDir, 'fake-worker.mjs');
const fixtureBinary = path.join(fixtureDir, 'fake-worker');

writeFileSync(fixtureScript, `
import fs from 'node:fs';
import process from 'node:process';
const signalFile = process.env.SIG_FIXTURE_SIGNAL_FILE;
const readyFile = process.env.SIG_FIXTURE_READY_FILE;
const exitCode = Number(process.env.SIG_FIXTURE_EXIT_CODE ?? '1');
let recorded = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (!recorded && signalFile) {
      recorded = true;
      fs.writeFileSync(signalFile, sig);
    }
    process.exit(exitCode);
  });
}
if (readyFile) fs.writeFileSync(readyFile, String(process.pid));
setInterval(() => {}, 1000);
`);
writeFileSync(fixtureBinary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixtureScript)} "$@"\n`);
chmodSync(fixtureBinary, 0o755);

process.env['AGENT_SMITH_CODEX_BIN'] = fixtureBinary;
process.env['AGENT_SMITH_AGY_BIN'] = fixtureBinary;
const { codexProvider } = await import('./codex.ts');
const { agyProvider } = await import('./agy.ts');

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-codex-sig-state-'));
  dirs.push(dir);
  return dir;
};

test.after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test('codex sends SIGINT first on cancel and timeout; exit code 1 with no turn.completed still yields cancelled/timeout', async () => {
  if (process.platform === 'win32') return;

  const cancelDir = tempDir();
  const cancelReady = path.join(cancelDir, 'ready');
  const cancelSig = path.join(cancelDir, 'signal');
  const cancelSpawnedAt = Date.now();
  const cancelled = await codexProvider.spawn({
    mode: 'implement',
    prompt: 'work',
    cwd: cancelDir,
    timeoutMs: scaled(60_000),
    unrestricted: false,
    stateDir: cancelDir,
    env: { SIG_FIXTURE_READY_FILE: cancelReady, SIG_FIXTURE_SIGNAL_FILE: cancelSig, SIG_FIXTURE_EXIT_CODE: '1' },
  });
  await waitFor(() => existsSync(cancelReady), { message: 'fake codex worker to start' });
  const startupMs = Date.now() - cancelSpawnedAt;
  cancelled.cancel();
  const cancelResult = await cancelled.waitForResult();
  assert.equal(readFileSync(cancelSig, 'utf8'), 'SIGINT');
  assert.equal(cancelResult.status, 'cancelled');
  assert.equal(cancelResult.exitCode, 1);

  const timeoutDir = tempDir();
  const timeoutReady = path.join(timeoutDir, 'ready');
  const timeoutSig = path.join(timeoutDir, 'signal');
  const timedOut = await codexProvider.spawn({
    mode: 'implement',
    prompt: 'work',
    cwd: timeoutDir,
    timeoutMs: Math.max(scaled(600), startupMs * 5),
    unrestricted: false,
    stateDir: timeoutDir,
    env: { SIG_FIXTURE_READY_FILE: timeoutReady, SIG_FIXTURE_SIGNAL_FILE: timeoutSig, SIG_FIXTURE_EXIT_CODE: '1' },
  });
  let timeoutSettled = false;
  const timeoutResultPromise = timedOut.waitForResult().then((r) => {
    timeoutSettled = true;
    return r;
  });
  await waitFor(() => existsSync(timeoutReady) || timeoutSettled, { message: 'fake codex timeout worker to start' });
  assert.ok(existsSync(timeoutReady), 'fake codex timeout worker exited before installing its signal handler');
  const timeoutResult = await timeoutResultPromise;
  assert.equal(readFileSync(timeoutSig, 'utf8'), 'SIGINT');
  assert.equal(timeoutResult.status, 'timeout');
  assert.equal(timeoutResult.exitCode, 1);
});

test('other providers still send SIGTERM first on cancel', async () => {
  if (process.platform === 'win32') return;
  const dir = tempDir();
  const ready = path.join(dir, 'ready');
  const sigFile = path.join(dir, 'signal');
  const handle = await agyProvider.spawn({
    mode: 'implement',
    prompt: 'work',
    cwd: dir,
    timeoutMs: scaled(60_000),
    unrestricted: false,
    stateDir: dir,
    env: { SIG_FIXTURE_READY_FILE: ready, SIG_FIXTURE_SIGNAL_FILE: sigFile, SIG_FIXTURE_EXIT_CODE: '1' },
  });
  await waitFor(() => existsSync(ready), { message: 'fake agy worker to start' });
  handle.cancel();
  const result = await handle.waitForResult();
  assert.equal(readFileSync(sigFile, 'utf8'), 'SIGTERM');
  assert.equal(result.status, 'cancelled');
});

test('spawnWorker with terminateSignal SIGINT still escalates to SIGKILL after grace', async () => {
  if (process.platform === 'win32') return;
  const dir = tempDir();
  const ready = path.join(dir, 'ready');
  const sigFile = path.join(dir, 'signal');
  const code = [
    "const fs = require('node:fs');",
    `process.on('SIGINT', () => { fs.writeFileSync(${JSON.stringify(sigFile)}, 'SIGINT'); });`,
    `fs.writeFileSync(${JSON.stringify(ready)}, 'ready');`,
    'setInterval(() => {}, 1000);',
  ].join('');
  const proc = await spawnWorker({
    provider: 'codex',
    binary: process.execPath,
    argv: ['-e', code],
    cwd: dir,
    timeoutMs: scaled(60_000),
    killGraceMs: 100,
    terminateSignal: 'SIGINT',
    stateDir: dir,
    jobId: 'sigint-escalate',
    mode: 'test',
    onStdoutLine() {},
    onStderr() {},
  });
  await waitFor(() => existsSync(ready), { message: 'worker ignoring SIGINT to start' });
  proc.terminate('cancelled');
  const exit = await proc.exited;
  proc.closeLog();
  assert.equal(readFileSync(sigFile, 'utf8'), 'SIGINT');
  assert.equal(proc.killReason, 'cancelled');
  assert.equal(exit.signal, 'SIGKILL');
});
