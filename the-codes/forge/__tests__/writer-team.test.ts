import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AgentSmithReader } from '../../harness/agent-smith.ts';
import { normalize } from '../../harness/normalize.ts';
import { FILES, jobFile } from '../format.ts';
import { toSummary } from '../summary.ts';
import { toWatchStatus, watchLiveness } from '../../surfaces/channel/src/watch-source.ts';
import { withTeamCounts } from '../../surfaces/channel/src/views.ts';
import { JobWriter, TEAM_MEMBERS_CAP } from '../writer.ts';
import { memberFileName } from '../../surfaces/mod/hooks/team.ts';
import type { MemberView, Team, TeamMember } from '../../surfaces/mod/types/index.d.ts';

function start(flushMs = 0): { r: string; w: JobWriter } {
  const r = mkdtempSync(path.join(tmpdir(), 'agent-smith-team-'));
  const w = new JobWriter({ repo: r, jobId: 'implement-smith-7eam0001', flushMs });
  w.start({ provider: 'agy', mode: 'implement', model: null, effort: null, cwd: r, prompt: 'coordinate', unrestricted: true,
    conversation: null, timeoutMs: 1000, pipeline: null, stage: null, attempt: null });
  return { r, w };
}
function member(id: string, over: Partial<TeamMember> = {}): TeamMember {
  return { id, name: id, role: 'worker', model: null, modelLabel: null, task: `task ${id}`, state: 'working', activity: null,
    toolCount: 1, tokensOut: null, startedAt: 1, lastEventAt: 2, lastPost: null, ...over };
}
const team = (members: TeamMember[], updatedAt = 10): Team =>
  ({ schema: 1, source: 'agy-swarm', title: 'swarm', boardHead: 3, members, updatedAt });
const view = (id: string, report = 'r'): MemberView => ({ schema: 1, id, name: id, brief: 'b', report, timeline: [], truncated: false });
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

test('a team event writes team.json and one file per member view without moving lastEventAt, updatedAt or the timeline', () => {
  const { r, w } = start();
  const t0 = new Date(Date.now() + 1_000).toISOString();
  w.onEvent({ kind: 'text', at: t0, text: 'waiting on the swarm', stream: 'assistant' });
  const before = readJson(jobFile(r, w.jobId, FILES.job));
  const viewBefore = readFileSync(jobFile(r, w.jobId, FILES.view), 'utf8');
  w.onEvent({ kind: 'team', at: new Date(Date.now() + 60_000).toISOString(), team: team([member('a/b'), member('c')]), views: [view('a/b'), view('c')] });
  assert.equal((readJson(jobFile(r, w.jobId, FILES.team))['members'] as unknown[]).length, 2);
  assert.deepEqual(readdirSync(jobFile(r, w.jobId, FILES.members)).sort(), [memberFileName('a/b'), memberFileName('c')].sort());
  assert.equal(readJson(jobFile(r, w.jobId, path.join(FILES.members, memberFileName('a/b'))))['id'], 'a/b');
  assert.equal(readJson(jobFile(r, w.jobId, FILES.progress))['lastEventAt'], t0, 'a team is not a worker event');
  assert.equal(readJson(jobFile(r, w.jobId, FILES.job))['updatedAt'], before['updatedAt']);
  assert.equal(readFileSync(jobFile(r, w.jobId, FILES.view), 'utf8'), viewBefore, 'not in the timeline');
});

test('member views are rewritten only when they change, and members past the cap are dropped', () => {
  const { r, w } = start();
  const at = () => new Date().toISOString();
  w.onEvent({ kind: 'team', at: at(), team: team([member('a'), member('b')]), views: [view('a'), view('b')] });
  const fileA = jobFile(r, w.jobId, path.join(FILES.members, memberFileName('a')));
  const fileB = jobFile(r, w.jobId, path.join(FILES.members, memberFileName('b')));
  writeFileSync(fileA, 'sentinel');
  w.onEvent({ kind: 'team', at: at(), team: team([member('a'), member('b', { state: 'waiting' })], 11), views: [view('a'), view('b', 'new')] });
  assert.equal(readFileSync(fileA, 'utf8'), 'sentinel', 'unchanged view is not rewritten');
  assert.equal(readJson(fileB)['report'], 'new');
  const many = Array.from({ length: TEAM_MEMBERS_CAP + 6 }, (_, i) => member(`m${i}`));
  w.onEvent({ kind: 'team', at: at(), team: team(many), views: many.map((m) => view(m.id)) });
  assert.equal((readJson(jobFile(r, w.jobId, FILES.team))['members'] as unknown[]).length, TEAM_MEMBERS_CAP);
  assert.equal(existsSync(jobFile(r, w.jobId, path.join(FILES.members, memberFileName(`m${TEAM_MEMBERS_CAP}`)))), false);
});

test('team writes coalesce on the flush cadence and the latest snapshot lands by finish', () => {
  const { r, w } = start(60_000);
  const t = Date.now();
  w.onEvent({ kind: 'team', at: new Date(t + 120_000).toISOString(), team: team([member('a')], 1), views: [view('a')] });
  const file = jobFile(r, w.jobId, FILES.team);
  const first = statSync(file).mtimeMs;
  w.onEvent({ kind: 'team', at: new Date(t + 121_000).toISOString(), team: team([member('a', { state: 'done' })], 2), views: [view('a', 'final')] });
  assert.equal(readJson(file)['updatedAt'], 1, 'held inside the flush window');
  assert.equal(statSync(file).mtimeMs, first);
  w.finish({ jobId: w.jobId, provider: 'agy', ok: true, status: 'success', exitCode: 0, signal: null, response: 'done', durationMs: 5,
    startedAt: new Date(t).toISOString(), finishedAt: new Date(t + 122_000).toISOString(), stateDir: r }, 'done');
  assert.equal(readJson(file)['updatedAt'], 2);
  assert.equal(readJson(jobFile(r, w.jobId, path.join(FILES.members, memberFileName('a'))))['report'], 'final');
});

test('the harness reader carries a valid team into the summary and drops an invalid one', async () => {
  const { r, w } = start();
  w.onEvent({ kind: 'team', at: new Date().toISOString(), team: team([member('a', { lastEventAt: Date.now() }), member('b', { state: 'waiting' })]), views: [] });
  const read = async () => toSummary(normalize((await new AgentSmithReader().read(r, w.jobId))!));
  assert.deepEqual((await read()).team?.members.map((m) => m.state), ['working', 'waiting']);
  writeFileSync(jobFile(r, w.jobId, FILES.team), JSON.stringify({ schema: 2, source: 'agy-swarm', members: [member('a')] }));
  assert.equal((await read()).team, undefined);
  writeFileSync(jobFile(r, w.jobId, FILES.team), '{not json');
  const summary = await read();
  assert.equal(summary.team, undefined);
  assert.equal(summary.status, 'running', 'a broken team file never breaks the job');
});

test('the hook watcher reads the same team rule: a quiet coordinator with a working member is not attention', async () => {
  const { r, w } = start();
  const old = new Date(Date.now() - 40 * 60_000).toISOString();
  w.onEvent({ kind: 'team', at: new Date().toISOString(), team: team([member('a', { lastEventAt: Date.now() - 10_000 })]), views: [] });
  writeFileSync(jobFile(r, w.jobId, FILES.job), JSON.stringify({ ...readJson(jobFile(r, w.jobId, FILES.job)), startedAt: old, updatedAt: old }));
  writeFileSync(jobFile(r, w.jobId, FILES.progress), JSON.stringify({ lastEventAt: old, lastAliveAt: new Date().toISOString(), warnings: [] }));
  const observed = normalize((await new AgentSmithReader().read(r, w.jobId))!);
  assert.equal(watchLiveness(observed, Date.now())?.state, 'active');
  assert.equal(toWatchStatus(observed, Date.now()), 'running');
  writeFileSync(jobFile(r, w.jobId, FILES.team), JSON.stringify(team([member('a', { state: 'waiting' })])));
  assert.equal(toWatchStatus(normalize((await new AgentSmithReader().read(r, w.jobId))!), Date.now()), 'attention');
});

test('a member file that cannot be written blocks neither team.json nor the other members, and is retried', () => {
  const { r, w } = start();
  const blocked = jobFile(r, w.jobId, path.join(FILES.members, memberFileName('a')));
  mkdirSync(blocked, { recursive: true });
  w.onEvent({ kind: 'team', at: new Date().toISOString(), team: team([member('a'), member('b')]), views: [view('a'), view('b')] });
  assert.equal((readJson(jobFile(r, w.jobId, FILES.team))['members'] as unknown[]).length, 2);
  assert.equal(readJson(jobFile(r, w.jobId, path.join(FILES.members, memberFileName('b'))))['id'], 'b');
  rmSync(blocked, { recursive: true });
  w.onEvent({ kind: 'heartbeat', at: new Date(Date.now() + 1_000).toISOString() });
  assert.equal(readJson(blocked)['id'], 'a', 'the failed member file is written on the next flush');
});

test('a long member id gets a bounded file name that stays distinct', () => {
  const long = 'seat-'.repeat(60);
  const a = memberFileName(`${long}a`);
  const b = memberFileName(`${long}b`);
  assert.ok(a.length <= 100 && b.length <= 100);
  assert.notEqual(a, b);
  assert.match(a, /-[0-9a-f]{8}\.json$/);
  assert.equal(memberFileName('short'), 'short.json');
  const { r, w } = start();
  w.onEvent({ kind: 'team', at: new Date().toISOString(), team: team([member(`${long}a`)]), views: [view(`${long}a`)] });
  assert.equal(readJson(jobFile(r, w.jobId, path.join(FILES.members, a)))['id'], `${long}a`);
});

test('a finished job\'s team reads stopped where the snapshot said working, in the summary and the status counts', async () => {
  const { r, w } = start();
  const t = Date.now();
  w.onEvent({ kind: 'team', at: new Date(t).toISOString(),
    team: team([member('a', { lastEventAt: t }), member('b', { state: 'waiting', lastEventAt: t })]), views: [] });
  w.finish({ jobId: w.jobId, provider: 'agy', ok: true, status: 'success', exitCode: 0, signal: null, response: 'done', durationMs: 5,
    startedAt: new Date(t).toISOString(), finishedAt: new Date(t + 1_000).toISOString(), stateDir: r }, 'done');
  assert.equal((readJson(jobFile(r, w.jobId, FILES.team))['members'] as TeamMember[])[0]!.state, 'working', 'the snapshot is stored as received');
  const summary = toSummary(normalize((await new AgentSmithReader().read(r, w.jobId))!));
  assert.deepEqual(summary.team?.members.map((m) => m.state), ['stopped', 'waiting']);
  assert.deepEqual(withTeamCounts(summary).team, { total: 2, working: 0, waiting: 1, stopped: 1, done: 0, failed: 0, killed: 0 });
});
