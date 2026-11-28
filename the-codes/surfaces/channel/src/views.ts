import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { JobDetail, JobSummary } from '../../../forge/service.ts';
import { failedReason } from '../../../forge/summary.ts';
import type { ContinuationKind } from '../../../forge/format.ts';
import type { Acceptance } from '../../../forge/checks.ts';
import type { PipelineRecord } from '../../../forge/execute.ts';
import { livenessOf, type Liveness } from '../../mod/hooks/stale.ts';
import { isTerminalStatus } from '../../mod/hooks/turns.ts';
import { jobSummary } from '../../mod/hooks/text.ts';
import { hasTeam, teamCounts, type TeamCounts } from '../../mod/hooks/team.ts';

export type ResponseFormat = 'concise' | 'detailed';
export const CONCISE_LIST_LIMIT = 20;
const CONCISE_SUMMARY_CHARS = 160;
const CONCISE_REPORT_CHARS = 2_000;
const CONCISE_FILES_CAP = 20;
export const EARLIER_TURNS_CAP = 5;
const EARLIER_SUMMARY_CHARS = 120;
const OUTPUT_TAIL_CHARS = 500;
const DIFF_MAX_CHARS = 40_000;
const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
export function taskStatus(status: JobSummary['status']): TaskStatus {
  switch (status) {
    case 'running': case 'unknown': return 'working';
    case 'succeeded': return 'completed';
    case 'failed': return 'failed';
    case 'canceled': return 'cancelled';
  }
}

function trimWords(text: string, max: number): string {
  const t = flat(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function parseSince(value: string, now = Date.now()): number {
  const rel = /^(\d+)\s*([smhd])$/i.exec(value.trim());
  if (rel) return now - Number(rel[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2]!.toLowerCase() as 's' | 'm' | 'h' | 'd'];
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error(`since: use an ISO time or 30m, 2h, 1d; got "${value}".`);
  return at;
}

function lastActivity(a: JobSummary['lastActivity']): string | undefined {
  return a ? `step ${a.stepIndex}: ${a.tool}${a.input ? ` ${trimWords(a.input, 80)}` : ''} (${a.status})` : undefined;
}
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}
const warningTexts = (ws: JobSummary['warnings'], error: string | null): string[] => {
  const e = error ? flat(error) : '';
  return [...new Set(ws.map(w => flat(w.message)).filter(m => e === '' || !(e.includes(m) || m.includes(e))).map(m => trimWords(m, 200)))];
};

export function jobLiveness(j: JobSummary, now = Date.now()): Liveness | null {
  return livenessOf({ status: j.status, updatedAt: j.updatedAt, lastEventAt: j.lastEventAt, lastAliveAt: j.lastAliveAt,
    lastActivity: j.lastActivity, team: j.team, now });
}
export function teamView(team: JobSummary['team']): TeamCounts | null {
  return hasTeam(team) ? teamCounts(team) : null;
}
export function withTeamCounts<T extends JobSummary>(j: T): Omit<T, 'team'> & { team?: TeamCounts } {
  const { team, ...rest } = j;
  const counts = teamView(team);
  return counts === null ? rest : { ...rest, team: counts };
}
export function livenessView(l: Liveness | null) {
  return l === null ? null : { state: l.state, silentForMs: l.silentForMs, ...(l.tool ? { tool: l.tool } : {}) };
}
function evidence(j: JobSummary) {
  return {
    toolErrors: j.toolErrors ? j.toolErrors : null,
    failedEarly: j.failedEarly ? true : null,
    changedFilesUnknown: j.changedFilesUnknown ? true : null,
    cwdMissingAtFinish: j.cwdMissingAtFinish ? true : null,
  };
}

export function conciseRow(j: JobSummary & { turn?: number; continuedFrom?: string; continuationKind?: ContinuationKind; chainStartedAt?: string }, now = Date.now()) {
  const turn = j.turn ?? 1;
  const started = j.startedAt ? Date.parse(j.startedAt) : NaN;
  const base = {
    name: j.name,
    jobId: j.jobId,
    turn: turn > 1 ? turn : null,
    status: j.status,
    provider: j.provider,
    model: j.model,
    mode: j.mode,
  };
  if (isTerminalStatus(j.status)) {
    const ended = j.finishedAt ? Date.parse(j.finishedAt) : NaN;
    return compact({
      ...base,
      summary: j.latestSummary ? trimWords(j.latestSummary, CONCISE_SUMMARY_CHARS) : null,
      durationMs: !Number.isNaN(started) && !Number.isNaN(ended) ? Math.max(0, ended - started) : null,
      finishedAt: j.finishedAt,
      acceptance: j.acceptance && (j.acceptance.state !== 'unchecked' || j.acceptance.pending || j.acceptance.checks.length > 0)
        ? checkVerdicts(j.acceptance) : null,
      changedFileCount: typeof j.changedFileCount === 'number' && j.changedFileCount > 0 ? j.changedFileCount : null,
      warningCount: j.warnings.length || null,
      reason: failedReason(j),
      resumable: j.status === 'failed' ? (j.resumable ?? Boolean((j as { conversation?: string | null }).conversation)) : null,
      ...evidence(j),
    });
  }
  const live = jobLiveness(j, now);
  return compact({
    ...base,
    liveness: livenessView(live),
    lastActivity: lastActivity(j.lastActivity),
    digest: j.digest ? compact({
      phase: j.digest.phase, filesRead: j.digest.filesRead || null,
      editedCount: j.digest.editedCount || null, edited: j.digest.edited.length ? j.digest.edited.slice(0, 5) : null,
      testRuns: j.digest.testRuns || null, lastTestFailed: j.digest.lastTestFailed ? true : null, repeat: j.digest.repeat,
    }) : null,
    elapsedMs: Number.isNaN(started) ? null : Math.max(0, now - started),
    toolCalls: j.toolCalls,
    pendingMessages: j.pendingSteers ? j.pendingSteers : null,
  });
}

type AcceptanceView = Pick<Acceptance, 'state'> & Partial<Acceptance>;
const names = (a: Partial<Acceptance>, ok: boolean) => { const n = (a.checks ?? []).filter(c => c.ok === ok).map(c => c.name); return n.length ? n : null; };
function checkVerdicts(a: AcceptanceView | null | undefined) {
  if (!a) return null;
  return compact({
    state: a.state, pending: a.pending ? true : null, running: a.pending ? a.running ?? null : null, reason: a.reason ?? null,
    passed: names(a, true), failed: names(a, false),
  });
}

export function conciseStatus(d: JobDetail & { turn?: number; continuedFrom?: string; continuationKind?: ContinuationKind; chainStartedAt?: string; resolvedFrom?: string | null }, acceptance: AcceptanceView | null, extra: { waited?: boolean; stillRunning?: boolean } = {}, now = Date.now()) {
  const report = d.report ?? '';
  const cut = report.length > CONCISE_REPORT_CHARS;
  const turn = d.turn ?? 1;
  const running = !isTerminalStatus(d.status);
  const live = running ? jobLiveness(d, now) : null;
  const started = d.startedAt ? Date.parse(d.startedAt) : NaN;
  const ended = d.finishedAt ? Date.parse(d.finishedAt) : now;
  const files = d.changedFiles ?? [];
  const warnings = d.warnings.length ? warningTexts(d.warnings, d.error) : [];
  const summary = running ? d.latestSummary?.trim() : undefined;
  return compact({
    jobId: d.jobId,
    workerId: d.workerId,
    name: d.name,
    turn: turn > 1 ? turn : null,
    status: d.status,
    provider: d.provider, model: d.model, mode: d.mode,
    acceptance: checkVerdicts(acceptance),
    supersededBy: d.supersededBy || null,
    resolvedFrom: d.resolvedFrom || null,
    liveness: live ? livenessView(live) : null,
    team: teamView(d.team),
    lastActivity: running ? lastActivity(d.lastActivity) : null,
    durationMs: Number.isNaN(started) ? null : Math.max(0, ended - started),
    pendingMessages: d.pendingSteers ? d.pendingSteers : null,
    changedFileCount: d.changedFiles && files.length > 0 ? files.length : null,
    changedFiles: files.length ? files.slice(0, CONCISE_FILES_CAP) : null,
    changedFilesNote: files.length > CONCISE_FILES_CAP || d.changedFilesTruncated ? `First ${Math.min(files.length, CONCISE_FILES_CAP)} of ${files.length}${d.changedFilesTruncated ? '+' : ''} shown.` : null,
    ...evidence(d),
    staleReads: d.staleReads?.length ? d.staleReads : null,
    resumable: running || d.status === 'succeeded' ? null : (d.resumable ?? Boolean(d.conversation)),
    reason: failedReason(d),
    error: d.error ? trimWords(d.error, 500) : null,
    warnings: warnings.length ? warnings : null,
    summary: summary ? trimWords(summary, 300) : null,
    report: report ? (cut ? `${report.slice(0, CONCISE_REPORT_CHARS)}\n…[truncated: ${CONCISE_REPORT_CHARS} of ${report.length} chars shown]` : report) : null,
    reportTruncated: cut || null,
    ...extra,
  });
}

export function earlierTurn(d: JobDetail & { turn?: number; continuedFrom?: string; continuationKind?: ContinuationKind }, reportPath: string, fmt: ResponseFormat) {
  const report = d.report ?? '';
  const rawSummary = jobSummary(report, d.latestSummary);
  const summary = rawSummary ? trimWords(rawSummary, EARLIER_SUMMARY_CHARS) : null;
  const base = {
    turn: d.turn ?? 1,
    jobId: d.jobId,
    status: d.status,
    summary,
  };
  if (fmt === 'concise') return compact(base);
  return compact({
    ...base,
    report: report || null,
    reportPath,
  });
}

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
      if ((err as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ out: String((err as { stdout?: string }).stdout ?? ''), clipped: true });
      reject(err);
    });
  });
}

export function withWorkerFiles<T extends JobDetail>(head: T, earlier: readonly JobDetail[]): T {
  if (earlier.length === 0) return head;
  const turns = [...earlier, head];
  const anyRecorded = turns.some(t => Array.isArray(t.changedFiles));
  const changedFiles = [...new Set(turns.flatMap(t => t.changedFiles ?? []))];
  const changedFilesUnknown = turns.some(t => t.changedFilesUnknown === true);
  const changedFilesTruncated = turns.some(t => t.changedFilesTruncated === true);
  return {
    ...head,
    ...(anyRecorded ? { changedFiles, changedFileCount: changedFiles.length } : {}),
    ...(changedFilesUnknown ? { changedFilesUnknown: true } : {}),
    ...(changedFilesTruncated ? { changedFilesTruncated: true } : {}),
  };
}

export function withWorkerBaseline<T extends JobDetail>(head: T, earlier: readonly JobDetail[]): T {
  if (earlier.length === 0) return head;
  const baselineTurn = [...earlier, head].find(t => Boolean(t.gitBaseline?.head));
  if (!baselineTurn) return head;
  return { ...head, gitBaseline: baselineTurn.gitBaseline, cwd: baselineTurn.cwd ?? head.cwd };
}

export async function jobDiff(d: JobDetail, { runningTurnPending = false }: { runningTurnPending?: boolean } = {}): Promise<{ diff: string | null; diffNote?: string }> {
  const head = d.gitBaseline?.head;
  if (!d.gitBaseline || !head || !d.cwd) return { diff: null, diffNote: 'No diff: no git commit at spawn.' };
  if (!d.changedFiles) return { diff: null, diffNote: d.status === 'running' ? 'No diff yet: files are listed when the job finishes.' : 'No diff: no changed files recorded.' };
  if (d.changedFiles.length === 0) {
    return { diff: '', diffNote: runningTurnPending ? "No files changed yet; the running turn's files are added when it finishes." : 'No files changed.' };
  }
  if (!existsSync(d.cwd)) return { diff: null, diffNote: `No diff: ${d.cwd} no longer exists.` };
  try {
    const [tracked, untracked] = await Promise.all([
      git(d.cwd, ['diff', '--no-color', head, '--', ...d.changedFiles]),
      git(d.cwd, ['ls-files', '--others', '--exclude-standard', '--', ...d.changedFiles]),
    ]);
    const notes: string[] = [];
    let diff = tracked.out;
    if (diff.length > DIFF_MAX_CHARS || tracked.clipped) {
      diff = diff.slice(0, DIFF_MAX_CHARS); diff = diff.slice(0, diff.lastIndexOf('\n') + 1);
      notes.push(`Diff cut at ${DIFF_MAX_CHARS} chars. Rest: git diff ${head} -- <file> in ${d.cwd}.`);
    }
    const added = untracked.out.split('\n').filter(Boolean);
    if (added.length) notes.push(`Untracked, not in diff: ${added.join(', ')}.`);
    const preDirty = d.changedFiles.filter(f => d.gitBaseline!.dirty.includes(f));
    if (preDirty.length) notes.push(`Dirty before the job, so the diff includes earlier edits: ${preDirty.join(', ')}.`);
    if (runningTurnPending) notes.push("The running turn's files are added when it finishes.");
    return { diff, ...(notes.length ? { diffNote: notes.join(' ') } : {}) };
  } catch (err) {
    return { diff: null, diffNote: `git diff failed: ${trimWords(String(err), 200)}. Run git diff ${head} -- <file> yourself.` };
  }
}

export const CONCISE_MODELS_CAP = 15;
const NON_CODING_MODEL = /embedding|(?:^|[-/])tts(?:$|-)|-tts\b|image|(?:^|\/)veo-|(?:^|\/)lyria-|-live-|computer-use|deep-research|translate/i;
export interface CapabilityModel { readonly id: string; readonly label?: string; readonly efforts?: readonly string[]; readonly defaultEffort?: string | null }
export interface CapabilityProvider {
  readonly name: string; readonly available: boolean;
  readonly defaultModel?: string | null; readonly defaultEffort?: string | null;
  readonly models: readonly CapabilityModel[];
  readonly stale?: boolean; readonly verified?: boolean; readonly error?: string;
}

export function conciseCapabilities(providers: readonly CapabilityProvider[], only: string | undefined) {
  return providers.map((p) => {
    if (!p.available) return { name: p.name, available: false, ...(p.error ? { error: p.error } : {}) };
    const coding = p.models.filter((m) => !NON_CODING_MODEL.test(m.id));
    const efforts = commonEfforts(coding.map(model => model.efforts ?? []));
    const rows = coding.map(model => ({
      id: model.id,
      ...(model.efforts?.length && model.efforts.join() !== efforts?.join() ? { efforts: model.efforts } : {}),
      ...(model.defaultEffort && model.defaultEffort !== p.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
    }));
    const listed = only !== undefined || rows.length <= CONCISE_MODELS_CAP;
    return {
      name: p.name, available: true,
      ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}),
      ...(p.defaultEffort ? { defaultEffort: p.defaultEffort } : {}),
      ...(efforts ? { efforts } : {}),
      ...(listed ? { models: rows } : { modelCount: rows.length, more: `0 of ${rows.length} models shown` }),
      ...(p.verified === false ? { unverified: 'model list unconfirmed' } : {}),
      ...(p.stale ? { stale: true } : {}),
      ...(p.error ? { error: p.error } : {}),
    };
  });
}

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
