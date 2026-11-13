/**
 * tail.ts — live NDJSON step streamer for an agent-smith worker job.
 *
 * Watches a job directory, drains events.jsonl from a byte offset without
 * splitting UTF-8 or partial lines, reduces ProviderEvents into compact step
 * records, follows steer continuations, waits for non-pending acceptance, and
 * reconciles orphaned workers via an inactivity dead-man switch.
 */

import { closeSync, fstatSync, openSync, readSync, watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAcceptance } from '../../../forge/checks.ts';
import {
  isTerminalForgeStatus,
  jobDir,
  jobFile,
  ownerAlive,
  readManifest,
  FILES,
  type ForgeManifest,
  type ForgeStatus,
} from '../../../forge/format.ts';
import { reconcileOrphan } from '../../../forge/reconcile.ts';
import { readSteerHead } from '../../../forge/steer-log.ts';
import type { ProviderEvent } from '../../../providers/types.ts';
import { ACCEPTANCE_HOLD_MS } from '../../mod/hooks/notice.ts';
import { classify } from '../../mod/hooks/progress.ts';
import { oneLine } from '../../mod/hooks/text.ts';

export const DEFAULT_DEADMAN_MS = 35_000;
const FALLBACK_POLL_MS = 500;
const MAX_ASSISTANT_CHARS = 160;

export type TailStatus = Exclude<ForgeStatus, 'running'>;

export type TailRecord =
  | { readonly kind: 'step'; readonly text: string }
  | { readonly kind: 'job'; readonly jobId: string }
  | { readonly kind: 'settled'; readonly jobId: string; readonly status: TailStatus };

export type WatchListener = (eventType: string, filename: string | Buffer | null) => void;

export interface WatcherLike {
  on(event: 'error', listener: (err: Error) => void): unknown;
  close(): void;
}

export type WatchFn = (dir: string, listener: WatchListener) => WatcherLike;

export interface TailOptions {
  readonly job: string;
  readonly repo: string;
  /** Called once per NDJSON record (JSON string without trailing newline). */
  readonly out: (line: string) => void;
  readonly watchFn?: WatchFn;
  readonly deadmanMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface SplitLinesResult {
  readonly lines: string[];
  readonly consumedBytes: number;
}

/**
 * Decode complete `\n`-terminated UTF-8 lines from `buf`, returning only up to
 * the last `0x0a` byte so partial lines and split multi-byte UTF-8 sequences
 * are never emitted.
 */
export function splitCompleteLines(buf: Buffer): SplitLinesResult {
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline === -1) return { lines: [], consumedBytes: 0 };
  const text = buf.subarray(0, lastNewline).toString('utf8');
  const lines = text.split('\n').filter((line) => line.length > 0);
  return { lines, consumedBytes: lastNewline + 1 };
}

function formatAssistantText(raw: string): string {
  const collapsed = oneLine(raw, MAX_ASSISTANT_CHARS + 1);
  if (collapsed.length === 0) return '';
  if (collapsed.length <= MAX_ASSISTANT_CHARS) return collapsed;
  return `${oneLine(collapsed, MAX_ASSISTANT_CHARS - 1)}…`;
}

function capitalizeFirst(text: string): string {
  if (text.length === 0) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Pure reducer from normalized ProviderEvent records to compact step records.
 * Caches tool input by stepIndex across activity-start / activity-update for
 * activity-end, and concatenates delta assistant text until the next boundary.
 */
export class EventReducer {
  private readonly inputsByStep = new Map<number, string>();
  private textBuffer = '';

  push(event: ProviderEvent): TailRecord[] {
    switch (event.kind) {
      case 'started':
      case 'usage':
      case 'notice':
      case 'heartbeat':
        return [];

      case 'activity-start': {
        const flushed = this.flush();
        if (typeof event.activity.input === 'string' && event.activity.input !== '') {
          this.inputsByStep.set(event.activity.stepIndex, event.activity.input);
        }
        return flushed;
      }

      case 'activity-update': {
        if (typeof event.activity.input === 'string' && event.activity.input !== '') {
          this.inputsByStep.set(event.activity.stepIndex, event.activity.input);
        }
        return [];
      }

      case 'activity-end': {
        const cached = this.inputsByStep.get(event.activity.stepIndex);
        this.inputsByStep.delete(event.activity.stepIndex);
        const input = (typeof event.activity.input === 'string' && event.activity.input !== '')
          ? event.activity.input
          : cached;
        const label = classify(event.activity.tool, input).label;
        const formatted = capitalizeFirst(label || event.activity.tool);
        const text = event.status === 'error' ? `✗ ${formatted}` : formatted;
        return [{ kind: 'step', text }];
      }

      case 'text': {
        if (event.stream !== 'assistant') return [];
        if (event.delta === true) {
          this.textBuffer += event.text;
          return [];
        }
        // Held, not emitted: the worker's last message is its report, which the hand-back
        // carries. A message followed by more work is emitted at the next activity.
        const out = this.flush();
        this.textBuffer = event.text;
        return out;
      }
    }
  }

  /** Flush any buffered delta assistant text as one step record. */
  flush(): TailRecord[] {
    if (this.textBuffer === '') return [];
    const text = formatAssistantText(this.textBuffer);
    this.textBuffer = '';
    return text === '' ? [] : [{ kind: 'step', text }];
  }

  /** Reset state when switching to a steer continuation job. */
  reset(): void {
    this.inputsByStep.clear();
    this.textBuffer = '';
  }
}

function readNewEventBytes(eventsPath: string, offset: number): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(eventsPath, 'r');
    const size = fstatSync(fd).size;
    if (size <= offset) return Buffer.alloc(0);
    const len = size - offset;
    const buf = Buffer.allocUnsafe(len);
    let totalRead = 0;
    while (totalRead < len) {
      const n = readSync(fd, buf, totalRead, len - totalRead, offset + totalRead);
      if (n === 0) break;
      totalRead += n;
    }
    return totalRead === len ? buf : buf.subarray(0, totalRead);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
    throw err;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

type PendingAcceptance = { pending?: boolean; budgetMs?: unknown };

function acceptancePending(repo: string, jobId: string, finishedAt: string | null, now: number): boolean {
  if (finishedAt === null) return false;
  const finished = Date.parse(finishedAt);
  const placeholder = readAcceptance(repo, jobId) as PendingAcceptance;
  if (placeholder.pending !== true) return false;
  const budget = typeof placeholder.budgetMs === 'number' && placeholder.budgetMs > 0
    ? placeholder.budgetMs
    : ACCEPTANCE_HOLD_MS;
  return !(Number.isFinite(finished) && now - finished > budget);
}

function nextSteerJobId(repo: string, jobId: string, manifest: ForgeManifest): string | null {
  if (typeof manifest.supersededBy === 'string' && manifest.supersededBy.length > 0) {
    return manifest.supersededBy;
  }
  return readSteerHead(repo, jobId);
}

/**
 * Stream reduced steps for `job` in `repo` until it (or its steer chain)
 * settles, writing NDJSON records to `out`.
 */
export async function runTail(options: TailOptions): Promise<void> {
  const {
    job,
    repo,
    out,
    watchFn = (dir, listener) => fsWatch(dir, listener),
    deadmanMs = DEFAULT_DEADMAN_MS,
    signal,
    now = Date.now,
  } = options;

  if (signal?.aborted) return;

  const emit = (record: TailRecord): void => {
    out(JSON.stringify(record));
  };

  let currentJobId = job;
  let currentDir = jobDir(repo, currentJobId);
  let offset = 0;
  const reducer = new EventReducer();
  const seen = new Set<string>([currentJobId]);

  let watcher: WatcherLike | null = null;
  let fallbackTimer: NodeJS.Timeout | null = null;
  let deadmanTimer: NodeJS.Timeout | null = null;
  let done = false;
  let drainInFlight = false;
  let dirty = false;

  const stopWatch = (): void => {
    if (watcher !== null) {
      try { watcher.close(); } catch { /* ignore */ }
      watcher = null;
    }
  };

  const stopFallback = (): void => {
    if (fallbackTimer !== null) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
  };

  const stopDeadman = (): void => {
    if (deadmanTimer !== null) {
      clearTimeout(deadmanTimer);
      deadmanTimer = null;
    }
  };

  const cleanup = (): void => {
    done = true;
    stopWatch();
    stopFallback();
    stopDeadman();
  };

  const drainEvents = (): void => {
    const eventsPath = jobFile(repo, currentJobId, FILES.events);
    const buf = readNewEventBytes(eventsPath, offset);
    if (buf.length === 0) return;
    const { lines, consumedBytes } = splitCompleteLines(buf);
    if (consumedBytes === 0) return;
    offset += consumedBytes;
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { kind?: unknown }).kind !== 'string') {
        continue;
      }
      for (const rec of reducer.push(parsed as ProviderEvent)) {
        emit(rec);
      }
    }
  };

  const flushReducer = (): void => {
    for (const rec of reducer.flush()) {
      emit(rec);
    }
  };

  return await new Promise<void>((resolve, reject) => {
    const finish = (err?: unknown): void => {
      if (done) return;
      cleanup();
      signal?.removeEventListener('abort', onAbort);
      if (err !== undefined) reject(err);
      else resolve();
    };

    const onAbort = (): void => {
      finish();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const armDeadman = (): void => {
      stopDeadman();
      if (done || deadmanMs <= 0) return;
      deadmanTimer = setTimeout(() => {
        if (done) return;
        try {
          const manifest = readManifest(repo, currentJobId);
          if (!ownerAlive(manifest)) {
            reconcileOrphan(repo, currentJobId, now());
          }
          scheduleDrain();
          if (!done) armDeadman();
        } catch (err) {
          finish(err);
        }
      }, deadmanMs);
      deadmanTimer.unref?.();
    };

    const startFallback = (): void => {
      if (done || fallbackTimer !== null) return;
      fallbackTimer = setInterval(() => {
        if (!done) scheduleDrain();
      }, FALLBACK_POLL_MS);
    };

    const startWatch = (dir: string): void => {
      stopWatch();
      stopFallback();
      try {
        const w = watchFn(dir, () => {
          if (done) return;
          armDeadman();
          scheduleDrain();
        });
        watcher = w;
        w.on('error', () => {
          if (done) return;
          stopWatch();
          startFallback();
        });
      } catch {
        startFallback();
      }
    };

    const drainOnce = (): void => {
      if (done) return;
      drainEvents();
      const manifest = readManifest(repo, currentJobId);

      // Steer handoff MUST be checked before terminal or acceptance.
      const nextId = nextSteerJobId(repo, currentJobId, manifest);
      if (nextId !== null && !seen.has(nextId)) {
        seen.add(nextId);
        // Final drain of the parent before switching to the child.
        drainEvents();
        flushReducer();

        currentJobId = nextId;
        currentDir = jobDir(repo, currentJobId);
        offset = 0;
        reducer.reset();
        startWatch(currentDir);
        emit({ kind: 'job', jobId: currentJobId });
        dirty = true;
        return;
      }

      if (isTerminalForgeStatus(manifest.status) && !acceptancePending(repo, currentJobId, manifest.finishedAt, now())) {
        // Final drain before emitting settled. Buffered assistant text is the report: dropped here.
        drainEvents();
        reducer.reset();
        emit({ kind: 'settled', jobId: currentJobId, status: manifest.status });
        finish();
      }
    };

    const scheduleDrain = (): void => {
      if (done) return;
      if (drainInFlight) {
        dirty = true;
        return;
      }
      drainInFlight = true;
      try {
        do {
          dirty = false;
          drainOnce();
        } while (dirty && !done);
      } catch (err) {
        finish(err);
      } finally {
        drainInFlight = false;
      }
    };

    // 1. Watch the job directory first (never the file itself), arm dead-man,
    //    then perform the immediate initial drain.
    startWatch(currentDir);
    armDeadman();
    scheduleDrain();
  });
}

export interface TailCliArgs {
  readonly job: string | null;
  readonly repo: string | null;
}

export function parseTailArgs(argv: readonly string[]): TailCliArgs {
  let job: string | null = null;
  let repo: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const val = argv[i + 1];
    if (arg === '--job' && val !== undefined) {
      job = val;
      i++;
    } else if (arg === '--repo' && val !== undefined) {
      repo = path.resolve(val);
      i++;
    }
  }
  return { job, repo };
}

let cliStarted = false;

export async function startCliTail(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (cliStarted) return;
  cliStarted = true;
  const { job, repo } = parseTailArgs(argv);
  if (!job || !repo) {
    process.stderr.write('Usage: tail --job <jobId> --repo <absolute repo>\n');
    process.exitCode = 1;
    return;
  }

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  // The reader went away (the hook left its loop, or a stop killed it): stop quietly. The
  // handler stays installed, since writes already queued can fail after runTail returns.
  const onStdoutError = (err: NodeJS.ErrnoException): void => {
    if (err.code === 'EPIPE') { controller.abort(); process.exitCode = 0; }
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  process.stdout.on('error', onStdoutError);

  try {
    await runTail({
      job,
      repo,
      out: (line) => {
        process.stdout.write(`${line}\n`);
      },
      signal: controller.signal,
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }
}

function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  return invoked !== undefined && path.resolve(invoked) === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) {
  await startCliTail();
}
