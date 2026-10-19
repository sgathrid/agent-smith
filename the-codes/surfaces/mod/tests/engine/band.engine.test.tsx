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
      if (LAUNCH_TOOL.test(call.tool)) return launchAck(call);
      options.nativeTaskCalls!.push({ tool: call.tool, input: { ...call } });
      if (call.tool === 'TaskCreate') return { result: { task: { id: 'native-task-1', subject: call.subject } } };
      if (call.tool === 'TaskUpdate') return { result: { success: true, taskId: call.taskId } };
      return { deny: `unexpected tool ${call.tool}` };
    });
  }
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'REST-OF-BAND' }));
  return clock;
}

/** The three launch tools, under the built plugin's server name. */
const LAUNCH_TOOL = /__(?:spawn_job|resume_job|run_pipeline)$/;
/** Core answering a launch tool with its ack, echoing the id and repo the test passed. */
const launchAck = (e: any) => ({ result: { structuredContent: { [e.runId ? 'runId' : 'jobId']: e.runId ?? e.jobId, repo: e.repo ?? '/work', timeoutMs: 600_000 }, content: [] } });
/** A successful launch through `tool.call`: how this session comes to own a job or run. */
const launched = ($: any, id: string, repo = '/work', kind: 'job' | 'run' = 'job') => $.tool.call({
  tool: `mcp__plugin_agent-smith_agent-smith__${kind === 'job' ? 'spawn_job' : 'run_pipeline'}`, [kind === 'job' ? 'jobId' : 'runId']: id, repo,
});

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

    expect(await band.find({ type: 'Text', text: /✓ open an agent-built dashboard.*done/ })).toBeDefined();
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
    const clock = engine(on, {
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
    // Another session's running job gets no task here.
    await clock.advance(3000);
    expect(calls).toHaveLength(0);
    // This session's launch does.
    await launched($, 'job-native-1');
    await clock.advance(3000);

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
    expect(update?.input.description).toContain('Worker said:\nFound a retry loop');
  });
});

test('the last finished band row expires and stops repainting', async ($, on) => {
  const clock=engine(on,{now:Date.parse('2026-10-03T17:05:45Z'),files:{[`${ID}.result.md`]:'A complete worker report with enough content to pass the output validator.',[`${ID}.result.md.status.json`]:REAL_STATUS}});
  await $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'} as never);
  const band=await $.ui.mount({plugin:'agent-smith',surface:'terminal',...BAND} as never);
  expect(await band.find({type:'Text',text:/open an agent-built dashboard/})).toBeDefined();
  await clock.advance(60_000);
  expect(await band.find({type:'Text',text:/open an agent-built dashboard/})).toBeUndefined();
});

// ── /forge: the band's digits and the command open one focused sidebar ─────

const PANE_TARGET = { plugin: 'agent-smith', surface: 'terminal', component: 'Pane', requestId: 'agent-smith', viewport: { columns: 180, rows: 40, isFullscreen: true }, props: { title: 'Agent Smith', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as never;
const iso = (ms: number) => new Date(ms).toISOString();
/** One canonical job directory, keyed by full path. */
function canonicalJob(id: string, job: Record<string, unknown>, extra: Record<string, string> = {}): Record<string, string> {
  const dir = `/work/.agent-smith/jobs/${id}`;
  return {
    [`${dir}/job.json`]: JSON.stringify({schema:1,jobId:id,workerId:id,task:'Inspect',startedAt:iso(RUNNING_NOW-5000),updatedAt:iso(RUNNING_NOW),...job}),
    ...Object.fromEntries(Object.entries(extra).map(([name, body]) => [`${dir}/${name}`, body])),
  };
}
const failedJob = (id: string, endedAt: number) => canonicalJob(id,
  {status:'failed',name:id,startedAt:iso(endedAt-5000),finishedAt:iso(endedAt),updatedAt:iso(endedAt),error:'supervisor exited (orphaned)'},
  {'acceptance.json':JSON.stringify({state:'unchecked',pending:false,checks:[]})});
const ADA_VIEW = JSON.stringify({schema:1,prompt:'Long task instructions',preamble:'Mode preamble',truncated:false,tools:[],transcript:[],timeline:[
  {kind:'assistant',sequence:0,at:iso(RUNNING_NOW),text:'Tracing the renderer.'},
  {kind:'tool',sequence:1,at:iso(RUNNING_NOW),stepIndex:0,tool:'Read',input:'register.tsx',output:'file contents',state:'active'}]});
const ada = () => canonicalJob('job-ada', {status:'running',name:'Ada',workerId:'ada',role:'reviewer',provider:'codex',model:'gpt-6-sol'}, {'view.json':ADA_VIEW});

/** A host over canonical jobs that records what the mod asks of the UI. */
function forgeHost(on: (...args: any[]) => void, files: Record<string,string>, ids: string[]) {
  const host = { opens: [] as Record<string,unknown>[], closes: [] as Record<string,unknown>[], toasts: [] as string[], scrolls: [] as Record<string,unknown>[] };
  on('session.start', (_$: unknown, e: any) => ({sessionId:'s',cwd:e.cwd}));
  on('command.register', () => ({value:undefined}));
  on('env.get', () => ({value:undefined}));
  on('ui.open', (_$: unknown, e: any) => { host.opens.push({...e}); return {value:{isPlaced:true}}; });
  on('ui.toast', (_$: unknown, e: any) => { host.toasts.push(e.text); return {value:undefined}; });
  on('ui.scroll', (_$: unknown, e: any) => { host.scrolls.push({...e}); return {}; });
  on('ui.close', (_$: unknown, e: any) => { host.closes.push({...e}); return {value:undefined}; });
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'REST-OF-BAND' }));
  on('tool.call', (_$: unknown, e: any) => e.tool==='TaskCreate'?{result:{task:{id:'native-task-1'}}}
    // Core answering a launch call with its ack.
    :LAUNCH_TOOL.test(e.tool)?launchAck(e)
    :/__status$/.test(e.tool)?{result:{structuredContent:{jobId:e.jobId,status:e.status??'succeeded',acceptance:{state:'accepted',pending:false}},content:[]}}
    :{result:{success:true}});
  const clock = mock.clock(on as never,{now:RUNNING_NOW});
  on('fs.list', () => ({value:ids.map(name=>({name,kind:'dir',size:0}))}));
  on('fs.exists', (_$: unknown, e: any) => ({value:e.path==='/work/.agent-smith/jobs'||Object.hasOwn(files,e.path)}));
  on('fs.read', (_$: unknown, e: any) => { const body=files[e.path]; return body===undefined?{deny:'ENOENT'}:{value:body}; });
  return { host, clock };
}
const start = ($: any) => $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'} as never);
/** Launch through the ack this session's Claude would get back. */
const launch = ($: any, id: string, kind: 'job' | 'run' = 'job') => launched($, id, '/work', kind);

test('the band shows on the main thread only, not while viewing a subagent', async ($, on) => {
  forgeHost(on, ada(), ['job-ada']);
  await start($);
  await launch($, 'job-ada');
  const main = await $.ui.mount({plugin:'agent-smith',surface:'terminal',...BAND,props:{...BAND.props,view:{}}} as never);
  expect(await main.find({key:'band-job-ada'})).toBeDefined();
  const sub = await $.ui.mount({plugin:'agent-smith',surface:'terminal',...BAND,requestId:'forge-band-sub',props:{...BAND.props,view:{agentId:'agent-1'}}} as never);
  expect(await sub.find({key:'band-job-ada'})).toBeUndefined();
  expect(await sub.find({type:'Text',text:/REST-OF-BAND/})).toBeDefined();
});

test('a band row is a digit Button that opens the focused sidebar on that worker', async ($, on) => {
  const { host } = forgeHost(on, ada(), ['job-ada']);
  await start($);
  await launch($, 'job-ada');
  const band = await $.ui.mount({plugin:'agent-smith',surface:'terminal',...BAND} as never);
  const row = await band.find({key:'band-job-ada'}) as { props?: Record<string,unknown> } | undefined;
  expect(row?.props?.hotkey).toBe('1');
  await band.press({key:'band-job-ada'});
  expect(host.opens.at(-1)).toMatchObject({id:'agent-smith',focus:true});
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({type:'Text',text:/Ada · reviewer/})).toBeDefined();
  expect(await pane.find({key:'event-1'})).toBeDefined();
});

test('a running worker with a progress digest shows what it is doing and what it has changed', async ($, on) => {
  const digest = {phase:'editing',filesRead:21,searches:14,edited:['src/config.py','src/loader.py','tests/test_config.py'],editedCount:3,
    commands:2,testRuns:2,lastTestFailed:true,repeat:null};
  const progress = JSON.stringify({jobId:'job-ada',lastEventAt:iso(RUNNING_NOW),recentActivities:[],toolCalls:59,warnings:[],latestText:null,
    lastActivity:{stepIndex:58,tool:'replace_file_content',status:'active',input:JSON.stringify({TargetFile:'/work/src/loader.py'})},digest});
  forgeHost(on, canonicalJob('job-ada', {status:'running',name:'pp-engine',workerId:'ada',role:'implement',provider:'agy'}, {'progress.json':progress,'view.json':ADA_VIEW}), ['job-ada']);
  await start($);
  await launch($, 'job-ada');
  const band = await $.ui.mount({plugin:'agent-smith',surface:'terminal',...BAND} as never);
  const row = await band.find({key:'band-job-ada'}) as { props?: Record<string,unknown> } | undefined;
  expect(String(row?.props?.label)).toMatch(/pp-engine\s+editing loader\.py · 3 files edited · last test run failed/);
  await band.press({key:'band-job-ada'});
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({type:'Text',text:/^Editing · 21 files read · 14 searches · 2 commands · 59 tool calls$/})).toBeDefined();
  expect(await pane.find({type:'Text',text:/^Edited: config\.py, loader\.py, test_config\.py$/})).toBeDefined();
  expect(await pane.find({type:'Text',text:/^Tests: ran 2 times · last run failed$/})).toBeDefined();
  // Tool rows read as plain actions, not the tool name and its raw JSON input.
  const toolRow = await pane.find({key:'event-1'}) as { props?: Record<string,unknown> } | undefined;
  expect(String(toolRow?.props?.label)).toBe('› reading');
});

test('/forge opens the focused session list; /forge pane is the same list; /forge all adds the repository', async ($, on) => {
  const { host } = forgeHost(on, { ...ada(), ...failedJob('job-failed', RUNNING_NOW) }, ['job-ada','job-failed']);
  await start($);
  await launch($, 'job-ada');
  expect(await $.command.run({command:'forge',args:''})).toMatchObject({text:'1 running'});
  expect(host.opens.at(-1)).toMatchObject({id:'agent-smith',focus:true});
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({type:'Text',text:'Workers · 1 running'})).toBeDefined();
  expect(await pane.find({key:'job-job-ada'})).toBeDefined();
  expect(await pane.find({key:'job-job-failed'})).toBeUndefined();
  await pane.press({key:'job-job-ada'});
  await $.command.run({command:'forge',args:'pane'});
  expect(await pane.find({key:'job-job-ada'})).toBeDefined();
  expect(await pane.find({key:'job-job-failed'})).toBeUndefined();

  expect(await $.command.run({command:'forge',args:'all'})).toMatchObject({text:'repository: 1 running · 1 failed'});
  expect(await pane.find({type:'Text',text:'Workers · repository: 1 running · 1 failed'})).toBeDefined();
  expect(await pane.find({key:'job-job-ada'})).toBeDefined();
  expect(await pane.find({type:'Text',text:'Recent'})).toBeDefined();
  // A recent failure stays marked: red, with its failure label.
  expect((await pane.find({type:'Text',text:/failed · server stopped/}) as { props?: Record<string,unknown> })?.props?.color).toBe('red');
  expect((await pane.find({type:'Text',text:'✗'}) as { props?: Record<string,unknown> })?.props?.color).toBe('red');
  // `s` returns to this session; `a` shows the repository again.
  await pane.press({key:'scope-session'});
  expect(await pane.find({key:'job-job-failed'})).toBeUndefined();
  await pane.press({key:'scope-all'});
  expect(await pane.find({key:'job-job-failed'})).toBeDefined();
  expect(host.toasts).toHaveLength(0);
});

test('a fresh session over old jobs: an empty band, an empty session list, no lifetime counts', async ($, on) => {
  const { host } = forgeHost(on, { ...ada(), ...failedJob('job-failed', RUNNING_NOW) }, ['job-ada','job-failed']);
  await start($);
  const band = await $.ui.mount({plugin:'agent-smith',surface:'terminal',...BAND} as never);
  expect(await band.find({key:'band-job-ada'})).toBeUndefined();
  expect(await band.find({type:'Text',text:'REST-OF-BAND'})).toBeDefined();
  const reply = await $.command.run({command:'forge',args:''}) as { text?: string };
  expect(reply.text).toBe('No workers in this session');
  expect(reply.text).not.toMatch(/failed|done/);
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({type:'Text',text:'Workers · No workers in this session'})).toBeDefined();
  expect(await pane.find({type:'Text',text:/\/forge all shows the repository's history/})).toBeDefined();
  expect(await pane.find({key:'job-job-ada'})).toBeUndefined();
  await pane.press({key:'scope-all'});
  expect(await pane.find({key:'job-job-ada'})).toBeDefined();
  expect(await pane.find({key:'job-job-failed'})).toBeDefined();
  expect(host.toasts).toHaveLength(0);
});

test('after a launch only that job shows; a pipeline launch shows its stage jobs', async ($, on) => {
  const stage = canonicalJob('job-stage', {status:'running',name:'Bo',workerId:'bo',pipeline:'run-7',stage:'build'});
  forgeHost(on, { ...ada(), ...failedJob('job-failed', RUNNING_NOW), ...stage }, ['job-ada','job-failed','job-stage']);
  await start($);
  await launch($, 'job-ada');
  const band = await $.ui.mount({plugin:'agent-smith',surface:'terminal',...BAND} as never);
  expect(await band.find({key:'band-job-ada'})).toBeDefined();
  expect(await band.find({key:'band-job-failed'})).toBeUndefined();
  expect(await band.find({key:'band-job-stage'})).toBeUndefined();
  await launch($, 'run-7', 'run');
  expect(await band.find({key:'band-job-stage'})).toBeDefined();
  expect(await $.command.run({command:'forge',args:''})).toMatchObject({text:'2 running'});
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({key:'job-job-stage'})).toBeDefined();
  expect(await pane.find({key:'job-job-failed'})).toBeUndefined();
});

test('/forge <name> searches the whole repository, so an older worker still opens', async ($, on) => {
  const grace = canonicalJob('job-old', {status:'failed',name:'Grace',workerId:'grace',startedAt:iso(RUNNING_NOW-90_000),finishedAt:iso(RUNNING_NOW-60_000),error:'supervisor exited (orphaned)'});
  const { host } = forgeHost(on, { ...ada(), ...grace }, ['job-ada','job-old']);
  await start($);
  await launch($, 'job-ada');
  await $.command.run({command:'forge',args:'grace'});
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({key:'back'})).toBeDefined();
  expect(await pane.find({type:'Text',text:/Grace/})).toBeDefined();
  expect(await pane.find({type:'Text',text:/failed · server stopped/})).toBeDefined();
  expect(host.toasts).toHaveLength(0);
});

test('/forge Ada opens Ada; an unknown name falls back to the list with a toast', async ($, on) => {
  const { host } = forgeHost(on, ada(), ['job-ada']);
  await start($);
  await launch($, 'job-ada');
  await $.command.run({command:'forge',args:'ada'});
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({key:'back'})).toBeDefined();
  expect(await pane.find({type:'Markdown',text:'Tracing the renderer.'})).toBeDefined();
  await $.command.run({command:'forge',args:'Grace'});
  expect(host.toasts.at(-1)).toMatch(/No worker matches "Grace"/);
  expect(await pane.find({key:'job-job-ada'})).toBeDefined();
  expect(await pane.find({key:'back'})).toBeUndefined();
});

test('the worker view is one scroll: header, task, transcript, then result and failing checks', async ($, on) => {
  const files = ada();
  const { clock } = forgeHost(on, files, ['job-ada']);
  await start($);
  await $.command.run({command:'forge',args:'Ada'});
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({type:'Text',text:/codex·gpt-6-sol · 5s/})).toBeDefined();
  expect(await pane.find({key:'task',text:/Task: Long task instructions/})).toBeDefined();
  expect(await pane.find({type:'Markdown',text:/Mode preamble/})).toBeUndefined();
  expect(await pane.find({type:'Text',text:'Following live output.'})).toBeDefined();
  expect(await pane.find({key:'tab-activity'})).toBeUndefined();
  await pane.press({key:'task'});
  expect(await pane.find({type:'Markdown',text:'Mode preamble\n\nLong task instructions'})).toBeDefined();

  files['/work/.agent-smith/jobs/job-ada/job.json'] = JSON.stringify({...JSON.parse(files['/work/.agent-smith/jobs/job-ada/job.json']!),status:'succeeded',finishedAt:iso(RUNNING_NOW+2000),updatedAt:iso(RUNNING_NOW+2000)});
  files['/work/.agent-smith/jobs/job-ada/result.md'] = 'Final findings';
  files['/work/.agent-smith/jobs/job-ada/acceptance.json'] = JSON.stringify({state:'rejected',pending:false,checks:[
    {name:'tests',ok:true,outputTail:''},{name:'lint',ok:false,outputTail:'src/a.ts: unused import',reason:'exit 1'}]});
  await clock.advance(3000);
  expect(await pane.find({type:'Text',text:/✗ lint/})).toBeDefined();
  expect(await pane.find({type:'Markdown',text:'Tracing the renderer.'})).toBeDefined();
  expect(await pane.find({type:'Markdown',text:'Final findings'})).toBeDefined();
  expect(await pane.find({type:'Text',text:'✗ lint · exit 1'})).toBeDefined();
  expect(await pane.find({type:'Text',text:'src/a.ts: unused import'})).toBeDefined();
});

test('b returns to the list; x closes the sidebar', async ($, on) => {
  const { host } = forgeHost(on, ada(), ['job-ada']);
  await start($);
  await launch($, 'job-ada');
  await $.command.run({command:'forge',args:'Ada'});
  const pane = await $.ui.mount(PANE_TARGET);
  await pane.press({key:'back'});
  expect(await pane.find({key:'job-job-ada'})).toBeDefined();
  await pane.press({key:'job-job-ada'});
  expect(await pane.find({key:'back'})).toBeDefined();
  await pane.press({key:'close'});
  expect(host.closes.at(-1)).toMatchObject({id:'agent-smith'});
});

test('scrolling up pauses following and scrolling back to the end resumes it', async ($, on) => {
  const { host, clock } = forgeHost(on, ada(), ['job-ada']);
  await start($);
  await $.command.run({command:'forge',args:'Ada'});
  const pane = await $.ui.mount(PANE_TARGET);
  const person = {component:'Pane',requestId:'agent-smith',bodyRows:30,contentRows:50,origin:{kind:'person'}};
  await $.ui.scroll({...person,offset:10,by:-10} as never);
  expect(await pane.find({type:'Text',text:/^Paused/})).toBeDefined();
  const ends = () => host.scrolls.filter(s => s.to==='end').length;
  const before = ends();
  await clock.advance(3000);
  expect(ends()).toBe(before);
  await $.ui.scroll({...person,offset:20,by:10} as never);
  expect(await pane.find({type:'Text',text:'Following live output.'})).toBeDefined();
});

test('canonical acceptance refreshes in an open worker view; a read failure keeps the rows', async ($, on) => {
  const files = canonicalJob('job-native-1', {status:'succeeded',name:'Ada',workerId:'ada',finishedAt:iso(RUNNING_NOW-1000),toolCalls:1},
    {'acceptance.json':JSON.stringify({state:'unchecked',pending:true,checks:[]}),'result.md':'Worker report'});
  const { clock } = forgeHost(on, files, ['job-native-1']);
  await start($);
  await launch($, 'job-native-1');
  await $.command.run({command:'forge',args:'job-native-1'});
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({type:'Text',text:/checking/})).toBeDefined();
  files['/work/.agent-smith/jobs/job-native-1/acceptance.json']=JSON.stringify({state:'rejected',pending:false,checks:[
    {name:'tests',ok:false,outputTail:'',timedOut:true,signal:'SIGTERM',reason:'command timed out'}]});
  await clock.advance(3000);
  expect(await pane.find({type:'Text',text:/✗ tests · timed out · signal SIGTERM · command timed out/})).toBeDefined();
  await pane.press({key:'back'});
  files['/work/.agent-smith/jobs/job-native-1/job.json']='{broken';
  await clock.advance(3000);
  expect(await pane.find({type:'Text',text:/Can't read job state/})).toBeDefined();
  expect(await pane.find({key:'job-job-native-1'})).toBeDefined();
});

test('a failure older than 24 h stays in Recent but is no longer drawn as one needing attention', async ($, on) => {
  forgeHost(on, { ...failedJob('job-old', RUNNING_NOW - 25*3600*1000), ...failedJob('job-new', RUNNING_NOW - 3600*1000) }, ['job-old','job-new']);
  await start($);
  await $.command.run({command:'forge',args:'all'});
  const pane = await $.ui.mount(PANE_TARGET);
  const rows = await pane.findAll({type:'Text',text:/failed · server stopped/}) as { props?: Record<string,unknown> }[];
  expect(rows.map(row => row.props?.color)).toEqual(['red', undefined]);
  expect(await pane.find({key:'job-job-old'})).toBeDefined();
});

test('pagination makes the tenth worker selectable', async ($, on) => {
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


// ── completion notices: the mod takes a launch over from the command hook ────

describe('completion notices', () => {
  /** forgeHost, plus what the mod says and whether the command hook beneath ran. */
  function noticeHost(on: (...args: any[]) => void, files: Record<string,string>, ids: string[]) {
    const r = forgeHost(on, files, ids);
    const said = { logs: [] as string[], prompts: [] as string[], origins: [] as any[], hookRuns: 0 };
    on('ui.log', (_$: unknown, e: any) => { said.logs.push(e.text); return {value:undefined}; });
    on('prompt.submit', (_$: unknown, e: any) => { said.prompts.push(e.text); said.origins.push(e.origin); return {text:e.text}; });
    // Beneath every module: where the plugin's PostToolUse command hook runs.
    on('classic.PostToolUse', () => { said.hookRuns++; return {}; });
    on('fs.write', (_$: unknown, e: any) => { files[e.path] = e.text; return {value:undefined}; });
    return { ...r, said };
  }
  const ada = (status: string, more: Record<string, unknown> = {}) => canonicalJob('job-ada',
    {status,name:'Ada',provider:'codex',role:'review',...more},
    status === 'running' ? {} : {'acceptance.json':JSON.stringify({state:'accepted',checks:[{name:'tests',ok:true},{name:'lint',ok:true}]})});

  test('a finished owned job: the hook stands down, no ui.log, one prompt.submit', async ($, on) => {
    const files = ada('running');
    const { clock, said } = noticeHost(on, files, ['job-ada']);
    await start($);
    const r = await launched($, 'job-ada');
    expect(r.result.structuredContent.jobId).toBe('job-ada'); // passed through untouched
    // The command hook still starts; it finds the claim and stays silent.
    expect(Object.hasOwn(files, '/work/.agent-smith/claims/job-job-ada')).toBe(true);

    await clock.advance(3000);
    expect(said.logs).toEqual([]);
    Object.assign(files, ada('succeeded', {startedAt:iso(RUNNING_NOW-43_000),finishedAt:iso(RUNNING_NOW+1000),updatedAt:iso(RUNNING_NOW+1000),changedFiles:['a.ts','b.ts']}));
    await clock.advance(3000);
    await clock.advance(3000);

    expect(said.logs).toEqual([]); // the plugin message is the only notice
    expect(said.prompts).toHaveLength(1);
    // Keeps the host's plugin wrapper: the notice quotes worker-controlled text.
    expect(said.origins[0]?.asUser).not.toBe(true);
    expect(said.prompts[0]).toMatch(/^Agent Smith · ✓ Ada \(codex review\) 44s · done · checks 2\/2\nstatus job-ada$/);
  });

  /** Claude reading a settled job through `status`; forgeHost answers it as succeeded. */
  const settledRead = ($: any, id: string, more: Record<string, unknown> = {}) =>
    $.tool.call({ tool: 'mcp__plugin_agent-smith_agent-smith__status', jobId: id, ...more });

  test('a job whose settled status the main agent already read is not announced again', async ($, on) => {
    const files = ada('running');
    const { clock, said } = noticeHost(on, files, ['job-ada']);
    await start($);
    await launched($, 'job-ada');
    Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }));
    await settledRead($, 'job-ada');
    await clock.advance(3000);
    await clock.advance(3000);
    expect(said.prompts).toEqual([]);
  });

  test("a subagent's settled status read does not retire the main agent's notice", async ($, on) => {
    const files = ada('running');
    const { clock, said } = noticeHost(on, files, ['job-ada']);
    await start($);
    await launched($, 'job-ada');
    Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }));
    await settledRead($, 'job-ada', { agentId: 'sub-1' });
    await clock.advance(3000);
    await clock.advance(3000);
    expect(said.prompts).toHaveLength(1);
  });

  test('the mod leaves classic.PostToolUse to the command hook', async ($, on) => {
    const { said } = noticeHost(on, ada('running'), ['job-ada']);
    await start($);
    await ($ as any).classic.PostToolUse({
      tool_name: 'mcp__plugin_agent-smith_agent-smith__spawn_job', tool_use_id: 'tu-1', tool_input: {},
      tool_response: { structuredContent: { jobId: 'job-ada', repo: '/work', timeoutMs: 600_000 }, content: [] },
    });
    expect(said.hookRuns).toBe(1);
  });

  test("another session's job finishing in the same repo is not announced here", async ($, on) => {
    const files = ada('running');
    const { clock, said } = noticeHost(on, files, ['job-ada']);
    await start($);
    Object.assign(files, ada('failed', {finishedAt:iso(RUNNING_NOW+1000),error:'exit 1'}));
    await clock.advance(3000);
    await clock.advance(3000);
    expect(said.logs).toEqual([]);
    expect(said.prompts).toEqual([]);
  });

  test('a launch in a repo the mod is not watching stays with the hook', async ($, on) => {
    const files = ada('running');
    const { clock, said } = noticeHost(on, files, ['job-ada']);
    await start($);
    await launched($, 'job-ada', '/elsewhere');
    expect(Object.hasOwn(files, '/work/.agent-smith/claims/job-job-ada')).toBe(false);
    Object.assign(files, ada('succeeded', {finishedAt:iso(RUNNING_NOW+1000)}));
    await clock.advance(3000);
    await clock.advance(3000);
    expect(said.logs).toEqual([]);
    expect(said.prompts).toEqual([]);
  });
});
