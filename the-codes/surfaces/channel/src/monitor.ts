import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isTerminalForgeStatus, jobDir, jobsDir } from '../../../forge/format.ts';
import { pipelineRecordPath } from '../../../forge/execute.ts';
import { waitForChange } from '../../../forge/watch.ts';
import { type Batch, type WatchableJob, buildBatch, dedupeKey } from './policy.ts';
import { readJob, readPipelineRecord } from './watch-source.ts';
import { readJsonSafe } from '../../../harness/safe-fs.ts';
import { WORKERS_DIR, isWorkerIdle, parseWorkerIndex, pickHead, workerIndexPath, type TurnLike, type WorkerIndex } from '../../mod/hooks/turns.ts';

function safeJobDir(cwd: string, id: string): string {
  try { return jobDir(cwd, id); } catch { return jobsDir(cwd); }
}

async function waitForAnyChange(
  dirs: readonly string[],
  fallbackDir: string,
  timeoutMs: number,
  opts: { signal?: AbortSignal; fallbackMs: number },
): Promise<void> {
  if (opts.signal?.aborted || !(timeoutMs > 0)) return;
  const unique = [...new Set(dirs)];
  if (unique.length === 0) {
    await waitForChange(fallbackDir, timeoutMs, opts);
    return;
  }
  if (unique.length === 1) {
    await waitForChange(unique[0]!, timeoutMs, opts);
    return;
  }
  const slice = new AbortController();
  const onAbort = () => slice.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race(unique.map((dir) => waitForChange(dir, timeoutMs, { signal: slice.signal, fallbackMs: opts.fallbackMs })));
  } finally {
    slice.abort();
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

async function emitStdout(line: string): Promise<void> {
  if (process.stdout.write(`${line}\n`)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      process.stdout.off('drain', onDrain);
      process.stdout.off('error', onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    process.stdout.once('drain', onDrain);
    process.stdout.once('error', onError);
  });
}

const DEFAULT_WATCH_TIMEOUT_MS = 45 * 60_000 + 60_000;
const WATCH_RECHECK_MS = 5_000;
const WATCH_FALLBACK_MS = 500;

export interface JobWatchOptions {
  readonly cwd: string;
  readonly jobIds?: readonly string[];
  readonly runIds?: readonly string[];
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly readJob?: (cwd: string, id: string, now: number) => Promise<WatchableJob | null>;
  readonly readRun?: (cwd: string, id: string) => Promise<{ job: WatchableJob; stageJobIds: string[] } | null>;
  readonly readIndex?: (cwd: string, workerId: string) => Promise<WorkerIndex | null>;
  readonly emit?: (line: string, batch: Batch | null) => Promise<void> | void;
  readonly onError?: (error: unknown) => void;
  readonly announceOnce?: boolean;
}

export type JobWatchEnd = 'done' | 'timeout' | 'aborted';

interface WorkerWatch {
  readonly root: string;
  rootTurn: number | null;
  head: string | null;
}

function watchTurn(job: WatchableJob): TurnLike {
  return {
    jobId: job.id, status: job.status, turn: job.turn, supersededBy: job.supersededBy, followedBy: job.followedBy,
    startedAt: job.startedAt, acceptancePending: job.acceptancePending, pendingMessages: job.pendingMessages,
  };
}

export async function readWorkerIndex(cwd: string, workerId: string): Promise<WorkerIndex | null> {
  let file: string;
  try { file = workerIndexPath(cwd, workerId); } catch { return null; }
  return parseWorkerIndex(await readJsonSafe<unknown>(file));
}

const MAX_TURNS_READ = 64;

async function followWorkerHead(
  cwd: string,
  rootId: string,
  root: WatchableJob,
  now: number,
  readJobFn: (cwd: string, id: string, now: number) => Promise<WatchableJob | null>,
  readIndexFn: (cwd: string, workerId: string) => Promise<WorkerIndex | null>,
): Promise<{ head: WatchableJob; missingNextId: string | null }> {
  const rows = new Map<string, WatchableJob>([[root.id, root]]);
  const index = root.workerId ? await readIndexFn(cwd, root.workerId) : null;
  const at = index ? index.turns.indexOf(rootId) : -1;
  for (const id of at >= 0 ? index!.turns.slice(at + 1) : []) {
    if (rows.size >= MAX_TURNS_READ) break;
    const row = await readJobFn(cwd, id, now);
    if (row) rows.set(row.id, row);
  }
  let head = pickHead([...rows.values()].map((r) => ({ ...watchTurn(r), row: r })))!.row;
  let missingNextId: string | null = null;
  for (let next = head.supersededBy ?? head.followedBy; next && !rows.has(next) && rows.size < MAX_TURNS_READ; next = head.supersededBy ?? head.followedBy) {
    const row = await readJobFn(cwd, next, now);
    if (!row) { missingNextId = next; break; }
    rows.set(row.id, row);
    head = pickHead([...rows.values()].map((r) => ({ ...watchTurn(r), row: r })))!.row;
  }
  return { head, missingNextId };
}

export async function runJobWatch(options: JobWatchOptions): Promise<JobWatchEnd> {
  const recheckMs = Math.max(50, options.intervalMs ?? WATCH_RECHECK_MS);
  const fallbackMs = Math.max(50, options.intervalMs ?? WATCH_FALLBACK_MS);
  const timeoutMs = options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const rj = options.readJob ?? readJob;
  const rr = options.readRun ?? readPipelineRecord;
  const ri = options.readIndex ?? readWorkerIndex;
  const emit = options.emit ?? emitStdout;
  const onError = options.onError ?? ((error) => { process.stderr.write(`agent-smith monitor: ${String(error)}\n`); });
  const workers: WorkerWatch[] = [...new Set(options.jobIds ?? [])].map((root) => ({ root, rootTurn: null, head: null }));
  const runIds = [...new Set(options.runIds ?? [])];
  const seen = new Map<string, Set<string>>();
  const done = new Set<string>();
  let startedAt = now();

  while (!options.signal?.aborted) {
    const watchDirs: string[] = [];
    try {
      const t = now();
      const candidates: WatchableJob[] = [];
      const finals = new Map<string, WatchableJob>();
      for (const w of workers) {
        if (done.has(w.root)) continue;
        const root = await rj(options.cwd, w.root, t);
        if (!root) { watchDirs.push(safeJobDir(options.cwd, w.root)); continue; }
        w.rootTurn ??= root.turn ?? 1;
        const { head, missingNextId } = await followWorkerHead(options.cwd, w.root, root, t, rj, ri);
        if (missingNextId !== null) watchDirs.push(safeJobDir(options.cwd, missingNextId));
        if (w.head !== null && w.head !== head.id) startedAt = t;
        w.head = head.id;
        if (root.workerId) watchDirs.push(path.join(options.cwd, WORKERS_DIR));
        watchDirs.push(safeJobDir(options.cwd, head.id));
        const turn = head.turn ?? 1;
        const announced = w.rootTurn !== null && turn > w.rootTurn ? { ...head, alsoRan: { from: w.rootTurn, to: turn - 1 } } : head;
        if (head.status === 'attention' || isWorkerIdle(watchTurn(head))) {
          candidates.push(announced);
          if (isWorkerIdle(watchTurn(head))) finals.set(w.root, announced);
        }
      }
      for (const id of runIds) {
        if (done.has(id)) continue;
        const rec = await rr(options.cwd, id);
        if (!rec) { watchDirs.push(path.dirname(pipelineRecordPath(options.cwd, id))); continue; }
        candidates.push(rec.job);
        finals.set(id, rec.job);
        watchDirs.push(path.dirname(pipelineRecordPath(options.cwd, id)));
        for (const sid of rec.stageJobIds) {
          watchDirs.push(safeJobDir(options.cwd, sid));
          const sj = await rj(options.cwd, sid, t);
          if (sj && !(options.announceOnce === true && sj.checksRunning !== undefined)) candidates.push(sj);
        }
      }
      const unique = [...new Map(candidates.map((job) => [job.id, job])).values()];
      const batch = buildBatch(unique.map((job) => ({ job, seen: seen.get(job.id) ?? new Set<string>(), observedInPriorPoll: true })), t);
      if (batch.content !== null) {
        await emit(batch.content.replace(/\s+/g, ' ').trim(), batch);
        for (const key of batch.keys) {
          const id = key.slice(0, key.indexOf('#'));
          const set = seen.get(id);
          if (set) set.add(key); else seen.set(id, new Set([key]));
        }
      }
      for (const [id, job] of finals) {
        if (isTerminalForgeStatus(job.status) && !job.acceptancePending && (options.announceOnce === true || job.checksRunning === undefined) &&
          (seen.get(job.id)?.has(dedupeKey(job)) ?? false)) done.add(id);
      }
      const all = [...workers.map((w) => w.root), ...runIds];
      if (all.length > 0 && all.every((id) => done.has(id))) return 'done';
    } catch (error) {
      onError(error);
    }
    const elapsed = now() - startedAt;
    if (elapsed >= timeoutMs) {
      const ids = [...workers.filter((w) => !done.has(w.root)).map((w) => w.head ?? w.root), ...runIds.filter((id) => !done.has(id))];
      try { await emit(`Agent Smith · still running: ${ids.join(', ')}`, null); } catch (error) { onError(error); }
      return 'timeout';
    }
    await waitForAnyChange(watchDirs, jobsDir(options.cwd), Math.min(recheckMs, Math.max(1, timeoutMs - elapsed)), { signal: options.signal, fallbackMs });
  }
  return 'aborted';
}

interface CliArgs {
  cwd: string | null;
  jobIds: string[];
  runIds: string[];
  exitCode: number;
  timeoutMs: number;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const out: CliArgs = { cwd: null, jobIds: [], runIds: [], exitCode: 0, timeoutMs: DEFAULT_WATCH_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    if (a === '--job' && v) { out.jobIds.push(v); i++; }
    else if (a === '--run' && v) { out.runIds.push(v); i++; }
    else if (a === '--cwd' && v) { out.cwd = path.resolve(v); i++; }
    else if (a === '--exit-code' && v && Number.isInteger(Number(v))) { out.exitCode = Number(v); i++; }
    else if (a === '--timeout-ms' && v && Number(v) > 0) { out.timeoutMs = Number(v); i++; }
    else if (!a.startsWith('--') && out.cwd === null && i === 0) out.cwd = path.resolve(a);
  }
  if (out.cwd === null) out.cwd = process.cwd();
  return out;
}

function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && path.resolve(invoked) === fileURLToPath(import.meta.url);
}

export async function startCliMonitor(): Promise<void> {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const args = parseArgs(process.argv.slice(2));
  if (args.jobIds.length > 0 || args.runIds.length > 0) {
    await runJobWatch({ cwd: args.cwd!, jobIds: args.jobIds, runIds: args.runIds, timeoutMs: args.timeoutMs, signal: controller.signal });
    process.exitCode = args.exitCode;
  }
}

if (isEntrypoint()) await startCliMonitor();
