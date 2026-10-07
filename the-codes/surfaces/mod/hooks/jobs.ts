/**
 * jobs.ts — read `.agy-staff/jobs/` through `$.fs` and decide what each job IS.
 *
 * WHY A READER LIVES HERE WHEN ./job-source.ts EXISTS
 * ───────────────────────────────────────────────────
 * job-source.ts is the right shape and the right rules, and this file does not
 * restate them. It exists because of one VERIFIED constraint:
 *
 *   A hooks module may import only `claude-code` and files inside the plugin's
 *   own folder. `node:fs`, `node:path` and a path escaping the plugin folder are
 *   all refused at load time:
 *     "cannot import "node:fs/promises" (from hooks/register.tsx): a hooks module
 *      imports its own files by relative path and "claude-code", nothing else"
 *     "cannot import "../../../harness/agy-staff.ts": it is outside the plugin's
 *      folder"
 *
 * job-source.ts imports `node:path` and reaches into `../../../harness/`, so it
 * cannot load in a mod (confirmed by `claude plugin test`). The engine's own
 * file access is `$.fs` — read/list/exists/stat, text only, 4 MiB cap — so this
 * reader takes an `FsLike` and is handed `$.fs` by register.tsx.
 *
 * That also means this file is where `node --test` can reach the rules, because
 * it imports no `claude-code` and no `node:` builtin. The hazard and headline-rule
 * tests run against it directly.
 *
 * IF THE PANE'S READER IS PORTED TO `$.fs`, DELETE THIS FILE and have
 * register.tsx call it. Two readers means two answers to "is this job still
 * running", which is the drift this whole project exists to eliminate. See
 * README.md §Known blocker.
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
 *   <id>.result.md              the report; only its EMPTINESS matters here
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

import { describeActivity, parseInputPreview } from './format.ts';
import { STALL_GRACE_MS } from './stale.ts';
import type { RadarJob, RadarStatus } from '../types/index.d.ts';

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
export const JOBS_SUFFIX = ['.agy-staff', 'jobs'] as const;

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
  resolved?: { mode?: string; model?: string; profile?: string };
  prompt_source?: { task?: string };
}

interface Activity {
  step_index?: number;
  tool?: string;
  input_preview?: string;
}

interface Progress {
  job_id?: string;
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
 * the real polluted file (12 blocks). It is restated here — 10 lines — because
 * a mod cannot import it (outside the plugin folder) and because the band needs
 * only a boolean, so shipping the small helper is cheaper than shipping the
 * reader behind it. IF job-source.ts is ported to `$.fs`, import its re-export
 * instead of keeping this copy: two strippers is two answers to "does this job
 * have output".
 */
function stripSystemNotifications(text: string): string {
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

/** The task title. First non-empty line of prompt_source.task, never the prompt. */
function taskTitle(spec: Spec | null): string {
  const raw = spec?.prompt_source?.task;
  if (typeof raw !== 'string') return '';
  const first = raw.split('\n').find((l) => l.trim().length > 0) ?? '';
  return first.replace(/^#\s*/, '').slice(0, 200);
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
 *      STALL_GRACE_MS (core/liveness.ts's 15 min, from stale.ts, so the band and
 *      the channel agree on when "stalled" begins).
 *   7. otherwise                          => unknown
 *
 * NO ROW SAYS "the file is gone, therefore finished." That inference is HAZARD A,
 * and the entire ordering above exists to prevent it.
 */
export async function resolve(
  fs: FsLike,
  dir: string,
  id: string,
  now: number,
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

  const terminalStatus = status?.status;
  const base = { id, startedAt, toolCount, activity, task: taskTitle(spec), warnings, report: null, reasoning, raw: {} };

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

  // --- row 5: died before writing status.json ---------------------------------
  if (logFacts.agyStatus === 'ERROR' || (logFacts.agyExit !== null && logFacts.agyExit !== 0)) {
    return { ...base, status: 'failed', endedAt: endedAt ?? now };
  }

  // --- row 6: live ------------------------------------------------------------
  if (progress !== null) {
    // Silence past the grace period escalates to `attention`. A missing
    // last_event_at yields Infinity, which escalates: we do not know the job is
    // alive, and "unknown" must never be drawn as healthy — the same asymmetry
    // core/liveness.ts documents.
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

/** The repo the band watches when `AGY_RADAR_REPO` is unset. See README. */
export const DEFAULT_REPO = '/Users/gathrid/Repos/renyi';

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
export async function readAllJobs(fs: FsLike, repo: string, now: number): Promise<RadarJob[]> {
  const dir = jobsDir(repo);
  const ids = await discover(fs, dir);
  const out: RadarJob[] = [];
  for (const id of ids) {
    const job = await resolve(fs, dir, id, now).catch(() => null);
    if (job !== null) out.push(job);
  }
  return out;
}

/**
 * The order the band draws: live first, then terminal, newest first.
 *
 * PURE and therefore testable with no filesystem. Ordering is where a job list
 * usually goes wrong, and an unstable order is TERMINAL-UI.md's one rule arriving
 * as a reshuffle rather than as a row count change.
 */
export function sortForBand(jobs: readonly RadarJob[]): RadarJob[] {
  return [...jobs].sort((a, b) => {
    const rank = (s: RadarStatus): number => (s === 'running' || s === 'attention' ? 0 : 1);
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    return (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0);
  });
}