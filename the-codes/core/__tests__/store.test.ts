/**
 * Store tests: round-trip fidelity, the progress-clock rule, ordering, pruning.
 *
 * Uses ':memory:' so the suite never touches disk and runs in any order.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JobStore } from '../store.ts';
import { EventBus } from '../bus.ts';
import type { Job, JobEvent } from '../types.ts';

const T0 = '2026-03-01T10:00:00.000Z';
const T1 = '2026-03-01T10:05:00.000Z';

/** A complete Job, so a round-trip test fails loudly on any dropped field. */
function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'agy-001',
    title: 'rework dashboard',
    provider: 'agy',
    status: 'running',
    stage: 'implement',
    cwd: '/Users/gathrid/Repos/agent-smith',
    pid: 4242,
    task: 'rewrite the store',
    startedAt: T0,
    updatedAt: T0,
    lastEventAt: T0,
    endedAt: null,
    activity: { kind: 'writing', label: 'editing src/store.ts', detail: 'patch 1/3' },
    warnings: [
      { code: 'repeated_tool_call', message: 'grep called twice', at: T0, context: { tool: 'grep' } },
    ],
    metrics: { tokens: 1200, cost: 0.03 },
    ...overrides,
  };
}

describe('JobStore', () => {
  test('round-trips every field of a Job', () => {
    const store = new JobStore();
    const original = makeJob();
    store.upsertJob(original);

    const read = store.getJob('agy-001');
    assert.ok(read);
    assert.deepEqual(read, original);
    store.close();
  });

  test('getJob returns null for an unknown id', () => {
    const store = new JobStore();
    assert.equal(store.getJob('nope'), null);
    store.close();
  });

  test('upsert replaces rather than duplicates', () => {
    const store = new JobStore();
    store.upsertJob(makeJob());
    store.upsertJob(makeJob({ title: 'renamed', updatedAt: T1, lastEventAt: T1 }));

    assert.equal(store.listJobs().length, 1);
    assert.equal(store.getJob('agy-001')?.title, 'renamed');
    store.close();
  });

  test('a job with no explicit lastEventAt falls back to updatedAt', () => {
    // The guard against a dead worker looking alive: a reader that re-saves an
    // unchanged job supplies no lastEventAt, and the progress clock must not
    // move on its own.
    const store = new JobStore();
    const job = makeJob();
    delete (job as Partial<Job>).lastEventAt;

    const stored = store.upsertJob(job);
    assert.equal(stored.lastEventAt, T0);
    assert.equal(store.getJob('agy-001')?.lastEventAt, T0);
    store.close();
  });

  test('a terminal status stamps endedAt when the caller omits it', () => {
    const store = new JobStore();
    const job = makeJob({ status: 'done', updatedAt: T1, lastEventAt: T1 });
    delete (job as Partial<Job>).endedAt;

    assert.equal(store.upsertJob(job).endedAt, T1);
    store.close();
  });

  test('round-trips a JobEvent and assigns a monotonic seq', () => {
    const store = new JobStore();
    store.upsertJob(makeJob());

    const first = store.appendEvent({
      jobId: 'agy-001',
      at: T0,
      kind: 'tool_call',
      message: 'read src/store.ts',
      tool: 'read',
      toolInputHash: 'abc12345',
      data: { bytes: 4096 },
    });
    const second = store.appendEvent({
      jobId: 'agy-001',
      at: T1,
      kind: 'message',
      message: 'done reading',
    });

    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.deepEqual(store.recentEvents('agy-001'), [first, second]);
    store.close();
  });

  test('recentEvents returns the newest n, oldest first', () => {
    const store = new JobStore();
    store.upsertJob(makeJob());
    for (let i = 0; i < 5; i++) {
      store.appendEvent({ jobId: 'agy-001', at: T0, kind: 'note', message: `n${i}` });
    }

    const tail = store.recentEvents('agy-001', 2);
    assert.deepEqual(tail.map((e) => e.message), ['n3', 'n4']);
    store.close();
  });

  test('a progress event advances lastEventAt, a status event does not', () => {
    // The single most important store behaviour: the progress clock tracks
    // worker behaviour only.
    const store = new JobStore();
    store.upsertJob(makeJob());
    assert.equal(store.getJob('agy-001')?.lastEventAt, T0);

    store.appendEvent({ jobId: 'agy-001', at: T1, kind: 'status', message: 'still running' });
    assert.equal(store.getJob('agy-001')?.lastEventAt, T0, 'status must not advance the clock');

    store.appendEvent({ jobId: 'agy-001', at: T1, kind: 'tool_call', message: 'grep', tool: 'grep' });
    assert.equal(store.getJob('agy-001')?.lastEventAt, T1, 'tool_call must advance the clock');
    store.close();
  });

  test('an out-of-order event cannot rewind the progress clock', () => {
    // Provider clocks disagree. A late event with an older timestamp must not
    // make a mid-step job look stalled.
    const store = new JobStore();
    store.upsertJob(makeJob({ lastEventAt: T1 }));

    store.appendEvent({ jobId: 'agy-001', at: T0, kind: 'tool_call', message: 'late', tool: 'grep' });
    assert.equal(store.getJob('agy-001')?.lastEventAt, T1);
    store.close();
  });

  test('events are accepted for a job row that does not exist yet', () => {
    // A reader sees a transcript before it can build a Job. Dropping those
    // events would put a hole in the audit trail exactly where diagnosis is
    // hardest.
    const store = new JobStore();
    const event = store.appendEvent({
      jobId: 'ghost',
      at: T0,
      kind: 'message',
      message: 'starting up',
    });
    assert.equal(event.seq, 1);
    assert.deepEqual(store.recentEvents('ghost'), [event]);
    store.close();
  });

  test('listJobs orders by most recent activity', () => {
    const store = new JobStore();
    store.upsertJob(makeJob({ id: 'a', lastEventAt: '2026-03-01T10:00:00.000Z' }));
    store.upsertJob(makeJob({ id: 'b', lastEventAt: '2026-03-01T12:00:00.000Z' }));
    store.upsertJob(makeJob({ id: 'c', lastEventAt: '2026-03-01T11:00:00.000Z' }));

    assert.deepEqual(store.listJobs().map((j) => j.id), ['b', 'c', 'a']);
    store.close();
  });

  test('listJobs filters by status, provider, stage, and activeSince', () => {
    const store = new JobStore();
    store.upsertJob(makeJob({ id: 'a', provider: 'agy', status: 'running' }));
    store.upsertJob(makeJob({ id: 'b', provider: 'codex', status: 'done', stage: 'review', endedAt: T1 }));
    store.upsertJob(
      makeJob({ id: 'c', provider: 'codex', status: 'running', stage: 'review', lastEventAt: T1 }),
    );

    assert.deepEqual(store.listJobs({ provider: 'codex' }).map((j) => j.id).sort(), ['b', 'c']);
    assert.deepEqual(store.listJobs({ status: 'running' }).map((j) => j.id).sort(), ['a', 'c']);
    assert.deepEqual(store.listJobs({ stage: 'review' }).map((j) => j.id).sort(), ['b', 'c']);
    assert.deepEqual(store.listJobs({ activeSince: T1 }).map((j) => j.id), ['c']);
    store.close();
  });

  test('listJobs search escapes LIKE wildcards', () => {
    // A search for "100%" must not turn into a match-everything.
    const store = new JobStore();
    store.upsertJob(makeJob({ id: 'a', title: 'cut latency 100%' }));
    store.upsertJob(makeJob({ id: 'b', title: 'unrelated' }));

    assert.deepEqual(store.listJobs({ search: '100%' }).map((j) => j.id), ['a']);
    assert.deepEqual(store.listJobs({ search: 'LATENCY' }).map((j) => j.id), ['a']);
    store.close();
  });

  test('listJobs honours limit', () => {
    const store = new JobStore();
    store.upsertJob(makeJob({ id: 'a' }));
    store.upsertJob(makeJob({ id: 'b' }));
    store.upsertJob(makeJob({ id: 'c' }));
    assert.equal(store.listJobs({ limit: 2 }).length, 2);
    store.close();
  });

  test('prune removes jobs and their events, keeping recent ones', () => {
    const store = new JobStore();
    store.upsertJob(makeJob({ id: 'old', lastEventAt: '2026-03-01T00:00:00.000Z' }));
    store.upsertJob(makeJob({ id: 'new', lastEventAt: '2026-03-05T00:00:00.000Z' }));
    store.appendEvent({ jobId: 'old', at: '2026-03-01T00:00:00.000Z', kind: 'message', message: 'x' });
    store.appendEvent({ jobId: 'new', at: '2026-03-05T00:00:00.000Z', kind: 'message', message: 'y' });

    // 48h before 2026-03-05T00:00:00Z is 2026-03-03T00:00:00Z, so 'old' falls out.
    const result = store.prune(48 * 60 * 60 * 1000, '2026-03-05T00:00:00.000Z');

    assert.deepEqual(result, { jobs: 1, events: 1 });
    assert.equal(store.getJob('old'), null);
    assert.ok(store.getJob('new'));
    assert.deepEqual(store.recentEvents('new').length, 1);
    assert.deepEqual(store.recentEvents('old').length, 0);
    store.close();
  });

  test('prune also sweeps orphaned events', () => {
    const store = new JobStore();
    store.appendEvent({ jobId: 'ghost', at: '2026-02-01T00:00:00.000Z', kind: 'message', message: 'x' });
    store.appendEvent({ jobId: 'ghost', at: '2026-03-05T00:00:00.000Z', kind: 'message', message: 'y' });

    const result = store.prune(48 * 60 * 60 * 1000, '2026-03-05T00:00:00.000Z');
    assert.deepEqual(result, { jobs: 0, events: 1 });
    assert.deepEqual(store.recentEvents('ghost').map((e) => e.message), ['y']);
    store.close();
  });

  test('prune is a no-op when nothing is stale', () => {
    const store = new JobStore();
    store.upsertJob(makeJob({ id: 'fresh', lastEventAt: '2026-03-05T00:00:00.000Z' }));
    assert.deepEqual(store.prune(48 * 60 * 60 * 1000, '2026-03-05T01:00:00.000Z'), {
      jobs: 0,
      events: 0,
    });
    assert.ok(store.getJob('fresh'));
    store.close();
  });

  test('publishes job.upserted, event.appended and pruned on the bus', () => {
    const bus = new EventBus();
    const store = new JobStore({ bus });
    const seen: string[] = [];
    bus.subscribe('job.upserted', () => seen.push('upserted'));
    bus.subscribe('event.appended', () => seen.push('event'));
    bus.subscribe('pruned', () => seen.push('pruned'));

    store.upsertJob(makeJob({ id: 'old', lastEventAt: '2026-03-01T00:00:00.000Z' }));
    store.appendEvent({ jobId: 'old', at: '2026-03-01T00:00:00.000Z', kind: 'message', message: 'x' });
    store.prune(48 * 60 * 60 * 1000, '2026-03-05T00:00:00.000Z');

    assert.deepEqual(seen, ['upserted', 'event', 'pruned']);
    store.close();
  });

  test('a re-entrant write from a bus subscriber succeeds', () => {
    // upsertJob publishes inside the transaction; a subscriber writing back must
    // join the open transaction rather than opening a nested one.
    const bus = new EventBus();
    const store = new JobStore({ bus });
    let nested = 0;
    // Guarded so the subscriber does not answer its own write — an unguarded
    // echo would recurse forever, which is a bug in the test, not the store.
    bus.subscribe('job.upserted', (job) => {
      if (job.id.endsWith('-echo')) return;
      store.upsertJob(makeJob({ id: `${job.id}-echo`, updatedAt: T1, lastEventAt: T1 }));
      nested++;
    });

    store.upsertJob(makeJob());
    assert.equal(nested, 1);
    assert.ok(store.getJob('agy-001-echo'));
    store.close();
  });

  test('events survive a store reopen when backed by a file', () => {
    // The durability claim in the header: WAL + synchronous NORMAL survives a
    // clean process exit.
    const path = `${process.env['TMPDIR'] ?? '/tmp'}/agent-smith-test-${process.pid}.sqlite`;
    const event: JobEvent = {
      jobId: 'p',
      at: T0,
      kind: 'tool_call',
      message: 'edit',
      tool: 'edit',
    };

    const first = new JobStore({ path });
    first.upsertJob(makeJob({ id: 'p' }));
    first.appendEvent(event);
    first.close();

    const second = new JobStore({ path });
    assert.equal(second.getJob('p')?.title, 'rework dashboard');
    assert.equal(second.recentEvents('p').length, 1);
    second.close();
  });
});