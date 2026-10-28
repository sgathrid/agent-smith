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
  ContinuedWorker,
  Escalation,
  PipelineRun,
  PipelineSpec,
  PipelineStatus,
  ProviderId,
  Stage,
  StageContext,
  StageContinuation,
  StageResult,
  StageRouting,
  StageRunner,
} from './types.ts';
import path from 'node:path';

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
  if (!spec.name.trim() || spec.stages.length === 0) {
    throw new PipelineSpecError('a pipeline needs a name and at least one stage');
  }
  if (spec.concurrency !== undefined && (!Number.isSafeInteger(spec.concurrency) || spec.concurrency < 1 || spec.concurrency > 32)) {
    throw new PipelineSpecError('concurrency must be an integer from 1 to 32');
  }
  const seen = new Set<string>();
  for (const stage of spec.stages) {
    if (!stage.name.trim() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stage.name)) {
      throw new PipelineSpecError('every stage needs a name');
    }
    if (!stage.provider.trim()) throw new PipelineSpecError(`stage '${stage.name}' needs a provider`);
    if (stage.timeoutMs !== undefined && (!Number.isSafeInteger(stage.timeoutMs) || stage.timeoutMs <= 0)) {
      throw new PipelineSpecError(`stage '${stage.name}' timeoutMs must be a positive integer`);
    }
    for (const check of stage.checks ?? []) {
      if (!check.name.trim() || !check.command.trim()) throw new PipelineSpecError(`stage '${stage.name}' has an empty check`);
      if (check.timeoutMs !== undefined && (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs <= 0)) {
        throw new PipelineSpecError(`stage '${stage.name}' check timeoutMs must be a positive integer`);
      }
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

  const byName = new Map(spec.stages.map((s) => [s.name, s]));
  const ancestorsOf = (name: string, into = new Set<string>()): Set<string> => {
    for (const dep of byName.get(name)?.dependsOn ?? []) {
      if (!into.has(dep)) ancestorsOf(dep, into.add(dep));
    }
    return into;
  };
  for (const stage of spec.stages) {
    if (stage.continues === undefined) continue;
    const target = byName.get(stage.continues);
    const label = `stage '${stage.name}' continues '${stage.continues}'`;
    if (stage.continues === stage.name) throw new PipelineSpecError(`${label}, which is itself`);
    if (target === undefined) throw new PipelineSpecError(`${label}, which does not exist`);
    if (!ancestorsOf(stage.name).has(target.name)) {
      throw new PipelineSpecError(`${label}, which it does not depend on; add '${target.name}' to its dependsOn (directly or through another stage)`);
    }
    if (target.provider !== stage.provider) {
      throw new PipelineSpecError(`${label}, but a conversation cannot move between providers (${stage.provider} vs ${target.provider}); use provider ${target.provider} or omit provider to inherit it`);
    }
    if (stage.conversation !== undefined) {
      throw new PipelineSpecError(`${label} and also sets conversation; use one or the other`);
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
 * providers per stage while the pipeline sees exactly one runner. the forge
 * (forge/runner.ts, forge/execute.ts) constructs the provider runners and wires
 * them at the composition root; pipeline/ and verify/ stay ignorant of every worker's API.
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
            'This is a wiring gap in the composition root (forge/), not a provider failure.',
          retryable: false,
        });
      }
      return runner.run(ctx);
    },
  };
}

/**
 * Give a stage that `continues` another and omits `provider` that stage's
 * provider. Parsers call this before validateSpec, because a conversation can
 * only resume on the provider that holds it, so asking again is noise.
 */
export function inheritContinuedProviders(stages: readonly (Omit<Stage, 'provider'> & { provider?: ProviderId | undefined })[]): Stage[] {
  const byName = new Map(stages.map((s) => [s.name, s]));
  const providerOf = (stage: (typeof stages)[number], seen: Set<string>): ProviderId | undefined => {
    if (stage.provider !== undefined) return stage.provider;
    if (stage.continues === undefined || seen.has(stage.name)) return undefined;
    const target = byName.get(stage.continues);
    return target === undefined ? undefined : providerOf(target, seen.add(stage.name));
  };
  return stages.map((stage) => {
    const provider = providerOf(stage, new Set());
    if (provider === undefined && stage.continues !== undefined && !byName.has(stage.continues)) {
      throw new PipelineSpecError(`stage '${stage.name}' continues '${stage.continues}', which does not exist`);
    }
    if (provider === undefined) throw new PipelineSpecError(`stage '${stage.name}' needs a provider`);
    return { ...stage, provider };
  });
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

/**
 * The mutable state of one `runPipeline` call, and the steps that act on it.
 *
 * A class rather than closures so each step is a named method that can be read
 * on its own. It holds no behaviour `runPipeline` did not already have.
 */
class PipelineExecution {
  private readonly spec: PipelineSpec;
  private readonly options: RunOptions;
  private readonly now: () => number;
  private readonly workDir: string;
  private readonly policy: StallPolicy;
  private readonly abort = new AbortController();
  private readonly stages: Map<string, Stage>;
  private readonly outcomes = new Map<string, StageResult>();
  private readonly skipped = new Set<string>();
  /**
   * Stages that have been dispatched at least once.
   *
   * Separate from `outcomes` on purpose: a dispatched stage is neither passed nor
   * finished, so readiness alone would re-dispatch it on the very next loop
   * iteration. Dispatch is tracked by "has this been started", completion by
   * "is there a result" — conflating the two is how a DAG runner ends up
   * running `implement` eight times in a row.
   */
  private readonly started = new Set<string>();
  /** Stages currently in flight, so a timeout can abort exactly one attempt. */
  private readonly inflight = new Map<string, AbortController>();
  private readonly scheduler: Scheduler;
  private readonly order: string[] = [];
  private peakConcurrency = 0;
  private aborted = false;

  constructor(spec: PipelineSpec, options: RunOptions) {
    this.spec = spec;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.workDir = options.workDir ?? spec.workDir ?? process.cwd();
    this.policy = options.policy ?? DEFAULT_STALL_POLICY;
    this.scheduler = new Scheduler(normalizeConcurrency(options.concurrency ?? spec.concurrency));
    this.stages = new Map(spec.stages.map((s) => [s.name, s]));

    const parentSignal = options.signal;
    if (parentSignal) {
      // Captured in a local: narrowing on `options.signal` does not survive into
      // the closure below, and `exactOptionalPropertyTypes` keeps it optional.
      const onAbort = () => this.abort.abort(parentSignal.reason);
      if (parentSignal.aborted) onAbort();
      else parentSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  private depsOf(stage: Stage): readonly string[] {
    return stage.dependsOn ?? [];
  }

  /** A continuing stage works where its target worked unless it names its own workDir. */
  private workDirOf(stage: Stage): string {
    const own = stage.workDir ?? (stage.continues === undefined ? undefined : this.stages.get(stage.continues)?.workDir);
    return own ? path.resolve(this.workDir, own) : this.workDir;
  }

  /** A stage is dispatchable when it is unstarted, not skipped, and every dep passed. */
  private isDispatchable(stage: Stage): boolean {
    if (this.started.has(stage.name) || this.outcomes.has(stage.name) || this.skipped.has(stage.name)) return false;
    return this.depsOf(stage).every((d) => this.outcomes.get(d)?.status === 'passed');
  }

  /**
   * Cascade `skipped` forward from anything not 'passed'.
   *
   * Iterated to a fixed point so a three-deep chain settles in one pass and the
   * reason reported names the *originating* failure rather than the neighbour
   * that happened to be checked first.
   */
  private propagateSkips(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const stage of this.spec.stages) {
        if (this.outcomes.has(stage.name) || this.skipped.has(stage.name)) continue;
        for (const dep of this.depsOf(stage)) {
          const upstream = this.outcomes.get(dep);
          if (this.skipped.has(dep)) {
            this.skipStage(stage, 'upstream-skipped', dep, `skipped because upstream '${dep}' was skipped`);
            changed = true;
            break;
          }
          if (upstream && upstream.status !== 'passed') {
            this.skipStage(
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
  }

  private skipStage(
    stage: Stage,
    kind: NonNullable<StageResult['skippedBecause']>['kind'],
    becauseOf: string,
    message: string,
  ): void {
    const t = this.now();
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
    this.skipped.add(stage.name);
    this.outcomes.set(stage.name, result);
    this.order.push(stage.name);
    this.options.onStageEnd?.(result);
  }

  /**
   * Inputs for a stage: every upstream artifact, in dependency order.
   *
   * Artifacts, not summaries. A downstream stage that needs to know what the
   * upstream stage concluded reads the upstream stage's own result.md, because
   * a summary written by a model is the thing most likely to be confidently
   * wrong (see verify/runner.ts for why prose is not a verdict).
   */
  private inputsFor(stage: Stage): readonly ArtifactRef[] {
    const inherited: ArtifactRef[] = [];
    for (const dep of this.depsOf(stage)) {
      const upstream = this.outcomes.get(dep);
      if (!upstream) continue;
      const declaredPath = this.stages.get(dep)?.resultPath ?? 'result.md';
      inherited.push({ stage: dep, path: declaredPath, label: declaredPath });
      // Anything the upstream stage advertised beyond its main result.
      for (const art of upstream.artifacts ?? []) {
        if (art.path !== declaredPath) inherited.push(art);
      }
    }
    return [...inherited, ...(stage.consumes ?? [])];
  }

  private record(result: StageResult, escalations: readonly Escalation[]): void {
    const withEsc: StageResult =
      escalations.length > 0 ? { ...result, escalations } : result;
    this.outcomes.set(result.stage, withEsc);
    this.order.push(result.stage);
    this.options.onStageEnd?.(withEsc);
  }

  /**
   * `continues`: resume the target's worker conversation. validateSpec proved
   * it is an ancestor, so it has passed by now; what can still be missing is the
   * conversation handle (the provider reported none) or its provider (an
   * escalation moved the target to another one). Returns the remedy as `problem`.
   */
  private resolveContinued(stage: Stage, routing: StageRouting): ContinuedWorker | { readonly problem: string } {
    const target = this.stages.get(stage.continues!)!;
    const done = this.outcomes.get(target.name);
    const ref = done?.transcriptRef;
    if (ref === undefined) {
      return { problem: `stage '${target.name}' produced no conversation handle to resume (the provider reported none); keep the fix in '${target.name}' or start a fresh worker` };
    }
    if (done?.provider !== routing.provider) {
      return { problem: `stage '${target.name}' finished on ${done?.provider}, but this stage runs on ${routing.provider} and a conversation cannot move between providers; pin '${target.name}' with routingPinned` };
    }
    return { stage: target.name, transcriptRef: ref, workerId: target.workerId, agentName: target.agentName };
  }

  /**
   * One attempt: run the stage under its own abort signal and timeout, and turn
   * a throw or a late success into the result it really is.
   */
  private async runAttempt(
    stage: Stage,
    attempt: number,
    stageStart: number,
    routing: StageRouting,
    continuation: StageContinuation | undefined,
    continued: ContinuedWorker | undefined,
  ): Promise<{ result: StageResult; abortedThisAttempt: boolean }> {
    // Per-stage timeout: abort this attempt's signal without touching the run.
    const stageAbort = new AbortController();
    this.inflight.set(stage.name, stageAbort);
    if (this.abort.signal.aborted) stageAbort.abort(this.abort.signal.reason);

    const onParentAbort = () => stageAbort.abort(this.abort.signal.reason);
    this.abort.signal.addEventListener('abort', onParentAbort, { once: true });
    const timer = stage.timeoutMs
      ? setTimeout(() => stageAbort.abort(new Error(`stage timeout after ${stage.timeoutMs}ms`)), stage.timeoutMs)
      : undefined;

    this.options.onStageStart?.(stage, attempt);
    const ctx: StageContext = {
      pipeline: this.spec.name,
      stage,
      attempt,
      workDir: this.workDirOf(stage),
      inputs: this.inputsFor(stage),
      routing,
      ...(continuation ? { continuation } : {}),
      ...(continued ? { continues: continued } : {}),
      signal: stageAbort.signal,
    };

    let result: StageResult;
    try {
      result = await this.options.runner.run(ctx);
    } catch (err) {
      // A runner that throws has still told us something; turning it into a
      // result (rather than a rejected promise) keeps the DAG's bookkeeping
      // and lets dependents be skipped for the right reason.
      const t = this.now();
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
      this.abort.signal.removeEventListener('abort', onParentAbort);
      this.inflight.delete(stage.name);
    }

    // A stage that reported success while its own signal was aborted is not a
    // success. Cheap check, and it closes the "signal-ignored" hole.
    const abortedThisAttempt = stageAbort.signal.aborted;
    if (abortedThisAttempt && result.status === 'passed') {
      this.aborted = true;
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
    return { result, abortedThisAttempt };
  }

  /**
   * After a failed, un-aborted attempt: stop with a final result, or escalate.
   *
   * Escalate only on a stall SHAPE (routing RULE 2). A plain failure with no
   * shape gets exactly the benefit of the doubt the reference job earned: the
   * first error of a long job is not evidence of a bad job. Pushes the new
   * escalation onto `escalations` when it retries.
   */
  private decideEscalation(
    stage: Stage,
    result: StageResult,
    routing: StageRouting,
    attempt: number,
    escalations: Escalation[],
  ): { readonly kind: 'stop'; readonly result: StageResult } | { readonly kind: 'retry'; readonly routing: StageRouting; readonly continuation: StageContinuation } {
    const verdict = assessStall(result.observations ?? [], this.policy);
    const next = nextRouting(routing, verdict, stage, this.options.ladders, this.policy, escalations.length);

    if (!verdict.escalate || next === null) {
      if (!verdict.escalate) {
        return {
          kind: 'stop',
          result: {
            ...result,
            failure: result.failure
              ? { ...result.failure, message: `${result.failure.message} (no stall shape: ${verdict.because})` }
              : { code: 'failed', message: verdict.because },
          },
        };
      }
      return {
        kind: 'stop',
        result: {
          ...result,
          failure: {
            code: 'escalation-ceiling',
            message:
              `stall shape '${verdict.shape}' persisted after ${escalations.length} ` +
              'escalation(s); stopping and surfacing the evidence',
            retryable: false,
          },
        },
      };
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

    return {
      kind: 'retry',
      routing: next,
      continuation: {
        attempt,
        priorStatus: result.status,
        transcriptRef: result.transcriptRef,
        transcriptProvider: routing.provider,
        appendedContext: escalation.appendedContext ?? '',
        priorEscalations: escalations,
      },
    };
  }

  /**
   * One stage, including its escalation ladder.
   *
   * RULE 3: every escalation after the first is a *continuation*. The previous
   * attempt's transcript reference and its failing tail are handed to the next
   * attempt so the worker resumes rather than starts over.
   */
  private async runStage(stage: Stage): Promise<void> {
    const stageStart = this.now();
    let attempt = 1;
    let continuation: StageContinuation | undefined;
    const escalations: Escalation[] = [];
    let routing = planInitialRouting(stage, this.options.ladders);

    let continued: ContinuedWorker | undefined;
    if (stage.continues !== undefined) {
      const resolved = this.resolveContinued(stage, routing);
      if ('problem' in resolved) {
        const t = this.now();
        this.record({
          stage: stage.name, provider: routing.provider, model: routing.model, status: 'failed',
          startedAt: stageStart, finishedAt: t, durationMs: t - stageStart,
          failure: { code: 'no-conversation', message: `cannot continue: ${resolved.problem}`, retryable: false },
        }, []);
        return;
      }
      continued = resolved;
    }

    for (;;) {
      if (this.abort.signal.aborted) {
        this.aborted = true;
        const t = this.now();
        this.outcomes.set(stage.name, {
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
        this.order.push(stage.name);
        return;
      }

      const { result, abortedThisAttempt } = await this.runAttempt(stage, attempt, stageStart, routing, continuation, continued);

      // An aborted attempt is exempt from escalation: a timeout is not a
      // reasoning failure, and spending an escalation to re-run the same work
      // under the same timeout would just burn the ceiling.
      if (result.status === 'passed' || abortedThisAttempt) {
        this.record(result, escalations);
        return;
      }

      const decision = this.decideEscalation(stage, result, routing, attempt, escalations);
      if (decision.kind === 'stop') {
        this.record(decision.result, escalations);
        return;
      }
      continuation = decision.continuation;
      routing = decision.routing;
      attempt += 1;
    }
  }

  /** Drive the DAG to completion and assemble the run. */
  async execute(startedAt: number): Promise<PipelineRun> {
    const { spec, scheduler, started, outcomes } = this;

    while (true) {
      this.propagateSkips();

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
        if (!this.isDispatchable(stage)) continue;
        started.add(stage.name);
        scheduler.enter();
        this.peakConcurrency = Math.max(this.peakConcurrency, scheduler.activeCount);
        dispatched = true;

        // Deliberately not awaited here: the stage runs concurrently and signals
        // the scheduler when it settles. Fire-and-observe is what keeps the other
        // branches moving, and it is why peakConcurrency is a measured fact rather
        // than an assumption about the ceiling.
        void this.runStage(stage).finally(() => scheduler.release());
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
        this.skipStage(
          stage,
          'upstream-skipped',
          this.depsOf(stage)[0] ?? '(none)',
          'blocked: no dependency reached a passing state and nothing is in flight',
        );
      }
      break;
    }

    // In-flight attempts are already settled at this point (the loop exits only
    // when every stage has an outcome), but a hard abort may leave stragglers.
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();

    const finishedAt = this.now();
    const abortedRun = this.aborted || this.abort.signal.aborted;
    return {
      pipeline: spec.name,
      status: summarize(spec.stages.map((s) => outcomes.get(s.name))),
      outcomes: Object.fromEntries(outcomes),
      order: this.order,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      peakConcurrency: this.peakConcurrency,
      ...(abortedRun ? { aborted: true } : {}),
    };
  }
}

export async function runPipeline(
  spec: PipelineSpec,
  options: RunOptions,
): Promise<PipelineRun> {
  validateSpec(spec);
  const startedAt = (options.now ?? Date.now)();
  return new PipelineExecution(spec, options).execute(startedAt);
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
