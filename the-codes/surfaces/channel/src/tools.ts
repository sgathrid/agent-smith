import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claimMarkerPath } from '../../mod/hooks/notice.ts';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Server } from '@modelcontextprotocol/server';
import type { ForgeStatus } from '../../../forge/format.ts';
import {
  continuationModelAndEffort,
  type FollowUpRequest,
  type ForgeService,
  type JobDetail,
  type MessageAck,
  type SpawnAck,
  type SteerRequest,
} from '../../../forge/service.ts';
import { failedReason } from '../../../forge/summary.ts';
import { launchPipeline } from '../../../forge/supervisor.ts';
import { FILES, jobDir, jobFile } from '../../../forge/format.ts';
import { waitForChange } from '../../../forge/watch.ts';
import { startPipeline, readPipeline, cancelPipeline, missingPipelineError } from '../../../forge/execute.ts';
import { readAcceptance } from '../../../forge/checks.ts';
import { isTerminalStatus, isWorkerIdle } from '../../mod/hooks/turns.ts';
import { validateSpec } from '../../../pipeline/pipeline.ts';
import { EFFORTS, validateEnv, type Stage } from '../../../pipeline/types.ts';
import { MODES, MODE_PRESETS, isMode as isModeName } from '../../../forge/modes.ts';
import { requireProvider, validateModelAndEffort } from '../../../forge/spawn-request.ts';
import { getCatalogs, probeProviders } from '../../../providers/catalog.ts';
import { effectiveDefaultUnrestricted, findProvider, providerNames } from '../../../providers/registry.ts';
import type { ModelCatalog } from '../../../providers/types.ts';
import { loadModelConfig, resolveRequest, describeAliases } from '../../../providers/aliases.ts';
import { CONCISE_LIST_LIMIT, EARLIER_TURNS_CAP, conciseCapabilities, conciseRow, conciseStatus, concisePipeline, earlierTurn, jobDiff, jobLiveness, livenessView, parseSince, taskStatus, withTeamCounts, withWorkerBaseline, withWorkerFiles, type ResponseFormat } from './views.ts';
import { PROVIDERS, TOOL_DEFS, MAX_WAIT_MS } from './tool-defs.ts';
import { allowed, boolean, contextText, filesList, format, keys, number, parseChecks, parseStages, record, text, workingDirectory } from './args.ts';
import { catalogFailureText, defaultMixedPipeline, defaultProvider, discoverCatalogs, type CatalogSource } from './stage-defaults.ts';

export { MAX_CONTEXT_CHARS, TOOL_DEFS, type ToolAnnotations, type ToolDef } from './tool-defs.ts';
export { parseStages } from './args.ts';
export { defaultMixedPipeline, type CatalogSource, type MixedSpecInput } from './stage-defaults.ts';

export const REPORT_HEAD_CHARS = 8_000;
const WAIT_POLL_MS = 500;
const WATCH_RECHECK_MS = 5_000;

/** Long enough for a person to read the prompt and answer; the SDK default (60 s) is not. */
const CONFIRM_TIMEOUT_MS = 10 * 60_000;
export const DECLINED_UNRESTRICTED = 'The user declined unrestricted access; rerun without unrestricted, or ask the user.';
export const UNCONFIRMED_UNRESTRICTED = 'unrestricted not confirmed: this client cannot prompt the user.';
interface EscalatingLaunch {
  unrestricted?: boolean | undefined;
  provider: string;
  who: string;
  label?: string | undefined;
  cwd: string;
}
function isEscalatingLaunch(l: EscalatingLaunch): boolean {
  if (l.unrestricted !== true) return false;
  const provider = findProvider(l.provider);
  if (effectiveDefaultUnrestricted(provider)) return false;
  if (provider?.describeSandbox) {
    return provider.describeSandbox({ unrestricted: true }).unrestricted !== false;
  }
  return true;
}

async function confirmUnrestricted(
  ctx: HandlerContext,
  launches: readonly EscalatingLaunch[],
  kind: 'worker' | 'pipeline stage' = 'worker',
): Promise<{ refused?: ToolOutcome; warning?: string }> {
  const escalating = launches.filter(isEscalatingLaunch);
  if (escalating.length === 0 || process.env['AGENT_SMITH_CONFIRM_UNRESTRICTED'] !== '1') return {};
  if (ctx.unrestrictedGate) return ctx.unrestrictedGate;
  if (!ctx.server?.getClientCapabilities()?.elicitation?.form) return { warning: UNCONFIRMED_UNRESTRICTED };
  const target = escalating.length === 1
    ? escalating[0]!.who
    : `${escalating.length} ${kind}s (${escalating.map(e => e.label ?? e.who).join(', ')})`;
  const cwds = [...new Set(escalating.map(e => e.cwd))].join(', ');
  try {
    const answer = await ctx.server.elicitInput({ mode: 'form', message: `Allow ${target} to run without approval prompts in ${cwds}? It will be able to run any command.`, requestedSchema: { type: 'object', properties: {} } }, { timeout: CONFIRM_TIMEOUT_MS });
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
  const { reason: _r, latestSummary, summarySource, ...rest } = withTeamCounts(detail);
  const reason = failedReason(detail);
  return { ...rest, ...(isTerminalStatus(detail.status) ? {} : { latestSummary, summarySource }), ...(reason !== null ? { reason } : {}), resumable: Boolean(detail.conversation), ...(live === null ? {} : { liveness: livenessView(live) }), taskStatus: taskStatus(detail.status), report: detail.report?.slice(0, REPORT_HEAD_CHARS) ?? null, reportTruncated: (detail.report?.length ?? 0) > REPORT_HEAD_CHARS, acceptance };
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
    ...(ack.sandboxUnrestricted !== undefined && ack.sandboxUnrestricted !== ack.unrestricted ? { sandbox: ack.sandbox } : {}),
    ...(ack.readOnlyRequested || (isModeName(ack.role) && MODE_PRESETS[ack.role].readOnly) ? { readOnlyEnforced: ack.readOnlyEnforced ?? false } : {}),
    ...(ack.envKeys?.length ? { envKeys: ack.envKeys } : {}),
    ...(ack.warnings?.length ? { warnings: ack.warnings } : {}),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as Partial<typeof out>;
}

async function resolveDefaultProvider(ctx: HandlerContext): Promise<string> {
  if (ctx.catalogs) {
    const { catalogs, error } = await discoverCatalogs(ctx);
    const usable = catalogs.filter(c => c.probeFailed !== true);
    const detail = error ?? (usable.length === 0 ? catalogFailureText(catalogs) : undefined);
    return defaultProvider(usable.map(c => c.provider), undefined, detail);
  }
  const probes = await probeProviders();
  const installed = probes.filter(p => p.status === 'installed').map(p => p.name);
  const failed = probes.filter(p => p.status === 'failed');
  const detail = installed.length === 0 && failed.length > 0
    ? failed.map(p => `${p.name}: ${p.reason ?? 'availability probe failed'}`).join('; ')
    : undefined;
  return defaultProvider(installed, undefined, detail);
}

interface PreResolvedSpawn {
  provider: string;
  resolved: ReturnType<typeof resolveRequest>;
  cfgErrors: readonly string[];
  rawProvider?: string | undefined;
  rawModel?: string | undefined;
  rawEffort?: string | undefined;
}

async function spawnOne(ctx: HandlerContext, args: Args, preResolved?: PreResolvedSpawn, extraWarnings: readonly string[] = []): Promise<Record<string, unknown>> {
  const mode = allowed(args, 'mode', MODES); if (mode === undefined) throw new Error(`mode is required; one of ${MODES.join(', ')}.`);
  const rawProvider = preResolved ? preResolved.rawProvider : allowed(args, 'provider', PROVIDERS);
  const rawModel = preResolved ? preResolved.rawModel : text(args, 'model');
  const rawEffort = preResolved ? preResolved.rawEffort : allowed(args, 'effort', EFFORTS);
  let resolved: ReturnType<typeof resolveRequest>;
  let cfgErrors: readonly string[];
  let provider: string;
  if (preResolved) {
    resolved = preResolved.resolved;
    cfgErrors = preResolved.cfgErrors;
    provider = preResolved.provider;
  } else {
    const cfg = loadModelConfig({ repo: ctx.service.repo });
    resolved = resolveRequest({ provider: rawProvider, model: rawModel, effort: rawEffort, mode }, cfg);
    cfgErrors = cfg.errors;
    provider = resolved.provider ?? await resolveDefaultProvider(ctx);
  }
  const notes = [...extraWarnings, ...resolved.warnings, ...cfgErrors.map(e => `models.json: ${e}`)];
  const withNotes = (ack: SpawnAck) => ({ ...slimAck(ack), provider: ack.provider ?? provider, ...(resolved.appliedAlias ? { aliasApplied: resolved.appliedAlias, aliasSource: resolved.source } : {}), ...(notes.length ? { warnings: [...(ack.warnings ?? []), ...notes] } : {}) });
  const checks = parseChecks(args.checks);
  const request = { mode, prompt: text(args, 'prompt', true)!, context: contextText(args), files: filesList(args), checks, cwd: workingDirectory(args), name: text(args, 'name'), task: text(args, 'task'), provider, model: resolved.model, effort: resolved.effort, timeoutMs: number(args, 'timeoutMs'), conversation: text(args, 'conversation'), unrestricted: boolean(args, 'unrestricted'), env: validateEnv(args.env),
    ownerChecks: true, onPrepared: ctx.onJobPrepared };
  const gate = await confirmUnrestricted(ctx, [{
    unrestricted: request.unrestricted,
    provider,
    who: request.name ? `${provider} worker "${request.name}"` : `a new ${provider} worker`,
    cwd: request.cwd ?? ctx.service.repo,
  }]);
  if (gate.refused) throw new Error(refusedText(gate.refused));
  if (gate.warning) notes.push(gate.warning);
  const saved = { mode, prompt: request.prompt, context: request.context, files: request.files, cwd: request.cwd, task: request.task, name: request.name, provider: rawProvider, model: rawModel, effort: rawEffort, timeoutMs: request.timeoutMs, unrestricted: request.unrestricted };
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

function overlay(base: Args, over: Args, baseProvider?: string, keepUnrestricted = false): { args: Args; droppedUnrestricted?: string } {
  const defined = Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined));
  const switched = defined.provider !== undefined && baseProvider !== defined.provider;
  const dropKeys = keepUnrestricted ? ['model', 'effort'] : ['model', 'effort', 'unrestricted'];
  const kept = switched ? Object.fromEntries(Object.entries(base).filter(([k]) => !dropKeys.includes(k))) : base;
  const dropped = switched && !keepUnrestricted && base.unrestricted !== undefined && defined.unrestricted === undefined
    ? `unrestricted: ${String(base.unrestricted)} was dropped because the provider changed or was not shared.`
    : undefined;
  return { args: { ...kept, ...defined }, ...(dropped ? { droppedUnrestricted: dropped } : {}) };
}

async function inheritFrom(ctx: HandlerContext, args: Args): Promise<{ args: Args; droppedUnrestricted?: string }> {
  const from = text(args, 'from', true)!;
  const detail = await ctx.service.resolveWorkerHead(from);
  const root = (await ctx.service.earlierTurns(detail, Number.MAX_SAFE_INTEGER))[0]?.jobId ?? detail.jobId;
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
  const inherited = args.from === undefined ? { args } : await inheritFrom(ctx, args);
  const base = inherited.args;
  if (args.variants === undefined) {
    return structured(await spawnOne(ctx, base, undefined, inherited.droppedUnrestricted ? [inherited.droppedUnrestricted] : []), { compact: true });
  }
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
  const overlaid = variants.map((v, i) => overlay(shared, { ...v, name: names[i] }, baseProvider, true));
  const requests = overlaid.map(o => o.args);
  let fallbackProvider: string | undefined;
  const getFallbackProvider = async () => fallbackProvider ??= await resolveDefaultProvider(ctx);
  const preResolved: PreResolvedSpawn[] = [];
  for (const r of requests) {
    const rawProvider = allowed(r, 'provider', PROVIDERS);
    const rawModel = text(r, 'model');
    const rawEffort = allowed(r, 'effort', EFFORTS);
    const resolved = resolveRequest({ provider: rawProvider, model: rawModel, effort: rawEffort, mode }, cfg);
    const provider = resolved.provider ?? await getFallbackProvider();
    preResolved.push({ provider, resolved, cfgErrors: cfg.errors, rawProvider, rawModel, rawEffort });
  }
  const gate = await confirmUnrestricted(
    ctx,
    requests.map((r, i) => ({
      unrestricted: boolean(r, 'unrestricted'),
      provider: preResolved[i]!.provider,
      who: `${preResolved[i]!.provider} worker "${String(r.name)}"`,
      label: `${String(r.name)}: ${preResolved[i]!.provider}`,
      cwd: cwd ?? ctx.service.repo,
    })),
  );
  if (gate.refused) return gate.refused;
  const batchCtx: HandlerContext = { ...ctx, unrestrictedGate: gate.warning ? { warning: gate.warning } : {} };
  const jobs: Record<string, unknown>[] = [];
  for (const [i, r] of requests.entries()) {
    const dropped = [inherited.droppedUnrestricted, overlaid[i]!.droppedUnrestricted].filter((w): w is string => w !== undefined);
    try { jobs.push(await spawnOne(batchCtx, r, preResolved[i], dropped)); } catch (err) { jobs.push({ name: names[i], error: err instanceof Error ? err.message : String(err) }); }
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
    checks: parseChecks(args.checks), model: text(args, 'model'), effort: allowed(args, 'effort', [...EFFORTS, 'default']), timeoutMs: number(args, 'timeoutMs'),
    env: validateEnv(args.env), unrestricted: boolean(args, 'unrestricted'),
  };
  let targetWorker = request.worker;
  const notes: string[] = [];
  if (request.unrestricted === true || request.model !== undefined || request.effort !== undefined) {
    const head = await ctx.service.messageTarget(request.worker);
    targetWorker = head.workerId ?? head.jobId;
    const provider = head.provider ?? '';
    if (request.model !== undefined || request.effort !== undefined) {
      const inherited = continuationModelAndEffort(head, []);
      const modelArg = request.model === 'default' ? undefined : (request.model ?? inherited.modelExpected);
      const effortArg = request.effort === 'default' ? undefined : request.effort;
      if (modelArg !== undefined || effortArg !== undefined) {
        const cfg = loadModelConfig({ repo: ctx.service.repo });
        const resolved = resolveRequest({ provider: provider || undefined, model: modelArg, effort: effortArg }, cfg);
        Object.assign(request, {
          ...(request.model !== undefined && request.model !== 'default' ? { model: resolved.model } : {}),
          ...(request.effort !== 'default' ? { effort: resolved.effort } : {}),
        });
        notes.push(...resolved.warnings, ...cfg.errors.map(e => `models.json: ${e}`));
      }
    }
    const gate = await confirmUnrestricted(ctx, [{
      unrestricted: request.unrestricted,
      provider,
      who: head.name ? `${provider} worker "${head.name}"` : `a new ${provider} worker`,
      cwd: head.cwd ?? ctx.service.repo,
    }]);
    if (gate.refused) return gate.refused;
    if (gate.warning) notes.push(gate.warning);
  }
  const ack = await ctx.service.followUp({ ...request, worker: targetWorker });
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
  if (fmt !== 'concise') return structured(workers.map(j => { const live = jobLiveness(j); return { ...withTeamCounts(j), taskStatus: taskStatus(j.status), ...(live === null ? {} : { liveness: livenessView(live) }) }; }));
  const rows = workers.slice(0, limit).map(j => conciseRow(j));
  return structured(workers.length > rows.length
    ? { items: rows, more: `More than ${rows.length} jobs match; ${rows.length} shown.` }
    : rows, { compact: true });
};

function unsettled(ctx: HandlerContext, d: JobDetail, worker: boolean): boolean {
  const acceptancePending = (readAcceptance(ctx.service.repo, d.jobId) as { pending?: boolean }).pending === true;
  if (worker) return !isWorkerIdle({ jobId: d.jobId, status: d.status, supersededBy: d.supersededBy, followedBy: d.followedBy, acceptancePending, pendingMessages: d.pendingSteers });
  return d.status === 'running' || Boolean(d.supersededBy) || acceptancePending;
}

const jobStatus: Handler = async (ctx, args) => {
  const id = text(args, 'id', true)!.trim(); const waitMs = number(args, 'wait_ms', MAX_WAIT_MS); const fmt = format(args); const wantDiff = boolean(args, 'include_diff') ?? false;
  const { detail: resolvedDetail, isWorker: worker } = await ctx.service.resolveWorkerTarget(id);
  let detail: JobDetail & { resolvedFrom?: string } = resolvedDetail;
  let waited = false;
  const waitTarget = worker ? (detail.workerId ?? detail.jobId) : id;
  if (waitMs !== undefined) {
    waited = true; const deadline = Date.now() + waitMs; const fallbackMs = ctx.pollMs ?? WAIT_POLL_MS;
    const maxSlice = ctx.pollMs ?? WATCH_RECHECK_MS;
    while (unsettled(ctx, detail, worker) && Date.now() < deadline) {
      await waitForChange(jobDir(ctx.service.repo, detail.jobId), Math.min(maxSlice, deadline - Date.now()), { fallbackMs });
      detail = await ctx.service.resolveWorker(waitTarget);
    }
  }
  if (detail.jobId !== id) detail = { ...detail, resolvedFrom: id };
  const reportPath = jobFile(ctx.service.repo, detail.jobId, FILES.report);
  const acceptance = readAcceptance(ctx.service.repo, detail.jobId);
  if (boolean(args, 'report_only')) return structured({ jobId: detail.jobId, status: detail.status, report: detail.report, reportPath, acceptance });
  const wait = waited ? { waited: true, stillRunning: unsettled(ctx, detail, worker) } : {};
  const allEarlier = await ctx.service.earlierTurns(detail, worker ? Number.MAX_SAFE_INTEGER : EARLIER_TURNS_CAP);
  const earlier = allEarlier.slice(-EARLIER_TURNS_CAP);
  const viewDetail = worker ? withWorkerFiles(detail, allEarlier) : detail;
  const diffDetail = worker ? withWorkerBaseline(viewDetail, allEarlier) : viewDetail;
  const diff = wantDiff ? await jobDiff(diffDetail, { runningTurnPending: worker && allEarlier.length > 0 && detail.status === 'running' }) : {};
  const turns = earlier.length > 0 ? { earlierTurns: earlier.map(t => earlierTurn(t, jobFile(ctx.service.repo, t.jobId, FILES.report), fmt)) } : {};
  if (fmt === 'concise') return structured({ ...conciseStatus(viewDetail, acceptance, wait), reportPath, ...turns, ...diff }, { compact: true });
  return structured({ ...fullStatus(viewDetail, acceptance), reportPath, ...turns, ...wait, ...diff });
};

const pipelineStatus: Handler = async (ctx, args) => {
  const runId = text(args, 'runId', true)!; const r = readPipeline(ctx.service.repo, runId);
  if (!r) throw missingPipelineError(runId);
  return structured(format(args) === 'concise' ? concisePipeline(r) : r, { compact: true });
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
    return structured(out, { compact: true });
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
  return structured(out, { compact: true });
};

async function validatePipelineStages(ctx: HandlerContext, stages: readonly Stage[]): Promise<string[]> {
  let stubbed: Promise<ModelCatalog[]> | undefined;
  const catalogOf = (provider: string) => ctx.catalogs
    ? (stubbed ??= discoverCatalogs(ctx).then(r => r.catalogs)).then(all => all.find(c => c.provider === provider))
    : ctx.service.catalogFor(provider);
  const warnings: string[] = [];
  for (const stage of stages) {
    try {
      const provider = requireProvider(stage.provider);
      const checked = await validateModelAndEffort(provider, stage.model, stage.effort, () => catalogOf(provider.name));
      warnings.push(...checked.warnings.map(w => `stage '${stage.name}': ${w}`));
    } catch (err) {
      throw new Error(`stage '${stage.name}': ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return warnings;
}

const runPipeline: Handler = async (ctx, args) => {
  const raw = record(args.spec, 'spec'); keys(raw, ['name', 'task', 'workDir', 'concurrency', 'unrestricted', 'stages']);
  const stages = parseStages(raw.stages); const task = text(raw, 'task', stages === undefined);
  const spec = await defaultMixedPipeline({ name: text(raw, 'name', true)!, task: task ?? '', stages, workDir: text(raw, 'workDir') ?? ctx.service.repo, concurrency: number(raw, 'concurrency', 32), modelConfig: loadModelConfig({ repo: ctx.service.repo }) }, ctx.catalogs);
  validateSpec(spec);
  const warnings = await validatePipelineStages(ctx, spec.stages);
  const unrestricted = boolean(raw, 'unrestricted');
  const baseWorkDir = spec.workDir ?? ctx.service.repo;
  const stagesByName = new Map(spec.stages.map(s => [s.name, s]));
  const gate = await confirmUnrestricted(
    ctx,
    spec.stages.map(s => {
      const own = s.workDir ?? (s.continues === undefined ? undefined : stagesByName.get(s.continues)?.workDir);
      return {
        unrestricted,
        provider: s.provider,
        who: `pipeline stage "${s.name}" (${s.provider})`,
        label: `${s.name}: ${s.provider}`,
        cwd: own ? path.resolve(baseWorkDir, own) : baseWorkDir,
      };
    }),
    'pipeline stage',
  );
  if (gate.refused) return gate.refused;
  if (gate.warning) warnings.push(gate.warning);
  const run = ctx.service.supervisorUrl
    ? await launchPipeline(ctx.service, spec, { unrestricted })
    : startPipeline(ctx.service, spec, { unrestricted });
  void run.done.catch(err => process.stderr.write(`agent-smith pipeline ${run.runId}: ${String(err)}\n`));
  return structured({ runId: run.runId, repo: ctx.service.repo, stages: spec.stages.map(s => ({ name: s.name, provider: s.provider, ...(s.dependsOn?.length ? { dependsOn: s.dependsOn } : {}) })), ...(warnings.length ? { warnings } : {}) }, { compact: true });
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
  const { catalogs: cats, error: discoveryError } = ctx.catalogs
    ? await discoverCatalogs(ctx)
    : await discoverCatalogs({ catalogs: () => getCatalogs({ refresh, repo: ctx.service.repo }) });
  const warning = discoveryError ? `Provider discovery failed (${discoveryError}).` : undefined;
  const installed = new Set(cats.map(c => c.provider));
  const all = [
    ...cats.map(c => ({ name: c.provider, available: c.probeFailed !== true, defaultModel: c.defaultModel, defaultEffort: c.defaultEffort, defaultSource: c.defaultSource,
      models: c.models.map(m => ({ id: m.id, label: m.label, efforts: m.efforts, defaultEffort: m.defaultEffort })), source: c.source, stale: c.stale, verified: c.verified, ...(c.error ? { error: c.error } : {}) })),
    ...providerNames().filter(n => !installed.has(n)).map(name => ({ name, available: false, models: [], defaultSource: 'unknown' as const })),
  ];
  const providers = only === undefined ? all : all.filter(p => p.name === only);
  const modelConfig = loadModelConfig({ repo: ctx.service.repo });
  const aliases = describeAliases(modelConfig);
  if (fmt === 'concise') {
    return {
      providers: conciseCapabilities(providers, only),
      ...(warning ? { warning } : {}),
      ...(aliases.aliases.length || Object.keys(aliases.roleDefaults).length ? { aliases } : {}),
      ...(modelConfig.errors.length ? { aliasConfigErrors: modelConfig.errors } : {}),
    };
  }
  return {
    providers,
    ...(warning ? { warning } : {}),
    aliases,
    ...(modelConfig.errors.length ? { aliasConfigErrors: modelConfig.errors } : {}),
    modes: MODES.map(name => ({ name, description: MODE_PRESETS[name].description, readOnly: MODE_PRESETS[name].readOnly, runsCommands: MODE_PRESETS[name].runsCommands })),
    efforts: `Effort is one of ${EFFORTS.join(', ')}; each model lists the efforts it actually accepts (providers may use native names). Omit model/effort to use the harness's own configured default.`,
  };
}
