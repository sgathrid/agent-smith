import assert from 'node:assert/strict';
import test from 'node:test';

import { runMonitor } from '../monitor.ts';
import type { WatchableJob } from '../policy.ts';

const T0 = Date.parse('2026-10-07T12:00:00.000Z');

function running(): WatchableJob {
  return {
    id: 'job-a', name: 'Codex implementer', role: 'implementer',
    status: 'running', lastEventAt: new Date(T0).toISOString(), finishedAt: null,
    warned: false,
  };
}

function finished(): WatchableJob {
  return {
    ...running(), status: 'succeeded',
    lastEventAt: new Date(T0).toISOString(),
    finishedAt: new Date(T0 + 120_000).toISOString(),
    latestSummary: 'Implemented the retry guard.\nAll focused checks passed.',
    summarySource: 'worker',
  };
}

test('monitor emits one compact milestone after a silent baseline and running polls', async () => {
  const controller = new AbortController();
  const seen: WatchableJob[][] = [[running()], [running()], [finished()], [finished()]];
  const lines: string[] = [];
  let reads = 0;

  await runMonitor({
    cwd: '/repo', intervalMs: 100, signal: controller.signal, now: () => T0 + reads * 5_000,
    read: async () => {
      const jobs = seen[Math.min(reads, seen.length - 1)]!;
      reads++;
      if (reads === seen.length) controller.abort();
      return jobs;
    },
    emit: (line) => { lines.push(line); },
  });

  assert.equal(reads, 4);
  assert.equal(lines.length, 1, 'baseline, in-progress polls, and repeated terminal state stay silent');
  assert.match(lines[0]!, /^Agent Smith: Codex implementer .*completed execution/);
  assert.match(lines[0]!, /Worker output: Implemented the retry guard\. All focused checks passed\./);
  assert.ok(!lines[0]!.includes('\n'), 'each milestone is exactly one output line');
});

test('a terminal backlog present at startup is baseline, not a notification', async () => {
  const controller = new AbortController();
  const lines: string[] = [];
  let reads = 0;
  const old = { ...finished(), id: 'old-job' };

  await runMonitor({
    cwd: '/repo', intervalMs: 100, signal: controller.signal,
    read: async () => {
      reads++;
      if (reads === 3) controller.abort();
      return [old];
    },
    emit: (line) => { lines.push(line); },
  });

  assert.equal(reads, 3);
  assert.deepEqual(lines, []);
});
