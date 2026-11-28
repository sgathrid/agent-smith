/**
 * agy-team reader against synthetic brain trees shaped like agy 1.5.18's files
 * (invented content). Chunk files are byte slices of one stream, so the
 * fixtures cut lines (and a UTF-8 character) across chunk boundaries.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyModelLabel, createAgyTeamReader, type AgyTeamRead } from './agy-team.ts';
import type { TeamMember } from '../surfaces/mod/types/index.d.ts';

const C = '11111111-aaaa-4aaa-8aaa-000000000000';
const ALPHA = '22222222-aaaa-4aaa-8aaa-000000000001';
const BETA = '22222222-aaaa-4aaa-8aaa-000000000002';
const GAMMA = '22222222-aaaa-4aaa-8aaa-000000000003';
const DELTA = '22222222-aaaa-4aaa-8aaa-000000000004';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'agy-team-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const sg = (conv: string, ...rest: string[]) => join(root, conv, '.system_generated', ...rest);
const write = (file: string, body: string) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, body); };
const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, i)).toISOString().replace('.000', '');

type Step = Record<string, unknown>;
/** The compact transcript JSON-quotes every argument value. */
const call = (name: string, args: Record<string, unknown>) => ({ name, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, JSON.stringify(v)])) });
const planner = (i: number, calls: unknown[], extra: Step = {}): Step =>
  ({ step_index: i, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: at(i), model: 'gemini-4-neon-high', output_tokens: 10, tool_calls: calls, ...extra });
const result = (i: number, body: string, status = 'DONE'): Step =>
  ({ step_index: i, source: 'MODEL', type: 'GENERIC', status, created_at: at(i), content: `Created At: x\nCompleted At: y\n${body}` });
const system = (i: number, content: string): Step => ({ step_index: i, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: at(i), content });
const jsonl = (steps: Step[]) => steps.map((s) => JSON.stringify(s) + '\n').join('');
const message = (sender: string, content: string) =>
  `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-01-01T10:00:00Z sender=${sender} priority=MESSAGE_PRIORITY_HIGH content=${content}\n</SYSTEM_MESSAGE>`;

/** Writes a transcript as chunk files cut at the given byte offsets. */
function chunks(conv: string, body: string | Buffer, cuts: number[] = []) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const edges = [0, ...cuts, buf.length];
  for (let i = 0; i + 1 < edges.length; i += 1) {
    write(sg(conv, 'logs', 'chunks', 'transcript', `${String(i).padStart(8, '0')}.jsonl`), '');
    writeFileSync(sg(conv, 'logs', 'chunks', 'transcript', `${String(i).padStart(8, '0')}.jsonl`), buf.subarray(edges[i], edges[i + 1]));
  }
}

function swarm(members: Record<string, Record<string, unknown>>, board: Step[], plan?: unknown) {
  write(sg(C, 'swarm', 'swarm.json'), JSON.stringify({ version: 1, backend: 'local', swarm_id: C, created_at: '2026-01-01T10:00:00Z' }));
  write(sg(C, 'swarm', 'members.json'), JSON.stringify({
    title: 'Review the parser',
    members: { coordinator: { conversation_id: C, role: 'coordinator', applied_model: 'gemini-4-neon-high', killed: false }, ...members },
  }));
  write(sg(C, 'swarm', 'board.jsonl'), jsonl(board));
  if (plan !== undefined) write(sg(C, 'swarm', 'plan.json'), JSON.stringify(plan));
}
const member = (conv: string, extra: Record<string, unknown> = {}) =>
  ({ conversation_id: conv, role: 'worker', desired_model: 'gemini-4-hydrogen-high', applied_model: 'gemini-4-hydrogen-high', wake_mode: 'mentions', killed: false, ...extra });
const post = (seq: number, agent: string, text: string, extra: Step = {}): Step => ({ seq, agent, text, time: '2026-01-01 10:00:00', ...extra });

const read = (nowMs = 1_000): AgyTeamRead => {
  const r = reader().poll(nowMs);
  assert.ok(r, 'expected a snapshot');
  return r;
};
let shared: ReturnType<typeof createAgyTeamReader> | null = null;
const reader = () => (shared ??= createAgyTeamReader({ conversationId: C, cwd: '/work/repo', brainRoot: root }));
beforeEach(() => { shared = null; });
const byName = (r: AgyTeamRead, name: string): TeamMember => {
  const m = r.team.members.find((x) => x.name === name);
  assert.ok(m, `no member ${name}`);
  return m;
};

function standardSwarm() {
  swarm({
    alpha: member(ALPHA),
    beta: member(BETA),
    gamma: member(GAMMA, { killed: true }),
    delta: member(DELTA, { wake_mode: 'mentions' }),
  }, [
    post(1, 'coordinator', '@alpha Audit the tokenizer.\nCite file:line.', { kind: 'brief' }),
    post(2, 'coordinator', '@beta Check the error paths.\nNo edits.', { kind: 'brief' }),
    post(3, 'beta', '@coordinator [done] error paths reviewed\nThree findings.'),
  ], { goal: { title: 'Review', line: 'Review the parser' }, tasks: { alpha: 'Tokenizer audit' } });
  chunks(ALPHA, jsonl([
    system(0, message(C, 'ignored: alpha has a board brief')),
    planner(1, [call('read_file', { Path: '/work/repo/src/lexer.ts' })], { content: 'Reading the lexer first.', output_tokens: 7 }),
    result(2, 'export const x = 1;'),
    planner(3, [call('run_command', { CommandLine: 'git status --short', Cwd: '/work/repo' })], { output_tokens: 5 }),
  ]));
  chunks(BETA, jsonl([
    system(0, message(C, 'brief')),
    planner(1, [call('post_message', { text: '@coordinator [done] error paths reviewed' }), call('swarm_wait', { since: 2 })]),
    result(2, '{"status":"posted","seq":3}'),
    result(3, '{"status":"posted","seq":3}'),
  ]));
  chunks(GAMMA, jsonl([planner(0, [call('read_file', { Path: '/work/repo/a.ts' })])]));
}

describe('agy swarm', () => {
  it('lists every member but the coordinator, with agy\'s state rule', () => {
    standardSwarm();
    const r = read(42);
    assert.equal(r.team.source, 'agy-swarm');
    assert.equal(r.team.title, 'Review the parser');
    assert.equal(r.team.boardHead, 3);
    assert.equal(r.team.updatedAt, 42);
    assert.deepEqual(r.team.members.map((m) => [m.name, m.state]),
      [['alpha', 'working'], ['beta', 'waiting'], ['gamma', 'killed'], ['delta', 'waiting']]);
    assert.ok(!r.team.members.some((m) => m.role === 'coordinator'));
    assert.equal(r.views.length, 4);
  });

  it('fills task, activity, counts and posts', () => {
    standardSwarm();
    const r = read();
    const alpha = byName(r, 'alpha');
    assert.equal(alpha.id, 'alpha');
    assert.equal(alpha.task, 'Tokenizer audit');
    assert.equal(alpha.activity, 'checking git');
    assert.equal(alpha.toolCount, 2);
    assert.equal(alpha.tokensOut, 12);
    assert.equal(alpha.model, 'gemini-4-hydrogen-high');
    assert.equal(alpha.modelLabel, 'Gemini 4 Hydrogen (High)');
    assert.equal(alpha.startedAt, Date.parse(at(0)));
    assert.equal(alpha.lastEventAt, Date.parse(at(3)));
    assert.equal(alpha.lastPost, null);
    const beta = byName(r, 'beta');
    assert.equal(beta.task, 'Check the error paths.');
    assert.equal(beta.activity, 'posted #3');
    assert.deepEqual(beta.lastPost, { seq: 3, text: '@coordinator [done] error paths reviewed' });
    const delta = byName(r, 'delta');
    assert.equal(delta.toolCount, 0);
    assert.equal(delta.tokensOut, null);
    assert.equal(delta.activity, null);
  });

  it('builds member views: brief, report and a decoded timeline', () => {
    standardSwarm();
    const r = read();
    const alpha = r.views.find((v) => v.id === 'alpha')!;
    assert.equal(alpha.brief, 'Audit the tokenizer.\nCite file:line.');
    assert.equal(alpha.report, null);
    assert.equal(alpha.truncated, false);
    assert.deepEqual(alpha.timeline.map((e) => [e.kind, e.sequence]), [['assistant', 1], ['tool', 2], ['tool', 4]]);
    const [, read1, cmd] = alpha.timeline;
    assert.ok(read1?.kind === 'tool' && cmd?.kind === 'tool');
    assert.deepEqual(JSON.parse(read1.input), { Path: '/work/repo/src/lexer.ts' });
    assert.equal(read1.output, 'export const x = 1;');
    assert.equal(read1.state, 'done');
    assert.equal(cmd.state, 'active');
    assert.equal(cmd.output, '');
    const beta = r.views.find((v) => v.id === 'beta')!;
    assert.equal(beta.report, '@coordinator [done] error paths reviewed\nThree findings.');
    assert.deepEqual(JSON.parse((beta.timeline[1] as { input: string }).input), { since: 2 });
  });

  it('does not double-count on repeated polls and picks up appended steps', () => {
    standardSwarm();
    reader().poll(1);
    reader().poll(2);
    assert.equal(byName(read(), 'alpha').toolCount, 2);
    appendFileSync(sg(ALPHA, 'logs', 'chunks', 'transcript', '00000000.jsonl'), jsonl([result(4, 'M src/lexer.ts')]));
    const alpha = byName(read(), 'alpha');
    assert.equal(alpha.toolCount, 2);
    assert.equal(alpha.lastEventAt, Date.parse(at(4)));
    assert.equal(alpha.state, 'working');
  });

  it('a swarm_wait that is not DONE, or anything after it, keeps the member working', () => {
    swarm({ alpha: member(ALPHA), beta: member(BETA) }, []);
    chunks(ALPHA, jsonl([planner(0, [call('swarm_wait', { since: 0 })]), result(1, 'timed out', 'ERROR')]));
    chunks(BETA, jsonl([planner(0, [call('swarm_wait', { since: 0 })]), result(1, 'ok'), system(2, 'a background task finished')]));
    const r = read();
    assert.equal(byName(r, 'alpha').state, 'working');
    assert.equal(byName(r, 'beta').state, 'working');
    assert.equal(byName(r, 'alpha').activity, 'waiting for posts');
  });

  it('a reply with no tool calls stops the run', () => {
    swarm({ alpha: member(ALPHA) }, []);
    chunks(ALPHA, jsonl([planner(0, [], { content: 'All done here.' })]));
    const r = read();
    assert.equal(byName(r, 'alpha').state, 'waiting');
    assert.equal(byName(r, 'alpha').activity, 'replied');
    assert.equal(r.views[0]!.report, 'All done here.');
  });

  it('falls back to wake_mode when a member has no transcript yet', () => {
    swarm({ alpha: member(ALPHA, { wake_mode: 'working' }), beta: member(BETA, { wake_mode: 'anything' }) }, []);
    const r = read();
    assert.equal(byName(r, 'alpha').state, 'working');
    assert.equal(byName(r, 'beta').state, 'waiting');
  });

  it('tails a transcript whose lines straddle chunk files, holding a partial tail until it completes', () => {
    swarm({ alpha: member(ALPHA) }, []);
    const steps = jsonl([
      planner(0, [call('read_file', { Path: '/work/repo/naïve.ts' })]),
      result(1, 'données'),
      planner(2, [call('swarm_wait', { since: 0 })]),
    ]);
    const full = Buffer.from(steps + JSON.stringify(result(3, 'woken')) + '\n');
    const naive = full.indexOf(Buffer.from('ï'));
    const head = Buffer.from(steps).length + 20;
    // Cut inside the first line, inside a two-byte character, and leave step 3 unfinished.
    chunks(ALPHA, full.subarray(0, head), [30, naive + 1, Buffer.from(steps).length - 5]);
    let r = read();
    let alpha = byName(r, 'alpha');
    assert.equal(alpha.toolCount, 2);
    assert.equal(alpha.state, 'working', 'a torn last line is mid-turn');
    assert.deepEqual(JSON.parse((r.views[0]!.timeline[0] as { input: string }).input), { Path: '/work/repo/naïve.ts' });
    assert.equal((r.views[0]!.timeline[0] as { output: string }).output, 'données');
    writeFileSync(sg(ALPHA, 'logs', 'chunks', 'transcript', '00000004.jsonl'), full.subarray(head));
    r = read();
    alpha = byName(r, 'alpha');
    assert.equal(alpha.state, 'waiting');
    assert.equal(alpha.lastEventAt, Date.parse(at(3)));
    assert.equal(alpha.toolCount, 2);
  });

  it('starts over when agy rewrites a transcript', () => {
    swarm({ alpha: member(ALPHA) }, []);
    chunks(ALPHA, jsonl([planner(0, [call('read_file', { Path: '/a' })]), result(1, 'a'), planner(2, [call('read_file', { Path: '/b' })]), result(3, 'b')]));
    assert.equal(byName(read(), 'alpha').toolCount, 2);
    chunks(ALPHA, jsonl([planner(0, [call('read_file', { Path: '/c' })]), result(1, 'c')]));
    assert.equal(byName(read(), 'alpha').toolCount, 1);
    // Larger, with a different first step: the first bytes no longer match.
    chunks(ALPHA, jsonl([system(0, 'restarted'), planner(1, [call('read_file', { Path: '/d' })]), result(2, 'd'), planner(3, [call('read_file', { Path: '/e' })]), result(4, 'e')]));
    assert.equal(byName(read(), 'alpha').toolCount, 2);
  });

  it('keeps reading when agy logs a step out of order', () => {
    swarm({ alpha: member(ALPHA) }, []);
    chunks(ALPHA, jsonl([system(0, 'x'), planner(1, [call('read_file', { Path: '/a' })]), result(3, 'a'), result(2, 'b')]));
    assert.equal(byName(read(), 'alpha').toolCount, 1);
    appendFileSync(sg(ALPHA, 'logs', 'chunks', 'transcript', '00000000.jsonl'), jsonl([planner(4, [call('read_file', { Path: '/b' })])]));
    const alpha = byName(read(), 'alpha');
    assert.equal(alpha.toolCount, 2);
    assert.equal(alpha.lastEventAt, Date.parse(at(4)));
  });

  it('re-reads the board after a rewrite', () => {
    swarm({ alpha: member(ALPHA) }, [post(1, 'coordinator', '@alpha First brief.', { kind: 'brief' }), post(2, 'alpha', 'old post'), post(3, 'alpha', 'older post')]);
    assert.equal(read().team.boardHead, 3);
    write(sg(C, 'swarm', 'board.jsonl'), jsonl([post(1, 'coordinator', '@alpha New brief.', { kind: 'brief' })]));
    let r = read();
    assert.equal(r.team.boardHead, 1);
    assert.equal(r.views[0]!.brief, 'New brief.');
    assert.equal(byName(r, 'alpha').lastPost, null);
    // Same size or larger, different content: the first line no longer matches.
    write(sg(C, 'swarm', 'board.jsonl'), jsonl([post(1, 'coordinator', '@alpha Other brief.', { kind: 'brief' }), post(2, 'alpha', 'fresh')]));
    r = read();
    assert.equal(r.team.boardHead, 2);
    assert.equal(r.views[0]!.brief, 'Other brief.');
    assert.equal(byName(r, 'alpha').lastPost?.text, 'fresh');
  });

  it('caps the timeline at the newest 200 events', () => {
    swarm({ alpha: member(ALPHA) }, []);
    const steps: Step[] = [];
    for (let i = 0; i < 150; i += 1) steps.push(planner(i * 2, [call('read_file', { Path: `/f${i}` })], { content: `step ${i}` }), result(i * 2 + 1, 'x'.repeat(3_000)));
    chunks(ALPHA, jsonl(steps));
    const view = read().views[0]!;
    assert.equal(view.timeline.length, 200);
    assert.equal(view.truncated, true);
    assert.equal(byName(read(), 'alpha').toolCount, 150);
    const last = view.timeline[view.timeline.length - 1]!;
    assert.ok(last.kind === 'tool' && last.sequence === 299 && last.output.length === 2_000);
  });
});

describe('agy sub-agents', () => {
  const sub = (conv: string, state: string, desc: Record<string, unknown> | null, spawn: number) =>
    write(sg(C, 'subagents', `${conv}.json`), JSON.stringify({
      conversationId: conv, ...(desc ? { subagentDescriptor: desc } : {}), state, spawnStepIndex: spawn, workspaceUris: ['file:///work/repo'],
    }));

  it('maps state, brief, report and names from subagent files and transcripts', () => {
    sub(ALPHA, 'SUBAGENT_STATE_KILLED', { typeName: 'research', role: 'Tokenizer And Lexer Boundary Researcher' }, 3);
    sub(BETA, 'SUBAGENT_STATE_ALIVE', { typeName: 'self', role: 'Fix Engineer' }, 5);
    sub(GAMMA, 'SUBAGENT_STATE_KILLED', { typeName: 'self', role: 'Stopped Engineer' }, 7);
    sub(DELTA, 'SUBAGENT_STATE_ALIVE', null, 9);
    chunks(ALPHA, jsonl([
      system(0, message(C, 'Survey the lexer.\nReturn file:line citations.')),
      planner(1, [call('read_file', { Path: '/work/repo/lexer.ts' })], { model: 'gemini-4-neon-low' }),
      result(2, 'code'),
      planner(3, [], { content: 'Found two issues.\nDetails follow.', model: 'gemini-4-neon-low' }),
    ]));
    chunks(BETA, jsonl([system(0, message(C, 'Fix it.')), planner(1, [call('edit_file', { Path: '/work/repo/a.ts' })])]));
    chunks(GAMMA, jsonl([system(0, message(C, 'Go.')), planner(1, [call('run_command', { CommandLine: 'npm test' })]), result(2, 'ok')]));
    const r = read();
    assert.equal(r.team.source, 'agy-subagents');
    assert.equal(r.team.boardHead, null);
    assert.equal(r.team.title, null);
    assert.deepEqual(r.team.members.map((m) => [m.id, m.state]),
      [[ALPHA, 'done'], [BETA, 'working'], [GAMMA, 'killed'], [DELTA, 'working']]);
    const alpha = r.team.members[0]!;
    assert.equal(alpha.name, 'Tokenizer And Lexer');
    assert.equal(alpha.role, 'Tokenizer And Lexer Boundary Researcher');
    assert.equal(alpha.task, 'Survey the lexer.');
    assert.equal(alpha.model, 'gemini-4-neon-low');
    assert.equal(alpha.modelLabel, 'Gemini 4 Neon (Low)');
    assert.equal(alpha.activity, 'replied');
    assert.equal(alpha.lastPost, null);
    assert.equal(r.views[0]!.brief, 'Survey the lexer.\nReturn file:line citations.');
    assert.equal(r.views[0]!.report, 'Found two issues.\nDetails follow.');
    assert.equal(r.team.members[1]!.activity, 'editing a.ts');
    assert.equal(r.team.members[3]!.name, DELTA.slice(0, 8));
    assert.equal(r.team.members[3]!.role, 'sub-agent');
  });

  it('ignores a brief from another sender', () => {
    sub(ALPHA, 'SUBAGENT_STATE_ALIVE', { role: 'Helper' }, 1);
    chunks(ALPHA, jsonl([system(0, message('someone-else', 'not the brief')), system(1, message(C, 'the brief'))]));
    assert.equal(read().views[0]!.brief, 'the brief');
  });

  it('skips a garbage subagent file and keeps the rest', () => {
    sub(ALPHA, 'SUBAGENT_STATE_ALIVE', { role: 'Helper' }, 1);
    write(sg(C, 'subagents', `${BETA}.json`), '{not json');
    write(sg(C, 'subagents', 'bad.json'), JSON.stringify({ conversationId: '../escape', state: 'SUBAGENT_STATE_ALIVE' }));
    assert.deepEqual(read().team.members.map((m) => m.id), [ALPHA]);
  });
});

describe('agy team: nothing to show', () => {
  it('returns null for a conversation with no swarm and no sub-agents', () => {
    assert.equal(reader().poll(1), null);
    write(sg(C, 'logs', 'transcript.jsonl'), '');
    assert.equal(reader().poll(1), null);
  });

  it('returns null for an unusable conversation id or brain root, without throwing', () => {
    assert.equal(createAgyTeamReader({ conversationId: '../x', cwd: '/work/repo', brainRoot: root }).poll(1), null);
    assert.equal(createAgyTeamReader({ conversationId: C, cwd: '/work/repo', brainRoot: join(root, 'missing') }).poll(1), null);
  });

  it('returns null while members.json is missing or garbage, and keeps the last good roster through a torn rewrite', () => {
    mkdirSync(sg(C, 'swarm'), { recursive: true });
    assert.equal(reader().poll(1), null);
    write(sg(C, 'swarm', 'members.json'), '{"title":');
    assert.equal(reader().poll(1), null);
    swarm({ alpha: member(ALPHA) }, []);
    assert.equal(read().team.members.length, 1);
    write(sg(C, 'swarm', 'members.json'), '{"title": "torn');
    assert.equal(read().team.members[0]!.name, 'alpha');
  });

  it('returns null when the roster has only the coordinator, or subagents/ is empty', () => {
    swarm({}, []);
    assert.equal(reader().poll(1), null);
    rmSync(sg(C, 'swarm'), { recursive: true });
    mkdirSync(sg(C, 'subagents'), { recursive: true });
    assert.equal(reader().poll(1), null);
  });

  it('skips garbage transcript lines and a missing board', () => {
    swarm({ alpha: member(ALPHA) }, []);
    rmSync(sg(C, 'swarm', 'board.jsonl'));
    chunks(ALPHA, 'garbage\n' + jsonl([planner(0, [], { content: 'hi' })]));
    const r = read();
    assert.equal(r.team.boardHead, null);
    assert.equal(byName(r, 'alpha').state, 'waiting');
  });

  it('reads transcript.jsonl when agy wrote no chunks', () => {
    swarm({ alpha: member(ALPHA) }, []);
    write(sg(ALPHA, 'logs', 'transcript.jsonl'), jsonl([planner(0, [call('read_file', { Path: '/a.ts' })])]));
    assert.equal(byName(read(), 'alpha').activity, 'reading a.ts');
  });
});

describe('agyModelLabel', () => {
  it('reads agy model ids', () => {
    assert.equal(agyModelLabel('gemini-4-neon-high'), 'Gemini 4 Neon (High)');
    assert.equal(agyModelLabel('gemini-4-flash'), 'Gemini 4 Flash');
    assert.equal(agyModelLabel('Some Model'), null);
    assert.equal(agyModelLabel(null), null);
  });
});
