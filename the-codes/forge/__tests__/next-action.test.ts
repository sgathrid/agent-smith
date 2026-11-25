import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { FILES, ORPHAN_REASON, diffChangedFiles, failureFields, jobFile, CHANGED_FILES_CAP, type ForgeManifest } from '../format.ts';
import { REASONS, reasonFromText } from '../../surfaces/mod/hooks/reasons.ts';
import { JobWriter, parsePorcelainZ } from '../writer.ts';
import { initGitRepo } from '../testing/git-repo.ts';
import type { JobResult } from '../../providers/types.js';
import { waitFor } from '../testing/time.ts';

test('failure reason taxonomy', () => {
  assert.equal(reasonFromText('x — network issue connecting to the server'), REASONS.networkError);
  assert.equal(failureFields({ status: 'failed', suspicious: true, reason: 'denied' }, { status: 'denied', deniedActions: [{ action: 'command', displayName: 'RunCommand' }] }).reason, 'denied RunCommand');
  assert.equal(failureFields({ status: 'failed', suspicious: false, reason: REASONS.timedOut }, { status: 'timeout' }).reason, REASONS.timedOut);
  assert.equal(reasonFromText('no output'), REASONS.noOutput);
  assert.equal(failureFields({ status: 'failed', suspicious: true, reason: REASONS.noOutput }, { status: 'success', error: '' }).reason, REASONS.noOutput);
  assert.equal(reasonFromText(ORPHAN_REASON), REASONS.serverStopped);
  assert.equal(reasonFromText('boom'), 'boom');
  assert.equal(reasonFromText('a long unrecognisable failure message that exceeds thirty two characters'), REASONS.workerError);
});

test('provider setup and account failures classify to short reasons', () => {
  for (const error of ['authentication failed', '401 Unauthorized', 'invalid API key', 'refresh token expired']) {
    assert.equal(reasonFromText(error), REASONS.notLoggedIn);
  }
  for (const error of [
    'RESOURCE_EXHAUSTED: TPM quota exhausted. No spare capacity is currently available… Resource exhausted. Please try again later.',
    '503 Service Unavailable',
    '14 UNAVAILABLE: Service unavailable',
    'overloaded',
  ]) {
    assert.equal(reasonFromText(error), REASONS.providerBusy);
  }
  for (const error of ['429 Too Many Requests', 'rate_limit exceeded']) {
    assert.equal(reasonFromText(error), REASONS.rateLimited);
  }
  assert.equal(reasonFromText('429 insufficient_quota'), REASONS.outOfCredits);
  assert.equal(reasonFromText('quota exhausted'), REASONS.outOfCredits);
  for (const error of [
    'exited 1 · stderr: error: failed to run prompt: provider.api_error: 429 Your account org-123 key-456 is suspended due to insufficient balance, please recharge your account or check your plan and billing details See log: /tmp/kimi.log',
    '429 Your account is suspended, please recharge your account',
    'provider.api_error: 429 balance exhausted, please recharge',
  ]) {
    assert.equal(reasonFromText(error), REASONS.outOfCredits);
  }
  for (const error of ["unknown option '--permission-prompts'", "unexpected argument '--standalone'", 'unknown model "old-model"']) {
    assert.equal(reasonFromText(error), REASONS.badFlagOrModel);
  }
  assert.equal(reasonFromText('spawn codex ENOENT'), REASONS.couldntStart);
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

function gitRepo(): string {
  const r = mkdtempSync(path.join(tmpdir(), 'smith-git-'));
  initGitRepo(r, { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
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
  const w = new JobWriter({ repo: r, jobId: 'implement-smith-abcd1234', flushMs: 0 });
  w.start({
    provider: 'agy', mode: 'implement', model: null, effort: null, cwd, prompt: 'x', unrestricted: false,
    conversation: null, timeoutMs: 1000, pipeline: null, stage: null, attempt: null,
  });
  return w;
}
const read = (r: string): ForgeManifest => JSON.parse(readFileSync(jobFile(r, 'implement-smith-abcd1234', FILES.job), 'utf8'));

test('git baseline + changedFiles in a temp repo', async () => {
  const r = gitRepo();
  writeFileSync(path.join(r, 'a.txt'), 'dirty before');
  writeFileSync(path.join(r, 'b.txt'), 'dirty before');
  const w = begin(r, r);
  await w.prepareFinish();
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

test('start() does not wait on git', async () => {
  const r = gitRepo();
  begin(r, r);
  assert.equal(read(r).gitBaseline, undefined, 'start() returned before git was consulted');
  const landed = await waitFor(() => read(r).gitBaseline, { message: 'async git baseline to be merged into the manifest' });
  assert.ok(landed.head, 'baseline lands once git settles');
});

test('provider API access errors are not tool denials, and quota outranks timeout', () => {
  assert.equal(reasonFromText('Access denied'), 'Access denied');
  assert.equal(reasonFromText('403 Permission denied'), '403 Permission denied');
  assert.equal(reasonFromText('HTTP 402: Insufficient account funds'), REASONS.outOfCredits);
  assert.equal(reasonFromText('worker soft-denied 1 tool action(s) (view_file)'), 'denied view_file');
  assert.match(reasonFromText('permission check failed: user denied permission to run command'), /^denied\b/);
  assert.equal(reasonFromText('quota exhausted; request timed out'), REASONS.outOfCredits);
});
