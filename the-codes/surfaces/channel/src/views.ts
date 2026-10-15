/** Reader-sized views of job and pipeline state: concise by default, detailed is the full record. */
import { execFile } from 'node:child_process';
import type { JobDetail, JobSummary } from '../../../forge/service.ts';
import type { Acceptance } from '../../../forge/checks.ts';
import type { PipelineRecord } from '../../../forge/execute.ts';

export type ResponseFormat = 'concise' | 'detailed';
export const CONCISE_LIST_LIMIT = 20;
export const CONCISE_SUMMARY_CHARS = 200;
export const CONCISE_REPORT_CHARS = 2_000;
export const CONCISE_FILES_CAP = 20;
export const OUTPUT_TAIL_CHARS = 500;
export const DIFF_MAX_CHARS = 40_000;
const DETAIL_HINT = 'use response_format: "detailed"';
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Job lifecycle in the vocabulary of the MCP Tasks extension (protocol 2026-07-28):
 * working | input_required | completed | failed | cancelled. Reported beside `status`
 * so a later Tasks adapter is a translation, not a redesign. `input_required` is
 * reserved: no job pauses for input today. `unknown` (state not yet determinable,
 * never terminal) maps to `working`.
 */
export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
export function taskStatus(status: JobSummary['status']): TaskStatus {
  switch (status) {
    case 'running': case 'unknown': return 'working';
    case 'succeeded': return 'completed';
    case 'failed': return 'failed';
    case 'canceled': return 'cancelled';
  }
}

/** Cut at a word boundary within max chars, marking the cut with an ellipsis. */
export function trimWords(text: string, max: number): string {
  const t = flat(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** ISO time, or relative like 30m / 2h / 1d / 90s, to epoch ms. */
export function parseSince(value: string, now = Date.now()): number {
  const rel = /^(\d+)\s*([smhd])$/i.exec(value.trim());
  if (rel) return now - Number(rel[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2]!.toLowerCase() as 's' | 'm' | 'h' | 'd'];
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`since must be an ISO time (2026-10-11T09:00:00Z) or relative like 30m, 2h, 1d; got "${value}".`);
  return at;
}

function lastActivity(a: JobSummary['lastActivity']): string | undefined {
  return a ? `step ${a.stepIndex}: ${a.tool}${a.input ? ` ${trimWords(a.input, 80)}` : ''} (${a.status})` : undefined;
}
/** Drop null/undefined so concise output carries only fields that say something. */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}
const warningTexts = (ws: JobSummary['warnings']): string[] => [...new Set(ws.map(w => trimWords(w.message, 200)))];

/** One compact row for list_jobs. */
export function conciseRow(j: JobSummary) {
  return compact({
    jobId: j.jobId, name: j.name, status: j.status, taskStatus: taskStatus(j.status), provider: j.provider, model: j.model, mode: j.mode,
    summary: j.latestSummary ? trimWords(j.latestSummary, CONCISE_SUMMARY_CHARS) : null,
    toolCalls: j.toolCalls, lastActivity: lastActivity(j.lastActivity), startedAt: j.startedAt, finishedAt: j.finishedAt,
    nextAction: j.nextAction, warningCount: j.warnings.length || null,
  });
}

type AcceptanceView = Pick<Acceptance, 'state'> & Partial<Acceptance>;
const names = (a: Partial<Acceptance>, ok: boolean) => { const n = (a.checks ?? []).filter(c => c.ok === ok).map(c => c.name); return n.length ? n : null; };
function checkVerdicts(a: AcceptanceView | null | undefined) {
  if (!a) return null;
  return compact({
    state: a.state, pending: a.pending ? true : null, reason: a.reason ?? null,
    passed: names(a, true), failed: names(a, false),
  });
}

/** Concise single-job view: identity, verdicts, timing, one report. */
export function conciseStatus(d: JobDetail, acceptance: AcceptanceView | null, extra: { waited?: boolean; stillRunning?: boolean } = {}) {
  const report = d.report ?? '';
  const cut = report.length > CONCISE_REPORT_CHARS;
  const summary = d.latestSummary?.trim();
  const started = d.startedAt ? Date.parse(d.startedAt) : NaN;
  const ended = d.finishedAt ? Date.parse(d.finishedAt) : Date.now();
  const files = d.changedFiles ?? [];
  return compact({
    jobId: d.jobId, name: d.name, provider: d.provider, model: d.model, mode: d.mode, status: d.status, taskStatus: taskStatus(d.status),
    acceptance: checkVerdicts(acceptance),
    startedAt: d.startedAt, finishedAt: d.finishedAt, durationMs: Number.isNaN(started) ? null : Math.max(0, ended - started),
    toolCalls: d.toolCalls, lastActivity: lastActivity(d.lastActivity),
    changedFileCount: d.changedFiles ? files.length : null, changedFiles: files.length ? files.slice(0, CONCISE_FILES_CAP) : null,
    changedFilesNote: files.length > CONCISE_FILES_CAP || d.changedFilesTruncated ? `Only the first ${Math.min(files.length, CONCISE_FILES_CAP)} listed; ${DETAIL_HINT} or include_diff for the rest.` : null,
    nextAction: d.nextAction, error: d.error ? trimWords(d.error, 500) : null,
    warnings: d.warnings.length ? warningTexts(d.warnings) : null,
    summary: summary && !report.includes(summary) ? trimWords(summary, 300) : null,
    report: report ? (cut ? `${report.slice(0, CONCISE_REPORT_CHARS)}\n…[truncated: ${CONCISE_REPORT_CHARS} of ${report.length} chars; ${DETAIL_HINT} for more]` : report) : null,
    reportTruncated: cut, ...extra,
  });
}

/** Concise pipeline view: per-stage verdicts and output tail, no observations list. */
export function concisePipeline(r: PipelineRecord) {
  return compact({
    runId: r.runId, pipeline: r.pipeline, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt,
    durationMs: r.finishedAt === null ? null : r.finishedAt - r.startedAt, error: r.error ? trimWords(r.error, 500) : null,
    stageResults: Object.fromEntries(Object.entries(r.stageResults).map(([name, s]) => [name, compact({
      status: s.status, acceptance: s.acceptance, durationMs: s.status === 'running' ? null : s.durationMs, startedAt: s.status === 'running' ? s.startedAt : null, provider: s.status === 'running' ? s.provider : null, jobId: s.jobId,
      checks: s.verification ? { passed: s.verification.verdicts.filter(v => v.passed).map(v => v.check.name), failed: s.verification.verdicts.filter(v => !v.passed).map(v => v.check.name) } : null,
      artifact: s.resultPath, warnings: s.warnings?.length ? s.warnings : null, failure: s.failure ? `${s.failure.code}: ${trimWords(s.failure.message, 200)}` : null,
      outputTail: s.outputTail ? s.outputTail.slice(-OUTPUT_TAIL_CHARS) : null,
    })])),
  });
}

function git(cwd: string, args: string[]): Promise<{ out: string; clipped: boolean }> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout) => {
      if (!err) return resolve({ out: stdout, clipped: false });
      // maxBuffer overflow still hands back what was read; anything else is a real failure.
      if ((err as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ out: String((err as { stdout?: string }).stdout ?? ''), clipped: true });
      reject(err);
    });
  });
}

/** Unified diff of the job's changedFiles against its spawn-time HEAD. Evidence, not attribution. Never throws. */
export async function jobDiff(d: JobDetail): Promise<{ diff: string | null; diffNote?: string }> {
  const head = d.gitBaseline?.head;
  if (!d.gitBaseline || !head || !d.cwd) return { diff: null, diffNote: 'No git baseline was recorded for this job (its cwd was not a git repository with a commit at spawn), so no diff is available; inspect the files directly.' };
  if (!d.changedFiles) return { diff: null, diffNote: d.status === 'running' ? 'changedFiles is computed when the job finishes; call status again after it completes.' : 'No changedFiles were recorded for this job, so there is nothing to diff.' };
  if (d.changedFiles.length === 0) return { diff: '', diffNote: 'The job changed no files.' };
  try {
    const [tracked, untracked] = await Promise.all([
      git(d.cwd, ['diff', '--no-color', head, '--', ...d.changedFiles]),
      git(d.cwd, ['ls-files', '--others', '--exclude-standard', '--', ...d.changedFiles]),
    ]);
    const notes: string[] = [];
    let diff = tracked.out;
    if (diff.length > DIFF_MAX_CHARS || tracked.clipped) {
      diff = diff.slice(0, DIFF_MAX_CHARS); diff = diff.slice(0, diff.lastIndexOf('\n') + 1);
      notes.push(`Diff truncated at ${DIFF_MAX_CHARS} chars. See the rest with: git diff ${head} -- <file> (run in ${d.cwd}).`);
    }
    const added = untracked.out.split('\n').filter(Boolean);
    if (added.length) notes.push(`New untracked files not shown in the diff: ${added.join(', ')}.`);
    // The diff is against HEAD, so a file already dirty at spawn carries edits the job did not make.
    const preDirty = d.changedFiles.filter(f => d.gitBaseline!.dirty.includes(f));
    if (preDirty.length) notes.push(`Already uncommitted when the job started, so their diff includes earlier edits: ${preDirty.join(', ')}.`);
    return { diff, ...(notes.length ? { diffNote: notes.join(' ') } : {}) };
  } catch (err) {
    return { diff: null, diffNote: `git diff failed in ${d.cwd}: ${trimWords(String(err), 200)}. Run git diff ${head} -- <file> yourself.` };
  }
}

// ── capabilities ─────────────────────────────────────────────────────────────

/** Concise list_capabilities lists a provider's models inline up to this many; beyond it, a count and a hint. */
export const CONCISE_MODELS_CAP = 15;
/** Models that cannot run a coding job: embeddings, speech, image, video, music, live audio, computer use, research. */
const NON_CODING_MODEL = /embedding|(?:^|[-/])tts(?:$|-)|-tts\b|image|(?:^|\/)veo-|(?:^|\/)lyria-|-live-|computer-use|deep-research|translate/i;
/** When one model is reachable through several opencode routes, concise shows this route and lists the others under `via`. */
const PREFERRED_ROUTE = 'opencode';

export interface CapabilityModel { readonly id: string; readonly label?: string; readonly efforts?: readonly string[]; readonly defaultEffort?: string | null }
export interface CapabilityProvider {
  readonly name: string; readonly available: boolean;
  readonly defaultModel?: string | null; readonly defaultEffort?: string | null;
  readonly models: readonly CapabilityModel[];
  readonly stale?: boolean; readonly verified?: boolean; readonly error?: string;
}

/** `route/name` → [route, name]; an id without a route is its own name. */
function splitRoute(id: string): [string | null, string] {
  const i = id.indexOf('/');
  return i === -1 ? [null, id] : [id.slice(0, i), id.slice(i + 1)];
}

/** One row per model name: the preferred route's id, the other routes under `via`. */
function collapseRoutes(models: readonly CapabilityModel[]): Array<{ model: CapabilityModel; via: string[] }> {
  const byName = new Map<string, { model: CapabilityModel; via: string[] }>();
  for (const model of models) {
    const [route, name] = splitRoute(model.id);
    const seen = byName.get(name);
    if (seen === undefined) { byName.set(name, { model, via: [] }); continue; }
    if (route === PREFERRED_ROUTE) {
      const [kept] = splitRoute(seen.model.id);
      if (kept !== null) seen.via.push(kept);
      seen.model = model;
    } else if (route !== null) seen.via.push(route);
  }
  return [...byName.values()].map(({ model, via }) => ({ model, via: via.sort() }));
}

/**
 * The orchestrator needs enough to pick a provider, model and effort, and no
 * more. Drop fields that repeat a default or say nothing, models that cannot
 * code, and duplicate routes to one model. A provider with more models than the
 * cap reports a count; naming it in `provider` lists them all.
 */
export function conciseCapabilities(providers: readonly CapabilityProvider[], only: string | undefined) {
  return providers.map((p) => {
    if (!p.available) return { name: p.name, available: false };
    const coding = collapseRoutes(p.models.filter((m) => !NON_CODING_MODEL.test(m.id)));
    const efforts = commonEfforts(coding.map(({ model }) => model.efforts ?? []));
    const rows = coding.map(({ model, via }) => ({
      id: model.id,
      ...(model.efforts?.length && model.efforts.join() !== efforts?.join() ? { efforts: model.efforts } : {}),
      ...(model.defaultEffort && model.defaultEffort !== p.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
      ...(via.length ? { via } : {}),
    }));
    const listed = only !== undefined || rows.length <= CONCISE_MODELS_CAP;
    return {
      name: p.name, available: true,
      ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}),
      ...(p.defaultEffort ? { defaultEffort: p.defaultEffort } : {}),
      ...(efforts ? { efforts } : {}),
      ...(listed ? { models: rows } : { modelCount: rows.length, more: `pass provider: "${p.name}" to list its ${rows.length} models` }),
      ...(p.verified === false ? { unverified: 'model list parsed from unconfirmed CLI output; prefer an explicit, known model' } : {}),
      ...(p.stale ? { stale: true } : {}),
      ...(p.error ? { error: p.error } : {}),
    };
  });
}

/** The effort list most models share, stated once on the provider; models list theirs only when it differs. */
function commonEfforts(lists: ReadonlyArray<readonly string[]>): readonly string[] | undefined {
  const counts = new Map<string, { list: readonly string[]; n: number }>();
  for (const list of lists) {
    if (list.length === 0) continue;
    const key = list.join();
    const entry = counts.get(key) ?? { list, n: 0 };
    entry.n += 1;
    counts.set(key, entry);
  }
  let best: { list: readonly string[]; n: number } | undefined;
  for (const entry of counts.values()) if (best === undefined || entry.n > best.n) best = entry;
  return best?.list;
}
