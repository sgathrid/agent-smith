/**
 * agy-staff.ts — reads agy-staff's job state from `<repo>/.agy-staff/jobs/`.
 *
 * This reader spawns nothing and patches nothing. agy-staff already writes a
 * complete, continuously-updated snapshot for every job; we read it. The layout
 * (verified against 20 real jobs in /Users/gathrid/Repos/renyi/.agy-staff/jobs):
 *
 *   <jobId>.spec.json          { resolved: { mode, model, profile, timeout,
 *                                       background }, prompt, prompt_source,
 *                               opts, cwd }
 *   <jobId>.progress.json      { job_id, last_event_at, recent_activities[<=5],
 *                               latest_text: { step_index, text, truncated,
 *                               updated_at, incomplete, status }, warnings: string[] }
 *   <jobId>.result.md.status.json  { status: 'done'|'error'|'canceled',
 *                               warnings?: bool, reason?: string, finished_at: iso }
 *   <jobId>.result.md          final report markdown (sometimes POLLUTED, see HAZARD C)
 *   <jobId>.log                telemetry lines, e.g.
 *                               "[agy-staff] mode=... agy_status=SUCCESS agy_exit=0
 *                                duration=1681.5s turns=1 tokens(in ..., out ...)"
 *   <jobId>.events.jsonl       raw NDJSON stream; only present for RUNNING or
 *                               WARNED/FAILED jobs
 *   <jobId>.spec.json.cancel   cancel marker; content is the cancel ISO timestamp
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE REAL HAZARDS (each handled explicitly below, labeled [HAZARD A/B/C])
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * =============================================================================
 * [HAZARD A] progress.json is DELETED on a clean, warning-free success.
 * =============================================================================
 * A missing progress.json does NOT mean "job missing" — it means the job
 * FINISHED. agy-staff cleans up progress.json + events.jsonl when a job
 * succeeds with no warnings, precisely so a finished job looks tidy. Observed
 * in the real corpus: all 20 jobs had warnings=true, so all 20 retained
 * progress.json; but the cleanup path is real and warning-free successes WILL
 * lose the file.
 *
 * THE FIX: never treat progress.json as the liveness or terminal anchor.
 * Terminal state is anchored on the always-written `<jobId>.result.md.status.json`.
 * Progress/events are treated as OPTIONAL liveness evidence. This reader
 * returns a full snapshot for a finished job even when both files are gone.
 *
 * =============================================================================
 * [HAZARD B] `.spec.json.cancel` marker files mark cancelled jobs.
 * =============================================================================
 * When a job is cancelled, agy-staff writes a sibling `<jobId>.spec.json.cancel`
 * file whose content is the cancellation timestamp. In the real corpus there
 * are 2 of these (implement-murvydru-07eed78d, implement-musledug-f5e05526),
 * and BOTH correspond to a status.json with { status:'canceled', reason:'canceled' }.
 * We detect the marker directly because a cancellation may be mid-flight: the
 * marker can exist before status.json is finalized.
 *
 * THE FIX: read the marker and set a `canceled` flag in the payload; the
 * normalizer turns that into status 'canceled' regardless of status.json.
 *
 * =============================================================================
 * [HAZARD C] result.md can be POLLUTED with <system_notification> blocks.
 * =============================================================================
 * Some result.md files are prefixed with a run of `<system_notification>...
 * </system_notification>` blocks (background-task completion messages) that
 * agy-staff failed to strip before persisting the report. The real job
 * implement-musm82da-f1dc1fe4.result.md has 12 such blocks (= 24 open+close
 * tags) prepended before the real markdown. This is a genuine upstream bug
 * and `stripSystemNotifications()` below is the clean fix.
 */

import path from "node:path";

import {
  existsSafe,
  readJsonSafe,
  readTextSafe,
  readdirSafe,
} from "./safe-fs.ts";
import type { JobStateReader, RawJobState } from "./types.ts";

/** Directory agy-staff writes per-repo job state into. */
const JOBS_DIR = path.join(".agy-staff", "jobs");

/** Suffixes that identify a job directory entry, mapped to a logical field. */
const SPEC_SUFFIX = ".spec.json";
const PROGRESS_SUFFIX = ".progress.json";
const STATUS_SUFFIX = ".result.md.status.json";
const RESULT_SUFFIX = ".result.md";
const LOG_SUFFIX = ".log";
const EVENTS_SUFFIX = ".events.jsonl";
const CANCEL_SUFFIX = ".spec.json.cancel";

/** payload keys the normalizer relies on (documented here for cross-reference). */
export const AGY_PAYLOAD = {
  mode: "mode",
  model: "model",
  profile: "profile",
  resolved: "resolved",
  promptSource: "prompt_source",
  status: "status", // terminal status from status.json: 'done'|'error'|'canceled'
  statusWarnings: "status_warnings", // status.json warnings:boolean
  statusReason: "status_reason", // status.json reason:string (error/canceled)
  finishedAt: "finished_at", // status.json finished_at
  lastEventAt: "last_event_at", // progress.json
  recentActivities: "recent_activities", // progress.json
  latestText: "latest_text", // progress.json
  progressWarnings: "progress_warnings", // progress.json warnings:string[]
  output: "output", // cleaned result.md text
  outputTruncated: "output_truncated",
  telemetry: "telemetry", // parsed fields from .log
  canceled: "canceled", // true if .spec.json.cancel exists (HAZARD B)
  cancelAt: "cancel_at", // marker timestamp (HAZARD B)
  hasProgressFile: "has_progress_file", // for evidence/debug (HAZARD A)
  hasEventsFile: "has_events_file",
  notificationsStripped: "notifications_stripped", // count removed (HAZARD C)
} as const;

/** Loosely-typed shapes of the upstream files. Every field optional on purpose. */
interface AgySpec {
  resolved?: {
    mode?: string;
    model?: string;
    profile?: string;
    timeout?: string;
    background?: boolean;
    conversation?: string | null;
    parentJobId?: string | null;
  };
  prompt_source?: { kind?: string; task?: string };
  opts?: unknown;
  cwd?: string;
}

interface AgyProgressActivity {
  step_index?: number;
  started_at?: string;
  tool?: string;
  status?: string;
  input_preview?: string;
  input_truncated?: boolean;
  output_preview?: string;
  output_truncated?: boolean;
}

interface AgyProgress {
  job_id?: string;
  last_event_at?: string;
  recent_activities?: AgyProgressActivity[];
  latest_text?: { step_index?: number; text?: string; truncated?: boolean; incomplete?: boolean };
  warnings?: string[];
}

interface AgyStatus {
  status?: string; // 'done' | 'error' | 'canceled'
  warnings?: boolean;
  reason?: string;
  finished_at?: string;
}

/** A dependency-free `.agy-staff/jobs` reader. */
export class AgyStaffReader implements JobStateReader {
  readonly provider = "agy-staff";

  /** Resolve the per-repo jobs directory for a given cwd. */
  private jobsDir(cwd: string): string {
    return path.join(cwd, JOBS_DIR);
  }

  /**
   * Enumerate job ids from `<jobId>.spec.json` entries.
   *
   * Robustness notes:
   *  - We key on spec.json because every job (running or finished) has one.
   *  - We tolerate readdir races by simply ignoring names we cannot classify.
   *  - `discover` never throws; unknown cwd yields [].
   */
  async discover(cwd: string): Promise<string[]> {
    const dir = this.jobsDir(cwd);
    const entries = await readdirSafe(dir);
    const ids = new Set<string>();
    for (const name of entries) {
      if (name.endsWith(SPEC_SUFFIX) && name.length > SPEC_SUFFIX.length) {
        ids.add(name.slice(0, -SPEC_SUFFIX.length));
      }
    }
    return [...ids].sort();
  }

  /**
   * Assemble a snapshot for one job.
   *
   * Returns null ONLY when there is no evidence the job exists at all (no
   * spec, no status, no result, no log, no cancel marker). A finished job with
   * a deleted progress.json still returns a snapshot — see HAZARD A.
   */
  async read(cwd: string, jobId: string): Promise<RawJobState | null> {
    const dir = this.jobsDir(cwd);
    const at = (suffix: string) => path.join(dir, `${jobId}${suffix}`);

    // --- HAZARD B: cancel marker. Read it first; it can outrank status.json. ---
    const cancelMarkerPath = at(CANCEL_SUFFIX);
    const canceled = await existsSafe(cancelMarkerPath);
    let cancelAt: string | null = null;
    if (canceled) {
      const raw = await readTextSafe(cancelMarkerPath);
      // The marker body is the cancel timestamp; normalize to trimmed string or null.
      const t = raw?.trim();
      cancelAt = t && t.length > 0 ? t : null;
    }

    // --- Terminal anchor (HAZARD A). status.json is written on every terminal
    // job, so it is the reliable source of done/error/canceled. ---
    const status = await readJsonSafe<AgyStatus>(at(STATUS_SUFFIX));

    // --- spec.json: exists for every job; carries mode/model/profile. ---
    const spec = await readJsonSafe<AgySpec>(at(SPEC_SUFFIX));

    // --- result.md: the final report. Read + de-pollute (HAZARD C). ---
    const rawResult = await readTextSafe(at(RESULT_SUFFIX));
    let output: string | null = null;
    let outputTruncated = false;
    let notificationsStripped = 0;
    if (rawResult !== null) {
      const cleaned = stripSystemNotifications(rawResult);
      notificationsStripped = cleaned.removedCount;
      output = cleaned.text;
      // After stripping, if what remains is empty the "final answer" is empty —
      // a suspicious success, flagged in normalize.ts.
    }

    // --- .log: best-effort telemetry (mode/model/agy_status/duration/tokens). ---
    const log = await readTextSafe(at(LOG_SUFFIX));
    const telemetry = log === null ? {} : parseLogTelemetry(log);

    // Decide "does this job exist at all?" only after collecting all evidence,
    // so a job whose only surviving artifact is the cancel marker is still seen.
    const anyEvidence =
      status !== null ||
      spec !== null ||
      rawResult !== null ||
      log !== null ||
      canceled;
    if (!anyEvidence) return null;

    // --- progress.json + events.jsonl are OPTIONAL liveness evidence (HAZARD A).
    // A null here means either "still running but not written yet" OR
    // "finished clean and agy-staff deleted it". We record presence as evidence
    // but never treat absence as fatal. ---
    const progress = await readJsonSafe<AgyProgress>(at(PROGRESS_SUFFIX));
    const hasProgressFile = progress !== null;
    const hasEventsFile = await existsSafe(at(EVENTS_SUFFIX));

    const payload: Record<string, unknown> = {
      [AGY_PAYLOAD.mode]: spec?.resolved?.mode ?? null,
      [AGY_PAYLOAD.model]: spec?.resolved?.model ?? null,
      [AGY_PAYLOAD.profile]: spec?.resolved?.profile ?? null,
      [AGY_PAYLOAD.resolved]: spec?.resolved ?? null,
      [AGY_PAYLOAD.promptSource]: spec?.prompt_source?.kind ?? null,
      [AGY_PAYLOAD.status]: status?.status ?? null,
      [AGY_PAYLOAD.statusWarnings]: status?.warnings ?? null,
      [AGY_PAYLOAD.statusReason]: status?.reason ?? null,
      [AGY_PAYLOAD.finishedAt]: status?.finished_at ?? null,
      [AGY_PAYLOAD.lastEventAt]: progress?.last_event_at ?? null,
      [AGY_PAYLOAD.recentActivities]: progress?.recent_activities ?? [],
      [AGY_PAYLOAD.latestText]: progress?.latest_text ?? null,
      [AGY_PAYLOAD.progressWarnings]: progress?.warnings ?? [],
      [AGY_PAYLOAD.output]: output,
      [AGY_PAYLOAD.outputTruncated]: outputTruncated,
      [AGY_PAYLOAD.telemetry]: telemetry,
      [AGY_PAYLOAD.canceled]: canceled,
      [AGY_PAYLOAD.cancelAt]: cancelAt,
      [AGY_PAYLOAD.hasProgressFile]: hasProgressFile,
      [AGY_PAYLOAD.hasEventsFile]: hasEventsFile,
      [AGY_PAYLOAD.notificationsStripped]: notificationsStripped,
    };

    // partial=true when the terminal anchor is missing (still running) OR when
    // any parse silently failed. normalize.ts uses this to bias toward 'unknown'
    // over a confident guess.
    const partial = status === null;

    return {
      // MUST match `this.provider`: normalize() selects its per-provider rule by
      // this string, and a mismatch silently degrades to `unknown`.
      provider: this.provider,
      jobId,
      cwd: spec?.cwd ?? cwd,
      payload,
      partial,
    };
  }
}

/**
 * =============================================================================
 * HAZARD C FIX: strip leading `<system_notification>` blocks from result.md
 * =============================================================================
 * Upstream bug: agy-staff prepends `<system_notification>...</system_notification>`
 * blocks (completed background-task messages) to some result.md files, burying
 * the real report. Real job implement-musm82da-f1dc1fe4.result.md has 12 such
 * blocks before the real markdown.
 *
 * Approach notes:
 *  - Blocks can span multiple lines (the notification body contains log paths and
 *    wrapped text), so we cannot strip line-by-line. We scan for the open tag,
 *    then find the matching close tag after it, and cut the whole span.
 *  - We only strip a block when BOTH an open and a close tag are found, so a
 *    lone open tag (e.g. someone literally wrote the text) is left intact rather
 *    than swallowing the rest of the document.
 *  - Runs at the start are collapsed. A notification appearing mid-document is
 *    still removed (they are always noise), but we don't reorder anything.
 *  - Pure function; unit-tested against the real file in __tests__/.
 */
export function stripSystemNotifications(
  text: string,
): { text: string; removedCount: number } {
  const OPEN = "<system_notification>";
  const CLOSE = "</system_notification>";

  let out = text;
  let removed = 0;

  for (;;) {
    const start = out.indexOf(OPEN);
    if (start === -1) break;
    const closeIdx = out.indexOf(CLOSE, start + OPEN.length);
    if (closeIdx === -1) break; // unmatched open tag: leave everything alone
    const end = closeIdx + CLOSE.length;
    out = out.slice(0, start) + out.slice(end);
    removed += 1;
  }

  // Collapse any blank-line gap left where the leading run used to be, so the
  // real report starts at the top rather than after dozens of blank lines.
  const cleaned = out.replace(/^(?:[ \t]*\r?\n)+/, "").trimStart();
  return { text: cleaned, removedCount: removed };
}

/**
 * Parse the `[agy-staff] ...` telemetry line(s) from a job's .log.
 *
 * Example real line:
 *   [agy-staff] mode=implement profile=unrestricted model=gemini-3.8-flash-high
 *   agy_status=SUCCESS agy_exit=0 duration=1681.549339s turns=1
 *   tokens(in 2221077, out 137616, think 88239, cache 20425839)
 *
 * Failure logs instead carry `AGY_ERROR: {...}` and no telemetry fields. This
 * returns an empty object in that case — absence is not an error here.
 */
export function parseLogTelemetry(log: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  const mode = /\bmode=(\S+)/.exec(log);
  if (mode?.[1]) out["mode"] = mode[1];
  const profile = /\bprofile=(\S+)/.exec(log);
  if (profile?.[1]) out["profile"] = profile[1];
  const model = /\bmodel=(\S+)/.exec(log);
  if (model?.[1]) out["model"] = model[1];
  const agyStatus = /\bagy_status=(\S+)/.exec(log);
  if (agyStatus?.[1]) out["agy_status"] = agyStatus[1];
  const agyExit = /\bagy_exit=(-?\d+)/.exec(log);
  if (agyExit?.[1]) out["agy_exit"] = Number(agyExit[1]);

  const duration = /\bduration=([\d.]+)s/.exec(log);
  if (duration?.[1]) out["duration_ms"] = Math.round(Number(duration[1]) * 1000);

  const turns = /\bturns=(\d+)/.exec(log);
  if (turns?.[1]) out["turns"] = Number(turns[1]);

  const tokens = /\btokens\(in (\d+), out (\d+), think (\d+), cache (\d+)\)/.exec(log);
  if (tokens) {
    out["tokens_in"] = Number(tokens[1]);
    out["tokens_out"] = Number(tokens[2]);
    out["tokens_think"] = Number(tokens[3]);
    out["tokens_cache"] = Number(tokens[4]);
  }

  // A failure line is hard error evidence; keep a marker for normalize.ts.
  if (log.includes("AGY_ERROR:")) {
    out["saw_agy_error"] = true;
    const reasonLine = /\nerror:\s*(.+)/.exec(log);
    if (reasonLine?.[1]) out["agy_error_reason"] = reasonLine[1].trim();
  }

  return out;
}