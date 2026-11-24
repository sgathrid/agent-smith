import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readAcceptance } from '../checks.ts';
import { FILES, jobFile, readManifest } from '../format.ts';
import { ForgeService } from '../service.ts';
import { assertFakeProviderActive } from '../testing/shim.ts';
import { waitFor } from '../testing/time.ts';

assertFakeProviderActive();

test('detached owner: a follow_up during checks waits for the verdict, then runs as the next turn with it', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'smith-owner-delivery-'));
  const service = new ForgeService({ repo, supervisorUrl: new URL('../../surfaces/channel/src/supervisor.ts', import.meta.url) });
  try {
    const ack = await service.spawnJob({
      mode: 'implement', name: 'w', prompt: 'do the thing', provider: 'agy', timeoutMs: 30_000, cwd: repo,
      checks: [{ name: 'gate', command: 'while [ ! -f GO ]; do sleep 0.05; done; echo gate-output; exit 2' }],
    });
    await waitFor(() => (readAcceptance(repo, ack.jobId) as { running?: string }).running === 'gate', { timeoutMs: 60_000, message: 'checks to start' });
    const fu = await service.followUp({ worker: 'w', prompt: 'QUEUED-DURING-CHECKS' });
    assert.equal(fu.action, 'queued');
    assert.equal(fu.jobId, ack.jobId);
    assert.equal(existsSync(jobFile(repo, ack.jobId, FILES.ownerDone)), false, 'the owner is still running the checks');
    writeFileSync(path.join(repo, 'GO'), '');
    const next = await waitFor(() => readManifest(repo, ack.jobId).followedBy, { timeoutMs: 60_000, message: 'the owner to chain the follow-up' });
    const view = JSON.parse(readFileSync(jobFile(repo, next, FILES.view), 'utf8')) as { prompt: string };
    assert.match(view.prompt, /QUEUED-DURING-CHECKS/);
    assert.match(view.prompt, /gate: FAIL \(exit 2\)/);
    assert.equal(readAcceptance(repo, ack.jobId).state, 'rejected');
    await waitFor(() => existsSync(jobFile(repo, next, FILES.ownerDone)), { timeoutMs: 60_000, message: 'owner.done after the last turn and its checks' });
    assert.equal(readManifest(repo, next).continuationKind, 'follow-up');

    assert.ok(readManifest(repo, next).conversation, 'the fixture saved a conversation');
    const cold = await service.followUp({ worker: 'w', prompt: 'COLD-START' });
    assert.equal(cold.action, 'started');
    assert.deepEqual(cold.checks, ['gate']);
    await waitFor(() => existsSync(jobFile(repo, cold.jobId, FILES.ownerDone)), { timeoutMs: 60_000, message: 'cold owner done' });
    assert.equal(readAcceptance(repo, cold.jobId).state, 'rejected', 'the new owner ran the checks');
    assert.equal(readManifest(repo, next).followedBy, cold.jobId);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
