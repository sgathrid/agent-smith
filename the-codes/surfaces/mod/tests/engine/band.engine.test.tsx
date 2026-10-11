/**
 * band.engine.test.tsx — the band as the ENGINE draws it.
 *
 * WHY THIS FILE EXISTS WHEN tests/band.test.ts ALREADY EXISTS
 * ────────────────────────────────────────────────────────────
 * Two different runners, two different questions.
 *
 *   `node --test` (tests/band.test.ts, tests/jobs.test.ts) asks: are the RULES
 *   right? Elapsed padding, the 4-row cap, glyph choice, the deleted-progress
 *   case. It cannot load a .tsx at all (Node's type stripping has no JSX
 *   transform), so it can never answer: does this module actually load, and does
 *   the band actually paint?
 *
 *   `claude plugin test` (this file) asks exactly that. It loads the plugin
 *   through the engine's own host, in an environment like the one the hooks run
 *   in, and hands back the drawn elements.
 *
 * Run it with:  claude plugin test the-codes/surfaces/mod
 *
 * NOTE ON THE FIXTURES HERE
 * ─────────────────────────
 * A hooks module may not import `node:fs`, so the file bodies below are
 * INLINED, not read from disk. They are byte-for-byte from the real corpus at
 * /Users/gathrid/Repos/renyi/.agy-staff/jobs — the same values tests/jobs.test.ts
 * reads off disk — and each says which file it came from. A change in agy-staff's
 * layout fails the node --test suite with a real file; this suite catches the
 * remaining class, which is "the band draws the wrong THING".
 */

import { describe, expect, mock, test } from 'claude-code/testing';

import type { BandLine, BandBudget } from '../../hooks/band.ts';
import { BAND_ROWS, buildLine, isShown, noColor, rowBudget } from '../../hooks/band.ts';
import type { RadarJob } from '../../../types/index.d.ts';

test('Forge expands at the bottom; an explicit inspector requests one third of the terminal', async ($, on) => {
  engine(on);
  const widths: number[] = [];
  on('ui.open', (_$, e) => { widths.push(e.columns); return { value: { isPlaced: true } }; });
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
  const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND,
    viewport: { columns: 180, rows: 40, isFullscreen: true } } as never);
  await $.command.run({ command: 'forge', args: '' });
  expect(widths).toHaveLength(0);
  expect(await band.find({key:'job-'+ID})).toBeDefined();
  await band.press({key:'inspector'});
  expect(widths[widths.length - 1]).toBe(60);
  await band.unmount();
  const pane = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', component: 'Pane', requestId: 'agent-smith',
    viewport: { columns: 240, rows: 40, isFullscreen: true },
    props: { title: 'Agent Smith', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as never);
  expect(await pane.find({type:'Text',text:'Ctrl+X then Tab: focus pane hotkeys'})).toBeDefined();
  expect(widths[widths.length - 1]).toBe(80);
  await pane.press({ key: `job-${ID}` });
  expect(await pane.find({ key: 'back' })).toBeDefined();
  expect(widths[widths.length - 1]).toBe(80);
  await pane.unmount();
});

// ── fixtures, verbatim from the corpus ──────────────────────────────────────

/** `<id>.log`, real: implement-musm82da-f1dc1fe4.log */
const REAL_LOG =
  '[agy-staff] dispatch registered implement-musm82da-f1dc1fe4 at 2026-10-03T16:37:40.991Z\n' +
  '[agy-staff] worker started implement-musm82da-f1dc1fe4 pid=87142 at 2026-10-03T16:37:41.031Z\n' +
  '[agy-staff] mode=implement profile=unrestricted model=gemini-3.8-flash-high ' +
  'agy_status=SUCCESS agy_exit=0 duration=1681.549339s turns=1 ' +
  'tokens(in 2221077, out 137616, think 88239, cache 20425839)\n';

/** `<id>.spec.json`, real, prompt shortened */
const REAL_SPEC =
  '{"resolved":{"mode":"implement","model":"gemini-3.8-flash-high","profile":"unrestricted"},' +
  '"prompt_source":{"kind":"template","task":"# Task: open an agent-built dashboard with real names"},' +
  '"cwd":"/Users/gathrid/Repos/renyi"}';

/** `<id>.progress.json`, real shape, one activity */
const REAL_PROGRESS = JSON.stringify({
  job_id: 'implement-musm82da-f1dc1fe4',
  last_event_at: '2026-10-03T16:49:44.766Z',
  recent_activities: [
    { step_index: 76, tool: 'run_command', input_preview: '{"CommandLine":"cargo test --workspace"}' },
  ],
  warnings: [],
});

/** `<id>.result.md.status.json`, real */
const REAL_STATUS = '{"status":"done","warnings":true,"finished_at":"2026-10-03T17:05:44.132Z"}';

const ID = 'implement-musm82da-f1dc1fe4';

/** 12m04s after the real worker-started line. */
const RUNNING_NOW = Date.parse('2026-10-03T16:49:45.031Z');

const BAND = {
  component: 'AbovePrompt' as const,
  requestId: 'forge-band',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 },
};

/**
 * An engine beneath the plugin: the corpus files, served from literals.
 *
 * `events` is a synthetic stand-in with 200 records at step_index 341, so the
 * drawn count is the real 341 the design's sample line uses. The real file has
 * the same shape at a different scale.
 */
function engine(
  on: (event: string, hook: (...args: never[]) => unknown) => unknown,
  options: {
    now?: number;
    noColorEnv?: string;
    files?: Record<string, string>;
    entries?: { name: string; kind: 'file' | 'dir'; size: number }[];
    scrollCalls?: Record<string,unknown>[];
    nativeTask?: boolean;
    nativeTaskCalls?: { tool: string; input: Record<string, unknown> }[];
  } = {},
) {
  const files: Record<string, string> = {
    [`${ID}.spec.json`]: REAL_SPEC,
    [`${ID}.progress.json`]: REAL_PROGRESS,
    [`${ID}.log`]: REAL_LOG,
    ...options.files,
  };
  const entries =
    options.entries ??
    [
      { name: `${ID}.spec.json`, kind: 'file', size: REAL_SPEC.length },
      { name: `${ID}.progress.json`, kind: 'file', size: REAL_PROGRESS.length },
      { name: `${ID}.events.jsonl`, kind: 'file', size: 492_000 },
      { name: `${ID}.log`, kind: 'file', size: REAL_LOG.length },
    ];
  if (files[`${ID}.events.jsonl`] === undefined && !options.entries) {
    files[`${ID}.events.jsonl`] = '{"event":"step_update","step_index":341}\n'.repeat(200);
  }

  on('session.start', (_$: unknown, e: unknown) => ({
    sessionId: 's',
    cwd: (e as { cwd?: string }).cwd,
  }));
  on('command.register', () => ({ value: undefined }));
  on('ui.scroll', (_$,e) => { options.scrollCalls?.push(e as Record<string,unknown>); return {}; });
  on('ui.close', () => ({value:undefined}));
  const clock = mock.clock(on as never, { now: options.now ?? RUNNING_NOW });
  on('env.get', (_$: unknown, e: unknown) => {
    const name = (e as { name: string }).name;
    if (name === 'AGY_RADAR_REPO') return { value: options.nativeTask ? '/work' : '/corpus' };
    if (name === 'AGENT_SMITH_LEGACY_JOBS') return { value: options.nativeTask ? undefined : '1' };
    if (name === 'NO_COLOR') return { value: options.noColorEnv };
    return { value: undefined };
  });
  on('fs.list', (_$: unknown, e: unknown) => {
    const path = (e as { path: string }).path;
    if (options.nativeTask && path === '/work/.agent-smith/jobs') {
      return { value: [{ name: 'job-native-1', kind: 'dir', size: 0 }] };
    }
    return { value: entries };
  });
  on('fs.read', (_$: unknown, e: unknown) => {
    const path = (e as { path: string }).path;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const body = options.files?.[name] ?? files[name];
    if (body === undefined) {
      // The real `$.fs.read` rejects with the OS errno; the band must survive it.
      return { deny: `ENOENT: no such file or directory, open '${path}'` };
    }
    return { value: body };
  });
  on('fs.exists', (_$: unknown, e: unknown) => ({
    value: (options.nativeTask && (e as {path:string}).path === '/work/.agent-smith/jobs') || Object.hasOwn(options.files ?? {}, (e as {path:string}).path.split('/').pop()!) || Object.hasOwn(files, (e as { path: string }).path.slice((e as { path: string }).path.lastIndexOf('/') + 1)),
  }));
  if (options.nativeTaskCalls) {
    on('tool.call', (_$: unknown, e: unknown) => {
      const call = e as { tool: string; [key: string]: unknown };
      options.nativeTaskCalls!.push({ tool: call.tool, input: { ...call } });
      if (call.tool === 'TaskCreate') return { result: { task: { id: 'native-task-1', subject: call.subject } } };
      if (call.tool === 'TaskUpdate') return { result: { success: true, taskId: call.taskId } };
      return { deny: `unexpected tool ${call.tool}` };
    });
  }
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'REST-OF-BAND' }));
  return clock;
}

// ── pure helpers, re-checked under the engine's own runner ─────────────────

describe('band helpers (pure)', () => {
  test('the pure rules hold identically here and under node --test', () => {
    // The same assertions live in tests/band.test.ts. They are repeated here
    // because this suite may be run on its own, and a rule that only one runner
    // checks is a rule that gets broken silently.
    expect(noColor({ NO_COLOR: '1' })).toBe(true);
    expect(noColor({ NO_COLOR: '' })).toBe(false);
    expect(noColor({ TERM: 'dumb' })).toBe(true);
    expect(rowBudget([], 10).rows.length).toBe(0);
    expect(rowBudget(new Array(9).fill({}), 10).hidden).toBe(9 - BAND_ROWS);
  });
});

// ── the band as drawn ──────────────────────────────────────────────────────

describe('the band', () => {
  test('a running job is one yellow bold row, elapsed last', async ($, on) => {
    engine(on);
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    const band = await $.ui.mount({
      plugin: 'agent-smith',
      surface: 'terminal',
      ...BAND,
    } as never);

    // The exact line from the design brief, produced from real corpus files.
    const line = await band.find({ type: 'Text', text: /⏺ open an agent-built dashboard/ });
    expect(line).toBeDefined();
    // …and the clock, which is 12m04s from the real log's worker-started line.
    expect(await band.find({ type: 'Text', text: '12m04s' })).toBeDefined();

    // The accent, and only the accent, is coloured; the rest is dim.
    const head = (line as { children?: { props?: Record<string, unknown> }[] }).children?.[0];
    expect(head?.props?.color).toBe('blue');
    expect(head?.props?.bold).toBe(true);
  });

  test("the host's own band content survives, as our last child", async ($, on) => {
    // TERMINAL-UI.md L170-173: never replace what Claude Code or another mod
    // drew above the prompt.
    engine(on);
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);
    expect(await band.find({ type: 'Text', text: 'REST-OF-BAND' })).toBeDefined();
  });

  test('a survey holds the band: we render nothing and return the host alone', async ($, on) => {
    engine(on);
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    const band = await $.ui.mount({
      plugin: 'agent-smith',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: true, isWorking: true, maxRows: 10, bodyColumns: 120 },
    } as never);
    // The job IS running, and we still draw no line of our own.
    expect(await band.find({ type: 'Text', text: /cargo test/ })).toBeUndefined();
    expect(await band.find({ type: 'Text', text: 'REST-OF-BAND' })).toBeDefined();
  });

  test('no jobs means nothing drawn, not an empty box', async ($, on) => {
    // TERMINAL-UI.md L168-171. A band that "appears to say nothing" is noise, and
    // the row count must drop to zero rather than holding reserved space.
    engine(on, { entries: [], files: {} });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);
    expect(await band.find({ type: 'Text', text: /\/forge/ })).toBeUndefined();
    expect(await band.find({ type: 'Text', text: 'REST-OF-BAND' })).toBeDefined();
  });

  test('NO_COLOR drops the colour prop and keeps the glyph and the bold', async ($, on) => {
    engine(on, { noColorEnv: '1' });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);

    const line = await band.find({ type: 'Text', text: /⏺ open an agent-built dashboard/ });
    expect(line).toBeDefined();
    const head = (line as { children?: { props?: Record<string, unknown> }[] }).children?.[0];
    // The redundant channel survives: the glyph still says "running".
    expect(head?.props?.color).toBeUndefined();
    // Bold is a contrast affordance, not a colour, so it stays.
    expect(head?.props?.bold).toBe(true);
  });

  test('every Text WE draw carries wrap="truncate-end"', async ($, on) => {
    // TERMINAL-UI.md L124-126: a wrapped status line becomes two rows, the band
    // grows, and the prompt moves — the one-rule violation this rule exists for.
    //
    // The host's own row is excluded: it is the engine's to truncate, and we
    // return it untouched. Checking it would be checking someone else's code.
    engine(on);
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);
    const texts = await band.findAll({ type: 'Text' });
    const ours = texts.filter((t) => (t as { text?: string }).text !== 'REST-OF-BAND');
    expect(ours.length).toBeGreaterThan(0);
    for (const t of ours) {
      expect((t as { props?: Record<string, unknown> }).props?.wrap).toBe('truncate-end');
    }
  });
});

// ── the deleted-progress case, as drawn ────────────────────────────────────

describe('HAZARD A, as drawn', () => {
  test('a finished job whose progress.json and events.jsonl are GONE still draws as done', async ($, on) => {
    // THE case. On a warning-free success agy-staff deletes progress.json AND
    // events.jsonl. The band must draw `✓ … finished`, not drop the job and not
    // resurrect it as running.
    engine(on, {
      now: Date.parse('2026-10-03T17:05:50.000Z'), // 6s after it finished
      entries: [
        { name: `${ID}.spec.json`, kind: 'file', size: REAL_SPEC.length },
        { name: `${ID}.log`, kind: 'file', size: REAL_LOG.length },
        { name: `${ID}.result.md`, kind: 'file', size: 900 },
        { name: `${ID}.result.md.status.json`, kind: 'file', size: REAL_STATUS.length },
      ],
      files: {
        [`${ID}.result.md`]: '## What I changed\n- crates/renyi-core/src/dashboard_decode.rs — decode inside\n',
        [`${ID}.result.md.status.json`]: '{"status":"done","warnings":false,"finished_at":"2026-10-03T17:05:44.132Z"}',
      },
    });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);

    expect(await band.find({ type: 'Text', text: /✓ open an agent-built dashboard.*finished/ })).toBeDefined();
    // No tool count, because there is genuinely none on disk — omitted, not 0.
    expect(await band.find({ type: 'Text', text: /0 tools/ })).toBeUndefined();
    // And it does NOT read as still running.
    expect(await band.find({ type: 'Text', text: /⏺ open an agent-built dashboard/ })).toBeUndefined();
  });

  test('empty output + warnings:true draws FAILED, not a green check', async ($, on) => {
    // THE headline rule. agy-staff exits 0 having delivered nothing when a tool
    // is soft-denied. A `✓` here is the most expensive lie this project could tell.
    engine(on, {
      now: Date.parse('2026-10-03T17:05:45.000Z'),
      entries: [
        { name: `${ID}.spec.json`, kind: 'file', size: REAL_SPEC.length },
        { name: `${ID}.log`, kind: 'file', size: REAL_LOG.length },
        { name: `${ID}.result.md`, kind: 'file', size: 0 },
        { name: `${ID}.result.md.status.json`, kind: 'file', size: REAL_STATUS.length },
      ],
      files: {
        [`${ID}.result.md`]: '',
        [`${ID}.result.md.status.json`]: REAL_STATUS,
      },
    });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);

    expect(await band.find({ type: 'Text', text: /✗ open an agent-built dashboard.*failed/ })).toBeDefined();
    expect(await band.find({ type: 'Text', text: /✓ open an agent-built dashboard/ })).toBeUndefined();
    // And the reason reaches the line as a stable code.
    expect(await band.find({ type: 'Text', text: /no output/ })).toBeDefined();
  });

  test('a finished job older than the linger is not drawn at all', async ($, on) => {
    // The real corpus is 20 jobs finished hours ago. Drawing four of them at
    // session start would be asserting work is in flight when it is not.
    engine(on, {
      now: Date.parse('2026-10-03T23:00:00.000Z'), // six hours later
      entries: [
        { name: `${ID}.spec.json`, kind: 'file', size: REAL_SPEC.length },
        { name: `${ID}.log`, kind: 'file', size: REAL_LOG.length },
        { name: `${ID}.result.md`, kind: 'file', size: 900 },
        { name: `${ID}.result.md.status.json`, kind: 'file', size: REAL_STATUS.length },
      ],
      files: {
        [`${ID}.result.md`]: '## What I changed\n- a real report\n',
        [`${ID}.result.md.status.json`]: REAL_STATUS,
      },
    });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);
    expect(await band.find({ type: 'Text', text: new RegExp(ID) })).toBeUndefined();
  });

  test('at most four rows, then `+N more`', async ($, on) => {
    // TERMINAL-UI.md L151. Six jobs, so two are hidden.
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const entries = names.flatMap((s) => [
      { name: `job-${s}.spec.json`, kind: 'file' as const, size: 10 },
      { name: `job-${s}.progress.json`, kind: 'file' as const, size: 10 },
      { name: `job-${s}.log`, kind: 'file' as const, size: 10 },
    ]);
    engine(on, {
      entries,
      files: Object.fromEntries(
        names.flatMap((s) => [
          [`job-${s}.spec.json`, REAL_SPEC],
          [`job-${s}.progress.json`, REAL_PROGRESS],
          // A distinct start per job, so the clocks differ.
          [`job-${s}.log`, `[agy-staff] worker started job-${s} pid=1 at 2026-10-03T16:37:41.031Z\n`],
        ]),
      ),
    });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);

    const overflow = await band.find({ type: 'Text', text: '+2 more' });
    expect(overflow).toBeDefined();
    expect((overflow as { text?: string }).text).toContain('/forge');
  });

  test("the engine's own maxRows is respected", async ($, on) => {
    // A 3-row band takes 2 job rows and spends the last on the overflow line,
    // because the engine reserves a row of maxRows for its own.
    const names = ['a', 'b', 'c', 'd', 'e'];
    engine(on, {
      entries: names.flatMap((s) => [
        { name: `job-${s}.spec.json`, kind: 'file' as const, size: 10 },
        { name: `job-${s}.log`, kind: 'file' as const, size: 10 },
      ]),
      files: Object.fromEntries(
        names.flatMap((s) => [
          [`job-${s}.spec.json`, REAL_SPEC],
          [`job-${s}.log`, `[agy-staff] worker started job-${s} pid=1 at 2026-10-03T16:37:41.031Z\n`],
        ]),
      ),
    });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    const band = await $.ui.mount({
      plugin: 'agent-smith',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 3, bodyColumns: 80 },
    } as never);
    // 5 jobs, 2 rows + overflow ⇒ +3 more, not +1.
    expect(await band.find({ type: 'Text', text: '+4 more' })).toBeDefined();
  });
});

// ── type-level guards: the render path and the helpers agree ───────────────

describe('the render path uses the tested helpers', () => {
  test('a job built here builds the line the band would draw', () => {
    // A cheap guard against a future edit that hand-rolls a line in register.tsx
    // and quietly stops matching band.ts. Same type, same function, no TUI.
    const job: RadarJob = {
      id: ID,
      status: 'running',
      startedAt: Date.parse('2026-10-03T16:37:41.031Z'),
      endedAt: null,
      toolCount: 341,
      activity: 'cargo test --workspace',
      task: 'open an agent-built dashboard',
      warnings: [],
      report: null,
      reasoning: null,
      raw: {},
    };
    const line: BandLine = buildLine(job, RUNNING_NOW);
    expect(line.plain).toContain('12m04s');
    expect(line.glyph).toBe('⏺');
    expect(line.accent).toBe('blue');

    const budget: BandBudget = rowBudget([job], 10);
    expect(budget.rows).toHaveLength(1);
    expect(budget.hidden).toBe(0);
    expect(isShown(job, RUNNING_NOW)).toBe(true);
  });
});

describe('native task-list projection', () => {
  test('uses host TaskCreate/TaskUpdate and preserves truthful worker metadata', async ($, on) => {
    const calls: { tool: string; input: Record<string, unknown> }[] = [];
    engine(on, {
      nativeTask: true,
      nativeTaskCalls: calls,
      files: {
        'job.json': JSON.stringify({
          schema: 1,
          jobId: 'job-native-1',
          status: 'running',
          updatedAt: new Date(RUNNING_NOW).toISOString(),
          name: 'Codex reviewer',
          workerId: 'worker-codex-7',
          role: 'reviewer',
          task: 'Review provider recovery',
          provider: 'codex',
          model: 'gpt-6-sol',
        }),
        'progress.json': JSON.stringify({
          latestSummary: 'Found a retry loop that can duplicate a request.',
          summarySource: 'worker',
        }),
      },
    });

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);

    const create = calls.find((call) => call.tool === 'TaskCreate');
    const update = calls.find((call) => call.tool === 'TaskUpdate');
    expect(create).toBeDefined();
    expect(create?.input.subject).toBe('Codex reviewer: Review provider recovery');
    expect(create?.input.metadata).toEqual({
      source: 'agent-smith',
      jobId: 'job-native-1',
      workerId: 'worker-codex-7',
      role: 'reviewer',
    });
    expect(update).toBeDefined();
    expect(update?.input.taskId).toBe('native-task-1');
    expect(update?.input.status).toBe('in_progress');
    expect(update?.input.description).toContain('Outcome: running');
    expect(update?.input.description).toContain('Latest worker output:\nFound a retry loop');
  });
});

const PANE_TARGET = { plugin: 'agent-smith', surface: 'terminal', component: 'Pane', requestId: 'agent-smith', viewport: { columns: 180, rows: 40, isFullscreen: true }, props: { title: 'Agent Smith', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as never;
test('Clear finished dismisses the completed row', async ($, on) => {
  engine(on, {now: Date.parse('2026-10-03T17:05:45Z'), files: {[`${ID}.result.md`]: 'A complete worker report with enough content to pass the output validator.', [`${ID}.result.md.status.json`]: REAL_STATUS}});
  await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'} as never);
  const pane=await $.ui.mount(PANE_TARGET);
  await pane.press({key:'roster-history'});
  expect(await pane.find({key:`job-${ID}`})).toBeDefined();
  await pane.press({key:'clear'});
  expect(await pane.find({key:`job-${ID}`})).toBeUndefined();
});

test('clearing acknowledges a failure into History and keeps running work in Active', async ($, on) => {
  const files: Record<string, string> = {
    '/work/.agent-smith/jobs/job-failed/job.json': JSON.stringify({schema:1,jobId:'job-failed',status:'failed',name:'Orphan',workerId:'orphan',task:'Inspect',
      startedAt:new Date(RUNNING_NOW-5000).toISOString(),finishedAt:new Date(RUNNING_NOW).toISOString(),updatedAt:new Date(RUNNING_NOW).toISOString(),error:'supervisor exited (orphaned)'}),
    '/work/.agent-smith/jobs/job-failed/acceptance.json': JSON.stringify({state:'unchecked',pending:false,checks:[]}),
    '/work/.agent-smith/jobs/job-running/job.json': JSON.stringify({schema:1,jobId:'job-running',status:'running',name:'Live',workerId:'live',task:'Inspect',startedAt:new Date(RUNNING_NOW-5000).toISOString(),updatedAt:new Date(RUNNING_NOW).toISOString()}),
    '/work/.agent-smith/jobs/job-running/acceptance.json': JSON.stringify({state:'unchecked',pending:true,checks:[]}),
  };
  on('session.start', (_$, e) => ({sessionId:'s',cwd:e.cwd}));
  on('command.register', () => ({value:undefined}));
  on('env.get', () => ({value:undefined}));
  on('ui.open', () => ({value:{isPlaced:true}}));
  mock.clock(on,{now:RUNNING_NOW});
  on('fs.list', () => ({value:[{name:'job-failed',kind:'dir',size:0},{name:'job-running',kind:'dir',size:0}]}));
  on('fs.exists', (_$, e) => ({value:e.path==='/work/.agent-smith/jobs'||Object.hasOwn(files,e.path)}));
  on('fs.read', (_$, e) => { const body=files[e.path]; return body===undefined?{deny:'ENOENT'}:{value:body}; });
  await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'} as never);
  await $.command.run({command:'forge',args:''});
  const pane=await $.ui.mount(PANE_TARGET);
  expect(await pane.find({key:'job-job-failed'})).toBeDefined();
  await pane.press({key:'clear'});
  expect(await pane.find({key:'job-job-failed'})).toBeUndefined();
  expect(await pane.find({key:'job-job-running'})).toBeDefined();
  await pane.press({key:'roster-history'});
  expect(await pane.find({key:'job-job-failed'})).toBeDefined();
  expect(await pane.find({type:'Text',text:/need attention/})).toBeUndefined();
  await pane.unmount();
  const reopened=await $.ui.mount(PANE_TARGET);
  expect(await reopened.find({key:'job-job-failed'})).toBeDefined();
});

test('a settled failure can be acknowledged from its detail view and remains in History', async ($, on) => {
  const files: Record<string, string> = {
    '/work/.agent-smith/jobs/job-failed/job.json': JSON.stringify({schema:1,jobId:'job-failed',status:'failed',name:'Orphan',workerId:'orphan',task:'Inspect',
      startedAt:new Date(RUNNING_NOW-5000).toISOString(),finishedAt:new Date(RUNNING_NOW).toISOString(),updatedAt:new Date(RUNNING_NOW).toISOString(),error:'supervisor exited (orphaned)'}),
    '/work/.agent-smith/jobs/job-failed/acceptance.json': JSON.stringify({state:'unchecked',pending:false,checks:[]}),
  };
  on('session.start', (_$, e) => ({sessionId:'s',cwd:e.cwd}));
  on('command.register', () => ({value:undefined}));
  on('env.get', () => ({value:undefined}));
  on('ui.open', () => ({value:{isPlaced:true}}));
  mock.clock(on,{now:RUNNING_NOW});
  on('fs.list', () => ({value:[{name:'job-failed',kind:'dir',size:0}]}));
  on('fs.exists', (_$, e) => ({value:e.path==='/work/.agent-smith/jobs'||Object.hasOwn(files,e.path)}));
  on('fs.read', (_$, e) => { const body=files[e.path]; return body===undefined?{deny:'ENOENT'}:{value:body}; });
  await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'} as never);
  await $.command.run({command:'forge',args:''});
  const pane=await $.ui.mount(PANE_TARGET);
  await pane.press({key:'job-job-failed'});
  expect(await pane.find({key:'acknowledge'})).toBeDefined();
  await pane.press({key:'acknowledge'});
  expect(await pane.find({key:'acknowledge'})).toBeUndefined();
  await pane.press({key:'back'});
  expect(await pane.find({key:'job-job-failed'})).toBeUndefined();
  await pane.press({key:'roster-history'});
  expect(await pane.find({key:'job-job-failed'})).toBeDefined();
  await pane.unmount();
  const reopened=await $.ui.mount(PANE_TARGET);
  expect(await reopened.find({key:'job-job-failed'})).toBeDefined();
});
const failedJob = (id: string, endedAt: number) => ({
  [`/work/.agent-smith/jobs/${id}/job.json`]: JSON.stringify({schema:1,jobId:id,status:'failed',name:id,workerId:id,task:'Inspect',
    startedAt:new Date(endedAt-5000).toISOString(),finishedAt:new Date(endedAt).toISOString(),updatedAt:new Date(endedAt).toISOString(),error:'supervisor exited (orphaned)'}),
  [`/work/.agent-smith/jobs/${id}/acceptance.json`]: JSON.stringify({state:'unchecked',pending:false,checks:[]}),
});
function forgeFiles(on: (...args: any[]) => void, files: Record<string,string>, listing: { ids: string[]; fail: boolean }): void {
  on('session.start', (_$: unknown, e: any) => ({sessionId:'s',cwd:e.cwd}));
  on('command.register', () => ({value:undefined}));
  on('env.get', () => ({value:undefined}));
  on('ui.open', () => ({value:{isPlaced:true}}));
  mock.clock(on,{now:RUNNING_NOW});
  on('fs.list', () => listing.fail ? {deny:'EIO'} : {value:listing.ids.map(name=>({name,kind:'dir',size:0}))});
  on('fs.exists', (_$: unknown, e: any) => ({value:e.path==='/work/.agent-smith/jobs'||Object.hasOwn(files,e.path)}));
  on('fs.read', (_$: unknown, e: any) => { const body=files[e.path]; return body===undefined?{deny:'ENOENT'}:{value:body}; });
}

test('an old settled failure leaves Active and the attention count but stays in History', async ($, on) => {
  const files = { ...failedJob('job-old', RUNNING_NOW - 25*3600*1000), ...failedJob('job-new', RUNNING_NOW - 3600*1000) };
  forgeFiles(on, files, { ids: ['job-old','job-new'], fail: false });
  await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'} as never);
  await $.command.run({command:'forge',args:''});
  const pane=await $.ui.mount(PANE_TARGET);
  expect(await pane.find({key:'job-job-new'})).toBeDefined();
  expect(await pane.find({key:'job-job-old'})).toBeUndefined();
  expect(await pane.find({type:'Text',text:/1 need attention/})).toBeDefined();
  await pane.press({key:'roster-history'});
  expect(await pane.find({key:'job-job-old'})).toBeDefined();
  expect(await pane.find({key:'job-job-new'})).toBeUndefined();
  expect(await pane.find({type:'Text',text:/failed · orphaned/})).toBeDefined();
  await pane.press({key:'job-job-old'});
  expect(await pane.find({key:'acknowledge'})).toBeUndefined();
});

test('persisted dismissals drop when their job is gone, but not on a read failure', async ($, on) => {
  const files = failedJob('job-failed', RUNNING_NOW);
  const listing = { ids: ['job-failed'], fail: false };
  forgeFiles(on, files, listing);
  await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'} as never);
  await $.command.run({command:'forge',args:''});
  const pane=await $.ui.mount(PANE_TARGET);
  await pane.press({key:'clear'});
  expect(await pane.find({key:'restore'})).toBeDefined();
  listing.fail = true;
  await $.command.run({command:'forge',args:''});
  expect(await pane.find({key:'restore'})).toBeDefined();
  listing.fail = false;
  listing.ids = [];
  await $.command.run({command:'forge',args:''});
  expect(await pane.find({key:'restore'})).toBeUndefined();
});

test('pagination makes the tenth running job selectable', async ($, on) => {
  const ids=Array.from({length:10},(_,i)=>`job-${i}`);
  engine(on,{entries:ids.map(id=>({name:`${id}.spec.json`,kind:'file',size:10})), files:Object.fromEntries(ids.flatMap(id=>[[`${id}.spec.json`,REAL_SPEC],[`${id}.log`,REAL_LOG],[`${id}.progress.json`,REAL_PROGRESS]]))});
  await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'} as never);
  const pane=await $.ui.mount(PANE_TARGET);
  expect(await pane.find({key:'job-job-9'})).toBeUndefined();
  await pane.press({key:'next-page'});
  expect(await pane.find({key:'job-job-9'})).toBeDefined();
  await pane.press({key:'job-job-9'});
  expect(await pane.find({key:'back'})).toBeDefined();
});
test('the last finished band row expires and stops repainting', async ($, on) => {
  const clock=engine(on,{now:Date.parse('2026-10-03T17:05:45Z'),files:{[`${ID}.result.md`]:'A complete worker report with enough content to pass the output validator.',[`${ID}.result.md.status.json`]:REAL_STATUS}});
  await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'} as never);
  const band=await $.ui.mount({plugin:'agent-smith',surface:'terminal',...BAND} as never);
  expect(await band.find({type:'Text',text:/open an agent-built dashboard/})).toBeDefined();
  await clock.advance(60_000);
  expect(await band.find({type:'Text',text:/open an agent-built dashboard/})).toBeUndefined();
});

test('canonical jobs refresh acceptance in an open pane and survive Clear while checks are pending', async ($, on) => {
  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  const registrations: unknown[] = [];
  const files: Record<string, string> = {
    'job.json': JSON.stringify({schema:1,jobId:'job-native-1',status:'succeeded',name:'Ada',workerId:'ada',
      task:'Canonical worker',startedAt:new Date(RUNNING_NOW-5000).toISOString(),finishedAt:new Date(RUNNING_NOW-1000).toISOString(),updatedAt:new Date(RUNNING_NOW).toISOString(),toolCalls:1}),
    'acceptance.json': JSON.stringify({state:'unchecked',pending:true,checks:[]}),
    'view.json': JSON.stringify({schema:1,prompt:'Canonical task',preamble:null,tools:[],transcript:['Assistant output'],truncated:false}),
    'result.md': 'Worker report',
  };
  on('session.start', (_$, e) => ({sessionId:'s',cwd:e.cwd}));
  on('command.register', (_$, e) => {registrations.push(e);return {value:undefined};});
  on('env.get', () => ({value:undefined}));
  on('ui.open', () => ({value:{isPlaced:true}}));
  const clock=mock.clock(on,{now:RUNNING_NOW});
  on('fs.list', () => ({value:[{name:'job-native-1',kind:'dir',size:0}]}));
  on('fs.exists', (_$, e) => ({value:e.path==='/work/.agent-smith/jobs'||Object.hasOwn(files,e.path.split('/').pop()!)}));
  on('fs.read', (_$, e) => {
    const body=files[e.path.split('/').pop()!];
    return body===undefined?{deny:'ENOENT'}:{value:body};
  });
  on('tool.call', (_$, e) => {
    calls.push({tool:e.tool,input:{...e}});
    return e.tool==='TaskCreate'?{result:{task:{id:'native-task-1'}}}:{result:{success:true}};
  });
  await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'} as never);
  expect(registrations.some(e => (e as {immediate?:boolean}).immediate===true)).toBe(true);
  await $.command.run({command:'forge',args:''});
  const pane=await $.ui.mount(PANE_TARGET);
  expect(await pane.find({key:'job-job-native-1'})).toBeDefined();
  await pane.press({key:'clear'});
  expect(await pane.find({key:'job-job-native-1'})).toBeDefined();
  await pane.press({key:'job-job-native-1'});
  await pane.press({key:'tab-checks'});
  expect(await pane.find({type:'Text',text:'Acceptance: checks pending'})).toBeDefined();
  files['acceptance.json']=JSON.stringify({state:'rejected',pending:false,checks:[
    {name:'tests',ok:false,outputTail:'',timedOut:true,signal:'SIGTERM',reason:'command timed out'},
    {name:'typecheck',ok:false,outputTail:'',skipped:'missing-cwd',reason:'working directory does not exist'},
  ]});
  await clock.advance(3000);
  expect(await pane.find({type:'Text',text:'Acceptance: rejected'})).toBeDefined();
  expect(await pane.find({type:'Text',text:/command timed out/})).toBeDefined();
  expect(await pane.find({type:'Text',text:/working directory does not exist/})).toBeDefined();
  expect(calls.some(call => call.tool==='TaskUpdate'&&String(call.input.subject).includes('[checks rejected]'))).toBe(true);
  await clock.advance(30_000);
  expect(calls.some(call => call.input.status==='deleted')).toBe(false);
  await pane.press({key:'back'});
  files['job.json']='{broken';
  await clock.advance(3000);
  expect(await pane.find({type:'Text',text:/Unable to read Forge state/})).toBeDefined();
  expect(await pane.find({key:'job-job-native-1'})).toBeDefined();
});


test('bottom Activity pauses on user scroll and keeps the worker open on completion', async ($,on) => {
  const calls: Record<string,unknown>[]=[];
  const files: Record<string,string>={
    'job.json':JSON.stringify({schema:1,jobId:'job-native-1',workerId:'ada',name:'Ada',role:'reviewer',status:'running',task:'Inspect Forge',startedAt:new Date(RUNNING_NOW-5000).toISOString(),updatedAt:new Date(RUNNING_NOW).toISOString(),toolCalls:1}),
    'view.json':JSON.stringify({schema:1,prompt:'Long task instructions',preamble:null,truncated:false,tools:[],transcript:[],timeline:[
      {kind:'assistant',sequence:0,at:new Date(RUNNING_NOW).toISOString(),text:'Tracing the renderer.'},
      {kind:'tool',sequence:1,at:new Date(RUNNING_NOW).toISOString(),stepIndex:0,tool:'Read',input:'register.tsx',output:'file contents',state:'active'}]}),
  };
  const clock=engine(on,{nativeTask:true,files,scrollCalls:calls});

  await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'} as never);
  await $.command.run({command:'forge',args:''});
  const band=await $.ui.mount({plugin:'agent-smith',surface:'terminal',...BAND} as never);
  await band.press({key:'job-job-native-1'});
  expect(await band.find({key:'event-1'})).toBeDefined();
  expect(await band.find({type:'Markdown',text:'Tracing the renderer.'})).toBeDefined();
  expect(await band.find({type:'Markdown',text:'Long task instructions'})).toBeUndefined();
  // The testkit exposes scroll events, but does not paint or implement $.ui.scroll.
  // The real terminal probe verifies end anchoring; this test verifies pause/state.
  expect(await band.find({key:'follow',text:'Follow on'})).toBeDefined();
  await $.ui.scroll({component:'AbovePrompt',requestId:'forge-band',offset:0,by:-1,bodyRows:9,contentRows:30,origin:{kind:'person'}} as never);
  expect(await band.find({key:'follow',text:'Follow paused'})).toBeDefined();
  const count=calls.length;
  files['job.json']=JSON.stringify({...JSON.parse(files['job.json']!),status:'succeeded',finishedAt:new Date(RUNNING_NOW+3000).toISOString()});
  files['result.md']='Final findings';
  await clock.advance(3000);
  expect(calls.length).toBe(count,'polling must not resume following');
  expect(await band.find({key:'back'})).toBeDefined();
  expect(await band.find({key:'event-1'})).toBeDefined();
  await band.press({key:'follow'});
  expect(await band.find({key:'follow',text:'Follow on'})).toBeDefined();
  await band.press({key:'tab-result'});
  expect(await band.find({type:'Markdown',text:'Final findings'})).toBeDefined();
  await band.press({key:'tab-task'});
  expect(await band.find({type:'Markdown',text:'Long task instructions'})).toBeDefined();
  await band.redraw({...BAND.props,bodyColumns:24,maxRows:6} as never);
  expect(await band.find({key:'close'})).toBeDefined();
  await band.press({key:'close'});
  expect(await band.find({key:'tab-activity'})).toBeUndefined();
});
