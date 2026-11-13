/** MCP control surface over the canonical forge runtime. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claimMarkerPath } from '../../mod/hooks/notice.ts';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Server } from '@modelcontextprotocol/server';
import type { ForgeStatus } from '../../../forge/format.ts';
import { ENV_KEYS_FILE, type ForgeService, type JobDetail } from '../../../forge/service.ts';
import { launchPipeline } from '../../../forge/supervisor.ts';
import { FILES, jobFile } from '../../../forge/format.ts';
import { startPipeline, readPipeline, cancelPipeline } from '../../../forge/execute.ts';
import { markAcceptancePending, markAcceptanceSuperseded, readAcceptance, settleAcceptance } from '../../../forge/checks.ts';
import { validateSpec } from '../../../pipeline/pipeline.ts';
import { EFFORTS, validateEnv, type StageCheck } from '../../../pipeline/types.ts';
import { MODES, MODE_PRESETS } from '../../../forge/modes.ts';
import { getCatalogs, getInstalledProviders } from '../../../providers/catalog.ts';
import { providerNames } from '../../../providers/registry.ts';
import { loadModelConfig, resolveRequest, describeAliases } from '../../../providers/aliases.ts';
import { CONCISE_LIST_LIMIT, EARLIER_TURNS_CAP, conciseCapabilities, conciseRow, conciseStatus, concisePipeline, earlierTurn, jobDiff, jobLiveness, livenessView, parseSince, taskStatus, type ResponseFormat } from './views.ts';
import { isStalled } from '../../mod/hooks/stale.ts';
import { PROVIDERS, TOOL_DEFS, MAX_WAIT_MS } from './tool-defs.ts';
import { allowed, boolean, contextText, filesList, format, keys, number, parseChecks, parseStages, record, text, workingDirectory } from './args.ts';
import { defaultMixedPipeline, defaultProvider, installedCatalogs, type CatalogSource } from './stage-defaults.ts';
import { launchTask, notifyHint } from './notify.ts';

// The tool-facing surface lives in sibling modules; callers keep importing it from here.
export { MAX_CONTEXT_CHARS, TOOL_DEFS, type ToolAnnotations, type ToolDef } from './tool-defs.ts';
export { parseStages } from './args.ts';
export { defaultMixedPipeline, type CatalogSource, type MixedSpecInput } from './stage-defaults.ts';
export { builtMonitorPath, notifyHint } from './notify.ts';

export const REPORT_HEAD_CHARS = 8_000;
const WAIT_POLL_MS = 500;

// ── unrestricted confirmation ────────────────────────────────────────────────
/** Providers that run restricted unless asked. agy and kimi are unrestricted by design: headless they cannot prompt (kimi's print mode forces auto). */
const RESTRICTED_BY_DEFAULT = new Set(['codex', 'claude', 'opencode']);
/** Long enough for a person to read the prompt and answer; the SDK default (60 s) is not. */
const CONFIRM_TIMEOUT_MS = 10 * 60_000;
export const DECLINED_UNRESTRICTED = 'The user declined unrestricted access; rerun without unrestricted, or ask the user.';
export const UNCONFIRMED_UNRESTRICTED = 'unrestricted: true was not confirmed with the user: this client cannot show a confirmation prompt (no MCP elicitation support).';
/**
 * Ask the user before an explicit unrestricted:true escalates a provider that runs restricted by default.
 * Returns `refused` to stop the call, or a `warning` for the ack when no prompt was possible.
 * Skipped for agy, for unrestricted false/absent, and when AGENT_SMITH_CONFIRM_UNRESTRICTED=0 (automation).
 */
async function confirmUnrestricted(ctx: HandlerContext, req: { unrestricted?: boolean | undefined; provider: string; worker?: string | undefined; cwd: string }): Promise<{ refused?: ToolOutcome; warning?: string }> {
  if (req.unrestricted !== true || !RESTRICTED_BY_DEFAULT.has(req.provider) || process.env['AGENT_SMITH_CONFIRM_UNRESTRICTED'] === '0') return {};
  if (!ctx.server?.getClientCapabilities()?.elicitation?.form) return { warning: UNCONFIRMED_UNRESTRICTED };
  const who = req.worker ? `${req.provider} worker "${req.worker}"` : `a new ${req.provider} worker`;
  try {
    const answer = await ctx.server.elicitInput({ mode: 'form', message: `Allow ${who} to run without approval prompts in ${req.cwd}? It will be able to run any command.`, requestedSchema: { type: 'object', properties: {} } }, { timeout: CONFIRM_TIMEOUT_MS });
    return answer.action === 'accept' ? {} : { refused: failure(DECLINED_UNRESTRICTED) };
  } catch (err) {
    // No answer is not consent: fail closed.
    return { refused: failure(`Could not confirm unrestricted access with the user (${err instanceof Error ? err.message : String(err)}); rerun without unrestricted, or ask the user.`) };
  }
}

export type ToolOutcome = CallToolResult;
export interface HandlerContext {
  readonly service: ForgeService; readonly pollMs?: number; readonly onStageSpawned?: (stage: string, jobId: string) => void; readonly catalogs?: CatalogSource;
  /** Persist an external task link after validation/approval and before the worker starts. */
  readonly onJobPrepared?: (jobId: string) => void;
  /** The MCP server, to ask the user mid-call (elicitation). Absent outside the server: no prompt is possible. */
  readonly server?: Pick<Server, 'getClientCapabilities' | 'elicitInput'>;
  /** Override CANCEL_SETTLE_MS (tests). */
  readonly cancelSettleMs?: number;
}
export function json(value: unknown): ToolOutcome { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
/** json plus structuredContent (arrays wrapped as {items}). */
export function structured(value: unknown, { compact = false }: { compact?: boolean } = {}): ToolOutcome {
  const out = compact ? { content: [{ type: 'text' as const, text: JSON.stringify(value) }] } : json(value);
  const sc = Array.isArray(value) ? { items: value } : value;
  return sc !== null && typeof sc === 'object' ? { ...out, structuredContent: sc as Record<string, unknown> } : out;
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/** Checks running now for a finished job, by job ID, so `cancel` can stop them. */
const RUNNING_CHECKS = new Map<string, AbortController>();
function abortChecks(...ids: string[]): boolean {
  let aborted = false;
  for (const id of ids) { const c = RUNNING_CHECKS.get(id); if (c) { c.abort(); aborted = true; } }
  return aborted;
}
/** Detached, tools-layer-owned: await terminal state, run checks, write acceptance.json. Never throws. */
function gateAcceptance(ctx: HandlerContext, jobId: string, done: Promise<{ jobId?: string; status: string; cwd?: string | null }>, checks: StageCheck[], preparedJobIds: readonly string[]): void {
  if (ctx.service.supervisorUrl) return; // The execution owner runs checks across server reloads.
  void (async () => {
    const manifest = await done;
    const finalJobId = manifest.jobId ?? jobId;
    const controller = new AbortController();
    RUNNING_CHECKS.set(finalJobId, controller);
    try {
      await settleAcceptance({ succeeded: manifest.status === 'succeeded', checks, baseDir: manifest.cwd ?? ctx.service.repo, repo: ctx.service.repo, finalJobId, preparedJobIds, signal: controller.signal });
    } finally { RUNNING_CHECKS.delete(finalJobId); }
  })().catch(err => process.stderr.write(`agent-smith acceptance ${jobId}: ${String(err)}\n`));
}
export function failure(message: string, detail?: unknown): ToolOutcome { return { isError: true, content: [{ type: 'text', text: message + (detail === undefined ? '' : `\n${JSON.stringify(detail)}`) }] }; }

/** The full `status` view of one job; Tasks results reuse it. */
export function fullStatus(detail: JobDetail, acceptance: ReturnType<typeof readAcceptance>, now = Date.now()) {
  const live = jobLiveness(detail, now);
  return { ...detail, resumable: Boolean(detail.conversation), ...(live === null ? {} : { liveness: livenessView(live) }), stalled: isStalled(live), taskStatus: taskStatus(detail.status), report: detail.report?.slice(0, REPORT_HEAD_CHARS) ?? null, reportTruncated: (detail.report?.length ?? 0) > REPORT_HEAD_CHARS, acceptance };
}

type Args = Record<string, unknown>;
type Handler = (ctx: HandlerContext, args: Args) => Promise<ToolOutcome>;

const resolveHead = (ctx: HandlerContext, id: string) => typeof ctx.service.resolveHead === 'function' ? ctx.service.resolveHead(id) : id;

const listCapabilitiesTool: Handler = async (ctx, args) => {
  const fmt = format(args);
  // Read before nearly every spawn, so its concise text is sent unindented.
  return structured(await listCapabilities(ctx, boolean(args, 'refresh') ?? false, fmt, allowed(args, 'provider', PROVIDERS)), { compact: fmt === 'concise' });
};

/** One spawn: the ack as an object. Throws on a bad request or a refused confirmation. */
async function spawnOne(ctx: HandlerContext, args: Args): Promise<Record<string, unknown>> {
  const mode = allowed(args, 'mode', MODES); if (mode === undefined) throw new Error(`mode is required; one of ${MODES.join(', ')}.`);
  const cfg = loadModelConfig({ repo: ctx.service.repo });
  const resolved = resolveRequest({ provider: allowed(args, 'provider', PROVIDERS), model: text(args, 'model'), effort: allowed(args, 'effort', EFFORTS), mode }, cfg);
  const provider = resolved.provider ?? defaultProvider(ctx.catalogs ? (await installedCatalogs(ctx)).map(c => c.provider) : await getInstalledProviders());
  const notes = [...resolved.warnings, ...cfg.errors.map(e => `models.json: ${e}`)];
  const withNotes = <T extends { warnings?: readonly string[]; jobId?: string; timeoutMs?: number }>(ack: T) => ({ ...ack, ...(ack.jobId ? { taskHandle: launchTask(ack.jobId), notify: notifyHint({ job: ack.jobId }, ctx.service.repo, ack.timeoutMs) } : {}), ...(resolved.appliedAlias ? { aliasApplied: resolved.appliedAlias, aliasSource: resolved.source } : {}), ...(notes.length ? { warnings: [...(ack.warnings ?? []), ...notes] } : {}) });
  const checks = parseChecks(args.checks);
  const preparedJobIds: string[] = [];
  const onPrepared = (jobId: string) => {
    if (preparedJobIds.length === 0) {
      // First: if it throws, the job is aborted and must not be left with checks pending.
      ctx.onJobPrepared?.(jobId);
    } else {
      try { ctx.onJobPrepared?.(jobId); } catch { /* best-effort rebind on continuation turn */ }
    }
    const prevId = preparedJobIds.at(-1);
    preparedJobIds.push(jobId);
    if (checks?.length) {
      if (prevId) {
        try { markAcceptanceSuperseded(ctx.service.repo, prevId); } catch { /* ignore */ }
      }
      try { markAcceptancePending(ctx.service.repo, jobId, checks); } catch (err) { process.stderr.write(`agent-smith acceptance ${jobId}: ${String(err)}\n`); }
    }
  };
  const request = { mode, prompt: text(args, 'prompt', true)!, context: contextText(args), files: filesList(args), checks, cwd: workingDirectory(args), name: text(args, 'name'), task: text(args, 'task'), provider, model: resolved.model, effort: resolved.effort, timeoutMs: number(args, 'timeoutMs'), conversation: text(args, 'conversation'), unrestricted: boolean(args, 'unrestricted'), env: validateEnv(args.env), onPrepared };
  // After every argument is validated, so the user is never asked about a call that then fails.
  const gate = await confirmUnrestricted(ctx, { unrestricted: request.unrestricted, provider, worker: request.name, cwd: request.cwd ?? ctx.service.repo });
  if (gate.refused) throw new Error(refusedText(gate.refused));
  if (gate.warning) notes.push(gate.warning);
  const saved = { mode, prompt: request.prompt, context: request.context, files: request.files, cwd: request.cwd, task: request.task, name: request.name, provider, model: text(args, 'model'), effort: allowed(args, 'effort', EFFORTS), timeoutMs: request.timeoutMs, unrestricted: request.unrestricted };
  if (!checks?.length) { const ack = await ctx.service.spawnJob(request); saveRequest(ctx, ack.jobId, saved); return { ...withNotes(ack), provider }; }
  const { ack, done } = await ctx.service.spawnTracked(request);
  if (!preparedJobIds.includes(ack.jobId)) {
    preparedJobIds.push(ack.jobId);
    try { markAcceptancePending(ctx.service.repo, ack.jobId, checks); } catch (err) { process.stderr.write(`agent-smith acceptance ${ack.jobId}: ${String(err)}\n`); }
  }
  gateAcceptance(ctx, ack.jobId, done, checks, preparedJobIds);
  saveRequest(ctx, ack.jobId, saved);
  return { ...withNotes(ack), provider, checks: checks.map(c => c.name) };
}

const refusedText = (r: ToolOutcome) => (r.content as { text?: string }[])[0]?.text ?? 'refused';

/** The request a fresh spawn was made with, so `from` can reuse its brief. Best effort. */
function saveRequest(ctx: HandlerContext, jobId: string, saved: Record<string, unknown>): void {
  try { writeFileSync(jobFile(ctx.service.repo, jobId, FILES.request), JSON.stringify(saved)); } catch { /* from will say the brief is missing */ }
}

/** Most variants one spawn_job call starts. */
export const MAX_VARIANTS = 8;
const VARIANT_KEYS = ['name', 'provider', 'model', 'effort'] as const;

/**
 * Overrides on top of a base request. A different provider drops the base's model, effort and
 * unrestricted: they belonged to the old provider.
 */
function overlay(base: Args, over: Args): Args {
  const defined = Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined));
  const switched = defined.provider !== undefined && defined.provider !== base.provider;
  const kept = switched ? Object.fromEntries(Object.entries(base).filter(([k]) => !['model', 'effort', 'unrestricted'].includes(k))) : base;
  return { ...kept, ...defined };
}

/** spawn_job args with `from` resolved: the earlier worker's first request, overlaid with what this call passes. */
async function inheritFrom(ctx: HandlerContext, args: Args): Promise<Args> {
  const from = text(args, 'from', true)!;
  const detail = await ctx.service.resolveWorker(from);
  const root = detail.workerId || detail.jobId;
  let saved: Args;
  try { saved = JSON.parse(readFileSync(jobFile(ctx.service.repo, root, FILES.request), 'utf8')) as Args; } catch {
    throw new Error(`"${detail.name}" has no saved request to reuse (a pipeline stage, or spawned before from existed); pass mode and prompt.`);
  }
  try { saved.checks = JSON.parse(readFileSync(jobFile(ctx.service.repo, root, FILES.checksSpec), 'utf8')); } catch { /* spawned without checks */ }
  delete saved.name;
  const { from: _from, ...rest } = args;
  return overlay(saved, rest);
}

const spawnJob: Handler = async (ctx, args) => {
  const base = args.from === undefined ? args : await inheritFrom(ctx, args);
  if (args.variants === undefined) return structured(await spawnOne(ctx, base));
  if (ctx.onJobPrepared) throw new Error('variants start several jobs, and a task-augmented call tracks one; call spawn_job once per variant.');
  if (!Array.isArray(args.variants) || args.variants.length === 0 || args.variants.length > MAX_VARIANTS) throw new Error(`variants must be an array of 1 to ${MAX_VARIANTS} entries.`);
  const { variants: _v, ...shared } = base;
  const stem = text(shared, 'name') ?? text(shared, 'mode') ?? 'job';
  const variants = args.variants.map((raw, i) => { const v = record(raw, `variants[${i}]`); keys(v, [...VARIANT_KEYS]); return v; });
  const names = variants.map(v => text(v, 'name') ?? [stem, text(v, 'provider') ?? text(shared, 'provider'), text(v, 'model')].filter(Boolean).join('-').slice(0, 80));
  if (new Set(names).size !== names.length) throw new Error('variants need distinct names; pass name on each variant.');
  const jobs: Record<string, unknown>[] = [];
  for (const [i, v] of variants.entries()) {
    try { jobs.push(await spawnOne(ctx, overlay(shared, { ...v, name: names[i] }))); } catch (err) { jobs.push({ name: names[i], error: err instanceof Error ? err.message : String(err) }); }
  }
  return structured({ jobs });
};



const resumeJob: Handler = async (ctx, args) => {
  const worker = text(args, 'worker', true)!;
  const detail = await ctx.service.resolveWorker(worker);
  if (detail.status === 'running') throw new Error(`"${detail.name}" is still running; use steer_job with delivery: "queue" or "interrupt", or wait.`);
  if (!detail.conversation) throw new Error(`"${detail.name}" has no conversation to resume: the provider did not save a conversation before it stopped. Use spawn_job with the full original brief; on-disk edits remain in ${detail.cwd ?? ctx.service.repo}.`);
  const resumeModel = resolveRequest({ provider: detail.provider ?? undefined, model: text(args, 'model'), effort: allowed(args, 'effort', EFFORTS) }, loadModelConfig({ repo: ctx.service.repo }));
  let inheritedChecks: StageCheck[] | undefined;
  if (args.checks === undefined) {
    try { inheritedChecks = parseChecks(JSON.parse(readFileSync(jobFile(ctx.service.repo, detail.jobId, FILES.checksSpec), 'utf8'))); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const checks = args.checks === undefined ? inheritedChecks : parseChecks(args.checks);
  const preparedJobIds: string[] = [];
  const onPrepared = (id: string) => {
    ctx.onJobPrepared?.(id);
    preparedJobIds.push(id);
    if (checks?.length) markAcceptancePending(ctx.service.repo, id, checks);
  };
  const prompt = text(args, 'prompt', true)!; const cwd = workingDirectory(args) ?? detail.cwd ?? ctx.service.repo;
  const timeoutMs = number(args, 'timeoutMs'); const unrestricted = boolean(args, 'unrestricted');
  const inheritedFiles = Object.keys(detail.watchedFiles ?? {});
  const mergedFiles = [...new Set([...inheritedFiles, ...(filesList(args) ?? [])])];
  // Only an explicit unrestricted:true asks; an inherited setting was the original job's.
  const gate = await confirmUnrestricted(ctx, { unrestricted, provider: detail.provider ?? '', worker: detail.name, cwd });
  if (gate.refused) return gate.refused;
  const request = { checks, mode: detail.mode ?? 'task', prompt, files: mergedFiles.length > 0 ? mergedFiles : undefined, ...(detail.watchedFiles ? { previousWatchedFiles: detail.watchedFiles } : {}), provider: detail.provider ?? undefined, model: resumeModel.model ?? detail.model ?? undefined, effort: resumeModel.effort ?? detail.effort ?? undefined, name: detail.name, workerId: detail.workerId, task: detail.task ?? undefined, cwd, conversation: detail.conversation, timeoutMs, unrestricted: unrestricted ?? detail.unrestricted, env: validateEnv(args.env), onPrepared };
  const tracked = checks?.length ? await ctx.service.spawnTracked(request) : null;
  const resumed = tracked?.ack ?? await ctx.service.spawnJob(request);
  if (tracked && checks) gateAcceptance(ctx, resumed.jobId, tracked.done, checks, preparedJobIds);
  let droppedEnv: string[] = [];
  if (request.env === undefined) { try { droppedEnv = JSON.parse(readFileSync(jobFile(ctx.service.repo, detail.jobId, ENV_KEYS_FILE), 'utf8')) as string[]; } catch { /* the original had no env */ } }
  const allWarnings = [...(resumed.warnings ?? []), ...(gate.warning ? [gate.warning] : []), ...(droppedEnv.length > 0 ? [`The original job set env ${droppedEnv.join(', ')}; values are not stored, so this turn runs without them. Pass env again to keep them.`] : [])];
  return structured({ ...resumed, taskHandle: launchTask(resumed.jobId), notify: notifyHint({ job: resumed.jobId }, ctx.service.repo, resumed.timeoutMs), ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}) });
};

const steerJob: Handler = async (ctx, args) => {
  const worker = text(args, 'worker', true)!;
  const prompt = text(args, 'prompt', true)!;
  const context = contextText(args);
  const files = filesList(args);
  const delivery = allowed(args, 'delivery', ['queue', 'interrupt']) as 'queue' | 'interrupt' | undefined;
  if (delivery === undefined) throw new Error('delivery is required: choose "queue" (after current turn) or "interrupt" (stop current turn now).');
  const ack = await ctx.service.steer({ worker, prompt, context, files, delivery });
  const idNote = ` The continuation gets a new job ID; status and cancel on ${ack.jobId} follow it.`;
  return structured({ ...ack, note: `${ack.note}${idNote}`, taskHandle: launchTask(ack.jobId), notify: notifyHint({ job: ack.jobId }, ctx.service.repo, ack.timeoutMs) });
};

const listJobs: Handler = async (ctx, args) => {
  const fmt = format(args); const since = text(args, 'since');
  const limit = number(args, 'limit', 500) ?? (fmt === 'concise' ? CONCISE_LIST_LIMIT : undefined);
  // Concise asks for one extra row so a cut list says so instead of looking complete.
  const jobs = await ctx.service.list({ status: allowed(args, 'status', ['running', 'succeeded', 'failed', 'canceled']) as ForgeStatus | undefined,
    limit: fmt === 'concise' && limit !== undefined ? limit + 1 : limit, sinceMs: since === undefined ? undefined : parseSince(since), ids: boolean(args, 'session') ? ctx.service.spawnedIds : undefined });
  // A turn a steer replaced is not a worker; its continuation's row stands for it.
  const workers = jobs.filter(j => !j.supersededBy);
  if (fmt !== 'concise') return structured(workers.map(j => { const live = jobLiveness(j); return { ...j, taskStatus: taskStatus(j.status), ...(live === null ? {} : { liveness: livenessView(live), stalled: isStalled(live) }) }; }));
  const rows = workers.slice(0, limit).map(j => conciseRow(j));
  return structured(workers.length > rows.length
    ? { items: rows, more: `More than ${rows.length} jobs match; narrow with since, status or session, or raise limit.` }
    : rows);
};

const jobStatus: Handler = async (ctx, args) => {
  const jobId = text(args, 'jobId', true)!; const waitMs = number(args, 'wait_ms', MAX_WAIT_MS); const fmt = format(args); const wantDiff = boolean(args, 'include_diff') ?? false;
  let detail = await ctx.service.detail(resolveHead(ctx, jobId)); let waited = false;
  if (waitMs !== undefined) {
    waited = true; const deadline = Date.now() + waitMs; const step = ctx.pollMs ?? WAIT_POLL_MS;
    while ((detail.status === 'running' || Boolean(detail.supersededBy)) && Date.now() < deadline) {
      await sleep(Math.min(step, Math.max(0, deadline - Date.now())));
      detail = await ctx.service.detail(resolveHead(ctx, detail.jobId));
    }
  }
  const reportPath = jobFile(ctx.service.repo, detail.jobId, FILES.report);
  if (boolean(args, 'report_only')) return structured({ jobId: detail.jobId, status: detail.status, taskStatus: taskStatus(detail.status), report: detail.report, reportPath });
  const acceptance = readAcceptance(ctx.service.repo, detail.jobId); const wait = waited ? { waited: true, stillRunning: detail.status === 'running' || Boolean(detail.supersededBy) } : {};
  const diff = wantDiff ? await jobDiff(detail) : {};
  // Oldest first, so the turns read in the order the worker took them.
  const earlier: JobDetail[] = [];
  for (let id = detail.steeredFrom; id && earlier.length < EARLIER_TURNS_CAP;) {
    const turn = await ctx.service.detail(id).catch(() => null);
    if (turn === null) break;
    earlier.unshift(turn); id = turn.steeredFrom;
  }
  const turns = earlier.length > 0 ? { earlierTurns: earlier.map(t => earlierTurn(t, jobFile(ctx.service.repo, t.jobId, FILES.report), fmt)) } : {};
  if (fmt === 'concise') return structured({ ...conciseStatus(detail, acceptance, wait), reportPath, resumable: Boolean(detail.conversation), ...turns, ...diff });
  return structured({ ...fullStatus(detail, acceptance), reportPath, resumable: Boolean(detail.conversation), ...turns, ...wait, ...diff });
};

const pipelineStatus: Handler = async (ctx, args) => {
  const runId = text(args, 'runId', true)!; const r = readPipeline(ctx.service.repo, runId);
  if (!r) throw new Error(`No pipeline run "${runId}".`);
  return json(format(args) === 'concise' ? concisePipeline(r) : r);
};

/** The caller asked for this cancel and its answer says the job stopped: mark it claimed so the command hook stays silent. */
function quietNotice(repo: string, kind: 'job' | 'run', id: string): void {
  const marker = claimMarkerPath(repo, kind, id);
  try { mkdirSync(path.dirname(marker), { recursive: true }); writeFileSync(marker, `${new Date().toISOString()}\n`, { flag: 'wx' }); } catch { /* already claimed, or best effort */ }
}

/** How long cancel waits for a job or run to settle before answering. */
export const CANCEL_SETTLE_MS = 5_000;

/**
 * Cancel, then wait briefly for the settled state. The answer is the job's status after the wait,
 * so the caller learns whether it stopped without a second call. `settled: false` (still
 * running after the wait) is the one case worth a later status call.
 */
const cancelJob: Handler = async (ctx, args) => {
  const id = text(args, 'jobId', true)!;
  const step = ctx.pollMs ?? WAIT_POLL_MS;
  const settleBy = Date.now() + (ctx.cancelSettleMs ?? CANCEL_SETTLE_MS);
  if (readPipeline(ctx.service.repo, id)) {
    cancelPipeline(ctx.service.repo, id);
    let run = readPipeline(ctx.service.repo, id);
    while (run?.status === 'running' && Date.now() < settleBy) { await sleep(Math.min(step, Math.max(0, settleBy - Date.now()))); run = readPipeline(ctx.service.repo, id); }
    const status = run?.status ?? 'unknown';
    if (status !== 'running') quietNotice(ctx.service.repo, 'run', id);
    return json({ runId: id, status, settled: status !== 'running' });
  }
  const result = ctx.service.cancel(id);
  const resolved = result.resolvedFrom === undefined ? {} : { resolvedFrom: result.resolvedFrom };
  // A worker that already exited can still have checks running; stop those too.
  // With a detached supervisor the cancel marker is the request; the supervisor stops the checks within ~200 ms.
  const checksCanceled = abortChecks(id, result.jobId);
  let detail = await ctx.service.detail(result.jobId).catch(() => null);
  while (detail?.status === 'running' && Date.now() < settleBy) {
    await sleep(Math.min(step, Math.max(0, settleBy - Date.now())));
    detail = await ctx.service.detail(resolveHead(ctx, result.jobId)).catch(() => detail);
  }
  const status = detail?.status ?? 'unknown';
  const out: Record<string, unknown> = { jobId: detail?.jobId ?? result.jobId, ...resolved, status, settled: status !== 'running' };
  if (status !== 'running') quietNotice(ctx.service.repo, 'job', String(out.jobId));
  if (checksCanceled) return json({ ...out, checksCanceled: true });
  const pending = readAcceptance(ctx.service.repo, result.jobId) as { pending?: boolean; running?: string };
  return json(pending.pending === true && pending.running !== undefined
    ? { ...out, checksCanceled: false, checksNote: 'The supervisor running the acceptance checks will stop them; status shows acceptance.' }
    : out);
};

const runPipeline: Handler = async (ctx, args) => {
  const raw = record(args.spec, 'spec'); keys(raw, ['name', 'task', 'workDir', 'concurrency', 'unrestricted', 'stages']);
  const stages = parseStages(raw.stages); const task = text(raw, 'task', stages === undefined);
  const spec = await defaultMixedPipeline({ name: text(raw, 'name', true)!, task: task ?? '', stages, workDir: text(raw, 'workDir') ?? ctx.service.repo, concurrency: number(raw, 'concurrency', 32), modelConfig: loadModelConfig({ repo: ctx.service.repo }) }, ctx.catalogs);
  validateSpec(spec);
  const run = ctx.service.supervisorUrl
    ? await launchPipeline(ctx.service, spec, { unrestricted: boolean(raw, 'unrestricted') })
    : startPipeline(ctx.service, spec, { unrestricted: boolean(raw, 'unrestricted') });
  void run.done.catch(err => process.stderr.write(`agent-smith pipeline ${run.runId}: ${String(err)}\n`));
  return json({ runId: run.runId, recordPath: run.recordPath, stages: spec.stages.map(s => ({ name: s.name, provider: s.provider, dependsOn: s.dependsOn ?? [] })), started: true, taskHandle: launchTask(run.runId), notify: notifyHint({ run: run.runId }, ctx.service.repo, Math.max(0, ...spec.stages.map(st => st.timeoutMs ?? 0)) || undefined) });
};

const HANDLERS: Readonly<Record<string, Handler>> = {
  list_capabilities: listCapabilitiesTool, spawn_job: spawnJob, resume_job: resumeJob, steer_job: steerJob,
  list_jobs: listJobs, status: jobStatus, pipeline_status: pipelineStatus, cancel: cancelJob, run_pipeline: runPipeline,
};

export async function callTool(ctx: HandlerContext, name: string, rawArgs: unknown): Promise<ToolOutcome> {
  try {
    const def = TOOL_DEFS.find(t => t.name === name); if (!def) throw new Error(`Unknown tool ${name}; available: ${TOOL_DEFS.map(t => t.name).join(', ')}.`);
    const args = record(rawArgs ?? {}, 'arguments'); keys(args, Object.keys(def.inputSchema.properties as object));
    const handler = HANDLERS[name]; if (!handler) throw new Error(`Unknown tool ${name}.`);
    return await handler(ctx, args);
  } catch (err) { return failure(err instanceof Error ? err.message : String(err)); }
}

async function listCapabilities(ctx: HandlerContext, refresh: boolean, fmt: ResponseFormat, only: string | undefined) {
  const cats = ctx.catalogs ? await installedCatalogs(ctx) : await installedCatalogs({ catalogs: () => getCatalogs({ refresh, repo: ctx.service.repo }) });
  const installed = new Set(cats.map(c => c.provider));
  const all = [
    ...cats.map(c => ({ name: c.provider, available: true, defaultModel: c.defaultModel, defaultEffort: c.defaultEffort, defaultSource: c.defaultSource,
      models: c.models.map(m => ({ id: m.id, label: m.label, efforts: m.efforts, defaultEffort: m.defaultEffort })), source: c.source, stale: c.stale, verified: c.verified, ...(c.error ? { error: c.error } : {}) })),
    ...providerNames().filter(n => !installed.has(n)).map(name => ({ name, available: false, models: [], defaultSource: 'unknown' as const })),
  ];
  const providers = only === undefined ? all : all.filter(p => p.name === only);
  const modelConfig = loadModelConfig({ repo: ctx.service.repo });
  const aliases = describeAliases(modelConfig);
  if (fmt === 'concise') {
    return {
      providers: conciseCapabilities(providers, only),
      ...(aliases.aliases.length || Object.keys(aliases.roleDefaults).length ? { aliases } : {}),
      ...(modelConfig.errors.length ? { aliasConfigErrors: modelConfig.errors } : {}),
    };
  }
  return {
    providers,
    aliases,
    ...(modelConfig.errors.length ? { aliasConfigErrors: modelConfig.errors } : {}),
    modes: MODES.map(name => ({ name, description: MODE_PRESETS[name].description, readOnly: MODE_PRESETS[name].readOnly, runsCommands: MODE_PRESETS[name].runsCommands })),
    efforts: `Effort is one of ${EFFORTS.join(', ')}; each model lists the efforts it actually accepts (providers may use native names). Omit model/effort to use the harness's own configured default.`,
  };
}
