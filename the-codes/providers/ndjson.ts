import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import type { JobResult, JobStatus, ProviderEvent, SpawnSpec, WorkerHandle } from './types.ts';
import { recoveredErrorText, timedOutText } from './failure-text.ts';

type ProbeCacheEntry = { ok: true; found: boolean } | { ok: false; error: unknown };
const pathProbeCache = new Map<string, ProbeCacheEntry>();

async function probeExecutable(target: string): Promise<boolean> {
  try {
    await access(target, constants.X_OK);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    if (code === 'EACCES') {
      try {
        await access(target, constants.F_OK);
        return false;
      } catch (fErr) {
        const fCode = (fErr as NodeJS.ErrnoException).code;
        if (fCode === 'ENOENT' || fCode === 'ENOTDIR') return false;
        throw fErr;
      }
    }
    throw err;
  }
}

export async function binaryOnPath(bin: string): Promise<boolean> {
  const pathEnv = process.env['PATH'] ?? '';
  const cacheKey = `${bin}|${pathEnv}`;
  const cached = pathProbeCache.get(cacheKey);
  if (cached !== undefined) {
    if (!cached.ok) throw cached.error;
    return cached.found;
  }

  try {
    if (bin.includes('/') || bin.includes(path.sep)) {
      const direct = await probeExecutable(bin);
      pathProbeCache.set(cacheKey, { ok: true, found: direct });
      return direct;
    }

    const dirs = pathEnv.split(path.delimiter).filter((d) => d !== '');
    let found = false;
    let probeError: unknown;
    for (const dir of dirs) {
      const full = path.join(dir, bin);
      try {
        if (await probeExecutable(full)) {
          found = true;
          break;
        }
      } catch (err) {
        probeError ??= err;
      }
    }
    if (!found && probeError !== undefined) throw probeError;
    pathProbeCache.set(cacheKey, { ok: true, found });
    return found;
  } catch (err) {
    pathProbeCache.set(cacheKey, { ok: false, error: err });
    throw err;
  }
}

function stateRoot(): string {
  return process.env['AGENT_SMITH_STATE_DIR'] ?? path.join(os.homedir(), '.agent-smith', 'state');
}

export function writeStateDir(provider: string, jobId: string, override?: string): string {
  const dir = override ?? path.join(stateRoot(), provider, jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeArgv(dir: string, argv: string[], cwd: string): void {
  writeFileSync(path.join(dir, 'argv.json'), JSON.stringify({ argv, cwd }, null, 2));
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}…`, truncated: true };
}

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

export function str(o: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = o?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function obj(o: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const v = o?.[key];
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

export function num(o: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = o?.[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function nowIso(at = Date.now()): string {
  return new Date(at).toISOString();
}

export interface EventBus {
  emit(event: ProviderEvent): void;
  onEvent(listener: (event: ProviderEvent) => void): () => void;
  readonly events: AsyncIterable<ProviderEvent>;
  close(): void;
}

export function createEventBus(maxQueue = 4096): EventBus {
  const listeners = new Set<(e: ProviderEvent) => void>();
  const queue: ProviderEvent[] = [];
  let waiting: ((v: IteratorResult<ProviderEvent>) => void) | undefined;
  let done = false;

  function emit(event: ProviderEvent): void {
    for (const l of listeners) {
      try {
        l(event);
      } catch {}
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
      [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
        return {
          next(): Promise<IteratorResult<ProviderEvent>> {
            const q = queue.shift();
            if (q !== undefined) return Promise.resolve({ value: q, done: false });
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise<IteratorResult<ProviderEvent>>((resolve) => {
              waiting = resolve;
            });
          },
          return(): Promise<IteratorResult<ProviderEvent>> {
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

export interface WorkerPumps {
  onStdoutLine(line: string): void;
  onStderr(chunk: string): void;
}

export interface SpawnWorkerOptions extends WorkerPumps {
  provider: string;
  binary: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  killGraceMs?: number;
  terminateSignal?: NodeJS.Signals;
  env?: NodeJS.ProcessEnv;
  stateDir: string;
  jobId: string;
  mode: string;
  onHeartbeat?: (at: string, pid: number | undefined) => void;
  heartbeatMs?: number;
  stdin?: 'ignore' | 'pipe';
}

export const HEARTBEAT_MS = 30_000;

export type PipedChild = ChildProcessByStdio<Writable | null, Readable, Readable>;

export interface WorkerProcess {
  child: PipedChild;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  terminate(reason: 'cancelled' | 'timeout'): void;
  killReason: 'cancelled' | 'timeout' | undefined;
  closeLog(): void;
  stderrTail(): string;
  spawnError: string | undefined;
}

const STDERR_CAPTURE_LIMIT = 256 * 1024;
const STDERR_LOG_LIMIT = 4 * 1024 * 1024;

export function spawnWorker(opts: SpawnWorkerOptions): Promise<WorkerProcess> {
  const logStream: WriteStream = createWriteStream(path.join(opts.stateDir, 'stderr.log'), { flags: 'w' });
  logStream.on('error', () => {});
  const state = {
    captured: '',
    logged: 0,
  };

  const handle = spawn(opts.binary, opts.argv, {
    cwd: opts.cwd,
    // RULE 1 + 2: never a TTY, never a PTY. stdin is ignored so CLIs that sniff
    // for a pipe (codex) do not block on it, unless a LiveInput owns it.
    stdio: [opts.stdin ?? 'ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...opts.env },
    // Give each worker its own process group so cancellation reaches shell/tool
    // descendants too. We only wait for the CLI process itself; the group is
    // signalled as a unit on timeout or cancellation.
    detached: process.platform !== 'win32',
  }) as PipedChild;

  let killReason: 'cancelled' | 'timeout' | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let firstBeat: NodeJS.Timeout | undefined;
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

  const firstSignal: NodeJS.Signals = opts.terminateSignal ?? 'SIGTERM';
  function terminate(reason: 'cancelled' | 'timeout'): void {
    if (killReason !== undefined) return;
    killReason = reason;
    proc.killReason = reason;
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    signalTree(firstSignal);
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
    spawnError: undefined,
  };

  if (opts.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => proc.terminate('timeout'), opts.timeoutMs);
    timeoutTimer.unref?.();
  }

  // Liveness from the process owner. Provider events stop during a long tool
  // call; this does not. The first beat waits one macrotask so the caller has
  // subscribed to the adapter's bus (spawn resolves first).
  //
  // The beat stops when the CLI process EXITS, not when its stdio closes: a
  // descendant that inherited stdout can hold it open long after the worker
  // died, and beats in that window would make a dead pid look alive. Each beat
  // also probes the pid itself and stops if it is gone.
  let leaderExited = false;
  const stopHeartbeat = (): void => {
    leaderExited = true;
    if (firstBeat !== undefined) clearTimeout(firstBeat);
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    firstBeat = undefined;
    heartbeatTimer = undefined;
  };
  handle.on('exit', stopHeartbeat);
  const onHeartbeat = opts.onHeartbeat;
  const pid = handle.pid;
  if (onHeartbeat !== undefined && pid !== undefined) {
    const beat = (): void => {
      if (leaderExited) return;
      try {
        process.kill(pid, 0);
      } catch (err) {
        // EPERM: it exists, we just may not signal it. Anything else: gone.
        if ((err as NodeJS.ErrnoException).code !== 'EPERM') { stopHeartbeat(); return; }
      }
      try { onHeartbeat(nowIso(), pid); } catch {}
    };
    firstBeat = setTimeout(beat, 0);
    firstBeat.unref?.();
    heartbeatTimer = setInterval(beat, Math.max(1, opts.heartbeatMs ?? HEARTBEAT_MS));
    heartbeatTimer.unref?.();
  }

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      stopHeartbeat();
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
        if (killReason !== undefined) signalTree('SIGKILL');
      }
      resolve({ code, signal });
    };
    handle.on('error', (err: NodeJS.ErrnoException) => {
      // 'error' fires for spawn failures AND for kill failures. ENOENT here
      // means the binary vanished between `which` and spawn.
      // No pid means the child never started: that is a spawn failure, not a
      // failed kill.
      const message = `spawn error: ${err.message}`;
      if (handle.pid === undefined) proc.spawnError = message;
      opts.onStderr(`${message}\n`);
      finish(null, null);
    });
    handle.on('close', (code, signal) => finish(code, signal));
  });
  proc.exited = exited;

  const rl = readline.createInterface({ input: handle.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim() !== '') opts.onStdoutLine(line);
  });
  // readline holds the stream open; closing it frees the fd promptly.
  handle.stdout.on('close', () => rl.close());

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

export function newJobId(): string {
  return randomUUID();
}

export function appendEventLog(stateDir: string, event: unknown): void {
  try {
    writeFileSync(path.join(stateDir, 'events.jsonl'), `${JSON.stringify(event)}\n`, { flag: 'a' });
  } catch {}
}

export function writeResultFile(stateDir: string, result: unknown): void {
  try {
    writeFileSync(path.join(stateDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  } catch {}
}

export async function binaryAvailable(binary: string): Promise<boolean> {
  return binaryOnPath(binary);
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  killReason: 'cancelled' | 'timeout' | undefined;
  stderr: string;
  spawnError?: string;
}

export interface Verdict {
  status: JobStatus;
  error: string;
}

export function earlyVerdict(exit: ExitInfo, durationMs: number): Verdict | undefined {
  if (exit.killReason === 'cancelled') return { status: 'cancelled', error: 'canceled' };
  if (exit.killReason === 'timeout') return { status: 'timeout', error: timedOutText(durationMs) };
  if (exit.spawnError !== undefined) return { status: 'spawn-failed', error: exit.spawnError };
  return undefined;
}

export class ErrorRecovery {
  private last: { message: string; at: string; label: string; textAfter: boolean; completed: boolean } | undefined;

  noteError(label: string, message: string, at: string): void {
    this.last = { label, message, at, textAfter: false, completed: false };
  }

  observe(events: readonly ProviderEvent[]): void {
    if (this.last === undefined) return;
    for (const e of events) {
      if (e.kind === 'text' || e.kind === 'activity-start' || e.kind === 'activity-update' || e.kind === 'activity-end') {
        this.invalidateCompletion();
      }
      if (e.kind === 'text' && e.stream !== 'thinking' && e.text.trim() !== '') this.last.textAfter = true;
    }
  }

  invalidateCompletion(): void {
    if (this.last !== undefined) this.last.completed = false;
  }

  noteCompletion(): void {
    if (this.last?.textAfter) this.last.completed = true;
  }

  recovered(finalText: string, exitCode: number | null): { label: string; message: string; at: string } | undefined {
    const l = this.last;
    return l !== undefined && l.textAfter && finalText.trim() !== ''
      && exitCode !== null && (exitCode === 0 || l.completed) ? l : undefined;
  }
}

export function recoveredErrorNotice(
  recovered: { label: string; message: string; at: string } | undefined,
  final: JobResult,
): ProviderEvent | undefined {
  if (recovered === undefined || final.status !== 'success') return undefined;
  return { kind: 'notice', at: final.finishedAt, level: 'warn', message: recoveredErrorText(recovered.label, recovered.message, recovered.at) };
}

export function jobResult(args: {
  provider: string;
  jobId: string;
  status: JobStatus;
  error: string | undefined;
  exit: ExitInfo;
  response: string;
  startedAtMs: number;
  durationMs: number;
  stateDir: string;
}): JobResult {
  const { status, error, exit } = args;
  const out: JobResult = {
    jobId: args.jobId,
    provider: args.provider,
    ok: status === 'success',
    status,
    exitCode: exit.code,
    signal: exit.signal,
    response: args.response,
    durationMs: args.durationMs,
    startedAt: new Date(args.startedAtMs).toISOString(),
    finishedAt: nowIso(),
    stateDir: args.stateDir,
  };
  if (error !== undefined) out.error = error;
  return out;
}

export interface NdjsonWorkerConfig {
  provider: string;
  binary: string;
  spec: SpawnSpec;
  buildArgv(spec: SpawnSpec): string[];
  translate(raw: Record<string, unknown>): ProviderEvent[];
  preamble?: ProviderEvent[];
  intercept?(raw: Record<string, unknown>): boolean;
  stderrLevel?(text: string): 'info' | 'warn' | 'error';
  terminateSignal?: NodeJS.Signals;
  buildResult(ctx: { jobId: string; startedAtMs: number; stateDir: string; exit: ExitInfo }): JobResult;
  afterResult?(result: JobResult): ProviderEvent[];
  input?: LiveInput;
}

export interface LiveInput {
  attach(stdin: Writable | null): void;
  send(text: string): boolean;
  end(): void;
  unread(): string[];
}

export async function runNdjsonWorker(cfg: NdjsonWorkerConfig): Promise<WorkerHandle> {
  const { provider, spec } = cfg;
  const jobId = spec.jobId ?? newJobId();
  const stateDir = writeStateDir(provider, jobId, spec.stateDir);
  const argv = cfg.buildArgv(spec);
  writeArgv(stateDir, argv, spec.cwd);

  const bus = createEventBus();
  const publish = (events: ProviderEvent[]): void => {
    for (const e of events) {
      bus.emit(e);
      appendEventLog(stateDir, e);
    }
  };
  const notice = (level: 'info' | 'warn' | 'error', message: string): void =>
    publish([{ kind: 'notice', at: nowIso(), level, message }]);

  if (cfg.preamble !== undefined) publish(cfg.preamble);

  const startedAtMs = Date.now();
  const proc = await spawnWorker({
    provider,
    binary: cfg.binary,
    argv,
    cwd: spec.cwd,
    timeoutMs: spec.timeoutMs,
    stateDir,
    jobId,
    mode: spec.mode,
    onHeartbeat: (at, pid) => bus.emit({ kind: 'heartbeat', at, ...(pid === undefined ? {} : { pid }) }),
    ...(cfg.terminateSignal !== undefined ? { terminateSignal: cfg.terminateSignal } : {}),
    ...(spec.env !== undefined ? { env: spec.env } : {}),
    ...(cfg.input !== undefined ? { stdin: 'pipe' as const } : {}),
    onStdoutLine(line) {
      const raw = tryParseObject(line);
      if (raw === undefined) {
        notice('warn', `${provider} stdout (non-JSON): ${truncate(line, 400).text}`);
        return;
      }
      if (cfg.intercept?.(raw)) return;
      publish(cfg.translate(raw));
    },
    onStderr(chunk) {
      const text = chunk.trim();
      if (text === '') return;
      notice(cfg.stderrLevel?.(text) ?? 'info', truncate(text, 800).text);
    },
  });

  const input = cfg.input;
  input?.attach(proc.child.stdin);

  let resolveResult: (r: JobResult) => void = () => {};
  const resultPromise = new Promise<JobResult>((resolve) => {
    resolveResult = resolve;
  });

  void proc.exited.then(({ code, signal }) => {
    proc.closeLog();
    const exit: ExitInfo = { code, signal, killReason: proc.killReason, stderr: proc.stderrTail() };
    if (proc.spawnError !== undefined) exit.spawnError = proc.spawnError;
    const final = cfg.buildResult({ jobId, startedAtMs, stateDir, exit });
    if (input !== undefined) {
      input.end();
      const unread = input.unread();
      if (unread.length > 0) final.unreadInput = unread;
    }
    if (cfg.afterResult !== undefined) publish(cfg.afterResult(final));
    bus.close();
    writeResultFile(stateDir, final);
    resolveResult(final);
  });

  return {
    id: jobId,
    stateDir,
    cancel: () => proc.terminate('cancelled'),
    waitForResult: () => resultPromise,
    onEvent: (listener) => bus.onEvent(listener),
    events: bus.events,
    ...(input !== undefined ? { send: (text: string) => input.send(text) } : {}),
  };
}
