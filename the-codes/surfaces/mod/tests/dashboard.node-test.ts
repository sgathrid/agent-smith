import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rosterJobs, groupWorkers, workerStatus, rosterSummary, scopedJobKey, belongsToRepo } from '../hooks/dashboard.ts';
import type { RadarJob } from '../types/index.d.ts';
const job=(id:string,extra:Partial<RadarJob>={}):RadarJob=>({id,status:'running',startedAt:100,endedAt:null,toolCount:1,activity:'Read file.ts',task:'Review',warnings:[],report:null,reasoning:null,raw:{},...extra});
test('pending checks and rejected work remain active; settled success moves to history',()=>{
  const running=job('run');
  const pending=job('pending',{status:'succeeded',acceptance:{state:'unchecked',pending:true,checks:[]}});
  const rejected=job('reject',{status:'succeeded',acceptance:{state:'rejected',checks:[]}});
  const done=job('done',{status:'succeeded'});
  assert.deepEqual(rosterJobs([running,pending,rejected,done],'active',[]).map(j=>j.id),['reject','pending','run']);
  assert.deepEqual(rosterJobs([running,pending,rejected,done],'history',[]).map(j=>j.id),['done']);
  assert.equal(rosterJobs([pending],'active',['pending']).length,1);
  assert.match(workerStatus(pending),/Execution complete · checks pending/);
});
test('only real worker identities group runs; live runs win over older failures',()=>{
  const earlier=job('old',{workerId:'ada',status:'failed',startedAt:200});
  const live=job('new',{workerId:'ada',startedAt:100});
  const unrelated=job('other',{name:'Ada'});
  assert.deepEqual(groupWorkers([earlier,live,unrelated]).map(j=>j.id),['new','other']);
});

test('attention count follows the visible Active worker representatives',()=>{
  const failed=job('old',{workerId:'ada',status:'failed',failureReason:'orphaned',startedAt:100});
  const live=job('live',{workerId:'ada',status:'running',startedAt:200});
  const done=job('done',{workerId:'ada',status:'succeeded',startedAt:200});
  assert.doesNotMatch(rosterSummary([failed,live]),/need attention/);
  assert.match(rosterSummary([failed,done]),/1 need attention/);
  assert.deepEqual(rosterJobs([live],'history',['live']).map(j=>j.id),[]);
});

test('acknowledged failures leave attention and remain available in History by repo and job',()=>{
  const failed=job('job-a',{status:'failed',startedAt:200,failureReason:'orphaned'});
  const running=job('run');
  const pending=job('pending',{status:'succeeded',acceptance:{state:'unchecked',pending:true,checks:[]}});
  const ack=[scopedJobKey('/repo-a','job-a')];
  assert.deepEqual(rosterJobs([failed,running,pending],'active',[],ack,'/repo-a').map(j=>j.id).sort(),['pending','run']);
  assert.deepEqual(rosterJobs([failed],'active',[],[scopedJobKey('/repo-b','job-a')],'/repo-a').map(j=>j.id),['job-a']);
  assert.deepEqual(rosterJobs([failed,running,pending],'history',[],ack,'/repo-a').map(j=>j.id),['job-a']);
  assert.doesNotMatch(rosterSummary([failed],ack,'/repo-a'),/need attention/);
  assert.equal(scopedJobKey('/repo-a','job-a')===scopedJobKey('/repo-b','job-a'),false);
  assert.equal(belongsToRepo(scopedJobKey('/repo-a','job-a'),'/repo-a'),true);
  assert.equal(belongsToRepo(scopedJobKey('/repo-a','job-a'),'/repo-b'),false);
});

test('failed rows show their failure reason and do not show unchecked when no checks ran',()=>{
  assert.equal(workerStatus(job('orphan',{status:'failed',failureReason:'orphaned',acceptance:{state:'unchecked',checks:[]}})),'failed · orphaned');
  assert.equal(workerStatus(job('failed',{status:'failed',acceptance:{state:'unchecked',checks:[]}})),'failed');
  assert.equal(workerStatus(job('checked',{status:'failed',failureReason:'timeout',acceptance:{state:'rejected',checks:[{name:'tests',ok:false,outputTail:''}]}})),'failed · timeout');
});
