/**
 * Tests for the poll loop's state machine.
 *
 * policy.test.ts proves each rule in isolation. This file proves the rules hold
 * ACROSS POLLS, which is where the real money is: the channel's cost is the number
 * of notifications a long session produces, and that number is a property of the
 * loop, not of any single decision.
 *
 * `read` is injected, so these tests drive the poller with a scripted sequence of
 * job states and count exactly what would have been sent. No transport, no
 * filesystem, no clock — the real test runner, no mocking library.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pollOnce, resetPoller } from '../poller.ts';
import type { Batch } from '../policy.ts';
import type { WatchableJob } from '../policy.ts';

const T0 = Date.parse('2026-10-03T16:00:00.000Z');

/** A running job, mid-flight. */
function running(id: string): WatchableJob {
  return {
    id,
    status: 'running',
    lastEventAt: new Date(T0).toISOString(),
    finishedAt: null,
    warned: false,
  };
}

/** A job that finished successfully at `at`. */
function done(id: string, at: number): WatchableJob {
  return {
    id,
    status: 'succeeded',
    lastEventAt: new Date(at - 28 * 60_000).toISOString(),
    finishedAt: new Date(at).toISOString(),
    warned: false,
  };
}

/** A job that failed at `at`. */
function failed(id: string, at: number): WatchableJob {
  return { ...done(id, at), status: 'failed', warned: true };
}

/**
 * Drive the poller over a scripted timeline and collect every batch it sends.
 *
 * `script` is one entry per poll. Each entry is the job list as of that poll, so
 * repeating the same list models "nothing changed", which is the overwhelmingly
 * common case in a real session.
 */
async function run(script: WatchableJob[][], cwd = '/repo'): Promise<Batch[]> {
  const sent: Batch[] = [];
  for (let i = 0; i < script.length; i++) {
    const jobs = script[i]!;
    await pollOnce(cwd, T0 + i * 5_000, async (b) => { sent.push(b); }, async () => jobs);
  }
  return sent;
}

// Every test starts from clean dedupe state, because it is module-level.
test('the first poll is a baseline and sends nothing', async () => {
  resetPoller();
  // Ten jobs already finished on disk before the channel existed.
  const backlog = Array.from({ length: 10 }, (_, i) => done(`job-${i}`, T0));
  const sent = await run([backlog]);

  // THE RULE THAT KEEPS THE CHANNEL SURVIVABLE. A user who starts a session in a
  // repo with a history of finished jobs must not be greeted with ten
  // notifications about work that completed before the channel existed.
  assert.equal(sent.length, 0, `expected silence, got ${sent.length}`);
});

test('a job finishing after the baseline is announced exactly once', async () => {
  resetPoller();
  const script = [
    [running('implement-musm82da')], // baseline: running
    [running('implement-musm82da')], // still running — must stay silent
    [done('implement-musm82da', T0)], // finishes here
    [done('implement-musm82da', T0)], // unchanged
    [done('implement-musm82da', T0)], // still unchanged
  ];
  const sent = await run(script);

  assert.equal(sent.length, 1, `expected exactly one notification, got ${sent.length}`);
  assert.ok(sent[0]!.content!.includes('implement-musm82da'));
  assert.equal(sent[0]!.meta['kind'], 'finished');
});

test('sixty polls of a running job cost nothing', async () => {
  // The headline cost property, stated as a test. 60 polls at the real 5 s cadence
  // is five minutes of an active session, and it must produce zero tokens. If this
  // test ever fails, the channel has become the thing it exists to prevent.
  resetPoller();
  const script = Array.from({ length: 60 }, () => [running('implement-musm82da')]);
  const sent = await run(script);
  assert.equal(sent.length, 0);
});

test('a whole job lifecycle produces two notifications, not hundreds', async () => {
  // 28 minutes at 5 s is ~336 polls. Baseline, then one finish.
  resetPoller();
  const script = Array.from({ length: 336 }, () => [running('implement-musm82da')]);
  script.push([done('implement-musm82da', T0)]);
  script.push([done('implement-musm82da', T0)]);

  const sent = await run(script);
  assert.equal(sent.length, 1, 'a 28-minute job must cost one notification');
});

test('fail, re-run, succeed: two announcements, in order', async () => {
  resetPoller();
  const script = [
    [running('implement-musm82da')],
    [failed('implement-musm82da', T0)],
    [failed('implement-musm82da', T0)],
    [running('implement-musm82da')], // re-run
    [done('implement-musm82da', T0)],
  ];
  const sent = await run(script);

  assert.equal(sent.length, 2, `expected fail then success, got ${sent.length}`);
  assert.equal(sent[0]!.meta['kind'], 'failed');
  assert.equal(sent[1]!.meta['kind'], 'finished');
});

test('five jobs finishing on the same tick produce one notification', async () => {
  resetPoller();
  const script = [
    [running('a'), running('b'), running('c'), running('d'), running('e')],
    [done('a', T0), done('b', T0), done('c', T0), done('d', T0), done('e', T0)],
  ];
  const sent = await run(script);

  assert.equal(sent.length, 1, 'one tick, one notification');
  assert.match(sent[0]!.content!, /^Agent Smith · 5 jobs: 5 succeeded\./);
});

test('a job going silent after the baseline is announced once as attention', async () => {
  resetPoller();
  const stalled = (id: string): WatchableJob => ({
    ...running(id),
    status: 'attention',
    lastEventAt: new Date(T0 - 20 * 60_000).toISOString(), // 20 min of silence
  });

  const script = [
    [running('implement-musm82da')], // baseline, moving
    [stalled('implement-musm82da')],
    [stalled('implement-musm82da')],
    [stalled('implement-musm82da')],
  ];
  const sent = await run(script);

  assert.equal(sent.length, 1, `a stall must be announced once, got ${sent.length}`);
  assert.equal(sent[0]!.meta['kind'], 'attention');
});

test('a job already stalled at startup is never announced', async () => {
  resetPoller();
  const stalled: WatchableJob = {
    ...running('old-stall'),
    status: 'attention',
    lastEventAt: new Date(T0 - 3 * 60 * 60_000).toISOString(),
  };
  // First poll sees only the stalled job. It must produce nothing: we did not
  // observe it stall.
  const sent = await run([[stalled], [stalled], [stalled]]);
  assert.equal(sent.length, 0);
});

test('a cancellation is announced', async () => {
  resetPoller();
  const cancelled: WatchableJob = {
    ...running('implement-musm82da'),
    status: 'canceled',
    finishedAt: new Date(T0).toISOString(),
  };
  const sent = await run([[running('implement-musm82da')], [cancelled]]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.meta['kind'], 'cancelled');
});

test('a vanished job does not resurrect an old notification', async () => {
  resetPoller();
  const script = [
    [running('implement-musm82da')],
    [done('implement-musm82da', T0)],
    [], // agy-staff cleaned the directory
    [done('implement-musm82da', T0)], // and it is somehow back
  ];
  const sent = await run(script);
  // Once announced, once announced. A job disappearing is not an event we push.
  assert.equal(sent.length, 1);
});

test('a read that throws costs one tick of silence, not the channel', async () => {
  resetPoller();
  const sent: Batch[] = [];
  // A reader blowing up mid-rewrite must not kill the server, and must certainly
  // not push a half-read state.
  await pollOnce('/repo', T0, async (b) => { sent.push(b); }, async () => {
    throw new Error('EIO');
  });
  assert.equal(sent.length, 0);

  // And the very next poll works normally.
  await pollOnce('/repo', T0 + 5_000, async (b) => { sent.push(b); }, async () => [running('a')]);
  await pollOnce('/repo', T0 + 10_000, async (b) => { sent.push(b); }, async () => [done('a', T0 + 10_000)]);
  assert.equal(sent.length, 1, 'the channel recovers from a bad read');
});

test('a rejected send is retried, not swallowed', async () => {
  resetPoller();
  const script = [
    [running('implement-musm82da')],
    [done('implement-musm82da', T0)],
  ];

  // Poll 1 is the baseline and sends nothing, so the first ACTUAL send is call 1.
  // That one fails. We must NOT have recorded the key by then, or the event is lost
  // forever — a lost notification is worse than a repeated one, because nobody
  // notices the loss.
  let calls = 0;
  const send = async (): Promise<void> => {
    calls++;
    if (calls === 1) throw new Error('transport closed');
  };

  // Poll 0 is the baseline: resolves silently, sends nothing.
  await pollOnce('/repo', T0, send, async () => script[0]!);
  assert.equal(calls, 0, 'the baseline poll must not send');

  // Poll 1 is the first real send, and it fails.
  await assert.rejects(
    pollOnce('/repo', T0 + 5_000, send, async () => script[1]!),
    /transport closed/,
  );
  assert.equal(calls, 1, 'the send was attempted exactly once and failed');

  // The next poll re-offers the same event.
  let retried = 0;
  await pollOnce('/repo', T0 + 15_000, async () => { retried++; }, async () => [
    done('implement-musm82da', T0),
  ]);
  assert.equal(retried, 1, 'the undelivered event must be offered again');
});

test('a realistic session: 12 jobs, mixed outcomes, bounded cost', async () => {
  // The end-to-end cost property. A day of work in this repo is ~20 jobs over ~16
  // hours at 3 concurrent. What must hold is that notifications track EVENTS, not
  // polls, and that simultaneous events collapse.
  resetPoller();
  const ids = Array.from({ length: 12 }, (_, i) => `implement-muro${i}`);

  const script: WatchableJob[][] = [];
  script.push(ids.map(running)); // baseline: 12 running
  for (let poll = 0; poll < 40; poll++) {
    // Each round, one more job finishes. 12 finishes spread over 40 polls.
    const settled = Math.min(12, Math.floor(poll / 3.3));
    script.push(ids.map((id, i) => (i < settled ? done(id, T0) : running(id))));
  }
  // One tick where four jobs fail simultaneously, right after twelve finished.
  script.push([
    ...ids.map((id) => done(id, T0)),
    ...[13, 14, 15, 16].map((n) => failed(`implement-musm${n}`, T0)),
  ]);

  const sent = await run(script);

  // 12 finishes, batched as far as the timeline allows, plus one failure batch.
  // The bound that matters: notifications <= events, and every notification names
  // real jobs. The absolute number depends on how the timeline batches, so we
  // assert the relationship rather than a magic constant.
  const totalEvents = 12 + 4;
  assert.ok(sent.length <= totalEvents, `${sent.length} notifications for ${totalEvents} events`);
  assert.ok(sent.length >= 5, `expected real events to be reported, got ${sent.length}`);

  for (const b of sent) {
    assert.ok(b.content !== null);
    // A bounded headline and footer, plus one short line per job named.
    assert.ok(b.content.length < 160 + 110 * Number(b.meta['count']), `over-long notification: ${b.content}`);
  }
  // Exactly one notification mentions a failure, and it is the 4-way batch.
  const failures = sent.filter((b) => b.content!.includes('failed'));
  assert.equal(failures.length, 1, 'four simultaneous failures must be one notification');
  assert.match(failures[0]!.content!, /^Agent Smith · \d+ jobs: (\d+ succeeded, )?4 failed\./);
});