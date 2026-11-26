import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATTENTION_TTL_MS, PANE_FALLBACK_COLUMNS, PANE_MIN_COLUMNS, PANE_QUIET_MS, checksLabel, commandTerminalColumns, condenseTimeline, countLine, findWorker, forgeList, groupWorkers, measurePaneTerminalColumns, needsAttention, paneWidthRequest, priorTurnSummary, recordLaunch, scopeLine, sessionBoard, sessionJobs, statusLine, timelineGroupLabel, turnCount, workerHead, workerHeading, workerLivenessLine, workerStatus, workerTurns } from '../hooks/dashboard.ts';
import { oneLine, sanitizeText } from '../hooks/format.ts';
import type { RadarJob } from '../types/index.d.ts';
const job=(id:string,extra:Partial<RadarJob>={}):RadarJob=>({id,workerId:extra.workerId??id,turn:1,status:'running',startedAt:100,endedAt:null,toolCount:1,activity:'Read file.ts',task:'Review',warnings:[],report:null,reasoning:null,raw:{},...extra});
test('the list puts running and checking work first, then settled work most recent first',()=>{
  const running=job('run',{startedAt:50});
  const pending=job('pending',{status:'succeeded',startedAt:10,endedAt:20,acceptance:{state:'unchecked',pending:true,checks:[]}});
  const older=job('older',{status:'failed',startedAt:10,endedAt:30});
  const newer=job('newer',{status:'succeeded',startedAt:5,endedAt:90});
  assert.deepEqual(forgeList([older,newer,pending,running]).map(j=>j.id),['run','pending','newer','older']);
  assert.match(workerStatus(pending),/^exited · checking$/);
  assert.equal(workerStatus(job('p2',{status:'succeeded',startedAt:10,endedAt:20,acceptance:{state:'unchecked',pending:true,running:'ui-suite',checks:[]}})),'exited · checking: ui-suite');
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
  assert.equal(checksLabel({state:'unchecked',pending:true,checks:[]}),'');
  assert.equal(checksLabel({state:'unchecked',pending:true,running:'tests',checks:[]}),'checking');
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
  assert.equal(needsAttention(oldFailed),true);
  assert.equal(needsAttention(oldFailed,old+ATTENTION_TTL_MS),true);
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
  assert.equal(countLine([job('r1',{workerId:'ada',status:'succeeded',endedAt:1}),job('r2',{workerId:'ada',startedAt:200})]),'1 running');
});

test('a denial, and an old job with only the long error, read as the same short reason',()=>{
  const long='worker soft-denied 1 tool action(s) (view_file) — it exited 0 and reported success while doing nothing.';
  assert.equal(workerStatus(job('d',{status:'failed',failureReason:long})),'failed · denied view_file');
  assert.equal(workerStatus(job('s',{status:'succeeded',acceptance:{state:'rejected',checks:[{name:'lint',ok:false,outputTail:''}]}})),'checks failed: lint');
  assert.equal(workerStatus(job('t',{status:'attention'})),'no output');
  assert.equal(workerStatus(job('t',{status:'attention',liveness:{state:'silent',silentForMs:16*60_000,since:0,forMs:16*60_000}})),'no output 16m');
  assert.equal(workerStatus(job('t',{status:'attention',liveness:{state:'dead',silentForMs:16*60_000,since:0,forMs:3*60_000}})),'process gone 3m');
  assert.equal(workerStatus(job('t',{status:'running',activity:'running tests',liveness:{state:'in-tool',silentForMs:16*60_000,since:0,forMs:16*60_000,tool:'cargo test'}})),'Running · in `cargo test` 16m');
  assert.equal(workerStatus(job('t',{status:'running',activity:'running tests',liveness:{state:'in-tool',silentForMs:5_000,since:0,forMs:5_000,tool:'cargo test'}})),'Running · running tests');
});

test('measurePaneTerminalColumns reconstructs terminal width from docked pane geometry and leaves fullscreen/non-docked viewports intact', () => {
  assert.equal(measurePaneTerminalColumns({ columns: 119 }, { bodyColumns: 60, placement: 'dock' }), 180);
  assert.equal( paneWidthRequest(measurePaneTerminalColumns({ columns: 119 }, { bodyColumns: 60, placement: 'dock' }) ?? null), 60);
  assert.equal(measurePaneTerminalColumns({ columns: 104 }, { bodyColumns: 75, placement: 'dock' }), 180);
  assert.equal(measurePaneTerminalColumns({ columns: 180 }, { bodyColumns: 180, placement: 'fullscreen' }), 180);
  assert.equal(measurePaneTerminalColumns({ columns: 150 }, { bodyColumns: 50 }), 150);
  assert.equal(measurePaneTerminalColumns(undefined, { bodyColumns: 60, placement: 'dock' }), undefined);
  assert.equal(measurePaneTerminalColumns({ columns: 119 }, { bodyColumns: 0, placement: 'dock' }), undefined);
  assert.equal(paneWidthRequest(null), PANE_FALLBACK_COLUMNS);
  assert.equal(paneWidthRequest(60), PANE_MIN_COLUMNS);
});

test('commandTerminalColumns reads the terminal width the host stamps on a command event', () => {
  assert.equal(commandTerminalColumns({ isFullscreen: true, columns: 180 }), 180);
  assert.equal(commandTerminalColumns({ columns: 144.7 }), 144);
  assert.equal(commandTerminalColumns({ columns: 0 }), undefined);
  assert.equal(commandTerminalColumns({ columns: '180' }), undefined);
  assert.equal(commandTerminalColumns(undefined), undefined);
  assert.equal(commandTerminalColumns(null), undefined);
});

test('sanitizeText strips ANSI sequences and forbidden controls while preserving newlines and valid astral characters', () => {
  const ansi = '\x1b[38;5;196mred\x1b[0m \x1b]8;;https://example.com\x07link\x1b]8;;\x1b\\ \x1bP1$r0m\x1b\\ \x9b32mgreen\x9b0m';
  assert.equal(sanitizeText(ansi), 'red link  green');
  const controls = 'step 1\rstep 2\r\nstep 3\tindented\x00\x07\x08\x0b\x0c\x1f\x7f\x85\ufdd0\ud800 🚀';
  assert.equal(sanitizeText(controls), 'step 1\nstep 2\nstep 3  indented 🚀');
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
  assert.match(statusLine(job('timed',{startedAt:1000}),11_000,60),/Running · Read file\.ts +10s$/);
});

test('a finished row carries the evidence the writer recorded, and never a fabricated 0 files',()=>{
  const accepted:NonNullable<RadarJob['acceptance']>={state:'accepted',checks:[
    {name:'tests',ok:true,outputTail:''},{name:'lint',ok:true,outputTail:''}]};
  assert.equal(workerStatus(job('done',{status:'succeeded',endedAt:200,changedFileCount:3,acceptance:accepted})),
    'done · 3 files changed · checks ✓ 2/2');
  assert.equal(workerStatus(job('rejected',{status:'succeeded',endedAt:200,changedFileCount:2,
    acceptance:{state:'rejected',checks:[{name:'lint',ok:false,outputTail:''}]}})),'checks failed: lint · 2 files changed');
  assert.equal(workerStatus(job('quiet',{status:'succeeded',endedAt:200})),'done');
  const digest={phase:'editing' as const,filesRead:2,searches:0,commands:1,testRuns:0,
    edited:['a.ts'],editedCount:1,lastTestFailed:false,repeat:null};
  assert.equal(workerStatus(job('edited',{status:'succeeded',endedAt:200,progress:digest})),'done · 1 file edited');
  assert.equal(workerStatus(job('steer',{status:'succeeded',endedAt:200,turn:2,continuedFrom:'job-0',continuationKind:'steer',changedFileCount:1})),
    'done · 1 file changed · steered');
  assert.equal(workerStatus(job('resumed',{status:'succeeded',endedAt:200,turn:2,continuedFrom:'job-0',continuationKind:'follow-up',changedFileCount:1})),
    'done · 1 file changed · follow-up');
  assert.equal(workerStatus(job('superseded',{status:'canceled',endedAt:200,supersededBy:'job-2'})),'steered');
  assert.equal(workerStatus(job('queued',{status:'running',pendingSteers:1,activity:'editing a.ts'})),'Running · 1 queued · editing a.ts');
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
  assert.equal(capped.length,14);
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

  assert.deepEqual(shape(condenseTimeline([tool(0,'Read','a.ts'),tool(1,'Read','b.ts')])),['event-0','event-1']);
  assert.deepEqual(shape(condenseTimeline([tool(0,'Read','a.ts'),tool(1,'Read','b.ts'),tool(2,'Read','c.ts')])),
    ['event-0','event-1','event-2']);
  assert.deepEqual(shape(condenseTimeline([tool(0,'Read','a.ts'),tool(1,'Read','b.ts'),
    tool(2,'Read','c.ts','active'),tool(3,'Read','d.ts')])),['event-0','event-1','event-2','event-3']);
  assert.deepEqual(shape(condenseTimeline([tool(0,'Read','a.ts'),prose(1),tool(2,'Read','b.ts'),
    tool(3,'Read','c.ts'),tool(4,'Read','d.ts')])),['event-0','event-1','event-2','event-3','event-4']);
  const shell=condenseTimeline([tool(0,"/bin/zsh -lc 'git status'",''),tool(1,"/bin/zsh -lc 'node --version'",''),
    tool(2,"/bin/zsh -lc 'cat a.ts'",''),tool(3,'Bash','{"command":"npm test"}'),tool(4,'Read','e.ts')]);
  assert.deepEqual(shape(shell),['group-0','event-3','event-4']);
  const run=shell[0]!;
  assert.equal(run.kind==='group'&&timelineGroupLabel(run.reads,run.searches,run.commands),'read 1 file · 2 commands');
});

test('a settled row says when it started; a live row does not',()=>{
  const t=new Date(2026,0,5,14,5).getTime();
  const done=job('d',{status:'succeeded',startedAt:t,endedAt:t+90_000,acceptance:{state:'accepted',checks:[]}});
  assert.match(statusLine(done,t+120_000,80),/^done · started 14:05 +1m30s$/);
  assert.match(statusLine(job('f',{status:'failed',startedAt:t,endedAt:t+5_000}),t+9_000,80),/^failed · started 14:05 +5s$/);
  assert.doesNotMatch(statusLine(job('r',{startedAt:t}),t+10_000,60),/started/);
});

test('workerLivenessLine drives the pane callout strictly from job.liveness with no legacy fallback', () => {
  const now = 1_000_000;
  assert.equal(workerLivenessLine(job('a1', { liveness: { state: 'active', silentForMs: PANE_QUIET_MS - 1, since: now - PANE_QUIET_MS + 1, forMs: PANE_QUIET_MS - 1 } })), null);
  assert.deepEqual(workerLivenessLine(job('a2', { liveness: { state: 'active', silentForMs: PANE_QUIET_MS, since: now - PANE_QUIET_MS, forMs: PANE_QUIET_MS } })),
    { text: 'No output 2m00s · process alive', tone: 'dim' });
  assert.deepEqual(workerLivenessLine(job('a3', { liveness: { state: 'active', silentForMs: 130_000, since: now - 130_000, forMs: 130_000 } })),
    { text: 'No output 2m10s · process alive', tone: 'dim' });
  assert.equal(workerLivenessLine(job('t1', { liveness: { state: 'in-tool', silentForMs: 16 * 60_000, since: now - 16 * 60_000, forMs: 16 * 60_000, tool: 'cargo test' } })), null);
  assert.deepEqual(workerLivenessLine(job('s1', { status: 'attention', liveness: { state: 'silent', silentForMs: 16 * 60_000, since: now - 16 * 60_000, forMs: 16 * 60_000 } })),
    { text: 'No output 16m00s', tone: 'yellow' });
  assert.deepEqual(workerLivenessLine(job('d1', { status: 'attention', liveness: { state: 'dead', silentForMs: 18 * 60_000, since: now - 3 * 60_000, forMs: 3 * 60_000 } })),
    { text: 'Worker process gone 3m00s', tone: 'red' });
  assert.equal(workerLivenessLine(job('o2', { lastEventAt: now - PANE_QUIET_MS - 1_000 })), null);
  assert.equal(workerLivenessLine(job('done', { status: 'succeeded', endedAt: now - 1_000, lastEventAt: now - 10 * 60_000 })), null);
});

test('priorTurnSummary formats inline clickable turns with message, verdict or status, and duration without tool count', () => {
  const steeredParent = job('t1', {
    workerId: 'ada', turn: 1, status: 'canceled', supersededBy: 't2',
    startedAt: 0, endedAt: 72_000, toolCount: 14, task: 'Refactor the links engine',
  });
  assert.equal(priorTurnSummary(steeredParent, 1, 100_000), '▸ 1  Refactor the links engine · steered · 1m12s');

  const checkedParent = job('t1-chk', {
    workerId: 'ada', turn: 1, status: 'succeeded',
    startedAt: 0, endedAt: 5_160_000, toolCount: 614, task: 'Refactor the links engine',
    acceptance: { state: 'accepted', checks: [{ name: 'a', ok: true, outputTail: '' }, { name: 'b', ok: true, outputTail: '' }] },
  });
  assert.equal(priorTurnSummary(checkedParent, 1, 6_000_000), '▸ 1  Refactor the links engine · checks ✓ 2/2 · 1h26m');

  const failedCheckParent = job('t2-chk', {
    workerId: 'ada', turn: 2, status: 'succeeded',
    startedAt: 0, endedAt: 283_000, toolCount: 41,
    prompt: 'Your previous turn completed.\n\nFix the review findings',
    messages: [{ sender: 'follow_up', text: 'Fix the review findings' }],
    acceptance: { state: 'rejected', checks: [{ name: 'lint', ok: false, outputTail: '' }] },
  });
  assert.equal(priorTurnSummary(failedCheckParent, 2, 300_000), '▸ 2  Fix the review findings · ✗ lint · 4m43s');

  const openTurn = job('t3', {
    workerId: 'ada', turn: 3, status: 'running',
    prompt: 'Your previous turn completed.\n\nAfter you finish the 19 test failures, do the decided fix list',
    messages: [{ sender: 'follow_up', text: 'After you finish the 19 test failures, do the decided fix list' }],
  });
  assert.equal(priorTurnSummary(openTurn, 3, 100_000, { open: true }), '▾ 3  After you finish the 19 test failures, do the decided fix list');

  const failedParent = job('t1-fail', {
    workerId: 'ada', turn: 1, status: 'failed', failureReason: 'timeout',
    startedAt: 0, endedAt: 30_000, toolCount: null, task: 'Run tests',
  });
  assert.equal(priorTurnSummary(failedParent, 1, 100_000), '▸ 1  Run tests · failed · timed out · 30s');
});

test('workerTurns, workerHead, statusLine and sessionJobs unify steered and resumed turns', () => {
  const t1 = job('t1', { workerId: 'ada', turn: 1, status: 'canceled', supersededBy: 't2', startedAt: 0, endedAt: 60_000, chainStartedAt: 0 });
  const t2 = job('t2', { workerId: 'ada', turn: 2, status: 'running', continuedFrom: 't1', continuationKind: 'steer', startedAt: 60_000, chainStartedAt: 0 });
  assert.deepEqual(workerTurns([t2, t1], 'ada').map((j) => j.id), ['t1', 't2']);
  assert.equal(workerHead([t1, t2], 'ada')?.id, 't2');
  assert.match(statusLine(t2, 72_000, 60), /1m12s$/);
  const t3 = job('t3', { workerId: 'ada', turn: 3, status: 'running', continuedFrom: 't2', continuationKind: 'follow-up', startedAt: 200_000, chainStartedAt: 200_000 });
  const mine = sessionJobs([t1, t2, t3, job('other')], { jobs: ['t1'], runs: [] });
  assert.deepEqual(mine.map((j) => j.id), ['t1', 't2', 't3']);
});
