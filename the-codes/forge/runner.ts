/**
 * runner.ts — the StageRunner that pipeline/ has been waiting for since it was
 * written.
 *
 * pipeline/types.ts declares the injection point and pipeline/pipeline.ts ships
 * `createRunnerRouter`, and nothing has ever supplied one. So the DAG runner
 * could not be executed, which is why the architecture's headline example —
 * implement in agy, review in Codex, moderate in Claude, independent stages
 * concurrent — was a diagram rather than a feature.
 *
 * This file supplies it, and it is thin on purpose: pipeline/ owns scheduling,
 * concurrency, skip propagation and escalation; providers/ owns argv and streams;
 * forge/ owns state. All this file does is translate one `StageContext` into one
 * `spawnJob` call and one `JobResult` back into one `StageResult`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE THINGS A RUNNER OWNS, AND WHY THEY ARE NOT IN THE DAG
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. THE PROMPT. A stage's prompt NAMES upstream stages; it does not contain
 *    their work. pipeline/types.ts is explicit that stages hand off PATHS, not
 *    prose: "a summary written by a model is the thing most likely to be
 *    confidently wrong". So the runner reads the upstream artifacts off disk and
 *    inlines them, capped, AND gives the absolute path so the worker can read
 *    more itself. Same reasoning as verify/runner.ts's "prose is not a verdict".
 *
 * 2. CONTINUATION, NOT RESTART. On attempt > 1 the runner passes
 *    `ctx.continuation.transcriptRef` as the provider's resume handle and
 *    prepends `appendedContext` to the prompt. Our agy adapter maps that onto
 *    `--conversation <id>` (a VERIFIED flag), so an escalation resumes the
 *    worker's own conversation instead of re-paying for everything it already
 *    read. This is pipeline/routing.ts RULE 3, and the only place in the repo
 *    where that rule is actually wired to a CLI. A stage with `continues` uses the same
 *    path on attempt 1: `ctx.continues` carries the target stage's conversation and
 *    worker identity, so the fix stage resumes the implementer it follows.
 *
 * 3. ARTIFACT PLACEMENT. Every stage gets its OWN directory under the pipeline
 *    work dir — `<workDir>/<stage.name>/` — and writes `result.md` inside it.
 *    pipeline.ts's `inputsFor()` hands downstream stages a bare relative path
 *    (`resultPath ?? 'result.md'`) with no stage qualifier, so three stages
 *    sharing one directory would have stage two overwrite stage one's artifact:
 *    the `moderate` stage would then be moderating its own review. Per-stage
 *    directories make that impossible, and the `resultPath` we report back is
 *    qualified with the stage name so `inputsFor()` resolves correctly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OBSERVATIONS ARE FACTS, NOT CONCLUSIONS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * routing.ts escalates on `Observation[]`. We report tool calls as 'tool' and
 * NEVER as 'edit' or 'verification', because a generic event stream does not tell
 * us whether a `write_file` was an edit or a scratch file, and
 * `edit-churn-unverified` is a stall verdict that would be a lie. Under-reporting
 * makes escalation conservative; over-reporting makes it spend on a bad
 * inference.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import type {
  ArtifactRef,
  Observation,
  Stage,
  StageContext,
  StageResult,
  StageRunner,
} from '../pipeline/types.ts';
import { FILES, jobDir, jobFile } from './format.ts';
import type { ForgeService, SpawnRequest } from './service.ts';
import type { ForgeActivity, ForgeManifest } from './format.ts';
import { appendBounded } from './writer.ts';
import { isMode, MODE_PRESETS } from './modes.ts';
import { runChecks } from '../verify/runner.ts';
import { acceptanceChecksFromReport, acceptanceState, normalizeAcceptanceReport, toVerifyChecks, writeAcceptance } from './checks.ts';
import type { Acceptance } from './checks.ts';
import type { Check } from '../verify/types.ts';

/**
 * How much of each upstream artifact we inline into the prompt.
 *
 * 12 KB per artifact, 48 KB total. Enough for a review to see the diff and a
 * moderate to see the finding; not enough to blow a context window on a stage
 * that can read the file itself. The cap is ANNOUNCED in the prompt when it
 * bites, so a truncated input is never silently truncated.
 */
export const ARTIFACT_INLINE_CHARS = 12_000;
export const TOTAL_INLINE_CHARS = 48_000;

/** Tail of the worker's own words attached to a StageResult. Bounded, diagnostics only. */
export const OUTPUT_TAIL_CHARS = 4_000;

/** Per-stage subdirectory under the pipeline work dir. Pure. */
export function stageDir(workDir: string, stage: string): string {
  validateStageName(stage);
  return path.join(workDir, stage);
}

/** The artifact a stage produces: `<workDir>/<stage>/<resultPath>`. Pure. */
export function stageArtifactPath(workDir: string, stage: string, resultPath?: string): string {
  const base = stageDir(workDir, stage);
  const relative = resultPath ?? 'result.md';
  validateArtifactRelative(relative);
  const resolved = path.resolve(base, relative);
  if (!resolved.startsWith(`${path.resolve(base)}${path.sep}`)) {
    throw new Error(`stage artifact path escapes its stage directory: "${relative}"`);
  }
  return resolved;
}

/** The pipeline-relative artifact path we report back, so `inputsFor()` resolves it. */
export function stageArtifactRef(stage: string, resultPath?: string): string {
  validateStageName(stage);
  validateArtifactRelative(resultPath ?? 'result.md');
  return `${stage}/${resultPath ?? 'result.md'}`;
}

function validateStageName(stage: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(stage) || stage === '.' || stage === '..') {
    throw new Error(`invalid stage name "${stage}"`);
  }
}

function validateArtifactRelative(relative: string): void {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`invalid stage artifact path "${relative}"`);
  }
}

/**
 * Resolve an upstream artifact to readable text.
 *
 * LENIENT ON PURPOSE, and the leniency is ordered. `pipeline.ts` hands us a bare
 * `result.md` with no stage qualifier, but we wrote ours at
 * `<workDir>/<stage>/result.md`. So we try, in order:
 *
 *   1. the path as given, resolved against the pipeline work dir
 *   2. `<workDir>/<input.stage>/result.md` — the location we actually wrote
 *   3. `<workDir>/result.md` — the literal `result.md`, for a hand-placed file
 *
 * Returning null rather than throwing is required: an artefact that has gone
 * missing must cost ONE INPUT, not the whole stage. A review with no diff in its
 * context still has the absolute path and can read it itself.
 */
export function readArtifact(
  workDir: string,
  input: ArtifactRef,
  limit = ARTIFACT_INLINE_CHARS,
): { text: string | null; from: string; truncated: boolean } {
  const candidates = [
    resolveInside(workDir, input.path),
    resolveStageInput(workDir, input.stage, input.path),
    safeStageDefault(workDir, input.stage),
    resolveInside(workDir, 'result.md'),
  ].filter((candidate): candidate is string => candidate !== null);
  if (candidates.length === 0) return { text: null, from: input.path, truncated: false };
  for (const candidate of candidates) {
    let body: string;
    try {
      body = readFileSync(candidate, 'utf8');
    } catch {
      continue;
    }
    const truncated = body.length > limit;
    return {
      text: truncated ? `${body.slice(0, limit)}\n…[truncated]` : body,
      from: candidate,
      truncated,
    };
  }
  return { text: null, from: candidates[0] ?? input.path, truncated: false };
}

function resolveInside(root: string, relative: string): string | null {
  if (path.isAbsolute(relative)) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  return resolved.startsWith(`${resolvedRoot}${path.sep}`) ? resolved : null;
}

function resolveStageInput(root: string, stage: string, relative: string): string | null {
  try { return resolveInside(stageDir(root, stage), relative); } catch { return null; }
}

function safeStageDefault(root: string, stage: string): string | null {
  try { return stageArtifactPath(root, stage); } catch { return null; }
}

/** The slice of pipeline's StageContinuation this file uses. Structurally identical. */
export interface StageContinuationLike {
  readonly attempt: number;
  readonly transcriptRef?: string | undefined;
  readonly transcriptProvider?: string | undefined;
  readonly appendedContext: string;
}

/**
 * Compose the prompt for one attempt.
 *
 * PURE, and therefore the most testable function in this file: its three inputs
 * are the stage's own prompt, the upstream artefacts, and (on a retry) the
 * continuation. Everything about escalation quality lives in this string, so it
 * is a pure function rather than something assembled inline inside `run()`.
 *
 * The continuation goes FIRST, deliberately. On attempt 2 the worker's most
 * important fact is "you already tried this and here is what went wrong", and a
 * trailing paragraph after a re-stated task is a paragraph the model reads last.
 */
export function buildStagePrompt(args: {
  readonly stage: Stage;
  readonly workDir: string;
  readonly artifactRoot?: string | undefined;
  readonly inputs: readonly ArtifactRef[];
  readonly attempt: number;
  readonly continuation?: StageContinuationLike | undefined;
  readonly canResumeTranscript?: boolean | undefined;
}): string {
  const parts: string[] = [];

  if (args.continuation !== undefined) {
    parts.push(
      `CONTINUE, DO NOT RESTART. This is attempt ${args.attempt} at stage '${args.stage.name}'. ` +
      (args.canResumeTranscript === false
        ? 'Keep the previous attempt’s repository changes and use the supplied failure context; the prior provider session cannot be resumed.'
        : 'Your previous attempt already did work you should keep; resume from where you stopped rather than re-reading the repository from scratch.'),
      '',
      'What went wrong last time:',
      appendBounded('', args.continuation.appendedContext, 6_000),
      '',
    );
  }

  parts.push(
    `SOURCE WORKSPACE: ${args.workDir}`,
    'Search, run commands and make any code changes in the source workspace. The output artifact directory is only for stage handoff files.',
    '',
    args.stage.prompt ?? `Carry out the '${args.stage.name}' stage and write your findings to result.md.`,
  );

  if (args.inputs.length > 0) {
    parts.push('', 'INPUTS FROM UPSTREAM STAGES (the artefacts themselves, not summaries of them):');
    let budget = TOTAL_INLINE_CHARS;
    for (const input of args.inputs) {
      if (budget <= 0) {
        parts.push(`- ${input.stage}: inline budget exhausted — read ${input.path} yourself.`);
        continue;
      }
      const limit = Math.min(ARTIFACT_INLINE_CHARS, budget);
      const found = readArtifact(args.artifactRoot ?? args.workDir, input, limit);
      if (found.text === null) {
        parts.push(`- ${input.stage}: not found on disk — try ${found.from}.`);
        continue;
      }
      budget -= found.text.length;
      parts.push(
        '',
        `--- from stage '${input.stage}' (${found.from})${found.truncated ? ' [truncated]' : ''} ---`,
        found.text,
      );
    }
  }

  // The service prepends the worker brief, whose review/moderate guidance says to
  // leave the files as they are. A stage still has to write its artifact, so say
  // which write is allowed instead of leaving the two instructions to collide.
  const mode = args.stage.role ?? args.stage.name;
  const readOnly = isMode(mode) && MODE_PRESETS[mode].readOnly;
  parts.push(
    '',
    'OUTPUT ARTIFACT (separate from the source workspace):',
    ...(readOnly
      ? ['This is a read-only stage: leave every file in the source workspace as it is. ' +
         'Writing the output artifact below is your only permitted write, and it is where your findings go.']
      : []),
    `Write your full answer to ${stageArtifactPath(args.artifactRoot ?? args.workDir, args.stage.name, args.stage.resultPath)}. ` +
      'That file is what the next stage reads; a summary you say in prose is not.',
  );

  return parts.join('\n');
}

/** One provider tool call → one routing Observation. Pure. */
export function toObservation(activity: ForgeActivity): Observation {
  const bad = activity.status === 'error' || activity.status === 'denied';
  return {
    turn: activity.stepIndex,
    // Never 'edit' or 'verification' — see the header. We do not know.
    kind: bad ? 'error' : 'tool',
    tool: activity.tool,
    ok: !bad,
    ...(bad
      ? { message: `tool ${activity.tool} ${activity.status}` }
      : activity.input === undefined
        ? {}
        : { target: activity.input.slice(0, 200) }),
  };
}

export interface RunnerDeps {
  readonly service: ForgeService;
  /** Unique pipeline invocation id; scopes artifacts away from concurrent runs. */
  readonly runId?: string | undefined;
  /**
   * Bypass tool approvals for pipeline stages.
   *
   * FALSE, and it stays false. A pipeline is unattended by construction, and
   * unattended is exactly the condition under which agy soft-denies every tool
   * and reports success having done nothing. The caller has to say yes out loud.
   * See forge/service.ts's header.
   */
  readonly unrestricted?: boolean | undefined;
  /** Test/observability tap. Must not throw; the runner does not guard it. */
  readonly onObservation?: ((stage: string, obs: Observation) => void) | undefined;
  /** Called once a stage's job exists, so the pipeline record can show it running. Must not throw. */
  readonly onStageRunning?: ((result: StageResult) => void) | undefined;
}

/** Build the StageRunner. One closure over the service; nothing global. */
export function createForgeRunner(deps: RunnerDeps): StageRunner {
  const runId = deps.runId ?? `run-${Date.now()}-${randomBytes(5).toString('hex')}`;
  const artifactRoot = pipelineArtifactRoot(deps.service.repo, runId);
  async function run(ctx: StageContext): Promise<StageResult> {
    const startedAt = Date.now();
    const stage = ctx.stage;
    const continuation = ctx.continuation as StageContinuationLike | undefined;

    const sameProvider = continuation?.transcriptProvider === undefined || continuation.transcriptProvider === ctx.routing.provider;
    // A retry that continues this stage's own conversation already has the brief,
    // context and checks from attempt 1; only a fresh conversation needs them.
    const continuesAttempt = sameProvider && continuation?.transcriptRef !== undefined;
    const request: SpawnRequest = {
      mode: stage.role ?? stage.name,
      name: stage.agentName ?? ctx.continues?.agentName,
      workerId: stage.workerId ?? (ctx.continues === undefined ? `${runId}:${stage.name}` : ctx.continues.workerId ?? `${runId}:${ctx.continues.stage}`),
      task: stage.title ?? stage.prompt,
      prompt: buildStagePrompt({
        stage,
        workDir: ctx.workDir,
        artifactRoot,
        inputs: ctx.inputs,
        attempt: ctx.attempt,
        ...(continuation === undefined ? {} : { continuation }),
        canResumeTranscript:
          continuation?.transcriptRef === undefined || continuation.transcriptProvider === undefined || continuation.transcriptProvider === ctx.routing.provider,
      }),
      provider: ctx.routing.provider,
      cwd: ctx.workDir,
      artifactPath: path.resolve(stageArtifactPath(artifactRoot, stage.name, stage.resultPath)),
      ...(continuesAttempt ? {} : { context: stage.context, checks: stage.checks }),
      // 0 means "use the service default" (clampTimeout's DEFAULT_TIMEOUT_MS).
      // A stage timeout is ALSO enforced by the DAG via ctx.signal, so this is a
      // second, independent line of defence rather than the only one.
      timeoutMs: stage.timeoutMs ?? 0,
      unrestricted: deps.unrestricted,
      pipeline: ctx.pipeline,
      stage: stage.name,
      attempt: ctx.attempt,
      ...(ctx.routing.model === undefined ? {} : { model: ctx.routing.model }),
      // routing RULE 1: `low` unless routing moved the rung. Passing it through
      // is exactly right — the pipeline owns the rung, we do not second-guess.
      ...(stage.effort === undefined && ctx.routing.tier === 't0-cheap' ? {} : { effort: ctx.routing.effort }),
      // routing RULE 3: continue, do not restart.
      ...(sameProvider
        ? { conversation: continuation?.transcriptRef ?? ctx.continues?.transcriptRef ?? stage.conversation }
        : {}),
    };

    let jobId: string;
    try {
      mkdirSync(path.dirname(stageArtifactPath(artifactRoot, stage.name, stage.resultPath)), { recursive: true });
      const tracked = await deps.service.spawnTracked(request);
      jobId = tracked.ack.jobId;
      // As spawn_job does: the job reads "checks pending" until a verdict exists.
      if (stage.checks?.length) recordAcceptance(deps.service.repo, jobId, { state: 'unchecked', checks: [], pending: true });
      deps.onStageRunning?.({
        stage: stage.name, jobId, status: 'running', provider: ctx.routing.provider,
        ...(ctx.routing.model === undefined ? {} : { model: ctx.routing.model }),
        // The record's required timing fields: only startedAt is meaningful until the stage ends.
        startedAt, finishedAt: startedAt, durationMs: 0,
      });

      // The DAG aborts a stage by firing ctx.signal; the worker is a separate
      // process, so the bridge is `cancel`.
      const onAbort = (): void => {
        try {
          deps.service.cancel(jobId);
        } catch {
          /* already terminal, or never started */
        }
      };
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });

      // Collect the facts routing.ts escalates on, while the job runs. The tap
      // is a poll of our OWN state (half a second, one small JSON read) rather
      // than a second subscription to the provider's event stream: the service
      // already owns that stream, and these observations are only useful after
      // the attempt has ended anyway.
      const collection = collectObservations(deps.service, jobId, stage.name, deps.onObservation);

      const manifest = await tracked.done;
      const observations = await collection;

      publishArtifact(deps.service.repo, jobId, stage, artifactRoot);
      const result = toStageResult(stage, ctx, manifest, observations, startedAt, artifactRoot);
      if (!stage.checks?.length) return manifest.status === 'succeeded' ? { ...result, acceptance: 'unchecked' } : result;
      if (manifest.status !== 'succeeded') {
        recordAcceptance(deps.service.repo, jobId, { state: 'rejected', checks: [], at: new Date().toISOString(), reason: 'job did not succeed; checks not run' });
        return result;
      }

      const checks: Check[] = toVerifyChecks(stage.checks, ctx.workDir);
      const report = normalizeAcceptanceReport(await runChecks(checks, { signal: ctx.signal }), stage.checks);
      const acceptanceChecks = acceptanceChecksFromReport(report, stage.checks);
      recordAcceptance(deps.service.repo, jobId, { state: acceptanceState(acceptanceChecks), checks: acceptanceChecks, at: new Date().toISOString() });
      const checkEvidence = report.verdicts.map((verdict) =>
        `${verdict.passed ? 'PASS' : 'FAIL'} ${verdict.check.name}: ${verdict.reason}`,
      ).join('\n');
      if (report.passed && !report.incomplete) return { ...result, acceptance: 'passed', verification: report };
      const failedChecks = report.verdicts.filter((verdict) => !verdict.passed && verdict.blocking);
      return {
        ...result,
        status: 'failed',
        acceptance: 'failed',
        verification: report,
        failure: {
          code: 'verification-failed',
          message: failedChecks.map((verdict) => `${verdict.check.name}: ${verdict.reason}`).join('; ') || 'verification did not complete',
          retryable: true,
          detail: report,
        },
        ...(checkEvidence === '' ? {} : { outputTail: appendBounded(result.outputTail ?? '', `\n\nExecutable checks:\n${checkEvidence}`, OUTPUT_TAIL_CHARS) }),
      };
    } catch (err) {
      const t = Date.now();
      return {
        stage: stage.name,
        provider: ctx.routing.provider,
        ...(ctx.routing.model === undefined ? {} : { model: ctx.routing.model }),
        status: 'failed',
        startedAt,
        finishedAt: t,
        durationMs: t - startedAt,
        failure: {
          code: 'spawn-failed',
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        },
      };
    }
  }

  return { id: 'forge', run };
}

/** Persist the stage job's acceptance beside its record. A failed write must not fail the stage. */
function recordAcceptance(repo: string, jobId: string, acceptance: Acceptance): void {
  try { writeAcceptance(repo, jobId, acceptance); } catch (err) { process.stderr.write(`agent-smith acceptance ${jobId}: ${String(err)}\n`); }
}

/* ── observation collection ──────────────────────────────────────────────── */

/**
 * Poll the job's own activity rows for the whole attempt.
 *
 * Turn numbers are the tool step index, which is monotonic within a job. That is
 * what makes routing.ts's "N consecutive turns with no tool call" rule mean what
 * it says rather than count stream events.
 *
 * Bounded on purpose: routing's stall rules are thresholds over a shape, and a
 * 5,000-element observation array is neither cheaper to analyse nor more
 * informative than the tail that contains the stall. See ACTIVITY_TAIL.
 */
export async function collectObservations(
  service: ForgeService,
  jobId: string,
  stage: string,
  onObservation?: (stage: string, obs: Observation) => void,
): Promise<Observation[]> {
  const out: Observation[] = [];
  // A tool step is one row that moves active -> done/error/denied, so a step's
  // identity is its index and a later state replaces the earlier one.
  const slots = new Map<number, number>();
  const states = new Map<number, string>();
  for (;;) {
    const rows = await service.activities(jobId);
    let progressed = false;
    for (const row of rows) {
      const key = `${row.tool}:${row.status}`;
      if (states.get(row.stepIndex) === key) continue;
      states.set(row.stepIndex, key);
      progressed = true;
      const obs = toObservation(row);
      const slot = slots.get(row.stepIndex);
      if (slot === undefined) { slots.set(row.stepIndex, out.length); out.push(obs); } else out[slot] = obs;
      try {
        onObservation?.(stage, obs);
      } catch {
        /* an observer's problem */
      }
    }
    // Terminal means done. `unknown` is NOT terminal: an unreadable anchor is
    // not an ending, and stopping on it would silently truncate every
    // observation series the moment a reader raced a write.
    const state = await service.state(jobId);
    if (!progressed && state !== 'running') break;
    if (state !== 'running' && state !== 'unknown') break;
    await sleep(500);
  }
  return out.slice(-ACTIVITY_TAIL);
}

/** How many observations we keep. routing's thresholds are all well under this. */
export const ACTIVITY_TAIL = 400;

/** Stable root for one pipeline invocation's handoff artifacts. */
export function pipelineArtifactRoot(repo: string, runId: string): string {
  return path.join(repo, '.agent-smith', 'pipelines', safeSegment(runId), 'artifacts');
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100) || 'pipeline';
}

function sleep(ms: number): Promise<void> {
  // This poll is part of the supervisor's durability path. In particular after
  // cancellation it must keep the process alive long enough to collect the
  // terminal job state and persist the pipeline record.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Copy the job's report to the pipeline's artefact path.
 *
 * The job directory holds the canonical report (that is the state format's
 * `result.md`); the stage directory holds what the DAG hands downstream. Same
 * bytes, two homes, because the two consumers are different systems and neither
 * should have to know about the other. Best effort: a missing report is not an
 * error here, because the stage may legitimately have produced none.
 */
function publishArtifact(repo: string, jobId: string, stage: Stage, workDir: string): void {
  const from = jobFile(repo, jobId, FILES.report);
  const to = stageArtifactPath(workDir, stage.name, stage.resultPath);
  // Workers often write the requested file themselves, with substantially more
  // useful detail than the bounded text returned in the provider result.
  if (existsSync(to)) return;
  try {
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  } catch {
    /* no report, or the artifact is unwritable; the StageResult carries the verdict */
  }
}

/* ── result mapping ──────────────────────────────────────────────────────── */

/**
 * One `ForgeManifest` → one `StageResult`.
 *
 * The artifact paths are returned on FAILURE too, deliberately. pipeline.ts's
 * `inputsFor()` propagates a skipped stage's declared artefacts to its own
 * dependents, and a human debugging a partial run needs to read the failed
 * stage's report to find out why. A StageResult with no `resultPath` and a
 * failure is the least informative thing this function could produce.
 *
 * `passed` requires the writer's verdict, which deriveStatus already refuses to
 * call `succeeded` for an empty report. The second condition here is that the
 * artefact exists on disk: the StageResult is the DAG's verdict, the DAG has no
 * reader for a manifest, and "the worker said it passed but there is nothing to
 * hand the next stage" is the failure mode a DAG cannot recover from.
 */
export function toStageResult(
  stage: Stage,
  ctx: StageContext,
  manifest: ForgeManifest,
  observations: readonly Observation[],
  startedAt: number,
  workDir: string,
): StageResult {
  const finishedAt = Date.now();
  const durationMs = finishedAt - startedAt;
  const ref = stageArtifactRef(stage.name, stage.resultPath);
  const artifact = path.resolve(stageArtifactPath(workDir, stage.name, stage.resultPath));
  const report = readTail(artifact);
  // Listing a file that is not there sends the next stage after a ghost.
  const written = existsSync(artifact);
  const base = {
    stage: stage.name,
    jobId: manifest.jobId,
    provider: manifest.provider,
    ...(manifest.model === null ? {} : { model: manifest.model }),
    startedAt,
    finishedAt,
    durationMs,
    ...(written
      ? { resultPath: ref, artifacts: [{ stage: stage.name, path: ref, label: 'result.md' }] }
      : { artifacts: [], warnings: [`${ref} not found on disk; the stage wrote no artifact`] }),
    ...(manifest.conversation === null ? {} : { transcriptRef: manifest.conversation }),
    ...(report === null ? {} : { outputTail: report }),
    observations,
  };

  if (manifest.status === 'succeeded' && report !== null) {
    return { ...base, status: 'passed' };
  }

  return {
    ...base,
    status: 'failed',
    failure:
      manifest.status === 'succeeded'
        ? {
            // The rule this whole project is named after, asserted at the DAG
            // boundary too: the worker claimed success and there is nothing on
            // disk to hand downstream.
            code: 'no-result',
            message: `stage '${stage.name}' reported success but wrote no readable ${ref}`,
            retryable: true,
          }
        : {
            // The provider's own status word, not our prose. `denied` in
            // particular has to survive verbatim: it is the difference between
            // "the tool broke" and "the permission model ate the work", and the
            // remedy is different.
            code: manifest.jobStatus ?? manifest.status,
            message: manifest.error ?? `stage '${stage.name}' finished ${manifest.status}`,
            retryable: manifest.jobStatus === 'error' || manifest.jobStatus === 'malformed',
            detail: { jobId: manifest.jobId, denied: manifest.deniedActions },
          },
  };
}

/** The tail of an artefact, bounded. Diagnostics only, never a verdict. */
export function readTail(file: string, max = OUTPUT_TAIL_CHARS): string | null {
  let body: string;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const trimmed = body.trim();
  if (trimmed === '') return null;
  return trimmed.length <= max ? trimmed : trimmed.slice(trimmed.length - max);
}

/** Where a stage's job directory lives. Exported so tests can assert on it. */
export function stageJobDir(repo: string, jobId: string): string {
  return jobDir(repo, jobId);
}
