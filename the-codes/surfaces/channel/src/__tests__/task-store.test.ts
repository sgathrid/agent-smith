import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { TaskStore } from '../task-store.ts';

function fixture(options: { ttlMs?: number; maxRecords?: number } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'agent-smith-tasks-'));
  // Anchor fake time in the past so any accidental fallback to Date.now() fails immediately.
  let now = Date.parse('2020-01-01T00:00:00.000Z');
  const store = () => new TaskStore(directory, { ...options, now: () => now });
  return { directory, store, now: () => now, advance: (ms: number) => { now += ms; }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('task identity and terminal result survive store restart unchanged', () => {
  const f = fixture();
  try {
    const original = f.store().create({ taskId: 'task_123', requestFingerprint: 'sha256:abc' });
    assert.deepEqual(f.store().bindJob('task_123', 'job-456').jobId, 'job-456');
    assert.deepEqual(f.store().bindJob('task_123', 'job-456').jobId, 'job-456');
    assert.throws(() => f.store().bindJob('task_123', 'job-other'), /already bound/);
    const final = f.store().complete('task_123', [{ type: 'text', text: 'done' }]);
    assert.throws(() => f.store().bindJob('task_123', 'job-456'), /already terminal/);
    f.advance(5_000);
    const restarted = f.store();
    assert.deepEqual(restarted.get('task_123'), final);
    assert.equal(final.createdAt, original.createdAt);
    assert.equal(final.jobId, 'job-456');
    assert.deepEqual(restarted.complete('task_123', [{ type: 'text', text: 'different' }]), final);
    assert.deepEqual(restarted.fail('task_123', { code: -32000, message: 'late failure' }), final);
  } finally { f.cleanup(); }
});

test('default wall-clock store round-trips a task without custom options', () => {
  const f = fixture();
  try {
    const live = new TaskStore(f.directory);
    const created = live.create({ taskId: 'wall_clock_task', jobId: 'job-live' });
    assert.deepEqual(new TaskStore(f.directory).get('wall_clock_task'), created);
  } finally { f.cleanup(); }
});

test('unsafe IDs never resolve outside the task directory', () => {
  const f = fixture();
  try {
    const store = f.store();
    for (const id of ['../escape', '/tmp/escape', 'a/b', '']) {
      assert.throws(() => store.get(id), TypeError);
      assert.throws(() => store.create({ taskId: id }), TypeError);
      assert.throws(() => store.create({ taskId: 'safe', jobId: id }), TypeError);
    }
    assert.deepEqual(readdirSync(f.directory), []);
  } finally { f.cleanup(); }
});

test('expired tasks return unknown and remove both working and terminal files from disk', () => {
  const f = fixture({ ttlMs: 1000 });
  try {
    f.store().create({ taskId: 'expires_working' });
    f.store().create({ taskId: 'expires_terminal' });
    f.store().complete('expires_terminal', { ok: true });
    f.advance(1001);
    assert.equal(f.store().get('expires_working'), undefined);
    assert.equal(f.store().get('expires_terminal'), undefined);
    assert.deepEqual(readdirSync(f.directory), []);
  } finally { f.cleanup(); }
});

test('creation rejects duplicates, preserves unexpired handles at capacity, and evicts expired records', () => {
  const f = fixture({ ttlMs: 1000, maxRecords: 2 });
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

    // Once existing records expire, create() sweeps them and frees capacity.
    f.advance(1000);
    const three = store.create({ taskId: 'three' });
    const oneAgain = store.create({ taskId: 'one' });
    assert.equal(three.taskId, 'three');
    assert.equal(oneAgain.status, 'working');
    assert.deepEqual(readdirSync(f.directory).sort(), ['one.json', 'three.json']);
  } finally { f.cleanup(); }
});

test('concurrent processes publish one immutable terminal result and all observe the same winner', async () => {
  const f = fixture();
  try {
    f.store().create({ taskId: 'race', jobId: 'job-race' });
    const moduleUrl = new URL('../task-store.ts', import.meta.url).href;
    const script = `import { TaskStore } from ${JSON.stringify(moduleUrl)}; const s = new TaskStore(process.argv[1], { now: () => Number(process.argv[3]) }); const n = Number(process.argv[2]); const out = n % 2 ? s.complete('race', { winner: n }) : s.fail('race', { code: -32000 - n, message: String(n) }); process.stdout.write(JSON.stringify(out));`;
    const observed = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise<unknown>((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script, f.directory, String(index), String(f.now())], { stdio: ['ignore', 'pipe', 'ignore'] });
      let stdout = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`terminal writer exited ${code}`)));
    })));
    const store = f.store();
    const winner = store.get('race')!;
    assert.ok(winner.status === 'completed' || winner.status === 'failed');
    assert.equal(winner.jobId, 'job-race');
    for (const childResult of observed) {
      assert.deepEqual(childResult, winner);
    }
    assert.equal(readdirSync(f.directory).some((name) => name.includes('.tmp-')), false);
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
