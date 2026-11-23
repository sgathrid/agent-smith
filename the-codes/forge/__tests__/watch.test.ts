import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { waitForChange, type WatchOutcome } from '../watch.ts';

/**
 * Drain any delayed directory-creation event that macOS FSEvents delivers right after
 * mkdtempSync so subsequent assertions observe only events caused by the test itself.
 */
async function settleDir(dir: string): Promise<WatchOutcome> {
  let outcome: WatchOutcome = 'change';
  for (let i = 0; i < 5; i++) {
    outcome = await waitForChange(dir, 50);
    if (outcome === 'timeout') return outcome;
  }
  return outcome;
}

test('waitForChange wakes on a file change, not on a timer', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'smith-watch-'));
  const target = path.join(dir, 'job.json');
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await settleDir(dir);
    const started = Date.now();
    timer = setTimeout(() => writeFileSync(target, '{}'), 50);
    while (!existsSync(target)) {
      assert.equal(await waitForChange(dir, 10_000), 'change');
    }
    assert.ok(Date.now() - started < 5_000, 'woke well before the timeout');
  } finally {
    if (timer !== null) clearTimeout(timer);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('waitForChange honours non-positive timeout, abort, idle timeout, and missing-dir fallback', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'smith-watch-'));
  try {
    assert.equal(await waitForChange(dir, 0), 'timeout');
    assert.equal(await waitForChange(dir, -10), 'timeout');
    assert.equal(await waitForChange(dir, Number.NaN), 'timeout');

    assert.equal(await settleDir(dir), 'timeout');

    const ac = new AbortController();
    const waiting = waitForChange(dir, 10_000, { signal: ac.signal });
    ac.abort();
    assert.equal(await waiting, 'aborted');
    assert.equal(await waitForChange(dir, 10_000, { signal: ac.signal }), 'aborted');

    assert.equal(await waitForChange(path.join(dir, 'missing'), 10_000, { fallbackMs: 20 }), 'polled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
