/** Provider completion can reach disk before the supervisor's terminal anchor. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeResultFile } from '../../providers/ndjson.ts';
import type { JobResult } from '../../providers/types.ts';
import { readAcceptance, writeAcceptance } from '../checks.ts';
import { FILES, jobDir, jobFile } from '../format.ts';
import { ForgeService } from '../service.ts';
import { reconcileOrphan } from '../reconcile.ts';
import { JobWriter } from '../writer.ts';

function fixture(live = false) {
  const repo = mkdtempSync(path.join(tmpdir(), 'completion-recovery-'));
  const jobId = 'implement-smith-abcd0123';
  const writer = new JobWriter({ repo, jobId, mirror: false });
  writer.start({ provider: 'agy', mode: 'implement', model: null, effort: null,
    cwd: repo, prompt: 'complete work', unrestricted: false, conversation: null,
    pipeline: null, stage: null, attempt: null } as never);
  const file = jobFile(repo, jobId, FILES.job);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const ownerPid = live ? process.pid : Number(spawnSync(process.execPath,
    ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString());
  writeFileSync(file, JSON.stringify({ ...manifest, ownerPid }));
  const result: JobResult = { jobId, provider: 'agy', ok: true, status: 'success',
    response: 'Done.', exitCode: 0, signal: null, durationMs: 100,
    startedAt: manifest.startedAt, finishedAt: new Date().toISOString(),
    stateDir: jobDir(repo, jobId) };
  return { repo, jobId, file, result };
}

for (const [name, patch, expected] of [
  ['success', {}, 'succeeded'],
  ['empty success', { response: '  \n' }, 'failed'],
  ['provider failure', { ok: false, status: 'error', error: 'provider failed' }, 'failed'],
  ['soft denial', { deniedActions: [{ action: 'command', displayName: 'Run' }] }, 'failed'],
  ['nonfatal tool denial', { deniedActions: [{ action: 'tool' }] }, 'succeeded'],
  ['acknowledged cancellation', { status: 'cancelled', ok: false }, 'canceled'],
] as const) {
  test(`recovers persisted ${name} using canonical completion rules`, () => {
    const { repo, jobId, file, result } = fixture();
    const completed = { ...result, ...patch };
    writeAcceptance(repo, jobId, { state: 'unchecked', checks: [], pending: true });
    writeResultFile(result.stateDir, completed);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'running');
    assert.equal(reconcileOrphan(repo, jobId), true);
    const recovered = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(recovered.status, expected);
    assert.equal(recovered.jobStatus, completed.status);
    assert.equal(recovered.finishedAt, completed.finishedAt);
    assert.equal(readFileSync(jobFile(repo, jobId, FILES.report), 'utf8'),
      completed.response.trim() === '' ? '' : completed.response);
    assert.deepEqual(readAcceptance(repo, jobId), { state: 'rejected', checks: [],
      at: completed.finishedAt, pending: false, reason: 'server stopped; checks not run' });
    const anchor = readFileSync(file, 'utf8');
    assert.equal(reconcileOrphan(repo, jobId), false);
    assert.equal(readFileSync(file, 'utf8'), anchor);
    // Simulate a crash after the anchor rename but before acceptance settled.
    writeAcceptance(repo, jobId, { state: 'unchecked', checks: [], pending: true });
    assert.equal(reconcileOrphan(repo, jobId), false);
    assert.equal(readAcceptance(repo, jobId).state, 'rejected');
    assert.equal(readFileSync(file, 'utf8'), anchor);
  });
}

test('persisted completion cannot replace a live owner or a published terminal anchor', () => {
  const live = fixture(true);
  writeResultFile(live.result.stateDir, live.result);
  const running = readFileSync(live.file, 'utf8');
  assert.equal(reconcileOrphan(live.repo, live.jobId), false);
  assert.equal(readFileSync(live.file, 'utf8'), running);
  const dead = fixture();
  const manifest = JSON.parse(readFileSync(dead.file, 'utf8'));
  writeFileSync(dead.file, JSON.stringify({ ...manifest, status: 'failed', finishedAt: dead.result.finishedAt }));
  writeResultFile(dead.result.stateDir, dead.result);
  const terminal = readFileSync(dead.file, 'utf8');
  assert.equal(reconcileOrphan(dead.repo, dead.jobId), false);
  assert.equal(readFileSync(dead.file, 'utf8'), terminal);
});

test('cancel request retains precedence when the owner died before publishing completion', () => {
  const { repo, jobId, file, result } = fixture();
  writeResultFile(result.stateDir, result);
  writeFileSync(jobFile(repo, jobId, FILES.cancel), result.finishedAt);
  assert.equal(reconcileOrphan(repo, jobId), true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, 'canceled');
});

for (const body of ['{', '{}', '{"ok":true}', 'null', 'wrong job', 'bad denial']) {
  test(`invalid persisted result ${body} cannot suppress orphan recovery`, () => {
    const { repo, jobId, file, result } = fixture();
    const contents = body === 'wrong job' ? JSON.stringify({ ...result, jobId: 'other' })
      : body === 'bad denial' ? JSON.stringify({ ...result, deniedActions: [null] }) : body;
    writeFileSync(jobFile(repo, jobId, FILES.result), contents);
    assert.equal(reconcileOrphan(repo, jobId), true);
    const recovered = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.jobStatus, 'orphaned');
    assert.equal(reconcileOrphan(repo, jobId), false);
  });
}

test('service startup publishes a provider completion already present on disk', async () => {
  const { repo, jobId, result } = fixture();
  writeResultFile(result.stateDir, result);
  writeAcceptance(repo, jobId, { state: 'accepted', checks: [], pending: false });
  const service = new ForgeService({ repo, mirror: false });
  assert.equal((await service.list())[0]?.status, 'succeeded');
  assert.equal(readAcceptance(repo, jobId).state, 'accepted', 'published acceptance is preserved');
});

for (const [provider, key] of [['agy', 'conversation_id'], ['codex', 'threadId'], ['claude', 'sessionId'], ['opencode', 'sessionId'], ['kimi', 'sessionId']]) {
  test(`recovers ${provider} resume identity from an older result with no conversation anchor`, () => {
    const { repo, jobId, file, result } = fixture();
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...manifest, provider, conversation: null }));
    writeResultFile(result.stateDir, { ...result, provider, raw: { [key!]: 'recovered-session' } });
    assert.equal(reconcileOrphan(repo, jobId), true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).conversation, 'recovered-session');
  });
}

test('invalid recovered identity retains the existing conversation', () => {
  const { repo, jobId, file, result } = fixture();
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...manifest, conversation: 'existing-session' }));
  writeResultFile(result.stateDir, { ...result, raw: { conversation_id: {} } });
  assert.equal(reconcileOrphan(repo, jobId), true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).conversation, 'existing-session');
});

test('recovery fails a writing job whose cwd is gone, keeps a review, and summarises from the end', () => {
  for (const [mode, expected] of [['implement', 'failed'], ['review', 'succeeded']] as const) {
    const { repo, jobId, file, result } = fixture();
    const gone = mkdtempSync(path.join(tmpdir(), 'completion-recovery-cwd-'));
    rmSync(gone, { recursive: true, force: true });
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), mode, cwd: gone }));
    const tail = 'Verdict: merge.';
    writeResultFile(result.stateDir, { ...result, response: `${'Long preamble. '.repeat(120)}\n\n${tail}` });
    assert.equal(reconcileOrphan(repo, jobId), true);
    const recovered = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(recovered.status, expected, mode);
    assert.equal(recovered.cwdMissingAtFinish, true);
    assert.equal(recovered.changedFilesUnknown, true);
    assert.match(recovered.latestSummary, /Verdict: merge\.$/);
  }
});

test('recovery counts only completed edits as writing; the digest is a fallback for old files', () => {
  for (const [label, progress, expected] of [
    ['edit attempted, none completed', { editsCompleted: 0, digest: { editedCount: 1 } }, 'succeeded'],
    ['edit completed', { editsCompleted: 1, digest: { editedCount: 1 } }, 'failed'],
    ['pre-counter file with a digest edit', { digest: { editedCount: 1 } }, 'failed'],
  ] as const) {
    const { repo, jobId, file, result } = fixture();
    const gone = mkdtempSync(path.join(tmpdir(), 'completion-recovery-cwd-'));
    rmSync(gone, { recursive: true, force: true });
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), mode: 'review', cwd: gone }));
    const progressFile = jobFile(repo, jobId, FILES.progress);
    const onDisk = JSON.parse(readFileSync(progressFile, 'utf8')) as Record<string, unknown>;
    delete onDisk['editsCompleted'];
    writeFileSync(progressFile, JSON.stringify({ ...onDisk, ...progress }));
    writeResultFile(result.stateDir, { ...result, response: 'Full review.' });
    assert.equal(reconcileOrphan(repo, jobId), true);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).status, expected, label);
  }
});
