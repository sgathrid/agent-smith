import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATTENTION_TTL_MS, checksLabel, findWorker, forgeList, groupWorkers, needsAttention, workerStatus } from '../hooks/dashboard.ts';
import type { RadarJob } from '../types/index.d.ts';
const job=(id:string,extra:Partial<RadarJob>={}):RadarJob=>({id,status:'running',startedAt:100,endedAt:null,toolCount:1,activity:'Read file.ts',task:'Review',warnings:[],report:null,reasoning:null,raw:{},...extra});
test('the list puts running and checking work first, then settled work most recent first',()=>{
  const running=job('run',{startedAt:50});
  const pending=job('pending',{status:'succeeded',startedAt:10,endedAt:20,acceptance:{state:'unchecked',pending:true,checks:[]}});
  const older=job('older',{status:'failed',startedAt:10,endedAt:30});
  const newer=job('newer',{status:'succeeded',startedAt:5,endedAt:90});
  assert.deepEqual(forgeList([older,newer,pending,running]).map(j=>j.id),['run','pending','newer','older']);
  assert.match(workerStatus(pending),/Execution complete · checks pending/);
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
  assert.equal(workerStatus(job('orphan',{status:'failed',failureReason:'orphaned',acceptance:{state:'unchecked',checks:[]}})),'failed · orphaned');
  assert.equal(workerStatus(job('failed',{status:'failed',acceptance:{state:'unchecked',checks:[]}})),'failed');
  assert.equal(workerStatus(job('checked',{status:'failed',failureReason:'timeout',acceptance:{state:'rejected',checks:[{name:'tests',ok:false,outputTail:''}]}})),'failed · timeout');
});
test('acceptance reads as a pass count or the failing check names',()=>{
  assert.equal(checksLabel(undefined),'');
  assert.equal(checksLabel({state:'unchecked',pending:true,checks:[]}),'checks pending');
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
  assert.equal(workerStatus(oldFailed),'failed · orphaned');
});
