import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { humanDuration } from '../../providers/failure-text.ts';
import { readForgeJobs } from '../../surfaces/mod/hooks/canonical.ts';
import { ForgeService } from '../service.ts';
import { assertFakeProviderActive } from '../testing/shim.ts';
import { waitFor } from '../testing/time.ts';
import { readAllObservedJobs } from './observe.ts';

function repo(): string {
  return mkdtempSync(path.join(tmpdir(), 'agent-smith-e2e-'));
}

assertFakeProviderActive();

async function nodeFs(): Promise<{
  read(p: string): Promise<string>;
  list(p: string): Promise<readonly { name: string; kind: string; size: number }[]>;
  exists(p: string): Promise<boolean>;
}> {
  const { readFile, readdir, stat } = await import('node:fs/promises');
  return {
    async read(p: string): Promise<string> {
      return readFile(p, 'utf8');
    },
    async list(p: string) {
      const entries = await readdir(p, { withFileTypes: true });
      const out: { name: string; kind: string; size: number }[] = [];
      for (const e of entries) {
        out.push({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file', size: 0 });
      }
      return out;
    },
    async exists(p: string): Promise<boolean> {
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    },
  };
}

test('ACCEPTANCE: a job spawned through the tool appears in the mod pane', async () => {
  const r = repo();

  const service = new ForgeService({ repo: r });

  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    prompt: '# Dashboard rework\n\nRebuild the pane and prove it renders.',
    provider: 'agy',
    timeoutMs: 30_000,
    unrestricted: false,
  });
  assert.match(ack.jobId, /^implement-smith-[0-9a-f]{8}$/);
  assert.equal(ack.unrestricted, false);
  assert.match(ack.note, /^queued · 30s limit · approvals on$/);

  assert.ok(existsSync(path.join(ack.dir, 'job.json')), 'job.json exists the moment spawn_job returns');

  await done;
  const manifest = JSON.parse(readFileSync(path.join(ack.dir, 'job.json'), 'utf8'));

  assert.equal(manifest.status, 'succeeded', `expected success, got: ${manifest.error ?? 'no error'}`);
  assert.equal(manifest.provider, 'agy');
  assert.ok(manifest.conversation, 'the provider\'s conversation id was captured for resume');
  assert.ok(manifest.toolCalls >= 2, `tool count from the real stream: ${manifest.toolCalls}`);

  for (const f of ['events.jsonl', 'argv.json', 'stderr.log', 'result.json']) {
    assert.ok(existsSync(path.join(ack.dir, f)), `${f} is in our job dir, written by providers/ndjson.ts`);
  }

  const observed = await readAllObservedJobs(r);
  assert.equal(observed.length, 1, 'exactly ONE job');
  assert.equal(observed[0]?.provider, 'agent-smith');
  assert.equal(observed[0]?.status, 'succeeded');
  assert.match(observed[0]?.output ?? '', /Fixture report/);

  const radar = (await readForgeJobs(await nodeFs(), r, Date.now()))[0];
  assert.ok(radar, 'the pane resolved our job');
  assert.equal(radar?.id, ack.jobId);
  assert.equal(radar?.status, 'succeeded');
  assert.equal(radar?.task, 'Dashboard rework', 'the pane shows our task');
  assert.equal(radar?.endedAt !== null, true, 'the pane has an end time');
});

test('SAFETY: a soft-denied tool is recorded FAILED, never a clean success', async () => {
  const r = repo();
  const service = new ForgeService({ repo: r });

  const ack = await service.spawnJob({
    mode: 'implement',
    prompt: 'Run the shell command: echo hi — deny nothing that matters',
    provider: 'agy',
    timeoutMs: 30_000,
  });

  const manifest = await waitForTerminal(r, ack.jobId, 20_000);

  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.jobStatus, 'denied');
  assert.ok((manifest.deniedActions ?? []).length > 0, 'the denials survived into the state file');
  assert.match(manifest.reason ?? '', /^denied /);
  assert.match(manifest.error ?? '', /^denied /);

  const radar = (await readForgeJobs(await nodeFs(), r, Date.now()))[0];
  assert.equal(radar?.status, 'failed');
});

test('a provider that reports no denials and returns nothing is ALSO failed', async () => {
  const r = repo();
  const service = new ForgeService({ repo: r });
  const ack = await service.spawnJob({ mode: 'review', prompt: 'say nothing and stay silent', provider: 'agy' });
  const manifest = await waitForTerminal(r, ack.jobId, 20_000);

  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.reason, 'no output');
});

test('a worker that dies without a result event is not a success', async () => {
  const r = repo();
  const service = new ForgeService({ repo: r });
  const ack = await service.spawnJob({ mode: 'implement', prompt: 'crash it', provider: 'agy' });
  const manifest = await waitForTerminal(r, ack.jobId, 20_000);

  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.jobStatus, 'error');
  assert.match(manifest.error ?? '', /no result/);
});

test('CANCEL: the marker is written first and the pane sees it as canceled', async () => {
  const r = repo();
  const service = new ForgeService({ repo: r });
  const ack = await service.spawnJob({
    mode: 'implement',
    prompt: 'take your time, slow down',
    provider: 'agy',
    timeoutMs: 30_000,
  });

  await waitFor(() => existsSync(path.join(ack.dir, 'progress.json')), { timeoutMs: 60_000, message: 'progress.json' });

  const result = service.cancel(ack.jobId);
  assert.equal(result.requested, true);
  assert.equal(result.signalled, true, 'this process holds the handle, so it can actually signal');

  assert.ok(existsSync(path.join(ack.dir, 'cancel')));

  const manifest = await waitForTerminal(r, ack.jobId, 15_000);
  assert.equal(manifest.status, 'canceled');

  const radar = (await readForgeJobs(await nodeFs(), r, Date.now()))[0];
  assert.equal(radar?.status, 'canceled');
});

test('CANCEL: a second ForgeService marker is observed by the running owner', async () => {
  const r = repo();
  const owner = new ForgeService({ repo: r });
  const requester = new ForgeService({ repo: r });
  const ack = await owner.spawnJob({ mode: 'implement', name: 'long-worker', workerId: 'stable-worker', prompt: 'slow cross-service cancellation', provider: 'agy', timeoutMs: 30_000 });
  await waitFor(() => existsSync(path.join(ack.dir, 'progress.json')), { timeoutMs: 60_000, message: 'progress.json' });
  await assert.rejects(
    owner.spawnJob({ mode: 'review', name: 'follow-up', workerId: 'stable-worker', prompt: 'overlapping follow-up', provider: 'agy' }),
    /is busy/,
  );

  const request = requester.cancel(ack.jobId);
  assert.equal(request.requested, true);
  assert.equal(request.signalled, false, 'only the service holding the worker handle can signal it');
  const manifest = await waitForTerminal(r, ack.jobId, 15_000);
  assert.equal(manifest.status, 'canceled', 'the owner observed the marker and confirmed process cancellation');
});

test('a cancel for a job this process never started is recorded and admitted, not faked', async () => {
  const r = repo();
  const service = new ForgeService({ repo: r });

  assert.throws(() => service.cancel('implement-smith-deadbeef'), /no job/);

  const ack = await service.spawnJob({ mode: 'implement', prompt: 'quick one', provider: 'agy' });
  const settled = await waitForTerminal(r, ack.jobId, 20_000);

  const fresh = new ForgeService({ repo: r });
  const outcome = fresh.cancel(ack.jobId);
  assert.equal(outcome.requested, false);
  assert.equal(outcome.signalled, false);
  assert.equal(outcome.status, (settled as { status: string }).status);
  assert.match(outcome.note, /nothing to cancel/);
  assert.equal(existsSync(path.join(r, '.agent-smith', 'jobs', ack.jobId, 'cancel')), false, 'no cancel marker on a settled turn');
});

test('list: spawnedIds tracks this process; ids and sinceMs filter', async () => {
  const r = repo();
  const service = new ForgeService({ repo: r });
  const ack = await service.spawnJob({ mode: 'implement', prompt: 'quick one', provider: 'agy' });
  await waitForTerminal(r, ack.jobId, 20_000);
  assert.deepEqual([...service.spawnedIds], [ack.jobId]);
  assert.equal((await service.list({ ids: service.spawnedIds })).length, 1);
  assert.equal((await service.list({ ids: new ForgeService({ repo: r }).spawnedIds })).length, 0, 'a restarted server has spawned nothing');
  assert.equal((await service.list({ sinceMs: Date.now() - 60_000 })).length, 1);
  assert.equal((await service.list({ sinceMs: Date.now() + 60_000 })).length, 0);
});

test('an unknown provider is rejected with a list, not a stack trace', async () => {
  const r = repo();
  const service = new ForgeService({ repo: r });
  await assert.rejects(
    () => service.spawnJob({ mode: 'implement', prompt: 'x', provider: 'cdoe' }),
    /unknown provider "cdoe"\. Known providers: agy, codex, opencode, claude, kimi/,
  );
  assert.deepEqual(readdirSync(r), []);
});

test('a missing binary produces a FAILED job, not a rejected promise', async () => {
  const r = repo();
  const saved = process.env['AGENT_SMITH_AGY_BIN'];
  process.env['AGENT_SMITH_AGY_BIN'] = path.join(r, 'definitely-not-here');
  try {
    const svc = new ForgeService({ repo: r });
    const { done } = await svc.spawnTracked({ mode: 'implement', prompt: 'x', provider: 'agy' });
    const got = await done;
    assert.equal(got.status, 'failed');
    assert.equal(got.jobStatus, 'spawn-failed');
    assert.match(got.error ?? '', /no result|spawn/);
  } finally {
    if (saved === undefined) delete process.env['AGENT_SMITH_AGY_BIN'];
    else process.env['AGENT_SMITH_AGY_BIN'] = saved;
  }
});

async function waitForTerminal(repoRoot: string, jobId: string, timeoutMs: number): Promise<any> {
  await waitFor(
    () => {
      const at = path.join(repoRoot, '.agent-smith', 'jobs', jobId, 'job.json');
      if (!existsSync(at)) return false;
      const m = JSON.parse(readFileSync(at, 'utf8')) as { status: string };
      return m.status !== 'running';
    },
    { timeoutMs: Math.max(timeoutMs, 60_000), message: `job ${jobId} to reach a terminal status` },
  );
  return JSON.parse(
    readFileSync(path.join(repoRoot, '.agent-smith', 'jobs', jobId, 'job.json'), 'utf8'),
  );
}

test('humanDuration reads at a glance', () => {
  assert.equal(humanDuration(30_000), '30s');
  assert.equal(humanDuration(45 * 60_000), '45m');
  assert.equal(humanDuration(65 * 60_000), '1h05m');
  assert.equal(humanDuration(2 * 3_600_000), '2h');
});
