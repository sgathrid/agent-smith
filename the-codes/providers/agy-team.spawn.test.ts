import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scaled, waitFor } from '../forge/testing/time.ts';
import { createAgyTeamWatch, spawnAgy, type AgyTeamDeps } from './agy.ts';
import type { AgyTeamRead, AgyTeamReaderOptions } from './agy-team.ts';
import { createEventBus } from './ndjson.ts';
import type { ProviderEvent } from './types.ts';
import type { TeamMember } from '../surfaces/mod/types/index.d.ts';

const member = (state: TeamMember['state']): TeamMember => ({ id: 'w1', name: 'w1', role: 'worker', model: null, modelLabel: null,
  task: 'look', state, activity: null, toolCount: 0, tokensOut: null, startedAt: null, lastEventAt: 5, lastPost: null });
const snapshot = (state: TeamMember['state'], updatedAt: number): AgyTeamRead => ({
  team: { schema: 1, source: 'agy-swarm', title: null, boardHead: null, members: [member(state)], updatedAt },
  views: [{ schema: 1, id: 'w1', name: 'w1', brief: null, report: null, timeline: [], truncated: false }],
});

test('the team watch emits only when the snapshot changes, ignoring updatedAt, and never before start or after stop', () => {
  const reads: (AgyTeamRead | null | 'throw')[] = [snapshot('working', 1), snapshot('working', 2), null, 'throw', snapshot('waiting', 3), snapshot('done', 4)];
  const opened: AgyTeamReaderOptions[] = [];
  const deps: AgyTeamDeps = { pollMs: 3_600_000, createReader: (o) => { opened.push(o); return { poll: () => {
    const next = reads.shift() ?? null;
    if (next === 'throw') throw new Error('reader broke');
    return next;
  } }; } };
  const events: ProviderEvent[] = [];
  const watch = createAgyTeamWatch('/work', (e) => events.push(e), deps);
  watch.tick(0);
  assert.equal(opened.length, 0, 'no reader before agy names the conversation');
  watch.start('conv-1');
  watch.start('conv-2');
  assert.deepEqual(opened, [{ conversationId: 'conv-1', cwd: '/work' }]);
  for (let i = 0; i < 5; i++) watch.tick(1_000 + i);
  const states = () => events.map((e) => (e.kind === 'team' ? e.team.members[0]!.state : e.kind));
  assert.deepEqual(states(), ['working', 'waiting'], 'same content is not re-sent; null and a throw are dropped');
  watch.stop();
  assert.deepEqual(states(), ['working', 'waiting', 'done'], 'stop polls one last time');
  watch.tick(9_999);
  assert.equal(events.length, 3);
});

test('an undrained bus keeps only the newest team snapshot; listeners still see every one', async () => {
  const bus = createEventBus();
  const heard: ProviderEvent[] = [];
  bus.onEvent((e) => heard.push(e));
  for (const [i, state] of (['working', 'waiting', 'done'] as const).entries()) {
    bus.emit({ kind: 'team', at: String(i), ...snapshot(state, i) });
    bus.emit({ kind: 'heartbeat', at: String(i) });
  }
  bus.close();
  const queued: ProviderEvent[] = [];
  for await (const e of bus.events) queued.push(e);
  assert.equal(heard.filter((e) => e.kind === 'team').length, 3);
  assert.deepEqual(queued.map((e) => (e.kind === 'team' ? e.team.members[0]!.state : e.kind)), ['heartbeat', 'heartbeat', 'done', 'heartbeat']);
});

const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-agy-team-'));
const fixtureScript = path.join(fixtureDir, 'fake-agy.mjs');
const fixtureBinary = path.join(fixtureDir, 'agy');
const goFile = path.join(fixtureDir, 'go');
writeFileSync(fixtureScript, `
import { existsSync } from 'node:fs';
const out = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
out({ event: 'init', conversation_id: 'conv-team', init: { model: 'gemini-test' } });
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(goFile)})) return;
  clearInterval(timer);
  out({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'Team done.' } });
  out({ event: 'result', result: { status: 'SUCCESS', response: 'Team done.' } });
}, 10);
`);
writeFileSync(fixtureBinary, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixtureScript)} "$@"\n`);
chmodSync(fixtureBinary, 0o755);
test.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

test('agy polls its team while the child runs, puts changes on the bus but not in events.jsonl, and stops at exit', async () => {
  const previous = process.env['AGENT_SMITH_AGY_BIN'];
  process.env['AGENT_SMITH_AGY_BIN'] = fixtureBinary;
  let polls = 0;
  let conversationId = '';
  const deps: AgyTeamDeps = { pollMs: 5, createReader: (o) => {
    conversationId = o.conversationId;
    return { poll: (now) => { polls += 1; return snapshot(polls < 4 ? 'working' : 'waiting', now); } };
  } };
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-agy-team-state-'));
  try {
    const handle = await spawnAgy({ mode: 'implement', prompt: 'swarm it', cwd: fixtureDir, timeoutMs: scaled(60_000), unrestricted: true, stateDir }, deps);
    const events: ProviderEvent[] = [];
    handle.onEvent((e) => events.push(e));
    await waitFor(() => events.some((e) => e.kind === 'team' && e.team.members[0]!.state === 'waiting'), { message: 'second team snapshot' });
    writeFileSync(goFile, '');
    const result = await handle.waitForResult();
    assert.equal(result.status, 'success');
    assert.equal(conversationId, 'conv-team');
    assert.deepEqual(events.filter((e) => e.kind === 'team').map((e) => e.kind === 'team' && e.team.members[0]!.state), ['working', 'waiting']);
    const logged = readFileSync(path.join(stateDir, 'events.jsonl'), 'utf8');
    assert.ok(logged.includes('"started"'));
    assert.ok(!logged.includes('"team"'), 'team snapshots are never written to events.jsonl');
    const settled = polls;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(polls, settled, 'no poll after exit');
    assert.ok(existsSync(path.join(stateDir, 'result.json')));
  } finally {
    if (previous === undefined) delete process.env['AGENT_SMITH_AGY_BIN'];
    else process.env['AGENT_SMITH_AGY_BIN'] = previous;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
