import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateAcceptance, readAcceptance, toVerifyChecks, writeAcceptance } from '../checks.ts';

test('toVerifyChecks resolves cwd and applies default timeout', () => {
  const [c] = toVerifyChecks([{ name: 'a', command: 'true', cwd: 'sub' }], '/base');
  assert.equal(c!.cwd, path.resolve('/base', 'sub')); assert.equal(c!.timeoutMs, 60_000);
});

test('acceptance rules', async () => {
  const baseDir = tmpdir();
  const ok = { name: 'ok', command: 'true' }; const bad = { name: 'bad', command: 'exit 3' };
  assert.equal((await evaluateAcceptance({ succeeded: true, checks: undefined, baseDir })).state, 'unchecked');
  assert.equal((await evaluateAcceptance({ succeeded: false, checks: [ok], baseDir })).state, 'rejected');
  assert.equal((await evaluateAcceptance({ succeeded: true, checks: [ok], baseDir })).state, 'accepted');
  const rej = await evaluateAcceptance({ succeeded: true, checks: [ok, bad], baseDir });
  assert.equal(rej.state, 'rejected'); assert.equal(rej.checks.find(c => c.name === 'bad')!.exitCode, 3);
  assert.equal((await evaluateAcceptance({ succeeded: true, checks: [ok, { ...bad, blocking: false }], baseDir })).state, 'accepted');
});

test('configured blocking checks that do not execute cannot be accepted', async () => {
  const baseDir = tmpdir();
  const result = await evaluateAcceptance({
    succeeded: true,
    checks: [{ name: 'required', command: '   ' }],
    baseDir,
  });
  assert.equal(result.state, 'rejected');
  assert.equal(result.checks[0]!.ok, false);
  assert.equal(result.checks[0]!.blocking, true);
  assert.equal(result.checks[0]!.skipped, 'not-configured');
  assert.match(result.checks[0]!.reason!, /no command configured/);
});

test('acceptance persists runner execution details and honors optional preflight failures', async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'acceptance-cwd-'));
  const result = await evaluateAcceptance({
    succeeded: true,
    checks: [{ name: 'optional', command: 'exit 0', cwd: 'missing', blocking: false }],
    baseDir,
  });
  assert.equal(result.state, 'accepted');
  assert.equal(result.checks[0]!.blocking, false);
  assert.equal(result.checks[0]!.skipped, 'missing-cwd');
  assert.equal(result.checks[0]!.timedOut, false);
  assert.equal(result.checks[0]!.signal, null);
  assert.match(result.checks[0]!.reason!, /cwd does not exist/);
});

test('sidecar round trips; absent is unchecked', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'acc-'));
  assert.deepEqual(readAcceptance(repo, 'job-x'), { state: 'unchecked' });
  writeAcceptance(repo, 'job-x', { state: 'accepted', checks: [], at: 'now' });
  assert.equal(readAcceptance(repo, 'job-x').state, 'accepted');
});

test('optional spawn failure never gates; actual timeout diagnostics survive the sidecar', async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'acceptance-details-'));
  writeFileSync(path.join(baseDir, 'not-a-directory'), 'fixture');
  const optional = await evaluateAcceptance({ succeeded: true, baseDir,
    checks: [{ name: 'optional-spawn', command: 'true', cwd: 'not-a-directory', blocking: false }] });
  assert.equal(optional.state, 'accepted');
  assert.equal(optional.checks[0]!.skipped, 'spawn-failed');
  assert.equal(optional.checks[0]!.blocking, false);
  const timeout = await evaluateAcceptance({ succeeded: true, baseDir,
    checks: [{ name: 'timeout', command: 'node -e "setTimeout(() => {}, 5000)"', timeoutMs: 50 }] });
  writeAcceptance(baseDir, 'job-timeout', timeout);
  const persisted = readAcceptance(baseDir, 'job-timeout');
  assert.equal(persisted.state, 'rejected');
  assert.ok('checks' in persisted);
  assert.equal(persisted.checks[0]!.timedOut, true);
  assert.notEqual(persisted.checks[0]!.signal, null);
  assert.match(persisted.checks[0]!.reason!, /timed out/);
});
