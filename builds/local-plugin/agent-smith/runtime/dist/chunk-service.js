import {l as readManifest,d as jobFile,F as FILES,o as ownerAlive,c as readPipeline,h as cancelPipeline,P as PROVIDERS,m as errMessage,n as findProvider,w as writeJsonAtomic,A as AgentSmithReader,q as normalize,t as writeAtomic,j as jobDir,u as SCHEMA_VERSION,x as validOwnerPid,k as isTerminalForgeStatus,y as reportFor,z as cwdFacts,B as normalizeDenials,C as deriveOrphan,E as deriveStatus,G as summaryTail,H as failureFields,R as REASONS,e as readAcceptance,I as writeAcceptance,J as createMarker,W as WORKERS_DIR,K as jobsDir,L as parseWorkerIndex,p as providerNames,N as getProvider,M as MODES,a as MODE_PRESETS,D as DEFAULT_TIMEOUT_MS$1,O as normalizeContinuationKind,Q as nextActionFor,T as fileSig,U as JobWriter,i as isTerminalStatus,g as isMode,V as newJobId,X as markAcceptancePending,Y as humanDuration,Z as pipeEvents,_ as checksAbortRequested,$ as verdictBlock,a0 as runAcceptance,a1 as senderOf,a2 as markAcceptanceSuperseded,a3 as pipelineRecordPath,a4 as pickHead,f as isWorkerIdle,a5 as compareTurnPriority,a6 as computeStaleReads,a7 as SMITH_PAYLOAD,a8 as isForgeStatus}from'./chunk-normalize.js';import {existsSync,readFileSync,mkdirSync,appendFileSync,openSync,writeSync,closeSync,unlinkSync,statSync,renameSync,linkSync,readdirSync,realpathSync,lstatSync,copyFileSync}from'node:fs';import {fork}from'node:child_process';import {fileURLToPath}from'node:url';import {setTimeout as setTimeout$1}from'node:timers/promises';import path from'node:path';import {createHash}from'node:crypto';const LAUNCH_ACK_MS = 15_000;
async function launch(url, payload, onPrepared) {
    const child = fork(fileURLToPath(url), [], {
        detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: url.pathname.endsWith('.ts') ? ['--experimental-strip-types'] : [],
    });
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => fail(new Error(`execution supervisor did not acknowledge launch within ${LAUNCH_ACK_MS / 1000}s`)), LAUNCH_ACK_MS);
        function fail(error) {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            child.kill();
            reject(error);
        }
        child.once('error', fail);
        child.once('exit', (code) => fail(new Error(`execution supervisor exited before launch (exit ${code})`)));
        child.on('message', async (raw) => {
            const m = raw;
            if (settled)
                return;
            if (m.kind === 'prepared') {
                try {
                    await onPrepared?.(m.jobId);
                    if (!settled && child.connected)
                        child.send({ kind: 'start' });
                }
                catch (error) {
                    fail(error instanceof Error ? error : new Error(String(error)));
                }
            }
            else if (m.kind === 'error')
                fail(new Error(m.error));
            else if (m.kind === 'ack') {
                settled = true;
                clearTimeout(timer);
                child.disconnect();
                child.unref();
                resolve(m.value);
            }
        });
        child.send(payload);
    });
}
async function launchJob(service, request) {
    const { onPrepared, ...serializable } = request;
    const ack = await launch(service.supervisorUrl, { kind: 'job', repo: service.repo, request: serializable }, onPrepared);
    service.spawnedIds.add(ack.jobId);
    const done = (async () => {
        let id = ack.jobId;
        while (true) {
            id = service.resolveTurn(id);
            const detail = await service.detail(id);
            if (detail.followedBy) {
                id = detail.followedBy;
                continue;
            }
            if (detail.status !== 'running' && !detail.supersededBy) {
                const manifest = readManifest(service.repo, id);
                if (existsSync(jobFile(service.repo, id, FILES.ownerDone)) || !ownerAlive(manifest)) {
                    return manifest;
                }
            }
            await setTimeout$1(100);
        }
    })();
    void done.catch(() => { });
    return { ack, done };
}
async function launchPipeline(service, spec, options) {
    const ack = await launch(service.supervisorUrl, { kind: 'pipeline', repo: service.repo, spec, options });
    service.spawnedRuns.add(ack.runId);
    const done = (async () => {
        while (true) {
            const record = readPipeline(service.repo, ack.runId);
            if (record && record.status !== 'running')
                return;
            await setTimeout$1(100);
        }
    })();
    return { ...ack, done, cancel: () => { cancelPipeline(service.repo, ack.runId); } };
}/**
 * pipeline/types.ts — vocabulary for mixed-provider stage pipelines.
 *
 * The headline feature this file exists for:
 *
 *     implement → gemini   ·   review → codex   ·   moderate → claude-sonnet
 *
 * One task, a different worker per stage. Nothing in this file knows how to
 * talk to any worker; `StageRunner` (below) is the seam, and it is injected.
 *
 * WHY NO IMPORT FROM providers/
 * providers/ is written concurrently by another engineer. If pipeline/ imported
 * a concrete provider client we would have a compile-order dependency on work
 * that does not exist yet, and pipeline/ could not be tested without spawning
 * real agents. So the dependency points *inward*: pipeline/ declares the shape
 * it needs, forge/ supplies an implementation over providers/ at the composition
 * root (forge/runner.ts, forge/execute.ts). See `createRunnerRouter` in pipeline.ts for the wiring point.
 */
/**
 * Reasoning effort, where the worker supports it.
 *
 * Evidence (measured on this user's own jobs): raising effort to `high` cost
 * **+50% wall clock and 1.9x thinking tokens for ZERO accuracy gain** on an
 * in-band task. That is why `low` is the default everywhere in this codebase
 * and why escalation — not the default — is what buys effort.
 */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Worker `env` keys that are refused, because they change how the worker
 * binary is found, loaded or configured. The env is applied when the CLI is
 * spawned, BEFORE any sandbox it sets up exists: `PATH` can swap the binary
 * for a shim, `NODE_OPTIONS=--import=…` or `DYLD_INSERT_LIBRARIES` run code
 * ahead of the worker, and a provider config dir can drop its read-only
 * settings, while the ack would still report the sandbox as enforced.
 * Matched case-insensitively (Windows env names are).
 */
const ENV_DENYLIST = {
    PATH: 'would change which worker binary runs',
    HOME: 'would change which config the worker loads',
    SHELL: 'would change the shell the worker runs commands with',
    TMPDIR: 'would move the worker\'s temporary and sandbox files',
    NODE_OPTIONS: 'would run code before the worker starts',
    NODE_PATH: 'would change which modules the worker loads',
    PYTHONPATH: 'would change which modules the worker loads',
    PYTHONHOME: 'would change which runtime the worker loads',
    PYTHONSTARTUP: 'would run code before the worker starts',
    // Shell startup files: a shell-based launcher sources these before the worker body runs.
    BASH_ENV: 'would run code before the worker starts',
    ENV: 'would run code before the worker starts',
    ZDOTDIR: 'would run code before the worker starts',
    SHELLOPTS: 'would change how the shell runs the worker',
    PROMPT_COMMAND: 'would run code before the worker starts',
    PERL5OPT: 'would run code before the worker starts',
    RUBYOPT: 'would run code before the worker starts',
};
/**
 * Key prefixes refused for the same reason: the dynamic loader (`LD_`, `DYLD_`),
 * XDG config/data dirs, Agent Smith's own settings (`AGENT_SMITH_*_BIN`,
 * `_HOME`, `_CODEX_SANDBOX`, …) and each provider's config (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`, `KIMI_CODE_HOME`, `OPENCODE_*`, `AGY_*`). The adapters' own
 * keys are all covered here; do not list them again above.
 */
const ENV_DENY_PREFIXES = {
    LD_: 'would change which libraries the worker loads',
    DYLD_: 'would change which libraries the worker loads',
    XDG_: 'would change which config the worker loads',
    AGENT_SMITH_: 'is Agent Smith\'s own setting, not the worker\'s',
    AGY_: 'would change the provider\'s config',
    CLAUDE_: 'would change the provider\'s config',
    CODEX_: 'would change the provider\'s config',
    OPENCODE_: 'would change the provider\'s config',
    KIMI_: 'would change the provider\'s config',
};
/** Why a worker `env` key is refused, or null when it is allowed. */
function deniedEnvReason(key) {
    const upper = key.toUpperCase();
    const exact = ENV_DENYLIST[upper];
    if (exact !== undefined)
        return exact;
    for (const [prefix, why] of Object.entries(ENV_DENY_PREFIXES))
        if (upper.startsWith(prefix))
            return why;
    return null;
}
/** Validate a worker `env` map: plain identifier keys not on the denylist, string values without NUL. Returns it unchanged, or undefined when absent. */
function validateEnv(raw, label = 'env') {
    if (raw === undefined)
        return undefined;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error(`${label} must be an object of string values.`);
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!ENV_KEY.test(key))
            throw new Error(`${label} key "${key}" is not a valid variable name (letters, digits, underscore; no leading digit).`);
        const denied = deniedEnvReason(key);
        if (denied !== null)
            throw new Error(`${label}.${key} ${denied}; it is not allowed in a worker env.`);
        if (typeof value !== 'string' || value.includes('\0'))
            throw new Error(`${label}.${key} must be a string without NUL characters.`);
        out[key] = value;
    }
    return out;
}/**
 * providers/catalog.ts — cached model discovery across providers.
 *
 * Lazy: nothing runs until getCatalogs() is called. Per-provider TTL cache,
 * stale-on-error, parallel fan-out, never rejects.
 */
const CATALOG_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
/** Disk entry: the catalog and when it was discovered (ms). */
function catalogFile(repo, name) {
    return path.join(repo, '.agent-smith', 'catalogs', `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}
function readDisk(repo, name) {
    if (repo === undefined)
        return undefined;
    try {
        const v = JSON.parse(readFileSync(catalogFile(repo, name), 'utf8'));
        const c = v.catalog;
        if (typeof v.at !== 'number' || c === undefined || c === null || c.provider !== name || !Array.isArray(c.models))
            return undefined;
        // A malformed entry must be ignored and rediscovered, never served as fresh: the spawn path
        // reads model ids from it and a null entry would throw inside validation and block the launch.
        const wellFormed = c.models.every((m) => {
            if (m === null || typeof m !== 'object')
                return false;
            const { id, efforts } = m;
            // Validation indexes `efforts`, so a model without a string array there would throw at spawn.
            return typeof id === 'string' && Array.isArray(efforts) && efforts.every((e) => typeof e === 'string');
        });
        if (!wellFormed || typeof c.source !== 'string')
            return undefined;
        return { catalog: c, at: v.at };
    }
    catch {
        return undefined;
    }
}
function writeDisk(repo, name, entry) {
    if (repo === undefined || entry.catalog.source === 'static')
        return;
    try {
        writeJsonAtomic(catalogFile(repo, name), entry);
    }
    catch { /* the disk cache is an optimization */ }
}
const cache = new Map();
let clock = Date.now;
let providerSource = () => PROVIDERS;
function lookup(name) {
    return providerSource().find((p) => p.name === name) ?? (providerSource() === PROVIDERS ? findProvider(name) : undefined);
}
function failed(name, error) {
    return { provider: name, models: [], defaultSource: 'unknown', source: 'live', stale: false, verified: false, error };
}
async function discover(provider, timeoutMs, refresh, repo) {
    const name = provider.name;
    // Memory first, then another process's discovery. `refresh` never serves either as fresh, but an
    // older entry still backs the stale-on-error fallback, and a successful discovery rewrites the file.
    const hit = cache.get(name) ?? readDisk(repo, name);
    if (hit !== undefined && !cache.has(name))
        cache.set(name, hit);
    if (!refresh && hit !== undefined && clock() - hit.at < CATALOG_TTL_MS) {
        return { ...hit.catalog, source: hit.catalog.source === 'static' ? 'static' : 'cache', stale: false };
    }
    let fresh;
    if (provider.listModels === undefined) {
        fresh = failed(name, 'provider does not support model discovery');
    }
    else {
        let timer;
        try {
            // Guard: a misbehaving listModels must not hang the whole fan-out.
            const guard = new Promise((resolve) => {
                timer = setTimeout(() => resolve(failed(name, `model discovery timed out after ${timeoutMs} ms`)), timeoutMs + 1_000);
                timer.unref?.();
            });
            fresh = await Promise.race([provider.listModels({ timeoutMs }), guard]);
        }
        catch (e) {
            fresh = failed(name, errMessage(e));
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    const usable = fresh.error === undefined || fresh.models.length > 0;
    if (usable) {
        const entry = { catalog: fresh, at: clock() };
        cache.set(name, entry);
        writeDisk(repo, name, entry);
        return fresh;
    }
    if (hit !== undefined) {
        return { ...hit.catalog, source: hit.catalog.source === 'static' ? 'static' : 'cache', stale: true, error: fresh.error };
    }
    return fresh;
}
/** Names of installed providers. PATH probes only: cheap, no model discovery. */
async function getInstalledProviders() {
    const all = providerSource();
    const flags = await Promise.all(all.map(async (p) => { try {
        return await p.available();
    }
    catch {
        return false;
    } }));
    return all.filter((_, i) => flags[i]).map((p) => p.name);
}
/** A provider's configured default model/effort from its own config file. Sync, no CLI. */
function getHarnessDefaults(name) {
    try {
        return lookup(name)?.harnessDefaults?.() ?? {};
    }
    catch {
        return {};
    }
}
/** Catalogs for installed providers. Never throws; per-provider failures appear in `error`. */
async function getCatalogs(options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const refresh = options.refresh === true;
    try {
        let targets;
        const missing = [];
        if (options.providers !== undefined) {
            targets = [];
            for (const n of options.providers) {
                const p = lookup(n);
                if (p)
                    targets.push(p);
                else
                    missing.push(failed(n, `unknown provider '${n}'`));
            }
        }
        else {
            const all = providerSource();
            const flags = await Promise.all(all.map(async (p) => {
                try {
                    return await p.available();
                }
                catch {
                    return false;
                }
            }));
            targets = all.filter((_, i) => flags[i]);
        }
        const results = await Promise.all(targets.map((p) => discover(p, timeoutMs, refresh, options.repo).catch((e) => failed(p.name, errMessage(e)))));
        return [...results, ...missing];
    }
    catch (e) {
        return [failed('*', errMessage(e))];
    }
}/**
 * registry.ts — `readObservedJob()`, one fault-isolating read of one job.
 *
 * WHY FAULT ISOLATION MATTERS: readers read state a live worker is rewriting. A
 * reader that throws (bad symlink, exotic errno) must degrade to an `unknown`
 * job, never to a crashed band. Every call here is wrapped.
 */
const READER = new AgentSmithReader();
/**
 * Read + normalize one job, isolating failures.
 *
 * Returns `null` if the reader returns null (job not known to it), and an
 * `unknown` job if either the read or the normalize threw. A throw here
 * is a bug we want visible in tests, but it must not take down a caller that
 * is polling every 100ms.
 */
async function readObservedJob(cwd, jobId) {
    const provider = READER.provider;
    let raw;
    try {
        raw = await READER.read(cwd, jobId);
    }
    catch (err) {
        // Surface as unknown rather than propagating.
        return unknownJob(provider, jobId, errText(err));
    }
    if (raw === null)
        return null;
    try {
        return normalize(raw);
    }
    catch (err) {
        return unknownJob(provider, jobId, `normalize: ${errText(err)}`);
    }
}
/** A defensive `unknown` ObservedJob used when a read/normalize fails. */
function unknownJob(provider, jobId, detail) {
    return {
        provider,
        jobId,
        status: "unknown",
        warnings: [
            { code: "incomplete_state", message: `Failed to read state: ${detail}` },
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
        raw: {},
    };
}
function errText(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}const DIRTY_FILES_CAP = 20;
function workspaceLine(mode, cwd) {
    if (mode === 'review' || mode === 'moderate')
        return `Workspace: ${cwd}.`;
    return `Workspace: ${cwd}. Make changes only inside it; edits elsewhere go unreviewed.`;
}
function dirtyFilesLine(dirtyFiles) {
    if (dirtyFiles === undefined || dirtyFiles.length === 0)
        return null;
    const shown = dirtyFiles.slice(0, DIRTY_FILES_CAP);
    const rest = dirtyFiles.length - shown.length;
    const list = rest > 0 ? `${shown.join(', ')}, and ${rest} more` : shown.join(', ');
    return `Already modified before you started; not yours, leave them unless the task says otherwise: ${list}`;
}
function checkLine(check) {
    const command = check.command.includes('`') ? check.command : `\`${check.command}\``;
    return `- ${check.name}: ${command}${check.cwd === undefined ? '' : ` (in ${check.cwd})`}`;
}
function checkLines(checks, mode) {
    const gating = checks.filter((c) => c.blocking !== false);
    const advisory = checks.filter((c) => c.blocking === false);
    const gatingHeader = mode === 'review' || mode === 'moderate' || mode === 'verify'
        ? 'These run after you finish; report their result if you run them:'
        : "You're done when these checks pass. They run after you finish, so run them yourself first if you can:";
    return [
        ...(gating.length === 0 ? [] : [gatingHeader, ...gating.map(checkLine)]),
        ...(advisory.length === 0
            ? []
            : ['These also run afterwards, for information only:', ...advisory.map(checkLine)]),
    ];
}
/** The brief, or '' when there is nothing to add. Joined to the prompt with a blank line. */
function buildBrief(input) {
    const context = input.context?.trim();
    const contextLines = context ? [`Context: ${context}`] : [];
    const checks = input.checks?.length ? checkLines(input.checks, input.mode) : [];
    if (input.resuming === true)
        return [...contextLines, ...checks].join('\n');
    const dirtyLine = input.pipelineStage === true ? null : dirtyFilesLine(input.dirtyFiles);
    return [
        "You're working for an orchestrating agent that will check your work and act on your report.",
        ...(input.pipelineStage === true ? [] : [workspaceLine(input.mode, input.cwd)]),
        ...(dirtyLine === null ? [] : [dirtyLine]),
        ...contextLines,
        ...checks,
        ...(input.preset === undefined ? [] : [input.preset.guidance]),
        'Start your report with `Status: DONE`, `Status: DONE_WITH_CONCERNS` or `Status: BLOCKED`. ' +
            "Only claim what you can point to (command output, file contents, a diff); say what you couldn't verify. " +
            'If the task conflicts with what you find, say so rather than guess.',
    ].join('\n');
}function appendSteerEntry(repo, jobId, entry) {
    const dir = jobDir(repo, jobId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(jobFile(repo, jobId, FILES.steer), `${JSON.stringify(entry)}\n`, 'utf8');
}
function readSteerEntries(repo, jobId) {
    const file = jobFile(repo, jobId, FILES.steer);
    let text;
    try {
        text = readFileSync(file, 'utf8');
    }
    catch {
        return [];
    }
    const out = [];
    const seenIds = new Set();
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '')
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed.id === 'string' &&
                typeof parsed.createdAt === 'string' &&
                typeof parsed.prompt === 'string' &&
                (parsed.delivery === 'queue' || parsed.delivery === 'interrupt') &&
                !seenIds.has(parsed.id)) {
                seenIds.add(parsed.id);
                out.push(parsed);
            }
        }
        catch { }
    }
    return out;
}
function readCount(repo, jobId, name) {
    try {
        const n = Number.parseInt(readFileSync(jobFile(repo, jobId, name), 'utf8').trim(), 10);
        return Number.isInteger(n) && n >= 0 ? n : 0;
    }
    catch {
        return 0;
    }
}
function readConsumedCount(repo, jobId) {
    return readCount(repo, jobId, FILES.steerConsumed);
}
function writeConsumedCount(repo, jobId, n) {
    writeAtomic(jobFile(repo, jobId, FILES.steerConsumed), `${n}\n`);
}
function readDiscardCut(repo, jobId) {
    return readCount(repo, jobId, FILES.steerDiscard);
}
function writeDiscardCut(repo, jobId, n) {
    writeAtomic(jobFile(repo, jobId, FILES.steerDiscard), `${n}\n`);
}
function undeliveredEntries(repo, jobId) {
    const discarded = existsSync(jobFile(repo, jobId, FILES.steerDiscard)) ? readDiscardCut(repo, jobId) : 0;
    return readSteerEntries(repo, jobId).slice(Math.max(readConsumedCount(repo, jobId), discarded));
}
function quoted(entries) {
    return `"${entries[0]?.prompt.replace(/\s+/g, ' ').trim().slice(0, 80) ?? ''}"`;
}
function messages(n) {
    return `${n} queued message${n === 1 ? '' : 's'}`;
}
function notSentWarning(entries, reason) {
    return `${messages(entries.length)} not sent (${reason}): ${quoted(entries)}`;
}
function discardedWarning(discarded) {
    return `${messages(discarded.length)} discarded: ${quoted(discarded)}`;
}
function liveDeliverable(e) {
    return e.delivery === 'queue'
        && (e.overrides === undefined || Object.keys(e.overrides).length === 0)
        && (e.files === undefined || e.files.length === 0)
        && e.context === undefined;
}
function liveMessageText(e) {
    return e.prompt;
}
function buildSteeredPrompt(input) {
    const steerBody = input.entries.length === 1
        ? input.entries[0].prompt
        : input.entries.map((e, idx) => `[Steer ${idx + 1} (${e.createdAt})]\n${e.prompt}`).join('\n\n');
    const tag = input.freshContinuation
        ? '[FRESH CONTINUATION]'
        : input.wasInterrupted
            ? '[TURN INTERRUPTED]'
            : `[FOLLOW-UP STEER · ${input.entries.length} queued update${input.entries.length === 1 ? '' : 's'}]`;
    const statusLine = input.wasInterrupted
        ? 'Your previous turn was interrupted with updated instructions. Inspect your working tree before repeating any completed steps.'
        : `Your previous turn ${input.priorStatus === undefined || input.priorStatus === 'succeeded' ? 'completed' : `ended ${input.priorStatus}`}.`;
    const syncedLine = input.syncedFiles !== undefined && input.syncedFiles.length > 0
        ? `\nSynced brief file(s) in your working tree: ${input.syncedFiles.join(', ')} (re-read before continuing).`
        : '';
    const tailBlock = input.freshContinuation && input.responseTail
        ? `\nLast response excerpt from previous turn:\n${input.responseTail}\n`
        : '';
    const verdictBlock = input.verdict ? `\n${input.verdict}\n` : '';
    const header = `${tag}\n${statusLine}${syncedLine}${verdictBlock}${tailBlock}\n[ORCHESTRATOR UPDATE]\n${steerBody}`;
    const prependBrief = input.brief !== '' && !header.startsWith(input.brief);
    const sentPrompt = prependBrief ? `${input.brief}\n\n${header}` : header;
    return { rawPrompt: header, sentPrompt, prependBrief };
}
function readSteerHead(repo, jobId) {
    try {
        const line = readFileSync(jobFile(repo, jobId, FILES.steerHead), 'utf8')
            .split('\n')
            .map((s) => s.trim())
            .find((s) => s !== '');
        return line ?? null;
    }
    catch {
        return null;
    }
}/** Service-owned recovery of abandoned jobs. Readers never write job records. */
/**
 * A dead recorded supervisor cannot complete another write. Do not persist the
 * timeout heuristic for PID-less legacy jobs: their writer may still be alive.
 * Re-read the anchor and result immediately before writing, without yielding,
 * so an already published completion always wins. Concurrent recovery passes
 * may publish the same verdict; neither can replace a terminal anchor.
 */
function reconcileOrphan(repo, jobId, now = Date.now()) {
    const file = jobFile(repo, jobId, FILES.job);
    try {
        const before = readFileSync(file, 'utf8');
        const manifest = JSON.parse(before);
        if (manifest.schema !== SCHEMA_VERSION || manifest.jobId !== jobId
            || validOwnerPid(manifest) === null || ownerAlive(manifest))
            return false;
        if (manifest.status !== 'running') {
            if (isTerminalForgeStatus(manifest.status)
                && typeof manifest.finishedAt === 'string')
                abandonPendingAcceptance(repo, jobId, manifest.finishedAt);
            abandonQueue(repo, jobId);
            return false;
        }
        const resultFile = jobFile(repo, jobId, FILES.result);
        const resultBefore = readOptional(resultFile);
        const result = recoverableResult(resultBefore, manifest);
        const cancelFile = jobFile(repo, jobId, FILES.cancel);
        const cancelSteerFile = jobFile(repo, jobId, FILES.cancelSteer);
        const canceled = existsSync(cancelFile) || existsSync(cancelSteerFile);
        const report = result === null ? null : reportFor(result);
        // Without the writer, the cwd and the mode (plus the completed-edit count
        // in progress.json) are all recovery can prove about a writing job.
        const facts = cwdFacts(manifest.cwd, manifest.mode, editedOnDisk(repo, jobId));
        const deniedActions = result === null ? [] : normalizeDenials(result.deniedActions);
        const verdict = result === null
            ? deriveOrphan(manifest, null, now, undefined, canceled)
            : deriveStatus({
                alreadyTerminal: canceled || result.status === 'cancelled' ? 'canceled' : null,
                ok: result.ok, jobStatus: result.status,
                deniedActions, report,
                ...facts,
            });
        if (verdict === null)
            return false;
        if (readFileSync(file, 'utf8') !== before || ownerAlive(manifest)
            || readOptional(resultFile) !== resultBefore
            || (existsSync(cancelFile) || existsSync(cancelSteerFile)) !== canceled)
            return false;
        if (result !== null) {
            // The provider persisted completion before the supervisor published its
            // anchor. Restore the same report/verdict, without replaying checks or
            // claiming that finish-time git attribution was captured.
            writeAtomic(jobFile(repo, jobId, FILES.report), report ?? '');
            if (readFileSync(file, 'utf8') !== before || ownerAlive(manifest)
                || readOptional(resultFile) !== resultBefore
                || (existsSync(cancelFile) || existsSync(cancelSteerFile)) !== canceled)
                return false;
            writeJsonAtomic(file, {
                ...manifest, status: verdict.status, jobStatus: result.status,
                updatedAt: result.finishedAt, finishedAt: result.finishedAt,
                startedAt: manifest.startedAt ?? result.startedAt, exitCode: result.exitCode,
                conversation: recoveredConversation(result) ?? manifest.conversation,
                ...failureFields(verdict, { ...result, deniedActions }),
                deniedActions: deniedActions.map(({ action, displayName, nonfatal }) => ({
                    ...(action === undefined ? {} : { action }),
                    ...(displayName === undefined ? {} : { displayName }),
                    ...(nonfatal === true ? { nonfatal: true } : {}),
                })),
                usage: result.usage === undefined ? null : Object.fromEntries(Object.entries(result.usage).filter((entry) => typeof entry[1] === 'number')),
                // The conclusion is at the end of the response (same rule as writer.finish).
                latestSummary: summaryTail(result.response, 1_000) || manifest.latestSummary || null,
                summarySource: result.response.trim() || manifest.latestSummary ? 'worker' : null,
                // Recovery never runs the finish-time git diff.
                changedFilesUnknown: true,
                ...(facts.cwdMissing ? { cwdMissingAtFinish: true } : {}),
            });
            abandonPendingAcceptance(repo, jobId, result.finishedAt);
            abandonQueue(repo, jobId);
            return true;
        }
        const at = new Date(now).toISOString();
        writeJsonAtomic(file, {
            ...manifest, status: verdict.status, error: verdict.reason,
            reason: verdict.status === 'failed' ? REASONS.serverStopped : null, jobStatus: 'orphaned',
            updatedAt: at, finishedAt: at,
        });
        abandonPendingAcceptance(repo, jobId, at);
        abandonQueue(repo, jobId);
        return true;
    }
    catch {
        return false;
    } // An unreadable anchor remains unknown; do not invent it.
}
function abandonPendingAcceptance(repo, jobId, at) {
    const acceptance = readAcceptance(repo, jobId);
    if ('pending' in acceptance && acceptance.pending === true) {
        writeAcceptance(repo, jobId, {
            state: 'rejected', checks: [], at, pending: false,
            reason: 'server stopped; checks not run',
        });
    }
}
function abandonQueue(repo, jobId) {
    const ownerDone = jobFile(repo, jobId, FILES.ownerDone);
    if (existsSync(ownerDone))
        return;
    const undelivered = undeliveredEntries(repo, jobId);
    for (const name of [FILES.job, FILES.progress]) {
        const file = jobFile(repo, jobId, name);
        let doc;
        try {
            doc = JSON.parse(readFileSync(file, 'utf8'));
        }
        catch {
            continue;
        }
        const warnings = Array.isArray(doc['warnings']) ? doc['warnings'] : [];
        const warning = undelivered.length > 0 && name === FILES.progress ? notSentWarning(undelivered, 'owner stopped') : null;
        const pending = typeof doc['pendingSteers'] === 'number' && doc['pendingSteers'] > 0;
        if (!pending && (warning === null || warnings.includes(warning)))
            continue;
        writeJsonAtomic(file, {
            ...doc, pendingSteers: 0,
            ...(warning === null || warnings.includes(warning) ? {} : { warnings: [...warnings, warning] }),
        });
    }
    if (undelivered.length > 0)
        createMarker(ownerDone, new Date().toISOString());
}
/**
 * progress.json recorded at least one completed edit (evidence the job wrote).
 * `editsCompleted` counts only edits that ended without error; the digest's
 * `editedCount` counts at start and is read only for files written before the
 * counter existed.
 */
function editedOnDisk(repo, jobId) {
    try {
        const p = JSON.parse(readFileSync(jobFile(repo, jobId, FILES.progress), 'utf8'));
        if (typeof p.editsCompleted === 'number')
            return p.editsCompleted > 0;
        return typeof p.digest?.editedCount === 'number' && p.digest.editedCount > 0;
    }
    catch {
        return false;
    }
}
/** Missing or partially written provider output cannot keep a dead job running. */
function readOptional(file) {
    try {
        return readFileSync(file, 'utf8');
    }
    catch {
        return null;
    }
}
function recoverableResult(body, manifest) {
    if (body === null)
        return null;
    try {
        const result = JSON.parse(body);
        const statuses = ['success', 'error', 'denied', 'timeout', 'cancelled', 'malformed', 'spawn-failed'];
        if (result === null || typeof result !== 'object'
            || result.jobId !== manifest.jobId || result.provider !== manifest.provider
            || typeof result.ok !== 'boolean' || !statuses.includes(result.status)
            || typeof result.response !== 'string'
            || !(result.exitCode === null || Number.isInteger(result.exitCode))
            || typeof result.startedAt !== 'string' || !Number.isFinite(Date.parse(result.startedAt))
            || typeof result.finishedAt !== 'string' || !Number.isFinite(Date.parse(result.finishedAt))
            || (result.error !== undefined && typeof result.error !== 'string')
            || (result.deniedActions !== undefined && (!Array.isArray(result.deniedActions)
                || result.deniedActions.some(d => d === null || typeof d !== 'object'
                    || (d.action !== undefined && typeof d.action !== 'string')
                    || (d.displayName !== undefined && typeof d.displayName !== 'string'))))
            || (result.usage !== undefined && (result.usage === null || typeof result.usage !== 'object'
                || Array.isArray(result.usage))))
            return null;
        return result;
    }
    catch {
        return null;
    }
}
/** Older running anchors did not persist the provider's started-event identity. */
function recoveredConversation(result) {
    if (result.raw === null || typeof result.raw !== 'object')
        return null;
    const raw = result.raw;
    const key = result.provider === 'agy' ? 'conversation_id'
        : result.provider === 'codex' ? 'threadId'
            : result.provider === 'claude' || result.provider === 'opencode' || result.provider === 'kimi' ? 'sessionId' : null;
    const value = key === null ? null : raw[key];
    return typeof value === 'string' && value.trim() !== '' ? value : null;
}const LOCK_WAIT_MS = 5_000;
const EMPTY_LOCK_STALE_MS = 2_000;
const POLL_MS = 10;
const SAFE_ID$1 = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const heldHere = new Set();
let breakCounter = 0;
function workerFileKey(workerId) {
    if (SAFE_ID$1.test(workerId) && workerId !== '.' && workerId !== '..')
        return workerId;
    if (workerId === '')
        throw new Error('Invalid worker id');
    return `h-${createHash('sha256').update(workerId).digest('hex').slice(0, 40)}`;
}
function workerLockPath(repo, workerId) {
    return path.join(repo, WORKERS_DIR, `${workerFileKey(workerId)}.lock`);
}
function holdsWorkerLock(repo, workerId) {
    return heldHere.has(key(repo, workerId));
}
function key(repo, workerId) {
    return `${path.resolve(repo)}\0${workerId}`;
}
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        // EPERM: the process exists but belongs to someone else.
        return err.code === 'EPERM';
    }
}
function parsePid(body) {
    const pid = Number.parseInt(body.split('\n')[0] ?? '', 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}
function isStale(body, mtimeMs, now) {
    const pid = parsePid(body);
    if (pid === null)
        return now - mtimeMs > EMPTY_LOCK_STALE_MS;
    return !pidAlive(pid);
}
function tryAcquire(file) {
    mkdirSync(path.dirname(file), { recursive: true });
    const body = `${process.pid}\n${new Date().toISOString()}\n`;
    let fd;
    try {
        fd = openSync(file, 'wx');
    }
    catch (err) {
        if (err.code === 'EEXIST') {
            breakIfStale(file);
            return null;
        }
        throw err;
    }
    try {
        writeSync(fd, body);
    }
    finally {
        closeSync(fd);
    }
    return body;
}
/**
 * Break a stale lock without the read-then-unlink race: move it aside under a
 * unique name, then look at what was moved. If it turns out to be live (it was
 * replaced between our read and the rename), put it back with link(), which
 * fails rather than overwrite a lock created meanwhile.
 */
function breakIfStale(file) {
    let body;
    let mtimeMs;
    try {
        body = readFileSync(file, 'utf8');
        mtimeMs = statSync(file).mtimeMs;
    }
    catch {
        return;
    }
    if (!isStale(body, mtimeMs, Date.now()))
        return;
    breakCounter += 1;
    const aside = `${file}.stale-${process.pid}-${breakCounter}`;
    try {
        renameSync(file, aside);
    }
    catch {
        return;
    }
    let moved = '';
    try {
        moved = readFileSync(aside, 'utf8');
    }
    catch { }
    if (moved !== body && !isStale(moved, Date.now(), Date.now())) {
        try {
            linkSync(aside, file);
        }
        catch { }
    }
    try {
        unlinkSync(aside);
    }
    catch { }
}
function release(file, body) {
    try {
        if (readFileSync(file, 'utf8') === body)
            unlinkSync(file);
    }
    catch { }
}
const sleepSync = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
function holderOf(file) {
    try {
        return readFileSync(file, 'utf8').split('\n')[0] || 'unknown';
    }
    catch {
        return 'unknown';
    }
}
function timeoutError(workerId, file, waitMs) {
    return new Error(`worker "${workerId}" is locked by pid ${holderOf(file)}; gave up after ${waitMs} ms (${file}).`);
}
function withWorkerLockSync(repo, workerId, fn, options = {}) {
    const file = workerLockPath(repo, workerId);
    const k = key(repo, workerId);
    if (heldHere.has(k))
        throw new Error(`worker "${workerId}" lock is already held by this process (not reentrant).`);
    const waitMs = options.waitMs ?? LOCK_WAIT_MS;
    const deadline = Date.now() + waitMs;
    let body = tryAcquire(file);
    while (body === null) {
        if (Date.now() >= deadline)
            throw timeoutError(workerId, file, waitMs);
        sleepSync(POLL_MS);
        body = tryAcquire(file);
    }
    heldHere.add(k);
    try {
        return fn();
    }
    finally {
        heldHere.delete(k);
        release(file, body);
    }
}
async function withWorkerLock(repo, workerId, fn, options = {}) {
    const file = workerLockPath(repo, workerId);
    const k = key(repo, workerId);
    const waitMs = options.waitMs ?? LOCK_WAIT_MS;
    const startedAt = Date.now();
    let nextNotice = startedAt + LOCK_WAIT_MS;
    let body = heldHere.has(k) ? null : tryAcquire(file);
    while (body === null) {
        const now = Date.now();
        if (now - startedAt >= waitMs)
            throw timeoutError(workerId, file, waitMs);
        if (options.onWait !== undefined && now >= nextNotice) {
            options.onWait(now - startedAt, holderOf(file));
            nextNotice = now + LOCK_WAIT_MS;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
        body = heldHere.has(k) ? null : tryAcquire(file);
    }
    heldHere.add(k);
    try {
        return await fn();
    }
    finally {
        heldHere.delete(k);
        release(file, body);
    }
}const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const INDEX_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/;
function workerIndexFile(repo, workerId) {
    return path.join(repo, WORKERS_DIR, `${workerFileKey(workerId)}.json`);
}
function readIndexFile(file) {
    try {
        return parseWorkerIndex(JSON.parse(readFileSync(file, 'utf8')));
    }
    catch {
        return null;
    }
}
function startMs(m) {
    const ms = Date.parse(m.startedAt ?? m.createdAt ?? '');
    return Number.isFinite(ms) ? ms : 0;
}
const MTIME_SETTLE_MS = 50;
function settled(mtimeMs) {
    return Date.now() - mtimeMs > MTIME_SETTLE_MS ? mtimeMs : Number.NaN;
}
function mtimeOf(dir) {
    try {
        return statSync(dir).mtimeMs;
    }
    catch {
        return -1;
    }
}
function readWorkerIndex(repo, workerId) {
    if (workerId === '')
        return null;
    const index = readIndexFile(workerIndexFile(repo, workerId));
    return index !== null && index.workerId === workerId ? index : null;
}
function writeWorkerIndex(repo, index) {
    writeJsonAtomic(workerIndexFile(repo, index.workerId), index);
}
function appendTurnsLocked(repo, workerId, name, jobIds, legacyTurns = []) {
    const current = readWorkerIndex(repo, workerId);
    const turns = [...(current?.turns ?? legacyTurns)];
    const have = new Set(turns);
    for (const id of jobIds)
        if (!have.has(id)) {
            turns.push(id);
            have.add(id);
        }
    const next = { schema: 1, workerId, name: current?.name ?? name, turns, updatedAt: new Date().toISOString() };
    writeWorkerIndex(repo, next);
    return next;
}
function underLock(repo, workerId, lockHeld, fn) {
    return lockHeld || holdsWorkerLock(repo, workerId) ? fn() : withWorkerLockSync(repo, workerId, fn);
}
class WorkerIndexStore {
    repo;
    read;
    byName = new Map();
    names = new Map();
    jobWorker = new Map();
    seenIndexFiles = new Set();
    seenJobs = new Set();
    workersMtime = Number.NaN;
    jobsMtime = Number.NaN;
    constructor(repo, options = {}) {
        this.repo = repo;
        this.read = options.readManifest ?? ((id) => { try {
            return readManifest(repo, id);
        }
        catch {
            return null;
        } });
    }
    remember(index) {
        this.names.set(index.workerId, index.name);
        let set = this.byName.get(index.name);
        if (set === undefined)
            this.byName.set(index.name, (set = new Set()));
        set.add(index.workerId);
        for (const id of index.turns) {
            this.jobWorker.set(id, index.workerId);
            this.seenJobs.add(id);
        }
    }
    get(workerId) {
        const index = readWorkerIndex(this.repo, workerId);
        if (index !== null)
            this.remember(index);
        return index;
    }
    workersNamed(name) {
        this.refresh();
        return [...(this.byName.get(name) ?? [])];
    }
    refresh() {
        const workersDir = path.join(this.repo, WORKERS_DIR);
        const wm = mtimeOf(workersDir);
        if (wm !== this.workersMtime) {
            // A directory mtime advances in ticks (ms on Linux): an entry created in the
            // same tick as the last one seen leaves it unchanged. Trust an mtime only
            // once it is older than one tick window, so the next call re-reads.
            this.workersMtime = settled(wm);
            let files = [];
            try {
                files = readdirSync(workersDir);
            }
            catch { }
            for (const f of files) {
                if (this.seenIndexFiles.has(f))
                    continue;
                if (!INDEX_FILE.test(f))
                    continue;
                const index = readIndexFile(path.join(workersDir, f));
                if (index === null)
                    continue;
                this.seenIndexFiles.add(f);
                this.remember(index);
            }
        }
        const jdir = jobsDir(this.repo);
        const jm = mtimeOf(jdir);
        if (jm === this.jobsMtime)
            return;
        let ids = [];
        try {
            ids = readdirSync(jdir);
        }
        catch { }
        const unindexed = new Map();
        let complete = true;
        for (const id of ids) {
            if (this.seenJobs.has(id) || !SAFE_ID.test(id))
                continue;
            const manifest = this.read(id);
            if (manifest === null) {
                complete = false;
                continue;
            }
            if (typeof manifest.turn === 'number') {
                this.seenJobs.add(id);
                continue;
            }
            const workerId = typeof manifest.workerId === 'string' && manifest.workerId !== '' ? manifest.workerId : id;
            const list = unindexed.get(workerId);
            if (list === undefined)
                unindexed.set(workerId, [manifest]);
            else
                list.push(manifest);
        }
        for (const [workerId, manifests] of unindexed) {
            try {
                this.indexLegacy(workerId, manifests);
            }
            catch {
                complete = false;
            }
        }
        if (complete)
            this.jobsMtime = settled(jm);
    }
    indexLegacy(workerId, manifests) {
        const fresh = this.get(workerId);
        const missing = manifests.filter((m) => !(fresh?.turns ?? []).includes(m.jobId));
        if (missing.length === 0) {
            for (const m of manifests)
                this.seenJobs.add(m.jobId);
            return;
        }
        const sorted = [...missing].sort((a, b) => startMs(a) - startMs(b) || a.jobId.localeCompare(b.jobId));
        const name = [...sorted].reverse().find((m) => typeof m.name === 'string' && m.name !== '')?.name ?? workerId;
        const index = underLock(this.repo, workerId, false, () => {
            const existing = readWorkerIndex(this.repo, workerId);
            if (existing === null) {
                return appendTurnsLocked(this.repo, workerId, name, sorted.map((m) => m.jobId));
            }
            return appendTurnsLocked(this.repo, workerId, name, sorted.map((m) => m.jobId).filter((id) => !existing.turns.includes(id)));
        });
        this.remember(index);
        for (const m of manifests)
            this.seenJobs.add(m.jobId);
    }
    scanWorker(workerId, exclude) {
        let ids = [];
        try {
            ids = readdirSync(jobsDir(this.repo));
        }
        catch {
            return [];
        }
        const found = [];
        for (const id of ids) {
            if (id === exclude || !SAFE_ID.test(id))
                continue;
            const m = this.read(id);
            if (m !== null && (m.workerId ?? id) === workerId)
                found.push(m);
        }
        return found.sort((a, b) => startMs(a) - startMs(b) || a.jobId.localeCompare(b.jobId)).map((m) => m.jobId);
    }
    recordTurnStart(input) {
        const { workerId, name, jobId } = input;
        const index = underLock(this.repo, workerId, input.lockHeld === true, () => {
            const needsLegacy = input.continuation && !existsSync(workerIndexFile(this.repo, workerId));
            const legacy = needsLegacy ? this.scanWorker(workerId, jobId) : [];
            const next = appendTurnsLocked(this.repo, workerId, name, [jobId], legacy);
            input.alsoLocked?.();
            return next;
        });
        this.remember(index);
        return index;
    }
    workerOf(jobId) {
        return this.jobWorker.get(jobId);
    }
}const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 6 * 60 * 60_000;
function resolveTimeoutMs(ms) {
    if (ms === undefined)
        return DEFAULT_TIMEOUT_MS$1;
    if (!Number.isFinite(ms) || ms <= 0) {
        throw new RangeError(`timeoutMs must be a positive finite number, got ${ms}`);
    }
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(ms)));
}
function requireProvider(name) {
    if (findProvider(name) === undefined) {
        throw new Error(`unknown provider "${name}". Known providers: ${providerNames().join(', ')}.`);
    }
    return getProvider(name);
}
function modeError(mode) {
    const lines = MODES.map((m) => `  ${m}: ${MODE_PRESETS[m].description}`).join('\n');
    return new Error(`${mode === '' ? 'mode is required' : `unknown mode "${mode}"`}. Valid modes:\n${lines}`);
}
const ENV_KEYS_FILE = 'env-keys.json';
const AGY_EFFORT_SUFFIX = /-(low|medium|high)$/;
function checkAgainstCatalog(provider, model, effort, catalog) {
    const warnings = [];
    if (model === undefined && effort === undefined)
        return warnings;
    const fresh = catalog !== undefined &&
        !catalog.stale &&
        catalog.error === undefined &&
        catalog.verified !== false &&
        catalog.source !== 'static' &&
        catalog.models.length > 0;
    if (!fresh) {
        const why = catalog === undefined
            ? 'no catalog available'
            : catalog.error !== undefined
                ? `catalog error: ${catalog.error}`
                : catalog.stale
                    ? 'catalog is stale'
                    : catalog.models.length === 0
                        ? 'catalog is empty'
                        : catalog.source === 'static'
                            ? 'catalog is a static alias list; full model names are also valid'
                            : 'catalog is unverified';
        warnings.push(`could not verify ${[model === undefined ? '' : `model "${model}"`, effort === undefined ? '' : `effort "${effort}"`].filter(Boolean).join(' / ')} for ${provider} (${why}); passing it through unchecked.`);
        return warnings;
    }
    const ids = catalog.models.map((m) => m.id);
    let match = model === undefined ? undefined : catalog.models.find((m) => m.id === model);
    if (model !== undefined && match === undefined && provider === 'agy') {
        const base = model.replace(AGY_EFFORT_SUFFIX, '');
        if (base !== model)
            match = catalog.models.find((m) => m.id === base);
    }
    if (model !== undefined && match === undefined) {
        throw new Error(`unknown model "${model}" for ${provider}. Valid model ids: ${ids.join(', ')}.`);
    }
    if (effort !== undefined) {
        const target = match ?? (catalog.defaultModel === undefined ? undefined : catalog.models.find((m) => m.id === catalog.defaultModel));
        const efforts = Array.isArray(target?.efforts) ? target.efforts : [];
        if (target !== undefined && efforts.length > 0 && !efforts.includes(effort)) {
            throw new Error(`effort "${effort}" is not valid for ${provider} model "${target.id}". Valid efforts: ${efforts.join(', ')}.`);
        }
    }
    return warnings;
}
function turnStartInput(provider, spec, turn) {
    return {
        name: spec.name,
        workerId: spec.workerId,
        task: turn.task,
        provider,
        mode: spec.mode,
        model: spec.model ?? null,
        effort: spec.effort ?? null,
        cwd: spec.cwd,
        prompt: turn.prompt,
        ...(turn.preamble === undefined ? {} : { preamble: turn.preamble }),
        unrestricted: spec.unrestricted,
        conversation: turn.conversation,
        timeoutMs: spec.timeoutMs,
        pipeline: spec.pipeline,
        stage: spec.stage,
        attempt: spec.attempt,
        modelRequested: spec.modelRequested,
        modelResolved: spec.modelResolved,
        modelSource: spec.modelSource,
        preambleApplied: turn.preambleApplied,
        sandbox: spec.sandbox,
        sandboxFlags: [...spec.sandboxFlags],
        readOnlyRequested: spec.readOnlyRequested,
        readOnlyEnforced: spec.readOnlyEnforced,
        ...(turn.turn === undefined ? {} : { turn: turn.turn }),
        ...(turn.continuedFrom === undefined ? {} : { continuedFrom: turn.continuedFrom }),
        ...(turn.continuationKind === undefined ? {} : { continuationKind: turn.continuationKind }),
        ...(turn.chainStartedAt === undefined ? {} : { chainStartedAt: turn.chainStartedAt }),
        ...(turn.watchedFiles === undefined ? {} : { watchedFiles: turn.watchedFiles }),
    };
}function toSummary(observed) {
    const raw = observed.raw;
    const toolCalls = typeof raw['tool_calls'] === 'number' ? raw['tool_calls'] : null;
    const task = typeof raw['task'] === 'string' && raw['task'] !== '' ? raw['task'] : null;
    const changedFiles = raw['changed_files'];
    const digest = readDigest(raw['digest']);
    const activities = Array.isArray(raw['recent_activities']) ? raw['recent_activities'] : [];
    const currentActivity = observed.status === 'running'
        ? [...activities].reverse().find(isActiveForgeActivity) ?? null
        : null;
    const turn = typeof raw['turn'] === 'number' && Number.isInteger(raw['turn']) && raw['turn'] >= 1 ? raw['turn'] : 1;
    const continuedFrom = typeof raw['continuedFrom'] === 'string' && raw['continuedFrom'] !== '' ? raw['continuedFrom'] : undefined;
    const continuationKind = normalizeContinuationKind(raw['continuationKind']) ?? (continuedFrom !== undefined ? 'follow-up' : undefined);
    const chainStartedAt = typeof raw['chainStartedAt'] === 'string' && raw['chainStartedAt'] !== ''
        ? raw['chainStartedAt']
        : (observed.startedAt ?? undefined);
    return {
        jobId: observed.jobId,
        name: typeof raw['name'] === 'string' && raw['name'] ? raw['name'] : observed.jobId,
        workerId: typeof raw['workerId'] === 'string' && raw['workerId'] !== '' ? raw['workerId'] : observed.jobId,
        turn,
        role: typeof raw['role'] === 'string' ? raw['role'] : observed.mode,
        latestSummary: raw['summarySource'] === 'worker' && typeof raw['latestSummary'] === 'string' ? raw['latestSummary'] : null,
        summarySource: raw['summarySource'] === 'worker' ? 'worker' : null,
        status: observed.status,
        provider: typeof raw['provider'] === 'string' ? raw['provider'] : observed.label,
        unrestricted: raw['unrestricted'] === true,
        nextAction: nextActionFor({
            status: observed.status,
            jobStatus: typeof raw['job_status'] === 'string' ? raw['job_status'] : null,
            error: [typeof raw['error'] === 'string' ? raw['error'] : '', ...observed.warnings.map((w) => w.message)].join(' — '),
            report: observed.output,
            exitCode: typeof raw['exit_code'] === 'number' ? raw['exit_code'] : null,
            deniedCount: Array.isArray(raw['denied_actions']) ? raw['denied_actions'].length : 0,
            unrestricted: raw['unrestricted'] === true,
            steerNotApplied: observed.warnings.some((w) => w.code === 'steer_not_applied'),
            failedEarly: raw['failedEarly'] === true,
        }),
        mode: observed.mode,
        model: observed.model,
        task,
        toolCalls,
        currentActivity,
        lastActivity: isForgeActivity(raw['last_activity']) ? raw['last_activity']
            : [...activities].reverse().find(isForgeActivity) ?? null,
        startedAt: observed.startedAt,
        updatedAt: observed.updatedAt,
        finishedAt: observed.finishedAt,
        warnings: observed.warnings.map((w) => ({ code: w.code, message: w.message })),
        ...(typeof raw['supersededBy'] === 'string' || raw['supersededBy'] === null
            ? { supersededBy: raw['supersededBy'] }
            : {}),
        ...(typeof raw['followedBy'] === 'string' && raw['followedBy'] !== '' ? { followedBy: raw['followedBy'] } : {}),
        ...(continuedFrom !== undefined ? { continuedFrom } : {}),
        ...(continuationKind !== undefined ? { continuationKind } : {}),
        ...(chainStartedAt !== undefined ? { chainStartedAt } : {}),
        ...(typeof raw['pendingSteers'] === 'number'
            ? { pendingSteers: raw['pendingSteers'] }
            : {}),
        ...(Array.isArray(changedFiles) ? { changedFileCount: changedFiles.length } : {}),
        ...(digest !== null ? { digest } : {}),
        ...(typeof raw['toolErrors'] === 'number' && raw['toolErrors'] > 0 ? { toolErrors: raw['toolErrors'] } : {}),
        ...(raw['failedEarly'] === true ? { failedEarly: true } : {}),
        ...(raw['changedFilesUnknown'] === true ? { changedFilesUnknown: true } : {}),
        ...(raw['cwdMissingAtFinish'] === true ? { cwdMissingAtFinish: true } : {}),
        ...(typeof raw['last_event_at'] === 'string' ? { lastEventAt: raw['last_event_at'] } : {}),
        ...(typeof raw['last_alive_at'] === 'string' ? { lastAliveAt: raw['last_alive_at'] } : {}),
    };
}
function readDigest(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v))
        return null;
    const d = v;
    if (typeof d['phase'] !== 'string' || !Array.isArray(d['edited']))
        return null;
    const n = (key) => typeof d[key] === 'number' ? d[key] : 0;
    const repeat = d['repeat'];
    const r = repeat !== null && typeof repeat === 'object' && !Array.isArray(repeat)
        ? repeat : null;
    return {
        phase: (['starting', 'exploring', 'editing', 'testing', 'running'].includes(d['phase'])
            ? d['phase'] : 'running'),
        filesRead: n('filesRead'),
        searches: n('searches'),
        commands: n('commands'),
        testRuns: n('testRuns'),
        edited: d['edited'].filter((e) => typeof e === 'string'),
        editedCount: n('editedCount'),
        lastTestFailed: d['lastTestFailed'] === true,
        repeat: r !== null && typeof r['label'] === 'string' && typeof r['count'] === 'number'
            ? { label: r['label'], count: r['count'] } : null,
    };
}
function isForgeActivity(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const activity = value;
    return typeof activity['stepIndex'] === 'number' && typeof activity['tool'] === 'string'
        && ['active', 'done', 'denied', 'error'].includes(String(activity['status']));
}
function isActiveForgeActivity(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const activity = value;
    return typeof activity['stepIndex'] === 'number' && typeof activity['tool'] === 'string' && activity['status'] === 'active';
}/**
 * watched-files.ts — brief/spec files a worker is told to read, copied into its
 * cwd and tracked by signature so a later edit on either side is noticed.
 */
const MAX_WATCHED_FILES = 32;
const MAX_WATCHED_BYTES = 4 * 1024 * 1024;
function validateWatchedFiles(repo, files) {
    const repoRoot = path.resolve(repo);
    let realRepoRoot = repoRoot;
    try {
        realRepoRoot = realpathSync(repoRoot);
    }
    catch { /* non-existent repo root caught by per-file stat below */ }
    const seen = new Set();
    const out = [];
    let totalBytes = 0;
    for (const raw of files) {
        const trimmed = raw.trim();
        if (trimmed === '') {
            throw new Error('files entry must be a non-empty relative path inside the repository.');
        }
        if (path.isAbsolute(trimmed)) {
            throw new Error(`watched file "${trimmed}" must be a relative path inside the repository.`);
        }
        const abs = path.resolve(repoRoot, trimmed);
        const rel = path.relative(repoRoot, abs);
        if (rel === '' || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new Error(`watched file "${trimmed}" escapes repository root ${repoRoot}.`);
        }
        const normalized = rel.split(path.sep).join('/');
        let st;
        try {
            st = statSync(abs);
        }
        catch {
            throw new Error(`watched file "${normalized}" does not exist in ${repoRoot}.`);
        }
        if (!st.isFile()) {
            throw new Error(`watched file "${normalized}" is not a regular file.`);
        }
        let realAbs;
        try {
            realAbs = realpathSync(abs);
        }
        catch {
            throw new Error(`watched file "${normalized}" does not exist in ${repoRoot}.`);
        }
        const realRel = path.relative(realRepoRoot, realAbs);
        if (realRel === '' || realRel === '.' || realRel.startsWith('..') || path.isAbsolute(realRel)) {
            throw new Error(`watched file "${normalized}" resolves outside repository root ${repoRoot}.`);
        }
        if (!seen.has(normalized)) {
            if (out.length >= MAX_WATCHED_FILES) {
                throw new Error(`files exceeds maximum of ${MAX_WATCHED_FILES} watched files (${files.length} requested).`);
            }
            totalBytes += st.size;
            if (totalBytes > MAX_WATCHED_BYTES) {
                throw new Error(`watched files exceed maximum total size of ${MAX_WATCHED_BYTES} bytes.`);
            }
            seen.add(normalized);
            out.push(normalized);
        }
    }
    return out;
}
function syncWatchedFiles(repo, cwd, files, previousWatched, onWarning) {
    const normalized = validateWatchedFiles(repo, files);
    const repoRoot = path.resolve(repo);
    const cwdRoot = path.resolve(cwd);
    const sameRoot = repoRoot === cwdRoot;
    const out = {};
    for (const rel of normalized) {
        const repoSig = fileSig(repoRoot, rel);
        if (!sameRoot) {
            const src = path.join(repoRoot, rel);
            const dst = path.join(cwdRoot, rel);
            // Resolve every existing component, including a symlink at the file itself.
            // Missing suffixes are safe only after their nearest existing parent passed.
            const realRoot = realpathSync(cwdRoot);
            let component = cwdRoot;
            for (const part of rel.split('/')) {
                component = path.join(component, part);
                try {
                    lstatSync(component);
                }
                catch (err) {
                    if (err.code === 'ENOENT')
                        break;
                    throw err;
                }
                const resolved = realpathSync(component);
                const relative = path.relative(realRoot, resolved);
                if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                    throw new Error(`watched file "${rel}" destination resolves outside worker cwd ${cwdRoot}.`);
                }
            }
            const prev = previousWatched?.[rel];
            const currentCwdSig = fileSig(cwdRoot, rel);
            if (prev === undefined || currentCwdSig === 'gone') {
                mkdirSync(path.dirname(dst), { recursive: true });
                copyFileSync(src, dst);
            }
            else if (prev.repoSig !== repoSig) {
                if (currentCwdSig !== prev.cwdSig) {
                    onWarning?.(`watched file "${rel}" changed in both repo and worktree; kept worktree copy`);
                }
                else {
                    mkdirSync(path.dirname(dst), { recursive: true });
                    copyFileSync(src, dst);
                }
            }
        }
        const cwdSig = sameRoot ? repoSig : fileSig(cwdRoot, rel);
        const prev = previousWatched?.[rel];
        // Keep the last shared baseline until worker edits are reconciled. Retaining
        // a divergent copy must never make it replaceable on the following sync.
        out[rel] = prev !== undefined && cwdSig !== repoSig && cwdSig !== prev.cwdSig
            ? prev : { repoSig, cwdSig };
    }
    return out;
}function newLiveJob(writer, timeoutMs) {
    return {
        writer,
        handle: null,
        timeoutMs,
        consumedSteers: 0,
        liveSent: 0,
        interruptRequested: false,
        interruptFired: false,
        userCanceled: false,
    };
}
const STEER_CONVERSATION_WAIT_MS = 2_000;
const OWNER_CHECKS_POLL_MS = 200;
function checksFollow(spec) {
    return spec.ownerChecks && (spec.checks?.length ?? 0) > 0;
}
function mergeOverrides(entries) {
    let out = {};
    for (const e of entries)
        if (e.overrides !== undefined)
            out = { ...out, ...e.overrides };
    return out;
}
function applyOverrides(spec, o, provider) {
    if (Object.keys(o).length === 0)
        return spec;
    const unrestricted = o.unrestricted === undefined ? spec.unrestricted : provider.name === 'kimi' ? true : o.unrestricted;
    return {
        ...spec,
        ...(o.model === undefined ? {} : { model: o.model, modelRequested: o.model, modelResolved: o.model, modelSource: 'requested' }),
        ...(o.effort === undefined || provider.supportsEffort === false ? {} : { effort: o.effort }),
        ...(o.timeoutMs === undefined ? {} : { timeoutMs: resolveTimeoutMs(o.timeoutMs) }),
        ...(o.checks === undefined ? {} : { checks: o.checks }),
        unrestricted,
        readOnlyRequested: spec.preset?.readOnly === true && !unrestricted,
    };
}
class WorkerLookupError extends Error {
    kind;
    jobIds;
    constructor(message, kind, jobIds = []) {
        super(message);
        this.name = 'WorkerLookupError';
        this.kind = kind;
        this.jobIds = jobIds;
    }
}
const CATALOG_WAIT_MS = 2_000;
const CATALOG_COLD_WAIT_MS = 5_000;
class ForgeService {
    repo;
    supervisorUrl;
    live = new Map();
    spawnedIds = new Set();
    spawnedRuns = new Set();
    flushMs;
    catalogSource;
    catalogWaitMs;
    catalogSeen = false;
    catalogWarm;
    harnessDefaults;
    providerSource;
    describeSandbox;
    workers;
    hooks;
    envVault = new Map();
    constructor(options) {
        this.repo = options.repo;
        this.hooks = options.hooks ?? {};
        this.workers = new WorkerIndexStore(options.repo, { readManifest: (id) => this.readManifestRaw(id) });
        this.supervisorUrl = options.supervisorUrl;
        this.flushMs = options.flushMs;
        this.providerSource = options.providerSource ?? requireProvider;
        this.catalogSource = options.catalogSource ?? ((providers) => getCatalogs({ providers, repo: this.repo }));
        this.catalogWaitMs = { warm: options.catalogWaitMs?.warm ?? CATALOG_WAIT_MS, cold: options.catalogWaitMs?.cold ?? CATALOG_COLD_WAIT_MS };
        this.harnessDefaults = options.harnessDefaults ?? getHarnessDefaults;
        this.describeSandbox = options.describeSandbox ?? ((p, spec) => p.describeSandbox?.(spec));
        try {
            for (const entry of readdirSync(jobsDir(this.repo), { withFileTypes: true })) {
                if (entry.isDirectory())
                    reconcileOrphan(this.repo, entry.name);
            }
        }
        catch { }
    }
    newWriter(jobId) {
        return new JobWriter({
            repo: this.repo,
            jobId,
            ...(this.flushMs === undefined ? {} : { flushMs: this.flushMs }),
        });
    }
    assertNameFree(name, workerId) {
        const busy = (jobId) => new Error(`"${name}" is busy (${jobId}); wait, cancel, or use another name.`);
        const canonicalConflict = this.findActiveIdentity(name, workerId);
        if (canonicalConflict !== null)
            throw busy(canonicalConflict.jobId);
        for (const { writer } of this.live.values()) {
            const active = writer.snapshot();
            if (active !== null && (active.workerId === workerId || active.name === name))
                throw busy(active.jobId);
        }
    }
    nextTurnAfter(parentId, parent, workerId) {
        if (parent !== null && typeof parent.turn === 'number' && Number.isInteger(parent.turn) && parent.turn >= 1)
            return parent.turn + 1;
        this.workers.refresh();
        const turns = this.workers.get(workerId)?.turns ?? [];
        return turns.includes(parentId) ? turns.length + 1 : 2;
    }
    recordTurnStart(input) {
        const parentId = input.continuedFrom;
        this.workers.recordTurnStart({
            workerId: input.workerId,
            name: input.name,
            jobId: input.jobId,
            continuation: parentId !== undefined,
            lockHeld: input.lockHeld,
            alsoLocked: () => {
                if (parentId === undefined || this.live.has(parentId))
                    return;
                if (!this.isSafeJobId(parentId))
                    return;
                let parent;
                try {
                    parent = readManifest(this.repo, parentId);
                }
                catch {
                    return;
                }
                if (!isTerminalStatus(parent.status) || parent.followedBy || parent.supersededBy)
                    return;
                const link = input.replacesParent ? { supersededBy: input.jobId } : { followedBy: input.jobId };
                writeJsonAtomic(jobFile(this.repo, parentId, FILES.job), { ...parent, ...link, ...(parent.pendingSteers ? { pendingSteers: 0 } : {}) });
                if (parent.pendingSteers)
                    this.setSettledPending(parentId, 0);
            },
        });
    }
    warmCatalogs() {
        if (this.catalogWarm !== undefined)
            return;
        this.catalogWarm = Promise.resolve()
            .then(() => this.catalogSource())
            .then((all) => { this.catalogSeen = true; return all; })
            .catch(() => [])
            .finally(() => { this.catalogWarm = undefined; });
    }
    async catalogFor(provider) {
        let timer;
        try {
            const waitMs = this.catalogSeen ? this.catalogWaitMs.warm : this.catalogWaitMs.cold;
            const timeout = new Promise((resolve) => {
                timer = setTimeout(() => resolve(undefined), waitMs);
                timer.unref?.();
            });
            const warm = this.catalogWarm;
            const all = await Promise.race([warm ?? this.catalogSource([provider]), timeout]);
            if (all !== undefined)
                this.catalogSeen = true;
            return all?.find((c) => c.provider === provider) ?? (warm === undefined ? all?.[0] : undefined);
        }
        catch {
            return undefined;
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    async spawnJob(request) {
        const { ack } = await this.spawnTracked(request);
        return ack;
    }
    async spawnTracked(request) {
        const tracked = this.supervisorUrl ? await launchJob(this, request) : await this.startOwned(request);
        if (request.env !== undefined && Object.keys(request.env).length > 0) {
            this.envVault.set(tracked.ack.workerId, { ...(this.envVault.get(tracked.ack.workerId) ?? {}), ...request.env });
        }
        return tracked;
    }
    async startOwned(request) {
        const prepared = await this.prepareTurn(request);
        const done = this.own(this.pump(prepared.writer, prepared.provider, prepared.spec, prepared.turn));
        return { ack: prepared.ack, done };
    }
    async prepareTurn(request) {
        const provider = this.providerSource(request.provider ?? (() => { throw new Error('provider is required.'); })());
        const rawMode = request.mode.trim();
        const resuming = request.conversation !== undefined && request.conversation !== null;
        if (request.pipeline == null && !resuming && !isMode(rawMode))
            throw modeError(rawMode);
        const mode = rawMode === '' ? 'task' : rawMode;
        const preset = isMode(mode) ? MODE_PRESETS[mode] : undefined;
        const prompt = request.prompt;
        if (prompt.trim() === '') {
            throw new Error('prompt is empty; there is nothing to hand the worker.');
        }
        const timeoutMs = resolveTimeoutMs(request.timeoutMs);
        const env = validateEnv(request.env);
        const envKeys = env === undefined ? [] : Object.keys(env);
        const cwd = request.cwd ?? this.repo;
        const unrestrictedRequested = request.unrestricted;
        const unrestricted = provider.name === 'kimi'
            ? true
            : unrestrictedRequested ?? (provider.name === 'agy' && process.env['AGENT_SMITH_AGY_RESTRICTED'] !== '1');
        const warnings = [];
        if (unrestrictedRequested === false && provider.name === 'kimi') {
            warnings.push('kimi print mode force-sets the auto permission policy; unrestricted:false cannot restrict it. The ack and job.json record the effective posture.');
        }
        const effort = provider.supportsEffort === false ? undefined : request.effort;
        if (request.effort !== undefined && provider.supportsEffort === false) {
            warnings.push(`kimi has no per-run effort flag; effort "${request.effort}" was ignored. Set [thinking].effort or a model alias default_effort in config.toml.`);
        }
        if ((request.model !== undefined || effort !== undefined) && request.lockHeldByCaller !== true) {
            warnings.push(...checkAgainstCatalog(provider.name, request.model, effort, await this.catalogFor(provider.name)));
        }
        let modelResolved = request.model ?? null;
        let modelSource = request.model === undefined ? 'unknown' : 'requested';
        if (request.model === undefined) {
            const configured = this.harnessDefaults(provider.name).model;
            if (configured) {
                modelResolved = configured;
                modelSource = 'harness-config';
            }
        }
        const readOnlyRequested = preset?.readOnly === true && !unrestricted;
        const artifactPath = readOnlyRequested ? request.artifactPath : undefined;
        const sandboxInfo = this.describeSandbox(provider, {
            unrestricted,
            readOnly: readOnlyRequested,
            ...(artifactPath === undefined ? {} : { artifactPath }),
        });
        const sandbox = sandboxInfo?.sandbox ?? 'unknown';
        const sandboxFlags = sandboxInfo?.flags ?? [];
        const readOnlyEnforced = sandboxInfo?.readOnlyEnforced ?? false;
        if (provider.name === 'agy' && preset?.runsCommands === true && !unrestricted) {
            warnings.push('agy cannot prompt for permission headless; commands will be denied and the job will return an empty result. Retry with unrestricted:true if this job needs shell access.');
        }
        const brief = buildBrief({
            mode,
            preset,
            cwd,
            context: request.context,
            checks: request.checks,
            pipelineStage: request.pipeline !== undefined && request.pipeline !== null,
            resuming,
        });
        const prependBrief = brief !== '' && !prompt.startsWith(brief);
        const preambleApplied = brief !== '';
        const sentPrompt = prependBrief ? `${brief}\n\n${prompt}` : prompt;
        const jobId = newJobId(mode);
        const name = request.name?.trim() || `${mode}-${jobId.slice(-8)}`;
        if (name.length > 80)
            throw new Error('worker name must be at most 80 characters');
        const workerId = request.workerId ?? jobId;
        this.assertNameFree(name, workerId);
        const writer = this.newWriter(jobId);
        warnings.push(...request.notes ?? []);
        const watchedFiles = request.watchedFiles ?? (request.files !== undefined && request.files.length > 0
            ? syncWatchedFiles(this.repo, cwd, request.files, undefined, (w) => warnings.push(w))
            : undefined);
        const spec = {
            jobId,
            name,
            workerId,
            task: request.task,
            mode,
            preset,
            context: request.context,
            checks: request.checks,
            prompt: sentPrompt,
            readOnlyRequested,
            readOnlyEnforced,
            sandbox,
            sandboxFlags: [...sandboxFlags],
            artifactPath,
            cwd,
            model: request.model,
            modelRequested: request.model ?? null,
            modelResolved,
            modelSource,
            effort,
            timeoutMs,
            unrestricted,
            conversation: request.conversation,
            env,
            pipeline: request.pipeline ?? null,
            stage: request.stage ?? null,
            attempt: request.attempt ?? null,
            onPrepared: request.onPrepared,
            ownerChecks: request.ownerChecks === true,
        };
        const parentManifest = request.continuedFrom ? this.readManifestSync(request.continuedFrom) : null;
        const continuationKind = request.continuedFrom
            ? normalizeContinuationKind(request.continuationKind) ?? 'follow-up'
            : undefined;
        const turn = typeof request.turn === 'number' && Number.isInteger(request.turn) && request.turn >= 1
            ? request.turn
            : request.continuedFrom
                ? this.nextTurnAfter(request.continuedFrom, parentManifest, workerId)
                : 1;
        const startedManifest = writer.start(turnStartInput(provider.name, spec, {
            prompt,
            preamble: prependBrief ? brief : undefined,
            preambleApplied,
            conversation: request.conversation ?? null,
            task: request.task,
            watchedFiles,
            turn,
            continuedFrom: request.continuedFrom,
            continuationKind,
            chainStartedAt: continuationKind === 'follow-up' ? undefined : request.chainStartedAt,
        }));
        try {
            this.recordTurnStart({
                workerId, name, jobId,
                continuedFrom: request.continuedFrom,
                continuationKind,
                replacesParent: request.replacesParent === true,
                lockHeld: request.lockHeldByCaller === true,
            });
            if (request.checks !== undefined)
                writeJsonAtomic(jobFile(this.repo, jobId, FILES.checksSpec), request.checks);
            const trackedKeys = [...new Set([...(request.continuedFrom ? this.envKeysOf(request.continuedFrom) : []), ...envKeys])];
            if (trackedKeys.length > 0)
                writeJsonAtomic(jobFile(this.repo, jobId, ENV_KEYS_FILE), trackedKeys);
            for (const m of request.messages ?? [])
                writer.recordMessage(m.text, 'turn-start', m.sender);
            for (const note of request.notes ?? [])
                writer.warn(note);
            if (spec.ownerChecks && request.checks?.length)
                markAcceptancePending(this.repo, jobId, request.checks);
            await request.onPrepared?.(jobId);
        }
        catch (error) {
            writer.abort('failed', `setup failed · ${String(error)}`);
            try {
                createMarker(jobFile(this.repo, jobId, FILES.ownerDone), new Date().toISOString());
            }
            catch { }
            throw error;
        }
        this.spawnedIds.add(jobId);
        const ack = {
            jobId,
            name,
            workerId,
            turn: startedManifest.turn ?? turn,
            ...(startedManifest.continuedFrom ? { continuedFrom: startedManifest.continuedFrom } : {}),
            ...(startedManifest.continuationKind ? { continuationKind: startedManifest.continuationKind } : {}),
            chainStartedAt: startedManifest.chainStartedAt ?? startedManifest.startedAt ?? startedManifest.createdAt,
            role: mode,
            provider: provider.name,
            status: 'running',
            dir: jobDir(this.repo, jobId),
            repo: this.repo,
            timeoutMs,
            ...(envKeys.length > 0 ? { envKeys } : {}),
            unrestricted,
            note: `queued · ${humanDuration(timeoutMs)} limit · ${provider.name === 'kimi' ? 'auto policy (cannot restrict)' : unrestricted ? 'unrestricted' : 'approvals on'}`,
            sandbox,
            sandboxFlags,
            readOnlyRequested,
            readOnlyEnforced,
            modelRequested: request.model ?? null,
            modelResolved,
            modelSource,
            preambleApplied,
            ...(warnings.length === 0 ? {} : { warnings }),
        };
        return { ack, writer, provider, spec, turn: { rawPrompt: prompt, prependBrief, resuming, context: request.context } };
    }
    async pump(initialWriter, provider, initialSpec, initialTurn, initialLive) {
        let spec = initialSpec;
        let currentWriter = initialWriter;
        let currentJobId = spec.jobId;
        let currentPrompt = spec.prompt;
        let currentConversation = spec.conversation;
        let currentTurn = initialTurn;
        let liveEntry = initialLive ?? newLiveJob(currentWriter, spec.timeoutMs);
        this.live.set(currentJobId, liveEntry);
        const ended = (manifest) => ({
            manifest: manifest ?? currentWriter.snapshot() ?? { jobId: currentJobId },
            spec, provider, consumed: liveEntry.consumedSteers,
        });
        const abortTurn = (status, reason) => this.ownerLocked(spec.workerId, async () => {
            const jobId = currentJobId;
            this.live.delete(jobId);
            const end = ended(currentWriter.abort(status, reason));
            writeConsumedCount(this.repo, jobId, liveEntry.consumedSteers);
            if (status === 'canceled')
                this.discardAtCancel(jobId, readSteerEntries(this.repo, jobId), liveEntry, (w) => this.warnSettled(jobId, w));
            const waiting = undeliveredEntries(this.repo, jobId).length;
            if (waiting > 0) {
                this.setSettledPending(jobId, waiting);
                return end;
            }
            if (checksFollow(spec))
                return end;
            this.markOwnerDone(jobId);
            return { ...end, ownerDone: true };
        });
        while (true) {
            if (currentTurn.prependBrief && !currentTurn.resuming && spec.pipeline === null && currentWriter.hasPendingBaseline()) {
                const dirty = await currentWriter.awaitBaseline();
                if (liveEntry.userCanceled || currentWriter.cancelled || existsSync(jobFile(this.repo, currentJobId, FILES.cancel))) {
                    currentWriter.requestCancel();
                    return abortTurn('canceled', 'canceled by user');
                }
                if (dirty.length > 0) {
                    const fullBrief = buildBrief({
                        mode: spec.mode,
                        preset: spec.preset,
                        cwd: spec.cwd,
                        context: currentTurn.context,
                        checks: spec.checks,
                        pipelineStage: false,
                        resuming: false,
                        dirtyFiles: dirty,
                    });
                    currentPrompt = `${fullBrief}\n\n${currentTurn.rawPrompt}`;
                    currentWriter.updatePreamble(fullBrief);
                }
            }
            let handle;
            try {
                handle = await provider.spawn({
                    mode: currentJobId,
                    prompt: currentPrompt,
                    cwd: spec.cwd,
                    timeoutMs: spec.timeoutMs,
                    unrestricted: spec.unrestricted,
                    ...(spec.readOnlyRequested ? { readOnly: true } : {}),
                    ...(spec.artifactPath === undefined ? {} : { artifactPath: spec.artifactPath }),
                    ...(spec.model === undefined ? {} : { model: spec.model }),
                    ...(spec.effort === undefined ? {} : { effort: spec.effort }),
                    ...(currentConversation === undefined ? {} : { conversation: currentConversation }),
                    ...(spec.env === undefined ? {} : { env: { ...spec.env } }),
                    stateDir: jobDir(this.repo, currentJobId),
                    jobId: currentJobId,
                });
            }
            catch (err) {
                return abortTurn('failed', `couldn't start · ${describe(err)}`);
            }
            liveEntry.handle = handle;
            const unsubscribe = pipeEvents(currentWriter, handle);
            let interruptDetectedAt = null;
            let lastPendingSteers = 0;
            let pollWarned = false;
            const live = liveEntry;
            const writer = currentWriter;
            const jobId = currentJobId;
            const liveInput = provider.liveInput === true && typeof handle.send === 'function';
            const publishConsumed = (entries) => {
                writeConsumedCount(this.repo, jobId, live.consumedSteers);
                const pending = Math.max(0, entries.length - live.consumedSteers);
                lastPendingSteers = pending;
                writer.setPendingSteers(pending);
            };
            const syncSteerAndCancel = () => {
                if (existsSync(jobFile(this.repo, jobId, FILES.cancel))) {
                    live.userCanceled = true;
                }
                if (live.userCanceled) {
                    writer.requestCancel();
                    handle.cancel();
                    return;
                }
                const entries = readSteerEntries(this.repo, jobId);
                const unconsumed = entries.slice(live.consumedSteers);
                if (unconsumed.length !== lastPendingSteers) {
                    lastPendingSteers = unconsumed.length;
                    writer.setPendingSteers(unconsumed.length);
                }
                if (unconsumed.some((e) => e.delivery === 'interrupt') || existsSync(jobFile(this.repo, jobId, FILES.cancelSteer))) {
                    live.interruptRequested = true;
                }
                if (liveInput && !live.interruptRequested) {
                    for (let i = live.consumedSteers + live.liveSent; i < entries.length; i++) {
                        const e = entries[i];
                        if (!liveDeliverable(e) || handle.send(liveMessageText(e)) !== true)
                            break;
                        live.liveSent += 1;
                    }
                }
                if (live.interruptRequested && !live.interruptFired) {
                    if (interruptDetectedAt === null)
                        interruptDetectedAt = Date.now();
                    const hasConversation = writer.currentConversation() !== null;
                    const allowFresh = unconsumed.some((e) => e.allowFresh === true);
                    const waitElapsed = Date.now() - interruptDetectedAt >= STEER_CONVERSATION_WAIT_MS;
                    if (hasConversation || allowFresh || waitElapsed) {
                        live.interruptFired = true;
                        handle.cancel();
                    }
                }
            };
            const safeSyncSteerAndCancel = () => {
                try {
                    syncSteerAndCancel();
                }
                catch (err) {
                    if (!pollWarned) {
                        pollWarned = true;
                        process.stderr.write(`agent-smith steer poll ${jobId}: ${describe(err)}\n`);
                    }
                }
            };
            const replayed = [];
            const markLiveRead = (texts, at) => {
                replayed.push(...texts);
                const entries = readSteerEntries(this.repo, jobId);
                while (live.liveSent > 0) {
                    const e = entries[live.consumedSteers];
                    const i = e === undefined ? -1 : replayed.indexOf(liveMessageText(e));
                    if (i < 0)
                        break;
                    replayed.splice(i, 1);
                    writer.recordMessage(liveMessageText(e), 'next-step', senderOf(e), at);
                    live.consumedSteers += 1;
                    live.liveSent -= 1;
                }
                publishConsumed(entries);
            };
            const readAtResult = (unread) => {
                const left = [...unread];
                return readSteerEntries(this.repo, jobId).slice(live.consumedSteers, live.consumedSteers + live.liveSent)
                    .map(liveMessageText)
                    .filter((text) => {
                    const i = left.indexOf(text);
                    if (i < 0)
                        return true;
                    left.splice(i, 1);
                    return false;
                });
            };
            const unsubSteerTap = handle.onEvent((ev) => {
                if (ev.kind === 'started' && live.interruptRequested && !live.interruptFired) {
                    safeSyncSteerAndCancel();
                }
                if (ev.kind === 'user-message' && live.liveSent > 0) {
                    try {
                        markLiveRead([ev.text], ev.at);
                    }
                    catch (err) {
                        process.stderr.write(`agent-smith live input ${jobId}: ${describe(err)}\n`);
                    }
                }
            });
            safeSyncSteerAndCancel();
            const cancelPoll = setInterval(safeSyncSteerAndCancel, 100);
            cancelPoll.unref?.();
            try {
                const result = await handle.waitForResult();
                clearInterval(cancelPoll);
                unsubSteerTap();
                unsubscribe();
                if (live.liveSent > 0)
                    markLiveRead(readAtResult(result.unreadInput ?? []), result.finishedAt);
                live.liveSent = 0;
                await writer.prepareFinish();
                const report = reportFor(result);
                const decision = await this.ownerLocked(spec.workerId, async () => {
                    safeSyncSteerAndCancel();
                    const entries = readSteerEntries(this.repo, jobId);
                    if (live.userCanceled)
                        this.discardAtCancel(jobId, entries, live, (w) => writer.warn(w));
                    const unconsumed = entries.slice(live.consumedSteers);
                    await this.hooks.afterFinalRead?.(jobId);
                    const alreadyTerminal = result.status === 'cancelled' ? 'canceled' : null;
                    const verdict = deriveStatus({
                        alreadyTerminal,
                        ok: result.ok,
                        jobStatus: result.status,
                        deniedActions: result.deniedActions ?? [],
                        report: report === '' ? null : report,
                        ...writer.verdictFacts(),
                    });
                    if (unconsumed.length > 0) {
                        const next = await this.chainContinuation({
                            provider, spec, parent: { writer, jobId, live },
                            result, report, entries, unconsumed, verdictStatus: verdict.status, lockHeld: true,
                        });
                        return { next };
                    }
                    const manifest = writer.finish(result, report === '' ? null : report);
                    writeConsumedCount(this.repo, jobId, live.consumedSteers);
                    this.live.delete(jobId);
                    const done = !checksFollow(spec);
                    if (done)
                        this.markOwnerDone(jobId);
                    return { manifest, ownerDone: done };
                });
                if (decision.next === undefined) {
                    const end = ended(decision.manifest ?? null);
                    return decision.ownerDone === true ? { ...end, ownerDone: true } : end;
                }
                const next = decision.next;
                spec = next.spec;
                currentWriter = next.writer;
                currentJobId = next.jobId;
                currentPrompt = next.prompt;
                currentConversation = next.conversation;
                currentTurn = next.turn;
                liveEntry = next.live;
                continue;
            }
            catch (err) {
                clearInterval(cancelPoll);
                unsubSteerTap();
                unsubscribe();
                return abortTurn('failed', `crashed · ${describe(err)}`);
            }
        }
    }
    ownerLocked(workerId, fn) {
        return withWorkerLock(this.repo, workerId, fn, {
            waitMs: Number.POSITIVE_INFINITY,
            onWait: (waitedMs, holder) => process.stderr.write(`agent-smith owner ${workerId}: waiting ${Math.round(waitedMs / 1000)} s for the worker lock held by pid ${holder}\n`),
        });
    }
    discardAtCancel(jobId, entries, live, warn) {
        const cut = existsSync(jobFile(this.repo, jobId, FILES.steerDiscard)) ? readDiscardCut(this.repo, jobId) : entries.length;
        const end = Math.min(cut, entries.length);
        if (end <= live.consumedSteers)
            return;
        warn(discardedWarning(entries.slice(live.consumedSteers, end)));
        live.consumedSteers = end;
        writeConsumedCount(this.repo, jobId, end);
    }
    markOwnerDone(jobId) {
        createMarker(jobFile(this.repo, jobId, FILES.ownerDone), new Date().toISOString());
    }
    async own(first) {
        let end = await first;
        try {
            while (true) {
                if (end.ownerDone === true)
                    return end.manifest;
                const head = end.manifest;
                const checks = end.spec.ownerChecks ? end.spec.checks : undefined;
                const acceptance = checks?.length ? await this.ownerRunChecks(head, checks) : undefined;
                await this.hooks.beforeOwnerDecision?.(head.jobId);
                const next = await this.ownerLocked(end.spec.workerId, async () => {
                    if (acceptance !== undefined)
                        writeAcceptance(this.repo, head.jobId, acceptance);
                    const entries = readSteerEntries(this.repo, head.jobId);
                    const live = { consumedSteers: Math.max(end.consumed, readConsumedCount(this.repo, head.jobId)) };
                    if (existsSync(jobFile(this.repo, head.jobId, FILES.cancel))) {
                        this.discardAtCancel(head.jobId, entries, live, (w) => this.warnSettled(head.jobId, w));
                    }
                    const unconsumed = entries.slice(live.consumedSteers);
                    if (unconsumed.length === 0) {
                        this.markOwnerDone(head.jobId);
                        return null;
                    }
                    let prepared;
                    try {
                        const request = this.continuationRequest({
                            head, spec: end.spec, provider: end.provider.name, entries: unconsumed,
                            verdict: acceptance === undefined ? undefined : verdictBlock(acceptance),
                            env: end.spec.env,
                            replacesHead: checksAbortRequested(this.repo, head.jobId),
                        });
                        prepared = await this.prepareTurn(request);
                    }
                    catch (err) {
                        this.warnSettled(head.jobId, notSentWarning(unconsumed, describe(err)));
                        this.setSettledPending(head.jobId, 0);
                        this.markOwnerDone(head.jobId);
                        return null;
                    }
                    writeConsumedCount(this.repo, head.jobId, entries.length);
                    const nextLive = newLiveJob(prepared.writer, prepared.spec.timeoutMs);
                    this.live.set(prepared.spec.jobId, nextLive);
                    return { prepared, live: nextLive };
                });
                if (next === null)
                    return end.manifest;
                end = await this.pump(next.prepared.writer, next.prepared.provider, next.prepared.spec, next.prepared.turn, next.live);
            }
        }
        catch (err) {
            process.stderr.write(`agent-smith owner ${end.manifest.jobId}: ${describe(err)}\n`);
            try {
                createMarker(jobFile(this.repo, end.manifest.jobId, FILES.ownerDone), new Date().toISOString());
            }
            catch { }
            return end.manifest;
        }
    }
    async ownerRunChecks(head, checks) {
        const controller = new AbortController();
        let abortedBy = null;
        const poll = () => {
            if (abortedBy !== null)
                return;
            if (existsSync(jobFile(this.repo, head.jobId, FILES.cancel)))
                abortedBy = 'cancel';
            else if (checksAbortRequested(this.repo, head.jobId))
                abortedBy = 'steer';
            if (abortedBy !== null)
                controller.abort();
        };
        poll();
        const timer = setInterval(poll, OWNER_CHECKS_POLL_MS);
        timer.unref?.();
        let acceptance;
        try {
            acceptance = await runAcceptance({
                repo: this.repo, jobId: head.jobId, succeeded: head.status === 'succeeded', checks,
                baseDir: head.cwd ?? this.repo, signal: controller.signal,
            });
        }
        finally {
            clearInterval(timer);
        }
        if (abortedBy === 'steer') {
            acceptance = { state: 'unchecked', checks: [], at: new Date().toISOString(), reason: 'aborted by steer' };
        }
        return acceptance;
    }
    warnSettled(jobId, message) {
        const file = jobFile(this.repo, jobId, FILES.progress);
        try {
            const progress = JSON.parse(readFileSync(file, 'utf8'));
            const warnings = Array.isArray(progress.warnings) ? progress.warnings : [];
            if (!warnings.includes(message))
                writeJsonAtomic(file, { ...progress, warnings: [...warnings, message] });
        }
        catch { }
    }
    setSettledPending(jobId, pending) {
        for (const name of [FILES.job, FILES.progress]) {
            const file = jobFile(this.repo, jobId, name);
            try {
                const doc = JSON.parse(readFileSync(file, 'utf8'));
                writeJsonAtomic(file, { ...doc, pendingSteers: pending });
            }
            catch { }
        }
    }
    continuationRequest(input) {
        const { head, spec, entries } = input;
        const o = mergeOverrides(entries);
        const conversation = typeof head.conversation === 'string' && head.conversation !== '' ? head.conversation : undefined;
        const steered = entries.some((e) => senderOf(e) === 'steer');
        let responseTail = '';
        if (conversation === undefined) {
            try {
                responseTail = readFileSync(jobFile(this.repo, head.jobId, FILES.report), 'utf8').trim().slice(-600);
            }
            catch { }
        }
        const cwd = spec?.cwd ?? head.cwd ?? this.repo;
        const { watchedFiles, syncedFiles, notes } = this.syncContinuationFiles(cwd, head.watchedFiles, entries.flatMap((e) => e.files ?? []));
        const { rawPrompt } = buildSteeredPrompt({
            wasInterrupted: false,
            priorStatus: head.status,
            verdict: input.verdict,
            freshContinuation: conversation === undefined,
            responseTail,
            entries,
            syncedFiles,
            brief: '',
        });
        const context = [...entries].reverse().find((e) => e.context !== undefined)?.context ?? spec?.context;
        const checks = o.checks ?? spec?.checks ?? input.headChecks;
        const env = input.env !== undefined && Object.keys(input.env).length > 0 ? input.env : undefined;
        return {
            mode: spec?.mode ?? head.mode ?? 'task',
            prompt: rawPrompt,
            provider: input.provider,
            name: head.name,
            workerId: head.workerId ?? head.jobId,
            task: head.task ?? undefined,
            cwd,
            model: o.model ?? spec?.model ?? head.model ?? undefined,
            effort: o.effort ?? spec?.effort ?? head.effort ?? undefined,
            timeoutMs: o.timeoutMs ?? spec?.timeoutMs ?? head.timeoutMs,
            unrestricted: o.unrestricted ?? spec?.unrestricted ?? head.unrestricted,
            ...(context === undefined ? {} : { context }),
            ...(checks === undefined ? {} : { checks }),
            ...(watchedFiles === undefined ? {} : { watchedFiles }),
            ...(notes.length === 0 ? {} : { notes }),
            ...(conversation === undefined ? {} : { conversation }),
            ...(env === undefined ? {} : { env }),
            continuedFrom: head.jobId,
            continuationKind: steered ? 'steer' : 'follow-up',
            ...(steered && input.replacesHead
                ? { replacesParent: true, chainStartedAt: head.chainStartedAt ?? head.startedAt ?? head.createdAt }
                : {}),
            lockHeldByCaller: true,
            ownerChecks: spec === undefined ? true : spec.ownerChecks,
            messages: entries.map((e) => ({ text: e.prompt, sender: senderOf(e) })),
        };
    }
    withSandbox(spec, before, provider) {
        if (spec.unrestricted === before.unrestricted)
            return spec;
        const info = this.describeSandbox(provider, {
            unrestricted: spec.unrestricted,
            readOnly: spec.readOnlyRequested,
            ...(spec.artifactPath === undefined ? {} : { artifactPath: spec.artifactPath }),
        });
        return {
            ...spec,
            sandbox: info?.sandbox ?? 'unknown',
            sandboxFlags: [...(info?.flags ?? [])],
            readOnlyEnforced: info?.readOnlyEnforced ?? false,
        };
    }
    syncContinuationFiles(cwd, previous, added) {
        const notes = [];
        const paths = [...new Set([...Object.keys(previous ?? {}), ...added])].filter((f) => {
            if (existsSync(path.resolve(this.repo, f)))
                return true;
            notes.push(`dropped deleted watched file "${f}" from continuation turn`);
            return false;
        });
        if (paths.length === 0)
            return { watchedFiles: undefined, syncedFiles: [], notes };
        let watchedFiles;
        try {
            watchedFiles = syncWatchedFiles(this.repo, cwd, paths, previous, (w) => notes.push(w));
        }
        catch (err) {
            notes.push(`watched file sync warning: ${describe(err)}`);
            return { watchedFiles: undefined, syncedFiles: [], notes };
        }
        const syncedFiles = Object.entries(watchedFiles)
            .filter(([rel, sigs]) => {
            const prev = previous?.[rel];
            return prev === undefined || (prev.repoSig !== sigs.repoSig && sigs.cwdSig === sigs.repoSig);
        })
            .map(([rel]) => rel);
        return { watchedFiles, syncedFiles, notes };
    }
    async chainContinuation(input) {
        const { provider, parent, result, report, entries, unconsumed, verdictStatus } = input;
        const spec = this.withSandbox(applyOverrides(input.spec, mergeOverrides(unconsumed), provider), input.spec, provider);
        const conversation = parent.writer.currentConversation();
        const wasInterrupted = parent.live.interruptRequested && verdictStatus !== 'succeeded';
        if (conversation === null && !wasInterrupted) {
            parent.writer.warn('provider did not report a resumable conversation ID; continuing in a fresh session');
        }
        try {
            unlinkSync(jobFile(this.repo, parent.jobId, FILES.cancelSteer));
        }
        catch { }
        const nextJobId = newJobId(spec.mode);
        const nextWriter = this.newWriter(nextJobId);
        const latestContext = [...unconsumed].reverse().find((e) => e.context !== undefined)?.context ?? spec.context;
        const resuming = conversation !== null;
        const parentWatched = parent.writer.snapshot()?.watchedFiles;
        const { watchedFiles: nextWatchedFiles, syncedFiles, notes: syncWarnings } = this.syncContinuationFiles(spec.cwd, parentWatched, unconsumed.flatMap((e) => e.files ?? []));
        const nextBrief = buildBrief({
            mode: spec.mode,
            preset: spec.preset,
            cwd: spec.cwd,
            context: latestContext,
            checks: spec.checks,
            pipelineStage: spec.pipeline !== null,
            resuming,
        });
        const { rawPrompt, sentPrompt, prependBrief } = buildSteeredPrompt({
            wasInterrupted,
            priorStatus: verdictStatus,
            freshContinuation: !resuming,
            responseTail: resuming ? '' : result.response.trim().slice(-600),
            entries: unconsumed,
            syncedFiles,
            brief: nextBrief,
        });
        const nextLiveEntry = newLiveJob(nextWriter, spec.timeoutMs);
        const parentSnap = parent.writer.snapshot();
        const nextTurn = (parentSnap?.turn ?? 1) + 1;
        const continuationKind = parent.live.interruptRequested ? 'steer' : 'follow-up';
        const chainStartedAt = continuationKind === 'steer'
            ? parentSnap?.chainStartedAt ?? parentSnap?.startedAt ?? parentSnap?.createdAt
            : undefined;
        nextWriter.start(turnStartInput(provider.name, spec, {
            prompt: rawPrompt,
            preamble: prependBrief ? nextBrief : undefined,
            preambleApplied: nextBrief !== '',
            conversation,
            task: parentSnap?.task ?? spec.task,
            watchedFiles: nextWatchedFiles,
            turn: nextTurn,
            continuedFrom: parent.jobId,
            continuationKind,
            chainStartedAt,
        }));
        if (spec.checks !== undefined)
            writeJsonAtomic(jobFile(this.repo, nextJobId, FILES.checksSpec), spec.checks);
        parent.live.consumedSteers = entries.length;
        writeConsumedCount(this.repo, parent.jobId, entries.length);
        for (const e of unconsumed)
            nextWriter.recordMessage(e.prompt, 'turn-start', senderOf(e));
        if (spec.ownerChecks && spec.checks?.length)
            markAcceptancePending(this.repo, nextJobId, spec.checks);
        const trackedKeys = [...new Set([...this.envKeysOf(parent.jobId), ...Object.keys(spec.env ?? {})])];
        if (trackedKeys.length > 0)
            writeJsonAtomic(jobFile(this.repo, nextJobId, ENV_KEYS_FILE), trackedKeys);
        for (const w of syncWarnings)
            nextWriter.warn(w);
        const workerId = parentSnap?.workerId ?? spec.workerId;
        const recordChild = () => {
            this.workers.recordTurnStart({
                workerId, name: parentSnap?.name ?? spec.name, jobId: nextJobId, continuation: true, lockHeld: true,
            });
        };
        try {
            if (input.lockHeld === true)
                recordChild();
            else
                await withWorkerLock(this.repo, workerId, recordChild);
        }
        catch (err) {
            nextWriter.warn(`worker index not updated: ${describe(err)}`);
        }
        if (continuationKind === 'steer') {
            writeAtomic(jobFile(this.repo, parent.jobId, FILES.steerHead), `${nextJobId}\n`);
        }
        this.spawnedIds.add(nextJobId);
        this.live.set(nextJobId, nextLiveEntry);
        try {
            await spec.onPrepared?.(nextJobId);
        }
        catch { }
        if (continuationKind === 'steer')
            parent.writer.markSuperseded(nextJobId);
        else
            parent.writer.markFollowedBy(nextJobId);
        parent.writer.finish(result, report === '' ? null : report);
        this.live.delete(parent.jobId);
        if (input.spec.checks !== undefined && input.spec.checks.length > 0) {
            try {
                if (continuationKind === 'follow-up')
                    writeAcceptance(this.repo, parent.jobId, { state: 'unchecked', checks: [], reason: 'continued by follow-up' });
                else
                    markAcceptanceSuperseded(this.repo, parent.jobId);
            }
            catch (err) {
                process.stderr.write(`agent-smith acceptance ${parent.jobId}: ${describe(err)}\n`);
            }
        }
        return {
            spec: { ...spec, jobId: nextJobId },
            writer: nextWriter,
            jobId: nextJobId,
            live: nextLiveEntry,
            prompt: sentPrompt,
            conversation: conversation ?? undefined,
            turn: { rawPrompt, prependBrief: false, resuming, context: latestContext },
        };
    }
    cancel(id) {
        const trimmed = id.trim();
        const isJob = this.isJobId(trimmed);
        let headId;
        try {
            headId = isJob ? this.resolveTurn(trimmed) : this.resolveWorkerHeadId(trimmed);
        }
        catch (err) {
            if (err instanceof WorkerLookupError && err.kind === 'missing') {
                throw new Error(`no job "${id}" in ${jobsDir(this.repo)}; call list_jobs for valid job IDs.`);
            }
            throw err;
        }
        const known = this.live.has(headId) || (this.isSafeJobId(headId) && existsSync(jobDir(this.repo, headId)));
        if (!known) {
            throw new Error(`no job "${id}" in ${jobsDir(this.repo)}; call list_jobs for valid job IDs.`);
        }
        const resolvedFrom = headId !== trimmed ? trimmed : null;
        const discarded = this.cutQueue(headId);
        const dropped = discarded.length === 0 ? {} : { discarded: discarded.length, warnings: [discardedWarning(discarded)] };
        const headManifest = this.readManifestSync(headId);
        if (!this.live.has(headId) && headManifest !== null && headManifest.status !== 'running') {
            const checksPending = readAcceptance(this.repo, headId).pending === true;
            if (checksPending || discarded.length > 0)
                createMarker(jobFile(this.repo, headId, FILES.cancel), new Date().toISOString());
            if (discarded.length > 0)
                this.setSettledPending(headId, 0);
            return {
                jobId: headId,
                ...(resolvedFrom === null ? {} : { resolvedFrom }),
                ...dropped,
                requested: checksPending,
                signalled: false,
                status: headManifest.status,
                note: checksPending
                    ? `Already ${headManifest.status}; asked its owner to stop the acceptance checks still running.`
                    : `Already ${headManifest.status}; nothing to cancel.`,
            };
        }
        const targets = new Set([headId]);
        if (isJob && trimmed !== headId && (this.live.has(trimmed) || this.readManifestSync(trimmed)?.status === 'running')) {
            targets.add(trimmed);
        }
        for (const target of targets) {
            try {
                unlinkSync(jobFile(this.repo, target, FILES.cancelSteer));
            }
            catch { }
            const live = this.live.get(target);
            const writer = live?.writer ??
                this.newWriter(target);
            writer.requestCancel();
            if (live !== undefined) {
                live.userCanceled = true;
                live.handle?.cancel();
            }
        }
        const headLive = this.live.get(headId);
        if (headLive === undefined) {
            return {
                jobId: headId,
                ...(resolvedFrom === null ? {} : { resolvedFrom }),
                ...dropped,
                requested: true,
                signalled: false,
                note: 'Cancel recorded; no live worker here to signal directly. A live owning supervisor will stop it.',
            };
        }
        return {
            jobId: headId,
            ...(resolvedFrom === null ? {} : { resolvedFrom }),
            ...dropped,
            requested: true,
            signalled: headLive.handle !== null,
            note: headLive.handle === null
                ? 'Cancel recorded; the continuation has not started yet and will be cancelled before it runs.'
                : 'Canceled.',
        };
    }
    ownerLive(jobId, m) {
        if (this.live.has(jobId))
            return true;
        if (!ownerAlive(m) || existsSync(jobFile(this.repo, jobId, FILES.ownerDone)))
            return false;
        if (!isTerminalStatus(m.status))
            return true;
        return this.checksPending(jobId) || readSteerEntries(this.repo, jobId).length > readConsumedCount(this.repo, jobId);
    }
    checksPending(jobId) {
        const acc = readAcceptance(this.repo, jobId);
        return 'pending' in acc && acc.pending === true;
    }
    cutQueue(jobId) {
        if (!this.isSafeJobId(jobId))
            return [];
        const undelivered = undeliveredEntries(this.repo, jobId);
        writeDiscardCut(this.repo, jobId, readSteerEntries(this.repo, jobId).length);
        return undelivered;
    }
    async messageTarget(ref) {
        const { headId, head } = this.messageHead(ref.trim());
        if (!this.ownerLive(headId, head))
            this.assertResumable(head);
        return this.numberedDetail(headId);
    }
    messageHead(ref) {
        if (existsSync(pipelineRecordPath(this.repo, ref))) {
            throw new Error(`"${ref}" is a pipeline run; follow_up and steer apply to workers, not runs.`);
        }
        let headId;
        try {
            headId = this.resolveWorkerHeadId(ref);
        }
        catch (err) {
            throw err instanceof WorkerLookupError ? new Error(err.message) : err;
        }
        const head = this.readManifestSync(headId);
        if (head === null)
            throw new Error(`No worker "${ref}"; see list_jobs.`);
        if (head.pipeline !== null && head.pipeline !== undefined) {
            throw new Error(`"${head.name ?? headId}" is a pipeline stage (${headId}); run_pipeline manages its turns.`);
        }
        return { headId, head };
    }
    assertResumable(head) {
        if (typeof head.conversation === 'string' && head.conversation !== '')
            return;
        const name = head.name ?? head.jobId;
        throw new Error(`"${name}" (${head.jobId}) has no saved conversation; spawn_job with from:"${name}" starts it fresh with the original brief.`);
    }
    async followUp(request) {
        return this.deliver('follow_up', request);
    }
    async steer(request) {
        return this.deliver('steer', request);
    }
    async deliver(sender, request) {
        const prompt = request.prompt;
        if (typeof prompt !== 'string' || prompt.trim() === '') {
            throw new Error('prompt is empty; there is nothing to hand the worker.');
        }
        const ref = request.worker.trim();
        const { headId: firstHeadId, head: first } = this.messageHead(ref);
        const env = sender === 'follow_up' ? validateEnv(request.env) : undefined;
        const files = request.files !== undefined && request.files.length > 0 ? validateWatchedFiles(this.repo, request.files) : undefined;
        const workerId = first.workerId ?? firstHeadId;
        const overrides = sender === 'steer' ? {} : {
            ...(request.checks === undefined ? {} : { checks: request.checks }),
            ...(request.model === undefined ? {} : { model: request.model }),
            ...(request.effort === undefined ? {} : { effort: request.effort }),
            ...(request.timeoutMs === undefined ? {} : { timeoutMs: resolveTimeoutMs(request.timeoutMs) }),
            ...(request.unrestricted === undefined ? {} : { unrestricted: request.unrestricted }),
        };
        const warnings = [];
        if (overrides.model !== undefined || overrides.effort !== undefined) {
            warnings.push(...checkAgainstCatalog(first.provider, overrides.model, overrides.effort, await this.catalogFor(first.provider)));
        }
        const entry = {
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date().toISOString(),
            prompt,
            ...(request.context === undefined ? {} : { context: request.context }),
            ...(files === undefined ? {} : { files }),
            delivery: sender === 'steer' ? 'interrupt' : 'queue',
            ...(sender === 'steer' && request.allowFresh === true ? { allowFresh: true } : {}),
            sender,
            ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
        };
        return withWorkerLock(this.repo, workerId, async () => {
            const headId = this.workerHeadId(workerId) ?? firstHeadId;
            const head = this.readManifestSync(headId);
            if (head === null)
                throw new Error(`No worker "${ref}"; see list_jobs.`);
            if (this.ownerLive(headId, head))
                return this.enqueue(sender, headId, head, entry, env, warnings);
            return this.coldStart(sender, head, entry, env, warnings);
        }, { waitMs: LAUNCH_ACK_MS + LOCK_WAIT_MS });
    }
    enqueue(sender, headId, head, entry, env, warnings) {
        const live = this.live.get(headId);
        const running = head.status === 'running';
        const name = head.name ?? headId;
        if (sender === 'steer' && running) {
            if (live?.userCanceled || existsSync(jobFile(this.repo, headId, FILES.cancel))) {
                throw new Error(`"${name}" (${headId}) is being canceled; send the message after it stops.`);
            }
            const resumable = (typeof head.conversation === 'string' && head.conversation !== '') ||
                (live !== undefined && live.writer.currentConversation() !== null);
            if (!resumable && entry.allowFresh !== true) {
                throw new Error(`Cannot interrupt "${name}" (${headId}): no resumable conversation handle exists yet, so interrupting now would discard in-flight context and start fresh. Wait for a conversation ID, use follow_up, or pass allowFresh: true.`);
            }
        }
        const checksRunning = !running && this.checksPending(headId);
        appendSteerEntry(this.repo, headId, entry);
        const at = entry.createdAt;
        if (sender === 'steer') {
            if (running) {
                writeAtomic(jobFile(this.repo, headId, FILES.cancelSteer), `${at}\n`);
                if (live !== undefined) {
                    live.interruptRequested = true;
                    if (live.handle !== null && (live.writer.currentConversation() !== null || entry.allowFresh === true) && !live.interruptFired) {
                        live.interruptFired = true;
                        live.handle.cancel();
                    }
                }
            }
            else if (checksRunning) {
                createMarker(jobFile(this.repo, headId, FILES.checksAbort), at);
            }
        }
        const entries = readSteerEntries(this.repo, headId);
        const consumed = live !== undefined ? live.consumedSteers : readConsumedCount(this.repo, headId);
        const pending = Math.max(1, entries.length - consumed);
        if (live !== undefined)
            live.writer.setPendingSteers(pending, at);
        else if (!running)
            this.setSettledPending(headId, pending);
        const workerId = head.workerId ?? headId;
        const envAck = this.envForLiveOwner(workerId, headId, env, warnings);
        const provider = this.providerSafe(head.provider);
        const canDeliverLive = running
            && provider?.liveInput === true
            && !live?.interruptRequested
            && !existsSync(jobFile(this.repo, headId, FILES.cancelSteer))
            && !existsSync(jobFile(this.repo, headId, FILES.cancel))
            && liveDeliverable(entry)
            && entries.slice(consumed).every(liveDeliverable);
        const delivery = sender === 'steer'
            ? 'now'
            : canDeliverLive ? 'next-step' : 'turn-end';
        const checks = (entry.overrides?.checks ?? this.headChecks(headId))?.map((c) => c.name);
        const turn = typeof head.turn === 'number' && head.turn >= 1 ? head.turn : 1;
        const note = sender === 'steer'
            ? running ? 'Interrupting; the steered turn starts next.'
                : checksRunning ? 'Aborting the checks; the steered turn starts next.' : 'Queued; the steered turn starts next.'
            : delivery === 'next-step' ? 'Sent into the running turn; read at its next step.'
                : running ? 'Queued; runs when this turn ends.'
                    : checksRunning ? 'Queued; runs after the checks.' : 'Queued; runs as the next turn.';
        return {
            jobId: headId, name, workerId, turn,
            action: sender === 'steer' && (running || checksRunning) ? 'interrupting' : 'queued',
            delivery, status: 'running', provider: head.provider, repo: this.repo,
            timeoutMs: entry.overrides?.timeoutMs ?? head.timeoutMs ?? DEFAULT_TIMEOUT_MS$1,
            pendingMessages: pending,
            ...envAck,
            ...(checks !== undefined && checks.length > 0 ? { checks } : {}),
            ...(warnings.length === 0 ? {} : { warnings }),
            note,
        };
    }
    async coldStart(sender, head, entry, env, warnings) {
        this.assertResumable(head);
        const workerId = head.workerId ?? head.jobId;
        const passed = env !== undefined && Object.keys(env).length > 0;
        const known = { ...(this.envVault.get(workerId) ?? {}), ...(env ?? {}) };
        const runEnv = Object.keys(known).length > 0 ? known : undefined;
        const missing = this.envKeysOf(head.jobId).filter((k) => !(k in known));
        if (missing.length > 0)
            warnings.push(`env ${missing.join(', ')} not set: values live only in memory and were lost; pass env again.`);
        const envAck = missing.length > 0 ? { env: 'dropped', envKeys: missing }
            : passed ? { env: 'set' } : runEnv !== undefined ? { env: 'kept' } : {};
        const acceptance = readAcceptance(this.repo, head.jobId);
        const onDisk = readSteerEntries(this.repo, head.jobId).length;
        const request = this.continuationRequest({
            head, provider: head.provider, entries: [...undeliveredEntries(this.repo, head.jobId), entry],
            verdict: verdictBlock(acceptance), env: runEnv, headChecks: this.headChecks(head.jobId), replacesHead: false,
        });
        const { ack } = await this.spawnTracked({ ...request, ownerChecks: true, lockHeldByCaller: true });
        writeConsumedCount(this.repo, head.jobId, onDisk);
        const checks = request.checks?.map((c) => c.name);
        return {
            jobId: ack.jobId, name: ack.name, workerId: ack.workerId, turn: ack.turn,
            action: 'started', delivery: 'now', status: 'running', provider: ack.provider, repo: this.repo,
            timeoutMs: ack.timeoutMs,
            ...envAck,
            ...(checks !== undefined && checks.length > 0 ? { checks } : {}),
            ...((warnings.length + (ack.warnings?.length ?? 0)) === 0 ? {} : { warnings: [...warnings, ...(ack.warnings ?? [])] }),
            note: sender === 'steer' ? `Started turn ${ack.turn} with the steer.` : `Started turn ${ack.turn}.`,
        };
    }
    envForLiveOwner(workerId, headId, env, warnings) {
        const vault = this.envVault.get(workerId);
        if (env !== undefined && Object.keys(env).length > 0) {
            const same = vault !== undefined && Object.entries(env).every(([k, v]) => vault[k] === v);
            this.envVault.set(workerId, { ...(vault ?? {}), ...env });
            if (!same)
                warnings.push('env applies from the next new turn after this worker goes idle; the running worker keeps the environment it started with.');
            return { env: 'kept' };
        }
        return this.envKeysOf(headId).length > 0 || (vault !== undefined && Object.keys(vault).length > 0) ? { env: 'kept' } : {};
    }
    envKeysOf(jobId) {
        try {
            const keys = JSON.parse(readFileSync(jobFile(this.repo, jobId, ENV_KEYS_FILE), 'utf8'));
            return Array.isArray(keys) ? keys.filter((k) => typeof k === 'string') : [];
        }
        catch {
            return [];
        }
    }
    headChecks(jobId) {
        try {
            const checks = JSON.parse(readFileSync(jobFile(this.repo, jobId, FILES.checksSpec), 'utf8'));
            return Array.isArray(checks) ? checks : undefined;
        }
        catch {
            return undefined;
        }
    }
    providerSafe(name) {
        try {
            return this.providerSource(name);
        }
        catch {
            return null;
        }
    }
    isSafeJobId(id) {
        return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) && id !== '.' && id !== '..';
    }
    isJobId(id) {
        return this.isSafeJobId(id) && (this.live.has(id) || existsSync(jobFile(this.repo, id, FILES.job)));
    }
    readManifestSync(id) {
        if (!this.isSafeJobId(id))
            return null;
        const inMem = this.live.get(id)?.writer.snapshot();
        if (inMem !== null && inMem !== undefined)
            return inMem;
        reconcileOrphan(this.repo, id);
        try {
            return readManifest(this.repo, id);
        }
        catch {
            return null;
        }
    }
    readManifestRaw(id) {
        if (!this.isSafeJobId(id))
            return null;
        const inMem = this.live.get(id)?.writer.snapshot();
        if (inMem !== null && inMem !== undefined)
            return inMem;
        try {
            return readManifest(this.repo, id);
        }
        catch {
            return null;
        }
    }
    resolveTurn(jobId) {
        const trimmed = jobId.trim();
        const seen = new Set();
        let curId = trimmed;
        let cur = this.readManifestSync(curId);
        if (cur === null)
            return trimmed;
        while (!seen.has(curId)) {
            seen.add(curId);
            const nextId = cur.supersededBy ?? readSteerHead(this.repo, curId);
            if (nextId === null || nextId === undefined || nextId === '')
                break;
            const next = this.readManifestSync(nextId);
            if (next === null)
                break;
            curId = nextId;
            cur = next;
        }
        return curId;
    }
    /**
     * @deprecated Use resolveTurn (a jobId) or resolveWorkerHead (a worker).
     * Kept for callers outside forge (channel tools/tasks): same as resolveTurn.
     */
    resolveHead(jobId) {
        return this.resolveTurn(jobId);
    }
    workerTurns(workerId) {
        const index = this.workers.get(workerId);
        if (index === null)
            return [];
        const out = [];
        index.turns.forEach((jobId, pos) => {
            let m = this.readManifestRaw(jobId);
            if (m === null)
                return;
            if (m.status === 'running' && !this.live.has(jobId))
                m = this.readManifestSync(jobId) ?? m;
            const turn = typeof m.turn === 'number' && Number.isInteger(m.turn) && m.turn >= 1 ? m.turn : pos + 1;
            out.push({ jobId, manifest: m, turn });
        });
        return out;
    }
    turnLike(t) {
        return {
            jobId: t.jobId,
            status: t.manifest.status,
            turn: t.turn,
            supersededBy: t.manifest.supersededBy,
            followedBy: t.manifest.followedBy,
            startedAt: t.manifest.startedAt,
            createdAt: t.manifest.createdAt,
            updatedAt: t.manifest.updatedAt,
            hasSteerHead: readSteerHead(this.repo, t.jobId) !== null,
            acceptancePending: this.checksPending(t.jobId),
            pendingMessages: t.manifest.pendingSteers ?? 0,
        };
    }
    workerHead(workerId) {
        return pickHead(this.workerTurns(workerId).map((t) => this.turnLike(t)));
    }
    workerHeadId(workerId) {
        let turns = this.workerTurns(workerId);
        if (turns.length === 0) {
            this.workers.refresh();
            turns = this.workerTurns(workerId);
        }
        const head = pickHead(turns.map((t) => this.turnLike(t)));
        return head === null ? null : this.resolveTurn(head.jobId);
    }
    resolveWorkerHeadId(ref) {
        const trimmed = ref.trim();
        if (trimmed === '')
            throw new WorkerLookupError('worker is empty; pass a worker name, workerId or jobId.', 'missing');
        this.workers.refresh();
        if (this.isJobId(trimmed)) {
            const m = this.readManifestRaw(trimmed);
            const workerId = m?.workerId ?? trimmed;
            return this.workerHeadId(workerId) ?? this.resolveTurn(trimmed);
        }
        if (this.isSafeJobId(trimmed)) {
            const byWorkerId = this.workerHeadId(trimmed);
            if (byWorkerId !== null)
                return byWorkerId;
        }
        return this.resolveName(trimmed);
    }
    resolveName(name) {
        const workerIds = this.workers.workersNamed(name);
        const heads = [];
        for (const wid of workerIds) {
            const turns = this.workerTurns(wid);
            const head = pickHead(turns.map((t) => this.turnLike(t)));
            if (head === null)
                continue;
            const headId = this.resolveTurn(head.jobId);
            const manifest = this.readManifestSync(headId) ?? turns.find((t) => t.jobId === head.jobId).manifest;
            heads.push({ jobId: headId, manifest, session: turns.some((t) => this.spawnedIds.has(t.jobId)), idle: isWorkerIdle(head) });
        }
        if (heads.length === 0)
            throw new WorkerLookupError(`No worker "${name}"; see list_jobs.`, 'missing');
        const startOf = (h) => Date.parse(h.manifest.startedAt ?? h.manifest.createdAt ?? '') || 0;
        const latest = (xs) => [...xs].sort((a, b) => startOf(b) - startOf(a) || b.jobId.localeCompare(a.jobId))[0];
        const running = heads.filter((h) => !h.idle);
        if (running.length === 1)
            return running[0].jobId;
        const pool = running.length > 1 ? running : heads;
        const session = pool.filter((h) => h.session);
        if (session.length > 0)
            return latest(session).jobId;
        if (pool.length === 1)
            return pool[0].jobId;
        const candidates = [...pool].sort((a, b) => startOf(b) - startOf(a)).map((h) => isTerminalStatus(h.manifest.status)
            ? `${name} (${h.jobId}, finished ${h.manifest.finishedAt ?? h.manifest.updatedAt ?? 'unknown'})`
            : `${name} (${h.jobId}, ${h.manifest.status})`);
        throw new WorkerLookupError(`"${name}" matches ${pool.length} workers: ${candidates.join(', ')}; pass a jobId.`, 'ambiguous', pool.map((h) => h.jobId));
    }
    async resolveWorkerHead(nameOrWorkerIdOrJobId) {
        return this.numberedDetail(this.resolveWorkerHeadId(nameOrWorkerIdOrJobId));
    }
    async resolveWorker(nameOrId) {
        const trimmed = nameOrId.trim();
        if (this.isJobId(trimmed))
            return this.numberedDetail(this.resolveTurn(trimmed));
        return this.resolveWorkerHead(trimmed);
    }
    async numberedDetail(jobId) {
        const d = await this.detail(jobId);
        const raw = this.readManifestRaw(jobId);
        if (raw === null || (typeof raw.turn === 'number' && raw.turn >= 1))
            return d;
        const pos = this.workers.get(d.workerId)?.turns.indexOf(jobId) ?? -1;
        return pos >= 0 ? { ...d, turn: pos + 1 } : d;
    }
    async earlierTurns(headOrId, cap = 20) {
        const head = typeof headOrId === 'string' ? await this.resolveWorker(headOrId) : headOrId;
        if (cap <= 0)
            return [];
        let index = this.workers.get(head.workerId);
        if (index === null || !index.turns.includes(head.jobId)) {
            this.workers.refresh();
            index = this.workers.get(head.workerId);
        }
        if (index === null)
            return [];
        const pos = index.turns.indexOf(head.jobId);
        const before = pos >= 0 ? index.turns.slice(0, pos) : [];
        const wanted = before.slice(-cap);
        const offset = before.length - wanted.length;
        const out = [];
        for (let i = 0; i < wanted.length; i++) {
            const id = wanted[i];
            const d = await this.detail(id).catch(() => null);
            if (d === null)
                continue;
            const raw = this.readManifestRaw(id);
            const numbered = raw !== null && typeof raw.turn === 'number' && raw.turn >= 1;
            out.push(numbered ? d : { ...d, turn: offset + i + 1 });
        }
        return out;
    }
    findActiveIdentity(name, workerId) {
        const own = this.workerTurns(workerId).find((t) => t.manifest.status === 'running');
        if (own !== undefined)
            return this.turnLike(own);
        for (const wid of this.workers.workersNamed(name)) {
            if (wid === workerId)
                continue;
            const head = this.workerHead(wid);
            if (!isWorkerIdle(head))
                return head;
        }
        return null;
    }
    async list(filter = {}) {
        for (const id of this.spawnedRuns) {
            for (const stage of Object.values(readPipeline(this.repo, id)?.stageResults ?? {})) {
                if (stage.jobId)
                    this.spawnedIds.add(stage.jobId);
            }
        }
        const all = await this.readJobs();
        let pool = all;
        if (filter.ids !== undefined) {
            const matchedWorkers = new Set();
            for (const j of all) {
                if (filter.ids.has(j.jobId) || filter.ids.has(j.workerId)) {
                    matchedWorkers.add(j.workerId);
                }
            }
            pool = all.filter((j) => filter.ids.has(j.jobId) || matchedWorkers.has(j.workerId));
        }
        const groupByWorker = filter.groupByWorker ?? true;
        let rows;
        if (groupByWorker) {
            const byId = new Map();
            const groups = new Map();
            for (const j of pool) {
                byId.set(j.jobId, j);
                const list = groups.get(j.workerId);
                if (list !== undefined)
                    list.push(j);
                else
                    groups.set(j.workerId, [j]);
            }
            rows = [];
            for (const turns of groups.values()) {
                const sorted = [...turns].sort((a, b) => compareTurnPriority({ ...a, hasSteerHead: readSteerHead(this.repo, a.jobId) !== null }, { ...b, hasSteerHead: readSteerHead(this.repo, b.jobId) !== null }));
                let head = sorted[0];
                const liveHeadId = this.resolveTurn(head.jobId);
                if (liveHeadId && liveHeadId !== head.jobId) {
                    const fromPool = byId.get(liveHeadId);
                    if (fromPool !== undefined) {
                        head = fromPool;
                    }
                    else {
                        const observed = await readObservedJob(this.repo, liveHeadId);
                        if (observed !== null) {
                            const summary = toSummary(observed);
                            const found = readAcceptance(this.repo, liveHeadId);
                            const acceptance = 'checks' in found ? found : { state: 'unchecked', checks: [] };
                            const meaningful = acceptance.state !== 'unchecked' || acceptance.pending === true || acceptance.checks.length > 0;
                            head = meaningful ? { ...summary, acceptance } : summary;
                        }
                    }
                }
                rows.push(head);
            }
        }
        else {
            rows = pool;
        }
        const touched = (j) => Date.parse(j.finishedAt ?? j.updatedAt ?? j.startedAt ?? '');
        const filtered = rows.filter((j) => (filter.status === undefined || j.status === filter.status) &&
            (filter.sinceMs === undefined || touched(j) >= filter.sinceMs));
        filtered.sort((a, b) => {
            const rank = (s) => (s === 'running' ? 0 : 1);
            const r = rank(a.status) - rank(b.status);
            if (r !== 0)
                return r;
            return (b.finishedAt ?? b.updatedAt ?? '').localeCompare(a.finishedAt ?? a.updatedAt ?? '');
        });
        const limit = filter.limit ?? 50;
        return filtered.slice(0, Math.max(1, limit));
    }
    async detail(jobId) {
        reconcileOrphan(this.repo, jobId);
        const observed = await readObservedJob(this.repo, jobId);
        if (observed === null) {
            throw new Error(`no job "${jobId}" in ${jobsDir(this.repo)}; call list_jobs for valid job IDs.`);
        }
        const reportPath = jobFile(this.repo, jobId, FILES.report);
        let report = null;
        try {
            report = readFileSync(reportPath, 'utf8');
        }
        catch {
            report = null;
        }
        const raw = observed.raw;
        let manifest = null;
        try {
            manifest = readManifest(this.repo, jobId);
        }
        catch { }
        const liveStale = manifest?.status === 'running' && manifest.watchedFiles !== undefined
            ? computeStaleReads(this.repo, manifest.cwd, manifest.watchedFiles, this.live.get(jobId)?.writer.editedFiles(Object.keys(manifest.watchedFiles)) ?? manifest.changedFiles)
            : [];
        const staleReads = [...new Set([...(manifest?.staleReads ?? []), ...liveStale])].sort();
        return {
            ...toSummary(observed),
            report,
            error: typeof raw['error'] === 'string' ? raw['error'] : null,
            exitCode: typeof raw['exit_code'] === 'number' ? raw['exit_code'] : null,
            unrestricted: raw['unrestricted'] === true,
            pipeline: typeof raw['pipeline'] === 'string' ? raw['pipeline'] : null,
            stage: typeof raw['stage'] === 'string' ? raw['stage'] : null,
            usage: typeof raw['usage'] === 'object' && raw['usage'] !== null ? raw['usage'] : null,
            conversation: typeof raw['conversation'] === 'string' ? raw['conversation'] : null,
            effort: typeof raw['effort'] === 'string' ? raw['effort'] : null,
            cwd: manifest?.cwd ?? null,
            ...(manifest?.reason ? { reason: manifest.reason } : {}),
            ...(manifest === null
                ? {}
                : {
                    ...(manifest.modelRequested === undefined ? {} : { modelRequested: manifest.modelRequested }),
                    ...(manifest.modelResolved === undefined ? {} : { modelResolved: manifest.modelResolved }),
                    ...(manifest.modelSource === undefined ? {} : { modelSource: manifest.modelSource }),
                    ...(manifest.preambleApplied === undefined ? {} : { preambleApplied: manifest.preambleApplied }),
                    ...(manifest.sandbox === undefined ? {} : { sandbox: manifest.sandbox }),
                    ...(manifest.sandboxFlags === undefined ? {} : { sandboxFlags: manifest.sandboxFlags }),
                    ...(manifest.readOnlyRequested === undefined ? {} : { readOnlyRequested: manifest.readOnlyRequested }),
                    ...(manifest.readOnlyEnforced === undefined ? {} : { readOnlyEnforced: manifest.readOnlyEnforced }),
                    ...(manifest.gitBaseline === undefined ? {} : { gitBaseline: manifest.gitBaseline }),
                    ...(manifest.changedFiles === undefined ? {} : { changedFiles: manifest.changedFiles }),
                    ...(manifest.changedFilesTruncated === undefined ? {} : { changedFilesTruncated: manifest.changedFilesTruncated }),
                    ...(manifest.unattributedFiles === undefined ? {} : { unattributedFiles: manifest.unattributedFiles }),
                    ...(manifest.watchedFiles === undefined ? {} : { watchedFiles: manifest.watchedFiles }),
                    ...(staleReads.length === 0 ? {} : { staleReads }),
                }),
            cancellable: this.live.has(jobId) || (manifest?.status === 'running' && ownerAlive(manifest)),
        };
    }
    async activities(jobId) {
        const live = this.live.get(jobId);
        if (live !== undefined)
            return live.writer.activities();
        try {
            const raw = await new AgentSmithReader().read(this.repo, jobId);
            const rows = raw?.payload[SMITH_PAYLOAD.recentActivities];
            return Array.isArray(rows) ? rows : [];
        }
        catch {
            return [];
        }
    }
    async state(jobId) {
        reconcileOrphan(this.repo, jobId);
        const live = this.live.get(jobId)?.writer.snapshot();
        if (live !== null && live !== undefined)
            return live.status;
        try {
            const raw = await new AgentSmithReader().read(this.repo, jobId);
            const s = raw?.payload[SMITH_PAYLOAD.status];
            return isForgeStatus(s) ? s : 'unknown';
        }
        catch {
            return 'unknown';
        }
    }
    async readJobs() {
        const ids = await new AgentSmithReader().discover(this.repo);
        const out = [];
        for (const id of ids) {
            reconcileOrphan(this.repo, id);
            const observed = await readObservedJob(this.repo, id);
            if (observed === null)
                continue;
            const summary = toSummary(observed);
            const found = readAcceptance(this.repo, id);
            const acceptance = 'checks' in found ? found : { state: 'unchecked', checks: [] };
            const meaningful = acceptance.state !== 'unchecked' || acceptance.pending === true || acceptance.checks.length > 0;
            out.push(meaningful ? { ...summary, acceptance } : summary);
        }
        return out;
    }
}
function describe(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}export{EFFORTS as E,ForgeService as F,MAX_WATCHED_FILES as M,getInstalledProviders as a,getCatalogs as g,launchPipeline as l,validateEnv as v};