/**
 * time.ts — test helper: wait for a condition, never for a duration.
 *
 * A fixed sleep followed by an assertion is a race the test loses on a slower
 * machine: a loaded CI VM, a cold macOS runner, six suites sharing one laptop.
 * `waitFor` polls the condition instead, returning as soon as it holds, so a
 * fast machine pays nothing and a slow one gets until the deadline. The
 * deadline only bounds how long a genuinely broken test takes to fail.
 *
 * `scaled(ms)` multiplies a deadline by AGENT_SMITH_TEST_TIME_SCALE (default 1)
 * for runners known to be slow. Use it for every timeout that is a failure
 * bound (subprocess timeouts, probe budgets, waitFor deadlines), never for a
 * duration the code under test is meant to measure.
 */

const SCALE = (() => {
  const n = Number(process.env['AGENT_SMITH_TEST_TIME_SCALE']);
  return Number.isFinite(n) && n > 0 ? n : 1;
})();

/** A failure-bound timeout, stretched on slow runners. */
export function scaled(ms: number): number {
  return Math.round(ms * SCALE);
}

/**
 * Default deadline for waitFor. It is a hang guard, not a wait: a passing test
 * returns the moment its condition holds, so only a broken one ever reaches it.
 * Generous enough for a heavily loaded runner (real child processes, MCP reloads).
 */
export const WAIT_DEADLINE_MS = 60_000;

/**
 * Resolve with the first truthy value `check` returns, polling every `intervalMs`.
 * Rejects with `message` (and the last thrown error, if any) after the scaled deadline.
 */
export async function waitFor<T>(
  check: () => T | Promise<T>,
  { timeoutMs = WAIT_DEADLINE_MS, intervalMs = 10, message = 'condition' }: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + scaled(timeoutMs);
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value as NonNullable<T>;
      lastError = undefined;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      const cause = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(`timed out after ${scaled(timeoutMs)} ms waiting for ${message}${cause}`, { cause: lastError });
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
