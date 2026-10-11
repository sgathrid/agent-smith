import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertFakeProviderActive } from '../testing/shim.ts';
import { ForgeService } from '../service.ts';
import { cancelPipeline, pipelineCancelPath, readPipeline, startPipeline } from '../execute.ts';

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
  let running = readPipeline(repo, run.runId)?.stageResults['slow'];
  for (let i = 0; i < 100 && running?.status !== 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    running = readPipeline(repo, run.runId)?.stageResults['slow'];
  }
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
