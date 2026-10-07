/** orphan.test.ts — a `running` job whose supervisor died is derived `failed`. */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AgentSmithReader } from '../../harness/agent-smith.ts';
import { normalize } from '../../harness/normalize.ts';
import {
  FILES, LEGACY_ORPHAN_AFTER_MS, ORPHAN_REASON, deriveOrphan, isPidAlive, jobFile,
} from '../format.ts';
import { JobWriter } from '../writer.ts';

/** A pid that existed and was reaped: guaranteed dead. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(r.stdout.toString());
}

const NOW = Date.parse('2026-10-07T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();

test('dead pid is not alive, our own pid is', () => {
  assert.equal(isPidAlive(deadPid()), false);
  assert.equal(isPidAlive(process.pid), true);
});

test('deriveOrphan: dead owner pid => failed, suspicious, with the reason', () => {
  const v = deriveOrphan({ status: 'running', ownerPid: deadPid(), createdAt: iso(NOW) }, NOW, NOW);
  assert.deepEqual(v, { status: 'failed', suspicious: true, reason: ORPHAN_REASON });
});

test('deriveOrphan: live owner pid stays running, however old', () => {
  const old = NOW - 10 * LEGACY_ORPHAN_AFTER_MS;
  assert.equal(deriveOrphan({ status: 'running', ownerPid: process.pid, createdAt: iso(old) }, old, NOW), null);
});

test('deriveOrphan: terminal anchors are never touched', () => {
  assert.equal(deriveOrphan({ status: 'succeeded', ownerPid: deadPid() }, null, NOW), null);
});

test('deriveOrphan: legacy manifest is orphaned only past 2x the default timeout', () => {
  const m = { status: 'running', createdAt: iso(NOW - LEGACY_ORPHAN_AFTER_MS + 60_000) };
  assert.equal(deriveOrphan(m, null, NOW), null);
  const old = { status: 'running', createdAt: iso(NOW - LEGACY_ORPHAN_AFTER_MS - 1) };
  assert.equal(deriveOrphan(old, null, NOW)?.status, 'failed');
  // recent liveness evidence rescues an old createdAt
  assert.equal(deriveOrphan(old, NOW - 1000, NOW), null);
});

function writerFor(repo: string, jobId: string): JobWriter {
  const w = new JobWriter({ repo, jobId, mirror: false, flushMs: 0 });
  w.start({
    provider: 'agy', mode: 'implement', model: 'm', effort: 'low', cwd: repo,
    prompt: 'do the thing', unrestricted: false, conversation: null,
    pipeline: null, stage: null, attempt: null,
  } as never);
  return w;
}

async function observe(repo: string, jobId: string) {
  const raw = await new AgentSmithReader().read(repo, jobId);
  assert.ok(raw);
  return normalize(raw);
}

test('writer records ownerPid; live supervisor reads running and leaves no marker', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'orphan-'));
  const id = 'implement-smith-aaaa0001';
  writerFor(repo, id);
  const m = JSON.parse(readFileSync(jobFile(repo, id, FILES.job), 'utf8'));
  assert.equal(m.ownerPid, process.pid);
  assert.equal((await observe(repo, id)).status, 'running');
  assert.equal(existsSync(jobFile(repo, id, FILES.orphaned)), false);
});

test('dead supervisor reads failed with the reason; job.json is untouched', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'orphan-'));
  const id = 'implement-smith-aaaa0002';
  writerFor(repo, id);
  const file = jobFile(repo, id, FILES.job);
  const m = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...m, ownerPid: deadPid() }));
  const before = readFileSync(file, 'utf8');

  const job = await observe(repo, id);
  assert.equal(job.status, 'failed');
  assert.ok(job.warnings.some((w) => w.message === ORPHAN_REASON));
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(existsSync(jobFile(repo, id, FILES.orphaned)), true);
});

test('a finished job whose supervisor is gone keeps its real verdict', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'orphan-'));
  const id = 'implement-smith-aaaa0003';
  writerFor(repo, id);
  const file = jobFile(repo, id, FILES.job);
  const m = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...m, ownerPid: deadPid(), status: 'succeeded' }));
  assert.equal((await observe(repo, id)).status, 'succeeded');
});
