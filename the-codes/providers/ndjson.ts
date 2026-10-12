/**
 * providers/ndjson.ts — shared spawn/stream plumbing for every adapter.
 *
 * WHY THIS EXISTS
 * ===============
 * Four CLIs, four JSON dialects, one set of hard-won process rules. Repeating
 * those rules per adapter is how you end up with the claude-squad trap: one
 * adapter quietly wrapping its child in a PTY, another forgetting to cap its
 * stderr buffer, a third leaking a listener. So they live here, once.
 *
 * THE RULES ENFORCED HERE (do not duplicate these in an adapter):
 *   1. stdio is ALWAYS ['ignore'|'pipe', 'pipe', 'pipe']. Never a TTY, never a
 *      PTY, never 'inherit'. ARCHITECTURE.md rules out tmux/claude-squad
 *      scrollback; a PTY would also merge stderr into stdout and destroy NDJSON.
 *   2. stdin is 'ignore' by default. Codex explicitly reads stdin when it is a
 *      pipe and will happily block waiting for input that never comes. agy and
 *      claude take the prompt on argv, so stdin is dead weight.
 *   3. stderr is capped. A worker that spams stderr must not OOM the parent.
 *   4. Every kill path goes through terminate(): SIGTERM, grace, SIGKILL.
 *   5. waitForResult resolves exactly once, on every terminal path including
 *      "the process exited and we never saw a result event".
 *
 * Node builtins only. No dependencies, by requirement and by taste.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

/**
 * Minimal `which`: walk PATH, test for X_OK.
 *
 * WHY NOT execFile('which', ...): spawning a shell helper once per provider per
 * startup is wasteful, and `which` does not exist on Windows. PATH walking is
 * ~20 lines, has zero process overhead, and behaves identically on all three
 * platforms. Cached per (binary, PATH) pair because detectAvailable() probes
 * four providers back to back and PATH does not change mid-run.
 *
 * NOTE: the PATH list separator is path.DELIMITER, not path.SEP. See the
 * comment inside the function below, which has the details.
 */
const pathProbeCache = new Map<string, boolean>();

export async function binaryOnPath(bin: string): Promise<boolean> {
  const pathEnv = process.env['PATH'] ?? '';
  const cacheKey = `${bin}|${pathEnv}`;
  const cached = pathProbeCache.get(cacheKey);
  if (cached !== undefined) return cached;

  // A name containing a path separator is a PATH, not a name. This is what makes
  // the documented AGENT_SMITH_<NAME>_BIN overrides work at all: without this,
  // path.join(dir, '/opt/bin/agy') yields '/usr/local/bin/opt/bin/agy' and an
  // absolute override can never resolve. Same rule as execvp.
  if (bin.includes('/') || bin.includes(path.sep)) {
    let direct = false;
    try {
      await access(bin, constants.X_OK);
      direct = true;
    } catch {
      /* not executable */
    }
    pathProbeCache.set(cacheKey, direct);
    return direct;
  }

  // `path.delimiter`, NOT `path.sep`. The PATH *list* separator is ':' on POSIX
  // and ';' on Windows; `path.sep` is '/' and '\' — the separator BETWEEN
  // components of a single path. Splitting PATH by path.sep walks garbage
  // fragments like 'sers/gathrid/.local/bin' and never finds anything, so
  // binaryOnPath returned false for every binary on a machine where all four
  // were installed. Caught by `agent-smith doctor` reporting zero providers.
  const dirs = pathEnv.split(path.delimiter).filter((d) => d !== '');
  let found = false;
  for (const dir of dirs) {
    const full = path.join(dir, bin);
    try {
      await access(full, constants.X_OK);
      found = true;
      break;
    } catch {
      /* keep walking */
    }
  }
  pathProbeCache.set(cacheKey, found);
  return found;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Root for all provider-written state. Overridable for tests / multi-root setups. */
export function stateRoot(): string {
  return process.env['AGENT_SMITH_STATE_DIR'] ?? path.join(os.homedir(), '.agent-smith', 'state');
}

/**
 * Create the state directory for a job. Returns the absolute path.
 * Called BEFORE spawn() so a consumer can tail events.jsonl the instant the
 * handle exists.
 */
export function writeStateDir(provider: string, jobId: string, override?: string): string {
  const dir = override ?? path.join(stateRoot(), provider, jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Persist the exact argv/cwd/env-keys we spawned with. Debugging breadcrumb. */
export function writeArgv(dir: string, argv: string[], cwd: string): void {
  // argv[0] is the binary path and can leak into logs; it is not a secret.
  writeFileSync(path.join(dir, 'argv.json'), JSON.stringify({ argv, cwd }, null, 2));
}

/**
 * Clamp a string to `max` characters, marking it truncated.
 *
 * WHY CHARACTERS AND NOT BYTES: a surrogate pair or a multi-byte UTF-8 char
 * split at a byte boundary produces replacement characters in the UI. JS strings
 * are already UTF-16, so slicing by code unit is safe for storage (it can split
 * a surrogate pair, hence the ellipsis hint that the text is cut).
 */
export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}…`, truncated: true };
}

/**
 * Coerce an unknown JSON value to a preview string.
 * Tool params come back as objects (`{"CommandLine":"cargo test"}`), which is
 * useless on a one-line band. We render them compactly rather than [object Object].
 */
export function preview(value: unknown, max: number): { text: string; truncated: boolean } | undefined {
  if (value === undefined || value === null) return undefined;
  let s: string;
  if (typeof value === 'string') s = value;
  else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  return truncate(s, max);
}

/** Parse one line of a stream as JSON, or undefined if it is not an object. */
export function tryParseObject(line: string): Record<string, unknown> | undefined {
  const t = line.trim();
  if (t === '' || (t[0] !== '{' && t[0] !== '[')) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Read a string field off an unknown record without fighting the type system. */
export function str(o: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = o?.[key];
  return typeof v === 'string' ? v : undefined;
}

/** Read a nested record field. */
export function obj(o: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const v = o?.[key];
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

/** Read a finite number field. Strings that parse as numbers are accepted (some CLIs emit "3"). */
export function num(o: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = o?.[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** ISO timestamp. One helper so every event sorts lexicographically by time. */
export function nowIso(at = Date.now()): string {
  return new Date(at).toISOString();
}

// ---------------------------------------------------------------------------
// Event bus: push (onEvent) + pull (AsyncIterable) over the same stream
// ---------------------------------------------------------------------------

export interface EventBus {
  emit(event: import('./types.js').ProviderEvent): void;
  onEvent(listener: (event: import('./types.js').ProviderEvent) => void): () => void;
  readonly events: AsyncIterable<import('./types.js').ProviderEvent>;
  close(): void;
}

/**
 * Bounded-queue bus.
 *
 * WHY THE BOUND: a `--forward-subagent-text` claude run with a chatty
 * subagent can emit events faster than a slow consumer drains them. Unbounded
 * buffering is a memory leak with a long fuse. On overflow we DROP the oldest
 * queued events and record that we did, rather than growing without limit.
 */
export function createEventBus(maxQueue = 4096): EventBus {
  const listeners = new Set<(e: import('./types.js').ProviderEvent) => void>();
  const queue: import('./types.js').ProviderEvent[] = [];
  let waiting: ((v: IteratorResult<import('./types.js').ProviderEvent>) => void) | undefined;
  let done = false;

  function emit(event: import('./types.js').ProviderEvent): void {
    // A throwing listener must not take down the worker pump. Log and continue.
    for (const l of listeners) {
      try {
        l(event);
      } catch {
        /* consumer's problem, not the worker's */
      }
    }
    if (waiting) {
      const w = waiting;
      waiting = undefined;
      w({ value: event, done: false });
      return;
    }
    if (queue.length >= maxQueue) queue.shift();
    queue.push(event);
  }

  return {
    emit,
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    events: {
      [Symbol.asyncIterator](): AsyncIterator<import('./types.js').ProviderEvent> {
        return {
          next(): Promise<IteratorResult<import('./types.js').ProviderEvent>> {
            const q = queue.shift();
            if (q !== undefined) return Promise.resolve({ value: q, done: false });
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise<IteratorResult<import('./types.js').ProviderEvent>>((resolve) => {
              waiting = resolve;
            });
          },
          return(): Promise<IteratorResult<import('./types.js').ProviderEvent>> {
            done = true;
            waiting?.({ value: undefined, done: true });
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
    close() {
      done = true;
      const w = waiting;
      waiting = undefined;
      w?.({ value: undefined, done: true });
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// spawnWorker: the single, shared child-process lifecycle
// ---------------------------------------------------------------------------

export interface WorkerPumps {
  /** Called for every non-empty stdout line (NDJSON is one object per line). */
  onStdoutLine(line: string): void;
  /** Called for each chunk of stderr, already capped per chunk. */
  onStderr(chunk: string): void;
}

export interface SpawnWorkerOptions extends WorkerPumps {
  provider: string;
  binary: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  /** SIGTERM-to-SIGKILL grace period. Defaults to 5 seconds. */
  killGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  stateDir: string;
  jobId: string;
  mode: string;
}

/**
 * The concrete child type we actually get: stdin is null (stdio[0]='ignore'),
 * stdout and stderr are Readable.
 */
export type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

export interface WorkerProcess {
  child: PipedChild;
  /** Resolves once the process is fully reaped. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** SIGTERM then SIGKILL. Idempotent. */
  terminate(reason: 'cancelled' | 'timeout'): void;
  /** 'cancelled' | 'timeout' | undefined — whichever kill path fired, if any. */
  killReason: 'cancelled' | 'timeout' | undefined;
  /** Close the stderr log file handle. */
  closeLog(): void;
  /** The retained stderr tail (capped). Used as a JobResult.error fallback. */
  stderrTail(): string;
}

const STDERR_CAPTURE_LIMIT = 256 * 1024; // 256 KB retained in memory for JobResult
const STDERR_LOG_LIMIT = 4 * 1024 * 1024; // 4 MB retained on disk

/**
 * Spawn a child with piped stdio and wire up the lifecycle.
 *
 * REJECTS only when the process cannot be started at all (ENOENT, bad cwd).
 * After this returns, every outcome — including immediate crash — is delivered
 * through `exited`.
 */
export function spawnWorker(opts: SpawnWorkerOptions): Promise<WorkerProcess> {
  const logStream: WriteStream = createWriteStream(path.join(opts.stateDir, 'stderr.log'), { flags: 'w' });
  // A full disk or removed state directory must not turn a worker into an
  // unhandled stream error. stderr is still retained in memory for its result.
  logStream.on('error', () => {});
  const state = {
    captured: '',
    logged: 0,
  };

  const handle = spawn(opts.binary, opts.argv, {
    cwd: opts.cwd,
    // RULE 1 + 2: never a TTY, never a PTY. stdin is ignored so CLIs that sniff
    // for a pipe (codex) do not block on it.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...opts.env },
    // Give each worker its own process group so cancellation reaches shell/tool
    // descendants too. We only wait for the CLI process itself; the group is
    // signalled as a unit on timeout or cancellation.
    detached: process.platform !== 'win32',
  });

  let killReason: 'cancelled' | 'timeout' | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  const killGraceMs = Math.max(0, opts.killGraceMs ?? 5_000);

  function signalTree(signal: NodeJS.Signals): void {
    const pid = handle.pid;
    if (pid === undefined) return;
    try {
      if (process.platform === 'win32') process.kill(pid, signal);
      else process.kill(-pid, signal);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && code !== 'EPERM') throw err;
    }
  }

  // RULE 4: polite first, then escalate. SIGTERM gives the CLI a chance to flush
  // its result file, which matters for the agy-staff readers in harness/.
  // Some CLIs ignore SIGTERM while a tool call is in flight, hence the SIGKILL.
  function terminate(reason: 'cancelled' | 'timeout'): void {
    if (killReason !== undefined) return; // idempotent; first reason wins
    killReason = reason;
    proc.killReason = reason;
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    signalTree('SIGTERM');
    killTimer = setTimeout(() => {
      killTimer = undefined;
      signalTree('SIGKILL');
    }, killGraceMs);
    // Cleanup must keep the supervisor alive even when only detached-stdio
    // descendants remain. An unref'ed timer would silently abandon SIGKILL.
  }

  const proc: WorkerProcess = {
    child: handle,
    exited: Promise.resolve({ code: null, signal: null }),
    terminate,
    killReason: undefined,
    closeLog: () => {
      logStream.end();
    },
    stderrTail: () => state.captured,
  };

  if (opts.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => proc.terminate('timeout'), opts.timeoutMs);
    // Do not hold the event loop open on our account.
    timeoutTimer.unref?.();
  }

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
        // Once the leader is gone there is nothing left to flush. Stop any
        // surviving tools before acknowledging the terminal cancellation.
        if (killReason !== undefined) signalTree('SIGKILL');
      }
      resolve({ code, signal });
    };
    handle.on('error', (err: NodeJS.ErrnoException) => {
      // 'error' fires for spawn failures AND for kill failures. ENOENT here
      // means the binary vanished between `which` and spawn.
      opts.onStderr(`spawn error: ${err.message}\n`);
      finish(null, null);
    });
    handle.on('close', (code, signal) => finish(code, signal));
  });
  proc.exited = exited;

  // ---- stdout: NDJSON line pump ------------------------------------------------
  const rl = readline.createInterface({ input: handle.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim() !== '') opts.onStdoutLine(line);
  });
  // readline holds the stream open; closing it frees the fd promptly.
  handle.stdout.on('close', () => rl.close());

  // ---- stderr: bounded capture + log ------------------------------------------
  handle.stderr.setEncoding('utf8');
  handle.stderr.on('data', (chunk: string) => {
    if (state.logged < STDERR_LOG_LIMIT) {
      const room = STDERR_LOG_LIMIT - state.logged;
      const slice = chunk.slice(0, room);
      state.logged += slice.length;
      logStream.write(slice);
    }
    if (state.captured.length < STDERR_CAPTURE_LIMIT) {
      state.captured = (state.captured + chunk).slice(0, STDERR_CAPTURE_LIMIT);
    }
    opts.onStderr(chunk);
  });

  return Promise.resolve(proc);
}

/** The retained stderr tail for a worker process. See WorkerProcess.stderrTail. */
export function stderrTailOf(proc: WorkerProcess): string {
  return proc.stderrTail();
}

/** Generate a job id when the caller did not supply one. */
export function newJobId(): string {
  return randomUUID();
}

/** Append one normalized event to <stateDir>/events.jsonl. Fire-and-forget. */
export function appendEventLog(stateDir: string, event: unknown): void {
  try {
    writeFileSync(path.join(stateDir, 'events.jsonl'), `${JSON.stringify(event)}\n`, { flag: 'a' });
  } catch {
    // The event log is a convenience for harness/tail consumers. Never let it
    // fail a worker that is otherwise running fine.
  }
}

/** Write <stateDir>/result.json once, at job completion. */
export function writeResultFile(stateDir: string, result: unknown): void {
  try {
    writeFileSync(path.join(stateDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  } catch {
    /* see appendEventLog */
  }
}
