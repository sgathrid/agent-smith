/**
 * Completion notices: the words, the launch acks, and which jobs a session may
 * announce. The mod and the PostToolUse hook both render through notice.ts, so
 * the last test checks they produce identical text for the same job.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ACCEPTANCE_HOLD_MS, LAUNCH_TOOL, STATUS_TOOL, type NoticeJob, type NoticeRow, type Owned, type RunRecord,
  claim, claudeText, displayNoticeText, due, headline, noticeFromRadar, parseLaunch, pipelineOutcome, parseSettledRead, unclaim,
} from '../hooks/notice.ts';
import { buildBatch } from '../../channel/src/policy.ts';

const NOW = Date.parse('2026-10-11T12:00:00Z');
const PLUGIN = 'mcp__plugin_agent-smith_agent-smith__';

test('MCP Tasks handles and final results do not claim legacy completion notices', () => {
  const tool = `${PLUGIN}spawn_job`;
  assert.equal(parseLaunch(tool, { resultType: 'task', taskId: 't', status: 'working' }), null);
  assert.equal(parseLaunch(tool, {
    _meta: { 'io.agent-smith/task-result': true }, structuredContent: { jobId: 'j', status: 'succeeded' },
  }), null);
  assert.equal(parseLaunch(tool, { jobId: 'j', status: 'succeeded', report: 'done' }), null);
  assert.equal(parseLaunch(tool, { jobId: 'j', status: 'running' })?.id, 'j');
});

function row(over: Partial<NoticeRow> & { id: string }): NoticeRow {
  return { status: 'running', startedAt: NOW - 60_000, endedAt: null, lastEventAt: NOW - 1000, ...over };
}
function notice(over: Partial<NoticeJob>): NoticeJob {
  return { id: 'job-1', kind: 'finished', ...over };
}

// ── the words ───────────────────────────────────────────────────────────────

test('done names worker, provider, role and duration; checks only when they ran', () => {
  assert.equal(
    headline(notice({ name: 'Ada', provider: 'codex', role: 'review', durationMs: 43_000, changedFiles: 2, checks: { passed: 2, total: 2 } })),
    '✓ Ada (codex review) 43s · done · checks 2/2',
  );
  assert.equal(headline(notice({ name: 'Ada', provider: 'codex', role: 'review' })), '✓ Ada (codex review) · done');
});

test('failure says failed and the short reason', () => {
  assert.equal(
    headline(notice({ kind: 'failed', name: 'Bo', provider: 'agy', role: 'implement', durationMs: 45 * 60_000, reason: 'timed out' })),
    '✗ Bo (agy implement) 45m · failed: timed out',
  );
});

test('canceled and stalled read as what they are', () => {
  assert.equal(headline(notice({ kind: 'cancelled', name: 'Cy', provider: 'claude', role: 'implement', durationMs: 125_000 })),
    '■ Cy (claude implement) 2m · canceled');
  assert.equal(headline(notice({ kind: 'attention', name: 'Di', provider: 'opencode', role: 'research', durationMs: 16 * 60_000 })),
    '! Di (opencode research) · stalled 16m');
});

test('rejected checks are a failure, not done: glyph x and the failed check names', () => {
  assert.equal(headline(notice({ name: 'E', provider: 'codex', checks: { passed: 1, total: 2, failed: ['lint'] }, durationMs: 65 * 60_000 })),
    '✗ E (codex) 1h05m · checks failed: lint');
  assert.equal(headline(notice({ name: 'E', provider: 'codex', checks: { passed: 0, total: 2, failed: ['lint', 'tests'] } })),
    '✗ E (codex) · checks failed: lint +1');
});

test('every provider is named as itself; agy is not the default', () => {
  for (const provider of ['codex', 'claude', 'agy', 'opencode']) {
    const text = claudeText([notice({ name: 'W', provider, role: 'review' })]);
    assert.match(text, new RegExp(`^Agent Smith · ✓ W \\(${provider} review\\) · done`));
    assert.doesNotMatch(text, /agy-radar/);
  }
  assert.match(headline(notice({ id: 'x-1' })), /^✓ job x-1 · done/);
  assert.match(headline(notice({ id: 'implement-1', source: 'agy-staff' })), /^✓ agy-staff job implement-1 · done/);
});

test("Claude's text: the user's failed job is one short line, then how to read it", () => {
  const job = noticeFromRadar(row({
    id: 'implement-smith-6b456b3d', name: 'pp-engine', provider: 'agy', role: 'implement', status: 'failed',
    startedAt: NOW - 21 * 60_000, endedAt: NOW, changedFileCount: 8,
    failureReason: 'worker soft-denied 1 tool action(s) (view_file) — it exited 0 and reported success while doing nothing. This is NOT a clean success.',
  }), 'failed', NOW);
  const text = claudeText([job]);
  assert.equal(text, [
    'Agent Smith · ✗ pp-engine (agy implement) 21m · failed: denied view_file',
    'status implement-smith-6b456b3d',
  ].join('\n'));
  assert.equal(displayNoticeText(text), 'Agent Smith · ✗ pp-engine (agy implement) 21m · failed: denied view_file');
});

test('an old job with only the long error text gets the same short reason', () => {
  const old = (failureReason: string) => noticeFromRadar(row({ id: 'j', name: 'A', provider: 'codex', status: 'failed', endedAt: NOW, failureReason }), 'failed', NOW);
  assert.equal(old('supervisor process exited before the job finished (orphaned)').reason, 'server stopped');
  assert.equal(old('The worker exceeded the 30m budget').reason, 'timed out');
  assert.equal(old('exited with code 2').reason, 'exit 2');
  assert.equal(old('exit 1').reason, 'exit 1');
});

test('checks rejected after a clean execution: failed glyph, failed check names', () => {
  const job = noticeFromRadar(row({
    id: 'job-9', name: 'Ada', provider: 'codex', role: 'implement', status: 'succeeded', endedAt: NOW, startedAt: NOW - 120_000,
    acceptance: { checks: [{ ok: true, name: 'tests' }, { ok: false, name: 'lint' }] },
  }), 'finished', NOW);
  assert.equal(claudeText([job]), 'Agent Smith · ✗ Ada (codex implement) 2m · checks failed: lint\nstatus job-9');
});

test("Claude's text: a batch is one block, counted by outcome, one line per job", () => {
  const text = claudeText([
    notice({ id: 'a', name: 'Ada', provider: 'codex' }),
    notice({ id: 'b', name: 'Bo', provider: 'agy', kind: 'failed', reason: 'exit 1' }),
    notice({ id: 'c', name: 'Cy', provider: 'claude', kind: 'cancelled' }),
  ]);
  assert.equal(text, [
    'Agent Smith · 3 jobs: 1 done, 1 failed, 1 canceled',
    '✓ Ada (codex) · done',
    '✗ Bo (agy) · failed: exit 1',
    '■ Cy (claude) · canceled',
    'status a, b, c',
  ].join('\n'));
});

test('a generated name is shown as the job id', () => {
  const text = claudeText([notice({ id: 'review-smith-1a2b3c4d', name: 'review-1a2b3c4d', provider: 'agy', role: 'review' })]);
  assert.equal(text, [
    'Agent Smith · ✓ review-smith-1a2b3c4d (agy review) · done',
    'status review-smith-1a2b3c4d',
  ].join('\n'));
});

test('a pipeline run points at pipeline_status and states its stages', () => {
  const text = claudeText([notice({ id: 'run-1', name: 'ship', role: 'pipeline', run: true, kind: 'failed', durationMs: 120_000, reason: '1/2 stages passed · test: checks failed: lint' })]);
  assert.equal(text, [
    'Agent Smith · ✗ ship 2m · 1/2 stages passed · test: checks failed: lint',
    'pipeline_status run-1',
  ].join('\n'));
});

test('pipelineOutcome names the first stage that did not pass, in the short words', () => {
  const record = (stageResults: RunRecord['stageResults']): RunRecord => ({
    runId: 'r', pipeline: 'ship', status: 'partial', startedAt: 0, finishedAt: 1, stageResults,
  });
  assert.equal(pipelineOutcome(record({
    plan: { stage: 'plan', status: 'passed', acceptance: 'passed' },
    test: { stage: 'test', status: 'passed', acceptance: 'failed', verification: { failing: [{ check: { name: 'lint' } }] } },
  })), '1/2 stages passed · test: checks failed: lint');
  assert.equal(pipelineOutcome(record({
    build: { stage: 'build', status: 'failed', failure: { code: 'exit-1', message: 'worker soft-denied 1 tool action(s) (view_file)' } },
  })), '0/1 stages passed · build: denied view_file');
  assert.equal(pipelineOutcome(record({ a: { stage: 'a', status: 'passed' } })), '1/1 stages passed');
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
    stageResults: { test: { stage: 'test', status: 'passed', acceptance: 'passed', jobId: 'stage-1' } },
  });
  const stage = row({ id: 'stage-1', status: 'succeeded', endedAt: NOW, name: 'T', provider: 'codex' });
  assert.deepEqual(due(owned, [stage], new Map([['run-1', record('running', null)]]), NOW).notices, [], 'a finished stage waits for its run');
  const r = due(owned, [stage], new Map([['run-1', record('passed', NOW)]]), NOW);
  assert.deepEqual(r.notices.map((n) => n.id), ['run-1', 'stage-1']);
  assert.match(claudeText(r.notices), /✓ ship 2m · 1\/1 stages passed/);
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
    lastEventAt: finished, warned: false, changedFileCount: 2, staleReads: ['ARCHITECTURE.md', 'brief.md'], checks: { passed: 2, total: 2 },
    summarySource: 'worker', latestSummary: 'Two findings.',
  } }], NOW).content;
  const mod = claudeText([noticeFromRadar(row({
    id: 'job-ada', name: 'Ada', provider: 'codex', role: 'review', status: 'succeeded',
    startedAt: Date.parse(started), endedAt: Date.parse(finished), changedFileCount: 2, staleReads: ['ARCHITECTURE.md', 'brief.md'],
    acceptance: { checks: [{ ok: true }, { ok: true }] }, summarySource: 'worker', latestSummary: 'Two findings.',
  }), 'finished', NOW)]);
  assert.equal(hook, mod);
  assert.match(mod, /^Agent Smith · ✓ Ada \(codex review\) 43s · done · checks 2\/2 · stale brief: ARCHITECTURE\.md \+1\nstatus job-ada$/);
});

test('displayNoticeText keeps the notice lines and drops the line for Claude', () => {
  const single = claudeText([notice({ id: 'implement-smith-6729d530', name: 'smoke-agy', provider: 'agy', role: 'implement', durationMs: 7000, checks: { passed: 1, total: 1 } })]);
  assert.equal(displayNoticeText(single), 'Agent Smith · ✓ smoke-agy (agy implement) 7s · done · checks 1/1');

  const batch = claudeText([
    notice({ id: 'a', name: 'Ada', provider: 'codex' }),
    notice({ id: 'b', name: 'Bo', provider: 'agy', kind: 'failed', reason: 'exit 1' }),
  ]);
  assert.equal(displayNoticeText(batch), [
    'Agent Smith · 2 jobs: 1 done, 1 failed',
    '✓ Ada (codex) · done',
    '✗ Bo (agy) · failed: exit 1',
  ].join('\n'));
});

test('displayNoticeText drops the host frame Claude Code wraps around a plugin prompt', () => {
  const body = claudeText([notice({ id: 'implement-smith-eaf379dd', name: 'pp-docs', provider: 'agy', role: 'implement', durationMs: 300_000 })]);
  for (const [header, footer] of [
    ['The agent-smith plugin sent a message:', "This is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above."],
    ['The agent-smith plugin sent a message while you were working:', 'This is how Claude Code surfaces prompts a plugin submits mid-turn — within the running turn, often alongside the next tool result. Address the message above as you continue this turn.'],
  ]) {
    const framed = `${header}\n${body.split('\n').map((l) => `  ${l}`).join('\n')}\n\n  ${footer}`;
    assert.equal(displayNoticeText(framed), displayNoticeText(body));
  }
  assert.equal(displayNoticeText(body), 'Agent Smith · ✓ pp-docs (agy implement) 5m · done');
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

test('due follows supersededBy across turns without announcing the superseded parent or dropping the claim before child appears', () => {
  let owned: Owned[] = claim([], launch('turn-1'), NOW);

  // Case 1: parent is superseded, child anchor is not visible in rows yet -> claim transfers to child and is held until child appears
  const step1 = due(owned, [row({ id: 'turn-1', status: 'canceled', endedAt: NOW, supersededBy: 'turn-2' })], new Map(), NOW + 1000);
  assert.deepEqual(step1.notices, [], 'superseded parent never fires a notice');
  assert.deepEqual(step1.owned.map((o) => o.id), ['turn-2'], 'transfers and retains child claim even before child row appears');

  // Case 2: child appears running -> claim transfers to child with refreshed budget
  const step2 = due(step1.owned, [
    row({ id: 'turn-1', status: 'canceled', endedAt: NOW, supersededBy: 'turn-2' }),
    row({ id: 'turn-2', status: 'running', steeredFrom: 'turn-1' }),
  ], new Map(), NOW + 2000);
  assert.deepEqual(step2.notices, []);
  assert.deepEqual(step2.owned.map((o) => o.id), ['turn-2']);

  // Case 3: child finishes -> single completion notice fires for turn-2
  const step3 = due(step2.owned, [
    row({ id: 'turn-1', status: 'canceled', endedAt: NOW, supersededBy: 'turn-2' }),
    row({ id: 'turn-2', status: 'succeeded', endedAt: NOW + 5000, steeredFrom: 'turn-1', name: 'Ada', provider: 'codex' }),
  ], new Map(), NOW + 5000);
  assert.deepEqual(step3.notices.map((n) => n.id), ['turn-2']);
  assert.deepEqual(step3.owned, []);
});
