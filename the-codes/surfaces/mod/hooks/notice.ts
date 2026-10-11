/**
 * notice.ts: the words Agent Smith uses to say a job finished, and which jobs
 * this session may announce. Pure; no host API, no `node:` imports.
 *
 * One owner, two speakers. The mod announces through `$.ui.log` (the user's
 * line) and `$.prompt.submit` (Claude's turn, credited to the plugin). Without
 * the mod, the PostToolUse command hook (channel/src/watch-hook.ts) wakes Claude
 * with exit 2. Both render here, so the two paths cannot drift apart.
 *
 * Who announces is decided once per launch, at `classic.PostToolUse`: the mod
 * claims the job and does not call `next`, so the command hook never starts.
 * Nothing else announces a claimed job (see register.tsx, `claimLaunch`).
 */

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
  readonly acceptance?: { readonly pending?: boolean; readonly checks: readonly { readonly ok: boolean }[] };
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
  readonly checks?: { readonly passed: number; readonly total: number } | null;
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

/** `Ada (codex review)`, or `agy-staff job <id>` for a legacy job with no name. */
function who(job: NoticeJob): string {
  const identity = [job.provider, job.role].filter(Boolean).join(' ');
  if (job.name) return identity ? `${job.name} (${identity})` : job.name;
  return `${job.source === 'agy-staff' ? 'agy-staff job' : job.run ? 'pipeline' : 'job'} ${job.id}`;
}

/**
 * One line, the most decision-relevant fact first:
 *   ✓ Ada (codex review) succeeded in 43s · 2 files changed · checks 2/2
 *   ✗ Bo (agy implement) failed after 45m: timeout
 */
export function headline(job: NoticeJob): string {
  const d = durationWords(job.durationMs);
  const reason = job.reason ? `: ${compactExcerpt(job.reason, 160)}` : '';
  let state: string;
  switch (job.kind) {
    case 'finished': state = `succeeded${d ? ` in ${d}` : ''}`; break;
    case 'failed': state = `failed${d ? ` after ${d}` : ''}${job.run ? '' : reason}`; break;
    case 'cancelled': state = `cancelled${d ? ` after ${d}` : ''}`; break;
    case 'attention': state = `needs attention${d ? `: no progress for ${d}` : ''}`; break;
  }
  const facts: string[] = [];
  if (typeof job.changedFiles === 'number' && job.changedFiles > 0) {
    facts.push(`${job.changedFiles} file${job.changedFiles === 1 ? '' : 's'} changed`);
  }
  if (job.checks && job.checks.total > 0) {
    facts.push(`checks ${job.checks.passed}/${job.checks.total}${job.checks.passed < job.checks.total ? ' (rejected)' : ''}`);
  }
  return [`${GLYPH[job.kind]} ${who(job)} ${state}`, ...facts].join(' · ');
}

/** Lines shown to the user: one per job, capped, with a short excerpt where it helps. */
export const USER_LINES = 5;
export function userLines(jobs: readonly NoticeJob[]): string[] {
  const lines = jobs.slice(0, USER_LINES).map((job) => {
    const excerpt = job.kind === 'finished' && job.summary ? ` — ${compactExcerpt(job.summary, 90)}` : '';
    return `${headline(job)}${excerpt}`;
  });
  if (jobs.length > USER_LINES) lines.push(`+${jobs.length - USER_LINES} more · /forge`);
  return lines;
}

const CLAUDE_JOBS = 8;

/**
 * What Claude reads. Worker prose is labelled as a claim; runtime outcomes are
 * labelled as such. Ends with the one next step, naming the real tools.
 */
export function claudeText(jobs: readonly NoticeJob[]): string {
  if (jobs.length === 0) return '';
  const one = jobs.length === 1;
  const lines: string[] = [];
  if (!one) {
    const counts = new Map<string, number>();
    for (const job of jobs) counts.set(STATE[job.kind], (counts.get(STATE[job.kind]) ?? 0) + 1);
    lines.push(`Agent Smith · ${jobs.length} jobs: ${[...counts].map(([k, n]) => `${n} ${k}`).join(', ')}.`);
  }
  for (const job of jobs.slice(0, CLAUDE_JOBS)) {
    const budget = one ? 600 : 250;
    const outcome = job.run && job.reason ? ` Runtime outcome: ${compactExcerpt(job.reason, budget)}` : '';
    const summary = job.summary ? ` Worker summary (unverified claim): ${compactExcerpt(job.summary, budget)}` : '';
    lines.push(`${one ? 'Agent Smith · ' : ''}${headline(job)}. ${job.run ? 'Run' : 'Job'} ID ${job.id}.${outcome}${summary}`);
  }
  if (jobs.length > CLAUDE_JOBS) lines.push(`…and ${jobs.length - CLAUDE_JOBS} more; list_jobs shows them.`);
  const runs = jobs.some((j) => j.run);
  lines.push(`Judge the result with ${runs ? 'pipeline_status (runs) or status (jobs)' : 'status'} before acting; /forge shows it to the user.`);
  return lines.join('\n');
}

const STATE: Record<NoticeKind, string> = {
  finished: 'succeeded', failed: 'failed', cancelled: 'cancelled', attention: 'need attention',
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
    checks: checks.length > 0 ? { passed: checks.filter((c) => c.ok).length, total: checks.length } : null,
    reason: kind === 'failed' ? job.failureReason ?? null : null,
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
  readonly stageResults: Readonly<Record<string, { stage?: unknown; status?: unknown; acceptance?: unknown; jobId?: unknown } | null>>;
}

/** Pipeline outcome, stage by stage. Runtime-owned, so stated as fact. */
export function pipelineOutcome(run: RunRecord): string {
  const stages = Object.values(run.stageResults)
    .filter((s): s is NonNullable<typeof s> => s !== null && typeof s === 'object' && typeof s.stage === 'string')
    .map((s) => `${String(s.stage)}: execution ${String(s.status)}, acceptance ${typeof s.acceptance === 'string' ? s.acceptance : 'unchecked'}`);
  return `Pipeline ${run.status}; ${stages.join('; ')}.`;
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
