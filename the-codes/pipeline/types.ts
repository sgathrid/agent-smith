/**
 * pipeline/types.ts — vocabulary for mixed-provider stage pipelines.
 *
 * The headline feature this file exists for:
 *
 *     implement → gemini   ·   review → codex   ·   moderate → claude-sonnet
 *
 * One task, a different worker per stage. Nothing in this file knows how to
 * talk to any worker; `StageRunner` (below) is the seam, and it is injected.
 *
 * WHY NO IMPORT FROM providers/
 * providers/ is written concurrently by another engineer. If pipeline/ imported
 * a concrete provider client we would have a compile-order dependency on work
 * that does not exist yet, and pipeline/ could not be tested without spawning
 * real agents. So the dependency points *inward*: pipeline/ declares the shape
 * it needs, providers/ (or core/) supplies an implementation at the composition
 * root. See `createRunnerRouter` in pipeline.ts for the wiring point.
 */

/** Opaque provider key. Values like 'gemini' | 'codex' | 'claude' | 'agy' | 'kimi'. */
export type ProviderId = string;

/** Opaque model key. Free-form: each provider has its own model naming. */
export type ModelId = string;

/**
 * Reasoning effort, where the worker supports it.
 *
 * Evidence (measured on this user's own jobs): raising effort to `high` cost
 * **+50% wall clock and 1.9x thinking tokens for ZERO accuracy gain** on an
 * in-band task. That is why `low` is the default everywhere in this codebase
 * and why escalation — not the default — is what buys effort.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

/** An explicit executable acceptance check, resolved against the worker's cwd. */
export interface StageCheck {
  readonly name: string;
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly blocking?: boolean;
}

/**
 * What a stage is for. Open-ended on purpose: a spec may use a custom role and
 * the DAG does not care, but these four carry meaning to routing.ts.
 *
 *   implement — do the work, produce an artifact
 *   review    — read the artifact, critique it
 *   moderate  — probe the previous stage with a DIFFERENT model family
 *   verify    — assert something executable about the working tree
 */
export type StageRole = 'implement' | 'review' | 'moderate' | 'verify' | (string & {});

/**
 * A pointer to a file a worker produced or consumed.
 *
 * Stages hand off *paths*, not transcripts of prose. That keeps the coupling
 * between stages a filesystem contract (consume `result.md`) rather than a
 * stringly-typed one, and it lets a later stage read the artifact itself
 * instead of trusting a summary written by an earlier model.
 */
export interface ArtifactRef {
  /** Who produced it. */
  readonly stage: string;
  /** Path relative to the pipeline work dir. */
  readonly path: string;
  /** Human-facing label, e.g. 'result.md'. */
  readonly label?: string | undefined;
}

/**
 * One stage of the pipeline: a named node in the DAG.
 *
 * A stage names *which worker runs it* (provider/model/effort), *what it needs*
 * (dependsOn → the upstream artifacts) and *what it yields* (resultPath).
 */
export interface Stage {
  /** Unique within the spec. Used as the DAG node id. */
  readonly name: string;
  /** Which injected StageRunner handles this stage. */
  readonly provider: ProviderId;
  /** Model override. Omit to let the provider (or routing) choose its default. */
  readonly model?: ModelId | undefined;
  /**
   * Effort override. Omit to let routing decide — and routing decides `low`.
   * See the `Effort` note above before setting this by hand.
   */
  readonly effort?: Effort | undefined;
  /** Upstream stage names. Empty/omitted = may start immediately. */
  readonly dependsOn?: readonly string[] | undefined;
  /** What this stage is for. Informs routing, not scheduling. */
  readonly role?: StageRole | undefined;
  /** The instruction handed to the worker. */
  readonly prompt?: string | undefined;
  /** Why the work matters and who it is for. Shown to the worker in its brief (forge/brief.ts). */
  readonly context?: string | undefined;
  /**
   * Human-facing one-liner for surfaces — the mod's `task` column, the store's
   * `title`.
   *
   * ADDITIVE, and it exists because deriving it from `prompt` is wrong whenever
   * the prompt is not the task. A `review` stage's prompt is role framing plus
   * the task, so "the first line of the prompt" is the framing, and every row in
   * the band reads `You are reviewing the work of…` instead of what the worker is
   * actually being asked to do. Omit it and the first non-empty line of `prompt`
   * is used, which is right for a spec whose prompt IS the task.
   */
  readonly title?: string | undefined;
  /** Human-readable worker name, independent of the DAG node key. */
  readonly agentName?: string;
  /** Stable worker identity retained across follow-up invocations. */
  readonly workerId?: string;
  /** Provider-native conversation handle for an explicit follow-up. */
  readonly conversation?: string;
  /**
   * Name of an earlier stage whose worker this stage continues: it resumes that
   * stage's conversation (same provider, worker identity and workDir) instead of
   * starting a fresh worker. The target must be an ancestor via `dependsOn`, so
   * its artifacts arrive as this stage's inputs. This is how a stage fixes from a
   * review: `build -> review -> fix`, where `fix` continues `build`. Omit
   * `provider` to inherit the target's.
   */
  readonly continues?: string | undefined;
  /** Working directory for the worker. Relative to the pipeline work dir. */
  readonly workDir?: string | undefined;
  /**
   * Artifact this stage produces, relative to its workDir. Convention is
   * `result.md`, and that is the convention downstream stages consume.
   */
  readonly resultPath?: string | undefined;
  /** Extra artifact paths consumed from upstream stages. */
  readonly consumes?: readonly ArtifactRef[] | undefined;
  /** Per-stage timeout. The pipeline aborts the runner via `StageContext.signal`. */
  readonly timeoutMs?: number | undefined;
  /** Checks run after the harness completes; no checks means execution only. */
  readonly checks?: readonly StageCheck[];
  /**
   * Opt out of routing's default-cheapest pass. Set true when a spec author has
   * deliberately pinned model/effort and does not want them rewritten.
   */
  readonly routingPinned?: boolean | undefined;
  /**
   * Extra environment for this stage's worker, merged over the server's. Values
   * are secrets-grade: only the KEYS are ever written to disk.
   */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Worker `env` keys that are refused, because they change how the worker
 * binary is found, loaded or configured. The env is applied when the CLI is
 * spawned, BEFORE any sandbox it sets up exists: `PATH` can swap the binary
 * for a shim, `NODE_OPTIONS=--import=…` or `DYLD_INSERT_LIBRARIES` run code
 * ahead of the worker, and a provider config dir can drop its read-only
 * settings, while the ack would still report the sandbox as enforced.
 * Matched case-insensitively (Windows env names are).
 */
export const ENV_DENYLIST: Readonly<Record<string, string>> = {
  PATH: 'would change which worker binary runs',
  HOME: 'would change which config the worker loads',
  SHELL: 'would change the shell the worker runs commands with',
  TMPDIR: 'would move the worker\'s temporary and sandbox files',
  NODE_OPTIONS: 'would run code before the worker starts',
  NODE_PATH: 'would change which modules the worker loads',
  PYTHONPATH: 'would change which modules the worker loads',
  PYTHONHOME: 'would change which runtime the worker loads',
  PYTHONSTARTUP: 'would run code before the worker starts',
  // Shell startup files: a shell-based launcher sources these before the worker body runs.
  BASH_ENV: 'would run code before the worker starts',
  ENV: 'would run code before the worker starts',
  ZDOTDIR: 'would run code before the worker starts',
  SHELLOPTS: 'would change how the shell runs the worker',
  PROMPT_COMMAND: 'would run code before the worker starts',
  PERL5OPT: 'would run code before the worker starts',
  RUBYOPT: 'would run code before the worker starts',
};

/**
 * Key prefixes refused for the same reason: the dynamic loader (`LD_`, `DYLD_`),
 * XDG config/data dirs, Agent Smith's own settings (`AGENT_SMITH_*_BIN`,
 * `_HOME`, `_CODEX_SANDBOX`, …) and each provider's config (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`, `KIMI_CODE_HOME`, `OPENCODE_*`, `AGY_*`). The adapters' own
 * keys are all covered here; do not list them again above.
 */
export const ENV_DENY_PREFIXES: Readonly<Record<string, string>> = {
  LD_: 'would change which libraries the worker loads',
  DYLD_: 'would change which libraries the worker loads',
  XDG_: 'would change which config the worker loads',
  AGENT_SMITH_: 'is Agent Smith\'s own setting, not the worker\'s',
  AGY_: 'would change the provider\'s config',
  CLAUDE_: 'would change the provider\'s config',
  CODEX_: 'would change the provider\'s config',
  OPENCODE_: 'would change the provider\'s config',
  KIMI_: 'would change the provider\'s config',
};

/** Why a worker `env` key is refused, or null when it is allowed. */
export function deniedEnvReason(key: string): string | null {
  const upper = key.toUpperCase();
  const exact = ENV_DENYLIST[upper];
  if (exact !== undefined) return exact;
  for (const [prefix, why] of Object.entries(ENV_DENY_PREFIXES)) if (upper.startsWith(prefix)) return why;
  return null;
}

/** Validate a worker `env` map: plain identifier keys not on the denylist, string values without NUL. Returns it unchanged, or undefined when absent. */
export function validateEnv(raw: unknown, label = 'env'): Readonly<Record<string, string>> | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} must be an object of string values.`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!ENV_KEY.test(key)) throw new Error(`${label} key "${key}" is not a valid variable name (letters, digits, underscore; no leading digit).`);
    const denied = deniedEnvReason(key);
    if (denied !== null) throw new Error(`${label}.${key} ${denied}; it is not allowed in a worker env.`);
    if (typeof value !== 'string' || value.includes('\0')) throw new Error(`${label}.${key} must be a string without NUL characters.`);
    out[key] = value;
  }
  return out;
}

/**
 * The whole plan.
 *
 * `concurrency` exists because of a concrete measurement: 16 jobs across
 * 16.3 hours of wall clock at a ceiling of 3 concurrent. A DAG runner that
 * serializes independent stages reproduces that exact failure. Default is 8 —
 * see DEFAULT_CONCURRENCY in pipeline.ts for why not 3 and not Infinity.
 */
export interface PipelineSpec {
  /** Identifier used in logs, work dirs and gate reports. */
  readonly name: string;
  readonly stages: readonly Stage[];
  /** Root for relative stage paths. Usually the job's working tree. */
  readonly workDir?: string | undefined;
  /** Max stages in flight at once. Omit for the default. */
  readonly concurrency?: number | undefined;
}

/** Terminal (or in-flight) state of a stage. */
export type StageStatus =
  /** Not started; deps not yet satisfied. */
  | 'pending'
  /** Dispatched to a StageRunner. */
  | 'running'
  /** Completed successfully. */
  | 'passed'
  /** The runner reported failure. Dependents become 'skipped'. */
  | 'failed'
  /** Never ran, because something upstream was not 'passed'. */
  | 'skipped';

/**
 * Why a stage was skipped.
 *
 * This field is not decoration. A pipeline that silently drops work reads as a
 * pipeline that succeeded; the distinction between "we did not run this because
 * review failed" and "this did not run and nobody knows why" is the whole
 * difference between a trustworthy log and a fluent, wrong handoff.
 */
export interface SkipReason {
  readonly kind: 'upstream-failed' | 'upstream-skipped' | 'pipeline-aborted';
  /** The upstream stage that was not 'passed'. */
  readonly becauseOf: string;
  readonly message: string;
}

/**
 * One thing the worker did, as reported by the provider adapter.
 *
 * WHY WE COLLECT OBSERVATIONS AT ALL
 * Escalation needs a *shape*, and the only reliable shapes are post-hoc. These
 * are raw facts, deliberately uninterpreted: routing.ts decides what they mean.
 * Nothing in the pipeline branches on the worker's own opinion of itself.
 */
export type ObservationKind =
  /** A tool call: read, grep, shell, etc. */
  | 'tool'
  /** A file mutation. `target` is the path. */
  | 'edit'
  /** A check run by the worker itself (typecheck, test, lint). */
  | 'verification'
  /** Assistant text. */
  | 'text'
  /** An error of any origin: tool error, provider error, thrown exception. */
  | 'error';

export interface Observation {
  /** Monotonic turn index within the stage. */
  readonly turn: number;
  readonly kind: ObservationKind;
  /** Tool name for kind='tool'. */
  readonly tool?: string | undefined;
  /** Path (edits) or command/check name (verifications). */
  readonly target?: string | undefined;
  /** For tools and verifications: did it succeed? Absent means unknown. */
  readonly ok?: boolean | undefined;
  /** Raw error text for kind='error'. Normalized only when comparing shapes. */
  readonly message?: string | undefined;
}

/**
 * Cost/rigor tier for a stage. Monotonic: escalation only ever moves up.
 *
 *   t0-cheap        the provider's cheapest model at `low` effort — the default
 *   t1-effort       same model, effort raised
 *   t2-stronger     a stronger model *within* the provider
 *   t3-cross-family a different model family entirely (also what `moderate` uses)
 */
export type CostTier = 't0-cheap' | 't1-effort' | 't2-stronger' | 't3-cross-family';

/**
 * The resolved routing for one attempt at a stage.
 *
 * Built by routing.ts, consumed by the StageRunner. The pipeline never picks a
 * model itself — it only holds the rung it is currently on.
 */
export interface StageRouting {
  readonly tier: CostTier;
  readonly provider: ProviderId;
  readonly model?: ModelId | undefined;
  readonly effort: Effort;
  /** Why this rung. Logged verbatim, so it must read as a reason, not a label. */
  readonly rationale: string;
}

/**
 * State needed to RESUME a stage rather than restart it.
 *
 * WHY THIS EXISTS: escalating by restarting re-runs the whole task — it re-reads
 * files, re-explores dead ends, and can regress work the first attempt already
 * got right. Continuing from the transcript costs one resume. Every escalation
 * in this codebase carries one of these; none of them are silent restarts.
 */
export interface StageContinuation {
  /** 1-based: the attempt that just ended. */
  readonly attempt: number;
  readonly priorStatus: StageStatus;
  /** Where the worker left its conversation. Read by the runner, never by us. */
  readonly transcriptRef?: string | undefined;
  readonly transcriptProvider?: string | undefined;
  /** Text appended to the worker's context (failing check output, stall shape). */
  readonly appendedContext: string;
  /** Escalations already applied, so the runner can label the resume. */
  readonly priorEscalations?: readonly Escalation[] | undefined;
}

/** The earlier stage's worker that a `continues` stage resumes. */
export interface ContinuedWorker {
  readonly stage: string;
  readonly transcriptRef: string;
  readonly workerId?: string | undefined;
  readonly agentName?: string | undefined;
}

/**
 * What a StageRunner receives.
 *
 * Note it receives resolved *artifacts* and a *routing*, not the upstream
 * prose. If a stage needs what the previous stage said, it reads the previous
 * stage's result.md — a file, on disk, written by the worker that did the work.
 */
export interface StageContext {
  readonly pipeline: string;
  readonly stage: Stage;
  /** 1-based attempt number. 1 means "fresh start". */
  readonly attempt: number;
  /** Absolute working directory for this stage. */
  readonly workDir: string;
  /** Upstream artifacts, in dependency order. */
  readonly inputs: readonly ArtifactRef[];
  readonly routing: StageRouting;
  /** Present only on attempt > 1. */
  readonly continuation?: StageContinuation | undefined;
  /** Present when `stage.continues` is set: the worker conversation to resume on attempt 1. */
  readonly continues?: ContinuedWorker | undefined;
  /** Aborted on pipeline abort or stage timeout. Honor it. */
  readonly signal: AbortSignal;
}

/**
 * THE INJECTION POINT.
 *
 * One method. Everything provider-specific — spawning, resume, streaming,
 * transcript storage — lives behind this. pipeline/ and verify/ never learn the
 * shape of any worker's API.
 *
 * Wiring (see createRunnerRouter in pipeline.ts):
 *
 *     const runner = createRunnerRouter({
 *       gemini: geminiRunner,   // provided by providers/, constructed at the
 *       codex:  codexRunner,    // composition root in core/
 *     });
 *     await runPipeline(spec, { runner });
 */
export interface StageRunner {
  /** Stable id for logs: provider name, or 'router'. */
  readonly id: string;
  /**
   * Run one attempt at one stage.
   *
   * Contract:
   *  - Return a StageResult. Do not throw for an ordinary failure — a failing
   *    stage is data, and an exception loses the duration and the output tail.
   *  - Resolve with status 'passed' / 'failed'. 'skipped' is for the DAG.
   *  - Honor `ctx.signal` and abort promptly when it fires.
   *  - On attempt > 1, honor `ctx.continuation` and continue; do not restart.
   *  - Report facts in `observations`, not conclusions.
   */
  run(ctx: StageContext): Promise<StageResult>;
}

/** Structured failure detail, kept separate from prose. */
export interface StageFailure {
  /** Short, stable, greppable. E.g. 'exit-1' | 'timeout' | 'no-result'. */
  readonly code: string;
  readonly message: string;
  /** True when re-running the same stage could plausibly help. */
  readonly retryable?: boolean | undefined;
  /** Provider-specific payload. Opaque here on purpose. */
  readonly detail?: unknown;
}

/**
 * One escalation of one stage: the routing decision to try again, carrying the
 * worker's existing conversation instead of starting over.
 *
 * WHY CONTINUE, NOT RESTART: restarting throws away the completed work, the
 * explored dead ends, and the file contents the worker already read. Continuing
 * with context costs one resume and keeps everything the worker learned.
 */
export interface Escalation {
  /** 1-based: which escalation this is. */
  readonly attempt: number;
  /** Human-readable reason, e.g. 'repeat-tool-failure: tsc x3'. */
  readonly because: string;
  readonly fromModel?: ModelId | undefined;
  readonly toModel?: ModelId | undefined;
  readonly fromEffort?: Effort | undefined;
  readonly toEffort?: Effort | undefined;
  /**
   * Where the preserved conversation lives. The runner needs it to continue
   * rather than restart; the pipeline never interprets it.
   */
  readonly transcriptRef?: string | undefined;
  /** Text appended to the worker's context on resume (e.g. failing check output). */
  readonly appendedContext?: string | undefined;
}

/**
 * The terminal outcome of one stage.
 *
 * This is what `StageRunner.run` returns and what the DAG records. It is
 * deliberately *data*: the orchestrator must be able to decide from it without
 * parsing prose.
 */
export interface StageResult {
  readonly stage: string;
  /** External worker invocation ID; distinct from the pipeline run ID. */
  readonly jobId?: string;
  /** Acceptance is separate from successful harness execution. */
  readonly acceptance?: 'unchecked' | 'passed' | 'failed';
  readonly verification?: import('../verify/types.ts').CheckReport;
  readonly provider: ProviderId;
  readonly model?: ModelId | undefined;
  readonly status: StageStatus;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  /** Artifact this stage produced. Usually the next stage's input. */
  readonly resultPath?: string | undefined;
  /** Everything this stage can hand to downstream stages. */
  readonly artifacts?: readonly ArtifactRef[] | undefined;
  readonly failure?: StageFailure | undefined;
  /** Non-fatal facts a reader should know, e.g. an artifact the stage did not write. */
  readonly warnings?: readonly string[] | undefined;
  readonly skippedBecause?: SkipReason | undefined;
  /** Escalations applied before this result was reached. */
  readonly escalations?: readonly Escalation[] | undefined;
  /** Where the worker's conversation lives, for a later continuation. */
  readonly transcriptRef?: string | undefined;
  /** Cost if the provider reported it. Never used for control flow. */
  readonly costUsd?: number | undefined;
  /** Bounded tail of the worker's own output. Diagnostics only, not a verdict. */
  readonly outputTail?: string | undefined;
  /**
   * What the worker actually did this attempt, in order.
   *
   * Fed to routing.ts to decide escalation. Absent is legitimate (a provider
   * that reports no structured events) and means "no stall signal available",
   * NOT "nothing went wrong".
   */
  readonly observations?: readonly Observation[] | undefined;
}

/**
 * Aggregate status of a whole run.
 *
 *   passed  — every stage passed
 *   partial — something passed, something did not
 *   failed  — nothing useful produced; the pipeline is done
 */
export type PipelineStatus = 'passed' | 'partial' | 'failed';

/** Result of running a whole spec. */
export interface PipelineRun {
  readonly pipeline: string;
  readonly status: PipelineStatus;
  readonly outcomes: Readonly<Record<string, StageResult>>;
  /** Stage names in completion order. Useful for drawing the mod. */
  readonly order: readonly string[];
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  /** Highest simultaneous stage count observed. Evidence for the concurrency claim. */
  readonly peakConcurrency: number;
  /** Aborted by a signal or a stage timeout rather than by finishing. */
  readonly aborted?: boolean | undefined;
}
