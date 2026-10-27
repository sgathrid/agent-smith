import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertFakeProviderActive } from '../testing/shim.ts';
import { ForgeService } from '../service.ts';
import { waitFor } from '../testing/time.ts';
import { cancelPipeline, pipelineCancelPath, pipelineRecordPath, readPipeline, startPipeline } from '../execute.ts';

assertFakeProviderActive();

test('pipeline runs receive unique atomic records and a cross-process cancel marker', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-execute-'));
  const service = new ForgeService({ repo });
  const spec = { name: 'same-name', workDir: repo, stages: [{ name: 'implement', provider: 'agy', prompt: 'do the work' }] } as const;

  const first = startPipeline(service, spec, { runId: 'run-one' });
  const second = startPipeline(service, spec, { runId: 'run-two' });
  assert.notEqual(first.recordPath, second.recordPath);
  assert.equal(readPipeline(repo, first.runId)?.status, 'running');
  const result = await Promise.all([first.done, second.done]);
  assert.deepEqual(result.map((run) => run.status), ['passed', 'passed']);
  assert.equal(readPipeline(repo, first.runId)?.status, 'passed');
  assert.equal(readPipeline(repo, second.runId)?.status, 'passed');
  assert.ok(Object.values(readPipeline(repo, first.runId)?.stageResults ?? {}).every((stage) => stage.jobId));

  const cancelAttempt = startPipeline(service, { ...spec, stages: [{ name: 'slow', provider: 'agy', prompt: 'run slowly' }] }, { runId: 'run-cancel' });
  const acknowledgment = cancelPipeline(repo, cancelAttempt.runId);
  assert.equal(acknowledgment.requested, true);
  assert.ok(existsSync(pipelineCancelPath(repo, cancelAttempt.runId)));
  const canceled = await cancelAttempt.done;
  assert.equal(canceled.aborted, true);
  assert.equal(readPipeline(repo, cancelAttempt.runId)?.status, canceled.status);
});

test('a running stage shows in the record with its job, then is replaced by its result', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-execute-'));
  const service = new ForgeService({ repo });
  const spec = { name: 'live', workDir: repo, stages: [{ name: 'slow', provider: 'agy', prompt: 'run slowly' }] } as const;
  const run = startPipeline(service, spec, { runId: 'run-live' });
  const running = await waitFor(() => {
    const r = readPipeline(repo, run.runId)?.stageResults['slow'];
    return r?.status === 'running' ? r : undefined;
  }, { message: 'stage to show as running' });
  assert.equal(running?.status, 'running');
  assert.ok(running?.jobId);
  assert.equal(running?.provider, 'agy');
  assert.ok(running?.startedAt);
  run.cancel();
  await run.done;
  const final = readPipeline(repo, run.runId)?.stageResults['slow'];
  assert.notEqual(final?.status, 'running');
  assert.equal(final?.jobId, running?.jobId);
});

test('a run id of 90 characters keeps its record, cancel marker and lookups on one name', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-execute-'));
  const service = new ForgeService({ repo });
  const spec = { name: 'long-id', workDir: repo, stages: [{ name: 'slow', provider: 'agy', prompt: 'run slowly' }] } as const;
  const runId = `run-${'x'.repeat(86)}`;
  assert.equal(runId.length, 90);

  const run = startPipeline(service, spec, { runId });
  assert.equal(run.runId, runId);
  assert.equal(run.recordPath, pipelineRecordPath(repo, runId));
  // Record and cancel marker share one sanitised stem; the old record path cut it at 80.
  assert.equal(path.basename(run.recordPath, '.json'), path.basename(pipelineCancelPath(repo, runId), '.cancel'));
  assert.equal(path.basename(run.recordPath), `${runId}.json`);
  assert.equal(readPipeline(repo, runId)?.runId, runId);
  assert.equal(cancelPipeline(repo, runId).requested, true);
  assert.ok(existsSync(pipelineCancelPath(repo, runId)));
  await run.done;
  assert.notEqual(readPipeline(repo, runId)?.status, 'running');
});

test('a record written under the old 80-character name is still found by its 90-character run id', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'agent-smith-execute-'));
  const runId = `legacy-${'y'.repeat(83)}`;
  const legacy = path.join(repo, '.agent-smith', 'pipelines', `${runId.slice(0, 80)}.json`);
  mkdirSync(path.dirname(legacy), { recursive: true });
  writeFileSync(legacy, JSON.stringify({ runId, pipeline: 'p', status: 'passed', startedAt: 1, finishedAt: 2, stageResults: {} }));
  assert.equal(readPipeline(repo, runId)?.status, 'passed');
});
