/**
 * mirror.ts — the compat projection, and the only reason it is allowed to exist.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The acceptance criterion for this whole change is:
 *
 *     a job spawned through our MCP tool appears in the mod's pane,
 *     with no change to the rendering code.
 *
 * The mod's reader (surfaces/mod/hooks/jobs.ts) is a STANDALONE PLUGIN. It
 * cannot import anything outside its own folder — the loader refuses it at load
 * time, verified against 2.1.292:
 *
 *     "cannot import '../../../harness/agy-staff.ts': it is outside the
 *      plugin's folder"
 *
 * And another engineer is redesigning that UI right now, so it is off limits.
 * Which leaves exactly one way to put a job in the pane without touching the
 * pane: write the job somewhere the pane already looks.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ANSWER: WE WRITE OUR OWN STATE, AND PROJECT IT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `.agent-smith/jobs/<jobId>/` is the truth (see format.ts). This module
 * renders that truth into agy-staff's file shapes under `.agy-staff/jobs/`, so
 * an unmodified pane finds it. Three properties make this a projection rather
 * than a fork:
 *
 *   1. IT IS ONE-WAY AND DERIVED. Nothing reads the mirror for a verdict. There
 *      is exactly one reader per job id in this system — forge's own — and it
 *      reads `.agent-smith`. The mirror exists for exactly one consumer: a reader
 *      we are not allowed to change.
 *   2. IT IS NAMESPACED. Our ids carry the `-smith-` marker and our spec.json
 *      carries a marker field, and the writer REFUSES to write over a file that
 *      is not ours (see MirrorWriter.claim). We never delete, never truncate and
 *      never read an agy-staff job. The 20 real jobs in renyi/.agy-staff/jobs
 *      are test data, not territory.
 *   3. IT IS SMALL. Seven files, all derivable from job.json + progress.json +
 *      result.md. If forge/format.ts is redesigned, this file is thrown away and
 *      rewritten in an afternoon; no history depends on it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE PANE ACTUALLY READS, AND WHY EACH FIELD IS HERE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   .spec.json              prompt_source.task → the task cell.
 *                           resolved.mode/model → provider readout.
 *   .progress.json          recent_activities → the activity phrase (highest
 *                           step_index wins, because a rewritten array is not
 *                           guaranteed sorted and showing a 4-steps-ago tool as
 *                           "now" is the quiet wrongness a band exists to
 *                           prevent). last_event_at → the stall clock.
 *   .events.jsonl           max step_index → the tool COUNT. DONE records only →
 *                           the tool HISTORY.
 *   .result.md              emptiness → the status (hazard A/C); contents → the
 *                           report in the detail view.
 *   .result.md.status.json  THE terminal anchor.
 *   .log                    `dispatch registered … at ISO` → the start time,
 *                           which exists nowhere else; and `agy_exit` → the
 *                           "died before writing a status" fallback row.
 *   .spec.json.cancel       written the INSTANT cancel is requested, so it can
 *                           outrank the status file. Hazard B.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { appendLine, createMarker, writeAtomic, writeJsonAtomic } from './atomic.ts';
import type { ForgeActivity, ForgeManifest, ForgeProgress } from './format.ts';

/** agy-staff's jobs directory. Relative to the same repo as ours. */
export const MIRROR_DIR_SEGMENTS = ['.agy-staff', 'jobs'] as const;

const SPEC = '.spec.json';
const PROGRESS = '.progress.json';
const STATUS = '.result.md.status.json';
const RESULT = '.result.md';
const LOG = '.log';
const EVENTS = '.events.jsonl';
const CANCEL = '.spec.json.cancel';

/** Written into every spec.json we mirror. The ownership claim. */
export const MIRROR_MARKER = 'agent-smith';

export function mirrorDir(repo: string): string {
  return path.join(repo, ...MIRROR_DIR_SEGMENTS);
}

export function mirrorAt(repo: string, jobId: string, suffix: string): string {
  return path.join(mirrorDir(repo), `${jobId}${suffix}`);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Pure builders. Everything the mirror writes is computed here, with no I/O, so
 * a reviewer can check the shape without running anything.
 * ──────────────────────────────────────────────────────────────────────────── */

/** `.spec.json`. The `task` is what the band and pane show as the job's title. */
export function mirrorSpec(m: ForgeManifest): Record<string, unknown> {
  return {
    [MIRROR_MARKER]: true,
    job_id: m.jobId,
    name: m.name,
    workerId: m.workerId,
    role: m.role,
    cwd: m.cwd,
    prompt_source: { kind: MIRROR_MARKER, task: m.task },
    resolved: {
      name: m.name,
      workerId: m.workerId,
      role: m.role,
      mode: m.mode,
      model: m.model,
      // agy-staff's `profile` is its permission profile; ours is the honest
      // equivalent, and it is the one field an operator must never have to
      // guess at from the outside.
      profile: m.unrestricted ? 'unrestricted' : 'default',
      background: true,
    },
  };
}

/**
 * `.progress.json`.
 *
 * `recent_activities` is capped at 5 for the same reason agy-staff caps it: the
 * band renders one phrase, and carrying 484 of them costs bytes on every repaint
 * to display five characters.
 */
export function mirrorProgress(
  p: ForgeProgress,
  recent: readonly ForgeActivity[] = p.recentActivities.slice(-5),
): Record<string, unknown> {
  return {
    job_id: p.jobId,
    name: p.name,
    workerId: p.workerId,
    role: p.role,
    latestSummary: p.latestSummary,
    summarySource: p.summarySource,
    last_event_at: p.lastEventAt,
    tool_calls: p.toolCalls,
    recent_activities: recent.map((a) => ({
      step_index: a.stepIndex,
      tool: a.tool,
      ...(a.input === undefined ? {} : { input_preview: a.input }),
      status: a.status,
    })),
    latest_text:
      p.latestText === null
        ? null
        : { text: p.latestText, updated_at: p.lastEventAt, incomplete: true },
    warnings: [...p.warnings],
  };
}

/**
 * `.result.md.status.json` — the terminal anchor.
 *
 * `status` is derived from OUR verdict, which `deriveStatus` already downgraded
 * when the report was empty. So the pane's own headline rule ("done + empty
 * output ⇒ failed") is a second line of defence behind ours rather than the only
 * one: by the time the pane applies it, `done` genuinely means we had output.
 *
 * `warnings: true` is carried from the verdict's `suspicious` flag. The pane
 * treats a non-empty report with warnings as still succeeded (correct — it did
 * produce work) but says so in words, which is the honest middle ground between
 * a green tick and a red row.
 */
export function mirrorStatus(m: ForgeManifest, suspicious: boolean): Record<string, unknown> {
  const status = m.status === 'succeeded' ? 'done' : m.status === 'canceled' ? 'canceled' : 'error';
  const out: Record<string, unknown> = {
    status,
    warnings: suspicious,
    finished_at: m.finishedAt ?? m.updatedAt,
  };
  if (m.error !== null && m.error !== '') out['reason'] = m.error;
  else if (suspicious) out['reason'] = 'reported success with no usable output';
  return out;
}

/**
 * `.log`. Appended, never rewritten.
 *
 * The `dispatch registered` line exists for ONE reason: `startedAt` comes from
 * nowhere else. Every other field in agy-staff's layout is end-anchored, and
 * without a start there is no elapsed time to draw and no way to answer "is it
 * moving?".
 *
 * We write no `worker started … pid=N` line because we do not have the child's
 * pid: `WorkerHandle` does not expose it and adding it to the four adapters is a
 * change to a verified contract for one cosmetic field. The pane's `parseLog`
 * falls back to the dispatch line, which carries the same instant, so nothing is
 * lost — we state the omission rather than writing a pid we did not observe.
 */
export function mirrorDispatchLine(m: ForgeManifest): string {
  return `[${MIRROR_MARKER}] dispatch registered ${m.jobId} at ${m.createdAt}\n`;
}

/**
 * The terminal `.log` line.
 *
 * `agy_status` / `agy_exit` are agy-staff's field names, kept verbatim because
 * the pane greps for them by name. They are what makes a job that died BEFORE
 * this module could write a status file still read as `failed` rather than
 * sitting at `?` forever.
 */
export function mirrorTerminalLine(m: ForgeManifest): string {
  const ok = m.status === 'succeeded';
  const seconds = durationSeconds(m);
  const tokens = tokenWords(m.usage);
  return (
    `[${MIRROR_MARKER}] mode=${m.mode} provider=${m.provider} job_status=${m.jobStatus ?? m.status} ` +
    `agy_status=${ok ? 'SUCCESS' : 'ERROR'} agy_exit=${m.exitCode ?? -1} ` +
    `duration=${seconds.toFixed(3)}s${tokens}\n`
  );
}

/**
 * Runtime in seconds, from the two timestamps, or 0 when either is missing.
 *
 * Derived rather than stored: a stored duration can disagree with the timestamps
 * that produced it, and then two readers of the same job print different
 * runtimes. One source.
 */
export function durationSeconds(m: ForgeManifest): number {
  if (m.startedAt === null || m.finishedAt === null) return 0;
  const ms = Date.parse(m.finishedAt) - Date.parse(m.startedAt);
  if (Number.isNaN(ms) || ms < 0) return 0;
  return ms / 1000;
}

/** `tokens(in N, out N, think N, cache N)`, or '' when there is no usage. Absent is not zero. */
export function tokenWords(usage: Readonly<Record<string, number>> | null): string {
  if (usage === null) return '';
  const i = usage['inputTokens'];
  const o = usage['outputTokens'];
  if (i === undefined && o === undefined) return '';
  return ` tokens(in ${i ?? 0}, out ${o ?? 0}, think ${usage['thinkingTokens'] ?? 0}, cache ${usage['cacheReadTokens'] ?? 0})`;
}

/**
 * One agy-shaped `step_update` line, from a normalized provider event.
 *
 * We emit BOTH the ACTIVE and the DONE record, exactly as agy-staff does,
 * because the pane was built against that corpus: `toolCountFromEvents` takes
 * the max `step_index` (identical either way) and `toolHistoryFromEvents` keeps
 * only `state: 'DONE'` records. Emitting only the DONE record would work too,
 * but emitting the shape the readers were verified against is one fewer thing to
 * be wrong about.
 */
export function mirrorEventLine(event: Record<string, unknown>): Record<string, unknown> | null {
  const kind = event['kind'];
  // Assistant prose, for the pane's live transcript. A separate top-level key so
  // tool-count/tool-history readers (which only look at `step_update`) ignore it.
  if (kind === 'text') {
    const text = event['text'];
    if (event['stream'] !== 'assistant' || typeof text !== 'string' || text.trim() === '') return null;
    return { agent_text: { at: event['at'] ?? null, text: text.slice(0, 4_000) } };
  }
  if (kind !== 'activity-start' && kind !== 'activity-end') return null;
  const activity = event['activity'] as Record<string, unknown> | undefined;
  if (activity === undefined) return null;

  const tool = activity['tool'];
  if (typeof tool !== 'string') return null;

  const end = kind === 'activity-end';
  const activityStatus = event['status'];
  const state =
    !end
      ? 'ACTIVE'
      : activityStatus === 'error' || activityStatus === 'denied'
        ? 'ERROR'
        : 'DONE';

  const parameters =
    typeof activity['input'] === 'string' ? { input: activity['input'] } : {};
  const toolInfo: Record<string, unknown> = { ...parameters };
  if (end) {
    if (typeof activity['output'] === 'string') toolInfo['output'] = activity['output'];
    if (activity['denied'] === true || activityStatus === 'error' || activityStatus === 'denied') {
      toolInfo['error'] = { type: 'TOOL_ERROR', message: `tool ${tool} did not complete` };
    }
  }

  return {
    step_update: {
      conversation_id: event['conversationId'] ?? null,
      step_index: activity['stepIndex'] ?? 0,
      state,
      step_type: 'tool',
      tool_name: tool,
      tool_info: toolInfo,
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The writer
 * ──────────────────────────────────────────────────────────────────────────── */

/** Thrown when a mirror target exists and is not ours. See MirrorWriter.claim. */
export class MirrorClaimError extends Error {
  // Explicit field, not a constructor parameter property: `node --test
  // --experimental-strip-types` cannot erase one and fails at LOAD time, so a
  // tsconfig that allows it is not enough — the syntax itself is unavailable.
  readonly filePath: string;

  constructor(filePath: string) {
    super(
      `refusing to mirror over a job that is not ours: ${filePath}. ` +
        'agent-smith never writes a file it did not create.',
    );
    this.name = 'MirrorClaimError';
    this.filePath = filePath;
  }
}

export interface MirrorWriterOptions {
  /** When false, only the pure builders run. Used to prove the mod is optional. */
  readonly enabled?: boolean;
}

/**
 * Writes the agy-staff-shaped projection for ONE of our jobs.
 *
 * The ownership claim is checked once, on the first write, and is the reason
 * this class is safe to point at a directory full of somebody else's history:
 *
 *   - If our spec.json already exists (we wrote it earlier), fine.
 *   - If NO spec.json exists, we create it and we own the id from then on.
 *   - If a spec.json exists and does NOT carry our marker, we throw. That is
 *     not a recoverable condition — it means an id collision, and the only
 *     correct response to "I am about to overwrite an agy-staff job" is to stop.
 */
export class MirrorWriter {
  readonly enabled: boolean;
  // Explicit fields, not constructor parameter properties: this repo runs under
  // `node --experimental-strip-types`, which cannot erase a parameter property
  // and fails at load time rather than at typecheck. pipeline/pipeline.ts's
  // Scheduler makes the same choice.
  private readonly repo: string;

  constructor(repo: string, options: MirrorWriterOptions = {}) {
    this.repo = repo;
    this.enabled = options.enabled ?? true;
  }

  /** Verify we may write this job's mirror. Throws MirrorClaimError otherwise. */
  claim(jobId: string): void {
    if (!this.enabled) return;
    const specPath = mirrorAt(this.repo, jobId, SPEC);
    // existsSync via a read: no new import needed, and a read of a file we are
    // about to check ownership of is cheaper than a failed open() syscall.
    let existing: string | null = null;
    try {
      existing = readTextFile(specPath);
    } catch {
      existing = null;
    }
    if (existing === null) return; // nobody has claimed it; we will
    if (parseMarkedSpec(existing)) return; // ours
    throw new MirrorClaimError(specPath);
  }

  writeSpec(m: ForgeManifest): void {
    if (!this.enabled) return;
    writeJsonAtomic(mirrorAt(this.repo, m.jobId, SPEC), mirrorSpec(m));
    appendLine(mirrorAt(this.repo, m.jobId, LOG), mirrorDispatchLine(m).trimEnd());
  }

  writeProgress(m: ForgeManifest, p: ForgeProgress): void {
    if (!this.enabled) return;
    writeJsonAtomic(mirrorAt(this.repo, m.jobId, PROGRESS), mirrorProgress(p));
  }

  appendEvent(jobId: string, event: Record<string, unknown>): void {
    if (!this.enabled) return;
    const line = mirrorEventLine(event);
    if (line !== null) appendLine(mirrorAt(this.repo, jobId, EVENTS), line);
  }

  /**
   * Write the terminal anchor, the report, and the terminal log line.
   *
   * ORDER MATTERS and is not incidental:
   *   result.md FIRST, then the log line, THEN status.json.
   * A reader that samples between the first and the last sees no status file and
   * still reads `running`, which is the correct conservative answer. The
   * reverse order would open a window where `status: 'done'` exists and
   * `result.md` does not — and "done with no report" is precisely the
   * suspicious-success state we spend this whole codebase trying to prevent.
   */
  finish(m: ForgeManifest, report: string, suspicious: boolean): void {
    if (!this.enabled) return;
    writeAtomic(mirrorAt(this.repo, m.jobId, RESULT), report);
    appendLine(mirrorAt(this.repo, m.jobId, LOG), mirrorTerminalLine(m).trimEnd());
    writeJsonAtomic(mirrorAt(this.repo, m.jobId, STATUS), mirrorStatus(m, suspicious));
  }

  /** Write the cancel marker. First writer wins; the body is the instant. */
  cancel(jobId: string, at: string): boolean {
    if (!this.enabled) return false;
    return createMarker(mirrorAt(this.repo, jobId, CANCEL), at);
  }
}

/* ── local helpers, kept private so this module's public surface is the
 * builders + the writer, and the two cannot disagree ─────────────────────── */

function readTextFile(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function parseMarkedSpec(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== 'object') return false;
    return (parsed as Record<string, unknown>)[MIRROR_MARKER] === true;
  } catch {
    // A spec.json we cannot parse is not ours. Treating it as ours would let us
    // overwrite a file we know nothing about, which is the whole thing we refuse.
    return false;
  }
}
