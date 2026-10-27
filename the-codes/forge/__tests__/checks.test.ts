import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acceptanceBudgetMs, evaluateAcceptance, pendingAcceptance, readAcceptance, runAcceptance, toVerifyChecks, writeAcceptance } from '../checks.ts';

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

test('the pending placeholder carries a budget: the checks timeouts summed, plus grace, capped', () => {
  assert.equal(acceptanceBudgetMs([{ name: 'a', command: 'x' }]), 60_000 + 30_000);
  assert.equal(acceptanceBudgetMs([{ name: 'a', command: 'x', timeoutMs: 600_000 }, { name: 'b', command: 'x', timeoutMs: 600_000 }]), 1_230_000);
  assert.equal(acceptanceBudgetMs([{ name: 'a', command: 'x', timeoutMs: 3_600_000 }]), 30 * 60_000);
  assert.deepEqual(pendingAcceptance([{ name: 'a', command: 'x' }]), { state: 'unchecked', checks: [], pending: true, budgetMs: 90_000 });
});

test('evaluateAcceptance reports which checks run; runAcceptance keeps the placeholder current', async () => {
  const baseDir = tmpdir();
  const seen: string[][] = [];
  await evaluateAcceptance({ succeeded: true, baseDir, checks: [{ name: 'one', command: 'true' }], onProgress: (r) => seen.push([...r]) });
  assert.deepEqual(seen, [['one'], []]);
  const repo = mkdtempSync(path.join(tmpdir(), 'acceptance-run-'));
  const checks = [{ name: 'slow', command: 'sleep 0.4' }];
  const run = runAcceptance({ repo, jobId: 'j1', succeeded: true, checks, baseDir });
  await new Promise(r => setTimeout(r, 200));
  const mid = readAcceptance(repo, 'j1') as { pending?: boolean; running?: string; budgetMs?: number };
  assert.equal(mid.pending, true); assert.equal(mid.running, 'slow'); assert.equal(mid.budgetMs, 90_000);
  assert.equal((await run).state, 'accepted');
});

test('aborting running checks records unchecked, checks canceled', async () => {
  const ac = new AbortController();
  const repo = mkdtempSync(path.join(tmpdir(), 'acceptance-abort-'));
  const run = runAcceptance({ repo, jobId: 'j2', succeeded: true, checks: [{ name: 'hang', command: 'sleep 30' }], baseDir: tmpdir(), signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  const r = await run;
  assert.equal(r.state, 'unchecked'); assert.equal(r.reason, 'checks canceled'); assert.deepEqual(r.checks, []);
});
