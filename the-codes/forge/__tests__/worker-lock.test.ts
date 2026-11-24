import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { holdsWorkerLock, withWorkerLock, withWorkerLockSync, workerFileKey, workerLockPath } from '../worker-lock.ts';

const repo = () => mkdtempSync(path.join(tmpdir(), 'smith-lock-'));
const deadPid = (): number => Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
const plant = (r: string, id: string, body: string): string => {
  const file = workerLockPath(r, id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
};

test('sync: the lock file holds "<pid>\\n<iso>" while held and is gone after, even when fn throws', () => {
  const r = repo();
  const file = workerLockPath(r, 'w1');
  const seen = withWorkerLockSync(r, 'w1', () => {
    assert.equal(holdsWorkerLock(r, 'w1'), true);
    return readFileSync(file, 'utf8');
  });
  const [pid, iso] = seen.split('\n');
  assert.equal(Number(pid), process.pid);
  assert.ok(Number.isFinite(Date.parse(iso!)));
  assert.equal(existsSync(file), false);
  assert.equal(holdsWorkerLock(r, 'w1'), false);
  assert.throws(() => withWorkerLockSync(r, 'w1', () => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(file), false);
});

test('a lock whose pid is dead is stale and is broken', () => {
  const r = repo();
  plant(r, 'w2', `${deadPid()}\n2026-01-01T00:00:00.000Z\n`);
  const t0 = Date.now();
  assert.equal(withWorkerLockSync(r, 'w2', () => 'ran', { waitMs: 2_000 }), 'ran');
  assert.ok(Date.now() - t0 < 1_000, 'no waiting on a dead holder');
});

test('an empty lock file is stale only once it is old (a crash between open and write)', () => {
  const r = repo();
  const file = plant(r, 'w3', '');
  assert.throws(() => withWorkerLockSync(r, 'w3', () => 'x', { waitMs: 50 }), /gave up after 50 ms/);
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  assert.equal(withWorkerLockSync(r, 'w3', () => 'ok', { waitMs: 500 }), 'ok');
});

test('a lock held by a live process is waited on, boundedly, then an error', async () => {
  const r = repo();
  const file = plant(r, 'w4', `${process.ppid}\n${new Date().toISOString()}\n`);
  const t0 = Date.now();
  assert.throws(() => withWorkerLockSync(r, 'w4', () => 'x', { waitMs: 120 }), new RegExp(`locked by pid ${process.ppid}; gave up after 120 ms`));
  assert.ok(Date.now() - t0 >= 100);
  await assert.rejects(withWorkerLock(r, 'w4', () => 'x', { waitMs: 120 }), /gave up after 120 ms/);
  assert.equal(existsSync(file), true, 'a live lock is never broken');
});

test('not reentrant: a sync acquire while this process holds the lock fails fast', async () => {
  const r = repo();
  withWorkerLockSync(r, 'w5', () => {
    const t0 = Date.now();
    assert.throws(() => withWorkerLockSync(r, 'w5', () => 'x'), /already held by this process/);
    assert.ok(Date.now() - t0 < 500);
  });
  await withWorkerLock(r, 'w5', () => {
    assert.throws(() => withWorkerLockSync(r, 'w5', () => 'x'), /already held by this process/);
  });
});

test('async: concurrent holders in one process are serialized', async () => {
  const r = repo();
  let inside = 0;
  let maxInside = 0;
  const order: number[] = [];
  await Promise.all([0, 1, 2, 3].map((i) => withWorkerLock(r, 'w6', async () => {
    inside += 1;
    maxInside = Math.max(maxInside, inside);
    await new Promise((res) => setTimeout(res, 15));
    order.push(i);
    inside -= 1;
  })));
  assert.equal(maxInside, 1);
  assert.equal(order.length, 4);
});

test('release unlinks only our own lock', () => {
  const r = repo();
  const file = workerLockPath(r, 'w7');
  withWorkerLockSync(r, 'w7', () => {
    writeFileSync(file, `${process.ppid}\nsomeone-else\n`);
  });
  assert.equal(readFileSync(file, 'utf8'), `${process.ppid}\nsomeone-else\n`);
});

test('unsafe worker ids (pipeline "<run>:<stage>") get a hashed, safe file name', () => {
  assert.equal(workerFileKey('abc-1'), 'abc-1');
  const k = workerFileKey('run-1:implement');
  assert.match(k, /^h-[0-9a-f]{40}$/);
  assert.equal(workerFileKey('run-1:implement'), k);
  const r = repo();
  assert.equal(withWorkerLockSync(r, 'run-1:implement', () => 'ok'), 'ok');
});

test('an unbounded wait keeps waiting on a live holder, reports it periodically, and takes the lock once the holder dies', async () => {
  const r = repo();
  const holder = spawn('sleep', ['30']);
  plant(r, 'w9', `${holder.pid}\n${new Date().toISOString()}\n`);
  const notices: string[] = [];
  setTimeout(() => holder.kill(), 5_500);
  const t0 = Date.now();
  const ran = await withWorkerLock(r, 'w9', () => 'ran', { waitMs: Number.POSITIVE_INFINITY, onWait: (_ms, pid) => notices.push(pid) });
  assert.equal(ran, 'ran');
  assert.ok(Date.now() - t0 >= 5_000);
  assert.deepEqual(notices, [String(holder.pid)]);
});
