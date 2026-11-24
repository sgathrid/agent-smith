import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { FILES, jobFile } from '../format.ts';
import { ForgeService } from '../service.ts';
import { callTool } from '../../surfaces/channel/src/tools.ts';
import { claim, claudeText, due } from '../../surfaces/mod/hooks/notice.ts';
import { controlledProvider, makeService } from '../testing/steer-harness.ts';
import { initGitRepo } from '../testing/git-repo.ts';
import { waitFor } from '../testing/time.ts';

const seedRepo = (dir: string): void =>
  initGitRepo(dir, { 'ARCHITECTURE.md': '# Architecture v1\nShareable export.\n', 'docs/brief.md': 'Initial brief.\n' });

test('watched brief files: copies into worktree cwd, excludes unmodified copy from changedFiles even if read, detects staleReads when repo changes, and re-syncs on steer', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  seedRepo(repo);

  const worktree = mkdtempSync(path.join(tmpdir(), 'agent-smith-wt-'));
  seedRepo(worktree);

  writeFileSync(path.join(repo, 'ARCHITECTURE.md'), '# Architecture v2\nPackEngine export.\n');

  const turn1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'worker-f',
    cwd: worktree,
    files: ['ARCHITECTURE.md', 'docs/brief.md'],
    prompt: 'Implement according to ARCHITECTURE.md.',
  });

  assert.equal(readFileSync(path.join(worktree, 'ARCHITECTURE.md'), 'utf8'), '# Architecture v2\nPackEngine export.\n');

  const turn1 = await turn1Ready;
  await waitFor(() => JSON.parse(readFileSync(jobFile(repo, ack.jobId, FILES.job), 'utf8')).gitBaseline, { message: 'gitBaseline' });
  turn1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'thread-f' });
  turn1.emit({ kind: 'activity-start', at: new Date().toISOString(), activity: { stepIndex: 1, tool: 'Read', input: 'ARCHITECTURE.md' } });
  writeFileSync(path.join(worktree, 'src.ts'), 'export const x = 1;\n');
  turn1.emit({ kind: 'activity-start', at: new Date().toISOString(), activity: { stepIndex: 2, tool: 'Write', input: 'src.ts' } });

  writeFileSync(path.join(repo, 'ARCHITECTURE.md'), '# Architecture v3\nUpdated export.\n');

  const runningDetail = await waitFor(
    async () => {
      const d = await service.detail(ack.jobId);
      return d.status === 'running' && d.staleReads !== undefined ? d : null;
    },
    { message: 'running detail with staleReads' },
  );
  assert.deepEqual(runningDetail.staleReads, ['ARCHITECTURE.md']);

  writeFileSync(path.join(repo, 'docs', 'extra.md'), 'Extra spec.\n');
  await service.followUp({
    worker: 'worker-f',
    prompt: 'Re-read ARCHITECTURE.md and docs/extra.md.',
    files: ['docs/extra.md'],
  });

  const turn2Ready = ctrl.nextTurn();
  turn1.finish({ status: 'success', response: 'Finished initial implementation according to v2.' });

  const turn2 = await turn2Ready;
  const parentDetail = await waitFor(async () => { const d = await service.detail(ack.jobId); return d.changedFiles !== undefined ? d : null; },
    { message: 'the parent turn to record its changedFiles' });
  assert.deepEqual(parentDetail.changedFiles, ['src.ts']);
  assert.deepEqual(parentDetail.staleReads, ['ARCHITECTURE.md']);

  assert.equal(readFileSync(path.join(worktree, 'ARCHITECTURE.md'), 'utf8'), '# Architecture v3\nUpdated export.\n');
  assert.equal(readFileSync(path.join(worktree, 'docs', 'extra.md'), 'utf8'), 'Extra spec.\n');
  assert.match(turn2.spec.prompt, /Synced brief file\(s\) in your working tree: ARCHITECTURE\.md, docs\/extra\.md/);

  const parentAfterSteer = await service.detail(ack.jobId);
  const turn2JobId = parentAfterSteer.followedBy!;
  assert.equal(parentAfterSteer.supersededBy, undefined);
  await waitFor(() => JSON.parse(readFileSync(jobFile(repo, turn2JobId, FILES.job), 'utf8')).gitBaseline, { message: 'turn 2 gitBaseline' });
  writeFileSync(path.join(worktree, 'docs', 'brief.md'), 'Worker edited brief.\n');
  turn2.emit({ kind: 'activity-start', at: new Date().toISOString(), activity: { stepIndex: 1, tool: 'Write', input: 'docs/brief.md' } });
  turn2.finish({ status: 'success', response: 'Updated implementation to v3 and annotated docs/brief.md.' });

  const finalManifest = await done;
  const finalDetail = await service.detail(finalManifest.jobId);
  assert.ok(finalDetail.changedFiles?.includes('docs/brief.md'), 'worker-modified watched file is in changedFiles');
  assert.equal(finalDetail.changedFiles?.includes('ARCHITECTURE.md'), false, 'unmodified synced watched file is excluded from changedFiles');
  assert.equal(finalDetail.changedFiles?.includes('docs/extra.md'), false, 'unmodified newly synced watched file is excluded from changedFiles');
  assert.equal(finalDetail.staleReads, undefined, 'no stale reads after re-sync');
});

test('watched brief files: rejects path traversal, absolute paths, and missing files', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  seedRepo(repo);

  await assert.rejects(
    service.spawnTracked({ mode: 'implement', prompt: 'x', files: ['../outside.md'] }),
    /escapes repository root/,
  );
  await assert.rejects(
    service.spawnTracked({ mode: 'implement', prompt: 'x', files: ['/etc/passwd'] }),
    /must be a relative path/,
  );
  await assert.rejects(
    service.spawnTracked({ mode: 'implement', prompt: 'x', files: ['nonexistent.md'] }),
    /does not exist in/,
  );
});

test('watched brief files in same-root cwd (cwd === repo): reading ARCHITECTURE.md does not suppress finish-time staleReads when orchestrator edits it', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  seedRepo(repo);

  const turnReady = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'same-root-worker',
    files: ['ARCHITECTURE.md', 'docs/brief.md'],
    prompt: 'Implement according to ARCHITECTURE.md.',
  });

  const turn = await turnReady;
  await waitFor(() => JSON.parse(readFileSync(jobFile(repo, ack.jobId, FILES.job), 'utf8')).gitBaseline, { message: 'gitBaseline' });
  turn.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'thread-same-root' });
  turn.emit({
    kind: 'activity-start',
    at: new Date().toISOString(),
    activity: { stepIndex: 1, tool: 'Read', input: 'Read ARCHITECTURE.md' },
  });
  writeFileSync(path.join(repo, 'src.ts'), 'export const v = 1;\n');
  turn.emit({
    kind: 'activity-start',
    at: new Date().toISOString(),
    activity: { stepIndex: 2, tool: 'Write', input: 'src.ts' },
  });

  writeFileSync(path.join(repo, 'ARCHITECTURE.md'), '# Architecture v2\nOrchestrator update.\n');

  const liveDetail = await waitFor(async () => { const d = await service.detail(ack.jobId); return d.status === 'running' && d.staleReads !== undefined ? d : null; },
    { message: 'live staleReads while running' });
  assert.deepEqual(liveDetail.staleReads, ['ARCHITECTURE.md']);

  turn.finish({ status: 'success', response: 'Implemented based on ARCHITECTURE.md v1.' });
  await done;

  const finalDetail = await service.detail(ack.jobId);
  assert.deepEqual(finalDetail.changedFiles, ['src.ts']);
  assert.deepEqual(finalDetail.staleReads, ['ARCHITECTURE.md']);

  const now = Date.now();
  const owned = claim([], { kind: 'job', id: ack.jobId, repo, timeoutMs: 60_000 }, now);
  const noticeRes = due(
    owned,
    [
      {
        id: ack.jobId,
        status: 'succeeded',
        startedAt: now - 1000,
        endedAt: now,
        staleReads: finalDetail.staleReads,
      },
    ],
    new Map(),
    now,
  );
  assert.equal(noticeRes.notices.length, 1);
  assert.match(claudeText(noticeRes.notices), /stale brief: ARCHITECTURE\.md/);
});

test('watched brief files: re-sync on steer preserves worker edits in worktree when repo copy did not change, and does not clobber on both-changed', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  seedRepo(repo);

  const worktree = mkdtempSync(path.join(tmpdir(), 'agent-smith-wt-preserve-'));
  seedRepo(worktree);

  const turn1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'worker-preserve',
    cwd: worktree,
    files: ['ARCHITECTURE.md', 'docs/brief.md'],
    prompt: 'Turn 1.',
  });
  const turn1 = await turn1Ready;
  turn1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'thread-preserve' });

  writeFileSync(path.join(worktree, 'docs', 'brief.md'), '# worker edit\n');
  turn1.emit({
    kind: 'activity-start',
    at: new Date().toISOString(),
    activity: { stepIndex: 1, tool: 'Write', input: 'docs/brief.md' },
  });

  await service.followUp({
    worker: ack.jobId,
    prompt: 'Continue turn 2.',
  });

  const turn2Ready = ctrl.nextTurn();
  turn1.finish({ status: 'success', response: 'Edited docs/brief.md in worktree.' });

  const turn2 = await turn2Ready;
  assert.equal(
    readFileSync(path.join(worktree, 'docs', 'brief.md'), 'utf8'),
    '# worker edit\n',
    'worker edit in worktree must not be overwritten by unchanged repo copy',
  );
  assert.doesNotMatch(turn2.spec.prompt, /Synced brief file\(s\) in your working tree/);

  writeFileSync(path.join(repo, 'ARCHITECTURE.md'), '# repo conflicting edit\n');
  writeFileSync(path.join(worktree, 'ARCHITECTURE.md'), '# worktree conflicting edit\n');
  await service.followUp({
    worker: ack.jobId,
    prompt: 'Continue turn 3.',
  });

  const turn3Ready = ctrl.nextTurn();
  turn2.finish({ status: 'success', response: 'Finished turn 2.' });
  const turn3 = await turn3Ready;
  assert.equal(
    readFileSync(path.join(worktree, 'ARCHITECTURE.md'), 'utf8'),
    '# worktree conflicting edit\n',
    'conflicting worktree edit must not be clobbered',
  );
  turn3.finish({ status: 'success', response: 'Finished turn 3.' });
  const finalManifest = await done;
  const finalDetail = await service.detail(finalManifest.jobId);
  assert.ok(
    finalDetail.warnings.some((w) => w.message.includes('changed in both repo and worktree')),
    'expected warning when watched file changed in both repo and worktree',
  );
});

test('watched brief files: rejects symlink escaping repo, enforces 32-file cap, and drops deleted inherited file on resume_job with warning', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  seedRepo(repo);

  const outsideDir = mkdtempSync(path.join(tmpdir(), 'agent-smith-outside-'));
  const outsideFile = path.join(outsideDir, 'secret.md');
  writeFileSync(outsideFile, 'secret\n');
  symlinkSync(outsideFile, path.join(repo, 'escape-link.md'));

  await assert.rejects(
    service.spawnTracked({ mode: 'implement', prompt: 'x', files: ['escape-link.md'] }),
    /resolves outside repository root/,
  );

  const tooMany: string[] = [];
  for (let i = 0; i < 33; i++) {
    const rel = `docs/f-${i}.md`;
    writeFileSync(path.join(repo, rel), `file ${i}\n`);
    tooMany.push(rel);
  }
  await assert.rejects(
    service.spawnTracked({ mode: 'implement', prompt: 'x', files: tooMany }),
    /exceeds maximum of 32 watched files/,
  );

  const t1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'resume-deleted-watched',
    files: ['ARCHITECTURE.md', 'docs/brief.md'],
    prompt: 'Turn 1.',
  });
  const t1 = await t1Ready;
  await Promise.resolve();
  t1.emit({ kind: 'started', at: new Date().toISOString(), conversationId: 'thread-resume-del' });
  t1.finish({ status: 'success', response: 'Done turn 1.' });
  await done;

  unlinkSync(path.join(repo, 'docs', 'brief.md'));

  const t2Ready = ctrl.nextTurn();
  const resumeOut = await callTool(
    { service, catalogs: async () => [] },
    'follow_up',
    { worker: ack.jobId, prompt: 'Resume after docs/brief.md was deleted.' },
  );
  assert.notEqual(resumeOut.isError, true);
  const resumeAck = JSON.parse((resumeOut.content[0] as { text: string }).text);
  assert.ok(
    Array.isArray(resumeAck.warnings) &&
      resumeAck.warnings.some((w: string) => w.includes('dropped deleted watched file "docs/brief.md"')),
  );
  const t2 = await t2Ready;
  t2.finish({ status: 'success', response: 'Done turn 2.' });
});

test('watched destinations reject escaped file and parent symlinks before any copy', async () => {
  const { syncWatchedFiles } = await import('../watched-files.ts');
  for (const parent of [false, true]) {
    const repo = mkdtempSync(path.join(tmpdir(), 'smith-src-'));
    const cwd = mkdtempSync(path.join(tmpdir(), 'smith-dst-'));
    const outside = mkdtempSync(path.join(tmpdir(), 'smith-out-'));
    mkdirSync(path.join(repo, 'docs'));
    writeFileSync(path.join(repo, 'docs/brief.md'), 'brief');
    writeFileSync(path.join(outside, 'brief.md'), 'private');
    if (parent) symlinkSync(outside, path.join(cwd, 'docs'));
    else { mkdirSync(path.join(cwd, 'docs')); symlinkSync(path.join(outside, 'brief.md'), path.join(cwd, 'docs/brief.md')); }
    assert.throws(() => syncWatchedFiles(repo, cwd, ['docs/brief.md']), /destination resolves outside/);
    assert.equal(readFileSync(path.join(outside, 'brief.md'), 'utf8'), 'private');
  }
});

test('unresolved worker edits survive repeated syncs until explicitly reconciled', async () => {
  const { syncWatchedFiles } = await import('../watched-files.ts');
  const repo = mkdtempSync(path.join(tmpdir(), 'smith-src-'));
  const cwd = mkdtempSync(path.join(tmpdir(), 'smith-dst-'));
  const writeRepo = (s: string) => writeFileSync(path.join(repo, 'brief.md'), s);
  writeRepo('v1');
  let baseline = syncWatchedFiles(repo, cwd, ['brief.md']);
  writeFileSync(path.join(cwd, 'brief.md'), 'worker edits');
  baseline = syncWatchedFiles(repo, cwd, ['brief.md'], baseline);
  for (const revision of ['v2', 'v3', 'v4']) {
    writeRepo(revision);
    const warnings: string[] = [];
    baseline = syncWatchedFiles(repo, cwd, ['brief.md'], baseline, w => warnings.push(w));
    assert.equal(readFileSync(path.join(cwd, 'brief.md'), 'utf8'), 'worker edits');
    assert.equal(warnings.length, 1);
  }
  writeFileSync(path.join(cwd, 'brief.md'), 'v4');
  baseline = syncWatchedFiles(repo, cwd, ['brief.md'], baseline);
  writeRepo('v5');
  syncWatchedFiles(repo, cwd, ['brief.md'], baseline);
  assert.equal(readFileSync(path.join(cwd, 'brief.md'), 'utf8'), 'v5');
});

test('finished staleReads do not change when a brief is edited after completion', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  writeFileSync(path.join(repo, 'brief.md'), 'original');
  const ready = ctrl.nextTurn();
  const tracked = await service.spawnTracked({ mode: 'review', prompt: 'review', files: ['brief.md'] });
  const turn = await ready;
  turn.finish({});
  await tracked.done;
  writeFileSync(path.join(repo, 'brief.md'), 'edited only after finish');
  assert.equal((await service.detail(tracked.ack.jobId)).staleReads, undefined);
});

test('steer ack reports the job timeoutMs from the manifest when another process owns the job', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);

  const t1Ready = ctrl.nextTurn();
  const { ack, done } = await service.spawnTracked({
    mode: 'implement',
    name: 'supervised',
    prompt: 'Work.',
    timeoutMs: 4000,
  });
  const t1 = await t1Ready;

  const other = new ForgeService({
    repo,
   
    flushMs: 5,
    providerSource: () => ctrl.provider,
    catalogSource: async () => [],
  });
  const steered = await other.followUp({ worker: ack.jobId, prompt: 'Adjust.' });
  assert.equal(steered.action, 'queued');
  assert.equal(steered.timeoutMs, 4000);

  const t2Ready = ctrl.nextTurn();
  t1.finish({ status: 'success', response: 'Done.' });
  (await t2Ready).finish({ status: 'success', response: 'Done.' });
  await done;
});

test('a steer continuation that starts fresh does not list the worker\'s own edits as already modified', async () => {
  const ctrl = controlledProvider();
  const { service, repo } = makeService(ctrl.provider);
  seedRepo(repo);
  writeFileSync(path.join(repo, 'pre.ts'), 'export const pre = 1;\n');
  const turn1Ready = ctrl.nextTurn();
  const { done } = await service.spawnTracked({ mode: 'implement', name: 'worker-dirty', prompt: 'Edit src.ts.' });
  const turn1 = await turn1Ready;
  assert.match(turn1.spec.prompt, /Already modified before you started[^\n]*pre\.ts/);
  writeFileSync(path.join(repo, 'src.ts'), 'export const x = 1;\n');
  const turn2Ready = ctrl.nextTurn();
  await service.followUp({ worker: 'worker-dirty', prompt: 'Also add y.' });
  turn1.finish({});
  const turn2 = await turn2Ready;
  assert.doesNotMatch(turn2.spec.prompt, /Already modified/);
  turn2.finish({});
  await done;
});
