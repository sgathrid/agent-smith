import { describe, expect, mock, test } from 'claude-code/testing';

import type { BandLine, BandBudget } from '../../hooks/band.ts';
import { BAND_ROWS, buildLine, isShown, noColor, rowBudget } from '../../hooks/band.ts';
import type { RadarJob } from '../../../types/index.d.ts';
import { proseText } from '../../hooks/views.tsx';
import { updateLine } from '../../hooks/update.ts';
import { register as registerMod } from '../../hooks/register.tsx';

const ID = 'job-1';
const RUNNING_NOW = Date.parse('2026-10-03T16:49:45.031Z');

const BAND = {
  component: 'AbovePrompt' as const,
  requestId: 'forge-band',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 },
};

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

const LAUNCH_TOOL = /__(?:spawn_job|follow_up|steer|run_pipeline)$/;
const launchAck = (e: any) => e.variantJobs
  ? { result: { structuredContent: { jobs: [...e.variantJobs.map((id: string) => ({ jobId: id, status: 'running', repo: e.repo ?? '/work', timeoutMs: 600_000 })), { name: 'Bad', error: 'no such model' }] }, content: [] } }
  : { result: { structuredContent: { [e.runId ? 'runId' : 'jobId']: e.runId ?? e.jobId, ...(e.workerId ? { workerId: e.workerId } : {}), repo: e.repo ?? '/work', timeoutMs: 600_000 }, content: [] } };
const launched = ($: any, id: string, repo = '/work', kind: 'job' | 'run' = 'job') => $.tool.call({
  tool: `mcp__plugin_agent-smith_agent-smith__${kind === 'job' ? 'spawn_job' : 'run_pipeline'}`, [kind === 'job' ? 'jobId' : 'runId']: id, repo,
});

describe('band helpers (pure)', () => {
  test('the pure rules hold identically here and under node --test', () => {
    expect(noColor({ NO_COLOR: '1' })).toBe(true);
    expect(noColor({ NO_COLOR: '' })).toBe(false);
    expect(noColor({ TERM: 'dumb' })).toBe(true);
    expect(rowBudget([], 10).rows.length).toBe(0);
    expect(rowBudget(new Array(9).fill({}), 10).hidden).toBe(9 - BAND_ROWS);
  });
});

describe('the band', () => {
  test("the host's own band content survives, as our last child", async ($, on) => {
    forgeHost(on, ada(), ['job-ada']);
    await start($);
    await launch($, 'job-ada');
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);
    expect(await band.find({ key: 'band-ada' })).toBeDefined();
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
    expect(await band.find({ key: 'band-ada' })).toBeUndefined();
    expect(await band.find({ type: 'Text', text: 'REST-OF-BAND' })).toBeDefined();
  });

  test('no jobs means nothing drawn, not an empty box', async ($, on) => {
    forgeHost(on, {}, []);
    await start($);
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);
    expect(await band.find({ type: 'Text', text: /\/forge/ })).toBeUndefined();
    expect(await band.find({ type: 'Text', text: 'REST-OF-BAND' })).toBeDefined();
  });

  test('every Text WE draw carries wrap="truncate-end"', async ($, on) => {
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

describe('the render path uses the tested helpers', () => {
  test('a job built here builds the line the band would draw', () => {
    const job: RadarJob = {
      id: ID,
      workerId: ID,
      turn: 1,
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
    await clock.advance(3000);
    expect(calls).toHaveLength(0);
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

const PANE_TARGET = { plugin: 'agent-smith', surface: 'terminal', component: 'Pane', requestId: 'agent-smith', viewport: { columns: 119, rows: 40, isFullscreen: true }, props: { title: 'Agent Smith', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as never;
const iso = (ms: number) => new Date(ms).toISOString();
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

function forgeHost(on: (...args: any[]) => void, files: Record<string,string>, ids: string[], env: Record<string,string> = {}) {
  const host = { opens: [] as Record<string,unknown>[], closes: [] as Record<string,unknown>[], toasts: [] as string[], scrolls: [] as Record<string,unknown>[], io: { list: 0, reads: [] as string[] }, statusCalls: 0 };
  on('session.start', (_$: unknown, e: any) => ({sessionId:'s',cwd:e.cwd}));
  on('command.register', () => ({value:undefined}));
  on('env.get', (_$: unknown, e: any) => ({value:env[e.name]}));
  on('ui.open', (_$: unknown, e: any) => { host.opens.push({...e}); return {value:{isPlaced:true}}; });
  on('ui.toast', (_$: unknown, e: any) => { host.toasts.push(e.text); return {value:undefined}; });
  on('ui.scroll', (_$: unknown, e: any) => { host.scrolls.push({...e}); return {}; });
  on('ui.close', (_$: unknown, e: any) => { host.closes.push({...e}); return {value:undefined}; });
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'REST-OF-BAND' }));
  on('tool.call', (_$: unknown, e: any) => e.tool==='TaskCreate'?{result:{task:{id:'native-task-1'}}}
    :LAUNCH_TOOL.test(e.tool)?launchAck(e)
    :/__cancel$/.test(e.tool)?{result:{structuredContent:{jobId:e.jobId,status:'canceled',settled:e.settled??true},content:[]}}
    :/__status$/.test(e.tool)&&++host.statusCalls?{result:{structuredContent:{jobId:e.jobId,status:e.status??'succeeded',acceptance:{state:'accepted',pending:false}},content:[]}}
    :{result:{success:true}});
  const clock = mock.clock(on as never,{now:RUNNING_NOW});
  on('fs.list', () => { host.io.list += 1; return {value:ids.map(name=>({name,kind:'dir',size:0}))}; });
  on('fs.exists', (_$: unknown, e: any) => ({value:e.path==='/work/.agent-smith/jobs'||Object.hasOwn(files,e.path)}));
  on('fs.read', (_$: unknown, e: any) => { host.io.reads.push(e.path); const body=files[e.path]; return body===undefined?{deny:'ENOENT'}:{value:body}; });
  return { host, clock };
}
const start = ($: any) => $.session.start({surface:'terminal',isInteractive:true,cwd:'/work'} as never);
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
  expect(await main.find({key:'band-ada'})).toBeDefined();
  const sub = await $.ui.mount({plugin:'agent-smith',surface:'terminal',...BAND,requestId:'forge-band-sub',props:{...BAND.props,view:{agentId:'agent-1'}}} as never);
  expect(await sub.find({key:'band-ada'})).toBeUndefined();
  expect(await sub.find({type:'Text',text:/REST-OF-BAND/})).toBeDefined();
});

test('a band row is a digit Button that opens the focused sidebar on that worker', async ($, on) => {
  const { host } = forgeHost(on, ada(), ['job-ada']);
  await start($);
  await launch($, 'job-ada');
  const band = await $.ui.mount({plugin:'agent-smith',surface:'terminal',...BAND} as never);
  const row = await band.find({key:'band-ada'}) as { props?: Record<string,unknown> } | undefined;
  expect(row?.props?.hotkey).toBe('1');
  await band.press({key:'band-ada'});
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
  const row = await band.find({key:'band-ada'}) as { props?: Record<string,unknown> } | undefined;
  expect(String(row?.props?.label)).toMatch(/pp-engine\s+editing loader\.py · 3 files edited · last test run failed/);
  await band.press({key:'band-ada'});
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({type:'Text',text:/^Editing · 21 files read · 14 searches · 2 commands · tests ran 2× · last run failed$/})).toBeDefined();
  const toolRow = await pane.find({key:'event-1'}) as { props?: Record<string,unknown> } | undefined;
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
  expect(await pane.find({key:'job-ada'})).toBeDefined();
  expect(await pane.find({key:'job-job-failed'})).toBeUndefined();
  await pane.press({key:'job-ada'});
  await $.command.run({command:'forge',args:'pane'});
  expect(await pane.find({key:'job-ada'})).toBeDefined();
  expect(await pane.find({key:'job-job-failed'})).toBeUndefined();

  expect(await $.command.run({command:'forge',args:'all'})).toMatchObject({text:'repository: 1 running · 1 failed'});
  expect(await pane.find({type:'Text',text:'Workers · repository: 1 running · 1 failed'})).toBeDefined();
  expect(await pane.find({key:'job-ada'})).toBeDefined();
  expect(await pane.find({type:'Text',text:'Recent'})).toBeDefined();
  expect((await pane.find({type:'Text',text:/failed · server stopped/}) as { props?: Record<string,unknown> })?.props?.color).toBe('red');
  expect((await pane.find({type:'Text',text:'✗'}) as { props?: Record<string,unknown> })?.props?.color).toBe('red');
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
  expect(await band.find({key:'band-ada'})).toBeUndefined();
  expect(await band.find({type:'Text',text:'REST-OF-BAND'})).toBeDefined();
  const reply = await $.command.run({command:'forge',args:''}) as { text?: string };
  expect(reply.text).toBe('No workers in this session');
  expect(reply.text).not.toMatch(/failed|done/);
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({type:'Text',text:'Workers · No workers in this session'})).toBeDefined();
  expect(await pane.find({type:'Text',text:/\/forge all shows the repository's history/})).toBeDefined();
  expect(await pane.find({key:'job-ada'})).toBeUndefined();
  await pane.press({key:'scope-all'});
  expect(await pane.find({key:'job-ada'})).toBeDefined();
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
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({key:'job-ada'})).toBeDefined();
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
  expect(await pane.find({key:'event-0'})).toBeUndefined();
  expect(await pane.find({key:'event-4'})).toBeDefined();
  expect(await pane.find({key:'event-5'})).toBeDefined();
  expect(await pane.find({key:'event-6'})).toBeDefined();

  await pane.press({key:'group-0'});
  const expandedGroup = await pane.find({key:'group-0'}) as {props?: Record<string,unknown>} | undefined;
  expect(String(expandedGroup?.props?.label)).toBe('▾ read 3 files · 1 search');
  expect(expandedGroup?.props?.dimColor).toBe(false);
  expect(await pane.find({key:'body-group-0'})).toBeDefined();
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
  expect(await pane.find({type:'Text',text:/^Note:/})).toBeUndefined();
  expect(await pane.find({type:'Text',text:/^Running · running/})).toBeUndefined();
  expect(await pane.find({type:'Text',text:/tests ran 1× · last run failed/})).toBeDefined();
});

test('after a launch only that job shows; a pipeline launch shows its stage jobs', async ($, on) => {
  const stage = canonicalJob('job-stage', {status:'running',name:'Bo',workerId:'bo',pipeline:'run-7',stage:'build'});
  forgeHost(on, { ...ada(), ...failedJob('job-failed', RUNNING_NOW), ...stage }, ['job-ada','job-failed','job-stage']);
  await start($);
  await launch($, 'job-ada');
  const band = await $.ui.mount({plugin:'agent-smith',surface:'terminal',...BAND} as never);
  expect(await band.find({key:'band-ada'})).toBeDefined();
  expect(await band.find({key:'band-job-failed'})).toBeUndefined();
  expect(await band.find({key:'band-bo'})).toBeUndefined();
  await launch($, 'run-7', 'run');
  expect(await band.find({key:'band-bo'})).toBeDefined();
  expect(await $.command.run({command:'forge',args:''})).toMatchObject({text:'2 running'});
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({key:'job-bo'})).toBeDefined();
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
  expect(await pane.find({type:'Text',text:/server stopped/})).toBeDefined();
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
  expect(await pane.find({key:'job-ada'})).toBeDefined();
  expect(await pane.find({key:'back'})).toBeUndefined();
});

test('the worker view is one scroll: header, task, transcript, then result and failing checks', async ($, on) => {
  const files = ada();
  const { clock } = forgeHost(on, files, ['job-ada']);
  await start($);
  await $.command.run({command:'forge',args:'Ada'});
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({type:'Text',text:/Ada · reviewer · 5s/})).toBeDefined();
  expect(await pane.find({type:'Text',text:'codex gpt-6-sol'})).toBeDefined();
  expect(await pane.find({type:'Text',text:/Task: Long task instructions/})).toBeDefined();
  expect(await pane.find({type:'Markdown',text:/Mode preamble/})).toBeUndefined();
  expect(await pane.find({type:'Text',text:'Following live output.'})).toBeUndefined();
  expect(await pane.find({key:'tab-activity'})).toBeUndefined();
  await pane.press({key:'task'});
  expect(await pane.find({type:'Markdown',text:'Mode preamble\n\nLong task instructions'})).toBeDefined();

  files['/work/.agent-smith/jobs/job-ada/job.json'] = JSON.stringify({...JSON.parse(files['/work/.agent-smith/jobs/job-ada/job.json']!),status:'succeeded',finishedAt:iso(RUNNING_NOW+2000),updatedAt:iso(RUNNING_NOW+2000)});
  files['/work/.agent-smith/jobs/job-ada/result.md'] = 'Final findings';
  files['/work/.agent-smith/jobs/job-ada/acceptance.json'] = JSON.stringify({state:'rejected',pending:false,checks:[
    {name:'tests',ok:true,outputTail:''},{name:'lint',ok:false,outputTail:'src/a.ts: unused import',reason:'exit 1'}]});
  await clock.advance(1000);
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
  expect(await pane.find({key:'job-ada'})).toBeDefined();
  await pane.press({key:'job-ada'});
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
  expect(await pane.find({type:'Text',text:/^Paused/})).toBeUndefined();
  expect(await pane.find({type:'Text',text:'Following live output.'})).toBeUndefined();
});

test('canonical acceptance refreshes in an open worker view; a read failure keeps the rows', async ($, on) => {
  const ids = ['job-native-1'];
  const files = canonicalJob('job-native-1', {status:'succeeded',name:'Ada',workerId:'ada',finishedAt:iso(RUNNING_NOW-1000),toolCalls:1},
    {'acceptance.json':JSON.stringify({state:'unchecked',pending:true,running:'tests',checks:[]}),'result.md':'Worker report'});
  const { clock } = forgeHost(on, files, ids);
  await start($);
  await launch($, 'job-native-1');
  await $.command.run({command:'forge',args:'job-native-1'});
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({type:'Text',text:/checks running/})).toBeDefined();
  files['/work/.agent-smith/jobs/job-native-1/acceptance.json']=JSON.stringify({state:'rejected',pending:false,checks:[
    {name:'tests',ok:false,outputTail:'',timedOut:true,signal:'SIGTERM',reason:'command timed out'}]});
  await clock.advance(1000);
  expect(await pane.find({type:'Text',text:/✗ tests · timed out · signal SIGTERM · command timed out/})).toBeDefined();
  await pane.press({key:'back'});
  ids.push('job-broken');
  files['/work/.agent-smith/jobs/job-broken/job.json']='{broken';
  await clock.advance(1000);
  expect(await pane.find({type:'Text',text:/Can't read job state/})).toBeDefined();
  expect(await pane.find({key:'job-ada'})).toBeDefined();
});

test('a quiet but live worker shows process alive instead of Stalled, and the line disappears once a new event arrives', async ($, on) => {
  const files = canonicalJob('job-ada', {status:'running',name:'Ada',workerId:'ada',provider:'agy',updatedAt:iso(RUNNING_NOW-130_000)},
    {'progress.json':JSON.stringify({lastEventAt:iso(RUNNING_NOW-130_000),lastAliveAt:iso(RUNNING_NOW-10_000)})});
  const { clock } = forgeHost(on, files, ['job-ada']);
  await start($);
  await $.command.run({command:'forge',args:'Ada'});
  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({type:'Text',text:'No output 2m10s · process alive'})).toBeDefined();
  expect(await pane.find({type:'Text',text:/Stalled/})).toBeUndefined();

  files['/work/.agent-smith/jobs/job-ada/progress.json'] = JSON.stringify({lastEventAt:iso(RUNNING_NOW+1000),lastAliveAt:iso(RUNNING_NOW+1000)});
  await clock.advance(3000);
  expect(await pane.find({type:'Text',text:/No output .* · process alive/})).toBeUndefined();
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
  const band = await $.ui.mount({
    plugin: 'agent-smith',
    surface: 'terminal',
    ...BAND,
    viewport: { columns: 180, rows: 40, isFullscreen: true },
    props: { ...BAND.props, bodyColumns: 180 },
  } as never);
  expect(await band.find({ key: 'band-ada' })).toBeDefined();

  await $.command.run({ command: 'forge', args: '' });
  expect(host.opens).toHaveLength(1);
  expect(host.opens[0]).toMatchObject({ id: 'agent-smith', focus: true, columns: 60 });

  const pane = await $.ui.mount(PANE_TARGET);
  expect(await pane.find({ key: 'job-ada' })).toBeDefined();
  expect(host.opens).toHaveLength(1);

  await $.ui.mount({
    plugin: 'agent-smith',
    surface: 'terminal',
    ...BAND,
    requestId: 'forge-band-docked',
    viewport: { columns: 119, rows: 40, isFullscreen: true },
    props: { ...BAND.props, bodyColumns: 119 },
  } as never);
  await pane.press({ key: 'job-ada' });
  expect(await pane.find({ key: 'back' })).toBeDefined();
  expect(host.opens).toHaveLength(1);

  await (pane as unknown as { unmount(): Promise<void> }).unmount();
  const resizedPane = await $.ui.mount({
    ...(PANE_TARGET as Record<string, unknown>),
    requestId: 'agent-smith',
    viewport: { columns: 104, rows: 40, isFullscreen: true },
    props: { ...((PANE_TARGET as { props: Record<string, unknown> }).props), bodyColumns: 75, placement: 'dock' },
  } as never);
  expect(await resizedPane.find({ key: 'back' })).toBeDefined();
  expect(host.opens).toHaveLength(1);

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
  expect(await band.find({ key: 'band-ada' })).toBeDefined();
  await $.command.run({ command: 'forge', args: '' });
  await $.ui.mount(PANE_TARGET);
  expect(host.opens).toHaveLength(1);

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

  expect(await pane.find({ type: 'Text', text: /✗ Renyi · implement/ })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: /Denied rm\nsecond line/ })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: /Warn retry/ })).toBeDefined();
  expect(await pane.find({ type: 'Markdown', text: 'Heading bold\nline 2' })).toBeDefined();
  await pane.press({ key: 'event-1' });
  expect(await pane.find({ type: 'Text', text: /error\[E0425\]: cannot find value\n10%\n100%/ })).toBeDefined();
  expect(await pane.find({ type: 'Markdown', text: 'Final report\nclean' })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: '✗ clippy! · exit 1' })).toBeDefined();
  expect(await pane.find({ type: 'Text', text: 'warning: unused variable\ndone' })).toBeDefined();

  await pane.press({ key: 'task' });
  expect(await pane.find({ type: 'Markdown', text: 'Preamble ok\n\nInspect Renyi\nstep 2' })).toBeDefined();

  expect(files['/work/.agent-smith/jobs/job-dirty/view.json']).toBe(rawView);
  expect(files['/work/.agent-smith/jobs/job-dirty/acceptance.json']).toBe(rawAcceptance);
});

describe('update check', () => {
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

  test('a newer release on main is one toast naming both versions and how to update', async ($, on) => {
    const { seen, clock } = updateHost(on, '0.2.1', released('0.2.3'));
    await start($);
    await clock.advance(1);
    expect(seen.fetched).toEqual(['https://raw.githubusercontent.com/sgathrid/agent-smith/main/builds/local-plugin/agent-smith/.claude-plugin/plugin.json']);
    expect(seen.toasts).toEqual([updateLine('0.2.1', '0.2.3')]);
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
  function noticeHost(on: (...args: any[]) => void, files: Record<string,string>, ids: string[], env: Record<string,string> = {}) {
    const r = forgeHost(on, files, ids, env);
    const said = { logs: [] as string[], prompts: [] as string[], origins: [] as any[], hookRuns: 0 };
    on('ui.log', (_$: unknown, e: any) => { said.logs.push(e.text); return {value:undefined}; });
    on('prompt.submit', (_$: unknown, e: any) => { said.prompts.push(e.text); said.origins.push(e.origin); return {text:e.text}; });
    on('classic.PostToolUse', () => { said.hookRuns++; return {}; });
    on('fs.write', (_$: unknown, e: any) => { files[e.path] = e.text; return {value:undefined}; });
    on('turn.start', (_$: unknown, e: any) => ({ turnId: e.turnId }));
    on('turn.complete', (_$: unknown, e: any) => ({ text: e.answer ?? '' }));
    return { ...r, said };
  }
  const ada = (status: string, more: Record<string, unknown> = {}) => canonicalJob('job-ada',
    {status,name:'Ada',workerId:'w-ada',provider:'codex',role:'review',...more},
    status === 'running' ? {} : {'acceptance.json':JSON.stringify({state:'accepted',checks:[{name:'tests',ok:true},{name:'lint',ok:true}]})});

  test('a finished owned job: the hook stands down, no ui.log, one prompt.submit', async ($, on) => {
    const files = ada('running');
    const { clock, said } = noticeHost(on, files, ['job-ada']);
    await start($);
    const r = await launched($, 'job-ada');
    expect(r.result.structuredContent.jobId).toBe('job-ada');
    expect(Object.hasOwn(files, '/work/.agent-smith/claims/job-job-ada')).toBe(true);
    await ($ as any).turn.complete({ turnId: 't-launch', reason: 'answer', answer: 'ok', durationMs: 10, isAborted: false });

    await clock.advance(3000);
    expect(said.logs).toEqual([]);
    Object.assign(files, ada('succeeded', {startedAt:iso(RUNNING_NOW-43_000),finishedAt:iso(RUNNING_NOW+1000),updatedAt:iso(RUNNING_NOW+1000),changedFiles:['a.ts','b.ts']}));
    await clock.advance(3000);
    await clock.advance(3000);

    expect(said.logs).toEqual([]);
    expect(said.prompts).toHaveLength(1);
    expect(said.origins[0]?.asUser).not.toBe(true);
    expect(said.prompts[0]).toMatch(/^Agent Smith · ✓ Ada \(codex review\) · checks 2\/2 · 44s\nstatus w-ada$/);
  });

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
    await ($ as any).turn.complete({ turnId: 't-launch', reason: 'answer', answer: 'ok', durationMs: 10, isAborted: false });
    Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }));
    await settledRead($, 'job-ada', { agentId: 'sub-1' });
    await clock.advance(3000);
    await clock.advance(3000);
    expect(said.prompts).toHaveLength(1);
  });

  describe('status wait_ms on an announced worker', () => {
    const statusWait = ($: any, more: Record<string, unknown> = {}, tool = 'status') =>
      $.tool.call({ tool: `mcp__plugin_agent-smith_agent-smith__${tool}`, id: 'job-ada', wait_ms: 60_000, ...more });
    const owning = async ($: any, on: any, isInteractive = true) => {
      const { host } = noticeHost(on, ada('running'), ['job-ada']);
      await $.session.start({ surface: isInteractive ? 'terminal' : null, isInteractive, cwd: '/work' } as never);
      await launched($, 'job-ada');
      return host;
    };

    test('the main loop is denied and the tool is not called', async ($, on) => {
      const host = await owning($, on);
      const r = await statusWait($) as any;
      expect(r.deny).toBe('job-ada will be announced when it finishes. Call status without wait_ms to check it now.');
      expect(host.statusCalls).toBe(0);
    });

    test('a headless session passes through', async ($, on) => {
      const host = await owning($, on, false);
      const r = await statusWait($) as any;
      expect(r.deny).toBeUndefined();
      expect(host.statusCalls).toBe(1);
    });

    for (const [label, more, tool] of [
      ['a subagent', { agentId: 'sub-1' }, 'status'],
      ['a status without wait_ms', { wait_ms: undefined }, 'status'],
      ['pipeline_status', {}, 'pipeline_status'],
    ] as const) {
      test(`${label} passes through`, async ($, on) => {
        await owning($, on);
        const r = await statusWait($, more, tool) as any;
        expect(r.deny).toBeUndefined();
        expect(r.result).toBeDefined();
      });
    }
  });

  test('a variants ack claims every job it started, and skips a variant that failed', async ($, on) => {
    const files = { ...ada('running'), ...canonicalJob('job-bo', { status: 'running', name: 'Bo', provider: 'codex', role: 'review' }) };
    noticeHost(on, files, ['job-ada', 'job-bo']);
    await start($);
    const r = await $.tool.call({ tool: 'mcp__plugin_agent-smith_agent-smith__spawn_job', variantJobs: ['job-ada', 'job-bo'], repo: '/work' }) as any;
    expect(r.result.structuredContent.jobs).toHaveLength(3);
    expect(Object.hasOwn(files, '/work/.agent-smith/claims/job-job-ada')).toBe(true);
    expect(Object.hasOwn(files, '/work/.agent-smith/claims/job-job-bo')).toBe(true);
    expect(Object.keys(files).filter((k) => k.includes('/claims/'))).toHaveLength(2);
  });

  test('a variants ack with two jobs announces both jobs when both finish', async ($, on) => {
    const files = { ...ada('running'), ...canonicalJob('job-bo', { status: 'running', name: 'Bo', workerId: 'w-bo', provider: 'codex', role: 'review' }) };
    const { clock, said } = noticeHost(on, files, ['job-ada', 'job-bo']);
    await start($);
    await $.tool.call({ tool: 'mcp__plugin_agent-smith_agent-smith__spawn_job', variantJobs: ['job-ada', 'job-bo'], repo: '/work' });
    await ($ as any).turn.complete({ turnId: 't-launch', reason: 'answer', answer: 'ok', durationMs: 10, isAborted: false });
    Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }),
      canonicalJob('job-bo', { status: 'succeeded', name: 'Bo', workerId: 'w-bo', provider: 'codex', role: 'review', finishedAt: iso(RUNNING_NOW + 1000) },
        { 'acceptance.json': JSON.stringify({ state: 'accepted', checks: [] }) }));
    await clock.advance(3000);
    await clock.advance(3000);
    await clock.advance(3000);
    expect(said.prompts).toHaveLength(1);
    expect(said.prompts[0]).toMatch(/status w-ada, w-bo/);
    const all = said.prompts.join('\n');
    expect(all).toMatch(/Ada/);
    expect(all).toMatch(/Bo/);
  });

  for (const settled of [true, false]) {
    test(`a cancel answering settled:${settled} ${settled ? 'retires the notice' : 'leaves the notice'}`, async ($, on) => {
      const files = ada('running');
      const { clock, said } = noticeHost(on, files, ['job-ada']);
      await start($);
      await launched($, 'job-ada');
      await $.tool.call({ tool: 'mcp__plugin_agent-smith_agent-smith__cancel', jobId: 'job-ada', settled });
      await ($ as any).turn.complete({ turnId: 't-launch', reason: 'answer', answer: 'ok', durationMs: 10, isAborted: false });
      Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }));
      await clock.advance(3000);
      await clock.advance(3000);
      expect(said.prompts).toHaveLength(settled ? 0 : 1);
    });
  }

  test('the mod leaves classic.PostToolUse to the command hook', async ($, on) => {
    const { said } = noticeHost(on, ada('running'), ['job-ada']);
    await start($);
    await ($ as any).classic.PostToolUse({
      tool_name: 'mcp__plugin_agent-smith_agent-smith__spawn_job', tool_use_id: 'tu-1', tool_input: {},
      tool_response: { structuredContent: { jobId: 'job-ada', repo: '/work', timeoutMs: 600_000 }, content: [] },
    });
    expect(said.hookRuns).toBe(1);
  });

  test('a notice row drops the host frame and status line, even via stored or marketplace origin', async ($, on) => {
    on('ui.render', { component: 'UserMessage' }, ($: any, e: any) => $.ui.resolve(e).Text({ children: e.props.text }));
    const text = 'The agent-smith plugin sent a message:\n  Agent Smith · ✓ hig-codex (codex review) · done · 7m\n  status review-smith-7cdfd099\n\n' +
      "  This is how Claude Code surfaces a prompt a plugin submits between turns — it starts this turn in the user's place. Address the message above.";
    for (const isExpanded of [false, true]) {
      const row = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', component: 'UserMessage', requestId: `row-${isExpanded}`,
        props: { text, origin: { kind: 'plugin', name: 'agent-smith' }, isExpanded } } as never);
      expect(await row.find({ type: 'Text', text: /^Agent Smith · ✓ hig-codex \(codex review\) · done · 7m$/ })).toBeDefined();
      expect(await row.find({ type: 'Text', text: /This is how Claude Code|sent a message|^status / })).toBeUndefined();
    }
    const storedRow = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', component: 'UserMessage', requestId: 'row-stored',
      props: {
        text: 'Agent Smith · ✗ ship · 1/2 stages passed · 2m\npipeline_status run-1',
        origin: { kind: 'person' },
        stored: { kind: 'plugin', name: 'agent-smith@local' },
      } } as never);
    expect(await storedRow.find({ type: 'Text', text: /^Agent Smith · ✗ ship · 1\/2 stages passed · 2m$/ })).toBeDefined();
    expect(await storedRow.find({ type: 'Text', text: /pipeline_status/ })).toBeUndefined();
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

  test('a worker finishing mid-turn and read with status before turn.complete submits no prompt', async ($, on) => {
    const files = ada('running');
    const { clock, said } = noticeHost(on, files, ['job-ada']);
    await start($);
    await launched($, 'job-ada');
    await ($ as any).turn.start({ turnId: 't-1', text: 'check' });
    Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }));
    await clock.advance(3000);
    await clock.advance(3000);
    expect(said.prompts).toEqual([]);
    await settledRead($, 'job-ada');
    await ($ as any).turn.complete({ turnId: 't-1', reason: 'answer', answer: 'done', durationMs: 100, isAborted: false });
    await clock.advance(3000);
    expect(said.prompts).toEqual([]);
  });

  test('a worker finishing mid-turn and not read submits once after turn.complete', async ($, on) => {
    const files = ada('running');
    const { clock, said } = noticeHost(on, files, ['job-ada']);
    await start($);
    await launched($, 'job-ada');
    await ($ as any).turn.start({ turnId: 't-1', text: 'work' });
    Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }));
    await clock.advance(3000);
    await clock.advance(3000);
    expect(said.prompts).toEqual([]);
    await ($ as any).turn.complete({ turnId: 't-1', reason: 'aborted', answer: '', durationMs: 100, isAborted: true });
    expect(said.prompts).toHaveLength(1);
    await clock.advance(3000);
    expect(said.prompts).toHaveLength(1);
  });

  test('a subagent turn.start/turn.complete does not hold or release main-loop notices', async ($, on) => {
    const files = ada('running');
    const { clock, said } = noticeHost(on, files, ['job-ada']);
    await start($);
    await launched($, 'job-ada');
    await ($ as any).turn.complete({ turnId: 't-launch', reason: 'answer', answer: 'ok', durationMs: 10, isAborted: false });
    await ($ as any).turn.start({ turnId: 'sub-t1', agentId: 'sub-1', text: 'sub' });
    Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }));
    await clock.advance(3000);
    await clock.advance(3000);
    expect(said.prompts).toHaveLength(1);
    await ($ as any).turn.complete({ turnId: 'sub-t1', agentId: 'sub-1', reason: 'answer', answer: 'ok', durationMs: 50, isAborted: false });
    expect(said.prompts).toHaveLength(1);
  });

  test('with no turn events fired, completion notices announce on poll as before', async ($, on) => {
    const files = ada('running');
    const { clock, said } = noticeHost(on, files, ['job-ada']);
    await $.session.start({ surface: null, isInteractive: false, cwd: '/work' } as never);
    await launched($, 'job-ada');
    Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }));
    await clock.advance(3000);
    await clock.advance(3000);
    expect(said.prompts).toHaveLength(1);
  });

  test('with no turn.start fired, a main-loop launch tool call holds notices until turn.complete and settled status read submits no prompt', async ($, on) => {
    const files = ada('running');
    const { clock, said } = noticeHost(on, files, ['job-ada']);
    await start($);
    await launched($, 'job-ada');
    Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }));
    await clock.advance(3000);
    await clock.advance(3000);
    expect(said.prompts).toEqual([]);
    await settledRead($, 'job-ada');
    await ($ as any).turn.complete({ turnId: 't-1', reason: 'answer', answer: 'done', durationMs: 100, isAborted: false });
    await clock.advance(3000);
    expect(said.prompts).toEqual([]);
  });

  test('with no turn.start fired, a main-loop launch tool call without a status read submits once after turn.complete', async ($, on) => {
    const files = ada('running');
    const { clock, said } = noticeHost(on, files, ['job-ada']);
    await start($);
    await launched($, 'job-ada');
    Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }));
    await clock.advance(3000);
    await clock.advance(3000);
    expect(said.prompts).toEqual([]);
    await ($ as any).turn.complete({ turnId: 't-1', reason: 'answer', answer: 'done', durationMs: 100, isAborted: false });
    expect(said.prompts).toHaveLength(1);
    await clock.advance(3000);
    expect(said.prompts).toHaveLength(1);
  });

  test('a tool call carrying an agentId does not hold main-loop notices', async ($, on) => {
    const files = ada('running');
    const { clock, said } = noticeHost(on, files, ['job-ada']);
    await start($);
    await $.tool.call({ tool: 'mcp__plugin_agent-smith_agent-smith__spawn_job', jobId: 'job-ada', repo: '/work', agentId: 'sub-1' });
    Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }));
    await clock.advance(3000);
    await clock.advance(3000);
    expect(said.prompts).toHaveLength(1);
  });

  test('when registering turn hooks throws, a main-loop tool call does not hold notices', async () => {
    const files = ada('running');
    const prompts: string[] = [];
    const store = new Map<string, { value: unknown; version: number }>();
    const ticks: (() => void)[] = [];
    const hook$ = {
      env: { get: async () => undefined },
      clock: {
        now: async () => RUNNING_NOW,
        every: (_ms: number, fn: () => void) => { ticks.push(fn); return { cancel: () => {} }; },
      },
      fs: {
        read: async (p: string) => {
          if (!Object.hasOwn(files, p)) throw new Error(`ENOENT: ${p}`);
          return files[p]!;
        },
        exists: async (p: string) => p === '/work/.agent-smith/jobs' || Object.hasOwn(files, p),
        list: async () => [{ name: 'job-ada', kind: 'dir', size: 0 }],
        write: async (p: string, text: string) => { files[p] = text; },
      },
      state: {
        get: async (ref: { plugin: string; key: string }) => store.get(`${ref.plugin}:${ref.key}`) ?? { value: undefined, version: 0 },
        set: async (ref: { plugin: string; key: string }, value: unknown) => {
          const k = `${ref.plugin}:${ref.key}`;
          const version = (store.get(k)?.version ?? 0) + 1;
          store.set(k, { value, version });
          return { isSet: true, version };
        },
      },
      command: { register: async () => {} },
      prompt: { submit: async (input: { text: string }) => { prompts.push(input.text); return { text: input.text }; } },
      plugin: { root: '/plugin' },
      ui: { toast: async () => {} },
    };
    const handlers: { event: string; matcher?: unknown; fn: (...args: any[]) => any }[] = [];
    const throwingOn = (event: string, matcherOrFn: any, maybeFn?: any) => {
      if (event === 'turn.start' || event === 'turn.complete') {
        throw new Error(`unsupported event: ${event}`);
      }
      const fn = typeof matcherOrFn === 'function' ? matcherOrFn : maybeFn;
      const matcher = typeof matcherOrFn === 'function' ? undefined : matcherOrFn;
      handlers.push({ event, matcher, fn });
    };
    registerMod(throwingOn as never);
    const sessionStart = handlers.find((h) => h.event === 'session.start')!.fn;
    await sessionStart(hook$, { surface: 'terminal', isInteractive: true, cwd: '/work' }, async (e: any) => ({ cwd: e.cwd }));
    const launchHook = handlers.find((h) => h.event === 'tool.call' && (h.matcher as any)?.tool?.test('mcp__plugin_agent-smith_agent-smith__spawn_job'))!.fn;
    const launchNext = Object.assign(
      async (e: any) => launchAck(e),
      { origin: { plugin: 'engine', tier: 'core' } },
    );
    await launchHook(hook$, { tool: 'mcp__plugin_agent-smith_agent-smith__spawn_job', jobId: 'job-ada', repo: '/work' }, launchNext);
    Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }));
    for (const tick of ticks) tick();
    await new Promise((r) => setTimeout(r, 20));
    for (const tick of ticks) tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(prompts).toHaveLength(1);
  });

  test('turn.start firing while announce awaits file reads holds the notice without submitting or committing', async ($, on) => {
    const files: Record<string, string> = {
      ...ada('running'),
      '/work/.agent-smith/pipelines/p1.json': JSON.stringify({ runId: 'p1', pipeline: 'pipe', startedAt: RUNNING_NOW, finishedAt: null, status: 'running', stageResults: {} }),
    };
    let releaseRead: (() => void) | null = null;
    const readPaused = new Promise<void>((r) => { releaseRead = r; });
    let holdReads = false;
    const said = { prompts: [] as string[] };
    const clock = mock.clock(on as never, { now: RUNNING_NOW });
    on('session.start', (_$: unknown, e: any) => ({ sessionId: 's', cwd: e.cwd }));
    on('command.register', () => ({ value: undefined }));
    on('env.get', () => ({ value: undefined }));
    on('fs.list', () => ({ value: [{ name: 'job-ada', kind: 'dir', size: 0 }] }));
    on('fs.exists', (_$: unknown, e: any) => {
      const p = String(e.path);
      const name = p.slice(p.lastIndexOf('/') + 1);
      return { value: p === '/work/.agent-smith/jobs' || Object.hasOwn(files, p) || Object.hasOwn(files, name) };
    });
    on('fs.read', async (_$: unknown, e: any) => {
      const p = String(e.path);
      const name = p.slice(p.lastIndexOf('/') + 1);
      if (holdReads && p.endsWith('p1.json')) await readPaused;
      const body = files[p] ?? files[name];
      return body !== undefined ? { value: body } : { deny: `ENOENT: ${p}` };
    });
    on('fs.write', (_$: unknown, e: any) => { files[e.path] = e.text; return { value: undefined }; });
    on('tool.call', (_$: unknown, e: any) => LAUNCH_TOOL.test(e.tool) ? launchAck(e) : { deny: 'unexpected' });
    on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'REST' }));
    on('prompt.submit', (_$: unknown, e: any) => { said.prompts.push(e.text); return { text: e.text }; });
    on('turn.start', (_$: unknown, e: any) => ({ turnId: e.turnId }));
    on('turn.complete', (_$: unknown, e: any) => ({ text: e.answer ?? '' }));

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    await $.tool.call({ tool: 'mcp__plugin_agent-smith_agent-smith__run_pipeline', runId: 'p1', repo: '/work' });
    Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }));
    files['/work/.agent-smith/pipelines/p1.json'] = JSON.stringify({ runId: 'p1', pipeline: 'pipe', startedAt: RUNNING_NOW, finishedAt: RUNNING_NOW + 1000, status: 'passed', stageResults: {} });
    holdReads = true;
    const advanceP = clock.advance(1000);
    await new Promise((r) => setTimeout(r, 20));
    await ($ as any).turn.start({ turnId: 't-race', text: 'user prompt' });
    releaseRead!();
    await advanceP;
    await new Promise((r) => setTimeout(r, 20));
    expect(said.prompts).toEqual([]);
    await ($ as any).turn.complete({ turnId: 't-race', reason: 'answer', answer: 'ok', durationMs: 50, isAborted: false });
    expect(said.prompts).toHaveLength(1);
  });

  test('dropped or rejected prompt.submit leaves notice pending for the next poll without duplicate sends', async ($, on) => {
    const files = ada('running');
    const { clock } = forgeHost(on, files, ['job-ada']);
    let mode: 'drop' | 'reject' | 'pending' | 'accept' = 'drop';
    let releasePending: (() => void) | null = null;
    const prompts: string[] = [];
    on('fs.write', (_$: unknown, e: any) => { files[e.path] = e.text; return { value: undefined }; });
    on('prompt.submit', async (_$: unknown, e: any) => {
      prompts.push(e.text);
      if (mode === 'drop') return { drop: 'session input held' };
      if (mode === 'reject') throw new Error('host busy');
      if (mode === 'pending') {
        await new Promise<void>((r) => { releasePending = r; });
        return { text: e.text };
      }
      return { text: e.text };
    });
    on('turn.start', (_$: unknown, e: any) => ({ turnId: e.turnId }));
    on('turn.complete', (_$: unknown, e: any) => ({ text: e.answer ?? '' }));

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    await launched($, 'job-ada');
    await ($ as any).turn.start({ turnId: 't-1', text: 'work' });
    Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }));
    await ($ as any).turn.complete({ turnId: 't-1', reason: 'aborted', answer: '', durationMs: 100, isAborted: true });
    expect(prompts).toHaveLength(1);

    mode = 'reject';
    await clock.advance(1000);
    expect(prompts).toHaveLength(2);

    mode = 'pending';
    await clock.advance(1000);
    expect(prompts).toHaveLength(3);

    await clock.advance(1000);
    await clock.advance(1000);
    expect(prompts).toHaveLength(3);

    releasePending!();
    await new Promise((r) => setTimeout(r, 20));

    mode = 'accept';
    await clock.advance(1000);
    expect(prompts).toHaveLength(3);
  });

  test('status read while an attention prompt.submit is in flight preserves readHead and suppresses completion notice', async ($, on) => {
    const files = ada('running', { startedAt: iso(RUNNING_NOW - 16 * 60_000), updatedAt: iso(RUNNING_NOW - 16 * 60_000) });
    const { clock } = forgeHost(on, files, ['job-ada']);
    let releaseSubmit: (() => void) | null = null;
    const prompts: string[] = [];
    on('fs.write', (_$: unknown, e: any) => { files[e.path] = e.text; return { value: undefined }; });
    on('prompt.submit', async (_$: unknown, e: any) => {
      prompts.push(e.text);
      if (prompts.length === 1) {
        await new Promise<void>((r) => { releaseSubmit = r; });
      }
      return { text: e.text };
    });
    on('turn.start', (_$: unknown, e: any) => ({ turnId: e.turnId }));
    on('turn.complete', (_$: unknown, e: any) => ({ text: e.answer ?? '' }));

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    await launched($, 'job-ada');
    await ($ as any).turn.complete({ turnId: 't-launch', reason: 'answer', answer: 'ok', durationMs: 10, isAborted: false });
    await clock.advance(1000);
    expect(prompts).toHaveLength(1);

    Object.assign(files, ada('succeeded', { finishedAt: iso(RUNNING_NOW + 1000) }));
    await settledRead($, 'job-ada');
    releaseSubmit!();
    await new Promise((r) => setTimeout(r, 20));

    await clock.advance(1000);
    expect(prompts).toHaveLength(1);
  });

  test('newer turn recorded and read while prior prompt.submit is in flight stays retired', async ($, on) => {
    const files = ada('running', { startedAt: iso(RUNNING_NOW - 16 * 60_000), updatedAt: iso(RUNNING_NOW - 16 * 60_000) });
    const ids = ['job-ada'];
    const { clock } = forgeHost(on, files, ids);
    let releaseSubmit: (() => void) | null = null;
    const prompts: string[] = [];
    on('fs.write', (_$: unknown, e: any) => { files[e.path] = e.text; return { value: undefined }; });
    on('prompt.submit', async (_$: unknown, e: any) => {
      prompts.push(e.text);
      if (prompts.length === 1) {
        await new Promise<void>((r) => { releaseSubmit = r; });
      }
      return { text: e.text };
    });
    on('turn.start', (_$: unknown, e: any) => ({ turnId: e.turnId }));
    on('turn.complete', (_$: unknown, e: any) => ({ text: e.answer ?? '' }));

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never);
    await $.tool.call({ tool: 'mcp__plugin_agent-smith_agent-smith__spawn_job', jobId: 'job-ada', workerId: 'w-ada', repo: '/work' });
    await ($ as any).turn.complete({ turnId: 't-launch', reason: 'answer', answer: 'ok', durationMs: 10, isAborted: false });
    await clock.advance(1000);
    expect(prompts).toHaveLength(1);

    Object.assign(files, canonicalJob('job-ada-2',
      { status: 'succeeded', name: 'Ada', workerId: 'w-ada', provider: 'codex', role: 'review', continuedFrom: 'job-ada', finishedAt: iso(RUNNING_NOW + 1000), updatedAt: iso(RUNNING_NOW + 1000) },
      { 'acceptance.json': JSON.stringify({ state: 'accepted', checks: [{ name: 'tests', ok: true }] }) }));
    ids.push('job-ada-2');
    await $.tool.call({ tool: 'mcp__plugin_agent-smith_agent-smith__follow_up', jobId: 'job-ada-2', workerId: 'w-ada', repo: '/work' });
    await settledRead($, 'job-ada-2');
    releaseSubmit!();
    await new Promise((r) => setTimeout(r, 20));

    await clock.advance(1000);
    expect(prompts).toHaveLength(1);
  });

  test('a failed worker read with status mid-turn retires its notice even when the status payload carries an error string', async ($, on) => {
    const files = ada('running');
    const { clock, said } = noticeHost(on, files, ['job-ada']);
    await start($);
    await launched($, 'job-ada');
    await ($ as any).turn.start({ turnId: 't-1', text: 'check' });
    Object.assign(files, ada('failed', { finishedAt: iso(RUNNING_NOW + 1000), error: 'timed out after 2m' }));
    await clock.advance(3000);
    await clock.advance(3000);
    expect(said.prompts).toEqual([]);
    await settledRead($, 'job-ada', { status: 'failed', error: 'timed out after 2m' });
    await ($ as any).turn.complete({ turnId: 't-1', reason: 'answer', answer: 'done', durationMs: 100, isAborted: false });
    await clock.advance(3000);
    expect(said.prompts).toEqual([]);
  });
});

describe("a session cwd that is not the server's repo (#43)", () => {
  const drifted = ($: any, cwd = '/work/reports/x') => $.session.start({surface:'terminal',isInteractive:true,cwd} as never);
  const files = () => canonicalJob('job-ada', {status:'running',name:'Ada',provider:'codex',role:'review'});

  test('a launch moves the watch to the repo the server reported: shown, listed, and claimed', async ($, on) => {
    const jobs = files();
    const host: Record<string,string> = jobs;
    forgeHost(on, host, ['job-ada']);
    on('fs.write', (_$: unknown, e: any) => { host[e.path] = e.text; return {value:undefined}; });
    on('prompt.submit', (_$: unknown, e: any) => ({text:e.text}));
    await drifted($);
    await launched($, 'job-ada', '/work/');
    const band = await $.ui.mount({plugin:'agent-smith',surface:'terminal',...BAND} as never);
    expect(await band.find({key:'band-job-ada'})).toBeDefined();
    expect(await $.command.run({command:'forge',args:''})).toMatchObject({text:'1 running'});
    expect(Object.hasOwn(host, '/work/.agent-smith/claims/job-job-ada')).toBe(true);
  });

  test('a later session.start from the drifted cwd keeps the repo a launch reported', async ($, on) => {
    forgeHost(on, files(), ['job-ada']);
    await start($);
    await launched($, 'job-ada');
    await drifted($);
    expect(await $.command.run({command:'forge',args:''})).toMatchObject({text:'1 running'});
    expect(await $.command.run({command:'forge',args:'all'})).toMatchObject({text:'repository: 1 running'});
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

describe('worker-first UI, inline prior turns, auto-follow, and O(active) idle polling', () => {
  test('band groups by workerId (always 1 row across steer/resume), renders pendingSteers, turn N, and continuous chainStartedAt', async ($, on) => {
    const t1Start = RUNNING_NOW - 72_000;
    const t2Start = RUNNING_NOW - 12_000;
    const files = {
      ...canonicalJob('job-ada-1', {
        status: 'succeeded', name: 'Ada', workerId: 'ada', turn: 1,
        startedAt: iso(t1Start), finishedAt: iso(t2Start), updatedAt: iso(t2Start),
      }),
      ...canonicalJob('job-ada-2', {
        status: 'running', name: 'Ada', workerId: 'ada', turn: 2,
        continuedFrom: 'job-ada-1', continuationKind: 'steer',
        startedAt: iso(t2Start), chainStartedAt: iso(t1Start), updatedAt: iso(RUNNING_NOW),
      }, {
        'progress.json': JSON.stringify({ lastEventAt: iso(RUNNING_NOW), lastAliveAt: iso(RUNNING_NOW), pendingSteers: 1, toolCalls: 3 }),
      }),
    };
    forgeHost(on, files, ['job-ada-1', 'job-ada-2']);
    await start($);
    await launch($, 'job-ada-1');
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);
    const buttons = await band.findAll({ type: 'Button' });
    expect(buttons).toHaveLength(1);
    const row = await band.find({ key: 'band-ada' }) as { props?: Record<string, unknown> } | undefined;
    expect(row).toBeDefined();
    expect(String(row?.props?.label)).toMatch(/1 queued ∙ turn 2/);
    expect(String(row?.props?.label)).toMatch(/1m12s$/);
  });

  test('the band says "1 queued" until the worker reads the message, then /forge shows it inline where it was read', async ($, on) => {
    const view = (timeline: unknown[]) => JSON.stringify({ schema: 1, prompt: 'Fix the parser', preamble: '', truncated: false, timeline });
    const said = { kind: 'assistant', sequence: 0, at: iso(RUNNING_NOW - 2000), text: 'Reading the parser.' };
    const job = (pendingSteers: number, timeline: unknown[]) => canonicalJob('job-ada', {
      status: 'running', name: 'Ada', workerId: 'ada', turn: 1, provider: 'claude', updatedAt: iso(RUNNING_NOW),
    }, {
      'progress.json': JSON.stringify({ lastEventAt: iso(RUNNING_NOW), lastAliveAt: iso(RUNNING_NOW), pendingSteers, toolCalls: 2 }),
      'view.json': view(timeline),
    });
    const files: Record<string, string> = job(1, [said]);
    const { clock } = forgeHost(on, files, ['job-ada']);
    await start($);
    await launch($, 'job-ada');
    const band = await $.ui.mount({ plugin: 'agent-smith', surface: 'terminal', ...BAND } as never);
    const label = async () => String(((await band.find({ key: 'band-ada' })) as { props?: Record<string, unknown> } | undefined)?.props?.label);
    expect(await label()).toMatch(/1 queued/);

    Object.assign(files, job(0, [said, { kind: 'message', sequence: 1, at: iso(RUNNING_NOW + 500), text: 'Also cover the empty-input case.\nThanks.', delivery: 'next-step', sender: 'follow_up' }]));
    await clock.advance(1000);
    expect(await label()).not.toMatch(/queued|follow-up|message/);
    await $.command.run({ command: 'forge', args: 'Ada' });
    const pane = await $.ui.mount(PANE_TARGET);
    expect(await pane.find({ type: 'Text', text: '↳ follow-up read: Also cover the empty-input case.' })).toBeDefined();
    expect(await pane.find({ type: 'Markdown', text: '● Reading the parser.' })).toBeDefined();
  });

  test('/forge auto-follows live head on steer, renders clickable prior turns inline above live turn, and supports pinning a prior turn', async ($, on) => {
    const t1Start = RUNNING_NOW - 72_000;
    const ids = ['job-ada-1'];
    const t1View = JSON.stringify({
      schema: 1, prompt: 'First task', preamble: '', truncated: false,
      timeline: [{ kind: 'assistant', sequence: 0, at: iso(t1Start + 5000), text: 'Turn 1 work.' }],
    });
    const t2View = JSON.stringify({
      schema: 1, prompt: 'Steered task', preamble: '', truncated: false,
      timeline: [{ kind: 'assistant', sequence: 0, at: iso(RUNNING_NOW + 500), text: 'Turn 2 live work.' }],
    });
    const files: Record<string, string> = {
      ...canonicalJob('job-ada-1', {
        status: 'running', name: 'Ada', workerId: 'ada', turn: 1, provider: 'codex',
        startedAt: iso(t1Start), updatedAt: iso(RUNNING_NOW), toolCalls: 14,
      }, { 'view.json': t1View }),
    };
    const { clock } = forgeHost(on, files, ids);
    await start($);
    await launch($, 'job-ada-1');
    await $.command.run({ command: 'forge', args: 'Ada' });
    const pane = await $.ui.mount(PANE_TARGET);
    expect(await pane.find({ type: 'Markdown', text: '● Turn 1 work.' })).toBeDefined();

    Object.assign(files, canonicalJob('job-ada-1', {
      status: 'canceled', name: 'Ada', workerId: 'ada', turn: 1, provider: 'codex',
      supersededBy: 'job-ada-2', startedAt: iso(t1Start), finishedAt: iso(RUNNING_NOW), updatedAt: iso(RUNNING_NOW), toolCalls: 14,
    }, { 'view.json': t1View }));
    ids.push('job-ada-2');
    Object.assign(files, canonicalJob('job-ada-2', {
      status: 'running', name: 'Ada', workerId: 'ada', turn: 2, provider: 'codex',
      continuedFrom: 'job-ada-1', continuationKind: 'steer',
      startedAt: iso(RUNNING_NOW), chainStartedAt: iso(t1Start), updatedAt: iso(RUNNING_NOW + 1000),
    }, { 'view.json': t2View }));

    await clock.advance(1000);
    expect(await pane.find({ type: 'Markdown', text: '● Turn 2 live work.' })).toBeDefined();
    const priorBtn = await pane.find({ key: 'turn-job-ada-1' }) as { props?: Record<string, unknown> } | undefined;
    expect(String(priorBtn?.props?.label)).toMatch(/^▸ 1  Inspect\s+steered · 1m12s$/);
    expect(await pane.find({ type: 'Text', text: '▾ 2  Steered task' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'Earlier runs' })).toBeUndefined();

    await pane.press({ key: 'turn-job-ada-1' });
    expect(await pane.find({ type: 'Markdown', text: '● Turn 1 work.' })).toBeDefined();
    const backLive = await pane.find({ key: 'return-live' }) as { props?: Record<string, unknown> } | undefined;
    expect(String(backLive?.props?.label)).toBe('↩ Back to Turn 2 (live)');
    await clock.advance(1000);
    expect(await pane.find({ type: 'Markdown', text: '● Turn 1 work.' })).toBeDefined();

    await pane.press({ key: 'return-live' });
    expect(await pane.find({ type: 'Markdown', text: '● Turn 2 live work.' })).toBeDefined();
    expect(await pane.find({ key: 'return-live' })).toBeUndefined();
  });

  test('idle-when-quiet lists the jobs dir once a tick and reads no file, wakes immediately on launch or /forge open, and serves settled jobs from cache', async ($, on) => {
    const ids = ['done-1'];
    const files: Record<string, string> = {
      ...canonicalJob('done-1', {
        status: 'succeeded', name: 'Old', workerId: 'old', turn: 1,
        startedAt: iso(RUNNING_NOW - 120_000), finishedAt: iso(RUNNING_NOW - 60_000), updatedAt: iso(RUNNING_NOW - 60_000),
      }, { 'acceptance.json': JSON.stringify({ state: 'accepted', pending: false, checks: [] }) }),
    };
    const { host, clock } = forgeHost(on, files, ids);

    await start($);
    host.io.list = 0;
    host.io.reads.length = 0;

    await clock.advance(10_000);
    expect(host.io.list).toBeGreaterThanOrEqual(10);
    expect(host.io.list).toBeLessThanOrEqual(11);
    expect(host.io.reads).toEqual([]);

    await $.command.run({ command: 'forge', args: 'all' });
    expect(host.io.list).toBeGreaterThan(0);
    expect(host.io.reads.some((p) => p.includes('/done-1/'))).toBe(false);
    const pane = await $.ui.mount(PANE_TARGET);
    await pane.press({ key: 'close' });
    host.io.list = 0;
    host.io.reads.length = 0;
    await clock.advance(5_000);
    expect(host.io.list).toBe(5);
    expect(host.io.reads).toEqual([]);

    ids.push('live-1');
    Object.assign(files, canonicalJob('live-1', {
      status: 'running', name: 'Fresh', workerId: 'fresh', turn: 1,
      startedAt: iso(RUNNING_NOW + 15_000), updatedAt: iso(RUNNING_NOW + 15_000),
    }));
    await launch($, 'live-1');
    expect(host.io.reads.some((p) => p.includes('/live-1/'))).toBe(true);
    expect(host.io.reads.some((p) => p.includes('/done-1/'))).toBe(false);

    host.io.reads.length = 0;
    await clock.advance(1000);
    expect(host.io.reads.some((p) => p.includes('/live-1/'))).toBe(true);
    expect(host.io.reads.some((p) => p.includes('/done-1/'))).toBe(false);
  });

  test('a worker started outside this session wakes the band within one idle tick', async ($, on) => {
    const ids = ['done-1'];
    const files: Record<string, string> = {
      ...canonicalJob('done-1', {
        status: 'succeeded', name: 'Old', workerId: 'old', turn: 1,
        startedAt: iso(RUNNING_NOW - 120_000), finishedAt: iso(RUNNING_NOW - 60_000), updatedAt: iso(RUNNING_NOW - 60_000),
      }, { 'acceptance.json': JSON.stringify({ state: 'accepted', pending: false, checks: [] }) }),
    };
    const { host, clock } = forgeHost(on, files, ids);
    await start($);
    await clock.advance(3_000);
    host.io.reads.length = 0;
    await clock.advance(2_000);
    expect(host.io.reads).toEqual([]);

    ids.push('ext-1');
    Object.assign(files, canonicalJob('ext-1', {
      status: 'running', name: 'Elsewhere', workerId: 'ext', turn: 1,
      startedAt: iso(RUNNING_NOW + 4_000), updatedAt: iso(RUNNING_NOW + 5_000),
    }));
    await clock.advance(1_000);
    expect(host.io.reads.some((p) => p.includes('/ext-1/'))).toBe(true);
    expect(host.io.reads.some((p) => p.includes('/done-1/'))).toBe(false);
    host.io.reads.length = 0;
    await clock.advance(1_000);
    expect(host.io.reads.some((p) => p.includes('/ext-1/'))).toBe(true);
    expect(await $.command.run({ command: 'forge', args: 'all' })).toMatchObject({ text: expect.stringMatching(/1 running/) });
  });

  test('single-turn running worker renders one header line, no starting row, no turn list, and Task/Back/Close footer', async ($, on) => {
    const files = canonicalJob('job-single', {
      status: 'running', name: 'links1', workerId: 'links1', role: 'implement',
      provider: 'agy', model: 'gemini-4-neon-xhigh', task: 'Refactor the links engine',
      startedAt: iso(RUNNING_NOW - 5000), updatedAt: iso(RUNNING_NOW),
    }, {
      'progress.json': JSON.stringify({
        lastEventAt: iso(RUNNING_NOW), toolCalls: 0,
        digest: { phase: 'starting', filesRead: 0, searches: 0, edited: [], editedCount: 0, commands: 0, testRuns: 0, lastTestFailed: false, repeat: null },
      }),
      'view.json': JSON.stringify({ schema: 1, prompt: 'Refactor the links engine', preamble: '', truncated: false, tools: [], transcript: [], timeline: [] }),
    });
    forgeHost(on, files, ['job-single']);
    await start($);
    await launch($, 'job-single');
    await $.command.run({ command: 'forge', args: 'links1' });
    const pane = await $.ui.mount(PANE_TARGET);

    expect(await pane.find({ type: 'Text', text: '⏺ links1 · implement · 5s' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'agy gemini-4-neon-xhigh' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /turn 1/ })).toBeUndefined();
    expect(await pane.find({ type: 'Text', text: /Starting/ })).toBeUndefined();
    expect(await pane.find({ key: 'turn-job-single' })).toBeUndefined();
    expect(await pane.find({ type: 'Text', text: 'Task: Refactor the links engine' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'No worker activity recorded yet.' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'Following live output.' })).toBeUndefined();
    const btns = (await pane.findAll({ type: 'Button' })) as { props?: Record<string, unknown> }[];
    expect(btns.map((b) => `${b.props?.hotkey}:${b.props?.label}`)).toEqual(['t:Task', 'b:Back', 'x:Close']);
  });

  test('three-turn worker reads task from stored messages, suppresses duplicate turn-start message, and formats turn rows without tool counts', async ($, on) => {
    const t1Start = RUNNING_NOW - 5_448_000;
    const t2Start = RUNNING_NOW - 288_000;
    const t3Start = RUNNING_NOW - 5_000;
    const steeredPrompt = 'Your previous turn completed.\n\nAfter you finish the 19 test failures, do the decided fix list';
    const files: Record<string, string> = {
      ...canonicalJob('job-l-1', {
        status: 'succeeded', name: 'links2-neon', workerId: 'links2', turn: 1, role: 'implement',
        provider: 'agy', model: 'gemini-4-neon-xhigh', task: 'Refactor the links engine',
        startedAt: iso(t1Start), finishedAt: iso(t2Start), updatedAt: iso(t2Start), toolCalls: 614,
      }, {
        'acceptance.json': JSON.stringify({
          state: 'accepted', pending: false,
          checks: [
            { name: 'a', ok: true, outputTail: '' }, { name: 'b', ok: true, outputTail: '' },
            { name: 'c', ok: true, outputTail: '' }, { name: 'd', ok: true, outputTail: '' },
          ],
        }),
      }),
      ...canonicalJob('job-l-2', {
        status: 'succeeded', name: 'links2-neon', workerId: 'links2', turn: 2, role: 'implement',
        provider: 'agy', model: 'gemini-4-neon-xhigh', task: 'Fix the review findings',
        startedAt: iso(t2Start), finishedAt: iso(t3Start), updatedAt: iso(t3Start), toolCalls: 41,
      }, {
        'acceptance.json': JSON.stringify({
          state: 'rejected', pending: false,
          checks: [{ name: 'lint', ok: false, outputTail: '' }],
        }),
      }),
      ...canonicalJob('job-l-3', {
        status: 'running', name: 'links2-neon', workerId: 'links2', turn: 3, role: 'implement',
        provider: 'agy', model: 'gemini-4-neon-xhigh', task: 'Refactor the links engine',
        startedAt: iso(t3Start), chainStartedAt: iso(t3Start), updatedAt: iso(RUNNING_NOW),
      }, {
        'progress.json': JSON.stringify({
          lastEventAt: iso(RUNNING_NOW), toolCalls: 0,
          digest: { phase: 'starting', filesRead: 0, searches: 0, edited: [], editedCount: 0, commands: 0, testRuns: 0, lastTestFailed: false, repeat: null },
        }),
        'view.json': JSON.stringify({
          schema: 1, prompt: steeredPrompt, preamble: '', truncated: false, tools: [], transcript: [],
          messages: [{ sender: 'follow_up', text: 'After you finish the 19 test failures, do the decided fix list' }],
          timeline: [
            { kind: 'message', sequence: 0, at: iso(RUNNING_NOW), text: 'After you finish the 19 test failures, do the decided fix list', delivery: 'turn-start', sender: 'follow_up' },
            { kind: 'message', sequence: 1, at: iso(RUNNING_NOW + 100), text: 'Also check the empty-input edge case.', delivery: 'next-step', sender: 'follow_up' },
          ],
        }),
      }),
    };
    forgeHost(on, files, ['job-l-1', 'job-l-2', 'job-l-3']);
    await start($);
    await launch($, 'job-l-1');
    await $.command.run({ command: 'forge', args: 'links2-neon' });
    const pane = await $.ui.mount(PANE_TARGET);

    expect(await pane.find({ type: 'Text', text: '⏺ links2-neon · implement · turn 3 · 5s' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'agy gemini-4-neon-xhigh' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /Starting/ })).toBeUndefined();
    const t1 = (await pane.find({ key: 'turn-job-l-1' })) as { props?: Record<string, unknown> } | undefined;
    const t2 = (await pane.find({ key: 'turn-job-l-2' })) as { props?: Record<string, unknown> } | undefined;
    expect(String(t1?.props?.label)).toMatch(/^▸ 1  Refactor the links engine\s+checks ✓ 4\/4 · 1h26m$/);
    expect(String(t2?.props?.label)).toMatch(/^▸ 2  Fix the review findings\s+✗ lint · 4m43s$/);
    expect(String(t1?.props?.label)).not.toMatch(/tools?/);
    expect(String(t2?.props?.label)).not.toMatch(/tools?/);
    expect(await pane.find({ type: 'Text', text: /^▾ 3  After you finish the 19 test failures, do the decided/ })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: '↳ follow-up read: After you finish the 19 test failures, do the decided fix list' })).toBeUndefined();
    expect(await pane.find({ type: 'Text', text: '↳ follow-up read: Also check the empty-input edge case.' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'Following live output.' })).toBeUndefined();

    await pane.press({ key: 'task' });
    expect(await pane.find({ type: 'Markdown', text: steeredPrompt })).toBeDefined();
  });

  test('earlier-turn rows built from manifests only (no view.json prompt) show each turn manifest task', async ($, on) => {
    const t1Start = RUNNING_NOW - 120_000;
    const t2Start = RUNNING_NOW - 60_000;
    const t3Start = RUNNING_NOW - 5_000;
    const files: Record<string, string> = {
      ...canonicalJob('job-m-1', {
        status: 'succeeded', name: 'Ada', workerId: 'ada', turn: 1, role: 'implement',
        model: 'gemini-4-neon-xhigh', task: 'Refactor the links engine',
        startedAt: iso(t1Start), finishedAt: iso(t2Start), updatedAt: iso(t2Start),
      }),
      ...canonicalJob('job-m-2', {
        status: 'succeeded', name: 'Ada', workerId: 'ada', turn: 2, role: 'implement',
        model: 'gemini-4-neon-xhigh', task: 'Fix the review findings',
        startedAt: iso(t2Start), finishedAt: iso(t3Start), updatedAt: iso(t3Start),
      }),
      ...canonicalJob('job-m-3', {
        status: 'running', name: 'Ada', workerId: 'ada', turn: 3, role: 'implement',
        model: 'gemini-4-neon-xhigh', task: 'Verify edge cases',
        startedAt: iso(t3Start), chainStartedAt: iso(t3Start), updatedAt: iso(RUNNING_NOW),
      }, {
        'view.json': JSON.stringify({
          schema: 1,
          prompt: 'Your previous turn completed.\n\nVerify edge cases',
          messages: [{ sender: 'follow_up', text: 'Verify edge cases' }],
          preamble: '', truncated: false, tools: [], transcript: [], timeline: [],
        }),
      }),
    };
    forgeHost(on, files, ['job-m-1', 'job-m-2', 'job-m-3']);
    await start($);
    await launch($, 'job-m-1');
    await $.command.run({ command: 'forge', args: 'Ada' });
    const pane = await $.ui.mount(PANE_TARGET);

    const b1 = (await pane.find({ key: 'turn-job-m-1' })) as { props?: Record<string, unknown> } | undefined;
    const b2 = (await pane.find({ key: 'turn-job-m-2' })) as { props?: Record<string, unknown> } | undefined;
    expect(String(b1?.props?.label)).toMatch(/^▸ 1  Refactor the links engine\s+done · 1m00s$/);
    expect(String(b2?.props?.label)).toMatch(/^▸ 2  Fix the review findings\s+done · 55s$/);
    expect(await pane.find({ type: 'Text', text: '▾ 3  Verify edge cases' })).toBeDefined();
  });

  test('expanded tool, error, and group rows use ▾/✗ glyphs, un-dim expanded headers, and indent bodies by 2 columns per level', async ($, on) => {
    const view = JSON.stringify({
      schema: 1, prompt: 'Inspect', preamble: '', truncated: false, tools: [], transcript: [],
      timeline: [
        { kind: 'tool', sequence: 0, at: iso(RUNNING_NOW), stepIndex: 0, tool: 'Read', input: 'src/a.ts', output: 'line 1\nline 2', state: 'done' },
        { kind: 'tool', sequence: 1, at: iso(RUNNING_NOW), stepIndex: 1, tool: 'Read', input: 'src/b.ts', output: 'b', state: 'done' },
        { kind: 'tool', sequence: 2, at: iso(RUNNING_NOW), stepIndex: 2, tool: 'Grep', input: '{"pattern":"x"}', output: 'match', state: 'done' },
        { kind: 'tool', sequence: 3, at: iso(RUNNING_NOW), stepIndex: 3, tool: 'Edit', input: '{"file_path":"src/c.ts"}', output: 'saved', state: 'done' },
        { kind: 'tool', sequence: 4, at: iso(RUNNING_NOW), stepIndex: 4, tool: 'Bash', input: '{"command":"npm test"}', output: 'exit 1', state: 'error' },
      ],
    });
    const files = canonicalJob('job-exp', { status: 'running', name: 'Exp', workerId: 'exp', role: 'implement' }, { 'view.json': view });
    forgeHost(on, files, ['job-exp']);
    await start($);
    await launch($, 'job-exp');
    await $.command.run({ command: 'forge', args: 'exp' });
    const pane = await $.ui.mount(PANE_TARGET);

    const collapsedEdit = (await pane.find({ key: 'event-3' })) as { props?: Record<string, unknown> } | undefined;
    expect(String(collapsedEdit?.props?.label)).toBe('✓ editing c.ts');
    expect(collapsedEdit?.props?.dimColor).toBe(true);
    expect(await pane.find({ key: 'body-event-3' })).toBeUndefined();

    const errorCmd = (await pane.find({ key: 'event-4' })) as { props?: Record<string, unknown>; children?: { props?: Record<string, unknown> }[] } | undefined;
    expect(String(errorCmd?.props?.label)).toBe('✗ running tests');
    expect(errorCmd?.props?.dimColor).toBe(false);
    expect(errorCmd?.children?.[0]?.props?.color).toBe('red');
    expect(await pane.find({ key: 'body-event-4' })).toBeUndefined();
    expect(await pane.find({ type: 'Text', text: 'Bash {"command":"npm test"}\nexit 1' })).toBeUndefined();

    await pane.press({ key: 'event-4' });
    const errorExpanded = (await pane.find({ key: 'event-4' })) as { props?: Record<string, unknown> } | undefined;
    expect(String(errorExpanded?.props?.label)).toBe('✗ running tests');
    const errorBody = (await pane.find({ key: 'body-event-4' })) as { props?: Record<string, unknown>; children?: unknown[] } | undefined;
    expect(errorBody?.props?.flexDirection).toBe('row');
    expect(await pane.find({ type: 'Text', text: 'Bash {"command":"npm test"}\nexit 1' })).toBeDefined();
    expect(await pane.find({ key: 'end-event-4' })).toBeDefined();

    await pane.press({ key: 'event-4' });
    expect(await pane.find({ key: 'body-event-4' })).toBeUndefined();
    expect(await pane.find({ key: 'end-event-4' })).toBeUndefined();

    await pane.press({ key: 'event-3' });
    const expandedEdit = (await pane.find({ key: 'event-3' })) as { props?: Record<string, unknown> } | undefined;
    expect(String(expandedEdit?.props?.label)).toBe('▾ editing c.ts');
    expect(expandedEdit?.props?.dimColor).toBe(false);
    const editBody = (await pane.find({ key: 'body-event-3' })) as { props?: Record<string, unknown> } | undefined;
    expect(editBody?.props?.flexDirection).toBe('row');
    expect(await pane.find({ type: 'Text', text: 'Edit {"file_path":"src/c.ts"}\nsaved' })).toBeDefined();

    await pane.press({ key: 'group-0' });
    const expandedGroup = (await pane.find({ key: 'group-0' })) as { props?: Record<string, unknown> } | undefined;
    expect(String(expandedGroup?.props?.label)).toBe('▾ read 2 files · 1 search');
    expect(expandedGroup?.props?.dimColor).toBe(false);
    const groupBody = (await pane.find({ key: 'body-group-0' })) as { props?: Record<string, unknown> } | undefined;
    expect(groupBody?.props?.flexDirection).toBe('row');

    await pane.press({ key: 'event-0' });
    const nestedRead = (await pane.find({ key: 'event-0' })) as { props?: Record<string, unknown> } | undefined;
    expect(String(nestedRead?.props?.label)).toBe('▾ reading');
    expect(nestedRead?.props?.dimColor).toBe(false);
    const nestedBody = (await pane.find({ key: 'body-event-0' })) as { props?: Record<string, unknown> } | undefined;
    expect(nestedBody?.props?.flexDirection).toBe('row');
    expect(await pane.find({ type: 'Text', text: 'Read src/a.ts\nline 1\nline 2' })).toBeDefined();
  });

  test('error tool row is plain when NO_COLOR is set and expanded blocks get one trailing blank line without doubling prose gaps', async ($, on) => {
    const view = JSON.stringify({
      schema: 1, prompt: 'Inspect', preamble: '', truncated: false, tools: [], transcript: [],
      timeline: [
        { kind: 'tool', sequence: 0, at: iso(RUNNING_NOW), stepIndex: 0, tool: 'Bash', input: '{"command":"npm test"}', output: 'exit 1', state: 'error' },
        { kind: 'tool', sequence: 1, at: iso(RUNNING_NOW), stepIndex: 1, tool: 'Edit', input: '{"file_path":"src/c.ts"}', output: 'saved', state: 'done' },
        { kind: 'assistant', sequence: 2, at: iso(RUNNING_NOW), text: 'Checking output.' },
      ],
    });
    const files = canonicalJob('job-col', { status: 'running', name: 'Col', workerId: 'col', role: 'implement' }, { 'view.json': view });
    forgeHost(on, files, ['job-col'], { NO_COLOR: '1' });
    await start($);
    await launch($, 'job-col');
    await $.command.run({ command: 'forge', args: 'col' });
    const pane = await $.ui.mount(PANE_TARGET);

    const errorBtn = (await pane.find({ key: 'event-0' })) as { children?: { props?: Record<string, unknown> }[] } | undefined;
    expect(errorBtn?.children?.[0]?.props?.color).toBeUndefined();
    expect(await pane.find({ key: 'end-event-0' })).toBeUndefined();
    expect(await pane.find({ key: 'end-event-1' })).toBeUndefined();

    await pane.press({ key: 'event-0' });
    expect(await pane.find({ key: 'end-event-0' })).toBeDefined();

    await pane.press({ key: 'event-1' });
    expect(await pane.find({ key: 'end-event-1' })).toBeUndefined();
    expect(await pane.find({ key: 'gap-event-2' })).toBeDefined();
  });

  test('worker header shows provider alone when model is unknown and avoids duplicating prefixed model names', async ($, on) => {
    const unknownModel = canonicalJob('job-no-model', { status: 'running', name: 'NoModel', workerId: 'no-model', role: 'implement', provider: 'agy', model: null });
    const prefixedModel = canonicalJob('job-prefixed', { status: 'running', name: 'Prefixed', workerId: 'prefixed', role: 'review', provider: 'claude', model: 'claude-sonnet-4-5' });
    forgeHost(on, { ...unknownModel, ...prefixedModel }, ['job-no-model', 'job-prefixed']);
    await start($);
    await launch($, 'job-no-model');
    await launch($, 'job-prefixed');
    await $.command.run({ command: 'forge', args: 'NoModel' });
    const pane = await $.ui.mount(PANE_TARGET);
    expect(await pane.find({ type: 'Text', text: /NoModel · implement · 5s/ })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'agy' })).toBeDefined();
    await $.command.run({ command: 'forge', args: 'Prefixed' });
    expect(await pane.find({ type: 'Text', text: /Prefixed · review · 5s/ })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'claude-sonnet-4-5' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /claude claude-sonnet-4-5/ })).toBeUndefined();
  });

  test('transcript-gap adds one blank line when timeline has rows, none when empty, and does not double before prose', async ($, on) => {
    const emptyFiles = canonicalJob('job-empty', { status: 'running', name: 'Empty', workerId: 'empty', role: 'implement', provider: 'codex', model: 'gpt-6' }, {
      'view.json': JSON.stringify({ schema: 1, prompt: 'Do it', preamble: '', truncated: false, tools: [], transcript: [], timeline: [] }),
    });
    const proseFiles = canonicalJob('job-prose', { status: 'running', name: 'Prose', workerId: 'prose', role: 'implement', provider: 'codex', model: 'gpt-6' }, {
      'view.json': JSON.stringify({
        schema: 1, prompt: 'Do it', preamble: '', truncated: false, tools: [], transcript: [],
        timeline: [{ sequence: 1, kind: 'assistant', at: iso(RUNNING_NOW - 1000), text: 'First thought.' }],
      }),
    });
    forgeHost(on, { ...emptyFiles, ...proseFiles }, ['job-empty', 'job-prose']);
    await start($);
    await launch($, 'job-empty');
    await launch($, 'job-prose');
    await $.command.run({ command: 'forge', args: 'Empty' });
    const pane = await $.ui.mount(PANE_TARGET);
    expect(await pane.find({ key: 'transcript-gap' })).toBeUndefined();
    expect(await pane.find({ type: 'Text', text: 'No worker activity recorded yet.' })).toBeDefined();
    await $.command.run({ command: 'forge', args: 'Prose' });
    expect(await pane.find({ key: 'transcript-gap' })).toBeDefined();
    expect(await pane.find({ key: 'gap-event-1' })).toBeUndefined();
    expect((await pane.findAll({ key: 'transcript-gap' })).length).toBe(1);
  });

  test('worker header checks label: silent while worker runs with checks defined, checking while running, verdict when done', async ($, on) => {
    const files = canonicalJob('job-chk', { status: 'running', name: 'Chk', workerId: 'chk', role: 'implement', provider: 'agy', model: 'gemini-4-hydrogen' }, {
      'acceptance.json': JSON.stringify({ state: 'unchecked', pending: true, checks: [] }),
    });
    const { clock } = forgeHost(on, files, ['job-chk']);
    await start($);
    await $.command.run({ command: 'forge', args: 'Chk' });
    const pane = await $.ui.mount(PANE_TARGET);
    expect(await pane.find({ type: 'Text', text: /Chk · implement · 5s$/ })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'agy gemini-4-hydrogen' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: /checks running|checking/ })).toBeUndefined();

    files['/work/.agent-smith/jobs/job-chk/job.json'] = JSON.stringify({
      ...JSON.parse(files['/work/.agent-smith/jobs/job-chk/job.json']!),
      status: 'succeeded', finishedAt: iso(RUNNING_NOW + 1000), updatedAt: iso(RUNNING_NOW + 1000),
    });
    files['/work/.agent-smith/jobs/job-chk/acceptance.json'] = JSON.stringify({ state: 'unchecked', pending: true, running: 'tests', checks: [] });
    await clock.advance(1000);
    expect(await pane.find({ type: 'Text', text: 'agy gemini-4-hydrogen · checks running' })).toBeDefined();

    files['/work/.agent-smith/jobs/job-chk/acceptance.json'] = JSON.stringify({
      state: 'accepted', pending: false, checks: [{ name: 'tests', ok: true, outputTail: '' }],
    });
    await clock.advance(1000);
    expect(await pane.find({ type: 'Text', text: 'agy gemini-4-hydrogen · checks 1/1' })).toBeDefined();
  });

  test('three-line header renders running, finished, failed, and checks-running states', async ($, on) => {
    const files: Record<string, string> = {
      ...canonicalJob('job-s1', {
        status: 'running', name: 'cleanup-058', workerId: 'w-s1', turn: 2, role: 'implement',
        provider: 'agy', model: 'gemini-4-hydrogen', startedAt: iso(RUNNING_NOW - 113_000), pendingSteers: 1,
      }, {
        'progress.json': JSON.stringify({
          lastEventAt: iso(RUNNING_NOW), toolCalls: 33,
          digest: { phase: 'exploring', filesRead: 22, searches: 10, edited: [], editedCount: 0, commands: 0, testRuns: 1, lastTestFailed: false, repeat: null },
        }),
      }),
      ...canonicalJob('job-s2', {
        status: 'succeeded', name: 'arch-doc', workerId: 'w-s2', role: 'implement',
        provider: 'agy', model: 'gemini-4-hydrogen', startedAt: iso(RUNNING_NOW - 24_000), finishedAt: iso(RUNNING_NOW),
        changedFiles: ['README.md'],
      }, {
        'acceptance.json': JSON.stringify({
          state: 'accepted', pending: false,
          checks: [{ name: 'lint', ok: true, outputTail: '' }, { name: 'tests', ok: true, outputTail: '' }],
        }),
      }),
      ...canonicalJob('job-s3', {
        status: 'failed', name: 'final-kimi', workerId: 'w-s3', role: 'verify',
        provider: 'kimi', model: 'k3.1-pro-highspeed', startedAt: iso(RUNNING_NOW - 5_000), finishedAt: iso(RUNNING_NOW),
        error: '429 insufficient_quota',
      }),
      ...canonicalJob('job-s4', {
        status: 'succeeded', name: 'links2', workerId: 'w-s4', turn: 3, role: 'implement',
        provider: 'codex', model: 'gpt-6.2-sol', startedAt: iso(RUNNING_NOW - 240_000), finishedAt: iso(RUNNING_NOW),
      }, {
        'acceptance.json': JSON.stringify({ state: 'unchecked', pending: true, running: 'tests', checks: [] }),
      }),
    };
    forgeHost(on, files, ['job-s1', 'job-s2', 'job-s3', 'job-s4']);
    await start($);
    for (const id of ['job-s1', 'job-s2', 'job-s3', 'job-s4']) await launch($, id);

    await $.command.run({ command: 'forge', args: 'cleanup-058' });
    const pane = await $.ui.mount(PANE_TARGET);
    expect(await pane.find({ type: 'Text', text: '⏺ cleanup-058 · implement · turn 2 · 1m53s' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'agy gemini-4-hydrogen · 1 queued' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'Exploring · 22 files read · 10 searches · tests ran 1×' })).toBeDefined();

    await $.command.run({ command: 'forge', args: 'arch-doc' });
    expect(await pane.find({ type: 'Text', text: '✓ arch-doc · implement · 24s' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'agy gemini-4-hydrogen · checks 2/2 · 1 file changed' })).toBeDefined();

    await $.command.run({ command: 'forge', args: 'final-kimi' });
    expect(await pane.find({ type: 'Text', text: '✗ final-kimi · verify · 5s' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'kimi k3.1-pro-highspeed · out of credits' })).toBeDefined();

    await $.command.run({ command: 'forge', args: 'links2' });
    expect(await pane.find({ type: 'Text', text: '✓ links2 · implement · turn 3 · 4m' })).toBeDefined();
    expect(await pane.find({ type: 'Text', text: 'codex gpt-6.2-sol · checks running' })).toBeDefined();
  });
});
