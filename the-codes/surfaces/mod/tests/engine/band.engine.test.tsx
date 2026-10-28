/**
 * band.engine.test.tsx — the band as the ENGINE draws it.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────────
 * `node --test` (tests/*.node-test.ts) asks whether the RULES are right. It
 * cannot load a .tsx, so it cannot answer whether this module actually loads
 * and the band actually paints. `claude plugin test` (this file) does: it loads
 * the plugin through the engine's own host and hands back the drawn elements.
 *
 * Run it with:  claude plugin test the-codes/surfaces/mod
 *
 * Hooks may not import `node:fs`, so job files are served from literals over
 * the engine's fs events.
 */

import { describe, expect, mock, test } from 'claude-code/testing';

import type { BandLine, BandBudget } from '../../hooks/band.ts';
import { BAND_ROWS, buildLine, isShown, noColor, rowBudget } from '../../hooks/band.ts';
import type { RadarJob } from '../../../types/index.d.ts';
import { proseText } from '../../hooks/views.tsx';

// ── fixtures ────────────────────────────────────────────────────────────────

/** The clock the fixtures share. */
const ID = 'job-1';
const RUNNING_NOW = Date.parse('2026-10-03T16:49:45.031Z');

const BAND = {
  component: 'AbovePrompt' as const,
  requestId: 'forge-band',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 },
};

/**
 * An engine beneath the plugin serving one canonical job, `job-native-1`, whose
 * files are given by bare name in `options.files`.
 */
function engine(
  on: (event: string, hook: (...args: never[]) => unknown) => unknown,
  options: {
    now?: number;
    noColorEnv?: string;
    files?: Record<string, string>;
    scrollCalls?: Record<string,unknown>[];
    nativeTaskCalls?: { tool: string; input: Record<string, unknown> }[];
  } = {},
) {
  const files: Record<string, string> = { ...options.files };

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
    if (name === 'AGY_RADAR_REPO') return { value: '/work' };
    if (name === 'NO_COLOR') return { value: options.noColorEnv };
    return { value: undefined };
  });
  on('fs.list', (_$: unknown, e: unknown) => {
    void e;
    return { value: [{ name: 'job-native-1', kind: 'dir', size: 0 }] };
  });
  on('fs.read', (_$: unknown, e: unknown) => {
    const path = (e as { path: string }).path;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const body = files[name];
    if (body === undefined) {
      // The real `$.fs.read` rejects with the OS errno; the band must survive it.
      return { deny: `ENOENT: no such file or directory, open '${path}'` };
    }
    return { value: body };
  });
  on('fs.exists', (_$: unknown, e: unknown) => ({
    value: (e as {path:string}).path === '/work/.agent-smith/jobs' || Object.hasOwn(files, (e as { path: string }).path.slice((e as { path: string }).path.lastIndexOf('/') + 1)),
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
  test("the host's own band content survives, as our last child", async ($, on) => {
    // TERMINAL-UI.md L170-173: never replace what Claude Code or another mod
    // drew above the prompt.
    forgeHost(on, ada(), ['job-ada']);
    await start($);
    await launch($, 'job-ada');
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);
    expect(await band.find({ key: 'band-job-ada' })).toBeDefined();
    expect(await band.find({ type: 'Text', text: 'REST-OF-BAND' })).toBeDefined();
  });

  test('a survey holds the band: we render nothing and return the host alone', async ($, on) => {
    forgeHost(on, ada(), ['job-ada']);
    await start($);
    await launch($, 'job-ada');
    const band = await $.ui.mount({
      plugin: 'agent-smith', surface: 'terminal', component: 'AbovePrompt', requestId: 'forge-band',
      props: { hasSurvey: true, isWorking: true, maxRows: 10, bodyColumns: 120 },
    } as never);
    // The job IS running, and we still draw no line of our own.
    expect(await band.find({ key: 'band-job-ada' })).toBeUndefined();
    expect(await band.find({ type: 'Text', text: 'REST-OF-BAND' })).toBeDefined();
  });

  test('no jobs means nothing drawn, not an empty box', async ($, on) => {
    // TERMINAL-UI.md L168-171: the row count drops to zero rather than holding space.
    forgeHost(on, {}, []);
    await start($);
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);
    expect(await band.find({ type: 'Text', text: /\/forge/ })).toBeUndefined();
    expect(await band.find({ type: 'Text', text: 'REST-OF-BAND' })).toBeDefined();
  });

  test('every Text WE draw carries wrap="truncate-end"', async ($, on) => {
    // TERMINAL-UI.md L124-126: a wrapped status line becomes two rows, the band
    // grows, and the prompt moves. The host's own row is the engine's to truncate.
    forgeHost(on, ada(), ['job-ada']);
    await start($);
    await launch($, 'job-ada');
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);
    const texts = await band.findAll({ type: 'Text' });
    const ours = texts.filter((t) => (t as { text?: string }).text !== 'REST-OF-BAND');
    expect(ours.length).toBeGreaterThan(0);
    for (const t of ours) {
      expect((t as { props?: Record<string, unknown> }).props?.wrap).toBe('truncate-end');
    }
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

// ── /forge: the band's digits and the command open one focused sidebar ─────

const PANE_TARGET = { plugin: 'agent-smith', surface: 'terminal', component: 'Pane', requestId: 'agent-smith', viewport: { columns: 119, rows: 40, isFullscreen: true }, props: { title: 'Agent Smith', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as never;
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

test('the last finished band row expires and stops repainting', async ($, on) => {
  const { clock } = forgeHost(on, failedJob('job-f', RUNNING_NOW), ['job-f']);
  await start($);
  await launch($, 'job-f');
  const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);
  expect(await band.find({ key: 'band-job-f' })).toBeDefined();
  await clock.advance(60_000);
  expect(await band.find({ key: 'band-job-f' })).toBeUndefined();
});

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
  const { clock } = forgeHost(on, canonicalJob('job-ada', {status:'running',name:'pp-engine',workerId:'ada',role:'implement',provider:'agy'}, {'progress.json':progress,'view.json':ADA_VIEW}), ['job-ada']);
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
  // The running call's dim dot blinks once a second, off then on.
  expect(String(toolRow?.props?.label)).toBe('  reading');
  await clock.advance(1000);
  const lit = await pane.find({key:'event-1'}) as { props?: Record<string,unknown> } | undefined;
  expect(String(lit?.props?.label)).toBe('● reading');
  expect(lit?.props?.dimColor).toBe(true);
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

test('/forge recap prints the multi-line session board instead of treating "recap" as a worker name', async ($, on) => {
  const { host } = forgeHost(on, { ...ada(), ...failedJob('job-failed', RUNNING_NOW) }, ['job-ada','job-failed']);
  await start($);
  await launch($, 'job-ada');
  const mine = await $.command.run({command:'forge',args:'recap'}) as {text?: string};
  expect(mine.text).toBe('This session · 1 running\n⏺ Ada · reviewer — Running · 5s');
  expect(host.toasts).toHaveLength(0);
  // The list pane opened: recap is a board request, never a lookup that misses.
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({key:'job-job-ada'})).toBeDefined();
  expect(await pane.find({key:'back'})).toBeUndefined();
  const board = 'Repository · 1 running · 1 failed\n⏺ Ada · reviewer — Running · 5s\n✗ job-failed — failed · server stopped · 5s';
  expect(await $.command.run({command:'forge',args:'all recap'})).toMatchObject({text:board});
  expect(await $.command.run({command:'forge',args:'recap all'})).toMatchObject({text:board});
  expect(host.toasts).toHaveLength(0);
});

test('a long run of completed read calls folds into one expandable row, leaving edit, test and active rows', async ($, on) => {
  const view = JSON.stringify({schema:1,prompt:'Long task instructions',preamble:'',truncated:false,tools:[],transcript:[],timeline:[
    {kind:'tool',sequence:0,at:iso(RUNNING_NOW),stepIndex:0,tool:'Read',input:'src/a.ts',output:'a',state:'done'},
    {kind:'tool',sequence:1,at:iso(RUNNING_NOW),stepIndex:1,tool:'Read',input:'src/b.ts',output:'b',state:'done'},
    {kind:'tool',sequence:2,at:iso(RUNNING_NOW),stepIndex:2,tool:'Grep',input:'{"pattern":"render"}',output:'match',state:'done'},
    {kind:'tool',sequence:3,at:iso(RUNNING_NOW),stepIndex:3,tool:'Read',input:'src/c.ts',output:'c',state:'done'},
    {kind:'tool',sequence:4,at:iso(RUNNING_NOW),stepIndex:4,tool:'Edit',input:'{"file_path":"src/a.ts"}',output:'ok',state:'done'},
    {kind:'tool',sequence:5,at:iso(RUNNING_NOW),stepIndex:5,tool:'Bash',input:'{"command":"cargo test"}',output:'ok',state:'done'},
    {kind:'tool',sequence:6,at:iso(RUNNING_NOW),stepIndex:6,tool:'Read',input:'src/d.ts',output:'d',state:'active'},
  ]});
  const files = canonicalJob('job-rec', {status:'running',name:'Rae',workerId:'rae',role:'implement'}, {'view.json':view});
  forgeHost(on, files, ['job-rec']);
  await start($);
  await launch($, 'job-rec');
  await $.command.run({command:'forge',args:'rae'});
  const pane = await $.ui.mount(PANE_TARGET);

  const group = await pane.find({key:'group-0'}) as {props?: Record<string,unknown>} | undefined;
  expect(String(group?.props?.label)).toBe('✓ read 3 files · 1 search');
  // Folded rows are not drawn until the group is opened.
  expect(await pane.find({key:'event-0'})).toBeUndefined();
  // The edit, the test run and the active call are never folded away.
  expect(await pane.find({key:'event-4'})).toBeDefined();
  expect(await pane.find({key:'event-5'})).toBeDefined();
  expect(await pane.find({key:'event-6'})).toBeDefined();

  await pane.press({key:'group-0'});
  expect(await pane.find({key:'event-0'})).toBeDefined();
  expect(await pane.find({key:'event-3'})).toBeDefined();
});


test('prose and tool rows read apart: a blank row at each turn, dimmed tools, no repeated note or status', async ($, on) => {
  const view = JSON.stringify({schema:1,prompt:'Review',preamble:'',truncated:false,tools:[],transcript:[],timeline:[
    {kind:'assistant',sequence:0,at:iso(RUNNING_NOW),text:'Reviewing the range.'},
    {kind:'tool',sequence:1,at:iso(RUNNING_NOW),stepIndex:0,tool:"/bin/zsh -lc '/Library/Developer/CommandLineTools/usr/bin/git diff 5e7ac74 895fa82 -- the-codes/surf",input:'',output:'',state:'done'},
    {kind:'tool',sequence:2,at:iso(RUNNING_NOW),stepIndex:1,tool:"/bin/zsh -lc 'node --version'",input:'',output:'',state:'done'},
    {kind:'assistant',sequence:3,at:iso(RUNNING_NOW),text:'- a list item'},
    {kind:'tool',sequence:4,at:iso(RUNNING_NOW),stepIndex:2,tool:'Read',input:'a.ts',output:'',state:'error'},
  ]});
  const files = canonicalJob('job-rev', {status:'running',name:'Rev',workerId:'rev'},
    {'view.json':view,'progress.json':JSON.stringify({latestText:'Reviewing the range.',
      digest:{phase:'running',filesRead:0,searches:0,commands:2,edited:[],editedCount:0,testRuns:1,lastTestFailed:true,repeat:null}})});
  forgeHost(on, files, ['job-rev']);
  await start($);
  await launch($, 'job-rev');
  await $.command.run({command:'forge',args:'rev'});
  const pane = await $.ui.mount(PANE_TARGET);

  expect(await pane.find({type:'Markdown',text:'● Reviewing the range.'})).toBeDefined();
  // A text that opens with markdown block syntax keeps it intact.
  expect(await pane.find({type:'Markdown',text:'- a list item'})).toBeDefined();
  expect(await pane.find({key:'gap-event-1'})).toBeDefined();
  expect(await pane.find({key:'gap-event-2'})).toBeUndefined();
  expect(await pane.find({key:'gap-event-3'})).toBeDefined();
  expect(await pane.find({key:'gap-event-4'})).toBeDefined();
  const cmd = await pane.find({key:'event-1'}) as {props?: Record<string,unknown>} | undefined;
  expect(String(cmd?.props?.label)).toBe('✓ checking git');
  expect(cmd?.props?.dimColor).toBe(true);
  const failed = await pane.find({key:'event-4'}) as {props?: Record<string,unknown>} | undefined;
  expect(failed?.props?.dimColor).toBe(false);
  // The note would repeat the first prose row; the status row would repeat the progress block.
  expect(await pane.find({type:'Text',text:/^Note:/})).toBeUndefined();
  expect(await pane.find({type:'Text',text:/^Running · running/})).toBeUndefined();
  expect(await pane.find({type:'Text',text:/^Tests: ran 1 time · last run failed/})).toBeDefined();
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
  expect(await pane.find({type:'Markdown',text:'● Tracing the renderer.'})).toBeDefined();
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
  expect(await pane.find({type:'Markdown',text:'● Tracing the renderer.'})).toBeDefined();
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
  forgeHost(on, Object.assign({}, ...ids.map(id => canonicalJob(id, {status:'running',name:id}))), ids);
  await start($);
  await $.command.run({command:'forge',args:'all'});
  const pane=await $.ui.mount(PANE_TARGET);
  expect(await pane.find({key:'job-job-9'})).toBeUndefined();
  await pane.press({key:'next-page'});
  expect(await pane.find({key:'job-job-9'})).toBeDefined();
  await pane.press({key:'job-job-9'});
  expect(await pane.find({key:'back'})).toBeDefined();
});

test('docked pane rendering does not feed conversationColumns back into ui.open, nor let AbovePrompt overwrite terminal width while open', async ($, on) => {
  const { host } = forgeHost(on, ada(), ['job-ada']);
  await start($);
  await launch($, 'job-ada');
  // 1. AbovePrompt measures a 180-column terminal before the pane is open.
  const band = await $.ui.mount({
    plugin: 'agent-smith',
    surface: 'terminal',
    ...BAND,
    viewport: { columns: 180, rows: 40, isFullscreen: true },
    props: { ...BAND.props, bodyColumns: 180 },
  } as never);
  expect(await band.find({ key: 'band-job-ada' })).toBeDefined();

  // 2. /forge requests 60 columns (floor(180 / 3)).
  await $.command.run({ command: 'forge', args: '' });
  expect(host.opens).toHaveLength(1);
  expect(host.opens[0]).toMatchObject({ id: 'agent-smith', focus: true, columns: 60 });

  // 3. The host mounts the docked Pane with viewport.columns = conversationColumns (119) and bodyColumns = 60.
  //    Without reconstructing terminalColumns = 119 + 60 + 1 = 180, the Pane render would request 39 columns and loop.
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({ key: 'job-job-ada' })).toBeDefined();
  expect(host.opens).toHaveLength(1);

  // 4. While the pane is open, AbovePrompt renders at conversationColumns (119).
  //    It must not overwrite the 180-column terminal measurement, so a subsequent Pane render still does not call ui.open.
  await $.ui.mount({
    plugin: 'agent-smith',
    surface: 'terminal',
    ...BAND,
    requestId: 'forge-band-docked',
    viewport: { columns: 119, rows: 40, isFullscreen: true },
    props: { ...BAND.props, bodyColumns: 119 },
  } as never);
  await pane.press({ key: 'job-job-ada' });
  expect(await pane.find({ key: 'back' })).toBeDefined();
  expect(host.opens).toHaveLength(1);

  // 5. If the user drags the dock to 75 columns on the same 180-column terminal (viewport.columns = 104, bodyColumns = 75),
  //    reconstructed terminal width is still 180, so the Pane handler does not fight the user's sizing.
  await (pane as unknown as { unmount(): Promise<void> }).unmount();
  const resizedPane = await $.ui.mount({
    ...(PANE_TARGET as Record<string, unknown>),
    requestId: 'agent-smith',
    viewport: { columns: 104, rows: 40, isFullscreen: true },
    props: { ...((PANE_TARGET as { props: Record<string, unknown> }).props), bodyColumns: 75, placement: 'dock' },
  } as never);
  expect(await resizedPane.find({ key: 'back' })).toBeDefined();
  expect(host.opens).toHaveLength(1);

  // 6. When the terminal genuinely resizes to 210 columns (docked at 60 -> viewport.columns = 149),
  //    the Pane handler reconstructs 210 and requests 70 columns once.
  await (resizedPane as unknown as { unmount(): Promise<void> }).unmount();
  await $.ui.mount({
    ...(PANE_TARGET as Record<string, unknown>),
    requestId: 'agent-smith',
    viewport: { columns: 149, rows: 40, isFullscreen: true },
    props: { ...((PANE_TARGET as { props: Record<string, unknown> }).props), bodyColumns: 60, placement: 'dock' },
  } as never);
  expect(host.opens).toHaveLength(2);
  expect(host.opens[1]).toMatchObject({ id: 'agent-smith', columns: 70 });
});

test('/forge sizes its first dock request from the command presentation, before any band render', async ($, on) => {
  const { host } = forgeHost(on, ada(), ['job-ada']);
  await start($);
  // No AbovePrompt render has measured the terminal yet. command.run's
  // presentation.columns is the whole terminal, so the first open is a third of
  // 144 rather than the 60-column fallback.
  await $.command.run({ command: 'forge', args: '', presentation: { isFullscreen: true, columns: 144 } } as never);
  expect(host.opens).toHaveLength(1);
  expect(host.opens[0]).toMatchObject({ id: 'agent-smith', columns: 48 });
});

test('a second session.start (a reload) leaves a mounted pane measuring the terminal, not the conversation', async ($, on) => {
  const { host } = forgeHost(on, ada(), ['job-ada']);
  await start($);
  await launch($, 'job-ada');
  const band = await $.ui.mount({
    plugin: 'agent-smith',
    surface: 'terminal',
    ...BAND,
    viewport: { columns: 180, rows: 40, isFullscreen: true },
    props: { ...BAND.props, bodyColumns: 180 },
  } as never);
  expect(await band.find({ key: 'band-job-ada' })).toBeDefined();
  await $.command.run({ command: 'forge', args: '' });
  await $.ui.mount(PANE_TARGET);
  expect(host.opens).toHaveLength(1);

  // A reload loads the module afresh and fires session.start again while the
  // host still has the pane mounted. startBand resets the module's own
  // measurements, not paneOpen: if it reset paneOpen, this band render would
  // record conversationColumns (119) as the terminal width, and the forced open
  // below would ask for floor(119 / 3) = 39 columns instead of 60.
  await start($);
  await $.ui.mount({
    plugin: 'agent-smith',
    surface: 'terminal',
    ...BAND,
    requestId: 'forge-band-reloaded',
    viewport: { columns: 119, rows: 40, isFullscreen: true },
    props: { ...BAND.props, bodyColumns: 119 },
  } as never);
  await $.command.run({ command: 'forge', args: '' });
  expect(host.opens.at(-1)).toMatchObject({ id: 'agent-smith', columns: 60 });
});

test('ANSI escapes and control bytes in failed tool output, warnings, check output, summaries, and markdown are stripped at the UI boundary while disk files stay untouched', async ($, on) => {
  const rawView = JSON.stringify({
    schema: 1,
    prompt: 'Inspect \x1b[31mRenyi\x1b[0m\r\nstep 2\x07',
    preamble: 'Preamble \x1b[32mok\x1b[0m\x08',
    truncated: false,
    tools: [],
    transcript: [],
    timeline: [
      { kind: 'assistant', sequence: 0, at: iso(RUNNING_NOW), text: 'Heading \x1b[1mbold\x1b[0m\r\nline 2\x07\ufdd0' },
      {
        kind: 'tool',
        sequence: 1,
        at: iso(RUNNING_NOW),
        stepIndex: 0,
        tool: 'Bash\x07',
        input: '{"command":"cargo test --color=always"}\r\x1b[2K',
        output: '\x1b[31merror[E0425]\x1b[0m: cannot find value\r\n10%\r100%\x07\x1f',
        state: 'error',
      },
    ],
  });
  const rawAcceptance = JSON.stringify({
    state: 'rejected',
    pending: false,
    checks: [
      {
        name: 'clippy\x1b[31m!\x1b[0m\x07',
        ok: false,
        outputTail: '\x1b[33mwarning\x1b[0m: unused variable\r\ndone\x07\x7f',
        reason: 'exit 1\x1b[0m\x07',
      },
    ],
  });
  const files = canonicalJob(
    'job-dirty',
    {
      status: 'failed',
      name: '\x1b[36mRenyi\x1b[0m\x07',
      workerId: 'renyi\x07',
      role: 'implement\x1b[0m',
      provider: 'codex\x07',
      model: 'gpt-6\x1b[0m',
      finishedAt: iso(RUNNING_NOW + 1000),
      updatedAt: iso(RUNNING_NOW + 1000),
      error: 'Denied \x1b[31mrm\x1b[0m\r\nsecond line\x07',
    },
    {
      'progress.json': JSON.stringify({ warnings: ['Warn \x1b[33mretry\x1b[0m\x07'] }),
      'view.json': rawView,
      'acceptance.json': rawAcceptance,
      'result.md': 'Final \x1b[32mreport\x1b[0m\r\nclean\x07\ufdef',
    },
  );
  forgeHost(on, files, ['job-dirty']);
  await start($);
  await launch($, 'job-dirty');
  await $.command.run({ command: 'forge', args: 'job-dirty' });
  const pane = await $.ui.mount(PANE_TARGET);

  // Expanded failed tool row, warnings, check output, and markdown render without control characters.
  expect(await pane.find({ type: 'Text', text: /✗ Renyi · implement/ })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: /Denied rm\nsecond line/ })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: /Warn retry/ })).toBeDefined();
  expect(await pane.find({ type: 'Markdown', text: 'Heading bold\nline 2' })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: /error\[E0425\]: cannot find value\n10%\n100%/ })).toBeDefined();
  expect(await pane.find({ type: 'Markdown', text: 'Final report\nclean' })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: '✗ clippy! · exit 1' })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: 'warning: unused variable\ndone' })).toBeDefined();

  await pane.press({ key: 'task' });
  expect(await pane.find({ type: 'Markdown', text: 'Preamble ok\n\nInspect Renyi\nstep 2' })).toBeDefined();

  // Stored job files on disk are untouched.
  expect(files['/work/.agent-smith/jobs/job-dirty/view.json']).toBe(rawView);
  expect(files['/work/.agent-smith/jobs/job-dirty/acceptance.json']).toBe(rawAcceptance);
});


// ── completion notices: the mod takes a launch over from the command hook ────

describe('update check', () => {
  /** A host with an installed manifest at `installed` and `released` on main. */
  function updateHost(on: (...args: any[]) => void, installed: string, released: { ok: boolean; text: string }, env: Record<string, string> = {}) {
    const seen = { toasts: [] as string[], fetched: [] as string[] };
    on('session.start', (_$: unknown, e: any) => ({ sessionId: 's', cwd: e.cwd }));
    on('command.register', () => ({ value: undefined }));
    on('env.get', (_$: unknown, e: any) => ({ value: env[e.name] }));
    on('fs.list', () => ({ value: [] }));
    on('fs.exists', () => ({ value: false }));
    on('fs.read', (_$: unknown, e: any) => e.path.endsWith('/.claude-plugin/plugin.json') ? { value: JSON.stringify({ name: 'agent-smith', version: installed }) } : { deny: 'ENOENT' });
    on('http.fetch', (_$: unknown, e: any) => { seen.fetched.push(e.url); return { value: { status: released.ok ? 200 : 404, ok: released.ok, headers: {}, text: released.text } }; });
    on('ui.toast', (_$: unknown, e: any) => { seen.toasts.push(e.text); return { value: undefined }; });
    const clock = mock.clock(on as never, { now: RUNNING_NOW });
    return { seen, clock };
  }
  const released = (version: string) => ({ ok: true, text: JSON.stringify({ name: 'agent-smith', version }) });

  test('a newer release on main is one toast naming both versions', async ($, on) => {
    const { seen, clock } = updateHost(on, '0.2.1', released('0.2.3'));
    await start($);
    await clock.advance(1);
    expect(seen.fetched).toEqual(['https://raw.githubusercontent.com/sgathrid/agent-smith/main/builds/local-plugin/agent-smith/.claude-plugin/plugin.json']);
    expect(seen.toasts).toEqual(['agent-smith update available: v0.2.1 → v0.2.3']);
  });

  test('an installed version that matches main says nothing', async ($, on) => {
    const { seen, clock } = updateHost(on, '0.2.3', released('0.2.3'));
    await start($);
    await clock.advance(1);
    expect(seen.toasts).toEqual([]);
  });

  test('a failed fetch says nothing', async ($, on) => {
    const { seen, clock } = updateHost(on, '0.2.1', { ok: false, text: '404: Not Found' });
    await start($);
    await clock.advance(1);
    expect(seen.toasts).toEqual([]);
  });

  test('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC skips the request', async ($, on) => {
    const { seen, clock } = updateHost(on, '0.2.1', released('0.2.3'), { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    await start($);
    await clock.advance(1);
    expect(seen.fetched).toEqual([]);
    expect(seen.toasts).toEqual([]);
  });
});

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

  test('a notice row drops the host frame, even drawn expanded under its speaker label', async ($, on) => {
    // Beneath the mod: the engine drawing the row's text.
    on('ui.render', { component: 'UserMessage' }, ($: any, e: any) => $.ui.resolve(e).Text({ children: e.props.text }));
    const text = 'The agent-smith plugin sent a message:\n  Agent Smith · ✓ hig-codex (codex review) 7m · done\n  status review-smith-7cdfd099\n\n' +
      "  This is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.";
    for (const isExpanded of [false, true]) {
      const row = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', component: 'UserMessage', requestId: `row-${isExpanded}`,
        props: { text, origin: { kind: 'plugin', name: 'agent-smith' }, isExpanded } } as never);
      expect(await row.find({ type: 'Text', text: /^Agent Smith · ✓ hig-codex \(codex review\) 7m · done$/ })).toBeDefined();
      expect(await row.find({ type: 'Text', text: /This is how Claude Code|sent a message|^status / })).toBeUndefined();
    }
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

describe('proseText', () => {
  test('marks plain prose and leaves markdown blocks intact', () => {
    expect(proseText('Done: tests pass.')).toBe('● Done: tests pass.');
    expect(proseText('\n  Leading space trimmed.')).toBe('● Leading space trimmed.');
    expect(proseText('    const a = 1;\n    const b = 2;')).toBe('    const a = 1;\n    const b = 2;');
    expect(proseText('-----')).toBe('-----');
    expect(proseText('* * *\nnext')).toBe('* * *\nnext');
    expect(proseText('- item')).toBe('- item');
    expect(proseText('<details>x</details>')).toBe('<details>x</details>');
  });
});
