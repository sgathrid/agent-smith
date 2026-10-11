#!/usr/bin/env node
// Isolated MCP stdio smoke runner. All job and provider state lives in one
// temporary tree; no command here targets the caller's working repository.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { buildSmokeServerEnv } from './testing/smoke-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const live = process.argv.includes('--live');
const providerFlag = process.argv.find((arg) => arg.startsWith('--providers='))?.slice('--providers='.length);
const requestedProviders = providerFlag === undefined ? undefined : providerFlag.split(',').map((name) => name.trim()).filter(Boolean);
const scratch = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-smoke-'));
const repo = path.join(scratch, 'work-repo');
const state = path.join(scratch, 'provider-state');
mkdirSync(repo); mkdirSync(state);
const summary = { mode: live ? 'live' : 'fake', scratch, cleanup: 'pending', scenarios: [] };
const record = async (name, run) => {
  const item = { name, status: 'pass' };
  if (live) process.stderr.write(`[smoke] starting: ${name}\n`);
  try { item.detail = await run(); }
  catch (error) { item.status = 'fail'; item.error = String(error?.stack ?? error); }
  summary.scenarios.push(item);
  if (live) process.stderr.write(`[smoke] ${item.status}: ${name}\n`);
  return item.status === 'pass';
};

let client;
try {
  const channelRoot = path.join(root, 'the-codes/surfaces/channel');
  const require = createRequire(path.join(channelRoot, 'package.json'));
  const sdkCjs = require.resolve('@modelcontextprotocol/sdk/client/index.js');
  const sdkEsm = sdkCjs.replace(`${path.sep}dist${path.sep}cjs${path.sep}`, `${path.sep}dist${path.sep}esm${path.sep}`);
  const { Client } = await import(pathToFileURL(sdkEsm));
  const { StdioClientTransport } = await import(pathToFileURL(sdkEsm.replace(`${path.sep}client${path.sep}index.js`, `${path.sep}client${path.sep}stdio.js`)));
  const server = path.join(channelRoot, 'src/server.ts');
  const fakeCodex = path.join(scratch, 'fake-codex.cjs');
  const fakeAgy = path.join(scratch, 'fake-agy.cjs');
  writeFileSync(fakeCodex, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2),p=a.at(-1)||'';\nconst emit=()=>{const f=/Write your full answer to (.+?)\\. /.exec(p)?.[1];if(f){if(!fs.statSync(path.dirname(f)).isDirectory())process.exit(22);fs.writeFileSync(f,'FAKE IMPLEMENTATION ARTIFACT\\n');}if(p.includes('Review the implementation artifact')&&!p.includes('FAKE IMPLEMENTATION ARTIFACT'))process.exit(21);console.log(JSON.stringify({type:'thread.started',thread_id:'smoke-thread'}));console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'Fake provider review: smoke passed.'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:8,output_tokens:4}}));};const delay=p.includes('SMOKE_SLOW')?12000:p.includes('SMOKE_CONCURRENT')?180:0;if(delay)setTimeout(emit,delay);else emit();\n`);
  writeFileSync(fakeAgy, `#!${process.execPath}\nconst a=process.argv.slice(2),p=a.find(x=>x.includes('Write your full answer to'))||'';const m=/Write your full answer to (.+?)\\. /.exec(p);if(m){const fs=require('node:fs'),path=require('node:path');if(!fs.statSync(path.dirname(m[1])).isDirectory())process.exit(22);fs.writeFileSync(m[1],'FAKE IMPLEMENTATION ARTIFACT\\n');}\nconst emit=()=>{console.log(JSON.stringify({event:'init',init:{model:'smoke-fixture',conversation_id:'smoke-agy'}}));console.log(JSON.stringify({event:'step_update',step_index:1,state:'DONE',step_type:'agent_response',text:'Fake implementation complete.'}));console.log(JSON.stringify({event:'result',result:{conversation_id:'smoke-agy',status:'SUCCESS',response:'Fake implementation complete.',usage:{input_tokens:8,output_tokens:4}}}));};if(p.includes('SMOKE_CONCURRENT'))setTimeout(emit,180);else emit();\n`);
  chmodSync(fakeCodex, 0o755); chmodSync(fakeAgy, 0o755);
  let stderr = '';
  const openClient = async (name, env) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', server], env, stderr: 'pipe' });
    transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const next = new Client({ name, version: '1' });
    await next.connect(transport);
    return next;
  };
  const fakeEnv = buildSmokeServerEnv(process.env, { repo, stateDir: state });
  fakeEnv.AGENT_SMITH_CODEX_BIN = fakeCodex;
  fakeEnv.AGENT_SMITH_AGY_BIN = fakeAgy;
  client = await openClient('agent-smith-smoke-fake', fakeEnv);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  const required = ['spawn_job', 'resume_job', 'run_pipeline', 'pipeline_status', 'cancel', 'list_capabilities'];
  await record('MCP stdio tool discovery', async () => {
    for (const name of required) if (!tools.includes(name)) throw new Error(`Missing MCP tool ${name}`);
    return { tools: required };
  });
  const data = async (result) => {
    const block = result.content?.find((part) => part.type === 'text');
    if (!block) throw new Error('MCP response contained no text');
    const parsed = JSON.parse(block.text);
    if (result.isError) throw new Error(JSON.stringify(parsed));
    return parsed;
  };
  const waitStatus = async (tool, key, id, timeoutMs = 20_000, progressLabel) => {
    const end = Date.now() + timeoutMs;
    let progressAt = Date.now() + 10_000;
    while (Date.now() < end) {
      const value = await data(await client.callTool({ name: tool, arguments: { [key]: id, response_format: 'detailed' } }));
      if (value.status !== 'running') return value;
      if (progressLabel && Date.now() >= progressAt) {
        process.stderr.write(`[smoke] still waiting: ${progressLabel}\n`);
        progressAt = Date.now() + 10_000;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`${tool} timed out for ${id}`);
  };
  const solo = await record('solo review and named resume', async () => {
    const ack = await data(await client.callTool({ name: 'spawn_job', arguments: { provider: 'codex', mode: 'review', name: 'Smoke Reviewer', task: 'Review the smoke fixture', prompt: 'Review the fixture', model: 'smoke-fixture', effort: 'low', cwd: repo } }));
    const finished = await waitStatus('status', 'jobId', ack.jobId);
    if (finished.status !== 'succeeded') throw new Error(`Review ended ${finished.status}`);
    const resumed = await data(await client.callTool({ name: 'resume_job', arguments: { worker: 'Smoke Reviewer', prompt: 'Check the same fixture again' } }));
    const continued = await waitStatus('status', 'jobId', resumed.jobId);
    if (continued.status !== 'succeeded' || continued.workerId !== finished.workerId) throw new Error('Named resume did not preserve worker identity');
    const argv = JSON.parse(readFileSync(path.join(repo, '.agent-smith', 'jobs', resumed.jobId, 'argv.json'), 'utf8')).argv;
    if (!Array.isArray(argv) || argv[0] !== 'exec' || argv[1] !== 'resume' || !argv[2]) throw new Error('Resume did not reuse its recorded conversation handle');
    return { review: finished.status, resume: continued.status, workerId: finished.workerId, conversation: argv[2] };
  });
  const pipeline = await record('cross-provider implement to review with executable check', async () => {
    const result = await data(await client.callTool({ name: 'run_pipeline', arguments: { spec: { name: 'smoke pipeline', workDir: repo, stages: [
      { name: 'implement', provider: 'agy', prompt: 'Implement the fixture and write the requested artifact', model: 'smoke-fixture', resultPath: 'implementation.md', checks: [{ name: 'executable-check', command: 'node -e "process.exit(0)"', blocking: true }] },
      { name: 'review', provider: 'codex', prompt: 'Review the implementation artifact', model: 'smoke-fixture', dependsOn: ['implement'], consumes: [{ stage: 'implement', path: 'implementation.md', label: 'implementation' }] },
    ] } } }));
    const done = await waitStatus('pipeline_status', 'runId', result.runId, 30_000);
    if (done.status !== 'passed') throw new Error(`Pipeline ended ${done.status}: ${JSON.stringify(done.stageResults)}`);
    const reviewJob = Object.values(done.stageResults ?? {}).find((stage) => stage.stage === 'review')?.jobId;
    const reviewArgv = reviewJob && JSON.parse(readFileSync(path.join(repo, '.agent-smith', 'jobs', reviewJob, 'argv.json'), 'utf8')).argv;
    if (!reviewArgv?.at(-1)?.includes('FAKE IMPLEMENTATION ARTIFACT')) throw new Error('Downstream stage prompt omitted upstream artifact contents');
    return { status: done.status, stages: Object.keys(done.stageResults ?? {}), artifactForwarded: true };
  });
  await record('implement, review, then the implementer fixes from the review', async () => {
    const result = await data(await client.callTool({ name: 'run_pipeline', arguments: { spec: { name: 'smoke fix loop', workDir: repo, stages: [
      { name: 'build', provider: 'agy', prompt: 'Implement the fixture and write the requested artifact', model: 'smoke-fixture' },
      { name: 'review', provider: 'codex', prompt: 'Review the build', model: 'smoke-fixture', dependsOn: ['build'] },
      { name: 'fix', continues: 'build', prompt: 'Fix what the review found', model: 'smoke-fixture', dependsOn: ['review'], checks: [{ name: 'executable-check', command: 'node -e "process.exit(0)"', blocking: true }] },
    ] } } }));
    const done = await waitStatus('pipeline_status', 'runId', result.runId, 30_000);
    if (done.status !== 'passed') throw new Error(`Fix loop ended ${done.status}: ${JSON.stringify(done.stageResults)}`);
    const jobOf = (name) => Object.values(done.stageResults ?? {}).find((stage) => stage.stage === name)?.jobId;
    const argvOf = (name) => JSON.parse(readFileSync(path.join(repo, '.agent-smith', 'jobs', jobOf(name), 'argv.json'), 'utf8')).argv;
    const fixArgv = argvOf('fix');
    if (fixArgv[fixArgv.indexOf('--conversation') + 1] !== 'smoke-agy') throw new Error('Fix stage did not resume the build conversation');
    if (!fixArgv.some((arg) => arg.includes('--- from stage \'review\'') && arg.includes('FAKE IMPLEMENTATION ARTIFACT'))) throw new Error('Fix stage prompt omitted the review artifact');
    const workers = new Set(['build', 'fix'].map((name) => JSON.parse(readFileSync(path.join(repo, '.agent-smith', 'jobs', jobOf(name), 'view.json'), 'utf8')).workerId));
    if (workers.size !== 1) throw new Error('Fix stage did not keep the build worker identity');
    return { status: done.status, resumedConversation: 'smoke-agy', workerShared: true };
  });
  await record('cancellation', async () => {
    const ack = await data(await client.callTool({ name: 'spawn_job', arguments: { provider: 'codex', mode: 'review', name: 'Smoke Cancel', task: 'Cancel fixture', prompt: 'SMOKE_SLOW cancellation fixture', model: 'smoke-fixture', effort: 'low', cwd: repo } }));
    const cancellation = await data(await client.callTool({ name: 'cancel', arguments: { jobId: ack.jobId } }));
    const terminal = await waitStatus('status', 'jobId', ack.jobId);
    if (!cancellation.requested || terminal.status !== 'canceled') throw new Error(`Cancellation ended ${terminal.status}`);
    return { requested: cancellation.requested, status: terminal.status };
  });
  await record('timeout', async () => {
    const ack = await data(await client.callTool({ name: 'spawn_job', arguments: { provider: 'codex', mode: 'review', name: 'Smoke Timeout', task: 'Timeout fixture', prompt: 'SMOKE_SLOW timeout fixture', model: 'smoke-fixture', effort: 'low', timeoutMs: 1_000, cwd: repo } }));
    const terminal = await waitStatus('status', 'jobId', ack.jobId, 8_000);
    if (terminal.status !== 'failed' || !/timeout/i.test(terminal.error ?? '')) throw new Error(`Timeout did not surface as timeout failure: ${JSON.stringify(terminal)}`);
    return { status: terminal.status, reason: 'timeout' };
  });
  await record('concurrency limit', async () => {
    const run = async (name, concurrency) => {
      const started = await data(await client.callTool({ name: 'run_pipeline', arguments: { spec: { name, workDir: repo, concurrency, stages: [
        { name: 'agy-worker', provider: 'agy', prompt: 'SMOKE_CONCURRENT independent fixture A', model: 'smoke-fixture' },
        { name: 'codex-worker', provider: 'codex', prompt: 'SMOKE_CONCURRENT independent fixture B', model: 'smoke-fixture' },
      ] } } }));
      return waitStatus('pipeline_status', 'runId', started.runId, 30_000);
    };
    const parallel = await run('smoke concurrency two', 2);
    const serial = await run('smoke concurrency one', 1);
    const intervals = (run) => Object.values(run.stageResults ?? {}).map((stage) => ({ startedAt: stage.startedAt, finishedAt: stage.finishedAt }));
    const parallelTimes = intervals(parallel), serialTimes = intervals(serial);
    const overlap = parallelTimes.length === 2 && Math.max(...parallelTimes.map((v) => v.startedAt)) < Math.min(...parallelTimes.map((v) => v.finishedAt));
    const serialized = serialTimes.length === 2 && (serialTimes[0].finishedAt <= serialTimes[1].startedAt || serialTimes[1].finishedAt <= serialTimes[0].startedAt);
    if (parallel.status !== 'passed' || !overlap) throw new Error(`Expected overlapping execution at limit 2: ${JSON.stringify(parallelTimes)} ${JSON.stringify(parallel)}`);
    if (serial.status !== 'passed' || !serialized) throw new Error(`Expected serialized execution at limit 1: ${JSON.stringify(serialTimes)} ${JSON.stringify(serial)}`);
    return { parallelOverlap: overlap, serialNoOverlap: serialized };
  });
  if (live) {
    const liveEnv = buildSmokeServerEnv(process.env, { repo, stateDir: state, fixtureBins: [fakeCodex, fakeAgy] });
    const liveEnvSafe = await record('live transport fixture isolation', async () => {
      if (liveEnv.AGENT_SMITH_CODEX_BIN === fakeCodex || liveEnv.AGENT_SMITH_AGY_BIN === fakeAgy) throw new Error('Live transport retained a fake provider executable');
      return { fakeCodexRemoved: true, fakeAgyRemoved: true };
    });
    if (!liveEnvSafe) throw new Error('Refusing to start live provider calls with fixture executable overrides');
    await client.close();
    client = await openClient('agent-smith-smoke-live', liveEnv);
    let available = [];
    await record('installed provider and catalog discovery', async () => {
      const capabilities = await data(await client.callTool({ name: 'list_capabilities', arguments: { refresh: true } }));
      const known = new Set((capabilities.providers ?? []).map((provider) => provider.name));
      const unknown = (requestedProviders ?? []).filter((name) => !known.has(name));
      if (unknown.length) throw new Error(`Unknown provider(s): ${unknown.join(', ')}. Known: ${[...known].join(', ')}`);
      const unavailable = (requestedProviders ?? []).filter((name) => !capabilities.providers?.find((provider) => provider.name === name)?.available);
      if (unavailable.length) throw new Error(`Requested provider(s) unavailable: ${unavailable.join(', ')}`);
      available = (capabilities.providers ?? []).filter((provider) => provider.available && (!requestedProviders || requestedProviders.includes(provider.name)));
      if (!available.length) throw new Error('No installed providers reported available');
      return { available: available.map(({ name, models }) => ({ name, modelCount: models?.length ?? 0 })) };
    });
    for (const provider of available) await record(`live minimal review: ${provider.name}`, async () => {
      const ack = await data(await client.callTool({ name: 'spawn_job', arguments: { provider: provider.name, mode: 'review', name: `Smoke ${provider.name}`, task: 'Minimal live provider smoke', prompt: 'Reply with exactly: smoke passed.', timeoutMs: 120_000, cwd: repo } }));
      let done;
      try { done = await waitStatus('status', 'jobId', ack.jobId, 125_000, `live provider ${provider.name}`); }
      catch (error) {
        try { await data(await client.callTool({ name: 'cancel', arguments: { jobId: ack.jobId } })); } catch { /* cancel best-effort before scratch cleanup */ }
        throw error;
      }
      if (done.status !== 'succeeded') throw new Error(`${provider.name} ended ${done.status}`);
      return { status: done.status, model: done.modelResolved ?? done.model ?? null };
    });
  } else summary.scenarios.push({ name: 'installed provider live discovery', status: 'skip', reason: 'pass --live to inspect installed providers and catalogs' });
  if (!solo || !pipeline || summary.scenarios.some((scenario) => scenario.status === 'fail')) summary.exitCode = 1;
  if (stderr.includes('Unhandled')) { summary.exitCode = 1; summary.stderr = stderr; }
} catch (error) {
  summary.exitCode = 1;
  summary.scenarios.push({ name: 'runner setup', status: 'fail', error: String(error?.stack ?? error) });
} finally {
  try { await client?.close(); } catch { /* close is best-effort after transport failure */ }
  if (keep) summary.cleanup = 'preserved';
  else { rmSync(scratch, { recursive: true, force: true }); summary.cleanup = 'removed'; }
}
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.exitCode ?? (summary.scenarios.some((scenario) => scenario.status === 'fail') ? 1 : 0);
