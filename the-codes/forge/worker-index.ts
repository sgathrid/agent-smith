import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { WORKERS_DIR, parseWorkerIndex, type WorkerIndex } from '../surfaces/mod/hooks/turns.ts';
import { writeJsonAtomic } from './atomic.ts';
import { jobsDir, readManifest, type ForgeManifest } from './format.ts';
import { holdsWorkerLock, withWorkerLockSync, workerFileKey } from './worker-lock.ts';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const INDEX_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/;

export function workerIndexFile(repo: string, workerId: string): string {
  return path.join(repo, WORKERS_DIR, `${workerFileKey(workerId)}.json`);
}

function readIndexFile(file: string): WorkerIndex | null {
  try {
    return parseWorkerIndex(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

function startMs(m: Pick<ForgeManifest, 'startedAt' | 'createdAt'>): number {
  const ms = Date.parse(m.startedAt ?? m.createdAt ?? '');
  return Number.isFinite(ms) ? ms : 0;
}

const MTIME_SETTLE_MS = 50;

function settled(mtimeMs: number): number {
  return Date.now() - mtimeMs > MTIME_SETTLE_MS ? mtimeMs : Number.NaN;
}

function mtimeOf(dir: string): number {
  try { return statSync(dir).mtimeMs; } catch { return -1; }
}

export function readWorkerIndex(repo: string, workerId: string): WorkerIndex | null {
  if (workerId === '') return null;
  const index = readIndexFile(workerIndexFile(repo, workerId));
  return index !== null && index.workerId === workerId ? index : null;
}

function writeWorkerIndex(repo: string, index: WorkerIndex): void {
  writeJsonAtomic(workerIndexFile(repo, index.workerId), index);
}

export function appendTurnsLocked(
  repo: string,
  workerId: string,
  name: string,
  jobIds: readonly string[],
  legacyTurns: readonly string[] = [],
): WorkerIndex {
  const current = readWorkerIndex(repo, workerId);
  const turns = [...(current?.turns ?? legacyTurns)];
  const have = new Set(turns);
  for (const id of jobIds) if (!have.has(id)) { turns.push(id); have.add(id); }
  const next: WorkerIndex = { schema: 1, workerId, name: current?.name ?? name, turns, updatedAt: new Date().toISOString() };
  writeWorkerIndex(repo, next);
  return next;
}

function underLock<T>(repo: string, workerId: string, lockHeld: boolean, fn: () => T): T {
  return lockHeld || holdsWorkerLock(repo, workerId) ? fn() : withWorkerLockSync(repo, workerId, fn);
}

export interface WorkerIndexStoreOptions {
  readonly readManifest?: (jobId: string) => ForgeManifest | null;
}

export class WorkerIndexStore {
  readonly repo: string;
  private readonly read: (jobId: string) => ForgeManifest | null;
  private readonly byName = new Map<string, Set<string>>();
  private readonly names = new Map<string, string>();
  private readonly jobWorker = new Map<string, string>();
  private readonly seenIndexFiles = new Set<string>();
  private readonly seenJobs = new Set<string>();
  private workersMtime = Number.NaN;
  private jobsMtime = Number.NaN;

  constructor(repo: string, options: WorkerIndexStoreOptions = {}) {
    this.repo = repo;
    this.read = options.readManifest ?? ((id) => { try { return readManifest(repo, id); } catch { return null; } });
  }

  private remember(index: WorkerIndex): void {
    this.names.set(index.workerId, index.name);
    let set = this.byName.get(index.name);
    if (set === undefined) this.byName.set(index.name, (set = new Set()));
    set.add(index.workerId);
    for (const id of index.turns) { this.jobWorker.set(id, index.workerId); this.seenJobs.add(id); }
  }

  get(workerId: string): WorkerIndex | null {
    const index = readWorkerIndex(this.repo, workerId);
    if (index !== null) this.remember(index);
    return index;
  }

  workersNamed(name: string): string[] {
    this.refresh();
    return [...(this.byName.get(name) ?? [])];
  }

  refresh(): void {
    const workersDir = path.join(this.repo, WORKERS_DIR);
    const wm = mtimeOf(workersDir);
    if (wm !== this.workersMtime) {
      // A directory mtime advances in ticks (ms on Linux): an entry created in the
      // same tick as the last one seen leaves it unchanged. Trust an mtime only
      // once it is older than one tick window, so the next call re-reads.
      this.workersMtime = settled(wm);
      let files: string[] = [];
      try { files = readdirSync(workersDir); } catch {}
      for (const f of files) {
        if (this.seenIndexFiles.has(f)) continue;
        if (!INDEX_FILE.test(f)) continue;
        const index = readIndexFile(path.join(workersDir, f));
        if (index === null) continue;
        this.seenIndexFiles.add(f);
        this.remember(index);
      }
    }
    const jdir = jobsDir(this.repo);
    const jm = mtimeOf(jdir);
    if (jm === this.jobsMtime) return;
    let ids: string[] = [];
    try { ids = readdirSync(jdir); } catch {}
    const unindexed = new Map<string, ForgeManifest[]>();
    let complete = true;
    for (const id of ids) {
      if (this.seenJobs.has(id) || !SAFE_ID.test(id)) continue;
      const manifest = this.read(id);
      if (manifest === null) { complete = false; continue; }
      if (typeof manifest.turn === 'number') { this.seenJobs.add(id); continue; }
      const workerId = typeof manifest.workerId === 'string' && manifest.workerId !== '' ? manifest.workerId : id;
      const list = unindexed.get(workerId);
      if (list === undefined) unindexed.set(workerId, [manifest]);
      else list.push(manifest);
    }
    for (const [workerId, manifests] of unindexed) {
      try {
        this.indexLegacy(workerId, manifests);
      } catch {
        complete = false;
      }
    }
    if (complete) this.jobsMtime = settled(jm);
  }

  private indexLegacy(workerId: string, manifests: readonly ForgeManifest[]): void {
    const fresh = this.get(workerId);
    const missing = manifests.filter((m) => !(fresh?.turns ?? []).includes(m.jobId));
    if (missing.length === 0) { for (const m of manifests) this.seenJobs.add(m.jobId); return; }
    const sorted = [...missing].sort((a, b) => startMs(a) - startMs(b) || a.jobId.localeCompare(b.jobId));
    const name = [...sorted].reverse().find((m) => typeof m.name === 'string' && m.name !== '')?.name ?? workerId;
    const index = underLock(this.repo, workerId, false, () => {
      const existing = readWorkerIndex(this.repo, workerId);
      if (existing === null) {
        return appendTurnsLocked(this.repo, workerId, name, sorted.map((m) => m.jobId));
      }
      return appendTurnsLocked(this.repo, workerId, name, sorted.map((m) => m.jobId).filter((id) => !existing.turns.includes(id)));
    });
    this.remember(index);
    for (const m of manifests) this.seenJobs.add(m.jobId);
  }

  private scanWorker(workerId: string, exclude: string): string[] {
    let ids: string[] = [];
    try { ids = readdirSync(jobsDir(this.repo)); } catch { return []; }
    const found: ForgeManifest[] = [];
    for (const id of ids) {
      if (id === exclude || !SAFE_ID.test(id)) continue;
      const m = this.read(id);
      if (m !== null && (m.workerId ?? id) === workerId) found.push(m);
    }
    return found.sort((a, b) => startMs(a) - startMs(b) || a.jobId.localeCompare(b.jobId)).map((m) => m.jobId);
  }

  recordTurnStart(input: {
    readonly workerId: string; readonly name: string; readonly jobId: string; readonly continuation: boolean;
    readonly lockHeld?: boolean;
    readonly alsoLocked?: () => void;
  }): WorkerIndex {
    const { workerId, name, jobId } = input;
    const index = underLock(this.repo, workerId, input.lockHeld === true, () => {
      const needsLegacy = input.continuation && !existsSync(workerIndexFile(this.repo, workerId));
      const legacy = needsLegacy ? this.scanWorker(workerId, jobId) : [];
      const next = appendTurnsLocked(this.repo, workerId, name, [jobId], legacy);
      input.alsoLocked?.();
      return next;
    });
    this.remember(index);
    return index;
  }

  workerOf(jobId: string): string | undefined {
    return this.jobWorker.get(jobId);
  }
}
