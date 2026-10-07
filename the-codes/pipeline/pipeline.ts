/**
 * pipeline/pipeline.ts — the DAG runner.
 *
 * The one behaviour that justifies this file existing: **independent stages run
 * concurrently.** The motivating measurement was 16 jobs across 16.3 hours of
 * wall clock at a ceiling of 3 concurrent. A runner that walks stages in order,
 * or that serializes stages to keep a graph tidy, reproduces that exact
 * pathology. Concurrency here is not an optimisation; it is the product.
 *
 * Design notes worth knowing before editing:
 *
 *  - Scheduling is event-driven, not wave-based. A long `review` running at the
 *    same time as a 30-second `test` must not block the next stage from
 *    starting the moment `test` finishes. Dispatch happens whenever a slot frees
 *    or a stage settles, which keeps slots busy right up to the concurrency
 *    ceiling instead of idling at the end of every barrier.
 *
 *  - Failure propagates as `skipped`, never as `failed`. A dependent of a failed
 *    stage never ran, so calling it failed would be a lie about work that did
 *    not happen. It carries a `SkipReason` naming the upstream stage.
 *
 *  - The runner never interprets prose. Escalation decisions come from
 *    routing.ts over structured `Observation[]`; this file only moves the rung
 *    and records why.
 */

import {
  assessStall,
  DEFAULT_STALL_POLICY,
  nextRouting,
  planInitialRouting,
  type ProviderLadder,
  type StallPolicy,
} from './routing.ts';
import type {
  ArtifactRef,
  Escalation,
  PipelineRun,
  PipelineSpec,
  PipelineStatus,
  Stage,
  StageContext,
  StageContinuation,
  StageResult,
  StageRunner,
  StageStatus,
} from './types.ts';

/**
 * Default ceiling on simultaneous stages.
 *
 * Not 3: that is the measured value that produced 16.3h for 16 jobs, and it is
 * an artifact of a queue that did not know stages were independent.
 *
 * Not Infinity: providers rate-limit, and a provider that silently throttles
 * looks exactly like a provider that is slow for reasons you cannot see. 8 is a
 * starting point for one pipeline, not a global fleet cap — the caller is
 * expected to keep the *fleet* total in budget, since this number bounds one
 * spec only. Raise it with evidence, not optimism.
 */
export const DEFAULT_CONCURRENCY = 8;

export interface RunOptions {
  /** THE INJECTION POINT. Required: this package never imports providers/. */
  runner: StageRunner;
  /** Overrides spec.concurrency. */
  concurrency?: number | undefined;
  /** Base directory for relative stage paths. Defaults to spec.workDir or cwd. */
  workDir?: string | undefined;
  /** Stall detection thresholds and escalation ceiling. */
  policy?: StallPolicy | undefined;
  /** Declared provider capabilities, for routing's ladder. */
  ladders?: Readonly<Record<string, ProviderLadder>> | undefined;
  /** Abort the whole run. In-flight runners are signalled via StageContext.signal. */
  signal?: AbortSignal | undefined;
  /** Called as a stage starts. For the mod surface. Must not throw. */
  onStageStart?: (stage: Stage, attempt: number) => void | undefined;
  /** Called when a stage reaches a terminal state, including 'skipped'. */
  onStageEnd?: (result: StageResult) => void | undefined;
  /** Injectable clock, so tests can assert on timing. */
  now?: (() => number) | undefined;
}

/** Raised for a malformed spec. Cheap to catch, expensive to debug at runtime. */
export class PipelineSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineSpecError';
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Validate names, dependency edges and acyclicity.
 *
 * Cycle detection is done here rather than tolerated at runtime because a cycle
 * would silently produce a run where nothing ever dispatches — which looks
 * identical to "all my stages are pending". Failing at spec time names the
 * offending edge.
 */
export function validateSpec(spec: PipelineSpec): void {
  const seen = new Set<string>();
  for (const stage of spec.stages) {
    if (stage.name.length === 0) {
      throw new PipelineSpecError('every stage needs a name');
    }
    if (seen.has(stage.name)) {
      throw new PipelineSpecError(`duplicate stage name '${stage.name}'`);
    }
    seen.add(stage.name);
  }
  for (const stage of spec.stages) {
    for (const dep of stage.dependsOn ?? []) {
      if (!seen.has(dep)) {
        throw new PipelineSpecError(
          `stage '${stage.name}' depends on '${dep}', which does not exist`,
        );
      }
      if (dep === stage.name) {
        throw new PipelineSpecError(`stage '${stage.name}' depends on itself`);
      }
    }
  }

  // Kahn's algorithm; whatever remains in `pending` is on or behind a cycle.
  const pending = new Set(spec.stages.map((s) => s.name));
  const resolved = new Set<string>();
  let progress = true;
  while (pending.size > 0 && progress) {
    progress = false;
    for (const stage of spec.stages) {
      if (!pending.has(stage.name)) continue;
      const deps = stage.dependsOn ?? [];
      if (deps.every((d) => resolved.has(d))) {
        pending.delete(stage.name);
        resolved.add(stage.name);
        progress = true;
      }
    }
  }
  if (pending.size > 0) {
    throw new PipelineSpecError(
      `dependency cycle among stages: ${[...pending].sort().join(', ')}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Concurrency primitive                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A counting semaphore with an explicit "slot freed" signal.
 *
 * Why not `Promise.all` over ready stages? Because there is no cap. Why not a
 * fixed pool of N workers pulling from a queue? Because the queue would have to
 * be re-sorted on every settle to preserve readiness, which is the same
 * bookkeeping with less visibility. This is the smallest thing that gives both
 * the cap and the wakeup.
 */
class Scheduler {
  private active = 0;
  private slotWaiters: Array<() => void> = [];
  private settleWaiters: Array<() => void> = [];
  // Declared explicitly, not a constructor parameter property: this project sets
  // `erasableSyntaxOnly`, so the code must survive type-stripping with no emit.
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Stages in flight right now. Read by the loop for peak tracking. */
  get activeCount(): number {
    return this.active;
  }

  hasSlot(): boolean {
    return this.active < this.limit;
  }

  enter(): void {
    this.active += 1;
  }

  /** Wake everything parked on a free slot, and anyone waiting on a settle. */
  release(): void {
    this.active -= 1;
    const slots = this.slotWaiters;
    this.slotWaiters = [];
    for (const wake of slots) wake();
    this.wakeSettle();
  }

  private wakeSettle(): void {
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const wake of waiters) wake();
  }

  /** Resolves when a slot frees, or immediately if one is free. */
  whenSlotFree(): Promise<void> {
    if (this.hasSlot()) return Promise.resolve();
    return new Promise<void>((resolve) => this.slotWaiters.push(resolve));
  }

  /** Resolves when any stage settles. */
  whenSettled(): Promise<void> {
    return new Promise<void>((resolve) => this.settleWaiters.push(resolve));
  }
}

/* -------------------------------------------------------------------------- */
/* Injection helper                                                            */
/* -------------------------------------------------------------------------- */

/**
 * THE INJECTION POINT, concretely.
 *
 * Builds a StageRunner that dispatches by `stage.provider`, so a spec can mix
 * providers per stage while the pipeline sees exactly one runner. core/ (or the
 * binary) constructs the provider runners and calls this at the composition
 * root; pipeline/ and verify/ stay ignorant of every worker's API.
 *
 *     const runner = createRunnerRouter({
 *       gemini: makeGeminiRunner(clients),
 *       codex:  makeCodexRunner(clients),
 *     });
 *
 * Cross-family escalation (routing's t3 rung) relies on this: when routing
 * moves a stage to a different family, the pipeline re-resolves the runner for
 * the stage's provider at the next attempt and the new worker resumes the
 * transcript rather than restarting the task.
 */
export function createRunnerRouter(runners: Readonly<Record<string, StageRunner>>): StageRunner {
  return {
    id: 'router',
    async run(ctx: StageContext): Promise<StageResult> {
      const runner = runners[ctx.stage.provider] ?? runners[ctx.routing.provider];
      if (!runner) {
        return failedResult(ctx, {
          code: 'no-runner',
          message:
            `no StageRunner registered for provider '${ctx.stage.provider}' ` +
            `(registered: ${Object.keys(runners).sort().join(', ') || 'none'}). ` +
            'This is a wiring gap in core/, not a provider failure.',
          retryable: false,
        });
      }
      return runner.run(ctx);
    },
  };
}

/** Standard result for a stage that never really ran. */
function failedResult(
  ctx: StageContext,
  failure: NonNullable<StageResult['failure']>,
): StageResult {
  const now = Date.now();
  return {
    stage: ctx.stage.name,
    provider: ctx.routing.provider,
    model: ctx.routing.model,
    status: 'failed',
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    failure,
  };
}

/* -------------------------------------------------------------------------- */
/* The runner                                                                  */
/* -------------------------------------------------------------------------- */

export async function runPipeline(
  spec: PipelineSpec,
  options: RunOptions,
): Promise<PipelineRun> {
  validateSpec(spec);

  const now = options.now ?? Date.now;
  const startedAt = now();
  const workDir = options.workDir ?? spec.workDir ?? process.cwd();
  const limit = normalizeConcurrency(options.concurrency ?? spec.concurrency);
  const policy = options.policy ?? DEFAULT_STALL_POLICY;

  const abort = new AbortController();
  const parentSignal = options.signal;
  if (parentSignal) {
    // Captured in a local: narrowing on `options.signal` does not survive into
    // the closure below, and `exactOptionalPropertyTypes` keeps it optional.
    const onAbort = () => abort.abort(parentSignal.reason);
    if (parentSignal.aborted) onAbort();
    else parentSignal.addEventListener('abort', onAbort, { once: true });
  }

  const stages = new Map<string, Stage>(spec.stages.map((s) => [s.name, s]));
  const outcomes = new Map<string, StageResult>();
  const skipped = new Set<string>();
  /**
   * Stages that have been dispatched at least once.
   *
   * Separate from `outcomes` on purpose: a dispatched stage is neither passed nor
   * finished, so readiness alone would re-dispatch it on the very next loop
   * iteration. Dispatch is tracked by "has this been started", completion by
   * "is there a result" — conflating the two is how a DAG runner ends up
   * running `implement` eight times in a row.
   */
  const started = new Set<string>();
  /** Stages currently in flight, so a timeout can abort exactly one attempt. */
  const inflight = new Map<string, AbortController>();
  const scheduler = new Scheduler(limit);
  const order: string[] = [];
  let peakConcurrency = 0;
  let aborted = false;

  const depsOf = (stage: Stage): readonly string[] => stage.dependsOn ?? [];

  /** A stage is dispatchable when it is unstarted, not skipped, and every dep passed. */
  const isDispatchable = (stage: Stage): boolean => {
    if (started.has(stage.name) || outcomes.has(stage.name) || skipped.has(stage.name)) return false;
    return depsOf(stage).every((d) => outcomes.get(d)?.status === 'passed');
  };

  /**
   * Cascade `skipped` forward from anything not 'passed'.
   *
   * Iterated to a fixed point so a three-deep chain settles in one pass and the
   * reason reported names the *originating* failure rather than the neighbour
   * that happened to be checked first.
   */
  const propagateSkips = (): void => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const stage of spec.stages) {
        if (outcomes.has(stage.name) || skipped.has(stage.name)) continue;
        for (const dep of depsOf(stage)) {
          const upstream = outcomes.get(dep);
          if (skipped.has(dep)) {
            skipStage(stage, 'upstream-skipped', dep, `skipped because upstream '${dep}' was skipped`);
            changed = true;
            break;
          }
          if (upstream && upstream.status !== 'passed') {
            skipStage(
              stage,
              'upstream-failed',
              dep,
              `not run: upstream '${dep}' finished '${upstream.status}'` +
                (upstream.failure ? ` (${upstream.failure.code}: ${upstream.failure.message})` : ''),
            );
            changed = true;
            break;
          }
        }
      }
    }
  };

  const skipStage = (
    stage: Stage,
    kind: NonNullable<StageResult['skippedBecause']>['kind'],
    becauseOf: string,
    message: string,
  ): void => {
    const t = now();
    const result: StageResult = {
      stage: stage.name,
      provider: stage.provider,
      model: stage.model,
      status: 'skipped',
      startedAt: t,
      finishedAt: t,
      durationMs: 0,
      skippedBecause: { kind, becauseOf, message },
    };
    skipped.add(stage.name);
    outcomes.set(stage.name, result);
    order.push(stage.name);
    options.onStageEnd?.(result);
  };

  /**
   * Inputs for a stage: every upstream artifact, in dependency order.
   *
   * Artifacts, not summaries. A downstream stage that needs to know what the
   * upstream stage concluded reads the upstream stage's own result.md, because
   * a summary written by a model is the thing most likely to be confidently
   * wrong (see verify/runner.ts for why prose is not a verdict).
   */
  const inputsFor = (stage: Stage): readonly ArtifactRef[] => {
    const inherited: ArtifactRef[] = [];
    for (const dep of depsOf(stage)) {
      const upstream = outcomes.get(dep);
      if (!upstream) continue;
      const declaredPath = stages.get(dep)?.resultPath ?? 'result.md';
      inherited.push({ stage: dep, path: declaredPath, label: declaredPath });
      // Anything the upstream stage advertised beyond its main result.
      for (const art of upstream.artifacts ?? []) {
        if (art.path !== declaredPath) inherited.push(art);
      }
    }
    return [...inherited, ...(stage.consumes ?? [])];
  };

  /**
   * One stage, including its escalation ladder.
   *
   * RULE 3: every escalation after the first is a *continuation*. The previous
   * attempt's transcript reference and its failing tail are handed to the next
   * attempt so the worker resumes rather than starts over.
   */
  const runStage = async (stage: Stage): Promise<void> => {
    const stageStart = now();
    let attempt = 1;
    let continuation: StageContinuation | undefined;
    const escalations: Escalation[] = [];
    let routing = planInitialRouting(stage, options.ladders);

    for (;;) {
      if (abort.signal.aborted) {
        aborted = true;
        const t = now();
        outcomes.set(stage.name, {
          stage: stage.name,
          provider: routing.provider,
          model: routing.model,
          status: 'failed',
          startedAt: stageStart,
          finishedAt: t,
          durationMs: t - stageStart,
          failure: {
            code: 'aborted',
            message: 'pipeline aborted before this stage completed',
            retryable: false,
          },
          ...(escalations.length > 0 ? { escalations } : {}),
        });
        order.push(stage.name);
        return;
      }

      // Per-stage timeout: abort this attempt's signal without touching the run.
      const stageAbort = new AbortController();
      inflight.set(stage.name, stageAbort);
      if (abort.signal.aborted) stageAbort.abort(abort.signal.reason);

      const onParentAbort = () => stageAbort.abort(abort.signal.reason);
      abort.signal.addEventListener('abort', onParentAbort, { once: true });
      const timer = stage.timeoutMs
        ? setTimeout(() => stageAbort.abort(new Error(`stage timeout after ${stage.timeoutMs}ms`)), stage.timeoutMs)
        : undefined;

      options.onStageStart?.(stage, attempt);
      const ctx: StageContext = {
        pipeline: spec.name,
        stage,
        attempt,
        workDir: stage.workDir ? `${workDir}/${stage.workDir}` : workDir,
        inputs: inputsFor(stage),
        routing,
        ...(continuation ? { continuation } : {}),
        signal: stageAbort.signal,
      };

      let result: StageResult;
      try {
        result = await options.runner.run(ctx);
      } catch (err) {
        // A runner that throws has still told us something; turning it into a
        // result (rather than a rejected promise) keeps the DAG's bookkeeping
        // and lets dependents be skipped for the right reason.
        const t = now();
        result = {
          stage: stage.name,
          provider: routing.provider,
          model: routing.model,
          status: 'failed',
          startedAt: stageStart,
          finishedAt: t,
          durationMs: t - stageStart,
          failure: {
            code: stageAbort.signal.aborted ? 'timeout' : 'runner-threw',
            message: stageAbort.signal.aborted
              ? `stage aborted (timeoutMs=${stage.timeoutMs ?? 'unset'})`
              : `StageRunner threw: ${err instanceof Error ? err.message : String(err)}`,
            retryable: !stageAbort.signal.aborted,
          },
        };
      } finally {
        if (timer) clearTimeout(timer);
        abort.signal.removeEventListener('abort', onParentAbort);
        inflight.delete(stage.name);
      }

      // A stage that reported success while its own signal was aborted is not a
      // success. Cheap check, and it closes the "signal-ignored" hole.
      const abortedThisAttempt = stageAbort.signal.aborted;
      if (abortedThisAttempt && result.status === 'passed') {
        aborted = true;
        result = {
          ...result,
          status: 'failed',
          failure: {
            code: 'timeout',
            message:
              `stage reported success after its abort signal fired ` +
              `(timeoutMs=${stage.timeoutMs ?? 'unset'}); treating as failure`,
            retryable: false,
          },
        };
      }

      if (result.status === 'passed') {
        record(result, escalations);
        return;
      }

      // Escalate only on a stall SHAPE (routing RULE 2). A plain failure with no
      // shape gets exactly the benefit of the doubt the reference job earned:
      // the first error of a long job is not evidence of a bad job.
      //
      // An aborted attempt is exempt: a timeout is not a reasoning failure, and
      // spending an escalation to re-run the same work under the same timeout
      // would just burn the ceiling.
      const verdict = assessStall(result.observations ?? [], policy);
      const next = abortedThisAttempt
        ? null
        : nextRouting(routing, verdict, stage, options.ladders, policy, escalations.length);

      if (abortedThisAttempt) {
        record(result, escalations);
        return;
      }

      if (!verdict.escalate || next === null) {
        if (!verdict.escalate) {
          result = {
            ...result,
            failure: result.failure
              ? { ...result.failure, message: `${result.failure.message} (no stall shape: ${verdict.because})` }
              : { code: 'failed', message: verdict.because },
          };
        } else {
          result = {
            ...result,
            failure: {
              code: 'escalation-ceiling',
              message:
                `stall shape '${verdict.shape}' persisted after ${escalations.length} ` +
                'escalation(s); stopping and surfacing the evidence',
              retryable: false,
            },
          };
        }
        record(result, escalations);
        return;
      }

      const escalation: Escalation = {
        attempt: escalations.length + 1,
        because: verdict.because,
        fromModel: routing.model,
        toModel: next.model,
        fromEffort: routing.effort,
        toEffort: next.effort,
        transcriptRef: result.transcriptRef,
        appendedContext: buildEscalationContext(verdict.because, result.outputTail),
      };
      escalations.push(escalation);

      continuation = {
        attempt,
        priorStatus: result.status,
        transcriptRef: result.transcriptRef,
        appendedContext: escalation.appendedContext ?? '',
        priorEscalations: escalations,
      };
      routing = next;
      attempt += 1;
    }
  };

  const record = (result: StageResult, escalations: readonly Escalation[]): void => {
    const withEsc: StageResult =
      escalations.length > 0 ? { ...result, escalations } : result;
    outcomes.set(result.stage, withEsc);
    order.push(result.stage);
    options.onStageEnd?.(withEsc);
  };

  /* ------------------------------ main loop ------------------------------ */

  while (true) {
    propagateSkips();

    const remaining = spec.stages.filter((s) => !started.has(s.name) && !outcomes.has(s.name));
    if (remaining.length === 0) {
      // Nothing left to dispatch, but stages we already started may still be
      // running. Returning here would hand back a PipelineRun with no outcomes
      // for them, so wait for the last one to settle.
      if (scheduler.activeCount === 0) break;
      const settled = scheduler.whenSettled();
      if (scheduler.activeCount > 0) await settled;
      continue;
    }

    // Dispatch everything currently dispatchable, bounded by the ceiling. This
    // is the whole concurrency story: any dispatchable stage takes the next free
    // slot, and the slot count is the only ceiling we impose.
    let dispatched = false;
    for (const stage of remaining) {
      if (!scheduler.hasSlot()) break;
      if (!isDispatchable(stage)) continue;
      started.add(stage.name);
      scheduler.enter();
      peakConcurrency = Math.max(peakConcurrency, scheduler.activeCount);
      dispatched = true;

      // Deliberately not awaited here: the stage runs concurrently and signals
      // the scheduler when it settles. Fire-and-observe is what keeps the other
      // branches moving, and it is why peakConcurrency is a measured fact rather
      // than an assumption about the ceiling.
      void runStage(stage).finally(() => scheduler.release());
    }

    if (dispatched) {
      // Keep draining the ready queue without waiting: if a stage settled during
      // the loop above, its dependents may already be dispatchable.
      continue;
    }

    // Nothing dispatchable. Two possible reasons:
    //  - something is still running, so we must wait for a settle or a free slot;
    //  - the graph is blocked, which validateSpec should have rejected.
    if (scheduler.activeCount > 0) {
      // Register the waiter BEFORE re-checking, or a release landing between the
      // check and the registration would leave us parked forever.
      const settled = scheduler.whenSettled();
      if (scheduler.activeCount > 0) await settled;
      continue;
    }

    for (const stage of remaining) {
      skipStage(
        stage,
        'upstream-skipped',
        depsOf(stage)[0] ?? '(none)',
        'blocked: no dependency reached a passing state and nothing is in flight',
      );
    }
    break;
  }

  // In-flight attempts are already settled at this point (the loop exits only
  // when every stage has an outcome), but a hard abort may leave stragglers.
  for (const controller of inflight.values()) controller.abort();
  inflight.clear();

  const finishedAt = now();
  const finalStatus = summarize(spec.stages.map((s) => outcomes.get(s.name)));
  const abortedRun = aborted || abort.signal.aborted;
  const run: PipelineRun = {
    pipeline: spec.name,
    status: finalStatus,
    outcomes: Object.fromEntries(outcomes),
    order,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    peakConcurrency,
    ...(abortedRun ? { aborted: true } : {}),
  };
  return run;
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return DEFAULT_CONCURRENCY;
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.floor(value));
}

/**
 * Roll stage results up into one status.
 *
 * 'partial' exists because "some stages ran and some did not" is the common
 * outcome of any real pipeline and is materially different from "nothing ran" —
 * a mod needs to draw those differently.
 */
function summarize(results: readonly (StageResult | undefined)[]): PipelineStatus {
  let passed = 0;
  let bad = 0;
  for (const r of results) {
    if (!r) continue;
    if (r.status === 'passed') passed += 1;
    else bad += 1;
  }
  if (bad === 0) return 'passed';
  if (passed === 0) return 'failed';
  return 'partial';
}

/**
 * Text handed to the resuming worker.
 *
 * Bounded, because the point is to inform the next attempt, not to replay the
 * log. The stall shape is stated first: the worker needs to know what to change,
 * and a raw error dump invites it to re-read the same mistake.
 */
export function buildEscalationContext(shape: string, outputTail?: string | undefined): string {
  const head = `Previous attempt stalled: ${shape}.`;
  const tail = outputTail?.trim();
  if (!tail) return head;
  return `${head}\n\nLast output (tail, may be truncated):\n${tail.slice(-4000)}`;
}

/** Convenience for callers holding only statuses. */
export function statusOf(run: PipelineRun, stage: string): StageStatus | undefined {
  return run.outcomes[stage]?.status;
}