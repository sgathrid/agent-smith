import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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

test('sidecar round trips; absent is unchecked', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'acc-'));
  assert.deepEqual(readAcceptance(repo, 'job-x'), { state: 'unchecked' });
  writeAcceptance(repo, 'job-x', { state: 'accepted', checks: [], at: 'now' });
  assert.equal(readAcceptance(repo, 'job-x').state, 'accepted');
});
