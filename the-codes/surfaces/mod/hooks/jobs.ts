/**
 * jobs.ts — read `.agy-staff/jobs/` through `$.fs` and decide what each job IS.
 *
 * THIS IS THE ONLY READER IN THE MOD. The band's line and the pane's list row
 * come from `resolve()` below, so the two surfaces cannot disagree about whether
 * a job is running. See README.md §One reader.
 *
 * WHAT THE LOADER FORCES
 * ──────────────────────
 * A hooks module may import only `claude-code` and files inside the plugin's own
 * folder. `node:fs`, `node:path` and a path escaping the plugin folder are all
 * refused at load time (VERIFIED against 2.1.292):
 *     "cannot import "node:path" (from hooks/job-source.ts): a hooks module
 *      imports its own files by relative path and "claude-code", nothing else"
 *     "cannot import "../../../harness/agy-staff.ts": it is outside the plugin's
 *      folder"
 *
 * The engine's own file access is `$.fs` — read/list/exists/stat, text only,
 * 4 MiB cap — so this reader takes an `FsLike` and is handed `$.fs` by
 * register.tsx. The consequence worth stating: `harness/` cannot be called from
 * here, so harness's reader and normalizer are not reimplemented here but
 * RE-STATED as the precedence table in `resolve()`. Every row of that table
 * names its harness counterpart, because the coupling is real and can only be
 * managed by writing it down.
 *
 * That this file imports no `claude-code` and no `node:` builtin is also what
 * lets `node --test` reach the rules. The hazard and headline-rule tests in
 * tests/jobs.test.ts run against exactly this code.
 *
 * WHAT CAME FROM THE PANE'S OLD ./job-source.ts
 * ─────────────────────────────────────────────
 * `result.md`'s contents (for the detail view's report), the tool history, and
 * the re-exported `stripSystemNotifications`. What did NOT come, deliberately:
 * `projectRadarJob`/`toRadarStatus`/`toRadarStatus`'s second status path, and the
 * separate `sortJobs`. One precedence table, one status function. The pane's
 * ordering lives in ./format.ts with the rest of the pure presentation.
 *
 * THE FILES (verified against 20 real jobs in
 * /Users/gathrid/Repos/renyi/.agy-staff/jobs/)
 * ────────────────────────────────────────────────────────────────────────────
 *   <id>.spec.json              { resolved: { mode, model, profile, timeout },
 *                                 prompt, cwd }
 *   <id>.progress.json          { job_id, last_event_at, recent_activities[<=5]:
 *                                 { step_index, tool, input_preview }, warnings[] }
 *                                 republished ~100ms
 *   <id>.result.md.status.json  { status: done|error|canceled, warnings?: bool,
 *                                 reason?: string, finished_at }   <- ANCHOR
 *   <id>.spec.json.cancel       the cancellation instant (HAZARD B)
 *   <id>.events.jsonl           NDJSON; tool counts come from its step_index
 *   <id>.log                    `[agy-staff] worker started <id> pid=N at ISO`
 *                                 `[agy-staff] … agy_status=… agy_exit=…`
 *   <id>.result.md              the report. Its EMPTINESS decides status; its
 *                                 CONTENTS are the pane detail view's report
 *
 * THE THREE HAZARDS, AND WHERE EACH IS HANDLED
 * ──────────────────────────────────────────────
 * [HAZARD A] progress.json IS DELETED on a warning-free success, so a missing
 *   progress.json means FINISHED, never "missing". `resolve()` below never
 *   infers terminal state from an absent file; the only terminal anchor is
 *   `*.result.md.status.json`, which agy-staff always writes. The regression
 *   guard is "a finished job whose progress.json was deleted still renders as
 *   done" in tests/jobs.test.ts.
 * [HAZARD B] a `.spec.json.cancel` marker can be written BEFORE status.json is
 *   finalised, so it outranks it.
 * [HAZARD C] some result.md files carry leading `<system_notification>` blocks.
 *   Only emptiness is read here, and `looksEmpty` strips them first so a
 *   polluted-but-real report is not mistaken for an empty one.
 *
 * THE HEADLINE RULE (harness/normalize.ts)
 * ─────────────────────────────────────────
 *   An empty response with warnings is NOT a clean success.
 * agy-staff writes `{ status:'done', warnings:true }` and an empty result.md when
 * a tool was soft-denied, then exits 0 having done nothing. `resolve()` maps
 * that to `failed`, never to `succeeded`.
 */

import { describeActivity, describeTool } from './tools-describe.ts';
import { STALL_GRACE_MS } from './stale.ts';
import { REASONS } from './reasons.ts';
import type { RadarJob, RadarStatus, ToolEntry } from '../types/index.d.ts';

/* ────────────────────────────────────────────────────────────────────────────
 * THE FILESYSTEM, AS AN ARGUMENT
 * ────────────────────────────────────────────────────────────────────────────
 * Exactly the shape of `$.fs` (claude-code.d.ts, CoreEngineInterface.fs),
 * narrowed to the three calls this reader makes. Passing it in rather than
 * importing it is what keeps this module free of `claude-code`, and therefore
 * testable under `node --test`.
 */

export interface FsLike {
  /** Reads a file as text. REJECTS when missing — never fatal here. */
  read(path: string): Promise<string>;
  /** Lists a directory, `{ name, kind, size }` per entry. Rejects when missing. */
  list(path: string): Promise<readonly { name: string; kind: string; size: number }[]>;
  /** Never rejects. */
  exists(path: string): Promise<boolean>;
}

/** agy-staff's jobs directory, relative to a repo root. */
const JOBS_SUFFIX = ['.agy-staff', 'jobs'] as const;

const SPEC = '.spec.json';
const PROGRESS = '.progress.json';
const STATUS = '.result.md.status.json';
const RESULT = '.result.md';
const LOG = '.log';
const EVENTS = '.events.jsonl';
const CANCEL = '.spec.json.cancel';

/** `<repo>` + `.agy-staff/jobs`. Pure string join; no `node:path` needed. */
export function jobsDir(repo: string): string {
  return [repo.replace(/\/+$/, ''), ...JOBS_SUFFIX].join('/');
}

/** What an orphaned job shows. Old job records say it at length; ORPHAN_RE (reasons.ts) still matches those. */
const ORPHAN_REASON = REASONS.serverStopped;

/** `<repo>/.agent-smith/jobs/<id>/orphaned`, from `<repo>/.agy-staff/jobs`. */
function orphanMarker(dir: string, id: string): string {
  return `${dir.replace(/\/\.agy-staff\/jobs$/, '/.agent-smith/jobs')}/${id}/orphaned`;
}

function at(dir: string, id: string, suffix: string): string {
  return `${dir}/${id}${suffix}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * TOLERANT READS
 * ────────────────────────────────────────────────────────────────────────────
 * Every function here returns null instead of throwing. We are reading files
 * another process is actively rewriting at ~10Hz: between our list and our read
 * a path can vanish, or hold half a JSON body. A throw here would take the whole
 * band down. A null costs one field for one tick.
 */

async function readTextSafe(fs: FsLike, path: string): Promise<string | null> {
  try {
    return await fs.read(path);
  } catch {
    return null;
  }
}

/** Parse JSON, tolerating absent, empty and half-written documents. */
async function readJsonSafe<T>(fs: FsLike, path: string): Promise<T | null> {
  const text = await readTextSafe(fs, path);
  if (text === null) return null;
  const trimmed = text.trim();
  // Empty or whitespace-only means "mid-write", not "no data".
  if (trimmed === '') return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null; // half-written JSON. The next poll gets it.
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE UPSTREAM SHAPES
 * ────────────────────────────────────────────────────────────────────────────
 * Every field optional on purpose. agy-staff evolves; a reader that requires a
 * field reports "no such job" the day the field goes away, and a band that lies
 * about a missing job is worse than one that says less about it.
 */

interface Spec {
  name?: string | null;
  workerId?: string | null;
  role?: string | null;
  resolved?: {
    mode?: string;
    model?: string;
    profile?: string;
    name?: string | null;
    workerId?: string | null;
    role?: string | null;
  };
  prompt_source?: { kind?: string; task?: string; prompt?: string; preamble?: string };
}

interface Activity {
  step_index?: number;
  tool?: string;
  input_preview?: string;
}

interface Progress {
  job_id?: string;
  name?: string | null;
  workerId?: string | null;
  role?: string | null;
  latestSummary?: string | null;
  summarySource?: 'worker' | null;
  last_event_at?: string;
  recent_activities?: Activity[];
  latest_text?: { text?: string };
  warnings?: string[];
}

interface Status {
  status?: string;
  warnings?: boolean;
  reason?: string;
  finished_at?: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE LOG — the only START TIME ANYWHERE
 * ────────────────────────────────────────────────────────────────────────────
 * Everything else on disk is end-anchored, and without a start there is no
 * elapsed time to show, so a band without this cannot answer "is it moving?".
 * Two lines are parsed and nothing more:
 *   [agy-staff] dispatch registered <id> at 2026-10-03T16:37:40.991Z
 *   [agy-staff] worker started <id> pid=87142 at 2026-10-03T16:37:41.031Z
 *
 * `worker started` WINS over `dispatch registered`: dispatch is registration and
 * worker start is the process actually coming up, and the gap between them is
 * real time the job spent not working.
 */

const RE_DISPATCH = /dispatch registered \S+ at (\S+)/;
const RE_WORKER = /worker started \S+ pid=\d+ at (\S+)/;
const RE_AGY_STATUS = /\bagy_status=(\S+)/;
const RE_AGY_EXIT = /\bagy_exit=(-?\d+)/;

/** ISO-8601 → epoch ms, or null. NaN never becomes a number here. */
export function toEpoch(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** The start time and run outcome the log carries. Pure and unit-tested. */
export function parseLog(log: string): {
  startedAt: number | null;
  agyStatus: string | null;
  agyExit: number | null;
} {
  const worker = RE_WORKER.exec(log);
  const dispatch = RE_DISPATCH.exec(log);
  const stamp = worker?.[1] ?? dispatch?.[1] ?? null;
  const exitMatch = RE_AGY_EXIT.exec(log);
  return {
    startedAt: toEpoch(stamp),
    agyStatus: RE_AGY_STATUS.exec(log)?.[1] ?? null,
    agyExit: exitMatch?.[1] === undefined ? null : Number(exitMatch[1]),
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * [HAZARD C] AND THE HEADLINE RULE
 * ────────────────────────────────────────────────────────────────────────────
 * `stripSystemNotifications` exists in harness/agy-staff.ts with tests against
 * the real polluted file (12 blocks). It is restated here — 10 lines — because a
 * mod cannot import it (outside the plugin folder), and because it is the one
 * pure helper worth carrying rather than a reader.
 *
 * EXPORTED, not private: the pane's detail view renders the STRIPPED report, and
 * a surface must never have to reach for a second copy of the de-polluter to get
 * it. Before this file absorbed ./job-source.ts this was a private helper with a
 * re-export over there; now there is exactly one copy.
 */
export function stripSystemNotifications(text: string): string {
  const OPEN = '<system_notification>';
  const CLOSE = '</system_notification>';
  let out = text;
  for (;;) {
    const start = out.indexOf(OPEN);
    if (start === -1) break;
    const close = out.indexOf(CLOSE, start + OPEN.length);
    // An unmatched open tag is literal text, not the start of a block.
    if (close === -1) break;
    out = out.slice(0, start) + out.slice(close + CLOSE.length);
  }
  return out.replace(/^(?:[ \t]*\r?\n)+/, '').trimStart();
}

/**
 * Is there no usable output?
 *
 * Under 8 characters counts as empty, matching harness/normalize.ts's
 * `looksEmpty`: a single stray character is not a deliverable, and neither is
 * "done" or "ok". Whitespace, and a body that was only notifications, both count.
 */
export function looksEmpty(resultText: string | null): boolean {
  if (resultText === null) return true;
  return stripSystemNotifications(resultText).trim().length < 8;
}

/* ────────────────────────────────────────────────────────────────────────────
 * TOOL COUNT — from events.jsonl's own step_index
 * ────────────────────────────────────────────────────────────────────────────
 * Counting events would double-count: agy-staff emits an ACTIVE record and a
 * DONE record per step at the same step_index. Real check on the corpus:
 * implement-muroviej has 338 tool records over 169 distinct step_index values,
 * max step_index 345. So the highest step_index that carried a tool call is the
 * step ordinal — a real, monotonic quantity, not an estimate.
 *
 * HAZARD A again: events.jsonl is deleted with progress.json on a warning-free
 * success, so this returns null for exactly the cleanest jobs. Null renders as
 * an OMITTED segment (see buildLine), never as `0`.
 */

const RE_STEP = /"step_index"\s*:\s*(\d+)/g;

/** Highest tool step in an events.jsonl body, or null when there is none. */
export function toolCountFromEvents(text: string | null): number | null {
  if (text === null || text === '') return null;
  // Only records that are a step carrying a tool count. `step_update` and
  // `tool_call` are the two that matter; anything else without a step_index is
  // skipped by the regex anyway.
  let max: number | null = null;
  for (const match of text.matchAll(RE_STEP)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && (max === null || n > max)) max = n;
  }
  return max;
}

/* ────────────────────────────────────────────────────────────────────────────
 * ACTIVITY — one terse clause, from the newest activity record
 * ────────────────────────────────────────────────────────────────────────────
 * progress.json holds at most 5 recent activities. We pick the highest
 * `step_index` rather than trusting array order: agy-staff appends, but a
 * rewritten array mid-poll is not guaranteed sorted, and showing a 4-steps-ago
 * tool call as "now" is the quiet wrongness a band exists to prevent.
 *
 * The phrasing itself is format.ts's `describeActivity`, so the band and the pane
 * cannot word the same action differently.
 */

function activityPhrase(activities: readonly Activity[] | undefined): string {
  if (!Array.isArray(activities) || activities.length === 0) return '';
  let best: Activity | undefined;
  let bestStep = -Infinity;
  for (const a of activities) {
    const s = a?.step_index;
    if (typeof s === 'number' && Number.isFinite(s) && s > bestStep) {
      bestStep = s;
      best = a;
    }
  }
  // No step indexes at all (an older layout): fall back to the last entry.
  const chosen = best ?? activities[activities.length - 1];
  if (chosen === undefined) return '';
  const tool = typeof chosen.tool === 'string' ? chosen.tool : null;
  const preview = typeof chosen.input_preview === 'string' ? chosen.input_preview : null;
  return describeActivity(tool, preview);
}

/**
 * The task's first line, verbatim. NOT a display label.
 *
 * Formatting a title is presentation, so it happens in ./format.ts
 * (`deriveTaskLabel`) rather than here — one place decides what a task title
 * looks like, and the band and the pane both call it. This function's whole job
 * is to find the line: the real tasks are 60+ lines long and the pane has room
 * for one, and the leading `#` is left ON because stripping markdown is one of
 * the cuts `deriveTaskLabel` makes deliberately (see its comment on the two
 * cuts) and doing half of it here would leave that function unable to reason
 * about what it was given.
 */
function taskTitle(spec: Spec | null): string {
  const raw = spec?.prompt_source?.task;
  if (typeof raw !== 'string') return '';
  return raw.split('\n').find((l) => l.trim().length > 0)?.trim().slice(0, 400) ?? '';
}

/**
 * The de-polluted report body, or null when there is nothing to show.
 *
 * HAZARD C AGAIN, now for the pane's benefit rather than only for emptiness: 12
 * leading `<system_notification>` blocks would render as the first screen of the
 * report in the detail view, so the strip is not optional here either.
 *
 * `looksEmpty` uses a `< 8` character threshold because a body that short is not
 * a deliverable. That threshold is right for deciding STATUS and wrong for
 * deciding whether to RENDER: a 5-character result is still the only thing the
 * worker produced, and the detail view saying "no report was written" about it
 * would be a different lie from the one `looksEmpty` is written to prevent. So
 * the two questions are asked separately — `looksEmpty` for status, this for the
 * body.
 */
export function reportBody(result: string | null): string | null {
  if (result === null) return null;
  const text = stripSystemNotifications(result).trim();
  return text === '' ? null : text;
}

/* ────────────────────────────────────────────────────────────────────────────
 * RESOLUTION — the whole point of the file
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Resolve one job id into the shared RadarJob row.
 *
 * STATUS PRECEDENCE, highest first. Each row names the evidence it needs and why
 * it cannot be reordered:
 *
 *   1. cancel marker present              => canceled
 *      [HAZARD B] it can appear before status.json is finalised, so it outranks
 *      it. A cancellation caught mid-flight is still a cancellation.
 *   2. status.json status === 'canceled'  => canceled
 *   3. status.json status === 'error'     => failed
 *   4. status.json status === 'done'      => succeeded, UNLESS the output is
 *      empty, in which case failed. THE HEADLINE RULE.
 *      The downgrade fires on emptiness REGARDLESS of the warnings flag: an empty
 *      result.md is empty whether or not agy-staff was kind enough to say so, and
 *      a warning flag that gates this is a warning flag agy can forget to set.
 *   5. agy_status=ERROR or agy_exit!=0    => failed
 *      A run that died before writing status.json — a killed process, a full
 *      disk — still has its log. Without this row such a job sits at `?` forever.
 *   6. progress.json present              => running, or attention if silent past
 *      STALL_GRACE_MS (15 min, from stale.ts, so the band and
 *      the channel agree on when "stalled" begins).
 *   7. otherwise                          => unknown
 *
 * NO ROW SAYS "THE FILE IS GONE, THEREFORE FINISHED." That inference is HAZARD A,
 * and the entire ordering above exists to prevent it.
 *
 * `withReport` is OFF by default and that default is load-bearing for cost, not
 * for correctness: the real corpus holds 256 KB of result.md across 20 jobs, and
 * the band re-reads and re-stringifies the whole snapshot every 3 s forever. A
 * band that carried every report would pay 256 KB of poll traffic to display a
 * six-character line. So the band reads without reports and the PANE — which
 * renders one report at a time on demand — asks for it. Status is identical
 * either way, because `looksEmpty` is computed from the same bytes regardless of
 * whether the body is kept.
 */
export async function resolve(
  fs: FsLike,
  dir: string,
  id: string,
  now: number,
  withReport = false,
): Promise<RadarJob | null> {
  const canceled = await fs.exists(at(dir, id, CANCEL)).catch(() => false);
  const status = await readJsonSafe<Status>(fs, at(dir, id, STATUS));
  const spec = await readJsonSafe<Spec>(fs, at(dir, id, SPEC));
  const progress = await readJsonSafe<Progress>(fs, at(dir, id, PROGRESS));
  const log = await readTextSafe(fs, at(dir, id, LOG));
  const result = await readTextSafe(fs, at(dir, id, RESULT));
  const events = await readTextSafe(fs, at(dir, id, EVENTS));

  // "Does this job exist?" is asked only after everything is collected, so a job
  // whose only surviving artifact is its spec is still found.
  const anyEvidence =
    status !== null || spec !== null || progress !== null || log !== null || canceled;
  if (!anyEvidence) return null;

  const logFacts = log === null
    ? { startedAt: null, agyStatus: null, agyExit: null }
    : parseLog(log);
  const finishedAt = typeof status?.finished_at === 'string' ? status.finished_at : null;
  const endedAt = toEpoch(finishedAt);

  // A start we could not find is `null`, never guessed: harness/normalize.ts
  // refuses to invent one and a wrong start is a wrong clock for the whole job.
  const startedAt = logFacts.startedAt;

  const toolCount = toolCountFromEvents(events);
  const activities = progress?.recent_activities;
  const activity = activityPhrase(activities);

  const progressWarnings = Array.isArray(progress?.warnings)
    ? progress.warnings.filter((w): w is string => typeof w === 'string')
    : [];

  // Accumulate into a mutable array, then hand it over as the readonly shape
  // the published type declares. The band must never push into a job's own
  // warnings after it is stored — they are a snapshot, not a channel.
  const warnings: { code: string; message: string }[] = [];
  if (typeof status?.reason === 'string' && status.reason !== '') {
    warnings.push({ code: 'canceled', message: status.reason });
  }
  if (logFacts.agyStatus === 'ERROR') {
    warnings.push({ code: 'tool_error', message: `agy reported ${logFacts.agyStatus}` });
  }
  if (status?.warnings === true) {
    warnings.push({ code: 'suspicious_success', message: 'agy-staff set warnings:true' });
  }
  for (const w of progressWarnings) {
    warnings.push({ code: 'tool_error', message: w });
  }

  const reasoning =
    typeof progress?.latest_text?.text === 'string' && progress.latest_text.text.trim() !== ''
      ? progress.latest_text.text
      : null;

  const firstText = (...values: unknown[]): string | null => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim() !== '') return value.trim();
    }
    return null;
  };
  const name = firstText(spec?.name, spec?.resolved?.name, progress?.name);
  const workerId = firstText(spec?.workerId, spec?.resolved?.workerId, progress?.workerId) ?? id;
  const role = firstText(spec?.role, spec?.resolved?.role, progress?.role, spec?.resolved?.mode);
  const latestSummary = firstText(progress?.latestSummary);
  const summarySource: 'worker' | null = progress?.summarySource === 'worker' && latestSummary !== null ? 'worker' : null;

  const terminalStatus = status?.status;
  // The report body is computed from bytes already in hand, so keeping it costs a
  // reference, not a read. See `withReport` above for why the band declines it.
  const report = withReport ? reportBody(result) : null;
  const raw = {
    ...(name === null ? {} : { name }),
    workerId,
    ...(role === null ? {} : { role }),
    ...(latestSummary === null ? {} : { latestSummary }),
    summarySource,
  };
  const base = {
    id,
    name,
    workerId,
    role,
    latestSummary,
    summarySource,
    startedAt,
    toolCount,
    activity,
    task: taskTitle(spec),
    // The whole prompt is detail-view only, like the report: the band polls every job.
    prompt: withReport && typeof spec?.prompt_source?.prompt === 'string' ? spec.prompt_source.prompt : null,
    preamble: withReport && typeof spec?.prompt_source?.preamble === 'string' ? spec.prompt_source.preamble : null,
    warnings,
    report,
    reasoning,
    raw,
  };

  // --- rows 1 & 2: canceled --------------------------------------------------
  if (canceled || terminalStatus === 'canceled') {
    return {
      ...base,
      status: 'canceled',
      endedAt: endedAt ?? now,
      // A cancelled job's empty output is expected; harness/normalize.ts drops
      // the empty_output warning for exactly this reason, and so do we.
      warnings: [{ code: 'canceled', message: status?.reason ?? 'cancelled' }],
    };
  }

  // --- row 3: terminal error -------------------------------------------------
  if (terminalStatus === 'error') {
    return {
      ...base,
      status: 'failed',
      endedAt: endedAt ?? now,
      warnings: [
        {
          code: 'tool_error',
          message: status?.reason ?? (logFacts.agyExit === 0 ? 'agy error' : `agy exit ${logFacts.agyExit ?? '?'}`),
        },
        ...warnings,
      ],
    };
  }

  // --- row 4: terminal done, with THE HEADLINE RULE ---------------------------
  if (terminalStatus === 'done') {
    if (looksEmpty(result)) {
      // The one case where `done` is a lie: agy exited 0 and delivered nothing.
      return {
        ...base,
        status: 'failed',
        endedAt: endedAt ?? now,
        warnings: [
          {
            code: 'suspicious_success',
            message: "agy reported 'done' but produced no usable output — not a clean success",
          },
          ...warnings,
        ],
      };
    }
    // Real output. `warnings:true` beside it is said in WORDS on the line, not
    // by recolouring a check: harness/normalize.ts is explicit that a non-empty
    // result with a warnings flag stays succeeded, and TERMINAL-UI.md L85-87
    // reserves red for real failures.
    return { ...base, status: 'succeeded', endedAt: endedAt ?? now };
  }

  // --- row 4b: supervisor died ------------------------------------------------
  // The node-side reader (harness/agent-smith.ts) proves the owner pid is dead and
  // leaves `.agent-smith/jobs/<id>/orphaned`; this module cannot probe a pid, so it
  // honours the marker. Same verdict, same words as forge/format.ts ORPHAN_REASON.
  if (await fs.exists(orphanMarker(dir, id)).catch(() => false)) {
    return {
      ...base,
      status: 'failed',
      endedAt: toEpoch(progress?.last_event_at) ?? now,
      warnings: [{ code: 'tool_error', message: ORPHAN_REASON }, ...warnings],
    };
  }

  // --- row 5: died before writing status.json ---------------------------------
  if (logFacts.agyStatus === 'ERROR' || (logFacts.agyExit !== null && logFacts.agyExit !== 0)) {
    return { ...base, status: 'failed', endedAt: endedAt ?? now };
  }

  // --- row 6: live ------------------------------------------------------------
  if (progress !== null) {
    // Silence past the grace period escalates to `attention`. A missing
    // last_event_at yields Infinity, which escalates: we do not know the job is
    // alive, and "unknown" must never be drawn as healthy — the same asymmetry
    // as everywhere else: unknown escalates.
    const lastSeen = toEpoch(progress.last_event_at);
    const silence = lastSeen === null ? Number.POSITIVE_INFINITY : now - lastSeen;
    const status2: RadarStatus = silence > STALL_GRACE_MS ? 'attention' : 'running';
    return { ...base, status: status2, endedAt: null };
  }

  // --- row 7: no evidence either way ------------------------------------------
  // `unknown` stays its own state. harness/types.ts: it is load-bearing, never
  // collapse it into running (a lie) and never into failed (a false alarm).
  return { ...base, status: 'unknown', endedAt: null };
}

/**
 * Every job id in a jobs directory.
 *
 * Keyed on `.spec.json`, because every job has one, running or finished. Names
 * that do not classify are ignored rather than guessed at: this races agy-staff's
 * own writes and an unclassifiable name is a hypothesis, not a job.
 */
export async function discover(fs: FsLike, dir: string): Promise<string[]> {
  let entries: readonly { name: string; kind: string; size: number }[];
  try {
    entries = await fs.list(dir);
  } catch {
    // No jobs directory is the ORDINARY case — this repo spawns nothing — not an
    // error. It is the most common outcome of this function.
    return [];
  }
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'file' && entry.name.endsWith(SPEC) && entry.name.length > SPEC.length) {
      ids.add(entry.name.slice(0, -SPEC.length));
    }
  }
  return [...ids].sort();
}

/**
 * The repo the band watches when `AGY_RADAR_REPO` is unset.
 *
 * Empty, not a hardcoded path. `.agy-staff/` is per-repo state, so the repo you
 * launched Claude in IS the right answer; a developer's absolute path would
 * make the plugin report someone else's jobs on another machine. register.tsx
 * substitutes the session cwd when this is empty.
 */
export const DEFAULT_REPO = '';

/**
 * Read every job in a repo.
 *
 * Sequential on purpose. agy-staff is rewriting these files right now, and 20
 * parallel readers of one directory is the fastest way to make every read land
 * on a half-written file. The band re-polls at 3 s; serial reads of 20 small
 * files cost single-digit milliseconds.
 *
 * NEVER THROWS. One unreadable job is that job's absence, not a dead band — the
 * failure mode harness/registry.ts calls provider fault isolation, and the reason
 * surfaces are read-only projections rather than owners of the truth.
 */
export async function readAllJobs(
  fs: FsLike,
  repo: string,
  now: number,
  withReport = false,
): Promise<RadarJob[]> {
  const dir = jobsDir(repo);
  const ids = await discover(fs, dir);
  const out: RadarJob[] = [];
  for (const id of ids) {
    const job = await resolve(fs, dir, id, now, withReport).catch(() => null);
    if (job !== null) out.push(job);
  }
  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE PANE'S THREE EXTRA CALLS
 * ────────────────────────────────────────────────────────────────────────────
 * All three are thin wrappers over what is above. That is the point: the pane's
 * detail view and the band read the SAME bytes through the SAME status function,
 * so a job cannot be `running` in one surface and `succeeded` in the other. They
 * are separate functions only because the pane reads a different SHAPE (reports
 * included, one job at a time) — not because it reads a different TRUTH.
 */

/** One job by id, with its report. Null only when the job genuinely is not there. */
export async function readJob(
  fs: FsLike,
  repo: string,
  id: string,
  now: number,
): Promise<RadarJob | null> {
  return resolve(fs, jobsDir(repo), id, now, true).catch(() => null);
}

/**
 * The tool history for one job, newest last. Empty when events.jsonl is gone.
 *
 * FROM THE PANE'S OLD READER, AND THE ONE PLACE ITS LOGIC WAS BETTER: the old
 * `readEventsTail` opened the file with `node:fs`'s `open()` and read the last
 * 256 KB, because it re-polled a 500 KB file every 3 s. `$.fs` has no partial
 * read, so this reads the whole file (803 KB worst case in the real corpus,
 * against a verified 4 MiB cap) and keeps the last N entries. The cost is the
 * same order as the old code read `result.md` and the spec files anyway, and the
 * cap is a real limit: a file over 4 MiB rejects, which lands in the `catch` and
 * yields no history. The list view never calls this.
 *
 * ONLY `DONE` RECORDS ARE KEPT. agy-staff emits an ACTIVE and a DONE record per
 * step with identical tool+params, and rendering both reads as the tool having
 * run twice.
 */
export async function readToolHistory(fs: FsLike, repo: string, id: string): Promise<ToolEntry[]> {
  const text = await readTextSafe(fs, at(jobsDir(repo), id, EVENTS));
  return text === null ? [] : toolHistoryFromEvents(text);
}

/** How many tool entries the history keeps. The pane's own cap is lower. */
const HISTORY_KEEP = 200;

/** PURE: an events.jsonl body → the newest tool entries, oldest first. */
export function toolHistoryFromEvents(text: string): ToolEntry[] {
  // One entry per step_index: an ACTIVE record is replaced by its DONE/ERROR
  // record, and an ACTIVE with no terminal record yet is the tool running NOW.
  const bySteps = new Map<number, ToolEntry>();
  const order: number[] = [];
  let seq = -1;
  for (const line of text.split('\n')) {
    if (line.length < 2) continue;
    let obj: { step_update?: Record<string, unknown> };
    try {
      // The last line of a live file is routinely half-written.
      obj = JSON.parse(line) as typeof obj;
    } catch {
      continue;
    }
    const su = obj.step_update;
    if (!su || su['step_type'] !== 'tool') continue;
    const st = su['state'];
    if (st !== 'DONE' && st !== 'ERROR' && st !== 'ACTIVE') continue;

    const info = (su['tool_info'] ?? {}) as Record<string, unknown>;
    // agy writes `parameters` (an object); the forge mirror writes `input` (a string).
    const params = (info['parameters'] ?? {}) as Record<string, unknown>;
    const tool = typeof su['tool_name'] === 'string' ? su['tool_name'] : '';
    const input = typeof info['input'] === 'string' ? info['input'] : '';
    const output = typeof info['output'] === 'string' ? info['output'] : '';
    const idx = typeof su['step_index'] === 'number' ? su['step_index'] : seq--;
    if (!bySteps.has(idx)) order.push(idx);
    const prev = bySteps.get(idx);
    bySteps.set(idx, {
      // events.jsonl carries no per-record timestamp, so this is honestly null
      // rather than the enclosing job's start or the file's mtime.
      at: null,
      tool,
      label: Object.keys(params).length > 0 ? describeTool(tool, params) : (input !== '' ? (input === tool ? '' : input) : (prev?.label ?? describeTool(tool, params))),
      output: output.slice(0, 2_000),
      state: st === 'ERROR' ? 'error' : st === 'ACTIVE' ? 'active' : 'done',
    });
  }
  return order.map((i) => bySteps.get(i)!).slice(-HISTORY_KEEP);
}

/** PURE: an events.jsonl body → the newest assistant prose chunks, oldest first. */
export function transcriptFromEvents(text: string, keep = 200): string[] {
  const out: string[] = [];
  let deltaOpen = false;
  for (const line of text.split('\n')) {
    try {
      const event = JSON.parse(line) as { agent_text?: { text?: unknown; delta?: boolean }; step_update?: unknown };
      if (event.step_update) deltaOpen = false;
      const t = event.agent_text?.text;
      if (typeof t !== 'string' || t === '') continue;
      if (event.agent_text?.delta && deltaOpen && out.length > 0) out[out.length - 1] += t;
      else out.push(t);
      deltaOpen = event.agent_text?.delta === true;
    } catch { /* The final line can be incomplete while the worker appends. */ }
  }
  return out.slice(-keep).filter(t => t.trim() !== '');
}

export async function readTranscript(fs: FsLike, repo: string, id: string): Promise<string[]> {
  const text = await readTextSafe(fs, at(jobsDir(repo), id, EVENTS));
  return text === null ? [] : transcriptFromEvents(text);
}

/**
 * The order the BAND draws: live first, then terminal, newest first.
 *
 * It used to live here, next to the reader, and the pane's order lived in
 * format.ts. Two implementations of one rule is the drift this project's whole
 * "one reader, one resolver" structure exists to prevent — so the band's ordering
 * moved up to format.ts beside the pane's, where both are pure, both are tested
 * in the same place, and both are visible in the same file as the rows they
 * order. Re-exported here because ./band.ts used to import it from this module
 * and the mod's import graph should not have to care where a sort lives.
 *
 * PURE, and therefore testable with no filesystem. Ordering is where a job list
 * usually goes wrong, and an unstable order is TERMINAL-UI.md's one rule arriving
 * as a reshuffle rather than as a row count change.
 */
export { sortForBand } from './format.ts';
