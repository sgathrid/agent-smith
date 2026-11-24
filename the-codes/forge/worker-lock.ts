import { createHash } from 'node:crypto';
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { WORKERS_DIR } from '../surfaces/mod/hooks/turns.ts';

export const LOCK_WAIT_MS = 5_000;
const EMPTY_LOCK_STALE_MS = 2_000;
const POLL_MS = 10;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface WorkerLockOptions {
  readonly waitMs?: number;
  readonly onWait?: ((waitedMs: number, holder: string) => void) | undefined;
}

const heldHere = new Set<string>();
let breakCounter = 0;

export function workerFileKey(workerId: string): string {
  if (SAFE_ID.test(workerId) && workerId !== '.' && workerId !== '..') return workerId;
  if (workerId === '') throw new Error('Invalid worker id');
  return `h-${createHash('sha256').update(workerId).digest('hex').slice(0, 40)}`;
}

export function workerLockPath(repo: string, workerId: string): string {
  return path.join(repo, WORKERS_DIR, `${workerFileKey(workerId)}.lock`);
}

export function holdsWorkerLock(repo: string, workerId: string): boolean {
  return heldHere.has(key(repo, workerId));
}

function key(repo: string, workerId: string): string {
  return `${path.resolve(repo)}\0${workerId}`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parsePid(body: string): number | null {
  const pid = Number.parseInt(body.split('\n')[0] ?? '', 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isStale(body: string, mtimeMs: number, now: number): boolean {
  const pid = parsePid(body);
  if (pid === null) return now - mtimeMs > EMPTY_LOCK_STALE_MS;
  return !pidAlive(pid);
}

function tryAcquire(file: string): string | null {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = `${process.pid}\n${new Date().toISOString()}\n`;
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      breakIfStale(file);
      return null;
    }
    throw err;
  }
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  return body;
}

/**
 * Break a stale lock without the read-then-unlink race: move it aside under a
 * unique name, then look at what was moved. If it turns out to be live (it was
 * replaced between our read and the rename), put it back with link(), which
 * fails rather than overwrite a lock created meanwhile.
 */
function breakIfStale(file: string): void {
  let body: string;
  let mtimeMs: number;
  try {
    body = readFileSync(file, 'utf8');
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return;
  }
  if (!isStale(body, mtimeMs, Date.now())) return;
  breakCounter += 1;
  const aside = `${file}.stale-${process.pid}-${breakCounter}`;
  try {
    renameSync(file, aside);
  } catch {
    return;
  }
  let moved = '';
  try { moved = readFileSync(aside, 'utf8'); } catch {}
  if (moved !== body && !isStale(moved, Date.now(), Date.now())) {
    try { linkSync(aside, file); } catch {}
  }
  try { unlinkSync(aside); } catch {}
}

function release(file: string, body: string): void {
  try {
    if (readFileSync(file, 'utf8') === body) unlinkSync(file);
  } catch {}
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function holderOf(file: string): string {
  try { return readFileSync(file, 'utf8').split('\n')[0] || 'unknown'; } catch { return 'unknown'; }
}

function timeoutError(workerId: string, file: string, waitMs: number): Error {
  return new Error(`worker "${workerId}" is locked by pid ${holderOf(file)}; gave up after ${waitMs} ms (${file}).`);
}

export function withWorkerLockSync<T>(repo: string, workerId: string, fn: () => T, options: WorkerLockOptions = {}): T {
  const file = workerLockPath(repo, workerId);
  const k = key(repo, workerId);
  if (heldHere.has(k)) throw new Error(`worker "${workerId}" lock is already held by this process (not reentrant).`);
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;
  let body = tryAcquire(file);
  while (body === null) {
    if (Date.now() >= deadline) throw timeoutError(workerId, file, waitMs);
    sleepSync(POLL_MS);
    body = tryAcquire(file);
  }
  heldHere.add(k);
  try {
    return fn();
  } finally {
    heldHere.delete(k);
    release(file, body);
  }
}

export async function withWorkerLock<T>(repo: string, workerId: string, fn: () => T | Promise<T>, options: WorkerLockOptions = {}): Promise<T> {
  const file = workerLockPath(repo, workerId);
  const k = key(repo, workerId);
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const startedAt = Date.now();
  let nextNotice = startedAt + LOCK_WAIT_MS;
  let body = heldHere.has(k) ? null : tryAcquire(file);
  while (body === null) {
    const now = Date.now();
    if (now - startedAt >= waitMs) throw timeoutError(workerId, file, waitMs);
    if (options.onWait !== undefined && now >= nextNotice) {
      options.onWait(now - startedAt, holderOf(file));
      nextNotice = now + LOCK_WAIT_MS;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
    body = heldHere.has(k) ? null : tryAcquire(file);
  }
  heldHere.add(k);
  try {
    return await fn();
  } finally {
    heldHere.delete(k);
    release(file, body);
  }
}
