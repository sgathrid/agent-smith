import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildArgv as buildClaudeArgv } from './claude.ts';
import { buildArgv as buildCodexArgv } from './codex.ts';
import { buildArgv as buildAgyArgv } from './agy.ts';
import { buildArgv as buildOpencodeArgv } from './opencode.ts';
import { spawnWorker } from './ndjson.ts';
import type { SpawnSpec } from './types.ts';

const tmpDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-provider-test-'));
  tmpDirs.push(dir);
  return dir;
}

function spec(overrides: Partial<SpawnSpec> = {}): SpawnSpec {
  return {
    mode: 'implement',
    prompt: 'continue the work',
    cwd: process.cwd(),
    timeoutMs: 5_000,
    unrestricted: false,
    ...overrides,
  };
}

test.after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

test('Codex argv applies effort and resumes the supplied thread', () => {
  const argv = buildCodexArgv(spec({
    model: 'gpt-6-sol',
    effort: 'xhigh',
    conversation: 'thread-123',
  }));

  assert.deepEqual(argv.slice(0, 3), ['exec', 'resume', 'thread-123']);
  assert.ok(argv.includes('--model') && argv[argv.indexOf('--model') + 1] === 'gpt-6-sol');
  assert.ok(argv.includes('model_reasoning_effort="xhigh"'));
  assert.equal(argv.at(-1), 'continue the work');
});

test('Codex rejects an effort the CLI adapter does not support', () => {
  assert.throws(
    () => buildCodexArgv(spec({ effort: 'maximum-ish' })),
    /codex does not support effort 'maximum-ish'/,
  );
});

test('Claude argv applies effort and uses --resume for continuation', () => {
  const argv = buildClaudeArgv(spec({ effort: 'high', conversation: 'session-123' }));
  assert.ok(argv.includes('--effort') && argv[argv.indexOf('--effort') + 1] === 'high');
  assert.ok(argv.includes('--resume') && argv[argv.indexOf('--resume') + 1] === 'session-123');
  assert.ok(!argv.includes('--session-id'));
});

test('Claude rejects an effort the CLI does not support', () => {
  assert.throws(
    () => buildClaudeArgv(spec({ effort: 'ultra' })),
    /claude does not support effort 'ultra'/,
  );
});

test('agy refuses contradictory model effort suffixes', () => {
  assert.throws(() => buildAgyArgv(spec({ model: 'fixture-low', effort: 'high' })), /conflicting/);
  assert.equal(buildAgyArgv(spec({ model: 'fixture-high', effort: 'high' })).includes('--effort'), false);
});

test('cancellation kills a worker process group including a surviving descendant', async () => {
  if (process.platform === 'win32') return;
  const dir = tempDir();
  const delayedMarker = path.join(dir, 'descendant-survived');
  const childPidFile = path.join(dir, 'child.pid');
  const descendantCode = `process.on('SIGTERM',()=>{}); setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(delayedMarker)},'alive'),900); setInterval(()=>{},1000)`;
  const workerCode = [
    "const {spawn}=require('node:child_process');",
    "const fs=require('node:fs');",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore'});`,
    `fs.writeFileSync(${JSON.stringify(childPidFile)},String(child.pid));`,
    "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);",
  ].join('');
  const worker = await spawnWorker({
    provider: 'fake',
    binary: process.execPath,
    argv: ['-e', workerCode],
    cwd: dir,
    timeoutMs: 10_000,
    killGraceMs: 100,
    stateDir: dir,
    jobId: 'group-kill',
    mode: 'test',
    onStdoutLine() {},
    onStderr() {},
  });

  // Wait until the grandchild is live before asking the worker to stop.
  for (let i = 0; i < 100 && !existsSync(childPidFile); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(existsSync(childPidFile), 'fake worker started its descendant');
  const descendantPid = Number(readFileSync(childPidFile, 'utf8'));
  worker.terminate('cancelled');
  const exit = await worker.exited;
  worker.closeLog();
  assert.equal(worker.killReason, 'cancelled');
  assert.ok(exit.signal === 'SIGTERM' || exit.signal === 'SIGKILL');

  // The descendant ignores SIGTERM and has no inherited pipes to keep close
  // pending, so this proves the delayed SIGKILL reaches the whole group.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.equal(existsSync(delayedMarker), false, `descendant ${descendantPid} survived cancellation`);
});

test('spawn failures settle through exited instead of hanging', async () => {
  const dir = tempDir();
  const messages: string[] = [];
  const worker = await spawnWorker({
    provider: 'fake',
    binary: path.join(dir, 'missing-worker'),
    argv: [],
    cwd: dir,
    timeoutMs: 1_000,
    stateDir: dir,
    jobId: 'missing-binary',
    mode: 'test',
    onStdoutLine() {},
    onStderr(message) { messages.push(message); },
  });
  const exit = await Promise.race([
    worker.exited,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('spawn failure did not settle')), 1_000)),
  ]);
  worker.closeLog();
  assert.equal(exit.code, null);
  assert.ok(messages.some((message) => /spawn error/.test(message)));
});

test('a cancelled supervisor does not abandon detached-stdio descendants', async () => {
  if (process.platform === 'win32') return;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const dir = tempDir();
  const marker = path.join(dir, 'orphan-alive');
  const workerScript = path.join(dir, 'worker.cjs');
  const supervisor = path.join(dir, 'supervisor.mjs');
  const descendant = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),800);setInterval(()=>{},1000)`;
  writeFileSync(workerScript, `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});console.log('ready');setInterval(()=>{},1000)`);
  const moduleUrl = new URL('./ndjson.ts', import.meta.url).href;
  writeFileSync(supervisor, `import {spawnWorker} from ${JSON.stringify(moduleUrl)};
const proc=await spawnWorker({provider:'fixture',binary:process.execPath,argv:[${JSON.stringify(workerScript)}],cwd:${JSON.stringify(dir)},timeoutMs:3000,killGraceMs:150,stateDir:${JSON.stringify(dir)},jobId:'fixture',mode:'fixture',onStdoutLine(){setTimeout(()=>proc.terminate('cancelled'),100)},onStderr(){}});await proc.exited;proc.closeLog();`);
  await promisify(execFile)(process.execPath, ['--experimental-strip-types', supervisor], { timeout: 5000 });
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(existsSync(marker), false, 'the supervisor exited while its tool continued running');
});

test('opencode: addDirs must NOT emit --dir, which the CLI rejects', () => {
  // `opencode run` on v2.0.26 has no --dir flag; passing it prints usage and
  // exits non-zero, failing the whole job. The v2 docs still list it, so this
  // is a regression guard against "fixing" the adapter to match stale docs.
  const argv = buildOpencodeArgv(spec({ addDirs: ['/tmp/extra-a', '/tmp/extra-b'] }));
  assert.equal(argv.includes('--dir'), false, `argv must not contain --dir: ${argv.join(' ')}`);
  assert.equal(argv.includes('/tmp/extra-a'), false);
  assert.equal(argv.includes('/tmp/extra-b'), false);
});
