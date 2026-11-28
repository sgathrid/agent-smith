import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ObservedJob } from '../../harness/types.ts';
import { toSummary } from '../summary.ts';

function observed(raw: Record<string, unknown>, status: ObservedJob['status'] = 'running'): ObservedJob {
  return {
    provider: 'agent-smith', jobId: 'implement-smith-abcd1234', status, warnings: [], output: null,
    startedAt: null, updatedAt: null, finishedAt: null, mode: 'implement', model: null, label: null,
    outputTruncated: false, usage: null, partial: false, raw,
  };
}

test('job summary exposes only an observed active tool call as currentActivity', () => {
  const activity = { stepIndex: 3, tool: 'run_command', status: 'active', input: 'npm test' };
  const summary = toSummary(observed({ recent_activities: [{ stepIndex: 2, tool: 'read_file', status: 'done' }, activity] }));
  assert.deepEqual(summary.currentActivity, activity);
  assert.equal(toSummary(observed({ recent_activities: [] })).currentActivity, null);
  assert.equal(toSummary(observed({ recent_activities: [activity] }, 'succeeded')).currentActivity, null);
});

test('lastActivity retains a completed agy tool while currentActivity is empty', () => {
  const activity = { stepIndex: 3, tool: 'run_command', status: 'done', input: 'npm test' };
  const summary = toSummary(observed({ recent_activities: [activity] }));
  assert.equal(summary.currentActivity, null);
  assert.deepEqual(summary.lastActivity, activity);
  assert.deepEqual(toSummary(observed({ recent_activities: [activity] }, 'succeeded')).lastActivity, activity);
});

test('toSummary projects digest and changedFileCount when present', () => {
  const digest = {
    phase: 'editing', filesRead: 3, searches: 1, edited: ['a.ts', 'b.ts'], editedCount: 2,
    commands: 4, testRuns: 1, lastTestFailed: false, repeat: { label: 'Bash npm test', count: 2 },
  };
  const summary = toSummary(observed({ digest, changed_files: ['a.ts', 'b.ts', 'c.ts'] }));
  assert.deepEqual(summary.digest, digest);
  assert.equal(summary.changedFileCount, 3);
});

test('toSummary leaves digest and changedFileCount absent when the job has none', () => {
  const bare = toSummary(observed({}));
  assert.equal(bare.digest, undefined);
  assert.equal(bare.changedFileCount, undefined);
  assert.equal(toSummary(observed({ digest: { phase: 'editing' } })).digest, undefined);
  assert.equal(toSummary(observed({ digest: 'editing' })).digest, undefined);
  assert.equal(toSummary(observed({ changed_files: 'not-a-list' })).changedFileCount, undefined);
});

test('toSummary carries finish evidence, liveness inputs, and resumable', () => {
  const raw = { failedEarly: true, toolErrors: 3, changedFilesUnknown: true, cwdMissingAtFinish: true,
    job_status: 'error', error: 'Selected model is not supported in the selected location', conversation: 'thread-9',
    last_event_at: '2026-10-27T10:00:00.000Z', last_alive_at: '2026-10-27T10:00:30.000Z' };
  const s = toSummary(observed(raw, 'failed'));
  assert.deepEqual([s.failedEarly, s.toolErrors, s.changedFilesUnknown, s.cwdMissingAtFinish], [true, 3, true, true]);
  assert.equal(s.lastEventAt, '2026-10-27T10:00:00.000Z');
  assert.equal(s.lastAliveAt, '2026-10-27T10:00:30.000Z');
  assert.equal(s.resumable, true);
  const plain = toSummary(observed({ job_status: 'error', error: 'Selected model is not supported in the selected location' }, 'failed'));
  assert.equal(plain.failedEarly, undefined);
  assert.equal(plain.resumable, false);
});

test('toSummary projects unified turn-chain fields and defaults turn/chainStartedAt cleanly', () => {
  const modern = toSummary(observed({
    workerId: 'w-1',
    turn: 3,
    continuedFrom: 'job-2',
    continuationKind: 'resume',
    chainStartedAt: '2026-11-23T10:00:00.000Z',
  }));
  assert.equal(modern.workerId, 'w-1');
  assert.equal(modern.turn, 3);
  assert.equal(modern.continuedFrom, 'job-2');
  assert.equal(modern.continuationKind, 'follow-up', 'legacy resume reads as follow-up');
  assert.equal(modern.chainStartedAt, '2026-11-23T10:00:00.000Z');
  assert.equal('steeredFrom' in modern, false);
  assert.equal(modern.followedBy, undefined);

  assert.equal(toSummary(observed({ continuedFrom: 'a', continuationKind: 'steer-interrupt' })).continuationKind, 'steer');
  assert.equal(toSummary(observed({ continuedFrom: 'a', continuationKind: 'steer-queue' })).continuationKind, 'follow-up');
  assert.equal(toSummary(observed({ continuedFrom: 'a' })).continuationKind, 'follow-up');
  assert.equal(toSummary(observed({ followedBy: 'job-9' })).followedBy, 'job-9');

  const bare = toSummary({
    ...observed({}),
    startedAt: '2026-11-23T09:00:00.000Z',
  });
  assert.equal(bare.turn, 1);
  assert.equal(bare.continuedFrom, undefined);
  assert.equal(bare.continuationKind, undefined);
  assert.equal(bare.chainStartedAt, '2026-11-23T09:00:00.000Z');
  assert.equal('steeredFrom' in bare, false);
});

test('latestSummary is the running message, the report\'s opening once finished, and the last message when there is no report', () => {
  const raw = { latestSummary: 'Running the checks.', summarySource: 'worker' };
  assert.equal(toSummary(observed(raw)).latestSummary, 'Running the checks.');
  const done = toSummary({ ...observed(raw, 'succeeded'), output: 'Status: DONE\n\nShipped the fix.' });
  assert.deepEqual([done.latestSummary, done.summarySource], ['Shipped the fix.', 'worker']);
  const empty = toSummary({ ...observed(raw, 'failed'), output: null });
  assert.deepEqual([empty.latestSummary, empty.summarySource], ['Running the checks.', 'worker']);
});
