import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rosterJobs, groupWorkers, workerStatus } from '../hooks/dashboard.ts';
import type { RadarJob } from '../types/index.d.ts';
const job=(id:string,extra:Partial<RadarJob>={}):RadarJob=>({id,status:'running',startedAt:100,endedAt:null,toolCount:1,activity:'Read file.ts',task:'Review',warnings:[],report:null,reasoning:null,raw:{},...extra});
test('pending checks and rejected work remain active; settled success moves to history',()=>{
  const running=job('run');
  const pending=job('pending',{status:'succeeded',acceptance:{state:'unchecked',pending:true,checks:[]}});
  const rejected=job('reject',{status:'succeeded',acceptance:{state:'rejected',checks:[]}});
  const done=job('done',{status:'succeeded'});
  assert.deepEqual(rosterJobs([running,pending,rejected,done],'active',[]).map(j=>j.id),['reject','pending','run']);
  assert.deepEqual(rosterJobs([running,pending,rejected,done],'history',[]).map(j=>j.id),['reject','done']);
  assert.equal(rosterJobs([pending],'active',['pending']).length,1);
  assert.match(workerStatus(pending),/Execution complete · checks pending/);
});
test('only real worker identities group runs; live runs win over older failures',()=>{
  const earlier=job('old',{workerId:'ada',status:'failed',startedAt:200});
  const live=job('new',{workerId:'ada',startedAt:100});
  const unrelated=job('other',{name:'Ada'});
  assert.deepEqual(groupWorkers([earlier,live,unrelated]).map(j=>j.id),['new','other']);
});
