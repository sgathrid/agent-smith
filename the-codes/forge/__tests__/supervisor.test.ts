import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ForgeService } from '../service.ts';
import { waitFor } from '../testing/time.ts';

test('detached preparation failure never starts the provider', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'smith-prepare-'));
  const fake = path.join(repo, 'fake.cjs');
  const marker = path.join(repo, 'started');
  writeFileSync(fake, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'started');\n`);
  chmodSync(fake, 0o755);
  const previous = process.env.AGENT_SMITH_CODEX_BIN;
  process.env.AGENT_SMITH_CODEX_BIN = fake;
  const service = new ForgeService({ repo, supervisorUrl: new URL('../../surfaces/channel/src/supervisor.ts', import.meta.url) });
  let id = '';
  try {
    await assert.rejects(service.spawnJob({ provider: 'codex', mode: 'review', prompt: 'review', onPrepared: jobId => {
      id = jobId;
      throw new Error('cannot persist task identity');
    } }), /cannot persist task identity/);
    assert.ok(id);
    const manifest = JSON.parse(readFileSync(path.join(repo, '.agent-smith/jobs', id, 'job.json'), 'utf8'));
    assert.notEqual(manifest.ownerPid, process.pid);
    // The job turns failed once its detached supervisor exits and the service
    // reconciles the orphan; on a loaded machine that process can outlive the check.
    await waitFor(async () => (await service.detail(id)).status === 'failed', { message: 'prepared job to settle as failed' });
    // The job settled as failed. runNdjsonWorker writes argv.json before it spawns the provider, so its absence proves no spawn was attempted.
    assert.equal(existsSync(path.join(repo, '.agent-smith/jobs', id, 'argv.json')), false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_SMITH_CODEX_BIN;
    else process.env.AGENT_SMITH_CODEX_BIN = previous;
    rmSync(repo, { recursive: true, force: true });
  }
});
