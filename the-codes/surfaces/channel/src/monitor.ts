/**
 * Job-scoped monitor entrypoint (the `notify.fallback` monitorCommand).
 *
 * This process is deliberately separate from the MCP server: Claude Code can
 * launch it with `--job`/`--run` and consume one human-readable line per
 * milestone from stdout. Routine running/progress polls produce no stdout.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isTerminalForgeStatus } from '../../../forge/format.ts';
import { type Batch, type WatchableJob, buildBatch, dedupeKey } from './policy.ts';
import { readJob, readPipelineRecord } from './watch-source.ts';

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
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
  readonly emit?: (line: string, batch: Batch | null) => Promise<void> | void;
  readonly onError?: (error: unknown) => void;
  /**
   * Announce each job once. A job that exited with checks still running (its acceptance budget
   * ran out) is announced as "exited · checks running" and the watch ends, instead of waiting for
   * the verdict as a second notice. For callers that can wake Claude only once (the fallback hook).
   */
  readonly announceOnce?: boolean;
}

export type JobWatchEnd = 'done' | 'timeout' | 'aborted';


/**
 * Watch specific jobs/runs until each is terminal. There is NO silent
 * baseline: a job that already finished before the watcher
 * started is reported on the first observation.
 */
export async function runJobWatch(options: JobWatchOptions): Promise<JobWatchEnd> {
  const intervalMs = Math.max(50, options.intervalMs ?? 2_000);
  const timeoutMs = options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const rj = options.readJob ?? readJob;
  const rr = options.readRun ?? readPipelineRecord;
  const emit = options.emit ?? emitStdout;
  const onError = options.onError ?? ((error) => { process.stderr.write(`agent-smith monitor: ${String(error)}\n`); });
  const jobIds = [...new Set(options.jobIds ?? [])];
  const runIds = [...new Set(options.runIds ?? [])];
  const seen = new Map<string, Set<string>>();
  const done = new Set<string>();
  let startedAt = now();

  while (!options.signal?.aborted) {
    try {
      const t = now();
      const jobs = new Map<string, WatchableJob>();
      const want = new Set(jobIds);
      for (let i = 0; i < jobIds.length; i++) {
        const id = jobIds[i]!;
        const job = await rj(options.cwd, id, t);
        if (!job) continue;
        jobs.set(job.id, job);
        if (job.supersededBy && job.supersededBy !== job.id) {
          if (jobIds.includes(job.supersededBy)) {
            done.add(job.id);
          } else {
            const childJob = await rj(options.cwd, job.supersededBy, t);
            if (childJob) {
              done.add(job.id);
              jobIds.push(job.supersededBy);
              want.add(job.supersededBy);
              startedAt = t;
            }
          }
        }
      }
      for (const id of runIds) {
        const rec = await rr(options.cwd, id);
        if (!rec) continue;
        jobs.set(rec.job.id, rec.job);
        want.add(rec.job.id);
        for (const sid of rec.stageJobIds) {
          if (jobs.has(sid)) continue;
          const sj = await rj(options.cwd, sid, t);
          if (sj) jobs.set(sj.id, sj);
        }
      }
      // Announcing once: a stage that exited with its checks still running waits for its verdict
      // rather than contributing a "checks running" line that the one write would carry twice.
      const announce = options.announceOnce === true
        ? [...jobs.values()].filter((job) => job.checksRunning === undefined || want.has(job.id))
        : [...jobs.values()];
      const batch = buildBatch(announce.map((job) => ({ job, seen: seen.get(job.id) ?? new Set<string>(), knownBefore: true })), t);
      if (batch.content !== null) {
        await emit(batch.content.replace(/\s+/g, ' ').trim(), batch);
        for (const key of batch.keys) {
          const id = key.slice(0, key.indexOf('#'));
          const set = seen.get(id);
          if (set) set.add(key); else seen.set(id, new Set([key]));
        }
      }
      for (const id of want) {
        const job = jobs.get(id);
        if (job?.supersededBy) {
          if (want.has(job.supersededBy)) done.add(id);
          continue;
        }
        // Exited with checks still running: the verdict is a second notice, so keep watching (unless announcing once).
        if (job && isTerminalForgeStatus(job.status) && (options.announceOnce === true || job.checksRunning === undefined) && (seen.get(id)?.has(dedupeKey(job)) ?? false)) done.add(id);
      }
      if (want.size > 0 && [...want].every((id) => done.has(id))) return 'done';
    } catch (error) {
      onError(error);
    }
    if (now() - startedAt >= timeoutMs) {
      const ids = [...jobIds, ...runIds].filter((id) => !done.has(id));
      try { await emit(`Agent Smith · still running: ${ids.join(', ')}`, null); } catch (error) { onError(error); }
      return 'timeout';
    }
    await delay(intervalMs, options.signal);
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

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
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
  if (out.cwd === null) {
    const e = env['AGY_WATCH_CWD'];
    out.cwd = typeof e === 'string' && e.length > 0 ? path.resolve(e) : process.cwd();
  }
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
