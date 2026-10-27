import path from'node:path';import {constants,existsSync,readFileSync,mkdirSync,writeFileSync,renameSync}from'node:fs';import {readdir,open,access}from'node:fs/promises';import os from'node:os';import {spawn}from'node:child_process';import {randomBytes}from'node:crypto';/**
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
async function readTextSafe(path, maxBytes = DEFAULT_MAX_BYTES) {
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
    const text = await readTextSafe(path, maxBytes);
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
}
/**
 * Read a byte-capped prefix of a text file, spanning MULTIPLE lines.
 *
 * WHY: Claude Code subagent transcripts are append-only NDJSON up to ~500KB.
 * To discover which project a subagent belongs to we only need a `cwd` from its
 * leading records — reading whole files across 696 subagents to find one field
 * would be absurd.
 *
 * WHY "prefix" and not "first line": fork subagents do not begin with a
 * conversation record. They begin with a `{"type":"fork-context-ref", ...}`
 * header that has NO `cwd`; the first record that has one is a line later. A
 * single-line head read therefore makes every fork subagent invisible. Callers
 * scan the lines themselves and stop when they have what they need.
 *
 * The final line may be cut mid-record; that is fine and expected — consumers
 * parse line-by-line and skip anything that does not parse.
 */
async function readPrefixSafe(path, maxBytes = 16 * 1024) {
    return readTextSafe(path, maxBytes);
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
    /** Written by the first reader to prove the owner is dead. Never edits job.json. */
    orphaned: 'orphaned',
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
function newJobId(mode) {
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
const ORPHANED = { status: 'failed', suspicious: true, reason: ORPHAN_REASON };
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
            const raw = await readTextSafe(cancelPath);
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
        const report = await readTextSafe(jobFile(cwd, jobId, FILES.report));
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
            const markerPath = jobFile(cwd, jobId, FILES.orphaned);
            const lastSeen = Math.max(Date.parse(manifest.updatedAt), Date.parse(progress?.lastEventAt ?? ''));
            orphan = deriveOrphan(manifest, Number.isFinite(lastSeen) ? lastSeen : null, Date.now(), undefined, cancelRequested);
            // A live supervisor honours a cancel request within seconds. A request that
            // is a minute old and still has no terminal state means nobody is listening.
            const cancelAgeMs = cancelAt === null ? NaN : Date.now() - Date.parse(cancelAt);
            const ownerAlive = typeof manifest.ownerPid === 'number' && isPidAlive(manifest.ownerPid);
            if (orphan === null && cancelRequested && cancelAgeMs > 60_000 && !ownerAlive)
                orphan = CANCELED_ORPHAN;
            // The marker is proof the supervisor is gone; a cancel request makes that
            // a cancellation. A live pid beside a marker plus cancel is still in flight.
            if (orphan === null && (await existsSafe(markerPath))) {
                orphan = !cancelRequested ? ORPHANED : ownerAlive ? null : CANCELED_ORPHAN;
            }
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
}/**
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
            const raw = await readTextSafe(cancelMarkerPath);
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
        const rawResult = await readTextSafe(at(RESULT_SUFFIX));
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
        const log = await readTextSafe(at(LOG_SUFFIX));
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
 * claude-code.ts — reads Claude Code's own native subagent transcripts.
 *
 * VERIFIED LAYOUT (from ~/.claude/projects, 696 real subagents scanned):
 *
 *   ~/.claude/projects/<projectSlug>/<sessionId>/subagents/
 *       agent-<agentId>.jsonl        NDJSON transcript
 *       agent-<agentId>.meta.json    { agentType, description, toolUseId,
 *                                      spawnDepth, requestShape, model, ... }
 *
 *  - <projectSlug> is derived from a launch cwd by replacing `/`, `\`, and `.`
 *    with `-`. This is a *heuristic*, verified to match for the common case:
 *      /Users/gathrid/Repos/topos → -Users-gathrid-Repos-topos
 *    BUT it demonstrably diverges when the session was launched from a parent
 *    dir or a worktree, e.g.
 *      cwd /Users/gathrid/Repos/renyi/src/s1
 *      slug -Users-gathrid-Repos-renyi--claude-worktrees-s1-model-demo-plan
 *    So we NEVER rely on the slug alone: we scan all project dirs and read the
 *    real `cwd` out of each transcript's first record. A wrong guess here means
 *    we silently show zero jobs, which is worse than being slow.
 *
 *  - `isSidechain: true` and `agentId` appear on every *conversation* record of
 *    a subagent transcript. Neither appears on the parent transcript. That is
 *    the reliable sidechain discriminator (the filename is a weaker hint, since
 *    a parent transcript could in principle be named anything).
 *    CAVEAT: fork subagents break the "every line" rule — they lead with a
 *    `{"type":"fork-context-ref", ...}` header that has `agentId` but no
 *    `isSidechain` and no `cwd`. Handled in findCwdInHead().
 *
 *  - KNOWN GAP (documented, not a bug): workflow subagents live one level
 *    deeper, at `subagents/workflows/<workflowId>/agent-<id>.jsonl`. This
 *    reader only scans `subagents/*.jsonl` at depth 1, so workflow subagents
 *    are NOT discovered. Supporting them means extending the composite job id
 *    to three segments; deliberately left out of scope rather than
 *    half-implemented, because a partially-parsed workflow agent is worse than
 *    an absent one. (~57 such files exist in the sampled corpus.)
 *
 *  - Tool calls are `message.content[]` blocks of type `tool_use`
 *    ({ id, name, input }); results are blocks of type `tool_result`
 *    ({ tool_use_id, content }) which may be a string OR an array of blocks.
 *
 *  - There is NO terminal marker record. Verified across 200 real transcripts:
 *    zero have a `subtype` field, and 115/200 have no SubagentHandback call.
 *    We therefore infer lifecycle from content (see below).
 *
 *  ────────────────────────────────────────────────────────────────────────────
 *  IMPORTANT CAVEAT — the format is explicitly UNSTABLE UPSTREAM.
 *  Claude Code's own docs describe the transcript format as "internal and
 *  changes between versions". Observed already across 696 files: the set of
 *  top-level record keys varies per version and per feature flag (we saw
 *  `slug`, `effort`, `advisorModel`, `worktreePath`, `isFork`,
 *  `stoppedByUser`, `apiErrorStatus`, `serverClassifierContext`, … appear on
 *  some records only).
 *
 *  THEREFORE, THIS READER IS DEFENSIVE BY CONSTRUCTION:
 *    · every field access is optional-chained and type-guarded
 *    · an unknown record shape is skipped, never fatal
 *    · a malformed NDJSON line is counted, never thrown
 *    · this file must never `throw`. A future Claude Code version that renames
 *      `message.content` should degrade to "job visible, no tool details",
 *      not to a crashed mod band.
 *  ────────────────────────────────────────────────────────────────────────────
 */
/** payload keys the claude-code normalizer relies on. */
const CLAUDE_PAYLOAD = {
    agentType: "agent_type",
    description: "description",
    model: "model",
    spawnDepth: "spawn_depth",
    requestShape: "request_shape",
    stoppedByUser: "stopped_by_user",
    isFork: "is_fork",
    parentAgentId: "parent_agent_id",
    transcriptCwd: "transcript_cwd",
    recordCount: "record_count",
    malformedLines: "malformed_lines",
    firstAt: "first_at",
    lastAt: "last_at",
    toolCalls: "tool_calls", // { name, count }[]
    errorRecords: "error_records", // count of API-error records
    handback: "handback", // SubagentHandback message, if any
    finalText: "final_text", // last assistant text block, fallback output
    sidechain: "sidechain", // bool: verified via isSidechain on records
};
/** Derive the Claude project slug for a cwd. Heuristic — see file header. */
function projectSlug(cwd) {
    return cwd.replace(/[/\\.]/g, "-");
}
class ClaudeCodeReader {
    provider = "claude-code";
    /**
     * Overridable root, for tests and for reading a relocated ~/.claude.
     *
     * WHY not hardcoded: the fixtures in __tests__/ mirror the real directory
     * layout, and a reader that can only ever read `$HOME/.claude/projects` is a
     * reader that cannot be tested. Default remains the real location.
     */
    rootOverride;
    constructor(options = {}) {
        this.rootOverride = options.projectsRoot ?? null;
    }
    projectsRoot() {
        return this.rootOverride ?? path.join(os.homedir(), ".claude", "projects");
    }
    /**
     * Enumerate subagents belonging to a cwd.
     *
     * Strategy (correctness over speed): scan ALL project dirs (the slug
     * heuristic is unreliable), read each subagent's meta.json, and only then read
     * the transcript's first record to read the authoritative `cwd`. This is
     * O(#subagents) per call, which is heavy at 696 files — so we keep the
     * per-file reads minimal (meta.json is tiny; the transcript is read head-only).
     *
     * To keep this cheap for callers that poll, we filter candidate project dirs
     * by the exact slug FIRST; if that yields any matches we trust them, else we
     * fall back to the full scan. This gets the common case fast and stays
     * correct for the worktree/parent-dir divergence.
     *
     * `discover` never throws; returns [] on any trouble.
     */
    async discover(cwd) {
        const slug = projectSlug(cwd);
        const root = this.projectsRoot();
        // Fast path: only the dir whose slug matches exactly.
        const fast = await this.scanProjectDir(path.join(root, slug), cwd);
        if (fast.length > 0)
            return fast.map((s) => s.key).sort();
        // Slow-but-correct path: slug heuristic failed (worktree/parent launch dir).
        // Scan every project dir, filtering by the transcript's real `cwd`.
        const projectDirs = await readdirSafe(root);
        const all = [];
        for (const dir of projectDirs) {
            if (dir === slug)
                continue; // already scanned in fast path
            const found = await this.scanProjectDir(path.join(root, dir), cwd);
            all.push(...found);
        }
        return all.map((s) => s.key).sort();
    }
    /**
     * Scan one project-slug dir for subagents whose transcript `cwd` matches.
     * Matches if the transcript cwd equals the requested cwd OR the requested cwd
     * is an ancestor of the transcript cwd (a subagent spawned in a subdirectory).
     */
    async scanProjectDir(projectDir, cwd) {
        const sessionIds = await readdirSafe(projectDir);
        const out = [];
        for (const sessionId of sessionIds) {
            const subDir = path.join(projectDir, sessionId, "subagents");
            const files = await readdirSafe(subDir);
            for (const name of files) {
                if (!name.startsWith("agent-") || !name.endsWith(".jsonl"))
                    continue;
                const agentId = name.slice("agent-".length, -".jsonl".length);
                const jsonlPath = path.join(subDir, name);
                const metaPath = path.join(subDir, `agent-${agentId}.meta.json`);
                // cwd comes from the transcript, so read the head. NOT just line 0:
                // fork subagents lead with a `fork-context-ref` header that has no cwd
                // (see findCwdInHead).
                const head = await readPrefixSafe(jsonlPath, 8 * 1024);
                if (head === null)
                    continue;
                const transcriptCwd = findCwdInHead(head);
                if (transcriptCwd === null)
                    continue;
                // cwd match: equal, or transcript cwd is under the requested cwd.
                const normReq = cwd.replace(/\/+$/, "");
                const normTr = transcriptCwd.replace(/\/+$/, "");
                const matches = normTr === normReq || normTr.startsWith(normReq + path.sep) || normReq.startsWith(normTr + path.sep);
                if (!matches)
                    continue;
                out.push({ key: `${sessionId}/${agentId}`, sessionId, agentId, jsonlPath, metaPath });
            }
        }
        return out;
    }
    /**
     * Read one subagent's current state.
     *
     * `jobId` is the composite key returned by discover(): `<sessionId>/<agentId>`.
     * Returns null only if neither the transcript nor the meta can be found/read.
     */
    async read(cwd, jobId) {
        const slash = jobId.indexOf("/");
        if (slash === -1)
            return null;
        const sessionId = jobId.slice(0, slash);
        const agentId = jobId.slice(slash + 1);
        if (sessionId.length === 0 || agentId.length === 0)
            return null;
        // The meta sidecar sits beside the transcript; resolve it the same way.
        const meta = await this.resolveSidecar(sessionId, agentId);
        // The meta sidecar is optional and may lag/be absent; prefer the transcript
        // as the source of truth for content, use meta for descriptors only.
        const raw = await this.readTranscript(sessionId, agentId);
        if (raw === null && meta === null)
            return null; // nothing readable at all
        const payload = {
            [CLAUDE_PAYLOAD.agentType]: meta?.agentType ?? null,
            [CLAUDE_PAYLOAD.description]: meta?.description ?? null,
            [CLAUDE_PAYLOAD.model]: meta?.model ?? null,
            [CLAUDE_PAYLOAD.spawnDepth]: meta?.spawnDepth ?? null,
            [CLAUDE_PAYLOAD.requestShape]: meta?.requestShape ?? null,
            [CLAUDE_PAYLOAD.stoppedByUser]: meta?.stoppedByUser ?? null,
            [CLAUDE_PAYLOAD.isFork]: meta?.isFork ?? null,
            [CLAUDE_PAYLOAD.parentAgentId]: meta?.parentAgentId ?? null,
            [CLAUDE_PAYLOAD.transcriptCwd]: raw?.cwd ?? null,
            [CLAUDE_PAYLOAD.recordCount]: raw?.recordCount ?? 0,
            [CLAUDE_PAYLOAD.malformedLines]: raw?.malformedCount ?? 0,
            [CLAUDE_PAYLOAD.firstAt]: raw?.firstAt ?? null,
            [CLAUDE_PAYLOAD.lastAt]: raw?.lastAt ?? null,
            [CLAUDE_PAYLOAD.toolCalls]: raw?.toolCalls ?? [],
            [CLAUDE_PAYLOAD.errorRecords]: raw?.errorRecords ?? 0,
            [CLAUDE_PAYLOAD.handback]: raw?.handback ?? null,
            [CLAUDE_PAYLOAD.finalText]: raw?.finalText ?? null,
            [CLAUDE_PAYLOAD.sidechain]: raw?.sawSidechain ?? false,
        };
        return {
            provider: this.provider,
            jobId,
            cwd: raw?.cwd ?? cwd,
            payload,
            partial: raw === null || raw.sawSidechain === false,
        };
    }
    /**
     * Read the meta sidecar for a subagent, tolerating its absence.
     *
     * The sidecar is a NEWER, "compact" artifact — it did not exist in older
     * Claude Code versions, and 70/696 real metas are missing `requestShape`
     * outright. So it is strictly optional: descriptors come from it when it is
     * there, and the transcript is the source of truth for content either way.
     */
    async resolveSidecar(sessionId, agentId) {
        const resolved = await this.resolveSubagentFile(sessionId, `agent-${agentId}.meta.json`);
        if (resolved === null)
            return null;
        return readJsonSafe(resolved);
    }
    /**
     * Parse a full subagent transcript defensively.
     *
     * Reads the whole jsonl (cap via safe-fs default) and folds every record into
     * a small summary. Every field is optional/guarded: a future Claude Code that
     * renames `message.content` yields an empty tool list, not an exception.
     */
    async readTranscript(sessionId, agentId) {
        // Resolve the real path (the project slug is not derivable from cwd alone).
        const resolved = await this.resolveSubagentFile(sessionId, `agent-${agentId}.jsonl`);
        if (resolved === null)
            return null;
        const text = await readTextSafe(resolved);
        if (text === null)
            return null;
        const toolTally = new Map();
        let recordCount = 0;
        let malformedCount = 0;
        let errorRecords = 0;
        let sawSidechain = false;
        let cwd = null;
        let firstAt = null;
        let lastAt = null;
        let handback = null;
        let finalText = null;
        for (const line of text.split("\n")) {
            if (line.trim().length === 0)
                continue;
            let rec;
            try {
                rec = JSON.parse(line);
            }
            catch {
                // A malformed line is tolerated and counted (defensive-by-design).
                malformedCount += 1;
                continue;
            }
            recordCount += 1;
            if (rec["isSidechain"] === true)
                sawSidechain = true;
            if (typeof rec["cwd"] === "string" && cwd === null)
                cwd = rec["cwd"];
            const ts = rec["timestamp"];
            if (typeof ts === "string") {
                if (firstAt === null)
                    firstAt = ts;
                lastAt = ts;
            }
            // API-error records: verified real keys `isApiErrorMessage` / `apiErrorStatus`.
            if (rec["isApiErrorMessage"] === true || typeof rec["error"] === "string") {
                errorRecords += 1;
            }
            // Walk message.content[] defensively.
            const message = rec["message"];
            const content = typeof message === "object" && message !== null
                ? message["content"]
                : null;
            if (!Array.isArray(content))
                continue;
            for (const block of content) {
                if (typeof block !== "object" || block === null)
                    continue;
                const b = block;
                const btype = b["type"];
                if (btype === "tool_use") {
                    const name = typeof b["name"] === "string" ? b["name"] : "unknown";
                    toolTally.set(name, (toolTally.get(name) ?? 0) + 1);
                    const input = b["input"];
                    if (name === "SubagentHandback" &&
                        typeof input === "object" &&
                        input !== null &&
                        typeof input["message"] === "string") {
                        handback = input["message"];
                    }
                }
                else if (btype === "text" && typeof b["text"] === "string") {
                    finalText = b["text"];
                }
            }
        }
        const toolCalls = [...toolTally.entries()]
            .map(([name, count]) => ({ name, count }))
            .sort((a, b) => b.count - a.count);
        return {
            cwd,
            recordCount,
            malformedCount,
            firstAt,
            lastAt,
            toolCalls,
            errorRecords,
            handback,
            finalText,
            sawSidechain,
        };
    }
    /**
     * Find the concrete on-disk path of a file in `<session>/subagents/`.
     *
     * WHY a search instead of computing the project slug from cwd: the slug
     * heuristic is demonstrably wrong for sessions launched from a parent dir or a
     * worktree (verified against the real corpus). The transcript itself is
     * authoritative, so we find the file rather than guess where it lives.
     */
    async resolveSubagentFile(sessionId, fileName) {
        const root = this.projectsRoot();
        const projectDirs = await readdirSafe(root);
        for (const dir of projectDirs) {
            const candidate = path.join(root, dir, sessionId, "subagents", fileName);
            if (await existsSafe(candidate))
                return candidate;
        }
        return null;
    }
}
/**
 * Find a subagent's `cwd` in the leading records of its transcript.
 *
 * WHY THIS EXISTS — a real trap found by scanning all 696 real subagents:
 * fork subagents do NOT start with a conversation record. They start with a
 * `fork-context-ref` header:
 *
 *   {"type":"fork-context-ref","agentId":"awhere-are-wer-...","parentSessionId":...,
 *    "contextLength":107}
 *
 * That header has NO `cwd`. The first record that does is one line later. A
 * reader that only inspects line 0 therefore makes every fork subagent
 * INVISIBLE — it would silently drop ~8 real jobs rather than fail loudly, which
 * is the worst possible failure mode for an observability tool.
 *
 * So: scan the leading records (bounded) for the first string `cwd`.
 */
function findCwdInHead(head) {
    let seen = 0;
    for (const line of head.split("\n")) {
        if (line.trim().length === 0)
            continue;
        let rec;
        try {
            rec = JSON.parse(line);
        }
        catch {
            continue; // a malformed leading line must not stop the search
        }
        const cwd = rec["cwd"];
        if (typeof cwd === "string" && cwd.length > 0)
            return cwd;
        seen += 1;
        // Bounded: a transcript with no cwd in its first 20 records has none we
        // can trust. Stopping here keeps discovery cheap.
        if (seen >= 20)
            break;
    }
    return null;
}/**
 * normalize.ts — provider-agnostic normalization to ObservedJob.
 *
 * Every provider quirk and every judgement call lives HERE and only here, so
 * this file is the single place a reviewer reads to answer "why did that job
 * show up as failed?". Readers (agy-staff.ts, claude-code.ts) are dumb parsers;
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
// ── claude-code normalizer ──────────────────────────────────────────────────
/**
 * Map a Claude Code subagent transcript onto ObservedJob.
 *
 * LIFECYCLE INFERENCE (necessary because there is no terminal marker record —
 * verified: 0/200 real transcripts carry a `subtype`):
 *   1. meta.stoppedByUser === true                     ⇒ canceled
 *   2. a SubagentHandback tool_use was made            ⇒ succeeded (the
 *      subagent explicitly reported its result back)
 *   3. API-error records present (isApiErrorMessage)   ⇒ failed
 *   4. transcript still being appended (no handback, no
 *      error, and the reader saw a live-looking file)   ⇒ running
 *   5. otherwise (short, ended without handback)         ⇒ unknown
 *
 * Rule 5 is conservative on purpose: a subagent transcript with no handback and
 * no error might have been truncated, killed, or simply not use the handback
 * tool. We do NOT guess `succeeded`.
 */
const claudeNormalizer = (raw) => {
    const p = raw.payload;
    const warnings = [];
    const stoppedByUser = asBool(p[CLAUDE_PAYLOAD.stoppedByUser]) === true;
    const handback = asString(p[CLAUDE_PAYLOAD.handback]);
    const finalText = asString(p[CLAUDE_PAYLOAD.finalText]);
    const errorRecords = asNumber(p[CLAUDE_PAYLOAD.errorRecords]) ?? 0;
    const malformed = asNumber(p[CLAUDE_PAYLOAD.malformedLines]) ?? 0;
    const lastAt = asString(p[CLAUDE_PAYLOAD.lastAt]);
    const firstAt = asString(p[CLAUDE_PAYLOAD.firstAt]);
    const output = handback ?? finalText;
    // -- warnings ---------------------------------------------------------------
    if (stoppedByUser) {
        warnings.push({ code: "canceled", message: "stopped by the user" });
    }
    if (errorRecords > 0) {
        warnings.push({
            code: "tool_error",
            message: `${errorRecords} API ${errorRecords === 1 ? 'error' : 'errors'}`,
        });
    }
    if (malformed > 0) {
        warnings.push({
            code: "incomplete_state",
            message: `skipped ${malformed} unreadable transcript ${malformed === 1 ? 'line' : 'lines'}`,
        });
    }
    // Same headline rule as agy: no deliverable + warnings ⇒ not a clean success.
    const emptyOutput = looksEmpty(output);
    if (emptyOutput && !stoppedByUser) {
        warnings.push({
            code: "empty_output",
            message: "no output",
        });
    }
    // -- status -----------------------------------------------------------------
    let status;
    if (stoppedByUser) {
        status = "canceled";
    }
    else if (handback !== null) {
        // The subagent explicitly reported a result back. API errors earlier in the
        // run become a `tool_error` warning but do not erase the delivered report.
        status = "succeeded";
    }
    else if (errorRecords > 0) {
        status = "failed";
    }
    else if (lastAt !== null) {
        // Transcript has records but no handback and no error. Most likely still
        // running or died mid-flight; treat as running only if it looks live.
        // Without a mtime signal we cannot tell, so `running` is optimistic but
        // bounded — we prefer it over `unknown` for a file that clearly has
        // content, because a crashed-with-no-handback subagent is rare.
        status = "running";
    }
    else {
        status = "unknown";
    }
    return {
        provider: "claude-code",
        jobId: raw.jobId,
        status,
        warnings,
        output,
        startedAt: firstAt,
        updatedAt: lastAt,
        finishedAt: stoppedByUser ? lastAt : null,
        mode: asString(p[CLAUDE_PAYLOAD.agentType]),
        model: asString(p[CLAUDE_PAYLOAD.model]),
        label: asString(p[CLAUDE_PAYLOAD.description]),
        outputTruncated: false,
        usage: null,
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
    // answer and it must survive to the surface: core/types.ts is explicit that
    // `unknown` is load-bearing and must never be collapsed.
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
    ["claude-code", claudeNormalizer],
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
async function evaluateAcceptance(input) {
    const at = (input.now ?? (() => new Date()))().toISOString();
    if (!input.checks?.length)
        return { state: 'unchecked', checks: [], at };
    if (!input.succeeded)
        return { state: 'rejected', checks: [], at, reason: 'job did not succeed; checks not run' };
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
    return {
        state: acceptanceState(checks),
        at,
        checks,
    };
}
function writeAcceptance(repo, jobId, acceptance) {
    const dir = jobDir(repo, jobId);
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, ACCEPTANCE_FILE);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(acceptance, null, 2)}\n`);
    renameSync(tmp, target);
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
}
/**
 * evaluateAcceptance for a job on disk: keeps acceptance.json's pending placeholder
 * current with the checks running, then returns the verdict (the caller writes it).
 * An abort records `unchecked: checks canceled` instead of a verdict from killed checks.
 */
async function runAcceptance(input) {
    const budgetMs = acceptanceBudgetMs(input.checks);
    const startedAt = new Date().toISOString();
    const acceptance = await evaluateAcceptance({
        succeeded: input.succeeded, checks: input.checks, baseDir: input.baseDir,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
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
}/**
 * format.ts — PURE presentation logic for the /forge pane and the band.
 *
 * WHY THIS FILE IS NOT `register.tsx`:
 * `node --test --experimental-strip-types` CANNOT load a .tsx file — TypeScript's
 * type stripping has no JSX transform (verified: any JSX element in an imported
 * .tsx is a hard parse error). So if the formatters lived next to the render
 * code they would be untestable under the repo's own test runner, which defeats
 * the point of making them pure in the first place. Everything testable lives
 * here, in a module with zero imports and zero I/O. `register.tsx` imports this
 * file and does nothing but lay out what these functions return.
 *
 * NOTHING in here reads the clock, the filesystem, or any atom. "Now" is always
 * a parameter, for the same reason core/liveness.ts does it: a formatter that
 * called Date.now() itself could not be tested at a boundary.
 *
 * THE RULES ENCODED BELOW come from agent-configs/shared/TERMINAL-UI.md. Where a
 * rule needed interpretation the reasoning is inline.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ROW, IN ONE PLACE
 * ─────────────────────────────────────────────────────────────────────────────
 * Every job row in either surface is these four segments, in this order:
 *
 *     {glyph} {label} {detail} {elapsed}
 *       1        2       3        4
 *
 *   1 glyph     EAW=Neutral, one column, always drawn. Never colour alone.
 *   2 label     THE TASK, from `prompt_source.task`. Fixed-width cell.
 *   3 detail    what it is doing (live) or how it ended (terminal). Fixed cell.
 *   4 elapsed   fixed 6 columns, RIGHT-aligned, and LAST — see ELAPSED_WIDTH.
 *
 * WHY THE JOB ID IS NOT ON THE ROW ANY MORE. Measured against the real 20-job
 * corpus in .agy-staff/jobs: every id is `implement-musm82da-f1dc1fe4`. That is
 * 30 columns of which the mode is constant (`implement`, 100% of the corpus, so
 * it is not information) and `-f1dc1fe4` is a UUID fragment that distinguishes
 * nothing a reader can act on. The request the job was actually given sits in
 * `prompt_source.task` and reads "open an agent-built dashboard with real names,
 * decoded inside Renyi". That is the identity. The id survives in the DETAIL
 * view, where it is what you would paste into `agy` to talk about the job.
 *
 * WHY ELAPSED IS LAST AND FIXED-WIDTH. TERMINAL-UI.md §Width: "put the volatile
 * field last — elapsed time ticks every second; if it sits mid-line, everything
 * after it shifts horizontally each tick." The pane used to put the clock second
 * and rely on right-alignment; that is safe (see ELAPSED_WIDTH) but it is a
 * weaker version of the same guarantee than simply putting the field last, and
 * the band already did the latter. Both surfaces now agree, so there is no
 * band/pane ordering deviation left to document.
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
/** Collapse all whitespace runs to single spaces and cap the length. */
function oneLine(s, max = 400) {
    const t = sanitizeText(s).replace(/\s+/g, ' ').trim();
    return clip(t, max);
}
// ── activity, from real agy tool shapes ─────────────────────────────────────
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
    const trimmed = words.slice(0, 2).join(' ');
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
/** `/bin/zsh -lc 'cat x'` and `bash -lc "…"` → the command inside. codex names a shell call by its command line. */
function unwrapShell(command) {
    const m = /^\s*(?:\S*\/)?(?:ba|z|)sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
    return m ? m[2] : command;
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
}export{AgentSmithReader as A,isPidAlive as B,ClaudeCodeReader as C,DEFAULT_TIMEOUT_MS as D,deriveOrphan as E,FILES as F,jobsDir as G,newJobId as H,jobDir as I,isForgeJobId as J,SMITH_PAYLOAD as K,nextActionFor as L,checksReason as M,toolLabel as N,readJsonSafe as O,ProgressTracker as P,readdirSafe as Q,REASONS as R,SCHEMA_VERSION as S,existsSafe as T,readAcceptance as a,runAcceptance as b,PROGRESS_FLUSH_MS as c,attributeChanged as d,exitReason as e,diffChangedFiles as f,classify as g,cwdFacts as h,deriveStatus as i,jobFile as j,failureFields as k,FAILED_EARLY_MS as l,looksEmpty$1 as m,isForgeStatePath as n,toVerifyChecks as o,pendingAcceptance as p,normalizeAcceptanceReport as q,reasonFromText as r,shouldFlush as s,taskTitle as t,runChecks as u,acceptanceChecksFromReport as v,writeAcceptance as w,acceptanceState as x,AgyStaffReader as y,normalize as z};