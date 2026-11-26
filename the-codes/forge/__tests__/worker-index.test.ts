import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { FILES, jobFile } from '../format.ts';
import { ForgeService } from '../service.ts';
import { workerIndexPath } from '../../surfaces/mod/hooks/turns.ts';
import { existsSync } from 'node:fs';
import { WorkerIndexStore, appendTurnsLocked, workerIndexFile } from '../worker-index.ts';
import { workerLockPath } from '../worker-lock.ts';

const TURNS_PER_WORKER = 5;

function syntheticRepo(n: number): { repo: string; workers: number } {
  const repo = mkdtempSync(path.join(tmpdir(), 'smith-index-perf-'));
  const workers = n / TURNS_PER_WORKER;
  const base = Date.parse('2026-11-01T00:00:00.000Z');
  for (let w = 0; w < workers; w++) {
    for (let t = 1; t <= TURNS_PER_WORKER; t++) {
      const id = `job-${w}-${t}`;
      const file = jobFile(repo, id, FILES.job);
      mkdirSync(path.dirname(file), { recursive: true });
      const at = new Date(base + (w * TURNS_PER_WORKER + t) * 60_000).toISOString();
      writeFileSync(file, JSON.stringify({
        schema: 1, jobId: id, name: `worker-${w}`, workerId: `w-${w}`, turn: t,
        ...(t > 1 ? { continuedFrom: `job-${w}-${t - 1}`, continuationKind: 'follow-up' } : {}),
        ...(t < TURNS_PER_WORKER ? { followedBy: `job-${w}-${t + 1}` } : {}),
        provider: 'codex', mode: 'review', cwd: repo, status: 'succeeded',
        createdAt: at, startedAt: at, updatedAt: at, finishedAt: at,
      }));
      appendTurnsLocked(repo, `w-${w}`, `worker-${w}`, [id]);
    }
  }
  return { repo, workers };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

interface Timings { byName: number; byId: number; detailByName: number; detailById: number }

async function timeLookups(n: number): Promise<Timings> {
  const { repo, workers } = syntheticRepo(n);
  const service = new ForgeService({ repo });
  const mid = Math.floor(workers / 2);
  assert.equal(service.resolveWorkerHeadId(`worker-${mid}`), `job-${mid}-${TURNS_PER_WORKER}`);
  assert.ok(existsSync(workerIndexPath(repo, `w-${mid}`)));
  await new Promise((r) => setTimeout(r, 80));
  service.resolveWorkerHeadId(`worker-${mid}`);
  const byName: number[] = [];
  const byId: number[] = [];
  const detailByName: number[] = [];
  const detailById: number[] = [];
  for (let i = 0; i < 40; i++) {
    const w = (mid + i) % workers;
    let t0 = performance.now();
    assert.equal(service.resolveWorkerHeadId(`worker-${w}`), `job-${w}-${TURNS_PER_WORKER}`);
    byName.push(performance.now() - t0);
    t0 = performance.now();
    assert.equal(service.resolveWorkerHeadId(`job-${w}-2`), `job-${w}-${TURNS_PER_WORKER}`);
    byId.push(performance.now() - t0);
    t0 = performance.now();
    assert.equal((await service.resolveWorkerHead(`worker-${w}`)).jobId, `job-${w}-${TURNS_PER_WORKER}`);
    detailByName.push(performance.now() - t0);
    t0 = performance.now();
    assert.equal((await service.resolveWorkerHead(`job-${w}-2`)).jobId, `job-${w}-${TURNS_PER_WORKER}`);
    detailById.push(performance.now() - t0);
  }
  return { byName: median(byName), byId: median(byId), detailByName: median(detailByName), detailById: median(detailById) };
}

test('perf: resolveWorkerHead lookup time stays flat from 100 to 1,000 job dirs once indexed', async () => {
  const small = await timeLookups(100);
  const large = await timeLookups(1_000);
  assert.ok(large.byName < small.byName * 3 + 0.3, `by name 100 -> 1,000: ${small.byName.toFixed(3)} -> ${large.byName.toFixed(3)} ms`);
  assert.ok(large.byId < small.byId * 3 + 0.3, `by id 100 -> 1,000: ${small.byId.toFixed(3)} -> ${large.byId.toFixed(3)} ms`);
  assert.ok(large.detailByName < small.detailByName * 3 + 0.5, `resolveWorkerHead by name 100 -> 1,000: ${small.detailByName.toFixed(3)} -> ${large.detailByName.toFixed(3)} ms`);
  assert.ok(large.detailById < small.detailById * 3 + 0.5, `resolveWorkerHead by id 100 -> 1,000: ${small.detailById.toFixed(3)} -> ${large.detailById.toFixed(3)} ms`);
});

test('a job started by another process after the cache was built is found by name and by id', async () => {
  const { repo } = syntheticRepo(10);
  const service = new ForgeService({ repo });
  assert.equal(service.resolveWorkerHeadId('worker-0'), 'job-0-5');
  const late = new ForgeService({ repo });
  const file = jobFile(repo, 'job-0-6', FILES.job);
  mkdirSync(path.dirname(file), { recursive: true });
  const at = new Date().toISOString();
  writeFileSync(file, JSON.stringify({
    schema: 1, jobId: 'job-0-6', name: 'worker-0', workerId: 'w-0', turn: 6, continuedFrom: 'job-0-5',
    continuationKind: 'follow-up', provider: 'codex', mode: 'review', cwd: repo, status: 'succeeded',
    createdAt: at, startedAt: at, updatedAt: at, finishedAt: at,
  }));
  appendTurnsLocked(repo, 'w-0', 'worker-0', ['job-0-6']);
  assert.equal(late.resolveWorkerHeadId('job-0-6'), 'job-0-6');
  assert.equal(service.resolveWorkerHeadId('worker-0'), 'job-0-6');
  assert.equal(service.resolveWorkerHeadId('w-0'), 'job-0-6');
  const nf = jobFile(repo, 'fresh-1', FILES.job);
  mkdirSync(path.dirname(nf), { recursive: true });
  writeFileSync(nf, JSON.stringify({ schema: 1, jobId: 'fresh-1', name: 'newcomer', provider: 'codex', mode: 'review', cwd: repo, status: 'succeeded', startedAt: at, createdAt: at }));
  assert.equal(service.resolveWorkerHeadId('newcomer'), 'fresh-1');
});

test('refresh never takes the worker lock for a turn its starter has not indexed yet', () => {
  const repo = mkdtempSync(path.join(tmpdir(), 'smith-index-'));
  const at = new Date().toISOString();
  const file = jobFile(repo, 'job-new-2', FILES.job);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({
    schema: 1, jobId: 'job-new-2', name: 'starting', workerId: 'w-new', turn: 2, continuedFrom: 'job-new-1',
    provider: 'codex', mode: 'review', cwd: repo, status: 'running', createdAt: at, startedAt: at, updatedAt: at,
  }));
  const lock = workerLockPath(repo, 'w-new');
  mkdirSync(path.dirname(lock), { recursive: true });
  writeFileSync(lock, `${process.ppid}\n${at}\n`);
  const t0 = Date.now();
  new WorkerIndexStore(repo).refresh();
  assert.ok(Date.now() - t0 < 1_000, `refresh waited ${Date.now() - t0} ms on the starter's lock`);
  assert.equal(existsSync(workerIndexFile(repo, 'w-new')), false);
});

test('refresh reads a continuation turn written by another process once, not on every jobs dir change', async () => {
  const { repo } = syntheticRepo(5);
  const reads = new Map<string, number>();
  const store = new WorkerIndexStore(repo, { readManifest: (id) => {
    reads.set(id, (reads.get(id) ?? 0) + 1);
    try { return JSON.parse(readFileSync(jobFile(repo, id, FILES.job), 'utf8')); } catch { return null; }
  } });
  store.refresh();
  const at = new Date().toISOString();
  const file = jobFile(repo, 'job-0-6', FILES.job);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ schema: 1, jobId: 'job-0-6', name: 'worker-0', workerId: 'w-0', turn: 6, provider: 'codex', mode: 'review', cwd: repo, status: 'succeeded', createdAt: at, startedAt: at }));
  appendTurnsLocked(repo, 'w-0', 'worker-0', ['job-0-6']);
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 80));
    mkdirSync(path.join(repo, '.agent-smith', 'jobs', `other-${i}`));
    store.refresh();
  }
  assert.equal(reads.get('job-0-6'), 1);
});
