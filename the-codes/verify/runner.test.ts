/**
 * runner tests — exit codes, timeouts, process-group kill, bounded tails.
 *
 * The timeout test is the one that matters most. It spawns a check that leaves a
 * grandchild behind, waits for the verdict, and then asserts the grandchild is
 * actually dead. A runner that only signals the shell passes every other test in
 * this file and still orphans a process that keeps writing into the tree we just
 * declared broken.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_TAIL_BYTES,
  recheck,
  runCheck,
  runChecks,
} from './runner.ts';
import type { Check } from './types.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'agent-smith-verify-'));
}

function check(over: Partial<Check> & Pick<Check, 'command'>, cwd: string): Check {
  return {
    name: 'test',
    cwd,
    timeoutMs: 5_000,
    expect: { kind: 'exit0' },
    ...over,
  };
}

test('exit 0 passes', async () => {
  const cwd = scratch();
  try {
    const verdict = await runCheck(check({ command: 'exit 0' }, cwd));
    assert.equal(verdict.passed, true);
    assert.equal(verdict.exitCode, 0);
    assert.equal(verdict.timedOut, false);
    assert.equal(verdict.skipped, undefined);
    assert.match(verdict.reason, /exit 0/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a non-zero exit fails, and carries the code', async () => {
  const cwd = scratch();
  try {
    // The shape of the motivating bug: cargo test exiting 1 twice.
    const verdict = await runCheck(check({ command: 'echo "boom" >&2; exit 1' }, cwd));
    assert.equal(verdict.passed, false);
    assert.equal(verdict.exitCode, 1);
    assert.match(verdict.stderrTail, /boom/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('exitN accepts a listed code and rejects others', async () => {
  const cwd = scratch();
  try {
    const listed = await runCheck(
      check({ command: 'exit 2', expect: { kind: 'exitN', codes: [2, 3] } }, cwd),
    );
    assert.equal(listed.passed, true);

    const unlisted = await runCheck(
      check({ command: 'exit 4', expect: { kind: 'exitN', codes: [2, 3] } }, cwd),
    );
    assert.equal(unlisted.passed, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a custom expectation is evaluated against the raw observation', async () => {
  const cwd = scratch();
  try {
    const verdict = await runCheck(
      check({
        command: 'echo "0 tests passed"; exit 0',
        expect: {
          kind: 'custom',
          describe: 'output must not claim zero tests',
          test: (o) => !/0 tests passed/.test(o.stdout),
        },
      }, cwd),
    );
    // The command succeeded; the predicate is what says it should not have.
    assert.equal(verdict.passed, false);
    assert.equal(verdict.exitCode, 0);
    assert.match(verdict.reason, /must not claim zero tests/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('output tails are bounded and truncation is declared', async () => {
  const cwd = scratch();
  try {
    const verdict = await runCheck(
      check({ command: `i=0; while [ $i -lt 400 ]; do echo "line $i aaaaaaaaaaaaaaaaaaaa"; i=$((i+1)); done` }, cwd),
    );
    assert.equal(verdict.passed, true);
    assert.ok(
      verdict.stdoutTail.length < DEFAULT_TAIL_BYTES + 200,
      `tail must stay bounded, got ${verdict.stdoutTail.length} chars`,
    );
    // The bound must be VISIBLE. A silently truncated log reads as a complete one.
    assert.equal(verdict.truncated, true);
    assert.match(verdict.stdoutTail, /earlier bytes omitted/);
    // Tail, not head: the failure is at the end, so the last line must survive.
    assert.match(verdict.stdoutTail, /line 399/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('a small maxTailBytes is honoured per check', async () => {
  const cwd = scratch();
  try {
    const verdict = await runCheck(
      check({ command: 'i=0; while [ $i -lt 200 ]; do echo "x$i"; i=$((i+1)); done', maxTailBytes: 64 }, cwd),
    );
    assert.equal(verdict.truncated, true);
    assert.ok(verdict.stdoutTail.length < 300);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the check runs in its cwd', async () => {
  const cwd = scratch();
  try {
    writeFileSync(join(cwd, 'marker.txt'), 'here');
    const verdict = await runCheck(check({ command: 'cat marker.txt' }, cwd));
    assert.equal(verdict.passed, true);
    assert.equal(verdict.stdoutTail.trim(), 'here');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/* --------------------------------- timeouts --------------------------------- */

test('a timeout fails the verdict and never hangs the caller', async () => {
  const cwd = scratch();
  try {
    const started = Date.now();
    const verdict = await runCheck(check({ command: 'sleep 30', timeoutMs: 150 }, cwd));
    assert.equal(verdict.passed, false);
    assert.equal(verdict.timedOut, true);
    assert.match(verdict.reason, /timed out after 150ms/);
    assert.match(verdict.reason, /killed process group/);
    assert.ok(Date.now() - started < 5_000, 'must not wait for the child');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the process GROUP is killed, so grandchildren do not survive', async () => {
  const cwd = scratch();
  const pidFile = join(cwd, 'grandchild.pid');
  try {
    // The shell we spawn backgrounds a grandchild, records its pid, then sleeps.
    // Killing only the shell leaves that grandchild running.
    //
    // The grandchild's output is redirected away from our pipes ON PURPOSE. If it
    // inherited them, 'close' would not fire until the grandchild exited, and the
    // orphan would be masked by a 30s wait instead of being detected. Detaching
    // its stdio makes the two failure modes distinguishable: a pid-only kill
    // returns quickly with the grandchild still alive.
    const command = `( sleep 30 ) >/dev/null 2>&1 & echo $! > ${pidFile}; sleep 30`;

    const startedAt = Date.now();
    const verdict = await runCheck(check({ command, timeoutMs: 200 }, cwd));
    const elapsed = Date.now() - startedAt;

    assert.equal(verdict.timedOut, true);
    assert.ok(elapsed < 5_000, `verdict must resolve promptly, took ${elapsed}ms`);

    assert.ok(existsSync(pidFile), 'grandchild should have started and recorded its pid');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isInteger(pid) && pid > 0);

    // SIGTERM goes to the shell; the SIGKILL escalation follows. Give the group a
    // moment to be reaped before asserting.
    let alive = true;
    for (let i = 0; i < 60 && alive; i++) {
      alive = isAlive(pid);
      if (alive) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(alive, false, `grandchild pid ${pid} survived: the group was not killed`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function isAlive(pid: number): boolean {
  try {
    // Signal 0 is the existence probe: no delivery, no effect.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is not ours.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

test('an abort signal terminates the check', async () => {
  const cwd = scratch();
  const controller = new AbortController();
  try {
    const promise = runCheck(check({ command: 'sleep 30', timeoutMs: 0 }, cwd), {
      signal: controller.signal,
      killGraceMs: 100,
    });
    setTimeout(() => controller.abort(), 100);
    const verdict = await promise;
    assert.equal(verdict.passed, false);
    assert.match(verdict.reason, /killed by SIG|killed process group|timed out/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/* ------------------------------ failure modes ------------------------------ */

test('a missing cwd is reported, not thrown', async () => {
  const verdict = await runCheck(
    { name: 'ghost', command: 'exit 0', cwd: join(tmpdir(), 'definitely-not-here-9df8a7'), timeoutMs: 1_000 },
  );
  assert.equal(verdict.passed, false);
  assert.equal(verdict.skipped, 'missing-cwd');
  assert.equal(verdict.blocking, true);
});

test('a missing cwd preserves an explicitly non-blocking check', async () => {
  const verdict = await runCheck({
    name: 'optional-ghost', command: 'exit 0', cwd: join(tmpdir(), 'definitely-not-here-optional'),
    timeoutMs: 1_000, blocking: false,
  });
  assert.equal(verdict.skipped, 'missing-cwd');
  assert.equal(verdict.blocking, false);
});

test('an empty command is absent, not a failure to fix', async () => {
  const cwd = scratch();
  try {
    const verdict = await runCheck({ name: 'blank', command: '   ', cwd, timeoutMs: 1_000 });
    assert.equal(verdict.passed, false);
    assert.equal(verdict.skipped, 'not-configured');
    // Non-blocking: a check nobody configured must not manufacture a red gate
    // that no worker rerun could ever fix.
    assert.equal(verdict.blocking, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/* --------------------------------- runChecks --------------------------------- */

test('runChecks reduces to a report and lists only blocking failures', async () => {
  const cwd = scratch();
  try {
    const report = await runChecks([
      check({ name: 'typecheck', command: 'exit 0' }, cwd),
      check({ name: 'test', command: 'exit 1' }, cwd),
      check({ name: 'advisory', command: 'exit 1', blocking: false }, cwd),
    ]);
    assert.equal(report.passed, false);
    assert.deepEqual(report.failing.map((v) => v.check.name), ['test']);
    // The advisory failure is still VISIBLE — reported, just not blocking.
    assert.equal(report.verdicts.filter((v) => !v.passed).length, 2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('all passing checks produce a clean report', async () => {
  const cwd = scratch();
  try {
    const report = await runChecks([
      check({ name: 'a', command: 'exit 0' }, cwd),
      check({ name: 'b', command: 'exit 0' }, cwd),
    ]);
    assert.equal(report.passed, true);
    assert.equal(report.incomplete, false);
    assert.deepEqual(report.failing, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('unrunnable checks mark the report incomplete', async () => {
  const cwd = scratch();
  try {
    const report = await runChecks([
      check({ name: 'ok', command: 'exit 0' }, cwd),
      check({ name: 'ghost', command: 'exit 0', cwd: join(cwd, 'nope') }, cwd),
    ]);
    assert.equal(report.incomplete, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('checks run concurrently', async () => {
  const cwd = scratch();
  try {
    const started = Date.now();
    // 4 x 400ms serially would be ~1.6s; concurrently it is ~400ms.
    await runChecks(
      Array.from({ length: 4 }, (_, i) =>
        check({ name: `s${i}`, command: 'sleep 0.4', timeoutMs: 5_000 }, cwd),
      ),
      { concurrency: 4 },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_200, `expected concurrent execution, took ${elapsed}ms`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('recheck runs the checks again rather than reusing verdicts', async () => {
  const cwd = scratch();
  try {
    const marker = join(cwd, 'fixed');
    const checks = [check({ name: 'test', command: `test -f ${marker}` }, cwd)];
    assert.equal((await recheck(checks)).passed, false);
    // The worker "fixes" it; the next verification must see the new tree.
    writeFileSync(marker, 'ok');
    assert.equal((await recheck(checks)).passed, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
