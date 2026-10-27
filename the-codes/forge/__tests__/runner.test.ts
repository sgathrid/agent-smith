/**
 * runner.test.ts — the StageRunner, and the three things it owns.
 *
 * pipeline/ has been complete and unrunnable since it was written: it ships
 * `createRunnerRouter` and declares a `StageRunner` seam, and nothing ever
 * supplied one. These tests are for the supply, plus the pure functions that
 * decide what a stage's worker actually reads and what the DAG is told.
 *
 * The pipeline shape under test is the architecture's headline example —
 * implement in agy, review in Codex, moderate in Claude — with `dependsOn` doing
 * the real work of keeping review from running before there is anything to review.
 */

import assert from 'node:assert/strict';
// MUST BE FIRST in this file, and not as a matter of taste: providers/agy.ts
// captures `AGENT_SMITH_AGY_BIN` into a module-level const the moment it loads, so
// the shim has to be evaluated before anything below reaches the adapter. See
// ../testing/shim.ts for what happens when it is not.
import { MODE_PRESETS } from '../modes.ts';
import { buildBrief } from '../brief.ts';
import { assertFakeProviderActive } from '../testing/shim.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { createRunnerRouter, runPipeline } from '../../pipeline/pipeline.ts';
import { CrossFamilyViolation, moderateStage } from '../../pipeline/routing.ts';
import type { Stage } from '../../pipeline/types.ts';
import { ForgeService } from '../service.ts';
import { waitFor } from '../testing/time.ts';
import { readAcceptance } from '../checks.ts';
import { jobsDir } from '../format.ts';
import {
  ACTIVITY_TAIL,
  ARTIFACT_INLINE_CHARS,
  buildStagePrompt,
  pipelineArtifactRoot,
  readArtifact,
  readTail,
  stageArtifactPath,
  stageArtifactRef,
  collectObservations,
  stageDir,
  toObservation,
  toStageResult,
  createForgeRunner,
} from '../runner.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function repo(): string {
  return mkdtempSync(path.join(tmpdir(), 'agent-smith-runner-'));
}

/**
 * Fail loudly, at collection time, if the real `agy` binary was captured.
 *
 * Without this the suite still spawns real workers, and every "denial is a
 * failure" assertion passes for the wrong reason — having quietly spent the
 * user's model quota to prove something the fixture proves for free.
 */
assertFakeProviderActive();

function stage(over: Partial<Stage> = {}): Stage {
  return { name: 'implement', provider: 'agy', prompt: 'do the work', ...over };
}

test('stage output directory exists before dispatch and prompt separates source from output', async () => {
  const store = repo(); const work = repo(); let outputReady = false; let prompt = '';
  const service = { repo: store, spawnTracked: async (request: { prompt: string; cwd: string }) => {
    outputReady = existsSync(path.join(pipelineArtifactRoot(store, 'precreated'), 'implement', 'nested'));
    prompt = request.prompt;
    assert.equal(request.cwd, work);
    throw new Error('fixture stops before launching');
  } } as unknown as ForgeService;
  await createForgeRunner({ service, runId: 'precreated' }).run({
    pipeline: 'fixture', stage: stage({ resultPath: 'nested/result.md' }), attempt: 1, workDir: work,
    inputs: [], routing: { provider: 'agy', tier: 't0-cheap', effort: 'low' }, signal: new AbortController().signal,
  } as never);
  assert.equal(outputReady, true);
  assert.ok(prompt.includes(`SOURCE WORKSPACE: ${work}`));
  assert.ok(prompt.includes('OUTPUT ARTIFACT'));
  assert.ok(prompt.includes('Search, run commands and make any code changes in the source workspace'));
});

test("a stage's context and checks reach its worker's prompt, and a same-conversation retry does not repeat them", async () => {
  const r = repo(); const service = new ForgeService({ repo: r });
  const runner = createForgeRunner({ service, runId: 'brief' });
  const st = stage({ context: 'Ships in the next release.', checks: [{ name: 'unit', command: 'true' }] });
  const first = await runner.run(ctxFor(r, st));
  const view = JSON.parse(readFileSync(path.join(r, '.agent-smith', 'jobs', first.jobId!, 'view.json'), 'utf8')) as { preamble: string | null };
  assert.ok(view.preamble?.includes('Context: Ships in the next release.'));
  assert.ok(view.preamble?.includes('- unit: `true`'));
  assert.ok(view.preamble?.includes("You're done when these checks pass"));

  const ctx = ctxFor(r, st);
  ctx.attempt = 2;
  ctx.continuation = { attempt: 1, priorStatus: 'failed', transcriptRef: 'prior-thread', transcriptProvider: st.provider, appendedContext: 'Previous check failed' };
  const retry = await runner.run(ctx);
  const retryView = JSON.parse(readFileSync(path.join(r, '.agent-smith', 'jobs', retry.jobId!, 'view.json'), 'utf8')) as { preamble: string | null };
  assert.equal(retryView.preamble, null, 'the continued conversation already holds the brief');
});

/* ── paths ─────────────────────────────────────────────────────────────────── */

test('each stage gets its OWN directory, so a stage cannot overwrite its input', () => {
  // pipeline.ts hands downstream stages a bare `result.md` with no stage
  // qualifier. Three stages sharing one directory would mean the moderate stage
  // reviews its own review. Per-stage directories make that impossible.
  assert.equal(stageDir('/w', 'implement'), '/w/implement');
  assert.equal(stageArtifactPath('/w', 'implement'), '/w/implement/result.md');
  assert.equal(stageArtifactPath('/w', 'review', 'findings.md'), '/w/review/findings.md');
  assert.equal(stageArtifactRef('review'), 'review/result.md');
  assert.throws(() => stageArtifactPath('/w', '../outside'), /invalid stage name/);
  assert.throws(() => stageArtifactPath('/w', 'review', '../../outside'), /invalid stage artifact path/);
});

/* ── readArtifact ──────────────────────────────────────────────────────────── */

test('readArtifact resolves the bare result.md that the DAG hands us', () => {
  const r = repo();
  mkdirSync(path.join(r, 'implement'), { recursive: true });
  writeFileSync(path.join(r, 'implement', 'result.md'), '# the diff\n\nit works');
  // `inputsFor()` gives `{ stage: 'implement', path: 'result.md' }` — a path with
  // no stage qualifier. We wrote ours under the stage directory, so the fallback
  // has to find it.
  const found = readArtifact(r, { stage: 'implement', path: 'result.md' });
  assert.equal(found.text, '# the diff\n\nit works');
  assert.equal(found.from, path.resolve(r, 'implement', 'result.md'));
});

test('readArtifact resolves an explicit path first, as given', () => {
  const r = repo();
  mkdirSync(path.join(r, 'artifacts'), { recursive: true });
  writeFileSync(path.join(r, 'artifacts', 'patch.diff'), '--- a\n+++ b\n');
  const found = readArtifact(r, { stage: 'implement', path: 'artifacts/patch.diff' });
  assert.equal(found.text, '--- a\n+++ b\n');
});

test('a missing artefact costs one input, not the whole stage', () => {
  // Returning null rather than throwing is required: a review with no diff in its
  // context still has the absolute path and can read the file itself.
  const found = readArtifact(repo(), { stage: 'implement', path: 'result.md' });
  assert.equal(found.text, null);
});

test('readArtifact refuses traversal paths without throwing or reading outside the work tree', () => {
  const found = readArtifact(repo(), { stage: '../../outside', path: '../../outside/secret' });
  assert.equal(found.text, null);
});

test('an oversized artefact is truncated AND announced as truncated', () => {
  // A silently truncated input is worse than no input: the model cannot tell that
  // it is looking at a fragment.
  const r = repo();
  mkdirSync(path.join(r, 'implement'), { recursive: true });
  writeFileSync(path.join(r, 'implement', 'result.md'), 'x'.repeat(5_000));
  const found = readArtifact(r, { stage: 'implement', path: 'result.md' }, 1_000);
  assert.equal(found.truncated, true);
  assert.ok((found.text ?? '').endsWith('[truncated]'));
});

/* ── buildStagePrompt ──────────────────────────────────────────────────────── */

test('the stage prompt is passed through, and the artefact is appended', () => {
  const r = repo();
  mkdirSync(path.join(r, 'implement'), { recursive: true });
  writeFileSync(path.join(r, 'implement', 'result.md'), 'THE UPSTREAM WORK');
  const prompt = buildStagePrompt({
    stage: stage({ name: 'review', prompt: 'find what is wrong' }),
    workDir: r,
    inputs: [{ stage: 'implement', path: 'result.md' }],
    attempt: 1,
  });
  assert.match(prompt, /find what is wrong/);
  assert.match(prompt, /THE UPSTREAM WORK/, 'the artefact itself, not a summary of it');
  assert.ok(
    prompt.includes(path.resolve(r, 'implement', 'result.md')),
    'and the ABSOLUTE path, so a worker that needs the rest can read it itself',
  );
});

test('a read-only stage is told its artifact is the only permitted write', () => {
  // The service prepends the brief, whose review guidance says to leave the files
  // as they are; compose it the same way and check the worker is never left with
  // an unqualified "leave the files" plus an instruction to write.
  const work = repo();
  for (const name of ['review', 'moderate'] as const) {
    const stagePrompt = buildStagePrompt({ stage: stage({ name }), workDir: work, inputs: [], attempt: 1 });
    const prompt = `${buildBrief({ preset: MODE_PRESETS[name], cwd: work, pipelineStage: true })}\n\n${stagePrompt}`;
    assert.ok(prompt.includes(path.resolve(work, name, 'result.md')));
    assert.match(stagePrompt, /leave every file in the source workspace as it is/);
    assert.match(stagePrompt, /only permitted write/);
    const guidanceAt = prompt.toLowerCase().indexOf('leave the files as they are');
    assert.ok(guidanceAt >= 0 && guidanceAt < prompt.indexOf('only permitted write'), 'the qualification comes after the guidance');
  }
  // A custom role that is not a read-only mode keeps the plain wording.
  const implement = buildStagePrompt({ stage: stage({ name: 'implement' }), workDir: work, inputs: [], attempt: 1 });
  assert.doesNotMatch(implement, /read-only stage/);
  assert.match(buildStagePrompt({ stage: stage({ name: 'qa', role: 'review' }), workDir: work, inputs: [], attempt: 1 }), /read-only stage/);
});

test('the continuation goes FIRST, before the restated task', () => {
  // On attempt 2 the worker's most important fact is "you already tried this".
  // A trailing paragraph after a re-stated task is a paragraph read last.
  const prompt = buildStagePrompt({
    stage: stage({ name: 'implement' }),
    workDir: repo(),
    inputs: [],
    attempt: 2,
    continuation: { attempt: 1, appendedContext: 'Previous attempt stalled: no-progress.', transcriptRef: 'conv-1' },
  });
  assert.ok(prompt.indexOf('CONTINUE, DO NOT RESTART') < prompt.indexOf('do the work'));
  assert.match(prompt, /attempt 2/);
  assert.match(prompt, /Previous attempt stalled: no-progress/);
});


test('the total inline budget is honoured and the exhaustion is stated', () => {
  const r = repo();
  const inputs = Array.from({ length: 8 }, (_, i) => {
    mkdirSync(path.join(r, `s${i}`), { recursive: true });
    writeFileSync(path.join(r, `s${i}`, 'result.md'), 'y'.repeat(ARTIFACT_INLINE_CHARS));
    return { stage: `s${i}`, path: 'result.md' };
  });
  const prompt = buildStagePrompt({ stage: stage(), workDir: r, inputs, attempt: 1 });
  assert.match(prompt, /inline budget exhausted/);
});

/* ── observations ──────────────────────────────────────────────────────────── */

test('a tool call is a tool observation, never an edit or a verification', () => {
  // We cannot tell a `write_file` that edits the repo from one that writes a
  // scratch file, so claiming `edit` would feed routing's `edit-churn-unverified`
  // rule a stall verdict that is a lie.
  const obs = toObservation({ stepIndex: 7, tool: 'write_file', input: 'src/index.ts', status: 'done' });
  assert.equal(obs.kind, 'tool');
  assert.equal(obs.turn, 7, 'the step index is the turn, so no-progress runs are countable');
  assert.equal(obs.ok, true);
  assert.equal(obs.target, 'src/index.ts');
});

test('a denied tool is an ERROR observation, which is what routing escalates on', () => {
  const obs = toObservation({ stepIndex: 2, tool: 'run_command', status: 'denied' });
  assert.equal(obs.kind, 'error');
  assert.equal(obs.ok, false);
  assert.match(obs.message ?? '', /denied/);
});

test('the observation tail is bounded, and the bound is published', () => {
  assert.equal(ACTIVITY_TAIL, 400);
  assert.ok(ACTIVITY_TAIL >= 3, 'routing needs at least the repeat-signature threshold');
});

/* ── the StageResult mapping ───────────────────────────────────────────────── */

function manifestFor(over: Record<string, unknown> = {}): any {
  return {
    schema: 1,
    jobId: 'implement-smith-abcd1234',
    provider: 'agy',
    mode: 'implement',
    model: 'gemini-3.8-flash-high',
    effort: 'low',
    cwd: '/repo',
    task: 'x',
    promptChars: 1,
    unrestricted: false,
    conversation: 'conv-1',
    status: 'succeeded',
    createdAt: '2026-10-06T12:00:00.000Z',
    updatedAt: '2026-10-06T12:00:10.000Z',
    startedAt: '2026-10-06T12:00:00.000Z',
    finishedAt: '2026-10-06T12:00:10.000Z',
    exitCode: 0,
    jobStatus: 'success',
    error: null,
    deniedActions: [],
    usage: null,
    toolCalls: 5,
    pipeline: null,
    stage: null,
    attempt: null,
    ...over,
  };
}

function ctxFor(workDir: string, st: Stage, inputs: { stage: string; path: string }[] = []): any {
  return {
    pipeline: 'p',
    stage: st,
    attempt: 1,
    workDir,
    inputs,
    routing: { tier: 't0-cheap', provider: st.provider, model: 'm', effort: 'low', rationale: 'r' },
    signal: new AbortController().signal,
  };
}

test('a passed stage reports its artefact and its transcript, for a later resume', () => {
  const r = repo();
  mkdirSync(stageDir(r, 'implement'), { recursive: true });
  writeFileSync(stageArtifactPath(r, 'implement'), '# done\n\nthe work');
  const res = toStageResult(stage(), ctxFor(r, stage()), manifestFor(), [], 0, r);
  assert.equal(res.status, 'passed');
  assert.equal(res.resultPath, 'implement/result.md');
  assert.equal(res.transcriptRef, 'conv-1', 'so a continuation can resume rather than restart');
  assert.equal(res.outputTail, '# done\n\nthe work');
});

test('a failure keeps the provider\'s own status word, so `denied` survives', () => {
  // `denied` is the difference between "the tool broke" and "the permission model
  // ate the work", and the remedy is different.
  const r = repo();
  const res = toStageResult(
    stage(),
    ctxFor(r, stage()),
    manifestFor({ status: 'failed', jobStatus: 'denied', error: 'soft-denied 1 tool action' }),
    [],
    0,
    r,
  );
  assert.equal(res.status, 'failed');
  assert.equal(res.failure?.code, 'denied');
  assert.equal(res.failure?.retryable, false);
  assert.equal(res.resultPath, undefined, 'nothing was written, so no path is advertised');
  assert.deepEqual(res.artifacts, []);
  assert.match(res.warnings?.[0] ?? '', /implement\/result\.md not found on disk/);
});

test('a failed stage that did leave an artefact still publishes it for a human to read', () => {
  const r = repo();
  mkdirSync(stageDir(r, 'implement'), { recursive: true });
  writeFileSync(stageArtifactPath(r, 'implement'), 'partial notes');
  const res = toStageResult(stage(), ctxFor(r, stage()), manifestFor({ status: 'failed', jobStatus: 'error' }), [], 0, r);
  assert.equal(res.resultPath, 'implement/result.md');
  assert.deepEqual(res.artifacts, [{ stage: 'implement', path: 'implement/result.md', label: 'result.md' }]);
  assert.equal(res.warnings, undefined);
});

test('a stage that claims success but wrote nothing is FAILED at the DAG boundary', () => {
  // The DAG has no reader for a manifest, so "the worker said it passed but there
  // is nothing to hand the next stage" has to be caught HERE. deriveStatus already
  // refuses it upstream; this is the second, independent line.
  const r = repo();
  const res = toStageResult(stage(), ctxFor(r, stage()), manifestFor(), [], 0, r);
  assert.equal(res.status, 'failed');
  assert.equal(res.failure?.code, 'no-result');
  assert.equal(res.failure?.retryable, true, 'retrying could plausibly produce the artefact');
});

test('collectObservations keeps one observation per tool step, in its final state', async () => {
  const snapshots = [
    [{ stepIndex: 0, tool: 'Bash', input: 'ls', status: 'active' }],
    [{ stepIndex: 0, tool: 'Bash', input: 'ls', status: 'done' }, { stepIndex: 1, tool: 'Glob', input: '*.ts', status: 'active' }],
    [{ stepIndex: 0, tool: 'Bash', input: 'ls', status: 'done' }, { stepIndex: 1, tool: 'Glob', input: '*.ts', status: 'error' }],
  ];
  let reads = 0;
  const service = {
    activities: async () => snapshots[Math.min(reads++, snapshots.length - 1)],
    state: async () => (reads < snapshots.length ? 'running' : 'succeeded'),
  } as unknown as ForgeService;
  const tapped: string[] = [];
  const out = await collectObservations(service, 'job', 'implement', (_stage, obs) => { tapped.push(`${obs.turn}:${obs.tool}:${obs.ok}`); });
  assert.deepEqual(out.map((o) => [o.turn, o.tool, o.kind]), [[0, 'Bash', 'tool'], [1, 'Glob', 'error']]);
  assert.deepEqual(tapped, ['0:Bash:true', '0:Bash:true', '1:Glob:true', '1:Glob:false'], 'the tap still sees every state change');
});

test('readTail is bounded and null for nothing', () => {
  const r = repo();
  assert.equal(readTail(path.join(r, 'nope.md')), null);
  const at = path.join(r, 'a.md');
  writeFileSync(at, '   \n  ');
  assert.equal(readTail(at), null, 'whitespace is not a report');
  writeFileSync(at, 'z'.repeat(10_000));
  assert.equal((readTail(at) ?? '').length, 4_000);
});

/* ── the whole DAG, with the local quota-free fixture ─────────────────────── */

test('the DAG runs and each stage becomes a real fixture-backed job', async () => {
  const r = repo();
  const service = new ForgeService({ repo: r });
  const runner = createForgeRunner({ service, runId: 'test-dashboard' });
  const runners = { agy: runner };

  // Keep this integration test on the quota-free agy fixture. This fixture only
  // replaces agy, so routing codex or claude here would launch real clients.
  const spec = {
    name: 'dashboard-rework',
    workDir: r,
    stages: [
      { name: 'implement', provider: 'agy', role: 'implement', prompt: 'rebuild the pane' },
      { name: 'review', provider: 'agy', dependsOn: ['implement'], role: 'review', prompt: 'find what is wrong' },
      { name: 'moderate', provider: 'agy', dependsOn: ['review'], role: 'moderate', prompt: 'moderate the review' },
    ],
  };

  const started: string[] = [];
  const ended: string[] = [];
  const run = await runPipeline(spec as never, {
    runner: createRunnerRouter(runners),
    ladders: { agy: { label: 'agy' } },
    onStageStart: (s) => { started.push(s.name); },
    onStageEnd: (res) => { ended.push(`${res.stage}:${res.status}`); },
  });

  assert.equal(run.status, 'passed', JSON.stringify(run.outcomes, null, 2));
  assert.deepEqual(started, ['implement', 'review', 'moderate']);
  assert.deepEqual(ended.sort(), ['implement:passed', 'moderate:passed', 'review:passed']);
  assert.ok((run.peakConcurrency ?? 0) >= 1);

  // Every stage wrote its own artefact, under its own directory. This is the
  // reason the DAG can hand `moderate` an artefact that is not its own review.
  for (const name of ['implement', 'review', 'moderate']) {
    const artifact = stageArtifactPath(pipelineArtifactRoot(r, 'test-dashboard'), name);
    assert.ok(existsSync(artifact), `${name}/result.md exists`);
    assert.match(readFileSync(artifact, 'utf8'), /Fixture report/);
    assert.match(readFileSync(artifact, 'utf8'), /Worker-authored detail preserved/);
  }

  // And every stage is a real job on disk, which is what the pane draws and what
  // the channel announces. No new notification vocabulary was needed.
  const { readAllObservedJobs } = await import('./observe.ts');
  const jobs = await readAllObservedJobs(r);
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map((j) => j.mode).sort(), ['implement', 'moderate', 'review']);
  assert.deepEqual(new Set(jobs.map((j) => j.status)), new Set(['succeeded']));
});

test('a failed stage SKIPS its dependents; it never reports them as passed', async () => {
  const r = repo();
  const service = new ForgeService({ repo: r });
  const runner = createForgeRunner({ service });

  const run = await runPipeline(
    {
      name: 'p',
      workDir: r,
      stages: [
        // The fixture keys on the word "deny", so the FIRST stage fails.
        { name: 'implement', provider: 'agy', role: 'implement', prompt: 'please deny this' },
        { name: 'review', provider: 'codex', dependsOn: ['implement'], prompt: 'review it' },
      ],
    } as never,
    {
      runner: createRunnerRouter({ agy: runner, codex: runner }),
      ladders: { agy: {}, codex: {} },
    },
  );

  assert.equal(run.outcomes['implement']?.status, 'failed');
  assert.equal(run.outcomes['review']?.status, 'skipped', 'never "passed": the review never ran');
  assert.equal(run.outcomes['review']?.skippedBecause?.kind, 'upstream-failed');
  assert.match(run.outcomes['review']?.skippedBecause?.message ?? '', /implement/);
  assert.equal(run.status, 'failed');

});

test('an abort signal stops the worker instead of letting it run to the budget', async () => {
  const r = repo();
  const service = new ForgeService({ repo: r });
  let running = false;
  const runner = createForgeRunner({ service, onStageRunning: () => { running = true; } });
  const controller = new AbortController();
  const ctx = ctxFor(r, stage({ prompt: 'go slow and steady' }));
  ctx.signal = controller.signal;
  const p = runner.run(ctx);
  // Abort once the stage is observed running, not after a guessed delay.
  await waitFor(() => running, { message: 'the stage to start running' });
  controller.abort();

  const res = await p;
  assert.notEqual(res.status, 'passed', 'a stage that was aborted is not a pass');
});

test('continuation handles stay in their provider namespace', async () => {
  for (const priorProvider of ['agy', 'codex']) {
    const r = repo(); const service = new ForgeService({ repo: r });
    const runner = createForgeRunner({ service });
    const ctx = ctxFor(r, stage());
    ctx.attempt = 2;
    ctx.continuation = { attempt: 1, priorStatus: 'failed', transcriptRef: 'prior-thread', transcriptProvider: priorProvider, appendedContext: 'Previous check failed' };
    const outcome = await runner.run(ctx);
    assert.ok(outcome.jobId);
    const argv = JSON.parse(readFileSync(path.join(r, '.agent-smith', 'jobs', outcome.jobId!, 'argv.json'), 'utf8')).argv as string[];
    assert.equal(argv.includes('prior-thread'), priorProvider === 'agy');
  }
});

test('a continuing stage resumes its target worker with the review in its prompt', async () => {
  const store = repo(); const work = repo(); const requests: Array<Record<string, unknown>> = [];
  const review = stageArtifactPath(pipelineArtifactRoot(store, 'fixloop'), 'review');
  mkdirSync(path.dirname(review), { recursive: true });
  writeFileSync(review, 'FINDING-17: the cache is never invalidated');
  const service = { repo: store, spawnTracked: async (request: Record<string, unknown>) => { requests.push(request); throw new Error('fixture stops before launching'); } } as unknown as ForgeService;
  const ctx = ctxFor(work, stage({ name: 'fix', role: 'implement', checks: [{ name: 'unit', command: 'true' }] }), [{ stage: 'review', path: 'result.md' }]);
  ctx.continues = { stage: 'implement', transcriptRef: 'conv-implement', workerId: 'w-impl', agentName: 'builder' };
  await createForgeRunner({ service, runId: 'fixloop' }).run(ctx);
  await createForgeRunner({ service, runId: 'fixloop' }).run({ ...ctx, continues: { stage: 'implement', transcriptRef: 'conv-implement' } });
  const [explicit, defaulted] = requests;
  assert.equal(explicit?.['conversation'], 'conv-implement');
  assert.equal(explicit?.['workerId'], 'w-impl');
  assert.equal(explicit?.['name'], 'builder');
  assert.equal(explicit?.['cwd'], work);
  assert.equal(explicit?.['artifactPath'], stageArtifactPath(pipelineArtifactRoot(store, 'fixloop'), 'fix'), 'the request names the file the prompt tells the worker to write');
  assert.equal(defaulted?.['workerId'], 'fixloop:implement', 'the default identity is the target stage\'s');
  assert.match(String(explicit?.['prompt']), /FINDING-17: the cache is never invalidated/);
  assert.deepEqual(explicit?.['checks'], [{ name: 'unit', command: 'true' }], 'the fix stage\'s own checks reach the resumed worker');
});

test('implement -> review -> fix: the fix stage resumes the implementer and the review is its input', async () => {
  const r = repo(); const service = new ForgeService({ repo: r });
  const run = await runPipeline({
    name: 'fix-loop', workDir: r,
    stages: [
      { name: 'implement', provider: 'agy', role: 'implement', prompt: 'build it' },
      { name: 'review', provider: 'agy', dependsOn: ['implement'], role: 'review', prompt: 'review it' },
      { name: 'fix', provider: 'agy', continues: 'implement', dependsOn: ['review'], role: 'implement', prompt: 'fix it' },
    ],
  } as never, { runner: createRunnerRouter({ agy: createForgeRunner({ service, runId: 'fix-loop' }) }), ladders: { agy: { label: 'agy' } } });
  assert.equal(run.status, 'passed', JSON.stringify(run.outcomes, null, 2));
  const argvOf = (stageName: string): string[] => JSON.parse(readFileSync(path.join(r, '.agent-smith', 'jobs', run.outcomes[stageName]!.jobId!, 'argv.json'), 'utf8')).argv;
  const conversation = run.outcomes['implement']!.transcriptRef!;
  assert.ok(conversation);
  assert.equal(argvOf('fix')[argvOf('fix').indexOf('--conversation') + 1], conversation);
  assert.equal(argvOf('review').includes('--conversation'), false, 'a plain stage starts fresh');
  const worker = async (stageName: string) => (await service.detail(run.outcomes[stageName]!.jobId!)).workerId;
  assert.equal(await worker('fix'), await worker('implement'));
  assert.notEqual(await worker('review'), await worker('implement'));
});

test('pipeline acceptance respects optional preflight failures and mandatory blank checks', async () => {
  for (const [checks, expected] of [
    [[{ name: 'optional', command: 'true', cwd: 'missing', blocking: false }], 'passed'],
    [[{ name: 'mandatory', command: '   ' }], 'failed'],
    [[{ name: 'optional-empty', command: '   ', blocking: false }], 'passed'],
  ] as const) {
    const r = repo(); const service = new ForgeService({ repo: r });
    const outcome = await createForgeRunner({ service }).run(ctxFor(r, stage({ checks: [...checks] })));
    assert.equal(outcome.acceptance, expected);
    assert.equal(outcome.status, expected);
    assert.ok(outcome.verification?.verdicts[0]?.skipped);
  }
});

test('executable stage checks determine acceptance with exit-code evidence', async () => {
  const r = repo();
  const service = new ForgeService({ repo: r });
  const runner = createForgeRunner({ service, runId: 'checks-pass' });
  const passingStage = stage({ checks: [{ name: 'ok', command: 'node -e "process.exit(0)"' }] });
  const passed = await runner.run(ctxFor(r, passingStage));
  assert.equal(passed.status, 'passed');
  assert.equal(passed.acceptance, 'passed');
  assert.equal(passed.jobId !== undefined, true);
  assert.equal(passed.verification?.verdicts[0]?.exitCode, 0);

  const failingRunner = createForgeRunner({ service, runId: 'checks-fail' });
  const failingStage = stage({ checks: [{ name: 'tests', command: 'node -e "process.exit(1)"' }] });
  const failed = await failingRunner.run(ctxFor(r, failingStage));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.acceptance, 'failed');
  assert.equal(failed.failure?.code, 'verification-failed');
  assert.match(failed.failure?.message ?? '', /tests/);
  assert.equal(failed.verification?.verdicts[0]?.exitCode, 1);
});

test("a stage's job carries its acceptance, pending while checks run and decided after", async () => {
  const r = repo();
  const service = new ForgeService({ repo: r });
  // The check reads the job's acceptance sidecar from inside the running check.
  const probe = path.join(r, 'probe.cjs');
  writeFileSync(probe, "const fs=require('fs'),p=require('path');const [dir,out]=process.argv.slice(2);" +
    "const id=fs.readdirSync(dir)[0];fs.copyFileSync(p.join(dir,id,'acceptance.json'),out);");
  const seen = path.join(r, 'seen.json');
  const command = `node ${probe} ${jobsDir(r)} ${seen}`;
  const passed = await createForgeRunner({ service, runId: 'job-acc-pass' }).run(ctxFor(r, stage({ checks: [{ name: 'probe', command }] })));
  assert.equal(passed.acceptance, 'passed');
  assert.equal(JSON.parse(readFileSync(seen, 'utf8')).pending, true, 'checks pending, not a premature verdict');
  const accepted = readAcceptance(r, passed.jobId!);
  assert.equal(accepted.state, 'accepted');
  assert.equal((accepted as { pending?: boolean }).pending, undefined);

  const failed = await createForgeRunner({ service, runId: 'job-acc-fail' }).run(
    ctxFor(r, stage({ checks: [{ name: 'tests', command: 'node -e "process.exit(1)"' }] })));
  assert.equal(failed.acceptance, 'failed');
  const rejected = readAcceptance(r, failed.jobId!) as { state: string; checks: { name: string; ok: boolean }[] };
  assert.equal(rejected.state, 'rejected', 'status <jobId> agrees with pipeline_status');
  assert.deepEqual(rejected.checks.map((c) => [c.name, c.ok]), [['tests', false]]);

  const denied = await createForgeRunner({ service, runId: 'job-acc-denied' }).run(
    ctxFor(r, stage({ prompt: 'deny everything', checks: [{ name: 'never', command: 'true' }] })));
  assert.equal(denied.status, 'failed');
  const unrun = readAcceptance(r, denied.jobId!) as { state: string; pending?: boolean };
  assert.equal(unrun.state, 'rejected', 'a failed job does not stay pending forever');
  assert.equal(unrun.pending, undefined);
});

/* ── cross-family enforcement ──────────────────────────────────────────────── */

test('a same-family moderator is refused by construction, not by review', () => {
  // Same-family agreement is correlated (ICML 2025: 60% agreement when both err),
  // so a moderator from the implementer's own family manufactures confirmation.
  assert.throws(
    () => moderateStage({ name: 'moderate', probes: 'implement', provider: 'claude', model: 'gpt-5.6-sol', reviewedModel: 'gpt-5.6-mini' }),
    CrossFamilyViolation,
  );
  // A genuinely different family passes.
  const m = moderateStage({
    name: 'moderate',
    probes: 'implement',
    provider: 'claude',
    model: 'sonnet',
    reviewedModel: 'gemini-3.8-flash-high',
  });
  assert.equal(m.provider, 'claude');
  assert.deepEqual(m.dependsOn, ['implement']);
  assert.equal(m.routingPinned, true);
});

function readFileSyncUtf8(p: string): string {
  // Local import-free helper: this suite's other fs use is via the named imports
  // above, and adding one more named import for a single call would obscure that.
  const { readFileSync } = fs;
  return readFileSync(p, 'utf8');
}
import * as fs from 'node:fs';
