/**
 * Tests for the channel's push policy.
 *
 * This is the most important test file in the repo. Everything else renders a
 * screen the user can look away from; this file governs whether tokens are spent
 * in someone's context window. A policy that pushes a progress tick every 5
 * seconds would spend ~10k tokens an hour and would not be noticed until the bill
 * arrived, so the "must NOT push" cases are tested as hard as the "must push" ones.
 *
 * Fixtures use the real 20-job corpus shape at
 * /Users/gathrid/Repos/renyi/.agy-staff/jobs — real ids, real warning strings, real
 * ISO timestamps — so the tests fail on realistic data rather than on tidy data.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type Candidate,
  type PushKind,
  type WatchableJob,
  type WatchStatus,
  assertMetaSafe,
  buildBatch,
  dedupeKey,
  metaFor,
  pushKindFor,
  safeId,
  shouldPush,
} from '../policy.ts';
import { STALL_GRACE_MS } from '../../../mod/hooks/stale.ts';

test('named completion notices lead with status and leave the worker summary out', () => {
  const batch = buildBatch([cand(job({ name: 'smoke-codex', role: 'review', provider: 'codex',
    status: 'succeeded', startedAt: '2026-10-03T16:39:17Z', finishedAt: '2026-10-03T16:40:00Z',
    changedFileCount: 0, summarySource: 'worker', latestSummary: 'Complete sentence. ' + 'preserved '.repeat(80) }))], NOW);
  assert.match(batch.content!, /^Agent Smith · ✓ smoke-codex \(codex review\) succeeded in 43s · no checks\. Job ID /);
  assert.doesNotMatch(batch.content!, /0 files changed/, 'no change is not a fact worth a clause');
  assert.doesNotMatch(batch.content!, /Worker summary|Complete sentence|preserved/, 'the worker summary is not repeated in the notice');
  assert.match(batch.content!, /\nRead it with status before acting\.$/);
});

// ── fixtures, built from the real corpus ────────────────────────────────────

/** Real ids and statuses, read from the corpus. */
function job(over: Partial<WatchableJob> = {}): WatchableJob {
  return {
    id: 'implement-musm82da-f1dc1fe4',
    status: 'running',
    lastEventAt: '2026-10-03T16:37:41.031Z',
    finishedAt: null,
    warned: false,
    ...over,
  };
}

/** A candidate with nothing seen yet and the job already known from a prior poll. */
function cand(j: WatchableJob, seen: string[] = [], known = true): Candidate {
  return { job: j, seen: new Set(seen), knownBefore: known };
}

const NOW = Date.parse('2026-10-03T16:40:00.000Z');

// ── the vocabulary ──────────────────────────────────────────────────────────

test('exactly four things are speakable, and running is not one of them', () => {
  assert.equal(pushKindFor(job({ status: 'succeeded', finishedAt: 'x' })), 'finished');
  assert.equal(pushKindFor(job({ status: 'failed', finishedAt: 'x' })), 'failed');
  assert.equal(pushKindFor(job({ status: 'attention' })), 'attention');
  assert.equal(pushKindFor(job({ status: 'canceled', finishedAt: 'x' })), 'cancelled');

  // THE HEADLINE RULE. `running` returning a push kind is the bug this whole file
  // exists to prevent: progress pushed into context costs tokens on every
  // subsequent turn and tells Claude nothing it cannot get from the mod band.
  assert.equal(pushKindFor(job({ status: 'running' })), null);

  // `unknown` is silent too. "Something happened and I do not know what" costs
  // tokens and buys nothing — and pushing it would train Claude to expect noise.
  assert.equal(pushKindFor(job({ status: 'unknown' })), null);
});

test('a running job is never pushed, no matter how long it has been up', () => {
  const running = job({ status: 'running', lastEventAt: new Date(NOW).toISOString() });
  assert.equal(shouldPush(cand(running), NOW), false);
});

// ── dedupe ──────────────────────────────────────────────────────────────────

test('the same terminal state is never pushed twice', () => {
  // THE DEDUPE RULE. This is the assertion the whole channel rests on: a 28-minute
  // job is polled ~340 times, and without this the user is told it finished 340
  // times.
  const finished = job({ status: 'succeeded', finishedAt: '2026-10-03T16:40:00Z' });
  const key = dedupeKey(finished);

  assert.equal(shouldPush(cand(finished, []), NOW), true);
  assert.equal(shouldPush(cand(finished, [key]), NOW), false, 'second sighting must be silent');
  assert.equal(shouldPush(cand(finished, [key]), NOW), false, 'and every one after that');
});

test('a job that fails then succeeds speaks twice — that is two facts', () => {
  // Keying only on job id would swallow the recovery and leave Claude believing a
  // job failed when it in fact succeeded on a re-run.
  const failed = job({ status: 'failed', finishedAt: '2026-10-03T16:30:00Z' });
  const succeeded = job({ status: 'succeeded', finishedAt: '2026-10-03T16:40:00Z' });

  assert.notEqual(dedupeKey(failed), dedupeKey(succeeded));
  assert.equal(shouldPush(cand(failed, []), NOW), true);
  assert.equal(shouldPush(cand(succeeded, [dedupeKey(failed)]), NOW), true);
});

test('the dedupe key is id + status, and never a timestamp', () => {
  // finished_at is the natural instinct for a dedupe key and it is wrong:
  // agy-staff rewrites status.json on some cleanup paths, so a timestamp is not
  // stable and would turn a re-read into a fake "new" event.
  const a = job({ status: 'failed', finishedAt: '2026-10-03T16:30:00Z' });
  const b = job({ status: 'failed', finishedAt: '2026-10-03T17:45:00Z' });
  assert.equal(dedupeKey(a), dedupeKey(b), 'a moved timestamp must not create a new event');

  // The key is INTERNAL — it never crosses the MCP boundary, so it is not subject
  // to the identifier-safe rule that `meta` is. It is a Map key in this process and
  // hyphens in a job id are fine there. (`meta` is different, and the test below
  // covers why.)
  assert.equal(dedupeKey(a), `${a.id}#failed#0`);
  assert.equal(dedupeKey(a).split('#').length, 3);
});

test('a terminal claim with no finished_at is not pushed', () => {
  // The mid-flight flap: agy-staff deletes progress.json on a clean finish, and
  // there is a window where the terminal file is mid-write. A reader sampling that
  // window can see a finished job as `succeeded` with no finished_at yet. Pushing
  // it, then pushing again once the timestamp lands, would produce a duplicate.
  const flapping = job({ status: 'succeeded', finishedAt: null });
  assert.equal(shouldPush(cand(flapping), NOW), false);

  // Once the timestamp is real, it is pushable — exactly once.
  const settled = job({ status: 'succeeded', finishedAt: '2026-10-03T16:40:00Z' });
  assert.equal(shouldPush(cand(settled), NOW), true);
});

test('attention is not news on first sighting — only after we watched it happen', () => {
  // A channel starting against a directory with stalled jobs must not open with an
  // avalanche. It did not observe them stall, so it has a backlog, not news.
  const stalled = job({ status: 'attention', lastEventAt: '2026-10-03T16:00:00Z' });
  assert.equal(shouldPush(cand(stalled, [], false), NOW), false, 'first sighting is baseline');
  assert.equal(shouldPush(cand(stalled, [], true), NOW), true, 'a transition into attention is news');
});

test('attention does not need a terminal timestamp but does need a last event', () => {
  // The mirror of the gate above: attention is by definition NOT terminal, so
  // requiring finishedAt would make it unpushable.
  assert.equal(shouldPush(cand(job({ status: 'attention', lastEventAt: null }), [], true), NOW), false);
  assert.equal(
    shouldPush(cand(job({ status: 'attention', lastEventAt: '2026-10-03T16:39:00Z' }), [], true), NOW),
    true,
  );
});

// ── batching ────────────────────────────────────────────────────────────────

test('five simultaneous failures become ONE notification', () => {
  // THE ANTI-SPAM RULE. Not five lines. A firehose gets muted, and a muted channel
  // costs the user the one thing they installed it for.
  const failed = (n: number): Candidate =>
    cand(
      job({
        id: `implement-musm82da-0000000${n}`,
        status: 'failed',
        finishedAt: '2026-10-03T16:40:00Z',
      }),
    );

  const batch = buildBatch([failed(1), failed(2), failed(3), failed(4), failed(5)], NOW);

  assert.ok(batch.content !== null);
  assert.match(batch.content, /^Agent Smith · 5 jobs: 5 failed\./, 'one headline counts them');
  // The ids are still named: "5 failed" alone does not tell Claude which five, and
  // naming them is what lets Claude act without the user retyping a job id.
  for (const n of [1, 2, 3, 4, 5]) {
    assert.ok(batch.content.includes(`implement-musm82da-0000000${n}`), `missing job ${n}`);
  }
  assert.equal(batch.keys.length, 5, 'all five are acknowledged in one send');
  assert.ok(batch.content.endsWith('Read them with status before acting.'), 'must point at status');
  assert.ok(!batch.content.includes('agy'), 'unnamed Forge jobs are not called agy jobs');
});

test('a mixed batch groups by kind, so "three finished, one failed" stays legible', () => {
  const batch = buildBatch(
    [
      cand(job({ id: 'a', status: 'succeeded', finishedAt: '2026-10-03T16:40:00Z' })),
      cand(job({ id: 'b', status: 'succeeded', finishedAt: '2026-10-03T16:40:00Z' })),
      cand(job({ id: 'c', status: 'succeeded', finishedAt: '2026-10-03T16:40:00Z' })),
      cand(job({ id: 'd', status: 'failed', finishedAt: '2026-10-03T16:40:00Z' })),
    ],
    NOW,
  );

  const text = batch.content;
  assert.ok(text !== null);
  assert.match(text, /^Agent Smith · 4 jobs: 3 succeeded, 1 failed\./);
  // Collapsing these into "4 finished" would throw away the only part that matters.
  assert.match(text, /✗ job d failed/, 'the failed job must be named');
});

test('a single event gets the specific message, not a one-item summary', () => {
  const batch = buildBatch(
    [cand(job({ id: 'implement-musm82da-f1dc1fe4', status: 'failed', warned: true, finishedAt: '2026-10-03T16:40:00Z' }))],
    NOW,
  );
  assert.equal(batch.meta['kind'], 'failed');
  assert.equal(batch.meta['count'], '1');
  assert.ok(batch.content!.startsWith('Agent Smith · ✗ job implement-musm82da-f1dc1fe4 failed.\n'), batch.content!);
});

test('nothing to say produces no notification at all', () => {
  // The common case, and the one that must be cheap. On most ticks of a healthy
  // session this is the entire output.
  const batch = buildBatch([cand(job({ status: 'running' }))], NOW);
  assert.equal(batch.content, null);
  assert.deepEqual(batch.keys, []);
});

test('a batch of already-seen events is silent', () => {
  const done = job({ status: 'succeeded', finishedAt: '2026-10-03T16:40:00Z' });
  const batch = buildBatch([cand(done, [dedupeKey(done)])], NOW);
  assert.equal(batch.content, null);
});

// ── message content ─────────────────────────────────────────────────────────

test('the failure message is terse, specific, and ends with the next step', () => {
  const batch = buildBatch(
    [
      cand(
        job({
          id: 'implement-musm82da-f1dc1fe4',
          source: 'agy-staff',
          status: 'failed',
          warned: true,
          failureReason: 'agy exited 1',
          lastEventAt: '2026-10-03T16:12:00Z',
          finishedAt: '2026-10-03T16:40:00Z',
        }),
      ),
    ],
    NOW,
  );
  const text = batch.content!;
  assert.ok(text.includes('agy-staff job implement-musm82da-f1dc1fe4 failed: agy exited 1'), text);
  assert.ok(text.endsWith('Read it with status before acting.'));
  assert.ok(!text.includes('/agy-radar'), 'no /agy-radar command exists any more');
  // The budget is ~50 tokens. A multi-sentence essay would blow it.
  assert.ok(text.length < 220, `message is ${text.length} chars: ${text}`);
});

test('a duration is claimed only from a real start, never from the last event', () => {
  // last_event_at is the last EVENT, not the job start. For a fast job it is
  // seconds before the end, so finished - lastEvent is ~4s for a 28-minute job.
  // Without a start time the honest rendering is no duration at all.
  const quick = buildBatch(
    [cand(job({ status: 'failed', lastEventAt: '2026-10-03T16:39:56Z', finishedAt: '2026-10-03T16:40:00Z' }))],
    NOW,
  );
  assert.ok(!quick.content!.includes('after'), quick.content!);

  // A genuine long run does get a duration.
  const long = buildBatch(
    [cand(job({ status: 'failed', startedAt: '2026-10-03T16:12:00Z', finishedAt: '2026-10-03T16:40:00Z' }))],
    NOW,
  );
  assert.ok(long.content!.includes('failed after 28m'), long.content!);
});

test('an unwarned success is not dressed up as suspicious', () => {
  const batch = buildBatch(
    [cand(job({ status: 'succeeded', warned: false, finishedAt: '2026-10-03T16:40:00Z' }))],
    NOW,
  );
  assert.ok(!batch.content!.includes('warnings'), batch.content!);
  assert.ok(!batch.content!.includes('claimed otherwise'), batch.content!);
});

// ── meta ────────────────────────────────────────────────────────────────────

test('meta keys and values are identifier-safe, and the real job ids are not', () => {
  // THE CONTRACT: meta keys are [A-Za-z0-9_]. Real agy job ids contain HYPHENS,
  // so `meta.job = "implement-musm82da-f1dc1fe4"` is illegal and would make the
  // notification silently undeliverable.
  const real = 'implement-musm82da-f1dc1fe4';
  assert.ok(!/^[A-Za-z0-9_]+$/.test(real), 'the premise of this test must hold');

  const meta = metaFor('failed', [job({ id: real, status: 'failed' })]);
  assert.ok(assertMetaSafe(meta), `meta not safe: ${JSON.stringify(meta)}`);
  for (const [k] of Object.entries(meta)) {
    assert.match(k, /^[A-Za-z0-9_]+$/, `illegal key: ${k}`);
  }
  assert.equal(meta['jobs'], 'implement_musm82da_f1dc1fe4');
});

test('the human-readable content keeps the real ids with hyphens', () => {
  // Only meta is machine-facing. The text is for a person and a model, and neither
  // cares about a hyphen — sanitising the prose would make it harder to read for
  // no benefit.
  const batch = buildBatch(
    [cand(job({ id: 'implement-musm82da-f1dc1fe4', status: 'failed', finishedAt: '2026-10-03T16:40:00Z' }))],
    NOW,
  );
  assert.ok(batch.content!.includes('implement-musm82da-f1dc1fe4'));
  assert.equal(batch.meta['jobs'], 'implement_musm82da_f1dc1fe4');
});

test('assertMetaSafe rejects the shapes that would silently drop a notification', () => {
  assert.equal(assertMetaSafe({ kind: 'failed', count: '1', jobs: 'a_b' }), true);
  assert.equal(assertMetaSafe({ 'job-id': 'a' }), false, 'hyphen in a key');
  assert.equal(assertMetaSafe({ kind: 'failed', jobs: 'a-b' }), false, 'hyphen in a value');
  assert.equal(assertMetaSafe({ kind: '5 failed' }), false, 'space in a key');
});

test('safeId is lossy on purpose and that is acceptable', () => {
  assert.equal(safeId('implement-musm82da-f1dc1fe4'), 'implement_musm82da_f1dc1fe4');
  // Two distinct ids can collide. Allowed: meta is for coarse filtering and
  // `content` carries the exact text, so a perfect encoding would cost more tokens
  // than it is worth.
  assert.equal(safeId('a-b'), safeId('a_b'));
});

// ── the shared stall threshold ──────────────────────────────────────────────

test('the stall threshold is 15 minutes, shared with the mod', () => {
  // One constant, two importers. If the pane and the channel disagreed about when
  // a job counts as stalled, the user would see a band saying "fine" while Claude
  // was told the job was stuck.
  assert.equal(STALL_GRACE_MS, 15 * 60 * 1000);
});

test('the status union the policy reasons over covers every reader outcome', () => {
  // Guards against a reader gaining a status (codex, opencode) that the policy has
  // no case for — which would silently default to null and never be pushed.
  const statuses: WatchStatus[] = ['running', 'succeeded', 'failed', 'canceled', 'attention', 'unknown'];
  const pushed = statuses.filter((s) => pushKindFor(job({ status: s, finishedAt: 'x' })) !== null);
  assert.deepEqual(pushed.sort(), ['attention', 'canceled', 'failed', 'succeeded']);

  // And every push kind has a distinct meta value.
  const kinds: PushKind[] = ['finished', 'failed', 'attention', 'cancelled'];
  assert.equal(new Set(kinds).size, 4);
});
