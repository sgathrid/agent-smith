import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rowBudget } from '../hooks/band.ts';
import { CHILD_INDENT, childRow, foldText, planBand, tokenColumn, treeColumns, type BandEntry } from '../hooks/band-team.ts';
import { buildLine } from '../hooks/band.ts';
import { fitBandColumns, fitCell, jobDetail, jobLabel } from '../hooks/format.ts';
import { memberRow, teamColumns } from '../hooks/team-view.ts';
import { memberGlyph, memberMark, settleTeam, shortModel, sortMembers, teamCounts, teamHeaderLine, teamPhrase } from '../hooks/team.ts';
import type { RadarJob, Team, TeamMember } from '../types/index.d.ts';

const NOW = 1_000_000_000;

function member(name: string, over: Partial<TeamMember> = {}): TeamMember {
  return {
    id: name, name, role: 'worker', model: null, modelLabel: null, task: null, state: 'working', activity: null,
    toolCount: 0, tokensOut: null, startedAt: NOW - 60_000, lastEventAt: NOW - 1000, lastPost: null, ...over,
  };
}

const team = (members: TeamMember[]): Team => ({ schema: 1, source: 'agy-swarm', title: null, boardHead: null, members, updatedAt: NOW });

let seq = 0;
function job(over: Partial<RadarJob> = {}): RadarJob {
  seq += 1;
  const id = over.id ?? `implement-job${seq}`;
  return {
    id, workerId: id, turn: 1, status: 'running', startedAt: NOW - 600_000, endedAt: null, toolCount: null, activity: '', task: '',
    warnings: [], report: null, reasoning: null, raw: {}, ...over,
  };
}

const shape = (entries: readonly BandEntry[]): string[] =>
  entries.map((e) => e.kind === 'job' ? `job:${e.job.id}` : e.kind === 'member' ? `m:${e.member.name}` : `fold:${e.hidden.length}`);

test('no team: the plan is exactly the old row budget', () => {
  const shown = [job(), job(), job(), job(), job()];
  const plan = planBand(shown);
  const budget = rowBudget(shown);
  assert.deepEqual(plan.entries.map((e) => e.job.id), budget.rows.map((j) => j.id));
  assert.equal(plan.hidden, budget.hidden);
});

test('leftover rows go to the team: working members first, one fold for the rest', () => {
  const a = job({ id: 'a', team: team([member('idle', { state: 'waiting' }), member('busy'), member('busy2', { lastEventAt: NOW - 5000 }), member('idle2', { state: 'waiting' })]) });
  assert.deepEqual(shape(planBand([a, job({ id: 'b' })]).entries), ['job:a', 'm:busy', 'fold:3', 'job:b']);
  assert.deepEqual(shape(planBand([a]).entries), ['job:a', 'm:busy', 'm:busy2', 'fold:2']);
});

test('a team that fits gets one row per member and the last closes the tree', () => {
  const a = job({ id: 'a', team: team([member('x'), member('y')]) });
  const plan = planBand([a, job({ id: 'b' })]);
  assert.deepEqual(shape(plan.entries), ['job:a', 'm:x', 'm:y', 'job:b']);
  const lasts = plan.entries.filter((e) => e.kind === 'member').map((e) => e.kind === 'member' && e.last);
  assert.deepEqual(lasts, [false, true]);
});

test('workers keep their rows first: one spare row buys no children, and a fold never stands for one', () => {
  const a = job({ id: 'a', team: team([member('x'), member('y'), member('z')]) });
  assert.deepEqual(shape(planBand([a, job({ id: 'b' }), job({ id: 'c' })]).entries), ['job:a', 'job:b', 'job:c']);
  for (let rows = 2; rows <= 5; rows += 1) {
    for (const e of planBand([a], rows).entries) if (e.kind === 'fold') assert.ok(e.hidden.length >= 2);
  }
  assert.equal(planBand([a]).entries.length, 4);
});

test('the cap and the hidden-worker count are unchanged by children', () => {
  const t = team([member('x'), member('y')]);
  const shown = [job({ team: t }), job(), job(), job(), job(), job()];
  const plan = planBand(shown, 10);
  assert.equal(plan.entries.length, 4);
  assert.equal(plan.hidden, 2);
  assert.ok(planBand(shown, 3).entries.length <= 2);
  assert.ok(planBand([job({ team: t })], 3).entries.length <= 2);
});

test('only a live worker, or one whose checks are pending, shows children', () => {
  const t = team([member('x'), member('y')]);
  assert.equal(planBand([job({ status: 'succeeded', endedAt: NOW, team: t })]).entries.length, 1);
  assert.equal(planBand([job({ status: 'succeeded', endedAt: NOW, team: t, acceptance: { state: 'pending', pending: true, checks: [] } as never })]).entries.length, 3);
  assert.equal(planBand([job({ team: team([]) })]).entries.length, 1);
});

test('the fold names counts by state, biggest first, and the newest post among the hidden', () => {
  const hidden = [
    member('a', { state: 'waiting', lastPost: { seq: 9, text: 'x' } }),
    member('hydro-681', { state: 'waiting', lastPost: { seq: 13, text: 'y' } }),
    member('c', { state: 'working' }),
    member('d', { state: 'waiting' }),
  ];
  assert.equal(foldText(hidden), '✓ 2 reported ∙ ⏺ 1 working ∙ ○ 1 waiting ∙ hydro-681 posted #13');
  assert.equal(foldText([member('p'), member('q', { state: 'done' })]), '⏺ 1 working ∙ ○ 1 done');
});

test('a child row: glyph, name, activity or task, elapsed and tokens; settled members stop their clock', () => {
  const cols = { label: 20, detail: 30 };
  const busy = member('neon-core', { activity: 'git show note.rs', tokensOut: 219_000 });
  const entries: BandEntry[] = [
    { kind: 'member', job: job(), member: busy, last: false },
    { kind: 'member', job: job(), member: member('asked', { state: 'waiting', activity: null, task: 'port the ui', startedAt: NOW - 120_000, lastEventAt: NOW - 90_000 }), last: true },
  ];
  const tw = tokenColumn(entries);
  const [r1, r2] = entries.map((e) => childRow(e as never, NOW, cols, tw));
  assert.match(r1!.plain, /^├ ⏺ neon-core\s+git show note\.rs\s+ 1m00s ∙ ↓ 219k$/);
  assert.match(r2!.plain, /^└ ○ asked\s+port the ui\s+30s$/);
  assert.equal(r1!.bold, true);
  assert.equal(r2!.dim, true);
});

test('child rows share the job row right edge at every width, and never overflow', () => {
  const t = team([member('neon-core', { activity: 'git show …/note_reading.rs', tokensOut: 219_000 }), member('b', { tokensOut: 1_200_000, activity: 'x'.repeat(100) })]);
  const j = job({ name: 'stack-swarm-neon', team: t });
  const entries = planBand([j]).entries;
  const tw = tokenColumn(entries);
  for (let width = 37; width <= 197; width += 8) {
    const cols = fitBandColumns(width, 18);
    for (const e of entries) {
      if (e.kind !== 'member') continue;
      const row = childRow(e, NOW, cols, tw);
      const text = `${row.tree} ${row.glyph} ${row.label}${row.detail === '' ? '' : ` ${row.detail}`} ${row.right}`;
      assert.ok(text.length <= width, `${width}: ${text.length}`);
    }
  }
});

test('the parent detail leads with the team phrase, and a swarm wait replaces it with the count', () => {
  const t = team([member('a'), member('b', { state: 'waiting' }), member('c', { state: 'waiting' })]);
  assert.equal(jobDetail(job({ activity: 'editing x', team: t }), { tools: false }), '1/3 agents working ∙ editing x');
  assert.equal(jobDetail(job({ activity: 'Swarm_Wait', team: t }), { tools: false }), 'waiting on 1 of 3 agents');
  assert.equal(jobDetail(job({ activity: 'waiting on team', team: t }), { tools: false }), 'waiting on 1 of 3 agents');
  const inTool = job({ activity: 'running swarm_wait', liveness: { state: 'in-tool', tool: 'swarm_wait', silentForMs: 0, since: 0, forMs: 120_000 }, team: t });
  assert.equal(jobDetail(inTool, { tools: false }), 'waiting on 1 of 3 agents');
  const silent = job({ activity: 'swarm_wait', liveness: { state: 'silent', silentForMs: 300_000, since: 0, forMs: 300_000 }, team: t });
  assert.equal(jobDetail(silent, { tools: false }), 'waiting on 1 of 3 agents ∙ no output 5m');
  assert.equal(jobDetail(job({ activity: 'swarm_wait' }), { tools: false }), 'swarm_wait');
});

test('settleTeam: a member is working only while the run is live and it has acted since the run began', () => {
  const t = team([
    member('early', { lastEventAt: NOW - 10_000 }),
    member('late', { lastEventAt: NOW + 5_000 }),
    member('silent', { lastEventAt: null }),
    member('new', { lastEventAt: null, startedAt: null }),
    member('idle', { state: 'waiting', lastEventAt: NOW - 10_000 }),
    member('gone', { state: 'killed', lastEventAt: NOW - 10_000 }),
    member('fin', { state: 'done', lastEventAt: NOW - 10_000 }),
  ]);
  const states = (x: Team) => x.members.map((m) => `${m.name}:${m.state}`);
  assert.deepEqual(states(settleTeam(t, { live: false, startedAt: NOW })),
    ['early:stopped', 'late:stopped', 'silent:stopped', 'new:stopped', 'idle:waiting', 'gone:killed', 'fin:done'], 'a finished run has no working member');
  assert.deepEqual(states(settleTeam(t, { live: true, startedAt: NOW })),
    ['early:stopped', 'late:working', 'silent:stopped', 'new:working', 'idle:waiting', 'gone:killed', 'fin:done'], 'a live run keeps only members that acted since it began');
  const fresh = team([member('late', { lastEventAt: NOW + 5_000 }), member('idle', { state: 'waiting' })]);
  assert.equal(settleTeam(fresh, { live: true, startedAt: NOW }), fresh, 'unchanged team is the same object');
  assert.equal(settleTeam(t, { live: true, startedAt: null }).members[0]!.state, 'working', 'no known start: nothing predates it');
});

test('stopped members read stopped in the header, the phrase, the fold, the glyph and the order', () => {
  const t = team([member('a', { state: 'stopped' }), member('b', { state: 'stopped' }), member('c', { state: 'waiting' })]);
  assert.equal(teamHeaderLine(t), 'Team 3 · 1 waiting · 2 stopped');
  assert.equal(teamPhrase(team([member('a', { state: 'stopped' })])), '1 agent stopped');
  assert.equal(foldText(t.members), '○ 2 stopped ∙ ○ 1 waiting');
  assert.equal(memberGlyph('stopped'), '○');
  assert.deepEqual(sortMembers([member('w', { state: 'waiting' }), member('s', { state: 'stopped' }), member('x')]).map((m) => m.name), ['x', 's', 'w']);
});

const posted = (name: string, over: Partial<TeamMember> = {}): TeamMember =>
  member(name, { state: 'waiting', lastPost: { seq: 3, text: 'x' }, ...over });

test('a waiting member that has posted reads reported; the data keeps agy\'s state', () => {
  assert.equal(memberMark(posted('a')), 'reported');
  assert.equal(memberMark(member('m', { state: 'waiting' })), 'waiting');
  assert.equal(memberMark(member('w', { lastPost: { seq: 1, text: 'x' } })), 'working');
  assert.equal(memberGlyph('reported'), '✓');
  assert.equal(memberGlyph('waiting'), '○');
  const t = team([posted('a'), posted('b'), member('mon', { state: 'waiting' })]);
  assert.equal(teamCounts(t).waiting, 3);
  assert.equal(t.members[0]!.state, 'waiting');
});

test('reported shows in the header, the phrase, the fold and the order', () => {
  const t = team([member('mon', { state: 'waiting' }), posted('a'), posted('b'), member('w')]);
  assert.equal(teamHeaderLine({ ...t, boardHead: 11 }), 'Team 4 · 1 working · 2 reported · 1 waiting · board #11');
  assert.equal(teamPhrase(team([posted('a'), member('mon', { state: 'waiting' })])), '1/2 agents reported');
  assert.equal(teamPhrase(team([posted('a'), posted('b')])), '2 agents reported');
  assert.equal(teamPhrase(team([member('mon', { state: 'waiting' })])), '1 agent waiting');
  assert.equal(foldText([posted('a'), posted('b'), member('mon', { state: 'waiting' })]), '✓ 2 reported ∙ ○ 1 waiting ∙ a posted #3');
  assert.deepEqual(sortMembers(t.members).map((m) => m.name), ['w', 'a', 'b', 'mon']);
});

test('shortModel takes the family word of the label, else the model id', () => {
  const m = (modelLabel: string | null, model: string | null) => member('x', { modelLabel, model });
  assert.equal(shortModel(m('Gemini 4 Hydrogen (High)', 'g')), 'Hydrogen');
  assert.equal(shortModel(m('Claude Sonnet 5.5', 'c')), 'Sonnet');
  assert.equal(shortModel(m('GPT-5', 'g')), 'GPT-5');
  assert.equal(shortModel(m(null, 'kimi-k3')), 'kimi-k3');
  assert.equal(shortModel(m(null, null)), '');
});

test('a band member row names its model after the name, cut from the end', () => {
  const e = (m: TeamMember): BandEntry => ({ kind: 'member', job: job(), member: m, last: true });
  const hydro = { modelLabel: 'Gemini 4 Hydrogen (High)', model: 'g' };
  const r = childRow(e(member('codex', hydro)) as never, NOW, { label: 22, detail: 30 }, 0);
  assert.equal(r.name, 'codex');
  assert.match(r.model, /^ ∙ Hydrogen\s*$/);
  assert.equal(r.label.length, 20);
  const cut = childRow(e(member('codex', hydro)) as never, NOW, { label: 18, detail: 30 }, 0);
  assert.equal(cut.label, 'codex ∙ Hydrogen '.slice(0, 16));
  assert.equal(childRow(e(member('plain')) as never, NOW, { label: 22, detail: 30 }, 0).model.trim(), '');
});

test('the worker row and its member rows put the clock in one column', () => {
  const t = team([member('codex', { modelLabel: 'Gemini 4 Hydrogen (High)', tokensOut: 12_000, activity: 'reading a.rs' }), posted('kimi')]);
  const j = job({ name: 'review-smith', team: t, activity: 'checking team · 15 files read' });
  const entries = planBand([j]).entries;
  const tw = tokenColumn(entries);
  for (const width of [60, 90, 120, 160]) {
    const longest = 24;
    const cols = fitBandColumns(width, longest);
    const detail = treeColumns(cols, tw).worker;
    const worker = buildLine(j, NOW, { width, longestLabel: longest, detail });
    const workerClock = 2 + cols.label + 1 + worker.detail.length + 1;
    assert.equal(worker.detail.length, detail, `${width}`);
    for (const en of entries) {
      if (en.kind !== 'member') continue;
      const row = childRow(en, NOW, cols, tw);
      const clockAt = CHILD_INDENT.length + 4 + (cols.label - 2) + 1 + row.detail.length + 1;
      assert.equal(clockAt, workerClock, `${width}`);
      assert.ok(clockAt + row.right.length <= width + 3, `${width} fits`);
    }
  }
});

test('a band row uses one separator', () => {
  const j = job({ activity: 'checking team · 15 files read', team: team([member('a'), member('b', { state: 'waiting' })]) });
  const detail = jobDetail(j, { tools: false });
  assert.equal(detail, '1/2 agents working ∙ checking team ∙ 15 files read');
  assert.ok(!detail.includes('·'));
});

test('pane member rows share model and activity columns', () => {
  const hydro = { modelLabel: 'Gemini 4 Hydrogen (High)', model: 'g' };
  const a = member('opencode', { ...hydro, activity: 'reading a.rs' });
  const b = member('kimi', { ...hydro, activity: 'git grep', tokensOut: 8000 });
  const c = posted('codex', hydro);
  for (const width of [56, 116]) {
    const cols = teamColumns([a, b, c], NOW, width);
    const lines = [a, b, c].map((m) => memberRow(m, NOW, width, cols));
    assert.equal(lines[0]!.indexOf('Hydrogen'), lines[1]!.indexOf('Hydrogen'));
    assert.equal(lines[1]!.indexOf('Hydrogen'), lines[2]!.indexOf('Hydrogen'));
    assert.equal(lines[0]!.indexOf('reading'), lines[1]!.indexOf('git grep'));
    assert.equal(lines[1]!.indexOf('git grep'), lines[2]!.indexOf('posted'));
    for (const l of lines) assert.ok(l.length <= width, `${width}: ${l}`);
  }
  assert.equal(teamColumns([a], NOW, 56).model, 'short');
  assert.equal(teamColumns([a], NOW, 116).model, 'full');
  assert.equal(teamColumns([a], NOW, 40).model, 'none');
});

test('a worker row keeps at least the detail room it had, at every width', () => {
  const t = team([member('opencode', { modelLabel: 'Gemini 4 Hydrogen (High)', tokensOut: 12_000 }), posted('kimi')]);
  const j = job({ name: 'review-smith', team: t });
  const entries = planBand([j]).entries;
  const tw = tokenColumn(entries);
  const before = (width: number) => fitBandColumns(width, Math.max(jobLabel(j).length, ...t.members.map((m) => m.name.length + 2))).detail;
  for (const width of [40, 60, 120]) {
    const columns = fitBandColumns(width, jobLabel(j).length);
    assert.ok(columns.detail >= before(width), `${width}`);
    assert.ok(treeColumns(columns, tw).worker >= before(width) - tw, `${width}`);
    assert.equal(treeColumns(columns, 0).worker, columns.detail, `${width}`);
  }
});

test('a member label drops its model first, then truncates the name', () => {
  const e = (m: TeamMember): BandEntry => ({ kind: 'member', job: job(), member: m, last: true });
  const m = member('codex', { modelLabel: 'Gemini 4 Hydrogen (High)', model: 'g' });
  assert.equal(childRow(e(m) as never, NOW, { label: 12, detail: 30 }, 0).label, 'codex     ');
  assert.equal(childRow(e(m) as never, NOW, { label: 5, detail: 30 }, 0).label, 'cod');
});

test('a cut cell never ends in a dangling separator', () => {
  assert.equal(fitCell('5/6 agents reported ∙ checking team', 22).trimEnd(), '5/6 agents reported');
  assert.equal(fitCell('alpha beta · gamma delta', 12).trimEnd(), 'alpha beta');
  assert.equal(fitCell('abc ∙ def', 5).trimEnd(), 'abc');
});

test('the fold marks each count with its own member glyph and carries none of its own', () => {
  const row = childRow({ kind: 'fold', job: job(), hidden: [posted('a'), posted('b'), member('mon', { state: 'waiting' }), member('w'), member('f', { state: 'failed' })] }, NOW, { label: 20, detail: 30 }, 0);
  assert.equal(row.glyph, '');
  assert.equal(row.plain, '└ ✓ 2 reported ∙ ⏺ 1 working ∙ ○ 1 waiting ∙ ✗ 1 failed ∙ a posted #3');
});
