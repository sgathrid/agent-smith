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
