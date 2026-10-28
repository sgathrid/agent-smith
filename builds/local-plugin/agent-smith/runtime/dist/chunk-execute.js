import path from'node:path';import {readFileSync,existsSync,constants,mkdirSync,writeFileSync,createWriteStream,renameSync,unlinkSync,openSync,fsyncSync,closeSync,statSync,copyFileSync}from'node:fs';import {open,readdir,access,constants as constants$1}from'node:fs/promises';import {randomBytes,randomUUID,createHash}from'node:crypto';import {spawn,execFile}from'node:child_process';import os from'node:os';import readline from'node:readline';/**
 * reasons.ts — every failure, in two to four words.
 *
 * One vocabulary for every surface: the completion notice, the band, the pane,
 * `status`, and the hints Claude reads. The forge stores `reason` (from these
 * helpers) on the job when it fails; readers of older jobs, which have only the
 * long `error` text, derive the same words with `reasonFromText`. The full error
 * always stays one step away (status, the pane), so nothing here needs to
 * explain itself.
 *
 * Lives in the mod for the same reason as progress.ts: the mod loader only
 * admits files inside the plugin folder; the forge imports it from here. Pure:
 * no `claude-code` import, no filesystem.
 */
const NETWORK_RE = /network issue|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|connection (?:reset|refused|closed|error)|temporarily unavailable/i;
const TIMEOUT_RE = /timed? ?out|exceeded the .*budget|\btimeout\b/i;
const AUTH_RE = /\b(?:unauthorized|unauthenticated)\b|authentication (?:failed|required)|invalid (?:api[ _-]?key|access token)|(?:access |auth |refresh )token (?:has )?expired|not (?:logged|signed) in|please (?:log|sign) in/i;
const BUSY_RE = /resource[_ ]exhausted|no spare capacity|\b503\b|\bservice unavailable\b|\boverloaded\b|provider busy/i;
const RATE_LIMIT_RE = /\brate[ _-]?limit(?:ed|ing)?\b|too many requests|\b429\b/i;
const QUOTA_RE = /insufficient[_ ]quota|insufficient credits|quota (?:exceeded|exhausted)|exceeded.{0,30}quota|credit balance.{0,30}(?:low|exhausted)|billing.{0,30}(?:limit|exhausted)|out of credits|\b402\b|payment required/i;
const COMPATIBILITY_RE = /unknown (?:option|argument|flag)|unrecognized (?:option|argument|flag|subcommand)|unexpected argument|unsupported (?:option|flag)|invalid value.{0,80}(?:--model|--effort|reasoning_effort)|unknown model|does not support effort|bad flag or model/i;
const START_RE = /\bENOENT\b|spawn.{0,100}(?:not found|no such file)|couldn't start|could not start/i;
/** The orphan reason, old and new wording: the process that owned the job is gone. */
const ORPHAN_RE = /orphaned|supervisor process exited|server stopped/i;
const DENIED_RE = /\bdenied\b|soft-denied/i;
/** The warning the forge writes when a queued steer is dropped because its turn did not succeed (forge/service.ts). */
const STEER_NOT_APPLIED_RE = /^\d+ queued steers? not applied\b/;
const NO_OUTPUT_RE = /no usable output|empty response|\bno output\b/i;
/** The words for the cases the forge decides itself. */
const REASONS = {
    serverStopped: 'server stopped',
    noOutput: 'no output',
    timedOut: 'timed out',
    notLoggedIn: 'not logged in',
    providerBusy: 'provider busy',
    outOfCredits: 'out of credits',
    rateLimited: 'rate limited',
    badFlagOrModel: 'bad flag or model',
    couldntStart: "couldn't start",
    networkError: 'network error',
    crashed: 'crashed',
    setupFailed: 'setup failed',
    workerError: 'worker error',
};
/** `first +N`: one name and a count, so a long list never widens a line. */
function firstPlus(names) {
    const clean = [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))];
    if (clean.length === 0)
        return '';
    return clean.length === 1 ? clean[0] : `${clean[0]} +${clean.length - 1}`;
}
/** `denied view_file`, `denied view_file +2`, or `denied`. */
function deniedReason(names) {
    const list = firstPlus(names);
    return list === '' ? 'denied' : `denied ${list}`;
}
/** `checks failed: lint`, `checks failed: lint +1`, or `checks failed`. */
function checksReason(failed) {
    const list = firstPlus(failed);
    return list === '' ? 'checks failed' : `checks failed: ${list}`;
}
/** `exit 1`. */
function exitReason(code) {
    return `exit ${code}`;
}
/**
 * Any failure text → the short reason. For jobs recorded before `reason` was
 * stored, and for errors that only exist as prose. Order matters: the most
 * specific cause wins, and an orphan or a denial outranks whatever else the
 * text happens to mention.
 */
function reasonFromText(text) {
    const t = (text ?? '').trim();
    if (t === '')
        return REASONS.workerError;
    if (ORPHAN_RE.test(t))
        return REASONS.serverStopped;
    // Already a stored reason ("denied view_file +2"): keep it whole, count included.
    if (/^denied(?: [^\n·]+)?$/.test(t) && t.length <= 64)
        return t;
    if (DENIED_RE.test(t)) {
        // "soft-denied 2 tool action(s) (view_file, RunCommand)", "denied view_file", "denied: view_file"
        const named = /\(([^()]{2,})\)/.exec(t)?.[1] ?? /\bdenied:? ([A-Za-z_][^·\n]*)/i.exec(t)?.[1] ?? '';
        return deniedReason(named.split(',').map((n) => n.replace(/\s*\+\d+$/, '')));
    }
    if (NO_OUTPUT_RE.test(t))
        return REASONS.noOutput;
    if (TIMEOUT_RE.test(t))
        return REASONS.timedOut;
    if (AUTH_RE.test(t))
        return REASONS.notLoggedIn;
    if (BUSY_RE.test(t))
        return REASONS.providerBusy;
    if (QUOTA_RE.test(t))
        return REASONS.outOfCredits;
    if (RATE_LIMIT_RE.test(t))
        return REASONS.rateLimited;
    if (COMPATIBILITY_RE.test(t))
        return REASONS.badFlagOrModel;
    if (START_RE.test(t))
        return REASONS.couldntStart;
    if (NETWORK_RE.test(t))
        return REASONS.networkError;
    if (/without (?:emitting )?a result|no result event|\bcrashed\b/i.test(t))
        return REASONS.crashed;
    if (/preparation failed|setup failed/i.test(t))
        return REASONS.setupFailed;
    if (/checks failed/i.test(t))
        return t.split('\n')[0].slice(0, 48);
    const exit = /\bexit(?:ed)?(?: with)?(?: code)? (\d+)\b/i.exec(t);
    if (exit)
        return exitReason(Number(exit[1]));
    // Already short and plain: keep it as the worker or provider put it.
    if (t.length <= 32 && !t.includes('\n') && !t.includes(' — '))
        return t;
    return REASONS.workerError;
}/**
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
/** Per-repo job root, relative to the repo. Ours; nothing else reads it as truth. */
const JOBS_DIR_SEGMENTS = ['.agent-smith', 'jobs'];
/**
 * Bumped when the on-disk shape changes incompatibly.
 *
 * A reader that finds a manifest with a higher `schema` must refuse it rather
 * than half-understand it: reading a v2 manifest with v1 rules produces exactly
 * the confident wrong answers this project exists to prevent.
 */
const SCHEMA_VERSION = 1;
/** How often progress.json may be rewritten. See forge/writer.ts. */
const PROGRESS_FLUSH_MS = 250;
/** File names inside a job directory. Named once, referenced everywhere. */
const FILES = {
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
};
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
const ID_MARKER = 'smith';
function isForgeStatus(v) {
    return v === 'running' || v === 'succeeded' || v === 'failed' || v === 'canceled';
}
/** The statuses a job never leaves. `running` is the only non-terminal one. */
function isTerminalForgeStatus(s) {
    return s === 'succeeded' || s === 'failed' || s === 'canceled';
}
/**
 * Pure: split changed paths into those this job's own tool inputs mention (by full
 * path or basename) and those it never touched. With no captured input there is
 * nothing to attribute against, so everything stays attributed.
 */
function attributeChanged(files, toolInputs) {
    if (toolInputs === '')
        return { mine: [...files], other: [] };
    const mine = [];
    const other = [];
    for (const p of files) {
        const base = p.slice(p.lastIndexOf('/') + 1);
        (toolInputs.includes(p) || (base !== '' && toolInputs.includes(base)) ? mine : other).push(p);
    }
    return { mine, other };
}
/** Max entries kept in `changedFiles`. */
const CHANGED_FILES_CAP = 200;
/** Paths that are our own bookkeeping, never a worker's change. */
function isForgeStatePath(p) {
    return p === '.agent-smith' || p.startsWith('.agent-smith/') || p === '.agy-staff' || p.startsWith('.agy-staff/');
}
/**
 * Pure: which paths changed since the baseline.
 *
 * `nowDirty` is the worktree's dirty set at finish; `modifiedBaseline` is the
 * subset of baseline-dirty paths whose content signature moved (writer-computed);
 * `committed` are paths touched by commits made since the baseline HEAD.
 */
function diffChangedFiles(baseline, nowDirty, modifiedBaseline = [], committed = []) {
    const was = new Set(baseline.dirty);
    const out = new Set();
    for (const p of nowDirty)
        if (!was.has(p))
            out.add(p);
    // Dirty at start and clean now: the worker reverted/committed it.
    const now = new Set(nowDirty);
    for (const p of baseline.dirty)
        if (!now.has(p))
            out.add(p);
    for (const p of modifiedBaseline)
        out.add(p);
    for (const p of committed)
        out.add(p);
    const all = [...out].filter((p) => !isForgeStatePath(p)).sort();
    return { files: all.slice(0, CHANGED_FILES_CAP), truncated: all.length > CHANGED_FILES_CAP };
}
/* ────────────────────────────────────────────────────────────────────────────
 * Paths — pure string joins, exported so tests never touch a filesystem
 * ──────────────────────────────────────────────────────────────────────────── */
function jobsDir(repo) {
    return path.join(repo, ...JOBS_DIR_SEGMENTS);
}
function jobDir(repo, jobId) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(jobId) || jobId === '.' || jobId === '..') {
        throw new Error(`invalid job id "${jobId}"`);
    }
    return path.join(jobsDir(repo), jobId);
}
function jobFile(repo, jobId, name) {
    return path.join(jobDir(repo, jobId), name);
}
/** The anchor, parsed. Throws when absent or malformed: callers decide what that means. */
function readManifest(repo, jobId) {
    return JSON.parse(readFileSync(jobFile(repo, jobId, FILES.job), 'utf8'));
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
function newJobId$1(mode) {
    const safeMode = mode.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120).replace(/-+$/g, '');
    const prefix = safeMode === '' ? 'job' : safeMode;
    return `${prefix}-${ID_MARKER}-${randomBytes(4).toString('hex')}`;
}
/** Is this id one of ours? Used to keep the two readers from double-counting. */
function isForgeJobId(jobId) {
    return /(?:^|-)smith-[0-9a-f]{8}$/i.test(jobId);
}
/** The first non-empty line of a prompt, `#`-stripped, capped. The task cell. */
function taskTitle(prompt) {
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
const MIN_USEFUL_CHARS = 1;
/** Is there no usable output? See MIN_USEFUL_CHARS. */
function looksEmpty$1(text) {
    if (text === null || text === undefined)
        return true;
    return text.trim().length < MIN_USEFUL_CHARS;
}
/** deriveStatus's reason when a writing job's cwd vanished before it could be checked. */
const CWD_GONE_REASON = 'working directory gone; nothing could be verified';
/** A failure this soon after start, with no tool call, is a route failure, not the work. */
const FAILED_EARLY_MS = 20_000;
/** Writing modes: a vanished cwd makes their success unverifiable. */
function isWritingMode(mode) {
    return mode === 'implement' || mode === 'verify';
}
/**
 * deriveStatus's cwd inputs, from what the caller can prove: whether `cwd`
 * still exists, and whether the job was meant to write (its mode) or is known
 * to have edited. An empty or absent cwd is never "missing" (nothing to check).
 */
function cwdFacts(cwd, mode, edited = false) {
    return { cwdMissing: typeof cwd === 'string' && cwd !== '' && !existsSync(cwd), writing: isWritingMode(mode) || edited };
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
function denialNames(denials) {
    return denials
        .map((x) => x.displayName ?? x.action)
        .filter((n) => typeof n === 'string' && n.length > 0);
}
/** `view_file` or `view_file +2`; empty when no denial has a name. */
function deniedNames(denials) {
    const names = [...new Set(denialNames(denials))];
    if (names.length === 0)
        return '';
    return names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`;
}
/**
 * What a failed finish stores: the full `error` (the adapter's own text, else the
 * verdict's reason; never both) and the short `reason`. Not failed: both null-ish.
 */
/** Keep both ends of a long error: the cause leads, the stderr tail closes. */
function elide(text, max) {
    if (text.length <= max)
        return text;
    const head = Math.floor(max / 3);
    return `${text.slice(0, head)} … ${text.slice(text.length - (max - head - 3))}`;
}
function failureFields(verdict, result, maxError = 1_200) {
    const adapterError = (result.error ?? '').trim();
    const error = adapterError !== '' ? elide(adapterError, maxError) : verdict.reason;
    if (verdict.status !== 'failed')
        return { error, reason: null };
    const denials = result.deniedActions ?? [];
    const fatal = denials.length > 0 && verdict.reason !== null && DENIED_RE.test(verdict.reason);
    let reason;
    if (fatal)
        reason = deniedReason(denialNames(denials));
    else if (result.status === 'timeout')
        reason = REASONS.timedOut;
    else if (verdict.reason === REASONS.noOutput)
        reason = REASONS.noOutput;
    else if (verdict.reason === CWD_GONE_REASON && adapterError === '')
        reason = 'working directory gone';
    else
        reason = reasonFromText(adapterError !== '' ? adapterError : verdict.reason);
    return { error, reason };
}
function deriveStatus(d) {
    const terminal = d.alreadyTerminal ?? null;
    if (terminal === 'canceled')
        return { status: 'canceled', suspicious: false, reason: 'canceled' };
    if (terminal === 'succeeded')
        return { status: 'succeeded', suspicious: false, reason: null };
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
    const nonfatalOnly = denials.length > 0 && d.ok === true && !looksEmpty$1(d.report) && denials.every((x) => x.nonfatal === true || x.action === 'tool');
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
    if (looksEmpty$1(d.report)) {
        return {
            status: 'failed',
            suspicious: true,
            reason: REASONS.noOutput,
        };
    }
    return { status: 'succeeded', suspicious: false, reason: null };
}
/**
 * Should progress.json be rewritten now?
 *
 * A 28-minute job made 484 tool calls. Writing a file per event is 484 writes
 * the UI never needed; the band polls every 3 s, so anything under that is
 * invisible. The comparison is `>=` and not `>` so a flush is never starved by
 * an event stream that arrives faster than the interval.
 */
function shouldFlush(lastFlushMs, nowMs, minMs = PROGRESS_FLUSH_MS) {
    return nowMs - lastFlushMs >= minMs;
}
/* ────────────────────────────────────────────────────────────────────────────
 * Orphans — a `running` job whose supervisor died
 * ──────────────────────────────────────────────────────────────────────────── */
/** Default wall-clock budget for one job (re-exported by service.ts). */
const DEFAULT_TIMEOUT_MS = 45 * 60_000;
/** A legacy manifest (no ownerPid) is orphaned only when silent this long. */
const LEGACY_ORPHAN_AFTER_MS = 2 * DEFAULT_TIMEOUT_MS;
const ORPHAN_REASON = REASONS.serverStopped;
const CANCEL_ORPHAN_REASON = 'canceled; server stopped before confirming';
/** `kill(pid, 0)`: ESRCH means gone; EPERM means it exists but is not ours. */
function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === 'EPERM';
    }
}
/** The recorded owner pid when it is a usable one (positive integer), else null (legacy or malformed). */
function validOwnerPid(m) {
    const pid = m.ownerPid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
}
/** True when the manifest names an owner process that is still running. */
function ownerAlive(m) {
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
function deriveOrphan(m, lastSeenMs, nowMs, alive = isPidAlive, cancelRequested = false) {
    if (m.status !== 'running')
        return null;
    const verdict = cancelRequested
        ? { status: 'canceled', suspicious: false, reason: CANCEL_ORPHAN_REASON }
        : { status: 'failed', suspicious: true, reason: ORPHAN_REASON };
    if (typeof m.ownerPid === 'number')
        return alive(m.ownerPid) ? null : verdict;
    const times = [lastSeenMs, m.createdAt === undefined ? null : Date.parse(m.createdAt)]
        .filter((t) => t !== null && Number.isFinite(t));
    if (times.length === 0)
        return null;
    const ref = Math.max(...times);
    return nowMs - ref > LEGACY_ORPHAN_AFTER_MS ? verdict : null;
}
/**
 * THE one place a next step is derived. Derived on read, never stored in
 * job.json. Null for running/succeeded jobs. A short imperative for the
 * orchestrating agent, not for a human.
 */
function nextActionFor(i) {
    const base = baseNextAction(i);
    return base !== null && i.steerNotApplied === true
        ? `${base} A queued steer was not applied: include it in your resume_job prompt.`
        : base;
}
function baseNextAction(i) {
    const status = i.status ?? null;
    if (status !== 'failed')
        return null;
    const err = i.error ?? '';
    if (ORPHAN_RE.test(err))
        return 'Server stopped: resume_job if it has a conversation, else rerun.';
    if (i.jobStatus === 'denied' || (i.deniedCount ?? 0) > 0 || DENIED_RE.test(err)) {
        return i.unrestricted === true
            ? 'Denied even with unrestricted:true: narrow the task or give an approved path.'
            : 'Ask the user before retrying with unrestricted:true.';
    }
    if (AUTH_RE.test(err))
        return 'Not logged in: fix the provider login, then retry.';
    if (BUSY_RE.test(err))
        return 'Provider busy (temporary); resume_job to continue.';
    if (QUOTA_RE.test(err))
        return 'Out of credits on the provider account.';
    if (RATE_LIMIT_RE.test(err))
        return 'Rate limited; resume_job after a short wait.';
    if (COMPATIBILITY_RE.test(err))
        return 'Bad flag or model: run agent-smith doctor, then fix the request.';
    if (START_RE.test(err))
        return "Couldn't start: run agent-smith doctor.";
    // After the specific diagnoses, before the generic ones: resuming a route
    // that failed before any work just fails again.
    if (i.failedEarly === true && i.jobStatus !== 'timeout') {
        return 'Route failed before any work (model/account): pick another model from list_capabilities or fix the account.';
    }
    if (i.jobStatus === 'timeout' || TIMEOUT_RE.test(err)) {
        return 'Raise timeoutMs or split the task; resume_job keeps context.';
    }
    if (NETWORK_RE.test(err))
        return 'Network error: retry once with resume_job or a new spawn.';
    if (NO_OUTPUT_RE.test(err) || (i.exitCode === 0 && looksEmpty$1(i.report))) {
        return 'No output: ask for a final answer via resume_job, or rerun.';
    }
    return 'Read status.error and warnings before retrying.';
}/** Text sanitising and fixed-width fitting. Dependency-free: everything that puts
 * worker or user prose into a cell goes through here first.
 */
/**
 * Strip complete ANSI escape sequences (CSI, OSC, DCS/PM/APC/SOS, 2-byte ESC,
 * C1 controls) and remaining forbidden control characters, unpaired surrogates,
 * and noncharacters (`U+FDD0..U+FDEF`), while preserving `\n` and valid UTF-16
 * surrogate pairs.
 *
 * Why this exists: Claude Code's JSX element validator rejects any `<Text>`,
 * `<Button label>`, or `<Markdown text>` containing C0/C1 controls (except `\t`
 * and `\n`), lone surrogates, or `U+FDD0..U+FDEF`. Worker tool output, shell
 * commands, check output, and prompt text routinely contain ANSI colour codes or
 * `\r` progress lines; stripping them at the UI boundary keeps the stored job
 * files intact while preventing a single control byte from aborting the pane.
 */
const ANSI_ESCAPE = /(?:\x1b\][\s\S]*?(?:\x07|\x1b\\|\x9c)|\x9d[\s\S]*?(?:\x07|\x1b\\|\x9c)|\x1b[PX^_][\s\S]*?(?:\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[@-~])/gu;
const FORBIDDEN_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff\ufdd0-\ufdef]/gu;
function sanitizeText(s) {
    return s
        .replace(ANSI_ESCAPE, '')
        .replace(/\r\n?/g, '\n')
        .replace(/\t/g, '  ')
        .replace(FORBIDDEN_CONTROLS, '');
}
/**
 * Cut to at most `max` UTF-16 units without splitting a surrogate pair.
 *
 * `slice` can leave a high surrogate with no low half. `sanitizeText` removes
 * such halves, so a cut made AFTER sanitizing must not create one: the host
 * draws an unpaired half as U+FFFD, or refuses the tree a Text's string is
 * checked in. `max` stays in UTF-16 units because every caller sizes cells in
 * terminal columns, where a pair already counts as two.
 */
function clip(s, max) {
    if (s.length <= max)
        return s;
    const cut = s.slice(0, Math.max(0, max));
    return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}
/** Collapse all whitespace runs to single spaces and cap the length. A hard
 * bound on what one string can cost, for prose with no cell to sit in (a report
 * excerpt, a warning message); the renderer's `wrap="truncate-end"` is the
 * mechanism, this is belt and braces. */
function oneLine(s, max = 400) {
    const t = sanitizeText(s).replace(/\s+/g, ' ').trim();
    return clip(t, Math.max(0, max));
}/**
 * safe-fs.ts — race-tolerant filesystem primitives shared by every reader.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every reader in this directory observes state that another process is
 * *actively mutating*. agy-staff rewrites `progress.json` every ~100ms and then
 * **deletes** it the moment a job finishes cleanly. Claude Code appends to a
 * subagent `.jsonl` while we read it. So between our `readdir` and our `read`,
 * a path can vanish, be truncated mid-write, or be replaced by a directory.
 *
 * Throwing here is never correct: a missing file is *information* (see hazard A
 * in agy-staff.ts), not an error. Every function in this module returns
 * `null` / `[]` / `false` instead of throwing. This is the single most
 * important flake-prevention rule in the harness.
 */
/** Substrings of fs error codes that mean "the world moved on, carry on". */
const TRANSIENT_CODES = new Set([
    "ENOENT", // deleted between readdir and read (hazard A: clean-success cleanup)
    "EACCES", // macOS TCC / permissions
    "EPERM",
    "EISDIR", // a path we expected to be a file is a dir
    "ENOTDIR", // ...or vice versa
    "EBUSY",
    "ELOOP",
    "EMFILE",
    "ENFILE",
]);
/**
 * Default byte cap for text reads.
 *
 * WHY: `events.jsonl` reached 492KB and a Claude subagent transcript 526KB in
 * the sample corpus. We only ever want the *head* of a stream for display; a
 * viewer that OOMs on a long job is worse than one that truncates. Callers
 * that genuinely need everything pass a bigger number.
 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
function isTransient(err) {
    if (typeof err !== "object" || err === null)
        return true; // be paranoid
    const code = err.code;
    // A non-Error throw is by definition something we did not anticipate.
    if (typeof code !== "string")
        return true;
    return TRANSIENT_CODES.has(code);
}
/** `fs.access(F_OK)` that returns a boolean instead of throwing. */
async function existsSafe(path) {
    try {
        await access(path, constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Read a file as UTF-8 text, capped at `maxBytes`.
 *
 * Returns `null` if the file is gone, unreadable, or a directory. Never throws.
 * A short read is *normal* here — it means we caught a half-written file, which
 * is exactly what we want the JSON parser downstream to survive.
 */
async function readTextSafe$1(path, maxBytes = DEFAULT_MAX_BYTES) {
    let handle;
    try {
        handle = await open(path, "r");
        // +4 bytes so a multi-byte UTF-8 sequence straddling the cap does not
        // become a replacement character at the boundary.
        const buf = Buffer.allocUnsafe(maxBytes + 4);
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        if (bytesRead === 0)
            return ""; // genuinely empty file is not "missing"
        return buf.subarray(0, bytesRead).toString("utf8");
    }
    catch (err) {
        if (!isTransient(err))
            throw err;
        return null;
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
/**
 * Read and JSON.parse, tolerating every way that can go wrong.
 *
 * Returns `null` for: missing file, unreadable file, empty file, invalid JSON.
 * Invalid JSON is EXPECTED, not exceptional — agy-staff writes with a plain
 * `writeFile`, so a reader that arrives mid-write sees a truncated document.
 * Treating that as `null` and retrying on the next poll is the whole strategy.
 */
async function readJsonSafe(path, maxBytes) {
    const text = await readTextSafe$1(path, maxBytes);
    if (text === null)
        return null;
    const trimmed = text.trim();
    if (trimmed === "")
        return null; // empty or all-whitespace ⇒ mid-write
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return null; // half-written JSON. Next poll will get it.
    }
}
/**
 * `fs.readdir` that returns `[]` instead of throwing.
 *
 * NOTE: we do NOT `stat` each entry here. That would double the syscalls and
 * reintroduce the very race we are defending against. Callers should treat
 * every returned name as a *hypothesis* to be confirmed by a tolerant read.
 */
async function readdirSafe(path) {
    try {
        return await readdir(path);
    }
    catch (err) {
        if (!isTransient(err))
            throw err;
        return [];
    }
}/**
 * agent-smith.ts — reads OUR OWN job state from `<repo>/.agent-smith/jobs/`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE PRIMARY READER. WHY IT EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Until now the only reader in this layer read somebody else's directory.
 * harness/agy-staff.ts is a re-implementation of a layout nobody in this repo
 * writes any more, kept because the 20 real jobs under
 * /Users/gathrid/Repos/renyi/.agy-staff/jobs are the corpus the hazard rules
 * were verified against and because any future worker that writes that layout
 * should be picked up for free.
 *
 * It is now an INTEROP reader. This one is the source of truth, and
 * registry.ts holds both:
 *
 *     "agent-smith"   PRIMARY.   Every job this repo spawned.
 *     "agy-staff"     INTEROP.   Read-only history from another harness.
 *
 * The two are kept strictly apart — see the last section, which is the one rule
 * this file has to enforce.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE IS NOT MUCH CODE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Because forge/format.ts made it not much code. That is the point of owning the
 * state format. Compare with agy-staff.ts, which needs three documented hazards
 * and a seven-suffix fallback chain to answer the same three questions:
 *
 *   - Does this job exist?        → the directory exists and holds a job.json.
 *   - What is its terminal state? → job.json.status. Written atomically, always.
 *   - Is it alive?                → job.json.updatedAt, refreshed on every event.
 *
 * agy-staff's equivalents are all "which of these seven files, some of which are
 * deleted on success, do I read, and in what order". We traded that for a
 * directory, an atomic rewrite, and the refusal to ever delete the anchor.
 *
 * The one hazard we DID keep is the cancel marker, and it is the same hazard:
 * `cancel` can exist before job.json reaches a terminal state, so it outranks it.
 */
/**
 * payload keys the normalizer relies on. Cross-referenced by name from
 * harness/normalize.ts's `smithNormalizer`.
 */
const SMITH_PAYLOAD = {
    provider: 'provider',
    mode: 'mode',
    model: 'model',
    effort: 'effort',
    status: 'status',
    task: 'task',
    unrestricted: 'unrestricted',
    conversation: 'conversation',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
    exitCode: 'exit_code',
    jobStatus: 'job_status',
    error: 'error',
    deniedActions: 'denied_actions',
    usage: 'usage',
    toolCalls: 'tool_calls',
    output: 'output',
    canceled: 'canceled',
    cancelAt: 'cancel_at',
    lastEventAt: 'last_event_at',
    lastAliveAt: 'last_alive_at',
    recentActivities: 'recent_activities',
    lastActivity: 'last_activity',
    latestText: 'latest_text',
    progressWarnings: 'progress_warnings',
    pipeline: 'pipeline',
    stage: 'stage',
    attempt: 'attempt',
    schema: 'schema',
};
const CANCELED_ORPHAN = { status: 'canceled', suspicious: false, reason: CANCEL_ORPHAN_REASON };
/**
 * Reads `.agent-smith/jobs`.
 *
 * Every method is fault-tolerant in the same way and for the same reason as
 * agy-staff.ts: a reader reads files a live process is rewriting, and one
 * unreadable job is that job's absence rather than a dead band. `discover`
 * NEVER throws; an absent jobs directory is the ordinary case for a repo that
 * has never spawned anything, not an error.
 */
class AgentSmithReader {
    provider = 'agent-smith';
    /**
     * Enumerate job ids from the jobs directory.
     *
     * Keyed on the DIRECTORY, which is the whole reason this is simpler than the
     * interop reader: there is no suffix to parse, no "which file proves this job
     * exists", and no entry that can half-qualify. A job's identity is its
     * directory, so identity cannot be lost.
     */
    async discover(cwd) {
        const entries = await readdirSafe(jobsDir(cwd));
        const ids = new Set();
        for (const entry of entries) {
            // `readdirSafe` returns names only; a name that is not a directory will
            // simply fail the job.json read below and contribute nothing. We do not
            // stat here because a stat per entry is a syscall per entry on a path the
            // band hits every three seconds.
            if (!entry.startsWith('.'))
                ids.add(entry);
        }
        return [...ids].sort();
    }
    /**
     * Assemble one snapshot.
     *
     * Returns null when the job does not exist to this reader — i.e. no directory
     * and no job.json. A FINISHED job returns a full snapshot: job.json is never
     * deleted, which is the whole reason the format has a single anchor.
     */
    async read(cwd, jobId) {
        // The cancel marker outranks job.json (same hazard as agy-staff's B: the
        // marker can exist before the worker has been reaped).
        const cancelPath = jobFile(cwd, jobId, FILES.cancel);
        const cancelRequested = await existsSafe(cancelPath);
        let cancelAt = null;
        if (cancelRequested) {
            const raw = await readTextSafe$1(cancelPath);
            const t = raw?.trim();
            cancelAt = t !== undefined && t !== '' ? t : null;
        }
        const manifest = await readJsonSafe(jobFile(cwd, jobId, FILES.job));
        // A marker is a request. The owner may still be working or may finish
        // successfully before it can stop; only terminal canceled state is proof.
        const canceled = manifest === null ? cancelRequested : manifest.status === 'canceled';
        // A manifest from a NEWER writer is refused rather than half-understood.
        // Reading a v2 file with v1 rules produces exactly the confident wrong
        // answers this project exists to prevent, and `unknown` is the honest state.
        if (manifest !== null && typeof manifest.schema === 'number' && manifest.schema > SCHEMA_VERSION) {
            return {
                provider: this.provider,
                jobId,
                cwd,
                partial: true,
                payload: {
                    [SMITH_PAYLOAD.schema]: manifest.schema,
                    [SMITH_PAYLOAD.error]: `on-disk schema v${manifest.schema} is newer than this reader (v${SCHEMA_VERSION}); state unknown`,
                    [SMITH_PAYLOAD.canceled]: canceled,
                    [SMITH_PAYLOAD.cancelAt]: cancelAt,
                },
            };
        }
        const report = await readTextSafe$1(jobFile(cwd, jobId, FILES.report));
        const progress = await readJsonSafe(jobFile(cwd, jobId, FILES.progress));
        // "Does this job exist?" is asked LAST, and includes the marker: a job
        // whose only surviving artefact is its cancel request is still a job.
        //
        // Note what is NOT consulted: the bare existence of the directory. A
        // half-created directory (crash between mkdir and the first write) and a
        // stray directory a human dropped in here are both indistinguishable from a
        // job by `stat`, and a band that draws "unknown" for a stray folder is
        // indistinguishable from one that lies. We require evidence of a job.
        const anyEvidence = manifest !== null || canceled || report !== null;
        if (!anyEvidence)
            return null;
        // Orphan derivation (forge/format.ts deriveOrphan): a `running` anchor with
        // no terminal result whose supervisor is gone. Derived, never written into
        // job.json. Only the service reconciler persists the verdict; this reader
        // is read-only, including when used by notifications and validation.
        let orphan = null;
        if (manifest !== null && manifest.status === 'running' && !canceled
            && !(await existsSafe(jobFile(cwd, jobId, FILES.result)))) {
            const lastSeen = Math.max(Date.parse(manifest.updatedAt), Date.parse(progress?.lastEventAt ?? ''));
            orphan = deriveOrphan(manifest, Number.isFinite(lastSeen) ? lastSeen : null, Date.now(), undefined, cancelRequested);
            // A live supervisor honours a cancel request within seconds. A request that
            // is a minute old and still has no terminal state means nobody is listening.
            const cancelAgeMs = cancelAt === null ? NaN : Date.now() - Date.parse(cancelAt);
            const ownerIsAlive = ownerAlive(manifest);
            if (orphan === null && cancelRequested && cancelAgeMs > 60_000 && !ownerIsAlive)
                orphan = CANCELED_ORPHAN;
        }
        const payload = {
            [SMITH_PAYLOAD.schema]: manifest?.schema ?? null,
            [SMITH_PAYLOAD.provider]: manifest?.provider ?? null,
            name: manifest?.name ?? null,
            workerId: manifest?.workerId ?? jobId,
            role: manifest?.role ?? manifest?.mode ?? null,
            latestSummary: progress?.latestSummary ?? manifest?.latestSummary ?? null,
            summarySource: progress?.summarySource ?? manifest?.summarySource ?? null,
            [SMITH_PAYLOAD.mode]: manifest?.mode ?? null,
            [SMITH_PAYLOAD.model]: manifest?.model ?? null,
            [SMITH_PAYLOAD.effort]: manifest?.effort ?? null,
            [SMITH_PAYLOAD.status]: orphan?.status ?? manifest?.status ?? null,
            [SMITH_PAYLOAD.task]: manifest?.task ?? null,
            [SMITH_PAYLOAD.unrestricted]: manifest?.unrestricted ?? null,
            [SMITH_PAYLOAD.conversation]: manifest?.conversation ?? null,
            [SMITH_PAYLOAD.createdAt]: manifest?.createdAt ?? null,
            [SMITH_PAYLOAD.updatedAt]: manifest?.updatedAt ?? null,
            [SMITH_PAYLOAD.startedAt]: manifest?.startedAt ?? null,
            [SMITH_PAYLOAD.finishedAt]: manifest?.finishedAt ?? null,
            [SMITH_PAYLOAD.exitCode]: manifest?.exitCode ?? null,
            [SMITH_PAYLOAD.jobStatus]: manifest?.jobStatus ?? null,
            [SMITH_PAYLOAD.error]: orphan?.reason ?? manifest?.error ?? null,
            [SMITH_PAYLOAD.deniedActions]: manifest?.deniedActions ?? [],
            [SMITH_PAYLOAD.usage]: manifest?.usage ?? null,
            ...(Array.isArray(manifest?.changedFiles) && manifest.changedFilesTruncated !== true
                ? { changed_files: manifest.changedFiles } : {}),
            // No progress.json and no manifest count is unknown, not zero: a job that
            // wrote nothing must not claim it made no tool calls.
            [SMITH_PAYLOAD.toolCalls]: progress?.toolCalls ?? manifest?.toolCalls ?? null,
            [SMITH_PAYLOAD.pipeline]: manifest?.pipeline ?? null,
            [SMITH_PAYLOAD.stage]: manifest?.stage ?? null,
            [SMITH_PAYLOAD.attempt]: manifest?.attempt ?? null,
            [SMITH_PAYLOAD.output]: report,
            [SMITH_PAYLOAD.canceled]: canceled,
            [SMITH_PAYLOAD.cancelAt]: cancelAt,
            [SMITH_PAYLOAD.lastEventAt]: progress?.lastEventAt ?? manifest?.updatedAt ?? null,
            // The process owner's heartbeat (providers/ndjson.ts). Absent for jobs
            // written by older builds: liveness then falls back to event silence.
            [SMITH_PAYLOAD.lastAliveAt]: progress?.lastAliveAt ?? null,
            ...(typeof progress?.workerPid === 'number' ? { workerPid: progress.workerPid } : {}),
            ...(typeof (manifest?.toolErrors ?? progress?.toolErrors) === 'number'
                ? { toolErrors: manifest?.toolErrors ?? progress?.toolErrors } : {}),
            ...(manifest?.failedEarly === true ? { failedEarly: true } : {}),
            ...(manifest?.changedFilesUnknown === true ? { changedFilesUnknown: true } : {}),
            ...(manifest?.cwdMissingAtFinish === true ? { cwdMissingAtFinish: true } : {}),
            [SMITH_PAYLOAD.recentActivities]: progress?.recentActivities ?? [],
            [SMITH_PAYLOAD.lastActivity]: progress?.lastActivity ?? null,
            [SMITH_PAYLOAD.latestText]: progress?.latestText ?? null,
            [SMITH_PAYLOAD.progressWarnings]: progress?.warnings ?? [],
            ...(progress?.digest !== undefined ? { digest: progress.digest } : {}),
            ...(manifest?.supersededBy !== undefined ? { supersededBy: manifest.supersededBy } : {}),
            ...(manifest?.steeredFrom !== undefined ? { steeredFrom: manifest.steeredFrom } : {}),
            ...(typeof (progress?.pendingSteers ?? manifest?.pendingSteers) === 'number'
                ? { pendingSteers: progress?.pendingSteers ?? manifest?.pendingSteers }
                : {}),
            ...(Array.isArray(manifest?.staleReads) && manifest.staleReads.length > 0
                ? { staleReads: manifest.staleReads }
                : {}),
        };
        // partial=true when the anchor is missing: something is on disk for this
        // job but we could not read the file that says what state it is in. The
        // normalizer biases toward `unknown` over a guess, and `unknown` must never
        // be collapsed into `running`.
        return {
            provider: this.provider,
            jobId,
            cwd: manifest?.cwd ?? cwd,
            payload,
            partial: manifest === null,
        };
    }
}
/*
 * Older versions mirrored our jobs into `.agy-staff/jobs/`; copies may remain on
 * disk. `AgyStaffReader` callers skip forge ids (`isForgeJobId`) so a job never
 * gets two verdicts in one sweep.
 *//**
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
const AGY_PAYLOAD = {
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
};
/** A dependency-free `.agy-staff/jobs` reader. */
class AgyStaffReader {
    provider = "agy-staff";
    /** Resolve the per-repo jobs directory for a given cwd. */
    jobsDir(cwd) {
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
    async discover(cwd) {
        const dir = this.jobsDir(cwd);
        const entries = await readdirSafe(dir);
        const ids = new Set();
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
    async read(cwd, jobId) {
        const dir = this.jobsDir(cwd);
        const at = (suffix) => path.join(dir, `${jobId}${suffix}`);
        // --- HAZARD B: cancel marker. Read it first; it can outrank status.json. ---
        const cancelMarkerPath = at(CANCEL_SUFFIX);
        const canceled = await existsSafe(cancelMarkerPath);
        let cancelAt = null;
        if (canceled) {
            const raw = await readTextSafe$1(cancelMarkerPath);
            // The marker body is the cancel timestamp; normalize to trimmed string or null.
            const t = raw?.trim();
            cancelAt = t && t.length > 0 ? t : null;
        }
        // --- Terminal anchor (HAZARD A). status.json is written on every terminal
        // job, so it is the reliable source of done/error/canceled. ---
        const status = await readJsonSafe(at(STATUS_SUFFIX));
        // --- spec.json: exists for every job; carries mode/model/profile. ---
        const spec = await readJsonSafe(at(SPEC_SUFFIX));
        // --- result.md: the final report. Read + de-pollute (HAZARD C). ---
        const rawResult = await readTextSafe$1(at(RESULT_SUFFIX));
        let output = null;
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
        const log = await readTextSafe$1(at(LOG_SUFFIX));
        const telemetry = log === null ? {} : parseLogTelemetry(log);
        // Decide "does this job exist at all?" only after collecting all evidence,
        // so a job whose only surviving artifact is the cancel marker is still seen.
        const anyEvidence = status !== null ||
            spec !== null ||
            rawResult !== null ||
            log !== null ||
            canceled;
        if (!anyEvidence)
            return null;
        // --- progress.json + events.jsonl are OPTIONAL liveness evidence (HAZARD A).
        // A null here means either "still running but not written yet" OR
        // "finished clean and agy-staff deleted it". We record presence as evidence
        // but never treat absence as fatal. ---
        const progress = await readJsonSafe(at(PROGRESS_SUFFIX));
        const hasProgressFile = progress !== null;
        const hasEventsFile = await existsSafe(at(EVENTS_SUFFIX));
        const payload = {
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
function stripSystemNotifications(text) {
    const OPEN = "<system_notification>";
    const CLOSE = "</system_notification>";
    let out = text;
    let removed = 0;
    for (;;) {
        const start = out.indexOf(OPEN);
        if (start === -1)
            break;
        const closeIdx = out.indexOf(CLOSE, start + OPEN.length);
        if (closeIdx === -1)
            break; // unmatched open tag: leave everything alone
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
function parseLogTelemetry(log) {
    const out = {};
    const mode = /\bmode=(\S+)/.exec(log);
    if (mode?.[1])
        out["mode"] = mode[1];
    const profile = /\bprofile=(\S+)/.exec(log);
    if (profile?.[1])
        out["profile"] = profile[1];
    const model = /\bmodel=(\S+)/.exec(log);
    if (model?.[1])
        out["model"] = model[1];
    const agyStatus = /\bagy_status=(\S+)/.exec(log);
    if (agyStatus?.[1])
        out["agy_status"] = agyStatus[1];
    const agyExit = /\bagy_exit=(-?\d+)/.exec(log);
    if (agyExit?.[1])
        out["agy_exit"] = Number(agyExit[1]);
    const duration = /\bduration=([\d.]+)s/.exec(log);
    if (duration?.[1])
        out["duration_ms"] = Math.round(Number(duration[1]) * 1000);
    const turns = /\bturns=(\d+)/.exec(log);
    if (turns?.[1])
        out["turns"] = Number(turns[1]);
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
        if (reasonLine?.[1])
            out["agy_error_reason"] = reasonLine[1].trim();
    }
    return out;
}/**
 * normalize.ts — provider-agnostic normalization to ObservedJob.
 *
 * Every provider quirk and every judgement call lives HERE and only here, so
 * this file is the single place a reviewer reads to answer "why did that job
 * show up as failed?". Readers (agent-smith.ts, agy-staff.ts) are dumb parsers;
 * they extract facts and get out of the way.
 *
 * The headline rule, stated once and enforced below:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │ AN EMPTY RESPONSE WITH WARNINGS IS NOT A CLEAN SUCCESS.           │
 *   │ agy-staff will happily write { status:'done', warnings:true } and │
 *   │ an empty result.md when the underlying run degraded. Reporting     │
 *   │ that as `succeeded` with no warnings is a lie the mod band would  │
 *   │ happily render as a green check. We downgrade to `failed` and      │
 *   │ attach `suspicious_success`.                                      │
 *   └──────────────────────────────────────────────────────────────────┘
 */
// ── helpers ────────────────────────────────────────────────────────────────
function asString(v) {
    return typeof v === "string" && v.length > 0 ? v : null;
}
function asNumber(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asBool(v) {
    return typeof v === "boolean" ? v : null;
}
function asStringArray(v) {
    if (!Array.isArray(v))
        return [];
    return v.filter((x) => typeof x === "string");
}
/** A "clean enough" answer. Whitespace and short filler count as empty. */
function looksEmpty(text) {
    if (text === null)
        return true;
    const t = text.trim();
    if (t.length === 0)
        return true;
    // A single stray character is not a deliverable.
    if (t.length < 8)
        return true;
    return false;
}
// ── agy-staff normalizer ────────────────────────────────────────────────────
/**
 * Map an agy-staff payload onto ObservedJob.
 *
 * Status precedence (highest first):
 *   1. cancel marker exists                         ⇒ canceled    (HAZARD B)
 *   2. status.json status === 'canceled'           ⇒ canceled
 *   3. status.json status === 'error'               ⇒ failed
 *   4. status.json status === 'done'                ⇒ succeeded,
 *        UNLESS empty-output-with-warnings          ⇒ failed (suspicious_success)
 *   5. no status.json but progress evidence present ⇒ running
 *   6. nothing conclusive                           ⇒ unknown
 */
const agyNormalizer = (raw) => {
    const p = raw.payload;
    let warnings = [];
    const canceled = asBool(p[AGY_PAYLOAD.canceled]) === true;
    const terminalStatus = asString(p[AGY_PAYLOAD.status]);
    const statusWarnings = asBool(p[AGY_PAYLOAD.statusWarnings]);
    asString(p[AGY_PAYLOAD.statusReason]);
    const progressWarnings = asStringArray(p[AGY_PAYLOAD.progressWarnings]);
    const output = asString(p[AGY_PAYLOAD.output]);
    const hasProgressFile = asBool(p[AGY_PAYLOAD.hasProgressFile]) === true;
    const lastEventAt = asString(p[AGY_PAYLOAD.lastEventAt]);
    const finishedAt = asString(p[AGY_PAYLOAD.finishedAt]);
    const strippedCount = asNumber(p[AGY_PAYLOAD.notificationsStripped]) ?? 0;
    const telemetry = (p[AGY_PAYLOAD.telemetry] ?? {});
    // -- warning: de-polluted result (HAZARD C) ---------------------------------
    if (strippedCount > 0) {
        warnings.push({
            code: "polluted_result",
            message: `Removed ${strippedCount} <system_notification> block${strippedCount === 1 ? '' : 's'} from the result text.`,
        });
    }
    // -- warning: tool errors observed during the run --------------------------
    const sawAgyError = asBool(telemetry["saw_agy_error"]) === true;
    if (sawAgyError || progressWarnings.length > 0) {
        const detail = asString(telemetry["agy_error_reason"]) ??
            (progressWarnings[0] ?? "provider reported warnings");
        warnings.push({ code: "tool_error", message: detail });
    }
    // -- warning: cancellation --------------------------------------------------
    if (canceled || terminalStatus === "canceled") {
        warnings.push({ code: "canceled", message: "canceled" });
    }
    // -- status resolution ------------------------------------------------------
    const emptyOutput = looksEmpty(output);
    let status;
    if (canceled || terminalStatus === "canceled") {
        status = "canceled";
    }
    else if (terminalStatus === "error") {
        status = "failed";
    }
    else if (terminalStatus === "done") {
        // ── THE HEADLINE RULE ──────────────────────────────────────────────────
        // "done" + (warnings OR an empty answer) is a SUSPICIOUS success. We
        // refuse to call it `succeeded`, because doing so is exactly the failure
        // mode this project exists to eliminate: reporting work as done that was
        // not. Empty-and-warned ⇒ failed with a suspicious_success warning.
        if (emptyOutput) {
            status = "failed";
            warnings.push({
                code: "empty_output",
                message: "no output",
            });
            if (statusWarnings === true || progressWarnings.length > 0) {
                warnings.push({
                    code: "suspicious_success",
                    message: "success with warnings and no output",
                });
            }
            else {
                warnings.push({
                    code: "suspicious_success",
                    message: "success with no output",
                });
            }
        }
        else {
            // Non-empty output: still downgrade to `failed` if the provider flagged
            // hard warnings? No — warnings alone don't fail a job that clearly
            // produced work. But `statusWarnings: true` with no progress warning
            // text and a suspiciously short body is still suspicious; we flag it as
            // a warning while keeping status `succeeded`. This is the "clean success
            // vs. clean-ish success" distinction: warn loudly, don't overclaim.
            status = "succeeded";
            if (statusWarnings === true) {
                warnings.push({
                    code: "suspicious_success",
                    message: "done with warnings; review it",
                });
            }
        }
    }
    else if (hasProgressFile || lastEventAt !== null) {
        // Terminal status file not written yet but live evidence present ⇒ running.
        status = "running";
    }
    else {
        // No status.json, no progress. Could be a job that was cleaned up entirely,
        // or a job we know nothing about. `unknown` is the honest answer.
        status = "unknown";
        warnings.push({
            code: "incomplete_state",
            message: "no status or progress found",
        });
    }
    // A canceled job that also has an empty output is expected; don't double-flag.
    if (status === "canceled" && emptyOutput) {
        warnings = warnings.filter((w) => w.code !== "empty_output");
    }
    // -- usage ------------------------------------------------------------------
    let usage = null;
    const usageParts = {};
    const tin = asNumber(telemetry["tokens_in"]);
    const tout = asNumber(telemetry["tokens_out"]);
    const tthink = asNumber(telemetry["tokens_think"]);
    const tcache = asNumber(telemetry["tokens_cache"]);
    const durMs = asNumber(telemetry["duration_ms"]);
    const turns = asNumber(telemetry["turns"]);
    if (tin !== null)
        usageParts["inputTokens"] = tin;
    if (tout !== null)
        usageParts["outputTokens"] = tout;
    if (tthink !== null)
        usageParts["thinkingTokens"] = tthink;
    if (tcache !== null)
        usageParts["cacheTokens"] = tcache;
    if (durMs !== null)
        usageParts["durationMs"] = durMs;
    if (turns !== null)
        usageParts["turns"] = turns;
    if (Object.keys(usageParts).length > 0)
        usage = usageParts;
    // -- startedAt: agy-staff does not store a clean start time on the files we
    // read, so we leave it null rather than guessing. (Honor the contract: an
    // explicit null beats an invented value.)
    const startedAt = null;
    // -- updatedAt: the freshest timestamp we have. --
    const updatedAt = lastEventAt ?? finishedAt;
    return {
        provider: "agy-staff",
        jobId: raw.jobId,
        status,
        warnings,
        output,
        startedAt,
        updatedAt,
        finishedAt,
        mode: asString(p[AGY_PAYLOAD.mode]),
        model: asString(p[AGY_PAYLOAD.model]) ?? asString(telemetry["model"]),
        label: asString(p[AGY_PAYLOAD.profile]),
        outputTruncated: asBool(p[AGY_PAYLOAD.outputTruncated]) === true,
        usage,
        partial: raw.partial === true,
        raw: p,
    };
};
// ── agent-smith normalizer ──────────────────────────────────────────────────
/**
 * Map an agent-smith payload onto ObservedJob.
 *
 * THIS IS THE PRIMARY NORMALIZER, and it is far shorter than the two above
 * because we own the format (see forge/format.ts). Three rows, in order:
 *
 *   1. cancel marker exists                    ⇒ canceled   (outranks job.json:
 *      the marker is written the instant cancel is requested, and the worker may
 *      never get to write its own terminal state)
 *   2. job.json.status is a terminal state      ⇒ that state, VERBATIM
 *   3. otherwise                               ⇒ running, or unknown if the
 *      anchor was unreadable
 *
 * ROW 2 HAS NO JUDGEMENT IN IT, and that is deliberate. The suspicious-success
 * downgrade — the headline rule of this whole codebase — is applied ONCE, at the
 * moment of writing, by `forge/format.ts`'s `deriveStatus`. It is not applied
 * again here. A normalizer that re-derived the verdict from the output would be a
 * second, subtly different implementation of the same rule, and the day the two
 * disagree the mod would draw one state while the channel announced another.
 *
 * The reader's job is to report what is on disk. The writer's job is to decide
 * what it means. One decision, one place.
 */
const smithNormalizer = (raw) => {
    const p = raw.payload;
    const warnings = [];
    const canceled = asBool(p[SMITH_PAYLOAD.canceled]) === true;
    const status = asString(p[SMITH_PAYLOAD.status]);
    const output = asString(p[SMITH_PAYLOAD.output]);
    const denied = p[SMITH_PAYLOAD.deniedActions];
    const deniedCount = Array.isArray(denied) ? denied.length : 0;
    const errorText = asString(p[SMITH_PAYLOAD.error]);
    const progressWarnings = asStringArray(p[SMITH_PAYLOAD.progressWarnings]);
    // A newer on-disk schema is not a job we understand. `unknown` is the honest
    // answer and it must survive to the surface: `unknown` is
    // load-bearing and must never be collapsed.
    const schema = asNumber(p[SMITH_PAYLOAD.schema]);
    if (deniedCount > 0) {
        const failedWithoutOutput = status === "failed" && (output === null || output.trim() === '');
        warnings.push({
            code: failedWithoutOutput ? "suspicious_success" : "tool_error",
            message: `${deniedCount} ${deniedCount === 1 ? 'call' : 'calls'} denied`,
        });
    }
    // The forge's error for a denial restates it ("denied view_file · …"); any other error still shows.
    if (errorText !== null && !(deniedCount > 0 && /^denied\b/.test(errorText))) {
        warnings.push({ code: "tool_error", message: errorText });
    }
    for (const w of progressWarnings) {
        warnings.push({ code: STEER_NOT_APPLIED_RE.test(w) ? "steer_not_applied" : "tool_error", message: w });
    }
    let resolved;
    if (canceled) {
        resolved = "canceled";
        warnings.push({ code: "canceled", message: "canceled" });
    }
    else if (schema !== null && schema > SCHEMA_VERSION) {
        // A newer writer's file. `unknown`, and NOT `running`: "we cannot read this"
        // is a different claim from "it is working", and drawing one as the other is
        // the specific failure `unknown` exists to prevent.
        resolved = "unknown";
        warnings.push({
            code: "incomplete_state",
            message: `schema v${schema} is newer than this reader (v${SCHEMA_VERSION})`,
        });
    }
    else if (status === "succeeded") {
        resolved = "succeeded";
        if (output === null || output.trim() === '') {
            // Defensive only. deriveStatus cannot produce `succeeded` with an empty
            // report, so reaching here means job.json was written by something other
            // than forge/writer.ts. Believe the file, flag the contradiction, and do
            // not silently upgrade a job with no output to a success.
            warnings.push({
                code: "empty_output",
                message: "done, but no output on disk",
            });
        }
    }
    else if (status === "failed") {
        resolved = "failed";
    }
    else if (status === "canceled") {
        resolved = "canceled";
    }
    else if (status === "running") {
        resolved = "running";
    }
    else if (raw.partial === true) {
        // The anchor is missing. NOT `running`: "we cannot tell" and "it is working"
        // are different claims and a band that draws one as the other is lying.
        resolved = "unknown";
        warnings.push({
            code: "incomplete_state",
            message: "job.json missing or unreadable",
        });
    }
    else {
        resolved = "unknown";
        warnings.push({
            code: "incomplete_state",
            message: "no status in job.json",
        });
    }
    // A cancelled job's empty output is expected, not a defect.
    const kept = resolved === "canceled" ? warnings.filter((w) => w.code !== "empty_output") : warnings;
    return buildSmith(raw, resolved, kept);
};
/** Assemble the ObservedJob for the agent-smith normalizer. */
function buildSmith(raw, status, warnings) {
    const p = raw.payload;
    const usage = asUsage(p[SMITH_PAYLOAD.usage]);
    const toolCalls = asNumber(p[SMITH_PAYLOAD.toolCalls]);
    const usageFull = usage === null
        ? toolCalls === null || toolCalls === 0
            ? null
            : { turns: toolCalls }
        : toolCalls === null
            ? usage
            : { ...usage, turns: toolCalls };
    return {
        provider: "agent-smith",
        jobId: raw.jobId,
        status,
        warnings,
        output: asString(p[SMITH_PAYLOAD.output]),
        startedAt: asString(p[SMITH_PAYLOAD.startedAt]) ?? asString(p[SMITH_PAYLOAD.createdAt]),
        updatedAt: asString(p[SMITH_PAYLOAD.updatedAt]) ?? asString(p[SMITH_PAYLOAD.lastEventAt]),
        finishedAt: asString(p[SMITH_PAYLOAD.finishedAt]),
        mode: asString(p[SMITH_PAYLOAD.mode]),
        model: asString(p[SMITH_PAYLOAD.model]),
        // `label` is the pane's provider/permission word. Ours is honest about the
        // one field an operator must never have to guess: did this run with the
        // tool-approval prompt bypassed.
        label: asBool(p[SMITH_PAYLOAD.unrestricted]) === true
            ? "unrestricted"
            : asString(p[SMITH_PAYLOAD.provider]),
        outputTruncated: false,
        usage: usageFull,
        partial: raw.partial === true,
        raw: p,
    };
}
/**
 * Coerce a usage bag into the nullable ObservedUsage shape.
 *
 * Absent is absent. A provider that reports no token counts gets `null`, not a
 * bag of zeroes, because a confident `0` drawn on the pane is a measurement
 * nobody took.
 */
function asUsage(v) {
    if (v === null || typeof v !== "object")
        return null;
    const src = v;
    const out = {};
    const map = [
        ["inputTokens", "inputTokens"],
        ["outputTokens", "outputTokens"],
        ["thinkingTokens", "thinkingTokens"],
        ["cacheReadTokens", "cacheTokens"],
    ];
    for (const [from, to] of map) {
        const n = asNumber(src[from]);
        if (n !== null)
            out[to] = n;
    }
    return Object.keys(out).length > 0 ? out : null;
}
// ── registry of normalizers ─────────────────────────────────────────────────
const NORMALIZERS = new Map([
    ["agent-smith", smithNormalizer],
    ["agy-staff", agyNormalizer],
]);
/**
 * Normalize a raw provider snapshot.
 *
 * Unknown provider ⇒ returns a minimal `unknown` ObservedJob rather than
 * throwing, so adding a reader before adding its normalizer degrades to
 * "shows up but unknown", not "crashes the band".
 */
function normalize(raw) {
    const norm = NORMALIZERS.get(raw.provider);
    return norm ? norm(raw) : fallbackNormalizer(raw);
}
/** Minimal normalization used when no provider-specific normalizer is registered. */
function fallbackNormalizer(raw) {
    return {
        provider: raw.provider,
        jobId: raw.jobId,
        status: "unknown",
        warnings: [
            {
                code: "incomplete_state",
                message: `No normalizer registered for provider "${raw.provider}".`,
            },
        ],
        output: null,
        startedAt: null,
        updatedAt: null,
        finishedAt: null,
        mode: null,
        model: null,
        label: null,
        outputTruncated: false,
        usage: null,
        partial: true,
        raw: raw.payload,
    };
}/**
 * pipeline/routing.ts — dynamic model/stage selection.
 *
 * Six rules, each backed by a measurement. If you change one of these, change
 * the comment that justifies it, or you are just guessing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE 1 — DEFAULT EVERY STAGE TO THE CHEAPEST TIER.
 *
 * Measured on this user's own jobs: `high` effort cost **+50% wall clock and
 * 1.9x thinking tokens for ZERO accuracy gain** on an in-band task. Effort is
 * the one knob that reliably *spends* without returning anything. So `low` is
 * not a cautious default, it is the empirically correct starting point, and
 * spending effort has to be earned by a failure (RULE 2) rather than granted by
 * optimism.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE 2 — ESCALATE ON STALL SHAPES, NEVER ON THE FIRST ERROR.
 *
 * In a real 28-minute job, the first tool error appeared at **tool #34 of 484**
 * and that job **SUCCEEDED**. Agents that do long work error early and recover;
 * error count is therefore close to uncorrelated with failure, and any policy
 * that escalates on "an error happened" would have burned a stronger model on
 * the majority of *successful* jobs.
 *
 * What correlates with failure is a *shape*: the same failure signature
 * repeating, edits that churn with nothing ever verified, or a long run of
 * turns that change nothing. Those are patterns over an attempt, not moments.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE 3 — ESCALATE BY CONTINUING WITH CONTEXT, NOT BY RESTARTING.
 *
 * A restart discards the completed work, the explored dead ends, and every file
 * the worker already read, then re-pays for all of it. Resuming costs one call
 * and keeps the state that made the attempt worth escalating. See
 * `StageContinuation`. A restart is only correct when there is no transcript to
 * preserve.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE 4 — NO CONFIDENCE PREDICTION. NO DIFFICULTY CLASSIFIER.
 *
 * There is no reliable pre-hoc signal. Anything that claims to know a task's
 * difficulty *before* the work is done is guessing with extra steps, and a
 * guess that gates spend multiplies: mis-calibrate one way and every simple task
 * gets a frontier model, mis-calibrate the other way and the hard task never
 * escalates at all.
 *
 * The reliable signal only exists after the work is done, which is why this
 * module is *post-hoc by construction*: it consumes `Observation[]` from an
 * attempt that already ran. The consequence is deliberate — cheap models do the
 * cheap work and we pay for escalation exactly when the attempt actually went
 * sideways, rather than paying a tax on every job to insure against the ones
 * that would have been fine anyway.
 *
 * If someone asks for a `predictDifficulty(stage)` or a `confidence` field:
 * don't add it. Route on the artifact of the attempt instead.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE 5 — `moderate` IS A CROSS-FAMILY PROBE, AND IT IS NOT DEBATE.
 *
 * Generative agreement between same-family models is correlated: **60% agreement
 * when both models err** (ICML 2025, across 350+ models). Correlated errors mean
 * self-consistency is not verification — a model asked to check its own work
 * reproduces its own failure modes at a high rate, and the agreement looks like
 * confirmation. Only a different model *family* has a sufficiently independent
 * error distribution to make "did you miss this?" mean anything.
 *
 * That is also why `moderate` takes one opposing voice and does not vote: the
 * finding it replaces is that **debate underperforms plain self-consistency and
 * gets worse with more budget** (2406.06461, four budget-matched replications).
 * More models agreeing proves less and costs more. One different-family probe,
 * applied to a written artifact, is the honest version.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE 6 — EVERY STAGE IS ALLOWED TO STAY CHEAP.
 *
 * A stage with no stall signal never escalates. The common case must be cheap;
 * if routing spends by default, RULE 1 is dead.
 * ─────────────────────────────────────────────────────────────────────────────
 */
/* -------------------------------------------------------------------------- */
/* Model families                                                              */
/* -------------------------------------------------------------------------- */
/**
 * Provider and model prefixes mapped to a model family.
 *
 * WHY THIS TABLE EXISTS: "different model" is not enough. Two models from the
 * same vendor share training data, post-training recipes and failure modes, so
 * their agreement is correlated (RULE 5). The unit that buys independence is the
 * family.
 *
 * It is a prefix table on purpose — deliberately shallow. An unrecognised model
 * gets family 'unknown', which makes `assertCrossFamily` fail loudly instead of
 * quietly granting independence that may not exist.
 */
const FAMILY_PREFIXES = [
    ['gpt', 'openai'],
    ['o1', 'openai'],
    ['o3', 'openai'],
    ['o4', 'openai'],
    ['codex', 'openai'],
    ['claude', 'anthropic'],
    ['sonnet', 'anthropic'],
    ['opus', 'anthropic'],
    ['haiku', 'anthropic'],
    ['gemini', 'google'],
    ['gemma', 'google'],
    // Kimi Code's managed aliases are Moonshot models. The provider-name fallback
    // stays 'unknown' because a kimi config can point at any OpenAI-compatible
    // vendor; only an id that names Moonshot itself claims the family.
    ['kimi-code/', 'moonshot'],
    ['moonshot-ai/', 'moonshot'],
    ['moonshot/', 'moonshot'],
    ['kimi-', 'moonshot'],
    ['k3', 'moonshot'],
    ['llama', 'meta'],
    ['qwen', 'alibaba'],
    ['deepseek', 'deepseek'],
    ['mistral', 'mistral'],
    ['grok', 'xai'],
];
/**
 * Provider-level fallback for models the prefix table does not know.
 * A provider's *vendor* is the best guess at its family.
 */
const PROVIDER_FAMILIES = {
    gemini: 'google',
    codex: 'openai',
    openai: 'openai',
    claude: 'anthropic',
    anthropic: 'anthropic',
    agy: 'unknown',
    opencode: 'unknown',
    // Config-dependent: [models] can name any vendor. Moonshot model ids are
    // resolved by the prefix table above.
    kimi: 'unknown',
};
/**
 * Family of a model id, or `'unknown'`.
 *
 * Unresolved ids stay 'unknown' on purpose. 'unknown' is not "no family", it is
 * "we do not know enough to claim independence", and the cross-family assertions
 * in this file treat it as a failure.
 */
function familyOf(id) {
    const lower = id.toLowerCase();
    for (const [prefix, family] of FAMILY_PREFIXES) {
        if (lower.startsWith(prefix))
            return family;
    }
    return PROVIDER_FAMILIES[lower] ?? 'unknown';
}
/** True when two ids are known to share a model family. */
function sameFamily(a, b) {
    const fa = familyOf(a);
    const fb = familyOf(b);
    // 'unknown' is never treated as independent from anything, including itself.
    return fa === 'unknown' || fb === 'unknown' || fa === fb;
}
const DEFAULT_STALL_POLICY = {
    repeatSignatureCount: 3,
    editChurnMinEdits: 8,
    noProgressTurns: 6,
    maxEscalations: 2,
    /**
     * RULE 2, as data. `first-error` is listed here so that any future code that
     * tries to escalate on it fails a test rather than shipping.
     */
    ignoredSignals: ['first-error', 'error-count', 'slow-start', 'self-doubt', 'looks-hard'],
};
/**
 * Reduce an error message to a comparable signature.
 *
 * Paths, line numbers, hex ids and quoted values change between occurrences of
 * the *same* failure, so comparing raw strings undercounts recurrence. We keep
 * the alphabetic words, drop the numbers, and truncate — the goal is "same
 * failure?" not "same message?".
 */
function normalizeSignature(message) {
    const words = message
        .toLowerCase()
        // Quoted spans and path-like runs vary between occurrences of the SAME
        // failure, so they are replaced wholesale rather than split into words.
        // Without this, "module './src/user/profile.ts'" and "module
        // './src/admin/settings.ts'" read as different failures and recurrence goes
        // uncounted — which is the one thing this function exists to detect.
        .replace(/'[^']*'/g, ' ')
        .replace(/"[^"]*"/g, ' ')
        .replace(/`[^`]*`/g, ' ')
        .replace(/[a-z0-9_./\\-]*[\\/][a-z0-9_./\\-]*/g, ' path ')
        .replace(/[0-9a-f]{8,}/g, '#')
        .replace(/\d+/g, '#')
        .split(/[^a-z]+/)
        .filter((w) => w.length > 2);
    return words.slice(0, 10).join(' ') || 'unknown';
}
function observationsOf(events) {
    let turns = 0;
    const errors = [];
    const edits = [];
    const verifications = [];
    for (const ev of events) {
        turns = Math.max(turns, ev.turn);
        if (ev.kind === 'error')
            errors.push(ev);
        else if (ev.kind === 'edit')
            edits.push(ev);
        else if (ev.kind === 'verification')
            verifications.push(ev);
    }
    return { errors, edits, verifications, turns };
}
/**
 * Decide whether an attempt stalled, and in what shape.
 *
 * Note the shape of the API: it takes an attempt that has already happened.
 * There is no variant of this function that runs before the work (RULE 4).
 */
function assessStall(events, policy = DEFAULT_STALL_POLICY) {
    if (events.length === 0) {
        // No structured events is not evidence of health. It is absence of evidence.
        return { shape: null, escalate: false, because: 'no observations reported', evidence: [] };
    }
    const { errors, edits, verifications, turns } = observationsOf(events);
    // 1. Same signature, repeatedly.
    const counts = new Map();
    for (const ev of errors) {
        const sig = normalizeSignature(ev.message ?? '');
        counts.set(sig, (counts.get(sig) ?? 0) + 1);
    }
    let worstSig = '';
    let worstCount = 0;
    for (const [sig, n] of counts) {
        if (n > worstCount) {
            worstSig = sig;
            worstCount = n;
        }
    }
    if (worstCount >= policy.repeatSignatureCount) {
        return {
            shape: 'repeat-signature',
            escalate: true,
            because: `same failure repeated ${worstCount}x: '${worstSig}'`,
            evidence: [
                `signature '${worstSig}' x${worstCount} (threshold ${policy.repeatSignatureCount})`,
                `total errors in attempt: ${errors.length}`,
                // The counter-evidence, recorded so the decision is auditable.
                `distinct signatures: ${counts.size} — repetition, not variety, is the signal`,
            ],
        };
    }
    // 2. Edits without ever running anything.
    if (edits.length >= policy.editChurnMinEdits && verifications.length === 0) {
        return {
            shape: 'edit-churn-unverified',
            escalate: true,
            because: `${edits.length} edits with zero verification runs`,
            evidence: [
                `edits: ${edits.length} (threshold ${policy.editChurnMinEdits})`,
                'verification runs: 0',
                'the worker is asserting success it has never observed',
            ],
        };
    }
    // 3. A long stretch where nothing happened.
    // A turn is INACTIVE when it appears in the stream carrying only prose: the
    // worker emitted turns but made no tool call, no edit and no run. The signal is
    // the length of a contiguous inactive run, so interleaving real activity resets
    // it — a worker that keeps poking around is not stalled, however long it takes.
    const activeTurns = new Set();
    for (const ev of events) {
        if (ev.kind !== 'text')
            activeTurns.add(ev.turn);
    }
    const inactiveTurns = [...new Set(events.map((ev) => ev.turn))]
        .filter((t) => !activeTurns.has(t))
        .sort((a, b) => a - b);
    let bestRun = 0;
    let run = 0;
    let prev = -2;
    for (const t of inactiveTurns) {
        run = t === prev + 1 ? run + 1 : 1;
        if (run > bestRun)
            bestRun = run;
        prev = t;
    }
    if (bestRun >= policy.noProgressTurns) {
        return {
            shape: 'no-progress',
            escalate: true,
            because: `${bestRun} consecutive turns with no tool call, edit or run`,
            evidence: [`longest inactive run: ${bestRun} turns (threshold ${policy.noProgressTurns})`],
        };
    }
    // 4/5. The worker's own hard stop. This one is trustworthy *because* it is a
    // terminal condition, not a prediction — a runner that reports it has run out
    // of budget, and no amount of the same budget helps.
    const declared = errors.find((ev) => /\b(context (exhausted|window|length)|max (tokens|turns)|out of budget|exceeded)\b/.test(ev.message ?? ''));
    if (declared) {
        return {
            shape: 'context-exhaustion',
            escalate: true,
            because: 'worker reported a hard budget/context limit',
            evidence: [normalizeSignature(declared.message ?? '')],
        };
    }
    const stuck = events.find((ev) => ev.kind === 'text' && /\bi (can'?t|cannot|am unable to) (proceed|continue)\b/i.test(ev.message ?? ''));
    if (stuck) {
        return {
            shape: 'declared-stuck',
            escalate: true,
            because: 'worker declared it could not proceed',
            evidence: [(stuck.message ?? '').slice(0, 200)],
        };
    }
    // The counter-case, stated explicitly: a first error is NOT a stall. In the
    // reference 28-minute job the first tool error came at tool #34 of 484 and the
    // job succeeded. It must not reach this function's caller as a reason to spend.
    if (errors.length > 0 && counts.size === errors.length) {
        return {
            shape: null,
            escalate: false,
            because: `${errors.length} error(s), all distinct signatures — variety, not repetition`,
            evidence: [
                `distinct signatures: ${counts.size}`,
                'not escalating: an isolated error is the observed normal for long jobs (tool #34 of 484 still succeeded)',
            ],
        };
    }
    return {
        shape: null,
        escalate: false,
        because: `${turns} turns, ${errors.length} errors, ${edits.length} edits, no stall shape`,
        evidence: [],
    };
}
/**
 * Ladders per provider.
 *
 * These are *declared capabilities*, not a ranking of intelligence. If a
 * provider cannot offer a rung, the ladder stops there rather than substituting
 * something it was not measured for.
 */
const DEFAULT_LADDERS = {
    gemini: { defaultModel: 'gemini-flash', strongerModel: 'gemini-pro', label: 'gemini' },
    codex: { defaultModel: 'gpt-5.6-mini', strongerModel: 'gpt-5.6-sol', label: 'codex' },
    claude: {
        defaultModel: 'claude-sonnet',
        strongerModel: 'claude-opus',
        crossFamilyModel: 'gemini-flash',
        label: 'claude',
    },
    agy: { defaultModel: 'agy-default', label: 'agy' },
    opencode: { defaultModel: 'opencode-default', label: 'opencode' },
    // No invented model id: kimi's real default lives in its config.toml, and
    // print mode has no per-run effort flag (routing's effort is ignored by the
    // adapter with a warning).
    kimi: { label: 'kimi', efforts: false },
};
const TIER_ORDER = ['t0-cheap', 't1-effort', 't2-stronger', 't3-cross-family'];
/** Effort to use at each tier. Note t0/t1 keep the cheapest MODEL. */
function effortForTier(tier) {
    switch (tier) {
        case 't0-cheap':
            return 'low';
        case 't1-effort':
            return 'high';
        case 't2-stronger':
        case 't3-cross-family':
            return 'medium';
    }
}
/** The rationale string is a log line. Write it like one. */
function rationaleFor(tier, stage, ladder) {
    const who = ladder.label ?? stage.provider;
    switch (tier) {
        case 't0-cheap':
            return `${stage.name}: ${who} default model at low effort — measured default, high effort cost +50% wall clock / 1.9x thinking tokens for zero accuracy gain`;
        case 't1-effort':
            return `${stage.name}: same model, effort raised — only after a stall shape; the in-band measurement does not apply once the attempt is out-of-band`;
        case 't2-stronger':
            return `${stage.name}: stronger model in the same provider (${who}) after ${'stall shape'}`;
        case 't3-cross-family':
            return `${stage.name}: different model family after stall — correlated same-family agreement is not verification (60% agreement when both err, ICML 2025)`;
    }
}
/**
 * The initial routing for a stage: RULE 1, the cheapest tier.
 *
 * A spec author may pin model/effort (`stage.routingPinned`); we never
 * overwrite a deliberate pin, because that would silently discard the one
 * measurement they made themselves.
 */
function planInitialRouting(stage, ladders = DEFAULT_LADDERS) {
    const ladder = ladders[stage.provider] ?? { label: stage.provider };
    if (stage.routingPinned) {
        return {
            tier: 't0-cheap',
            provider: stage.provider,
            model: stage.model ?? ladder.defaultModel,
            effort: stage.effort ?? 'low',
            rationale: `${stage.name}: pinned by spec author, not rewritten by routing`,
        };
    }
    return {
        tier: 't0-cheap',
        provider: stage.provider,
        model: stage.model ?? ladder.defaultModel,
        // RULE 1: low, unless the spec explicitly asked for something else.
        effort: stage.effort ?? 'low',
        rationale: rationaleFor('t0-cheap', stage, ladder),
    };
}
/**
 * The next rung, or null if there is no next rung.
 *
 * THE CEILING (maxEscalations, default 2) exists because an agent that keeps
 * escalating is an agent that never returns. Two is enough to survive a stall
 * shape and one failed remedy; past that, more of the same medicine is not a
 * strategy. When we stop, we stop with the evidence attached so a human can see
 * what the worker actually did: a loop is worse than a stop.
 */
function nextRouting(current, verdict, stage, ladders = DEFAULT_LADDERS, policy = DEFAULT_STALL_POLICY, escalationsSoFar = 0) {
    if (!verdict.escalate)
        return null;
    if (escalationsSoFar >= policy.maxEscalations)
        return null;
    const idx = TIER_ORDER.indexOf(current.tier);
    const ladder = ladders[current.provider] ?? { label: current.provider };
    // Walk up one rung at a time, skipping rungs this provider cannot fill.
    for (let next = idx + 1; next < TIER_ORDER.length; next++) {
        const tier = TIER_ORDER[next];
        if (tier === undefined)
            continue;
        // t1 changes effort, not model. A provider that cannot set effort per run
        // would spend a full duplicate attempt for nothing; skip the rung.
        if (tier === 't1-effort' && ladder.efforts === false)
            continue;
        const model = modelForTier(tier, current.provider, current.model, ladder);
        if (model === undefined)
            continue;
        // RULE 5: a cross-family rung that is not actually cross-family is a lie.
        // Fall through to no escalation rather than shipping correlated agreement.
        if (tier === 't3-cross-family') {
            const underReview = current.model ?? stage.provider;
            if (sameFamily(model, underReview))
                continue;
        }
        return {
            tier,
            provider: current.provider,
            model,
            effort: stage.effort ?? effortForTier(tier),
            rationale: rationaleFor(tier, stage, ladder),
        };
    }
    return null;
}
function modelForTier(tier, provider, currentModel, ladder) {
    switch (tier) {
        case 't0-cheap':
            return ladder.defaultModel ?? currentModel;
        case 't1-effort':
            // Same model, more effort: nothing to fill in.
            return currentModel ?? ladder.defaultModel;
        case 't2-stronger':
            return ladder.strongerModel;
        case 't3-cross-family':
            return ladder.crossFamilyModel;
    }
}/**
 * pipeline/pipeline.ts — the DAG runner.
 *
 * The one behaviour that justifies this file existing: **independent stages run
 * concurrently.** The motivating measurement was 16 jobs across 16.3 hours of
 * wall clock at a ceiling of 3 concurrent. A runner that walks stages in order,
 * or that serializes stages to keep a graph tidy, reproduces that exact
 * pathology. Concurrency here is not an optimisation; it is the product.
 *
 * Design notes worth knowing before editing:
 *
 *  - Scheduling is event-driven, not wave-based. A long `review` running at the
 *    same time as a 30-second `test` must not block the next stage from
 *    starting the moment `test` finishes. Dispatch happens whenever a slot frees
 *    or a stage settles, which keeps slots busy right up to the concurrency
 *    ceiling instead of idling at the end of every barrier.
 *
 *  - Failure propagates as `skipped`, never as `failed`. A dependent of a failed
 *    stage never ran, so calling it failed would be a lie about work that did
 *    not happen. It carries a `SkipReason` naming the upstream stage.
 *
 *  - The runner never interprets prose. Escalation decisions come from
 *    routing.ts over structured `Observation[]`; this file only moves the rung
 *    and records why.
 */
/**
 * Default ceiling on simultaneous stages.
 *
 * Not 3: that is the measured value that produced 16.3h for 16 jobs, and it is
 * an artifact of a queue that did not know stages were independent.
 *
 * Not Infinity: providers rate-limit, and a provider that silently throttles
 * looks exactly like a provider that is slow for reasons you cannot see. 8 is a
 * starting point for one pipeline, not a global fleet cap — the caller is
 * expected to keep the *fleet* total in budget, since this number bounds one
 * spec only. Raise it with evidence, not optimism.
 */
const DEFAULT_CONCURRENCY = 8;
/** Raised for a malformed spec. Cheap to catch, expensive to debug at runtime. */
class PipelineSpecError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PipelineSpecError';
    }
}
/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */
/**
 * Validate names, dependency edges and acyclicity.
 *
 * Cycle detection is done here rather than tolerated at runtime because a cycle
 * would silently produce a run where nothing ever dispatches — which looks
 * identical to "all my stages are pending". Failing at spec time names the
 * offending edge.
 */
function validateSpec(spec) {
    if (!spec.name.trim() || spec.stages.length === 0) {
        throw new PipelineSpecError('a pipeline needs a name and at least one stage');
    }
    if (spec.concurrency !== undefined && (!Number.isSafeInteger(spec.concurrency) || spec.concurrency < 1 || spec.concurrency > 32)) {
        throw new PipelineSpecError('concurrency must be an integer from 1 to 32');
    }
    const seen = new Set();
    for (const stage of spec.stages) {
        if (!stage.name.trim() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stage.name)) {
            throw new PipelineSpecError('every stage needs a name');
        }
        if (!stage.provider.trim())
            throw new PipelineSpecError(`stage '${stage.name}' needs a provider`);
        if (stage.timeoutMs !== undefined && (!Number.isSafeInteger(stage.timeoutMs) || stage.timeoutMs <= 0)) {
            throw new PipelineSpecError(`stage '${stage.name}' timeoutMs must be a positive integer`);
        }
        for (const check of stage.checks ?? []) {
            if (!check.name.trim() || !check.command.trim())
                throw new PipelineSpecError(`stage '${stage.name}' has an empty check`);
            if (check.timeoutMs !== undefined && (!Number.isSafeInteger(check.timeoutMs) || check.timeoutMs <= 0)) {
                throw new PipelineSpecError(`stage '${stage.name}' check timeoutMs must be a positive integer`);
            }
        }
        if (seen.has(stage.name)) {
            throw new PipelineSpecError(`duplicate stage name '${stage.name}'`);
        }
        seen.add(stage.name);
    }
    for (const stage of spec.stages) {
        for (const dep of stage.dependsOn ?? []) {
            if (!seen.has(dep)) {
                throw new PipelineSpecError(`stage '${stage.name}' depends on '${dep}', which does not exist`);
            }
            if (dep === stage.name) {
                throw new PipelineSpecError(`stage '${stage.name}' depends on itself`);
            }
        }
    }
    const byName = new Map(spec.stages.map((s) => [s.name, s]));
    const ancestorsOf = (name, into = new Set()) => {
        for (const dep of byName.get(name)?.dependsOn ?? []) {
            if (!into.has(dep))
                ancestorsOf(dep, into.add(dep));
        }
        return into;
    };
    for (const stage of spec.stages) {
        if (stage.continues === undefined)
            continue;
        const target = byName.get(stage.continues);
        const label = `stage '${stage.name}' continues '${stage.continues}'`;
        if (stage.continues === stage.name)
            throw new PipelineSpecError(`${label}, which is itself`);
        if (target === undefined)
            throw new PipelineSpecError(`${label}, which does not exist`);
        if (!ancestorsOf(stage.name).has(target.name)) {
            throw new PipelineSpecError(`${label}, which it does not depend on; add '${target.name}' to its dependsOn (directly or through another stage)`);
        }
        if (target.provider !== stage.provider) {
            throw new PipelineSpecError(`${label}, but a conversation cannot move between providers (${stage.provider} vs ${target.provider}); use provider ${target.provider} or omit provider to inherit it`);
        }
        if (stage.conversation !== undefined) {
            throw new PipelineSpecError(`${label} and also sets conversation; use one or the other`);
        }
    }
    // Kahn's algorithm; whatever remains in `pending` is on or behind a cycle.
    const pending = new Set(spec.stages.map((s) => s.name));
    const resolved = new Set();
    let progress = true;
    while (pending.size > 0 && progress) {
        progress = false;
        for (const stage of spec.stages) {
            if (!pending.has(stage.name))
                continue;
            const deps = stage.dependsOn ?? [];
            if (deps.every((d) => resolved.has(d))) {
                pending.delete(stage.name);
                resolved.add(stage.name);
                progress = true;
            }
        }
    }
    if (pending.size > 0) {
        throw new PipelineSpecError(`dependency cycle among stages: ${[...pending].sort().join(', ')}`);
    }
}
/* -------------------------------------------------------------------------- */
/* Concurrency primitive                                                       */
/* -------------------------------------------------------------------------- */
/**
 * A counting semaphore with an explicit "slot freed" signal.
 *
 * Why not `Promise.all` over ready stages? Because there is no cap. Why not a
 * fixed pool of N workers pulling from a queue? Because the queue would have to
 * be re-sorted on every settle to preserve readiness, which is the same
 * bookkeeping with less visibility. This is the smallest thing that gives both
 * the cap and the wakeup.
 */
class Scheduler {
    active = 0;
    slotWaiters = [];
    settleWaiters = [];
    // Declared explicitly, not a constructor parameter property: this project sets
    // `erasableSyntaxOnly`, so the code must survive type-stripping with no emit.
    limit;
    constructor(limit) {
        this.limit = limit;
    }
    /** Stages in flight right now. Read by the loop for peak tracking. */
    get activeCount() {
        return this.active;
    }
    hasSlot() {
        return this.active < this.limit;
    }
    enter() {
        this.active += 1;
    }
    /** Wake everything parked on a free slot, and anyone waiting on a settle. */
    release() {
        this.active -= 1;
        const slots = this.slotWaiters;
        this.slotWaiters = [];
        for (const wake of slots)
            wake();
        this.wakeSettle();
    }
    wakeSettle() {
        const waiters = this.settleWaiters;
        this.settleWaiters = [];
        for (const wake of waiters)
            wake();
    }
    /** Resolves when a slot frees, or immediately if one is free. */
    whenSlotFree() {
        if (this.hasSlot())
            return Promise.resolve();
        return new Promise((resolve) => this.slotWaiters.push(resolve));
    }
    /** Resolves when any stage settles. */
    whenSettled() {
        return new Promise((resolve) => this.settleWaiters.push(resolve));
    }
}
/**
 * Give a stage that `continues` another and omits `provider` that stage's
 * provider. Parsers call this before validateSpec, because a conversation can
 * only resume on the provider that holds it, so asking again is noise.
 */
function inheritContinuedProviders(stages) {
    const byName = new Map(stages.map((s) => [s.name, s]));
    const providerOf = (stage, seen) => {
        if (stage.provider !== undefined)
            return stage.provider;
        if (stage.continues === undefined || seen.has(stage.name))
            return undefined;
        const target = byName.get(stage.continues);
        return target === undefined ? undefined : providerOf(target, seen.add(stage.name));
    };
    return stages.map((stage) => {
        const provider = providerOf(stage, new Set());
        if (provider === undefined && stage.continues !== undefined && !byName.has(stage.continues)) {
            throw new PipelineSpecError(`stage '${stage.name}' continues '${stage.continues}', which does not exist`);
        }
        if (provider === undefined)
            throw new PipelineSpecError(`stage '${stage.name}' needs a provider`);
        return { ...stage, provider };
    });
}
/* -------------------------------------------------------------------------- */
/* The runner                                                                  */
/* -------------------------------------------------------------------------- */
/**
 * The mutable state of one `runPipeline` call, and the steps that act on it.
 *
 * A class rather than closures so each step is a named method that can be read
 * on its own. It holds no behaviour `runPipeline` did not already have.
 */
class PipelineExecution {
    spec;
    options;
    now;
    workDir;
    policy;
    abort = new AbortController();
    stages;
    outcomes = new Map();
    skipped = new Set();
    /**
     * Stages that have been dispatched at least once.
     *
     * Separate from `outcomes` on purpose: a dispatched stage is neither passed nor
     * finished, so readiness alone would re-dispatch it on the very next loop
     * iteration. Dispatch is tracked by "has this been started", completion by
     * "is there a result" — conflating the two is how a DAG runner ends up
     * running `implement` eight times in a row.
     */
    started = new Set();
    /** Stages currently in flight, so a timeout can abort exactly one attempt. */
    inflight = new Map();
    scheduler;
    order = [];
    peakConcurrency = 0;
    aborted = false;
    constructor(spec, options) {
        this.spec = spec;
        this.options = options;
        this.now = options.now ?? Date.now;
        this.workDir = options.workDir ?? spec.workDir ?? process.cwd();
        this.policy = options.policy ?? DEFAULT_STALL_POLICY;
        this.scheduler = new Scheduler(normalizeConcurrency(options.concurrency ?? spec.concurrency));
        this.stages = new Map(spec.stages.map((s) => [s.name, s]));
        const parentSignal = options.signal;
        if (parentSignal) {
            // Captured in a local: narrowing on `options.signal` does not survive into
            // the closure below, and `exactOptionalPropertyTypes` keeps it optional.
            const onAbort = () => this.abort.abort(parentSignal.reason);
            if (parentSignal.aborted)
                onAbort();
            else
                parentSignal.addEventListener('abort', onAbort, { once: true });
        }
    }
    depsOf(stage) {
        return stage.dependsOn ?? [];
    }
    /** A continuing stage works where its target worked unless it names its own workDir. */
    workDirOf(stage) {
        const own = stage.workDir ?? (stage.continues === undefined ? undefined : this.stages.get(stage.continues)?.workDir);
        return own ? path.resolve(this.workDir, own) : this.workDir;
    }
    /** A stage is dispatchable when it is unstarted, not skipped, and every dep passed. */
    isDispatchable(stage) {
        if (this.started.has(stage.name) || this.outcomes.has(stage.name) || this.skipped.has(stage.name))
            return false;
        return this.depsOf(stage).every((d) => this.outcomes.get(d)?.status === 'passed');
    }
    /**
     * Cascade `skipped` forward from anything not 'passed'.
     *
     * Iterated to a fixed point so a three-deep chain settles in one pass and the
     * reason reported names the *originating* failure rather than the neighbour
     * that happened to be checked first.
     */
    propagateSkips() {
        let changed = true;
        while (changed) {
            changed = false;
            for (const stage of this.spec.stages) {
                if (this.outcomes.has(stage.name) || this.skipped.has(stage.name))
                    continue;
                for (const dep of this.depsOf(stage)) {
                    const upstream = this.outcomes.get(dep);
                    if (this.skipped.has(dep)) {
                        this.skipStage(stage, 'upstream-skipped', dep, `skipped because upstream '${dep}' was skipped`);
                        changed = true;
                        break;
                    }
                    if (upstream && upstream.status !== 'passed') {
                        this.skipStage(stage, 'upstream-failed', dep, `not run: upstream '${dep}' finished '${upstream.status}'` +
                            (upstream.failure ? ` (${upstream.failure.code}: ${upstream.failure.message})` : ''));
                        changed = true;
                        break;
                    }
                }
            }
        }
    }
    skipStage(stage, kind, becauseOf, message) {
        const t = this.now();
        const result = {
            stage: stage.name,
            provider: stage.provider,
            model: stage.model,
            status: 'skipped',
            startedAt: t,
            finishedAt: t,
            durationMs: 0,
            skippedBecause: { kind, becauseOf, message },
        };
        this.skipped.add(stage.name);
        this.outcomes.set(stage.name, result);
        this.order.push(stage.name);
        this.options.onStageEnd?.(result);
    }
    /**
     * Inputs for a stage: every upstream artifact, in dependency order.
     *
     * Artifacts, not summaries. A downstream stage that needs to know what the
     * upstream stage concluded reads the upstream stage's own result.md, because
     * a summary written by a model is the thing most likely to be confidently
     * wrong (see verify/runner.ts for why prose is not a verdict).
     */
    inputsFor(stage) {
        const inherited = [];
        for (const dep of this.depsOf(stage)) {
            const upstream = this.outcomes.get(dep);
            if (!upstream)
                continue;
            const declaredPath = this.stages.get(dep)?.resultPath ?? 'result.md';
            inherited.push({ stage: dep, path: declaredPath, label: declaredPath });
            // Anything the upstream stage advertised beyond its main result.
            for (const art of upstream.artifacts ?? []) {
                if (art.path !== declaredPath)
                    inherited.push(art);
            }
        }
        return [...inherited, ...(stage.consumes ?? [])];
    }
    record(result, escalations) {
        const withEsc = escalations.length > 0 ? { ...result, escalations } : result;
        this.outcomes.set(result.stage, withEsc);
        this.order.push(result.stage);
        this.options.onStageEnd?.(withEsc);
    }
    /**
     * `continues`: resume the target's worker conversation. validateSpec proved
     * it is an ancestor, so it has passed by now; what can still be missing is the
     * conversation handle (the provider reported none) or its provider (an
     * escalation moved the target to another one). Returns the remedy as `problem`.
     */
    resolveContinued(stage, routing) {
        const target = this.stages.get(stage.continues);
        const done = this.outcomes.get(target.name);
        const ref = done?.transcriptRef;
        if (ref === undefined) {
            return { problem: `stage '${target.name}' produced no conversation handle to resume (the provider reported none); keep the fix in '${target.name}' or start a fresh worker` };
        }
        if (done?.provider !== routing.provider) {
            return { problem: `stage '${target.name}' finished on ${done?.provider}, but this stage runs on ${routing.provider} and a conversation cannot move between providers; pin '${target.name}' with routingPinned` };
        }
        return { stage: target.name, transcriptRef: ref, workerId: target.workerId, agentName: target.agentName };
    }
    /**
     * One attempt: run the stage under its own abort signal and timeout, and turn
     * a throw or a late success into the result it really is.
     */
    async runAttempt(stage, attempt, stageStart, routing, continuation, continued) {
        // Per-stage timeout: abort this attempt's signal without touching the run.
        const stageAbort = new AbortController();
        this.inflight.set(stage.name, stageAbort);
        if (this.abort.signal.aborted)
            stageAbort.abort(this.abort.signal.reason);
        const onParentAbort = () => stageAbort.abort(this.abort.signal.reason);
        this.abort.signal.addEventListener('abort', onParentAbort, { once: true });
        const timer = stage.timeoutMs
            ? setTimeout(() => stageAbort.abort(new Error(`stage timeout after ${stage.timeoutMs}ms`)), stage.timeoutMs)
            : undefined;
        this.options.onStageStart?.(stage, attempt);
        const ctx = {
            pipeline: this.spec.name,
            stage,
            attempt,
            workDir: this.workDirOf(stage),
            inputs: this.inputsFor(stage),
            routing,
            ...(continuation ? { continuation } : {}),
            ...(continued ? { continues: continued } : {}),
            signal: stageAbort.signal,
        };
        let result;
        try {
            result = await this.options.runner.run(ctx);
        }
        catch (err) {
            // A runner that throws has still told us something; turning it into a
            // result (rather than a rejected promise) keeps the DAG's bookkeeping
            // and lets dependents be skipped for the right reason.
            const t = this.now();
            result = {
                stage: stage.name,
                provider: routing.provider,
                model: routing.model,
                status: 'failed',
                startedAt: stageStart,
                finishedAt: t,
                durationMs: t - stageStart,
                failure: {
                    code: stageAbort.signal.aborted ? 'timeout' : 'runner-threw',
                    message: stageAbort.signal.aborted
                        ? `stage aborted (timeoutMs=${stage.timeoutMs ?? 'unset'})`
                        : `StageRunner threw: ${err instanceof Error ? err.message : String(err)}`,
                    retryable: !stageAbort.signal.aborted,
                },
            };
        }
        finally {
            if (timer)
                clearTimeout(timer);
            this.abort.signal.removeEventListener('abort', onParentAbort);
            this.inflight.delete(stage.name);
        }
        // A stage that reported success while its own signal was aborted is not a
        // success. Cheap check, and it closes the "signal-ignored" hole.
        const abortedThisAttempt = stageAbort.signal.aborted;
        if (abortedThisAttempt && result.status === 'passed') {
            this.aborted = true;
            result = {
                ...result,
                status: 'failed',
                failure: {
                    code: 'timeout',
                    message: `stage reported success after its abort signal fired ` +
                        `(timeoutMs=${stage.timeoutMs ?? 'unset'}); treating as failure`,
                    retryable: false,
                },
            };
        }
        return { result, abortedThisAttempt };
    }
    /**
     * After a failed, un-aborted attempt: stop with a final result, or escalate.
     *
     * Escalate only on a stall SHAPE (routing RULE 2). A plain failure with no
     * shape gets exactly the benefit of the doubt the reference job earned: the
     * first error of a long job is not evidence of a bad job. Pushes the new
     * escalation onto `escalations` when it retries.
     */
    decideEscalation(stage, result, routing, attempt, escalations) {
        const verdict = assessStall(result.observations ?? [], this.policy);
        const next = nextRouting(routing, verdict, stage, this.options.ladders, this.policy, escalations.length);
        if (!verdict.escalate || next === null) {
            if (!verdict.escalate) {
                return {
                    kind: 'stop',
                    result: {
                        ...result,
                        failure: result.failure
                            ? { ...result.failure, message: `${result.failure.message} (no stall shape: ${verdict.because})` }
                            : { code: 'failed', message: verdict.because },
                    },
                };
            }
            return {
                kind: 'stop',
                result: {
                    ...result,
                    failure: {
                        code: 'escalation-ceiling',
                        message: `stall shape '${verdict.shape}' persisted after ${escalations.length} ` +
                            'escalation(s); stopping and surfacing the evidence',
                        retryable: false,
                    },
                },
            };
        }
        const escalation = {
            attempt: escalations.length + 1,
            because: verdict.because,
            fromModel: routing.model,
            toModel: next.model,
            fromEffort: routing.effort,
            toEffort: next.effort,
            transcriptRef: result.transcriptRef,
            appendedContext: buildEscalationContext(verdict.because, result.outputTail),
        };
        escalations.push(escalation);
        return {
            kind: 'retry',
            routing: next,
            continuation: {
                attempt,
                priorStatus: result.status,
                transcriptRef: result.transcriptRef,
                transcriptProvider: routing.provider,
                appendedContext: escalation.appendedContext ?? '',
                priorEscalations: escalations,
            },
        };
    }
    /**
     * One stage, including its escalation ladder.
     *
     * RULE 3: every escalation after the first is a *continuation*. The previous
     * attempt's transcript reference and its failing tail are handed to the next
     * attempt so the worker resumes rather than starts over.
     */
    async runStage(stage) {
        const stageStart = this.now();
        let attempt = 1;
        let continuation;
        const escalations = [];
        let routing = planInitialRouting(stage, this.options.ladders);
        let continued;
        if (stage.continues !== undefined) {
            const resolved = this.resolveContinued(stage, routing);
            if ('problem' in resolved) {
                const t = this.now();
                this.record({
                    stage: stage.name, provider: routing.provider, model: routing.model, status: 'failed',
                    startedAt: stageStart, finishedAt: t, durationMs: t - stageStart,
                    failure: { code: 'no-conversation', message: `cannot continue: ${resolved.problem}`, retryable: false },
                }, []);
                return;
            }
            continued = resolved;
        }
        for (;;) {
            if (this.abort.signal.aborted) {
                this.aborted = true;
                const t = this.now();
                this.outcomes.set(stage.name, {
                    stage: stage.name,
                    provider: routing.provider,
                    model: routing.model,
                    status: 'failed',
                    startedAt: stageStart,
                    finishedAt: t,
                    durationMs: t - stageStart,
                    failure: {
                        code: 'aborted',
                        message: 'pipeline aborted before this stage completed',
                        retryable: false,
                    },
                    ...(escalations.length > 0 ? { escalations } : {}),
                });
                this.order.push(stage.name);
                return;
            }
            const { result, abortedThisAttempt } = await this.runAttempt(stage, attempt, stageStart, routing, continuation, continued);
            // An aborted attempt is exempt from escalation: a timeout is not a
            // reasoning failure, and spending an escalation to re-run the same work
            // under the same timeout would just burn the ceiling.
            if (result.status === 'passed' || abortedThisAttempt) {
                this.record(result, escalations);
                return;
            }
            const decision = this.decideEscalation(stage, result, routing, attempt, escalations);
            if (decision.kind === 'stop') {
                this.record(decision.result, escalations);
                return;
            }
            continuation = decision.continuation;
            routing = decision.routing;
            attempt += 1;
        }
    }
    /** Drive the DAG to completion and assemble the run. */
    async execute(startedAt) {
        const { spec, scheduler, started, outcomes } = this;
        while (true) {
            this.propagateSkips();
            const remaining = spec.stages.filter((s) => !started.has(s.name) && !outcomes.has(s.name));
            if (remaining.length === 0) {
                // Nothing left to dispatch, but stages we already started may still be
                // running. Returning here would hand back a PipelineRun with no outcomes
                // for them, so wait for the last one to settle.
                if (scheduler.activeCount === 0)
                    break;
                const settled = scheduler.whenSettled();
                if (scheduler.activeCount > 0)
                    await settled;
                continue;
            }
            // Dispatch everything currently dispatchable, bounded by the ceiling. This
            // is the whole concurrency story: any dispatchable stage takes the next free
            // slot, and the slot count is the only ceiling we impose.
            let dispatched = false;
            for (const stage of remaining) {
                if (!scheduler.hasSlot())
                    break;
                if (!this.isDispatchable(stage))
                    continue;
                started.add(stage.name);
                scheduler.enter();
                this.peakConcurrency = Math.max(this.peakConcurrency, scheduler.activeCount);
                dispatched = true;
                // Deliberately not awaited here: the stage runs concurrently and signals
                // the scheduler when it settles. Fire-and-observe is what keeps the other
                // branches moving, and it is why peakConcurrency is a measured fact rather
                // than an assumption about the ceiling.
                void this.runStage(stage).finally(() => scheduler.release());
            }
            if (dispatched) {
                // Keep draining the ready queue without waiting: if a stage settled during
                // the loop above, its dependents may already be dispatchable.
                continue;
            }
            // Nothing dispatchable. Two possible reasons:
            //  - something is still running, so we must wait for a settle or a free slot;
            //  - the graph is blocked, which validateSpec should have rejected.
            if (scheduler.activeCount > 0) {
                // Register the waiter BEFORE re-checking, or a release landing between the
                // check and the registration would leave us parked forever.
                const settled = scheduler.whenSettled();
                if (scheduler.activeCount > 0)
                    await settled;
                continue;
            }
            for (const stage of remaining) {
                this.skipStage(stage, 'upstream-skipped', this.depsOf(stage)[0] ?? '(none)', 'blocked: no dependency reached a passing state and nothing is in flight');
            }
            break;
        }
        // In-flight attempts are already settled at this point (the loop exits only
        // when every stage has an outcome), but a hard abort may leave stragglers.
        for (const controller of this.inflight.values())
            controller.abort();
        this.inflight.clear();
        const finishedAt = this.now();
        const abortedRun = this.aborted || this.abort.signal.aborted;
        return {
            pipeline: spec.name,
            status: summarize(spec.stages.map((s) => outcomes.get(s.name))),
            outcomes: Object.fromEntries(outcomes),
            order: this.order,
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt,
            peakConcurrency: this.peakConcurrency,
            ...(abortedRun ? { aborted: true } : {}),
        };
    }
}
async function runPipeline(spec, options) {
    validateSpec(spec);
    const startedAt = (options.now ?? Date.now)();
    return new PipelineExecution(spec, options).execute(startedAt);
}
function normalizeConcurrency(value) {
    if (value === undefined || Number.isNaN(value))
        return DEFAULT_CONCURRENCY;
    if (!Number.isFinite(value))
        return Number.MAX_SAFE_INTEGER;
    return Math.max(1, Math.floor(value));
}
/**
 * Roll stage results up into one status.
 *
 * 'partial' exists because "some stages ran and some did not" is the common
 * outcome of any real pipeline and is materially different from "nothing ran" —
 * a mod needs to draw those differently.
 */
function summarize(results) {
    let passed = 0;
    let bad = 0;
    for (const r of results) {
        if (!r)
            continue;
        if (r.status === 'passed')
            passed += 1;
        else
            bad += 1;
    }
    if (bad === 0)
        return 'passed';
    if (passed === 0)
        return 'failed';
    return 'partial';
}
/**
 * Text handed to the resuming worker.
 *
 * Bounded, because the point is to inform the next attempt, not to replay the
 * log. The stall shape is stated first: the worker needs to know what to change,
 * and a raw error dump invites it to re-read the same mistake.
 */
function buildEscalationContext(shape, outputTail) {
    const head = `Previous attempt stalled: ${shape}.`;
    const tail = outputTail?.trim();
    if (!tail)
        return head;
    return `${head}\n\nLast output (tail, may be truncated):\n${tail.slice(-4e3)}`;
}/**
 * failure-text.ts — the short error strings the adapters share.
 *
 * One spelling per case, so every provider fails in the same words. Detail that
 * only a developer needs (event-shape gaps, flag advice) belongs in code
 * comments; advice for the orchestrator is nextActionFor's job (forge/format.ts).
 */
const STDERR_TAIL_CHARS = 300;
/** `45m`, `1h05m`, `30s`, `2m10s`. Whole units, never raw milliseconds. */
function humanDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0)
        return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}m`;
    if (m > 0)
        return s === 0 ? `${m}m` : `${m}m${String(s).padStart(2, '0')}s`;
    return `${s}s`;
}
function timedOutText(durationMs) {
    return `timed out after ${humanDuration(durationMs)}`;
}
/** ` · stderr: <tail>`, or '' when stderr is empty. The last bounded part: errors come last. */
function stderrClause(stderr) {
    const t = stderr.trim();
    if (t === '')
        return '';
    return ` · stderr: ${t.length > STDERR_TAIL_CHARS ? `…${t.slice(-STDERR_TAIL_CHARS)}` : t}`;
}
/** `exited 1, no result` or `exited on SIGTERM, no result`, plus the stderr clause. */
function noResultText(exit) {
    const how = exit.code === null ? `on ${exit.signal ?? 'a signal'}` : String(exit.code);
    return `exited ${how}, no result${stderrClause(exit.stderr)}`;
}
/** `denied view_file, RunCommand · stderr: …` */
function deniedText(names, stderr) {
    const list = [...new Set(names.filter((n) => n !== ''))].join(', ');
    return `${list === '' ? 'denied' : `denied ${list}`}${stderrClause(stderr)}`;
}
/**
 * `recovered from a provider connection error at 21:11 UTC: ECONNRESET …`.
 * The warning a job carries when a worker hit an error, kept working and still
 * delivered its report. `at` is an ISO timestamp; `label` names the kind of error.
 */
function recoveredErrorText(label, message, at) {
    const flat = message.replace(/\s+/g, ' ').trim();
    const detail = flat.length > 140 ? `${flat.slice(0, 139)}…` : flat;
    const clock = /^\d{4}-\d\d-\d\dT(\d\d:\d\d)/.exec(at)?.[1];
    return `recovered from ${label}${clock === undefined ? '' : ` at ${clock} UTC`}${detail === '' ? '' : `: ${detail}`}`;
}/**
 * providers/ndjson.ts — shared spawn/stream plumbing for every adapter.
 *
 * WHY THIS EXISTS
 * ===============
 * Four CLIs, four JSON dialects, one set of hard-won process rules. Repeating
 * those rules per adapter is how you end up with the claude-squad trap: one
 * adapter quietly wrapping its child in a PTY, another forgetting to cap its
 * stderr buffer, a third leaking a listener. So they live here, once.
 *
 * THE RULES ENFORCED HERE (do not duplicate these in an adapter):
 *   1. stdio is ALWAYS ['ignore'|'pipe', 'pipe', 'pipe']. Never a TTY, never a
 *      PTY, never 'inherit'. ARCHITECTURE.md rules out tmux/claude-squad
 *      scrollback; a PTY would also merge stderr into stdout and destroy NDJSON.
 *   2. stdin is 'ignore' by default. Codex explicitly reads stdin when it is a
 *      pipe and will happily block waiting for input that never comes. agy and
 *      claude take the prompt on argv, so stdin is dead weight.
 *   3. stderr is capped. A worker that spams stderr must not OOM the parent.
 *   4. Every kill path goes through terminate(): SIGTERM, grace, SIGKILL.
 *   5. waitForResult resolves exactly once, on every terminal path including
 *      "the process exited and we never saw a result event".
 *
 * Node builtins only. No dependencies, by requirement and by taste.
 */
/**
 * Minimal `which`: walk PATH, test for X_OK.
 *
 * WHY NOT execFile('which', ...): spawning a shell helper once per provider per
 * startup is wasteful, and `which` does not exist on Windows. PATH walking is
 * ~20 lines, has zero process overhead, and behaves identically on all three
 * platforms. Cached per (binary, PATH) pair because detectAvailable() probes
 * four providers back to back and PATH does not change mid-run.
 *
 * NOTE: the PATH list separator is path.DELIMITER, not path.SEP. See the
 * comment inside the function below, which has the details.
 */
const pathProbeCache = new Map();
async function binaryOnPath(bin) {
    const pathEnv = process.env['PATH'] ?? '';
    const cacheKey = `${bin}|${pathEnv}`;
    const cached = pathProbeCache.get(cacheKey);
    if (cached !== undefined)
        return cached;
    // A name containing a path separator is a PATH, not a name. This is what makes
    // the documented AGENT_SMITH_<NAME>_BIN overrides work at all: without this,
    // path.join(dir, '/opt/bin/agy') yields '/usr/local/bin/opt/bin/agy' and an
    // absolute override can never resolve. Same rule as execvp.
    if (bin.includes('/') || bin.includes(path.sep)) {
        let direct = false;
        try {
            await access(bin, constants$1.X_OK);
            direct = true;
        }
        catch {
            /* not executable */
        }
        pathProbeCache.set(cacheKey, direct);
        return direct;
    }
    // `path.delimiter`, NOT `path.sep`. The PATH *list* separator is ':' on POSIX
    // and ';' on Windows; `path.sep` is '/' and '\' — the separator BETWEEN
    // components of a single path. Splitting PATH by path.sep walks garbage
    // fragments like 'sers/gathrid/.local/bin' and never finds anything, so
    // binaryOnPath returned false for every binary on a machine where all four
    // were installed. Caught by `agent-smith doctor` reporting zero providers.
    const dirs = pathEnv.split(path.delimiter).filter((d) => d !== '');
    let found = false;
    for (const dir of dirs) {
        const full = path.join(dir, bin);
        try {
            await access(full, constants$1.X_OK);
            found = true;
            break;
        }
        catch {
            /* keep walking */
        }
    }
    pathProbeCache.set(cacheKey, found);
    return found;
}
// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
/** Root for all provider-written state. Overridable for tests / multi-root setups. */
function stateRoot() {
    return process.env['AGENT_SMITH_STATE_DIR'] ?? path.join(os.homedir(), '.agent-smith', 'state');
}
/**
 * Create the state directory for a job. Returns the absolute path.
 * Called BEFORE spawn() so a consumer can tail events.jsonl the instant the
 * handle exists.
 */
function writeStateDir(provider, jobId, override) {
    const dir = override ?? path.join(stateRoot(), provider, jobId);
    mkdirSync(dir, { recursive: true });
    return dir;
}
/** Persist the exact argv/cwd/env-keys we spawned with. Debugging breadcrumb. */
function writeArgv(dir, argv, cwd) {
    // argv[0] is the binary path and can leak into logs; it is not a secret.
    writeFileSync(path.join(dir, 'argv.json'), JSON.stringify({ argv, cwd }, null, 2));
}
/**
 * Clamp a string to `max` characters, marking it truncated.
 *
 * WHY CHARACTERS AND NOT BYTES: a surrogate pair or a multi-byte UTF-8 char
 * split at a byte boundary produces replacement characters in the UI. JS strings
 * are already UTF-16, so slicing by code unit is safe for storage (it can split
 * a surrogate pair, hence the ellipsis hint that the text is cut).
 */
function truncate(text, max) {
    if (text.length <= max)
        return { text, truncated: false };
    return { text: `${text.slice(0, max)}…`, truncated: true };
}
/**
 * Coerce an unknown JSON value to a preview string.
 * Tool params come back as objects (`{"CommandLine":"cargo test"}`), which is
 * useless on a one-line band. We render them compactly rather than [object Object].
 */
function preview(value, max) {
    if (value === undefined || value === null)
        return undefined;
    let s;
    if (typeof value === 'string')
        s = value;
    else {
        try {
            s = JSON.stringify(value);
        }
        catch {
            s = String(value);
        }
    }
    return truncate(s, max);
}
/** Parse one line of a stream as JSON, or undefined if it is not an object. */
function tryParseObject(line) {
    const t = line.trim();
    if (t === '' || (t[0] !== '{' && t[0] !== '['))
        return undefined;
    try {
        const v = JSON.parse(t);
        if (v !== null && typeof v === 'object' && !Array.isArray(v))
            return v;
        return undefined;
    }
    catch {
        return undefined;
    }
}
/** Read a string field off an unknown record without fighting the type system. */
function str(o, key) {
    const v = o?.[key];
    return typeof v === 'string' ? v : undefined;
}
/** Read a nested record field. */
function obj(o, key) {
    const v = o?.[key];
    if (v !== null && typeof v === 'object' && !Array.isArray(v))
        return v;
    return undefined;
}
/** Read a finite number field. Strings that parse as numbers are accepted (some CLIs emit "3"). */
function num(o, key) {
    const v = o?.[key];
    if (typeof v === 'number' && Number.isFinite(v))
        return v;
    if (typeof v === 'string') {
        const n = Number(v);
        if (Number.isFinite(n))
            return n;
    }
    return undefined;
}
/** ISO timestamp. One helper so every event sorts lexicographically by time. */
function nowIso(at = Date.now()) {
    return new Date(at).toISOString();
}
/**
 * Bounded-queue bus.
 *
 * WHY THE BOUND: a `--forward-subagent-text` claude run with a chatty
 * subagent can emit events faster than a slow consumer drains them. Unbounded
 * buffering is a memory leak with a long fuse. On overflow we DROP the oldest
 * queued events and record that we did, rather than growing without limit.
 */
function createEventBus(maxQueue = 4096) {
    const listeners = new Set();
    const queue = [];
    let waiting;
    let done = false;
    function emit(event) {
        // A throwing listener must not take down the worker pump. Log and continue.
        for (const l of listeners) {
            try {
                l(event);
            }
            catch {
                /* consumer's problem, not the worker's */
            }
        }
        if (waiting) {
            const w = waiting;
            waiting = undefined;
            w({ value: event, done: false });
            return;
        }
        if (queue.length >= maxQueue)
            queue.shift();
        queue.push(event);
    }
    return {
        emit,
        onEvent(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        events: {
            [Symbol.asyncIterator]() {
                return {
                    next() {
                        const q = queue.shift();
                        if (q !== undefined)
                            return Promise.resolve({ value: q, done: false });
                        if (done)
                            return Promise.resolve({ value: undefined, done: true });
                        return new Promise((resolve) => {
                            waiting = resolve;
                        });
                    },
                    return() {
                        done = true;
                        waiting?.({ value: undefined, done: true });
                        return Promise.resolve({ value: undefined, done: true });
                    },
                };
            },
        },
        close() {
            done = true;
            const w = waiting;
            waiting = undefined;
            w?.({ value: undefined, done: true });
            listeners.clear();
        },
    };
}
/** Default heartbeat interval; mirrors surfaces/mod/hooks/stale.ts HEARTBEAT_MS. */
const HEARTBEAT_MS = 30_000;
const STDERR_CAPTURE_LIMIT = 256 * 1024; // 256 KB retained in memory for JobResult
const STDERR_LOG_LIMIT = 4 * 1024 * 1024; // 4 MB retained on disk
/**
 * Spawn a child with piped stdio and wire up the lifecycle.
 *
 * Never rejects for a runtime failure. When the process cannot be started at
 * all (ENOENT, bad cwd) the promise still resolves: `exited` settles with a
 * null code, `spawnError` carries the message, and the same text goes to
 * onStderr. Every outcome, including immediate crash, is delivered through
 * `exited`.
 */
function spawnWorker(opts) {
    const logStream = createWriteStream(path.join(opts.stateDir, 'stderr.log'), { flags: 'w' });
    // A full disk or removed state directory must not turn a worker into an
    // unhandled stream error. stderr is still retained in memory for its result.
    logStream.on('error', () => { });
    const state = {
        captured: '',
        logged: 0,
    };
    const handle = spawn(opts.binary, opts.argv, {
        cwd: opts.cwd,
        // RULE 1 + 2: never a TTY, never a PTY. stdin is ignored so CLIs that sniff
        // for a pipe (codex) do not block on it.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...opts.env },
        // Give each worker its own process group so cancellation reaches shell/tool
        // descendants too. We only wait for the CLI process itself; the group is
        // signalled as a unit on timeout or cancellation.
        detached: process.platform !== 'win32',
    });
    let killReason;
    let killTimer;
    let timeoutTimer;
    let heartbeatTimer;
    let firstBeat;
    const killGraceMs = Math.max(0, opts.killGraceMs ?? 5_000);
    function signalTree(signal) {
        const pid = handle.pid;
        if (pid === undefined)
            return;
        try {
            if (process.platform === 'win32')
                process.kill(pid, signal);
            else
                process.kill(-pid, signal);
        }
        catch (err) {
            const code = err.code;
            if (code !== 'ESRCH' && code !== 'EPERM')
                throw err;
        }
    }
    // RULE 4: polite first, then escalate. SIGTERM gives the CLI a chance to flush
    // its result file, which matters for the agy-staff readers in harness/.
    // Some CLIs ignore SIGTERM while a tool call is in flight, hence the SIGKILL.
    function terminate(reason) {
        if (killReason !== undefined)
            return; // idempotent; first reason wins
        killReason = reason;
        proc.killReason = reason;
        if (timeoutTimer !== undefined) {
            clearTimeout(timeoutTimer);
            timeoutTimer = undefined;
        }
        signalTree('SIGTERM');
        killTimer = setTimeout(() => {
            killTimer = undefined;
            signalTree('SIGKILL');
        }, killGraceMs);
        // Cleanup must keep the supervisor alive even when only detached-stdio
        // descendants remain. An unref'ed timer would silently abandon SIGKILL.
    }
    const proc = {
        child: handle,
        exited: Promise.resolve({ code: null, signal: null }),
        terminate,
        killReason: undefined,
        closeLog: () => {
            logStream.end();
        },
        stderrTail: () => state.captured,
        spawnError: undefined,
    };
    if (opts.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => proc.terminate('timeout'), opts.timeoutMs);
        // Do not hold the event loop open on our account.
        timeoutTimer.unref?.();
    }
    // Liveness from the process owner. Provider events stop during a long tool
    // call; this does not. The first beat waits one macrotask so the caller has
    // subscribed to the adapter's bus (spawn resolves first).
    //
    // The beat stops when the CLI process EXITS, not when its stdio closes: a
    // descendant that inherited stdout can hold it open long after the worker
    // died, and beats in that window would make a dead pid look alive. Each beat
    // also probes the pid itself and stops if it is gone.
    let leaderExited = false;
    const stopHeartbeat = () => {
        leaderExited = true;
        if (firstBeat !== undefined)
            clearTimeout(firstBeat);
        if (heartbeatTimer !== undefined)
            clearInterval(heartbeatTimer);
        firstBeat = undefined;
        heartbeatTimer = undefined;
    };
    handle.on('exit', stopHeartbeat);
    const onHeartbeat = opts.onHeartbeat;
    const pid = handle.pid;
    if (onHeartbeat !== undefined && pid !== undefined) {
        const beat = () => {
            if (leaderExited)
                return;
            try {
                process.kill(pid, 0);
            }
            catch (err) {
                // EPERM: it exists, we just may not signal it. Anything else: gone.
                if (err.code !== 'EPERM') {
                    stopHeartbeat();
                    return;
                }
            }
            try {
                onHeartbeat(nowIso(), pid);
            }
            catch { /* a listener must not kill the worker */ }
        };
        firstBeat = setTimeout(beat, 0);
        firstBeat.unref?.();
        heartbeatTimer = setInterval(beat, Math.max(1, opts.heartbeatMs ?? HEARTBEAT_MS));
        heartbeatTimer.unref?.();
    }
    const exited = new Promise((resolve) => {
        let settled = false;
        const finish = (code, signal) => {
            if (settled)
                return;
            settled = true;
            if (timeoutTimer !== undefined)
                clearTimeout(timeoutTimer);
            stopHeartbeat();
            if (killTimer !== undefined) {
                clearTimeout(killTimer);
                killTimer = undefined;
                // Once the leader is gone there is nothing left to flush. Stop any
                // surviving tools before acknowledging the terminal cancellation.
                if (killReason !== undefined)
                    signalTree('SIGKILL');
            }
            resolve({ code, signal });
        };
        handle.on('error', (err) => {
            // 'error' fires for spawn failures AND for kill failures. ENOENT here
            // means the binary vanished between `which` and spawn.
            // No pid means the child never started: that is a spawn failure, not a
            // failed kill.
            const message = `spawn error: ${err.message}`;
            if (handle.pid === undefined)
                proc.spawnError = message;
            opts.onStderr(`${message}\n`);
            finish(null, null);
        });
        handle.on('close', (code, signal) => finish(code, signal));
    });
    proc.exited = exited;
    // ---- stdout: NDJSON line pump ------------------------------------------------
    const rl = readline.createInterface({ input: handle.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
        if (line.trim() !== '')
            opts.onStdoutLine(line);
    });
    // readline holds the stream open; closing it frees the fd promptly.
    handle.stdout.on('close', () => rl.close());
    // ---- stderr: bounded capture + log ------------------------------------------
    handle.stderr.setEncoding('utf8');
    handle.stderr.on('data', (chunk) => {
        if (state.logged < STDERR_LOG_LIMIT) {
            const room = STDERR_LOG_LIMIT - state.logged;
            const slice = chunk.slice(0, room);
            state.logged += slice.length;
            logStream.write(slice);
        }
        if (state.captured.length < STDERR_CAPTURE_LIMIT) {
            state.captured = (state.captured + chunk).slice(0, STDERR_CAPTURE_LIMIT);
        }
        opts.onStderr(chunk);
    });
    return Promise.resolve(proc);
}
/** Generate a job id when the caller did not supply one. */
function newJobId() {
    return randomUUID();
}
/** Append one normalized event to <stateDir>/events.jsonl. Fire-and-forget. */
function appendEventLog(stateDir, event) {
    try {
        writeFileSync(path.join(stateDir, 'events.jsonl'), `${JSON.stringify(event)}\n`, { flag: 'a' });
    }
    catch {
        // The event log is a convenience for harness/tail consumers. Never let it
        // fail a worker that is otherwise running fine.
    }
}
/** Write <stateDir>/result.json once, at job completion. */
function writeResultFile(stateDir, result) {
    try {
        writeFileSync(path.join(stateDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    }
    catch {
        /* see appendEventLog */
    }
}
// ---------------------------------------------------------------------------
// Shared adapter plumbing: availability, exit verdicts, the whole spawn() body
// ---------------------------------------------------------------------------
/** PATH probe for `Provider.available()`. Never throws: an unprobeable binary is an absent one. */
async function binaryAvailable(binary) {
    try {
        return await binaryOnPath(binary);
    }
    catch {
        return false;
    }
}
/**
 * The verdicts that dominate every adapter's own decision ladder: a job we
 * killed has no trustworthy terminal state, and a process that never started has
 * nothing else to interpret (spawnWorker resolves with a null exit code, which
 * would otherwise read as "exited null"). Undefined means "decide from the
 * output".
 */
function earlyVerdict(exit, durationMs) {
    if (exit.killReason === 'cancelled')
        return { status: 'cancelled', error: 'canceled' };
    if (exit.killReason === 'timeout')
        return { status: 'timeout', error: timedOutText(durationMs) };
    if (exit.spawnError !== undefined)
        return { status: 'spawn-failed', error: exit.spawnError };
    return undefined;
}
/**
 * Did the worker get past an error event? A transient error (a dropped
 * connection the CLI retries) is followed by more work and a final report, yet
 * the CLI may still exit non-zero. An adapter that treats any error event as
 * terminal then fails a job that completed.
 *
 * Recovery needs assistant text after the LAST error and positive completion
 * evidence: a clean exit or an adapter-confirmed terminal event. Further text
 * or tool activity invalidates that event, so a retry preamble followed by a
 * crash cannot masquerade as a completed report.
 */
class ErrorRecovery {
    last;
    /** Record an error event. `label` names it in the warning, e.g. "a provider connection error". */
    noteError(label, message, at) {
        this.last = { label, message, at, textAfter: false, completed: false };
    }
    /** Feed the events the translator just produced. */
    observe(events) {
        if (this.last === undefined)
            return;
        for (const e of events) {
            if (e.kind === 'text' || e.kind === 'activity-start' || e.kind === 'activity-update' || e.kind === 'activity-end') {
                this.invalidateCompletion();
            }
            if (e.kind === 'text' && e.stream !== 'thinking' && e.text.trim() !== '')
                this.last.textAfter = true;
        }
    }
    /** New work means a previously completed step no longer proves the run ended. */
    invalidateCompletion() {
        if (this.last !== undefined)
            this.last.completed = false;
    }
    /** Called only for a provider event that explicitly confirms normal completion. */
    noteCompletion() {
        if (this.last?.textAfter)
            this.last.completed = true;
    }
    /** A failed exit needs explicit completion evidence, not just partial output. */
    recovered(finalText, exitCode) {
        const l = this.last;
        return l !== undefined && l.textAfter && finalText.trim() !== ''
            && exitCode !== null && (exitCode === 0 || l.completed) ? l : undefined;
    }
}
/** The warning notice for a run judged a success despite a recovered error. Issued after the verdict. */
function recoveredErrorNotice(recovered, final) {
    if (recovered === undefined || final.status !== 'success')
        return undefined;
    return { kind: 'notice', at: final.finishedAt, level: 'warn', message: recoveredErrorText(recovered.label, recovered.message, recovered.at) };
}
/** The JobResult envelope every adapter fills the same way; callers add their optional fields. */
function jobResult(args) {
    const { status, error, exit } = args;
    const out = {
        jobId: args.jobId,
        provider: args.provider,
        ok: status === 'success',
        status,
        exitCode: exit.code,
        signal: exit.signal,
        response: args.response,
        durationMs: args.durationMs,
        startedAt: new Date(args.startedAtMs).toISOString(),
        finishedAt: nowIso(),
        stateDir: args.stateDir,
    };
    if (error !== undefined)
        out.error = error;
    return out;
}
/**
 * The spawn() body every adapter shares: state dir, argv breadcrumb, event bus,
 * the stdout/stderr pumps and the result promise. Notices go through `publish`
 * so they land in events.jsonl as well as on the live bus.
 */
async function runNdjsonWorker(cfg) {
    const { provider, spec } = cfg;
    const jobId = spec.jobId ?? newJobId();
    const stateDir = writeStateDir(provider, jobId, spec.stateDir);
    const argv = cfg.buildArgv(spec);
    writeArgv(stateDir, argv, spec.cwd);
    const bus = createEventBus();
    const publish = (events) => {
        for (const e of events) {
            bus.emit(e);
            appendEventLog(stateDir, e);
        }
    };
    const notice = (level, message) => publish([{ kind: 'notice', at: nowIso(), level, message }]);
    if (cfg.preamble !== undefined)
        publish(cfg.preamble);
    const startedAtMs = Date.now();
    const proc = await spawnWorker({
        provider,
        binary: cfg.binary,
        argv,
        cwd: spec.cwd,
        timeoutMs: spec.timeoutMs,
        stateDir,
        jobId,
        mode: spec.mode,
        // Liveness only: on the bus, never in events.jsonl (see ProviderEvent 'heartbeat').
        onHeartbeat: (at, pid) => bus.emit({ kind: 'heartbeat', at, ...(pid === undefined ? {} : { pid }) }),
        ...(spec.env !== undefined ? { env: spec.env } : {}),
        onStdoutLine(line) {
            const raw = tryParseObject(line);
            if (raw === undefined) {
                // NDJSON is one object per line; a banner, stray print or future format
                // change must be visible rather than silently dropped.
                notice('warn', `${provider} stdout (non-JSON): ${truncate(line, 400).text}`);
                return;
            }
            if (cfg.intercept?.(raw))
                return;
            publish(cfg.translate(raw));
        },
        onStderr(chunk) {
            const text = chunk.trim();
            if (text === '')
                return;
            notice(cfg.stderrLevel?.(text) ?? 'info', truncate(text, 800).text);
        },
    });
    let resolveResult = () => { };
    const resultPromise = new Promise((resolve) => {
        resolveResult = resolve;
    });
    void proc.exited.then(({ code, signal }) => {
        proc.closeLog();
        const exit = { code, signal, killReason: proc.killReason, stderr: proc.stderrTail() };
        if (proc.spawnError !== undefined)
            exit.spawnError = proc.spawnError;
        const final = cfg.buildResult({ jobId, startedAtMs, stateDir, exit });
        if (cfg.afterResult !== undefined)
            publish(cfg.afterResult(final));
        bus.close();
        writeResultFile(stateDir, final);
        resolveResult(final);
    });
    return {
        id: jobId,
        stateDir,
        cancel: () => proc.terminate('cancelled'),
        waitForResult: () => resultPromise,
        onEvent: (listener) => bus.onEvent(listener),
        events: bus.events,
    };
}/**
 * providers/discovery.ts — shared plumbing for lazy `listModels()` implementations.
 * Never called at startup; every helper here is I/O on demand and never throws.
 */
const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const runCapture = (bin, args, timeoutMs) => new Promise((resolve) => {
    try {
        execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env: process.env }, (err, stdout, stderr) => {
            if (err) {
                const killed = err.killed === true;
                const detail = killed ? `timed out after ${timeoutMs} ms` : err.message;
                resolve({ stdout: stdout ?? '', error: `${bin} ${args.join(' ')}: ${detail}${stderr ? ` (${String(stderr).trim().slice(0, 200)})` : ''}` });
                return;
            }
            resolve({ stdout: stdout ?? '' });
        });
    }
    catch (e) {
        resolve({ stdout: '', error: e instanceof Error ? e.message : String(e) });
    }
});
/** Read a file as text, undefined on any failure. */
function readTextSafe(file) {
    try {
        return readFileSync(file, 'utf8');
    }
    catch {
        return undefined;
    }
}
/** Home-relative config dir: first non-empty env var wins, else ~/<fallback>. */
function configDir(envNames, fallback) {
    for (const n of envNames) {
        const v = process.env[n];
        if (v !== undefined && v !== '')
            return v;
    }
    return path.join(process.env['HOME'] ?? os.homedir(), fallback);
}
function errMessage(e) {
    return e instanceof Error ? e.message : String(e);
}
/** Top-level `key = "value"` pairs of a config.toml (stops at the first [table]). */
function parseTomlTopLevel(text) {
    const out = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('['))
            break;
        const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/);
        if (m)
            out[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    return out;
}/**
 * providers/agy.ts — Antigravity CLI (`agy`) adapter.
 *
 * ============================================================================
 * EVERYTHING IN THIS FILE'S EVENT SCHEMA WAS VERIFIED AGAINST THE REAL BINARY.
 * ============================================================================
 * Verified on 2026-10-06 with:
 *   $ agy --print=hello --print-timeout=20s --output-format stream-json \
 *         --model gemini-3.8-flash-low
 * plus cross-checked against 20 archived agy-staff jobs in
 * ~/Repos/renyi/.agy-staff/jobs/ (~14 900 step_update records).
 * Commands used to check: `agy --help`, `agy models`, and live `--print` runs.
 * ============================================================================
 *
 * ----------------------------------------------------------------------------
 * THE TRAP: exit 0, status "SUCCESS", empty response.
 * ----------------------------------------------------------------------------
 * agy runs headless. Headless agy CANNOT PROMPT for tool permission. So when a
 * tool needs approval nobody can give, agy auto-denies it, prints a human
 * warning to stderr, and then reports:
 *
 *     {"event":"result","result":{
 *        "conversation_id":"...","status":"SUCCESS","response":"",
 *        "duration_seconds":2.6,"num_turns":1,"usage":{...},
 *        "denied_actions":[{"action":"command","display_name":"RunCommand"}]}}
 *
 * The process exits 0. `result.status` is the string "SUCCESS". `response` is
 * empty. VERIFIED LIVE:
 *
 *     $ agy --print="Run the shell command: echo hi" --output-format stream-json ...
 *     ... step_update step_index=2 state=ERROR step_type=tool tool_name=run_command
 *         tool_info.error.type = "TOOL_ERROR"
 *         tool_info.error.message = "permission check failed for command \"echo hi\":
 *             user denied permission to run command: ... Proceed without
 *             performing this action."
 *     stderr: jetski: no output produced — a tool required the "command"
 *             permission that headless mode cannot prompt for, so it was
 *             auto-denied. ... Alternatively, re-run with
 *             --dangerously-skip-permissions to auto-approve all tools.
 *     $ echo $?
 *     0
 *
 * EVERY NAIVE INTEGRATION READS THIS AS A SUCCESSFUL JOB THAT PRODUCED NOTHING.
 * A pipeline that chains implement -> review would then review a patch that was
 * never written, and report green. That is worse than a crash, because it is
 * quiet.
 *
 * So `result.denied_actions` IS TREATED AS A FIRST-CLASS FAILURE SIGNAL, and
 * there are actually THREE independent ways to detect it in this file, because
 * each fails in a different situation:
 *
 *   (1) result.denied_actions is non-empty  -> JobStatus 'denied'.  [primary]
 *       Unless agy still finished with SUCCESS, exit 0 and a non-empty report:
 *       then 'success' with the denials marked nonfatal, as claude does.
 *   (2) tool_info.error.type === 'TOOL_ERROR' whose message mentions a
 *       permission check failure or denial            -> 'denied'.  [early signal]
 *   (3) status !== 'SUCCESS'                        -> 'error'.
 *       Unless agy delivered a non-empty response and the error is stale
 *       (no error_message step in this run, or later steps succeeded):
 *       then 'success' with a warning notice.
 *   (4) status === 'SUCCESS' AND response.trim() === '' AND no usage beyond the
 *       preamble -> still 'denied'/'error', never 'success'. [last-resort net]
 *
 * (4) is deliberately paranoid. An empty response from a model that burned
 * 135 output tokens is not a success; it is a model that was told to stop. We
 * only allow the empty-response case to be benign if the job also had zero tool
 * calls, because "you asked me nothing and I said nothing" is a legitimate
 * (if useless) success.
 *
 * THE FIX IS UPSTREAM TOO: `unrestricted: true` adds --dangerously-skip-permissions,
 * which is what makes this whole class of silent failure disappear. But we still
 * check, because a config-level allow-rule can deny a single command and the
 * flag does not override an explicit deny.
 *
 * ----------------------------------------------------------------------------
 * THE OTHER TRAP: agy-staff DELETES progress.json on clean success.
 * ----------------------------------------------------------------------------
 * agy-staff (the host harness that used to drive agy) writes job state under
 *   <cwd>/.agy-staff/jobs/<jobId>.{spec.json,progress.json,events.jsonl,log,
 *                                   result.md,result.md.status.json}
 * On a run with NO warnings it DELETES progress.json and events.jsonl when the
 * job completes. This is not a bug and not a crash — it is the good path.
 *
 * CONSEQUENCE FOR ANY WATCHER (including harness/, and including anyone tempted
 * to poll progress.json from this file): a MISSING progress.json MEANS "JOB
 * FINISHED", NEVER "JOB VANISHED". Treating absence as liveness is how you get
 * a watcher that reports every healthy job as missing. The authoritative
 * terminal signal is the existence of result.md + result.md.status.json.
 *
 * We do NOT poll progress.json here — this adapter owns the live stream, and
 * stdio is authoritative. But we do not touch that tree either: it belongs to
 * harness/. Flagged loudly because it is the single most misreadable fact in
 * the whole system.
 */
const AGY_BINARY = process.env['AGENT_SMITH_AGY_BIN'] ?? 'agy';
// ---------------------------------------------------------------------------
// argv construction
// ---------------------------------------------------------------------------
/**
 * Format a millisecond budget as a Go duration string.
 *
 * agy's --print-timeout is typed as a Go `time.Duration` (its help literally
 * says `0s`), and agy-staff's resolved spec.json carries `"timeout":"120m"`,
 * i.e. the same grammar. Verified that `20s` is accepted.
 * NOTE: Go durations have no day component; >24h wraps. We clamp to hours.
 */
function toGoDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0)
        return `${h}h${m}m${s}s`;
    if (m > 0)
        return `${m}m${s}s`;
    return `${s}s`;
}
const COMPOSABLE_EFFORTS = ['low', 'medium', 'high'];
/**
 * Decide the --model / --effort pair. `agy models` lists effort-SUFFIXED ids and
 * discovery (listModels) exposes BASE ids, so a base id + low|medium|high effort
 * composes to `<base>-<effort>` (the form agy actually knows) and no --effort is
 * passed. Other efforts (xhigh/max) keep the separate --effort flag. An id that
 * already carries a suffix is used as-is; a conflicting effort throws.
 */
function resolveModelAndEffort(spec) {
    const model = spec.model !== undefined && spec.model !== '' ? spec.model : undefined;
    const effort = spec.effort !== undefined && spec.effort !== '' ? spec.effort : undefined;
    if (effort === undefined)
        return model === undefined ? {} : { model };
    if (model === undefined)
        return { effortFlag: effort };
    const encoded = model.match(/-(low|medium|high|xhigh|max)$/i)?.[1]?.toLowerCase();
    if (encoded !== undefined) {
        if (encoded !== effort)
            throw new Error(`model ${model} encodes effort ${encoded}, conflicting with ${effort}`);
        return { model };
    }
    if (COMPOSABLE_EFFORTS.includes(effort))
        return { model: `${model}-${effort}` };
    return { model, effortFlag: effort };
}
/** Sandbox flags agy gets for a spawn. Shared by buildArgv and describeSandbox. */
function sandboxPlan$4(spec) {
    if (spec.unrestricted) {
        return {
            sandbox: 'agy --dangerously-skip-permissions (unrestricted)',
            flags: ['--dangerously-skip-permissions'],
            readOnlyEnforced: false,
        };
    }
    return {
        sandbox: 'agy proceed-in-sandbox (cannot prompt; unapproved tools are auto-denied)',
        flags: [],
        readOnlyEnforced: false,
    };
}
/**
 * Build the exact argv for one agy worker.
 *
 * VERIFIED FLAGS (from `agy --help` on this machine):
 *   --print=<prompt>              NOT `--print <prompt>`: --print consumes the
 *                                 next token when separated by a space, so the
 *                                 attached form is the only safe one. (`-p` is
 *                                 a short alias; we use the long form.)
 *   --output-format stream-json   NDJSON on stdout.
 *   --model <id>
 *   --effort <low|medium|high|xhigh|max>
 *   --print-timeout <dur>         Go duration; 0 = wait forever.
 *   --add-dir <dir>               repeatable.
 *   --dangerously-skip-permissions
 *   --conversation <id>
 *
 * EXPLICITLY NOT PASSED, and why:
 *   --sandbox          agy's default permission_mode is already
 *                      "proceed-in-sandbox" (seen in the init event), so we do
 *                      not re-request it and accidentally widen the sandbox.
 *   --log-file         our own stderr.log in stateDir already captures it.
 *   --new-project      agy-staff passes --project for grouped sessions; that is
 *                      a harness concern, and SpawnSpec has no field for it.
 */
function buildArgv$4(spec) {
    const argv = [
        // Attached form. Verified: `--print=<prompt>` parses the whole prompt as one
        // argument even when it contains spaces, newlines and backticks.
        `--print=${spec.prompt}`,
        '--output-format',
        'stream-json',
    ];
    const { model, effortFlag } = resolveModelAndEffort(spec);
    if (model !== undefined)
        argv.push('--model', model);
    if (effortFlag !== undefined)
        argv.push('--effort', effortFlag);
    if (spec.timeoutMs > 0) {
        argv.push('--print-timeout', toGoDuration(spec.timeoutMs));
    }
    // Repeatable, one flag per directory.
    for (const dir of spec.addDirs ?? []) {
        argv.push('--add-dir', dir);
    }
    // Without --dangerously-skip-permissions, headless agy auto-denies every tool
    // that needs approval and reports SUCCESS. See THE TRAP.
    argv.push(...sandboxPlan$4(spec).flags);
    if (spec.conversation !== undefined && spec.conversation !== '') {
        // Resume a conversation thread (UUID from result.conversation_id).
        argv.push('--conversation', spec.conversation);
    }
    return argv;
}
// ---------------------------------------------------------------------------
// ProviderEvent translation
// ---------------------------------------------------------------------------
function toTokenUsage$4(u) {
    if (u === undefined)
        return undefined;
    const out = {};
    if (u.input_tokens !== undefined)
        out.inputTokens = u.input_tokens;
    if (u.output_tokens !== undefined)
        out.outputTokens = u.output_tokens;
    if (u.thinking_tokens !== undefined)
        out.thinkingTokens = u.thinking_tokens;
    if (u.cache_read_tokens !== undefined)
        out.cacheReadTokens = u.cache_read_tokens;
    if (u.total_tokens !== undefined)
        out.totalTokens = u.total_tokens;
    return Object.keys(out).length > 0 ? out : undefined;
}
/**
 * Is this TOOL_ERROR a permission denial rather than a genuine tool failure?
 *
 * The wording is agy's own (verified in the live run quoted at the top of this
 * file): "permission check failed for command ...: user denied permission to
 * run command". We match on it so the operator sees DENIED, not ERROR, because
 * the remedy is different: ERROR means the tool broke, DENIED means the
 * permission model ate the work.
 */
function isDenialError(toolError) {
    if (toolError === undefined)
        return false;
    const hay = `${toolError.type ?? ''} ${toolError.message ?? ''}`.toLowerCase();
    // Not a bare "permission": agy prefixes ordinary tool failures with its
    // permission-declaration phase ("declaring permissions: ... no such file or
    // directory"), and a missing file must not fail a finished job as denied.
    return (hay.includes('permission check failed') ||
        hay.includes('denied') ||
        hay.includes('not permitted'));
}
/**
 * agy's leftover error, as a short warning:
 * "API error (attempt 3): RESOURCE_EXHAUSTED (code 429): …" → "recovered: 429 resource exhausted".
 */
function recoveredWarning(rawError) {
    const raw = (rawError ?? '').replace(/\s+/g, ' ').trim().replace(/^error:\s*/i, '');
    const coded = /\b([A-Z][A-Z0-9_]+)\s*\(code\s+(\d+)\)/.exec(raw);
    const words = coded
        ? `${coded[2]} ${coded[1].toLowerCase().replace(/_/g, ' ')}`
        : raw.replace(/\.\s+(?:this can happen|please try again)\b.*$/i, '').replace(/\.$/, '').toLowerCase();
    return truncate(`recovered: ${words || 'worker error'}`, 200).text;
}
/**
 * The warning for a run `buildResult` judged a success although agy reported
 * an error: the error was stale. Issued only after that verdict, so the
 * warning and the status can never disagree.
 */
function recoveredNotice(final, resultEvent) {
    if (final.status !== 'success' || resultEvent === undefined || resultEvent.status === 'SUCCESS')
        return undefined;
    return { kind: 'notice', at: final.finishedAt, level: 'warn', message: recoveredWarning(resultEvent.error), raw: resultEvent };
}
function createAgyTranslator(maxChars) {
    const steps = new Map();
    /** Set by any denial signal; carried into JobResult. */
    const denials = [];
    // agy's final status repeats the conversation's last error, even one it
    // recovered from or one from an earlier run on the same conversation. Stale:
    // none this run, or a step finished after it. Trade-off: a failure agy
    // reports only in the result (no error step this run) also reads as stale;
    // buildResult still requires a response and exit 0 before calling it success.
    let sawErrorStep = false;
    let progressedAfterError = false;
    const errorIsStale = () => !sawErrorStep || progressedAfterError;
    function noteDenial(raw) {
        denials.push(raw);
    }
    function onEvent(raw) {
        const out = [];
        const event = str(raw, 'event');
        const at = nowIso();
        if (event === 'init') {
            const init = obj(raw, 'init');
            const ev = {
                kind: 'started',
                at,
                raw,
            };
            const conv = str(raw, 'conversation_id') ?? str(init, 'conversation_id');
            if (conv !== undefined)
                ev.conversationId = conv;
            const model = str(init, 'model');
            if (model !== undefined)
                ev.model = model;
            out.push(ev);
            return out;
        }
        if (event === 'step_update') {
            const su = obj(raw, 'step_update');
            if (su === undefined)
                return out;
            const stepIndex = su.step_index ?? 0;
            const stepType = su.step_type;
            const state = su.state;
            // --- usage, attached to almost every DONE record -----------------------
            // Any step that finishes, other than an error, is progress past an earlier error.
            if (state === 'DONE' && stepType !== 'error_message')
                progressedAfterError = true;
            const usage = toTokenUsage$4(su.usage);
            if (usage !== undefined)
                out.push({ kind: 'usage', at, usage });
            // --- agent prose / thinking --------------------------------------------
            if (stepType === 'agent_response') {
                const delta = su.text_delta;
                if (delta !== undefined && delta !== '') {
                    // agy streams prose as many small text_delta slices. We forward each
                    // one rather than buffering: the mod surface renders incrementally and
                    // a long answer would otherwise be invisible for minutes.
                    out.push({ kind: 'text', at, text: delta, stream: 'assistant', delta: true });
                }
                return out;
            }
            // --- tool calls ---------------------------------------------------------
            if (stepType === 'tool') {
                const info = su.tool_info;
                const toolName = su.tool_name ?? info?.name ?? 'unknown';
                const mem = steps.get(stepIndex) ?? {};
                steps.set(stepIndex, mem);
                if (state === 'ACTIVE') {
                    mem.tool = toolName;
                    const input = preview(info?.parameters, maxChars);
                    if (input !== undefined) {
                        mem.input = input.text;
                        mem.truncated = input.truncated;
                    }
                    const ref = { stepIndex, tool: toolName };
                    if (mem.input !== undefined)
                        ref.input = mem.input;
                    if (mem.truncated !== undefined)
                        ref.truncated = mem.truncated;
                    out.push({ kind: 'activity-start', at, activity: ref });
                    return out;
                }
                // DONE / ERROR
                const denied = state === 'ERROR' && isDenialError(info?.error);
                if (denied) {
                    noteDenial({
                        action: toolName,
                        displayName: toolName,
                        raw: { stepIndex, error: info?.error },
                    });
                }
                const output = preview(info?.output ?? info?.error?.message, maxChars);
                const ref = { stepIndex, tool: toolName };
                if (mem.input !== undefined)
                    ref.input = mem.input;
                if (output !== undefined)
                    ref.output = output.text;
                const anyTrunc = (mem.truncated ?? false) || (output !== undefined && output.truncated);
                if (anyTrunc)
                    ref.truncated = true;
                if (denied)
                    ref.denied = true;
                let status;
                if (denied)
                    status = 'denied';
                else if (state === 'ERROR')
                    status = 'error';
                else
                    status = 'done';
                const ev = { kind: 'activity-end', at, activity: ref, status };
                if (su.duration_seconds !== undefined)
                    ev.durationSeconds = su.duration_seconds;
                out.push(ev);
                return out;
            }
            // --- error_message: agy's own API/transport errors ----------------------
            if (stepType === 'error_message') {
                sawErrorStep = true;
                progressedAfterError = false;
                // agy's stream carries no error text here; the final result does.
                out.push({ kind: 'notice', at, level: 'error', message: 'agy error', raw: su });
                return out;
            }
            // --- system_message / checkpoint / user_input --------------------------
            // Informational. Forward as notices so the operator sees permission
            // prompts and checkpoints without the mod surface needing to know agy.
            if (stepType === 'system_message' || stepType === 'checkpoint') {
                out.push({
                    kind: 'notice',
                    at,
                    level: 'info',
                    message: `agy ${stepType} at step ${stepIndex}`,
                    raw: su,
                });
            }
            return out;
        }
        if (event === 'result') {
            // The result event itself is not a ProviderEvent. It becomes JobResult,
            // which is built in the exit handler. Nothing to emit here.
            return out;
        }
        // Unknown event name. Not fatal; the CLI gains fields before we gain code.
        return out;
    }
    return {
        onEvent,
        denials,
        stepsWereTools: () => [...steps.values()].some((m) => m.tool !== undefined),
        errorIsStale,
    };
}
// ---------------------------------------------------------------------------
// JobResult construction
// ---------------------------------------------------------------------------
function buildResult$4(args) {
    const { jobId, resultEvent, exit, startedAtMs, stateDir, denials, sawAnyToolCall } = args;
    const { errorIsStale } = args;
    const durationMs = Date.now() - startedAtMs;
    const response = resultEvent?.response ?? '';
    const reportedStatus = resultEvent?.status;
    const usage = toTokenUsage$4(resultEvent?.usage);
    // Normalize agy's denied_actions into our shape. Present-but-empty is the
    // same as absent, so we only set the field when it actually means something.
    // Two SOURCES are merged: the per-tool TOOL_ERROR denials we saw during the
    // stream, and the result event's own denied_actions. Either can fire alone.
    const deniedActions = [...denials];
    for (const d of resultEvent?.denied_actions ?? []) {
        const entry = { raw: d };
        if (d.action !== undefined)
            entry.action = d.action;
        if (d.display_name !== undefined)
            entry.displayName = d.display_name;
        deniedActions.push(entry);
    }
    const distinctDenials = [];
    const seen = new Set();
    for (const d of deniedActions) {
        const key = `${d.action ?? ''}:${d.displayName ?? ''}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        distinctDenials.push(d);
    }
    let status;
    let error;
    // ORDER MATTERS. Kill reasons dominate everything: a job we killed has no
    // trustworthy terminal state, whatever agy managed to flush first.
    const early = earlyVerdict(exit, durationMs);
    if (early !== undefined) {
        ({ status, error } = early);
    }
    else if (distinctDenials.length > 0 && reportedStatus === 'SUCCESS' && exit.code === 0 && response.trim() !== '') {
        // Denied calls, but agy finished and delivered a report: a success with a
        // warning, exactly as claude reports it. The forge verdict keeps the
        // denials visible as a note; an empty report still falls to THE TRAP.
        status = 'success';
        for (const d of distinctDenials)
            d.nonfatal = true;
    }
    else if (distinctDenials.length > 0) {
        // THE TRAP. exit code 0, status "SUCCESS", empty response — and yet the
        // job did nothing. Reported as a failure, loudly.
        status = 'denied';
        // Headless agy auto-denies tools it cannot prompt for unless run with
        // --dangerously-skip-permissions; an explicit deny rule overrides that flag.
        error = deniedText(distinctDenials.map((d) => d.displayName ?? d.action).filter((n) => n !== undefined), exit.stderr);
    }
    else if (resultEvent === undefined) {
        // Process ended with no result event at all: a crash, an OOM kill, or a CLI
        // version whose output format changed. Never report success.
        status = exit.code === 0 ? 'malformed' : 'error';
        error = noResultText(exit);
    }
    else if (reportedStatus !== 'SUCCESS') {
        if (response.trim() !== '' && errorIsStale) {
            status = 'success';
        }
        else {
            status = 'error';
            error = resultEvent.error ?? 'worker error';
        }
    }
    else if (response.trim() === '' && sawAnyToolCall) {
        // Paranoia net for (4) above. The model burned tokens and made tool calls
        // but produced no final text, with no explicit denial. That is a failure
        // shaped like a success. We allow the genuinely-empty case (no tool calls,
        // nothing asked) to pass as success.
        status = 'denied';
        error = `no output${stderrClause(exit.stderr)}`;
    }
    else {
        status = 'success';
    }
    // Exit code is corroboration, not the decision. A non-zero exit with a
    // SUCCESS-looking result event still has to be a failure.
    if (status === 'success' && exit.code !== 0) {
        status = 'error';
        error = exit.code === null ? `exited on ${exit.signal ?? 'a signal'}` : exitReason(exit.code);
    }
    const out = jobResult({ provider: 'agy', jobId, status, error, exit, response, startedAtMs, durationMs, stateDir });
    if (distinctDenials.length > 0)
        out.deniedActions = distinctDenials;
    if (usage !== undefined)
        out.usage = usage;
    if (resultEvent !== undefined)
        out.raw = resultEvent;
    return out;
}
// ---------------------------------------------------------------------------
// The Provider
// ---------------------------------------------------------------------------
/**
 * Parse `agy models` stdout (`<id>\t<label>` lines after a "Fetching..." line)
 * into BASE models: the -low/-medium/-high suffix is stripped and collected as efforts.
 */
function parseAgyModels(stdout) {
    const order = [];
    const byBase = new Map();
    for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '' || !line.includes('\t'))
            continue;
        const [id = '', label = ''] = line.split('\t');
        const m = id.trim().match(/^(.+)-(low|medium|high)$/);
        const base = m ? m[1] : id.trim();
        const effort = m ? m[2] : undefined;
        if (base === '')
            continue;
        let info = byBase.get(base);
        if (info === undefined) {
            info = { id: base, label: label.replace(/\s*\((low|medium|high)\)\s*$/i, '').trim() || base, efforts: [] };
            byBase.set(base, info);
            order.push(base);
        }
        if (effort !== undefined && !info.efforts.includes(effort))
            info.efforts.push(effort);
    }
    const rank = (e) => COMPOSABLE_EFFORTS.indexOf(e);
    return order.map((b) => {
        const i = byBase.get(b);
        i.efforts.sort((a, c) => rank(a) - rank(c));
        return i;
    });
}
/** Lazy, never throws. `run` is injectable for tests. */
async function listAgyModels(run, options) {
    const base = {
        provider: 'agy',
        models: [],
        defaultSource: 'unknown',
        source: 'live',
        stale: false,
        verified: true,
    };
    try {
        const r = await run(AGY_BINARY, ['models'], options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
        const models = parseAgyModels(r.stdout);
        if (r.error !== undefined && models.length === 0)
            return { ...base, error: r.error };
        if (models.length === 0)
            return { ...base, error: '`agy models` printed no models' };
        return { ...base, models };
    }
    catch (e) {
        return { ...base, error: errMessage(e) };
    }
}
const agyProvider = {
    name: 'agy',
    /**
     * PATH probe only. We deliberately do NOT run `agy models` here: available()
     * is called for every provider on every startup and a network-touching probe
     * would make startup slow and flaky. A resolvable binary is the contract;
     * auth problems surface as a job error instead.
     */
    available: () => binaryAvailable(AGY_BINARY),
    describeSandbox: sandboxPlan$4,
    listModels: (options) => listAgyModels(runCapture, options),
    spawn(spec) {
        const translator = createAgyTranslator(spec.maxOutputChars ?? 2000);
        let resultEvent;
        return runNdjsonWorker({
            provider: 'agy',
            binary: AGY_BINARY,
            spec,
            buildArgv: buildArgv$4,
            translate: translator.onEvent,
            // The result event is the verdict, not progress: hold it for buildResult
            // instead of translating it into an activity.
            intercept(raw) {
                if (raw['event'] !== 'result')
                    return false;
                const r = obj(raw, 'result');
                if (r !== undefined)
                    resultEvent = r;
                return true;
            },
            // agy writes human-facing warnings to stderr, most importantly the
            // auto-denial notice quoted at the top of this file. That notice is our
            // earliest operator-facing hint that a job is going to come back empty.
            stderrLevel: (text) => (text.includes('denied') || text.includes('permission') ? 'warn' : 'info'),
            buildResult: (ctx) => buildResult$4({
                ...ctx,
                resultEvent,
                denials: translator.denials,
                sawAnyToolCall: translator.stepsWereTools(),
                errorIsStale: translator.errorIsStale(),
            }),
            afterResult(final) {
                const recovered = recoveredNotice(final, resultEvent);
                return recovered === undefined ? [] : [recovered];
            },
        });
    },
};/**
 * providers/claude.ts — Claude Code headless adapter.
 *
 * This is agent-smith's PROBER / MODERATOR provider. ARCHITECTURE.md is
 * emphatic about why: "Claude proposes, another model probes." Generative
 * agreement between same-family models is correlated (60% agreement when both
 * err, ICML 2025, 350+ models), so self-consistency is not verification — a
 * different model family is. This adapter exists to be that different family,
 * which means it must be as trustworthy about its own failure modes as agy is.
 *
 * ============================================================================
 * VERIFICATION LEVEL: HIGH. Verified by running `claude --help` (2.1.292) and
 * by executing the exact invocation below against a live model.
 * ============================================================================
 *
 * VERIFIED FLAGS (`claude --help`, 2.1.292):
 *
 *   -p, --print                       "Print response and exit (useful for pipes)".
 *                                     Note the help text itself says the workspace
 *                                     trust dialog is skipped when stdout is not
 *                                     a TTY — which is exactly our spawn shape.
 *   --output-format <text|json|stream-json>   "(only works with --print)"
 *   --input-format <text|stream-json>
 *   --verbose                         required for the full stream in print mode
 *   --forward-subagent-text           "Forward subagent text and thinking blocks as
 *                                     assistant/user messages with
 *                                     parent_tool_use_id set (only works with
 *                                     --print and --output-format=stream-json)"
 *                                     ^^^ THIS IS THE FLAG THAT MAKES A MODERATOR
 *                                     USABLE. Without it, a subagent's reasoning
 *                                     is invisible to us, and a moderator that
 *                                     cannot see what the prober did is just
 *                                     another proposer.
 *   --include-partial-messages        partial chunks as they arrive (stream-json)
 *   --model <model>                   alias ('fable', 'opus', 'sonnet') or full name
 *   --permission-mode <acceptEdits|auto|bypassPermissions|manual|dontAsk|plan>
 *   --permission-prompts <host|none>  who answers permission prompts in print mode
 *   --dangerously-skip-permissions    bypass all permission checks
 *   --allow-dangerously-skip-permissions  make it an *option*, not the default
 *   --add-dir <directories...>        additional directories for tool access
 *   --session-id <uuid>               use a specific session id
 *   --allowedTools, --allowed-tools   allowlist tools
 *   --append-system-prompt <prompt>   append to the default system prompt
 *   --bare                            minimal mode: skip hooks, LSP, plugin sync,
 *                                     auto-memory, CLAUDE.md auto-discovery.
 *                                     STRICTLY auth via ANTHROPIC_API_KEY.
 *   --setting-sources <user,project,local>   which settings files to load
 *   --max-turns <n>                   (listed as -n/--name separately; turn cap
 *                                     is accepted in print mode — see UNVERIFIED)
 *
 * VERIFIED EVENT SHAPES (live run of
 *   claude -p --output-format stream-json --verbose --model haiku "Reply with exactly: OK" < /dev/null):
 *
 *   {"type":"system","subtype":"init","cwd":"...","session_id":"fd8a7751-...",
 *    "tools":["Task","Bash","CronCreate",...],"model":"claude-haiku-4-5-20251001", ...}
 *   {"type":"system","subtype":"thinking_tokens","estimated_tokens":157,
 *    "estimated_tokens_delta":107,"session_id":"...","uuid":"..."}
 *   {"type":"system","subtype":"hook_started","hook_id":"...","hook_name":"SessionStart:startup", ...}
 *   {"type":"system","subtype":"hook_response","hook_id":"...","output":"{...}", ...}
 *   {"type":"assistant","message":{"id":"msg_...","role":"assistant",
 *       "content":[{"type":"thinking","thinking":"...","signature":"..."} |
                   {"type":"text","text":"OK"} | {"type":"tool_use","id":"toolu_...",
                   "name":"Bash","input":{...}}],
 *       "model":"claude-haiku-4-5-20251001","usage":{...}},"session_id":"..."}
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_...",
 *       "content":"...","is_error":false}]},"session_id":"..."}     (documented; not in my run)
 *   {"type":"result","subtype":"success","duration_ms":...,"duration_api_ms":1609,
 *    "is_error":false,"result":"...","session_id":"...","total_cost_usd":0.03089125,
 *    "num_turns":1,"stop_reason":"end_turn",
 *    "usage":{"input_tokens":10,"cache_creation_input_tokens":24425,
 *             "cache_read_input_tokens":0,"output_tokens":70,
 *             "output_tokens_details":{"thinking_tokens":63}}}
 *   Exit code 0.
 *
 * NOTABLE AND IMPORTANT: hooks fire in headless mode. In my run a
 * SessionStart hook from this machine's Claude config ran and injected company
 * knowledge into the run. That means a headless moderator can be steered by
 * whatever hooks happen to be configured. For the prober/moderator role we
 * default to --setting-sources user (so personal hooks still apply) but keep the
 * knob, and `--bare` is available via SpawnSpec.env for callers who need a
 * hermetic run. Documented in the README — this is a real reproducibility trap.
 *
 * TIMEOUT: claude has NO `--print-timeout` equivalent (agy has one, codex does
 * not). We therefore enforce the budget entirely ourselves, via
 * spawnWorker's SIGTERM->SIGKILL escalation. If you kill mid-run, there is no
 * result event and we correctly report 'cancelled'/'timeout', never 'success'.
 */
const CLAUDE_BINARY = process.env['AGENT_SMITH_CLAUDE_BIN'] ?? 'claude';
/**
 * Build the exact argv for one claude worker.
 *
 * argv layout: `claude -p <flags> <prompt>`.
 *
 * The prompt is a TRAILING POSITIONAL (help shows `claude [options] [command] [prompt]`),
 * so a prompt beginning with "-" is safe. Combined with `-p`, this is the
 * documented headless invocation.
 */
/**
 * Sandbox/permission flags for claude. Shared by buildArgv and describeSandbox.
 *
 * unrestricted -> --dangerously-skip-permissions ("trusted in this directory").
 * restricted   -> --permission-mode dontAsk + --permission-prompts none. Claude
 *   cannot prompt in print mode, so anything not already allowed (by the user's
 *   settings allow rules or built-in read-only tools) is DENIED, not stalled.
 *   Denials are surfaced as status 'denied' in the JobResult (detected from
 *   tool_result text), so a restricted worker does not silently pass; but
 *   read-only is NOT enforced: user allow rules may still permit writes.
 */
/** Tools a read-only worker may use. Shell is limited to inspection commands. */
const READ_ONLY_ALLOWED = [
    'Read', 'Grep', 'Glob',
    ...['cat', 'head', 'tail', 'wc', 'xxd', 'od', 'ls', 'file', 'stat', 'rg', 'grep', 'diff',
        'git diff', 'git show', 'git log', 'git status', 'git blame'].map((c) => `Bash(${c}:*)`),
];
/** Tools a read-only worker may never use, even if user settings would allow them. */
const READ_ONLY_DENIED = ['Edit', 'Write', 'NotebookEdit'];
/**
 * Allow rule for the one file a read-only pipeline stage may write.
 *
 * Verified on claude 2.1.296 (dontAsk): `Write(<path>)` rules never match, in
 * `/abs`, `//abs` or glob form, so the write is denied. `Edit(//<abs path>)` is
 * the rule that matches, and it covers the Write tool for exactly that file;
 * `//` marks a filesystem-absolute path. A bare `Edit` deny does not shadow it.
 */
function artifactWriteRule(artifactPath) {
    return `Edit(/${path.resolve(artifactPath)})`;
}
function sandboxPlan$3(spec) {
    if (spec.unrestricted) {
        return {
            sandbox: 'claude --dangerously-skip-permissions (unrestricted)',
            flags: ['--dangerously-skip-permissions'],
            readOnlyEnforced: false,
        };
    }
    const flags = ['--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
    if (spec.readOnly) {
        // Read-only modes get an explicit allowlist (so a reviewer can inspect bytes
        // and history instead of being denied) and an explicit write-tool denylist,
        // which is what makes read-only enforced rather than merely requested.
        // A stage's output artifact is its one permitted write: Write comes off the
        // denylist and only that file goes on the allowlist, so dontAsk still denies
        // every other write. Edit and NotebookEdit stay denied.
        const artifact = spec.artifactPath;
        const allowed = artifact === undefined ? READ_ONLY_ALLOWED : [...READ_ONLY_ALLOWED, artifactWriteRule(artifact)];
        const denied = artifact === undefined ? READ_ONLY_DENIED : READ_ONLY_DENIED.filter((t) => t !== 'Write');
        flags.push('--allowedTools', ...allowed, '--disallowedTools', ...denied);
        return {
            sandbox: artifact === undefined
                ? 'claude dontAsk + read-only allowlist (writes disallowed; shell limited to inspection commands)'
                : `claude dontAsk + read-only allowlist (writes disallowed except the output artifact ${path.resolve(artifact)}; shell limited to inspection commands)`,
            flags,
            readOnlyEnforced: true,
        };
    }
    return {
        sandbox: 'claude dontAsk (cannot prompt; non-allowed tools are denied and reported as denied)',
        flags,
        readOnlyEnforced: false,
    };
}
function buildArgv$3(spec) {
    const argv = ['-p'];
    // NDJSON on stdout. `stream-json` is what lets a moderator show its work.
    argv.push('--output-format', 'stream-json');
    // WHY --verbose IS NOT OPTIONAL HERE: with --print, the full event stream is
    // only emitted in verbose mode. Without it claude emits a single result
    // object and we lose every tool call. Verified in my live run, which I
    // passed --verbose to.
    argv.push('--verbose');
    // Without this, a subagent's text and thinking are dropped from our stream.
    // For a prober/moderator that is disqualifying: we would be judging a
    // subagent's work we cannot see. Documented and verified to exist.
    argv.push('--forward-subagent-text');
    if (spec.model !== undefined && spec.model !== '') {
        // Aliases ('sonnet', 'opus', 'fable') or full model names both work.
        argv.push('--model', spec.model);
    }
    if (spec.effort !== undefined && spec.effort !== '') {
        if (!CLAUDE_EFFORTS.includes(spec.effort)) {
            throw new RangeError(`claude does not support effort '${spec.effort}'; expected one of ${CLAUDE_EFFORTS.join(', ')}`);
        }
        argv.push('--effort', spec.effort);
    }
    const addDirs = spec.addDirs ?? [];
    if (addDirs.length > 0) {
        // --add-dir is VARIADIC ("--add-dir <directories...>"). Emitting the flag
        // once per directory would be wrong: the second occurrence's list would be
        // taken and the first silently dropped. So: one flag, all dirs after it.
        argv.push('--add-dir', ...addDirs);
    }
    // See sandboxPlan for the unrestricted / restricted (dontAsk) rationale.
    argv.push(...sandboxPlan$3(spec).flags);
    if (spec.conversation !== undefined && spec.conversation !== '') {
        // --session-id starts a new session with a chosen id. --resume is the CLI's
        // continuation path and preserves the prior conversation.
        argv.push('--resume', spec.conversation);
    }
    // Reproducibility knob. --setting-sources controls which settings files load.
    // Default here is 'user' so personal skills/hooks work; set
    // AGENT_SMITH_CLAUDE_SETTING_SOURCES='' to disable the flag entirely, or
    // AGENT_SMITH_CLAUDE_BARE=1 for --bare (no hooks, no CLAUDE.md, keychain
    // auth disabled). See the header for why this matters for a moderator.
    const bare = process.env['AGENT_SMITH_CLAUDE_BARE'] === '1';
    if (bare) {
        argv.push('--bare');
    }
    else {
        const sources = process.env['AGENT_SMITH_CLAUDE_SETTING_SOURCES'] ?? 'user';
        if (sources !== '')
            argv.push('--setting-sources', sources);
    }
    // Trailing positional prompt, last.
    argv.push(spec.prompt);
    return argv;
}
// ---------------------------------------------------------------------------
// Event translation
// ---------------------------------------------------------------------------
/**
 * Anthropic usage field names, verified from the live `result` event:
 *   input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
 *   output_tokens, output_tokens_details.thinking_tokens
 *
 * `cache_creation_input_tokens` maps to our `cacheWriteTokens` so the store can
 * sum cache writes across agy (which does not report them) and claude (which
 * does) without either provider needing to know about the other.
 */
function toTokenUsage$3(usage) {
    if (usage === undefined)
        return undefined;
    const out = {};
    // Anthropic emits these as JSON NUMBERS, so num() is correct here — str()
    // would silently return undefined for every single field.
    const input = num(usage, 'input_tokens');
    const output = num(usage, 'output_tokens');
    if (input !== undefined)
        out.inputTokens = input;
    if (output !== undefined)
        out.outputTokens = output;
    const details = obj(usage, 'output_tokens_details');
    const thinking = num(details, 'thinking_tokens');
    if (thinking !== undefined)
        out.thinkingTokens = thinking;
    const read = num(usage, 'cache_read_input_tokens');
    if (read !== undefined)
        out.cacheReadTokens = read;
    const write = num(usage, 'cache_creation_input_tokens');
    if (write !== undefined)
        out.cacheWriteTokens = write;
    // Anthropic does not send a total. Left undefined on purpose — consumers decide
    // the accounting policy; providers do not invent numbers.
    return Object.keys(out).length > 0 ? out : undefined;
}
/** Is this a tool_result block reporting a permission refusal? */
function isPermissionDenial(text) {
    if (text === undefined)
        return false;
    const hay = text.toLowerCase();
    return (hay.includes('permission') &&
        (hay.includes('denied') || hay.includes('not allowed') || hay.includes('requested permissions')));
}
function createClaudeTranslator(maxChars) {
    const tx = {
        finalText: '',
        sawResult: false,
        sawErrorResult: false,
        deniedTools: [],
        onEvent: () => [],
    };
    /** tool_use_id -> stepIndex */
    const toolStep = new Map();
    const deniedIds = new Set();
    let step = 0;
    const recordDenial = (id) => {
        if (deniedIds.has(id))
            return false;
        deniedIds.add(id);
        tx.deniedTools.push(id);
        return true;
    };
    const denialActivity = (id, tool, at) => {
        if (!recordDenial(id))
            return undefined;
        const idx = toolStep.get(id) ?? step++;
        toolStep.set(id, idx);
        const activity = { stepIndex: idx, tool, toolCallId: id, denied: true };
        return { kind: 'activity-end', at, activity, status: 'denied' };
    };
    tx.onEvent = (raw) => {
        const out = [];
        const type = str(raw, 'type');
        const at = nowIso();
        const sessionId = str(raw, 'session_id');
        if (sessionId !== undefined)
            tx.sessionId = sessionId;
        // ---- system / init ------------------------------------------------------
        if (type === 'system') {
            const subtype = str(raw, 'subtype');
            if (subtype === 'permission_denied') {
                const toolUseId = str(raw, 'tool_use_id') ?? str(raw, 'id');
                const toolName = str(raw, 'tool_name') ?? str(raw, 'tool') ?? 'unknown';
                const key = toolUseId ?? `tool:${toolName}`;
                const evidence = denialActivity(key, toolName, at);
                if (evidence !== undefined)
                    out.push(evidence);
                return out;
            }
            if (subtype === 'init') {
                const ev = { kind: 'started', at, raw };
                if (sessionId !== undefined)
                    ev.conversationId = sessionId;
                const model = str(raw, 'model');
                if (model !== undefined) {
                    ev.model = model;
                    tx.model = model;
                }
                out.push(ev);
                return out;
            }
            if (subtype === 'thinking_tokens') {
                // Not text, but the only live signal that the model is thinking. Show
                // it as thinking text so the moderator pane feels alive instead of
                // frozen for 90 seconds.
                const est = raw['estimated_tokens'];
                out.push({
                    kind: 'text',
                    at,
                    text: `thinking… ~${typeof est === 'number' ? est : '?'} tokens`,
                    stream: 'thinking',
                });
                return out;
            }
            if (subtype === 'hook_started' || subtype === 'hook_response') {
                // Hooks genuinely run headless (verified — a SessionStart hook fired in
                // my run). An operator watching 16 workers should know they are there.
                out.push({
                    kind: 'notice',
                    at,
                    level: 'info',
                    message: `claude hook ${str(raw, 'hook_name') ?? subtype}`,
                    raw,
                });
                return out;
            }
            // Other system subtypes (compact_boundary, etc.) are informational.
            out.push({ kind: 'notice', at, level: 'info', message: `claude system.${subtype ?? 'unknown'}`, raw });
            return out;
        }
        // ---- assistant messages --------------------------------------------------
        if (type === 'assistant') {
            const message = obj(raw, 'message');
            const content = Array.isArray(message?.['content']) ? message['content'] : [];
            const usage = toTokenUsage$3(obj(message, 'usage'));
            if (usage !== undefined) {
                tx.usage = usage;
                out.push({ kind: 'usage', at, usage });
            }
            for (const block of content) {
                if (block === null || typeof block !== 'object')
                    continue;
                const b = block;
                const bType = str(b, 'type');
                if (bType === 'text') {
                    const text = str(b, 'text');
                    if (text !== undefined && text !== '') {
                        // parent_tool_use_id present => this text came from a SUBAGENT
                        // (forwarded by --forward-subagent-text). We must not fold it into
                        // finalText: the top-level result is the moderator's own answer, and
                        // a subagent's chatter in there would corrupt the moderated output.
                        const parent = str(b, 'parent_tool_use_id');
                        if (parent !== undefined) {
                            out.push({
                                kind: 'text',
                                at,
                                text: `[subagent] ${text}`,
                                stream: 'assistant',
                            });
                        }
                        else {
                            tx.finalText += text;
                            out.push({ kind: 'text', at, text, stream: 'assistant' });
                        }
                    }
                    continue;
                }
                if (bType === 'thinking') {
                    const thinking = str(b, 'thinking');
                    if (thinking !== undefined && thinking !== '') {
                        out.push({ kind: 'text', at, text: thinking, stream: 'thinking' });
                    }
                    continue;
                }
                if (bType === 'tool_use') {
                    const toolUseId = str(b, 'id') ?? `toolu-${step}`;
                    const toolName = str(b, 'name') ?? 'unknown';
                    const idx = step++;
                    toolStep.set(toolUseId, idx);
                    const input = preview(b['input'], maxChars);
                    const ref = { stepIndex: idx, tool: toolName, toolCallId: toolUseId };
                    if (input !== undefined)
                        ref.input = input.text;
                    if (input?.truncated === true)
                        ref.truncated = true;
                    out.push({ kind: 'activity-start', at, activity: ref });
                    continue;
                }
            }
            return out;
        }
        // ---- user messages: tool_result blocks ----------------------------------
        if (type === 'user') {
            const message = obj(raw, 'message');
            const content = Array.isArray(message?.['content']) ? message['content'] : [];
            for (const block of content) {
                if (block === null || typeof block !== 'object')
                    continue;
                const b = block;
                if (str(b, 'type') !== 'tool_result')
                    continue;
                const toolUseId = str(b, 'tool_use_id') ?? '';
                const idx = toolStep.get(toolUseId) ?? step++;
                if (toolUseId !== '')
                    toolStep.set(toolUseId, idx);
                // tool_result.content is either a string or an array of content blocks.
                const rawContent = b['content'];
                const text = typeof rawContent === 'string' ? rawContent : preview(rawContent, maxChars)?.text;
                const isError = b['is_error'] === true;
                const denied = isError && isPermissionDenial(text);
                let status = 'done';
                if (denied)
                    status = 'denied';
                else if (isError)
                    status = 'error';
                const output = preview(text, maxChars);
                const ref = { stepIndex: idx, tool: 'tool_result', toolCallId: toolUseId };
                if (output !== undefined)
                    ref.output = output.text;
                if (output?.truncated === true)
                    ref.truncated = true;
                if (denied)
                    ref.denied = true;
                out.push({ kind: 'activity-end', at, activity: ref, status });
                if (denied) {
                    const key = toolUseId !== '' ? toolUseId : `tool:${str(b, 'name') ?? 'unknown'}`;
                    recordDenial(key);
                }
            }
            return out;
        }
        // ---- result --------------------------------------------------------------
        if (type === 'result') {
            tx.sawResult = true;
            const permissionDenials = Array.isArray(raw['permission_denials']) ? raw['permission_denials'] : [];
            for (const denial of permissionDenials) {
                if (denial === null || typeof denial !== 'object')
                    continue;
                const d = denial;
                const toolName = str(d, 'tool_name') ?? str(d, 'tool') ?? 'unknown';
                const id = str(d, 'tool_use_id') ?? str(d, 'id') ?? `tool:${toolName}`;
                const evidence = denialActivity(id, toolName, at);
                if (evidence !== undefined)
                    out.push(evidence);
            }
            const subtype = str(raw, 'subtype');
            const isError = raw['is_error'] === true || (subtype !== undefined && subtype !== 'success');
            if (isError)
                tx.sawErrorResult = true;
            // On success, `result` IS the answer (handled below), so it is only an
            // "error" when it came back on a non-success result event.
            const errText = str(raw, 'error') ?? (isError ? str(raw, 'result') : undefined);
            if (errText !== undefined)
                tx.resultError = errText;
            const usage = toTokenUsage$3(obj(raw, 'usage'));
            if (usage !== undefined) {
                tx.usage = usage;
                out.push({ kind: 'usage', at, usage });
            }
            const cost = raw['total_cost_usd'];
            if (typeof cost === 'number')
                tx.cost = cost;
            const turns = raw['num_turns'];
            if (typeof turns === 'number')
                tx.numTurns = turns;
            // The top-level `result` string is the authoritative final answer. Prefer
            // it over our concatenation of text blocks: if the run used
            // --forward-subagent-text, the concatenation includes subagent chatter we
            // deliberately excluded, but if claude compressed or re-emitted text the
            // `result` field is still correct.
            const finalAnswer = str(raw, 'result');
            if (finalAnswer !== undefined && finalAnswer !== '')
                tx.finalText = finalAnswer;
            return out;
        }
        if (type === 'error') {
            tx.sawErrorResult = true;
            out.push({
                kind: 'notice',
                at,
                level: 'error',
                message: str(obj(raw, 'error'), 'message') ?? str(raw, 'message') ?? 'claude error',
                raw,
            });
            return out;
        }
        return out;
    };
    return tx;
}
// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
function buildResult$3(args) {
    const { jobId, startedAtMs, stateDir, exit, tx } = args;
    const durationMs = Date.now() - startedAtMs;
    let status;
    let error;
    // claude has no --print-timeout, so a timeout kill is entirely ours: never
    // infer success from "it produced a lot of output".
    const early = earlyVerdict(exit, durationMs);
    if (early !== undefined) {
        ({ status, error } = early);
    }
    else if (tx.deniedTools.length > 0 && !(tx.sawResult && !tx.sawErrorResult && exit.code === 0 && tx.finalText.trim() !== '')) {
        // Same discipline as agy. A moderator whose tools were denied has not
        // moderated anything, and claude may still report subtype "success".
        status = 'denied';
        error = deniedText(tx.deniedTools, exit.stderr);
    }
    else if (!tx.sawResult) {
        // No result event: killed early, crashed, or a CLI output change.
        status = exit.code === 0 ? 'malformed' : 'error';
        error = noResultText(exit);
    }
    else if (tx.sawErrorResult) {
        status = 'error';
        error = tx.resultError ?? 'worker error';
    }
    else if (exit.code !== 0) {
        status = 'error';
        error = `exited ${exit.code}${stderrClause(exit.stderr)}`;
    }
    else {
        status = 'success';
    }
    const out = jobResult({ provider: 'claude', jobId, status, error, exit, response: tx.finalText, startedAtMs, durationMs, stateDir });
    // A report was delivered despite denied calls: the job succeeded, but the
    // orchestrator must know some checks did not run (normalize.ts turns this
    // into a warning).
    if (tx.deniedTools.length > 0) {
        out.deniedActions = tx.deniedTools.map((id) => ({ action: 'tool', displayName: id, nonfatal: true }));
    }
    if (tx.usage !== undefined)
        out.usage = tx.usage;
    const raw = {};
    if (tx.sessionId !== undefined)
        raw['sessionId'] = tx.sessionId;
    if (tx.model !== undefined)
        raw['model'] = tx.model;
    if (tx.cost !== undefined)
        raw['totalCostUsd'] = tx.cost;
    if (tx.numTurns !== undefined)
        raw['numTurns'] = tx.numTurns;
    if (Object.keys(raw).length > 0)
        out.raw = raw;
    return out;
}
// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
/** Aliases documented by `claude --help`. */
const CLAUDE_ALIASES = [
    { id: 'fable', label: 'Fable' },
    { id: 'opus', label: 'Opus' },
    { id: 'sonnet', label: 'Sonnet' },
    { id: 'haiku', label: 'Haiku' },
];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Claude config dir: AGENT_SMITH_CLAUDE_HOME, CLAUDE_CONFIG_DIR, then ~/.claude. */
function claudeHome() {
    return configDir(['AGENT_SMITH_CLAUDE_HOME', 'CLAUDE_CONFIG_DIR'], '.claude');
}
/** Top-level `model` from <home>/settings.json. Throws on malformed JSON; callers decide how loud to be. */
function readDefaultModel(home) {
    const text = readTextSafe(path.join(home, 'settings.json'));
    const model = text === undefined ? undefined : JSON.parse(text)?.model;
    return typeof model === 'string' && model !== '' ? model : undefined;
}
/** Static alias catalog; default model from <home>/settings.json top-level `model`. Never throws. */
async function listClaudeModels(_options, home = claudeHome()) {
    const cat = {
        provider: 'claude',
        models: CLAUDE_ALIASES.map((a) => ({ id: a.id, label: a.label, efforts: [...CLAUDE_EFFORTS] })),
        defaultSource: 'unknown',
        source: 'static',
        stale: false,
        verified: true,
    };
    try {
        const model = readDefaultModel(home);
        if (model !== undefined) {
            cat.defaultModel = model;
            cat.defaultSource = 'harness-config';
        }
    }
    catch (e) {
        cat.error = `could not parse settings.json: ${errMessage(e)}`;
    }
    return cat;
}
/** Default model from <home>/settings.json. Sync file read only; never throws. */
function claudeHarnessDefaults(home = claudeHome()) {
    try {
        const model = readDefaultModel(home);
        return model === undefined ? {} : { model };
    }
    catch {
        return {};
    }
}
const claudeProvider = {
    harnessDefaults: () => claudeHarnessDefaults(),
    name: 'claude',
    available: () => binaryAvailable(CLAUDE_BINARY),
    describeSandbox: sandboxPlan$3,
    listModels: (options) => listClaudeModels(),
    spawn(spec) {
        const tx = createClaudeTranslator(spec.maxOutputChars ?? 2000);
        return runNdjsonWorker({
            provider: 'claude',
            binary: CLAUDE_BINARY,
            spec,
            buildArgv: buildArgv$3,
            translate: tx.onEvent,
            buildResult: (ctx) => buildResult$3({ ...ctx, tx }),
        });
    },
};/**
 * providers/codex.ts — OpenAI Codex CLI adapter (`codex exec`).
 *
 * VERIFICATION LEVEL: HIGH. Every flag below was read out of `codex exec --help`
 * on codex-cli 0.160.1 on this machine, and the whole invocation was then run
 * live end to end. See the transcript at the bottom of this file header.
 *
 * ----------------------------------------------------------------------------
 * VERIFIED FLAGS (`codex exec --help`, v0.160.1)
 * ----------------------------------------------------------------------------
 *   codex exec [PROMPT]            non-interactive; "Use Codex non-interactively"
 *   --json                         "Print events to stdout as JSONL"
 *   -m, --model <MODEL>
 *   -C, --cd <DIR>                 working root, independent of our spawn cwd
 *   -s, --sandbox <read-only|workspace-write|danger-full-access>
 *   --add-dir <DIR>                widen the writable sandbox
 *   --skip-git-repo-check          "Allow running Codex outside a Git repository"
 *   --dangerously-bypass-approvals-and-sandbox
 *                                  "Skip all confirmation prompts and execute
 *                                   commands without sandboxing."
 *   --ephemeral                    do not persist session files
 *   --ignore-user-config           skip ~/.codex/config.toml (auth still used)
 *   -c key=value                   dotted-path config override, TOML-parsed
 *   -o, --output-last-message <FILE>  write final message to a file
 *   --output-schema <FILE>         JSON Schema for the final response
 *
 * VERIFIED EVENT SHAPES (live, codex exec --json):
 *
 *   {"type":"thread.started","thread_id":"01a113ee-..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
 *   {"type":"turn.completed","usage":{"input_tokens":22319,
 *       "cached_input_tokens":12288,"cache_write_input_tokens":0,
 *       "output_tokens":5,"reasoning_output_tokens":0}}
 *
 * NOTE ON THE USAGE SHAPE: codex reports `cached_input_tokens` and
 * `cache_write_input_tokens`, NOT `cache_read_tokens` as agy does. We map
 * cached -> cacheReadTokens and cache_write -> cacheWriteTokens. There is no
 * `total_tokens`; we leave it undefined rather than inventing one. (Note also
 * that codex's input_tokens already appears to INCLUDE cached tokens in this
 * run — 22319 in, 12288 cached. We report what the CLI says and let consumers
 * decide the accounting policy; silently double-subtracting would be worse.)
 *
 * UNVERIFIED (documented in --help or upstream docs but NOT observed locally):
 *   - `item.started` and `item.updated`. `--help` does not enumerate event
 *     names and my live run produced no tool calls, so I never saw an in-flight
 *     tool event. The parser below HANDLES them if they exist and ignores them
 *     if they do not. See README "UNVERIFIED".
 *   - The exact `item.type` vocabulary for tools. I observed `agent_message`
 *     only. `command_execution`, `file_change`, `mcp_tool_call`, `reasoning`
 *     and `todo_list` appear in Codex's own docs and are handled defensively.
 *   - Whether `codex exec` ever exits 0 on a failed turn. Assumed it does not,
 *     but exit code is treated as corroboration, not proof — see buildResult.
 *
 * ----------------------------------------------------------------------------
 * TWO BEHAVIOURS THAT WILL BITE ANYONE WHO SPAWNS THIS NAIVELY
 * ----------------------------------------------------------------------------
 * 1. STDIN. With stdin as a pipe (or inherited from a non-tty parent), codex
 *    prints "Reading additional input from stdin..." and waits. The documented
 *    contract is "If stdin is piped and a prompt is also provided, stdin is
 *    appended as a `<stdin>` block". Our spawnWorker uses stdio[0]='ignore',
 *    which is a closed/absent fd rather than a pipe — so codex does not enter
 *    the stdin path and returns immediately. Verified. If you ever change
 *    stdio[0] to 'pipe', this adapter will hang forever.
 * 2. TRUSTED DIRECTORY. Outside a git repo, codex exits with
 *    "Not inside a trusted directory and --skip-git-repo-check was not
 *    specified." and writes NOTHING to stdout — not even an error event. So the
 *    absence of a result event is a real, reachable failure mode here and we
 *    map it to JobStatus 'malformed' with the stderr tail attached. Verified.
 *    We always pass --skip-git-repo-check for this reason: agent-smith runs
 *    workers in scratch dirs and vendored checkouts, and refusing to run
 *    because there is no .git is not a useful policy for an orchestrator.
 *
 * LIVE TRANSCRIPT (2026-10-06, codex-cli 0.160.1):
 *   $ codex exec --json --skip-git-repo-check -s read-only "Reply with exactly: OK" < /dev/null
 *   Reading additional input from stdin...            <- stderr, not stdout
 *   {"type":"thread.started","thread_id":"01a113ee-7022-7bf0-a5d8-e4c56fc61ce9"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
 *   {"type":"turn.completed","usage":{"input_tokens":22319,"cached_input_tokens":12288,
 *    "cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
 *   $ echo $?   -> 0
 */
const CODEX_BINARY = process.env['AGENT_SMITH_CODEX_BIN'] ?? 'codex';
/**
 * Map SpawnSpec.unrestricted onto a codex sandbox policy.
 *
 * WHY THIS IS A THREE-WAY CHOICE AND NOT A BOOLEAN
 * ------------------------------------------------
 * Codex has no "prompt for approval" headless mode worth using: it would stall
 * the worker forever waiting for a human who does not exist. So the only two
 * sane headless policies are "locked down" and "wide open".
 *
 *   unrestricted=true  -> --dangerously-bypass-approvals-and-sandbox.
 *     Verified help text: "Skip all confirmation prompts and execute commands
 *     without sandboxing." This is the honest expression of "I trust this
 *     worker in this directory", and it matches agy's
 *     --dangerously-skip-permissions and claude's
 *     --dangerously-skip-permissions, so all three providers mean the same
 *     thing when the pipeline says unrestricted.
 *
 *   unrestricted=false -> -s workspace-write.
 *     NOT read-only. A review or moderate stage that cannot write a scratch
 *     note cannot do its job, and workspace-write is codex's own default
 *     non-interactive posture. A caller that genuinely needs a read-only prober
 *     sets AGENT_SMITH_CODEX_SANDBOX=read-only (see configOverrides below),
 *     which overrides this mapping. Documented in the README as a deliberate
 *     asymmetry with agy, which has no equivalent knob.
 *
 * NOT USED: -s danger-full-access without the bypass flag. It grants the same
 * filesystem reach but leaves approval prompts in the loop, which in headless
 * mode means a stall. Combining them is strictly worse than the bypass alone.
 */
const UNRESTRICTED_FLAGS = ['--dangerously-bypass-approvals-and-sandbox'];
/** Valid AGENT_SMITH_CODEX_SANDBOX value, if any. */
function envSandbox() {
    const v = process.env['AGENT_SMITH_CODEX_SANDBOX'];
    return v === 'read-only' || v === 'workspace-write' || v === 'danger-full-access' ? v : undefined;
}
/**
 * The single source of truth for codex sandbox flags, used by buildArgv AND
 * describeSandbox. Precedence: AGENT_SMITH_CODEX_SANDBOX env > unrestricted
 * (bypass) > readOnly (`-s read-only`) > workspace-write. On resume `-s` is not
 * exposed, so the same mode goes through `-c sandbox_mode="..."`.
 */
function sandboxPlan$2(spec, resuming = false) {
    const mode = (m) => {
        const flags = resuming ? ['-c', `sandbox_mode=${JSON.stringify(m)}`] : ['-s', m];
        return { sandbox: `codex ${flags.join(' ')}`, flags, readOnlyEnforced: m === 'read-only' };
    };
    const forced = envSandbox();
    if (forced !== undefined) {
        const info = mode(forced);
        return { ...info, sandbox: `${info.sandbox} (AGENT_SMITH_CODEX_SANDBOX)` };
    }
    if (spec.unrestricted) {
        const flags = UNRESTRICTED_FLAGS;
        return { sandbox: `codex ${flags[0]} (unrestricted)`, flags, readOnlyEnforced: false };
    }
    if (spec.readOnly === true && spec.artifactPath !== undefined) {
        // `-s read-only` blocks every write, `--add-dir` included (verified on codex
        // 0.162.1), so a pipeline stage could not write its artifact. A permission
        // profile that reads everything and writes exactly that file can; it cannot
        // be combined with `-s`.
        const artifact = path.resolve(spec.artifactPath);
        const flags = [
            '-c', `default_permissions=${JSON.stringify(ARTIFACT_PROFILE)}`,
            '-c', `permissions.${ARTIFACT_PROFILE}.filesystem=${tomlInlineTable({ ':root': 'read', [artifact]: 'write' })}`,
        ];
        return { sandbox: `codex read-only except the output artifact ${artifact}`, flags, readOnlyEnforced: true };
    }
    return mode(spec.readOnly === true ? 'read-only' : 'workspace-write');
}
const ARTIFACT_PROFILE = 'agent-smith-artifact';
function tomlInlineTable(entries) {
    return `{${Object.entries(entries).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(', ')}}`;
}
/**
 * SpawnSpec has no field for arbitrary CLI config overrides, and inventing one
 * here would widen the shared SpawnSpec interface for one provider.
 * So: pass through the two config overrides that actually matter, read from the
 * environment with an AGENT_SMITH_ prefix. Documented in the README.
 */
function configOverrides() {
    const argv = [];
    const model = process.env['AGENT_SMITH_CODEX_MODEL'];
    // -c model="x" — note the value is TOML-parsed, so a bare number would become
    // a TOML integer. Model ids are never numeric, so a plain string is safe.
    if (model !== undefined && model !== '')
        argv.push('-c', `model="${model}"`);
    return argv;
}
/**
 * Build the exact argv for one codex worker.
 *
 * ORDER: `codex exec` must come first (it is the subcommand), then flags, then
 * the prompt as a trailing positional. Verified: `codex exec [OPTIONS] [PROMPT]`.
 *
 * The prompt is a positional argument, NOT attached to a flag and NOT stdin.
 * That is the difference from agy, whose `--print` CONSUMES the next token when
 * separated by a space — which is why agy needs the attached form and codex
 * does not. Verified live with a multi-word prompt.
 */
function buildArgv$2(spec) {
    const resuming = spec.conversation !== undefined && spec.conversation !== '';
    const argv = resuming
        ? ['exec', 'resume', spec.conversation]
        : ['exec'];
    // Verified: "--json  Print events to stdout as JSONL". Without it codex prints
    // human-formatted prose and we would have nothing to parse.
    argv.push('--json');
    // Verified necessary outside a git repo; see header note 2.
    argv.push('--skip-git-repo-check');
    // `exec resume --help` does not expose -C; resumed sessions retain their
    // original working directory. New sessions get an explicit root.
    if (!resuming)
        argv.push('-C', spec.cwd);
    if (spec.model !== undefined && spec.model !== '')
        argv.push('--model', spec.model);
    if (spec.effort !== undefined && spec.effort !== '') {
        const supported = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
        if (!supported.includes(spec.effort)) {
            throw new RangeError(`codex does not support effort '${spec.effort}'; expected one of ${supported.join(', ')}`);
        }
        // Codex exposes reasoning effort as config, not a dedicated exec flag.
        // `-c` applies to both exec and exec resume (verified with installed CLI help).
        argv.push('-c', `model_reasoning_effort=${JSON.stringify(spec.effort)}`);
    }
    // The prompt goes LAST so a prompt that begins with "-" cannot be mistaken
    // for a flag. (`--` would be the other fix; trailing positional is what the
    // help text documents and what I verified.)
    if (resuming && (spec.addDirs?.length ?? 0) > 0) {
        throw new RangeError('codex exec resume does not support --add-dir; remove addDirs or start a new session');
    }
    for (const dir of resuming ? [] : spec.addDirs ?? []) {
        argv.push('--add-dir', dir);
    }
    // Resume omits -s from its help but accepts generic -c; sandboxPlan handles both.
    argv.push(...sandboxPlan$2(spec, resuming).flags);
    argv.push(...configOverrides());
    argv.push(spec.prompt);
    return argv;
}
function toTokenUsage$2(u) {
    if (u === undefined)
        return undefined;
    const out = {};
    if (u.input_tokens !== undefined)
        out.inputTokens = u.input_tokens;
    if (u.output_tokens !== undefined)
        out.outputTokens = u.output_tokens;
    if (u.reasoning_output_tokens !== undefined)
        out.thinkingTokens = u.reasoning_output_tokens;
    // codex names its cache-read counter `cached_input_tokens`. Mapping it to the
    // same field agy calls cache_read_tokens is what lets consumers total them
    // without caring which provider a row came from.
    if (u.cached_input_tokens !== undefined)
        out.cacheReadTokens = u.cached_input_tokens;
    if (u.cache_write_input_tokens !== undefined)
        out.cacheWriteTokens = u.cache_write_input_tokens;
    // No total_tokens from codex. Deliberately left undefined — see header.
    return Object.keys(out).length > 0 ? out : undefined;
}
/**
 * Codex item types that represent a tool call, and the label we show for each.
 *
 * ONLY `agent_message` is VERIFIED (observed live). The rest come from Codex's
 * public docs and are mapped defensively: an unknown item type falls through to
 * a generic tool activity rather than being dropped, so progress never silently
 * disappears because the CLI added a type.
 */
const KNOWN_ITEM_TYPES = new Set([
    'agent_message',
    'reasoning',
    'command_execution',
    'file_change',
    'mcp_tool_call',
    'web_search',
    'todo_list',
    'error',
]);
/** Item types that are NOT tool calls and must not become activities. */
const NON_TOOL_ITEM_TYPES = new Set(['agent_message', 'reasoning', 'todo_list']);
/**
 * Incremental step counter.
 *
 * WHY NOT THE item.id: `item_0` is per-turn, not per-job — a second turn resets
 * numbering. Our ProviderEvent.activity.stepIndex must be monotonic within a
 * job because consumers use it as the activity key. So we mint our own.
 */
function createCodexTranslator(maxChars) {
    let step = 0;
    const state = {
        sawTurnCompleted: false,
        finalText: '',
        onEvent: () => [],
    };
    /** item.id -> stepIndex, so item.started/completed pair up. */
    const itemStep = new Map();
    /** item.id -> tool label, for the DONE event (the START may be absent). */
    const itemTool = new Map();
    state.onEvent = (raw) => {
        const out = [];
        const type = str(raw, 'type');
        const at = nowIso();
        if (type === 'thread.started') {
            // thread_id is codex's resume handle — the SpawnSpec.conversation value for
            // a follow-up run. Recorded on the event AND on the translator so it can
            // end up in JobResult.raw.
            const threadId = str(raw, 'thread_id');
            if (threadId !== undefined)
                state.threadId = threadId;
            const ev = { kind: 'started', at, raw };
            if (threadId !== undefined)
                ev.conversationId = threadId;
            const m = str(raw, 'model');
            if (m !== undefined)
                ev.model = m;
            out.push(ev);
            return out;
        }
        if (type === 'turn.started') {
            out.push({ kind: 'notice', at, level: 'info', message: 'codex turn started', raw });
            return out;
        }
        if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
            const item = obj(raw, 'item');
            if (item === undefined)
                return out;
            const itemId = str(item, 'id') ?? `anon-${step}`;
            const itemType = str(item, 'type') ?? 'unknown';
            // An item type we have never heard of. Not an error: surface it, do not
            // silently drop it. This is the whole reason the translation is a
            // whitelist-of-behaviour rather than a whitelist-of-types.
            if (!KNOWN_ITEM_TYPES.has(itemType)) {
                out.push({
                    kind: 'notice',
                    at,
                    level: 'info',
                    message: `codex emitted unrecognised item type "${itemType}"`,
                    raw: item,
                });
                return out;
            }
            // Assistant prose.
            if (itemType === 'agent_message') {
                const text = str(item, 'text');
                if (text !== undefined && text !== '') {
                    if (state.finalText !== '')
                        state.finalText += '\n';
                    state.finalText += text;
                    out.push({ kind: 'text', at, text, stream: 'assistant' });
                }
                return out;
            }
            // Reasoning. codex does not stream reasoning text in the JSONL we verified,
            // only a token count in usage, so there is nothing to emit here beyond a
            // notice. Kept so the branch is explicit rather than accidental.
            if (itemType === 'reasoning') {
                const summary = preview(item['summary'], maxChars);
                if (summary !== undefined) {
                    out.push({ kind: 'text', at, text: summary.text, stream: 'thinking' });
                }
                return out;
            }
            if (itemType === 'todo_list') {
                out.push({ kind: 'notice', at, level: 'info', message: 'codex updated its todo list', raw: item });
                return out;
            }
            if (NON_TOOL_ITEM_TYPES.has(itemType))
                return out;
            // ---- tool-ish items ----------------------------------------------------
            const tool = itemTool.get(itemId) ?? str(item, 'command') ?? itemType;
            if (!itemTool.has(itemId))
                itemTool.set(itemId, tool);
            // Command output arrives as `aggregated_output` / `output` on the item.
            // The parameter shape differs per item type, so preview the whole item
            // minus the id and hand it to the truncation helper. Better a slightly
            // noisy preview than no visibility into what the worker ran.
            const inputPreview = itemType === 'command_execution' ? preview(item['command'], maxChars) : preview(item['input'], maxChars);
            const outputPreview = preview(item['aggregated_output'] ?? item['output'], maxChars);
            if (type === 'item.started') {
                const idx = step++;
                itemStep.set(itemId, idx);
                const ref = { stepIndex: idx, tool };
                if (inputPreview !== undefined)
                    ref.input = inputPreview.text;
                if (inputPreview?.truncated === true)
                    ref.truncated = true;
                out.push({ kind: 'activity-start', at, activity: ref });
                return out;
            }
            // item.updated: incremental progress for the same item.
            if (type === 'item.updated') {
                const idx = itemStep.get(itemId);
                if (idx === undefined)
                    return out;
                const ref = { stepIndex: idx, tool };
                if (inputPreview !== undefined)
                    ref.input = inputPreview.text;
                if (outputPreview !== undefined) {
                    ref.output = outputPreview.text;
                    if (outputPreview.truncated)
                        ref.truncated = true;
                }
                out.push({ kind: 'activity-update', at, activity: ref });
                return out;
            }
            // item.completed: terminal.
            const idx = itemStep.get(itemId) ?? step++;
            itemStep.set(itemId, idx);
            // codex item status field: UNVERIFIED name/shape. We read a few plausible
            // spellings and fall back to "done", because a completed item that
            // carries an explicit failure must not render as green.
            const itemStatus = str(item, 'status') ?? str(item, 'state');
            const exitCode = itemType === 'command_execution' ? num(item, 'exit_code') : undefined;
            const itemResult = obj(item, 'result');
            const explicitError = itemType === 'error' || itemStatus === 'failed' || itemStatus === 'error' ||
                item['isError'] === true || item['is_error'] === true || item['error'] != null ||
                itemResult?.['isError'] === true || itemResult?.['is_error'] === true ||
                (exitCode !== undefined && exitCode !== 0);
            let status = explicitError ? 'error' : 'done';
            // A codex tool call that needs approval it cannot get is the same failure
            // shape as agy's soft denial: the work silently did not happen. We do not
            // have a verified codex denial field, but the message text is stable
            // enough to detect, and mis-rendering this as success is the expensive
            // error. UNVERIFIED — see README.
            const error = obj(item, 'error');
            const denialReason = str(item, 'decision') ?? str(item, 'approval_status') ?? str(error, 'type');
            const messages = [str(error, 'message'), str(item, 'message')].filter((m) => m !== undefined).map((m) => m.toLowerCase());
            const denied = item['permission_denied'] === true || item['denied'] === true ||
                itemStatus === 'denied' || itemStatus === 'rejected' || itemStatus === 'declined' ||
                (denialReason !== undefined && /^(?:denied|rejected|declined|approval_denied|permission_denied)$/i.test(denialReason)) ||
                messages.some((m) => /(?:permission|approval).{0,50}(?:denied|rejected)|(?:denied|rejected).{0,50}(?:permission|approval)|(?:rejected|declined) by (?:the )?user/.test(m));
            if (denied)
                status = 'denied';
            const ref = { stepIndex: idx, tool };
            ref.toolCallId = itemId;
            if (inputPreview !== undefined)
                ref.input = inputPreview.text;
            if (outputPreview !== undefined) {
                ref.output = outputPreview.text;
                if (outputPreview.truncated)
                    ref.truncated = true;
            }
            if (denied)
                ref.denied = true;
            const ev = { kind: 'activity-end', at, activity: ref, status };
            const dur = num(item, 'duration_ms');
            if (dur !== undefined)
                ev.durationSeconds = dur / 1000;
            out.push(ev);
            return out;
        }
        if (type === 'turn.completed') {
            state.sawTurnCompleted = true;
            const usage = toTokenUsage$2(obj(raw, 'usage'));
            if (usage !== undefined) {
                state.usage = usage;
                out.push({ kind: 'usage', at, usage });
            }
            return out;
        }
        if (type === 'turn.failed') {
            // UNVERIFIED: not observed locally, but it is the shape codex's docs
            // describe for a failed turn. Handled so a failure is not mistaken for
            // "the stream just ended".
            state.error = str(obj(raw, 'error'), 'message') ?? 'codex turn failed';
            out.push({
                kind: 'notice',
                at,
                level: 'error',
                message: state.error,
                raw,
            });
            return out;
        }
        if (type === 'error') {
            // `error` may be an object (codex's error envelope) or a bare string,
            // depending on the event. Try both rather than assume one shape.
            const e = obj(raw, 'error');
            const eString = typeof raw['error'] === 'string' ? raw['error'] : undefined;
            const message = str(e, 'message') ?? eString ?? str(raw, 'message') ?? 'codex reported an error';
            state.error = message;
            out.push({
                kind: 'notice',
                at,
                level: 'error',
                message,
                raw,
            });
            return out;
        }
        return out;
    };
    return state;
}
// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
function buildResult$2(args) {
    const { jobId, startedAtMs, stateDir, exit, tx } = args;
    const durationMs = Date.now() - startedAtMs;
    let status;
    let error;
    const early = earlyVerdict(exit, durationMs);
    if (early !== undefined) {
        ({ status, error } = early);
    }
    else if (!tx.sawTurnCompleted) {
        // The reachable case in practice is the untrusted-directory refusal, which
        // writes NOTHING to stdout and prints only to stderr. Guessing 'success'
        // here would be a lie.
        status = exit.code === 0 ? 'malformed' : 'error';
        // Usual causes: an untrusted directory, an auth failure, or an output-format change.
        error = tx.error ?? noResultText(exit);
    }
    else if (exit.code !== 0) {
        // turn.completed arrived but the process still failed. Corroboration wins.
        status = 'error';
        error = tx.error ?? `exited ${exit.code}${stderrClause(exit.stderr)}`;
    }
    else {
        status = 'success';
    }
    // codex has no single "response" field; the concatenated agent_message items
    // are the equivalent. If there were none, this is legitimately "".
    const out = jobResult({ provider: 'codex', jobId, status, error, exit, response: tx.finalText, startedAtMs, durationMs, stateDir });
    if (tx.usage !== undefined)
        out.usage = tx.usage;
    if (tx.threadId !== undefined)
        out.raw = { threadId: tx.threadId };
    return out;
}
// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
/** Codex home: AGENT_SMITH_CODEX_HOME, then CODEX_HOME, then ~/.codex. */
function codexHome() {
    return configDir(['AGENT_SMITH_CODEX_HOME', 'CODEX_HOME'], '.codex');
}
/**
 * Extract ONLY the `models` array from either `codex debug models` output or
 * models_cache.json. Nothing else (notably `identity`) is passed through.
 */
function parseCodexModels(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    const list = parsed?.models;
    if (!Array.isArray(list))
        return undefined;
    const out = [];
    for (const m of list) {
        if (m === null || typeof m !== 'object')
            continue;
        const r = m;
        if (typeof r['slug'] !== 'string' || r['slug'] === '')
            continue;
        const levels = Array.isArray(r['supported_reasoning_levels']) ? r['supported_reasoning_levels'] : [];
        const efforts = [];
        for (const l of levels) {
            const e = typeof l === 'string' ? l : l?.effort;
            if (typeof e === 'string' && e !== '' && !efforts.includes(e))
                efforts.push(e);
        }
        const info = {
            id: r['slug'],
            label: typeof r['display_name'] === 'string' && r['display_name'] !== '' ? r['display_name'] : r['slug'],
            efforts,
        };
        if (typeof r['default_reasoning_level'] === 'string' && r['default_reasoning_level'] !== '') {
            info.defaultEffort = r['default_reasoning_level'];
        }
        out.push(info);
    }
    return out;
}
/** Lazy, never throws. `run` and `home` are injectable for tests. */
async function listCodexModels(run, options, home = codexHome()) {
    const cat = {
        provider: 'codex',
        models: [],
        defaultSource: 'unknown',
        source: 'live',
        stale: false,
        verified: true,
    };
    try {
        let error;
        let models;
        const r = await run(CODEX_BINARY, ['debug', 'models'], options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
        if (r.error === undefined)
            models = parseCodexModels(r.stdout);
        if (models === undefined || models.length === 0) {
            error = r.error ?? '`codex debug models` returned no models';
            const cached = readTextSafe(path.join(home, 'models_cache.json'));
            const fromCache = cached === undefined ? undefined : parseCodexModels(cached);
            if (fromCache !== undefined && fromCache.length > 0) {
                models = fromCache;
                cat.source = 'cache';
                // The live listing failed, so this is last-known data: callers must not
                // reject unknown ids against it.
                cat.stale = true;
                cat.error = `live listing failed (${error}); using ~/.codex/models_cache.json`;
            }
            else {
                models = [];
            }
        }
        cat.models = models;
        if (models.length === 0)
            cat.error = error;
        const defaults = codexHarnessDefaults(home);
        if (defaults.model !== undefined)
            cat.defaultModel = defaults.model;
        if (defaults.effort !== undefined)
            cat.defaultEffort = defaults.effort;
        if (defaults.model !== undefined || defaults.effort !== undefined)
            cat.defaultSource = 'harness-config';
    }
    catch (e) {
        cat.error = errMessage(e);
    }
    return cat;
}
/** Default model/effort from <home>/config.toml. Sync file read only. */
function codexHarnessDefaults(home = codexHome()) {
    const cfgText = readTextSafe(path.join(home, 'config.toml'));
    if (cfgText === undefined)
        return {};
    const cfg = parseTomlTopLevel(cfgText);
    const out = {};
    if (cfg['model'])
        out.model = cfg['model'];
    if (cfg['model_reasoning_effort'])
        out.effort = cfg['model_reasoning_effort'];
    return out;
}
/** Known model discovery noise does not describe the outcome of a worker turn. */
function codexStderrLevel(text) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const refreshTimeout = /^(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+)?(?:ERROR\s+)?(?:(?:codex_models_manager::manager|codex_core::models_manager):\s+)?failed to refresh available models: request timed out\.?$/i;
    if (lines.length > 0 && lines.every(line => refreshTimeout.test(line)))
        return 'info';
    return /not inside a trusted directory|no such file|error/i.test(text) ? 'warn' : 'info';
}
const codexProvider = {
    name: 'codex',
    harnessDefaults: () => codexHarnessDefaults(),
    available: () => binaryAvailable(CODEX_BINARY),
    describeSandbox: sandboxPlan$2,
    listModels: (options) => listCodexModels(runCapture, options),
    spawn(spec) {
        const tx = createCodexTranslator(spec.maxOutputChars ?? 2000);
        return runNdjsonWorker({
            provider: 'codex',
            binary: CODEX_BINARY,
            spec,
            buildArgv: buildArgv$2,
            translate: tx.onEvent,
            // "Not inside a trusted directory..." is the single most useful line
            // codex emits and it is INFO-level, not an error — but it means the job
            // is dead. Level is about presentation, not job status.
            stderrLevel: codexStderrLevel,
            buildResult: (ctx) => buildResult$2({ ...ctx, tx }),
        });
    },
};/**
 * providers/kimi.ts — Kimi Code CLI adapter (`kimi -p`).
 *
 * ============================================================================
 * VERIFICATION LEVEL: HIGH. LIVE-VERIFIED ON 2.1.1 (fresh turn + resume),
 * SOURCE-VERIFIED FOR FLAGS AND STREAM-JSON.
 * ============================================================================
 *
 * The CLI surface and the stream-json schema below were read from the upstream
 * repository (MoonshotAI/kimi-code, main, 2026-10), then exercised against the
 * installed binary:
 *
 *   apps/kimi-code/src/cli/commands.ts        option definitions
 *   apps/kimi-code/src/cli/options.ts         prompt-mode conflicts
 *   apps/kimi-code/src/cli/prompt-render.ts   the stream-json writer
 *   apps/kimi-code/src/cli/v2/run-v2-print.ts print-mode runner
 *
 * LIVE TRANSCRIPT (2026-10-24, kimi 2.1.1):
 *   $ kimi --output-format stream-json -p 'Reply with exactly: OK'
 *   {"role":"assistant","content":"OK"}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_...",
 *    "command":"kimi -r session_...","content":"To resume this session: ..."}
 *   -> success, 7.9 s, response "OK", session id captured.
 *   A second run with `--session session_...` and the SAME cwd returned
 *   "RESUMED" in 6.2 s and kept the id.
 *   A third run asked for `printf hello > proof.txt` via Bash: one activity
 *   step carried tool "Bash" (input and output), the file existed afterwards,
 *   and the final response was "DONE" (6.8 s).
 *
 * RESUME REQUIRES THE ORIGINAL CWD. `kimi --session <id>` refuses a session
 * created under a different directory ("Session ... was created under a
 * different directory", exit 1). Agent Smith's resume_job defaults to the
 * original job's cwd, so the normal path works; overriding cwd to a different
 * directory fails loudly with that message. `--continue` is never used: it is
 * cwd-ambiguous and would let parallel workers collide.
 *
 * NO IN-FLIGHT TOOL DISPLAY. The writer buffers assistant text and tool calls
 * and flushes them when the step ends or the tool result arrives, so the band
 * learns about a tool call at completion, not while it runs. A long Bash call
 * is therefore a silent gap. This is a stream-json limitation, not a parser
 * choice.
 *
 * Still source-verified rather than live-exercised: retry meta and `--add-dir`.
 *
 * ----------------------------------------------------------------------------
 * VERIFIED CLI SURFACE
 * ----------------------------------------------------------------------------
 *   kimi -p <prompt> --output-format stream-json
 *     -p, --prompt <prompt>          run one prompt, non-interactively
 *     --output-format <format>       "text" (default) or "stream-json"
 *     -m, --model <model>            model ALIAS from config.toml [models]
 *     -S, --session [id]             resume an existing session by id
 *     -c, --continue                 continue the most recent session for cwd
 *     --add-dir <dir>                extra workspace dir; may be repeated
 *     -y, --yolo / --auto / --plan   interactive permission modes
 *
 * `--session` takes an OPTIONAL value, so the adapter emits the attached
 * `--session=<id>` form: with a space, an id beginning with "-" would be parsed
 * as another option. An id beginning with "-" is rejected before spawn too.
 *
 * CONFLICT: `-p` cannot be combined with `--yolo` (options.ts throws). `--auto`
 * is pointless here because print mode force-sets the auto policy anyway (see
 * below). `-c` is cwd-ambiguous: with several workers in one repository it can
 * resume another worker's session, so this adapter never emits it. Resume uses
 * `--session=<id>` only.
 *
 * ----------------------------------------------------------------------------
 * PERMISSIONS: PRINT MODE IS ALWAYS UNRESTRICTED
 * ----------------------------------------------------------------------------
 * run-v2-print.ts calls forceAuto(agent), which sets the session's permission
 * mode to "auto" before the turn. There is no flag to restrict print mode, no
 * approval prompt, and `--yolo` is rejected with `-p`. Static deny rules from
 * config.toml still apply, but Agent Smith cannot turn them on per run.
 *
 * Consequences, stated plainly:
 *   - `unrestricted` has no effect. spawn_job defaults it to true for kimi
 *     (forge/service.ts) and the ack's sandbox string reports the real posture.
 *   - `readOnly` is not enforceable. describeSandbox reports
 *     readOnlyEnforced:false so a review mode is never silently trusted.
 *   - A job cannot end "denied" from a policy prompt. A config deny rule shows
 *     up as tool output, not as a structured denial, so it is not reclassified;
 *     acceptance checks are the reliable detector for that case.
 *
 * ----------------------------------------------------------------------------
 * EFFORT: NO PER-RUN FLAG
 * ----------------------------------------------------------------------------
 * `kimi` has no --effort. Thinking effort comes from `[thinking].effort` or a
 * model alias's `default_effort` in config.toml. SpawnSpec.effort is therefore
 * ignored: forge/service.ts drops it before recording job.json and adds an ack
 * warning, and the adapter also emits a warning event for direct callers.
 * buildArgv never emits a flag the CLI does not have. listModels() reports
 * efforts:[] for the same reason: advertising efforts would invite a request we
 * cannot honor.
 *
 * ----------------------------------------------------------------------------
 * STREAM-JSON SCHEMA (from prompt-render.ts)
 * ----------------------------------------------------------------------------
 * One JSON object per stdout line, in this vocabulary:
 *
 *   {"role":"meta","type":"system.version","version":"..."}
 *   {"role":"assistant","content":"...","tool_calls":[
 *      {"type":"function","id":"...","function":{"name":"Bash","arguments":"{...}"}}]}
 *   {"role":"tool","tool_call_id":"...","content":"..."}
 *   {"role":"meta","type":"turn.step.retrying","failed_attempt":1,"next_attempt":2,
 *    "max_attempts":10,"delay_ms":...,"error_name":"...","error_message":"..."}
 *   {"role":"meta","type":"session.resume_hint","session_id":"...","command":"kimi -r ...","content":"..."}
 *
 * Assistant text and its tool calls are flushed TOGETHER when the step ends or
 * a tool result arrives. Tool results are a separate line keyed by
 * tool_call_id. Thinking deltas are NOT emitted in JSON mode. Token usage is
 * NOT emitted by this writer; the adapter leaves usage absent rather than
 * fabricating it. The final line carries the session id, which is the only
 * resume handle available: `started` is emitted when it arrives, late in the
 * run, and the job's JobResult.raw.sessionId records it too.
 *
 * TOOL ERRORS: PromptJsonWriter.writeToolResult receives ToolResultEvent.output
 * but drops the sibling `isError` field. The content may still be a JSON object
 * with an isError/status field, so the translator looks for one defensively;
 * otherwise it marks the activity done. A failed shell command is visible in
 * the output text, not in a status bit we were given.
 *
 * EXIT CODE: print mode exits non-zero on failure, but a clean exit is still
 * only corroboration. No assistant text after a zero exit is `malformed`, not
 * an empty success.
 */
const KIMI_BINARY = process.env['AGENT_SMITH_KIMI_BIN'] ?? 'kimi';
/** Kimi config dir: AGENT_SMITH_KIMI_HOME, then KIMI_CODE_HOME, then ~/.kimi-code. */
function kimiHome() {
    return configDir(['AGENT_SMITH_KIMI_HOME', 'KIMI_CODE_HOME'], '.kimi-code');
}
/**
 * The posture print mode actually applies, in one line for the spawn ack.
 * `spec` is accepted to match the Provider contract; there is nothing in it
 * this CLI can honor. See the header.
 */
function sandboxPlan$1(spec) {
    return {
        sandbox: 'kimi print mode: auto permission policy (no approval prompts; config deny rules still apply)',
        flags: [],
        readOnlyEnforced: false,
    };
}
/**
 * Build the exact argv for one Kimi worker.
 *
 * Flags first, prompt last. `-p` takes a value, so a prompt starting with "-"
 * is consumed as that value rather than parsed as an option.
 *
 * NOT EMITTED, deliberately:
 *   --effort    does not exist; effort lives in config.toml.
 *   --continue  cwd-ambiguous and unsafe with parallel workers.
 *   --yolo      rejected in prompt mode.
 *   --auto      redundant: print mode forces auto.
 */
function buildArgv$1(spec) {
    const argv = ['--output-format', 'stream-json'];
    if (spec.model !== undefined && spec.model !== '')
        argv.push('--model', spec.model);
    if (spec.conversation !== undefined && spec.conversation !== '') {
        // --session takes an OPTIONAL value, so `--session <id>` with an id starting
        // with "-" would be parsed as another option. The attached `=` form binds it
        // as a value; reject the remaining hostile shape rather than relying on the
        // CLI's own guard.
        if (spec.conversation.startsWith('-')) {
            throw new Error(`kimi session id must not start with "-": ${spec.conversation}`);
        }
        // A fresh run gets an id from the final resume_hint line; resume requires an
        // existing session, and the CLI refuses one from a different cwd.
        argv.push(`--session=${spec.conversation}`);
    }
    for (const dir of spec.addDirs ?? [])
        argv.push('--add-dir', dir);
    argv.push('-p', spec.prompt);
    return argv;
}
// ---------------------------------------------------------------------------
// Defensive extraction
// ---------------------------------------------------------------------------
/** Normalize an OpenAI-shaped usage object, if a future version emits one. */
function toTokenUsage$1(usage) {
    const pick = (...keys) => {
        for (const k of keys) {
            const v = num(usage, k);
            if (v !== undefined && v >= 0)
                return v;
        }
        return undefined;
    };
    const out = {};
    const input = pick('prompt_tokens', 'input_tokens', 'inputTokens', 'input');
    const output = pick('completion_tokens', 'output_tokens', 'outputTokens', 'output');
    const thinking = pick('reasoning_tokens', 'thinking_tokens', 'reasoningTokens');
    const cacheRead = pick('cached_tokens', 'cache_read_input_tokens', 'cacheReadTokens');
    const total = pick('total_tokens', 'totalTokens');
    if (input !== undefined)
        out.inputTokens = input;
    if (output !== undefined)
        out.outputTokens = output;
    if (thinking !== undefined)
        out.thinkingTokens = thinking;
    if (cacheRead !== undefined)
        out.cacheReadTokens = cacheRead;
    if (total !== undefined)
        out.totalTokens = total;
    return Object.keys(out).length > 0 ? out : undefined;
}
/**
 * Did a serialized tool result carry an explicit error marker?
 *
 * The stream writer drops ToolResultEvent.isError, but the `output` value is
 * passed through stringifyToolOutput(), so a structured result may still carry
 * its own flag. Only explicit fields count; prose containing the word "error"
 * is not evidence.
 */
function toolOutputIsError(content) {
    const parsed = tryParseObject(content);
    if (parsed === undefined)
        return false;
    if (parsed['isError'] === true || parsed['is_error'] === true)
        return true;
    const status = str(parsed, 'status');
    if (status !== undefined && status.toLowerCase() === 'error')
        return true;
    return parsed['error'] !== undefined && parsed['error'] !== null && parsed['error'] !== false;
}
/** Render a tool-result value as text without dropping a non-string payload. */
function contentText(value) {
    if (typeof value === 'string')
        return value;
    if (value === undefined)
        return '';
    try {
        const json = JSON.stringify(value);
        return json ?? String(value);
    }
    catch {
        return String(value);
    }
}
/**
 * Build the translator. Every line is handled by role because that is the
 * writer's actual discriminator; `type` is only read inside meta lines. A shape
 * this parser does not recognise becomes a notice with its payload preserved,
 * never a silent drop.
 */
function createKimiTranslator(maxChars) {
    const tx = {
        finalText: '',
        sawError: false,
        recovery: new ErrorRecovery(),
        completedTools: 0,
        unrecognised: new Set(),
        onEvent: () => [],
    };
    let step = 0;
    const toolSteps = new Map();
    const toolNames = new Map();
    const started = new Set();
    const ended = new Set();
    const stepFor = (id) => {
        const known = toolSteps.get(id);
        if (known !== undefined)
            return known;
        const idx = step++;
        toolSteps.set(id, idx);
        return idx;
    };
    const translate = (raw) => {
        const out = [];
        const at = nowIso();
        const role = str(raw, 'role');
        const type = str(raw, 'type') ?? '';
        // ---- session id: the resume handle arrives on the final meta line -------
        // It is accepted ONLY there. Any other line carrying a session_id is a
        // shape the writer does not produce; letting it overwrite the handle would
        // make a resume point at an id the CLI never issued.
        // ---- usage, if a future writer adds it --------------------------------
        const usage = toTokenUsage$1(obj(raw, 'usage') ?? obj(raw, 'tokens') ?? {});
        if (usage !== undefined) {
            tx.usage = usage;
            out.push({ kind: 'usage', at, usage });
        }
        // ---- meta lines -------------------------------------------------------
        if (role === 'meta') {
            if (type === 'system.version') {
                // Version banner. Known, carries nothing a consumer acts on.
                return out;
            }
            if (type === 'session.resume_hint') {
                const id = str(raw, 'session_id') ?? str(raw, 'sessionId');
                if (id === undefined || id === '') {
                    out.push({ kind: 'notice', at, level: 'warn', message: 'kimi resume hint without a session_id', raw });
                }
                else if (tx.sessionId === undefined) {
                    tx.sessionId = id;
                    out.push({ kind: 'started', at, conversationId: id, raw });
                }
                else if (tx.sessionId !== id) {
                    out.push({
                        kind: 'notice',
                        at,
                        level: 'warn',
                        message: `kimi resume hint changed the session id from ${tx.sessionId} to ${id}; keeping the first`,
                        raw,
                    });
                }
                return out;
            }
            if (type === 'turn.step.retrying') {
                const failed = num(raw, 'failed_attempt');
                const next = num(raw, 'next_attempt');
                const max = num(raw, 'max_attempts');
                const name = str(raw, 'error_name') ?? 'error';
                const message = str(raw, 'error_message') ?? '';
                const attempt = failed !== undefined && max !== undefined ? ` (attempt ${failed} of ${max})` : '';
                const retrying = next !== undefined ? `; retrying as ${next}` : '';
                // A retry that eventually succeeds is not a failed job, so this is a
                // warning, not sawError.
                out.push({ kind: 'notice', at, level: 'warn', message: `kimi ${name}${attempt}${retrying}: ${message}`.trim(), raw });
                return out;
            }
            if (type === 'error') {
                tx.sawError = true;
                tx.error = str(obj(raw, 'error'), 'message') ?? str(raw, 'message') ?? str(raw, 'error_message') ?? 'kimi error';
                tx.recovery.noteError('a worker error', tx.error, at);
                out.push({ kind: 'notice', at, level: 'error', message: tx.error, raw });
                return out;
            }
            const label = type === '' ? 'unknown' : type;
            tx.unrecognised.add(`meta:${label}`);
            out.push({
                kind: 'notice',
                at,
                level: 'info',
                message: `kimi emitted unrecognised meta line "${label}" (payload preserved in events.jsonl)`,
                raw,
            });
            return out;
        }
        // ---- assistant message: text plus the tool calls it invoked -----------
        if (role === 'assistant') {
            const content = str(raw, 'content');
            if (content !== undefined && content !== '') {
                if (tx.finalText !== '')
                    tx.finalText += '\n';
                tx.finalText += content;
                out.push({ kind: 'text', at, text: content, stream: 'assistant' });
            }
            const calls = raw['tool_calls'];
            if (calls !== undefined) {
                if (!Array.isArray(calls)) {
                    tx.unrecognised.add('assistant:tool_calls');
                    out.push({
                        kind: 'notice',
                        at,
                        level: 'warn',
                        message: 'kimi assistant tool_calls was not an array (payload preserved in events.jsonl)',
                        raw,
                    });
                }
                else {
                    for (const rawCall of calls) {
                        if (rawCall === null || typeof rawCall !== 'object' || Array.isArray(rawCall))
                            continue;
                        const call = rawCall;
                        const fn = obj(call, 'function');
                        const name = str(fn, 'name') ?? str(call, 'name') ?? 'tool';
                        const id = str(call, 'id') ?? str(call, 'tool_call_id') ?? `call-${step}`;
                        let args = fn?.['arguments'] ?? call['arguments'];
                        if (typeof args === 'string') {
                            try {
                                args = JSON.parse(args);
                            }
                            catch {
                                // Keep the raw string; preview() renders it without inventing structure.
                            }
                        }
                        const input = preview(args, maxChars);
                        const idx = stepFor(id);
                        toolNames.set(id, name);
                        if (!started.has(id)) {
                            started.add(id);
                            const ref = { stepIndex: idx, tool: name, toolCallId: id };
                            if (input !== undefined) {
                                ref.input = input.text;
                                if (input.truncated)
                                    ref.truncated = true;
                            }
                            out.push({ kind: 'activity-start', at, activity: ref });
                        }
                    }
                }
            }
            return out;
        }
        // ---- tool result: closes the matching call ----------------------------
        if (role === 'tool') {
            const id = str(raw, 'tool_call_id') ?? str(raw, 'id') ?? `tool-${step}`;
            if (ended.has(id)) {
                out.push({
                    kind: 'notice',
                    at,
                    level: 'info',
                    message: `kimi repeated tool result for "${id}" (ignored)`,
                    raw,
                });
                return out;
            }
            // The writer uses stringifyToolOutput(), but a future/hostile shape may
            // hand us an object. Coercing it keeps the payload and its error flag.
            const content = contentText(raw['content']);
            const output = truncate(content, maxChars);
            const status = toolOutputIsError(content) ? 'error' : 'done';
            const ref = {
                stepIndex: stepFor(id),
                tool: toolNames.get(id) ?? 'tool',
                toolCallId: id,
                output: output.text,
            };
            if (output.truncated)
                ref.truncated = true;
            // A result before its call must not be re-opened by the late call line.
            started.add(id);
            ended.add(id);
            tx.completedTools += 1;
            out.push({ kind: 'activity-end', at, activity: ref, status });
            return out;
        }
        // ---- top-level error shape (defensive; the current writer never emits) -
        if (type === 'error' || obj(raw, 'error') !== undefined) {
            tx.sawError = true;
            tx.error = str(obj(raw, 'error'), 'message') ?? str(raw, 'message') ?? 'kimi error';
            tx.recovery.noteError('a worker error', tx.error, at);
            out.push({ kind: 'notice', at, level: 'error', message: tx.error, raw });
            return out;
        }
        // ---- fallthrough: never drop data -------------------------------------
        const label = role ?? (type !== '' ? type : 'unknown');
        const key = role === undefined ? `type:${label}` : `role:${label}`;
        tx.unrecognised.add(key);
        out.push({
            kind: 'notice',
            at,
            level: 'info',
            message: `kimi emitted unrecognised line "${label}" (payload preserved in events.jsonl)`,
            raw,
        });
        return out;
    };
    tx.onEvent = (raw) => {
        const out = translate(raw);
        tx.recovery.observe(out);
        return out;
    };
    return tx;
}
// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
function buildResult$1(args) {
    const { jobId, startedAtMs, stateDir, exit, tx } = args;
    const durationMs = Date.now() - startedAtMs;
    const unrecognised = tx.unrecognised.size > 0
        ? ` · unrecognised lines: ${[...tx.unrecognised].join(', ')}`
        : '';
    let status;
    let error;
    // No verified terminal event exists in this stream: recovery needs a clean exit.
    const recovered = tx.recovery.recovered(tx.finalText, exit.code);
    const early = earlyVerdict(exit, durationMs);
    if (early !== undefined) {
        ({ status, error } = early);
    }
    else if (tx.sawError && recovered === undefined) {
        status = 'error';
        error = `${tx.error ?? 'worker error'}${unrecognised}${stderrClause(exit.stderr)}`;
    }
    else if (exit.code !== 0 && recovered === undefined) {
        status = 'error';
        error = exit.code === null
            ? `${noResultText({ code: exit.code, signal: exit.signal, stderr: '' })}${unrecognised}${stderrClause(exit.stderr)}`
            : `exited ${exit.code}${unrecognised}${stderrClause(exit.stderr)}`;
    }
    else if (tx.finalText.trim() === '') {
        // Zero exit and no assistant text. With a source-verified parser this is
        // more likely an account/network failure or a silent policy denial than an
        // empty model reply, and neither is a success. A completed tool step is
        // still worth naming, because it explains where the turn went.
        const tools = tx.completedTools > 0 ? ` · ${tx.completedTools} tool step(s) completed` : '';
        status = 'malformed';
        error = `no output${unrecognised}${tools}${stderrClause(exit.stderr)}`;
    }
    else {
        status = 'success';
    }
    const out = jobResult({ provider: 'kimi', jobId, status, error, exit, response: tx.finalText, startedAtMs, durationMs, stateDir });
    if (tx.usage !== undefined)
        out.usage = tx.usage;
    const raw = {};
    if (tx.sessionId !== undefined)
        raw['sessionId'] = tx.sessionId;
    if (tx.unrecognised.size > 0)
        raw['unrecognisedLines'] = [...tx.unrecognised];
    if (Object.keys(raw).length > 0)
        out.raw = raw;
    return out;
}
// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------
/**
 * Parse `kimi provider list --json`.
 *
 * Shape (sub/provider.ts + config-manifest.toml):
 *   { providers: { <id>: {...} }, models: { <alias>: {
 *       provider, model, display_name?, support_efforts?, default_effort?, overrides? } } }
 *
 * The key is the alias `-m` accepts. Live 2.1.1 output uses camelCase keys
 * (`supportEfforts`, `defaultEffort`, `displayName`) even though config.toml is
 * snake_case, so both spellings are accepted. `overrides` wins over the
 * top-level field, matching the CLI's own precedence. Efforts are reported as
 * [] because print mode has no per-run effort flag; see the header.
 */
function parseKimiModels(stdout) {
    let parsed;
    try {
        parsed = JSON.parse(stdout);
    }
    catch {
        return undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        return undefined;
    const models = parsed.models;
    if (models === null || typeof models !== 'object' || Array.isArray(models))
        return undefined;
    const out = [];
    for (const [alias, raw] of Object.entries(models)) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
            continue;
        const entry = raw;
        const overrides = obj(entry, 'overrides') ?? {};
        const label = str(overrides, 'display_name') ??
            str(overrides, 'displayName') ??
            str(entry, 'display_name') ??
            str(entry, 'displayName') ??
            str(entry, 'model') ??
            alias;
        out.push({ id: alias, label, efforts: [] });
    }
    return out;
}
/** Lazy, never throws. Live-verified on 2.1.1. */
async function listKimiModels(run, options, home = kimiHome()) {
    const cat = {
        provider: 'kimi',
        models: [],
        defaultSource: 'unknown',
        source: 'live',
        stale: false,
        verified: true,
    };
    try {
        const r = await run(KIMI_BINARY, ['provider', 'list', '--json'], options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
        const models = r.error === undefined ? parseKimiModels(r.stdout) : undefined;
        if (models !== undefined && models.length > 0)
            cat.models = models;
        else
            cat.error = r.error ?? '`kimi provider list --json` returned no models';
        // The top-level default_model is not part of `provider list --json`; it is
        // read from the same config file the CLI reads.
        const { model } = kimiHarnessDefaults(home);
        if (model !== undefined) {
            cat.defaultModel = model;
            cat.defaultSource = 'harness-config';
        }
    }
    catch (e) {
        cat.error = errMessage(e);
    }
    return cat;
}
/** Default model from <home>/config.toml top-level `default_model`. Sync, no CLI, never throws. */
function kimiHarnessDefaults(home = kimiHome()) {
    const text = readTextSafe(path.join(home, 'config.toml'));
    if (text === undefined)
        return {};
    const model = parseTomlTopLevel(text)['default_model'];
    return model !== undefined && model !== '' ? { model } : {};
}
// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
const kimiProvider = {
    name: 'kimi',
    // Print mode has no --effort; effort lives in config.toml. The service must
    // not record a request it cannot apply.
    supportsEffort: false,
    harnessDefaults: () => kimiHarnessDefaults(),
    available: () => binaryAvailable(KIMI_BINARY),
    describeSandbox: sandboxPlan$1,
    listModels: (options) => listKimiModels(runCapture, options),
    spawn(spec) {
        const tx = createKimiTranslator(spec.maxOutputChars ?? 2000);
        return runNdjsonWorker({
            provider: 'kimi',
            binary: KIMI_BINARY,
            spec,
            buildArgv: buildArgv$1,
            translate: tx.onEvent,
            // Do not silently pretend the effort was applied. The CLI reads effort
            // from config.toml, not from a flag.
            ...(spec.effort !== undefined && spec.effort !== '' ? { preamble: [{
                        kind: 'notice',
                        at: nowIso(),
                        level: 'warn',
                        message: `kimi has no per-run effort flag; ignoring effort "${spec.effort}". ` +
                            'Set [thinking].effort or a model alias default_effort in config.toml instead.',
                    }] } : {}),
            buildResult: (ctx) => buildResult$1({ ...ctx, tx }),
            afterResult(final) {
                const notice = recoveredErrorNotice(tx.recovery.recovered(tx.finalText, final.exitCode), final);
                return notice === undefined ? [] : [notice];
            },
        });
    },
};/**
 * providers/opencode.ts — OpenCode CLI adapter (`opencode run`).
 *
 * ============================================================================
 * VERIFICATION LEVEL: PARTIAL. READ THIS BEFORE TRUSTING THE EVENT PARSER.
 * ============================================================================
 *
 * VERIFIED (by running `opencode run --help` on v2.0.24 and by executing the
 * command twice on this machine):
 *
 *   opencode run [flags] [<message...>]
 *     --format choice     "Output format (choices: default, json)"  -> json
 *     --model, -m string  "Model to use in the format provider/model#variant"
 *     --agent string      "Agent to use"
 *     --auto              "Auto-approve permissions that are not explicitly denied"
 *     --session, -s       "Session ID to continue, or to create if it does not exist"
 *     --continue, -c      "Continue the last session"
 *     --fork              "Fork the session before continuing"
 *     --thinking          "Show thinking blocks"
 *     --standalone        "Run with a private server instead of the background service"
 *     --dir <path>        directory to run in  (docs; NOT in --help output)
 *     --variant <string>  provider-specific reasoning effort (docs; NOT in --help)
 *
 * AND one event shape, observed live:
 *   {"type":"error","timestamp":1791335768123,"sessionID":"ses_eec11658...",
 *    "error":{"type":"provider.quota","message":"Upstream request failed:
 *              Insufficient account funds","status":402,"response":{"body":"..."}}}
 *
 * ============================================================================
 * WHAT I COULD NOT VERIFY, AND WHAT I DID ABOUT IT
 * ============================================================================
 * I could not observe a SUCCESSFUL opencode run. Both attempts failed at the
 * provider layer with `provider.quota` (HTTP 402, "Insufficient account funds")
 * and `provider.no-route` ("Model unavailable"). That is an account problem, not
 * a flag problem: the flags above came from --help and the envelope shape above
 * came from real output. But it means:
 *
 *   *** The success-path event names below are UNVERIFIED. ***
 *
 * OpenCode's documented SSE event vocabulary (from opencode.ai/docs/server,
 * "Events") is namespaced, e.g. `message.part.updated`, `session.idle`,
 * `session.error`, `message.updated`. That is the SERVER bus, and `run
 * --format json` is documented only as "raw JSON events" — it very likely
 * emits the same bus events, but "very likely" is not verification.
 *
 * THEREFORE THE STRATEGY FOR THIS ADAPTER IS DEFENSIVE PARSING, NOT PRECISE
 * PARSING. Concretely:
 *
 *   1. Every line is emitted as a `notice` with its raw payload, so NOTHING is
 *      ever invisible. If the parser misses a shape, the operator still sees the
 *      data and the mod surface still has something to draw. This is the whole
 *      design: an adapter that silently drops events is worse than one that
 *      forwards everything.
 *   2. Text, tool calls and usage are extracted by CONTENT, not by event name:
 *      we look for a `text`/`content`/`delta` string anywhere in the payload, a
 *      `tool`/`toolName` string plus a state field, and a `tokens`/`usage`
 *      object. That works across plausible namings.
 *   3. Unknown event types get an explicit "unrecognised event type" notice
 *      naming the type, so the first run against a real account tells us exactly
 *      what to add. That is a feature, not an apology.
 *   4. We never guess SUCCESS. The final response is taken from whatever text
 *      the stream produced; if the stream ended with an `error` event or the
 *      exit code is non-zero without explicit recovery completion, the job fails.
 *      Exit code alone is never enough to call it a success, as with agy.
 *
 * ALSO NOTE, and this is a real trap for anyone spawning this: `opencode run`
 * talks to a BACKGROUND SERVER by default. That means (a) it may pick up an
 * unrelated session's state, and (b) the process you spawn is not the process
 * doing the work. We pass `--standalone` so the run gets a private server and
 * the child's lifetime really is the job's lifetime — otherwise a cancel() does
 * nothing and a "finished" worker leaves a server running. `--standalone` is
 * documented but I could not confirm its runtime behaviour without a working
 * account; flagged in the README.
 *
 * MODEL IDs: `--model` takes `provider/model` and optionally `provider/model#variant`
 * ("variant (provider-specific reasoning effort)"). We do not guess how to
 * encode SpawnSpec.effort as a variant, so we pass it through verbatim when it
 * looks like a variant and otherwise append `#<effort>` only if the caller gave
 * an effort AND no `#` is already present. See buildArgv.
 */
const OPENCODE_BINARY = process.env['AGENT_SMITH_OPENCODE_BIN'] ?? 'opencode';
/** Sandbox flags for opencode. Shared by buildArgv and describeSandbox. */
function sandboxPlan(spec) {
    if (spec.unrestricted) {
        return { sandbox: 'opencode --auto (approve all non-denied permissions)', flags: ['--auto'], readOnlyEnforced: false };
    }
    return {
        sandbox: "opencode default permissions (agent's configured rules; no CLI flag to restrict or enforce read-only)",
        flags: [],
        readOnlyEnforced: false,
    };
}
/**
 * Build the exact argv for one opencode worker.
 *
 * The message is a TRAILING POSITIONAL (`opencode run [flags] [<message>]`), so
 * a prompt starting with "-" is safe. `--` is not used because --help does not
 * document it for this subcommand and we do not invent flags.
 *
 * KNOWN GAP: there is no verified way to set opencode's sandbox from the CLI.
 * `--auto` approves "permissions that are not explicitly denied", which is the
 * documented auto-approve mechanism and our mapping for unrestricted:true. For
 * unrestricted:false we simply OMIT --auto and rely on the agent's configured
 * permissions, because the CLI gives us no flag to turn auto-approval off and
 * inventing one would be worse than being permissive by default here. The
 * README flags this as a real asymmetry with agy/codex/claude.
 */
function buildArgv(spec) {
    const argv = ['run'];
    // Private server so the child's lifetime is the job's lifetime.
    argv.push('--standalone');
    // Verified choice: "default" (formatted for humans) or "json" (raw events).
    argv.push('--format', 'json');
    if (spec.model !== undefined && spec.model !== '') {
        argv.push('--model', withEffortVariant(spec.model, spec.effort));
    }
    else if (spec.effort !== undefined && spec.effort !== '') {
        throw new Error('opencode effort requires an explicit provider/model so its variant can be applied');
    }
    argv.push(...sandboxPlan(spec).flags);
    // --session both continues an existing session and creates it if absent,
    // which is exactly the semantics SpawnSpec.conversation needs.
    if (spec.conversation !== undefined && spec.conversation !== '') {
        argv.push('--session', spec.conversation);
    }
    // addDirs: DELIBERATELY IGNORED.
    //
    // The v2 docs list a `--dir` flag, but it is NOT in `opencode run --help` on
    // v2.0.26, and passing it makes the CLI print usage and exit non-zero — a
    // guaranteed spawn failure for any job that set addDirs. Verified 2026-10-09.
    // Emitting a flag that the binary rejects is strictly worse than not emitting
    // it, so we drop the request rather than pretending the directories were
    // widened. `run` has no sandbox to widen anyway: it works from the cwd we
    // spawn it in, which spawnWorker already sets to spec.cwd. callers should treat
    // opencode as having no addDirs support rather than assume otherwise.
    // Trailing positional message, last.
    argv.push(spec.prompt);
    return argv;
}
/**
 * Attach a reasoning effort to an opencode model id as `#variant`.
 *
 * WHY SO CAREFUL: `--model` is documented as `provider/model#variant`, so a
 * caller who already wrote the variant in (`anthropic/claude-x#high`) must not
 * get a second `#`. And an effort with no model is meaningless, so we refuse it
 * rather than emit `--effort`, which does not exist as a flag.
 *
 * UNVERIFIED: that opencode accepts an arbitrary variant string, and which
 * variant names are legal per provider. If the CLI rejects one, the job fails
 * with a clear error and no side effects — acceptable for a flag we cannot test.
 */
function withEffortVariant(model, effort) {
    if (effort === undefined || effort === '')
        return model;
    if (model.includes('#'))
        return model; // caller already encoded it
    return `${model}#${effort}`;
}
// ---------------------------------------------------------------------------
// Defensive extraction
// ---------------------------------------------------------------------------
/**
 * Find the first string value under any of `keys`, at the top level or one
 * level down inside `part` / `message` / `properties` / `data`.
 *
 * WHY DEPTH-ONE RECURSION: opencode's part payloads nest the useful fields
 * under `properties` (per its server docs, Part objects carry a `properties`
 * bag). Without this, the text extraction silently returns nothing and the
 * mod surface shows an empty job.
 */
function deepString(o, keys) {
    for (const k of keys) {
        const v = str(o, k);
        if (v !== undefined && v !== '')
            return v;
    }
    for (const nest of ['part', 'message', 'properties', 'data', 'info']) {
        const inner = obj(o, nest);
        if (inner === undefined)
            continue;
        for (const k of keys) {
            const v = str(inner, k);
            if (v !== undefined && v !== '')
                return v;
        }
    }
    return undefined;
}
/** Locate a `tokens`/`usage` object anywhere one or two levels down. */
function findUsage(o) {
    const direct = obj(o, 'usage') ?? obj(o, 'tokens');
    if (direct !== undefined)
        return direct;
    for (const nest of ['part', 'properties', 'info', 'message', 'data']) {
        const inner = obj(o, nest);
        if (inner === undefined)
            continue;
        const u = obj(inner, 'usage') ?? obj(inner, 'tokens');
        if (u !== undefined)
            return u;
        // Bus events nest the part one level further: { properties: { part: … } }.
        const part = obj(inner, 'part');
        if (part === undefined)
            continue;
        const deep = obj(part, 'usage') ?? obj(part, 'tokens');
        if (deep !== undefined)
            return deep;
    }
    return undefined;
}
/**
 * Normalize opencode's token counters.
 *
 * UNVERIFIED field names. opencode is models.dev-driven and its counters are
 * likely to mirror Vercel AI SDK naming (promptTokens / completionTokens /
 * cachedInputTokens) rather than snake_case, while `step_finish` parts observed
 * in the wild use SHORT keys (`input`, `output`, `reasoning`, `cache.read`).
 * We accept every spelling and leave anything we do not recognise undefined. We
 * never invent a total.
 */
function toTokenUsage(usage) {
    if (usage === undefined)
        return undefined;
    const pick = (...keys) => {
        for (const k of keys) {
            const v = num(usage, k);
            if (v !== undefined)
                return v;
        }
        return undefined;
    };
    const out = {};
    const input = pick('input_tokens', 'inputTokens', 'promptTokens', 'prompt_tokens', 'input');
    const output = pick('output_tokens', 'outputTokens', 'completionTokens', 'completion_tokens', 'output');
    const thinking = pick('reasoning_tokens', 'thinking_tokens', 'reasoningTokens', 'reasoning');
    const cacheRead = pick('cache_read_tokens', 'cacheReadTokens', 'cachedInputTokens') ?? num(obj(usage, 'cache'), 'read');
    const cacheWrite = pick('cache_write_tokens', 'cacheWriteTokens') ?? num(obj(usage, 'cache'), 'write');
    const total = pick('total_tokens', 'totalTokens');
    if (input !== undefined)
        out.inputTokens = input;
    if (output !== undefined)
        out.outputTokens = output;
    if (thinking !== undefined)
        out.thinkingTokens = thinking;
    if (cacheRead !== undefined)
        out.cacheReadTokens = cacheRead;
    if (cacheWrite !== undefined)
        out.cacheWriteTokens = cacheWrite;
    if (total !== undefined)
        out.totalTokens = total;
    return Object.keys(out).length > 0 ? out : undefined;
}
/**
 * `step_finish` reports ONE step's counters; a job has many steps. Sum them so
 * the caller sees the job's usage rather than only the last step's.
 */
function addUsage(previous, next) {
    if (previous === undefined)
        return { ...next };
    const out = { ...previous };
    const add = (key) => {
        const a = previous[key];
        const b = next[key];
        if (a === undefined && b === undefined)
            return;
        out[key] = (a ?? 0) + (b ?? 0);
    };
    add('inputTokens');
    add('outputTokens');
    add('thinkingTokens');
    add('cacheReadTokens');
    add('cacheWriteTokens');
    add('totalTokens');
    return out;
}
/** Terminal-state words we might see on a tool part. */
const DONE_WORDS = new Set(['completed', 'complete', 'done', 'success', 'succeeded', 'finished']);
const ERROR_WORDS = new Set(['error', 'failed', 'failure', 'cancelled', 'canceled', 'aborted']);
/** Failed tool calls that each get their own warning notice; the rest are only counted. */
const TOOL_ERROR_NOTICES = 5;
/** OpenCode's error type for a dropped or reset connection to the provider. */
const TRANSPORT_ERROR_TYPE = 'provider.transport';
/**
 * Build the translator.
 *
 * The contract with the caller is deliberately weak: emit a text event for
 * anything textual, an activity for anything tool-shaped, a usage event for any
 * token counters, a notice for EVERYTHING ELSE, and never throw on a shape we
 * did not anticipate. Verified failure modes already handled: `error` events
 * (observed live) and totally unknown types (spec'd above).
 */
function createOpencodeTranslator(maxChars) {
    const tx = {
        finalText: '',
        sawTerminal: false,
        sawError: false,
        toolErrors: 0,
        unrecognised: new Set(),
        deniedNotices: [],
        recovery: new ErrorRecovery(),
        onEvent: () => [],
    };
    let step = 0;
    /** partID -> stepIndex */
    const partStep = new Map();
    const translate = (raw) => {
        const out = [];
        const at = nowIso();
        const type = str(raw, 'type') ?? 'unknown';
        const sessionId = str(raw, 'sessionID') ?? str(raw, 'session_id');
        if (sessionId !== undefined) {
            if (tx.sessionId === undefined) {
                out.push({ kind: 'started', at, conversationId: sessionId, raw });
            }
            tx.sessionId = sessionId;
        }
        // ---- errors: the one shape we verified live -----------------------------
        if (type === 'error') {
            tx.sawError = true;
            const e = obj(raw, 'error');
            const data = obj(e ?? {}, 'data');
            const message = str(e, 'message') ?? str(data, 'message') ?? str(raw, 'message') ?? 'opencode error';
            const statusCode = data?.['statusCode'];
            tx.error = typeof statusCode === 'number' ? `HTTP ${statusCode}: ${message}` : message;
            const errorType = str(e, 'type');
            // Quota / no-route failures are the two I actually hit. They are
            // environment failures (no money, no route) rather than the worker doing
            // something wrong, so we label them distinctly: the operator's fix is
            // billing or config, not a better prompt.
            // A dropped connection is different: OpenCode retries it and may finish
            // the work, so while the worker runs it is a warning, not a failure.
            // buildResult decides (ErrorRecovery) whether the job survived it.
            const isTransport = errorType === TRANSPORT_ERROR_TYPE;
            const isEnv = !isTransport && errorType !== undefined && (errorType.startsWith('provider.') || errorType.startsWith('auth.'));
            tx.recovery.noteError(isTransport ? 'a provider connection error' : 'a worker error', message, at);
            out.push({
                kind: 'notice',
                at,
                level: isTransport ? 'warn' : 'error',
                message: isTransport
                    ? `provider connection error (retrying): ${message}`
                    : isEnv ? `environment failure — ${errorType}: ${message}` : message,
                raw,
            });
            return out;
        }
        // ---- part location ------------------------------------------------------
        // `run --format json` emits `part` at the top level; the server bus nests it
        // under `properties`. Both carry the same Part object, so find it once.
        const part = obj(raw, 'part') ?? obj(obj(raw, 'properties') ?? {}, 'part');
        const partState = obj(part ?? {}, 'state') ?? obj(raw, 'state');
        const partType = str(part, 'type') ?? '';
        const isStepStart = type === 'step_start' || type === 'step-start' || partType === 'step-start';
        const isStepFinish = type === 'step_finish' || type === 'step-finish' || partType === 'step-finish';
        // ---- usage, wherever it hides -------------------------------------------
        // A `step_finish` reports only its own step's counters, so accumulate them.
        // Other carriers (message.updated) report a running total, so replace.
        const usage = toTokenUsage(findUsage(raw));
        if (usage !== undefined) {
            let merged;
            if (isStepFinish)
                merged = addUsage(tx.usage, usage);
            // A step's opening counters must not clobber what previous steps added.
            else if (isStepStart)
                merged = tx.usage ?? usage;
            else
                merged = usage;
            tx.usage = merged;
            out.push({ kind: 'usage', at, usage: merged });
        }
        // ---- tool-shaped parts --------------------------------------------------
        // Detection is by content: a `tool`/`toolName` string plus a state word, or a
        // tool-shaped `part`. `part.state` is an OBJECT, so its state word has to be
        // read off it — a plain string search never sees it.
        const isToolType = type.includes('tool') || partType === 'tool' || partType === 'tool_use';
        const toolName = str(part, 'tool') ??
            str(part, 'toolName') ??
            deepString(raw, ['tool', 'toolName', 'tool_name', 'name']);
        const stateWord = (str(partState, 'status') ??
            str(partState, 'state') ??
            deepString(raw, ['state', 'status']) ??
            '').toLowerCase();
        // Prefer the CALL id over the part id: the part id can differ between a
        // streaming update and the completed record for the same call, and splitting
        // those into two steps double-counts the tool.
        const partId = str(part, 'callID') ??
            str(part, 'callId') ??
            str(partState, 'callID') ??
            str(partState, 'callId') ??
            deepString(raw, ['callID', 'callId', 'id', 'partID', 'partId']) ??
            `anon-${step}`;
        if (toolName !== undefined && (stateWord !== '' || isToolType)) {
            const isDone = DONE_WORDS.has(stateWord) || type.endsWith('.completed') || type.endsWith('.done');
            const isErr = ERROR_WORDS.has(stateWord) || type.endsWith('.error');
            const errorTexts = [
                str(partState, 'error'),
                str(obj(partState, 'error'), 'message'),
                deepString(raw, ['error', 'message']),
                deepString(raw, ['error']),
            ];
            const denied = errorTexts.some((t) => t !== undefined && (t.toLowerCase().includes('denied') || t.toLowerCase().includes('permission')));
            const inputValue = partState?.['input'] ??
                part?.['input'] ??
                obj(raw, 'properties')?.['input'] ??
                raw['input'] ??
                raw['arguments'];
            const input = preview(inputValue, maxChars);
            // An error-state part often reports its only detail under `state.error`,
            // sometimes as a string and sometimes as `{ message }`.
            const stateError = partState?.['error'];
            const stateErrorText = typeof stateError === 'string' ? stateError : str(obj(partState, 'error'), 'message');
            const outputValue = partState?.['output'] ?? stateErrorText ?? part?.['output'] ?? raw['output'] ?? raw['result'];
            const output = preview(outputValue, maxChars);
            if (!partStep.has(partId)) {
                const idx = step++;
                partStep.set(partId, idx);
                const ref = { stepIndex: idx, tool: toolName, toolCallId: partId };
                if (input !== undefined)
                    ref.input = input.text;
                if (input?.truncated === true)
                    ref.truncated = true;
                if (denied)
                    ref.denied = true;
                out.push({ kind: 'activity-start', at, activity: ref });
            }
            if (isDone || isErr) {
                const idx = partStep.get(partId) ?? step++;
                partStep.set(partId, idx);
                let status = isErr ? 'error' : 'done';
                if (denied)
                    status = 'denied';
                const ref = { stepIndex: idx, tool: toolName, toolCallId: partId };
                if (input !== undefined)
                    ref.input = input.text;
                if (output !== undefined) {
                    ref.output = output.text;
                    if (output.truncated)
                        ref.truncated = true;
                }
                if (denied)
                    ref.denied = true;
                out.push({ kind: 'activity-end', at, activity: ref, status });
                if (denied)
                    tx.deniedNotices.push(toolName);
                else if (isErr) {
                    // A failed tool call (a `read` of a missing path) is evidence, not a
                    // verdict: the agent usually recovers and still delivers its report.
                    // Only `error` / `session.error`, a nonzero exit or an empty report fail the job.
                    tx.toolErrors += 1;
                    const detail = (stateErrorText ?? output?.text ?? '').split('\n')[0].slice(0, 160);
                    // The count is the evidence; past a few, per-call warnings only bury real ones.
                    if (tx.toolErrors <= TOOL_ERROR_NOTICES)
                        out.push({
                            kind: 'notice',
                            at,
                            level: 'warn',
                            message: `opencode tool ${toolName} failed (step ${idx})${detail === '' ? '' : `: ${detail}`}`,
                        });
                }
            }
            else {
                // In-flight: emit an update so a long tool call is not a silent gap.
                const idx = partStep.get(partId) ?? 0;
                const ref = { stepIndex: idx, tool: toolName, toolCallId: partId };
                if (input !== undefined)
                    ref.input = input.text;
                if (output !== undefined)
                    ref.output = output.text;
                out.push({ kind: 'activity-update', at, activity: ref });
            }
            return out;
        }
        // ---- text ---------------------------------------------------------------
        const text = deepString(raw, ['text', 'content', 'delta', 'textDelta']);
        const isThinking = type.includes('thinking') || type.includes('reasoning');
        if (text !== undefined && text !== '') {
            if (!isThinking) {
                if (tx.finalText !== '')
                    tx.finalText += '\n';
                tx.finalText += text;
            }
            out.push({ kind: 'text', at, text, stream: isThinking ? 'thinking' : 'assistant' });
            // A text event is also our best evidence the run is producing output, so
            // it doubles as a terminal marker candidate below.
            return out;
        }
        // ---- step boundaries ----------------------------------------------------
        // One per assistant step. Their counters were handled above and there is
        // nothing else a reader needs per step, so they are silent: one info notice
        // per step would bury real warnings under hundreds of lines of noise.
        if (isStepStart || isStepFinish) {
            // Verified in the installed OpenCode CLI: session.step.ended emits
            // step_finish with part.reason = data.finish. Tool-call/length finishes
            // end only a step; "stop" confirms the assistant finished normally.
            if (isStepFinish && str(part, 'reason') === 'stop')
                tx.recovery.noteCompletion();
            else
                tx.recovery.invalidateCompletion();
            return out;
        }
        // ---- session lifecycle --------------------------------------------------
        // Documented bus names (opencode.ai/docs/server "Events"), UNVERIFIED for
        // `run --format json`. Treated as terminal only for the unambiguous ones.
        if (type === 'session.idle' || type === 'session.idle.completed' || type === 'session.completed') {
            tx.sawTerminal = true;
            tx.recovery.noteCompletion();
            out.push({ kind: 'notice', at, level: 'info', message: `opencode ${type}`, raw });
            return out;
        }
        if (type === 'session.error') {
            tx.sawError = true;
            tx.error = str(obj(raw, 'error'), 'message') ?? str(raw, 'message') ?? 'opencode session.error';
            tx.recovery.noteError('a worker error', tx.error, at);
            out.push({ kind: 'notice', at, level: 'error', message: tx.error, raw });
            return out;
        }
        // ---- fallthrough: never drop data ---------------------------------------
        if (type === 'unknown' || !KNOWN_TYPES.has(type)) {
            tx.unrecognised.add(type);
            out.push({
                kind: 'notice',
                at,
                level: 'info',
                message: `opencode emitted unrecognised event type "${type}" (payload preserved in events.jsonl)`,
                raw,
            });
            return out;
        }
        out.push({ kind: 'notice', at, level: 'info', message: `opencode ${type}`, raw });
        return out;
    };
    tx.onEvent = (raw) => {
        const out = translate(raw);
        tx.recovery.observe(out);
        return out;
    };
    return tx;
}
/**
 * The event types we have a behaviour for. Anything outside this set gets the
 * "unrecognised" notice. Kept as a set (rather than a switch with a default) so
 * adding a handled type is a one-line, reviewable change.
 */
const KNOWN_TYPES = new Set([
    'error',
    'step_start',
    'step-start',
    'step_finish',
    'step-finish',
    'session.idle',
    'session.idle.completed',
    'session.completed',
    'session.error',
    'session.updated',
    'message.updated',
    'message.part.updated',
    'message.part.completed',
    'message.completed',
    'tool.started',
    'tool.completed',
    'tool.error',
    'text',
    'unknown',
]);
// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
function buildResult(args) {
    const { jobId, startedAtMs, stateDir, exit, tx } = args;
    const durationMs = Date.now() - startedAtMs;
    let status;
    let error;
    // Event types the parser did not know: the clue when a run looks empty or broken.
    const unrecognised = tx.unrecognised.size > 0 ? ` · unrecognised events: ${[...tx.unrecognised].join(', ')}` : '';
    const toolErrors = tx.toolErrors > 0 ? ` · ${tx.toolErrors} tool error(s)` : '';
    // An error the worker got past: more work and a final report followed it. A
    // signal kill is no evidence of completion, so it needs a real exit code.
    const recovered = tx.recovery.recovered(tx.finalText, exit.code);
    const early = earlyVerdict(exit, durationMs);
    if (early !== undefined) {
        ({ status, error } = early);
    }
    else if (tx.sawError && recovered === undefined) {
        // An `error` or `session.error` event (never a failed tool call: see
        // toolErrors). opencode's provider.quota 402 exits 1 with an error event
        // and no text, so this is the common path for a misconfigured account.
        status = 'error';
        error = `${tx.error ?? 'worker error'}${unrecognised}${stderrClause(exit.stderr)}`;
    }
    else if (tx.deniedNotices.length > 0) {
        // Same reasoning as agy: a denied tool means the work did not happen, and
        // opencode may well exit 0. Do not report that as a success.
        status = 'denied';
        error = deniedText(tx.deniedNotices, '');
    }
    else if (exit.code !== 0 && recovered === undefined) {
        status = 'error';
        error = `exited ${exit.code}${unrecognised}${toolErrors}${stderrClause(exit.stderr)}`;
    }
    else if (tx.finalText.trim() === '') {
        // Exited 0 with no text and no error event. Do not call that a success.
        // Be honest about why: with an unverified parser this is the shape most
        // likely to mean "we did not understand the output", not "the model said
        // nothing", and the two demand different fixes.
        // Most likely an event-shape gap in the adapter, not an empty model reply:
        // check events.jsonl and extend the parser.
        status = 'malformed';
        error = `no output${unrecognised}${toolErrors}${stderrClause(exit.stderr)}`;
    }
    else {
        status = 'success';
    }
    const out = jobResult({ provider: 'opencode', jobId, status, error, exit, response: tx.finalText, startedAtMs, durationMs, stateDir });
    if (tx.usage !== undefined)
        out.usage = tx.usage;
    if (tx.unrecognised.size > 0)
        out.raw = { unrecognisedEventTypes: [...tx.unrecognised] };
    if (tx.sessionId !== undefined) {
        out.raw = { ...(out.raw ?? {}), sessionId: tx.sessionId };
    }
    return out;
}
// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
/** Parse `opencode models` lines (`provider/model`, optionally `#variant` is not expected). */
function parseOpencodeModels(stdout) {
    const seen = new Set();
    const out = [];
    for (const raw of stdout.split(/\r?\n/)) {
        const id = raw.trim().split(/\s+/)[0] ?? '';
        // Accept only provider/model-looking tokens; skip banners and noise.
        if (!/^[A-Za-z0-9_.-]+\/[^\s]+$/.test(id) || seen.has(id))
            continue;
        seen.add(id);
        out.push({ id, label: id, efforts: [] });
    }
    return out;
}
/** Lazy, never throws. verified:false — the output format is unconfirmed. */
async function listOpencodeModels(run, options) {
    const base = {
        provider: 'opencode',
        models: [],
        defaultSource: 'unknown',
        source: 'live',
        stale: false,
        verified: false,
    };
    try {
        const r = await run(OPENCODE_BINARY, ['models'], options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
        const models = parseOpencodeModels(r.stdout);
        if (models.length > 0)
            return { ...base, models };
        return {
            ...base,
            error: r.error ?? '`opencode models` printed no recognizable models (output format unverified; pass an explicit provider/model)',
        };
    }
    catch (e) {
        return { ...base, error: errMessage(e) };
    }
}
const opencodeProvider = {
    name: 'opencode',
    available: () => binaryAvailable(OPENCODE_BINARY),
    describeSandbox: sandboxPlan,
    listModels: (options) => listOpencodeModels(runCapture, options),
    spawn(spec) {
        const tx = createOpencodeTranslator(spec.maxOutputChars ?? 2000);
        return runNdjsonWorker({
            provider: 'opencode',
            binary: OPENCODE_BINARY,
            spec,
            buildArgv,
            // `run --format json` is documented as raw JSON events, but --format
            // default prints human text, and a future version could add banner lines;
            // the runner surfaces those rather than dropping them.
            translate: tx.onEvent,
            buildResult: (ctx) => buildResult({ ...ctx, tx }),
            afterResult(final) {
                const notice = recoveredErrorNotice(tx.recovery.recovered(tx.finalText, final.exitCode), final);
                return notice === undefined ? [] : [notice];
            },
        });
    },
};/**
 * providers/registry.ts — name → Provider, plus machine capability detection.
 *
 * WHY A REGISTRY AND NOT A SWITCH STATEMENT
 * =========================================
 * ARCHITECTURE.md's whole premise is a MIXED PIPELINE: a task names different
 * workers per stage (implement: gemini, review: codex, moderate: claude). So
 * provider selection is data, not control flow — a stage says `provider: codex`
 * and something has to turn that string into a live Provider. This is that
 * something, and it is the only place that knows the full provider set.
 *
 * Two exports matter:
 *   - `getProvider(name)` / `PROVIDERS` — lookup. Throws on unknown names
 *     because a typo in a stage config should fail loudly at startup, not
 *     silently run no worker.
 *   - `detectAvailable()` — which of these CLIs exist on THIS machine. Powers
 *     the mod's provider readout and lets the supervisor refuse a plan it
 *     cannot staff before burning a job slot on it.
 */
// ---------------------------------------------------------------------------
// The provider set
// ---------------------------------------------------------------------------
/**
 * Canonical ordering. This is the order detectAvailable() reports in and the
 * order the mod lists them, and it is CHEAPEST-MOST-VERIFIED FIRST on purpose:
 * agy and claude are the two we verified end to end against live models, so if
 * something is wrong with detection, the providers we trust most show up first.
 */
const PROVIDERS = Object.freeze([
    agyProvider,
    codexProvider,
    opencodeProvider,
    claudeProvider,
    kimiProvider,
]);
/** name → Provider. Built once; the set is static. */
const BY_NAME = new Map(PROVIDERS.map((p) => [p.name, p]));
/** All known provider names, in canonical order. */
function providerNames() {
    return PROVIDERS.map((p) => p.name);
}
/**
 * Look up a provider by name.
 *
 * THROWS on an unknown name. Deliberate: a stage config with `provider: cdoe`
 * is a typo, and the failure mode we want is a startup crash with the list of
 * valid names, not a pipeline that silently runs zero workers and reports green.
 */
function getProvider(name) {
    const p = BY_NAME.get(name);
    if (p === undefined) {
        throw new Error(`unknown provider "${name}". Known providers: ${providerNames().join(', ')}. ` +
            'Register the adapter in registry.ts (PROVIDERS) to add one.');
    }
    return p;
}
/** Non-throwing lookup, for config validation that wants to report rather than raise. */
function findProvider(name) {
    return BY_NAME.get(name);
}/**
 * atomic.ts — the write primitives the state format depends on.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ===========================
 *
 * `job.json` is the anchor: the one file a reader MUST be able to read, and the
 * file that carries both the terminal verdict and the liveness clock. If it can
 * be observed half-written, then for one poll window every reader sees a
 * malformed manifest, the job reads as `unknown`, and the channel's Gate 3 (a
 * terminal claim needs a terminal timestamp) suppresses the one notification
 * that mattered. We have already paid for this class of bug once — see
 * harness/agy-staff.ts, where every read has to tolerate a half-written JSON
 * body because somebody else writes those files.
 *
 * We write this file, so we do not have to tolerate that.
 *
 * The primitive is the standard one: write a sibling temp file, then rename.
 * `rename(2)` is atomic within a filesystem, so a reader sees either the whole
 * previous file or the whole new one and never a splice of the two.
 *
 * appendFileSync is used for the append-only logs and needs no atomicity: a
 * partially-written LAST LINE is fine for NDJSON, because readers already skip
 * lines that do not parse (see the mod's `toolHistoryFromEvents`, which skips
 * them explicitly). Rewriting them atomically would cost a full copy per event.
 */
/** Monotonic counter so two atomic writes in the same millisecond cannot collide. */
let tempCounter = 0;
/** Write a file so a reader never observes a partial body. Creates parent dirs. */
function writeAtomic(filePath, body) {
    const dir = path.dirname(filePath);
    mkdirSync(dir, { recursive: true });
    tempCounter += 1;
    const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${tempCounter}`);
    try {
        // 'wx' would be stricter but races with nothing here and adds a failure mode
        // (a stale temp from a killed process) that costs more than it prevents.
        writeFileSync(tmp, body);
        renameSync(tmp, filePath);
    }
    catch (err) {
        try {
            unlinkSync(tmp);
        }
        catch {
            /* the rename may have already consumed it */
        }
        throw err;
    }
}
/** writeAtomic + a JSON body. Pretty-printed, because these files get read by humans. */
function writeJsonAtomic(filePath, value) {
    writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
/**
 * Create a marker file, writing `body` into it.
 *
 * Return value is whether WE created it. That matters: cancel is idempotent, and
 * the FIRST request is the one whose instant is the cancellation instant.
 */
function createMarker(filePath, body) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    let fd;
    try {
        fd = openSync(filePath, 'wx');
    }
    catch {
        return false; // already there
    }
    try {
        writeFileSync(fd, body);
        // Best-effort durability. A cancel marker lost to a machine crash costs one
        // un-cancelled job; an fsync on every cancel would cost the user a stall on
        // a path that runs while they are watching.
        try {
            fsyncSync(fd);
        }
        catch {
            /* not all filesystems support it; the rename below is the real barrier */
        }
    }
    finally {
        closeSync(fd);
    }
    return true;
}/** Tool name + parameters → a short human phrase. Shared by the legacy reader
 * (jobs.ts) and the progress digest (progress.ts); never raw tool output.
 */
/**
 * agy tool name + parameters → a short "what is it doing" phrase.
 *
 * Measured against the real corpus in .agy-staff/jobs:
 *   run_command           { CommandLine }
 *   view_file             { AbsolutePath }
 *   write_to_file         { TargetFile }
 *   replace_file_content  { TargetFile }
 *   grep_search           { Query | Pattern }
 *   list_dir              { AbsolutePath }
 *   call_mcp_tool         { ServerName, ToolName, Arguments }
 *   manage_task           { Action, TaskId }
 *   schedule              { DurationSeconds, Prompt }
 *
 * TERMINAL-UI.md §Motion: "terse tool descriptions, never raw output". Every
 * branch truncates at the source; there is no code path that hands raw tool
 * output to a list row.
 */
function describeTool(tool, params) {
    const str = (k) => {
        const v = params[k];
        return typeof v === 'string' ? oneLine(v) : '';
    };
    switch (tool) {
        case 'run_command':
            return humanCommand(str('CommandLine'));
        case 'view_file':
            return `reading ${basename(str('AbsolutePath'))}`;
        case 'write_to_file':
        // Same verb as replace_file_content, deliberately: from the reader's side
        // there is no difference between "created" and "changed" a file, and the
        // tool name is an implementation detail of agy, not of the work.
        case 'replace_file_content':
            return `editing ${basename(str('TargetFile'))}`;
        case 'grep_search':
            return `searching ${basename(str('Query') || str('Pattern'))}`;
        case 'list_dir':
            return `listing ${basename(str('AbsolutePath'))}`;
        case 'call_mcp_tool':
            return `${str('ToolName') || str('ServerName') || 'an mcp tool'}`;
        case 'manage_task':
            return `task ${str('Action') || 'update'}`;
        case 'schedule':
            return `waiting ${str('DurationSeconds') || '?'}s`;
        default:
            return `using ${oneLine(tool)}`;
    }
}
/**
 * A shell command → what a person would say they are doing.
 *
 * The corpus is 76 run_command records and the raw line is what put
 * `cargo tree -p renyi-mcp -e features -i` on a status row: real, precise, and
 * unreadable at a glance. So the COMMON commands get a verb, and anything else
 * gets a TRIMMED form rather than an invented one.
 *
 * The fallback rule is the important half. When there is no mapping this shows
 * the command's first two words and stops — `git rebase --onto main feature/x`
 * becomes `git rebase`, not `preparing the branch`. Inventing a plausible verb
 * for an arbitrary command would be a lie the user cannot check, and it would be
 * a lie in the one field the band exists to be trustworthy about. `cargo tree`
 * is in the table because it appears in the corpus four times, not because it
 * is universally understood.
 */
function humanCommand(cmd) {
    const line = oneLine(cmd);
    if (line === '')
        return 'running a command';
    // A pipeline or a `&&` chain is several actions; the first is what the job is
    // doing now, and the rest are what it will do after. `cargo test 2>&1 | tail`
    // is "running tests", not "running a shell pipeline".
    const first = line.split(/\s*(?:&&|\|\||;|\||&&)\s*/)[0] ?? line;
    const words = first.split(' ').filter((w) => !w.startsWith('-'));
    const prog = basename(words[0] ?? '');
    const sub = words[1] ?? '';
    switch (prog) {
        case 'cargo':
        case 'rustup':
            switch (sub) {
                case 'test':
                case 'nextest':
                    return 'running tests';
                case 'clippy':
                    return 'linting';
                case 'fmt':
                    return 'formatting';
                case 'build':
                    return 'building';
                case 'check':
                    return 'checking the build';
                case 'tree':
                    return 'inspecting dependencies';
                case 'doc':
                    return 'reading the docs';
                case 'run':
                    return `running ${basename(words[2] ?? 'the binary')}`;
            }
            break;
        case 'npm':
        case 'pnpm':
        case 'yarn':
        case 'bun':
            // `npm test` and `npm run test` are the same intent; `npm run build` is
            // building. Anything else under `npm run` is somebody's script and we do
            // not know what it does.
            if (sub === 'test')
                return 'running tests';
            if (sub === 'run' && (words[2] === 'build'))
                return 'building';
            if (sub === 'run' && (words[2] === 'test'))
                return 'running tests';
            return `running ${prog} scripts`;
        case 'python':
        case 'python3':
            return 'running a script';
        case 'git':
            if (sub === 'status' || sub === 'diff' || sub === 'log' || sub === 'show')
                return 'checking git';
            if (sub === 'commit')
                return 'committing';
            if (sub === 'push')
                return 'pushing';
            return `git ${sub}`.trim();
        case 'grep':
        case 'rg':
        case 'ag':
            return 'searching';
        case 'graft':
            return `navigating the graph`;
    }
    // The honest fallback: the command's name, and at most one argument.
    // `/Library/Developer/CommandLineTools/usr/bin/git` reads as `git`.
    const trimmed = [prog, ...words.slice(1, 2)].join(' ');
    return trimmed === '' ? 'running a command' : trimmed;
}
/** Last path segment only. */
function basename(p) {
    const i = p.lastIndexOf('/');
    return i === -1 ? p : p.slice(i + 1);
}
/**
 * `input_preview` is a JSON STRING of the tool parameters, truncated by agy-staff.
 * A truncated JSON string does not parse, so this never throws — a failure just
 * means we have no parameters and the caller falls back to the bare tool name.
 */
function parseInputPreview(preview) {
    if (!preview)
        return {};
    try {
        const v = JSON.parse(preview);
        return typeof v === 'object' && v !== null ? v : {};
    }
    catch {
        return {};
    }
}const READ_TOOLS = new Set(['view_file', 'read', 'read_file', 'list_dir', 'ls', 'list', 'notebookread', 'readmediafile']);
const SEARCH_TOOLS = new Set(['grep_search', 'grep', 'glob', 'find_by_name', 'search_files', 'find_files', 'codebase_search', 'search_web', 'web_search', 'websearch', 'webfetch', 'fetchurl']);
const EDIT_TOOLS = new Set(['write_to_file', 'replace_file_content', 'edit', 'edit_file', 'write', 'write_file', 'create_file', 'str_replace_editor', 'multiedit', 'notebookedit', 'patch', 'file_change', 'apply_patch']);
const COMMAND_TOOLS = new Set(['run_command', 'bash', 'shell', 'command_execution', 'exec']);
const PATH_KEYS = ['AbsolutePath', 'TargetFile', 'file_path', 'filePath', 'notebook_path', 'path'];
const COMMAND_KEYS = ['CommandLine', 'command', 'cmd'];
/**
 * `/bin/zsh -lc 'cat x'` and `bash -lc "…"` → the command inside. codex names a shell call by its command line.
 * A stored preview is cut short and loses its closing quote; the command is still the inside.
 */
function unwrapShell(command) {
    const m = /^\s*(?:\S*\/)?(?:ba|z|)sh\s+-l?c\s+(['"])([\s\S]*)$/.exec(command);
    if (!m)
        return command;
    const inner = m[2].trimEnd();
    return inner.endsWith(m[1]) ? inner.slice(0, -1) : inner;
}
const TEST_RE = /\b(?:pytest|jest|vitest|mocha|tox|nox|rspec|phpunit|ctest|unittest)\b|\b(?:cargo|go|npm|pnpm|yarn|bun|deno|dotnet|mvn|gradle|swift|mix)\s+(?:run\s+)?(?:test|nextest|verify)\b|\bmake\s+(?:test|check)\b|\bnode\s+--test\b/;
const SEARCH_PROGS = new Set(['grep', 'rg', 'ag', 'ack', 'find', 'fd']);
/** Steps that prepare a shell rather than do the work. */
const SETUP_PROGS = new Set(['cd', 'pushd', 'popd', 'export', 'unset', 'source', '.', 'set', 'ulimit']);
const READ_PROGS = new Set(['cat', 'sed', 'head', 'tail', 'nl', 'less', 'ls', 'tree', 'wc']);
function classifyCommand(raw) {
    // A leading `!` negates the exit status; it is not the program.
    const command = unwrapShell(raw).replace(/\s+/g, ' ').trim().replace(/^!\s*/, '');
    const segments = command.split(/\s*(?:&&|\|\||;|\|)\s*/).filter((s) => s !== '');
    const program = (segment) => segment.split(' ').filter((w) => w !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    // `unset VIRTUAL_ENV; uv run pytest`: the setup step is not what the command does.
    const first = segments.find((s) => !SETUP_PROGS.has(basename(program(s)[0] ?? ''))) ?? segments[0] ?? command;
    const words = program(first);
    const prog = basename(words[0] ?? '');
    const sub = subcommand(words);
    if (prog === 'git' && sub === 'grep')
        return { kind: 'search', label: 'git grep' };
    if (SEARCH_PROGS.has(prog))
        return { kind: 'search', label: humanCommand(first) };
    if (READ_PROGS.has(prog))
        return { kind: 'read', label: humanCommand(first) };
    if (TEST_RE.test(command))
        return { kind: 'test', label: 'running tests' };
    return { kind: 'command', label: humanCommand(first) };
}
/** Global options that take a value, so `git -C dir grep` finds `grep`, not `dir`. */
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
function subcommand(words) {
    for (let i = 1; i < words.length; i += 1) {
        const w = words[i];
        if (VALUE_OPTIONS.has(w)) {
            i += 1;
            continue;
        }
        if (!w.startsWith('-'))
            return w;
    }
    return '';
}
function firstString(params, keys, raw = '') {
    for (const k of keys) {
        const v = params[k];
        if (typeof v === 'string' && v.trim() !== '')
            return v;
    }
    // A long input (a Write's file body) arrives truncated and no longer parses;
    // its leading keys are still readable.
    for (const k of keys) {
        const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
        if (m) {
            try {
                return JSON.parse(`"${m[1]}"`);
            }
            catch {
                return m[1];
            }
        }
    }
    return '';
}
/**
 * A short name for an in-flight tool call, as a reader would type it: the
 * command line's first step for a shell tool (`cargo test`), else the tool
 * name. Used for liveness text ("in `cargo test` 16m").
 */
function toolLabel(tool, input, max = 40) {
    const lower = tool.trim().toLowerCase();
    if (COMMAND_TOOLS.has(lower)) {
        const command = unwrapShell(firstString(parseInputPreview(input), COMMAND_KEYS, input ?? '')).replace(/\s+/g, ' ').trim();
        const first = command.split(/\s*(?:&&|\|\||;|\|)\s*/).find((s) => s !== '') ?? '';
        if (first !== '')
            return oneLine(first, max);
    }
    return oneLine(tool, max);
}
/**
 * One tool call → its kind and a phrase. Every provider's tool vocabulary:
 * agy (view_file, run_command, …), claude (Read, Edit, Bash, …), opencode (read,
 * edit, bash, …), codex (a shell command line as the tool, or file_change) and
 * kimi (Read, Write, Edit, Grep, Glob, Bash, … — PascalCase, matched lowercased).
 * Input may be truncated JSON; a parse failure falls back to the bare tool name.
 */
function classify(tool, input) {
    const params = parseInputPreview(input);
    const name = tool.trim();
    const lower = name.toLowerCase();
    const path = firstString(params, PATH_KEYS, input ?? '');
    const file = path === '' ? '' : basename(path);
    if (COMMAND_TOOLS.has(lower))
        return classifyCommand(firstString(params, COMMAND_KEYS, input ?? ''));
    if (EDIT_TOOLS.has(lower)) {
        if (lower === 'file_change') {
            const changes = Array.isArray(params['changes']) ? params['changes'] : [];
            const first = changes.map((c) => (c && typeof c === 'object' ? c['path'] : undefined))
                .find((p) => typeof p === 'string');
            return { kind: 'edit', label: first ? `editing ${oneLine(basename(first))}` : 'editing files', ...(first ? { path: first } : {}) };
        }
        return { kind: 'edit', label: file ? `editing ${oneLine(file)}` : 'editing', ...(path ? { path } : {}) };
    }
    if (READ_TOOLS.has(lower)) {
        const listing = lower === 'list_dir' || lower === 'ls' || lower === 'list';
        return { kind: 'read', label: file ? `${listing ? 'listing' : 'reading'} ${oneLine(file)}` : 'reading', ...(path && !listing ? { path } : {}) };
    }
    if (SEARCH_TOOLS.has(lower)) {
        const query = oneLine(firstString(params, ['Query', 'Pattern', 'pattern', 'query', 'url'], input ?? ''));
        const short = query.length > 24 ? `${oneLine(query, 23)}…` : query;
        return { kind: 'search', label: short ? `searching ${short}` : 'searching' };
    }
    // codex: the tool IS the command line.
    if (/\s/.test(name) || /^(?:\S*\/)?(?:ba|z)?sh$/.test(name))
        return classifyCommand(name);
    return { kind: 'other', label: describeTool(name, params) };
}
const REPEAT_MIN = 4;
/** Accumulates one job's tool calls into a ProgressDigest. Feed it every activity start and end. */
class ProgressTracker {
    steps = new Map();
    /**
     * Steps whose first ACTIVITY event carried no input. A provider can split the
     * call into "started, parameters not yet known" and "updated, here they are";
     * such a step is classified but not counted until the input arrives, so a
     * later update can upgrade it without double-counting.
     */
    provisional = new Set();
    read = new Set();
    editedSet = new Set();
    edited = [];
    /** Edits whose file the tool did not name (codex file_change's shape is unverified): still edits. */
    unnamedEdits = 0;
    searches = 0;
    commands = 0;
    testRuns = 0;
    lastTestFailed = false;
    recent = [];
    repeatKey = '';
    repeatLabel = '';
    repeatCount = 0;
    activeTest = false;
    /** A tool call began. Repeated starts of one step (ACTIVE then DONE) are counted once. */
    start(stepIndex, tool, input) {
        // Codex passes the shell command line as `tool` with no separate `input`.
        const effectiveInput = (input ?? '').trim() !== '' ? input : (/\s/.test(tool.trim()) ? tool.trim() : '');
        const hasInput = effectiveInput !== '';
        const seen = this.steps.get(stepIndex);
        if (seen !== undefined) {
            // The parameters arrived after the step was first seen: classify for real.
            if (!this.provisional.has(stepIndex) || !hasInput)
                return;
            this.provisional.delete(stepIndex);
            const upgraded = classify(tool, input);
            this.steps.set(stepIndex, upgraded);
            this.apply(upgraded, effectiveInput);
            return;
        }
        const c = classify(tool, input);
        this.steps.set(stepIndex, c);
        if (!hasInput) {
            // No input means we do not know what ran. Remember the step so `end()`
            // keeps its verdict, but do not count a likely-misleading call.
            this.provisional.add(stepIndex);
            this.resetRepeat();
            return;
        }
        this.apply(c, effectiveInput);
    }
    apply(c, input) {
        switch (c.kind) {
            case 'read':
                if (c.path)
                    this.read.add(c.path);
                break;
            case 'search':
                this.searches += 1;
                break;
            case 'edit':
                if (c.path) {
                    if (this.editedSet.has(c.path))
                        this.edited = this.edited.filter((p) => p !== c.path);
                    this.editedSet.add(c.path);
                    this.edited.push(c.path);
                }
                else
                    this.unnamedEdits += 1;
                break;
            case 'test':
                this.testRuns += 1;
                this.activeTest = true;
                break;
            case 'command':
                this.commands += 1;
                break;
        }
        if (c.kind !== 'other')
            this.recent = [...this.recent, c].slice(-8);
        // An unclassified call is not a repeat of anything: "repeating editing ×17"
        // is not a fact about the worker, it is a fact about a missing input.
        if (c.kind === 'other') {
            this.resetRepeat();
            return;
        }
        const key = `${c.kind}\u0000${c.label}\u0000${input ?? ''}`;
        if (key === this.repeatKey)
            this.repeatCount += 1;
        else {
            this.repeatKey = key;
            this.repeatLabel = c.label;
            this.repeatCount = 1;
        }
    }
    resetRepeat() {
        this.repeatKey = '';
        this.repeatLabel = '';
        this.repeatCount = 0;
    }
    /** A tool call ended. Only an explicit error marks a test run failed. */
    end(stepIndex, tool, input, status) {
        this.start(stepIndex, tool, input);
        const c = this.steps.get(stepIndex);
        if (c.kind === 'test') {
            this.lastTestFailed = status === 'error';
            this.activeTest = false;
        }
    }
    digest(cwd = '') {
        const relative = (p) => {
            const base = cwd.replace(/\/+$/, '');
            return base !== '' && p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p;
        };
        return {
            phase: this.phase(),
            filesRead: this.read.size,
            searches: this.searches,
            edited: this.edited.slice(-8).map(relative),
            editedCount: this.editedSet.size + this.unnamedEdits,
            commands: this.commands,
            testRuns: this.testRuns,
            lastTestFailed: this.lastTestFailed,
            repeat: this.repeatCount >= REPEAT_MIN ? { label: this.repeatLabel, count: this.repeatCount } : null,
        };
    }
    /** All file paths named by edit tool calls so far, relative to `cwd` when inside it. */
    editedPaths(cwd = '') {
        const base = cwd.replace(/\/+$/, '');
        return this.edited.map((p) => (base !== '' && p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p));
    }
    /** From a window of recent calls, not the last one alone, so the phase does not flicker. */
    phase() {
        const last = this.recent.at(-1);
        if (last === undefined)
            return 'starting';
        if (this.activeTest || last.kind === 'test')
            return 'testing';
        if (this.recent.some((c) => c.kind === 'edit'))
            return 'editing';
        if (last.kind === 'command')
            return 'running';
        return 'exploring';
    }
}/**
 * writer.ts — one job, from `spawn()` to the terminal anchor.
 *
 * This is the module that makes the two halves of this repo one system. It takes
 * a `WorkerHandle` from providers/, translates its event stream into OUR state
 * format (format.ts), computes the verdict (format.deriveStatus), writes the
 * anchor.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE WRITER, AND NOT THE SURFACE, OWNS THE FILES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Because a job outlives the tool call that started it. `spawn_job` returns a
 * job id in under a millisecond; the job then runs for 28 minutes across an MCP
 * server restart, a session close, and a pane that was never opened. If the
 * surface owned the state, a Claude Code restart would lose every running job.
 *
 * The filesystem is the only thing in this system that survives all three.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WRITE AMOUNT, BECAUSE THIS RUNS 484 TIMES ON A GOOD JOB
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The reference job made 484 tool calls. Naively, that is 484 progress.json
 * rewrites. That is invisible — the band polls
 * at 3 s, the channel at 5 s — so we coalesce: at most one progress flush every
 * PROGRESS_FLUSH_MS, with a trailing flush on every terminal transition so the
 * last state is never lost.
 *
 * What is NOT throttled: the terminal writes, the cancel marker, and the
 * append-only event log. Those are the ones a reader is waiting on.
 */
// Shared with the mod, which renders the digest; the mod loader cannot import forge, so it lives there.
/** How many recent activities we keep. Matches the pane's rendering cap. */
const RECENT_ACTIVITIES = 5;
/** How much assistant text we keep as the "reasoning" cell. */
const LATEST_TEXT_CHARS = 4_000;
/** Max length of `latestSummary`. */
const SUMMARY_CHARS = 1_000;
/**
 * Owns the on-disk state of exactly one job.
 *
 * Not thread-safe and does not need to be: one job has one owner (the coroutine
 * that spawned it), and `forge/service.ts` keeps that ownership in a map.
 */
class JobWriter {
    jobId;
    repo;
    flushMs;
    manifest = null;
    progress = null;
    recent = [];
    lastActivity = null;
    lastFlushMs = 0;
    toolCalls = 0;
    toolSteps = new Set();
    latestText = null;
    /** The current assistant message only (reset at each tool call): what `latestSummary` shows while running. */
    currentMessage = '';
    /** Steps whose tool call ended in an error state. */
    toolErrorSteps = new Set();
    /** Last heartbeat and the worker pid it named; carried through every progress rebuild. */
    lastAliveAt = null;
    workerPid;
    lastHeartbeatFlushMs = 0;
    /** Whether the first substantive event (not `started`/`usage`) was an error notice. */
    firstEventSeen = false;
    firstEventWasError = false;
    tracker = new ProgressTracker();
    view = { schema: 1, prompt: '', preamble: null, transcript: [], tools: [], timeline: [], truncated: false };
    deltaOpen = false;
    viewSequence = 0;
    conversation = null;
    finished = false;
    cancelRequestedAt = null;
    cwd = '';
    baselinePending = null;
    /** In-memory size:mtime signatures of baseline-dirty files, to detect further edits. */
    baselineSigs = new Map();
    changed = null;
    unattributed = [];
    staleReads = [];
    /** Concatenated tool inputs of this job, used to attribute changed files to it. */
    toolInputs = '';
    /** Concatenated inputs of edit tool calls only, so read calls never attribute an external edit to the worker. */
    editToolInputs = '';
    /**
     * Steps whose edit tool call ENDED without error. The writing-job evidence
     * for the cwd rule: an edit that errored or was denied changed nothing, so
     * it must not turn a review into a writing job. (The progress digest counts
     * edits at start, which is right for the pane but not for a verdict.)
     */
    editStepsCompleted = new Set();
    constructor(options) {
        this.repo = options.repo;
        this.jobId = options.jobId;
        this.flushMs = options.flushMs ?? PROGRESS_FLUSH_MS;
    }
    /**
     * Write the initial snapshot, BEFORE the process is spawned.
     *
     * The ordering is the whole point. A reader that finds nothing has to answer
     * "does this job exist?" with "no", and then the job's whole life is invisible
     * until its first event — which for a slow provider is seconds, and for a
     * spawn failure is forever. Writing first means the job exists from the
     * instant it was accepted, and a spawn that throws turns an existing job from
     * `running` into `failed` instead of leaving a hole.
     *
     * `claim()` runs first: if the id belongs to somebody else's job we refuse
     * before writing a single byte.
     */
    start(input) {
        const now = new Date().toISOString();
        this.view = { ...this.view, prompt: input.prompt.slice(0, 64_000), preamble: input.preamble?.slice(0, 4_000) ?? null,
            truncated: input.prompt.length > 64_000 || (input.preamble?.length ?? 0) > 4_000 };
        this.conversation = input.conversation;
        const manifest = {
            schema: SCHEMA_VERSION,
            jobId: this.jobId,
            name: input.name ?? this.jobId,
            workerId: input.workerId ?? this.jobId,
            role: input.mode,
            latestSummary: null,
            summarySource: null,
            provider: input.provider,
            mode: input.mode,
            model: input.model,
            effort: input.effort,
            cwd: input.cwd,
            task: input.task === undefined ? taskTitle(input.prompt) : taskTitle(input.task),
            promptChars: input.prompt.length,
            unrestricted: input.unrestricted,
            conversation: input.conversation,
            ownerPid: process.pid,
            timeoutMs: input.timeoutMs,
            status: 'running',
            createdAt: now,
            updatedAt: now,
            startedAt: now,
            finishedAt: null,
            exitCode: null,
            jobStatus: null,
            error: null,
            deniedActions: [],
            usage: null,
            toolCalls: 0,
            pipeline: input.pipeline,
            stage: input.stage,
            attempt: input.attempt,
            ...(input.modelRequested === undefined ? {} : { modelRequested: input.modelRequested }),
            ...(input.modelResolved === undefined ? {} : { modelResolved: input.modelResolved }),
            ...(input.modelSource === undefined ? {} : { modelSource: input.modelSource }),
            ...(input.preambleApplied === undefined ? {} : { preambleApplied: input.preambleApplied }),
            ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
            ...(input.sandboxFlags === undefined ? {} : { sandboxFlags: input.sandboxFlags }),
            ...(input.readOnlyRequested === undefined ? {} : { readOnlyRequested: input.readOnlyRequested }),
            ...(input.readOnlyEnforced === undefined ? {} : { readOnlyEnforced: input.readOnlyEnforced }),
            ...(input.steeredFrom ? { steeredFrom: input.steeredFrom } : {}),
            ...(input.watchedFiles !== undefined && Object.keys(input.watchedFiles).length > 0
                ? { watchedFiles: input.watchedFiles }
                : {}),
        };
        this.manifest = manifest;
        this.progress = {
            jobId: this.jobId,
            lastEventAt: now,
            recentActivities: [],
            lastActivity: null,
            latestText: null,
            toolCalls: 0,
            editsCompleted: 0,
            warnings: [],
        };
        this.writeManifest();
        this.flushProgress(this.manifest.createdAt);
        // Fire and forget: spawn never waits on git. Merged into the manifest when it lands.
        this.cwd = input.cwd;
        this.baselinePending = this.captureBaseline(input.cwd);
        return manifest;
    }
    async captureBaseline(cwd) {
        try {
            const snap = await gitSnapshot(cwd);
            if (snap === null || this.finished || this.manifest === null)
                return;
            for (const p of snap.dirty.slice(0, CHANGED_FILES_SIG_CAP))
                this.baselineSigs.set(p, fileSig(cwd, p));
            this.manifest = { ...this.manifest, gitBaseline: { head: snap.head, dirty: snap.dirty } };
            this.writeManifest();
        }
        catch { /* best effort */ }
    }
    /** Candidate paths that this worker's own edit tool calls touched. */
    editedFiles(candidates) {
        const fromTracker = this.tracker.editedPaths(this.cwd);
        if (candidates === undefined)
            return fromTracker;
        const fromEditInputs = this.editToolInputs !== '' ? attributeChanged(candidates, this.editToolInputs).mine : [];
        return [...new Set([...fromTracker.filter((p) => candidates.includes(p)), ...fromEditInputs])];
    }
    /**
     * Compute `changedFiles` against the baseline. Call (awaited) just before
     * `finish()`; finish stays synchronous. Bounded by the git ~2s cap, never throws.
     */
    async prepareFinish() {
        try {
            if (this.baselinePending !== null)
                await this.baselinePending;
            if (this.manifest === null)
                return;
            // A vanished cwd has nothing to diff or compare; finish() records it as
            // cwdMissingAtFinish + changedFilesUnknown instead of a silent "no edits".
            if (!existsSync(this.cwd))
                return;
            const watched = this.manifest.watchedFiles;
            const watchedKeys = watched !== undefined ? Object.keys(watched) : [];
            const editedWatchedSet = new Set(this.editedFiles(watchedKeys));
            const sameRoot = path.resolve(this.repo) === path.resolve(this.cwd);
            const base = this.manifest.gitBaseline;
            if (base !== undefined) {
                const now = await gitSnapshot(this.cwd);
                if (now !== null) {
                    const modified = base.dirty.filter((p) => now.dirty.includes(p) && this.baselineSigs.has(p) && this.baselineSigs.get(p) !== fileSig(this.cwd, p));
                    const committed = base.head !== null && now.head !== null && base.head !== now.head
                        ? await gitCommittedPaths(this.cwd, base.head, now.head)
                        : [];
                    let baseForDiff = base;
                    let nowDirty = now.dirty;
                    let modifiedFiltered = modified;
                    let committedFiltered = committed;
                    if (watched !== undefined) {
                        const unmodifiedWatched = new Set();
                        const modifiedWatched = new Set();
                        for (const [p, sigs] of Object.entries(watched)) {
                            const sigChanged = fileSig(this.cwd, p) !== sigs.cwdSig;
                            const workerModified = sameRoot ? sigChanged && editedWatchedSet.has(p) : sigChanged;
                            if (!workerModified)
                                unmodifiedWatched.add(p);
                            else
                                modifiedWatched.add(p);
                        }
                        if (unmodifiedWatched.size > 0) {
                            baseForDiff = { ...base, dirty: base.dirty.filter((p) => !unmodifiedWatched.has(p)) };
                            nowDirty = now.dirty.filter((p) => !unmodifiedWatched.has(p));
                            modifiedFiltered = modified.filter((p) => !unmodifiedWatched.has(p));
                            committedFiltered = committed.filter((p) => !unmodifiedWatched.has(p));
                        }
                        if (modifiedWatched.size > 0) {
                            const nextMod = new Set(modifiedFiltered);
                            for (const p of modifiedWatched)
                                nextMod.add(p);
                            modifiedFiltered = [...nextMod];
                        }
                    }
                    const diff = diffChangedFiles(baseForDiff, nowDirty, modifiedFiltered, committedFiltered);
                    const split = attributeChanged(diff.files, this.toolInputs);
                    this.changed = { files: split.mine, truncated: diff.truncated };
                    this.unattributed = split.other;
                }
            }
            if (watched !== undefined) {
                this.staleReads = computeStaleReads(this.repo, this.cwd, watched, [...editedWatchedSet]);
            }
        }
        catch { /* best effort */ }
    }
    /**
     * Record that the worker's process is alive: progress.json `lastAliveAt` (and
     * `workerPid`). Not activity: `updatedAt`, `lastEventAt` and the timeline
     * stay untouched, and only progress.json is rewritten.
     */
    heartbeat(at, pid) {
        if (this.finished || this.manifest === null || this.progress === null)
            return;
        this.lastAliveAt = at;
        if (typeof pid === 'number')
            this.workerPid = pid;
        this.progress = { ...this.progress, lastAliveAt: at, ...(this.workerPid === undefined ? {} : { workerPid: this.workerPid }) };
        // Coalesced like every progress write; heartbeats are HEARTBEAT_MS apart, so in practice each lands.
        const nowMs = Date.parse(at);
        if (!shouldFlush(this.lastHeartbeatFlushMs, Number.isNaN(nowMs) ? Date.now() : nowMs, this.flushMs))
            return;
        this.lastHeartbeatFlushMs = Number.isNaN(nowMs) ? Date.now() : nowMs;
        writeJsonAtomic(jobFile(this.repo, this.jobId, FILES.progress), this.progress);
    }
    /** Feed one normalized provider event into the snapshot. */
    onEvent(event) {
        if (this.finished || this.manifest === null)
            return;
        switch (event.kind) {
            case 'heartbeat':
                this.heartbeat(event.at, event.pid);
                return;
            case 'started':
                this.onStarted(event);
                return;
            case 'activity-start':
            case 'activity-update':
            case 'activity-end':
                this.onActivity(event);
                return;
            case 'text':
                this.onText(event);
                return;
            case 'notice':
                // Info notices (lifecycle chatter) are not "the first thing that happened".
                if (event.level !== 'info')
                    this.noteFirstEvent(event.level === 'error');
                if (event.level === 'warn' || event.level === 'error') {
                    this.addWarning(event.message.slice(0, 400));
                    this.touch(event.at);
                }
                return;
            case 'usage':
                this.touch(event.at);
                return;
            default: return;
        }
    }
    onStarted(event) {
        if (this.manifest === null)
            return;
        const at = event.at;
        if (typeof event.conversationId === 'string' && event.conversationId.trim() !== '') {
            this.conversation = event.conversationId;
            this.manifest = { ...this.manifest, conversation: this.conversation };
            // Resume identity must survive a supervisor crash even inside the
            // progress coalescing window, before finish() can publish it.
            this.writeManifest();
        }
        if (typeof event.model === 'string' && this.manifest.model === null) {
            // Provider-reported (structured event, never worker text) beats "unknown"/harness-config guesses.
            this.manifest = {
                ...this.manifest,
                model: event.model,
                modelResolved: event.model,
                modelSource: 'reported',
            };
        }
        this.touch(at);
    }
    onActivity(event) {
        if (this.manifest === null)
            return;
        const at = event.at;
        this.deltaOpen = false;
        const ref = event.activity;
        const isStart = event.kind === 'activity-start';
        // An update is an in-flight call: it keeps the row active and must NOT
        // count as a new tool call when its step was already registered.
        const status = isStart || event.kind === 'activity-update'
            ? 'active'
            : event.status === 'denied'
                ? 'denied'
                : event.status === 'error'
                    ? 'error'
                    : 'done';
        if (!this.toolSteps.has(ref.stepIndex)) {
            this.toolSteps.add(ref.stepIndex);
            this.toolCalls += 1;
        }
        // A tool's DONE record frequently carries no `input` (the provider split
        // ACTIVE and DONE for the same step_index, and only ACTIVE had the
        // parameters — 14,900 archived records confirm it). So the DONE row
        // INHERITS the input from the ACTIVE row rather than dropping it, which is
        // what keeps the pane's activity phrase readable on a finished job. The
        // same applies to an update, and to a later update that finally names the
        // parameters the start did not have.
        const idx = this.recent.findIndex((a) => a.stepIndex === ref.stepIndex);
        const previousRow = idx >= 0 ? this.recent[idx] : undefined;
        const input = ref.input ?? previousRow?.input;
        const tool = ref.tool === 'tool_result' ? previousRow?.tool ?? ref.tool : ref.tool;
        const row = {
            stepIndex: ref.stepIndex,
            tool,
            status,
            ...(input === undefined ? {} : { input }),
        };
        // Only an input that arrived AFTER a start without one is "new" evidence:
        // re-sent parameters on every update must not fill the attribution buffer.
        if (ref.input !== undefined && previousRow?.input === undefined) {
            if (this.toolInputs.length < TOOL_INPUTS_CAP)
                this.toolInputs += ref.input + '\n';
            if (classify(tool, input).kind === 'edit' && this.editToolInputs.length < TOOL_INPUTS_CAP) {
                this.editToolInputs += ref.input + '\n';
            }
        }
        if (event.kind === 'activity-end')
            this.tracker.end(ref.stepIndex, row.tool, input, status);
        else
            this.tracker.start(ref.stepIndex, row.tool, ref.input ?? input);
        if (event.kind === 'activity-end' && status === 'done' && classify(tool, input).kind === 'edit') {
            this.editStepsCompleted.add(ref.stepIndex);
        }
        // A tool call ends the assistant message before it: the next text is a new one.
        if (isStart)
            this.currentMessage = '';
        if (status === 'error')
            this.toolErrorSteps.add(ref.stepIndex);
        this.noteFirstEvent(false);
        this.lastActivity = row;
        if (idx >= 0)
            this.recent[idx] = row;
        else
            this.recent.push(row);
        // The pane picks the HIGHEST step_index, not the last entry, because a
        // rewritten array mid-poll is not guaranteed sorted. Keeping the array
        // short is what stops that from mattering.
        if (this.recent.length > RECENT_ACTIVITIES)
            this.recent = this.recent.slice(-RECENT_ACTIVITIES);
        const tools = [...this.view.tools];
        const toolIndex = tools.findIndex(t => t.stepIndex === ref.stepIndex);
        const previous = tools[toolIndex];
        const detail = { stepIndex: ref.stepIndex, at, tool: (ref.tool === 'tool_result' ? previous?.tool ?? ref.tool : ref.tool).slice(0, 120),
            input: (ref.input ?? previous?.input ?? '').slice(0, 1_000),
            output: (ref.output ?? previous?.output ?? '').slice(0, 2_000),
            state: status === 'active' ? 'active' : status === 'done' ? 'done' : 'error' };
        if (toolIndex >= 0)
            tools[toolIndex] = detail;
        else
            tools.push(detail);
        this.view = { ...this.view, tools: tools.slice(-60), truncated: this.view.truncated || tools.length > 60 ||
                (ref.input?.length ?? 0) > 1_000 || (ref.output?.length ?? 0) > 2_000 || ref.tool.length > 120 };
        const timeline = [...this.view.timeline ?? []];
        const eventIndex = timeline.findIndex(e => e.kind === 'tool' && e.stepIndex === ref.stepIndex);
        const oldEvent = timeline[eventIndex];
        const item = { ...detail, kind: 'tool', sequence: oldEvent?.sequence ?? this.viewSequence++,
            at: oldEvent?.at ?? at };
        if (eventIndex >= 0)
            timeline[eventIndex] = item;
        else
            timeline.push(item);
        const bounded = boundTimeline(timeline);
        this.view = { ...this.view, timeline: bounded.events, truncated: this.view.truncated || bounded.truncated };
        this.touch(at);
    }
    onText(event) {
        if (this.manifest === null)
            return;
        const at = event.at;
        if (event.stream !== 'assistant')
            return;
        const joinDelta = event.delta === true && this.deltaOpen;
        const transcript = [...this.view.transcript];
        if (event.delta && this.deltaOpen && transcript.length > 0)
            transcript[transcript.length - 1] += event.text;
        else
            transcript.push(event.text);
        this.deltaOpen = event.delta === true;
        let truncated = this.view.truncated;
        let chars = transcript.reduce((n, t) => n + t.length, 0);
        while (transcript.length > 1 && (chars > 64_000 || transcript.length > 200)) {
            chars -= transcript.shift().length;
            truncated = true;
        }
        if (chars > 64_000) {
            transcript[0] = transcript[0].slice(-64e3);
            truncated = true;
        }
        this.view = { ...this.view, transcript, truncated };
        const timeline = [...this.view.timeline ?? []];
        const last = timeline.at(-1);
        if (joinDelta && last?.kind === 'assistant')
            timeline[timeline.length - 1] = { ...last, text: last.text + event.text };
        else
            timeline.push({ kind: 'assistant', sequence: this.viewSequence++, at, text: event.text });
        const bounded = boundTimeline(timeline);
        this.view = { ...this.view, timeline: bounded.events, truncated: this.view.truncated || bounded.truncated };
        this.latestText = appendBounded(this.latestText ?? '', event.text, LATEST_TEXT_CHARS);
        this.currentMessage = appendBounded(this.currentMessage, event.text, LATEST_TEXT_CHARS);
        this.noteFirstEvent(false);
        this.manifest = { ...this.manifest, latestSummary: summaryTail(this.currentMessage, SUMMARY_CHARS) || this.manifest.latestSummary || null, summarySource: 'worker' };
        this.touch(at);
    }
    /**
     * The cwd facts deriveStatus needs: is the cwd gone, and was this job meant
     * to write (mode) or seen editing (one of its own edit tool calls completed
     * without error). Every verdict for this job (finish, the steer chain) reads
     * them from here.
     */
    verdictFacts() {
        return cwdFacts(this.cwd, this.manifest?.mode, this.editStepsCompleted.size > 0);
    }
    /**
     * Write the terminal state.
     *
     * Every path out of a job goes through here, including the ones where the
     * process died without producing a JobResult — a cancel that raced the exit,
     * a throw from the adapter. A job that never gets a terminal write stays
     * `running` forever, which is a lie with a very long fuse.
     */
    finish(result, report) {
        if (this.finished || this.manifest === null) {
            // A second terminal write is a bug in the caller, but returning the
            // manifest we already have is strictly better than rewriting history.
            return this.manifest ?? emptyManifest(this.jobId);
        }
        this.finished = true;
        const finishedAt = result.finishedAt;
        // A marker records a request, not proof that the worker stopped. Only the
        // adapter's terminal cancellation verdict can make the job canceled.
        const alreadyTerminal = result.status === 'cancelled' ? 'canceled' : null;
        const { cwdMissing, writing } = this.verdictFacts();
        const verdict = deriveStatus({
            alreadyTerminal,
            ok: result.ok,
            jobStatus: result.status,
            deniedActions: result.deniedActions ?? [],
            report,
            cwdMissing,
            writing,
        });
        // deriveStatus warns for a writing job (via `suspicious`); a read-only job keeps its verdict and gets this.
        if (cwdMissing && !verdict.suspicious) {
            this.addWarning(`working directory ${this.cwd} was gone at finish; changed files and checks could not be verified`);
        }
        const failure = failureFields(verdict, result);
        // Failed before doing anything: a route (model/region/account) problem, not the work.
        const failedEarly = verdict.status === 'failed' && !result.ok && result.status !== 'timeout' && result.status !== 'cancelled' &&
            this.toolCalls === 0 && (result.durationMs <= FAILED_EARLY_MS || this.firstEventWasError);
        const response = result.response.trim();
        const usage = result.usage === undefined
            ? null
            : Object.fromEntries(Object.entries(result.usage).filter((e) => typeof e[1] === 'number'));
        const manifest = {
            ...this.manifest,
            status: verdict.status,
            updatedAt: finishedAt,
            finishedAt,
            startedAt: this.manifest.startedAt ?? result.startedAt,
            exitCode: result.exitCode,
            jobStatus: result.status,
            // The adapter's own text when it has one, else the verdict's reason; never both.
            error: failure.error,
            reason: failure.reason,
            deniedActions: (result.deniedActions ?? []).map((d) => ({
                ...(d.action === undefined ? {} : { action: d.action }),
                ...(d.displayName === undefined ? {} : { displayName: d.displayName }),
                ...(d.nonfatal === true ? { nonfatal: true } : {}),
            })),
            usage,
            toolCalls: this.toolCalls,
            ...(this.toolErrorSteps.size === 0 ? {} : { toolErrors: this.toolErrorSteps.size }),
            ...(failedEarly ? { failedEarly: true } : {}),
            conversation: this.conversation,
            // A worker's conclusion is at the END of its final response, not the start.
            latestSummary: summaryTail(response, SUMMARY_CHARS) || this.manifest.latestSummary || null,
            summarySource: response || this.manifest.latestSummary ? 'worker' : null,
            ...(this.changed === null
                ? { changedFilesUnknown: true }
                : { changedFiles: this.changed.files, changedFilesTruncated: this.changed.truncated }),
            ...(cwdMissing ? { cwdMissingAtFinish: true } : {}),
            ...(this.unattributed.length === 0 ? {} : { unattributedFiles: this.unattributed }),
            ...(this.staleReads.length === 0 ? {} : { staleReads: this.staleReads }),
            ...(this.manifest.pendingSteers !== undefined ? { pendingSteers: 0 } : {}),
        };
        this.manifest = manifest;
        if (this.progress !== null && this.progress.pendingSteers !== undefined) {
            this.progress = { ...this.progress, pendingSteers: 0 };
        }
        const body = report ?? '';
        writeAtomic(jobFile(this.repo, this.jobId, FILES.report), body);
        this.writeManifest();
        this.flushProgress(finishedAt);
        if (verdict.suspicious)
            this.addWarning(verdict.reason ?? 'suspicious success');
        return manifest;
    }
    /**
     * Record a terminal state with no JobResult at all.
     *
     * Used when the adapter throws or never resolves. Same guarantee as `finish`:
     * the job stops claiming to be `running`.
     */
    abort(status, reason) {
        if (this.finished || this.manifest === null)
            return this.manifest;
        this.finished = true;
        const now = new Date().toISOString();
        const manifest = {
            ...this.manifest,
            status,
            updatedAt: now,
            finishedAt: now,
            error: reason,
            reason: status === 'failed' ? reason.split(' · ')[0] : null,
            jobStatus: status === 'canceled' ? 'cancelled' : 'malformed',
            ...(this.manifest.pendingSteers !== undefined ? { pendingSteers: 0 } : {}),
        };
        this.manifest = manifest;
        if (this.progress !== null && this.progress.pendingSteers !== undefined) {
            this.progress = { ...this.progress, pendingSteers: 0 };
        }
        this.addWarning(reason);
        this.writeManifest();
        this.flushProgress(now);
        return manifest;
    }
    /**
     * Request cancellation. Writes the marker FIRST, then the caller kills.
     *
     * Marker before kill because the kill is asynchronous and a reader polling in
     * between must already see the intent. This is agy-staff's HAZARD B, kept for
     * the same reason it exists there: a cancellation caught mid-flight is still a
     * cancellation, and the worker may never get to write its own terminal state.
     */
    requestCancel(at = new Date().toISOString()) {
        if (this.finished)
            return;
        if (this.cancelRequestedAt === null) {
            this.cancelRequestedAt = at;
            createMarker(jobFile(this.repo, this.jobId, FILES.cancel), at);
            // Legacy readers treat a marker as already stopped. Keep the request
            // canonical until finish() publishes an acknowledged terminal state.
        }
    }
    /** Did this job get cancelled? True once a marker exists, terminal or not. */
    get cancelled() {
        return this.cancelRequestedAt !== null;
    }
    /** Latest conversation ID known to this writer (from start() or the provider's init event). */
    currentConversation() {
        return this.conversation;
    }
    /**
     * Stamp `supersededBy` in memory before `finish()` or `abort()` so the
     * terminal anchor write includes `supersededBy` atomically.
     */
    markSuperseded(nextJobId) {
        if (this.manifest === null)
            return;
        this.manifest = { ...this.manifest, supersededBy: nextJobId, pendingSteers: 0 };
        if (this.progress !== null) {
            this.progress = { ...this.progress, pendingSteers: 0 };
        }
    }
    /** Update the published count of unconsumed queued steers in the writer-owned files. */
    setPendingSteers(count, at = new Date().toISOString()) {
        if (this.finished || this.manifest === null)
            return;
        const next = Math.max(0, count);
        this.manifest = { ...this.manifest, pendingSteers: next, updatedAt: at };
        if (this.progress !== null) {
            this.progress = { ...this.progress, pendingSteers: next };
        }
        this.flushProgress(at);
    }
    /** Record a supervisor-level warning on this job's progress. */
    warn(message) {
        this.addWarning(message);
    }
    /**
     * The recent tool rows, in step order.
     *
     * Exposed so the pipeline runner can build `Observation[]` for routing.ts
     * without opening a second subscription to the provider's event stream — this
     * process already owns that stream.
     */
    activities() {
        return [...this.recent].sort((a, b) => a.stepIndex - b.stepIndex);
    }
    /** The current manifest, for a status() read that does not re-parse the file. */
    snapshot() {
        return this.manifest;
    }
    /* ── internals ─────────────────────────────────────────────────────────── */
    touch(at) {
        if (this.manifest === null)
            return;
        this.manifest = { ...this.manifest, updatedAt: at };
        this.progress = {
            jobId: this.jobId,
            name: this.manifest.name,
            workerId: this.manifest.workerId,
            role: this.manifest.role,
            latestSummary: this.manifest.latestSummary,
            summarySource: this.manifest.summarySource,
            lastEventAt: at,
            recentActivities: this.recent,
            lastActivity: this.lastActivity,
            latestText: this.latestText,
            toolCalls: this.toolCalls,
            // Always written, even 0: recovery must tell "no edit completed" from a pre-counter file.
            editsCompleted: this.editStepsCompleted.size,
            ...(this.toolErrorSteps.size === 0 ? {} : { toolErrors: this.toolErrorSteps.size }),
            ...(this.lastAliveAt === null ? {} : { lastAliveAt: this.lastAliveAt }),
            ...(this.workerPid === undefined ? {} : { workerPid: this.workerPid }),
            warnings: this.progress?.warnings ?? [],
            digest: this.tracker.digest(this.cwd),
            ...(this.progress?.pendingSteers !== undefined ? { pendingSteers: this.progress.pendingSteers } : {}),
        };
        const nowMs = Date.parse(at);
        const clock = Number.isNaN(nowMs) ? Date.now() : nowMs;
        if (shouldFlush(this.lastFlushMs, clock, this.flushMs))
            this.flushProgress(at);
    }
    noteFirstEvent(isError) {
        if (this.firstEventSeen)
            return;
        this.firstEventSeen = true;
        this.firstEventWasError = isError;
    }
    addWarning(message) {
        if (this.progress === null)
            return;
        if (this.progress.warnings.includes(message))
            return;
        this.progress = { ...this.progress, warnings: [...this.progress.warnings, message] };
    }
    /** Persist the anchor. Always whole, always atomic. */
    writeManifest() {
        if (this.manifest === null)
            return;
        writeJsonAtomic(jobFile(this.repo, this.jobId, FILES.job), this.manifest);
    }
    flushProgress(at) {
        if (this.progress === null)
            return;
        const progress = { ...this.progress, lastEventAt: at,
            name: this.manifest?.name, workerId: this.manifest?.workerId, role: this.manifest?.role,
            latestSummary: this.manifest?.latestSummary ?? null, summarySource: this.manifest?.summarySource ?? null };
        this.progress = progress;
        this.writeManifest();
        writeJsonAtomic(jobFile(this.repo, this.jobId, FILES.progress), progress);
        writeJsonAtomic(jobFile(this.repo, this.jobId, FILES.view), this.view);
        const ms = Date.parse(at);
        this.lastFlushMs = Number.isNaN(ms) ? Date.now() : ms;
    }
}
/* ── git baseline helpers ─────────────────────────────────────────────────── */
/** Per git call. AGENT_SMITH_GIT_TIMEOUT_MS raises it on slow or loaded machines, where a capped-out snapshot loses changedFiles. */
function gitCapMs() {
    const n = Number(process.env['AGENT_SMITH_GIT_TIMEOUT_MS']);
    return Number.isFinite(n) && n > 0 ? n : 2_000;
}
const TOOL_INPUTS_CAP = 200_000;
const CHANGED_FILES_SIG_CAP = 500;
function git(cwd, args) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, timeout: gitCapMs(), maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
}
/** HEAD + dirty paths, or null when cwd is not a git repo / git fails / is slow. */
async function gitSnapshot(cwd) {
    try {
        const [status, head] = await Promise.all([
            git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
            git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => ''),
        ]);
        return { head: head.trim() === '' ? null : head.trim(), dirty: parsePorcelainZ(status) };
    }
    catch {
        return null;
    }
}
/** Parse `status --porcelain=v1 -z`: `XY path\0`, renames/copies add `orig\0`. Exported for tests. */
function parsePorcelainZ(out) {
    const parts = out.split('\0');
    const paths = new Set();
    for (let i = 0; i < parts.length; i++) {
        const e = parts[i] ?? '';
        if (e.length < 4)
            continue;
        const xy = e.slice(0, 2);
        paths.add(e.slice(3));
        if (xy.includes('R') || xy.includes('C')) {
            const orig = parts[++i];
            if (orig)
                paths.add(orig);
        }
    }
    return [...paths].filter((p) => !isForgeStatePath(p)).sort();
}
async function gitCommittedPaths(cwd, from, to) {
    try {
        return (await git(cwd, ['diff', '--name-only', '-z', `${from}`, `${to}`])).split('\0').filter((p) => p !== '');
    }
    catch {
        return [];
    }
}
function fileSig(cwd, rel) {
    try {
        const full = path.join(cwd, rel);
        const st = statSync(full);
        if (!st.isFile())
            return 'gone';
        if (st.size <= 4 * 1024 * 1024) {
            const hash = createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 16);
            return `${st.size}:${hash}`;
        }
        return `${st.size}:${st.mtimeMs}`;
    }
    catch {
        return 'gone';
    }
}
function computeStaleReads(repo, cwd, watchedFiles, changedFiles) {
    if (!watchedFiles)
        return [];
    const entries = Object.entries(watchedFiles);
    if (entries.length === 0)
        return [];
    const repoRoot = path.resolve(repo);
    const cwdRoot = path.resolve(cwd);
    const sameRoot = repoRoot === cwdRoot;
    const workerChanged = new Set(changedFiles ?? []);
    const stale = [];
    for (const [rel, sigs] of entries) {
        const currentRepoSig = fileSig(repoRoot, rel);
        if (!sameRoot) {
            const currentCwdSig = fileSig(cwdRoot, rel);
            const externallyEditedInCwd = changedFiles !== undefined && currentCwdSig !== sigs.cwdSig && !workerChanged.has(rel);
            if (currentRepoSig !== sigs.repoSig || externallyEditedInCwd) {
                stale.push(rel);
            }
        }
        else if (currentRepoSig !== sigs.repoSig && !workerChanged.has(rel)) {
            stale.push(rel);
        }
    }
    return stale.sort();
}
/** Append `add` to `base`, bounded. Pure, so the bounding rule is testable. */
function appendBounded(base, add, max) {
    const joined = base === '' ? add : `${base}${add}`;
    if (joined.length <= max)
        return joined;
    // Cut from the FRONT: the newest text is what the pane shows, and a stale
    // opening paragraph is worth less than the sentence the worker just wrote.
    return joined.slice(joined.length - max);
}
/**
 * The last `max` chars of `text`, starting at a paragraph (else line) boundary
 * so the summary opens on a whole thought, not mid-sentence. A worker's
 * conclusion is at the end of its message. Pure; exported for tests.
 */
function summaryTail(text, max) {
    const t = text.trim();
    if (t.length <= max)
        return t;
    const tail = t.slice(t.length - max);
    for (const sep of ['\n\n', '\n']) {
        const i = tail.indexOf(sep);
        if (i >= 0 && tail.slice(i).trim() !== '')
            return tail.slice(i).trim();
    }
    return tail.trim();
}
function emptyManifest(jobId) {
    const now = new Date().toISOString();
    return {
        schema: SCHEMA_VERSION,
        jobId,
        provider: 'unknown',
        mode: 'unknown',
        model: null,
        effort: null,
        cwd: '',
        task: '',
        promptChars: 0,
        unrestricted: false,
        conversation: null,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        jobStatus: null,
        error: null,
        deniedActions: [],
        usage: null,
        toolCalls: 0,
        pipeline: null,
        stage: null,
        attempt: null,
    };
}
/**
 * Subscribe to a handle's events and drive this writer from them.
 *
 * Returns an unsubscribe. Event listeners run synchronously in stream order, so
 * this does no async work — the only awaits are in `onEvent`, and there are none.
 */
function pipeEvents(writer, handle) {
    return handle.onEvent((event) => {
        try {
            writer.onEvent(event);
        }
        catch {
            // A state write must never kill a worker that is otherwise fine. Losing
            // one progress snapshot costs one stale poll tick; killing the job costs
            // the user 28 minutes.
        }
    });
}
/** The report text a JobResult implies, under the headline rule. Exported for tests. */
function reportFor(result) {
    if (typeof result.response === 'string' && !looksEmpty$1(result.response))
        return result.response;
    return '';
}
/** Ordered previews use the same bounded budget as the other detail fields. */
function boundTimeline(input) {
    const events = [...input];
    let truncated = false;
    let chars = events.reduce((n, e) => n + (e.kind === 'assistant' ? e.text.length : 0), 0);
    let tools = events.filter(e => e.kind === 'tool').length;
    while (events.length > 1 && (events.length > 100 || chars > 64_000 || tools > 60)) {
        const removed = events.shift();
        if (removed.kind === 'assistant')
            chars -= removed.text.length;
        else
            tools--;
        truncated = true;
    }
    const first = events[0];
    if (first?.kind === 'assistant' && first.text.length > 64_000) {
        events[0] = { ...first, text: first.text.slice(-64e3) };
        truncated = true;
    }
    return { events, truncated };
}/**
 * forge/modes.ts — the closed set of job modes and what each one actually does.
 *
 * A mode sets ONLY provider-agnostic behavior: a line of guidance for the
 * worker's brief (forge/brief.ts) and a sandbox posture. It never picks a
 * provider or a model.
 *
 * The guidance gives the reason with the request. Workers follow a reason
 * better than a bare prohibition, and a reason also tells them what to do in
 * the cases a rule did not anticipate.
 */
const MODES = ['implement', 'review', 'moderate', 'verify'];
const MODE_PRESETS = Object.freeze({
    implement: {
        description: 'Make the change and report what changed and found.',
        guidance: 'Make the change, keeping it as small as the task allows. The orchestrator reviews the diff, and unrelated edits make that review harder. Say what you changed and why.',
        readOnly: false,
        runsCommands: true,
    },
    review: {
        description: 'Read-only review: report defects, missed cases and unsupported claims.',
        guidance: "Find problems; don't fix them. The author fixes from your findings, and your edits would change the work you're judging, so leave the files as they are. Give each defect, missed case or unsupported claim with its evidence (file:line, a failing input or command). Skip style nits unless asked.",
        readOnly: true,
        runsCommands: false,
    },
    moderate: {
        description: 'Independently probe prior work and reviewer findings; findings only.',
        guidance: "Test the earlier work and any reviewer's claims independently, and confirm or refute each one with evidence. Leave the files as they are: the author fixes from your findings, and your edits would change the work you're judging.",
        readOnly: true,
        runsCommands: false,
    },
    verify: {
        description: 'Run the checks and report what actually happened.',
        guidance: 'Run the checks and report exactly what happened, including the failing output. If something fails, report it rather than fixing it, so your result describes the work as it was handed to you.',
        readOnly: false,
        runsCommands: true,
    },
});
/**
 * The stage prompt a pipeline gives a review or moderate stage when the caller
 * supplies none. The MCP default pipeline and the CLI's single-stage run both
 * use it, so a stage is briefed the same way from either surface.
 */
const STAGE_PROMPTS = Object.freeze({
    review: 'Review the implementation and its supplied artifacts. Report defects with evidence; do not edit code.',
    moderate: 'Probe the implementation and reviewer findings against the original task. Report unresolved defects with evidence; do not edit code.',
});
function isMode(value) {
    return MODES.includes(value);
}/**
 * verify/runner.ts — run checks against the working tree, return a boolean.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE ORCHESTRATOR CONSUMES A VERDICT AND NOT PROSE
 *
 * The evidence: a real agy job reported "All tests pass with zero warnings"
 * while its own log tail showed `cargo test` exiting CODE 1 — twice. The job did
 * not lie maliciously; it summarized, the summary was fluent, and it was wrong
 * about a fact present in its own transcript. Alongside that, external checklist
 * 10/10 vs generic self-check 5/10 (p=0.0325), and self-assessment losing half its
 * runs with self-correction-by-prompting established as ineffective (TACL 2024).
 *
 * If the gate asked an LLM to read the test output and tell it whether things
 * worked, it would be re-implementing the exact step that produced the bad
 * summary, with the same failure mode: silent, fluent, wrong. An exit code has
 * no room for that. So this module's contract is deliberately narrow —
 *
 *     run a command in the working tree → return passed: boolean + evidence
 *
 * and the evidence is BOUNDED, because an unbounded log handed to a model is an
 * invitation to summarise it, which is the thing that fails. 8KB per stream,
 * same bound agy-staff uses, for the same reason.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY WE KILL THE PROCESS GROUP, NOT THE PID
 *
 * A check is not one process. `cargo test` builds, then runs a test binary;
 * `npm test` forks a runner that forks workers; `tsc` is fine but a lint rule
 * that shells out is not. Those grandchildren are real processes holding file
 * handles, CPU and — critically — write access to the working tree.
 *
 * `kill(pid)` reaps the shell we spawned and *orphans* everything below it. The
 * parent exits, our verdict resolves "failed/timed out", the pipeline moves on —
 * and a surviving grandchild keeps writing files into the tree we just declared
 * broken. That is not a resource leak, it is a correctness bug: the state the
 * next stage reads is being mutated by a process we believe is gone.
 *
 * So: `spawn(..., { detached: true })` makes the child a process-GROUP leader,
 * and cleanup signals the negative pid (`-pid`), which reaches every descendant
 * in the group. Order is SIGTERM, then SIGKILL after a grace period, because a
 * build step that catches SIGTERM still gets to clean up its own temp files while
 * the SIGKILL guarantees we never leave an orphan no matter what the child does.
 *
 * We also `unref` nothing and we always clear our timers, so the gate itself
 * cannot become the thing that keeps the process alive.
 * ─────────────────────────────────────────────────────────────────────────────
 */
/** Default cap per stream. Matches agy-staff's bound. */
const DEFAULT_TAIL_BYTES = 8 * 1024;
/** Grace between SIGTERM and SIGKILL when a check times out. */
const DEFAULT_KILL_GRACE_MS = 2_000;
/**
 * A bounded ring of the most recent bytes.
 *
 * WHY TAIL AND NOT HEAD: the failure is at the end. A head-truncated compiler
 * log shows you the invocation and drops the actual error. Ring keeps the tail,
 * which is the part a human needs to see the exact failing line.
 *
 * Bytes, not characters: a multi-byte char split by the cutoff must not produce a
 * replacement character in a log someone is about to paste into an issue.
 */
class TailBuffer {
    chunks = [];
    bytes = 0;
    dropped = 0;
    // Explicit field, not a constructor parameter property: `erasableSyntaxOnly` is
    // on in this project, so nothing here may require code generation.
    limit;
    constructor(limit) {
        this.limit = limit;
    }
    push(chunk) {
        if (chunk.length === 0)
            return;
        this.chunks.push(chunk);
        this.bytes += chunk.length;
        this.trim();
    }
    trim() {
        // Drop whole leading chunks while we are over budget and can afford to.
        while (this.bytes > this.limit) {
            const first = this.chunks[0];
            if (first === undefined)
                break;
            // Never remove the only chunk: a single chunk larger than the limit is
            // sliced instead, so `bytes` always reflects something we actually hold.
            if (this.chunks.length === 1) {
                const excess = first.length - this.limit;
                this.chunks[0] = first.subarray(excess);
                this.bytes -= excess;
                this.dropped += excess;
                break;
            }
            this.chunks.shift();
            this.bytes -= first.length;
            this.dropped += first.length;
        }
    }
    get truncated() {
        return this.dropped > 0;
    }
    text() {
        const buf = Buffer.concat(this.chunks);
        // Splitting a UTF-8 sequence mid-character would emit U+FFFD. Drop the
        // partial tail instead.
        const safe = buf.length > 0 && (buf[buf.length - 1] ?? 0) > 0x7f ? trimPartialUtf8(buf) : buf;
        const body = safe.toString('utf8');
        return this.dropped > 0 ? `[...${this.dropped} earlier bytes omitted...]\n${body}` : body;
    }
}
/** Remove an incomplete trailing UTF-8 sequence, if there is one. */
function trimPartialUtf8(buf) {
    let end = buf.length;
    // Walk back at most 3 bytes looking for a lead byte.
    for (let back = 1; back <= 3 && end - back > 0; back++) {
        const b = buf[end - back];
        if (b === undefined)
            continue;
        if ((b & 0xc0) === 0x80)
            continue; // continuation byte
        const need = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
        return end - back + need <= end ? buf.subarray(0, end - back + need) : buf;
    }
    return buf;
}
function describeExpectation(expect) {
    if (!expect || expect.kind === 'exit0')
        return 'exit code 0';
    if (expect.kind === 'exitN')
        return `exit code in {${expect.codes.join(', ')}}`;
    return expect.describe;
}
function evaluate(expect, observation) {
    if (!expect || expect.kind === 'exit0')
        return observation.exitCode === 0;
    if (expect.kind === 'exitN') {
        return observation.exitCode !== null && expect.codes.includes(observation.exitCode);
    }
    return expect.test(observation);
}
/**
 * Signal a whole process group, tolerating the process already being gone.
 *
 * `kill(-pid, sig)` is the group form. It throws ESRCH when the group is empty,
 * which is the normal case when the check finished on its own just as we timed
 * it out — that is success, not an error.
 */
function signalGroup(pid, signal) {
    if (pid === undefined || !Number.isFinite(pid))
        return;
    try {
        if (process.platform === 'win32') {
            // Windows has no process groups in this sense; spawn without detached so
            // the child is killable directly.
            process.kill(pid, signal);
        }
        else {
            process.kill(-pid, signal);
        }
    }
    catch (err) {
        const code = err.code;
        if (code === 'ESRCH')
            return; // already gone — the outcome we wanted
        if (code === 'EPERM')
            return; // not ours; nothing more we can do
        throw err;
    }
}
/**
 * Run ONE check. Resolves with a Verdict; never rejects.
 *
 * Rejecting would push error handling into the caller for a class of failure we
 * can describe precisely. A check that could not run is a failed check, with a
 * `skipped` reason and a reason string.
 */
function runCheck(check, options = {}) {
    const now = options.now ?? Date.now;
    const tailBytes = check.maxTailBytes ?? DEFAULT_TAIL_BYTES;
    const killGrace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const startedAt = now();
    const skip = (reason, why, blocking = check.blocking !== false) => ({
        passed: false,
        check,
        exitCode: null,
        signal: null,
        timedOut: false,
        stdoutTail: '',
        stderrTail: '',
        truncated: false,
        durationMs: now() - startedAt,
        skipped: reason,
        reason: why,
        // 'not-configured' is ABSENT, not broken: it must be visible in the report
        // but must not manufacture a failure no rerun could ever fix. The other two
        // reasons are real problems and do block.
        blocking: blocking && reason !== 'not-configured',
    });
    // Pre-flight: a missing working directory is the single most common config
    // error, and `spawn` would report it as a generic ENOENT on the *shell*.
    if (check.command.trim().length === 0) {
        return Promise.resolve(skip('not-configured', `check '${check.name}' has no command configured`));
    }
    if (!existsSync(check.cwd)) {
        return Promise.resolve(skip('missing-cwd', `check '${check.name}' cwd does not exist: ${check.cwd}`));
    }
    return new Promise((resolve) => {
        const stdout = new TailBuffer(tailBytes);
        const stderr = new TailBuffer(tailBytes);
        let timedOut = false;
        let settled = false;
        let childPid;
        let killTimer;
        let timeoutTimer;
        let onAbort;
        /**
         * Terminate the group, then guarantee it with SIGKILL.
         * Idempotent: safe to call from the timeout, from abort, and from 'close'.
         */
        const terminate = () => {
            if (childPid === undefined)
                return;
            signalGroup(childPid, 'SIGTERM');
            if (killTimer)
                clearTimeout(killTimer);
            killTimer = setTimeout(() => signalGroup(childPid, 'SIGKILL'), killGrace);
            // Do not let our own SIGKILL timer hold the event loop open.
            killTimer.unref?.();
        };
        const finish = (exitCode, signal) => {
            if (settled)
                return;
            settled = true;
            if (timeoutTimer)
                clearTimeout(timeoutTimer);
            if (killTimer)
                clearTimeout(killTimer);
            if (onAbort && options.signal)
                options.signal.removeEventListener('abort', onAbort);
            const observation = {
                check: check.name,
                exitCode,
                signal,
                timedOut,
                stdout: stdout.text(),
                stderr: stderr.text(),
                durationMs: now() - startedAt,
            };
            const passed = evaluate(check.expect, observation);
            let reason;
            if (timedOut) {
                reason = `timed out after ${check.timeoutMs}ms (killed process group; expecting ${describeExpectation(check.expect)})`;
            }
            else if (signal !== null) {
                reason = `killed by SIG${signal} (expecting ${describeExpectation(check.expect)})`;
            }
            else if (exitCode === 0) {
                reason = `exit 0 (${describeExpectation(check.expect)})`;
            }
            else {
                reason = `exit ${exitCode ?? 'null'}, expecting ${describeExpectation(check.expect)}`;
            }
            resolve({
                passed,
                check,
                exitCode,
                signal,
                timedOut,
                stdoutTail: observation.stdout,
                stderrTail: observation.stderr,
                truncated: stdout.truncated || stderr.truncated,
                durationMs: observation.durationMs,
                reason,
                blocking: check.blocking !== false,
            });
        };
        const posix = process.platform !== 'win32';
        const [shell, shellArgs] = posix
            ? ['/bin/sh', ['-c', check.command]]
            : ['cmd.exe', ['/d', '/s', '/c', check.command]];
        let child;
        try {
            child = spawn(shell, [...shellArgs], {
                cwd: check.cwd,
                env: { ...process.env, ...(check.env ?? {}) },
                stdio: ['ignore', 'pipe', 'pipe'],
                // Group leader: enables kill(-pid) for the whole tree. See the header.
                detached: posix,
            });
        }
        catch (err) {
            resolve(skip('spawn-failed', `check '${check.name}' could not start: ${err instanceof Error ? err.message : String(err)}`));
            return;
        }
        childPid = child.pid;
        child.stdout?.on('data', (chunk) => stdout.push(chunk));
        child.stderr?.on('data', (chunk) => stderr.push(chunk));
        // A read error on a pipe must not take the process down; the check still ran.
        child.stdout?.on('error', () => { });
        child.stderr?.on('error', () => { });
        if (check.timeoutMs > 0) {
            timeoutTimer = setTimeout(() => {
                timedOut = true;
                terminate();
            }, check.timeoutMs);
            timeoutTimer.unref?.();
        }
        if (options.signal) {
            onAbort = () => terminate();
            if (options.signal.aborted)
                onAbort();
            else
                options.signal.addEventListener('abort', onAbort, { once: true });
        }
        child.on('error', (err) => {
            if (err.code === 'ENOENT') {
                resolve(skip('spawn-failed', `shell not found for check '${check.name}'`));
                return;
            }
            // Fall back to a failed verdict rather than throwing: an unreadable pipe
            // or a failed kill is a fact about the check, not an exception for the
            // caller to unwrap.
            resolve(skip('spawn-failed', `check '${check.name}' failed to run: ${err.message}`));
        });
        child.on('close', (code, signal) => finish(code, signal));
    });
}
/**
 * Run a set of checks and reduce them to one report.
 *
 * Checks are independent by construction, so they run concurrently; a
 * typecheck and a lint pass nothing to each other and waiting for one before
 * starting the other doubles the wall clock of every gate for nothing.
 */
async function runChecks(checks, options = {}) {
    const started = (options.now ?? Date.now)();
    const limit = Math.max(1, Math.floor(options.concurrency ?? 4));
    const verdicts = [];
    let cursor = 0;
    let stop = false;
    const worker = async () => {
        for (;;) {
            if (stop)
                return;
            const index = cursor++;
            const check = checks[index];
            if (check === undefined)
                return;
            try {
                options.onCheck?.({ check, state: 'start' });
            }
            catch { /* a progress hook must not fail a check */ }
            const verdict = await runCheck(check, options);
            try {
                options.onCheck?.({ check, state: 'end' });
            }
            catch { /* as above */ }
            verdicts[index] = verdict;
            if (options.failFast && !verdict.passed && verdict.blocking)
                stop = true;
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, checks.length) }, worker));
    const present = verdicts.filter((v) => v !== undefined);
    // Only blocking failures fail the report. A check the caller explicitly marked
    // non-blocking is reported but does not manufacture a red gate.
    const failing = present.filter((v) => !v.passed && v.blocking);
    return {
        passed: failing.length === 0,
        verdicts: present,
        failing,
        durationMs: (options.now ?? Date.now)() - started,
        incomplete: present.some((v) => v.skipped !== undefined),
    };
}/**
 * forge/checks.ts — executable acceptance, shared by pipeline stages and spawn_job.
 *
 * Completion proves execution only. Acceptance is a separate fact, derived from
 * exit codes of checks run against the working tree (verify/runner.ts), never
 * from anything the worker wrote.
 *
 * Rules (`evaluateAcceptance`):
 *   - job did not succeed (failed/canceled)  -> 'rejected'  (checks are NOT run:
 *     a failed job's tree is not a candidate for acceptance)
 *   - no checks configured                    -> 'unchecked'
 *   - job succeeded, all blocking checks pass -> 'accepted'
 *   - job succeeded, a blocking check fails   -> 'rejected'
 *   Non-blocking checks (blocking: false) are reported but never gate.
 */
const ACCEPTANCE_FILE = 'acceptance.json';
const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
const ACCEPTANCE_GRACE_MS = 30_000;
const ACCEPTANCE_BUDGET_CAP_MS = 30 * 60_000;
/** Upper bound on how long checks can run: their timeouts summed (they may overlap), plus a grace, capped. */
function acceptanceBudgetMs(checks) {
    const total = checks.reduce((sum, c) => sum + (c.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS), 0);
    return Math.min(ACCEPTANCE_BUDGET_CAP_MS, total + ACCEPTANCE_GRACE_MS);
}
/** The placeholder written at spawn: checks will run once the job ends. */
function pendingAcceptance(checks) {
    return { state: 'unchecked', checks: [], pending: true, ...(checks?.length ? { budgetMs: acceptanceBudgetMs(checks) } : {}) };
}
/** Normalize a runner report into the persisted acceptance shape. */
function acceptanceChecksFromReport(report, configuredChecks) {
    return report.verdicts.map((v, index) => {
        const configured = configuredChecks[index];
        // runCheck deliberately treats an empty command as absent/non-blocking for
        // generic callers. At an acceptance boundary, a declared required check
        // that never ran must still fail closed.
        const blocking = v.skipped === 'not-configured'
            ? configured.blocking !== false
            : v.blocking;
        return {
            name: v.check.name, ok: v.passed, exitCode: v.exitCode, durationMs: v.durationMs, blocking,
            timedOut: v.timedOut, signal: v.signal,
            ...(v.skipped === undefined ? {} : { skipped: v.skipped }),
            ...(v.reason === undefined ? {} : { reason: v.reason }),
            outputTail: `${v.stdoutTail}${v.stderrTail === '' ? '' : `\n${v.stderrTail}`}`.slice(-2e3),
        };
    });
}
/** Apply configured acceptance policy to the generic runner report. */
function normalizeAcceptanceReport(report, configuredChecks) {
    const verdicts = report.verdicts.map((verdict, index) => {
        const configured = configuredChecks[index];
        const blocking = verdict.skipped === 'not-configured'
            ? configured.blocking !== false
            : verdict.blocking;
        return blocking === verdict.blocking ? verdict : { ...verdict, blocking };
    });
    const failing = verdicts.filter((verdict) => !verdict.passed && verdict.blocking);
    return {
        ...report,
        verdicts,
        failing,
        passed: failing.length === 0,
        incomplete: verdicts.some((verdict) => verdict.skipped !== undefined && verdict.blocking),
    };
}
function acceptanceState(checks) {
    return checks.some((check) => check.blocking && !check.ok) ? 'rejected' : 'accepted';
}
/** StageCheck -> verify Check, resolving cwd against baseDir. */
function toVerifyChecks(checks, baseDir) {
    return checks.map((check) => ({
        name: check.name,
        command: check.command,
        cwd: path.resolve(baseDir, check.cwd ?? '.'),
        timeoutMs: check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
        ...(check.blocking === undefined ? {} : { blocking: check.blocking }),
    }));
}
/**
 * Run the checks once and return both the persisted verdict and the raw report.
 * Pipeline stages need the report (its verdicts become stage evidence); every
 * other caller only wants the Acceptance, via `evaluateAcceptance`.
 */
async function evaluateAcceptanceReport(input) {
    const stamp = () => (input.now ?? (() => new Date()))().toISOString();
    if (!input.checks?.length)
        return { acceptance: { state: 'unchecked', checks: [], at: stamp() }, report: null };
    if (!input.succeeded) {
        return { acceptance: { state: 'rejected', checks: [], at: stamp(), reason: 'job did not succeed; checks not run' }, report: null };
    }
    const running = new Set();
    const rawReport = await runChecks(toVerifyChecks(input.checks, input.baseDir), {
        signal: input.signal,
        ...(input.onProgress === undefined ? {} : {
            onCheck: ({ check, state }) => {
                if (state === 'start')
                    running.add(check.name);
                else
                    running.delete(check.name);
                input.onProgress([...running]);
            },
        }),
    });
    const report = normalizeAcceptanceReport(rawReport, input.checks);
    const checks = acceptanceChecksFromReport(report, input.checks);
    return { acceptance: { state: acceptanceState(checks), at: stamp(), checks }, report };
}
async function evaluateAcceptance(input) {
    return (await evaluateAcceptanceReport(input)).acceptance;
}
function writeAcceptance(repo, jobId, acceptance) {
    writeJsonAtomic(path.join(jobDir(repo, jobId), ACCEPTANCE_FILE), acceptance);
}
/**
 * The placeholder written when a job is prepared, before it is terminal, so a
 * reader can tell "checks still to run" from "no checks attached". With the
 * checks it also records how long they may take (`budgetMs`).
 */
function markAcceptancePending(repo, jobId, checks) {
    writeAcceptance(repo, jobId, pendingAcceptance(checks));
}
/** A steered job's earlier turns never get checks of their own; the final turn carries the verdict. */
function markAcceptanceSuperseded(repo, jobId) {
    writeAcceptance(repo, jobId, { state: 'unchecked', checks: [], reason: 'superseded by steered turn' });
}
/**
 * evaluateAcceptance for a job on disk: keeps acceptance.json's pending placeholder
 * current with the checks running, then returns the verdict (the caller writes it).
 * An abort records `unchecked: checks canceled` instead of a verdict from killed checks.
 */
async function runAcceptance(input) {
    const budgetMs = acceptanceBudgetMs(input.checks ?? []);
    const startedAt = new Date().toISOString();
    const acceptance = await evaluateAcceptance({
        succeeded: input.succeeded, checks: input.checks, baseDir: input.baseDir,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.now === undefined ? {} : { now: input.now }),
        onProgress: (running) => {
            try {
                writeAcceptance(input.repo, input.jobId, {
                    state: 'unchecked', checks: [], pending: true, budgetMs, startedAt,
                    ...(running.length > 0 ? { running: running.join(', ') } : {}),
                });
            }
            catch { /* progress is advisory; the verdict write is not */ }
        },
    });
    return input.signal?.aborted
        ? { state: 'unchecked', checks: [], at: acceptance.at ?? startedAt, reason: 'checks canceled' }
        : acceptance;
}
/**
 * Evaluate the finished job (progress and cancel as in `runAcceptance`), record
 * the verdict on its final turn, and mark every other prepared turn superseded.
 * Returns the verdict written.
 */
async function settleAcceptance(input) {
    const acceptance = await runAcceptance({ ...input, jobId: input.finalJobId });
    writeAcceptance(input.repo, input.finalJobId, acceptance);
    for (const id of input.preparedJobIds)
        if (id !== input.finalJobId)
            markAcceptanceSuperseded(input.repo, id);
    return acceptance;
}
/** Sidecar contents, or {state:'unchecked'} when absent or unreadable. */
function readAcceptance(repo, jobId) {
    try {
        const parsed = JSON.parse(readFileSync(path.join(jobDir(repo, jobId), ACCEPTANCE_FILE), 'utf8'));
        return typeof parsed?.state === 'string' ? parsed : { state: 'unchecked' };
    }
    catch {
        return { state: 'unchecked' };
    }
}/**
 * runner.ts — the StageRunner that pipeline/ has been waiting for since it was
 * written.
 *
 * pipeline/types.ts declares the injection point and pipeline/pipeline.ts ships
 * `createRunnerRouter`, and nothing has ever supplied one. So the DAG runner
 * could not be executed, which is why the architecture's headline example —
 * implement in agy, review in Codex, moderate in Claude, independent stages
 * concurrent — was a diagram rather than a feature.
 *
 * This file supplies it, and it is thin on purpose: pipeline/ owns scheduling,
 * concurrency, skip propagation and escalation; providers/ owns argv and streams;
 * forge/ owns state. All this file does is translate one `StageContext` into one
 * `spawnJob` call and one `JobResult` back into one `StageResult`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE THINGS A RUNNER OWNS, AND WHY THEY ARE NOT IN THE DAG
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. THE PROMPT. A stage's prompt NAMES upstream stages; it does not contain
 *    their work. pipeline/types.ts is explicit that stages hand off PATHS, not
 *    prose: "a summary written by a model is the thing most likely to be
 *    confidently wrong". So the runner reads the upstream artifacts off disk and
 *    inlines them, capped, AND gives the absolute path so the worker can read
 *    more itself. Same reasoning as verify/runner.ts's "prose is not a verdict".
 *
 * 2. CONTINUATION, NOT RESTART. On attempt > 1 the runner passes
 *    `ctx.continuation.transcriptRef` as the provider's resume handle and
 *    prepends `appendedContext` to the prompt. Our agy adapter maps that onto
 *    `--conversation <id>` (a VERIFIED flag), so an escalation resumes the
 *    worker's own conversation instead of re-paying for everything it already
 *    read. This is pipeline/routing.ts RULE 3, and the only place in the repo
 *    where that rule is actually wired to a CLI. A stage with `continues` uses the same
 *    path on attempt 1: `ctx.continues` carries the target stage's conversation and
 *    worker identity, so the fix stage resumes the implementer it follows.
 *
 * 3. ARTIFACT PLACEMENT. Every stage gets its OWN directory under the pipeline
 *    work dir — `<workDir>/<stage.name>/` — and writes `result.md` inside it.
 *    pipeline.ts's `inputsFor()` hands downstream stages a bare relative path
 *    (`resultPath ?? 'result.md'`) with no stage qualifier, so three stages
 *    sharing one directory would have stage two overwrite stage one's artifact:
 *    the `moderate` stage would then be moderating its own review. Per-stage
 *    directories make that impossible, and the `resultPath` we report back is
 *    qualified with the stage name so `inputsFor()` resolves correctly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OBSERVATIONS ARE FACTS, NOT CONCLUSIONS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * routing.ts escalates on `Observation[]`. We report tool calls as 'tool' and
 * NEVER as 'edit' or 'verification', because a generic event stream does not tell
 * us whether a `write_file` was an edit or a scratch file, and
 * `edit-churn-unverified` is a stall verdict that would be a lie. Under-reporting
 * makes escalation conservative; over-reporting makes it spend on a bad
 * inference.
 */
/**
 * How much of each upstream artifact we inline into the prompt.
 *
 * 12 KB per artifact, 48 KB total. Enough for a review to see the diff and a
 * moderate to see the finding; not enough to blow a context window on a stage
 * that can read the file itself. The cap is ANNOUNCED in the prompt when it
 * bites, so a truncated input is never silently truncated.
 */
const ARTIFACT_INLINE_CHARS = 12_000;
const TOTAL_INLINE_CHARS = 48_000;
/** Tail of the worker's own words attached to a StageResult. Bounded, diagnostics only. */
const OUTPUT_TAIL_CHARS = 4_000;
/** Per-stage subdirectory under the pipeline work dir. Pure. */
function stageDir(workDir, stage) {
    validateStageName(stage);
    return path.join(workDir, stage);
}
/** The artifact a stage produces: `<workDir>/<stage>/<resultPath>`. Pure. */
function stageArtifactPath(workDir, stage, resultPath) {
    const base = stageDir(workDir, stage);
    const relative = resultPath ?? 'result.md';
    validateArtifactRelative(relative);
    const resolved = path.resolve(base, relative);
    if (!resolved.startsWith(`${path.resolve(base)}${path.sep}`)) {
        throw new Error(`stage artifact path escapes its stage directory: "${relative}"`);
    }
    return resolved;
}
/** The pipeline-relative artifact path we report back, so `inputsFor()` resolves it. */
function stageArtifactRef(stage, resultPath) {
    validateStageName(stage);
    validateArtifactRelative(resultPath ?? 'result.md');
    return `${stage}/${resultPath ?? 'result.md'}`;
}
function validateStageName(stage) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(stage) || stage === '.' || stage === '..') {
        throw new Error(`invalid stage name "${stage}"`);
    }
}
function validateArtifactRelative(relative) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((segment) => segment === '..' || segment === '.')) {
        throw new Error(`invalid stage artifact path "${relative}"`);
    }
}
/**
 * Resolve an upstream artifact to readable text.
 *
 * LENIENT ON PURPOSE, and the leniency is ordered. `pipeline.ts` hands us a bare
 * `result.md` with no stage qualifier, but we wrote ours at
 * `<workDir>/<stage>/result.md`. So we try, in order:
 *
 *   1. the path as given, resolved against the pipeline work dir
 *   2. `<workDir>/<input.stage>/result.md` — the location we actually wrote
 *   3. `<workDir>/result.md` — the literal `result.md`, for a hand-placed file
 *
 * Returning null rather than throwing is required: an artefact that has gone
 * missing must cost ONE INPUT, not the whole stage. A review with no diff in its
 * context still has the absolute path and can read it itself.
 */
function readArtifact(workDir, input, limit = ARTIFACT_INLINE_CHARS) {
    const candidates = [
        resolveInside(workDir, input.path),
        resolveStageInput(workDir, input.stage, input.path),
        safeStageDefault(workDir, input.stage),
        resolveInside(workDir, 'result.md'),
    ].filter((candidate) => candidate !== null);
    if (candidates.length === 0)
        return { text: null, from: input.path, truncated: false };
    for (const candidate of candidates) {
        let body;
        try {
            body = readFileSync(candidate, 'utf8');
        }
        catch {
            continue;
        }
        const truncated = body.length > limit;
        return {
            text: truncated ? `${body.slice(0, limit)}\n…[truncated]` : body,
            from: candidate,
            truncated,
        };
    }
    return { text: null, from: candidates[0] ?? input.path, truncated: false };
}
function resolveInside(root, relative) {
    if (path.isAbsolute(relative))
        return null;
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, relative);
    return resolved.startsWith(`${resolvedRoot}${path.sep}`) ? resolved : null;
}
function resolveStageInput(root, stage, relative) {
    try {
        return resolveInside(stageDir(root, stage), relative);
    }
    catch {
        return null;
    }
}
function safeStageDefault(root, stage) {
    try {
        return stageArtifactPath(root, stage);
    }
    catch {
        return null;
    }
}
/**
 * Compose the prompt for one attempt.
 *
 * PURE, and therefore the most testable function in this file: its three inputs
 * are the stage's own prompt, the upstream artefacts, and (on a retry) the
 * continuation. Everything about escalation quality lives in this string, so it
 * is a pure function rather than something assembled inline inside `run()`.
 *
 * The continuation goes FIRST, deliberately. On attempt 2 the worker's most
 * important fact is "you already tried this and here is what went wrong", and a
 * trailing paragraph after a re-stated task is a paragraph the model reads last.
 */
function buildStagePrompt(args) {
    const parts = [];
    if (args.continuation !== undefined) {
        parts.push(`CONTINUE, DO NOT RESTART. This is attempt ${args.attempt} at stage '${args.stage.name}'. ` +
            (args.canResumeTranscript === false
                ? 'Keep the previous attempt’s repository changes and use the supplied failure context; the prior provider session cannot be resumed.'
                : 'Your previous attempt already did work you should keep; resume from where you stopped rather than re-reading the repository from scratch.'), '', 'What went wrong last time:', appendBounded('', args.continuation.appendedContext, 6_000), '');
    }
    parts.push(`SOURCE WORKSPACE: ${args.workDir}`, 'Search, run commands and make any code changes in the source workspace. The output artifact directory is only for stage handoff files.', '', args.stage.prompt ?? `Carry out the '${args.stage.name}' stage and write your findings to result.md.`);
    if (args.inputs.length > 0) {
        parts.push('', 'INPUTS FROM UPSTREAM STAGES (the artefacts themselves, not summaries of them):');
        let budget = TOTAL_INLINE_CHARS;
        for (const input of args.inputs) {
            if (budget <= 0) {
                parts.push(`- ${input.stage}: inline budget exhausted — read ${input.path} yourself.`);
                continue;
            }
            const limit = Math.min(ARTIFACT_INLINE_CHARS, budget);
            const found = readArtifact(args.artifactRoot ?? args.workDir, input, limit);
            if (found.text === null) {
                parts.push(`- ${input.stage}: not found on disk — try ${found.from}.`);
                continue;
            }
            budget -= found.text.length;
            parts.push('', `--- from stage '${input.stage}' (${found.from})${found.truncated ? ' [truncated]' : ''} ---`, found.text);
        }
    }
    // The service prepends the worker brief, whose review/moderate guidance says to
    // leave the files as they are. A stage still has to write its artifact, so say
    // which write is allowed instead of leaving the two instructions to collide.
    const mode = args.stage.role ?? args.stage.name;
    const readOnly = isMode(mode) && MODE_PRESETS[mode].readOnly;
    parts.push('', 'OUTPUT ARTIFACT (separate from the source workspace):', ...(readOnly
        ? ['This is a read-only stage: leave every file in the source workspace as it is. ' +
                'Writing the output artifact below is your only permitted write, and it is where your findings go.']
        : []), `Write your full answer to ${stageArtifactPath(args.artifactRoot ?? args.workDir, args.stage.name, args.stage.resultPath)}. ` +
        'That file is what the next stage reads; a summary you say in prose is not.');
    return parts.join('\n');
}
/** One provider tool call → one routing Observation. Pure. */
function toObservation(activity) {
    const bad = activity.status === 'error' || activity.status === 'denied';
    return {
        turn: activity.stepIndex,
        // Never 'edit' or 'verification' — see the header. We do not know.
        kind: bad ? 'error' : 'tool',
        tool: activity.tool,
        ok: !bad,
        ...(bad
            ? { message: `tool ${activity.tool} ${activity.status}` }
            : activity.input === undefined
                ? {}
                : { target: activity.input.slice(0, 200) }),
    };
}
/** Build the StageRunner. One closure over the service; nothing global. */
function createForgeRunner(deps) {
    const runId = deps.runId ?? `run-${Date.now()}-${randomBytes(5).toString('hex')}`;
    const artifactRoot = pipelineArtifactRoot(deps.service.repo, runId);
    async function run(ctx) {
        const startedAt = Date.now();
        const stage = ctx.stage;
        const continuation = ctx.continuation;
        const sameProvider = continuation?.transcriptProvider === undefined || continuation.transcriptProvider === ctx.routing.provider;
        // A retry that continues this stage's own conversation already has the brief,
        // context and checks from attempt 1; only a fresh conversation needs them.
        const continuesAttempt = sameProvider && continuation?.transcriptRef !== undefined;
        const request = {
            mode: stage.role ?? stage.name,
            name: stage.agentName ?? ctx.continues?.agentName,
            workerId: stage.workerId ?? (ctx.continues === undefined ? `${runId}:${stage.name}` : ctx.continues.workerId ?? `${runId}:${ctx.continues.stage}`),
            task: stage.title ?? stage.prompt,
            prompt: buildStagePrompt({
                stage,
                workDir: ctx.workDir,
                artifactRoot,
                inputs: ctx.inputs,
                attempt: ctx.attempt,
                ...(continuation === undefined ? {} : { continuation }),
                canResumeTranscript: continuation?.transcriptRef === undefined || continuation.transcriptProvider === undefined || continuation.transcriptProvider === ctx.routing.provider,
            }),
            provider: ctx.routing.provider,
            cwd: ctx.workDir,
            artifactPath: path.resolve(stageArtifactPath(artifactRoot, stage.name, stage.resultPath)),
            ...(continuesAttempt ? {} : { context: stage.context, checks: stage.checks }),
            // 0 means "use the service default" (clampTimeout's DEFAULT_TIMEOUT_MS).
            // A stage timeout is ALSO enforced by the DAG via ctx.signal, so this is a
            // second, independent line of defence rather than the only one.
            timeoutMs: stage.timeoutMs ?? 0,
            unrestricted: deps.unrestricted,
            ...(stage.env === undefined ? {} : { env: stage.env }),
            pipeline: ctx.pipeline,
            stage: stage.name,
            attempt: ctx.attempt,
            ...(ctx.routing.model === undefined ? {} : { model: ctx.routing.model }),
            // routing RULE 1: `low` unless routing moved the rung. Passing it through
            // is exactly right — the pipeline owns the rung, we do not second-guess.
            ...(stage.effort === undefined && ctx.routing.tier === 't0-cheap' ? {} : { effort: ctx.routing.effort }),
            // routing RULE 3: continue, do not restart.
            ...(sameProvider
                ? { conversation: continuation?.transcriptRef ?? ctx.continues?.transcriptRef ?? stage.conversation }
                : {}),
        };
        let jobId;
        try {
            mkdirSync(path.dirname(stageArtifactPath(artifactRoot, stage.name, stage.resultPath)), { recursive: true });
            const tracked = await deps.service.spawnTracked(request);
            jobId = tracked.ack.jobId;
            // As spawn_job does: the job reads "checks pending" until a verdict exists.
            if (stage.checks?.length)
                recordAcceptance(deps.service.repo, jobId, pendingAcceptance(stage.checks));
            deps.onStageRunning?.({
                stage: stage.name, jobId, status: 'running', provider: ctx.routing.provider,
                ...(ctx.routing.model === undefined ? {} : { model: ctx.routing.model }),
                // The record's required timing fields: only startedAt is meaningful until the stage ends.
                startedAt, finishedAt: startedAt, durationMs: 0,
            });
            // The DAG aborts a stage by firing ctx.signal; the worker is a separate
            // process, so the bridge is `cancel`.
            const onAbort = () => {
                try {
                    deps.service.cancel(jobId);
                }
                catch {
                    /* already terminal, or never started */
                }
            };
            if (ctx.signal.aborted)
                onAbort();
            else
                ctx.signal.addEventListener('abort', onAbort, { once: true });
            // Collect the facts routing.ts escalates on, while the job runs. The tap
            // is a poll of our OWN state (half a second, one small JSON read) rather
            // than a second subscription to the provider's event stream: the service
            // already owns that stream, and these observations are only useful after
            // the attempt has ended anyway.
            const collection = collectObservations(deps.service, jobId, stage.name, deps.onObservation);
            const manifest = await tracked.done;
            const observations = await collection;
            publishArtifact(deps.service.repo, jobId, stage, artifactRoot);
            const result = toStageResult(stage, ctx, manifest, observations, startedAt, artifactRoot);
            if (!stage.checks?.length)
                return manifest.status === 'succeeded' ? { ...result, acceptance: 'unchecked' } : result;
            const { acceptance, report } = await evaluateAcceptanceReport({
                succeeded: manifest.status === 'succeeded', checks: stage.checks, baseDir: ctx.workDir, signal: ctx.signal,
            });
            recordAcceptance(deps.service.repo, jobId, acceptance);
            // No report means the job did not succeed, so no checks ran.
            if (report === null)
                return result;
            const checkEvidence = report.verdicts.map((verdict) => `${verdict.passed ? 'PASS' : 'FAIL'} ${verdict.check.name}: ${verdict.reason}`).join('\n');
            if (report.passed && !report.incomplete)
                return { ...result, acceptance: 'passed', verification: report };
            const failedChecks = report.verdicts.filter((verdict) => !verdict.passed && verdict.blocking);
            return {
                ...result,
                status: 'failed',
                acceptance: 'failed',
                verification: report,
                failure: {
                    code: 'verification-failed',
                    message: failedChecks.map((verdict) => `${verdict.check.name}: ${verdict.reason}`).join('; ') || 'verification did not complete',
                    retryable: true,
                    detail: report,
                },
                ...(checkEvidence === '' ? {} : { outputTail: appendBounded(result.outputTail ?? '', `\n\nExecutable checks:\n${checkEvidence}`, OUTPUT_TAIL_CHARS) }),
            };
        }
        catch (err) {
            const t = Date.now();
            return {
                stage: stage.name,
                provider: ctx.routing.provider,
                ...(ctx.routing.model === undefined ? {} : { model: ctx.routing.model }),
                status: 'failed',
                startedAt,
                finishedAt: t,
                durationMs: t - startedAt,
                failure: {
                    code: 'spawn-failed',
                    message: err instanceof Error ? err.message : String(err),
                    retryable: false,
                },
            };
        }
    }
    return { id: 'forge', run };
}
/** Persist the stage job's acceptance beside its record. A failed write must not fail the stage. */
function recordAcceptance(repo, jobId, acceptance) {
    try {
        writeAcceptance(repo, jobId, acceptance);
    }
    catch (err) {
        process.stderr.write(`agent-smith acceptance ${jobId}: ${String(err)}\n`);
    }
}
/* ── observation collection ──────────────────────────────────────────────── */
/**
 * Poll the job's own activity rows for the whole attempt.
 *
 * Turn numbers are the tool step index, which is monotonic within a job. That is
 * what makes routing.ts's "N consecutive turns with no tool call" rule mean what
 * it says rather than count stream events.
 *
 * Bounded on purpose: routing's stall rules are thresholds over a shape, and a
 * 5,000-element observation array is neither cheaper to analyse nor more
 * informative than the tail that contains the stall. See ACTIVITY_TAIL.
 */
async function collectObservations(service, jobId, stage, onObservation) {
    const out = [];
    // A tool step is one row that moves active -> done/error/denied, so a step's
    // identity is its index and a later state replaces the earlier one.
    const slots = new Map();
    const states = new Map();
    for (;;) {
        const rows = await service.activities(jobId);
        let progressed = false;
        for (const row of rows) {
            const key = `${row.tool}:${row.status}`;
            if (states.get(row.stepIndex) === key)
                continue;
            states.set(row.stepIndex, key);
            progressed = true;
            const obs = toObservation(row);
            const slot = slots.get(row.stepIndex);
            if (slot === undefined) {
                slots.set(row.stepIndex, out.length);
                out.push(obs);
            }
            else
                out[slot] = obs;
            try {
                onObservation?.(stage, obs);
            }
            catch {
                /* an observer's problem */
            }
        }
        // Terminal means done. `unknown` is NOT terminal: an unreadable anchor is
        // not an ending, and stopping on it would silently truncate every
        // observation series the moment a reader raced a write.
        const state = await service.state(jobId);
        if (!progressed && state !== 'running')
            break;
        if (state !== 'running' && state !== 'unknown')
            break;
        await sleep(500);
    }
    return out.slice(-400);
}
/** Stable root for one pipeline invocation's handoff artifacts. */
function pipelineArtifactRoot(repo, runId) {
    return path.join(repo, '.agent-smith', 'pipelines', safeSegment(runId), 'artifacts');
}
function safeSegment(value) {
    return value.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100) || 'pipeline';
}
function sleep(ms) {
    // This poll is part of the supervisor's durability path. In particular after
    // cancellation it must keep the process alive long enough to collect the
    // terminal job state and persist the pipeline record.
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Copy the job's report to the pipeline's artefact path.
 *
 * The job directory holds the canonical report (that is the state format's
 * `result.md`); the stage directory holds what the DAG hands downstream. Same
 * bytes, two homes, because the two consumers are different systems and neither
 * should have to know about the other. Best effort: a missing report is not an
 * error here, because the stage may legitimately have produced none.
 */
function publishArtifact(repo, jobId, stage, workDir) {
    const from = jobFile(repo, jobId, FILES.report);
    const to = stageArtifactPath(workDir, stage.name, stage.resultPath);
    // Workers often write the requested file themselves, with substantially more
    // useful detail than the bounded text returned in the provider result.
    if (existsSync(to))
        return;
    try {
        mkdirSync(path.dirname(to), { recursive: true });
        copyFileSync(from, to);
    }
    catch {
        /* no report, or the artifact is unwritable; the StageResult carries the verdict */
    }
}
/* ── result mapping ──────────────────────────────────────────────────────── */
/**
 * One `ForgeManifest` → one `StageResult`.
 *
 * The artifact paths are returned on FAILURE too, deliberately. pipeline.ts's
 * `inputsFor()` propagates a skipped stage's declared artefacts to its own
 * dependents, and a human debugging a partial run needs to read the failed
 * stage's report to find out why. A StageResult with no `resultPath` and a
 * failure is the least informative thing this function could produce.
 *
 * `passed` requires the writer's verdict, which deriveStatus already refuses to
 * call `succeeded` for an empty report. The second condition here is that the
 * artefact exists on disk: the StageResult is the DAG's verdict, the DAG has no
 * reader for a manifest, and "the worker said it passed but there is nothing to
 * hand the next stage" is the failure mode a DAG cannot recover from.
 */
function toStageResult(stage, ctx, manifest, observations, startedAt, workDir) {
    const finishedAt = Date.now();
    const durationMs = finishedAt - startedAt;
    const ref = stageArtifactRef(stage.name, stage.resultPath);
    const artifact = path.resolve(stageArtifactPath(workDir, stage.name, stage.resultPath));
    const report = readTail(artifact);
    // Listing a file that is not there sends the next stage after a ghost.
    const written = existsSync(artifact);
    const base = {
        stage: stage.name,
        jobId: manifest.jobId,
        provider: manifest.provider,
        ...(manifest.model === null ? {} : { model: manifest.model }),
        startedAt,
        finishedAt,
        durationMs,
        ...(written
            ? { resultPath: ref, artifacts: [{ stage: stage.name, path: ref, label: 'result.md' }] }
            : { artifacts: [], warnings: [`${ref} not found on disk; the stage wrote no artifact`] }),
        ...(manifest.conversation === null ? {} : { transcriptRef: manifest.conversation }),
        ...(report === null ? {} : { outputTail: report }),
        observations,
    };
    if (manifest.status === 'succeeded' && report !== null) {
        return { ...base, status: 'passed' };
    }
    return {
        ...base,
        status: 'failed',
        failure: manifest.status === 'succeeded'
            ? {
                // The rule this whole project is named after, asserted at the DAG
                // boundary too: the worker claimed success and there is nothing on
                // disk to hand downstream.
                code: 'no-result',
                message: `stage '${stage.name}' reported success but wrote no readable ${ref}`,
                retryable: true,
            }
            : {
                // The provider's own status word, not our prose. `denied` in
                // particular has to survive verbatim: it is the difference between
                // "the tool broke" and "the permission model ate the work", and the
                // remedy is different.
                code: manifest.jobStatus ?? manifest.status,
                message: manifest.error ?? `stage '${stage.name}' finished ${manifest.status}`,
                retryable: manifest.jobStatus === 'error' || manifest.jobStatus === 'malformed',
                detail: { jobId: manifest.jobId, denied: manifest.deniedActions },
            },
    };
}
/** The tail of an artefact, bounded. Diagnostics only, never a verdict. */
function readTail(file, max = OUTPUT_TAIL_CHARS) {
    let body;
    try {
        body = readFileSync(file, 'utf8');
    }
    catch {
        return null;
    }
    const trimmed = body.trim();
    if (trimmed === '')
        return null;
    return trimmed.length <= max ? trimmed : trimmed.slice(trimmed.length - max);
}/** Shared pipeline lifecycle for MCP and the optional local CLI. */
/**
 * THE sanitiser for a run id used as a file name. The record, the cancel marker
 * and the artifacts all key on it, so it must be one function: two lengths used
 * to split ids of 81-100 characters across files. 100 is also what the channel's
 * watch-source and the mod's notice code already assume.
 */
function safeRunId(id) {
    return id.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100) || 'pipeline';
}
/**
 * Where a PipelineRun's record is written.
 *
 * A pipeline outlives the MCP call that started it and usually outlives the
 * process too, so the run summary has to be a file. It sits beside the jobs,
 * not inside one: a run is not a job, and pretending otherwise would put a second
 * verdict for the same work into the pane.
 */
function pipelineRecordPath(repo, runId) {
    return path.join(repo, '.agent-smith', 'pipelines', `${safeRunId(runId)}.json`);
}
function pipelineCancelPath(repo, runId) {
    return path.join(repo, '.agent-smith', 'pipelines', `${safeRunId(runId)}.cancel`);
}
function readPipeline(repo, runId) {
    // Records written before the sanitiser was unified were truncated to 80 chars
    // even though the run id kept 100, so an 81-100 char id lives under the older name.
    const legacy = path.join(repo, '.agent-smith', 'pipelines', `${safeRunId(runId).slice(0, 80)}.json`);
    for (const file of [pipelineRecordPath(repo, runId), legacy]) {
        try {
            return JSON.parse(readFileSync(file, 'utf8'));
        }
        catch { /* try the next name */ }
    }
    return null;
}
function cancelPipeline(repo, runId) {
    const record = readPipeline(repo, runId);
    if (record === null)
        throw new Error(`no pipeline run "${runId}"`);
    if (record.status !== 'running') {
        return { requested: false, runId, note: `pipeline already ${record.status}` };
    }
    const created = createMarker(pipelineCancelPath(repo, runId), new Date().toISOString());
    return {
        requested: true,
        runId,
        note: created
            ? 'cancellation requested; a live pipeline owner will stop active stages, but a run without an owner may remain marked running'
            : 'cancellation was already requested; the run may remain marked running if its owner exited',
    };
}
/**
 * Start and durably record one uniquely identified pipeline invocation.
 *
 * The record deliberately reflects only writes from this live owner. There is
 * no PID/lease protocol to distinguish an orphan from a slow stage after the
 * supervisor exits, so a process crash can leave the record `running`. Recovery
 * needs an owner lease before that state can be reconciled safely.
 */
function startPipeline(service, spec, options = {}) {
    const runId = safeRunId(options.runId ?? `${Date.now()}-${randomBytes(5).toString('hex')}`);
    const recordPath = pipelineRecordPath(service.repo, runId);
    if (existsSync(recordPath)) {
        const existing = readPipeline(service.repo, runId);
        if (options.adoptExisting !== true || existing?.runId !== runId ||
            existing.pipeline !== spec.name || existing.status !== 'running') {
            throw new Error(`pipeline run id "${runId}" already exists`);
        }
    }
    const startedAt = Date.now();
    let current = {
        runId,
        pipeline: spec.name,
        status: 'running',
        startedAt,
        finishedAt: null,
        stageResults: {},
    };
    const persist = () => writeJsonAtomic(recordPath, current);
    persist();
    const controller = new AbortController();
    if (existsSync(pipelineCancelPath(service.repo, runId)))
        controller.abort('pipeline cancellation requested');
    const runner = createForgeRunner({
        service, runId, unrestricted: options.unrestricted,
        onStageRunning(result) {
            current = { ...current, stageResults: { ...current.stageResults, [result.stage]: result } };
            persist();
        },
    });
    const known = new Set(providerNames());
    const poll = setInterval(() => {
        if (existsSync(pipelineCancelPath(service.repo, runId)))
            controller.abort('pipeline cancellation requested');
    }, 250);
    poll.unref?.();
    const done = runPipeline(spec, {
        runner: {
            id: 'forge-router',
            run(ctx) {
                // One runner serves every provider (it spawns by ctx.routing.provider), so
                // the only thing left to decide is whether the stage names one we know.
                // An unknown name must stay a throw (a retryable runner-threw), not the
                // runner's non-retryable spawn-failed.
                if (!known.has(ctx.routing.provider) && !known.has(ctx.stage.provider)) {
                    throw new Error(`no forge worker available for provider ${ctx.stage.provider}`);
                }
                return runner.run(ctx);
            },
        },
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        workDir: spec.workDir ?? service.repo,
        signal: controller.signal,
        ladders: options.ladders ?? Object.fromEntries(providerNames().map((provider) => [provider, { label: provider }])),
        onStageEnd(result) {
            current = { ...current, stageResults: { ...current.stageResults, [result.stage]: result } };
            persist();
        },
    }).then((run) => {
        current = {
            ...current,
            status: run.status,
            finishedAt: run.finishedAt,
            stageResults: run.outcomes,
        };
        persist();
        return run;
    }, (error) => {
        current = {
            ...current,
            status: 'failed',
            finishedAt: Date.now(),
            error: error instanceof Error ? error.message : String(error),
        };
        persist();
        throw error;
    }).finally(() => clearInterval(poll));
    return { runId, recordPath, done, cancel: () => { cancelPipeline(service.repo, runId); } };
}export{checksReason as $,AgentSmithReader as A,deriveStatus as B,writeAtomic as C,DEFAULT_TIMEOUT_MS as D,summaryTail as E,FILES as F,failureFields as G,writeAcceptance as H,getProvider as I,nextActionFor as J,jobDir as K,fileSig as L,MODES as M,jobsDir as N,JobWriter as O,PROVIDERS as P,isMode as Q,REASONS as R,STAGE_PROMPTS as S,newJobId$1 as T,humanDuration as U,pipeEvents as V,pipelineRecordPath as W,isForgeJobId as X,computeStaleReads as Y,SMITH_PAYLOAD as Z,isForgeStatus as _,MODE_PRESETS as a,readJsonSafe as a0,toolLabel as a1,readAcceptance as b,readPipeline as c,cancelPipeline as d,settleAcceptance as e,markAcceptanceSuperseded as f,isTerminalForgeStatus as g,readManifest as h,inheritContinuedProviders as i,jobFile as j,AgyStaffReader as k,errMessage as l,markAcceptancePending as m,normalize as n,findProvider as o,providerNames as p,SCHEMA_VERSION as q,reasonFromText as r,startPipeline as s,validOwnerPid as t,ownerAlive as u,validateSpec as v,writeJsonAtomic as w,reportFor as x,cwdFacts as y,deriveOrphan as z};