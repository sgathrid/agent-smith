import { describe, expect, mock, test } from 'claude-code/testing';

import type { MemberView, RadarJob, Team, TeamMember } from '../../types/index.d.ts';
import type { ForgeDetail } from '../../hooks/canonical.ts';
import { memberFileName } from '../../hooks/team.ts';
import { renderMember, renderWorker, type ViewActions, type ViewOptions } from '../../hooks/views.tsx';

const NOW = Date.parse('2026-10-03T16:49:45.031Z');
const iso = (ms: number) => new Date(ms).toISOString();

const member = (id: string, over: Partial<TeamMember> = {}): TeamMember => ({
  id, name: id, role: 'worker', model: 'gemini-4-neon-high', modelLabel: 'Gemini 4 Neon (High)', task: `Review ${id}`,
  state: 'working', activity: `git show ${id}/note_reading.rs`, toolCount: 3, tokensOut: 219_000,
  startedAt: NOW - 14 * 60_000, lastEventAt: NOW - 1000, lastPost: null, ...over,
});
const MEMBERS: TeamMember[] = [
  member('neon-681-core'),
  member('neon-681-ui', { activity: 'reading ui.rs', tokensOut: 90_000 }),
  member('neon-707', { state: 'waiting', activity: null, startedAt: NOW - 12 * 60_000, lastEventAt: NOW - 60_000, lastPost: { seq: 15, text: 'ok' }, tokensOut: 180_000 }),
  member('neon-708', { state: 'done', lastEventAt: NOW - 120_000 }),
  member('neon-709', { state: 'failed', lastEventAt: NOW - 180_000 }),
  member('neon-710', { state: 'killed', lastEventAt: NOW - 240_000 }),
];
const team = (members: TeamMember[]): Team => ({ schema: 1, source: 'agy-swarm', title: null, boardHead: 15, members, updatedAt: NOW });

function job(members: TeamMember[] | null): RadarJob {
  return {
    id: 'job-1', workerId: 'swarm', turn: 1, status: 'running', task: '/swarm Review all four', prompt: '/swarm Review all four',
    name: 'stack-swarm', provider: 'agy', model: 'gemini-4-neon-high', startedAt: NOW - 755_000, endedAt: null, warnings: [],
    team: members ? team(members) : null, raw: {},
  } as unknown as RadarJob;
}
const detail = (members: TeamMember[] | null): ForgeDetail => ({ job: job(members), timeline: [
  { sequence: 0, kind: 'assistant', at: iso(NOW), text: 'Coordinating.' }] } as unknown as ForgeDetail);

const actions: ViewActions = {
  pick: async () => {}, pickTurn: async () => {}, page: async () => {}, back: async () => { void 0; }, task: async () => { void 0; },
  tool: async () => {}, close: async () => {},
  member: async (id) => { void id; }, team: async () => {}, memberBack: async () => {},
};
const options = (over: Partial<ViewOptions> = {}): ViewOptions => ({
  width: 60, now: NOW, colour: false, page: 0, scope: 'session', following: true, taskOpen: false, tools: [], pinnedTurnId: null, teamOpen: false, ...over,
});

const builders = new WeakMap<object, Map<string, (W: any) => JSX.Element>>();
let drawn = 0;
async function draw($: any, on: any, build: (W: any) => JSX.Element) {
  let map = builders.get($);
  if (!map) {
    const m = (map = new Map());
    builders.set($, m);
    mock.clock(on as never, { now: NOW });
    on('ui.render', { component: 'Pane' }, ($: any, e: any) => m.get(e.requestId)!($.ui.resolve(e)));
  }
  const requestId = `team-direct-${drawn++}`;
  map.set(requestId, build);
  return $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', component: 'Pane', requestId,
    viewport: { columns: 119, rows: 40, isFullscreen: true }, props: { title: 't', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as never);
}
const texts = async (pane: any): Promise<string[]> => (await pane.findAll({ type: 'Text' })).map((t: any) => String(t.text));
const labels = async (pane: any): Promise<string[]> => (await pane.findAll({ type: 'Button' })).map((b: any) => String(b.props?.label));

describe('the Team section (renderWorker)', () => {
  test('collapsed: header line, first four members, a more row, m in the footer', async ($, on) => {
    const pane = await draw($, on, (W) => renderWorker(W, detail(MEMBERS), options(), actions));
    expect(await texts(pane)).toContain('Team 6 · 2 working · 1 reported · 1 done · 1 failed · 1 killed · board #15');
    const rows = (await labels(pane)).filter((l) => /neon-/.test(l));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/^⏺ neon-681-core\s+Neon\s+git show/);
    expect(rows[0]).toMatch(/14m00s · ↓ 219k$/);
    expect(rows[3]).toMatch(/^✓ neon-707\s+Neon\s+posted #15\s+11m00s · ↓ 180k$/);
    expect(await texts(pane)).toContain('  + 2 more · m: all');
    expect((await pane.find({ key: 'member-neon-681-core' }) as any).props.hotkey).toBe('1');
    expect((await pane.find({ key: 'team' }) as any).props.hotkey).toBe('m');
  });

  test('open: every member and no more row; narrow width drops the model column and fits', async ($, on) => {
    const pane = await draw($, on, (W) => renderWorker(W, detail(MEMBERS), options({ teamOpen: true, width: 40 }), actions));
    const rows = (await labels(pane)).filter((l) => /neon-/.test(l));
    expect(rows).toHaveLength(6);
    for (const row of rows) { expect(row.length).toBeLessThanOrEqual(36); expect(row).not.toMatch(/Gemini/); }
    expect(await texts(pane)).not.toContainEqual(expect.stringMatching(/more/));
  });

  test('only the first nine members get a digit', async ($, on) => {
    const many = Array.from({ length: 11 }, (_, i) => member(`m${String(i).padStart(2, '0')}`, { lastEventAt: NOW - i }));
    const pane = await draw($, on, (W) => renderWorker(W, detail(many), options({ teamOpen: true }), actions));
    expect((await pane.find({ key: 'member-m08' }) as any).props.hotkey).toBe('9');
    expect((await pane.find({ key: 'member-m09' }) as any).props.hotkey).toBeUndefined();
  });

  test('a team that fits the collapsed rows has no Team button; a stopped member reads stopped with a frozen clock', async ($, on) => {
    const small = [member('neon-681-core', { state: 'stopped', lastEventAt: NOW - 4 * 60_000 }), MEMBERS[2]!];
    const pane = await draw($, on, (W) => renderWorker(W, detail(small), options(), actions));
    expect(await pane.find({ key: 'team' })).toBeUndefined();
    expect(await texts(pane)).toContain('Team 2 · 1 reported · 1 stopped · board #15');
    const rows = (await labels(pane)).filter((l) => /neon-/.test(l));
    expect(rows[0]).toMatch(/^○ neon-681-core\s.*10m00s · ↓ 219k$/);
  });

  test('a worker without a team shows none of it', async ($, on) => {
    const pane = await draw($, on, (W) => renderWorker(W, detail(null), options(), actions));
    expect(await pane.find({ key: 'team' })).toBeUndefined();
    expect(await texts(pane)).not.toContain('Team');
  });
});

describe('the member view (renderMember)', () => {
  const view: MemberView = { schema: 1, id: 'neon-681-core', name: 'neon-681-core', brief: 'Full brief for the member', report: 'Posted findings', truncated: false,
    timeline: [{ sequence: 0, kind: 'assistant', at: iso(NOW), text: 'Reading note_reading.rs.' },
      { sequence: 1, kind: 'tool', at: iso(NOW), stepIndex: 0, tool: 'Read', input: 'note_reading.rs', output: 'x', state: 'done' }] };

  test('header, task, timeline, result and a Back that returns to the worker', async ($, on) => {
    const pane = await draw($, on, (W) => renderMember(W, job(MEMBERS), MEMBERS[0]!, view, options(), actions));
    const t = await texts(pane);
    expect(t[0]).toBe('⏺ neon-681-core · member of stack-swarm · agy · 14m00s');
    expect(t[1]).toBe('Gemini 4 Neon (High) · worker · ↓ 219k');
    expect(t).toContain('Task: Review neon-681-core');
    expect(await pane.find({ type: 'Markdown', text: '● Reading note_reading.rs.' })).toBeDefined();
    expect(await pane.find({ type: 'Markdown', text: 'Posted findings' })).toBeDefined();
    expect(await pane.find({ type: 'Markdown', text: 'Full brief for the member' })).toBeUndefined();
    expect((await pane.find({ key: 'back' }) as any).props.hotkey).toBe('b');
    expect((await pane.find({ key: 'task' }) as any).props.hotkey).toBe('t');
    expect(await pane.find({ key: 'team' })).toBeUndefined();
  });

  test('t shows the full brief', async ($, on) => {
    const pane = await draw($, on, (W) => renderMember(W, job(MEMBERS), MEMBERS[0]!, view, options({ taskOpen: true }), actions));
    expect(await pane.find({ type: 'Markdown', text: 'Full brief for the member' })).toBeDefined();
  });

  test('a working member without a post says so; a missing view says no detail', async ($, on) => {
    const noPost = { ...view, report: null };
    const a = await draw($, on, (W) => renderMember(W, job(MEMBERS), MEMBERS[0]!, noPost, options(), actions));
    expect(await texts(a)).toContain('No post yet.');
    const b = await draw($, on, (W) => renderMember(W, job(MEMBERS), MEMBERS[2]!, null, options(), actions));
    const t = await texts(b);
    expect(t[0]).toMatch(/^✓ neon-707 · member of stack-swarm · agy/);
    expect(t[1]).toBe('Gemini 4 Neon (High) · worker · ↓ 180k · last post #15');
    expect(t).toContain('No detail recorded yet.');
  });
});

describe('the pane with a real job directory (needs the team reader)', () => {
  const dir = '/work/.agent-smith/jobs/job-swarm';
  const memberView: MemberView = { schema: 1, id: 'neon-681-core', name: 'neon-681-core', brief: 'Full brief', report: 'Posted findings', truncated: false,
    timeline: [{ sequence: 0, kind: 'assistant', at: iso(NOW), text: 'Reading note_reading.rs.' }] };
  const files = (): Record<string, string> => ({
    [`${dir}/job.json`]: JSON.stringify({ schema: 1, jobId: 'job-swarm', workerId: 'swarm', task: '/swarm Review', status: 'running', name: 'swarm', provider: 'agy',
      startedAt: iso(NOW - 5000), updatedAt: iso(NOW) }),
    [`${dir}/view.json`]: JSON.stringify({ schema: 1, prompt: '/swarm Review', preamble: '', truncated: false, tools: [], transcript: [], timeline: [] }),
    [`${dir}/team.json`]: JSON.stringify(team(MEMBERS)),
    [`${dir}/members/${memberFileName('neon-681-core')}`]: JSON.stringify(memberView),
  });
  const PANE_TARGET = { plugin: 'agent-smith', surface: 'terminal', component: 'Pane', requestId: 'agent-smith', viewport: { columns: 119, rows: 40, isFullscreen: true },
    props: { title: 'Agent Smith', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as never;

  function host(on: any, f: Record<string, string>) {
    on('session.start', (_$: unknown, e: any) => ({ sessionId: 's', cwd: e.cwd }));
    on('command.register', () => ({ value: undefined }));
    on('env.get', () => ({ value: undefined }));
    on('ui.open', () => ({ value: { isPlaced: true } }));
    on('ui.toast', () => ({ value: undefined }));
    on('ui.scroll', () => ({}));
    on('ui.close', () => ({ value: undefined }));
    on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'REST-OF-BAND' }));
    on('tool.call', () => ({ result: { success: true } }));
    mock.clock(on as never, { now: NOW });
    on('fs.list', () => ({ value: [{ name: 'job-swarm', kind: 'dir', size: 0 }] }));
    on('fs.exists', (_$: unknown, e: any) => ({ value: e.path === '/work/.agent-smith/jobs' || Object.hasOwn(f, e.path) }));
    on('fs.read', (_$: unknown, e: any) => (f[e.path] === undefined ? { deny: 'ENOENT' } : { value: f[e.path] }));
  }
  const open = async ($: any) => {
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    await $.command.run({ command: 'forge', args: 'swarm' });
    return $.ui.mount(PANE_TARGET);
  };

  test('team rows open a member, Back returns to the worker, and the worker Back clears the member', async ($, on) => {
    host(on, files());
    const pane = await open($);
    expect(await pane.find({ key: 'member-neon-681-core' })).toBeDefined();
    await pane.press({ key: 'member-neon-681-core' });
    expect(await pane.find({ type: 'Markdown', text: 'Posted findings' })).toBeDefined();
    await pane.press({ key: 'back' });
    expect(await pane.find({ key: 'member-neon-681-core' })).toBeDefined();
    await pane.press({ key: 'member-neon-681-core' });
    await pane.press({ key: 'close' });
    await $.command.run({ command: 'forge', args: 'swarm' });
    expect(await pane.find({ key: 'member-neon-681-core' })).toBeDefined();
  });

  test('m opens the whole team', async ($, on) => {
    host(on, files());
    const pane = await open($);
    expect(await pane.find({ key: 'member-neon-710' })).toBeUndefined();
    await pane.press({ key: 'team' });
    expect(await pane.find({ key: 'member-neon-710' })).toBeDefined();
  });

  test('a member without a view file shows its header and no detail', async ($, on) => {
    const f = files();
    delete f[`${dir}/members/${memberFileName('neon-681-core')}`];
    host(on, f);
    const pane = await open($);
    await pane.press({ key: 'member-neon-681-core' });
    expect(await pane.find({ type: 'Text', text: 'No detail recorded yet.' })).toBeDefined();
  });
});

describe('the Result block', () => {
  const tool = (sequence: number) => ({ sequence, kind: 'tool', at: iso(NOW), stepIndex: sequence, tool: 'Read', input: 'a.rs', output: 'x', state: 'done' });
  const note = { sequence: 1, kind: 'message', at: iso(NOW), sender: 'steer', text: 'go on' };
  const finished = (timeline: unknown[], report: string | null): ForgeDetail => ({
    job: { ...job(MEMBERS), status: 'succeeded', endedAt: NOW, report }, timeline } as unknown as ForgeDetail);
  const view = (timeline: unknown[], report: string | null): MemberView =>
    ({ schema: 1, id: 'neon-681-core', name: 'neon-681-core', brief: 'b', report, truncated: false, timeline } as unknown as MemberView);
  const around = async (pane: any) => {
    const all = await texts(pane);
    const at = all.indexOf('● Result');
    return { at, before: all.slice(0, at), all };
  };
  const trailingBlanks = (before: string[]) => before.length - 1 - before.map((t) => t.trim() !== '').lastIndexOf(true);

  test('worker: one blank row, then a bold marked heading, under the last timeline row', async ($, on) => {
    const pane = await draw($, on, (W) => renderWorker(W, finished([note], 'All done'), options(), actions));
    const { at, before } = await around(pane);
    expect(at).toBeGreaterThan(0);
    expect(trailingBlanks(before)).toBe(1);
    expect(await pane.find({ type: 'Markdown', text: 'All done' })).toBeDefined();
  });

  test('worker: an expanded tool row already ends in a blank, so the gap is not doubled', async ($, on) => {
    const pane = await draw($, on, (W) => renderWorker(W, finished([tool(0)], 'All done'), options({ tools: ['event-0'] }), actions));
    expect(trailingBlanks((await around(pane)).before)).toBe(1);
  });

  test('worker: no report keeps its line under the same heading', async ($, on) => {
    const pane = await draw($, on, (W) => renderWorker(W, finished([note], null), options(), actions));
    const { at, all } = await around(pane);
    expect(all[at + 1]).toBe('No report was written.');
  });

  test('member: the same gap and heading', async ($, on) => {
    const a = await draw($, on, (W) => renderMember(W, job(MEMBERS), MEMBERS[0]!, view([note], 'Posted'), options(), actions));
    expect(trailingBlanks((await around(a)).before)).toBe(1);
    const b = await draw($, on, (W) => renderMember(W, job(MEMBERS), MEMBERS[0]!, view([tool(0)], 'Posted'), options({ tools: ['event-0'] }), actions));
    expect(trailingBlanks((await around(b)).before)).toBe(1);
    const c = await draw($, on, (W) => renderMember(W, job(MEMBERS), MEMBERS[3]!, view([note], null), options(), actions));
    const { at, all } = await around(c);
    expect(all[at + 1]).toBe('No report recorded.');
  });
});
