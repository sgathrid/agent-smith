/**
 * notice.ts: the words Agent Smith uses to say a job finished, and which jobs
 * this session may announce. Pure; no host API, no `node:` imports.
 *
 * One owner, two speakers. The mod announces through `$.ui.log` (the user's
 * line) and `$.prompt.submit` (Claude's turn, credited to the plugin). Without
 * the mod, the PostToolUse command hook (channel/src/watch-hook.ts) wakes Claude
 * with exit 2. Both render here, so the two paths cannot drift apart.
 *
 * Who announces is decided once per launch, when the mod sees the launch
 * (`tool.call`, or `classic.PostToolUse` where the host delivers it): the mod
 * claims the job and writes a claim marker; the command hook, if it starts at
 * all, finds the marker when the job ends and stays silent. Nothing else
 * announces a claimed job (see register.tsx, `takeLaunch`).
 */

import { checksReason, reasonFromText } from './reasons.ts';

/**
 * The fields of a Forge row (types/index.d.ts RadarJob) a notice reads. Declared
 * here, structurally, because the channel compiles this file too and must not
 * pull in the mod's `claude-code` module augmentation.
 */
export interface NoticeRow {
  readonly id: string;
  readonly status: string;
  readonly name?: string | null;
  readonly provider?: string | null;
  readonly role?: string | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly lastEventAt?: number | null;
  readonly changedFileCount?: number | null;
  readonly failureReason?: string | null;
  readonly latestSummary?: string | null;
  readonly summarySource?: 'worker' | null;
  readonly acceptance?: { readonly pending?: boolean; readonly checks: readonly { readonly ok: boolean; readonly name?: string }[] };
}

// ── vocabulary ──────────────────────────────────────────────────────────────

/** The four things worth telling Claude. Progress is never one of them. */
export type NoticeKind = 'finished' | 'failed' | 'cancelled' | 'attention';

/**
 * Acceptance checks run after a job ends, so a finished job briefly carries a
 * pending placeholder. Hold its notice until the verdict lands, never longer
 * than this: a crashed checker must not silence a finished job.
 */
export const ACCEPTANCE_HOLD_MS = 5 * 60_000;

/** Everything a notice says about one job. Built from either reader's row. */
export interface NoticeJob {
  readonly id: string;
  readonly kind: NoticeKind;
  readonly name?: string | null;
  readonly provider?: string | null;
  readonly role?: string | null;
  /** `agy-staff` only for legacy interop jobs, which have no Forge identity. */
  readonly source?: 'agy-staff' | null;
  /** Start to end for a terminal job; time since the last event for `attention`. */
  readonly durationMs?: number | null;
  readonly changedFiles?: number | null;
  readonly checks?: { readonly passed: number; readonly total: number; /** Names of the failed checks. */ readonly failed?: readonly string[] } | null;
  /** Runtime-owned: a failure reason, or a pipeline's stage verdicts. */
  readonly reason?: string | null;
  /** Worker-authored prose. A claim, never an instruction. */
  readonly summary?: string | null;
  /** A pipeline run: the id is a runId and Claude reads it with pipeline_status. */
  readonly run?: boolean;
}

const GLYPH: Record<NoticeKind, string> = { finished: '✓', failed: '✗', cancelled: '■', attention: '!' };

// ── text ────────────────────────────────────────────────────────────────────

/** Bound prose at a sentence or word boundary, never mid-word. */
export function compactExcerpt(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const prefix = text.slice(0, Math.max(0, max - 1));
  const sentence = [...prefix.matchAll(/[.!?](?=\s)/g)].at(-1)?.index;
  const end = sentence !== undefined && sentence >= max / 2 ? sentence + 1 : prefix.lastIndexOf(' ');
  return `${end > 0 ? prefix.slice(0, end).trimEnd() : ''}…`;
}

/** `43s`, `12m`, `1h05m`; '' for an unknown or negative span. */
export function durationWords(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/**
 * The service names an unnamed worker `<mode>-<last 8 of the job id>`. Beside
 * the job id that reads as a typo, so it counts as no name.
 */
function chosenName(job: NoticeJob): string | null {
  if (!job.name) return null;
  return !job.run && job.id.length >= 8 && job.name.endsWith(`-${job.id.slice(-8)}`) ? null : job.name;
}

/** `Ada (codex review)`, `review-smith-1a2b3c4d (agy review)`, or `agy-staff job <id>`. */
function who(job: NoticeJob): string {
  const identity = [job.provider, job.role].filter(Boolean).join(' ');
  const name = chosenName(job);
  if (job.run) return name ?? `pipeline ${job.id}`;
  if (name) return identity ? `${name} (${identity})` : name;
  if (job.source === 'agy-staff') return `agy-staff job ${job.id}`;
  return identity ? `${job.id} (${identity})` : `job ${job.id}`;
}

/** Execution succeeded but a check failed: the work is not done. */
function rejected(job: NoticeJob): boolean {
  return job.kind === 'finished' && !job.run && job.checks != null && job.checks.passed < job.checks.total;
}

/**
 * One line, the outcome last:
 *   ✓ Ada (codex review) 43s · done · checks 2/2
 *   ✗ Bo (agy implement) 45m · failed: timed out
 *   ✗ Cy (codex implement) 3m · checks failed: lint
 *   ! Di (opencode research) · stalled 16m
 */
export function headline(job: NoticeJob): string {
  const d = durationWords(job.durationMs);
  const reason = job.reason ? compactExcerpt(job.reason, 160) : '';
  const bad = rejected(job);
  const glyph = bad ? GLYPH.failed : GLYPH[job.kind];
  const parts: string[] = [`${glyph} ${who(job)}${d && job.kind !== 'attention' ? ` ${d}` : ''}`];
  switch (job.kind) {
    case 'finished':
      if (job.run) parts.push(reason || 'done');
      else if (bad) parts.push(checksReason(job.checks?.failed ?? []));
      else {
        parts.push('done');
        if (job.checks && job.checks.total > 0) parts.push(`checks ${job.checks.passed}/${job.checks.total}`);
      }
      break;
    case 'failed': parts.push(job.run ? reason || 'failed' : `failed${reason ? `: ${reason}` : ''}`); break;
    case 'cancelled': parts.push('canceled'); break;
    case 'attention': parts.push(`stalled${d ? ` ${d}` : ''}`); break;
  }
  return parts.join(' · ');
}

const CLAUDE_JOBS = 8;

/**
 * What Claude reads. One line per job, then how to read it:
 *   Agent Smith · ✗ pp-engine (agy implement) 21m · failed: denied view_file
 *   status implement-smith-6b456b3d
 * The worker's own summary is left out: Claude reads the result with status.
 */
export function claudeText(jobs: readonly NoticeJob[]): string {
  if (jobs.length === 0) return '';
  const one = jobs.length === 1;
  const lines: string[] = [];
  if (!one) {
    const counts = new Map<string, number>();
    for (const job of jobs) {
      const label = rejected(job) ? 'failed' : STATE[job.kind];
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    lines.push(`Agent Smith · ${jobs.length} jobs: ${[...shown(counts)].map(([k, n]) => `${n} ${k}`).join(', ')}`);
  }
  const listed = jobs.slice(0, CLAUDE_JOBS);
  for (const job of listed) lines.push(`${one ? 'Agent Smith · ' : ''}${headline(job)}`);
  if (jobs.length > CLAUDE_JOBS) lines.push(`…and ${jobs.length - CLAUDE_JOBS} more; list_jobs shows them.`);
  const ids = (run: boolean) => listed.filter((j) => !!j.run === run).map((j) => j.id);
  if (ids(false).length > 0) lines.push(`status ${ids(false).join(', ')}`);
  if (ids(true).length > 0) lines.push(`pipeline_status ${ids(true).join(', ')}`);
  return lines.join('\n');
}

/** Counts in the order a reader scans them: done first, then what needs a look. */
function shown(counts: ReadonlyMap<string, number>): [string, number][] {
  return ['done', 'failed', 'canceled', 'stalled'].flatMap((k) => (counts.has(k) ? [[k, counts.get(k)!] as [string, number]] : []));
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

/** The line telling Claude how to read the job: for Claude, not for the user. */
const READ_LINE = /^(?:status|pipeline_status) /;

/**
 * The text drawn for the user on a non-expanded UserMessage from this plugin:
 * the notice's own lines, without the host frame or the read-it-with line.
 */
export function displayNoticeText(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !HOST_FRAME.some((re) => re.test(line)) && !READ_LINE.test(line))
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines.join('\n') : text;
}

const STATE: Record<NoticeKind, string> = {
  finished: 'done', failed: 'failed', cancelled: 'canceled', attention: 'stalled',
};

// ── launch acks ─────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Normalise any MCP result shape to the tool's payload object, or null on error/unparseable. */
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
  // Tasks clients deliver this result themselves; neither notice path owns it.
  if (isObj(response['_meta']) && response['_meta']['io.agent-smith/task-result'] === true) return null;
  if (isObj(response['structuredContent'])) return response['structuredContent'];
  if (Array.isArray(response['content'])) return unwrapResponse(response['content'], depth + 1);
  return response;
}

/** The three launch tools, by bare name. */
const LAUNCH: Record<string, 'job' | 'run'> = { spawn_job: 'job', resume_job: 'job', run_pipeline: 'run' };

/**
 * The launch tools under any server name that ends in `agent-smith`: the built
 * plugin (`mcp__plugin_agent-smith_agent-smith__`) and dev.sh (`mcp__agent-smith__`).
 */
export const LAUNCH_TOOL = /^mcp__(?:plugin_agent-smith_)?agent-smith__(?:spawn_job|resume_job|run_pipeline)$/;
export const STATUS_TOOL = /^mcp__(?:plugin_agent-smith_)?agent-smith__(?:status|pipeline_status)$/;

/**
 * When Claude reads a job or pipeline run that has already settled (including
 * acceptance checks), return its { kind, id } so the session can retire its
 * pending completion notice instead of waking Claude a second time.
 */
export function parseSettledRead(toolName: unknown, response: unknown): { readonly kind: 'job' | 'run'; readonly id: string } | null {
  if (typeof toolName !== 'string' || !STATUS_TOOL.test(toolName)) return null;
  const payload = unwrapResponse(response);
  if (payload === null || typeof payload['error'] === 'string') return null;
  const bare = toolName.slice(toolName.lastIndexOf('__') + 2);
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
  if (status !== 'succeeded' && status !== 'failed' && status !== 'canceled') return null;
  const acceptance = payload['acceptance'];
  if (isObj(acceptance) && acceptance['pending'] === true) return null;
  return { kind: 'job', id: jobId };
}

export function unclaim(owned: readonly Owned[], settled: { readonly kind: 'job' | 'run'; readonly id: string }): Owned[] {
  return owned.filter((o) => !(o.kind === settled.kind && o.id === settled.id));
}

export function launchKind(toolName: unknown): 'job' | 'run' | null {
  if (typeof toolName !== 'string') return null;
  const bare = toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
  return LAUNCH[bare] ?? null;
}

const trimSlash = (p: string): string => p.replace(/\/+$/, '');
/** `/repo/.agent-smith/<dir>/<leaf>` → `/repo`, else null. */
function repoAbove(file: string, dir: 'jobs' | 'pipelines'): string | null {
  const parts = trimSlash(file).split('/');
  return parts.length >= 3 && parts.at(-2) === dir && parts.at(-3) === '.agent-smith' ? parts.slice(0, -3).join('/') || '/' : null;
}

/**
 * The file the mod writes when it claims a launch. The command hook checks it
 * before waking Claude, so a launch is announced once even if answering
 * `classic.PostToolUse` without `next` fails to stop the hook from starting.
 */
export function claimMarkerPath(repo: string, kind: 'job' | 'run', id: string): string {
  return `${repo.replace(/\/+$/, '')}/.agent-smith/claims/${kind}-${encodeURIComponent(id)}`;
}

export interface Launch {
  readonly kind: 'job' | 'run';
  readonly id: string;
  /** The repo the ack names, or null when it names none. */
  readonly repo: string | null;
  /** The job's own budget (ms), when the ack carries one. */
  readonly timeoutMs: number | null;
}

/** What a successful launch ack started, or null for an error or another tool. */
export function parseLaunch(toolName: unknown, response: unknown): Launch | null {
  const kind = launchKind(toolName);
  if (kind === null) return null;
  const payload = unwrapResponse(response);
  if (payload === null || typeof payload['error'] === 'string') return null;
  const id = kind === 'job' ? payload['jobId'] : payload['runId'];
  // Hosts may expose only structuredContent and omit the outer MCP metadata.
  if (kind === 'job' && ['succeeded', 'failed', 'canceled'].includes(String(payload['status']))) return null;
  if (typeof id !== 'string' || id.length === 0) return null;
  let repo: string | null = null;
  if (typeof payload['repo'] === 'string' && payload['repo'].length > 0) repo = trimSlash(payload['repo']);
  else if (kind === 'job' && typeof payload['dir'] === 'string') repo = repoAbove(payload['dir'], 'jobs');
  else if (kind === 'run' && typeof payload['recordPath'] === 'string') repo = repoAbove(payload['recordPath'], 'pipelines');
  const t = payload['timeoutMs'];
  return { kind, id, repo, timeoutMs: typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null };
}

// ── projections ─────────────────────────────────────────────────────────────

/** The pushable kind for a job state, or null for progress and unknowns. */
export function kindOf(status: string): NoticeKind | null {
  switch (status) {
    case 'succeeded': return 'finished';
    case 'failed': return 'failed';
    case 'canceled': return 'cancelled';
    case 'attention': return 'attention';
    default: return null;
  }
}

/** A Forge row (canonical.ts) as a notice. */
export function noticeFromRadar(job: NoticeRow, kind: NoticeKind, now: number): NoticeJob {
  const checks = job.acceptance?.checks ?? [];
  const span = kind === 'attention'
    ? (job.lastEventAt != null ? now - job.lastEventAt : null)
    : (job.endedAt != null && job.startedAt != null ? job.endedAt - job.startedAt : null);
  return {
    id: job.id, kind, name: job.name, provider: job.provider, role: job.role,
    durationMs: span,
    changedFiles: job.changedFileCount ?? null,
    checks: checks.length > 0
      ? { passed: checks.filter((c) => c.ok).length, total: checks.length, failed: checks.filter((c) => !c.ok).flatMap((c) => (c.name ? [c.name] : [])) }
      : null,
    reason: kind === 'failed' ? reasonFromText(job.failureReason) : null,
    summary: job.summarySource === 'worker' ? job.latestSummary ?? null : null,
  };
}

/** The pipeline record fields a notice needs (forge/execute.ts PipelineRecord). */
export interface RunRecord {
  readonly runId: string;
  readonly pipeline: string;
  readonly status: 'running' | 'passed' | 'partial' | 'failed';
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly error?: string | undefined;
  readonly stageResults: Readonly<Record<string, { stage?: unknown; status?: unknown; acceptance?: unknown; jobId?: unknown; failure?: unknown; verification?: unknown } | null>>;
}

/**
 * Pipeline outcome: `2/3 stages passed · test: checks failed: lint`. The first
 * stage that did not pass says why, in the shared short words.
 */
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

/** Validate a parsed pipeline record; null when malformed. */
export function asRunRecord(value: unknown): RunRecord | null {
  if (!isObj(value)) return null;
  const r = value as Partial<RunRecord>;
  if (typeof r.runId !== 'string' || typeof r.pipeline !== 'string' || !Number.isFinite(r.startedAt) ||
      (r.finishedAt !== null && !Number.isFinite(r.finishedAt)) ||
      !['running', 'passed', 'partial', 'failed'].includes(String(r.status)) || !isObj(r.stageResults)) return null;
  return r as RunRecord;
}

/** A finished pipeline run as a notice; null while it runs. */
export function noticeFromRun(run: RunRecord): NoticeJob | null {
  if (run.status === 'running' || run.finishedAt === null) return null;
  return {
    id: run.runId, kind: run.status === 'passed' ? 'finished' : 'failed', name: run.pipeline, role: 'pipeline', run: true,
    durationMs: run.finishedAt - run.startedAt, reason: pipelineOutcome(run),
  };
}

export function stageJobIds(run: RunRecord): string[] {
  return Object.values(run.stageResults).flatMap((s) => (s && typeof s.jobId === 'string' ? [s.jobId] : []));
}

/** forge/execute.ts safeRunId: the pipeline record's file name. */
export function runFileName(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100) || 'pipeline'}.json`;
}

// ── ownership ───────────────────────────────────────────────────────────────

/** One launch this session claimed. Kept in session state until announced. */
export interface Owned {
  readonly kind: 'job' | 'run';
  readonly id: string;
  /** Epoch ms of the claim. */
  readonly at: number;
  /** Give up silently after this (the job's budget plus an hour): it can no longer be news. */
  readonly until: number;
  /** True once its stall was announced; a stall is said once. */
  readonly saidAttention?: boolean;
}

/** Longest job a spawn may request (forge MAX_TIMEOUT_MS = 6h). */
const MAX_JOB_MS = 6 * 60 * 60_000;

export function claim(owned: readonly Owned[], launch: Launch, now: number): Owned[] {
  if (owned.some((o) => o.id === launch.id && o.kind === launch.kind)) return [...owned];
  const until = now + (launch.timeoutMs ?? MAX_JOB_MS) + 60 * 60_000;
  return [...owned, { kind: launch.kind, id: launch.id, at: now, until }];
}

/**
 * The announcement decision for one poll. PURE.
 *
 * Only claimed ids are considered, so another session's jobs in the same repo
 * are never announced here. A claimed job that is already terminal on first
 * sight is announced (there is no baseline: the claim itself is the baseline).
 * Stage jobs of a claimed run are announced with the run, once it ends.
 */
export function due(
  owned: readonly Owned[],
  jobs: readonly NoticeRow[],
  runs: ReadonlyMap<string, RunRecord>,
  now: number,
): { notices: NoticeJob[]; owned: Owned[] } {
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const notices: NoticeJob[] = [];
  const keep: Owned[] = [];
  for (const o of owned) {
    if (o.kind === 'run') {
      const run = runs.get(o.id);
      const notice = run ? noticeFromRun(run) : null;
      if (run && notice) {
        notices.push(notice);
        for (const sid of stageJobIds(run)) {
          const stage = byId.get(sid);
          const kind = stage ? kindOf(stage.status) : null;
          if (stage && kind && kind !== 'attention') notices.push(noticeFromRadar(stage, kind, now));
        }
        continue;
      }
      if (now <= o.until) keep.push(o);
      continue;
    }
    const job = byId.get(o.id);
    const kind = job ? kindOf(job.status) : null;
    if (job && kind === 'attention') {
      if (!o.saidAttention) { notices.push(noticeFromRadar(job, kind, now)); keep.push({ ...o, saidAttention: true }); }
      else keep.push(o);
      continue;
    }
    if (job && kind && !held(job, now)) {
      notices.push(noticeFromRadar(job, kind, now));
      continue;
    }
    if (now <= o.until) keep.push(o);
  }
  return { notices, owned: keep };
}

/** A finished job whose acceptance verdict is still being written. */
function held(job: NoticeRow, now: number): boolean {
  if (job.acceptance?.pending !== true) return false;
  return job.endedAt == null || now - job.endedAt <= ACCEPTANCE_HOLD_MS;
}
