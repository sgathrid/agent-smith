import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { TaskStore } from '../task-store.ts';

function fixture(options: { ttlMs?: number; maxRecords?: number } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-smith-tasks-'));
  const base = Date.parse('2026-10-14T12:00:00.000Z');
  let now = base;
  const store = () => new TaskStore(directory, { ...options, now: () => now });
  return { directory, store, base, advance: (ms: number) => { now += ms; }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('task identity and terminal result survive store restart unchanged', () => {
  const f = fixture();
  try {
    const original = f.store().create({ taskId: 'task_123', requestFingerprint: 'sha256:abc' });
    f.store().bindJob('task_123', 'job-456');
    const final = f.store().complete('task_123', [{ type: 'text', text: 'done' }]);
    const restarted = new TaskStore(f.directory, { now: () => f.base });
    assert.deepEqual(restarted.get('task_123'), final);
    assert.equal(final.createdAt, original.createdAt);
    assert.equal(final.jobId, 'job-456');
    assert.deepEqual(restarted.complete('task_123', [{ type: 'text', text: 'different' }]), final);
    assert.deepEqual(restarted.fail('task_123', { code: -32000, message: 'late failure' }), final);
  } finally { f.cleanup(); }
});

test('unsafe IDs never resolve outside the task directory', () => {
  const f = fixture();
  try {
    const store = f.store();
    for (const id of ['../escape', '/tmp/escape', 'a/b', '']) {
      assert.throws(() => store.get(id), TypeError);
      assert.throws(() => store.create({ taskId: id }), TypeError);
    }
    assert.deepEqual(readdirSync(f.directory), []);
  } finally { f.cleanup(); }
});

test('expired tasks return unknown and are removed from disk', () => {
  const f = fixture({ ttlMs: 1000 });
  try {
    f.store().create({ taskId: 'expires' });
    f.advance(1001);
    assert.equal(f.store().get('expires'), undefined);
    assert.deepEqual(readdirSync(f.directory), []);
  } finally { f.cleanup(); }
});

test('creation rejects duplicates and capacity preserves all unexpired handles', () => {
  const f = fixture({ maxRecords: 2 });
  try {
    const store = f.store();
    store.create({ taskId: 'one' });
    assert.throws(() => store.create({ taskId: 'one' }));
    f.advance(1);
    store.create({ taskId: 'two' });
    f.advance(1);
    store.complete('one', 'frozen');
    assert.throws(() => store.create({ taskId: 'three' }), /capacity/);
    assert.ok(store.get('one'));
    assert.ok(store.get('two'));
    assert.equal(readdirSync(f.directory).filter((name) => name.endsWith('.json')).length, 2);
  } finally { f.cleanup(); }
});

test('concurrent processes publish one immutable terminal result', async () => {
  const f = fixture();
  try {
    f.store().create({ taskId: 'race', jobId: 'job-race' });
    const moduleUrl = new URL('../task-store.ts', import.meta.url).href;
    const script = `import { TaskStore } from ${JSON.stringify(moduleUrl)}; const s = new TaskStore(process.argv[1], { now: () => Number(process.argv[3]) }); const n = Number(process.argv[2]); if (n % 2) s.complete('race', { winner: n }); else s.fail('race', { code: -32000 - n, message: String(n) });`;
    await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, f.directory, String(index), String(f.base)], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`terminal writer exited ${code}`)));
    })));
    const store = f.store();
    const winner = store.get('race')!;
    assert.ok(winner.status === 'completed' || winner.status === 'failed');
    assert.equal(winner.jobId, 'job-race');
    assert.deepEqual(store.cancel('race'), winner);
    assert.deepEqual(store.complete('race', { winner: 'late' }), winner);
  } finally { f.cleanup(); }
});

test('cancellation persists intent without claiming completion, then terminal state wins once', () => {
  const f = fixture();
  try {
    const store = f.store();
    store.create({ taskId: 'cancel-me' });
    const requested = store.requestCancel('cancel-me');
    assert.equal(requested.status, 'working');
    assert.ok(requested.cancellationRequestedAt);
    const cancelled = store.cancel('cancel-me');
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(store.requestCancel('cancel-me'), cancelled);
    assert.deepEqual(store.complete('cancel-me', 'late completion'), cancelled);
  } finally { f.cleanup(); }
});
