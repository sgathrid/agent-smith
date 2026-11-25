import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ACCEPTANCE_HOLD_MS, LAUNCH_TOOL, STATUS_TOOL, type NoticeJob, type NoticeRow, type Owned, type RunRecord,
  claim, claudeText, displayNoticeText, due, headline, noticeFromRadar, parseLaunch, parseLaunches, pipelineOutcome, parseSettledRead, refusesStatusWait, unclaim,
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

test('done names worker, provider, role and duration; checks only when they ran', () => {
  assert.equal(
    headline(notice({ name: 'Ada', provider: 'codex', role: 'review', durationMs: 43_000, changedFiles: 2, checks: { passed: 2, total: 2 } })),
    '✓ Ada (codex review) 43s · done · checks 2/2',
  );
  assert.equal(headline(notice({ name: 'Ada', provider: 'codex', role: 'review' })), '✓ Ada (codex review) · done');
});

test('a steered or follow-up continuation says so honestly, and a dropped queued follow-up is named', () => {
  assert.equal(headline(notice({ name: 'Ada', provider: 'codex', role: 'review', durationMs: 6000, continuationKind: 'steer' })), '✓ Ada (codex review) 6s · done · steered');
  assert.equal(headline(notice({ name: 'Ada', provider: 'codex', role: 'review', durationMs: 6000, continuationKind: 'follow-up' })), '✓ Ada (codex review) 6s · done · follow-up');
  assert.equal(
    headline(notice({ name: 'Ada', provider: 'codex', role: 'review', durationMs: 4000, kind: 'failed', reason: 'timed out', steerNotApplied: true })),
    '✗ Ada (codex review) 4s · failed: timed out · queued follow-up not sent',
  );
  const steered = noticeFromRadar(row({ id: 'j2', name: 'Ada', status: 'succeeded', endedAt: NOW, continuedFrom: 'j1', continuationKind: 'steer' }), 'finished', NOW);
  assert.match(headline(steered), /· done · steered$/);
  const followed = noticeFromRadar(row({ id: 'j2r', name: 'Ada', status: 'succeeded', endedAt: NOW, continuedFrom: 'j1', continuationKind: 'follow-up' }), 'finished', NOW);
  assert.match(headline(followed), /· done · follow-up$/);
  const dropped = noticeFromRadar(row({ id: 'j3', name: 'Ada', status: 'failed', endedAt: NOW, failureReason: 'timed out', warnings: [{ code: 'steer_not_applied' }] }), 'failed', NOW);
  assert.match(headline(dropped), /· queued follow-up not sent$/);
  const quoted = noticeFromRadar(row({ id: 'j5', name: 'Ada', status: 'failed', endedAt: NOW, failureReason: 'timed out',
    warnings: [{ code: 'steer_not_applied', message: '1 queued follow-up not sent: the turn ended failed. "add the edge-case test\nand rerun"' }] }), 'failed', NOW);
  assert.match(headline(quoted), /· queued follow-up not sent: "add the edge-case test"$/);
  assert.doesNotMatch(headline(noticeFromRadar(row({ id: 'j4', status: 'succeeded', endedAt: NOW }), 'finished', NOW)), /steer|follow-up/);
  const discarded = noticeFromRadar(row({ id: 'j6', name: 'Ada', status: 'canceled', endedAt: NOW,
    warnings: [{ code: 'tool_error', message: '2 queued messages discarded by cancel: "add the edge-case test"' }] }), 'cancelled', NOW);
  assert.match(headline(discarded), /· canceled · queued follow-up not sent: "add the edge-case test"$/);
});

test('failure says failed and the short reason', () => {
  assert.equal(
    headline(notice({ kind: 'failed', name: 'Bo', provider: 'agy', role: 'implement', durationMs: 45 * 60_000, reason: 'timed out' })),
    '✗ Bo (agy implement) 45m · failed: timed out',
  );
});

test('canceled and quiet read as what they are: facts, never "stalled"', () => {
  assert.equal(headline(notice({ kind: 'cancelled', name: 'Cy', provider: 'claude', role: 'implement', durationMs: 125_000 })),
    '■ Cy (claude implement) 2m · canceled');
  assert.equal(headline(notice({ kind: 'attention', name: 'Di', provider: 'opencode', role: 'research', durationMs: 16 * 60_000 })),
    '! Di (opencode research) · no output for 16m');
  assert.equal(headline(notice({ kind: 'attention', name: 'Di', provider: 'opencode', role: 'research', durationMs: 16 * 60_000,
    liveness: { state: 'silent', tool: 'npm test' } })), '! Di (opencode research) · no output for 16m (in `npm test`)');
  assert.equal(headline(notice({ kind: 'attention', name: 'Di', provider: 'opencode', role: 'research', durationMs: 3 * 60_000,
    liveness: { state: 'dead' } })), '! Di (opencode research) · process gone 3m');
  const both = claudeText([notice({ id: 'a', kind: 'attention', durationMs: 16 * 60_000 }), notice({ id: 'b', kind: 'attention', liveness: { state: 'dead' } })]);
  assert.match(both, /^Agent Smith · 2 jobs: 1 no output, 1 process gone$/m);
  assert.doesNotMatch(both, /stalled/);
});

test('noticeFromRadar: silent counts from the last event, dead from the last heartbeat', () => {
  const silent = noticeFromRadar(row({ id: 'q', status: 'attention', lastEventAt: NOW - 16 * 60_000,
    liveness: { state: 'silent', silentForMs: 16 * 60_000, since: NOW - 16 * 60_000, tool: 'cargo test' } }), 'attention', NOW);
  assert.equal(headline(silent), '! job q · no output for 16m (in `cargo test`)');
  const dead = noticeFromRadar(row({ id: 'd', status: 'attention', lastEventAt: NOW - 60_000,
    liveness: { state: 'dead', silentForMs: 60_000, since: NOW - 3 * 60_000 } }), 'attention', NOW);
  assert.equal(headline(dead), '! job d · process gone 3m');
});

test('rejected checks are a failure, not done: glyph x and the failed check names', () => {
  assert.equal(headline(notice({ name: 'E', provider: 'codex', checks: { passed: 1, total: 2, failed: ['lint'] }, durationMs: 65 * 60_000 })),
    '✗ E (codex) 1h05m · checks failed: lint');
  assert.equal(headline(notice({ name: 'E', provider: 'codex', checks: { passed: 0, total: 2, failed: ['lint', 'tests'] } })),
    '✗ E (codex) · checks failed: lint +1');
});

test('every provider is named as itself; agy is not the default', () => {
  for (const provider of ['codex', 'claude', 'agy', 'opencode', 'kimi']) {
    const text = claudeText([notice({ name: 'W', provider, role: 'review' })]);
    assert.match(text, new RegExp(`^Agent Smith · ✓ W \\(${provider} review\\) · done`));
  }
  assert.match(headline(notice({ id: 'x-1' })), /^✓ job x-1 · done/);
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

test('launch tools match under the plugin and the dev.sh server names, nothing else', () => {
  for (const name of ['spawn_job', 'follow_up', 'steer', 'run_pipeline']) {
    assert.ok(LAUNCH_TOOL.test(`${PLUGIN}${name}`));
    assert.ok(LAUNCH_TOOL.test(`mcp__agent-smith__${name}`));
  }
  for (const gone of ['resume_job', 'steer_job']) assert.ok(!LAUNCH_TOOL.test(`${PLUGIN}${gone}`), gone);
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

test('a silent job whose process then dies is said again, once, as process gone', () => {
  let owned: Owned[] = claim([], launch('j'), NOW);
  const silent = row({ id: 'j', status: 'attention', lastEventAt: NOW - 16 * 60_000,
    liveness: { state: 'silent', silentForMs: 16 * 60_000, since: NOW - 16 * 60_000 } });
  const first = due(owned, [silent], new Map(), NOW);
  assert.match(headline(first.notices[0]!), /no output for 16m/);
  owned = first.owned;
  const dead = row({ id: 'j', status: 'attention', lastEventAt: NOW - 18 * 60_000,
    liveness: { state: 'dead', silentForMs: 18 * 60_000, since: NOW - 3 * 60_000 } });
  const second = due(owned, [dead], new Map(), NOW);
  assert.equal(second.notices.length, 1);
  assert.match(headline(second.notices[0]!), /process gone 3m/);
  assert.deepEqual(due(second.owned, [dead], new Map(), NOW + 3000).notices, [], 'dead is said once');
});

test('a dead job is said at once, without a silence notice first', () => {
  const owned = claim([], launch('j'), NOW);
  const dead = row({ id: 'j', status: 'attention', lastEventAt: NOW - 60_000,
    liveness: { state: 'dead', silentForMs: 60_000, since: NOW - 3 * 60_000 } });
  const r = due(owned, [dead], new Map(), NOW);
  assert.match(headline(r.notices[0]!), /process gone 3m/);
  assert.deepEqual(due(r.owned, [dead], new Map(), NOW + 3000).notices, []);
});

test('a pending acceptance verdict holds the notice, but not past the hold', () => {
  const owned = claim([], launch('j'), NOW);
  const pending = row({ id: 'j', status: 'succeeded', endedAt: NOW, acceptance: { pending: true, checks: [] } });
  assert.deepEqual(due(owned, [pending], new Map(), NOW + 1000).notices, []);
  assert.equal(due(owned, [pending], new Map(), NOW + ACCEPTANCE_HOLD_MS + 1).notices.length, 1);
});

test('the hold follows the checks budget; past it the notice says exited, checks running, then the verdict follows', () => {
  const owned = claim([], launch('j'), NOW);
  const budget = 20 * 60_000;
  const pending = row({ id: 'j', name: 'Ada', provider: 'codex', role: 'implement', status: 'succeeded', startedAt: NOW - 60_000, endedAt: NOW, acceptance: { pending: true, budgetMs: budget, running: 'ui-suite', checks: [] } });
  assert.deepEqual(due(owned, [pending], new Map(), NOW + ACCEPTANCE_HOLD_MS + 1).notices, []);
  const late = due(owned, [pending], new Map(), NOW + budget + 1);
  assert.equal(late.notices.length, 1);
  const text = claudeText(late.notices);
  assert.match(text, /exited · checks running: ui-suite/);
  assert.doesNotMatch(text, /done|✓/);
  assert.equal(late.owned[0]?.saidExited, true);
  assert.deepEqual(due(late.owned, [pending], new Map(), NOW + budget + 60_000).notices, []);
  const verdict = row({ id: 'j', name: 'Ada', status: 'succeeded', startedAt: NOW - 60_000, endedAt: NOW, acceptance: { checks: [{ ok: true, name: 'ui-suite' }] } });
  const final = due(late.owned, [verdict], new Map(), NOW + budget + 120_000);
  assert.match(claudeText(final.notices), /✓ .*done · checks 1\/1/);
  assert.deepEqual(final.owned, []);
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

test('the hook (policy) and the mod render the same job in the same words', () => {
  const started = '2026-10-11T11:59:17.000Z';
  const finished = '2026-10-11T12:00:00.000Z';
  const hook = buildBatch([{ observedInPriorPoll: true, seen: new Set(), job: {
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
  const read = unclaim(owned, { kind: 'job', id: 'j1' });
  assert.deepEqual(read.map((o) => [o.id, o.readHead]), [['j1', 'j1'], ['j2', undefined]]);
  const after = due(read, [row({ id: 'j1', status: 'succeeded', endedAt: NOW }), row({ id: 'j2', status: 'succeeded', endedAt: NOW })], new Map(), NOW + 1);
  assert.deepEqual(after.notices.map((n) => n.id), ['j2']);
  assert.deepEqual(after.owned, []);
  const runs: Owned[] = [{ kind: 'run', id: 'r1', at: NOW, until: NOW + 1000 }];
  assert.deepEqual(unclaim(runs, { kind: 'run', id: 'r1' }), []);
});

test('due follows supersededBy across turns without announcing the superseded parent or dropping the claim before child appears', () => {
  let owned: Owned[] = claim([], launch('turn-1'), NOW);

  const step1 = due(owned, [row({ id: 'turn-1', status: 'canceled', endedAt: NOW, supersededBy: 'turn-2' })], new Map(), NOW + 1000);
  assert.deepEqual(step1.notices, [], 'superseded parent never fires a notice');
  assert.deepEqual(step1.owned.map((o) => o.id), ['turn-2'], 'transfers and retains child claim even before child row appears');

  const step2 = due(step1.owned, [
    row({ id: 'turn-1', workerId: 'ada', turn: 1, status: 'canceled', endedAt: NOW, supersededBy: 'turn-2' }),
    row({ id: 'turn-2', workerId: 'ada', turn: 2, status: 'running', continuedFrom: 'turn-1', continuationKind: 'steer' }),
  ], new Map(), NOW + 2000);
  assert.deepEqual(step2.notices, []);
  assert.deepEqual(step2.owned.map((o) => o.id), ['turn-2']);

  const step3 = due(step2.owned, [
    row({ id: 'turn-1', workerId: 'ada', turn: 1, status: 'canceled', endedAt: NOW, supersededBy: 'turn-2' }),
    row({ id: 'turn-2', workerId: 'ada', turn: 2, status: 'succeeded', endedAt: NOW + 5000, continuedFrom: 'turn-1', continuationKind: 'steer', name: 'Ada', provider: 'codex' }),
  ], new Map(), NOW + 5000);
  assert.deepEqual(step3.notices.map((n) => n.id), ['turn-2']);
  assert.deepEqual(step3.owned, []);
});

test('claims follow the worker: a follow-up or steer ack extends the one claim, and a settled read records the head it read', () => {
  const spawnAck = parseLaunch(`${PLUGIN}spawn_job`, { jobId: 'turn-1', workerId: 'ada', status: 'running', repo: '/repo', timeoutMs: 60_000 })!;
  assert.equal(spawnAck.workerId, 'ada');
  let owned = claim([], spawnAck, NOW);
  assert.deepEqual(owned.map((o) => [o.id, o.workerId]), [['turn-1', 'ada']]);

  for (const [tool, action, id] of [['follow_up', 'queued', 'turn-1'], ['steer', 'interrupting', 'turn-1'], ['follow_up', 'started', 'turn-2']] as const) {
    const ack = parseLaunch(`${PLUGIN}${tool}`, { jobId: id, workerId: 'ada', status: 'running', action, turn: 2, repo: '/repo', timeoutMs: 60_000 })!;
    assert.deepEqual(ack, { kind: 'job', id, workerId: 'ada', repo: '/repo', timeoutMs: 60_000, ...(action === 'started' ? { startsTurn: true } : {}) }, `${tool} ${action}`);
    owned = claim(owned, ack, NOW + 1000);
    assert.equal(owned.length, 1, 'one claim per worker');
  }

  const settled = parseSettledRead(`${PLUGIN}status`, { jobId: 'turn-1', workerId: 'ada', status: 'succeeded' });
  assert.deepEqual(settled, { kind: 'job', id: 'turn-1', workerId: 'ada' });
  assert.deepEqual(unclaim(owned, settled!).map((o) => [o.id, o.readHead]), [['turn-2', 'turn-1']]);

  const followed = due(
    claim([], spawnAck, NOW),
    [
      row({ id: 'turn-1', workerId: 'ada', turn: 1, status: 'succeeded', startedAt: NOW - 5000, endedAt: NOW, followedBy: 'turn-2' }),
      row({ id: 'turn-2', workerId: 'ada', turn: 2, status: 'running', startedAt: NOW + 1000, continuedFrom: 'turn-1', continuationKind: 'follow-up' }),
    ],
    new Map(),
    NOW + 2000,
  );
  assert.deepEqual(followed.notices, []);
  assert.deepEqual(followed.owned.map((o) => [o.id, o.fromTurn]), [['turn-2', 1]]);
});

describe('one notice per idle transition', () => {
  const ada = (id: string, turn: number, over: Partial<NoticeRow> = {}) =>
    row({ id, workerId: 'ada', turn, name: 'Ada', provider: 'codex', role: 'review', startedAt: NOW + turn * 1000, ...over });
  const spawn = parseLaunch(`${PLUGIN}spawn_job`, { jobId: 't1', workerId: 'ada', status: 'running', repo: '/repo', timeoutMs: 60_000 })!;
  const done = (id: string, turn: number, over: Partial<NoticeRow> = {}) =>
    ada(id, turn, { status: 'succeeded', endedAt: NOW + turn * 1000 + 500, ...over });

  test('two queued follow-ups (turns 1 → 2 → 3 settling) produce exactly one notice', () => {
    let owned = claim([], spawn, NOW);
    for (let i = 0; i < 2; i++) {
      owned = claim(owned, parseLaunch(`${PLUGIN}follow_up`, { jobId: 't1', workerId: 'ada', status: 'running', action: 'queued', repo: '/repo' })!, NOW);
    }
    assert.equal(owned.length, 1);
    const snapshots: NoticeRow[][] = [
      [ada('t1', 1, { pendingMessages: 2 })],
      [done('t1', 1, { followedBy: 't2' })],
      [done('t1', 1, { followedBy: 't2' }), ada('t2', 2, { pendingMessages: 1, continuedFrom: 't1', continuationKind: 'follow-up' })],
      [done('t1', 1, { followedBy: 't2' }), done('t2', 2, { pendingMessages: 1, continuationKind: 'follow-up' })],
      [done('t1', 1, { followedBy: 't2' }), done('t2', 2, { acceptance: { pending: true, checks: [] }, continuationKind: 'follow-up' })],
      [done('t1', 1, { followedBy: 't2' }), done('t2', 2, { followedBy: 't3', continuationKind: 'follow-up' }), ada('t3', 3, { continuationKind: 'follow-up' })],
      [done('t1', 1, { followedBy: 't2' }), done('t2', 2, { followedBy: 't3', continuationKind: 'follow-up' }), done('t3', 3, { continuationKind: 'follow-up' })],
      [done('t1', 1, { followedBy: 't2' }), done('t2', 2, { followedBy: 't3', continuationKind: 'follow-up' }), done('t3', 3, { continuationKind: 'follow-up' })],
    ];
    const said: NoticeJob[] = [];
    snapshots.forEach((rows, i) => {
      const r = due(owned, rows, new Map(), NOW + 10_000 + i * 1000);
      said.push(...r.notices);
      owned = r.owned;
    });
    assert.deepEqual(said.map((n) => n.id), ['t3']);
    assert.equal(headline(said[0]!), '✓ Ada (codex review) 1s · done · follow-up · also ran turns 1–2');
    assert.deepEqual(owned, []);
  });

  test('a follow-up after the worker went idle produces a second notice later', () => {
    let owned = claim([], spawn, NOW);
    const first = due(owned, [done('t1', 1)], new Map(), NOW + 5000);
    assert.deepEqual(first.notices.map((n) => n.id), ['t1']);
    assert.doesNotMatch(headline(first.notices[0]!), /also ran/);
    owned = first.owned;
    assert.deepEqual(owned, []);
    owned = claim(owned, parseLaunch(`${PLUGIN}follow_up`, { jobId: 't2', workerId: 'ada', status: 'running', action: 'started', turn: 2, repo: '/repo' })!, NOW + 6000);
    const early = due(owned, [done('t1', 1)], new Map(), NOW + 6500);
    assert.deepEqual(early.notices, []);
    assert.deepEqual(early.owned.map((o) => o.id), ['t2']);
    owned = early.owned;
    const running = due(owned, [done('t1', 1, { followedBy: 't2' }), ada('t2', 2, { continuationKind: 'follow-up' })], new Map(), NOW + 7000);
    assert.deepEqual(running.notices, []);
    const second = due(running.owned, [done('t1', 1, { followedBy: 't2' }), done('t2', 2, { continuationKind: 'follow-up' })], new Map(), NOW + 9000);
    assert.deepEqual(second.notices.map((n) => n.id), ['t2']);
    assert.match(headline(second.notices[0]!), /· done · follow-up$/);
  });

  test("a settled read of an earlier turn while a follow-up runs does not swallow the worker's notice", () => {
    let owned = claim([], spawn, NOW);
    owned = due(owned, [done('t1', 1, { followedBy: 't2' }), ada('t2', 2)], new Map(), NOW + 3000).owned;
    owned = unclaim(owned, parseSettledRead(`${PLUGIN}status`, { jobId: 't1', workerId: 'ada', status: 'succeeded' })!);
    const r = due(owned, [done('t1', 1, { followedBy: 't2' }), done('t2', 2)], new Map(), NOW + 5000);
    assert.deepEqual(r.notices.map((n) => n.id), ['t2']);
    const again = unclaim(claim([], spawn, NOW), { kind: 'job', id: 't1', workerId: 'ada' });
    assert.deepEqual(due(again, [done('t1', 1)], new Map(), NOW + 5000).notices, []);
  });

  test('a new turn started after a settled read moves the claim to it: no "also ran" for the turn already read', () => {
    let owned = claim([], spawn, NOW);
    owned = due(owned, [ada('t1', 1)], new Map(), NOW + 500).owned;
    owned = unclaim(owned, parseSettledRead(`${PLUGIN}status`, { jobId: 't1', workerId: 'ada', status: 'succeeded' })!);
    owned = claim(owned, parseLaunch(`${PLUGIN}follow_up`, { jobId: 't2', workerId: 'ada', status: 'running', action: 'started', turn: 2, repo: '/repo' })!, NOW + 2000);
    assert.deepEqual(owned.map((o) => [o.id, o.fromTurn, o.readHead]), [['t2', undefined, undefined]]);
    const r = due(owned, [done('t1', 1, { followedBy: 't2' }), done('t2', 2, { continuationKind: 'follow-up' })], new Map(), NOW + 5000);
    assert.equal(headline(r.notices[0]!), '✓ Ada (codex review) 1s · done · follow-up');
  });

  test('a failed turn whose checks placeholder never settled is announced once and released', () => {
    const failed = ada('t1', 1, { status: 'failed', endedAt: NOW, failureReason: 'exit 1', acceptance: { pending: true, budgetMs: 1000, checks: [] } });
    const r = due(claim([], spawn, NOW), [failed], new Map(), NOW + 5000);
    assert.deepEqual(r.notices.map((n) => [n.id, n.kind]), [['t1', 'failed']]);
    assert.deepEqual(r.owned, []);
  });

  test('a failed turn with a queued follow-up not sent is announced once, quoting it', () => {
    const r = due(claim([], spawn, NOW), [ada('t1', 1, { status: 'failed', endedAt: NOW + 1500, failureReason: 'timed out',
      warnings: [{ code: 'steer_not_applied', message: '1 queued follow-up not sent: the turn ended failed. "rerun the tests"' }] })], new Map(), NOW + 3000);
    assert.equal(r.notices.length, 1);
    assert.match(headline(r.notices[0]!), /failed: timed out · queued follow-up not sent: "rerun the tests"$/);
  });
});

test('owned pipeline reports a stalled stage once while the pipeline keeps running', () => {
  const owned: Owned[] = [{ kind: 'run', id: 'run', at: NOW - 1000, until: NOW + 100000 }];
  const runs = new Map<string, RunRecord>([['run', { runId: 'run', pipeline: 'ship', status: 'running', startedAt: NOW - 1000,
    finishedAt: null, stageResults: { build: { stage: 'build', status: 'running', jobId: 'stage' } } }]]);
  const jobs = [row({ id: 'stage', status: 'attention', lastEventAt: NOW - 16 * 60_000 })];
  const first = due(owned, jobs, runs, NOW);
  assert.equal(first.notices[0]?.kind, 'attention');
  assert.equal(first.notices[0]?.id, 'stage');
  assert.equal(first.owned[0]?.kind, 'run');
  assert.deepEqual(due(first.owned, jobs, runs, NOW + 1).notices, []);
});

test('failure notice includes the provider diagnostic rather than only its category', () => {
  const n = noticeFromRadar(row({ id: 'quota', status: 'failed', failureReason: 'out of credits', failureDetail: 'HTTP 402: payment required for opencode/deepseek' }), 'failed', NOW);
  assert.match(claudeText([n]), /402: payment required/);
});

test('parseLaunches yields one launch per started variant and skips failed or terminal items', () => {
  const tool = `${PLUGIN}spawn_job`;
  const ack = (id: string) => ({ jobId: id, status: 'running', repo: '/repo/', timeoutMs: 1000 });
  const variants = { jobs: [ack('a'), { name: 'Bad', error: 'boom' }, ack('b'), { jobId: 'c', status: 'succeeded' }] };
  assert.deepEqual(parseLaunches(tool, { structuredContent: variants, content: [] }).map((l) => l.id), ['a', 'b']);
  assert.deepEqual(parseLaunches(tool, [{ type: 'text', text: JSON.stringify(variants) }])[0], { kind: 'job', id: 'a', repo: '/repo', timeoutMs: 1000 });
  assert.deepEqual(parseLaunches(tool, { jobs: [{ name: 'x', error: 'e' }] }), []);
  assert.deepEqual(parseLaunches(tool, ack('s')), [parseLaunch(tool, ack('s'))]);
  assert.deepEqual(parseLaunches(`${PLUGIN}run_pipeline`, { runId: 'r1', repo: '/r' }).map((l) => l.id), ['r1']);
  assert.deepEqual(parseLaunches(tool, { error: 'nope' }), []);
  assert.deepEqual(parseLaunches(tool, { jobId: 'j', status: 'succeeded' }), []);
  assert.deepEqual(parseLaunches(`${PLUGIN}status`, variants), []);
});

test('parseSettledRead reads a cancel only when it settled', () => {
  const cancel = `${PLUGIN}cancel`;
  assert.ok(STATUS_TOOL.test(cancel));
  assert.deepEqual(parseSettledRead(cancel, { jobId: 'j1', status: 'canceled', settled: true }), { kind: 'job', id: 'j1' });
  const resolved = parseSettledRead(cancel, { structuredContent: { jobId: 'j1', status: 'canceled', settled: true, resolvedFrom: 'j0' }, content: [] });
  assert.deepEqual(resolved, { kind: 'job', id: 'j1', resolvedFrom: 'j0' });
  assert.deepEqual(unclaim(claim(claim([], launch('j0'), NOW), launch('j2'), NOW), resolved!).map((o) => [o.id, o.readHead]), [['j0', 'j1'], ['j2', undefined]]);
  assert.equal(parseSettledRead(cancel, { jobId: 'j1', status: 'canceling', settled: false }), null);
  assert.equal(parseSettledRead(cancel, { jobId: 'j1', status: 'canceled' }), null);
  assert.deepEqual(parseSettledRead(cancel, { runId: 'r1', status: 'canceled', settled: true }), { kind: 'run', id: 'r1' });
  assert.equal(parseSettledRead(cancel, { runId: 'r1', status: 'canceling', settled: false }), null);
  assert.equal(parseSettledRead(cancel, { error: 'unknown job', settled: true }), null);
});

test('noticeFromRadar uses chainStartedAt for steered chains and per-turn startedAt on resumes', () => {
  const steered = noticeFromRadar(row({
    id: 't2', status: 'succeeded',
    startedAt: NOW - 6_000, endedAt: NOW,
    chainStartedAt: NOW - 120_000, continuationKind: 'follow-up',
  }), 'finished', NOW);
  assert.equal(steered.durationMs, 120_000);
  const resumed = noticeFromRadar(row({
    id: 't3', status: 'succeeded',
    startedAt: NOW - 6_000, endedAt: NOW,
    chainStartedAt: NOW - 6_000, continuationKind: 'follow-up',
  }), 'finished', NOW);
  assert.equal(resumed.durationMs, 6_000);
});

describe('refusesStatusWait', () => {
  const job = (status: string) => ({ id: 'job-1', workerId: 'w-1', name: 'links1-neon', status, startedAt: NOW, endedAt: null }) as any;
  const owned: Owned[] = [{ kind: 'job', id: 'job-1', workerId: 'w-1', at: NOW, until: NOW + 1000 }];
  for (const id of ['links1-neon', 'job-1', 'w-1']) {
    test(`refuses an owned live worker addressed as ${id}`, () => {
      assert.equal(refusesStatusWait(owned, [job('running')], id), true);
    });
  }
  test('passes a worker this session holds no notice for', () => {
    assert.equal(refusesStatusWait([], [job('running')], 'job-1'), false);
  });
  test('passes an owned worker that has settled', () => {
    assert.equal(refusesStatusWait(owned, [job('succeeded')], 'job-1'), false);
  });
});
