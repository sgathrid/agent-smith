/**
 * format.test.ts — the state format's pure rules, and above all THE HEADLINE RULE.
 *
 * `deriveStatus` is the single function that decides whether work happened. It is
 * pure, so this suite is exhaustive about it rather than representative: every row
 * of the precedence table gets a test that would fail if the row were deleted, and
 * the two rows that exist because of a REAL observed failure get the specific
 * input that caused it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FILES,
  MIN_USEFUL_CHARS,
  SCHEMA_VERSION,
  attributeChanged,
  deriveStatus,
  isForgeJobId,
  isForgeStatus,
  jobDir,
  jobFile,
  jobsDir,
  looksEmpty,
  newJobId,
  shouldFlush,
  taskTitle,
  warningsFor,
  type ForgeProgress,
} from '../format.ts';

// ── paths ────────────────────────────────────────────────────────────────────

test('the job root is ours, not agy-staffs', () => {
  assert.equal(jobsDir('/repo'), '/repo/.agent-smith/jobs');
  assert.equal(jobDir('/repo', 'implement-smith-abcd1234'), '/repo/.agent-smith/jobs/implement-smith-abcd1234');
  assert.equal(jobFile('/repo', 'j', FILES.job), '/repo/.agent-smith/jobs/j/job.json');
});

test('every file name in the format is one the writer and the reader share', () => {
  // If the writer renamed a file and the reader kept the old name, the anchor
  // would silently become unreadable and every job would read as `unknown`.
  assert.deepEqual(Object.values(FILES).sort(), [
    'argv.json',
    'cancel',
    'cancel.steer',
    'events.jsonl',
    'job.json',
    'orphaned',
    'progress.json',
    'result.json',
    'result.md',
    'stderr.log',
    'steer.head',
    'steer.jsonl',
    'view.json',
  ]);
});

// ── ids ──────────────────────────────────────────────────────────────────────

test('a job id carries the mode and the smith marker', () => {
  const id = newJobId('implement');
  assert.match(id, /^implement-smith-[0-9a-f]{8}$/);
  assert.equal(isForgeJobId(id), true);
});

test('a mode with path characters in it cannot escape the jobs directory', () => {
  // The id becomes a DIRECTORY name and, through the compat mirror, a filename
  // in somebody else's directory. `../../etc` must not survive.
  const id = newJobId('../../etc/passwd');
  assert.equal(id.includes('/'), false);
  assert.equal(id.includes('..'), false);
  assert.match(id, /^etc-passwd-smith-[0-9a-f]{8}$/);
});

test('two ids never collide', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newJobId('review')));
  assert.equal(ids.size, 500);
});

test('isForgeJobId recognises our ids and not agy-staffs', () => {
  // Real ids from the corpus. If these ever came back true, the registry would
  // drop somebody else's history in favour of a reader that cannot find it.
  assert.equal(isForgeJobId('implement-musm82da-f1dc1fe4'), false);
  assert.equal(isForgeJobId('implement-muroviej-9a1b2c3d'), false);
  assert.equal(isForgeJobId('review-smith-00000000'), true);
});

test('multiword modes remain forge ids and job paths reject traversal', () => {
  const id = newJobId('code review');
  assert.match(id, /^code-review-smith-[0-9a-f]{8}$/);
  assert.equal(isForgeJobId(id), true);
  assert.throws(() => jobDir('/repo', '../outside'), /invalid job id/);
});

// ── the task cell ────────────────────────────────────────────────────────────

test('the task is the first non-empty prompt line, hash-stripped and capped', () => {
  assert.equal(taskTitle('\n\n# Dashboard rework\n\ndo the thing'), 'Dashboard rework');
  assert.equal(taskTitle('no heading here'), 'no heading here');
  assert.equal(taskTitle('x'.repeat(400)).length, 200);
  assert.equal(taskTitle('   \n  '), '');
});

// ── emptiness ────────────────────────────────────────────────────────────────

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

// ── THE HEADLINE RULE ────────────────────────────────────────────────────────

test('THE TRAP: exit 0, SUCCESS, denied_actions, empty response ⇒ FAILED', () => {
  // This is the exact record agy produced in the verified live run. It exits 0,
  // reports status "SUCCESS", returns "" and did nothing at all.
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
    deniedActions: [{ action: 'tool', displayName: 'toolu_1' }],
    report: 'No defects found; could not check exact bytes.',
  });
  assert.equal(v.status, 'succeeded');
  assert.equal(v.suspicious, false);
  assert.match(v.note ?? '', /^1 call denied/);
  // Same denial with no report is still a failure.
  assert.equal(deriveStatus({ ok: true, jobStatus: 'success', deniedActions: [{ action: 'tool' }], report: '' }).status, 'failed');
});

test('the paranoid net: SUCCESS, no denials reported, empty response ⇒ FAILED', () => {
  // For a provider that does not report denials at all, emptiness is the only
  // evidence left. Reporting this as a clean success is the quiet failure this
  // project exists to eliminate.
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
  // Output is not redemption. A job that says it failed and printed a stack trace
  // has failed.
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
  // A job we killed has no trustworthy terminal state of its own: whatever the
  // CLI managed to write on the way down is not what happened to the task.
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
  // The adapter reports 'malformed' precisely because the process ended and we
  // never saw a terminal event. There is no reading of that as success.
  const v = deriveStatus({ ok: false, jobStatus: 'malformed', deniedActions: [], report: '' });
  assert.equal(v.status, 'failed');
});

// ── warnings ─────────────────────────────────────────────────────────────────

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

// ── progress flushing ────────────────────────────────────────────────────────

test('progress writes are coalesced, so a 484-tool job is not 484 writes', () => {
  // The band polls at 3 s and the channel at 5 s; anything under that is invisible.
  assert.equal(shouldFlush(0, 249, 250), false);
  assert.equal(shouldFlush(0, 250, 250), true, 'exactly at the window must flush, or it starves');
  assert.equal(shouldFlush(1000, 1100, 250), false);
  assert.equal(shouldFlush(1000, 1250, 250), true);
});

test('a clock that went backwards does not deadlock the flusher', () => {
  // NTP correction mid-job. A backwards stamp suppresses one flush, which is
  // harmless; what would NOT be harmless is never flushing again. So the rule is
  // that the very next forward-looking stamp flushes, which is what the second
  // assertion pins: the flusher is suppressed, never wedged.
  assert.equal(shouldFlush(1000, 500, 250), false, 'a backwards stamp suppresses one flush');
  assert.equal(shouldFlush(500, 800, 250), true, 'and the next forward stamp flushes immediately');
});

// ── the status enum ──────────────────────────────────────────────────────────

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
  // No captured input: nothing to attribute against, so nothing is disowned.
  assert.deepEqual(attributeChanged(['x'], ''), { mine: ['x'], other: [] });
});
