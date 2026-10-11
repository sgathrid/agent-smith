import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const server = process.env.SMITH_TEST_SERVER ?? fileURLToPath(new URL('../server.ts', import.meta.url));
function data(result: unknown): Record<string, any> {
  const content = (result as { content: unknown }).content as { type: string; text?: string }[];
  return JSON.parse(content[0]!.text!);
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read(); if (ready(value)) return value;
    if (Date.now() > deadline) throw new Error(`state did not settle: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 30));
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
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', server], env: { ...env, AGY_WATCH_CWD: repo, AGENT_SMITH_CODEX_BIN: fake }, stderr: 'pipe' });
  const client = new Client({ name: 'smith-protocol-test', version: '1' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const name of ['spawn_job', 'resume_job', 'run_pipeline', 'pipeline_status', 'cancel']) assert.ok(names.includes(name));
    const invalid = await client.callTool({ name: 'spawn_job', arguments: { mode: 'review', prompt: 'x', effort: 'typo' } });
    assert.equal(invalid.isError, true);
    const ack = data(await client.callTool({ name: 'spawn_job', arguments: { provider: 'codex', mode: 'review', name: 'Ada', task: 'Review fixture', prompt: 'Review the fixture', model: 'fixture-model', effort: 'xhigh' } }));
    const detail = await until(async () => data(await client.callTool({ name: 'status', arguments: { jobId: ack.jobId, response_format: 'detailed' } })), r => r.status !== 'running');
    assert.equal(detail.status, 'succeeded'); assert.equal(detail.name, 'Ada'); assert.equal(detail.role, 'review');
    assert.equal(detail.summarySource, 'worker'); assert.match(detail.latestSummary, /Worker findings/); assert.ok(!detail.latestSummary.includes('PRIVATE THINKING'));
    const resumed = data(await client.callTool({ name: 'resume_job', arguments: { worker: 'Ada', prompt: 'Address the edge case' } }));
    const followup = await until(async () => data(await client.callTool({ name: 'status', arguments: { jobId: resumed.jobId, response_format: 'detailed' } })), r => r.status !== 'running');
    assert.equal(followup.workerId, detail.workerId); assert.equal(followup.name, 'Ada'); assert.match(followup.report, /follow-up/);
    const argv = JSON.parse(readFileSync(path.join(repo, '.agent-smith', 'jobs', resumed.jobId, 'argv.json'), 'utf8')).argv;
    assert.deepEqual(argv.slice(0, 3), ['exec', 'resume', 'fixture-thread']);
    for (const exitCode of [0, 7]) {
      const run = data(await client.callTool({ name: 'run_pipeline', arguments: { spec: { name: 'fixture', stages: [{ name: 'implement', provider: 'codex', prompt: 'Write detailed findings', checks: [{ name: 'acceptance', command: `node -e 'process.exit(${exitCode})'` }] }] } } }));
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
