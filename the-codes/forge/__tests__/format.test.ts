import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { REASONS } from '../../surfaces/mod/hooks/reasons.ts';
import {
  CWD_GONE_REASON,
  DEFAULT_TIMEOUT_MS,
  FILES,
  MIN_USEFUL_CHARS,
  SCHEMA_VERSION,
  attributeChanged,
  deriveStatus,
  isForgeStatus,
  isTerminalForgeStatus,
  normalizeDenials,
  ownerAlive,
  readManifest,
  validOwnerPid,
  jobDir,
  jobFile,
  jobsDir,
  looksEmpty,
  newJobId,
  newWorkerId,
  shouldFlush,
  taskTitle,
  warningsFor,
  type ForgeProgress,
} from '../format.ts';
import { MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, resolveTimeoutMs } from '../spawn-request.ts';

test('the job root is .agent-smith/jobs', () => {
  assert.equal(jobsDir('/repo'), '/repo/.agent-smith/jobs');
  assert.equal(jobDir('/repo', 'implement-smith-abcd1234'), '/repo/.agent-smith/jobs/implement-smith-abcd1234');
  assert.equal(jobFile('/repo', 'j', FILES.job), '/repo/.agent-smith/jobs/j/job.json');
});

test('every file name in the format is one the writer and the reader share', () => {
  assert.deepEqual(Object.values(FILES).sort(), [
    'argv.json',
    'cancel',
    'cancel.steer',
    'checks-spec.json',
    'checks.abort',
    'events.jsonl',
    'job.json',
    'members',
    'owner.done',
    'progress.json',
    'request.json',
    'result.json',
    'result.md',
    'stderr.log',
    'steer.consumed',
    'steer.discard',
    'steer.head',
    'steer.jsonl',
    'team.json',
    'view.json',
  ]);
});

test('a job id carries the mode and the smith marker', () => {
  const id = newJobId('implement');
  assert.match(id, /^implement-smith-[0-9a-f]{8}$/);
});

test('a mode with path characters in it cannot escape the jobs directory', () => {
  const id = newJobId('../../etc/passwd');
  assert.equal(id.includes('/'), false);
  assert.equal(id.includes('..'), false);
  assert.match(id, /^etc-passwd-smith-[0-9a-f]{8}$/);
});

test('two ids never collide', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newJobId('review')));
  assert.equal(ids.size, 500);
});

test('multiword modes keep the id shape and job paths reject traversal', () => {
  const id = newJobId('code review');
  assert.match(id, /^code-review-smith-[0-9a-f]{8}$/);
  assert.throws(() => jobDir('/repo', '../outside'), /invalid job id/);
});

test('a worker id carries the w- prefix, passes safe-id checks, and never collides', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newWorkerId()));
  assert.equal(ids.size, 500);
  for (const id of ids) {
    assert.match(id, /^w-[0-9a-f]{12}$/);
    assert.equal(jobDir('/repo', id), `/repo/.agent-smith/jobs/${id}`);
  }
});

test('the task is the first non-empty prompt line, hash-stripped and capped', () => {
  assert.equal(taskTitle('\n\n# Dashboard rework\n\ndo the thing'), 'Dashboard rework');
  assert.equal(taskTitle('no heading here'), 'no heading here');
  assert.equal(taskTitle('x'.repeat(400)).length, 200);
  assert.equal(taskTitle('   \n  '), '');
});

test('a deliberately short final answer is a deliverable; whitespace is not', () => {
  assert.equal(MIN_USEFUL_CHARS, 1);
  assert.equal(looksEmpty(null), true);
  assert.equal(looksEmpty('   '), true);
  assert.equal(looksEmpty('ok'), false);
  assert.equal(looksEmpty('ready'), false);
  assert.equal(looksEmpty('1234567'), false);
  assert.equal(looksEmpty('12345678'), false);
});

test('structured success with a one-word final answer succeeds', () => {
  assert.equal(deriveStatus({ ok: true, jobStatus: 'success', report: 'ready' }).status, 'succeeded');
  assert.equal(deriveStatus({ ok: false, jobStatus: 'error', report: 'ready' }).status, 'failed');
});

test('THE TRAP: exit 0, SUCCESS, denied_actions, empty response ⇒ FAILED', () => {
  const v = deriveStatus({
    ok: false,
    jobStatus: 'denied',
    deniedActions: [{ action: 'command', displayName: 'RunCommand' }],
    report: '',
  });
  assert.equal(v.status, 'failed');
  assert.equal(v.suspicious, true);
  assert.match(v.reason ?? '', /RunCommand/);
  assert.equal(v.reason, 'denied RunCommand');
});

test('a delivered report with non-fatal tool denials succeeds with a warning', () => {
  const v = deriveStatus({
    ok: true,
    jobStatus: 'success',
    deniedActions: [{ action: 'tool', displayName: 'toolu_1', nonfatal: true }],
    report: 'No defects found; could not check exact bytes.',
  });
  assert.equal(v.status, 'succeeded');
  assert.equal(v.suspicious, false);
  assert.match(v.note ?? '', /^1 call denied/);
  assert.equal(deriveStatus({ ok: true, jobStatus: 'success', deniedActions: [{ action: 'tool', nonfatal: true }], report: '' }).status, 'failed');
  assert.equal(deriveStatus({ ok: true, jobStatus: 'success', deniedActions: [{ action: 'tool' }], report: 'report' }).status, 'failed');
});

test('a nonfatal denial does not excuse a writing job whose cwd vanished', () => {
  const base = { ok: true, jobStatus: 'success', report: 'Implemented change.', cwdMissing: true } as const;
  const bash = [{ action: 'Bash', nonfatal: true }];
  assert.deepEqual(deriveStatus({ ...base, writing: true }), { status: 'failed', suspicious: true, reason: CWD_GONE_REASON });
  assert.deepEqual(deriveStatus({ ...base, writing: true, deniedActions: bash }), { status: 'failed', suspicious: true, reason: CWD_GONE_REASON });
  const ro = deriveStatus({ ...base, writing: false, deniedActions: bash });
  assert.equal(ro.status, 'succeeded');
  assert.match(ro.note ?? '', /^1 call denied: Bash/);
  assert.match(deriveStatus({ ...base, writing: true, deniedActions: [{ action: 'Bash' }] }).reason ?? '', /denied/);
  assert.equal(deriveStatus({ ...base, ok: false, jobStatus: 'timeout', writing: true }).reason, REASONS.timedOut);
});

test('the paranoid net: SUCCESS, no denials reported, empty response ⇒ FAILED', () => {
  const v = deriveStatus({ ok: true, jobStatus: 'success', deniedActions: [], report: '' });
  assert.equal(v.status, 'failed');
  assert.equal(v.suspicious, true);
  assert.equal(v.reason, 'no output');
});

test('whitespace-only output is also empty', () => {
  const v = deriveStatus({ ok: true, deniedActions: [], report: '   \n\t  ' });
  assert.equal(v.status, 'failed');
  assert.equal(v.suspicious, true);
});

test('a real deliverable with SUCCESS ⇒ succeeded, no suspicion', () => {
  const v = deriveStatus({
    ok: true,
    jobStatus: 'success',
    deniedActions: [],
    report: '# Report\n\nthe work was done',
  });
  assert.equal(v.status, 'succeeded');
  assert.equal(v.suspicious, false);
  assert.equal(v.reason, null);
});

test('a hard failure with output is still a failure', () => {
  const v = deriveStatus({
    ok: false,
    jobStatus: 'error',
    deniedActions: [],
    report: 'Error: the test suite failed',
  });
  assert.equal(v.status, 'failed');
  assert.equal(v.suspicious, false, 'a stated failure is not a SUSPICIOUS success');
  assert.match(v.reason ?? '', /error/);
});

test('denials outrank a success verdict even when output exists', () => {
  const v = deriveStatus({
    ok: true,
    jobStatus: 'success',
    deniedActions: [{ action: 'command', displayName: 'RunCommand' }],
    report: 'a perfectly good looking report that changed nothing',
  });
  assert.equal(v.status, 'failed');
  assert.equal(v.suspicious, true);
});

test('a cancel outranks everything, including a result the worker flushed', () => {
  for (const ok of [true, false]) {
    const v = deriveStatus({
      alreadyTerminal: 'canceled',
      ok,
      jobStatus: ok ? 'success' : 'error',
      deniedActions: [],
      report: 'a report that raced the kill',
    });
    assert.equal(v.status, 'canceled');
  }
});

test('no verdict yet means running, and running is not suspicious', () => {
  const v = deriveStatus({ ok: null, report: null });
  assert.equal(v.status, 'running');
  assert.equal(v.suspicious, false);
});

test('an undefined verdict is treated as running rather than as success', () => {
  const v = deriveStatus({});
  assert.equal(v.status, 'running');
});

test('timeout and cancelled from the adapter are failures-or-cancellations, never successes', () => {
  assert.equal(deriveStatus({ ok: false, jobStatus: 'timeout', report: '' }).status, 'failed');
  assert.equal(deriveStatus({ ok: false, jobStatus: 'malformed', report: '' }).status, 'failed');
  assert.equal(deriveStatus({ ok: false, jobStatus: 'cancelled', report: '' }).status, 'failed');
});

test('a malformed stream with no result event is a failure', () => {
  const v = deriveStatus({ ok: false, jobStatus: 'malformed', deniedActions: [], report: '' });
  assert.equal(v.status, 'failed');
});

test('a suspicious success always produces exactly one warning', () => {
  const v = deriveStatus({ ok: true, deniedActions: [], report: '' });
  const warnings = warningsFor(v, null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /no output/);
});

test('warnings from progress are carried through', () => {
  const v = deriveStatus({ ok: true, deniedActions: [], report: 'a real deliverable here' });
  const progress: ForgeProgress = {
    jobId: 'j',
    lastEventAt: '2026-10-06T00:00:00.000Z',
    recentActivities: [],
    latestText: null,
    toolCalls: 0,
    warnings: ['agy: a tool required a permission that headless mode cannot prompt for'],
  };
  assert.deepEqual(warningsFor(v, progress), [
    'agy: a tool required a permission that headless mode cannot prompt for',
  ]);
});

test('progress writes are coalesced, so a 484-tool job is not 484 writes', () => {
  assert.equal(shouldFlush(0, 249, 250), false);
  assert.equal(shouldFlush(0, 250, 250), true, 'exactly at the window must flush, or it starves');
  assert.equal(shouldFlush(1000, 1100, 250), false);
  assert.equal(shouldFlush(1000, 1250, 250), true);
});

test('a clock that went backwards does not deadlock the flusher', () => {
  assert.equal(shouldFlush(1000, 500, 250), false, 'a backwards stamp suppresses one flush');
  assert.equal(shouldFlush(500, 800, 250), true, 'and the next forward stamp flushes immediately');
});

test('isForgeStatus accepts exactly the four states and nothing else', () => {
  for (const s of ['running', 'succeeded', 'failed', 'canceled']) {
    assert.equal(isForgeStatus(s), true, s);
  }
  for (const s of ['unknown', 'attention', 'done', '', null, undefined, 1]) {
    assert.equal(isForgeStatus(s), false, String(s));
  }
});

test('the on-disk schema is 1', () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test('changed files are attributed to the job whose tool inputs mention them', () => {
  const r = attributeChanged(['smoketest/a.txt', 'smoketest/b.txt'], '{"TargetFile":"/repo/smoketest/a.txt"}\n');
  assert.deepEqual(r.mine, ['smoketest/a.txt']);
  assert.deepEqual(r.other, ['smoketest/b.txt']);
  assert.deepEqual(attributeChanged(['x'], ''), { mine: ['x'], other: [] });
});

test('isTerminalForgeStatus is every status but running', () => {
  for (const s of ['succeeded', 'failed', 'canceled']) assert.equal(isTerminalForgeStatus(s), true);
  for (const s of ['running', 'unknown', '', null, undefined, 3]) assert.equal(isTerminalForgeStatus(s), false);
});

test('ownerAlive needs a usable pid that is running', () => {
  assert.equal(ownerAlive({ ownerPid: process.pid }), true);
  for (const ownerPid of [undefined, null, 0, -1, 1.5, '12', Number.MAX_SAFE_INTEGER]) {
    assert.equal(ownerAlive({ ownerPid }), false);
  }
  assert.equal(validOwnerPid({ ownerPid: 7 }), 7);
  assert.equal(validOwnerPid({ ownerPid: 0 }), null);
});

test('readManifest normalizes legacy tool denials to nonfatal:true', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'format-manifest-'));
  const jobId = 'review-smith-12345678';
  mkdirSync(jobDir(repo, jobId), { recursive: true });
  writeFileSync(jobFile(repo, jobId, FILES.job), JSON.stringify({
    schema: SCHEMA_VERSION,
    jobId,
    deniedActions: [{ action: 'tool', displayName: 'Bash' }, { action: 'command' }, { action: 'tool', nonfatal: false }],
  }));
  const m = readManifest(repo, jobId);
  assert.deepEqual(m.deniedActions, [
    { action: 'tool', displayName: 'Bash', nonfatal: true },
    { action: 'command' },
    { action: 'tool', nonfatal: false },
  ]);
  assert.deepEqual(normalizeDenials(undefined), []);
});

test('resolveTimeoutMs accepts undefined or positive finite numbers and rejects 0/negatives', () => {
  assert.equal(resolveTimeoutMs(undefined), DEFAULT_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs(1), MIN_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs(5_000.9), 5_000);
  assert.equal(resolveTimeoutMs(MAX_TIMEOUT_MS + 1), MAX_TIMEOUT_MS);
  for (const bad of [0, -1, -1000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => resolveTimeoutMs(bad), RangeError);
  }
});
