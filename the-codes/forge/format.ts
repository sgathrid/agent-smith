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

import path from 'node:path';
import { randomBytes } from 'node:crypto';

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
  /** Written by the first reader to prove the owner is dead. Never edits job.json. */
  orphaned: 'orphaned',
} as const;

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
  /** Registry key: agy | codex | opencode | claude. */
  readonly provider: string;
  /** Stage/role name: implement | review | moderate | custom. */
  readonly mode: string;
  /** Compat: requested model, or the one the provider reported. Prefer modelResolved. */
  readonly model: string | null;
  readonly modelRequested?: string | null;
  readonly modelResolved?: string | null;
  readonly modelSource?: 'requested' | 'harness-config' | 'reported' | 'unknown';
  /** True when the mode preset's preamble was prepended to the prompt sent to the provider. */
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
  readonly deniedActions: readonly ForgeDenial[];
  readonly usage: Readonly<Record<string, number>> | null;
  readonly toolCalls: number;

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
   * Paths that changed while this job ran but that none of this job's own tool
   * calls mention: another job's or the operator's edits (or shell side effects).
   * Present only when the job's tool inputs were captured.
   */
  readonly unattributedFiles?: readonly string[];
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
  readonly latestText: string | null;
  readonly toolCalls: number;
  readonly warnings: readonly string[];
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

export function jobDir(repo: string, jobId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(jobId) || jobId === '.' || jobId === '..') {
    throw new Error(`invalid job id "${jobId}"`);
  }
  return path.join(jobsDir(repo), jobId);
}

export function jobFile(repo: string, jobId: string, name: string): string {
  return path.join(jobDir(repo, jobId), name);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Ids
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A fresh job id: `<mode>-smith-<8 hex>`.
 *
 * The mode is sanitised to `[a-z0-9]` because the id becomes a directory name
 * and, through the compat mirror, a filename in somebody else's directory. A
 * mode of `Review/Docs` must not be able to escape.
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
 * Below this many characters there is no deliverable.
 *
 * The number is not arbitrary and not ours: harness/normalize.ts uses `< 8` and
 * so does the mod's `looksEmpty`. All three readers must agree, or the same job
 * is a green check in the pane and a red row in the channel.
 */
export const MIN_USEFUL_CHARS = 8;

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
 *      "SUCCESS", returned "" and did nothing. THE TRAP.
 *   3. ok === false               ⇒ failed. The adapter already weighed exit
 *      code against the result event; we do not second-guess it.
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
export function deriveStatus(d: StatusDerivation): StatusVerdict {
  const terminal = d.alreadyTerminal ?? null;
  if (terminal === 'canceled') return { status: 'canceled', suspicious: false, reason: 'cancelled by operator' };
  if (terminal === 'succeeded') return { status: 'succeeded', suspicious: false, reason: null };
  if (terminal === 'failed') {
    return { status: 'failed', suspicious: false, reason: `worker reported failure (${d.jobStatus ?? 'unknown'})` };
  }

  if (d.ok === null || d.ok === undefined) {
    return { status: 'running', suspicious: false, reason: null };
  }

  const denials = d.deniedActions ?? [];
  // Denials the provider itself marked non-fatal (action 'tool': a delivered report
  // plus denied calls, e.g. a read-only reviewer that wanted a shell) do not fail
  // the job. agy's soft-denials carry other actions and keep failing below.
  if (denials.length > 0 && d.ok === true && !looksEmpty(d.report) && denials.every((x) => x.action === 'tool')) {
    return {
      status: 'succeeded',
      suspicious: false,
      reason: null,
      note: `${denials.length} tool call(s) were denied by the permission policy; the report was delivered but some checks may not have run.`,
    };
  }
  if (denials.length > 0) {
    const names = denials
      .map((x) => x.displayName ?? x.action)
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
      .join(', ');
    return {
      status: 'failed',
      suspicious: true,
      reason:
        `worker soft-denied ${denials.length} tool action(s)` +
        (names === '' ? '' : ` (${names})`) +
        ' — it exited 0 and reported success while doing nothing. ' +
        'This is NOT a clean success.',
    };
  }

  if (d.ok === false) {
    return {
      status: 'failed',
      suspicious: false,
      reason: `worker reported failure (${d.jobStatus ?? 'unknown'})`,
    };
  }

  if (looksEmpty(d.report)) {
    return {
      status: 'failed',
      suspicious: true,
      reason:
        'worker reported success but delivered no usable output — ' +
        'treating as failed, not as a clean success.',
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

export const ORPHAN_REASON = 'supervisor process exited before the job finished (orphaned)';

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

/**
 * THE orphan rule, pure. The caller guarantees there is no terminal result and
 * no cancel marker. Returns the verdict to report, or null if the job is not
 * (provably) orphaned.
 *
 * `lastSeenMs` is the newest liveness evidence the caller has (updatedAt,
 * progress.lastEventAt); only the legacy no-pid path uses it.
 */
export function deriveOrphan(
  m: { readonly status: string; readonly ownerPid?: number | undefined; readonly createdAt?: string | undefined },
  lastSeenMs: number | null,
  nowMs: number,
  alive: (pid: number) => boolean = isPidAlive,
): StatusVerdict | null {
  if (m.status !== 'running') return null;
  const verdict: StatusVerdict = { status: 'failed', suspicious: true, reason: ORPHAN_REASON };
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
}

const NETWORK_RE = /network issue|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|connection (?:reset|refused|closed|error)|temporarily unavailable|overloaded/i;
const TIMEOUT_RE = /timed? ?out|exceeded the .*budget|\btimeout\b/i;

/**
 * THE one place a next step is derived. Derived on read, never stored in
 * job.json. Null for running/succeeded jobs. A short imperative for the
 * orchestrating agent, not for a human.
 */
export function nextActionFor(i: NextActionInput): string | null {
  const status = i.status ?? null;
  if (status === 'canceled') return 'Canceled by operator; nothing to do.';
  if (status !== 'failed') return null;
  const err = i.error ?? '';
  if (err.includes('orphaned') || err.includes(ORPHAN_REASON)) {
    return 'Supervisor exited; resume_job if it has a conversation handle, else rerun.';
  }
  if ((i.deniedCount ?? 0) > 0 || /soft-denied/i.test(err)) {
    return i.unrestricted === true
      ? 'Worker was denied actions even with unrestricted:true; give it an approved path or narrow the task.'
      : 'Retry with unrestricted:true, or give the worker an approved path.';
  }
  if (i.jobStatus === 'timeout' || TIMEOUT_RE.test(err)) {
    return 'Raise timeoutMs or split the task; resume_job keeps the conversation.';
  }
  if (NETWORK_RE.test(err)) return 'Transient: retry the same job once; resume_job or spawn again.';
  if (/no usable output/i.test(err) || (i.exitCode === 0 && looksEmpty(i.report))) {
    return 'Worker returned no usable output; ask for a longer answer via resume_job or rerun.';
  }
  return 'Worker failed; read status.error and warnings before retrying.';
}
