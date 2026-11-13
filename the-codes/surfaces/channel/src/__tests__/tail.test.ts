import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeJsonAtomic, writeAtomic } from '../../../../forge/atomic.ts';
import { FILES, SCHEMA_VERSION, jobDir, jobFile, type ForgeManifest } from '../../../../forge/format.ts';
import { appendSteerEntry } from '../../../../forge/steer-log.ts';
import { classify } from '../../../mod/hooks/progress.ts';
import { EventReducer, runTail, splitCompleteLines, type TailRecord, type WatchFn } from '../tail.ts';

function makeTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-smith-tail-test-'));
}

function makeManifest(jobId: string, overrides: Partial<ForgeManifest> = {}): ForgeManifest {
  const now = new Date().toISOString();
  return {
    schema: SCHEMA_VERSION,
    jobId,
    name: `test-${jobId}`,
    task: 'test task',
    promptChars: 9,
    mode: 'implement',
    provider: 'claude',
    model: null,
    effort: null,
    cwd: '/tmp/repo',
    status: 'running',
    jobStatus: null,
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    exitCode: null,
    error: null,
    reason: null,
    ownerPid: process.pid,
    timeoutMs: 60_000,
    unrestricted: false,
    conversation: null,
    deniedActions: [],
    usage: null,
    toolCalls: 0,
    pipeline: null,
    stage: null,
    attempt: null,
    ...overrides,
  };
}

function writeJob(repo: string, jobId: string, overrides: Partial<ForgeManifest> = {}): string {
  const dir = jobDir(repo, jobId);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = makeManifest(jobId, overrides);
  writeJsonAtomic(jobFile(repo, jobId, FILES.job), manifest);
  return dir;
}

function parseRecords(lines: readonly string[]): TailRecord[] {
  return lines.map((l) => JSON.parse(l) as TailRecord);
}

test('splitCompleteLines decodes only up to last newline and never splits UTF-8', () => {
  const emoji = Buffer.from('🚀', 'utf8'); // 4 bytes: f0 9f 9a 80
  const line1 = Buffer.from('{"a":1}\n', 'utf8');
  const partialPrefix = Buffer.from('{"b":"', 'utf8');
  const firstHalfEmoji = emoji.subarray(0, 2);
  const combined1 = Buffer.concat([line1, partialPrefix, firstHalfEmoji]);

  const res1 = splitCompleteLines(combined1);
  assert.deepEqual(res1.lines, ['{"a":1}']);
  assert.equal(res1.consumedBytes, line1.length);

  // Remaining bytes + second half of emoji + closing newline.
  const rest = Buffer.concat([
    combined1.subarray(res1.consumedBytes),
    emoji.subarray(2),
    Buffer.from('"}\n', 'utf8'),
  ]);
  const res2 = splitCompleteLines(rest);
  assert.deepEqual(res2.lines, ['{"b":"🚀"}']);
  assert.equal(res2.consumedBytes, rest.length);
});

test('EventReducer reduces activities, caches input, formats assistant text, and drops noise', () => {
  const reducer = new EventReducer();
  const at = '2026-11-13T00:00:00.000Z';

  assert.deepEqual(reducer.push({ kind: 'started', at, model: 'claude' }), []);
  assert.deepEqual(reducer.push({ kind: 'usage', at, usage: { inputTokens: 10 } }), []);
  assert.deepEqual(reducer.push({ kind: 'text', at, stream: 'thinking', text: 'secret thought' }), []);

  // Delta assistant text concatenated, flushed at next activity-start.
  assert.deepEqual(reducer.push({ kind: 'text', at, stream: 'assistant', delta: true, text: 'Hello   ' }), []);
  assert.deepEqual(reducer.push({ kind: 'text', at, stream: 'assistant', delta: true, text: 'world\n\nagain' }), []);

  const flushedOnStart = reducer.push({
    kind: 'activity-start',
    at,
    activity: { stepIndex: 1, tool: 'Read', input: JSON.stringify({ file_path: 'AGENTS.md' }) },
  });
  assert.deepEqual(flushedOnStart, [{ kind: 'step', text: 'Hello world again' }]);

  // activity-update updates cached input without emitting.
  assert.deepEqual(
    reducer.push({
      kind: 'activity-update',
      at,
      activity: { stepIndex: 1, tool: 'Read', input: JSON.stringify({ file_path: 'README.md' }) },
    }),
    [],
  );

  // activity-end without input uses cached input and capitalizes label.
  assert.deepEqual(
    reducer.push({
      kind: 'activity-end',
      at,
      activity: { stepIndex: 1, tool: 'Read' },
      status: 'done',
    }),
    [{ kind: 'step', text: 'Reading README.md' }],
  );

  // Failed tool prefixes with '✗ '.
  reducer.push({
    kind: 'activity-start',
    at,
    activity: { stepIndex: 2, tool: 'Bash', input: JSON.stringify({ command: 'npm test' }) },
  });
  assert.deepEqual(
    reducer.push({
      kind: 'activity-end',
      at,
      activity: { stepIndex: 2, tool: 'Bash' },
      status: 'error',
    }),
    [{ kind: 'step', text: '✗ Running tests' }],
  );

  // Long non-delta assistant text is held until the next activity-start, then truncated at 160 chars with ellipsis.
  const longText = 'x'.repeat(200);
  assert.deepEqual(
    reducer.push({ kind: 'text', at, stream: 'assistant', text: longText }),
    [],
  );
  assert.deepEqual(
    reducer.push({
      kind: 'activity-start',
      at,
      activity: { stepIndex: 3, tool: 'Read', input: JSON.stringify({ Path: '/a/b/AGENTS.md' }) },
    }),
    [{ kind: 'step', text: `${'x'.repeat(159)}…` }],
  );
});

test('pre-settled failed job with no events.jsonl settles immediately', async (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const jobId = 'job-failed-1';
  writeJob(repo, jobId, {
    status: 'failed',
    finishedAt: new Date().toISOString(),
    error: 'boom',
  });

  const lines: string[] = [];
  await runTail({ job: jobId, repo, out: (l) => lines.push(l) });
  assert.deepEqual(parseRecords(lines), [
    { kind: 'settled', jobId, status: 'failed' },
  ]);
});

test('incremental appends with partial line and split 4-byte emoji across writes', async (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const jobId = 'job-emoji-1';
  writeJob(repo, jobId, { status: 'running' });
  const eventsPath = jobFile(repo, jobId, FILES.events);

  const lines: string[] = [];
  const tailPromise = runTail({ job: jobId, repo, out: (l) => lines.push(l) });

  const ev1 = JSON.stringify({
    kind: 'text',
    at: '2026-11-13T00:00:00.000Z',
    stream: 'assistant',
    text: 'Ship 🚀',
  });
  const ev1Buf = Buffer.from(`${ev1}\n`, 'utf8');
  const emojiIdx = ev1Buf.indexOf(Buffer.from('🚀', 'utf8'));
  // Write up through the first 2 bytes of the 4-byte emoji (no newline yet).
  fs.writeFileSync(eventsPath, ev1Buf.subarray(0, emojiIdx + 2));

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(lines.length, 0, 'must not emit partial line or split emoji');

  // Append the rest of the emoji and newline, then a tool call so the held text flushes, then mark job succeeded.
  fs.appendFileSync(eventsPath, ev1Buf.subarray(emojiIdx + 2));
  fs.appendFileSync(
    eventsPath,
    `${JSON.stringify({ kind: 'activity-start', at: '2026-11-13T00:00:01.000Z', activity: { stepIndex: 1, tool: 'Read', input: JSON.stringify({ Path: 'AGENTS.md' }) } })}\n` +
    `${JSON.stringify({ kind: 'activity-end', at: '2026-11-13T00:00:01.100Z', activity: { stepIndex: 1, tool: 'Read' }, status: 'done' })}\n`,
  );
  await new Promise((r) => setTimeout(r, 40));
  writeJob(repo, jobId, { status: 'succeeded', finishedAt: new Date().toISOString() });

  await tailPromise;
  assert.deepEqual(parseRecords(lines), [
    { kind: 'step', text: 'Ship 🚀' },
    { kind: 'step', text: 'Reading AGENTS.md' },
    { kind: 'settled', jobId, status: 'succeeded' },
  ]);
});

test('steer A->B with A acceptance pending switches to B; failed turn with unconsumed steer.jsonl settles on A', async (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  // Case 1: A -> B via supersededBy while A has pending acceptance.
  const jobA = 'turn-a';
  const jobB = 'turn-b';
  writeJob(repo, jobA, { status: 'running' });
  fs.writeFileSync(
    jobFile(repo, jobA, FILES.events),
    `${JSON.stringify({ kind: 'text', at: '2026-11-13T00:00:00.000Z', stream: 'assistant', text: 'from A' })}\n`,
  );
  // A has pending acceptance, AND gets supersededBy B.
  writeJsonAtomic(jobFile(repo, jobA, 'acceptance.json'), {
    state: 'unchecked',
    checks: [],
    pending: true,
    budgetMs: 60_000,
  });
  writeJob(repo, jobB, { status: 'running' });
  writeJob(repo, jobA, {
    status: 'canceled',
    finishedAt: new Date().toISOString(),
    supersededBy: jobB,
  });

  const lines1: string[] = [];
  const p1 = runTail({ job: jobA, repo, out: (l) => lines1.push(l) });
  await new Promise((r) => setTimeout(r, 40));
  fs.writeFileSync(
    jobFile(repo, jobB, FILES.events),
    `${JSON.stringify({ kind: 'text', at: '2026-11-13T00:00:01.000Z', stream: 'assistant', text: 'from B' })}\n` +
    `${JSON.stringify({ kind: 'activity-start', at: '2026-11-13T00:00:01.100Z', activity: { stepIndex: 1, tool: 'Read', input: JSON.stringify({ Path: 'README.md' }) } })}\n` +
    `${JSON.stringify({ kind: 'activity-end', at: '2026-11-13T00:00:01.200Z', activity: { stepIndex: 1, tool: 'Read' }, status: 'done' })}\n`,
  );
  writeJob(repo, jobB, { status: 'succeeded', finishedAt: new Date().toISOString() });
  await p1;

  assert.deepEqual(parseRecords(lines1), [
    { kind: 'step', text: 'from A' },
    { kind: 'job', jobId: jobB },
    { kind: 'step', text: 'from B' },
    { kind: 'step', text: 'Reading README.md' },
    { kind: 'settled', jobId: jobB, status: 'succeeded' },
  ]);

  // Case 2: failed turn with unconsumed steer.jsonl and no supersededBy settles on A.
  const jobFail = 'turn-fail';
  writeJob(repo, jobFail, { status: 'failed', finishedAt: new Date().toISOString(), error: 'oops' });
  appendSteerEntry(repo, jobFail, {
    id: 'steer-1',
    createdAt: new Date().toISOString(),
    prompt: 'please continue',
    delivery: 'interrupt',
  });

  const lines2: string[] = [];
  await runTail({ job: jobFail, repo, out: (l) => lines2.push(l) });
  assert.deepEqual(parseRecords(lines2), [
    { kind: 'settled', jobId: jobFail, status: 'failed' },
  ]);
});

test('steer handoff via steer.head before supersededBy and cycle guard', async (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const jobA = 'head-a';
  const jobB = 'head-b';
  writeJob(repo, jobA, { status: 'running' });
  writeJob(repo, jobB, { status: 'succeeded', finishedAt: new Date().toISOString(), supersededBy: jobA });
  writeAtomic(jobFile(repo, jobA, FILES.steerHead), `${jobB}\n`);

  const lines: string[] = [];
  await runTail({ job: jobA, repo, out: (l) => lines.push(l) });
  assert.deepEqual(parseRecords(lines), [
    { kind: 'job', jobId: jobB },
    { kind: 'settled', jobId: jobB, status: 'succeeded' },
  ]);
});

test('acceptance pending holds, then settles when acceptance completes', async (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const jobId = 'job-acc-1';
  writeJob(repo, jobId, { status: 'succeeded', finishedAt: new Date().toISOString() });
  writeJsonAtomic(jobFile(repo, jobId, 'acceptance.json'), {
    state: 'unchecked',
    checks: [],
    pending: true,
    budgetMs: 60_000,
  });

  const lines: string[] = [];
  const tailPromise = runTail({ job: jobId, repo, out: (l) => lines.push(l) });

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(lines.length, 0, 'must hold while acceptance is pending');

  writeJsonAtomic(jobFile(repo, jobId, 'acceptance.json'), {
    state: 'accepted',
    checks: [],
    at: new Date().toISOString(),
    pending: false,
  });

  await tailPromise;
  assert.deepEqual(parseRecords(lines), [
    { kind: 'settled', jobId, status: 'succeeded' },
  ]);
});

test('orphan with reaped ownerPid reconciles and settles failed on deadmanMs', async (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const jobId = 'job-orphan-1';
  // PID 999999 is not alive.
  writeJob(repo, jobId, { status: 'running', ownerPid: 999_999 });

  const lines: string[] = [];
  await runTail({
    job: jobId,
    repo,
    out: (l) => lines.push(l),
    deadmanMs: 40,
  });

  assert.deepEqual(parseRecords(lines), [
    { kind: 'settled', jobId, status: 'failed' },
  ]);
});

test('watch fallback drains on 500ms interval when watchFn throws', async (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const jobId = 'job-fallback-1';
  writeJob(repo, jobId, { status: 'running' });

  const throwingWatch: WatchFn = () => {
    throw new Error('EMFILE: too many open files');
  };

  const lines: string[] = [];
  const tailPromise = runTail({
    job: jobId,
    repo,
    out: (l) => lines.push(l),
    watchFn: throwingWatch,
  });

  // Update job after fallback interval is armed.
  setTimeout(() => {
    fs.writeFileSync(
      jobFile(repo, jobId, FILES.events),
      `${JSON.stringify({ kind: 'text', at: '2026-11-13T00:00:00.000Z', stream: 'assistant', text: 'polled' })}\n` +
      `${JSON.stringify({ kind: 'activity-start', at: '2026-11-13T00:00:00.100Z', activity: { stepIndex: 1, tool: 'Read', input: JSON.stringify({ Path: 'AGENTS.md' }) } })}\n` +
      `${JSON.stringify({ kind: 'activity-end', at: '2026-11-13T00:00:00.200Z', activity: { stepIndex: 1, tool: 'Read' }, status: 'done' })}\n`,
    );
    writeJob(repo, jobId, { status: 'succeeded', finishedAt: new Date().toISOString() });
  }, 50);

  await tailPromise;
  assert.deepEqual(parseRecords(lines), [
    { kind: 'step', text: 'polled' },
    { kind: 'step', text: 'Reading AGENTS.md' },
    { kind: 'settled', jobId, status: 'succeeded' },
  ]);
});

test('watch error event falls back and abort signal exits cleanly without settled', async (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const jobId = 'job-abort-1';
  writeJob(repo, jobId, { status: 'running' });

  const emitter = new EventEmitter();
  let closed = false;
  const watchFn: WatchFn = () => Object.assign(emitter, {
    close() { closed = true; },
  });

  const controller = new AbortController();
  const lines: string[] = [];
  const tailPromise = runTail({
    job: jobId,
    repo,
    out: (l) => lines.push(l),
    watchFn,
    signal: controller.signal,
  });

  emitter.emit('error', new Error('watch failed'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(closed, true);

  controller.abort();
  await tailPromise;
  assert.deepEqual(lines, []);
});

test('final assistant message before settle is dropped while message followed by tool call is emitted', async (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const jobId = 'job-final-msg-1';
  writeJob(repo, jobId, { status: 'succeeded', finishedAt: new Date().toISOString() });
  const at = '2026-11-13T00:00:00.000Z';
  fs.writeFileSync(
    jobFile(repo, jobId, FILES.events),
    [
      JSON.stringify({ kind: 'text', at, stream: 'assistant', text: 'checking file first' }),
      JSON.stringify({ kind: 'activity-start', at, activity: { stepIndex: 1, tool: 'Read', input: JSON.stringify({ Path: 'AGENTS.md' }) } }),
      JSON.stringify({ kind: 'activity-end', at, activity: { stepIndex: 1, tool: 'Read' }, status: 'done' }),
      JSON.stringify({ kind: 'text', at, stream: 'assistant', text: 'Final report that should be dropped' }),
    ].join('\n') + '\n',
  );

  const lines: string[] = [];
  await runTail({ job: jobId, repo, out: (l) => lines.push(l) });
  assert.deepEqual(parseRecords(lines), [
    { kind: 'step', text: 'checking file first' },
    { kind: 'step', text: 'Reading AGENTS.md' },
    { kind: 'settled', jobId, status: 'succeeded' },
  ]);
});

test('progress classify handles agy read_file Path key', () => {
  const classified = classify('read_file', JSON.stringify({ Path: '/a/b/AGENTS.md' }));
  assert.equal(classified.kind, 'read');
  assert.equal(classified.label, 'reading AGENTS.md');
});

test('CLI exits 0 without unhandled error when stdout reader closes early (EPIPE)', async (t) => {
  const repo = makeTempRepo();
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));

  const jobId = 'job-epipe-1';
  writeJob(repo, jobId, { status: 'succeeded', finishedAt: new Date().toISOString() });
  const at = '2026-11-13T00:00:00.000Z';
  const events: string[] = [];
  for (let i = 1; i <= 500; i++) {
    events.push(JSON.stringify({
      kind: 'activity-start',
      at,
      activity: { stepIndex: i, tool: 'read_file', input: JSON.stringify({ Path: `/a/b/file-${i}.ts` }) },
    }));
    events.push(JSON.stringify({
      kind: 'activity-end',
      at,
      activity: { stepIndex: i, tool: 'read_file' },
      status: 'done',
    }));
  }
  fs.writeFileSync(jobFile(repo, jobId, FILES.events), `${events.join('\n')}\n`);

  const tailTsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tail.ts');
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; firstLine: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', tailTsPath, '--job', jobId, '--repo', repo], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let firstLine = '';
    let destroyed = false;
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdout.on('data', (chunk) => {
      if (destroyed) return;
      firstLine += String(chunk);
      const nl = firstLine.indexOf('\n');
      if (nl !== -1) {
        firstLine = firstLine.slice(0, nl);
        destroyed = true;
        child.stdout.destroy();
      }
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stderr, firstLine }));
  });

  assert.equal(result.firstLine, '{"kind":"step","text":"Reading file-1.ts"}');
  assert.equal(result.stderr, '');
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
});
