/**
 * Native Claude monitor entrypoint.
 *
 * This process is deliberately separate from the MCP server: Claude Code can
 * launch it as a repo-local monitor and consume one human-readable line per
 * milestone from stdout. It uses the same filesystem reader and poller as the
 * channel, so startup baselining, status rules, and deduplication stay identical.
 * Routine running/progress polls produce no stdout.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pollOnce, resetPoller } from './poller.ts';
import type { Batch, WatchableJob } from './policy.ts';
import { readAll } from './watch-source.ts';

export interface MonitorOptions {
  readonly cwd: string;
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly read?: (cwd: string, now: number) => Promise<WatchableJob[]>;
  /** Receives one collapsed, human-readable milestone line (without newline). */
  readonly emit?: (line: string, batch: Batch) => Promise<void> | void;
  readonly onError?: (error: unknown) => void;
}

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

/**
 * Monitor until aborted. Each send is one deduplicated policy batch; progress
 * is suppressed by policy and no startup backlog is emitted.
 */
export async function runMonitor(options: MonitorOptions): Promise<void> {
  const intervalMs = Math.max(100, options.intervalMs ?? 5_000);
  const now = options.now ?? Date.now;
  const read = options.read ?? readAll;
  const emit = options.emit ?? emitStdout;
  const onError = options.onError ?? ((error) => {
    process.stderr.write(`agent-smith monitor: ${String(error)}\n`);
  });

  // A monitor is a fresh observer. Existing jobs become the silent baseline;
  // only transitions seen after this point can reach Claude.
  resetPoller();
  while (!options.signal?.aborted) {
    try {
      await pollOnce(options.cwd, now(), async (batch) => {
        if (batch.content === null) return;
        const line = `Agent Smith: ${batch.content.replace(/\s+/g, ' ').trim()}`;
        await emit(line, batch);
      }, read);
    } catch (error) {
      // A transient output or poll failure must not prevent the next observation.
      onError(error);
    }
    if (options.signal?.aborted) break;
    await delay(intervalMs, options.signal);
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

function resolveCwd(): string {
  const arg = process.argv[2];
  if (arg !== undefined && arg.length > 0 && !arg.startsWith('--')) return path.resolve(arg);
  const env = process.env['AGY_WATCH_CWD'];
  if (typeof env === 'string' && env.length > 0) return path.resolve(env);
  return process.cwd();
}

function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && path.resolve(invoked) === fileURLToPath(import.meta.url);
}

export async function startCliMonitor(): Promise<void> {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  await runMonitor({ cwd: resolveCwd(), signal: controller.signal });
}

if (isEntrypoint()) await startCliMonitor();
