/**
 * format.ts — agent-smith's OWN job-state format, and the pure rules over it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY WE HAVE OUR OWN FORMAT AT ALL
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Up until now this repo could only READ somebody else's state (agy-staff's
 * `.agy-staff/jobs/<jobId>.*`). Nothing here wrote anything, so "agent-smith can
 * watch workers but cannot start one" was literally true: providers/ was 3,643
 * lines of never-executed adapters and harness/ was a re-implementation of
 * somebody else's directory layout.
 *
 * Now that we spawn, the layout is OURS to decide. So we decided it here, and
 * this file is the whole decision.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LAYOUT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     <repo>/.agent-smith/jobs/<jobId>/
 *       job.json        THE ANCHOR. Always present, always rewritten whole,
 *                       atomically (write-temp + rename). Carries the full
 *                       terminal verdict AND the liveness evidence.
 *       progress.json   Live snapshot. Advisory. Rewritten at most every
 *                       PROGRESS_FLUSH_MS so a 484-tool job does not do 484
 *                       fsync-ish writes.
 *       events.jsonl    Append-only normalized ProviderEvent NDJSON. Written by
 *                       providers/ndjson.ts because we hand it our job dir as
 *                       SpawnSpec.stateDir — so all four providers get the same
 *                       four files for free.
 *       argv.json       The exact argv + cwd we spawned with. Also ndjson.ts.
 *       stderr.log      The child's stderr, verbatim. Also ndjson.ts.
 *       result.json     The verbatim JobResult from the provider adapter. Also
 *                       ndjson.ts. This is where `denied_actions` evidence
 *                       survives verbatim.
 *       result.md       The report. The thing the pane renders.
 *       cancel          Marker written the instant cancel is requested. Its
 *                       content is the ISO instant. It can exist BEFORE
 *                       job.json reaches a terminal state, so it outranks it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A DIRECTORY, NOT agy-staff's FLAT `<jobId>.suffix` FILES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three reasons, all of them about not having to guess:
 *
 *  1. "Does this job exist?" is a stat on the directory. In the flat layout it
 *     is "find the longest suffix that parses", and every reader grows a
 *     fallback chain when the file you keyed on has been deleted.
 *  2. Two files can never collide, so adding a file to the format (we added
 *     `cancel`) cannot break an existing job. In the flat layout a new suffix is
 *     a namespace decision every reader has to learn.
 *  3. `stateDir` in providers/types.ts is ALREADY a per-job directory, and
 *     ndjson.ts writes four files into it. Pointing it at this directory means
 *     the provider layer and our layer write the same directory, instead of us
 *     copying four files across afterwards.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE ANCHOR, AND WHY THERE IS ONLY ONE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * job.json is the terminal anchor and the liveness anchor, and it is the only
 * file a reader MUST be able to read. Everything else may be missing:
 * progress.json is advisory, events.jsonl is a convenience, result.md is empty
 * for a denied job.
 *
 * This is the direct answer to agy-staff's HAZARD A, where progress.json is
 * deleted on a clean success and every reader has to learn that a missing file
 * means "finished", not "missing". We simply never delete it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HEADLINE RULE, IN ONE PURE FUNCTION
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `deriveStatus()` below is the only place a terminal verdict is computed. The
 * rule it encodes, and the reason it exists:
 *
 *   ┌────────────────────────────────────────────────────────────────────┐
 *   │ A JOB THAT EXITED 0 AND DELIVERED NOTHING IS **FAILED**.           │
 *   │ agy runs headless and cannot prompt for tool permission, so a      │
 *   │ denied tool is auto-denied, agy reports status "SUCCESS", response │
 *   │ "", and the process exits 0. We verified this live against the real │
 *   │ binary (see providers/agy.ts, THE TRAP). Recording that as a clean │
 *   │ success is worse than a crash, because it is quiet.                 │
 *   └────────────────────────────────────────────────────────────────────┘
 *
 * It is enforced twice over, because the two signals fail independently:
 *   - `deniedActions` non-empty  → failed  (the adapter's own detection)
 *   - ok === true, report empty  → failed  (the paranoid net; also covers a
 *     provider that does not report denials at all)
 */

import type { ProgressDigest } from '../surfaces/mod/types/index.d.ts';
import {
  AUTH_RE, BUSY_RE, COMPATIBILITY_RE, DENIED_RE, NETWORK_RE, NO_OUTPUT_RE, ORPHAN_RE, QUOTA_RE, RATE_LIMIT_RE,
  REASONS, START_RE, TIMEOUT_RE, deniedReason, reasonFromText,
} from '../surfaces/mod/hooks/reasons.ts';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/** Per-repo job root, relative to the repo. Ours; nothing else reads it as truth. */
export const JOBS_DIR_SEGMENTS = ['.agent-smith', 'jobs'] as const;

/**
 * Bumped when the on-disk shape changes incompatibly.
 *
 * A reader that finds a manifest with a higher `schema` must refuse it rather
 * than half-understand it: reading a v2 manifest with v1 rules produces exactly
 * the confident wrong answers this project exists to prevent.
 */
export const SCHEMA_VERSION = 1;

/** How often progress.json may be rewritten. See forge/writer.ts. */
export const PROGRESS_FLUSH_MS = 250;

/** File names inside a job directory. Named once, referenced everywhere. */
export const FILES = {
  job: 'job.json',
  progress: 'progress.json',
  view: 'view.json',
  events: 'events.jsonl',
  argv: 'argv.json',
  stderr: 'stderr.log',
  result: 'result.json',
  report: 'result.md',
  cancel: 'cancel',
  /** Marker written when a steer interrupts a running turn across or within processes. */
  cancelSteer: 'cancel.steer',
  /** Append-only NDJSON log of SteerEntry records for this job. */
  steer: 'steer.jsonl',
  /**
   * Child job ID, written after the continuation anchor exists but before the
   * parent's terminal manifest stamps `supersededBy`. Closes the finish window
   * for `resolveHead` readers (cancel/status) during a chained turn.
   */
  steerHead: 'steer.head',
  /** The acceptance checks a job was spawned with, so resume_job can inherit them. */
  checksSpec: 'checks-spec.json',
} as const;

export type SteerDelivery = 'queue' | 'interrupt';

export interface WatchedFileSigs {
  readonly repoSig: string;
  readonly cwdSig: string;
}

export interface SteerEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly prompt: string;
  readonly context?: string | undefined;
  readonly files?: readonly string[] | undefined;
  readonly delivery: SteerDelivery;
}

/**
 * The id segment that marks a job as OURS.
 *
 * WHY A MARKER IN THE ID RATHER THAN ONLY IN THE FILES: the mod band renders
 * ids, and "these six jobs I started" versus "those fourteen jobs a previous
 * harness left behind" is a distinction a human needs to be able to make by
 * looking. `implement-smith-3f9a2c71` says it in three characters.
 *
 * It also makes collisions with agy-staff's `<mode>-<word>-<8 hex>` structurally
 * impossible in practice rather than merely improbable.
 */
export const ID_MARKER = 'smith';

/** Lifecycle state of a forge job. Four states, matching ObservedStatus 1:1. */
export type ForgeStatus = 'running' | 'succeeded' | 'failed' | 'canceled';

export function isForgeStatus(v: unknown): v is ForgeStatus {
  return v === 'running' || v === 'succeeded' || v === 'failed' || v === 'canceled';
}

/** The statuses a job never leaves. `running` is the only non-terminal one. */
export function isTerminalForgeStatus(s: unknown): s is Exclude<ForgeStatus, 'running'> {
  return s === 'succeeded' || s === 'failed' || s === 'canceled';
}

/** One tool call, as the writer remembers it between events. */
export interface ForgeActivity {
  readonly stepIndex: number;
  readonly tool: string;
  readonly input?: string | undefined;
  readonly status: 'active' | 'done' | 'error' | 'denied';
}

export interface ForgeDenial {
  readonly action?: string | undefined;
  readonly displayName?: string | undefined;
  /** The adapter judged the run delivered its report despite this denial. */
  readonly nonfatal?: boolean | undefined;
}

/**
 * job.json. The anchor.
 *
 * Note what is NOT here: the full prompt. `task` is the first non-empty line
 * and `promptChars` is its length. The full prompt can be megabytes of the
 * user's source code, and this file is read by a UI that re-reads it every three
 * seconds forever.
 */
export interface ForgeManifest {
  readonly schema: number;
  readonly jobId: string;
  /** Additive fields are optional when reading manifests written by v1. */
  readonly name?: string;
  readonly workerId?: string;
  readonly role?: string;
  readonly latestSummary?: string | null;
  readonly summarySource?: 'worker' | null;
  /** Registry key: agy | codex | opencode | claude | kimi. */
  readonly provider: string;
  /** Stage/role name: implement | review | moderate | custom. */
  readonly mode: string;
  /** Compat: requested model, or the one the provider reported. Prefer modelResolved. */
  readonly model: string | null;
  readonly modelRequested?: string | null;
  readonly modelResolved?: string | null;
  readonly modelSource?: 'requested' | 'harness-config' | 'reported' | 'unknown';
  /** True when the prompt sent to the provider starts with the worker brief (forge/brief.ts). */
  readonly preambleApplied?: boolean;
  readonly sandbox?: string;
  readonly sandboxFlags?: readonly string[];
  readonly readOnlyRequested?: boolean;
  readonly readOnlyEnforced?: boolean;
  readonly effort: string | null;
  readonly cwd: string;
  /** First non-empty prompt line, `#`-stripped, ≤200 chars. The pane's task cell. */
  readonly task: string;
  readonly promptChars: number;
  /** True only when the caller explicitly opted in. Never defaulted on. */
  readonly unrestricted: boolean;
  /** Set from the provider's init/conversation id when one exists. */
  readonly conversation: string | null;

  /** pid of the supervising process (JobWriter.start). Absent on legacy manifests. */
  readonly ownerPid?: number;

  readonly status: ForgeStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly exitCode: number | null;

  /** The provider adapter's JobStatus. Diagnostic; `status` is the verdict. */
  readonly jobStatus: string | null;
  readonly error: string | null;
  /**
   * Why it failed, in two to four words (surfaces/mod/hooks/reasons.ts): what
   * notices, the band and `status` show. `error` keeps the full detail. Absent on
   * jobs recorded before it existed; readers derive it with reasonFromText.
   */
  readonly reason?: string | null;
  readonly deniedActions: readonly ForgeDenial[];
  readonly usage: Readonly<Record<string, number>> | null;
  readonly toolCalls: number;
  /**
   * Tool calls that ended in an error state (distinct steps). Evidence, not a
   * verdict: a worker that recovers from a failed `read` still succeeds.
   * Absent until the first tool error.
   */
  readonly toolErrors?: number;
  /**
   * True when the job failed before doing any work: zero tool calls and either
   * finished within FAILED_EARLY_MS or its first event was an error. Usually a
   * route problem (model not available in the region, account out of funds);
   * `error` keeps the provider's text verbatim. Absent otherwise.
   */
  readonly failedEarly?: boolean;

  /** Set when this job is one stage of a pipeline. */
  readonly pipeline: string | null;
  readonly stage: string | null;
  readonly attempt: number | null;

  /**
   * Cheap git reference taken at spawn when `cwd` is a git repo (absent
   * otherwise). `dirty` = paths from `git status --porcelain` at that instant.
   */
  readonly gitBaseline?: GitBaseline;
  /**
   * Paths that differ from the baseline at finish: new/modified/deleted since
   * start, excluding paths that were already dirty and are unchanged. Present
   * only when a baseline was captured. Capped at CHANGED_FILES_CAP.
   *
   * LIMITATION: it is a worktree diff, not an attribution. Concurrent jobs (or
   * the operator) editing the same worktree are indistinguishable, so one job's
   * changedFiles can include another's edits. Read-only modes normally yield [].
   */
  readonly changedFiles?: readonly string[];
  readonly changedFilesTruncated?: boolean;
  /**
   * True when `changedFiles` could not be computed at finish (no git baseline,
   * git failed or timed out, or the cwd was gone). An absent `changedFiles` then
   * means "unknown", never "no edits". Absent when changedFiles is known.
   */
  readonly changedFilesUnknown?: boolean;
  /** True when the job's cwd no longer existed at finish, so nothing in it could be checked. */
  readonly cwdMissingAtFinish?: boolean;
  /**
   * Paths that changed while this job ran but that none of this job's own tool
   * calls mention: another job's or the operator's edits (or shell side effects).
   * Present only when the job's tool inputs were captured.
   */
  readonly unattributedFiles?: readonly string[];
  /** Wall-clock limit this job was spawned with (0 = no timer); lets a non-owning process report it. */
  readonly timeoutMs?: number;
  /** Continuation job ID when this turn was superseded by a steered turn. */
  readonly supersededBy?: string | null;
  /** Parent job ID when this turn was created by steering an earlier turn. */
  readonly steeredFrom?: string | null;
  /** Number of unconsumed queued steers in steer.jsonl. */
  readonly pendingSteers?: number;
  /** Declared brief/spec files synced at turn start, mapped to their repo + cwd signatures. */
  readonly watchedFiles?: Readonly<Record<string, WatchedFileSigs>>;
  /** Watched brief/spec files that diverged in repo (or externally in cwd) while the turn ran. */
  readonly staleReads?: readonly string[];
}

export interface GitBaseline {
  readonly head: string | null;
  readonly dirty: readonly string[];
}

/**
 * Pure: split changed paths into those this job's own tool inputs mention (by full
 * path or basename) and those it never touched. With no captured input there is
 * nothing to attribute against, so everything stays attributed.
 */
export function attributeChanged(
  files: readonly string[],
  toolInputs: string,
): { mine: string[]; other: string[] } {
  if (toolInputs === '') return { mine: [...files], other: [] };
  const mine: string[] = [];
  const other: string[] = [];
  for (const p of files) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    (toolInputs.includes(p) || (base !== '' && toolInputs.includes(base)) ? mine : other).push(p);
  }
  return { mine, other };
}

/** Max entries kept in `changedFiles`. */
export const CHANGED_FILES_CAP = 200;

/** Paths that are our own bookkeeping, never a worker's change. */
export function isForgeStatePath(p: string): boolean {
  return p === '.agent-smith' || p.startsWith('.agent-smith/') || p === '.agy-staff' || p.startsWith('.agy-staff/');
}

/**
 * Pure: which paths changed since the baseline.
 *
 * `nowDirty` is the worktree's dirty set at finish; `modifiedBaseline` is the
 * subset of baseline-dirty paths whose content signature moved (writer-computed);
 * `committed` are paths touched by commits made since the baseline HEAD.
 */
export function diffChangedFiles(
  baseline: GitBaseline,
  nowDirty: readonly string[],
  modifiedBaseline: readonly string[] = [],
  committed: readonly string[] = [],
): { files: string[]; truncated: boolean } {
  const was = new Set(baseline.dirty);
  const out = new Set<string>();
  for (const p of nowDirty) if (!was.has(p)) out.add(p);
  // Dirty at start and clean now: the worker reverted/committed it.
  const now = new Set(nowDirty);
  for (const p of baseline.dirty) if (!now.has(p)) out.add(p);
  for (const p of modifiedBaseline) out.add(p);
  for (const p of committed) out.add(p);
  const all = [...out].filter((p) => !isForgeStatePath(p)).sort();
  return { files: all.slice(0, CHANGED_FILES_CAP), truncated: all.length > CHANGED_FILES_CAP };
}

/** progress.json. Advisory liveness evidence. */
export interface ForgeProgress {
  readonly jobId: string;
  readonly name?: string;
  readonly workerId?: string;
  readonly role?: string;
  readonly latestSummary?: string | null;
  readonly summarySource?: 'worker' | null;
  readonly lastEventAt: string;
  readonly recentActivities: readonly ForgeActivity[];
  readonly lastActivity?: ForgeActivity | null;
  readonly latestText: string | null;
  readonly toolCalls: number;
  /**
   * Edit tool calls that ENDED without error (not started, not failed, not
   * denied): the cwd rule's evidence that a job wrote. Unlike
   * `digest.editedCount`, which counts at start for the pane. Absent only on
   * files written before this counter existed.
   */
  readonly editsCompleted?: number;
  /** Tool calls that ended in an error state so far. Absent until the first one. */
  readonly toolErrors?: number;
  /**
   * Last heartbeat from the process owner (providers/ndjson.ts): the worker's
   * CLI process was running at this time. Moves without events; never moves
   * lastEventAt. Absent for jobs from builds before heartbeats, and until the first beat.
   */
  readonly lastAliveAt?: string;
  /** The worker CLI's pid (its process group leader), from the heartbeat. */
  readonly workerPid?: number;
  readonly warnings: readonly string[];
  /** What the worker has done so far, from its tool calls. */
  readonly digest?: ProgressDigest;
  /** Number of unconsumed queued steers in steer.jsonl. */
  readonly pendingSteers?: number;
}

export type ForgeViewEvent =
  | { sequence: number; kind: 'assistant'; at: string; text: string }
  | { sequence: number; kind: 'tool'; at: string; stepIndex: number; tool: string; input: string; output: string; state: 'active' | 'done' | 'error' };

/** Bounded detail projection. Lists use job/progress/acceptance, never this file. */
export interface ForgeView {
  readonly schema: 1;
  readonly prompt: string;
  readonly preamble: string | null;
  readonly truncated: boolean;
  readonly transcript: readonly string[];
  /** Missing on snapshots written before ordered activity was supported. */
  readonly timeline?: readonly ForgeViewEvent[];
  readonly tools: readonly {
    stepIndex: number; at: string; tool: string; input: string; output: string;
    state: 'active' | 'done' | 'error';
  }[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Paths — pure string joins, exported so tests never touch a filesystem
 * ──────────────────────────────────────────────────────────────────────────── */

export function jobsDir(repo: string): string {
  return path.join(repo, ...JOBS_DIR_SEGMENTS);
}

/** Where `agent-smith gc` moves settled jobs instead of deleting them. */
export function archivedJobsDir(repo: string): string {
  return path.join(repo, '.agent-smith', 'archive', 'jobs');
}

export function jobDir(repo: string, jobId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(jobId) || jobId === '.' || jobId === '..') {
    throw new Error(`invalid job id "${jobId}"`);
  }
  return path.join(jobsDir(repo), jobId);
}

export function jobFile(repo: string, jobId: string, name: string): string {
  return path.join(jobDir(repo, jobId), name);
}

/** The anchor, parsed. Throws when absent or malformed: callers decide what that means. */
export function readManifest(repo: string, jobId: string): ForgeManifest {
  return JSON.parse(readFileSync(jobFile(repo, jobId, FILES.job), 'utf8')) as ForgeManifest;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Ids
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A fresh job id: `<mode>-smith-<8 hex>`.
 *
 * The mode is sanitised to `[a-z0-9]` because the id becomes a directory name.
 * A mode of `Review/Docs` must not be able to escape.
 */
export function newJobId(mode: string): string {
  const safeMode = mode.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120).replace(/-+$/g, '');
  const prefix = safeMode === '' ? 'job' : safeMode;
  return `${prefix}-${ID_MARKER}-${randomBytes(4).toString('hex')}`;
}

/** Is this id one of ours? Used to keep the two readers from double-counting. */
export function isForgeJobId(jobId: string): boolean {
  return /(?:^|-)smith-[0-9a-f]{8}$/i.test(jobId);
}

/** The first non-empty line of a prompt, `#`-stripped, capped. The task cell. */
export function taskTitle(prompt: string): string {
  const first = prompt.split('\n').find((l) => l.trim().length > 0) ?? '';
  return first.replace(/^#\s*/, '').trim().slice(0, 200);
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE HEADLINE RULE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A nonempty final answer is a deliverable, including deliberately short answers.
 * Provider completion and executable acceptance remain separate requirements.
 */
export const MIN_USEFUL_CHARS = 1;

/** Is there no usable output? See MIN_USEFUL_CHARS. */
export function looksEmpty(text: string | null | undefined): boolean {
  if (text === null || text === undefined) return true;
  return text.trim().length < MIN_USEFUL_CHARS;
}

/** The input to the one function that decides a terminal verdict. */
export interface StatusDerivation {
  /**
   * A verdict already reached (cancel marker, an earlier finish). When present
   * it is final — this function never upgrades a terminal state.
   */
  readonly alreadyTerminal?: ForgeStatus | null | undefined;
  /** The provider adapter's `JobResult.ok`. Null/undefined ⇒ still running. */
  readonly ok?: boolean | null | undefined;
  /** The provider adapter's `JobResult.status`. Diagnostic, and a fallback. */
  readonly jobStatus?: string | null | undefined;
  /** The provider adapter's `deniedActions`. THE TRAP's primary signal. */
  readonly deniedActions?: readonly ForgeDenial[] | null | undefined;
  /** The report body. Empty ⇒ nothing was delivered, whatever the exit code. */
  readonly report?: string | null | undefined;
  /** The job's cwd was gone at finish: no edit or check in it can be verified. */
  readonly cwdMissing?: boolean | undefined;
  /** The job was meant to write (implement/verify mode) or its events show edits. */
  readonly writing?: boolean | undefined;
}

/** deriveStatus's reason when a writing job's cwd vanished before it could be checked. */
export const CWD_GONE_REASON = 'working directory gone; nothing could be verified';

/** A failure this soon after start, with no tool call, is a route failure, not the work. */
export const FAILED_EARLY_MS = 20_000;

/** Writing modes: a vanished cwd makes their success unverifiable. */
export function isWritingMode(mode: string | null | undefined): boolean {
  return mode === 'implement' || mode === 'verify';
}

/**
 * deriveStatus's cwd inputs, from what the caller can prove: whether `cwd`
 * still exists, and whether the job was meant to write (its mode) or is known
 * to have edited. An empty or absent cwd is never "missing" (nothing to check).
 */
export function cwdFacts(cwd: string | null | undefined, mode: string | null | undefined, edited = false): { cwdMissing: boolean; writing: boolean } {
  return { cwdMissing: typeof cwd === 'string' && cwd !== '' && !existsSync(cwd), writing: isWritingMode(mode) || edited };
}

export interface StatusVerdict {
  readonly status: ForgeStatus;
  /**
   * True when the provider claimed success and we are refusing to believe it.
   * Distinct from `failed`: a hard failure needs no explanation, a suspicious
   * success needs one, and the pane colours them differently.
   */
  readonly suspicious: boolean;
  readonly reason: string | null;
  /** A non-fatal caveat on a success (e.g. some tool calls were denied); surfaced as a warning. */
  readonly note?: string | null;
}

/**
 * THE ONLY PLACE A JOB IS DECLARED FINISHED, AND IT IS PURE.
 *
 * Precedence, highest first. Each row is here because removing it produced a
 * specific, observed lie:
 *
 *   1. alreadyTerminal            ⇒ that state. A cancel marker outranks the
 *      worker exiting, because a job we killed has no trustworthy terminal
 *      state of its own — whatever the CLI managed to flush on the way down is
 *      not what happened to the task.
 *   2. deniedActions non-empty    ⇒ failed, suspicious. agy exited 0, said
 *      "SUCCESS", returned "" and did nothing. THE TRAP. Unless every denial
 *      is nonfatal and a report was delivered: then succeeded, with a note —
 *      but only after rule 3b has passed.
 *   3. ok === false               ⇒ failed. The adapter already weighed exit
 *      code against the result event; we do not second-guess it.
 *   3b. cwd gone, writing job     ⇒ failed, suspicious. Its edits and checks
 *      cannot be verified; a nonfatal denial does not excuse it.
 *   4. ok === true, report empty  ⇒ failed, suspicious. The net for every
 *      provider that does not report denials. "You asked me nothing and I said
 *      nothing" is only a success when the job also made no tool calls — which
 *      the adapter has already ruled on by the time we get here.
 *   5. ok === true                ⇒ succeeded.
 *   6. no verdict yet             ⇒ running.
 *
 * Rule 4 is the one that exists because of what this project is for. Note it
 * fires on EMPTINESS, not on a warning flag: an empty report is empty whether or
 * not the provider was kind enough to mention it, and a warning flag that gates
 * this is a warning flag that can be forgotten.
 */
function denialNames(denials: readonly ForgeDenial[]): string[] {
  return denials
    .map((x) => x.displayName ?? x.action)
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
}

/** `view_file` or `view_file +2`; empty when no denial has a name. */
function deniedNames(denials: readonly ForgeDenial[]): string {
  const names = [...new Set(denialNames(denials))];
  if (names.length === 0) return '';
  return names.length === 1 ? names[0]! : `${names[0]} +${names.length - 1}`;
}

/**
 * What a failed finish stores: the full `error` (the adapter's own text, else the
 * verdict's reason; never both) and the short `reason`. Not failed: both null-ish.
 */
/** Keep both ends of a long error: the cause leads, the stderr tail closes. */
function elide(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  return `${text.slice(0, head)} … ${text.slice(text.length - (max - head - 3))}`;
}

export function failureFields(
  verdict: StatusVerdict,
  result: { readonly status: string; readonly error?: string | undefined; readonly deniedActions?: readonly ForgeDenial[] | undefined },
  maxError = 1_200,
): { error: string | null; reason: string | null } {
  const adapterError = (result.error ?? '').trim();
  const error = adapterError !== '' ? elide(adapterError, maxError) : verdict.reason;
  if (verdict.status !== 'failed') return { error, reason: null };
  const denials = result.deniedActions ?? [];
  const fatal = denials.length > 0 && verdict.reason !== null && DENIED_RE.test(verdict.reason);
  let reason: string;
  if (fatal) reason = deniedReason(denialNames(denials));
  else if (result.status === 'timeout') reason = REASONS.timedOut;
  else if (verdict.reason === REASONS.noOutput) reason = REASONS.noOutput;
  else if (verdict.reason === CWD_GONE_REASON && adapterError === '') reason = 'working directory gone';
  else reason = reasonFromText(adapterError !== '' ? adapterError : verdict.reason);
  return { error, reason };
}

export function deriveStatus(d: StatusDerivation): StatusVerdict {
  const terminal = d.alreadyTerminal ?? null;
  if (terminal === 'canceled') return { status: 'canceled', suspicious: false, reason: 'canceled' };
  if (terminal === 'succeeded') return { status: 'succeeded', suspicious: false, reason: null };
  if (terminal === 'failed') {
    return { status: 'failed', suspicious: false, reason: REASONS.workerError };
  }

  if (d.ok === null || d.ok === undefined) {
    return { status: 'running', suspicious: false, reason: null };
  }

  const denials = d.deniedActions ?? [];
  // Denials the adapter marked non-fatal (a delivered report plus denied calls,
  // e.g. a reviewer that wanted a shell) do not fail the job, whatever the
  // provider. `action: 'tool'` is the pre-flag claude encoding, still on disk.
  const nonfatalOnly = denials.length > 0 && d.ok === true && !looksEmpty(d.report) && denials.every((x) => x.nonfatal === true || x.action === 'tool');
  if (denials.length > 0 && !nonfatalOnly) {
    return { status: 'failed', suspicious: true, reason: deniedReason(denialNames(denials)) };
  }

  if (d.ok === false) {
    return {
      status: 'failed',
      suspicious: false,
      reason: d.jobStatus === 'timeout' ? REASONS.timedOut : REASONS.workerError,
    };
  }

  // A writing job whose cwd vanished cannot show its edits or pass a check:
  // its "done" is a claim with nothing behind it. A read-only job's report is
  // the deliverable, so it stands (the writer records a warning instead).
  // Checked before the nonfatal-denial success, which would otherwise let a
  // denied call excuse a writing job from it.
  if (d.cwdMissing === true && d.writing === true) {
    return { status: 'failed', suspicious: true, reason: CWD_GONE_REASON };
  }

  if (nonfatalOnly) {
    return {
      status: 'succeeded',
      suspicious: false,
      reason: null,
      note: `${denials.length} ${denials.length === 1 ? 'call' : 'calls'} denied` + (deniedNames(denials) === '' ? '' : `: ${deniedNames(denials)}`),
    };
  }

  if (looksEmpty(d.report)) {
    return {
      status: 'failed',
      suspicious: true,
      reason: REASONS.noOutput,
    };
  }

  return { status: 'succeeded', suspicious: false, reason: null };
}

/**
 * Warnings the reader attaches to a snapshot.
 *
 * Derived here rather than stored, so the rule that a suspicious success is
 * flagged lives next to the rule that produces the status it is suspicious about.
 */
export function warningsFor(v: StatusVerdict, progress: ForgeProgress | null): string[] {
  const out: string[] = [];
  if (v.suspicious) out.push(v.reason ?? 'suspicious success');
  if (v.note) out.push(v.note);
  for (const w of progress?.warnings ?? []) out.push(w);
  return out;
}

/**
 * Should progress.json be rewritten now?
 *
 * A 28-minute job made 484 tool calls. Writing a file per event is 484 writes
 * the UI never needed; the band polls every 3 s, so anything under that is
 * invisible. The comparison is `>=` and not `>` so a flush is never starved by
 * an event stream that arrives faster than the interval.
 */
export function shouldFlush(lastFlushMs: number, nowMs: number, minMs = PROGRESS_FLUSH_MS): boolean {
  return nowMs - lastFlushMs >= minMs;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Orphans — a `running` job whose supervisor died
 * ──────────────────────────────────────────────────────────────────────────── */

/** Default wall-clock budget for one job (re-exported by service.ts). */
export const DEFAULT_TIMEOUT_MS = 45 * 60_000;

/** A legacy manifest (no ownerPid) is orphaned only when silent this long. */
export const LEGACY_ORPHAN_AFTER_MS = 2 * DEFAULT_TIMEOUT_MS;

export const ORPHAN_REASON = REASONS.serverStopped;
export const CANCEL_ORPHAN_REASON = 'canceled; server stopped before confirming';

/** `kill(pid, 0)`: ESRCH means gone; EPERM means it exists but is not ours. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The recorded owner pid when it is a usable one (positive integer), else null (legacy or malformed). */
export function validOwnerPid(m: { readonly ownerPid?: unknown }): number | null {
  const pid = m.ownerPid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** True when the manifest names an owner process that is still running. */
export function ownerAlive(m: { readonly ownerPid?: unknown }): boolean {
  const pid = validOwnerPid(m);
  return pid !== null && isPidAlive(pid);
}

/**
 * THE orphan rule, pure. The caller guarantees there is no terminal result.
 * Returns the verdict to report, or null if the job is not (provably) orphaned.
 * A cancel request outranks the orphan: when the supervisor is dead or unknown
 * the operator's intent is what happened, so the verdict is `canceled`, not
 * `failed`. A live supervisor still returns null; it will settle the request.
 *
 * `lastSeenMs` is the newest liveness evidence the caller has (updatedAt,
 * progress.lastEventAt); only the legacy no-pid path uses it.
 */
export function deriveOrphan(
  m: { readonly status: string; readonly ownerPid?: number | undefined; readonly createdAt?: string | undefined },
  lastSeenMs: number | null,
  nowMs: number,
  alive: (pid: number) => boolean = isPidAlive,
  cancelRequested = false,
): StatusVerdict | null {
  if (m.status !== 'running') return null;
  const verdict: StatusVerdict = cancelRequested
    ? { status: 'canceled', suspicious: false, reason: CANCEL_ORPHAN_REASON }
    : { status: 'failed', suspicious: true, reason: ORPHAN_REASON };
  if (typeof m.ownerPid === 'number') return alive(m.ownerPid) ? null : verdict;
  const times = [lastSeenMs, m.createdAt === undefined ? null : Date.parse(m.createdAt)]
    .filter((t): t is number => t !== null && Number.isFinite(t));
  if (times.length === 0) return null;
  const ref = Math.max(...times);
  return nowMs - ref > LEGACY_ORPHAN_AFTER_MS ? verdict : null;
}


/* ────────────────────────────────────────────────────────────────────────────
 * nextAction — what the orchestrating agent should do about a bad terminal state
 * ──────────────────────────────────────────────────────────────────────────── */

/** The facts nextActionFor reads. Every reader can supply these from what it already has. */
export interface NextActionInput {
  readonly status: string | null | undefined;
  readonly jobStatus?: string | null | undefined;
  readonly error?: string | null | undefined;
  readonly report?: string | null | undefined;
  readonly exitCode?: number | null | undefined;
  readonly deniedCount?: number | undefined;
  readonly unrestricted?: boolean | undefined;
  /** A queued steer was dropped because this turn failed. */
  readonly steerNotApplied?: boolean | undefined;
  /** manifest.failedEarly: failed before any tool call (route/model/account). */
  readonly failedEarly?: boolean | undefined;
}

/**
 * THE one place a next step is derived. Derived on read, never stored in
 * job.json. Null for running/succeeded jobs. A short imperative for the
 * orchestrating agent, not for a human.
 */
export function nextActionFor(i: NextActionInput): string | null {
  const base = baseNextAction(i);
  return base !== null && i.steerNotApplied === true
    ? `${base} A queued steer was not applied: include it in your resume_job prompt.`
    : base;
}

function baseNextAction(i: NextActionInput): string | null {
  const status = i.status ?? null;
  if (status !== 'failed') return null;
  const err = i.error ?? '';
  if (ORPHAN_RE.test(err)) return 'Server stopped: resume_job if it has a conversation, else rerun.';
  if (i.jobStatus === 'denied' || (i.deniedCount ?? 0) > 0 || DENIED_RE.test(err)) {
    return i.unrestricted === true
      ? 'Denied even with unrestricted:true: narrow the task or give an approved path.'
      : 'Ask the user before retrying with unrestricted:true.';
  }
  if (AUTH_RE.test(err)) return 'Not logged in: fix the provider login, then retry.';
  if (BUSY_RE.test(err)) return 'Provider busy (temporary); resume_job to continue.';
  if (QUOTA_RE.test(err)) return 'Out of credits on the provider account.';
  if (RATE_LIMIT_RE.test(err)) return 'Rate limited; resume_job after a short wait.';
  if (COMPATIBILITY_RE.test(err)) return 'Bad flag or model: run agent-smith doctor, then fix the request.';
  if (START_RE.test(err)) return "Couldn't start: run agent-smith doctor.";
  // After the specific diagnoses, before the generic ones: resuming a route
  // that failed before any work just fails again.
  if (i.failedEarly === true && i.jobStatus !== 'timeout') {
    return 'Route failed before any work (model/account): pick another model from list_capabilities or fix the account.';
  }
  if (i.jobStatus === 'timeout' || TIMEOUT_RE.test(err)) {
    return 'Raise timeoutMs or split the task; resume_job keeps context.';
  }
  if (NETWORK_RE.test(err)) return 'Network error: retry once with resume_job or a new spawn.';
  if (NO_OUTPUT_RE.test(err) || (i.exitCode === 0 && looksEmpty(i.report))) {
    return 'No output: ask for a final answer via resume_job, or rerun.';
  }
  return 'Read status.error and warnings before retrying.';
}
