import {execFile,spawn}from'node:child_process';import {randomBytes,createHash}from'node:crypto';import {readFileSync,existsSync,mkdirSync,writeFileSync,renameSync,unlinkSync,openSync,fsyncSync,closeSync,statSync}from'node:fs';import path from'node:path';/**
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
 * WHY A DIRECTORY, NOT FLAT `<jobId>.suffix` FILES
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
 * It is never deleted, so a missing file never has to mean "finished".
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
    /** The spawn_job request (prompt, context, mode, ...), so a later spawn can reuse it with `from`. */
    request: 'request.json',
};
/**
 * The id segment that marks a job as OURS.
 *
 * WHY A MARKER IN THE ID RATHER THAN ONLY IN THE FILES: the mod band renders
 * ids, and a human should be able to tell an agent-smith job by looking.
 * `implement-smith-3f9a2c71` says it in three characters.
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
    return p === '.agent-smith' || p.startsWith('.agent-smith/');
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
function newJobId(mode) {
    const safeMode = mode.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120).replace(/-+$/g, '');
    const prefix = safeMode === '' ? 'job' : safeMode;
    return `${prefix}-${ID_MARKER}-${randomBytes(4).toString('hex')}`;
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
function looksEmpty(text) {
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
    if (NO_OUTPUT_RE.test(err) || (i.exitCode === 0 && looksEmpty(i.report))) {
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
 * that mattered. We write this file, so we never let a reader see it
 * half-written.
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
 * Measured against real agy tool calls:
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
 * `input_preview` is a JSON STRING of the tool parameters, possibly truncated.
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
const PATH_KEYS = ['AbsolutePath', 'TargetFile', 'Path', 'file_path', 'filePath', 'notebook_path', 'path'];
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
        this.baselinePending = isInsideGitRepo(input.cwd) ? this.captureBaseline(input.cwd) : null;
        return manifest;
    }
    hasPendingBaseline() {
        return this.baselinePending !== null;
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
    /** Wait for the async git baseline capture and return the dirty paths, if any. */
    async awaitBaseline() {
        try {
            if (this.baselinePending !== null)
                await this.baselinePending;
        }
        catch { /* best effort */ }
        return (this.manifest?.gitBaseline?.dirty ?? []).filter((p) => !isForgeStatePath(p));
    }
    /** Update `view.preamble` when the async brief enrichment lands before spawn. */
    updatePreamble(preamble) {
        this.view = {
            ...this.view,
            preamble: preamble.slice(0, 4_000),
            truncated: this.view.truncated || preamble.length > 4_000,
        };
        writeJsonAtomic(jobFile(this.repo, this.jobId, FILES.view), this.view);
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
     * between must already see the intent: a cancellation caught mid-flight is
     * still a cancellation, and the worker may never get to write its own
     * terminal state.
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
function isInsideGitRepo(cwd) {
    let dir = path.resolve(cwd);
    while (true) {
        if (existsSync(path.join(dir, '.git')))
            return true;
        const parent = path.dirname(dir);
        if (parent === dir)
            return false;
        dir = parent;
    }
}
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
    const t = text.trim().replace(/^Status:[^\n]*(?:\n|$)/, '').trim();
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
    if (typeof result.response === 'string' && !looksEmpty(result.response))
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
 * invitation to summarise it, which is the thing that fails. 8KB per stream.
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
/** Default cap per stream. */
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
}export{summaryTail as A,failureFields as B,writeAcceptance as C,DEFAULT_TIMEOUT_MS as D,toolLabel as E,FILES as F,CANCEL_ORPHAN_REASON as G,STEER_NOT_APPLIED_RE as H,exitReason as I,JobWriter as J,pendingAcceptance as K,evaluateAcceptanceReport as L,appendBounded as M,createMarker as N,checksReason as O,REASONS as R,SCHEMA_VERSION as S,readAcceptance as a,jobFile as b,markAcceptanceSuperseded as c,readManifest as d,jobsDir as e,fileSig as f,newJobId as g,reportFor as h,isTerminalForgeStatus as i,jobDir as j,deriveStatus as k,writeAtomic as l,markAcceptancePending as m,nextActionFor as n,ownerAlive as o,pipeEvents as p,computeStaleReads as q,reasonFromText as r,settleAcceptance as s,isForgeStatus as t,classify as u,oneLine as v,writeJsonAtomic as w,validOwnerPid as x,cwdFacts as y,deriveOrphan as z};