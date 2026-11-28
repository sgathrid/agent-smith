import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, ProgressTracker } from '../hooks/progress.ts';
import { condenseTimeline, timelineGroupLabel } from '../hooks/dashboard.ts';

const J = (v: unknown) => JSON.stringify(v);
const label = (tool: string, input: unknown, output?: string) =>
  classify(tool, typeof input === 'string' ? input : J(input), output).label;

test('swarm add reads the result, and the plan before it', () => {
  const out = J({ status: 'added', name: 'neon-1', model_display_name: 'Model A (High)', model: 'x' });
  assert.equal(label('swarm', { action: 'add', name: 'neon-1', brief: 'b' }, out), 'added neon-1 (Model A (High))');
  assert.equal(label('swarm', { action: 'add', name: 'neon-1' }), 'adding neon-1');
  assert.equal(label('swarm', { action: 'add', brief: 'b' }), 'adding agent');
  assert.equal(label('swarm', '{"action":"add","brief":"long long lo', '{"status":"added","name":"neon-2","model_display_name":"Model B"'), 'added neon-2 (Model B)');
  assert.equal(label('swarm', '{"action":"add","name":"neon-3","brief":"long long lo'), 'adding neon-3');
});

test('swarm status counts members by state, never the coordinator', () => {
  const members = [
    { name: 'coordinator', role: 'coordinator', state: 'working' },
    ...['a', 'b', 'c', 'd'].map((name) => ({ name, role: 'worker', state: 'working' })),
    ...['e', 'f', 'g', 'h', 'i'].map((name) => ({ name, role: 'worker', state: 'waiting' })),
  ];
  const body = J({ title: 't', members });
  assert.equal(label('swarm', { action: 'status' }, body), 'checked team (4 working · 5 waiting)');
  assert.equal(label('swarm', { action: 'status' }, body.slice(0, 180)), 'checked team (2 working)');
  assert.equal(label('swarm', { action: 'status' }), 'checking team');
  assert.equal(label('swarm', { action: 'status' }, '{"title":"x"'), 'checking team');
});

test('swarm admin actions', () => {
  assert.equal(label('swarm', { action: 'models', all: true }), 'listed models');
  assert.equal(label('swarm', { action: 'title', title: 'Review A' }), 'named team "Review A"');
  assert.equal(label('swarm', { action: 'kill', name: 'neon-1' }), 'stopped neon-1');
  assert.equal(label('swarm', { action: 'model', name: 'neon-1', model: 'fast' }), 'switched neon-1 to fast');
});

test('read_board, post_message, swarm_wait, update_steps', () => {
  const board = J({ messages: [{ seq: 10, agent: 'hydro-711', text: 'a {"seq":99,"agent":"zz"}' }, { seq: 11, agent: 'hydro-707', text: 'b' }, { seq: 13, agent: 'hydro-711', text: 'c' }] });
  assert.equal(label('read_board', { since: 9 }, board), 'board #10–#13 · hydro-711, hydro-707');
  assert.equal(label('read_board', { since: 9 }, board.slice(0, 42)), 'board #10 · hydro-711');
  assert.equal(label('read_board', { since: 9 }, '{"messages":[]}'), 'board: nothing new');
  assert.equal(label('read_board', { since: 9 }), 'reading board');
  assert.equal(label('read_board', { since: 9 }, '{"head":4,"mess'), 'reading board');
  assert.equal(label('post_message', { text: 'hi' }, '{"status":"posted","seq":14}'), 'posted #14');
  assert.equal(label('post_message', { text: 'hi' }), 'posting to board');
  assert.equal(label('swarm_wait', { mentions_only: true, since: 11 }), 'waiting on team');
  const steps = ['done', 'done', 'in_progress', 'pending', 'pending'].map((status, i) => ({ status, title: `s${i}` }));
  assert.equal(label('update_steps', { steps }), 'plan 2/5 done');
  assert.equal(label('update_steps', J({ steps }).slice(0, 90)), 'plan 2/2 done');
});

test('team tools are kind other, so they never reach the digest counts', () => {
  for (const [tool, input] of [['swarm', { action: 'status' }], ['read_board', {}], ['post_message', {}], ['swarm_wait', {}], ['update_steps', { steps: [] }]] as const) {
    assert.equal(classify(tool, J(input)).kind, 'other');
  }
  const t = new ProgressTracker();
  t.start(1, 'swarm', J({ action: 'status' }));
  const d = t.digest('/w');
  assert.deepEqual([d.filesRead, d.searches, d.commands, d.editedCount, d.repeat], [0, 0, 0, 0, null]);
});

test('repeated team polls fold into one group row', () => {
  let n = 0;
  const tool = (name: string, input: unknown, output = '') =>
    ({ kind: 'tool' as const, sequence: n, at: 't', stepIndex: n++, tool: name, input: J(input), output, state: 'done' });
  const msgs = (...seqs: number[]) => J({ messages: seqs.map((seq) => ({ seq, agent: 'a' })) });
  const items = condenseTimeline([
    tool('swarm', { action: 'status' }), tool('read_board', {}, msgs(10, 11)), tool('swarm_wait', {}),
    tool('swarm', { action: 'status' }), tool('read_board', {}, msgs(14, 15)), tool('swarm_wait', {}),
    tool('swarm', { action: 'add', name: 'x' }),
  ]);
  assert.deepEqual(items.map((i) => i.kind), ['group', 'event']);
  const g = items[0]!;
  assert.equal(g.kind === 'group' && timelineGroupLabel(g.reads, g.searches, g.commands, g.team), 'checked team 2× · board #10–#15 · waited 2×');
  assert.equal(condenseTimeline([tool('swarm', { action: 'add', name: 'x' }), tool('swarm', { action: 'add', name: 'y' }), tool('swarm', { action: 'add', name: 'z' }), tool('swarm', { action: 'add', name: 'w' })]).length, 4);
});
