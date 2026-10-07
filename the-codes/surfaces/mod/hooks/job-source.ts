/**
 * job-source.ts — the pane's I/O layer: agy-staff jobs on disk → RadarJob rows.
 *
 * This is the ONLY file in the mod that touches the filesystem, and the only one
 * that knows agy-staff exists. Everything below `projectRadarJob` is pure and
 * lives in format.ts.
 *
 * COUPLING NOTE (read before changing anything here):
 *
 * We import, we do not modify. Three imports, all from harness/:
 *   - AgyStaffReader            reads `<repo>/.agy-staff/jobs/`, tolerantly
 *   - normalize                 applies the "empty output + warnings ⇒ failed" rule
 *   - stripSystemNotifications  de-pollutes result.md (hazard C)
 *
 * harness/ is a sibling package, not a dependency of the mod. It is pure Node
 * builtins (`node:path`, `node:fs/promises` via safe-fs), no third-party imports,
 * so importing it adds nothing to the mod's dependency count — the mod stays
 * dependency-free, which is a hard requirement. We import via relative path
 * because the mod ships as a standalone plugin directory and cannot resolve a
 * bare specifier for it.
 *
 * If harness/ ever moves, this file is the only one that needs updating. If a
 * second worker (Codex, OpenCode) is ever added, this file grows a branch per
 * provider and NOTHING ELSE CHANGES — the formatters and the render code only
 * ever see RadarJob.
 *
 * WHY WE DO NOT GO THROUGH core/store.ts:
 * the store is a SQLite projection built for history and querying. The pane needs
 * a live read of files another process is actively rewriting, and the reader
 * already survives that (see safe-fs.ts). Going through the store would add a
 * write path the mod has no business owning — surfaces are read-only projections
 * (docs/ARCHITECTURE.md). The dedupe logic in the channel is where core/store
 * will eventually take over.
 */

import path from 'node:path';

import { AgyStaffReader, stripSystemNotifications } from '../../../harness/agy-staff.ts';
import { normalize } from '../../../harness/normalize.ts';
import { existsSafe, readTextSafe, statSafe } from '../../../harness/safe-fs.ts';
import type { ObservedJob } from '../../../harness/types.ts';
import type { RadarJob, RadarStatus, ToolEntry } from '../types/index.d.ts';
import { describeActivity, describeTool } from './format.ts';
import { STALL_GRACE_MS } from './stale.ts';

/** One reader, reused. Constructing a reader is cheap but the map is not per-call. */
const READER = new AgyStaffReader();

/** agy-staff's jobs directory, relative to a repo root. */
const JOBS_SUFFIX = ['.agy-staff', 'jobs'];

/** Return the agy-staff jobs dir for a repo root, or null if it does not exist. */
async function jobsDir(cwd: string): Promise<string | null> {
  const dir = path.join(cwd, ...JOBS_SUFFIX);
  return (await existsSafe(dir)) ? dir : null;
}

/**
 * List every job agy-staff knows about, newest-relevant first.
 *
 * NEVER THROWS. A missing jobs directory (most repos have never run agy-staff)
 * is the common case, not an error — it yields []. That is what makes the pane's
 * empty state reachable without an error path.
 */
export async function listJobs(cwd: string): Promise<string[]> {
  const dir = await jobsDir(cwd);
  if (dir === null) return [];
  try {
    return await READER.discover(cwd);
  } catch {
    // A reader that throws would take the whole pane down. Per-provider fault
    // isolation is harness/registry.ts's job for the store path; here we are the
    // only caller, so we do it ourselves.
    return [];
  }
}

/**
 * One job, fully projected. Null only when the job genuinely does not exist.
 *
 * A FINISHED job still returns a row: agy-staff deletes progress.json and
 * events.jsonl on a warning-free success (hazard A), and this function anchors on
 * the always-written `.result.md.status.json` instead. A vanished progress.json
 * means FINISHED, never "missing".
 */
export async function readJob(cwd: string, jobId: string): Promise<RadarJob | null> {
  const dir = await jobsDir(cwd);
  if (dir === null) return null;

  let observed: ObservedJob;
  try {
    const raw = await READER.read(cwd, jobId);
    if (raw === null) return null;
    observed = normalize(raw);
  } catch {
    return null;
  }

  const spec = await readSpecSummary(dir, jobId);
  const events = await readEvents(dir, jobId);
  return projectRadarJob(observed, spec, events);
}

// ── the projection ──────────────────────────────────────────────────────────

/** The bits of spec.json the pane shows. Read separately: the payload omits the task. */
interface SpecSummary {
  /** First line of prompt_source.task — the task title, never the whole prompt. */
  task: string;
  /** Epoch ms of the worker-started line, else the spec.json mtime. Null if neither. */
  startedAt: number | null;
}

/**
 * Read the task title and the best available start time.
 *
 * START TIME IS THE INTERESTING PART. agy-staff records no start timestamp on
 * any file we can read, and harness/normalize.ts deliberately leaves
 * ObservedJob.startedAt null rather than inventing one. But .log opens with:
 *   [agy-staff] dispatch registered <job> at 2026-10-03T00:47:07.610Z
 *   [agy-staff] worker started <job> pid=NNNNN at 2026-10-03T00:47:07.610Z
 * Both lines are present in all 20 real jobs in the corpus. `worker started` is
 * the true start; spec.json's mtime is within 2 s of it in the real corpus and is
 * the fallback when the log line is missing.
 *
 * We do NOT use the log's `duration=` field: it disagrees with wall clock on real
 * jobs (implement-mus165dn: duration=2652 s but 7201 s between dispatch and
 * finished_at, because the job hit a hard execution limit and the response was
 * delivered late). Elapsed time is a wall-clock question; duration= is the
 * worker's own accounting and they are not the same number.
 */
async function readSpecSummary(dir: string, jobId: string): Promise<SpecSummary> {
  const specText = await readTextSafe(path.join(dir, `${jobId}.spec.json`));
  let task = '';
  if (specText !== null) {
    try {
      const spec = JSON.parse(specText) as { prompt_source?: { task?: string } };
      const t = spec.prompt_source?.task;
      if (typeof t === 'string') {
        // First non-empty line. The real tasks open with `# Task: <title>` and
        // run to 60+ lines of body; the body is detail-pane content at most, and
        // the pane has no room for it in a list row.
        task = (t.split('\n').find((l) => l.trim().length > 0) ?? '').replace(/^#\s*/, '');
      }
    } catch {
      task = '';
    }
  }

  const log = await readTextSafe(path.join(dir, `${jobId}.log`));
  let startedAt: number | null = null;
  if (log !== null) {
    const m = /worker started \S+ pid=\d+ at (\S+)/.exec(log);
    if (m?.[1]) startedAt = toEpoch(m[1]);
  }

  // Fallback: the spec.json mtime. agy-staff writes spec.json at dispatch, so its
  // mtime is within ~2 s of the worker-started line across the real corpus, and it
  // survives the case where the .log was never written (a job killed before it
  // could log). A 2-second-wrong start is a far better answer than no start.
  const specPath = path.join(dir, `${jobId}.spec.json`);
  const st = await statSafe(specPath);
  if (startedAt === null && st !== null) startedAt = Math.round(st.mtimeMs);

  return { task, startedAt };
}

/** ISO-8601 → epoch ms, or null. NaN never becomes a number here. */
function toEpoch(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Parsed tool entries + a tool count, from events.jsonl.
 *
 * events.jsonl is 500 KB+ on a long job (1136 lines for implement-mus165dn), so we
 * read it as TEXT and scan lines rather than JSON.parse-ing the whole document.
 * We read the TAIL: the pane shows the last N tool calls, and the tool COUNT is
 * derived from the file's own `step_index` values rather than from counting lines.
 *
 * COUNTING: each tool step emits two records (ACTIVE then DONE) at the same
 * step_index, so counting records would double the number. Real check:
 * implement-muroviej has 338 tool records / 169 distinct step_index, and max
 * step_index 345. We take the highest step_index that carried a tool call, which
 * is the step ordinal — a real, monotonically increasing quantity, not a guess.
 *
 * When events.jsonl is absent (hazard A) we return null for the count. The pane
 * renders a blank cell, never `0`.
 */
async function readEvents(
  dir: string,
  jobId: string,
): Promise<{ count: number | null; tail: ToolEntry[] }> {
  const text = await readEventsTail(dir, jobId);
  if (text === null) return { count: null, tail: [] };

  const tail: ToolEntry[] = [];
  let maxStep = -1;

  for (const line of text.split('\n')) {
    if (line.length < 2) continue;
    let obj: { step_update?: Record<string, unknown> };
    try {
      obj = JSON.parse(line) as typeof obj;
    } catch {
      continue; // the last line of a live file is routinely half-written
    }
    const su = obj.step_update;
    if (!su || su['step_type'] !== 'tool') continue;

    const step = typeof su['step_index'] === 'number' ? su['step_index'] : -1;
    if (step > maxStep) maxStep = step;

    const tool = typeof su['tool_name'] === 'string' ? su['tool_name'] : '';
    const info = (su['tool_info'] ?? {}) as Record<string, unknown>;
    const params = (info['parameters'] ?? {}) as Record<string, unknown>;
    const output = typeof info['output'] === 'string' ? info['output'] : '';
    const state = typeof su['state'] === 'string' ? su['state'] : '';

    // Keep only DONE records for the visible history: an ACTIVE record and its
    // DONE twin have identical tool+params, and rendering both reads as the tool
    // having run twice.
    if (state !== 'DONE') continue;

    tail.push({
      at: null, // events.jsonl carries no per-event timestamp; see note below
      tool,
      label: describeTool(tool, params),
      output: output.slice(0, 400),
      state,
    });
    if (tail.length > 40) tail.shift();
  }

  // maxStep is a step ordinal, so +1 makes it a count of steps. The last step may
  // be an agent_response rather than a tool, so this is an upper bound on tools
  // and a lower bound on total work — which is the honest framing for a column
  // labelled "tools" only in the common case where the final step was a tool.
  return { count: maxStep >= 0 ? maxStep + 1 : null, tail: tail.slice(-20) };
}

/** How many bytes of events.jsonl to read. 256 KB covers the longest real job. */
const EVENTS_TAIL_BYTES = 256 * 1024;

/**
 * Read the tail of events.jsonl.
 *
 * WHY READ THE TAIL AND NOT THE WHOLE FILE: the real corpus has 516 KB files, and
 * we re-poll every 3 s while the pane is open. Reading 500 KB × N jobs × 20 Hz is
 * the difference between a pane that is free and one that heats a laptop. The
 * oldest tool calls are only ever shown as a count, which maxStep gives us from
 * whatever slice we read.
 */
async function readEventsTail(dir: string, jobId: string): Promise<string | null> {
  const full = path.join(dir, `${jobId}.events.jsonl`);
  if (!(await existsSafe(full))) return null;

  const { open } = await import('node:fs/promises');
  let handle;
  try {
    handle = await open(full, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - EVENTS_TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    await handle.read(buf, 0, len, start);
    // The first line of a tail read is almost certainly cut mid-record; dropping
    // everything before the first newline makes the parse loop's life trivial.
    const body = buf.toString('utf8');
    const nl = body.indexOf('\n');
    return nl === -1 ? '' : body.slice(nl + 1);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Observed job + spec + events → the pane's row.
 *
 * PURE. Exported and separately testable, and deliberately the single mapping
 * point: harness owns status truth, this owns presentation truth, and neither
 * leaks into the other.
 *
 * THE THREE HAZARDS, all handled here rather than at each call site:
 *   A. Terminal state is taken from ObservedJob.status, which normalize() derived
 *      from the always-written status.json. A missing progress.json cannot make a
 *      finished job look running, because we never consult progress for status.
 *   B. Cancellation arrives as ObservedJob.status === 'canceled' — normalize()
 *      already folded the .spec.json.cancel marker in, ahead of status.json.
 *   C. The report comes from ObservedJob.output, which the reader de-polluted with
 *      stripSystemNotifications(). We re-run strip defensively in the debug path
 *      only; the reader is the authority.
 */
export function projectRadarJob(
  observed: ObservedJob,
  spec: SpecSummary,
  events: { count: number | null; tail: ToolEntry[] },
  now: number = Date.now(),
): RadarJob {
  // spec.startedAt is epoch ms (from the log or the spec mtime). ObservedJob's own
  // startedAt is an ISO STRING and is null for agy-staff anyway (normalize.ts
  // refuses to invent one), so it is only a parsed fallback.
  const startedAt = spec.startedAt ?? toEpoch(observed.startedAt ?? '');
  const endedAt = observed.finishedAt === null ? null : toEpoch(observed.finishedAt);

  // How long the job has been quiet. `updatedAt` is lastEventAt when progress
  // exists and finishedAt otherwise — both are "the last moment we saw this worker
  // do something". A missing timestamp yields Infinity, which escalates to
  // `attention`: we do not know that it is alive, and "unknown" must never be
  // drawn as healthy (the same asymmetry core/liveness.ts documents).
  const silenceMs =
    observed.updatedAt === null ? Number.POSITIVE_INFINITY : now - (toEpoch(observed.updatedAt) ?? Number.NEGATIVE_INFINITY);

  return {
    id: observed.jobId,
    status: toRadarStatus(observed, silenceMs),
    // agy-staff's finished_at is the only terminal time we get. If it is missing
    // we leave the elapsed cell blank rather than showing a running clock forever.
    startedAt,
    endedAt,
    toolCount: events.count,
    activity: activityPhrase(observed),
    task: spec.task,
    warnings: observed.warnings.map((w) => ({ code: w.code, message: w.message })),
    report: observed.output,
    reasoning: reasoningText(observed),
    raw: observed.raw,
  };
}

/**
 * ObservedStatus → RadarStatus, plus the pane's own `attention` escalation.
 *
 * `attention` is derived here rather than in normalize() because it is a
 * PRESENTATION decision about urgency, not a lifecycle fact: the job is still
 * running, it has just gone quiet long enough that a human should look. We use
 * core/liveness.ts's default grace (15 min) so the band and the channel agree on
 * when "stalled" begins. Only `running` can escalate; a terminal job is never
 * "needing attention", it is simply over.
 */
export function toRadarStatus(observed: ObservedJob, silenceMs = 0): RadarStatus {
  if (observed.status !== 'running') return observed.status;
  return silenceMs > STALL_GRACE_MS ? 'attention' : 'running';
}

/**
 * The terse activity phrase, from the most recent activity record.
 *
 * progress.json holds at most 5 recent activities and we take the last, which is
 * the most recent. We prefer the events tail when it has an entry, because
 * progress.json's record can lag the events stream by one step.
 */
function activityPhrase(observed: ObservedJob): string {
  const activities = observed.raw['recent_activities'];
  if (Array.isArray(activities) && activities.length > 0) {
    const last = activities[activities.length - 1] as Record<string, unknown> | undefined;
    if (last) {
      const tool = typeof last['tool'] === 'string' ? last['tool'] : null;
      const preview = typeof last['input_preview'] === 'string' ? last['input_preview'] : null;
      if (tool) return describeActivity(tool, preview);
    }
  }
  return '';
}

/** The current reasoning text, or null. progress.json's latest_text. */
function reasoningText(observed: ObservedJob): string | null {
  const lt = observed.raw['latest_text'];
  if (typeof lt !== 'object' || lt === null) return null;
  const text = (lt as Record<string, unknown>)['text'];
  return typeof text === 'string' && text.trim().length > 0 ? text : null;
}

/**
 * Strip notification blocks from arbitrary text.
 *
 * Re-exported so the pane never has to import harness directly — job-source.ts
 * is the mod's entire coupling surface to the rest of the repo, and keeping it
 * that way is what makes the coupling auditable in one grep.
 */
export { stripSystemNotifications };

/**
 * The tool history for one job, newest last. Empty when events.jsonl is gone.
 * Used by the pane's detail view; the list view never calls it.
 */
export async function readToolHistory(cwd: string, jobId: string): Promise<ToolEntry[]> {
  const dir = await jobsDir(cwd);
  if (dir === null) return [];
  const { tail } = await readEvents(dir, jobId);
  return tail;
}

/**
 * Read every job. Sequential on purpose: agy-staff is rewriting these files right
 * now, and 20 parallel readers on one directory is the fastest way to make every
 * read hit a half-written file. The pane re-polls at 3 s; serial reads of 20
 * small files cost single-digit milliseconds.
 */
export async function readAllJobs(cwd: string): Promise<RadarJob[]> {
  const ids = await listJobs(cwd);
  const out: RadarJob[] = [];
  for (const id of ids) {
    const job = await readJob(cwd, id);
    if (job !== null) out.push(job);
  }
  return out;
}

/**
 * Split jobs into the order the pane draws them: running first (newest activity
 * first), then attention, then terminal jobs newest-first.
 *
 * PURE, and therefore testable without a filesystem — the ordering is where a
 * job list usually goes wrong and it deserves a test that needs no fixtures.
 */
export function sortJobs(jobs: readonly RadarJob[]): RadarJob[] {
  const rank = (s: RadarStatus): number =>
    s === 'running' ? 0 : s === 'attention' ? 1 : 2;
  return [...jobs].sort((a, b) => {
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    const at = a.endedAt ?? a.startedAt ?? 0;
    const bt = b.endedAt ?? b.startedAt ?? 0;
    return bt - at; // newest first in every group
  });
}

/** The header counts. Finished includes canceled, failed and unknown. */
export function countSummary(jobs: readonly RadarJob[]): { running: number; finished: number } {
  const running = jobs.filter((j) => j.status === 'running' || j.status === 'attention').length;
  return { running, finished: jobs.length - running };
}