/**
 * pipeline tests — DAG shape, concurrency, failure propagation, escalation.
 *
 * The concurrency tests use a gate rather than sleeps: a stage blocks until the
 * test releases it, so "did these two stages overlap?" is answered by whether
 * both entered before either exited — which is deterministic, unlike timing.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createRunnerRouter,
  DEFAULT_CONCURRENCY,
  PipelineSpecError,
  runPipeline,
  validateSpec,
  type RunOptions,
} from './pipeline.ts';
import { DEFAULT_STALL_POLICY } from './routing.ts';
import type {
  Observation,
  PipelineSpec,
  Stage,
  StageContext,
  StageResult,
  StageRunner,
} from './types.ts';

const WORKDIR = process.cwd();

function stage(name: string, extra: Partial<Stage> = {}): Stage {
  return { name, provider: 'gemini', ...extra };
}

function spec(name: string, stages: Stage[], rest: Partial<PipelineSpec> = {}): PipelineSpec {
  return { name, stages, workDir: WORKDIR, ...rest };
}

function ok(ctx: StageContext, extra: Partial<StageResult> = {}): StageResult {
  const now = Date.now();
  return {
    stage: ctx.stage.name,
    provider: ctx.routing.provider,
    model: ctx.routing.model,
    status: 'passed',
    startedAt: now,
    finishedAt: now,
    durationMs: 1,
    resultPath: 'result.md',
    ...extra,
  };
}

function boom(ctx: StageContext, extra: Partial<StageResult> = {}): StageResult {
  return {
    ...ok(ctx),
    status: 'failed',
    resultPath: undefined,
    failure: { code: 'exit-1', message: 'worker failed' },
    ...extra,
  };
}

/** A runner whose stages block until the test opens the gate. */
function gatedRunner() {
  const started: string[] = [];
  const contexts: StageContext[] = [];
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const runner: StageRunner = {
    id: 'gated',
    async run(ctx: StageContext): Promise<StageResult> {
      started.push(ctx.stage.name);
      contexts.push(ctx);
      await gate;
      return ok(ctx);
    },
  };
  return { runner, started, contexts, open: () => open() };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Three identical errors — the reference 28-minute job had ONE, at tool #34 of 484. */
const repeatSignature = (message: string): Observation[] =>
  [10, 11, 12].map((turn) => ({ turn, kind: 'error', message }) as Observation);

/* ------------------------------- validation ------------------------------- */

test('validateSpec rejects duplicate stage names', () => {
  assert.throws(() => validateSpec(spec('s', [stage('a'), stage('a')])), PipelineSpecError);
});

test('validateSpec rejects an unknown dependency', () => {
  assert.throws(
    () => validateSpec(spec('s', [stage('a', { dependsOn: ['ghost'] })])),
    /depends on 'ghost', which does not exist/,
  );
});

test('validateSpec rejects a self-dependency', () => {
  assert.throws(() => validateSpec(spec('s', [stage('a', { dependsOn: ['a'] })])), /depends on itself/);
});

test('validateSpec rejects a cycle', () => {
  const cyclic = spec('s', [
    stage('a', { dependsOn: ['c'] }),
    stage('b', { dependsOn: ['a'] }),
    stage('c', { dependsOn: ['b'] }),
  ]);
  assert.throws(() => validateSpec(cyclic), /cycle/);
});

test('validateSpec accepts a diamond', () => {
  const diamond = spec('s', [
    stage('a'),
    stage('b', { dependsOn: ['a'] }),
    stage('c', { dependsOn: ['a'] }),
    stage('d', { dependsOn: ['b', 'c'] }),
  ]);
  assert.doesNotThrow(() => validateSpec(diamond));
});

/* ------------------------------- concurrency ------------------------------- */

test('independent stages run concurrently, not in order', async () => {
  const { runner, started, open } = gatedRunner();
  const run = runPipeline(
    spec('wide', [stage('a'), stage('b'), stage('c')]),
    { runner, workDir: WORKDIR },
  );

  // The real assertion: all three ENTERED before any of them could EXIT. If the
  // runner serialized them, the first would still be parked here.
  await waitFor(() => started.length === 3, 'all three stages to start');
  assert.deepEqual([...started].sort(), ['a', 'b', 'c']);
  open();

  const result = await run;
  assert.equal(result.peakConcurrency, 3);
  assert.equal(result.status, 'passed');
});

test('the concurrency cap is respected exactly', async () => {
  const { runner, started, open } = gatedRunner();
  const stages = ['a', 'b', 'c', 'd', 'e'].map((n) => stage(n));
  const run = runPipeline(spec('capped', stages), { runner, workDir: WORKDIR, concurrency: 2 });

  await waitFor(() => started.length === 2, 'two stages to start');
  // Give the loop ample opportunity to over-dispatch before asserting.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(started.length, 2, 'must not exceed the cap');

  open();
  const result = await run;
  assert.equal(result.peakConcurrency, 2);
  assert.equal(Object.keys(result.outcomes).length, 5);
});

test('a dependent stage starts only after its dependency passes', async () => {
  const order: string[] = [];
  const events: string[] = [];
  const runner: StageRunner = {
    id: 'ordered',
    async run(ctx: StageContext): Promise<StageResult> {
      events.push(`start:${ctx.stage.name}`);
      // A short real delay so an incorrectly-parallel run is observable.
      await new Promise((r) => setTimeout(r, 20));
      events.push(`end:${ctx.stage.name}`);
      return ok(ctx);
    },
  };

  const result = await runPipeline(
    spec('chain', [stage('a'), stage('b', { dependsOn: ['a'] }), stage('c', { dependsOn: ['b'] })]),
    { runner, workDir: WORKDIR, onStageEnd: (r) => void order.push(r.stage) },
  );

  assert.equal(result.status, 'passed');
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(events, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  assert.equal(result.peakConcurrency, 1);
});

test('a slow stage does not block an unrelated ready stage', async () => {
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const runner: StageRunner = {
    id: 'mixed',
    async run(ctx: StageContext): Promise<StageResult> {
      started.push(ctx.stage.name);
      if (ctx.stage.name === 'slow') {
        await new Promise<void>((resolve) => gates.set('slow', resolve));
      }
      return ok(ctx);
    },
  };

  const run = runPipeline(
    spec('mixed', [stage('slow'), stage('quick'), stage('after', { dependsOn: ['quick'] })]),
    { runner, workDir: WORKDIR, concurrency: 3 },
  );

  // 'after' depends only on 'quick', so it must be able to run while 'slow' is
  // still parked. A wave-based scheduler would idle here until 'slow' finished.
  await waitFor(() => started.includes('after'), "'after' to run while 'slow' is parked");
  gates.get('slow')?.();
  const result = await run;
  assert.equal(result.status, 'passed');
  // Two, not three: 'quick' frees its slot before 'after' takes it, so the
  // maximum simultaneous count is slow+quick, then slow+after.
  assert.equal(result.peakConcurrency, 2);
  assert.deepEqual([...started].sort(), ['after', 'quick', 'slow']);
});

test('the default concurrency cap is the documented value', () => {
  assert.equal(DEFAULT_CONCURRENCY, 8);
});

/* ---------------------------- failure propagation ---------------------------- */

test('a failed stage skips its dependents with a written reason', async () => {
  const runner: StageRunner = {
    id: 'flaky',
    async run(ctx: StageContext): Promise<StageResult> {
      return ctx.stage.name === 'implement' ? boom(ctx) : ok(ctx);
    },
  };

  const result = await runPipeline(
    spec('failing', [
      stage('implement'),
      stage('review', { dependsOn: ['implement'] }),
      stage('moderate', { dependsOn: ['review'] }),
    ]),
    { runner, workDir: WORKDIR },
  );

  const review = result.outcomes['review'];
  const moderate = result.outcomes['moderate'];
  assert.equal(review?.status, 'skipped');
  assert.equal(moderate?.status, 'skipped');

  // Skipped, never 'failed': these stages did not run, and calling them failed
  // would misreport work that never happened.
  assert.equal(review?.failure, undefined);
  assert.equal(review?.skippedBecause?.kind, 'upstream-failed');
  assert.equal(review?.skippedBecause?.becauseOf, 'implement');
  assert.match(review?.skippedBecause?.message ?? '', /implement' finished 'failed'/);
  assert.match(review?.skippedBecause?.message ?? '', /exit-1/);

  // The chain cascades to a reason naming the ORIGINAL failure.
  assert.equal(moderate?.skippedBecause?.becauseOf, 'review');
  assert.equal(result.status, 'failed');
});

test('a partially satisfied pipeline reports partial, not failed', async () => {
  const runner: StageRunner = {
    id: 'partial',
    async run(ctx: StageContext): Promise<StageResult> {
      return ctx.stage.name === 'implement' ? boom(ctx) : ok(ctx);
    },
  };
  const result = await runPipeline(
    spec('partial', [stage('implement'), stage('independent')]),
    { runner, workDir: WORKDIR },
  );
  assert.equal(result.status, 'partial');
});

test('a runner that throws becomes a failed result, not a rejection', async () => {
  const runner: StageRunner = {
    id: 'thrower',
    async run(): Promise<StageResult> {
      throw new Error('provider socket closed');
    },
  };
  const result = await runPipeline(spec('boom', [stage('a'), stage('b', { dependsOn: ['a'] })]), {
    runner,
    workDir: WORKDIR,
  });
  assert.equal(result.outcomes['a']?.status, 'failed');
  assert.equal(result.outcomes['a']?.failure?.code, 'runner-threw');
  assert.match(result.outcomes['a']?.failure?.message ?? '', /provider socket closed/);
  assert.equal(result.outcomes['b']?.status, 'skipped');
});

/* ------------------------------- escalation ------------------------------- */

test('a repeated signature escalates exactly once, by continuing', async () => {
  const contexts: StageContext[] = [];
  const runner: StageRunner = {
    id: 'escalating',
    async run(ctx: StageContext): Promise<StageResult> {
      contexts.push(ctx);
      if (ctx.attempt === 1) {
        return boom(ctx, {
          observations: repeatSignature("Cannot find module './missing'"),
          transcriptRef: 'conv-123',
          outputTail: 'tsc: cannot resolve ./missing',
        });
      }
      return ok(ctx);
    },
  };

  const result = await runPipeline(spec('esc', [stage('implement')]), {
    runner,
    workDir: WORKDIR,
    policy: { ...DEFAULT_STALL_POLICY, maxEscalations: 2 },
  });

  assert.equal(result.status, 'passed');
  assert.equal(contexts.length, 2);

  // RULE 3: the second attempt CONTINUES from the first attempt's transcript. A
  // restart would be a fresh context with no continuation.
  const second = contexts[1];
  assert.ok(second);
  assert.equal(second.attempt, 2);
  assert.equal(second.continuation?.transcriptRef, 'conv-123');
  assert.match(second.continuation?.appendedContext ?? '', /same failure repeated 3x/);

  // Escalation moved UP the ladder, and only from the cheap default.
  assert.equal(contexts[0]?.routing.tier, 't0-cheap');
  assert.equal(contexts[0]?.routing.effort, 'low');
  assert.equal(second.routing.tier, 't1-effort');
  assert.equal(second.routing.effort, 'high');

  const escalations = result.outcomes['implement']?.escalations ?? [];
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0]?.fromEffort, 'low');
  assert.equal(escalations[0]?.toEffort, 'high');
});

test('a single distinct error does NOT escalate (tool #34 of 484 still succeeded)', async () => {
  const contexts: StageContext[] = [];
  const runner: StageRunner = {
    id: 'quiet',
    async run(ctx: StageContext): Promise<StageResult> {
      contexts.push(ctx);
      if (ctx.attempt === 1) {
        return boom(ctx, {
          observations: [
            { turn: 34, kind: 'tool', tool: 'bash', ok: false, message: 'grep found no matches in src/' },
            { turn: 35, kind: 'tool', tool: 'read', ok: true },
            { turn: 36, kind: 'edit', target: 'src/a.ts' },
            { turn: 37, kind: 'verification', target: 'typecheck', ok: true },
          ],
        });
      }
      return ok(ctx);
    },
  };

  const result = await runPipeline(spec('quiet', [stage('implement')]), { runner, workDir: WORKDIR });

  // Exactly one attempt: no escalation was spent on an ordinary error.
  assert.equal(contexts.length, 1);
  assert.equal(result.status, 'failed');
  assert.match(result.outcomes['implement']?.failure?.message ?? '', /no stall shape/);
});

test('escalation stops at the ceiling and keeps the evidence', async () => {
  let calls = 0;
  const runner: StageRunner = {
    id: 'always-stalled',
    async run(ctx: StageContext): Promise<StageResult> {
      calls += 1;
      return boom(ctx, { observations: repeatSignature('tsc: type error TS2304') });
    },
  };

  const result = await runPipeline(spec('ceiling', [stage('implement')]), {
    runner,
    workDir: WORKDIR,
    policy: { ...DEFAULT_STALL_POLICY, maxEscalations: 2 },
  });

  // 1 initial attempt + 2 escalations, then a stop.
  assert.equal(calls, 3);
  assert.equal(result.status, 'failed');
  assert.equal(result.outcomes['implement']?.failure?.code, 'escalation-ceiling');
  assert.match(result.outcomes['implement']?.failure?.message ?? '', /stall shape 'repeat-signature'/);
});

test('no observations means no escalation', async () => {
  let calls = 0;
  const runner: StageRunner = {
    id: 'silent',
    async run(ctx: StageContext): Promise<StageResult> {
      calls += 1;
      return calls === 1 ? boom(ctx) : ok(ctx);
    },
  };
  const result = await runPipeline(spec('silent', [stage('a')]), { runner, workDir: WORKDIR });
  assert.equal(calls, 1);
  assert.equal(result.status, 'failed');
});

/* ------------------------------ abort & timeout ------------------------------ */

test('an aborted run fails the in-flight stage and skips the rest', async () => {
  const controller = new AbortController();
  const started: string[] = [];
  const runner: StageRunner = {
    id: 'abortable',
    async run(ctx: StageContext): Promise<StageResult> {
      started.push(ctx.stage.name);
      if (ctx.stage.name === 'a') {
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return ok(ctx);
      }
      return ok(ctx);
    },
  };

  const run = runPipeline(spec('abort', [stage('a'), stage('b', { dependsOn: ['a'] })]), {
    runner,
    workDir: WORKDIR,
    signal: controller.signal,
  });

  await waitFor(() => started.includes('a'), 'stage a to start');
  controller.abort();
  const result = await run;

  assert.equal(result.aborted, true);
  assert.equal(result.outcomes['a']?.status, 'failed');
  // A runner that reported success after its signal fired is not a success.
  assert.equal(result.outcomes['a']?.failure?.code, 'timeout');
  assert.equal(result.outcomes['b']?.status, 'skipped');
});

test('a stage timeout is enforced', async () => {
  const runner: StageRunner = {
    id: 'hangs',
    async run(ctx: StageContext): Promise<StageResult> {
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return ok(ctx);
    },
  };
  const result = await runPipeline(
    spec('timeout', [stage('hang', { timeoutMs: 30 })]),
    { runner, workDir: WORKDIR },
  );
  assert.equal(result.outcomes['hang']?.status, 'failed');
  assert.equal(result.outcomes['hang']?.failure?.code, 'timeout');
  // A timeout is not a reasoning failure, so it must not consume an escalation.
  assert.equal(result.outcomes['hang']?.escalations, undefined);
  assert.match(result.outcomes['hang']?.failure?.message ?? '', /abort signal fired/);
  assert.match(result.outcomes['hang']?.failure?.message ?? '', /timeoutMs=30/);
});

/* ------------------------------ injection point ------------------------------ */

test('createRunnerRouter dispatches by stage provider', async () => {
  const seen: string[] = [];
  const make = (id: string): StageRunner => ({
    id,
    async run(ctx: StageContext): Promise<StageResult> {
      seen.push(id);
      return ok(ctx);
    },
  });

  const router = createRunnerRouter({ gemini: make('gemini'), codex: make('codex'), claude: make('claude') });
  const result = await runPipeline(
    spec('mixed', [
      stage('implement', { provider: 'gemini' }),
      stage('review', { provider: 'codex', model: 'gpt-5.6-sol', dependsOn: ['implement'] }),
      stage('moderate', { provider: 'claude', model: 'claude-sonnet', dependsOn: ['review'] }),
    ]),
    { runner: router, workDir: WORKDIR },
  );

  assert.equal(result.status, 'passed');
  assert.deepEqual(seen, ['gemini', 'codex', 'claude']);
});

test('a missing runner is reported as wiring, not as a provider failure', async () => {
  const trivial: StageRunner = { id: 'g', run: async (ctx) => ok(ctx) };
  const router = createRunnerRouter({ gemini: trivial });
  const result = await runPipeline(spec('unwired', [stage('x', { provider: 'nope' })]), {
    runner: router,
    workDir: WORKDIR,
  });
  const failure = result.outcomes['x']?.failure;
  assert.equal(failure?.code, 'no-runner');
  assert.equal(failure?.retryable, false);
  assert.match(failure?.message ?? '', /registered: gemini/);
});

/* --------------------------------- handoff --------------------------------- */

test('a dependent stage receives the upstream artifact path', async () => {
  const { runner, contexts, open } = gatedRunner();
  const run = runPipeline(
    spec('handoff', [
      stage('implement', { resultPath: 'out/result.md' }),
      stage('review', { dependsOn: ['implement'] }),
    ]),
    { runner, workDir: WORKDIR },
  );
  await waitFor(() => contexts.length > 0, 'implement to start');
  open();
  await run;

  const review = contexts.find((c) => c.stage.name === 'review');
  assert.ok(review, 'review stage should have run');
  assert.deepEqual(review.inputs, [{ stage: 'implement', path: 'out/result.md', label: 'out/result.md' }]);
});

/* ------------------------------- hooks ------------------------------- */

test('lifecycle hooks fire for skipped stages too', async () => {
  const started: string[] = [];
  const ended: string[] = [];
  const runner: StageRunner = {
    id: 'hooked',
    async run(ctx: StageContext): Promise<StageResult> {
      return ctx.stage.name === 'a' ? boom(ctx) : ok(ctx);
    },
  };
  const options: RunOptions = {
    runner,
    workDir: WORKDIR,
    onStageStart: (s) => void started.push(s.name),
    onStageEnd: (r) => void ended.push(`${r.stage}:${r.status}`),
  };
  await runPipeline(
    spec('hooked', [stage('a'), stage('b', { dependsOn: ['a'] }), stage('c', { dependsOn: ['b'] })]),
    options,
  );
  assert.deepEqual(started, ['a']);
  // A skipped stage is not started, but it MUST still be reported — silence
  // here is what makes a partial pipeline look like a complete one.
  assert.deepEqual(ended, ['a:failed', 'b:skipped', 'c:skipped']);
});