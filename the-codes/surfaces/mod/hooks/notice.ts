import { STEER_NOT_APPLIED_RE, checksReason, noticeReason, reasonFromText } from './reasons.ts';
import { isTerminal } from './format.ts';
import { isWorkerIdle, pickHead, type ContinuationKind, type TurnLike } from './turns.ts';

export type NoticeContinuationKind = ContinuationKind;

export interface NoticeRow {
  readonly id: string;
  readonly status: string;
  readonly workerId?: string;
  readonly turn?: number;
  readonly name?: string | null;
  readonly provider?: string | null;
  readonly role?: string | null;
  readonly startedAt: number | null;
  readonly chainStartedAt?: number | null;
  readonly endedAt: number | null;
  readonly lastEventAt?: number | null;
  readonly changedFileCount?: number | null;
  readonly failureReason?: string | null;
  readonly failureDetail?: string | null;
  readonly latestSummary?: string | null;
  readonly summarySource?: 'worker' | null;
  readonly supersededBy?: string | null;
  readonly followedBy?: string | null;
  readonly continuedFrom?: string | null;
  readonly continuationKind?: NoticeContinuationKind | null;
  readonly pendingMessages?: number | null;
  readonly warnings?: readonly { readonly code: string; readonly message?: string }[] | null;
  readonly pipeline?: string | null;
  readonly staleReads?: readonly string[] | null;
  readonly acceptance?: { readonly pending?: boolean; readonly budgetMs?: number; readonly running?: string; readonly checks: readonly { readonly ok: boolean; readonly name?: string }[] };
  readonly liveness?: { readonly state: string; readonly silentForMs: number; readonly since: number | null; readonly tool?: string } | null;
}

export type NoticeKind = 'finished' | 'failed' | 'cancelled' | 'attention';

export const ACCEPTANCE_HOLD_MS = 5 * 60_000;

export interface NoticeJob {
  readonly id: string;
  readonly workerId?: string;
  readonly kind: NoticeKind;
  readonly name?: string | null;
  readonly provider?: string | null;
  readonly role?: string | null;
  readonly durationMs?: number | null;
  readonly changedFiles?: number | null;
  readonly checks?: { readonly passed: number; readonly total: number; readonly failed?: readonly string[] } | null;
  readonly reason?: string | null;
  readonly summary?: string | null;
  readonly staleReads?: readonly string[] | null;
  readonly continuationKind?: NoticeContinuationKind | null;
  readonly steerNotApplied?: boolean;
  readonly droppedMessage?: string;
  readonly turns?: { readonly from: number; readonly to: number };
  readonly run?: boolean;
  readonly checksRunning?: string | true;
  readonly liveness?: { readonly state: 'silent' | 'dead'; readonly tool?: string };
}

const GLYPH: Record<NoticeKind, string> = { finished: '✓', failed: '✗', cancelled: '■', attention: '!' };

export function compactExcerpt(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const prefix = text.slice(0, Math.max(0, max - 1));
  const sentence = [...prefix.matchAll(/[.!?](?=\s)/g)].at(-1)?.index;
  const end = sentence !== undefined && sentence >= max / 2 ? sentence + 1 : prefix.lastIndexOf(' ');
  return `${end > 0 ? prefix.slice(0, end).trimEnd() : ''}…`;
}

export function durationWords(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function chosenName(job: NoticeJob): string | null {
  if (!job.name) return null;
  return !job.run && job.id.length >= 8 && job.name.endsWith(`-${job.id.slice(-8)}`) ? null : job.name;
}

function who(job: NoticeJob): string {
  const identity = [job.provider, job.role].filter(Boolean).join(' ');
  const name = chosenName(job);
  if (job.run) return name ?? `pipeline ${job.id}`;
  if (name) return identity ? `${name} (${identity})` : name;
  return identity ? `${job.id} (${identity})` : `job ${job.id}`;
}

function rejected(job: NoticeJob): boolean {
  return job.kind === 'finished' && !job.run && job.checks != null && job.checks.passed < job.checks.total;
}

export function headline(job: NoticeJob): string {
  const d = durationWords(job.durationMs);
  const reason = job.reason ? compactExcerpt(job.reason, 160) : '';
  const bad = rejected(job);
  const awaiting = job.kind === 'finished' && !job.run && !bad && job.checksRunning !== undefined;
  const glyph = bad ? GLYPH.failed : awaiting ? '…' : GLYPH[job.kind];
  const parts: string[] = [`${glyph} ${who(job)}`];
  switch (job.kind) {
    case 'finished':
      if (job.run) parts.push(reason || 'done');
      else if (bad) parts.push(checksReason(job.checks?.failed ?? []));
      else if (awaiting) {
        parts.push('exited', typeof job.checksRunning === 'string' ? `checks running: ${job.checksRunning}` : 'checks pending');
      } else if (job.checks && job.checks.total > 0) {
        parts.push(`checks ${job.checks.passed}/${job.checks.total}`);
      } else {
        parts.push('done');
      }
      break;
    case 'failed': parts.push(job.run ? reason || 'failed' : `failed${reason ? `: ${reason}` : ''}`); break;
    case 'cancelled': parts.push('canceled'); break;
    case 'attention':
      if (job.liveness?.state === 'dead') parts.push(`process gone${d ? ` ${d}` : ''}`);
      else parts.push(`no output${d ? ` for ${d}` : ''}${job.liveness?.tool ? ` (in \`${job.liveness.tool}\`)` : ''}`);
      break;
  }
  if (d && job.kind !== 'attention') parts.push(d);
  if (job.turns) {
    if (job.turns.from < job.turns.to) parts.push(`turns ${job.turns.from}–${job.turns.to}`);
    else if (job.turns.to > 1) parts.push(`turn ${job.turns.to}`);
  }
  if (job.steerNotApplied) parts.push(`queued follow-up not sent${job.droppedMessage ? `: "${compactExcerpt(job.droppedMessage, 80)}"` : ''}`);
  if (job.staleReads && job.staleReads.length > 0) {
    const first = job.staleReads[0]!;
    const extra = job.staleReads.length > 1 ? ` +${job.staleReads.length - 1}` : '';
    parts.push(`stale brief: ${first}${extra}`);
  }
  return parts.join(' · ');
}

const CLAUDE_JOBS = 8;

export function claudeText(jobs: readonly NoticeJob[]): string {
  if (jobs.length === 0) return '';
  const one = jobs.length === 1;
  const lines: string[] = [];
  if (!one) {
    const counts = new Map<string, number>();
    for (const job of jobs) {
      const label = rejected(job) ? 'failed' : job.checksRunning !== undefined && job.kind === 'finished' && !job.run ? 'exited'
        : job.kind === 'attention' && job.liveness?.state === 'dead' ? 'process gone' : STATE[job.kind];
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    lines.push(`Agent Smith · ${jobs.length} jobs: ${[...shown(counts)].map(([k, n]) => `${n} ${k}`).join(', ')}`);
  }
  const listed = jobs.slice(0, CLAUDE_JOBS);
  for (const job of listed) lines.push(`${one ? 'Agent Smith · ' : ''}${headline(job)}`);
  if (jobs.length > CLAUDE_JOBS) lines.push(`…and ${jobs.length - CLAUDE_JOBS} more; list_jobs shows them.`);
  const ids = (run: boolean) => listed.filter((j) => !!j.run === run).map((j) => (run ? j.id : j.workerId ?? j.id));
  if (ids(false).length > 0) lines.push(`status ${ids(false).join(', ')}`);
  if (ids(true).length > 0) lines.push(`pipeline_status ${ids(true).join(', ')}`);
  return lines.join('\n');
}

function shown(counts: ReadonlyMap<string, number>): [string, number][] {
  return ['done', 'exited', 'failed', 'canceled', 'no output', 'process gone'].flatMap((k) => (counts.has(k) ? [[k, counts.get(k)!] as [string, number]] : []));
}

/**
 * The host frames every plugin prompt for Claude: a header naming the plugin and
 * a footer saying how the prompt arrived. Claude keeps them (they mark the text
 * as not the user's); the transcript row does not need them.
 */
const HOST_FRAME = [
  /^The \S+ plugin sent a message(?: while you were working)?:$/,
  /^This is how Claude Code surfaces (?:a prompt|prompts) a plugin submits\b/,
];

const READ_LINE = /^(?:status|pipeline_status) /;

export function displayNoticeText(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !HOST_FRAME.some((re) => re.test(line)) && !READ_LINE.test(line))
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines.join('\n') : text;
}

const STATE: Record<NoticeKind, string> = {
  finished: 'done', failed: 'failed', cancelled: 'canceled', attention: 'no output',
};

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function unwrapResponse(response: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4) return null;
  if (typeof response === 'string') {
    try { return unwrapResponse(JSON.parse(response) as unknown, depth + 1); } catch { return null; }
  }
  if (Array.isArray(response)) {
    for (const part of response) {
      if (isObj(part) && typeof part['text'] === 'string') {
        const r = unwrapResponse(part['text'], depth + 1);
        if (r) return r;
      }
    }
    return null;
  }
  if (!isObj(response)) return null;
  if (response['isError'] === true) return null;
  if (isObj(response['_meta']) && response['_meta']['io.agent-smith/task-result'] === true) return null;
  if (isObj(response['structuredContent'])) return response['structuredContent'];
  if (Array.isArray(response['content'])) return unwrapResponse(response['content'], depth + 1);
  return response;
}

const LAUNCH: Record<string, 'job' | 'run'> = { spawn_job: 'job', follow_up: 'job', steer: 'job', run_pipeline: 'run' };

export const LAUNCH_TOOL = /^mcp__(?:plugin_agent-smith_)?agent-smith__(?:spawn_job|follow_up|steer|run_pipeline)$/;
export const STATUS_TOOL = /^mcp__(?:plugin_agent-smith_)?agent-smith__(?:status|pipeline_status|cancel)$/;

export function parseSettledRead(
  toolName: unknown,
  response: unknown,
): { readonly kind: 'job' | 'run'; readonly id: string; readonly resolvedFrom?: string; readonly workerId?: string } | null {
  if (typeof toolName !== 'string' || !STATUS_TOOL.test(toolName)) return null;
  const payload = unwrapResponse(response);
  if (payload === null || typeof payload['error'] === 'string') return null;
  const bare = toolName.slice(toolName.lastIndexOf('__') + 2);
  const workerId = typeof payload['workerId'] === 'string' && payload['workerId'].length > 0 ? payload['workerId'] : undefined;
  if (bare === 'cancel') {
    if (payload['settled'] !== true) return null;
    const runId = payload['runId'];
    if (typeof runId === 'string' && runId.length > 0) return { kind: 'run', id: runId };
    const jobId = payload['jobId'];
    if (typeof jobId !== 'string' || jobId.length === 0) return null;
    const resolvedFrom = payload['resolvedFrom'];
    return {
      kind: 'job',
      id: jobId,
      ...(typeof resolvedFrom === 'string' && resolvedFrom.length > 0 && resolvedFrom !== jobId ? { resolvedFrom } : {}),
      ...(workerId !== undefined ? { workerId } : {}),
    };
  }
  if (bare === 'pipeline_status') {
    const runId = payload['runId'];
    const status = payload['status'];
    if (typeof runId === 'string' && runId.length > 0 && (status === 'passed' || status === 'partial' || status === 'failed')) {
      return { kind: 'run', id: runId };
    }
    return null;
  }
  const jobId = payload['jobId'];
  const status = payload['status'];
  if (typeof jobId !== 'string' || jobId.length === 0) return null;
  if (typeof payload['supersededBy'] === 'string' && payload['supersededBy'].length > 0) return null;
  if (typeof status !== 'string' || !isTerminal(status)) return null;
  const acceptance = payload['acceptance'];
  if (!isObj(acceptance) || acceptance['pending'] === true) return null;
  return { kind: 'job', id: jobId, ...(workerId !== undefined ? { workerId } : {}) };
}

export function unclaim(
  owned: readonly Owned[],
  settled: { readonly kind: 'job' | 'run'; readonly id: string; readonly resolvedFrom?: string; readonly workerId?: string },
): Owned[] {
  const matches = (o: Owned) => o.kind === settled.kind && (
    o.id === settled.id ||
    (settled.resolvedFrom !== undefined && o.id === settled.resolvedFrom) ||
    (settled.workerId !== undefined && o.workerId === settled.workerId));
  if (settled.kind === 'run') return owned.filter((o) => !matches(o));
  return owned.map((o) => (matches(o) ? { ...o, readHead: settled.id } : o));
}

export function refusesStatusWait(owned: readonly Owned[], jobs: readonly NoticeRow[], id: string): boolean {
  const named = (match: (row: NoticeRow) => boolean) => new Set(jobs.filter(match).map((row) => row.workerId ?? row.id));
  const byId = named((row) => row.id === id);
  const byWorker = named((row) => row.workerId === id);
  const workers = byId.size > 0 ? byId : byWorker.size > 0 ? byWorker : named((row) => row.name === id);
  if (workers.size !== 1) return false;
  const [workerId] = workers;
  const turns = jobs.filter((row) => (row.workerId ?? row.id) === workerId);
  const head = pickHead(turns.map(noticeTurn));
  if (head === null || head.status === 'attention' || isWorkerIdle(head)) return false;
  return owned.some((o) => o.kind === 'job' && o.readHead === undefined && o.saidAttention !== true &&
    (o.workerId === workerId || turns.some((row) => row.id === o.id)));
}

function launchKind(toolName: unknown): 'job' | 'run' | null {
  if (typeof toolName !== 'string') return null;
  const bare = toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
  return LAUNCH[bare] ?? null;
}

const trimSlash = (p: string): string => p.replace(/\/+$/, '');
function repoAbove(file: string, dir: 'jobs' | 'pipelines'): string | null {
  const parts = trimSlash(file).split('/');
  return parts.length >= 3 && parts.at(-2) === dir && parts.at(-3) === '.agent-smith' ? parts.slice(0, -3).join('/') || '/' : null;
}

export function claimMarkerPath(repo: string, kind: 'job' | 'run', id: string): string {
  return `${repo.replace(/\/+$/, '')}/.agent-smith/claims/${kind}-${encodeURIComponent(id)}`;
}

export interface Launch {
  readonly kind: 'job' | 'run';
  readonly id: string;
  readonly workerId?: string;
  readonly startsTurn?: true;
  readonly repo: string | null;
  readonly timeoutMs: number | null;
}

export function parseLaunch(toolName: unknown, response: unknown): Launch | null {
  const kind = launchKind(toolName);
  if (kind === null) return null;
  const payload = unwrapResponse(response);
  if (payload === null) return null;
  return launchFromPayload(kind, payload);
}

export function parseLaunches(toolName: unknown, response: unknown): Launch[] {
  const kind = launchKind(toolName);
  if (kind === null) return [];
  const payload = unwrapResponse(response);
  if (payload === null || typeof payload['error'] === 'string') return [];
  const jobs = payload['jobs'];
  if (kind === 'job' && Array.isArray(jobs)) {
    return jobs.flatMap((item): Launch[] => {
      const one = isRecord(item) ? launchFromPayload('job', item) : null;
      return one === null ? [] : [one];
    });
  }
  const one = launchFromPayload(kind, payload);
  return one === null ? [] : [one];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function launchFromPayload(kind: 'job' | 'run', payload: Record<string, unknown>): Launch | null {
  if (typeof payload['error'] === 'string') return null;
  const id = kind === 'job' ? payload['jobId'] : payload['runId'];
  // Hosts may expose only structuredContent and omit the outer MCP metadata.
  if (kind === 'job' && isTerminal(String(payload['status']))) return null;
  if (typeof id !== 'string' || id.length === 0) return null;
  const workerId = kind === 'job' && typeof payload['workerId'] === 'string' && payload['workerId'].length > 0
    ? payload['workerId'] : undefined;
  let repo: string | null = null;
  if (typeof payload['repo'] === 'string' && payload['repo'].length > 0) repo = trimSlash(payload['repo']);
  else if (kind === 'job' && typeof payload['dir'] === 'string') repo = repoAbove(payload['dir'], 'jobs');
  else if (kind === 'run' && typeof payload['recordPath'] === 'string') repo = repoAbove(payload['recordPath'], 'pipelines');
  const t = payload['timeoutMs'];
  return {
    kind,
    id,
    ...(workerId !== undefined ? { workerId } : {}),
    ...(payload['action'] === 'started' ? { startsTurn: true as const } : {}),
    repo,
    timeoutMs: typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null,
  };
}

function kindOf(status: string): NoticeKind | null {
  switch (status) {
    case 'succeeded': return 'finished';
    case 'failed': return 'failed';
    case 'canceled': return 'cancelled';
    case 'attention': return 'attention';
    default: return null;
  }
}

export function noticeFromRadar(job: NoticeRow, kind: NoticeKind, now: number): NoticeJob {
  const checks = job.acceptance?.checks ?? [];
  const dead = kind === 'attention' && job.liveness?.state === 'dead';
  const start = job.chainStartedAt ?? job.startedAt;
  const span = dead
    ? (job.liveness?.since != null ? now - job.liveness.since : null)
    : kind === 'attention'
      ? (job.liveness ? job.liveness.silentForMs : job.lastEventAt != null ? now - job.lastEventAt : null)
      : (job.endedAt != null && start != null ? job.endedAt - start : null);
  return {
    id: job.id, ...(job.workerId ? { workerId: job.workerId } : {}), kind, name: job.name, provider: job.provider, role: job.role,
    durationMs: span,
    changedFiles: job.changedFileCount ?? null,
    checks: checks.length > 0
      ? { passed: checks.filter((c) => c.ok).length, total: checks.length, failed: checks.filter((c) => !c.ok).flatMap((c) => (c.name ? [c.name] : [])) }
      : null,
    reason: kind === 'failed' ? noticeReason(job.failureReason, job.failureDetail) : null,
    summary: job.summarySource === 'worker' ? job.latestSummary ?? null : null,
    ...(job.staleReads && job.staleReads.length > 0 ? { staleReads: job.staleReads } : {}),
    ...(job.continuationKind ? { continuationKind: job.continuationKind } : {}),
    ...steerNotAppliedFields(job.warnings),
    ...(kind === 'finished' && job.acceptance?.pending === true ? { checksRunning: job.acceptance.running ?? true } : {}),
    ...(kind === 'attention' ? { liveness: { state: dead ? 'dead' as const : 'silent' as const, ...(job.liveness?.tool ? { tool: job.liveness.tool } : {}) } } : {}),
  };
}

export function steerNotAppliedFields(warnings: NoticeRow['warnings']): { steerNotApplied?: true; droppedMessage?: string } {
  const w = warnings?.find((x) => x.code === 'steer_not_applied' || (typeof x.message === 'string' && STEER_NOT_APPLIED_RE.test(x.message)));
  if (!w) return {};
  const quote = droppedMessageQuote(w.message);
  return { steerNotApplied: true, ...(quote ? { droppedMessage: quote } : {}) };
}

export function droppedMessageQuote(message: string | null | undefined): string | null {
  if (typeof message !== 'string') return null;
  const m = /"([^"\n]+)|“([^”\n]+)/.exec(message);
  const text = (m?.[1] ?? m?.[2] ?? '').trim();
  return text === '' ? null : text;
}

export interface RunRecord {
  readonly runId: string;
  readonly pipeline: string;
  readonly status: 'running' | 'passed' | 'partial' | 'failed';
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly error?: string | undefined;
  readonly stageResults: Readonly<Record<string, { stage?: unknown; status?: unknown; acceptance?: unknown; jobId?: unknown; failure?: unknown; verification?: unknown } | null>>;
}

export function pipelineOutcome(run: RunRecord): string {
  const stages = Object.values(run.stageResults)
    .filter((s): s is NonNullable<typeof s> => s !== null && typeof s === 'object' && typeof s.stage === 'string');
  const passed = stages.filter((s) => s.status === 'passed' && s.acceptance !== 'failed').length;
  const bad = stages.find((s) => s.status === 'failed' || s.acceptance === 'failed');
  const head = `${passed}/${stages.length} stages passed`;
  if (bad) return `${head} · ${String(bad.stage)}: ${stageReason(bad)}`;
  return run.error && run.status !== 'passed' ? `${head} · ${reasonFromText(run.error)}` : head;
}

function stageReason(s: NonNullable<RunRecord['stageResults'][string]>): string {
  if (s.acceptance === 'failed') {
    const failing = isObj(s.verification) && Array.isArray(s.verification['failing']) ? s.verification['failing'] : [];
    const names = failing.flatMap((v) => (isObj(v) && isObj(v['check']) && typeof v['check']['name'] === 'string' ? [v['check']['name']] : []));
    return checksReason(names);
  }
  const f = isObj(s.failure) ? s.failure : null;
  return reasonFromText(typeof f?.['message'] === 'string' ? f['message'] : typeof f?.['code'] === 'string' ? f['code'] : null);
}

export function asRunRecord(value: unknown): RunRecord | null {
  if (!isObj(value)) return null;
  const r = value as Partial<RunRecord>;
  if (typeof r.runId !== 'string' || typeof r.pipeline !== 'string' || !Number.isFinite(r.startedAt) ||
      (r.finishedAt !== null && !Number.isFinite(r.finishedAt)) ||
      !['running', 'passed', 'partial', 'failed'].includes(String(r.status)) || !isObj(r.stageResults)) return null;
  return r as RunRecord;
}

function noticeFromRun(run: RunRecord): NoticeJob | null {
  if (run.status === 'running' || run.finishedAt === null) return null;
  return {
    id: run.runId, kind: run.status === 'passed' ? 'finished' : 'failed', name: run.pipeline, role: 'pipeline', run: true,
    durationMs: run.finishedAt - run.startedAt, reason: pipelineOutcome(run),
  };
}

export function stageJobIds(run: RunRecord): string[] {
  return Object.values(run.stageResults).flatMap((s) => (s && typeof s.jobId === 'string' ? [s.jobId] : []));
}

export function runFileName(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100) || 'pipeline'}.json`;
}

export interface Owned {
  readonly kind: 'job' | 'run';
  readonly id: string;
  readonly workerId?: string;
  readonly fromTurn?: number;
  readonly readHead?: string;
  readonly at: number;
  readonly until: number;
  readonly saidAttention?: boolean;
  readonly saidDead?: boolean;
  readonly saidExited?: boolean;
  readonly saidStageAttention?: readonly string[];
}

const MAX_JOB_MS = 6 * 60 * 60_000;

export function claim(owned: readonly Owned[], launch: Launch, now: number): Owned[] {
  const until = now + (launch.timeoutMs ?? MAX_JOB_MS) + 60 * 60_000;
  const idx = owned.findIndex((o) => o.kind === launch.kind && (
    o.id === launch.id || (launch.kind === 'job' && launch.workerId !== undefined && o.workerId === launch.workerId)));
  if (idx < 0) {
    return [...owned, { kind: launch.kind, id: launch.id, ...(launch.workerId ? { workerId: launch.workerId } : {}), at: now, until }];
  }
  if (launch.startsTurn === true && owned[idx]!.id !== launch.id) {
    const fresh: Owned = { kind: launch.kind, id: launch.id, ...(launch.workerId ? { workerId: launch.workerId } : {}), at: now, until };
    return owned.map((o, i) => (i === idx ? fresh : o));
  }
  const { readHead, ...existing } = owned[idx]!;
  const workerId = launch.workerId ?? existing.workerId;
  const next: Owned = {
    ...existing,
    ...(workerId ? { workerId } : {}),
    until: Math.max(existing.until, until),
    ...(readHead !== undefined && launch.id === readHead ? { readHead } : {}),
  };
  return owned.map((o, i) => (i === idx ? next : o));
}

export function noticeTurn(row: NoticeRow): TurnLike {
  return {
    jobId: row.id, status: row.status, turn: row.turn, supersededBy: row.supersededBy, followedBy: row.followedBy,
    startedAt: row.startedAt ?? row.endedAt, acceptancePending: row.acceptance?.pending === true,
    pendingMessages: row.pendingMessages,
  };
}

function coveredTurns(fromTurn: number | undefined, head: NoticeRow): { from: number; to: number } | null {
  const to = head.turn ?? 1;
  const from = fromTurn ?? to;
  if (from < to) return { from, to };
  return to > 1 ? { from: to, to } : null;
}

function rowDurationMs(row: NoticeRow): number | null {
  return row.startedAt != null && row.endedAt != null && row.endedAt >= row.startedAt
    ? row.endedAt - row.startedAt
    : null;
}

function coveredDurationMs(
  turns: readonly NoticeRow[],
  range: { from: number; to: number } | null,
): number | null {
  if (!range || range.from >= range.to) return null;
  let sum = 0;
  let count = 0;
  for (const t of turns) {
    const turn = t.turn ?? 1;
    if (turn < range.from || turn > range.to) continue;
    const span = rowDurationMs(t);
    if (span !== null) {
      sum += span;
      count += 1;
    }
  }
  return count > 1 ? sum : null;
}

export function due(
  owned: readonly Owned[],
  jobs: readonly NoticeRow[],
  runs: ReadonlyMap<string, RunRecord>,
  now: number,
): { notices: NoticeJob[]; owned: Owned[] } {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const byWorker = new Map<string, NoticeRow[]>();
  for (const j of jobs) {
    if (!j.workerId) continue;
    const list = byWorker.get(j.workerId);
    if (list) list.push(j);
    else byWorker.set(j.workerId, [j]);
  }
  const notices: NoticeJob[] = [];
  const seenNotices = new Set<string>();
  const pushNotice = (notice: NoticeJob) => {
    const key = `${notice.run ? 'run' : 'job'}:${notice.id}:${notice.kind}`;
    if (!seenNotices.has(key)) {
      seenNotices.add(key);
      notices.push(notice);
    }
  };
  const keep: Owned[] = [];
  const pushKeep = (entry: Owned) => {
    const existingIdx = keep.findIndex((k) =>
      k.kind === entry.kind && (k.id === entry.id || (k.kind === 'job' && entry.workerId !== undefined && k.workerId === entry.workerId)),
    );
    if (existingIdx >= 0) {
      const prev = keep[existingIdx]!;
      const sameId = prev.id === entry.id;
      const fromTurn = Math.min(prev.fromTurn ?? Infinity, entry.fromTurn ?? Infinity);
      keep[existingIdx] = {
        ...prev,
        id: sameId ? prev.id : entry.id,
        ...(entry.workerId ?? prev.workerId ? { workerId: entry.workerId ?? prev.workerId } : {}),
        ...(Number.isFinite(fromTurn) ? { fromTurn } : {}),
        until: Math.max(prev.until, entry.until),
        ...(sameId && (prev.saidAttention || entry.saidAttention) ? { saidAttention: true } : {}),
        ...(sameId && (prev.saidDead || entry.saidDead) ? { saidDead: true } : {}),
        ...(sameId && (prev.saidExited || entry.saidExited) ? { saidExited: true } : {}),
      };
    } else {
      keep.push(entry);
    }
  };
  const ownedRuns = new Set(owned.filter((o) => o.kind === 'run').map((o) => o.id));
  const ownedStageIds = new Set<string>();
  for (const runId of ownedRuns) {
    const run = runs.get(runId);
    if (run) for (const sid of stageJobIds(run)) ownedStageIds.add(sid);
  }
  const refreshed = (until: number) => Math.max(until, now + MAX_JOB_MS + 60 * 60_000);
  for (const o of owned) {
    if (o.kind === 'run') {
      const run = runs.get(o.id);
      const notice = run ? noticeFromRun(run) : null;
      if (run && notice) {
        pushNotice(notice);
        continue;
      }
      const said = new Set(o.saidStageAttention ?? []);
      for (const sid of run ? stageJobIds(run) : []) {
        const stage = byId.get(sid);
        if (stage && kindOf(stage.status) === 'attention' && !said.has(sid)) {
          pushNotice(noticeFromRadar(stage, 'attention', now));
          said.add(sid);
        }
      }
      if (now <= o.until) pushKeep({ ...o, saidStageAttention: [...said] });
      continue;
    }
    const own = byId.get(o.id);
    if (ownedStageIds.has(o.id) || (own?.pipeline != null && ownedRuns.has(own.pipeline))) continue;
    const workerId = o.workerId ?? own?.workerId;
    const fromTurn = o.fromTurn ?? own?.turn ?? (own ? 1 : undefined);
    let current: Owned = { ...o, ...(workerId ? { workerId } : {}), ...(fromTurn !== undefined ? { fromTurn } : {}) };
    if (!own) {
      if (now <= current.until) pushKeep(current);
      continue;
    }
    const turns = workerId ? byWorker.get(workerId) ?? [own] : [own];
    const head = pickHead(turns.map((t) => ({ ...noticeTurn(t), row: t })))?.row ?? own;
    if (head.id !== current.id) {
      const { saidAttention: _a, saidDead: _d, saidExited: _e, ...rest } = current;
      current = { ...rest, id: head.id, at: now, until: refreshed(current.until) };
    }
    const successor = head.supersededBy ?? head.followedBy;
    if (successor && isTerminal(head.status) && !byId.has(successor)) {
      const { saidAttention: _a, saidDead: _d, saidExited: _e, ...rest } = current;
      pushKeep({ ...rest, id: successor, at: now, until: refreshed(current.until) });
      continue;
    }
    const kind = kindOf(head.status);
    if (kind === 'attention') {
      const dead = head.liveness?.state === 'dead';
      if (!current.saidAttention || (dead && !current.saidDead)) {
        pushNotice(noticeFromRadar(head, kind, now));
        pushKeep({ ...current, saidAttention: true, ...(dead ? { saidDead: true } : {}) });
      } else {
        pushKeep(current);
      }
      continue;
    }
    if (kind === null) {
      if (now <= current.until) pushKeep(current);
      continue;
    }
    if (head.acceptance?.pending === true && kind !== 'finished' && !held(head, now)) {
      if (current.readHead !== head.id) pushNotice(withTurns(noticeFromRadar(head, kind, now), coveredTurns(current.fromTurn, head), turns));
      continue;
    }
    if (head.acceptance?.pending === true) {
      if (!held(head, now) && !current.saidExited && current.readHead !== head.id) {
        pushNotice(withTurns(noticeFromRadar(head, kind, now), coveredTurns(current.fromTurn, head), turns));
        current = { ...current, saidExited: true };
      }
      if (now <= current.until) pushKeep(current);
      continue;
    }
    if (!isWorkerIdle(noticeTurn(head))) {
      if (now <= current.until) pushKeep(current);
      continue;
    }
    if (current.readHead === head.id) continue;
    pushNotice(withTurns(noticeFromRadar(head, kind, now), coveredTurns(current.fromTurn, head), turns));
  }
  return { notices, owned: keep };
}

function withTurns(
  notice: NoticeJob,
  range: { from: number; to: number } | null,
  turns: readonly NoticeRow[],
): NoticeJob {
  const durationMs = coveredDurationMs(turns, range);
  return {
    ...notice,
    ...(range !== null ? { turns: range } : {}),
    ...(durationMs !== null ? { durationMs } : {}),
  };
}

function held(job: NoticeRow, now: number): boolean {
  if (job.acceptance?.pending !== true) return false;
  return job.endedAt == null || now - job.endedAt <= (job.acceptance.budgetMs ?? ACCEPTANCE_HOLD_MS);
}
