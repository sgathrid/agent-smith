import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATTENTION_TTL_MS, PANE_FALLBACK_COLUMNS, PANE_MIN_COLUMNS, checksLabel, commandTerminalColumns, condenseTimeline, countLine, findWorker, forgeList, groupWorkers, measurePaneTerminalColumns, needsAttention, paneWidthRequest, recordLaunch, scopeLine, sessionBoard, sessionJobs, statusLine, timelineGroupLabel, turnCount, workerHeading, workerStatus } from '../hooks/dashboard.ts';
import { oneLine, sanitizeText } from '../hooks/format.ts';
import type { RadarJob } from '../types/index.d.ts';
const job=(id:string,extra:Partial<RadarJob>={}):RadarJob=>({id,status:'running',startedAt:100,endedAt:null,toolCount:1,activity:'Read file.ts',task:'Review',warnings:[],report:null,reasoning:null,raw:{},...extra});
test('the list puts running and checking work first, then settled work most recent first',()=>{
  const running=job('run',{startedAt:50});
  const pending=job('pending',{status:'succeeded',startedAt:10,endedAt:20,acceptance:{state:'unchecked',pending:true,checks:[]}});
  const older=job('older',{status:'failed',startedAt:10,endedAt:30});
  const newer=job('newer',{status:'succeeded',startedAt:5,endedAt:90});
  assert.deepEqual(forgeList([older,newer,pending,running]).map(j=>j.id),['run','pending','newer','older']);
  assert.match(workerStatus(pending),/done · checking/);
});
test('only real worker identities group runs; live runs win over older failures',()=>{
  const earlier=job('old',{workerId:'ada',status:'failed',startedAt:200});
  const live=job('new',{workerId:'ada',startedAt:100});
  const unrelated=job('other',{name:'Ada'});
  assert.deepEqual(groupWorkers([earlier,live,unrelated]).map(j=>j.id),['new','other']);
});
test('/forge <query> matches a job id, then a worker name or id in any case, preferring live work',()=>{
  const failed=job('job-1',{name:'Ada',workerId:'ada',status:'failed',startedAt:300,endedAt:310});
  const live=job('job-2',{name:'Ada',workerId:'ada-2',startedAt:100});
  assert.equal(findWorker([failed,live],'ada')?.id,'job-2');
  assert.equal(findWorker([failed,live],'job-1')?.id,'job-1');
  assert.equal(findWorker([failed,live],'ADA-2')?.id,'job-2');
  assert.equal(findWorker([failed,live],'Grace'),undefined);
});
test('failed rows show their failure reason and do not show unchecked when no checks ran',()=>{
  assert.equal(workerStatus(job('orphan',{status:'failed',failureReason:'orphaned',acceptance:{state:'unchecked',checks:[]}})),'failed · server stopped');
  assert.equal(workerStatus(job('failed',{status:'failed',acceptance:{state:'unchecked',checks:[]}})),'failed');
  assert.equal(workerStatus(job('checked',{status:'failed',failureReason:'timeout',acceptance:{state:'rejected',checks:[{name:'tests',ok:false,outputTail:''}]}})),'failed · timed out');
});
test('acceptance reads as a pass count or the failing check names',()=>{
  assert.equal(checksLabel(undefined),'');
  assert.equal(checksLabel({state:'unchecked',pending:true,checks:[]}),'checking');
  assert.equal(checksLabel({state:'accepted',checks:[{name:'tests',ok:true,outputTail:''},{name:'lint',ok:true,outputTail:''}]}),'checks ✓ 2/2');
  assert.equal(checksLabel({state:'rejected',checks:[{name:'tests',ok:true,outputTail:''},{name:'lint',ok:false,outputTail:''}]}),'✗ lint');
  assert.equal(checksLabel({state:'unchecked',checks:[]}),'');
});
test('settled failures stop needing attention after 24 h; live, pending and stalled work never does',()=>{
  const now=10*ATTENTION_TTL_MS;
  const old=now-ATTENTION_TTL_MS-1;
  const oldFailed=job('old',{status:'failed',startedAt:old-10,endedAt:old,failureReason:'orphaned'});
  const freshFailed=job('fresh',{status:'failed',startedAt:now-1000,endedAt:now-500});
  const oldRejected=job('rejected',{status:'succeeded',startedAt:old-10,endedAt:old,acceptance:{state:'rejected',checks:[]}});
  const undated=job('undated',{status:'failed',startedAt:null,endedAt:null});
  const stalled=job('stalled',{status:'attention',startedAt:old-10});
  const pending=job('pending',{status:'failed',startedAt:old-10,endedAt:old,acceptance:{state:'unchecked',pending:true,checks:[]}});
  assert.deepEqual([oldFailed,freshFailed,oldRejected,undated,stalled,pending].filter(j=>needsAttention(j,now)).map(j=>j.id),
    ['fresh','undated','stalled','pending']);
  assert.equal(needsAttention(oldFailed),true); // no clock, no expiry
  assert.equal(needsAttention(oldFailed,old+ATTENTION_TTL_MS),true); // boundary is exclusive
  assert.equal(workerStatus(oldFailed),'failed · server stopped');
});
test('session launches are recorded once and select their jobs and pipeline stage jobs',()=>{
  let launched=recordLaunch({jobs:[],runs:[]},{kind:'job',id:'mine'});
  launched=recordLaunch(launched,{kind:'run',id:'run-1'});
  assert.equal(recordLaunch(launched,{kind:'job',id:'mine'}),launched);
  assert.deepEqual(launched,{jobs:['mine'],runs:['run-1']});
  const rows=[job('mine'),job('other'),job('stage',{pipeline:'run-1'}),job('foreign-stage',{pipeline:'run-2'})];
  assert.deepEqual(sessionJobs(rows,launched).map(j=>j.id),['mine','stage']);
  assert.deepEqual(sessionJobs(rows,{jobs:[],runs:[]}),[]);
});
test('the /forge counts name this session, or label the repository, never padded lifetime totals',()=>{
  const rows=[job('a'),job('b'),job('c',{status:'failed',endedAt:200}),job('d',{status:'succeeded',endedAt:300})];
  assert.equal(countLine(rows),'2 running · 1 failed · 1 done');
  assert.equal(countLine([job('x',{status:'succeeded',endedAt:1})]),'1 done');
  assert.equal(scopeLine(rows.slice(0,2),'session'),'2 running');
  assert.equal(scopeLine([],'session'),'No workers in this session');
  assert.equal(scopeLine(rows,'all'),'repository: 2 running · 1 failed · 1 done');
  assert.equal(scopeLine([],'all'),'repository: no workers yet');
  // One count per listed worker: a resumed worker is one row.
  assert.equal(countLine([job('r1',{workerId:'ada',status:'succeeded',endedAt:1}),job('r2',{workerId:'ada',startedAt:200})]),'1 running');
});

test('a denial, and an old job with only the long error, read as the same short reason',()=>{
  const long='worker soft-denied 1 tool action(s) (view_file) — it exited 0 and reported success while doing nothing.';
  assert.equal(workerStatus(job('d',{status:'failed',failureReason:long})),'failed · denied view_file');
  assert.equal(workerStatus(job('s',{status:'succeeded',acceptance:{state:'rejected',checks:[{name:'lint',ok:false,outputTail:''}]}})),'checks failed: lint');
  assert.equal(workerStatus(job('t',{status:'attention'})),'stalled');
});

test('measurePaneTerminalColumns reconstructs terminal width from docked pane geometry and leaves fullscreen/non-docked viewports intact', () => {
  // Docked pane on a 180-column terminal: viewport.columns is conversationColumns (119), bodyColumns is 60, divider is 1.
  assert.equal(measurePaneTerminalColumns({ columns: 119 }, { bodyColumns: 60, placement: 'dock' }), 180);
  assert.equal( paneWidthRequest(measurePaneTerminalColumns({ columns: 119 }, { bodyColumns: 60, placement: 'dock' }) ?? null), 60);
  // User-resized dock (e.g. dragged to 75 columns on a 180-column terminal -> conversationColumns is 104):
  // terminal width is still 180, so paneWidthRequest(180) stays 60 and matches lastPaneRequest without fighting user sizing.
  assert.equal(measurePaneTerminalColumns({ columns: 104 }, { bodyColumns: 75, placement: 'dock' }), 180);
  // Fullscreen or non-docked placement uses viewport.columns directly.
  assert.equal(measurePaneTerminalColumns({ columns: 180 }, { bodyColumns: 180, placement: 'fullscreen' }), 180);
  assert.equal(measurePaneTerminalColumns({ columns: 150 }, { bodyColumns: 50 }), 150);
  // Missing or invalid geometry returns undefined so lastViewportColumns is not clobbered.
  assert.equal(measurePaneTerminalColumns(undefined, { bodyColumns: 60, placement: 'dock' }), undefined);
  assert.equal(measurePaneTerminalColumns({ columns: 119 }, { bodyColumns: 0, placement: 'dock' }), undefined);
  assert.equal(paneWidthRequest(null), PANE_FALLBACK_COLUMNS);
  assert.equal(paneWidthRequest(60), PANE_MIN_COLUMNS);
});

test('commandTerminalColumns reads the terminal width the host stamps on a command event', () => {
  // command.run's presentation.columns is the whole terminal, so a fresh /forge
  // can size the dock before any band render has measured it.
  assert.equal(commandTerminalColumns({ isFullscreen: true, columns: 180 }), 180);
  assert.equal(commandTerminalColumns({ columns: 144.7 }), 144);
  assert.equal(commandTerminalColumns({ columns: 0 }), undefined);
  assert.equal(commandTerminalColumns({ columns: '180' }), undefined);
  assert.equal(commandTerminalColumns(undefined), undefined);
  assert.equal(commandTerminalColumns(null), undefined);
});

test('sanitizeText strips ANSI sequences and forbidden controls while preserving newlines and valid astral characters', () => {
  // Complete CSI, OSC (BEL and ST), DCS, and C1 sequences are removed cleanly without leaving parameter tails.
  const ansi = '\x1b[38;5;196mred\x1b[0m \x1b]8;;https://example.com\x07link\x1b]8;;\x1b\\ \x1bP1$r0m\x1b\\ \x9b32mgreen\x9b0m';
  assert.equal(sanitizeText(ansi), 'red link  green');
  // Progress carriage returns become newlines; tabs become spaces; NUL, BEL, BS, VT, FF, DEL, C1, noncharacters, and lone surrogates are stripped.
  const controls = 'step 1\rstep 2\r\nstep 3\tindented\x00\x07\x08\x0b\x0c\x1f\x7f\x85\ufdd0\ud800 🚀';
  assert.equal(sanitizeText(controls), 'step 1\nstep 2\nstep 3  indented 🚀');
  // Dashboard helpers sanitize heading, status, and check labels.
  const dirtyJob = job('dirty', {
    name: '\x1b[31mRenyi\x1b[0m\x07',
    role: 'review\x1b[2K\x08',
    activity: 'running \x1b[32mcargo test\x1b[0m\r10%',
  });
  const dirtyAcceptance: NonNullable<RadarJob['acceptance']> = {
    state: 'rejected',
    checks: [{ name: '\x1b[33mlint\x1b[0m\x07', ok: false, outputTail: '' }],
  };
  assert.equal(workerHeading(dirtyJob), 'Renyi · review');
  assert.equal(workerStatus(dirtyJob), 'Running · running cargo test 10%');
  assert.equal(workerStatus({ ...dirtyJob, status: 'succeeded', acceptance: dirtyAcceptance }), 'checks failed: lint');
  assert.equal(checksLabel(dirtyAcceptance), '✗ lint');
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff\ufdd0-\ufdef]/u.test(statusLine(dirtyJob, 1000, 50)));
});

test('a job with no recorded start shows no clock cell, never a fabricated 0s',()=>{
  const undated=job('undated',{startedAt:null,endedAt:null});
  assert.equal(statusLine(undated,1_000_000,60),oneLine(workerStatus(undated),60));
  assert.doesNotMatch(statusLine(undated,1_000_000,60),/0s/);
  // A dated job keeps its fixed-width clock cell at the end.
  assert.match(statusLine(job('timed',{startedAt:1000}),11_000,60),/Running · Read file\.ts +10s$/);
});

test('a finished row carries the evidence the writer recorded, and never a fabricated 0 files',()=>{
  const accepted:NonNullable<RadarJob['acceptance']>={state:'accepted',checks:[
    {name:'tests',ok:true,outputTail:''},{name:'lint',ok:true,outputTail:''}]};
  assert.equal(workerStatus(job('done',{status:'succeeded',endedAt:200,changedFileCount:3,acceptance:accepted})),
    'done · 3 files changed · checks ✓ 2/2');
  assert.equal(workerStatus(job('rejected',{status:'succeeded',endedAt:200,changedFileCount:2,
    acceptance:{state:'rejected',checks:[{name:'lint',ok:false,outputTail:''}]}})),'checks failed: lint · 2 files changed');
  // An absent count is not zero: the row says nothing about files.
  assert.equal(workerStatus(job('quiet',{status:'succeeded',endedAt:200})),'done');
  // A job that edits through the shell still has its digest's file count.
  const digest={phase:'editing' as const,filesRead:2,searches:0,commands:1,testRuns:0,
    edited:['a.ts'],editedCount:1,lastTestFailed:false,repeat:null};
  assert.equal(workerStatus(job('edited',{status:'succeeded',endedAt:200,progress:digest})),'done · 1 file edited');
  // A steered continuation is named, not hidden.
  assert.equal(workerStatus(job('steer',{status:'succeeded',endedAt:200,steeredFrom:'job-0',changedFileCount:1})),
    'done · 1 file changed · after steer');
  // A failure keeps its reason and adds the same evidence.
  assert.equal(workerStatus(job('broke',{status:'failed',endedAt:200,failureReason:'timeout',changedFileCount:2})),
    'failed · timed out · 2 files changed');
});

test('the /forge recap board is a multi-line factual summary of the fleet',()=>{
  assert.equal(sessionBoard([],'session',1000),'No workers in this session');
  assert.equal(sessionBoard([],'all',1000),'repository: no workers yet');

  const single=[job('run',{name:'Ada',workerId:'ada',role:'reviewer',startedAt:1000})];
  assert.equal(sessionBoard(single,'session',6000),
    ['This session · 1 running','⏺ Ada · reviewer — Running · Read file.ts · 5s'].join('\n'));

  const fleet=[
    job('run',{name:'Ada',workerId:'ada',role:'reviewer',startedAt:8000}),
    job('t1',{name:'Ada',workerId:'ada',role:'reviewer',status:'succeeded',startedAt:1000,endedAt:2000,changedFileCount:1}),
    job('done',{name:'Bo',workerId:'bo',status:'succeeded',startedAt:2000,endedAt:5000,changedFileCount:3,
      acceptance:{state:'accepted',checks:[{name:'tests',ok:true,outputTail:''},{name:'lint',ok:true,outputTail:''}]}}),
    job('boom',{name:'Cy',workerId:'cy',status:'failed',startedAt:1000,endedAt:3000,failureReason:'timeout'}),
    job('rej',{name:'Di',workerId:'di',status:'succeeded',startedAt:1000,endedAt:2000,changedFileCount:1,
      acceptance:{state:'rejected',checks:[{name:'cargo',ok:false,outputTail:''}]}}),
  ];
  assert.deepEqual(sessionBoard(fleet,'all',10_000).split('\n'),[
    'Repository · 1 running · 1 failed · 2 done',
    '⏺ Ada · reviewer · turn 2 — Running · Read file.ts · 2s',
    '✓ Bo — done · 3 files changed · checks ✓ 2/2 · 3s',
    '✗ Cy — failed · timed out · 2s',
    '✗ Di — checks failed: cargo · 1 file changed · 1s',
  ]);
  assert.equal(turnCount(fleet[0]!,fleet),2);
  assert.equal(turnCount(fleet[2]!,fleet),1);
  assert.equal(turnCount(job('lone'),fleet),1);

  const many=Array.from({length:13},(_,i)=>job(`w${i}`,{workerId:`w${i}`,status:'succeeded',startedAt:1000,endedAt:2000+i}));
  const capped=sessionBoard(many,'session',10_000).split('\n');
  assert.equal(capped.length,14); // header + 12 rows + the fold note
  assert.equal(capped.at(-1),'…and 1 more');
});

test('consecutive completed read and search calls condense; active, errored and prose rows never do',()=>{
  const tool=(sequence:number,name:string,input:string,state='done')=>({kind:'tool' as const,sequence,
    at:'2026-01-01T00:00:00Z',stepIndex:sequence,tool:name,input,output:'',state});
  const prose=(sequence:number)=>({kind:'assistant' as const,sequence,at:'2026-01-01T00:00:00Z',text:'thinking'});
  const shape=(items:ReturnType<typeof condenseTimeline>)=>
    items.map(item=>item.kind==='group'?item.key:`event-${item.event.sequence}`);

  const items=condenseTimeline([
    tool(0,'Read','a.ts'),tool(1,'Grep','{"pattern":"x"}'),tool(2,'Read','b.ts'),
    tool(3,'Edit','{"file_path":"a.ts"}'),
    tool(4,'Read','c.ts'),
  ]);
  assert.deepEqual(shape(items),['group-0','event-3','event-4']);
  const group=items[0]!;
  assert.equal(group.kind==='group'&&timelineGroupLabel(group.reads,group.searches),'read 2 files · 1 search');

  // Two is not a run, and the timeline's last event never joins one.
  assert.deepEqual(shape(condenseTimeline([tool(0,'Read','a.ts'),tool(1,'Read','b.ts')])),['event-0','event-1']);
  assert.deepEqual(shape(condenseTimeline([tool(0,'Read','a.ts'),tool(1,'Read','b.ts'),tool(2,'Read','c.ts')])),
    ['event-0','event-1','event-2']);
  // Active and errored calls break a run instead of hiding inside it.
  assert.deepEqual(shape(condenseTimeline([tool(0,'Read','a.ts'),tool(1,'Read','b.ts'),
    tool(2,'Read','c.ts','active'),tool(3,'Read','d.ts')])),['event-0','event-1','event-2','event-3']);
  // Assistant prose breaks a run too.
  assert.deepEqual(shape(condenseTimeline([tool(0,'Read','a.ts'),prose(1),tool(2,'Read','b.ts'),
    tool(3,'Read','c.ts'),tool(4,'Read','d.ts')])),['event-0','event-1','event-2','event-3','event-4']);
});
