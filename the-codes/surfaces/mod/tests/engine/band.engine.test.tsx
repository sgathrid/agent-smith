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

import { describe, expect, test } from 'claude-code/testing';

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
  on('clock.every', () => ({ value: { cancel: () => {} } }));
  on('clock.now', () => ({ value: options.now ?? RUNNING_NOW }));
  on('env.get', (_$: unknown, e: unknown) => {
    const name = (e as { name: string }).name;
    if (name === 'AGY_RADAR_REPO') return { value: '/corpus' };
    if (name === 'NO_COLOR') return { value: options.noColorEnv };
    return { value: undefined };
  });
  on('fs.list', () => ({ value: entries }));
  on('fs.read', (_$: unknown, e: unknown) => {
    const path = (e as { path: string }).path;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const body = files[name];
    if (body === undefined) {
      // The real `$.fs.read` rejects with the OS errno; the band must survive it.
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    return { value: body };
  });
  on('fs.exists', (_$: unknown, e: unknown) => ({
    value: Object.hasOwn(files, (e as { path: string }).path.slice((e as { path: string }).path.lastIndexOf('/') + 1)),
  }));
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'REST-OF-BAND' }));
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
    const line = await band.find({
      type: 'Text',
      text: `● ${ID} cargo test --workspace · 341 tools`,
    });
    expect(line).toBeDefined();
    // …and the clock, which is 12m04s from the real log's worker-started line.
    expect(await band.find({ type: 'Text', text: '12m04s' })).toBeDefined();

    // The accent, and only the accent, is coloured; the rest is dim.
    const head = (line as { children?: { props?: Record<string, unknown> }[] }).children?.[0];
    expect(head?.props?.color).toBe('yellow');
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
    expect(await band.find({ type: 'Text', text: /agent-smith/ })).toBeUndefined();
    expect(await band.find({ type: 'Text', text: 'REST-OF-BAND' })).toBeDefined();
  });

  test('NO_COLOR drops the colour prop and keeps the glyph and the bold', async ($, on) => {
    engine(on, { noColorEnv: '1' });
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);

    const line = await band.find({ type: 'Text', text: `● ${ID}` });
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

    expect(await band.find({ type: 'Text', text: `✓ ${ID} finished` })).toBeDefined();
    // No tool count, because there is genuinely none on disk — omitted, not 0.
    expect(await band.find({ type: 'Text', text: /0 tools/ })).toBeUndefined();
    // And it does NOT read as still running.
    expect(await band.find({ type: 'Text', text: new RegExp(`● ${ID}`) })).toBeUndefined();
  });

  test('empty output + warnings:true draws FAILED, not a green check', async ($, on) => {
    // THE headline rule. agy-staff exits 0 having delivered nothing when a tool
    // is soft-denied. A `✓` here is the most expensive lie this project could tell.
    engine(on, {
      now: Date.parse('2026-10-03T17:06:00.000Z'),
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

    expect(await band.find({ type: 'Text', text: new RegExp(`✗ ${ID} failed`) })).toBeDefined();
    expect(await band.find({ type: 'Text', text: new RegExp(`✓ ${ID}`) })).toBeUndefined();
    // And the reason reaches the line as a stable code.
    expect(await band.find({ type: 'Text', text: 'suspicious success' })).toBeDefined();
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
    expect((overflow as { text?: string }).text).toContain('/agent-smith');
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
    expect(await band.find({ type: 'Text', text: '+3 more' })).toBeDefined();
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
    expect(line.glyph).toBe('●');
    expect(line.accent).toBe('yellow');

    const budget: BandBudget = rowBudget([job], 10);
    expect(budget.rows).toHaveLength(1);
    expect(budget.hidden).toBe(0);
    expect(isShown(job, RUNNING_NOW)).toBe(true);
  });
});