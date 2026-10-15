import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAll } from '../watch-source.ts';
import { pollOnce, resetPoller } from '../poller.ts';
import type { Batch } from '../policy.ts';

test('acceptance failure is announced after successful worker execution with no worker summary', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'smith-events-'));
  try {
    const dir = path.join(repo, '.agent-smith', 'pipelines'); mkdirSync(dir, { recursive: true });
    const run = { runId: 'fixture-run', pipeline: 'Release review', status: 'running', startedAt: Date.now(), finishedAt: null as number | null, stageResults: {} as Record<string, unknown> };
    const save = () => writeFileSync(path.join(dir, 'fixture-run.json'), JSON.stringify(run));
    save(); resetPoller();
    const sent: Batch[] = [];
    const send = async (batch: Batch) => { sent.push(batch); };
    await pollOnce(repo, Date.now(), send);
    run.status = 'failed'; run.finishedAt = Date.now();
    run.stageResults.implement = { stage: 'implement', status: 'failed', acceptance: 'failed' }; save();
    const jobs = await readAll(repo);
    assert.equal(jobs[0]?.status, 'failed'); assert.equal(jobs[0]?.summarySource, undefined);
    await pollOnce(repo, Date.now(), send); await pollOnce(repo, Date.now(), send);
    assert.equal(sent.length, 1); assert.match(sent[0]!.content!, /Release review.*failed/);
    assert.match(sent[0]!.content!, /Release review .*1 stages passed|0\/1 stages passed · implement: checks failed/);
    assert.doesNotMatch(sent[0]!.content!, /Worker output:|Worker summary|Runtime outcome/);
  } finally { resetPoller(); rmSync(repo, { recursive: true, force: true }); }
});
