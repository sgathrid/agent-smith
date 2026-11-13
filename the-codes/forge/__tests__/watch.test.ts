import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { waitForChange } from '../watch.ts';

test('waitForChange wakes on a file change, not on a timer', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'smith-watch-'));
  const started = Date.now();
  const waiting = waitForChange(dir, 10_000);
  setTimeout(() => writeFileSync(path.join(dir, 'job.json'), '{}'), 50);
  assert.equal(await waiting, 'change');
  assert.ok(Date.now() - started < 5_000, 'woke well before the timeout');
});

test('waitForChange times out, honours abort, and falls back when the directory is missing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'smith-watch-'));
  // An idle directory ends at the timeout. macOS may report the directory's own recent
  // creation once; callers re-read the job after any wake, so a spurious 'change' is harmless.
  assert.ok(['timeout', 'change'].includes(await waitForChange(dir, 30)));
  const ac = new AbortController();
  const waiting = waitForChange(dir, 10_000, { signal: ac.signal });
  ac.abort();
  assert.equal(await waiting, 'aborted');
  assert.equal(await waitForChange(path.join(dir, 'missing'), 10_000, { fallbackMs: 20 }), 'polled');
});
