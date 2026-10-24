import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ObservedJob } from '../../harness/types.ts';
import { toSummary } from '../service.ts';

function observed(raw: Record<string, unknown>, status: ObservedJob['status'] = 'running'): ObservedJob {
  return {
    provider: 'agent-smith', jobId: 'implement-smith-abcd1234', status, warnings: [], output: null,
    startedAt: null, updatedAt: null, finishedAt: null, mode: 'implement', model: null, label: null,
    outputTruncated: false, usage: null, partial: false, raw,
  };
}

test('job summary exposes only an observed active tool call as currentActivity', () => {
  const activity = { stepIndex: 3, tool: 'run_command', status: 'active', input: 'npm test' };
  const summary = toSummary(observed({ recent_activities: [{ stepIndex: 2, tool: 'read_file', status: 'done' }, activity] }), 'agent-smith');
  assert.deepEqual(summary.currentActivity, activity);
  assert.equal(toSummary(observed({ recent_activities: [] }), 'agent-smith').currentActivity, null);
  assert.equal(toSummary(observed({ recent_activities: [activity] }, 'succeeded'), 'agent-smith').currentActivity, null);
});

test('lastActivity retains a completed agy tool while currentActivity is empty', () => {
  const activity = { stepIndex: 3, tool: 'run_command', status: 'done', input: 'npm test' };
  const summary = toSummary(observed({ recent_activities: [activity] }), 'agent-smith');
  assert.equal(summary.currentActivity, null);
  assert.deepEqual(summary.lastActivity, activity);
  assert.deepEqual(toSummary(observed({ recent_activities: [activity] }, 'succeeded'), 'agent-smith').lastActivity, activity);
});

test('toSummary projects digest and changedFileCount when present', () => {
  const digest = {
    phase: 'editing', filesRead: 3, searches: 1, edited: ['a.ts', 'b.ts'], editedCount: 2,
    commands: 4, testRuns: 1, lastTestFailed: false, repeat: { label: 'Bash npm test', count: 2 },
  };
  const summary = toSummary(observed({ digest, changed_files: ['a.ts', 'b.ts', 'c.ts'] }), 'agent-smith');
  assert.deepEqual(summary.digest, digest);
  assert.equal(summary.changedFileCount, 3);
});

test('toSummary leaves digest and changedFileCount absent when the job has none', () => {
  const bare = toSummary(observed({}), 'agent-smith');
  assert.equal(bare.digest, undefined);
  assert.equal(bare.changedFileCount, undefined);
  // A digest without the shape the writer produces is not trusted.
  assert.equal(toSummary(observed({ digest: { phase: 'editing' } }), 'agent-smith').digest, undefined);
  assert.equal(toSummary(observed({ digest: 'editing' }), 'agent-smith').digest, undefined);
  assert.equal(toSummary(observed({ changed_files: 'not-a-list' }), 'agent-smith').changedFileCount, undefined);
});
