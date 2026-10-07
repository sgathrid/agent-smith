/**
 * Bus tests. Small on purpose — the bus has no features left to test beyond
 * subscription lifecycle and dispatch-time unsubscribe safety.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../bus.ts';
import type { Job } from '../types.ts';

const job: Job = {
  id: 'j1',
  title: 't',
  provider: 'agy',
  status: 'running',
  startedAt: '2026-03-01T10:00:00.000Z',
  updatedAt: '2026-03-01T10:00:00.000Z',
  lastEventAt: '2026-03-01T10:00:00.000Z',
};

describe('EventBus', () => {
  test('delivers a payload to every subscriber', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe('job.upserted', (j) => seen.push(j.id));
    bus.subscribe('job.upserted', (j) => seen.push(j.id));

    assert.equal(bus.publish('job.upserted', job), 2);
    assert.deepEqual(seen, ['j1', 'j1']);
  });

  test('publishing with no subscribers is a no-op returning 0', () => {
    const bus = new EventBus();
    assert.equal(bus.publish('pruned', { jobs: 0, events: 0 }), 0);
  });

  test('unsubscribe stops delivery and is idempotent', () => {
    const bus = new EventBus();
    let count = 0;
    const off = bus.subscribe('event.appended', () => count++);

    bus.publish('event.appended', {
      jobId: 'j1',
      at: '2026-03-01T10:00:00.000Z',
      kind: 'note',
      message: 'x',
    });
    off();
    off();
    bus.publish('event.appended', {
      jobId: 'j1',
      at: '2026-03-01T10:00:00.000Z',
      kind: 'note',
      message: 'x',
    });

    assert.equal(count, 1);
    assert.equal(bus.listenerCount('event.appended'), 0);
  });

  test('topics are independent', () => {
    const bus = new EventBus();
    let upserts = 0;
    let prunes = 0;
    bus.subscribe('job.upserted', () => upserts++);
    bus.subscribe('pruned', () => prunes++);

    bus.publish('job.upserted', job);
    assert.equal(upserts, 1);
    assert.equal(prunes, 0);
  });

  test('a listener may unsubscribe a sibling mid-dispatch without skipping it', () => {
    // Very common when a surface tears down a row in response to the event that
    // removed it. Iterating the live Set would skip the second listener.
    const bus = new EventBus();
    const seen: string[] = [];
    // Registered first so it removes `second` before `second` would be reached.
    // Iterating the live Set here would skip it; iterating a copy delivers it.
    let offSecond = (): void => {};
    offSecond = bus.subscribe('job.deleted', () => seen.push('second'));
    bus.subscribe('job.deleted', () => {
      seen.push('first');
      offSecond();
    });

    bus.publish('job.deleted', { id: 'j1' });
    assert.deepEqual(seen, ['second', 'first']);
  });

  test('subscribers fire in registration order', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.subscribe('pruned', () => seen.push(1));
    bus.subscribe('pruned', () => seen.push(2));
    bus.subscribe('pruned', () => seen.push(3));

    bus.publish('pruned', { jobs: 1, events: 2 });
    assert.deepEqual(seen, [1, 2, 3]);
  });

  test('clear drops every subscriber', () => {
    const bus = new EventBus();
    bus.subscribe('pruned', () => {});
    bus.subscribe('job.deleted', () => {});
    bus.clear();
    assert.equal(bus.listenerCount('pruned'), 0);
    assert.equal(bus.listenerCount('job.deleted'), 0);
  });
});