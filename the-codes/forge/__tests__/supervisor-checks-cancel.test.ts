// MUST BE FIRST: points the agy adapter at the local fixture (see ../testing/shim.ts).
import { assertFakeProviderActive } from '../testing/shim.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readAcceptance } from '../checks.ts';
import { ForgeService } from '../service.ts';
import { scaled, waitFor } from '../testing/time.ts';

assertFakeProviderActive();

test('cancel stops acceptance checks owned by a detached supervisor', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'smith-checks-cancel-'));
  const service = new ForgeService({ repo, supervisorUrl: new URL('../../surfaces/channel/src/supervisor.ts', import.meta.url) });
  try {
    const ack = await service.spawnJob({
      mode: 'implement', prompt: 'do the thing', provider: 'agy', timeoutMs: 30_000,
      checks: [{ name: 'forever', command: 'sleep 600' }],
    });
    // The worker exits, the supervisor starts the check.
    await waitFor(() => (readAcceptance(repo, ack.jobId) as { running?: string }).running, { timeoutMs: 60_000, message: 'check to start' });
    const t0 = Date.now();
    service.cancel(ack.jobId);
    const verdict = await waitFor(() => {
      const a = readAcceptance(repo, ack.jobId) as { pending?: boolean; reason?: string };
      return a.pending ? undefined : a;
    }, { timeoutMs: 60_000, message: 'canceled verdict' });
    assert.deepEqual({ ...verdict, at: undefined }, { state: 'unchecked', checks: [], reason: 'checks canceled', at: undefined });
    // Only waiting out the whole 600 s sleep fails this, however loaded the machine is.
    assert.ok(Date.now() - t0 < scaled(300_000), 'checks stopped promptly, not after the 600 s sleep');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
