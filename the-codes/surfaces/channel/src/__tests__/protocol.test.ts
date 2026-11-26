import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { scaled, waitFor } from '../../../../forge/testing/time.ts';

const server = process.env.SMITH_TEST_SERVER ?? fileURLToPath(new URL('../server.ts', import.meta.url));
function data(result: unknown): Record<string, any> {
  const content = (result as { content: unknown }).content as { type: string; text?: string }[];
  return JSON.parse(content[0]!.text!);
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  let last: T | undefined;
  try {
    const hit = await waitFor(async () => { last = await read(); return ready(last) ? { value: last } : null; }, { intervalMs: 30, message: 'state to settle' });
    return hit.value;
  } catch (err) {
    throw new Error(`${(err as Error).message} (last: ${JSON.stringify(last)})`);
  }
}

test('MCP delegates, resumes named workers, preserves artifacts and gates acceptance', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'smith-protocol-'));
  const fake = path.join(repo, 'fake-codex.cjs');
  writeFileSync(fake, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),prompt=args.at(-1);
const artifact=/Write your full answer to (.+?)\\. /.exec(prompt)?.[1];
if(artifact){fs.mkdirSync(path.dirname(artifact),{recursive:true});fs.writeFileSync(artifact,'FULL WORKER FINDINGS: fixture artifact preserved');}
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));
console.log(JSON.stringify({type:'item.completed',item:{id:'reason',type:'reasoning',text:'PRIVATE THINKING'}}));
console.log(JSON.stringify({type:'item.started',item:{id:'tool',type:'command_execution',command:'fixture check',status:'in_progress'}}));
console.log(JSON.stringify({type:'item.completed',item:{id:'tool',type:'command_execution',command:'fixture check',status:'completed',exit_code:0,aggregated_output:'checked'}}));
setTimeout(()=>{console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:args.includes('resume')?'Worker follow-up: addressed the edge case.':'Worker findings: the fixture passes.'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:3}}));},60);
`);
  chmodSync(fake, 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', server, repo], env: { ...env, AGENT_SMITH_CODEX_BIN: fake }, stderr: 'pipe' });
  const client = new Client({ name: 'smith-protocol-test', version: '1' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ['spawn_job', 'follow_up', 'steer', 'run_pipeline', 'pipeline_status', 'cancel']) assert.ok(names.includes(name));
    const invalid = await client.callTool({ name: 'spawn_job', arguments: { mode: 'review', prompt: 'x', effort: 'typo' } });
    assert.equal(invalid.isError, true);
    const ack = data(await client.callTool({ name: 'spawn_job', arguments: { provider: 'codex', mode: 'review', name: 'Ada', task: 'Review fixture', prompt: 'Review the fixture', model: 'fixture-model', effort: 'xhigh' } }));
    const detail = await until(async () => data(await client.callTool({ name: 'status', arguments: { id: ack.jobId, response_format: 'detailed' } })), r => r.status !== 'running');
    assert.equal(detail.status, 'succeeded'); assert.equal(detail.name, 'Ada'); assert.equal(detail.role, 'review');
    assert.equal(detail.summarySource, 'worker'); assert.match(detail.latestSummary, /Worker findings/); assert.ok(!detail.latestSummary.includes('PRIVATE THINKING'));
    assert.equal(ack.status, 'running'); assert.equal(ack.repo, repo); assert.equal('taskHandle' in ack, false);
    assert.equal(detail.taskStatus, 'completed');
    const withDiff = data(await client.callTool({ name: 'status', arguments: { id: ack.jobId, include_diff: true } }));
    assert.equal(withDiff.status, 'succeeded'); assert.equal('taskStatus' in withDiff, false);
    const detailedList = await client.callTool({ name: 'list_jobs', arguments: { response_format: 'detailed' } });
    assert.equal((detailedList.structuredContent as { items: { taskStatus: string }[] }).items[0]!.taskStatus, 'completed');
    const conciseList = await client.callTool({ name: 'list_jobs', arguments: {} });
    assert.equal((conciseList.structuredContent as { items: { status: string }[] }).items[0]!.status, 'succeeded');
    const followed = data(await client.callTool({ name: 'follow_up', arguments: { worker: 'Ada', prompt: 'Address the edge case' } }));
    assert.equal(followed.status, 'running'); assert.equal(followed.name, 'Ada'); assert.ok(['queued', 'started'].includes(followed.action), followed.action);
    const followup = await until(async () => data(await client.callTool({ name: 'status', arguments: { id: 'Ada', response_format: 'detailed' } })), r => r.jobId !== ack.jobId && r.status !== 'running');
    assert.equal(followup.workerId, detail.workerId); assert.equal(followup.name, 'Ada'); assert.equal(followup.turn, 2); assert.match(followup.report, /follow-up/);
    assert.equal(data(await client.callTool({ name: 'status', arguments: { id: ack.jobId } })).jobId, ack.jobId);
    const argv = JSON.parse(readFileSync(path.join(repo, '.agent-smith', 'jobs', followup.jobId, 'argv.json'), 'utf8')).argv;
    assert.deepEqual(argv.slice(0, 3), ['exec', 'resume', 'fixture-thread']);
    for (const exitCode of [0, 7]) {
      const run = data(await client.callTool({ name: 'run_pipeline', arguments: { spec: { name: 'fixture', stages: [{ name: 'implement', provider: 'codex', prompt: 'Write detailed findings', checks: [{ name: 'acceptance', command: `node -e 'process.exit(${exitCode})'` }] }] } } }));
      assert.equal(run.repo, repo);
      const result = await until(async () => data(await client.callTool({ name: 'pipeline_status', arguments: { runId: run.runId, response_format: 'detailed' } })), r => r.status !== 'running');
      assert.equal(result.status, exitCode === 0 ? 'passed' : 'failed', JSON.stringify(result));
      const stage = result.stageResults.implement;
      assert.equal(stage.acceptance, exitCode === 0 ? 'passed' : 'failed');
      assert.ok(stage.jobId); assert.equal(readFileSync(path.join(repo, '.agent-smith', 'pipelines', run.runId, 'artifacts', stage.resultPath), 'utf8'), 'FULL WORKER FINDINGS: fixture artifact preserved');
    }
  } finally {
    await client.close(); rmSync(repo, { recursive: true, force: true });
  }
  assert.equal(stderr.includes('Unhandled'), false, stderr);
});

test('MCP asks the user before unrestricted codex, over the wire; a decline launches nothing', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'smith-elicit-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && e[0] !== 'AGENT_SMITH_CONFIRM_UNRESTRICTED'));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', server, repo], env: { ...env, AGENT_SMITH_CONFIRM_UNRESTRICTED: '1', AGENT_SMITH_CODEX_BIN: path.join(repo, 'never-run') }, stderr: 'pipe' });
  const client = new Client({ name: 'smith-elicit-test', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  const asked: string[] = [];
  client.setRequestHandler(ElicitRequestSchema, async (request) => { asked.push(request.params.message); return { action: 'decline' }; });
  try {
    await client.connect(transport);
    const r = await client.callTool({ name: 'spawn_job', arguments: { provider: 'codex', mode: 'review', name: 'Ada', prompt: 'x', unrestricted: true } });
    assert.equal(r.isError, true);
    assert.equal((r.content as { text: string }[])[0]!.text, 'The user declined unrestricted access; rerun without unrestricted, or ask the user.');
    assert.deepEqual(asked, [`Allow codex worker "Ada" to run without approval prompts in ${repo}? It will be able to run any command.`]);
    const jobs = path.join(repo, '.agent-smith', 'jobs');
    assert.equal(existsSync(jobs) ? readdirSync(jobs).length : 0, 0, 'a declined call creates no job');
  } finally {
    await client.close(); rmSync(repo, { recursive: true, force: true });
  }
});

test('MCP reload preserves jobs, steering, cancellation, checks, reports and pipeline progression', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'smith-reload-'));
  const fake = path.join(repo, 'fake-codex.cjs');
  writeFileSync(fake, `#!${process.execPath}
const fs=require('node:fs');
const prompt=process.argv.at(-1);
if(process.argv.includes('debug'))process.exit(0);
console.log(JSON.stringify({type:'thread.started',thread_id:'reload-thread'}));
fs.appendFileSync(${JSON.stringify(path.join(repo, 'starts'))},prompt+'\\n');
const finish=()=>{console.log(JSON.stringify({type:'item.completed',item:{id:'a',type:'agent_message',text:'Reload-safe full report '+ 'x'.repeat(9000)}}));console.log(JSON.stringify({type:'turn.completed'}));};
if(prompt.includes('first turn')||prompt.includes('wait-long')){const release=${JSON.stringify(path.join(repo, 'release-first-turn'))};const end=Date.now()+120000;const t=setInterval(()=>{if(fs.existsSync(release)||Date.now()>end){clearInterval(t);finish();}},20);}
else setTimeout(finish,1800);
`);
  chmodSync(fake, 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  const sessions: Array<{ client: Client; transport: StdioClientTransport }> = [];
  const connect = async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', server, repo], env: { ...env, AGENT_SMITH_CODEX_BIN: fake }, stderr: 'pipe' });
    const client = new Client({ name: 'reload-test', version: '1' });
    transport.stderr?.on('data', () => {});
    await client.connect(transport);
    sessions.push({ client, transport });
    return { client, transport };
  };
  try {
    const first = await connect();
    const checks = [{ name: 'verified', command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('checked','yes')"` }];
    const ack = data(await first.client.callTool({ name: 'spawn_job', arguments: { mode: 'review', provider: 'codex', prompt: 'wait-long review', name: 'survivor', checks } }));
    assert.notEqual(JSON.parse(readFileSync(path.join(ack.repo, '.agent-smith', 'jobs', ack.jobId, 'job.json'), 'utf8')).ownerPid, first.transport.pid);
    process.kill(first.transport.pid!, 'SIGKILL');
    await first.client.close();
    const second = await connect();
    const call = async (name: string, args: Record<string, unknown>) => data(await second.client.callTool({ name, arguments: args }));
    const running = await call('status', { id: ack.jobId });
    assert.equal(running.status, 'running'); assert.equal(running.cancellable, undefined);
    const detailed = await until(() => call('status', { id: ack.jobId, response_format: 'detailed' }), r => r.resumable === true);
    assert.equal(detailed.cancellable, true); assert.equal(detailed.resumable, true);
    const steered = await call('steer', { worker: ack.jobId, prompt: 'Finish now' });
    assert.equal(steered.action, 'interrupting');
    const finished = await until(() => call('status', { id: ack.jobId, response_format: 'detailed' }), r => r.status === 'succeeded' && r.acceptance?.state === 'accepted');
    assert.ok(existsSync(path.join(repo, 'checked')));
    const report = await call('status', { id: finished.jobId, report_only: true });
    assert.equal(report.status, 'succeeded'); assert.equal(report.taskStatus, undefined);
    assert.ok(report.report.length > 9000); assert.equal(report.provider, undefined); assert.equal(readFileSync(report.reportPath, 'utf8'), report.report);
    const nextTurn = (name: string, after: string) => until(() => call('status', { id: name }), r => r.jobId !== after && r.status !== 'running' && r.acceptance?.pending !== true);
    await call('follow_up', { worker: finished.jobId, prompt: 'follow up' });
    const accepted = await nextTurn('survivor', finished.jobId);
    assert.equal(accepted.acceptance.state, 'accepted');
    assert.equal(accepted.acceptance.passed[0], 'verified');
    const canceled = await call('spawn_job', { mode: 'review', provider: 'codex', prompt: 'wait-long cancel', name: 'cancel-me' });
    await call('cancel', { id: canceled.jobId });
    assert.equal((await until(() => call('status', { id: canceled.jobId }), r => r.status !== 'running')).status, 'canceled');
    const queued = await call('spawn_job', { mode: 'review', provider: 'codex', prompt: 'first turn', name: 'queue-me' });
    const queuedAck = await call('follow_up', { worker: queued.jobId, prompt: 'queued continuation' });
    assert.deepEqual([queuedAck.action, queuedAck.jobId], ['queued', queued.jobId]);
    writeFileSync(path.join(repo, 'release-first-turn'), '');
    const idle = await call('status', { id: 'queue-me', wait_ms: 30_000 });
    assert.deepEqual([idle.turn, idle.stillRunning, idle.status], [2, false, 'succeeded']);
    const queuedResult = await nextTurn('queue-me', queued.jobId);
    assert.equal(queuedResult.status, 'succeeded'); assert.equal(queuedResult.turn, 2);
    const turn1 = await call('status', { id: queued.jobId, wait_ms: 1_000 });
    assert.deepEqual([turn1.jobId, turn1.status], [queued.jobId, 'succeeded']);
    const listed = await call('list_jobs', { session: true });
    assert.ok((listed.items ?? listed).some((j: any) => j.jobId === queuedResult.jobId));
    const replacement = await call('follow_up', { worker: 'survivor', prompt: 'replace checks', checks: [{ name: 'replacement', command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"` }] });
    assert.deepEqual(replacement.checks, ['replacement']);
    const replaced = await nextTurn('survivor', accepted.jobId);
    assert.equal(replaced.status, 'succeeded'); assert.deepEqual(replaced.acceptance.passed, ['replacement']);
    const cleared = await call('follow_up', { worker: 'survivor', prompt: 'clear checks', checks: [] });
    assert.equal('checks' in cleared, false);
    const unchecked = await nextTurn('survivor', replaced.jobId);
    assert.equal(unchecked.status, 'succeeded'); assert.equal(unchecked.acceptance.state, 'unchecked');
    const pipeline = await call('run_pipeline', { spec: { name: 'reload-pipeline', stages: [
      { name: 'one', provider: 'codex', prompt: 'first', checks },
      { name: 'two', provider: 'codex', prompt: 'second', dependsOn: ['one'], checks },
    ] } });
    process.kill(second.transport.pid!, 'SIGKILL');
    await second.client.close();
    const third = await connect();
    const finalRun = await until(async () => data(await third.client.callTool({ name: 'pipeline_status', arguments: { runId: pipeline.runId } })), r => r.status !== 'running');
    assert.equal(finalRun.status, 'passed');
    assert.equal(finalRun.stageResults.two.acceptance, 'passed');
  } finally {
    for (const session of sessions) await session.client.close().catch(() => {});
    rmSync(repo, { recursive: true, force: true });
  }
});

test('provider credit and HTTP errors reach status and the completion notice', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'smith-provider-errors-'));
  const fake = path.join(repo, 'fake.cjs');
  writeFileSync(fake, `#!${process.execPath}
if(process.argv.includes('debug')||process.argv.includes('models'))process.exit(0);
const event=process.argv.includes('--format')?{type:'error',error:{name:'APIError',data:{message:'HTTP 402: payment required for requested route'}}}:{type:'turn.failed',error:{message:'You are out of credits; add credits to continue.'}};
console.log(JSON.stringify(event));process.exitCode=1;
`);
  chmodSync(fake, 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', server, repo], env: { ...env, AGENT_SMITH_CODEX_BIN: fake, AGENT_SMITH_OPENCODE_BIN: fake }, stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'error-test', version: '1' });
  try {
    await client.connect(transport);
    for (const provider of ['codex', 'opencode']) {
      const ack = data(await client.callTool({ name: 'spawn_job', arguments: { provider, mode: 'review', prompt: 'review' } }));
      const detail = await until(async () => data(await client.callTool({ name: 'status', arguments: { id: ack.jobId, response_format: 'detailed' } })), d => d.status === 'failed');
      assert.match(detail.error, provider === 'codex' ? /out of credits/ : /402: payment required/);
      assert.equal(detail.reason, 'out of credits');
      assert.equal(detail.resumable, false);
      const followed = await client.callTool({ name: 'follow_up', arguments: { worker: ack.jobId, prompt: 'continue' } });
      assert.equal(followed.isError, true);
      assert.match((followed.content as Array<{ text: string }>)[0]!.text, /has no saved conversation to continue/);
      const { readJob } = await import('../watch-source.ts');
      const { buildBatch } = await import('../policy.ts');
      const observed = (await readJob(repo, ack.jobId, Date.now()))!;
      const notice = buildBatch([{ job: observed, seen: new Set(), observedInPriorPoll: true }], Date.now());
      assert.match(notice.content!, /out of credits/);
    }
  } finally { await client.close(); rmSync(repo, { recursive: true, force: true }); }
});
