import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claimMarkerPath } from '../../mod/hooks/notice.ts';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Server } from '@modelcontextprotocol/server';
import type { ForgeStatus } from '../../../forge/format.ts';
import type { FollowUpRequest, ForgeService, JobDetail, MessageAck, SpawnAck, SteerRequest } from '../../../forge/service.ts';
import { launchPipeline } from '../../../forge/supervisor.ts';
import { FILES, jobDir, jobFile } from '../../../forge/format.ts';
import { waitForChange } from '../../../forge/watch.ts';
import { startPipeline, readPipeline, cancelPipeline, missingPipelineError } from '../../../forge/execute.ts';
import { readAcceptance } from '../../../forge/checks.ts';
import { isWorkerIdle } from '../../mod/hooks/turns.ts';
import { validateSpec } from '../../../pipeline/pipeline.ts';
import { EFFORTS, validateEnv } from '../../../pipeline/types.ts';
import { MODES, MODE_PRESETS, isMode as isModeName } from '../../../forge/modes.ts';
import { getCatalogs, getInstalledProviders } from '../../../providers/catalog.ts';
import { providerNames } from '../../../providers/registry.ts';
import { loadModelConfig, resolveRequest, describeAliases } from '../../../providers/aliases.ts';
import { CONCISE_LIST_LIMIT, EARLIER_TURNS_CAP, conciseCapabilities, conciseRow, conciseStatus, concisePipeline, earlierTurn, jobDiff, jobLiveness, livenessView, parseSince, taskStatus, type ResponseFormat } from './views.ts';
import { PROVIDERS, TOOL_DEFS, MAX_WAIT_MS } from './tool-defs.ts';
import { allowed, boolean, contextText, filesList, format, keys, number, parseChecks, parseStages, record, text, workingDirectory } from './args.ts';
import { defaultMixedPipeline, defaultProvider, installedCatalogs, type CatalogSource } from './stage-defaults.ts';

export { MAX_CONTEXT_CHARS, TOOL_DEFS, type ToolAnnotations, type ToolDef } from './tool-defs.ts';
export { parseStages } from './args.ts';
export { defaultMixedPipeline, type CatalogSource, type MixedSpecInput } from './stage-defaults.ts';

export const REPORT_HEAD_CHARS = 8_000;
const WAIT_POLL_MS = 500;
const WATCH_RECHECK_MS = 5_000;

/** Providers that run restricted unless asked. agy and kimi are unrestricted by design: headless they cannot prompt (kimi's print mode forces auto). */
const RESTRICTED_BY_DEFAULT = new Set(['codex', 'claude', 'opencode']);
/** Long enough for a person to read the prompt and answer; the SDK default (60 s) is not. */
const CONFIRM_TIMEOUT_MS = 10 * 60_000;
export const DECLINED_UNRESTRICTED = 'The user declined unrestricted access; rerun without unrestricted, or ask the user.';
export const UNCONFIRMED_UNRESTRICTED = 'unrestricted: true was not confirmed with the user: this client cannot show a confirmation prompt (no MCP elicitation support).';
async function confirmUnrestricted(ctx: HandlerContext, req: { unrestricted?: boolean | undefined; provider: string; worker?: string | undefined; cwd: string; who?: string }): Promise<{ refused?: ToolOutcome; warning?: string }> {
  if (req.unrestricted !== true || !RESTRICTED_BY_DEFAULT.has(req.provider) || process.env['AGENT_SMITH_CONFIRM_UNRESTRICTED'] === '0') return {};
  if (ctx.unrestrictedGate) return ctx.unrestrictedGate;
  if (!ctx.server?.getClientCapabilities()?.elicitation?.form) return { warning: UNCONFIRMED_UNRESTRICTED };
  const who = req.who ?? (req.worker ? `${req.provider} worker "${req.worker}"` : `a new ${req.provider} worker`);
  try {
    const answer = await ctx.server.elicitInput({ mode: 'form', message: `Allow ${who} to run without approval prompts in ${req.cwd}? It will be able to run any command.`, requestedSchema: { type: 'object', properties: {} } }, { timeout: CONFIRM_TIMEOUT_MS });
    return answer.action === 'accept' ? {} : { refused: failure(DECLINED_UNRESTRICTED) };
  } catch (err) {
    return { refused: failure(`Could not confirm unrestricted access with the user (${err instanceof Error ? err.message : String(err)}); rerun without unrestricted, or ask the user.`) };
  }
}

export type ToolOutcome = CallToolResult;
export interface HandlerContext {
  readonly service: ForgeService; readonly pollMs?: number; readonly onStageSpawned?: (stage: string, jobId: string) => void; readonly catalogs?: CatalogSource;
  readonly onJobPrepared?: (jobId: string) => void;
  readonly server?: Pick<Server, 'getClientCapabilities' | 'elicitInput'>;
  readonly cancelSettleMs?: number;
  readonly unrestrictedGate?: { warning?: string };
}
export function json(value: unknown): ToolOutcome { return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }; }
export function structured(value: unknown, { compact = false }: { compact?: boolean } = {}): ToolOutcome {
  const out = compact ? { content: [{ type: 'text' as const, text: JSON.stringify(value) }] } : json(value);
  const sc = Array.isArray(value) ? { items: value } : value;
  return sc !== null && typeof sc === 'object' ? { ...out, structuredContent: sc as Record<string, unknown> } : out;
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
export function failure(message: string, detail?: unknown): ToolOutcome { return { isError: true, content: [{ type: 'text', text: message + (detail === undefined ? '' : `\n${JSON.stringify(detail)}`) }] }; }

export function fullStatus(detail: JobDetail, acceptance: ReturnType<typeof readAcceptance>, now = Date.now()) {
  const live = jobLiveness(detail, now);
  return { ...detail, resumable: Boolean(detail.conversation), ...(live === null ? {} : { liveness: livenessView(live) }), taskStatus: taskStatus(detail.status), report: detail.report?.slice(0, REPORT_HEAD_CHARS) ?? null, reportTruncated: (detail.report?.length ?? 0) > REPORT_HEAD_CHARS, acceptance };
}

type Args = Record<string, unknown>;
type Handler = (ctx: HandlerContext, args: Args) => Promise<ToolOutcome>;

const listCapabilitiesTool: Handler = async (ctx, args) => {
  const fmt = format(args);
  return structured(await listCapabilities(ctx, boolean(args, 'refresh') ?? false, fmt, allowed(args, 'provider', PROVIDERS)), { compact: fmt === 'concise' });
};

export function slimAck(ack: SpawnAck) {
  const out = {
    jobId: ack.jobId, name: ack.name, workerId: ack.workerId,
    ...(ack.turn !== undefined ? { turn: ack.turn } : {}),
    provider: ack.provider, model: ack.modelResolved ?? null, status: ack.status,
    timeoutMs: ack.timeoutMs, repo: ack.repo, unrestricted: ack.unrestricted,
    ...(ack.readOnlyRequested || (isModeName(ack.role) && MODE_PRESETS[ack.role].readOnly) ? { readOnlyEnforced: ack.readOnlyEnforced ?? false } : {}),
    ...(ack.envKeys?.length ? { envKeys: ack.envKeys } : {}),
    ...(ack.warnings?.length ? { warnings: ack.warnings } : {}),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Partial<typeof out>;
}

async function spawnOne(ctx: HandlerContext, args: Args): Promise<Record<string, unknown>> {
  const mode = allowed(args, 'mode', MODES); if (mode === undefined) throw new Error(`mode is required; one of ${MODES.join(', ')}.`);
  const cfg = loadModelConfig({ repo: ctx.service.repo });
  const rawProvider = allowed(args, 'provider', PROVIDERS);
  const resolved = resolveRequest({ provider: rawProvider, model: text(args, 'model'), effort: allowed(args, 'effort', EFFORTS), mode }, cfg);
  const provider = resolved.provider ?? defaultProvider(ctx.catalogs ? (await installedCatalogs(ctx)).map(c => c.provider) : await getInstalledProviders());
  const notes = [...resolved.warnings, ...cfg.errors.map(e => `models.json: ${e}`)];
  const withNotes = (ack: SpawnAck) => ({ ...slimAck(ack), provider: ack.provider ?? provider, ...(resolved.appliedAlias ? { aliasApplied: resolved.appliedAlias, aliasSource: resolved.source } : {}), ...(notes.length ? { warnings: [...(ack.warnings ?? []), ...notes] } : {}) });
  const checks = parseChecks(args.checks);
  const request = { mode, prompt: text(args, 'prompt', true)!, context: contextText(args), files: filesList(args), checks, cwd: workingDirectory(args), name: text(args, 'name'), task: text(args, 'task'), provider, model: resolved.model, effort: resolved.effort, timeoutMs: number(args, 'timeoutMs'), conversation: text(args, 'conversation'), unrestricted: boolean(args, 'unrestricted'), env: validateEnv(args.env),
    ownerChecks: true, onPrepared: ctx.onJobPrepared };
  const gate = await confirmUnrestricted(ctx, { unrestricted: request.unrestricted, provider, worker: request.name, cwd: request.cwd ?? ctx.service.repo });
  if (gate.refused) throw new Error(refusedText(gate.refused));
  if (gate.warning) notes.push(gate.warning);
  const saved = { mode, prompt: request.prompt, context: request.context, files: request.files, cwd: request.cwd, task: request.task, name: request.name, provider: rawProvider, model: text(args, 'model'), effort: allowed(args, 'effort', EFFORTS), timeoutMs: request.timeoutMs, unrestricted: request.unrestricted };
  const ack = await ctx.service.spawnJob(request);
  saveRequest(ctx, ack.jobId, saved);
  return checks?.length ? { ...withNotes(ack), checks: checks.map(c => c.name) } : withNotes(ack);
}

const refusedText = (r: ToolOutcome) => (r.content as { text?: string }[])[0]?.text ?? 'refused';

function saveRequest(ctx: HandlerContext, jobId: string, saved: Record<string, unknown>): void {
  try { writeFileSync(jobFile(ctx.service.repo, jobId, FILES.request), JSON.stringify(saved)); } catch {}
}

export const MAX_VARIANTS = 8;
const VARIANT_KEYS = ['name', 'provider', 'model', 'effort'] as const;

function overlay(base: Args, over: Args, baseProvider?: string): Args {
  const defined = Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined));
  const switched = defined.provider !== undefined && baseProvider !== defined.provider;
  const kept = switched ? Object.fromEntries(Object.entries(base).filter(([k]) => !['model', 'effort', 'unrestricted'].includes(k))) : base;
  return { ...kept, ...defined };
}

async function inheritFrom(ctx: HandlerContext, args: Args): Promise<Args> {
  const from = text(args, 'from', true)!;
  const detail = await ctx.service.resolveWorkerHead(from);
  const root = detail.workerId || detail.jobId;
  let saved: Args;
  try { saved = JSON.parse(readFileSync(jobFile(ctx.service.repo, root, FILES.request), 'utf8')) as Args; } catch {
    throw new Error(`"${detail.name}" has no saved request to reuse (a pipeline stage, or spawned before from existed); pass mode and prompt.`);
  }
  try { saved.checks = JSON.parse(readFileSync(jobFile(ctx.service.repo, root, FILES.checksSpec), 'utf8')); } catch {}
  delete saved.name;
  const cfg = loadModelConfig({ repo: ctx.service.repo });
  const baseProvider = resolveRequest({
    provider: allowed(saved, 'provider', PROVIDERS),
    model: text(saved, 'model'),
    effort: allowed(saved, 'effort', EFFORTS),
    mode: allowed(saved, 'mode', MODES),
  }, cfg).provider;
  const { from: _from, ...rest } = args;
  return overlay(saved, rest, baseProvider);
}

const spawnJob: Handler = async (ctx, args) => {
  const base = args.from === undefined ? args : await inheritFrom(ctx, args);
  if (args.variants === undefined) return structured(await spawnOne(ctx, base), { compact: true });
  if (ctx.onJobPrepared) throw new Error('variants start several jobs, and a task-augmented call tracks one; call spawn_job once per variant.');
  if (!Array.isArray(args.variants) || args.variants.length === 0 || args.variants.length > MAX_VARIANTS) throw new Error(`variants must be an array of 1 to ${MAX_VARIANTS} entries.`);
  const { variants: _v, ...shared } = base;
  const mode = allowed(shared, 'mode', MODES); if (mode === undefined) throw new Error(`mode is required; one of ${MODES.join(', ')}.`);
  text(shared, 'prompt', true);
  contextText(shared);
  filesList(shared);
  parseChecks(shared.checks);
  const cwd = workingDirectory(shared);
  text(shared, 'name');
  text(shared, 'task');
  allowed(shared, 'provider', PROVIDERS);
  text(shared, 'model');
  allowed(shared, 'effort', EFFORTS);
  number(shared, 'timeoutMs');
  text(shared, 'conversation');
  boolean(shared, 'unrestricted');
  validateEnv(shared.env);
  const stem = text(shared, 'name') ?? mode;
  const variants = args.variants.map((raw, i) => {
    const v = record(raw, `variants[${i}]`);
    keys(v, [...VARIANT_KEYS]);
    allowed(v, 'provider', PROVIDERS);
    text(v, 'model');
    allowed(v, 'effort', EFFORTS);
    return v;
  });
  const names = variants.map(v => text(v, 'name') ?? [stem, text(v, 'provider') ?? text(shared, 'provider'), text(v, 'model')].filter(Boolean).join('-').slice(0, 80));
  if (new Set(names).size !== names.length) throw new Error('variants need distinct names; pass name on each variant.');
  const cfg = loadModelConfig({ repo: ctx.service.repo });
  const baseProvider = resolveRequest({
    provider: allowed(shared, 'provider', PROVIDERS),
    model: text(shared, 'model'),
    effort: allowed(shared, 'effort', EFFORTS),
    mode,
  }, cfg).provider;
  const requests = variants.map((v, i) => overlay(shared, { ...v, name: names[i] }, baseProvider));
  let fallbackProvider: string | undefined;
  const getFallbackProvider = async () => fallbackProvider ??= defaultProvider(ctx.catalogs ? (await installedCatalogs(ctx)).map(c => c.provider) : await getInstalledProviders());
  const resolvedProviders: string[] = [];
  for (const r of requests) {
    const resolved = resolveRequest({ provider: allowed(r, 'provider', PROVIDERS), model: text(r, 'model'), effort: allowed(r, 'effort', EFFORTS), mode }, cfg);
    resolvedProviders.push(resolved.provider ?? await getFallbackProvider());
  }
  const escalating = requests
    .map((r, i) => ({ r, provider: resolvedProviders[i]! }))
    .filter(({ r, provider }) => r.unrestricted === true && RESTRICTED_BY_DEFAULT.has(provider));
  let batchCtx = ctx;
  if (escalating.length > 0) {
    const who = escalating.length === 1
      ? `${escalating[0]!.provider} worker "${String(escalating[0]!.r.name)}"`
      : `${escalating.length} workers (${escalating.map(e => `${String(e.r.name)}: ${e.provider}`).join(', ')})`;
    const gate = await confirmUnrestricted(ctx, { unrestricted: true, provider: escalating[0]!.provider, cwd: cwd ?? ctx.service.repo, who });
    if (gate.refused) return gate.refused;
    batchCtx = { ...ctx, unrestrictedGate: gate.warning ? { warning: gate.warning } : {} };
  }
  const jobs: Record<string, unknown>[] = [];
  for (const [i, r] of requests.entries()) {
    try { jobs.push(await spawnOne(batchCtx, r)); } catch (err) { jobs.push({ name: names[i], error: err instanceof Error ? err.message : String(err) }); }
  }
  return structured({ jobs }, { compact: true });
};

function messageAck(ack: MessageAck, notes: readonly string[] = []): ToolOutcome {
  const warnings = [...(ack.warnings ?? []), ...notes];
  const out = Object.fromEntries(Object.entries({ ...ack, warnings: warnings.length ? warnings : undefined }).filter(([, v]) => v !== undefined));
  return structured(out, { compact: true });
}

const followUp: Handler = async (ctx, args) => {
  const request: FollowUpRequest = {
    worker: text(args, 'worker', true)!, prompt: text(args, 'prompt', true)!, context: contextText(args), files: filesList(args),
    checks: parseChecks(args.checks), model: text(args, 'model'), effort: allowed(args, 'effort', EFFORTS), timeoutMs: number(args, 'timeoutMs'),
    env: validateEnv(args.env), unrestricted: boolean(args, 'unrestricted'),
  };
  const notes: string[] = [];
  if (request.unrestricted === true || request.model !== undefined || request.effort !== undefined) {
    const head = await ctx.service.messageTarget(request.worker);
    const provider = head.provider ?? '';
    if (request.model !== undefined || request.effort !== undefined) {
      const cfg = loadModelConfig({ repo: ctx.service.repo });
      const resolved = resolveRequest({ provider: provider || undefined, model: request.model, effort: request.effort }, cfg);
      Object.assign(request, { model: resolved.model, effort: resolved.effort });
      notes.push(...resolved.warnings, ...cfg.errors.map(e => `models.json: ${e}`));
    }
    const gate = await confirmUnrestricted(ctx, { unrestricted: request.unrestricted, provider, worker: head.name, cwd: head.cwd ?? ctx.service.repo });
    if (gate.refused) return gate.refused;
    if (gate.warning) notes.push(gate.warning);
  }
  const ack = await ctx.service.followUp(request);
  try { ctx.onJobPrepared?.(ack.jobId); } catch {}
  return messageAck(ack, notes);
};

const steer: Handler = async (ctx, args) => {
  const allowFresh = boolean(args, 'allowFresh');
  const request: SteerRequest = {
    worker: text(args, 'worker', true)!, prompt: text(args, 'prompt', true)!, context: contextText(args), files: filesList(args),
    ...(allowFresh === undefined ? {} : { allowFresh }),
  };
  return messageAck(await ctx.service.steer(request));
};

const listJobs: Handler = async (ctx, args) => {
  const fmt = format(args); const since = text(args, 'since');
  const limit = number(args, 'limit', 500) ?? (fmt === 'concise' ? CONCISE_LIST_LIMIT : undefined);
  const listArgs = {
    status: allowed(args, 'status', ['running', 'succeeded', 'failed', 'canceled']) as ForgeStatus | undefined,
    limit: fmt === 'concise' && limit !== undefined ? limit + 1 : limit,
    sinceMs: since === undefined ? undefined : parseSince(since),
    ids: boolean(args, 'session') ? ctx.service.spawnedIds : undefined,
    groupByWorker: true,
  };
  const workers = await ctx.service.list(listArgs);
  if (fmt !== 'concise') return structured(workers.map(j => { const live = jobLiveness(j); return { ...j, taskStatus: taskStatus(j.status), ...(live === null ? {} : { liveness: livenessView(live) }) }; }));
  const rows = workers.slice(0, limit).map(j => conciseRow(j));
  return structured(workers.length > rows.length
    ? { items: rows, more: `More than ${rows.length} jobs match; narrow with since, status or session, or raise limit.` }
    : rows, { compact: true });
};

function unsettled(ctx: HandlerContext, d: JobDetail, worker: boolean): boolean {
  const acceptancePending = (readAcceptance(ctx.service.repo, d.jobId) as { pending?: boolean }).pending === true;
  if (worker) return !isWorkerIdle({ jobId: d.jobId, status: d.status, supersededBy: d.supersededBy, followedBy: d.followedBy, acceptancePending, pendingMessages: d.pendingSteers });
  return d.status === 'running' || Boolean(d.supersededBy) || acceptancePending;
}

const jobStatus: Handler = async (ctx, args) => {
  const id = text(args, 'id', true)!.trim(); const waitMs = number(args, 'wait_ms', MAX_WAIT_MS); const fmt = format(args); const wantDiff = boolean(args, 'include_diff') ?? false;
  let detail: JobDetail & { resolvedFrom?: string } = await ctx.service.resolveWorker(id); let waited = false;
  const worker = ctx.service.resolveTurn(id) !== detail.jobId;
  if (waitMs !== undefined) {
    waited = true; const deadline = Date.now() + waitMs; const fallbackMs = ctx.pollMs ?? WAIT_POLL_MS;
    const maxSlice = ctx.pollMs ?? WATCH_RECHECK_MS;
    while (unsettled(ctx, detail, worker) && Date.now() < deadline) {
      await waitForChange(jobDir(ctx.service.repo, detail.jobId), Math.min(maxSlice, deadline - Date.now()), { fallbackMs });
      detail = await ctx.service.resolveWorker(id);
    }
  }
  if (detail.jobId !== id) detail = { ...detail, resolvedFrom: id };
  const reportPath = jobFile(ctx.service.repo, detail.jobId, FILES.report);
  if (boolean(args, 'report_only')) return structured({ jobId: detail.jobId, status: detail.status, report: detail.report, reportPath });
  const acceptance = readAcceptance(ctx.service.repo, detail.jobId); const wait = waited ? { waited: true, stillRunning: unsettled(ctx, detail, worker) } : {};
  const diff = wantDiff ? await jobDiff(detail) : {};
  const earlier = await ctx.service.earlierTurns(detail, EARLIER_TURNS_CAP);
  const turns = earlier.length > 0 ? { earlierTurns: earlier.map(t => earlierTurn(t, jobFile(ctx.service.repo, t.jobId, FILES.report), fmt)) } : {};
  if (fmt === 'concise') return structured({ ...conciseStatus(detail, acceptance, wait), reportPath, ...turns, ...diff }, { compact: true });
  return structured({ ...fullStatus(detail, acceptance), reportPath, ...turns, ...wait, ...diff });
};

const pipelineStatus: Handler = async (ctx, args) => {
  const runId = text(args, 'runId', true)!; const r = readPipeline(ctx.service.repo, runId);
  if (!r) throw missingPipelineError(runId);
  return json(format(args) === 'concise' ? concisePipeline(r) : r);
};

function quietNotice(repo: string, kind: 'job' | 'run', id: string): boolean {
  const marker = claimMarkerPath(repo, kind, id);
  try { mkdirSync(path.dirname(marker), { recursive: true }); writeFileSync(marker, `${new Date().toISOString()}\n`, { flag: 'wx' }); return true; } catch { return false; }
}

function unquietNotice(repo: string, kind: 'job' | 'run', id: string): void {
  try { rmSync(claimMarkerPath(repo, kind, id), { force: true }); } catch {}
}

async function withQuietNotices<T extends { settled: boolean }>(
  repo: string,
  kind: 'job' | 'run',
  initialIds: readonly string[],
  fn: (quiet: (id: string) => void) => Promise<T>,
): Promise<T> {
  const created = new Set<string>();
  const quiet = (id: string) => { if (quietNotice(repo, kind, id)) created.add(id); };
  let settled = false;
  try {
    for (const id of initialIds) quiet(id);
    const result = await fn(quiet);
    settled = result.settled;
    return result;
  } finally {
    if (!settled) for (const id of created) unquietNotice(repo, kind, id);
  }
}

export const CANCEL_SETTLE_MS = 5_000;

const cancelJob: Handler = async (ctx, args) => {
  const id = text(args, 'id', true)!.trim();
  const step = ctx.pollMs ?? WAIT_POLL_MS;
  const settleBy = Date.now() + (ctx.cancelSettleMs ?? CANCEL_SETTLE_MS);
  if (readPipeline(ctx.service.repo, id)) {
    const out = await withQuietNotices(ctx.service.repo, 'run', [id], async () => {
      cancelPipeline(ctx.service.repo, id);
      let run = readPipeline(ctx.service.repo, id);
      while (run?.status === 'running' && Date.now() < settleBy) { await sleep(Math.min(step, Math.max(0, settleBy - Date.now()))); run = readPipeline(ctx.service.repo, id); }
      const status = run?.status ?? 'unknown';
      const settled = status === 'passed' || status === 'partial' || status === 'failed';
      return { runId: id, status, settled };
    });
    return json(out);
  }
  const checksRunning = (jobId: string) => {
    const a = readAcceptance(ctx.service.repo, jobId) as { pending?: boolean; running?: string };
    return a.pending === true && a.running !== undefined;
  };
  let target = id;
  try { target = (await ctx.service.resolveWorker(id)).jobId; } catch {}
  const initialIds = ctx.service.resolveTurn(id) === target ? [id, target] : [target];
  const out = await withQuietNotices(ctx.service.repo, 'job', initialIds, async (quiet) => {
    const result = ctx.service.cancel(id);
    quiet(result.jobId);
    const hadChecks = checksRunning(result.jobId);
    const isTerminal = (s: string | undefined) => s === 'succeeded' || s === 'failed' || s === 'canceled';
    const isSettled = (d: JobDetail | null) =>
      d !== null && isTerminal(d.status) && !d.supersededBy && (readAcceptance(ctx.service.repo, d.jobId) as { pending?: boolean }).pending !== true;
    const cancelled = new Set<string>([result.jobId]);
    let currentId = result.jobId;
    let detail = await ctx.service.detail(currentId).catch(() => null);
    const maxSlice = ctx.pollMs ?? WATCH_RECHECK_MS;
    while (!isSettled(detail) && Date.now() < settleBy) {
      await waitForChange(jobDir(ctx.service.repo, currentId), Math.min(maxSlice, settleBy - Date.now()), { fallbackMs: step });
      const next = ctx.service.resolveTurn(currentId);
      if (next !== currentId && !cancelled.has(next)) { cancelled.add(next); quiet(next); ctx.service.cancel(next); currentId = next; }
      detail = await ctx.service.detail(currentId).catch(() => detail);
    }
    const settled = isSettled(detail);
    const body: Record<string, unknown> & { settled: boolean } = {
      jobId: detail?.jobId ?? currentId,
      ...(detail?.workerId ? { workerId: detail.workerId } : {}),
      ...(result.resolvedFrom === undefined ? {} : { resolvedFrom: result.resolvedFrom }),
      status: detail?.status ?? 'unknown', settled,
      ...(result.discarded ? { discarded: result.discarded } : {}),
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    };
    if (!hadChecks) return body;
    return checksRunning(detail?.jobId ?? currentId)
      ? { ...body, checksCanceled: false, checksNote: 'The process running the acceptance checks will stop them; status shows acceptance.' }
      : { ...body, checksCanceled: true };
  });
  return json(out);
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
  return json({ runId: run.runId, repo: ctx.service.repo, stages: spec.stages.map(s => ({ name: s.name, provider: s.provider, ...(s.dependsOn?.length ? { dependsOn: s.dependsOn } : {}) })) });
};

const HANDLERS: Readonly<Record<string, Handler>> = {
  list_capabilities: listCapabilitiesTool, spawn_job: spawnJob, follow_up: followUp, steer,
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
