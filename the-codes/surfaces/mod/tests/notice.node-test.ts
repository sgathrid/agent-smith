/**
 * Completion notices: the words, the launch acks, and which jobs a session may
 * announce. The mod and the PostToolUse hook both render through notice.ts, so
 * the last test checks they produce identical text for the same job.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACCEPTANCE_HOLD_MS, LAUNCH_TOOL, STATUS_TOOL, type NoticeJob, type NoticeRow, type Owned, type RunRecord,
  claim, claudeText, displayNoticeText, due, headline, noticeFromRadar, parseLaunch, parseSettledRead, unclaim,
} from '../hooks/notice.ts';
import { buildBatch } from '../../channel/src/policy.ts';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const PLUGIN = 'mcp__plugin_agent-smith_agent-smith__';

function row(over: Partial<NoticeRow> & { id: string }): NoticeRow {
  return { status: 'running', startedAt: NOW - 60_000, endedAt: null, lastEventAt: NOW - 1000, ...over };
}
function notice(over: Partial<NoticeJob>): NoticeJob {
  return { id: 'job-1', kind: 'finished', ...over };
}

// ── the words ───────────────────────────────────────────────────────────────

test('success names worker, provider and role, duration, files and checks', () => {
  assert.equal(
    headline(notice({ name: 'Ada', provider: 'codex', role: 'review', durationMs: 43_000, changedFiles: 2, checks: { passed: 2, total: 2 } })),
    '✓ Ada (codex review) succeeded in 43s · 2 files changed · checks 2/2',
  );
});

test('failure leads with the runtime reason after the duration', () => {
  assert.equal(
    headline(notice({ kind: 'failed', name: 'Bo', provider: 'agy', role: 'implement', durationMs: 45 * 60_000, reason: 'timeout' })),
    '✗ Bo (agy implement) failed after 45m: timeout',
  );
});

test('cancel and attention read as what they are', () => {
  assert.equal(headline(notice({ kind: 'cancelled', name: 'Cy', provider: 'claude', role: 'implement', durationMs: 125_000 })),
    '■ Cy (claude implement) cancelled after 2m');
  assert.equal(headline(notice({ kind: 'attention', name: 'Di', provider: 'opencode', role: 'research', durationMs: 16 * 60_000 })),
    '! Di (opencode research) needs attention: no progress for 16m');
});

test('rejected checks say so; one file is singular; long runs show hours', () => {
  assert.equal(headline(notice({ name: 'E', provider: 'codex', changedFiles: 1, checks: { passed: 1, total: 2 }, durationMs: 65 * 60_000 })),
    '✓ E (codex) succeeded in 1h05m · 1 file changed · checks 1/2 (rejected)');
});

test('every provider is named as itself; agy is not the default', () => {
  for (const provider of ['codex', 'claude', 'agy', 'opencode']) {
    const text = claudeText([notice({ name: 'W', provider, role: 'review' })]);
    assert.match(text, new RegExp(`^Agent Smith · ✓ W \\(${provider} review\\) succeeded`));
    assert.doesNotMatch(text, /agy-radar/);
  }
  assert.match(headline(notice({ id: 'x-1' })), /^✓ job x-1 succeeded/);
  assert.match(headline(notice({ id: 'implement-1', source: 'agy-staff' })), /^✓ agy-staff job implement-1 succeeded/);
});

test("Claude's text: one job carries its id and the next step, never the worker's summary", () => {
  const text = claudeText([notice({ name: 'Ada', provider: 'codex', role: 'review', summary: 'Found two bugs in parser.ts.' })]);
  assert.equal(text, [
    'Agent Smith · ✓ Ada (codex review) succeeded · no checks. Job ID job-1.',
    'Read it with status before acting.',
  ].join('\n'));
});

test("Claude's text: a batch is one block, counted by outcome, one line per job", () => {
  const text = claudeText([
    notice({ id: 'a', name: 'Ada', provider: 'codex' }),
    notice({ id: 'b', name: 'Bo', provider: 'agy', kind: 'failed', reason: 'exit 1' }),
    notice({ id: 'c', name: 'Cy', provider: 'claude', kind: 'cancelled' }),
  ]);
  const lines = text.split('\n');
  assert.equal(lines[0], 'Agent Smith · 3 jobs: 1 succeeded, 1 failed, 1 cancelled.');
  assert.equal(lines[2], '✗ Bo (agy) failed: exit 1. Job ID b.');
  assert.equal(lines.length, 5);
  assert.equal(lines[4], 'Read them with status before acting.');
});

test('a finished job without checks says so; a pipeline run does not', () => {
  assert.equal(headline(notice({ name: 'Ada', provider: 'codex', role: 'review' })), '✓ Ada (codex review) succeeded · no checks');
  assert.doesNotMatch(headline(notice({ name: 'ship', run: true })), /no checks/);
});

test('a generated name is shown as the job id, with no Job ID sentence', () => {
  const text = claudeText([notice({ id: 'review-smith-1a2b3c4d', name: 'review-1a2b3c4d', provider: 'agy', role: 'review' })]);
  assert.equal(text, [
    'Agent Smith · ✓ review-smith-1a2b3c4d (agy review) succeeded · no checks.',
    'Read it with status before acting.',
  ].join('\n'));
  assert.doesNotMatch(text, /Job ID/);
});

test('a chosen name keeps its identity and the Job ID sentence', () => {
  const text = claudeText([notice({ id: 'review-smith-1a2b3c4d', name: 'Ada', provider: 'agy', role: 'review' })]);
  assert.match(text, /^Agent Smith · ✓ Ada \(agy review\) succeeded · no checks\. Job ID review-smith-1a2b3c4d\.\n/);
});

test('a pipeline run points at pipeline_status and states its stage verdicts', () => {
  const text = claudeText([notice({ id: 'run-1', name: 'ship', role: 'pipeline', run: true, kind: 'failed', reason: 'Pipeline partial; test: execution failed, acceptance rejected.' })]);
  assert.match(text, /^Agent Smith · ✗ ship \(pipeline\) failed\. Run ID run-1\. Pipeline partial/);
  assert.match(text, /pipeline_status/);
});

// ── launch acks ─────────────────────────────────────────────────────────────

test('launch tools match under the plugin and the dev.sh server names, nothing else', () => {
  for (const name of ['spawn_job', 'resume_job', 'run_pipeline']) {
    assert.ok(LAUNCH_TOOL.test(`${PLUGIN}${name}`));
    assert.ok(LAUNCH_TOOL.test(`mcp__agent-smith__${name}`));
  }
  assert.ok(!LAUNCH_TOOL.test(`${PLUGIN}status`));
  assert.ok(!LAUNCH_TOOL.test('mcp__other__spawn_job'));
});

test('parseLaunch reads the id, the repo and the budget from any ack shape', () => {
  const ack = { jobId: 'j1', repo: '/repo/', timeoutMs: 600_000 };
  assert.deepEqual(parseLaunch(`${PLUGIN}spawn_job`, { structuredContent: ack, content: [] }), { kind: 'job', id: 'j1', repo: '/repo', timeoutMs: 600_000 });
  assert.deepEqual(parseLaunch(`${PLUGIN}spawn_job`, [{ type: 'text', text: JSON.stringify({ jobId: 'j2', dir: '/r/.agent-smith/jobs/j2' }) }]),
    { kind: 'job', id: 'j2', repo: '/r', timeoutMs: null });
  assert.deepEqual(parseLaunch(`${PLUGIN}run_pipeline`, { runId: 'r1', recordPath: '/r/.agent-smith/pipelines/r1.json' }),
    { kind: 'run', id: 'r1', repo: '/r', timeoutMs: null });
  assert.equal(parseLaunch(`${PLUGIN}spawn_job`, { isError: true, content: [{ type: 'text', text: JSON.stringify(ack) }] }), null);
  assert.equal(parseLaunch(`${PLUGIN}spawn_job`, { error: 'nope' }), null);
  assert.equal(parseLaunch(`${PLUGIN}status`, ack), null);
});

// ── ownership ───────────────────────────────────────────────────────────────

const launch = (id: string, kind: 'job' | 'run' = 'job') => ({ kind, id, repo: '/repo', timeoutMs: 60_000 });

test('a claim is idempotent: the same launch twice is one entry', () => {
  const once = claim([], launch('j1'), NOW);
  assert.equal(claim(once, launch('j1'), NOW + 5).length, 1);
});

test("only this session's claims are announced, never a neighbour's job in the same repo", () => {
  const owned = claim([], launch('mine'), NOW);
  const jobs = [
    row({ id: 'mine', status: 'succeeded', endedAt: NOW }),
    row({ id: 'theirs', status: 'failed', endedAt: NOW }),
  ];
  const r = due(owned, jobs, new Map(), NOW);
  assert.deepEqual(r.notices.map((n) => n.id), ['mine']);
  assert.deepEqual(r.owned, [], 'announced claims are released');
  assert.deepEqual(due(r.owned, jobs, new Map(), NOW + 3000).notices, [], 'said once');
});

test('a job already terminal at first sight is announced: the claim is the baseline', () => {
  const r = due(claim([], launch('fast'), NOW), [row({ id: 'fast', status: 'failed', endedAt: NOW, failureReason: 'bad flag' })], new Map(), NOW);
  assert.equal(r.notices[0]?.reason, 'bad flag');
});

test('running is silent; a stall is said once, then the ending is said too', () => {
  let owned: Owned[] = claim([], launch('j'), NOW);
  assert.deepEqual(due(owned, [row({ id: 'j' })], new Map(), NOW).notices, []);
  const stalled = due(owned, [row({ id: 'j', status: 'attention', lastEventAt: NOW - 16 * 60_000 })], new Map(), NOW);
  assert.equal(stalled.notices[0]?.kind, 'attention');
  owned = stalled.owned;
  assert.deepEqual(due(owned, [row({ id: 'j', status: 'attention' })], new Map(), NOW).notices, []);
  assert.equal(due(owned, [row({ id: 'j', status: 'succeeded', endedAt: NOW })], new Map(), NOW).notices[0]?.kind, 'finished');
});

test('a pending acceptance verdict holds the notice, but not past the hold', () => {
  const owned = claim([], launch('j'), NOW);
  const pending = row({ id: 'j', status: 'succeeded', endedAt: NOW, acceptance: { pending: true, checks: [] } });
  assert.deepEqual(due(owned, [pending], new Map(), NOW + 1000).notices, []);
  assert.equal(due(owned, [pending], new Map(), NOW + ACCEPTANCE_HOLD_MS + 1).notices.length, 1);
});

test('a claimed run is announced with its stage jobs when it ends, not before', () => {
  const owned = claim([], launch('run-1', 'run'), NOW);
  const record = (status: RunRecord['status'], finishedAt: number | null): RunRecord => ({
    runId: 'run-1', pipeline: 'ship', status, startedAt: NOW - 120_000, finishedAt,
    stageResults: { test: { stage: 'test', status: 'succeeded', acceptance: 'accepted', jobId: 'stage-1' } },
  });
  const stage = row({ id: 'stage-1', status: 'succeeded', endedAt: NOW, name: 'T', provider: 'codex' });
  assert.deepEqual(due(owned, [stage], new Map([['run-1', record('running', null)]]), NOW).notices, [], 'a finished stage waits for its run');
  const r = due(owned, [stage], new Map([['run-1', record('passed', NOW)]]), NOW);
  assert.deepEqual(r.notices.map((n) => n.id), ['run-1', 'stage-1']);
  assert.match(claudeText(r.notices), /✓ ship \(pipeline\) succeeded in 2m\. Run ID run-1\. Pipeline passed; test: execution succeeded, acceptance accepted\./);
});

test('a claim that never shows up expires silently', () => {
  const owned = claim([], launch('ghost'), NOW);
  assert.equal(due(owned, [], new Map(), NOW + 1000).owned.length, 1);
  assert.equal(due(owned, [], new Map(), owned[0]!.until + 1).owned.length, 0);
});

// ── one source of truth ─────────────────────────────────────────────────────

test('the hook (policy) and the mod render the same job in the same words', () => {
  const started = '2026-10-11T11:59:17.000Z';
  const finished = '2026-10-11T12:00:00.000Z';
  const hook = buildBatch([{ knownBefore: true, seen: new Set(), job: {
    id: 'job-ada', name: 'Ada', provider: 'codex', role: 'review', status: 'succeeded', startedAt: started, finishedAt: finished,
    lastEventAt: finished, warned: false, changedFileCount: 2, checks: { passed: 2, total: 2 },
    summarySource: 'worker', latestSummary: 'Two findings.',
  } }], NOW).content;
  const mod = claudeText([noticeFromRadar(row({
    id: 'job-ada', name: 'Ada', provider: 'codex', role: 'review', status: 'succeeded',
    startedAt: Date.parse(started), endedAt: Date.parse(finished), changedFileCount: 2,
    acceptance: { checks: [{ ok: true }, { ok: true }] }, summarySource: 'worker', latestSummary: 'Two findings.',
  }), 'finished', NOW)]);
  assert.equal(hook, mod);
  assert.match(mod, /^Agent Smith · ✓ Ada \(codex review\) succeeded in 43s · 2 files changed · checks 2\/2\. Job ID job-ada\./);
});

test('displayNoticeText strips the Agent Smith prefix, inline Job ID, and instruction footer for the transcript row', () => {
  const single = claudeText([notice({ id: 'implement-smith-6729d530', name: 'smoke-agy', provider: 'agy', role: 'implement', durationMs: 7000, checks: { passed: 1, total: 1 } })]);
  assert.equal(displayNoticeText(single), '✓ smoke-agy (agy implement) succeeded in 7s · checks 1/1');

  const batch = claudeText([
    notice({ id: 'a', name: 'Ada', provider: 'codex' }),
    notice({ id: 'b', name: 'Bo', provider: 'agy', kind: 'failed', reason: 'exit 1' }),
  ]);
  assert.equal(displayNoticeText(batch), [
    '2 jobs: 1 succeeded, 1 failed',
    '✓ Ada (codex) succeeded · no checks',
    '✗ Bo (agy) failed: exit 1',
  ].join('\n'));
});

test('parseSettledRead and unclaim retire a notice once status reads a settled job or run', () => {
  assert.ok(STATUS_TOOL.test(`${PLUGIN}status`));
  assert.ok(STATUS_TOOL.test(`${PLUGIN}pipeline_status`));
  assert.ok(!STATUS_TOOL.test(`${PLUGIN}spawn_job`));

  assert.equal(parseSettledRead(`${PLUGIN}status`, { jobId: 'j1', status: 'running' }), null);
  assert.equal(parseSettledRead(`${PLUGIN}status`, { jobId: 'j1', status: 'succeeded', acceptance: { pending: true } }), null);
  assert.deepEqual(parseSettledRead(`${PLUGIN}status`, { jobId: 'j1', status: 'succeeded', acceptance: { state: 'accepted', pending: false } }), { kind: 'job', id: 'j1' });
  assert.deepEqual(parseSettledRead(`${PLUGIN}pipeline_status`, { runId: 'r1', status: 'passed' }), { kind: 'run', id: 'r1' });

  const owned = claim(claim([], launch('j1'), NOW), launch('j2'), NOW);
  assert.deepEqual(unclaim(owned, { kind: 'job', id: 'j1' }).map((o) => o.id), ['j2']);
});
