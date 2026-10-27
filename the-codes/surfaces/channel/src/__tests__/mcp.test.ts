import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { waitFor } from '../../../../forge/testing/time.ts';
import { createSmithServer } from '../mcp.ts';
import { withWorkerLookup } from './service-mock.ts';

function fixture() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let launches = 0;
  let workerName = 'Ada';
  const service = withWorkerLookup({
    repo: '/private/tmp',
    detail: async () => ({ jobId: 'fixture-job', status: 'succeeded', provider: 'codex', mode: 'review', name: workerName, workerId: 'worker', conversation: 'thread', cwd: '/private/tmp', unrestricted: false }),
    spawnJob: async () => { launches++; return { jobId: 'fixture-job', name: 'Ada', status: 'running', timeoutMs: 1_000, warnings: [] }; },
  }) as never;
  const handle = serveStdio(({ era }) => createSmithServer({ service, catalogs: async () => [] }, { era }), { transport: serverTransport });
  return { clientTransport, handle, launches: () => launches, renameWorker: (name: string) => { workerName = name; } };
}

for (const modern of [false, true]) {
  test(`${modern ? '2026' : '2025'} SDK client calls tools and confirms unrestricted access`, async () => {
    const h = fixture();
    const client = new Client({ name: 'protocol-fixture', version: '1' }, {
      versionNegotiation: { mode: modern ? { pin: '2026-07-28' } : 'legacy' },
      capabilities: { elicitation: { form: {} } },
    });
    let prompts = 0;
    client.setRequestHandler('elicitation/create', async () => { prompts++; return { action: 'accept' }; });
    try {
      await client.connect(h.clientTransport);
      assert.equal(client.getNegotiatedProtocolVersion(), modern ? '2026-07-28' : '2025-11-25');
      assert.equal(client.getServerCapabilities()?.extensions?.['io.modelcontextprotocol/tasks'], undefined);
      assert.ok((await client.listTools()).tools.some(t => t.name === 'spawn_job'));
      const result = await client.callTool({ name: 'spawn_job', arguments: { provider: 'codex', mode: 'review', prompt: 'review', unrestricted: true } });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.equal(prompts, 1);
      assert.equal(h.launches(), 1);
    } finally { await client.close(); await h.handle.close(); }
  });
}

test('modern envelope validation and approval state prevent invalid calls from launching workers', async () => {
  const h = fixture();
  const responses: Array<Record<string, any>> = [];
  h.clientTransport.onmessage = message => { responses.push(message as Record<string, any>); };
  await h.clientTransport.start();
  const caps = { elicitation: { form: {} } };
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': caps };
  let id = 0;
  async function request(method: string, params: Record<string, unknown>) {
    const requestId = ++id;
    await h.clientTransport.send({ jsonrpc: '2.0', id: requestId, method, params });
    await waitFor(() => responses.some(r => r.id === requestId), { intervalMs: 5, message: `protocol response ${method}` });
    return responses.find(r => r.id === requestId)!;
  }
  try {
    const discovery = await request('server/discover', { _meta: meta });
    assert.equal(discovery.result.resultType, 'complete');
    const unsupported = await request('tools/list', { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } });
    assert.equal(unsupported.error.code, -32022);
    const missing = await request('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } });
    assert.equal(missing.error.code, -32602);
    const args = { provider: 'codex', mode: 'review', prompt: 'review', unrestricted: true };
    const first = await request('tools/call', { name: 'spawn_job', arguments: args, _meta: meta });
    assert.equal(first.result.resultType, 'input_required');
    assert.equal(h.launches(), 0);
    const forged = await request('tools/call', { name: 'spawn_job', arguments: args, requestState: `${first.result.requestState}corrupt`, inputResponses: { unrestricted: { action: 'accept' } }, _meta: meta });
    assert.equal(forged.error.code, -32602);
    const changed = await request('tools/call', { name: 'spawn_job', arguments: { ...args, prompt: 'different work' }, requestState: first.result.requestState, inputResponses: { unrestricted: { action: 'accept' } }, _meta: meta });
    assert.equal(changed.result.resultType, 'input_required');
    assert.equal(h.launches(), 0);
    const declined = await request('tools/call', { name: 'spawn_job', arguments: args, requestState: first.result.requestState, inputResponses: { unrestricted: { action: 'decline' } }, _meta: meta });
    assert.equal(declined.result.isError, true);
    assert.equal(h.launches(), 0);
    const resumeArgs = { worker: 'job-1', prompt: 'follow up', unrestricted: true };
    const resume = await request('tools/call', { name: 'resume_job', arguments: resumeArgs, _meta: meta });
    assert.equal(resume.result.resultType, 'input_required');
    h.renameWorker('Grace');
    const rebound = await request('tools/call', { name: 'resume_job', arguments: resumeArgs, requestState: resume.result.requestState, inputResponses: { unrestricted: { action: 'accept' } }, _meta: meta });
    assert.equal(rebound.result.resultType, 'input_required');
    assert.match(rebound.result.inputRequests.unrestricted.params.message, /Grace/);
    assert.equal(h.launches(), 0);
  } finally { await h.clientTransport.close(); await h.handle.close(); }
});
