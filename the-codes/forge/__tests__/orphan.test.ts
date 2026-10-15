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
  CANCEL_ORPHAN_REASON, FILES, LEGACY_ORPHAN_AFTER_MS, ORPHAN_REASON, deriveOrphan, isPidAlive, jobFile,
} from '../format.ts';
import { ForgeService } from '../service.ts';
import { writeAcceptance, readAcceptance } from '../checks.ts';
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

test('dead supervisor reader is read-only; service persists the orphan verdict', async () => {
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
  assert.equal(existsSync(jobFile(repo, id, FILES.orphaned)), false);
  writeAcceptance(repo, id, { state: 'unchecked', checks: [], pending: true });
  const service = new ForgeService({ repo, mirror: false });
  assert.equal((await service.list())[0]?.status, 'failed');
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.error, ORPHAN_REASON);
  assert.ok(persisted.finishedAt);
  const acceptance = readAcceptance(repo, id);
  assert.equal('pending' in acceptance && acceptance.pending, false);
  const after = readFileSync(file, 'utf8');
  writeAcceptance(repo, id, { state: 'unchecked', checks: [], pending: true });
  await service.list();
  assert.equal(readFileSync(file, 'utf8'), after);
  assert.equal(readAcceptance(repo, id).state, 'rejected', 'a restart repairs an interrupted sidecar write');
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

test('service preserves live supervisors and terminal anchors; partial results do not block recovery', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'orphan-'));
  const service = new ForgeService({ repo, mirror: false });
  const id = 'implement-smith-aaaa0004';
  writerFor(repo, id);
  const file = jobFile(repo, id, FILES.job);
  const before = readFileSync(file, 'utf8');
  await service.list();
  assert.equal(readFileSync(file, 'utf8'), before);
  const m = JSON.parse(before);
  writeFileSync(file, JSON.stringify({ ...m, ownerPid: deadPid() }));
  writeFileSync(jobFile(repo, id, FILES.result), JSON.stringify({ ok: true }));
  await service.list();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'failed');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).jobStatus, 'orphaned');
  writeFileSync(file, JSON.stringify({ ...m, status: 'succeeded', finishedAt: iso(NOW) }));
  const finished = readFileSync(file, 'utf8');
  await service.list();
  assert.equal(readFileSync(file, 'utf8'), finished);
});

test('service startup recovers dead supervisors before any MCP read', async () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'orphan-'));
  const id = 'implement-smith-aaaa0005';
  writerFor(repo, id);
  const file = jobFile(repo, id, FILES.job);
  const m = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...m, ownerPid: deadPid() }));
  new ForgeService({ repo, mirror: false });
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(persisted.status, 'failed');
  assert.equal(persisted.jobStatus, 'orphaned');
  assert.ok(persisted.finishedAt);
});

/* ── cancel outranks orphan ───────────────────────────────────────────────── */

/** A running job with the given owner and a cancel request `cancelAgeMs` old (null = none). */
function cancelFixture(id: string, ownerPid: number | undefined, cancelAgeMs: number | null, marker = false) {
  const repo = mkdtempSync(path.join(tmpdir(), 'orphan-'));
  writerFor(repo, id);
  const file = jobFile(repo, id, FILES.job);
  const { ownerPid: _drop, ...m } = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify(ownerPid === undefined ? m : { ...m, ownerPid }));
  if (cancelAgeMs !== null) writeFileSync(jobFile(repo, id, FILES.cancel), iso(Date.now() - cancelAgeMs));
  if (marker) writeFileSync(jobFile(repo, id, FILES.orphaned), '');
  return { repo, file };
}

test('deriveOrphan: cancel request + dead pid => canceled, not suspicious', () => {
  const v = deriveOrphan({ status: 'running', ownerPid: deadPid() }, NOW, NOW, undefined, true);
  assert.deepEqual(v, { status: 'canceled', suspicious: false, reason: CANCEL_ORPHAN_REASON });
  assert.equal(deriveOrphan({ status: 'running', ownerPid: process.pid }, NOW, NOW, undefined, true), null);
});

test('reader: cancel + dead pid is canceled, even right after the request', async () => {
  const { repo } = cancelFixture('implement-smith-cccc0001', deadPid(), 1_000);
  assert.equal((await observe(repo, 'implement-smith-cccc0001')).status, 'canceled');
});

test('reader: cancel + no pid + old + orphaned marker is canceled (real-world shape)', async () => {
  const { repo } = cancelFixture('implement-smith-cccc0002', undefined, 10 * 60_000, true);
  assert.equal((await observe(repo, 'implement-smith-cccc0002')).status, 'canceled');
});

test('reader: no cancel + dead pid is still failed/orphaned', async () => {
  const { repo } = cancelFixture('implement-smith-cccc0003', deadPid(), null);
  const job = await observe(repo, 'implement-smith-cccc0003');
  assert.equal(job.status, 'failed');
  assert.ok(job.warnings.some((w) => w.message === ORPHAN_REASON));
});

test('reader: cancel + live pid is still running, marker or not', async () => {
  for (const [id, marker] of [['implement-smith-cccc0004', false], ['implement-smith-cccc0005', true]] as const) {
    const { repo } = cancelFixture(id, process.pid, 10 * 60_000, marker);
    assert.equal((await observe(repo, id)).status, 'running');
  }
});

test('reconcile persists canceled for cancel + dead pid, failed without the request', async () => {
  const a = cancelFixture('implement-smith-cccc0006', deadPid(), 1_000);
  const service = new ForgeService({ repo: a.repo, mirror: false });
  assert.equal((await service.list())[0]?.status, 'canceled');
  const persisted = JSON.parse(readFileSync(a.file, 'utf8'));
  assert.equal(persisted.status, 'canceled');
  assert.equal(persisted.error, CANCEL_ORPHAN_REASON);
  assert.ok(persisted.finishedAt);
  const settled = readFileSync(a.file, 'utf8');
  await service.list();
  assert.equal(readFileSync(a.file, 'utf8'), settled, 'settled verdict is not rewritten');

  const b = cancelFixture('implement-smith-cccc0007', deadPid(), null);
  new ForgeService({ repo: b.repo, mirror: false });
  assert.equal(JSON.parse(readFileSync(b.file, 'utf8')).status, 'failed');

  const c = cancelFixture('implement-smith-cccc0008', process.pid, 10 * 60_000);
  new ForgeService({ repo: c.repo, mirror: false });
  assert.equal(JSON.parse(readFileSync(c.file, 'utf8')).status, 'running');
});
