#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { buildSmokeServerEnv } from './testing/smoke-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timeScale = (() => { const n = Number(process.env.AGENT_SMITH_TEST_TIME_SCALE); return Number.isFinite(n) && n > 0 ? n : 1; })();
const scaled = (ms) => Math.round(ms * timeScale);
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
  const barrierRoot = path.join(scratch, 'barriers');
  const fakeCodex = path.join(scratch, 'fake-codex.cjs');
  const fakeAgy = path.join(scratch, 'fake-agy.cjs');
  writeFileSync(fakeCodex, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2),p=a.at(-1)||'';\nconst emit=()=>{const f=/Write your full answer to (.+?)\\. /.exec(p)?.[1];if(f){if(!fs.statSync(path.dirname(f)).isDirectory())process.exit(22);fs.writeFileSync(f,'FAKE IMPLEMENTATION ARTIFACT\\n');}if(p.includes('Review the implementation artifact')&&!p.includes('FAKE IMPLEMENTATION ARTIFACT'))process.exit(21);console.log(JSON.stringify({type:'thread.started',thread_id:'smoke-thread'}));console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:'Fake provider review: smoke passed.'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:8,output_tokens:4}}));};const bar=/SMOKE_BARRIER:([\\w-]+):(\\d+)/.exec(p);const meet=(go)=>{const fs=require('node:fs'),path=require('node:path'),d=path.join(${JSON.stringify(barrierRoot)},bar[1]);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,String(process.pid)),'');const gate=Number(bar[2])===0;const end=Date.now()+(gate?120000:Number(bar[2]));const tick=()=>{if((gate?fs.existsSync(path.join(d,'release')):fs.readdirSync(d).length>=2)||Date.now()>end)go();else setTimeout(tick,20);};tick();};if(bar)meet(emit);else if(p.includes('SMOKE_SLOW'))setTimeout(emit,12000);else emit();\n`);
  writeFileSync(fakeAgy, `#!${process.execPath}\nconst a=process.argv.slice(2),p=a.find(x=>x.includes('Write your full answer to'))||'';const m=/Write your full answer to (.+?)\\. /.exec(p);if(m){const fs=require('node:fs'),path=require('node:path');if(!fs.statSync(path.dirname(m[1])).isDirectory())process.exit(22);fs.writeFileSync(m[1],'FAKE IMPLEMENTATION ARTIFACT\\n');}\nconst emit=()=>{console.log(JSON.stringify({event:'init',init:{model:'smoke-fixture',conversation_id:'smoke-agy'}}));console.log(JSON.stringify({event:'step_update',step_index:1,state:'DONE',step_type:'agent_response',text:'Fake implementation complete.'}));console.log(JSON.stringify({event:'result',result:{conversation_id:'smoke-agy',status:'SUCCESS',response:'Fake implementation complete.',usage:{input_tokens:8,output_tokens:4}}}));};const bar=/SMOKE_BARRIER:([\\w-]+):(\\d+)/.exec(p);const meet=(go)=>{const fs=require('node:fs'),path=require('node:path'),d=path.join(${JSON.stringify(barrierRoot)},bar[1]);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,String(process.pid)),'');const gate=Number(bar[2])===0;const end=Date.now()+(gate?120000:Number(bar[2]));const tick=()=>{if((gate?fs.existsSync(path.join(d,'release')):fs.readdirSync(d).length>=2)||Date.now()>end)go();else setTimeout(tick,20);};tick();};if(bar)meet(emit);else emit();\n`);
  chmodSync(fakeCodex, 0o755); chmodSync(fakeAgy, 0o755);
  let stderr = '';
  const openClient = async (name, env) => {
    const transport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', server, repo], env, stderr: 'pipe' });
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
  const required = ['spawn_job', 'follow_up', 'steer', 'status', 'list_jobs', 'run_pipeline', 'pipeline_status', 'cancel', 'list_capabilities'];
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
  const waitStatus = async (tool, key, id, timeoutMs = 90_000, progressLabel) => {
    const end = Date.now() + scaled(timeoutMs);
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
  const nextTurn = async (name, afterJobId, timeoutMs = 90_000) => {
    const end = Date.now() + scaled(timeoutMs);
    while (Date.now() < end) {
      const value = await data(await client.callTool({ name: 'status', arguments: { id: name, response_format: 'detailed' } }));
      if (value.jobId !== afterJobId && value.status !== 'running') return value;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`no turn after ${afterJobId} for ${name}`);
  };
  const resumeArgv = (jobId) => {
    const argv = JSON.parse(readFileSync(path.join(repo, '.agent-smith', 'jobs', jobId, 'argv.json'), 'utf8')).argv;
    if (!Array.isArray(argv) || argv[0] !== 'exec' || argv[1] !== 'resume' || !argv[2]) throw new Error('The follow-up turn did not reuse its recorded conversation handle');
    return argv;
  };
  const solo = await record('solo review, then follow_up on the idle worker', async () => {
    const ack = await data(await client.callTool({ name: 'spawn_job', arguments: { provider: 'codex', mode: 'review', name: 'Smoke Reviewer', task: 'Review the smoke fixture', prompt: 'Review the fixture', model: 'smoke-fixture', effort: 'low', cwd: repo } }));
    const finished = await waitStatus('status', 'id', ack.jobId);
    if (finished.status !== 'succeeded') throw new Error(`Review ended ${finished.status}`);
    const followed = await data(await client.callTool({ name: 'follow_up', arguments: { worker: 'Smoke Reviewer', prompt: 'Check the same fixture again' } }));
    if (followed.action !== 'started' || followed.delivery !== 'now' || followed.jobId === finished.jobId) throw new Error(`follow_up on an idle worker must start a new turn: ${JSON.stringify(followed)}`);
    const continued = await nextTurn('Smoke Reviewer', finished.jobId);
    if (continued.status !== 'succeeded' || continued.workerId !== finished.workerId || continued.turn !== 2) throw new Error('follow_up did not continue the same worker');
    const argv = resumeArgv(continued.jobId);
    return { review: finished.status, followUp: continued.status, action: followed.action, delivery: followed.delivery, workerId: finished.workerId, conversation: argv[2] };
  });
  await record('follow_up queued behind a running turn', async () => {
    const tag = `queued-${Date.now()}`;
    const ack = await data(await client.callTool({ name: 'spawn_job', arguments: { provider: 'codex', mode: 'review', name: 'Smoke Queue', task: 'Queued follow-up fixture', prompt: `SMOKE_BARRIER:${tag}:0 queued fixture`, model: 'smoke-fixture', effort: 'low', cwd: repo } }));
    const queued = await data(await client.callTool({ name: 'follow_up', arguments: { worker: 'Smoke Queue', prompt: 'Then check the edge case' } }));
    if (queued.action !== 'queued' || queued.jobId !== ack.jobId || queued.delivery !== 'turn-end') throw new Error(`Expected queued at turn end on ${ack.jobId}: ${JSON.stringify(queued)}`);
    mkdirSync(path.join(barrierRoot, tag), { recursive: true });
    writeFileSync(path.join(barrierRoot, tag, 'release'), '');
    const continued = await nextTurn('Smoke Queue', ack.jobId);
    const first = await data(await client.callTool({ name: 'status', arguments: { id: ack.jobId } }));
    if (continued.status !== 'succeeded' || continued.turn !== 2) throw new Error(`Queued follow-up ended ${continued.status} (turn ${continued.turn})`);
    if (first.jobId !== ack.jobId || first.status !== 'succeeded') throw new Error('Turn 1 lost its own result to the follow-up');
    resumeArgv(continued.jobId);
    return { action: queued.action, delivery: queued.delivery, turn1: first.status, turn2: continued.status };
  });
  await record('steer interrupts a running turn', async () => {
    const tag = `steer-${Date.now()}`;
    const ack = await data(await client.callTool({ name: 'spawn_job', arguments: { provider: 'codex', mode: 'review', name: 'Smoke Steer', task: 'Steer fixture', prompt: `SMOKE_BARRIER:${tag}:0 steer fixture`, model: 'smoke-fixture', effort: 'low', cwd: repo } }));
    const steered = await data(await client.callTool({ name: 'steer', arguments: { worker: 'Smoke Steer', prompt: 'Stop and review only the README', allowFresh: true } }));
    if (steered.action !== 'interrupting' || steered.jobId !== ack.jobId) throw new Error(`Expected interrupting on ${ack.jobId}: ${JSON.stringify(steered)}`);
    const done = await waitStatus('status', 'id', ack.jobId);
    mkdirSync(path.join(barrierRoot, tag), { recursive: true });
    writeFileSync(path.join(barrierRoot, tag, 'release'), '');
    if (done.status !== 'succeeded' || done.jobId === ack.jobId || done.turn !== 2) throw new Error(`Steered turn ended ${done.status} as ${done.jobId}`);
    return { action: steered.action, status: done.status, turn: done.turn };
  });
  const pipeline = await record('cross-provider implement to review with executable check', async () => {
    const result = await data(await client.callTool({ name: 'run_pipeline', arguments: { spec: { name: 'smoke pipeline', workDir: repo, stages: [
      { name: 'implement', provider: 'agy', prompt: 'Implement the fixture and write the requested artifact', model: 'smoke-fixture', resultPath: 'implementation.md', checks: [{ name: 'executable-check', command: 'node -e "process.exit(0)"', blocking: true }] },
      { name: 'review', provider: 'codex', prompt: 'Review the implementation artifact', model: 'smoke-fixture', dependsOn: ['implement'], consumes: [{ stage: 'implement', path: 'implementation.md', label: 'implementation' }] },
    ] } } }));
    const done = await waitStatus('pipeline_status', 'runId', result.runId, 120_000);
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
    const done = await waitStatus('pipeline_status', 'runId', result.runId, 120_000);
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
    const cancellation = await data(await client.callTool({ name: 'cancel', arguments: { id: 'Smoke Cancel' } }));
    const terminal = await waitStatus('status', 'id', ack.jobId);
    if (cancellation.settled !== true || cancellation.jobId !== ack.jobId || terminal.status !== 'canceled') throw new Error(`Cancellation ended ${terminal.status}: ${JSON.stringify(cancellation)}`);
    if (existsSync(path.join(repo, '.agent-smith', 'claims', `job-${encodeURIComponent('Smoke Cancel')}`))) throw new Error('cancel claimed the worker name instead of its job');
    return { settled: cancellation.settled, status: terminal.status, by: 'name' };
  });
  await record('timeout', async () => {
    const ack = await data(await client.callTool({ name: 'spawn_job', arguments: { provider: 'codex', mode: 'review', name: 'Smoke Timeout', task: 'Timeout fixture', prompt: 'SMOKE_SLOW timeout fixture', model: 'smoke-fixture', effort: 'low', timeoutMs: 1_000, cwd: repo } }));
    const terminal = await waitStatus('status', 'id', ack.jobId, 60_000);
    if (terminal.status !== 'failed' || !/timeout|timed out/i.test(terminal.error ?? '')) throw new Error(`Timeout did not surface as timeout failure: ${JSON.stringify(terminal)}`);
    return { status: terminal.status, reason: 'timeout' };
  });
  await record('concurrency limit', async () => {
    const run = async (name, concurrency, waitMs) => {
      const tag = `${concurrency}-${Date.now()}`;
      const started = await data(await client.callTool({ name: 'run_pipeline', arguments: { spec: { name, workDir: repo, concurrency, stages: [
        { name: 'agy-worker', provider: 'agy', prompt: `SMOKE_BARRIER:${tag}:${waitMs} independent fixture A`, model: 'smoke-fixture' },
        { name: 'codex-worker', provider: 'codex', prompt: `SMOKE_BARRIER:${tag}:${waitMs} independent fixture B`, model: 'smoke-fixture' },
      ] } } }));
      if (waitMs === 0) {
        const end = Date.now() + scaled(60_000);
        for (;;) {
          const status = await data(await client.callTool({ name: 'pipeline_status', arguments: { runId: started.runId, response_format: 'detailed' } }));
          const stages = Object.values(status.stageResults ?? {});
          if (stages.length > 1) throw new Error(`Limit 1 started a second stage while the first was blocked: ${JSON.stringify(status)}`);
          if (stages.length === 1 && stages[0].status === 'running') break;
          if (status.status !== 'running' || Date.now() > end) throw new Error(`Serial run never showed a lone running stage: ${JSON.stringify(status)}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        mkdirSync(path.join(barrierRoot, tag), { recursive: true });
        writeFileSync(path.join(barrierRoot, tag, 'release'), '');
      }
      return waitStatus('pipeline_status', 'runId', started.runId, 120_000);
    };
    const parallel = await run('smoke concurrency two', 2, scaled(60_000));
    const serial = await run('smoke concurrency one', 1, 0);
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
      try { done = await waitStatus('status', 'id', ack.jobId, 125_000, `live provider ${provider.name}`); }
      catch (error) {
        try { await data(await client.callTool({ name: 'cancel', arguments: { id: ack.jobId } })); } catch { }
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
  try { await client?.close(); } catch { }
  if (keep) summary.cleanup = 'preserved';
  else { rmSync(scratch, { recursive: true, force: true }); summary.cleanup = 'removed'; }
}
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.exitCode ?? (summary.scenarios.some((scenario) => scenario.status === 'fail') ? 1 : 0);
