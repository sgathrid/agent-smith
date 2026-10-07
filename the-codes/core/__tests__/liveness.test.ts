/**
 * Liveness tests.
 *
 * Boundaries are tested explicitly and `now` is always injected — the point of
 * making these functions pure is that the exact-threshold case is testable at
 * all.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DEAD_MS,
  DEFAULT_GRACE_MS,
  DEFAULT_REPEAT_THRESHOLD,
  assessJob,
  detectToolLoop,
  evaluateLiveness,
  hashToolInput,
  silenceMs,
} from '../liveness.ts';
import type { Job, JobEvent, JobStatus } from '../types.ts';

const NOW = Date.parse('2026-03-05T12:00:00.000Z');

/** A job whose last progress was `msAgo` milliseconds before NOW. */
function jobAt(msAgo: number, status: JobStatus = 'running'): Pick<Job, 'status' | 'lastEventAt'> {
  return {
    status,
    lastEventAt: new Date(NOW - msAgo).toISOString(),
  };
}

describe('silenceMs', () => {
  test('measures elapsed time from an ISO timestamp', () => {
    assert.equal(silenceMs('2026-03-05T11:00:00.000Z', NOW), 60 * 60 * 1000);
  });

  test('accepts a Date and an epoch number for now', () => {
    const at = new Date(NOW - 5000).toISOString();
    assert.equal(silenceMs(at, new Date(NOW)), 5000);
    assert.equal(silenceMs(at, NOW), 5000);
    assert.equal(silenceMs(at, '2026-03-05T12:00:00.000Z'), 5000);
  });

  test('an unparseable timestamp is maximally stale, never fresh', () => {
    // "We do not know" must never read as healthy.
    assert.equal(silenceMs('not-a-timestamp', NOW), Number.POSITIVE_INFINITY);
    assert.equal(evaluateLiveness({ status: 'running', lastEventAt: 'garbage' }, NOW), 'dead');
  });
});

describe('evaluateLiveness', () => {
  test('recent activity is alive', () => {
    assert.equal(evaluateLiveness(jobAt(0), NOW), 'alive');
    assert.equal(evaluateLiveness(jobAt(DEFAULT_GRACE_MS - 1), NOW), 'alive');
  });

  test('exactly at the grace boundary is still alive', () => {
    // Boundary is exclusive on the stalled side: "more than grace" is stalled.
    // Choosing inclusive-alive buys a whole grace period of slack for a worker
    // that is exactly on time, which is the cheaper error to make.
    assert.equal(evaluateLiveness(jobAt(DEFAULT_GRACE_MS), NOW), 'alive');
    assert.equal(evaluateLiveness(jobAt(DEFAULT_GRACE_MS + 1), NOW), 'stalled');
  });

  test('exactly at the dead boundary is still stalled', () => {
    assert.equal(evaluateLiveness(jobAt(DEFAULT_DEAD_MS), NOW), 'stalled');
    assert.equal(evaluateLiveness(jobAt(DEFAULT_DEAD_MS + 1), NOW), 'dead');
  });

  test('custom grace and dead windows are honoured', () => {
    const opts = { graceMs: 1000, deadMs: 5000 };
    assert.equal(evaluateLiveness(jobAt(1000), NOW, opts), 'alive');
    assert.equal(evaluateLiveness(jobAt(1001), NOW, opts), 'stalled');
    assert.equal(evaluateLiveness(jobAt(5000), NOW, opts), 'stalled');
    assert.equal(evaluateLiveness(jobAt(5001), NOW, opts), 'dead');
  });

  test('every terminal status reports done, however long ago', () => {
    // This is what keeps the job list from filling with red entries for work
    // that finished successfully hours ago.
    for (const status of ['done', 'failed', 'cancelled'] as const) {
      assert.equal(evaluateLiveness(jobAt(DEFAULT_DEAD_MS * 100, status), NOW), 'done');
    }
  });

  test('an attention status reports attention', () => {
    assert.equal(evaluateLiveness(jobAt(0, 'attention'), NOW), 'attention');
  });

  test('honorAttention=false lets the clock decide instead', () => {
    assert.equal(evaluateLiveness(jobAt(0, 'attention'), NOW, { honorAttention: false }), 'alive');
  });

  test('unknown is evaluated, not assumed healthy or dead', () => {
    // A worker we cannot read may still be running, so keep evaluating it.
    assert.equal(evaluateLiveness(jobAt(0, 'unknown'), NOW), 'alive');
    assert.equal(evaluateLiveness(jobAt(DEFAULT_DEAD_MS + 1, 'unknown'), NOW), 'dead');
  });
});

describe('detectToolLoop', () => {
  /** A tool_call event, oldest-first ordering preserved. */
  function call(tool: string, inputHash: string | null, minute: number): JobEvent {
    // Minutes count up with recency: minute 0 is oldest, minute 9 is `NOW`.
    return {
      jobId: 'j',
      at: new Date(NOW - (9 - minute) * 60 * 1000).toISOString(),
      kind: 'tool_call',
      message: tool,
      tool,
      toolInputHash: inputHash,
    };
  }

  test('two identical consecutive calls are a loop', () => {
    const loop = detectToolLoop([call('grep', 'h1', 0), call('grep', 'h1', 1)]);
    assert.ok(loop);
    assert.equal(loop.tool, 'grep');
    assert.equal(loop.count, 2);
    assert.equal(loop.inputHash, 'h1');
  });

  test('a single repeated call is not a loop', () => {
    // One repeat is normal recovery — a flaky test, a re-read after an edit.
    assert.equal(detectToolLoop([call('grep', 'h1', 0)]), null);
  });

  test('different inputs are not a loop', () => {
    assert.equal(detectToolLoop([call('grep', 'h1', 0), call('grep', 'h2', 1)]), null);
  });

  test('different tools are not a loop', () => {
    assert.equal(detectToolLoop([call('grep', 'h1', 0), call('edit', 'h1', 1)]), null);
  });

  test('only consecutive calls count', () => {
    // The run ended, so nothing older can extend it — this is the case that a
    // naive "count occurrences" implementation gets wrong.
    assert.equal(
      detectToolLoop([call('grep', 'h1', 0), call('edit', 'h2', 1), call('grep', 'h1', 2)]),
      null,
    );
  });

  test('counts the full run and reports the newest timestamp', () => {
    const loop = detectToolLoop([
      call('bash', 'h1', 0),
      call('bash', 'h1', 1),
      call('bash', 'h1', 2),
      call('bash', 'h1', 3),
    ]);
    assert.ok(loop);
    assert.equal(loop.count, 4);
    assert.equal(loop.lastAt, call('bash', 'h1', 3).at);
  });

  test('honours a raised threshold', () => {
    const twice = [call('bash', 'h1', 0), call('bash', 'h1', 1)];
    assert.ok(detectToolLoop(twice), 'two repeats reach the default threshold of 2');
    assert.equal(detectToolLoop(twice, { threshold: 3 }), null, 'but not a threshold of 3');

    const thrice = [...twice, call('bash', 'h1', 2)];
    assert.equal(detectToolLoop(thrice, { threshold: 3 })?.count, 3);
  });

  test('throws on a threshold below 2 rather than always reporting a loop', () => {
    assert.throws(() => detectToolLoop([call('grep', 'h1', 0)], { threshold: 1 }), RangeError);
  });

  test('unhashed calls of the same tool still count as a loop', () => {
    // Providers that do not hash inputs must not silently disable the rule.
    const loop = detectToolLoop([call('grep', null, 0), call('grep', null, 1)]);
    assert.equal(loop?.count, 2);
    assert.equal(loop?.inputHash, null);
  });

  test('non-tool events are ignored', () => {
    const note: JobEvent = {
      jobId: 'j',
      at: new Date(NOW).toISOString(),
      kind: 'message',
      message: 'thinking',
      tool: 'grep',
      toolInputHash: 'h1',
    };
    assert.equal(detectToolLoop([call('grep', 'h1', 0), note]), null);
  });

  test('a widened kinds list can include messages', () => {
    const events: JobEvent[] = [
      {
        jobId: 'j',
        at: new Date(NOW - 60_000).toISOString(),
        kind: 'message',
        message: 'I will check the tests',
        tool: 'x',
        toolInputHash: 'h1',
      },
      {
        jobId: 'j',
        at: new Date(NOW).toISOString(),
        kind: 'message',
        message: 'I will check the tests',
        tool: 'x',
        toolInputHash: 'h1',
      },
    ];
    assert.equal(detectToolLoop(events), null);
    assert.equal(detectToolLoop(events, { kinds: ['message'] })?.count, 2);
  });

  test('an empty history has no loop', () => {
    assert.equal(detectToolLoop([]), null);
  });
});

describe('hashToolInput', () => {
  test('is stable for equal inputs', () => {
    assert.equal(hashToolInput('a'), hashToolInput('a'));
  });

  test('differs for different inputs', () => {
    assert.notEqual(hashToolInput('a'), hashToolInput('b'));
  });

  test('ignores object key order', () => {
    assert.equal(hashToolInput({ a: 1, b: 2 }), hashToolInput({ b: 2, a: 1 }));
  });

  test('does not throw on a circular structure', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    assert.equal(typeof hashToolInput(cyclic), 'string');
  });

  test('does not throw on a BigInt', () => {
    assert.equal(typeof hashToolInput({ n: 1n }), 'string');
  });
});

describe('assessJob', () => {
  const full: Job = {
    id: 'j',
    title: 't',
    provider: 'agy',
    status: 'running',
    startedAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    lastEventAt: new Date(NOW).toISOString(),
  };

  const loopEvents: JobEvent[] = [
    {
      jobId: 'j',
      at: new Date(NOW - 60_000).toISOString(),
      kind: 'tool_call',
      message: 'grep',
      tool: 'grep',
      toolInputHash: 'h1',
    },
    {
      jobId: 'j',
      at: new Date(NOW).toISOString(),
      kind: 'tool_call',
      message: 'grep',
      tool: 'grep',
      toolInputHash: 'h1',
    },
  ];

  test('a healthy live job reports alive and no loop', () => {
    assert.deepEqual(assessJob(full, [], NOW), { liveness: 'alive', loop: null });
  });

  test('a live job looping escalates to attention', () => {
    // Alive but going in circles: waiting does not help it, it needs eyes.
    assert.equal(assessJob(full, loopEvents, NOW).liveness, 'attention');
    assert.ok(assessJob(full, loopEvents, NOW).loop);
  });

  test('a stalled job escalates to attention when it is also looping', () => {
    const stalled: Job = { ...full, lastEventAt: new Date(NOW - DEFAULT_GRACE_MS - 1).toISOString() };
    assert.equal(assessJob(stalled, loopEvents, NOW).liveness, 'attention');
  });

  test('a stalled job without a loop stays stalled', () => {
    const stalled: Job = { ...full, lastEventAt: new Date(NOW - DEFAULT_GRACE_MS - 1).toISOString() };
    assert.deepEqual(assessJob(stalled, [], NOW), { liveness: 'stalled', loop: null });
  });

  test('a dead job is never escalated — it needs restarting, not watching', () => {
    const dead: Job = { ...full, lastEventAt: new Date(NOW - DEFAULT_DEAD_MS - 1).toISOString() };
    assert.deepEqual(assessJob(dead, loopEvents, NOW), { liveness: 'dead', loop: null });
  });

  test('a finished job is done and never escalated', () => {
    const done: Job = { ...full, status: 'done', lastEventAt: new Date(NOW - 10 * DEFAULT_DEAD_MS).toISOString() };
    assert.deepEqual(assessJob(done, loopEvents, NOW), { liveness: 'done', loop: null });
  });

  test('defaults are the documented ones', () => {
    assert.equal(DEFAULT_REPEAT_THRESHOLD, 2);
    assert.equal(DEFAULT_DEAD_MS, 4 * DEFAULT_GRACE_MS);
  });
});