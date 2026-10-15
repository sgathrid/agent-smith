/** nextAction taxonomy + git changed-files reference. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { FILES, ORPHAN_REASON, diffChangedFiles, jobFile, nextActionFor, CHANGED_FILES_CAP, type ForgeManifest } from '../format.ts';
import { JobWriter, parsePorcelainZ } from '../writer.ts';
import type { JobResult } from '../../providers/types.js';

const F = { status: 'failed' } as const;

test('nextAction taxonomy', () => {
  assert.match(nextActionFor({ ...F, error: 'x — network issue connecting to the server' }) ?? '', /^Network error/);
  assert.match(nextActionFor({ ...F, deniedCount: 1 }) ?? '', /unrestricted:true/);
  assert.match(nextActionFor({ ...F, jobStatus: 'timeout' }) ?? '', /timeoutMs/);
  assert.match(nextActionFor({ ...F, error: 'no output' }) ?? '', /^No output/);
  assert.match(nextActionFor({ ...F, exitCode: 0, report: '   ' }) ?? '', /^No output/);
  assert.doesNotMatch(nextActionFor({ ...F, exitCode: 0, report: 'hi' }) ?? '', /^No output/);
  assert.match(nextActionFor({ ...F, error: ORPHAN_REASON }) ?? '', /^Server stopped/);
  assert.equal(nextActionFor({ status: 'canceled' }), null);
  assert.match(nextActionFor({ ...F, error: 'boom', exitCode: 1 }) ?? '', /status\.error/);
  assert.equal(nextActionFor({ status: 'succeeded' }), null);
  assert.equal(nextActionFor({ status: 'running' }), null);
});

test('provider setup and account failures do not suggest blind retries or broader permissions', () => {
  for (const error of ['authentication failed', '401 Unauthorized', 'invalid API key', 'refresh token expired']) {
    assert.match(nextActionFor({ ...F, error })!, /^Not logged in/);
  }
  for (const error of ['429 Too Many Requests', 'rate_limit exceeded']) {
    assert.match(nextActionFor({ ...F, error })!, /^Rate limited/);
  }
  assert.match(nextActionFor({ ...F, error: '429 insufficient_quota' })!, /^Out of credits/);
  for (const error of ["unknown option '--permission-prompts'", "unexpected argument '--standalone'", 'unknown model "old-model"']) {
    assert.match(nextActionFor({ ...F, error })!, /^Bad flag or model/);
  }
  assert.match(nextActionFor({ ...F, error: 'spawn codex ENOENT' })!, /^Couldn.t start/);
  assert.match(nextActionFor({ ...F, jobStatus: 'denied' })!, /^Ask the user/);
  // Successful prose is not an execution diagnostic.
  assert.equal(nextActionFor({ status: 'succeeded', error: 'unauthorized rate limit' }), null);
});

test('diffChangedFiles excludes dirty-and-unchanged, caps at 200', () => {
  const d = diffChangedFiles({ head: 'a', dirty: ['keep.ts', 'gone.ts'] }, ['keep.ts', 'new.ts', '.agent-smith/x']);
  assert.deepEqual(d.files, ['gone.ts', 'new.ts']);
  const many = Array.from({ length: 250 }, (_, i) => `f${i}`);
  const c = diffChangedFiles({ head: 'a', dirty: [] }, many);
  assert.equal(c.files.length, CHANGED_FILES_CAP);
  assert.equal(c.truncated, true);
});

test('parsePorcelainZ handles renames and untracked', () => {
  assert.deepEqual(parsePorcelainZ(' M a.ts\0R  new.ts\0old.ts\0?? b.ts\0'), ['a.ts', 'b.ts', 'new.ts', 'old.ts']);
});

function sh(cwd: string, ...a: string[]): void {
  execFileSync('git', a, { cwd, stdio: 'ignore' });
}
function gitRepo(): string {
  const r = mkdtempSync(path.join(tmpdir(), 'smith-git-'));
  sh(r, 'init', '-q');
  sh(r, 'config', 'user.email', 't@t'); sh(r, 'config', 'user.name', 't'); sh(r, 'config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(r, 'a.txt'), 'a'); writeFileSync(path.join(r, 'b.txt'), 'b'); writeFileSync(path.join(r, 'c.txt'), 'c');
  sh(r, 'add', '.'); sh(r, 'commit', '-qm', 'init');
  return r;
}
function result(): JobResult {
  return {
    jobId: 'implement-smith-abcd1234', provider: 'agy', ok: true, status: 'success', exitCode: 0, signal: null,
    response: 'a sufficiently long deliverable', durationMs: 1, startedAt: '2026-10-06T12:00:00.000Z',
    finishedAt: '2026-10-06T12:00:01.000Z', stateDir: '',
  };
}
function begin(r: string, cwd: string): JobWriter {
  const w = new JobWriter({ repo: r, jobId: 'implement-smith-abcd1234', mirror: false, flushMs: 0 });
  w.start({
    provider: 'agy', mode: 'implement', model: null, effort: null, cwd, prompt: 'x', unrestricted: false,
    conversation: null, timeoutMs: 1000, pipeline: null, stage: null, attempt: null,
  });
  return w;
}
const read = (r: string): ForgeManifest => JSON.parse(readFileSync(jobFile(r, 'implement-smith-abcd1234', FILES.job), 'utf8'));

test('git baseline + changedFiles in a temp repo', async () => {
  const r = gitRepo();
  writeFileSync(path.join(r, 'a.txt'), 'dirty before'); // dirty at start, untouched later
  writeFileSync(path.join(r, 'b.txt'), 'dirty before'); // dirty at start, edited later
  const w = begin(r, r);
  await w.prepareFinish(); // also awaits the baseline
  writeFileSync(path.join(r, 'b.txt'), 'edited by the worker!');
  unlinkSync(path.join(r, 'c.txt'));
  writeFileSync(path.join(r, 'new.txt'), 'n');
  await w.prepareFinish();
  w.finish(result(), 'a sufficiently long deliverable');
  const m = read(r);
  assert.equal(m.gitBaseline?.head?.length, 40);
  assert.deepEqual(m.gitBaseline?.dirty, ['a.txt', 'b.txt']);
  assert.deepEqual(m.changedFiles, ['b.txt', 'c.txt', 'new.txt']);
  assert.equal(m.changedFilesTruncated, false);
});

test('read-only job yields []; a non-git cwd records nothing', async () => {
  const r = gitRepo();
  const w = begin(r, r);
  await w.prepareFinish();
  w.finish(result(), 'a sufficiently long deliverable');
  assert.deepEqual(read(r).changedFiles, []);

  const plain = mkdtempSync(path.join(tmpdir(), 'smith-plain-'));
  mkdirSync(plain, { recursive: true });
  const w2 = begin(plain, plain);
  await w2.prepareFinish();
  w2.finish(result(), 'a sufficiently long deliverable');
  const m = read(plain);
  assert.equal(m.gitBaseline, undefined);
  assert.equal(m.changedFiles, undefined);
});

test('start() does not wait on git', () => {
  const r = gitRepo();
  const t = performance.now();
  begin(r, r);
  assert.ok(performance.now() - t < 100, 'sync part of start stays fast');
});
