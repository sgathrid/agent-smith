import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  createApplicationInputHandler,
  createTaskSessionFromClient,
  resultFromTaskOutcome,
  type RawClientDispatch,
} from '@modelcontextprotocol/ext-tasks/client';
import { TASKS_EXTENSION_ID_V2, withTaskCapabilityV2 } from '@modelcontextprotocol/ext-tasks/core/v2';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { readAcceptance, writeAcceptance } from '../../../../forge/checks.ts';
import { FILES, jobFile } from '../../../../forge/format.ts';
import { ForgeService, type JobDetail } from '../../../../forge/service.ts';
import { parseLaunch } from '../../../mod/hooks/notice.ts';
import { createSmithServer } from '../mcp.ts';
import { TASK_RESULT_META } from '../tasks.ts';
import { TOOL_DEFS } from '../tools.ts';

const serverEntry = process.env.SMITH_TEST_SERVER ?? fileURLToPath(new URL('../server.ts', import.meta.url));
const validator = new AjvJsonSchemaValidator();

function rawTransport(tasks = true) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'smith-tasks-rpc-'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let status: JobDetail['status'] = 'running';
  let workerName = 'Ada';
  let conversation: string | null = 'thread-1';
  let launches = 0;
  let cancels = 0;
  const service = {
    repo,
    spawnedIds: new Set<string>(),
    detail: async (jobId: string): Promise<JobDetail> => ({
      jobId,
      name: workerName,
      workerId: 'worker-1',
      role: 'review',
      latestSummary: 'Reviewed fixture.',
      summarySource: 'worker',
      source: 'agent-smith',
      status,
      provider: 'codex',
      mode: 'review',
      model: 'gpt-5',
      task: 'Review fixture',
      toolCalls: 2,
      currentActivity: null,
      lastActivity: null,
      startedAt: '2026-10-14T12:00:00.000Z',
      updatedAt: '2026-10-14T12:00:05.000Z',
      finishedAt: status === 'running' ? null : '2026-10-14T12:00:05.000Z',
      warnings: [],
      nextAction: status === 'failed' ? 'inspect error' : null,
      report: status === 'running' ? null : 'Completed worker report: all findings documented.',
      error: status === 'failed' ? 'worker exited 1' : null,
      exitCode: status === 'succeeded' ? 0 : status === 'failed' ? 1 : null,
      unrestricted: false,
      pipeline: null,
      stage: null,
      usage: { input_tokens: 10, output_tokens: 5 },
      conversation,
      effort: 'high',
      cwd: repo,
      cancellable: status === 'running',
      changedFiles: ['src/index.ts'],
      changedFilesTruncated: false,
    }),
    spawnJob: async (req: { onPrepared?: (jobId: string) => void; name?: string }) => {
      launches++;
      const jobId = `review-smith-0000000${launches}`;
      req.onPrepared?.(jobId);
      return {
        jobId,
        name: req.name ?? workerName,
        workerId: 'worker-1',
        role: 'review',
        provider: 'codex',
        status: 'running',
        dir: path.join(repo, '.agent-smith', 'jobs', jobId),
        repo,
        timeoutMs: 1_000,
        unrestricted: false,
        note: 'queued',
        sandbox: 'codex -s read-only',
        sandboxFlags: ['-s', 'read-only'],
        readOnlyRequested: true,
        readOnlyEnforced: true,
        modelRequested: null,
        modelResolved: 'gpt-5',
        modelSource: 'harness-config',
        preambleApplied: true,
      };
    },
    cancel: (jobId: string) => {
      cancels++;
      return { jobId, requested: true, signalled: true, note: 'signalled' };
    },
  } as unknown as ForgeService;

  const handle = serveStdio(
    ({ era }) => createSmithServer({ service, pollMs: 20, catalogs: async () => [] }, { era, tasks, channel: true }),
    { transport: serverTransport },
  );
  const responses: Array<Record<string, any>> = [];
  clientTransport.onmessage = message => {
    responses.push(message as Record<string, any>);
  };
  let id = 0;
  async function request(method: string, params: Record<string, unknown>) {
    const requestId = ++id;
    await clientTransport.send({ jsonrpc: '2.0', id: requestId, method, params });
    const deadline = Date.now() + 3_000;
    while (!responses.some(r => r.id === requestId)) {
      if (Date.now() > deadline) throw new Error(`protocol response timed out for ${method}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return responses.find(r => r.id === requestId)!;
  }
  return {
    repo,
    service,
    clientTransport,
    handle,
    request,
    launches: () => launches,
    cancels: () => cancels,
    setStatus: (next: JobDetail['status']) => { status = next; },
    setWorkerName: (next: string) => { workerName = next; },
    setConversation: (next: string | null) => { conversation = next; },
    cleanup: async () => {
      await clientTransport.close();
      await handle.close();
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

function makeRawDispatch(client: Client): RawClientDispatch {
  return async (request, options) => {
    const req = request as { method: string; params?: Record<string, unknown> };
    const transport = client.transport;
    if (!transport) throw new Error('Client transport not connected');
    return await new Promise((resolve, reject) => {
      const prev = transport.onmessage;
      const timer = setTimeout(() => {
        transport.onmessage = prev;
        reject(new Error(`rawDispatch timed out for ${req.method}`));
      }, options?.context?.requestTimeoutMs ?? 5_000);
      // Intercept the raw JSON-RPC response for V2 task wire shapes while letting
      // the SDK client process unrelated traffic.
      transport.onmessage = (message, extra) => {
        if ('id' in message && message.id === reqId) {
          clearTimeout(timer);
          transport.onmessage = prev;
          const msg = message as unknown as Record<string, unknown>;
          if ('error' in msg) {
            resolve({ kind: 'error', error: msg.error as { code: number; message: string; data?: any } });
          } else {
            resolve({ kind: 'result', result: msg.result as any });
          }
          return;
        }
        prev?.(message, extra);
      };
      const reqId = `raw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      transport.send({ jsonrpc: '2.0', id: reqId, method: req.method, ...(req.params ? { params: req.params } : {}) } as never).catch(err => {
        clearTimeout(timer);
        transport.onmessage = prev;
        reject(err);
      });
    });
  };
}

test('ext-tasks V2 client negotiates Tasks, polls tasks/get, and receives completed report and acceptance', async () => {
  const h = rawTransport(true);
  const clientCapabilities = {
    elicitation: { form: {} },
    extensions: { [TASKS_EXTENSION_ID_V2]: {} },
  };
  const client = new Client({ name: 'ext-tasks-v2-client', version: '1.0.0' }, {
    versionNegotiation: { mode: { pin: '2026-07-28' } },
    capabilities: clientCapabilities,
  });
  try {
    await client.connect(h.clientTransport);
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
    assert.deepEqual(client.getServerCapabilities()?.extensions?.[TASKS_EXTENSION_ID_V2], {});

    const session = createTaskSessionFromClient(client, {
      endpointId: 'agent-smith-v2',
      rawDispatch: makeRawDispatch(client),
      v2RequestFraming: {
        protocolVersion: '2026-07-28',
        clientInfo: { name: 'ext-tasks-v2-client', version: '1.0.0' },
        clientCapabilities,
      },
      onInputRequest: createApplicationInputHandler({
        elicitation: async () => ({ action: 'accept' }),
        sampling: async () => ({ role: 'assistant', model: 'none', content: { type: 'text', text: '' } }),
        roots: async () => ({ roots: [] }),
      }),
    });
    try {
      const execution = await session.callTool('spawn_job', {
        provider: 'codex',
        mode: 'review',
        name: 'Ada',
        prompt: 'Review the module',
        unrestricted: true,
      });
      assert.equal(execution.kind, 'task');
      assert.ok(execution.handle?.taskId);
      assert.notEqual(execution.handle.taskId, 'review-smith-00000001');

      // Hold completion behind pending acceptance first, then settle acceptance.
      writeAcceptance(h.repo, 'review-smith-00000001', { state: 'unchecked', checks: [], pending: true });
      h.setStatus('succeeded');
      await new Promise(resolve => setTimeout(resolve, 40));
      writeAcceptance(h.repo, 'review-smith-00000001', {
        state: 'accepted',
        checks: [{ name: 'unit', ok: true, exitCode: 0, durationMs: 4, outputTail: 'ok', blocking: true, timedOut: false, signal: null }],
        at: '2026-10-14T12:00:06.000Z',
      });

      const { outcome, lastTask } = await execution.settle();
      assert.equal(outcome.status, 'completed');
      assert.equal(lastTask?.status, 'completed');
      const finalResult = resultFromTaskOutcome(outcome) as Record<string, any>;
      assert.equal(finalResult.isError, false);
      assert.equal(finalResult._meta?.[TASK_RESULT_META], true);
      assert.equal(finalResult.structuredContent.jobId, 'review-smith-00000001');
      assert.equal(finalResult.structuredContent.status, 'succeeded');
      assert.equal(finalResult.structuredContent.taskStatus, 'completed');
      assert.match(finalResult.structuredContent.report, /Completed worker report/);
      assert.equal(finalResult.structuredContent.acceptance.state, 'accepted');
      assert.equal(parseLaunch('mcp__plugin_agent-smith_agent-smith__spawn_job', finalResult), null);

      const spawnSchema = TOOL_DEFS.find(t => t.name === 'spawn_job')!.outputSchema!;
      const check = validator.getValidator(spawnSchema as never)(finalResult.structuredContent);
      assert.ok(check.valid, check.errorMessage);
    } finally {
      await session.close();
    }
  } finally {
    await client.close();
    await h.cleanup();
  }
});

test('per-request capability gating, non-task tools, MRTR approval, and validation errors', async () => {
  const h = rawTransport(true);
  await h.clientTransport.start();
  const baseCaps = { elicitation: { form: {} } };
  const taskCaps = withTaskCapabilityV2({
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': baseCaps,
    },
  })._meta;
  const plainMeta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': baseCaps,
  };
  try {
    // 1. Without extensions["io.modelcontextprotocol/tasks"] on the request, spawn_job returns immediate SpawnAck.
    const immediate = await h.request('tools/call', {
      name: 'spawn_job',
      arguments: { provider: 'codex', mode: 'review', prompt: 'quick check' },
      _meta: plainMeta,
    });
    assert.equal(immediate.result.resultType, 'complete');
    assert.equal(immediate.result.structuredContent.status, 'running');
    assert.equal(h.launches(), 1);

    // 2. Non-task tool with task capability still returns immediate complete result.
    const capsCall = await h.request('tools/call', {
      name: 'list_capabilities',
      arguments: {},
      _meta: taskCaps,
    });
    assert.equal(capsCall.result.resultType, 'complete');

    // 3. Validation error on spawn_job returns ordinary isError result, not a task.
    const invalid = await h.request('tools/call', {
      name: 'spawn_job',
      arguments: { provider: 'codex', mode: 'invalid-mode', prompt: 'x' },
      _meta: taskCaps,
    });
    assert.equal(invalid.result.resultType, 'complete');
    assert.equal(invalid.result.isError, true);
    assert.equal(h.launches(), 1);
    const tasksDir = path.join(h.repo, '.agent-smith', 'tasks');
    assert.equal(existsSync(tasksDir) ? readdirSync(tasksDir).length : 0, 0);

    // 4. MRTR approval resolves before launch; decline and rebound state never allocate a task.
    h.setStatus('succeeded');
    const resumeArgs = { worker: 'review-smith-00000001', prompt: 'follow up', unrestricted: true };
    const round1 = await h.request('tools/call', {
      name: 'resume_job',
      arguments: resumeArgs,
      _meta: taskCaps,
    });
    assert.equal(round1.result.resultType, 'input_required');
    assert.equal(h.launches(), 1);
    assert.equal(existsSync(tasksDir) ? readdirSync(tasksDir).length : 0, 0);

    // Rebinding worker name invalidates the prior prompt binding and re-prompts.
    h.setWorkerName('Grace');
    const rebound = await h.request('tools/call', {
      name: 'resume_job',
      arguments: resumeArgs,
      requestState: round1.result.requestState,
      inputResponses: { unrestricted: { action: 'accept' } },
      _meta: taskCaps,
    });
    assert.equal(rebound.result.resultType, 'input_required');
    assert.match(rebound.result.inputRequests.unrestricted.params.message, /Grace/);
    assert.equal(h.launches(), 1);

    // Declining returns ordinary isError tool result and allocates no task.
    const declined = await h.request('tools/call', {
      name: 'resume_job',
      arguments: resumeArgs,
      requestState: rebound.result.requestState,
      inputResponses: { unrestricted: { action: 'decline' } },
      _meta: taskCaps,
    });
    assert.equal(declined.result.resultType, 'complete');
    assert.equal(declined.result.isError, true);
    assert.equal(h.launches(), 1);
    assert.equal(existsSync(tasksDir) ? readdirSync(tasksDir).length : 0, 0);

    // Accepting with valid state launches and returns a pure task handle (no content array).
    const accepted = await h.request('tools/call', {
      name: 'resume_job',
      arguments: resumeArgs,
      requestState: rebound.result.requestState,
      inputResponses: { unrestricted: { action: 'accept' } },
      _meta: taskCaps,
    });
    assert.equal(accepted.result.resultType, 'task');
    assert.equal(accepted.result.status, 'working');
    assert.equal('content' in accepted.result, false);
    assert.equal(h.launches(), 2);
  } finally {
    await h.cleanup();
  }
});

test('truthful cancellation, completion-vs-cancel race, update validation, and reconnect durability', async () => {
  const h = rawTransport(true);
  await h.clientTransport.start();
  const taskMeta = withTaskCapabilityV2({
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  })._meta;
  try {
    // Launch task 1: test truthful cancellation (stays working until worker is actually canceled).
    const created1 = await h.request('tools/call', {
      name: 'spawn_job',
      arguments: { provider: 'codex', mode: 'review', prompt: 'cancel me' },
      _meta: taskMeta,
    });
    const taskId1 = created1.result.taskId as string;
    const cancelAck = await h.request('tasks/cancel', { taskId: taskId1, _meta: taskMeta });
    assert.equal(cancelAck.result.resultType, 'complete');
    assert.equal(h.cancels(), 1);

    // Worker is still running -> tasks/get must still report working.
    const stillWorking = await h.request('tasks/get', { taskId: taskId1, _meta: taskMeta });
    assert.equal(stillWorking.result.status, 'working');

    // Once Forge transitions job to canceled, tasks/get reports cancelled.
    h.setStatus('canceled');
    const nowCancelled = await h.request('tasks/get', { taskId: taskId1, _meta: taskMeta });
    assert.equal(nowCancelled.result.status, 'cancelled');

    // Launch task 2: worker finishes before tasks/cancel arrives -> completed result wins.
    h.setStatus('running');
    const created2 = await h.request('tools/call', {
      name: 'spawn_job',
      arguments: { provider: 'codex', mode: 'review', prompt: 'finish first' },
      _meta: taskMeta,
    });
    const taskId2 = created2.result.taskId as string;
    h.setStatus('succeeded');
    const lateCancel = await h.request('tasks/cancel', { taskId: taskId2, _meta: taskMeta });
    assert.equal(lateCancel.result.resultType, 'complete');
    const completed2 = await h.request('tasks/get', { taskId: taskId2, _meta: taskMeta });
    assert.equal(completed2.result.status, 'completed');
    assert.equal(completed2.result.result.isError, false);
    assert.match(completed2.result.result.structuredContent.report, /Completed worker report/);

    // Reconnect a fresh server instance against the same repo and verify terminal snapshot stability.
    const [clientTransport2, serverTransport2] = InMemoryTransport.createLinkedPair();
    const handle2 = serveStdio(
      ({ era }) => createSmithServer({ service: h.service, pollMs: 20, catalogs: async () => [] }, { era, tasks: true }),
      { transport: serverTransport2 },
    );
    const responses2: Array<Record<string, any>> = [];
    clientTransport2.onmessage = msg => { responses2.push(msg as Record<string, any>); };
    await clientTransport2.start();
    try {
      await clientTransport2.send({ jsonrpc: '2.0', id: 99, method: 'tasks/get', params: { taskId: taskId2, _meta: taskMeta } });
      const deadline = Date.now() + 3_000;
      while (!responses2.some(r => r.id === 99)) {
        if (Date.now() > deadline) throw new Error('reconnect response timed out');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const afterRestart = responses2.find(r => r.id === 99)!;
      assert.deepEqual(afterRestart.result, completed2.result);
    } finally {
      await clientTransport2.close();
      await handle2.close();
    }

    // tasks/update validates inputResponses and unknown taskId returns -32602.
    const validUpdate = await h.request('tasks/update', {
      taskId: taskId2,
      inputResponses: { unrestricted: { action: 'accept' } },
      _meta: taskMeta,
    });
    assert.equal(validUpdate.result.resultType, 'complete');

    const badUpdate = await h.request('tasks/update', {
      taskId: taskId2,
      inputResponses: { unrestricted: { action: 'not-an-action' } },
      _meta: taskMeta,
    });
    assert.equal(badUpdate.error.code, -32602);

    const unknownTask = await h.request('tasks/get', { taskId: 'missing_task', _meta: taskMeta });
    assert.equal(unknownTask.error.code, -32602);
  } finally {
    await h.cleanup();
  }
});

test('crash-gap tasks without a readable job fail with -32603, and dead owners reconcile as orphaned', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'smith-tasks-recovery-'));
  const service = new ForgeService({ repo });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const smithServer = createSmithServer({ service, pollMs: 20, catalogs: async () => [] }, { era: 'modern', tasks: true });
  const handle = serveStdio(() => smithServer, { transport: serverTransport });
  const responses: Array<Record<string, any>> = [];
  clientTransport.onmessage = msg => { responses.push(msg as Record<string, any>); };
  await clientTransport.start();
  const taskMeta = withTaskCapabilityV2({
    _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    },
  })._meta;
  let id = 0;
  async function request(method: string, params: Record<string, unknown>) {
    const reqId = ++id;
    await clientTransport.send({ jsonrpc: '2.0', id: reqId, method, params });
    const deadline = Date.now() + 3_000;
    while (!responses.some(r => r.id === reqId)) {
      if (Date.now() > deadline) throw new Error('timeout');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return responses.find(r => r.id === reqId)!;
  }
  try {
    // 1. Task record with no linked job (launch/persistence crash gap) -> status: 'failed' (-32603).
    const tasksDir = path.join(repo, '.agent-smith', 'tasks');
    const { TaskStore } = await import('../task-store.ts');
    const store = new TaskStore(tasksDir);
    store.create({ taskId: 'unlinked_task' });
    const unlinked = await request('tasks/get', { taskId: 'unlinked_task', _meta: taskMeta });
    assert.equal(unlinked.result.status, 'failed');
    assert.equal(unlinked.result.error.code, -32603);

    // 2. Task linked to a running job whose ownerPid is dead -> Forge reconciles orphan and settles pending acceptance.
    const orphanJobId = 'review-smith-deadbeef';
    const orphanJobFile = jobFile(repo, orphanJobId, FILES.job);
    mkdirSync(path.dirname(orphanJobFile), { recursive: true });
    writeFileSync(orphanJobFile, JSON.stringify({
      schema: 1,
      jobId: orphanJobId,
      name: 'OrphanAda',
      workerId: orphanJobId,
      provider: 'codex',
      mode: 'review',
      model: 'gpt-5',
      effort: null,
      cwd: repo,
      task: 'Orphaned review',
      unrestricted: false,
      conversation: null,
      timeoutMs: 60_000,
      status: 'running',
      createdAt: '2026-10-14T12:00:00.000Z',
      startedAt: '2026-10-14T12:00:00.000Z',
      updatedAt: '2026-10-14T12:00:01.000Z',
      finishedAt: null,
      ownerPid: 999_999_999,
      exitCode: null,
      jobStatus: null,
      error: null,
      deniedActions: [],
      usage: null,
    }, null, 2));
    writeAcceptance(repo, orphanJobId, { state: 'unchecked', checks: [], pending: true });
    store.create({ taskId: 'orphan_task', jobId: orphanJobId });

    const recovered = await request('tasks/get', { taskId: 'orphan_task', _meta: taskMeta });
    assert.equal(recovered.result.status, 'completed');
    assert.equal(recovered.result.result.isError, true);
    assert.equal(recovered.result.result.structuredContent.status, 'failed');
    assert.equal(recovered.result.result.structuredContent.acceptance.state, 'rejected');
    assert.equal(readAcceptance(repo, orphanJobId).state, 'rejected');
  } finally {
    await clientTransport.close();
    await handle.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('stdio server with AGENT_SMITH_TASKS=1 executes spawn_job and resume_job as Tasks end-to-end', async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'smith-tasks-stdio-'));
  const fake = path.join(repo, 'fake-codex.cjs');
  writeFileSync(fake, `#!${process.execPath}
console.log(JSON.stringify({type:'thread.started',thread_id:'task-thread-1'}));
setTimeout(()=>{
  const follow = process.argv.includes('resume');
  console.log(JSON.stringify({type:'item.completed',item:{id:'msg',type:'agent_message',text:follow?'Resumed task report.':'Initial task report.'}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:8,output_tokens:4}}));
}, 40);
`);
  chmodSync(fake, 0o755);
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--experimental-strip-types', serverEntry],
    env: { ...env, AGY_WATCH_CWD: repo, AGENT_SMITH_CODEX_BIN: fake, AGENT_SMITH_TASKS: '1', AGENT_SMITH_CHANNEL: '0' },
    stderr: 'pipe',
  });
  const clientCapabilities = { extensions: { [TASKS_EXTENSION_ID_V2]: {} } };
  const client = new Client({ name: 'stdio-tasks-test', version: '1.0.0' }, {
    versionNegotiation: { mode: { pin: '2026-07-28' } },
    capabilities: clientCapabilities,
  });
  try {
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
    assert.deepEqual(client.getServerCapabilities()?.extensions?.[TASKS_EXTENSION_ID_V2], {});

    const session = createTaskSessionFromClient(client, {
      endpointId: 'stdio-tasks-v2',
      rawDispatch: makeRawDispatch(client),
      v2RequestFraming: {
        protocolVersion: '2026-07-28',
        clientInfo: { name: 'stdio-tasks-test', version: '1.0.0' },
        clientCapabilities,
      },
    });
    try {
      const exec1 = await session.callTool('spawn_job', {
        provider: 'codex',
        mode: 'review',
        name: 'Ada',
        prompt: 'Review over stdio Tasks',
        checks: [{ name: 'pass', command: 'true' }],
      });
      assert.equal(exec1.kind, 'task');
      const settled1 = await exec1.settle();
      assert.equal(settled1.outcome.status, 'completed');
      const res1 = resultFromTaskOutcome(settled1.outcome) as Record<string, any>;
      assert.equal(res1.isError, false);
      assert.match(res1.structuredContent.report, /Initial task report/);
      assert.equal(res1.structuredContent.acceptance.state, 'accepted');

      // Now resume the named worker via Tasks.
      const exec2 = await session.callTool('resume_job', {
        worker: 'Ada',
        prompt: 'Follow up on edge cases',
      });
      assert.equal(exec2.kind, 'task');
      const settled2 = await exec2.settle();
      assert.equal(settled2.outcome.status, 'completed');
      const res2 = resultFromTaskOutcome(settled2.outcome) as Record<string, any>;
      assert.equal(res2.isError, false);
      assert.match(res2.structuredContent.report, /Resumed task report/);
    } finally {
      await session.close();
    }
  } finally {
    await client.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('isolated Claude Code host probe negotiates 2026-07-28 against Tasks-enabled server without global config edits', t => {
  if (spawnSync('which', ['claude'], { encoding: 'utf8' }).status !== 0) {
    t.skip('claude binary not installed');
    return;
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'smith-claude-host-probe-'));
  const claudeHome = path.join(tmp, 'claude-config');
  const wireLog = path.join(tmp, 'wire.jsonl');
  const spy = path.join(tmp, 'spy-server.mjs');
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(spy, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const log = process.env.SPY_WIRE_LOG;
const child = spawn(process.execPath, ['--experimental-strip-types', ${JSON.stringify(serverEntry)}], {
  env: { ...process.env, AGENT_SMITH_TASKS: '1', AGENT_SMITH_CHANNEL: '0' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
process.stdin.on('data', chunk => {
  appendFileSync(log, 'IN ' + chunk.toString('utf8'));
  child.stdin.write(chunk);
});
child.stdout.on('data', chunk => {
  appendFileSync(log, 'OUT ' + chunk.toString('utf8'));
  process.stdout.write(chunk);
});
child.stderr.on('data', chunk => process.stderr.write(chunk));
child.on('exit', code => process.exit(code ?? 0));
`);
  chmodSync(spy, 0o755);
  try {
    const isolatedEnv = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, HOME: tmp };
    const addRes = spawnSync(
      'claude',
      ['mcp', 'add-json', 'smith-probe', JSON.stringify({ type: 'stdio', command: spy, env: { SPY_WIRE_LOG: wireLog, AGY_WATCH_CWD: tmp } })],
      { cwd: tmp, env: isolatedEnv, encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(addRes.status, 0, addRes.stderr);
    const getRes = spawnSync('claude', ['mcp', 'get', 'smith-probe'], {
      cwd: tmp,
      env: isolatedEnv,
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.equal(getRes.status, 0, getRes.stderr);
    assert.match(getRes.stdout, /Connected/);
    const wire = readFileSync(wireLog, 'utf8');
    assert.match(wire, /"method":"server\/discover"/);
    assert.match(wire, /"io\.modelcontextprotocol\/protocolVersion":"2026-07-28"/);
    assert.match(wire, /"io\.modelcontextprotocol\/tasks":\{\}/);
    assert.match(wire, /"method":"tools\/list"/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

