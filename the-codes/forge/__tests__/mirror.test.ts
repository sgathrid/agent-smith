/**
 * mirror.test.ts — the compat projection, and above all its refusal to overwrite
 * somebody else's job.
 *
 * The mirror is the only place in this repo that writes outside its own state
 * directory. That makes it the only place a bug can damage a user's existing
 * work, so the ownership guard gets its own tests, on a REAL directory populated
 * with agy-staff-shaped files, not on mocks.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  MIRROR_MARKER,
  MirrorClaimError,
  MirrorWriter,
  durationSeconds,
  mirrorAt,
  mirrorDispatchLine,
  mirrorEventLine,
  mirrorProgress,
  mirrorSpec,
  mirrorStatus,
  mirrorTerminalLine,
  tokenWords,
} from '../mirror.ts';
import { SCHEMA_VERSION, type ForgeManifest, type ForgeProgress } from '../format.ts';

function repo(): string {
  return mkdtempSync(path.join(tmpdir(), 'agent-smith-mirror-'));
}

/**
 * Write a file into the mirror directory, as if another harness had.
 *
 * The mkdir is here because the PRODUCTION writer creates directories for us
 * (writeAtomic does), and this helper stands in for a process that is not ours
 * and so does not have that behaviour.
 */
function writeForeign(repoRoot: string, jobId: string, suffix: string, body: string): void {
  const at = mirrorAt(repoRoot, jobId, suffix);
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, body);
}

/** A minimal manifest. Every field is set so the builders have nothing to guess. */
function manifest(over: Partial<ForgeManifest> = {}): ForgeManifest {
  const now = '2026-10-06T12:00:00.000Z';
  return {
    schema: SCHEMA_VERSION,
    jobId: 'implement-smith-abcd1234',
    provider: 'agy',
    mode: 'implement',
    model: 'gemini-3.8-flash-high',
    effort: 'low',
    cwd: '/repo',
    task: 'Dashboard rework',
    promptChars: 4200,
    unrestricted: false,
    conversation: 'conv-1',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: null,
    exitCode: null,
    jobStatus: null,
    error: null,
    deniedActions: [],
    usage: null,
    toolCalls: 0,
    pipeline: null,
    stage: null,
    attempt: null,
    ...over,
  };
}

function progress(over: Partial<ForgeProgress> = {}): ForgeProgress {
  return {
    jobId: 'implement-smith-abcd1234',
    lastEventAt: '2026-10-06T12:00:05.000Z',
    recentActivities: [
      { stepIndex: 4, tool: 'run_command', input: 'npm test', status: 'done' },
      { stepIndex: 3, tool: 'read_file', input: 'src/index.ts', status: 'done' },
    ],
    latestText: 'I have read the entry point and I am about to change it.',
    toolCalls: 5,
    warnings: [],
    ...over,
  };
}

/* ── the pure builders ─────────────────────────────────────────────────────── */

test('the spec is agy-staff-shaped and carries the ownership marker', () => {
  const spec = mirrorSpec(manifest());
  assert.equal(spec[MIRROR_MARKER], true);
  // The exact path the mod reads for the band title.
  const ps = spec['prompt_source'] as { kind: string; task: string };
  assert.equal(ps.task, 'Dashboard rework');
  assert.equal(ps.kind, MIRROR_MARKER);
  const resolved = spec['resolved'] as { mode: string; model: string; profile: string };
  assert.equal(resolved.mode, 'implement');
  assert.equal(resolved.model, 'gemini-3.8-flash-high');
});

test('the permission profile says out loud whether approvals were bypassed', () => {
  // This is the field an operator must never have to guess at. agy headless
  // soft-denies and reports success, so "was this job allowed to touch the
  // filesystem" is a question the band has to answer from data.
  assert.equal(
    (mirrorSpec(manifest())['resolved'] as { profile: string }).profile,
    'default',
  );
  assert.equal(
    (mirrorSpec(manifest({ unrestricted: true }))['resolved'] as { profile: string }).profile,
    'unrestricted',
  );
});

test('progress keeps the five newest activities and the tool count', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    stepIndex: i,
    tool: `tool_${i}`,
    status: 'done' as const,
  }));
  const out = mirrorProgress(progress({ recentActivities: rows }));
  const activities = out['recent_activities'] as Array<{ step_index: number }>;
  assert.equal(activities.length, 5);
  assert.equal(activities[0]?.step_index, 7, 'the five NEWEST, not the first five');
  assert.equal(out['tool_calls'], 5);
});

test('progress passes activity warnings through for the mod to colour by', () => {
  const out = mirrorProgress(progress({ warnings: ['permission denied for command "ls"'] }));
  assert.deepEqual(out['warnings'], ['permission denied for command "ls"']);
});

test('an absent latest_text is null, never an empty object the mod would render', () => {
  assert.equal(mirrorProgress(progress({ latestText: null }))['latest_text'], null);
});

test("a SUCCEEDED job mirrors as status 'done'", () => {
  const out = mirrorStatus(manifest({ status: 'succeeded', finishedAt: '2026-10-06T12:28:00.000Z' }), false);
  assert.equal(out['status'], 'done');
  assert.equal(out['warnings'], false);
  assert.equal(out['finished_at'], '2026-10-06T12:28:00.000Z');
});

test('a FAILED job mirrors as status error and carries the reason', () => {
  const out = mirrorStatus(
    manifest({ status: 'failed', error: 'agy soft-denied 1 tool action(s)', finishedAt: '2026-10-06T12:00:06.000Z' }),
    true,
  );
  assert.equal(out['status'], 'error');
  assert.equal(out['warnings'], true);
  assert.equal(out['reason'], 'agy soft-denied 1 tool action(s)');
});

test('a CANCELED job mirrors as status canceled', () => {
  assert.equal(mirrorStatus(manifest({ status: 'canceled' }), false)['status'], 'canceled');
});

test('a suspicious success gets a reason even when the manifest has none', () => {
  // The one case where the wording must not be left blank: `done` with no
  // explanation is exactly the confusing state the downgrade exists to prevent.
  const out = mirrorStatus(manifest({ status: 'failed', error: null }), true);
  assert.match(String(out['reason']), /no usable output/);
});

test('the dispatch line carries the only start time in the layout', () => {
  const line = mirrorDispatchLine(manifest());
  assert.match(line, /^\[agent-smith\] dispatch registered implement-smith-abcd1234 at /);
  // The mod's parseLog regex. If this stops matching, `startedAt` becomes null and
  // every elapsed-time cell goes blank.
  const m = /dispatch registered \S+ at (\S+)/.exec(line);
  assert.equal(m?.[1], '2026-10-06T12:00:00.000Z');
});

test('no worker-started line is written, because we never observed the pid', () => {
  // We do not have the child's pid: WorkerHandle does not expose it, and adding
  // it to four verified adapters for one cosmetic field is not worth it. The mod
  // falls back to the dispatch line, which carries the same instant. Writing a
  // pid we did not observe would be a fabricated measurement.
  assert.equal(mirrorDispatchLine(manifest()).includes('pid='), false);
});

test('the terminal line reports agy-shaped fields the mod greps for by name', () => {
  const line = mirrorTerminalLine(
    manifest({
      status: 'failed',
      jobStatus: 'denied',
      exitCode: 0,
      startedAt: '2026-10-06T12:00:00.000Z',
      finishedAt: '2026-10-06T12:02:30.000Z',
      usage: { inputTokens: 100, outputTokens: 20, thinkingTokens: 5, cacheReadTokens: 900 },
    }),
  );
  assert.match(line, /agy_status=ERROR/);
  assert.match(line, /agy_exit=0/, 'exit 0 with an error status is the trap and must still say ERROR');
  assert.match(line, /duration=150\.000s/);
  assert.match(line, /tokens\(in 100, out 20, think 5, cache 900\)/);
});

test('duration is derived from the two timestamps, never stored separately', () => {
  // Two readers of one job must never print two different runtimes. A stored
  // duration can drift from the timestamps that produced it; a derived one cannot.
  assert.equal(
    durationSeconds(
      manifest({ startedAt: '2026-10-06T12:00:00.000Z', finishedAt: '2026-10-06T12:28:00.000Z' }),
    ),
    1680,
  );
  assert.equal(durationSeconds(manifest({ finishedAt: null })), 0, 'no finish ⇒ no duration, not zero-printed');
  assert.equal(
    durationSeconds(manifest({ startedAt: '2026-10-06T12:00:00.000Z', finishedAt: '2026-10-06T11:00:00.000Z' })),
    0,
    'a finish before the start is nonsense, not a negative runtime',
  );
});

test('absent usage is absent, not zeroes', () => {
  assert.equal(tokenWords(null), '');
  assert.equal(tokenWords({ cacheReadTokens: 900 }), '', 'cache alone is not usage');
  assert.match(tokenWords({ outputTokens: 7 }), /tokens\(in 0, out 7, think 0, cache 0\)/);
});

test('an activity-start mirrors as an ACTIVE step with its parameters', () => {
  const line = mirrorEventLine({
    kind: 'activity-start',
    activity: { stepIndex: 7, tool: 'run_command', input: 'npm test' },
  });
  const su = line?.['step_update'] as { step_index: number; state: string; tool_name: string };
  assert.equal(su.step_index, 7);
  assert.equal(su.state, 'ACTIVE');
  assert.equal(su.tool_name, 'run_command');
  assert.deepEqual((line?.['step_update'] as { tool_info: unknown }).tool_info, { input: 'npm test' });
});

test('an activity-end mirrors as a DONE step with its output', () => {
  const line = mirrorEventLine({
    kind: 'activity-end',
    status: 'done',
    activity: { stepIndex: 7, tool: 'run_command', output: '331 passing' },
  });
  const su = line?.['step_update'] as { state: string; tool_info: Record<string, unknown> };
  assert.equal(su.state, 'DONE');
  assert.equal(su.tool_info['output'], '331 passing');
});

test('a denied or errored tool mirrors as an ERROR step with a TOOL_ERROR body', () => {
  for (const status of ['error', 'denied']) {
    const line = mirrorEventLine({
      kind: 'activity-end',
      status,
      activity: { stepIndex: 2, tool: 'run_command', denied: true },
    });
    const su = line?.['step_update'] as { state: string; tool_info: { error: { type: string } } };
    assert.equal(su.state, 'ERROR', status);
    assert.equal(su.tool_info.error.type, 'TOOL_ERROR', status);
  }
});

test('events that are not tool calls are not mirrored at all', () => {
  // progress.json already carries the prose; mirroring it into events.jsonl would
  // double the bytes the mod reads every three seconds for no added signal.
  assert.equal(mirrorEventLine({ kind: 'text', text: 'hello' }), null);
  assert.equal(mirrorEventLine({ kind: 'usage', usage: {} }), null);
  assert.equal(mirrorEventLine({ kind: 'activity-end', activity: {} }), null, 'no tool name is not a tool call');
});

/* ── the writer, on a real directory ───────────────────────────────────────── */

test('the writer claims an unclaimed id and then owns it', () => {
  const r = repo();
  const m = manifest();
  const w = new MirrorWriter(r);
  w.claim(m.jobId); // no spec.json yet: nobody owns it
  w.writeSpec(m);
  assert.equal(JSON.parse(readFileSync(mirrorAt(r, m.jobId, '.spec.json'), 'utf8'))[MIRROR_MARKER], true);
  // And claiming again is fine: we already own it.
  w.claim(m.jobId);
});

test('THE GUARD: we refuse to write over an agy-staff job', () => {
  const r = repo();
  const id = 'implement-musm82da-f1dc1fe4';
  // Pre-populate as if agy-staff had written it.
  writeForeign(
    r,
    id,
    '.spec.json',
    JSON.stringify({
      prompt_source: { kind: 'agy-staff', task: 'a real job from the corpus' },
      resolved: { mode: 'implement', model: 'gemini-3.8-flash-high', profile: 'unrestricted' },
      cwd: '/renyi',
    }),
  );

  const w = new MirrorWriter(r);
  assert.throws(() => w.claim(id), MirrorClaimError);

  // And the existing file is untouched, byte for byte.
  const after = JSON.parse(readFileSync(mirrorAt(r, id, '.spec.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(after[MIRROR_MARKER], undefined);
  assert.equal((after['prompt_source'] as { task: string }).task, 'a real job from the corpus');
});

test('THE GUARD: an unparseable spec.json is also not ours', () => {
  // Treating "I cannot read it" as "I own it" would let us clobber a file we know
  // nothing about. The whole point of the guard is that it fails closed.
  const r = repo();
  const id = 'review-mutated-00000000';
  writeForeign(r, id, '.spec.json', '{ this is not json');
  assert.throws(() => new MirrorWriter(r).claim(id), MirrorClaimError);
});

test('with the mirror disabled nothing is written at all', () => {
  // The escape hatch: a consumer that does not want a projection should get no
  // files rather than a partial set, because a partial set is a job the mod will
  // draw as `unknown`.
  const r = repo();
  const m = manifest();
  const w = new MirrorWriter(r, { enabled: false });
  w.claim(m.jobId);
  w.writeSpec(m);
  w.writeProgress(m, progress());
  w.finish(m, 'report', false);
  assert.throws(() => readFileSync(mirrorAt(r, m.jobId, '.spec.json'), 'utf8'));
});

test('finish writes result.md, then the log line, then the terminal anchor', () => {
  // The ORDER is the safety property: a reader sampling between the last two
  // writes sees no status file and still reads `running`, which is the
  // conservative answer. The reverse order would open a window where `done`
  // exists and the report does not — the precise state the headline rule exists
  // to prevent. So we assert the whole log, in order, after the fact.
  const r = repo();
  const m = manifest({ status: 'succeeded', finishedAt: '2026-10-06T12:00:06.000Z' });
  const w = new MirrorWriter(r);
  w.claim(m.jobId);
  w.writeSpec(m);
  w.finish(m, '# Report\n\nthe work', false);

  assert.equal(readFileSync(mirrorAt(r, m.jobId, '.result.md'), 'utf8'), '# Report\n\nthe work');
  const log = readFileSync(mirrorAt(r, m.jobId, '.log'), 'utf8').split('\n').filter(Boolean);
  assert.equal(log.length, 2);
  assert.match(log[0] ?? '', /dispatch registered/);
  assert.match(log[1] ?? '', /agy_status=SUCCESS/);
  assert.equal(JSON.parse(readFileSync(mirrorAt(r, m.jobId, '.result.md.status.json'), 'utf8'))['status'], 'done');
});

test('the cancel marker is written once and the first instant wins', () => {
  const r = repo();
  const id = 'review-smith-11111111';
  const w = new MirrorWriter(r);
  w.claim(id);
  assert.equal(w.cancel(id, '2026-10-06T12:00:00.000Z'), true, 'first writer creates it');
  assert.equal(w.cancel(id, '2026-10-06T12:05:00.000Z'), false, 'a second request is a no-op');
  // The FIRST instant is the cancellation instant; overwriting it would move the
  // moment the job actually stopped.
  assert.equal(readFileSync(mirrorAt(r, id, '.spec.json.cancel'), 'utf8'), '2026-10-06T12:00:00.000Z');
});