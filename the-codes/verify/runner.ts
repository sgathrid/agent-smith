/**
 * verify/runner.ts — run checks against the working tree, return a boolean.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE ORCHESTRATOR CONSUMES A VERDICT AND NOT PROSE
 *
 * The evidence: a real agy job reported "All tests pass with zero warnings"
 * while its own log tail showed `cargo test` exiting CODE 1 — twice. The job did
 * not lie maliciously; it summarized, the summary was fluent, and it was wrong
 * about a fact present in its own transcript. Alongside that, external checklist
 * 10/10 vs generic self-check 5/10 (p=0.0325), and self-assessment losing half its
 * runs with self-correction-by-prompting established as ineffective (TACL 2024).
 *
 * If the gate asked an LLM to read the test output and tell it whether things
 * worked, it would be re-implementing the exact step that produced the bad
 * summary, with the same failure mode: silent, fluent, wrong. An exit code has
 * no room for that. So this module's contract is deliberately narrow —
 *
 *     run a command in the working tree → return passed: boolean + evidence
 *
 * and the evidence is BOUNDED, because an unbounded log handed to a model is an
 * invitation to summarise it, which is the thing that fails. 8KB per stream,
 * same bound agy-staff uses, for the same reason.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY WE KILL THE PROCESS GROUP, NOT THE PID
 *
 * A check is not one process. `cargo test` builds, then runs a test binary;
 * `npm test` forks a runner that forks workers; `tsc` is fine but a lint rule
 * that shells out is not. Those grandchildren are real processes holding file
 * handles, CPU and — critically — write access to the working tree.
 *
 * `kill(pid)` reaps the shell we spawned and *orphans* everything below it. The
 * parent exits, our verdict resolves "failed/timed out", the pipeline moves on —
 * and a surviving grandchild keeps writing files into the tree we just declared
 * broken. That is not a resource leak, it is a correctness bug: the state the
 * next stage reads is being mutated by a process we believe is gone.
 *
 * So: `spawn(..., { detached: true })` makes the child a process-GROUP leader,
 * and cleanup signals the negative pid (`-pid`), which reaches every descendant
 * in the group. Order is SIGTERM, then SIGKILL after a grace period, because a
 * build step that catches SIGTERM still gets to clean up its own temp files while
 * the SIGKILL guarantees we never leave an orphan no matter what the child does.
 *
 * We also `unref` nothing and we always clear our timers, so the gate itself
 * cannot become the thing that keeps the process alive.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Check, CheckObservation, CheckReport, Expectation, Verdict } from './types.ts';

/** Default cap per stream. Matches agy-staff's bound. */
export const DEFAULT_TAIL_BYTES = 8 * 1024;

/** Grace between SIGTERM and SIGKILL when a check times out. */
export const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * A bounded ring of the most recent bytes.
 *
 * WHY TAIL AND NOT HEAD: the failure is at the end. A head-truncated compiler
 * log shows you the invocation and drops the actual error. Ring keeps the tail,
 * which is the part a human needs to see the exact failing line.
 *
 * Bytes, not characters: a multi-byte char split by the cutoff must not produce a
 * replacement character in a log someone is about to paste into an issue.
 */
class TailBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private dropped = 0;
  // Explicit field, not a constructor parameter property: `erasableSyntaxOnly` is
  // on in this project, so nothing here may require code generation.
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    this.trim();
  }

  private trim(): void {
    // Drop whole leading chunks while we are over budget and can afford to.
    while (this.bytes > this.limit) {
      const first = this.chunks[0];
      if (first === undefined) break;
      // Never remove the only chunk: a single chunk larger than the limit is
      // sliced instead, so `bytes` always reflects something we actually hold.
      if (this.chunks.length === 1) {
        const excess = first.length - this.limit;
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
        this.dropped += excess;
        break;
      }
      this.chunks.shift();
      this.bytes -= first.length;
      this.dropped += first.length;
    }
  }

  get truncated(): boolean {
    return this.dropped > 0;
  }

  text(): string {
    const buf = Buffer.concat(this.chunks);
    // Splitting a UTF-8 sequence mid-character would emit U+FFFD. Drop the
    // partial tail instead.
    const safe = buf.length > 0 && (buf[buf.length - 1] ?? 0) > 0x7f ? trimPartialUtf8(buf) : buf;
    const body = safe.toString('utf8');
    return this.dropped > 0 ? `[...${this.dropped} earlier bytes omitted...]\n${body}` : body;
  }
}

/** Remove an incomplete trailing UTF-8 sequence, if there is one. */
function trimPartialUtf8(buf: Buffer): Buffer {
  let end = buf.length;
  // Walk back at most 3 bytes looking for a lead byte.
  for (let back = 1; back <= 3 && end - back > 0; back++) {
    const b = buf[end - back];
    if (b === undefined) continue;
    if ((b & 0xc0) === 0x80) continue; // continuation byte
    const need = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
    return end - back + need <= end ? buf.subarray(0, end - back + need) : buf;
  }
  return buf;
}

function describeExpectation(expect: Expectation | undefined): string {
  if (!expect || expect.kind === 'exit0') return 'exit code 0';
  if (expect.kind === 'exitN') return `exit code in {${expect.codes.join(', ')}}`;
  return expect.describe;
}

function evaluate(expect: Expectation | undefined, observation: CheckObservation): boolean {
  if (!expect || expect.kind === 'exit0') return observation.exitCode === 0;
  if (expect.kind === 'exitN') {
    return observation.exitCode !== null && expect.codes.includes(observation.exitCode);
  }
  return expect.test(observation);
}

/**
 * Signal a whole process group, tolerating the process already being gone.
 *
 * `kill(-pid, sig)` is the group form. It throws ESRCH when the group is empty,
 * which is the normal case when the check finished on its own just as we timed
 * it out — that is success, not an error.
 */
function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || !Number.isFinite(pid)) return;
  try {
    if (process.platform === 'win32') {
      // Windows has no process groups in this sense; spawn without detached so
      // the child is killable directly.
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return; // already gone — the outcome we wanted
    if (code === 'EPERM') return; // not ours; nothing more we can do
    throw err;
  }
}

export interface RunCheckOptions {
  /** Override the env (merged over process.env). */
  env?: Readonly<Record<string, string>> | undefined;
  /** Injected clock for durationMs, so tests do not depend on wall time. */
  now?: (() => number) | undefined;
  /** SIGTERM → SIGKILL grace on timeout. */
  killGraceMs?: number | undefined;
  /** Abort signal that triggers the same group kill as a timeout. */
  signal?: AbortSignal | undefined;
}

/**
 * Run ONE check. Resolves with a Verdict; never rejects.
 *
 * Rejecting would push error handling into the caller for a class of failure we
 * can describe precisely. A check that could not run is a failed check, with a
 * `skipped` reason and a reason string.
 */
export function runCheck(check: Check, options: RunCheckOptions = {}): Promise<Verdict> {
  const now = options.now ?? Date.now;
  const tailBytes = check.maxTailBytes ?? DEFAULT_TAIL_BYTES;
  const killGrace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const startedAt = now();

  const skip = (reason: Verdict['skipped'], why: string, blocking = check.blocking !== false): Verdict => ({
    passed: false,
    check,
    exitCode: null,
    signal: null,
    timedOut: false,
    stdoutTail: '',
    stderrTail: '',
    truncated: false,
    durationMs: now() - startedAt,
    skipped: reason,
    reason: why,
    // 'not-configured' is ABSENT, not broken: it must be visible in the report
    // but must not manufacture a failure no rerun could ever fix. The other two
    // reasons are real problems and do block.
    blocking: blocking && reason !== 'not-configured',
  });

  // Pre-flight: a missing working directory is the single most common config
  // error, and `spawn` would report it as a generic ENOENT on the *shell*.
  if (check.command.trim().length === 0) {
    return Promise.resolve(skip('not-configured', `check '${check.name}' has no command configured`));
  }
  if (!existsSync(check.cwd)) {
    return Promise.resolve(skip('missing-cwd', `check '${check.name}' cwd does not exist: ${check.cwd}`));
  }

  return new Promise<Verdict>((resolve) => {
    const stdout = new TailBuffer(tailBytes);
    const stderr = new TailBuffer(tailBytes);
    let timedOut = false;
    let settled = false;
    let childPid: number | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;

    /**
     * Terminate the group, then guarantee it with SIGKILL.
     * Idempotent: safe to call from the timeout, from abort, and from 'close'.
     */
    const terminate = (): void => {
      if (childPid === undefined) return;
      signalGroup(childPid, 'SIGTERM');
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => signalGroup(childPid, 'SIGKILL'), killGrace);
      // Do not let our own SIGKILL timer hold the event loop open.
      killTimer.unref?.();
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (onAbort && options.signal) options.signal.removeEventListener('abort', onAbort);

      const observation: CheckObservation = {
        check: check.name,
        exitCode,
        signal,
        timedOut,
        stdout: stdout.text(),
        stderr: stderr.text(),
        durationMs: now() - startedAt,
      };
      const passed = evaluate(check.expect, observation);

      let reason: string;
      if (timedOut) {
        reason = `timed out after ${check.timeoutMs}ms (killed process group; expecting ${describeExpectation(check.expect)})`;
      } else if (signal !== null) {
        reason = `killed by SIG${signal} (expecting ${describeExpectation(check.expect)})`;
      } else if (exitCode === 0) {
        reason = `exit 0 (${describeExpectation(check.expect)})`;
      } else {
        reason = `exit ${exitCode ?? 'null'}, expecting ${describeExpectation(check.expect)}`;
      }

      resolve({
        passed,
        check,
        exitCode,
        signal,
        timedOut,
        stdoutTail: observation.stdout,
        stderrTail: observation.stderr,
        truncated: stdout.truncated || stderr.truncated,
        durationMs: observation.durationMs,
        reason,
        blocking: check.blocking !== false,
      });
    };

    const posix = process.platform !== 'win32';
    const [shell, shellArgs] = posix
      ? (['/bin/sh', ['-c', check.command]] as const)
      : (['cmd.exe', ['/d', '/s', '/c', check.command]] as const);

    let child;
    try {
      child = spawn(shell, [...shellArgs], {
        cwd: check.cwd,
        env: { ...process.env, ...(check.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Group leader: enables kill(-pid) for the whole tree. See the header.
        detached: posix,
      });
    } catch (err) {
      resolve(
        skip('spawn-failed', `check '${check.name}' could not start: ${err instanceof Error ? err.message : String(err)}`),
      );
      return;
    }

    childPid = child.pid;

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    // A read error on a pipe must not take the process down; the check still ran.
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    if (check.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, check.timeoutMs);
      timeoutTimer.unref?.();
    }

    if (options.signal) {
      onAbort = () => terminate();
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        resolve(skip('spawn-failed', `shell not found for check '${check.name}'`));
        return;
      }
      // Fall back to a failed verdict rather than throwing: an unreadable pipe
      // or a failed kill is a fact about the check, not an exception for the
      // caller to unwrap.
      resolve(
        skip('spawn-failed', `check '${check.name}' failed to run: ${err.message}`),
      );
    });

    child.on('close', (code, signal) => finish(code, signal));
  });
}

export interface RunChecksOptions extends RunCheckOptions {
  /** Run this many checks at once. Default 4 — checks are usually the slowest part. */
  concurrency?: number | undefined;
  /** Stop dispatching after the first blocking failure. Default false (collect all). */
  failFast?: boolean | undefined;
  /** Called as each check starts and ends, so a caller can say which are running. */
  onCheck?: ((event: { readonly check: Check; readonly state: 'start' | 'end' }) => void) | undefined;
}

/**
 * Run a set of checks and reduce them to one report.
 *
 * Checks are independent by construction, so they run concurrently; a
 * typecheck and a lint pass nothing to each other and waiting for one before
 * starting the other doubles the wall clock of every gate for nothing.
 */
export async function runChecks(
  checks: readonly Check[],
  options: RunChecksOptions = {},
): Promise<CheckReport> {
  const started = (options.now ?? Date.now)();
  const limit = Math.max(1, Math.floor(options.concurrency ?? 4));
  const verdicts: Verdict[] = [];
  let cursor = 0;
  let stop = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stop) return;
      const index = cursor++;
      const check = checks[index];
      if (check === undefined) return;
      try { options.onCheck?.({ check, state: 'start' }); } catch { /* a progress hook must not fail a check */ }
      const verdict = await runCheck(check, options);
      try { options.onCheck?.({ check, state: 'end' }); } catch { /* as above */ }
      verdicts[index] = verdict;
      if (options.failFast && !verdict.passed && verdict.blocking) stop = true;
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, checks.length) }, worker));

  const present = verdicts.filter((v): v is Verdict => v !== undefined);
  // Only blocking failures fail the report. A check the caller explicitly marked
  // non-blocking is reported but does not manufacture a red gate.
  const failing = present.filter((v) => !v.passed && v.blocking);
  return {
    passed: failing.length === 0,
    verdicts: present,
    failing,
    durationMs: (options.now ?? Date.now)() - started,
    incomplete: present.some((v) => v.skipped !== undefined),
  };
}

/**
 * Re-run checks after a worker acted on them.
 *
 * This exists so the caller cannot accidentally keep the OLD verdicts: the whole
 * point of an escalation is that the previous verdict is invalidated, and
 * re-running through one function makes "the verdict belongs to the current tree"
 * a property of the code rather than of the caller's discipline.
 */
export async function recheck(checks: readonly Check[], options: RunChecksOptions = {}): Promise<CheckReport> {
  return runChecks(checks, options);
}
