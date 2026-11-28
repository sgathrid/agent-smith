import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type Candidate,
  type PushKind,
  type WatchableJob,
  type WatchStatus,
  buildBatch,
  dedupeKey,
  pushKindFor,
  shouldPush,
} from '../policy.ts';
import { STALL_GRACE_MS } from '../../../mod/hooks/stale.ts';

test('named completion notices lead with status and leave the worker summary out', () => {
  const batch = buildBatch([cand(job({ name: 'smoke-codex', role: 'review', provider: 'codex',
    status: 'succeeded', startedAt: '2026-10-03T16:39:17Z', finishedAt: '2026-10-03T16:40:00Z',
    changedFileCount: 0, summarySource: 'worker', latestSummary: 'Complete sentence. ' + 'preserved '.repeat(80) }))], NOW);
  assert.match(batch.content!, /^Agent Smith · ✓ smoke-codex \(codex review\) · done · 43s\n/);
  assert.doesNotMatch(batch.content!, /0 files changed/, 'no change is not a fact worth a clause');
  assert.doesNotMatch(batch.content!, /Worker summary|Complete sentence|preserved/, 'the worker summary is not repeated in the notice');
  assert.match(batch.content!, /\nstatus [^\n]+$/);
});

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

function cand(j: WatchableJob, seen: string[] = [], observedInPriorPoll = true): Candidate {
  return { job: j, seen: new Set(seen), observedInPriorPoll };
}

const NOW = Date.parse('2026-10-03T16:40:00.000Z');

test('exactly four things are speakable, and running is not one of them', () => {
  assert.equal(pushKindFor(job({ status: 'succeeded', finishedAt: 'x' })), 'finished');
  assert.equal(pushKindFor(job({ status: 'failed', finishedAt: 'x' })), 'failed');
  assert.equal(pushKindFor(job({ status: 'attention' })), 'attention');
  assert.equal(pushKindFor(job({ status: 'canceled', finishedAt: 'x' })), 'cancelled');

  assert.equal(pushKindFor(job({ status: 'running' })), null);

  assert.equal(pushKindFor(job({ status: 'unknown' })), null);
});

test('a running job is never pushed, no matter how long it has been up', () => {
  const running = job({ status: 'running', lastEventAt: new Date(NOW).toISOString() });
  assert.equal(shouldPush(cand(running)), false);
});

test('the same terminal state is never pushed twice', () => {
  const finished = job({ status: 'succeeded', finishedAt: '2026-10-03T16:40:00Z' });
  const key = dedupeKey(finished);

  assert.equal(shouldPush(cand(finished, [])), true);
  assert.equal(shouldPush(cand(finished, [key])), false, 'second sighting must be silent');
  assert.equal(shouldPush(cand(finished, [key])), false, 'and every one after that');
});

test('a job that fails then succeeds speaks twice — that is two facts', () => {
  const failed = job({ status: 'failed', finishedAt: '2026-10-03T16:30:00Z' });
  const succeeded = job({ status: 'succeeded', finishedAt: '2026-10-03T16:40:00Z' });

  assert.notEqual(dedupeKey(failed), dedupeKey(succeeded));
  assert.equal(shouldPush(cand(failed, [])), true);
  assert.equal(shouldPush(cand(succeeded, [dedupeKey(failed)])), true);
});

test('the dedupe key is id + status, and never a timestamp', () => {
  const a = job({ status: 'failed', finishedAt: '2026-10-03T16:30:00Z' });
  const b = job({ status: 'failed', finishedAt: '2026-10-03T17:45:00Z' });
  assert.equal(dedupeKey(a), dedupeKey(b), 'a moved timestamp must not create a new event');

  assert.equal(dedupeKey(a), `${a.id}#failed`);
  assert.equal(dedupeKey(a).split('#').length, 2);
});

test('a terminal claim with no finished_at is not pushed', () => {
  const flapping = job({ status: 'succeeded', finishedAt: null });
  assert.equal(shouldPush(cand(flapping)), false);

  const settled = job({ status: 'succeeded', finishedAt: '2026-10-03T16:40:00Z' });
  assert.equal(shouldPush(cand(settled)), true);
});

test('attention is not news on first sighting — only after we watched it happen', () => {
  const stalled = job({ status: 'attention', lastEventAt: '2026-10-03T16:00:00Z' });
  assert.equal(shouldPush(cand(stalled, [], false)), false, 'first sighting is baseline');
  assert.equal(shouldPush(cand(stalled, [], true)), true, 'a transition into attention is news');
});

test('attention does not need a terminal timestamp but does need a last event', () => {
  assert.equal(shouldPush(cand(job({ status: 'attention', lastEventAt: null }), [], true)), false);
  assert.equal(
    shouldPush(cand(job({ status: 'attention', lastEventAt: '2026-10-03T16:39:00Z' }), [], true)),
    true,
  );
});

test('five simultaneous failures become ONE notification', () => {
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
  assert.match(batch.content, /^Agent Smith · 5 jobs: 5 failed\n/, 'one headline counts them');
  for (const n of [1, 2, 3, 4, 5]) {
    assert.ok(batch.content.includes(`implement-musm82da-0000000${n}`), `missing job ${n}`);
  }
  assert.equal(batch.keys.length, 5, 'all five are acknowledged in one send');
  assert.ok(/\nstatus [^\n]+$/.test(batch.content), 'must point at status');
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
  assert.match(text, /^Agent Smith · 4 jobs: 3 done, 1 failed\n/);
  assert.match(text, /✗ job d · failed/, 'the failed job must be named');
});

test('a single event gets the specific message, not a one-item summary', () => {
  const batch = buildBatch(
    [cand(job({ id: 'implement-musm82da-f1dc1fe4', status: 'failed', warned: true, finishedAt: '2026-10-03T16:40:00Z' }))],
    NOW,
  );
  assert.ok(batch.content!.startsWith('Agent Smith · ✗ job implement-musm82da-f1dc1fe4 · failed: worker error\n'), batch.content!);
});

test('nothing to say produces no notification at all', () => {
  const batch = buildBatch([cand(job({ status: 'running' }))], NOW);
  assert.equal(batch.content, null);
  assert.deepEqual(batch.keys, []);
});

test('a batch of already-seen events is silent', () => {
  const done = job({ status: 'succeeded', finishedAt: '2026-10-03T16:40:00Z' });
  const batch = buildBatch([cand(done, [dedupeKey(done)])], NOW);
  assert.equal(batch.content, null);
});

test('the failure message is terse, specific, and ends with the next step', () => {
  const batch = buildBatch(
    [
      cand(
        job({
          id: 'implement-musm82da-f1dc1fe4',
          workerId: 'w-f1dc1fe40001',
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
  assert.ok(text.includes('job implement-musm82da-f1dc1fe4 · failed: exit 1'), text);
  assert.match(text, /\nstatus w-f1dc1fe40001$/);
  assert.ok(text.length < 220, `message is ${text.length} chars: ${text}`);
});

test('toNotice uses classified reason over raw stderr and falls back to raw excerpt when unclassified', async () => {
  const { toNotice } = await import('../policy.ts');
  const { headline } = await import('../../../mod/hooks/notice.ts');
  const kimi = toNotice(job({
    id: 'kimi-1',
    name: 'final-kimi',
    provider: 'kimi',
    role: 'verify',
    status: 'failed',
    startedAt: '2026-10-03T16:39:55Z',
    finishedAt: '2026-10-03T16:40:00Z',
    failureReason: 'exited 1 · stderr: error: failed to run prompt: provider.api_error: 429 Your account org-123 key-456 is suspended due to insufficient balance, please recharge your account or check your plan and billing details See log: /tmp/kimi.log',
    failureDetail: 'exited 1 · stderr: error: failed to run prompt: provider.api_error: 429 Your account org-123 key-456 is suspended due to insufficient balance, please recharge your account or check your plan and billing details See log: /tmp/kimi.log',
  }), 'failed', NOW);
  assert.equal(headline(kimi), '✗ final-kimi (kimi verify) · failed: out of credits · 5s');

  const unknown = toNotice(job({
    id: 'unknown-1',
    status: 'failed',
    finishedAt: '2026-10-03T16:40:00Z',
    failureReason: 'worker error',
    failureDetail: 'upstream gateway returned an unexpected opaque payload from node-7',
  }), 'failed', NOW);
  assert.match(headline(unknown), /upstream gateway returned an unexpected opaque payload from node-7/);
});

test('a duration is claimed only from a real start, never from the last event', () => {
  const quick = buildBatch(
    [cand(job({ status: 'failed', lastEventAt: '2026-10-03T16:39:56Z', finishedAt: '2026-10-03T16:40:00Z' }))],
    NOW,
  );
  assert.ok(!quick.content!.includes('after'), quick.content!);

  const long = buildBatch(
    [cand(job({ status: 'failed', startedAt: '2026-10-03T16:12:00Z', finishedAt: '2026-10-03T16:40:00Z' }))],
    NOW,
  );
  assert.ok(long.content!.includes('failed: worker error · 28m'), long.content!);
});

test('an unwarned success is not dressed up as suspicious', () => {
  const batch = buildBatch(
    [cand(job({ status: 'succeeded', warned: false, finishedAt: '2026-10-03T16:40:00Z' }))],
    NOW,
  );
  assert.ok(!batch.content!.includes('warnings'), batch.content!);
  assert.ok(!batch.content!.includes('claimed otherwise'), batch.content!);
});

test('the stall threshold is 15 minutes, shared with the mod', () => {
  assert.equal(STALL_GRACE_MS, 15 * 60 * 1000);
});

test('the status union the policy reasons over covers every reader outcome', () => {
  const statuses: WatchStatus[] = ['running', 'succeeded', 'failed', 'canceled', 'attention', 'unknown'];
  const pushed = statuses.filter((s) => pushKindFor(job({ status: s, finishedAt: 'x' })) !== null);
  assert.deepEqual(pushed.sort(), ['attention', 'canceled', 'failed', 'succeeded']);

  const kinds: PushKind[] = ['finished', 'failed', 'attention', 'cancelled'];
  assert.equal(new Set(kinds).size, 4);
});

test('attention text is a fact: "no output for", and a dead process is "process gone"', () => {
  const silent = job({ status: 'attention', lastEventAt: new Date(NOW - 16 * 60_000).toISOString(),
    liveness: { state: 'silent', silentForMs: 16 * 60_000, since: NOW - 16 * 60_000, tool: 'npm test' } });
  const text = buildBatch([cand(silent)], NOW).content!;
  assert.match(text, /no output for 16m \(in `npm test`\)/);
  assert.doesNotMatch(text, /stalled/);
  const dead = job({ status: 'attention', lastEventAt: null,
    liveness: { state: 'dead', silentForMs: 0, since: NOW - 3 * 60_000 } });
  assert.match(buildBatch([cand(dead)], NOW).content!, /process gone 3m/);
});

test('a silent job that then dies is pushed again; a dead one is pushed once', () => {
  const silent = job({ status: 'attention', liveness: { state: 'silent', silentForMs: 16 * 60_000, since: NOW - 16 * 60_000 } });
  const dead = job({ status: 'attention', liveness: { state: 'dead', silentForMs: 18 * 60_000, since: NOW - 3 * 60_000 } });
  assert.notEqual(dedupeKey(silent), dedupeKey(dead));
  assert.equal(shouldPush(cand(dead, [dedupeKey(silent)])), true, 'dead is news after silent');
  assert.equal(shouldPush(cand(dead, [dedupeKey(silent), dedupeKey(dead)])), false, 'said once');
  assert.equal(shouldPush(cand(job({ ...dead, lastEventAt: null }))), true);
  assert.equal(shouldPush(cand(job({ ...silent, lastEventAt: null }))), false);
});

test('toNotice passes continuationKind for steers and resumes without steeredFrom', async () => {
  const { toNotice } = await import('../policy.ts');
  const steered = toNotice(job({ status: 'succeeded', finishedAt: '2026-10-03T16:40:00Z', continuedFrom: 'turn-1', continuationKind: 'steer' }), 'finished', NOW);
  assert.equal((steered as { continuationKind?: unknown }).continuationKind, 'steer');
  assert.equal('steered' in steered, false);
  const resumed = toNotice(job({ status: 'succeeded', finishedAt: '2026-10-03T16:40:00Z', continuedFrom: 'turn-2', continuationKind: 'follow-up' }), 'finished', NOW);
  assert.equal((resumed as { continuationKind?: unknown }).continuationKind, 'follow-up');
});

test('a turn handed off to a follow-up is not pushed; the head carries the turns it covered', async () => {
  const { toNotice } = await import('../policy.ts');
  const done = { status: 'succeeded' as const, finishedAt: '2026-10-03T16:40:00Z' };
  assert.equal(shouldPush(cand(job({ ...done, followedBy: 'turn-2' }))), false);
  assert.equal(shouldPush(cand(job({ ...done, supersededBy: 'turn-2' }))), false);
  assert.equal(shouldPush(cand(job({ ...done, acceptancePending: true }))), false);
  const head = toNotice(job({ ...done, continuationKind: 'follow-up', turns: { from: 1, to: 3 }, droppedMessage: 'rerun' }), 'finished', NOW);
  assert.deepEqual([head.turns, head.droppedMessage], [{ from: 1, to: 3 }, 'rerun']);
});

test('toWatchStatus: a long open command is running; a stopped heartbeat is attention', async () => {
  const { toWatchStatus } = await import('../watch-source.ts');
  const obs = (raw: Record<string, unknown>) => ({
    provider: 'agent-smith', jobId: 'j', status: 'running' as const, warnings: [], output: null, startedAt: null,
    updatedAt: new Date(NOW - 40 * 60_000).toISOString(), finishedAt: null, mode: 'implement', model: null, label: null,
    outputTruncated: false, usage: null, partial: false, raw,
  });
  const open = { stepIndex: 1, tool: 'Bash', input: '{"command":"cargo test"}', status: 'active' };
  assert.equal(toWatchStatus(obs({ last_activity: open, last_alive_at: new Date(NOW - 10_000).toISOString() }), NOW), 'running');
  assert.equal(toWatchStatus(obs({ last_activity: open, last_alive_at: new Date(NOW - 3 * 60_000).toISOString() }), NOW), 'attention');
  assert.equal(toWatchStatus(obs({ last_activity: open }), NOW), 'attention');
  assert.equal(toWatchStatus({ ...obs({}), updatedAt: null }, NOW), 'attention');
});

test('toNotice uses chainStartedAt for steered chains and per-turn startedAt on resumes', async () => {
  const { toNotice } = await import('../policy.ts');
  const steered = toNotice(job({
    status: 'succeeded',
    chainStartedAt: '2026-10-03T16:38:00Z',
    startedAt: '2026-10-03T16:39:54Z',
    finishedAt: '2026-10-03T16:40:00Z',
    continuationKind: 'steer',
  }), 'finished', NOW);
  assert.equal(steered.durationMs, 120_000);
  const resumed = toNotice(job({
    status: 'succeeded',
    chainStartedAt: '2026-10-03T16:39:54Z',
    startedAt: '2026-10-03T16:39:54Z',
    finishedAt: '2026-10-03T16:40:00Z',
    continuationKind: 'follow-up',
  }), 'finished', NOW);
  assert.equal(resumed.durationMs, 6_000);
});

test("a finished job's notice summary comes from its report, not its last running message", async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { JobWriter } = await import('../../../../forge/writer.ts');
  const { readJob } = await import('../watch-source.ts');
  const { toNotice } = await import('../policy.ts');
  const repo = mkdtempSync(path.join(tmpdir(), 'smith-policy-'));
  const w = new JobWriter({ repo, jobId: 'review-smith-abcd1234', flushMs: 0 });
  w.start({ provider: 'codex', mode: 'review', model: null, effort: null, cwd: repo, prompt: 'Review it', unrestricted: false,
    conversation: null, timeoutMs: 1000, pipeline: null, stage: null, attempt: null });
  const at = new Date().toISOString();
  w.onEvent({ kind: 'text', at, stream: 'assistant', text: 'Running the checks.', messageKey: 'm1' });
  assert.equal((await readJob(repo, w.jobId))?.latestSummary, 'Running the checks.');
  const report = 'Status: DONE\n\nNo defects found.';
  w.onEvent({ kind: 'text', at, stream: 'assistant', text: report, messageKey: 'm2' });
  w.finish({ jobId: w.jobId, provider: 'codex', ok: true, status: 'success', exitCode: 0, signal: null, response: report, answerKey: 'm2',
    durationMs: 10, startedAt: at, finishedAt: at, stateDir: '' }, report);
  const done = (await readJob(repo, w.jobId))!;
  assert.equal(toNotice(done, 'finished', Date.now()).summary, 'No defects found.');
});
