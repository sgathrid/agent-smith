import {h as readManifest,b as readPipeline,c as cancelPipeline,n as normalize,A as AgentSmithReader,k as AgyStaffReader,P as PROVIDERS,l as errMessage,o as findProvider,j as jobFile,q as SCHEMA_VERSION,t as validOwnerPid,u as ownerAlive,g as isTerminalForgeStatus,F as FILES,w as reportFor,x as deriveOrphan,y as deriveStatus,z as writeAtomic,B as writeJsonAtomic,C as failureFields,R as REASONS,d as readAcceptance,E as writeAcceptance,p as providerNames,G as getProvider,M as MODES,a as MODE_PRESETS,D as DEFAULT_TIMEOUT_MS$1,H as nextActionFor,I as jobDir,J as fileSig,K as jobsDir,L as JobWriter,N as isMode,O as newJobId,Q as humanDuration,T as pipeEvents,U as pipelineRecordPath,V as isForgeJobId,W as computeStaleReads,X as SMITH_PAYLOAD,Y as isForgeStatus}from'./chunk-execute.js';import {fork}from'node:child_process';import {fileURLToPath}from'node:url';import {setTimeout as setTimeout$1}from'node:timers/promises';import {readFileSync,existsSync,mkdirSync,appendFileSync,realpathSync,lstatSync,copyFileSync,statSync,readdirSync,unlinkSync}from'node:fs';import path from'node:path';/** Detached execution, with one preparation barrier before a worker may start. */
async function launch(url, payload, onPrepared) {
    const child = fork(fileURLToPath(url), [], {
        detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        execArgv: url.pathname.endsWith('.ts') ? ['--experimental-strip-types'] : [],
    });
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => fail(new Error('execution supervisor did not acknowledge launch within 15s')), 15_000);
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
        while (true) {
            const head = service.resolveHead(ack.jobId);
            const detail = await service.detail(head);
            if (detail.status !== 'running' && !detail.supersededBy) {
                // Read the canonical manifest, not the surface projection.
                return readManifest(service.repo, head);
            }
            await setTimeout$1(100);
        }
    })();
    // ack-only callers deliberately do not await completion.
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
 * registry.ts — provider name → reader, and `readObservedJob()`.
 *
 * Production reads one job at a time (forge/service.ts, via the id's known
 * provider), so this stays tiny: two readers and one fault-isolating read.
 *
 *   "agent-smith"  PRIMARY.  Every job this repo spawned. Authoritative.
 *   "agy-staff"    INTEROP.  Somebody else's layout, read-only. Callers skip
 *                            forge ids here: forge/mirror.ts projects our jobs
 *                            into `.agy-staff/jobs/`, so this reader also sees
 *                            them, and two verdicts for one id must never exist.
 *
 * WHY FAULT ISOLATION MATTERS: readers read other people's mutable state. A
 * reader that throws (bad symlink, exotic errno) must degrade to an `unknown`
 * job, never to a crashed band. Every call here is wrapped.
 */
const READERS = new Map([
    ["agent-smith", new AgentSmithReader()],
    ["agy-staff", new AgyStaffReader()],
]);
/**
 * Read + normalize one job from one provider, isolating failures.
 *
 * Returns `null` if the provider is unknown, if the reader returns null (job
 * not known to it), or if either the read or the normalize threw. A throw here
 * is a bug we want visible in tests, but it must not take down a caller that
 * is polling every 100ms.
 */
async function readObservedJob(provider, cwd, jobId) {
    const reader = READERS.get(provider);
    if (reader === undefined)
        return null;
    let raw;
    try {
        raw = await reader.read(cwd, jobId);
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
}/**
 * providers/catalog.ts — cached model discovery across providers.
 *
 * Lazy: nothing runs until getCatalogs() is called. Per-provider TTL cache,
 * stale-on-error, parallel fan-out, never rejects.
 */
const CATALOG_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const cache = new Map();
let clock = Date.now;
let providerSource = () => PROVIDERS;
function lookup(name) {
    return providerSource().find((p) => p.name === name) ?? (providerSource() === PROVIDERS ? findProvider(name) : undefined);
}
function failed(name, error) {
    return { provider: name, models: [], defaultSource: 'unknown', source: 'live', stale: false, verified: false, error };
}
async function discover(provider, timeoutMs, refresh) {
    const name = provider.name;
    const hit = cache.get(name);
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
        cache.set(name, { catalog: fresh, at: clock() });
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
        const results = await Promise.all(targets.map((p) => discover(p, timeoutMs, refresh).catch((e) => failed(p.name, errMessage(e)))));
        return [...results, ...missing];
    }
    catch (e) {
        return [failed('*', errMessage(e))];
    }
}function checkLine(check) {
    const command = check.command.includes('`') ? check.command : `\`${check.command}\``;
    return `- ${check.name}: ${command}${check.cwd === undefined ? '' : ` (in ${check.cwd})`}`;
}
function checkLines(checks) {
    const gating = checks.filter((c) => c.blocking !== false);
    const advisory = checks.filter((c) => c.blocking === false);
    return [
        ...(gating.length === 0
            ? []
            : [
                "You're done when these checks pass. They run after you finish, so run them yourself first if you can:",
                ...gating.map(checkLine),
            ]),
        ...(advisory.length === 0
            ? []
            : ['These also run afterwards, for information only:', ...advisory.map(checkLine)]),
    ];
}
/** The brief, or '' when there is nothing to add. Joined to the prompt with a blank line. */
function buildBrief(input) {
    const context = input.context?.trim();
    const contextLines = context ? [`Context: ${context}`] : [];
    const checks = input.checks?.length ? checkLines(input.checks) : [];
    if (input.resuming === true)
        return [...contextLines, ...checks].join('\n');
    return [
        "You're working for an orchestrating agent that will check your work and act on your report.",
        ...(input.pipelineStage === true
            ? []
            : [
                `Workspace: ${input.cwd}. Make your changes only inside it: that's where the orchestrator reviews them, ` +
                    'and edits elsewhere would go unreviewed.',
            ]),
        ...contextLines,
        ...checks,
        ...(input.preset === undefined ? [] : [input.preset.guidance]),
        'In your report, only claim what you can point to: command output, file contents or a diff. ' +
            "If you couldn't verify something, say so.",
    ].join('\n');
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
            return false;
        }
        const resultFile = jobFile(repo, jobId, FILES.result);
        const resultBefore = readOptional(resultFile);
        const result = recoverableResult(resultBefore, manifest);
        const cancelFile = jobFile(repo, jobId, FILES.cancel);
        const cancelSteerFile = jobFile(repo, jobId, FILES.cancelSteer);
        const canceled = existsSync(cancelFile) || existsSync(cancelSteerFile);
        const report = result === null ? null : reportFor(result);
        const verdict = result === null
            ? deriveOrphan(manifest, null, now, undefined, canceled)
            : deriveStatus({
                alreadyTerminal: canceled || result.status === 'cancelled' ? 'canceled' : null,
                ok: result.ok, jobStatus: result.status,
                deniedActions: result.deniedActions ?? [], report,
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
                ...failureFields(verdict, result),
                deniedActions: (result.deniedActions ?? []).map(({ action, displayName, nonfatal }) => ({
                    ...(action === undefined ? {} : { action }),
                    ...(displayName === undefined ? {} : { displayName }),
                    ...(nonfatal === true ? { nonfatal: true } : {}),
                })),
                usage: result.usage === undefined ? null : Object.fromEntries(Object.entries(result.usage).filter((entry) => typeof entry[1] === 'number')),
                latestSummary: result.response.trim().slice(0, 1_000) || manifest.latestSummary || null,
                summarySource: result.response.trim() || manifest.latestSummary ? 'worker' : null,
            });
            abandonPendingAcceptance(repo, jobId, result.finishedAt);
            return true;
        }
        const at = new Date(now).toISOString();
        writeJsonAtomic(file, {
            ...manifest, status: verdict.status, error: verdict.reason,
            reason: verdict.status === 'failed' ? REASONS.serverStopped : null, jobStatus: 'orphaned',
            updatedAt: at, finishedAt: at,
        });
        abandonPendingAcceptance(repo, jobId, at);
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
}/**
 * spawn-request.ts — what a caller may ask the forge for, and the pure checks on it.
 *
 * Nothing here touches the job directory or a live job: it is the request and
 * ack shapes, the timeout clamp, provider/mode validation and the model catalog
 * check. forge/service.ts owns everything that has state.
 */
/** Floor and ceiling on a caller-supplied timeout. */
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 6 * 60 * 60_000;
/**
 * Clamp a timeout into the range we are willing to enforce. Pure; unit-tested.
 *
 * ZERO IS "UNSET", NOT "NO TIMEOUT", and that is a deliberate reading of an
 * otherwise ambiguous value. `SpawnSpec.timeoutMs: 0` means "do not arm the timer"
 * to providers/ndjson.ts, so a caller passing 0 would otherwise get an unbounded
 * job whose only kill path is an operator who happens to be watching. And a
 * pipeline stage that does not name a timeout — which is every stage in
 * ARCHITECTURE.md's own example — would have no budget at all.
 *
 * So 0 resolves to the default, exactly like an absent value. Anyone who genuinely
 * wants a very long job passes MAX_TIMEOUT_MS and says so out loud.
 */
function clampTimeout(ms) {
    if (ms === undefined || !Number.isFinite(ms) || ms <= 0)
        return DEFAULT_TIMEOUT_MS$1;
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(ms)));
}
/**
 * The word to put in a SpawnSpec for a provider that is not installed.
 *
 * Throwing rather than defaulting: `getProvider` on an unknown name is a typo in
 * a stage config, and a typo that silently runs zero workers and reports green is
 * the exact failure class this codebase is organised against. A KNOWN provider
 * whose binary is missing is different — that becomes a `failed` job with the
 * ENOENT in it, which is a report an operator can act on.
 */
function requireProvider(name) {
    if (findProvider(name) === undefined) {
        throw new Error(`unknown provider "${name}". Known providers: ${providerNames().join(', ')}.`);
    }
    return getProvider(name);
}
/** The teaching error for a mode outside the closed set. */
function modeError(mode) {
    const lines = MODES.map((m) => `  ${m}: ${MODE_PRESETS[m].description}`).join('\n');
    return new Error(`${mode === '' ? 'mode is required' : `unknown mode "${mode}"`}. Valid modes:\n${lines}`);
}
const AGY_EFFORT_SUFFIX = /-(low|medium|high)$/;
/**
 * Check model/effort against a catalog. Pure. Throws only when the catalog is
 * fresh and nonempty AND positively says the value is wrong; otherwise warns.
 */
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
        if (target !== undefined && target.efforts.length > 0 && !target.efforts.includes(effort)) {
            throw new Error(`effort "${effort}" is not valid for ${provider} model "${target.id}". Valid efforts: ${target.efforts.join(', ')}.`);
        }
    }
    return warnings;
}
/** The anchor one turn writes: the spec's fixed fields plus what differs per turn. */
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
        ...(turn.steeredFrom === undefined ? {} : { steeredFrom: turn.steeredFrom }),
        ...(turn.watchedFiles === undefined ? {} : { watchedFiles: turn.watchedFiles }),
    };
}/**
 * summary.ts — the read-side shapes (a list row, one job in full) and the pure
 * projection from an ObservedJob onto them.
 */
/** Project an ObservedJob onto what a list actually needs. */
function toSummary(observed, source) {
    const raw = observed.raw;
    const toolCalls = typeof raw['tool_calls'] === 'number' ? raw['tool_calls'] : null;
    const task = typeof raw['task'] === 'string' && raw['task'] !== '' ? raw['task'] : null;
    const changedFiles = raw['changed_files'];
    const digest = readDigest(raw['digest']);
    const activities = Array.isArray(raw['recent_activities']) ? raw['recent_activities'] : [];
    const currentActivity = observed.status === 'running'
        ? [...activities].reverse().find(isActiveForgeActivity) ?? null
        : null;
    return {
        jobId: observed.jobId,
        name: typeof raw['name'] === 'string' && raw['name'] ? raw['name'] : observed.jobId,
        workerId: typeof raw['workerId'] === 'string' ? raw['workerId'] : observed.jobId,
        role: typeof raw['role'] === 'string' ? raw['role'] : observed.mode,
        latestSummary: raw['summarySource'] === 'worker' && typeof raw['latestSummary'] === 'string' ? raw['latestSummary'] : null,
        summarySource: raw['summarySource'] === 'worker' ? 'worker' : null,
        source,
        status: observed.status,
        // `raw.provider` for OUR jobs. Interop jobs carry no provider field: they are
        // agy-staff's, i.e. agy. Their `profile` ("unrestricted") is a permission
        // word, not a provider, so it goes to the unrestricted flag.
        provider: typeof raw['provider'] === 'string' ? raw['provider'] : source === 'agy-staff' ? 'agy' : observed.label,
        unrestricted: raw['unrestricted'] === true || (source === 'agy-staff' && observed.label === 'unrestricted'),
        nextAction: nextActionFor({
            status: observed.status,
            jobStatus: typeof raw['job_status'] === 'string' ? raw['job_status'] : null,
            error: [typeof raw['error'] === 'string' ? raw['error'] : '', ...observed.warnings.map((w) => w.message)].join(' — '),
            report: observed.output,
            exitCode: typeof raw['exit_code'] === 'number' ? raw['exit_code'] : null,
            deniedCount: Array.isArray(raw['denied_actions']) ? raw['denied_actions'].length : 0,
            unrestricted: raw['unrestricted'] === true,
            steerNotApplied: observed.warnings.some((w) => w.code === 'steer_not_applied'),
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
        ...(typeof raw['steeredFrom'] === 'string' || raw['steeredFrom'] === null
            ? { steeredFrom: raw['steeredFrom'] }
            : {}),
        ...(typeof raw['pendingSteers'] === 'number'
            ? { pendingSteers: raw['pendingSteers'] }
            : {}),
        ...(Array.isArray(changedFiles) ? { changedFileCount: changedFiles.length } : {}),
        ...(digest !== null ? { digest } : {}),
    };
}
/** progress.json `digest`, accepted only when it has the shape the writer produces. */
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
 * steer-log.ts — the durable record of steers (`steer.jsonl`) and the prompt a
 * continuation turn is built from. Pure over the job directory: the pump in
 * forge/service.ts decides WHEN to chain; this decides what is said.
 */
function appendSteerEntry(repo, jobId, entry) {
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
        catch { /* ignore truncated line */ }
    }
    return out;
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
        ? `Your previous turn (${input.parentJobId}) was interrupted after ${input.toolCalls} tool call(s) with updated instructions from the orchestrator. Inspect your working tree before repeating any completed steps.`
        : `Your previous turn (${input.parentJobId}) completed after ${input.toolCalls} tool call(s), and the orchestrator queued follow-up instructions for you.`;
    const syncedLine = input.syncedFiles !== undefined && input.syncedFiles.length > 0
        ? `\nSynced brief file(s) in your working tree: ${input.syncedFiles.join(', ')} (re-read before continuing).`
        : '';
    const tailBlock = input.responseTail
        ? `\nLast response excerpt from previous turn:\n${input.responseTail}\n`
        : '';
    const header = `[STEERED TURN CONTINUITY] ${tag}\n${statusLine}${syncedLine}${tailBlock}\n[ORCHESTRATOR UPDATE]\n${steerBody}`;
    const prependBrief = input.brief !== '' && !header.startsWith(input.brief);
    const sentPrompt = prependBrief ? `${input.brief}\n\n${header}` : header;
    return { rawPrompt: header, sentPrompt, prependBrief };
}
/** The child job id the pump published before stamping `supersededBy`, if any. */
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
}/**
 * service.ts — the composition root that can START a worker.
 *
 * It wires providers/ (adapters) and pipeline/ (StageRunner) to the job
 * directory (forge/format.ts, writer.ts), and answers four questions: spawn a job, list
 * them, describe one, cancel one. `surfaces/channel` exposes exactly these as
 * MCP tools; nothing else in the repo may call a provider directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY spawn_job RETURNS IN UNDER A MILLISECOND
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A reference job in the corpus took 28 minutes. A tool call that waits for it
 * would time out, and a tool call that blocks the MCP server would stop the
 * channel from pushing anything at all for the duration — so a 28-minute job
 * would also blind the surface that exists to report it.
 *
 * So `spawnJob` does exactly three things synchronously: validate the request,
 * write the anchor (forge/writer.ts `start`), and hand the rest to a detached
 * async pump. The job id comes back and the job exists on disk before the caller
 * has finished reading the response. The 20 real jobs took 16.3 hours at a
 * concurrency of 3; a spawn path that holds the caller is that failure again.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SAFETY: --dangerously-skip-permissions IS OFF BY DEFAULT (EXCEPT FOR agy AND kimi)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `SpawnSpec.unrestricted` is a required field and this module defaults it to
 * `false`. It has to: a provider that can prompt must not bypass prompts by
 * default. agy and kimi cannot prompt headless: agy's restricted mode silently
 * denies tools and reports success with an empty response (verified live — see
 * providers/agy.ts, THE TRAP), so it defaults to unrestricted with an env
 * opt-out. kimi's print mode force-sets the auto policy and has no restricted
 * mode, so it is always unrestricted. `job.json` records the effective posture,
 * not a request that had no effect; everything else is opt-in per call.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A CLI
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It was going to be. The arguments against, which are the only ones that matter
 * here: this product is driven FROM WITHIN a harness, not from a terminal. A
 * `agent-smith run` binary would be a second way to do the same job as the MCP
 * tool, and a user driving agent-smith from Claude Code has a shell already —
 * it has Claude. Everything below is a plain function so it can be called from a
 * tool handler, a test, or a future entrypoint, and there is exactly one
 * implementation.
 */
function newLiveJob(writer, timeoutMs) {
    return {
        writer,
        handle: null,
        timeoutMs,
        consumedSteers: 0,
        interruptRequested: false,
        interruptFired: false,
        userCanceled: false,
    };
}
const STEER_CONVERSATION_WAIT_MS = 2_000;
/** A worker name that no job answers to, or that more than one worker does. */
class WorkerLookupError extends Error {
    kind;
    /** The job ids that matched, for an ambiguous name. */
    jobIds;
    constructor(message, kind, jobIds = []) {
        super(message);
        this.name = 'WorkerLookupError';
        this.kind = kind;
        this.jobIds = jobIds;
    }
}
const CATALOG_WAIT_MS = 2_000;
/**
 * The forge. One instance per process; the live-handle map is per instance.
 *
 * The map is bounded by the number of jobs this process started, and it is
 * deliberately NOT the source of truth — job.json is. A restart of this server
 * loses the ability to `kill()` an in-flight worker, and that is stated in the
 * cancel result rather than papered over: an honest "I marked it cancelled but
 * there is no handle here to signal" beats a `signalled: true` that never
 * happened. Service reads recover jobs whose recorded supervisor has died,
 * provided no terminal result is already present. PID-less legacy jobs remain
 * read-only observations because the service cannot prove their writer died.
 */
class ForgeService {
    repo;
    supervisorUrl;
    live = new Map();
    /** Job IDs spawned by this process, for `list_jobs session`. */
    spawnedIds = new Set();
    spawnedRuns = new Set();
    mirrorOn;
    flushMs;
    catalogSource;
    harnessDefaults;
    providerSource;
    describeSandbox;
    constructor(options) {
        this.repo = options.repo;
        this.supervisorUrl = options.supervisorUrl;
        this.mirrorOn = options.mirror ?? true;
        this.flushMs = options.flushMs;
        this.providerSource = options.providerSource ?? requireProvider;
        this.catalogSource = options.catalogSource ?? ((providers) => getCatalogs({ providers }));
        this.harnessDefaults = options.harnessDefaults ?? getHarnessDefaults;
        this.describeSandbox = options.describeSandbox ?? ((p, spec) => p.describeSandbox?.(spec));
        // Publish abandoned-job recovery when the owner service starts, so the
        // read-only pane agrees before an operator makes its first MCP status call.
        try {
            for (const entry of readdirSync(jobsDir(this.repo), { withFileTypes: true })) {
                if (entry.isDirectory())
                    reconcileOrphan(this.repo, entry.name);
            }
        }
        catch { /* A missing job store is the ordinary fresh-repo case. */ }
    }
    /** One writer per job, configured like every other writer this service makes. */
    newWriter(jobId) {
        return new JobWriter({
            repo: this.repo,
            jobId,
            mirror: this.mirrorOn,
            ...(this.flushMs === undefined ? {} : { flushMs: this.flushMs }),
        });
    }
    /** A worker is one running job at a time: refuse a name or identity that is already busy, on disk or live here. */
    assertNameFree(name, workerId) {
        const busy = (jobId) => new Error(`"${name}" is busy (${jobId}); wait, cancel, or use another name.`);
        const canonicalConflict = findActiveIdentity(this.repo, name, workerId);
        if (canonicalConflict !== null)
            throw busy(canonicalConflict.jobId);
        for (const { writer } of this.live.values()) {
            const active = writer.snapshot();
            if (active !== null && (active.workerId === workerId || active.name === name))
                throw busy(active.jobId);
        }
    }
    /** Never throws, never waits long: a catalog is advice, not a gate on starting. */
    async catalogFor(provider) {
        let timer;
        try {
            const timeout = new Promise((resolve) => {
                timer = setTimeout(() => resolve(undefined), CATALOG_WAIT_MS);
                timer.unref?.();
            });
            const all = await Promise.race([this.catalogSource([provider]), timeout]);
            return all?.find((c) => c.provider === provider) ?? all?.[0];
        }
        catch {
            return undefined;
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
        }
    }
    /**
     * Start one job. Returns as soon as the anchor is on disk.
     *
     * Rejects only for a bad REQUEST (unknown provider, empty prompt). Everything
     * that can go wrong afterwards — binary missing, auth expired, tool denied,
     * killed by the OS — arrives as a `failed` job, because a rejected promise has
     * no job id and therefore nothing a pane can ever draw.
     */
    async spawnJob(request) {
        const { ack } = await this.spawnTracked(request);
        return ack;
    }
    /**
     * spawnJob, plus the terminal manifest promise.
     *
     * Split out for exactly one caller — forge/runner.ts, which runs a pipeline
     * stage and must wait for it. Everything else wants the ack and the channel.
     */
    async spawnTracked(request) {
        if (this.supervisorUrl)
            return launchJob(this, request);
        const provider = this.providerSource(request.provider ?? 'agy');
        const rawMode = request.mode.trim();
        const resuming = request.conversation !== undefined && request.conversation !== null;
        // Closed set for fresh, non-pipeline spawns. Pipeline stages keep arbitrary
        // roles; a resume may carry a legacy mode from an older job.
        if (request.pipeline == null && !resuming && !isMode(rawMode))
            throw modeError(rawMode);
        const mode = rawMode === '' ? 'task' : rawMode;
        const preset = isMode(mode) ? MODE_PRESETS[mode] : undefined;
        const prompt = request.prompt;
        if (prompt.trim() === '') {
            throw new Error('prompt is empty; there is nothing to hand the worker.');
        }
        const timeoutMs = clampTimeout(request.timeoutMs);
        const cwd = request.cwd ?? this.repo;
        // agy and kimi cannot prompt headless. agy has an env opt-out; kimi's print
        // mode force-sets the auto policy and has no restricted mode, so the
        // EFFECTIVE posture is always unrestricted. Record that, not the request,
        // and warn when the two differ so the durable job is not a lie.
        const unrestrictedRequested = request.unrestricted;
        const unrestricted = provider.name === 'kimi'
            ? true
            : unrestrictedRequested ?? (provider.name === 'agy' && process.env['AGENT_SMITH_AGY_RESTRICTED'] !== '1');
        const warnings = [];
        if (unrestrictedRequested === false && provider.name === 'kimi') {
            warnings.push('kimi print mode force-sets the auto permission policy; unrestricted:false cannot restrict it. The ack and job.json record the effective posture.');
        }
        // A provider that cannot apply a per-run effort must not have one recorded
        // as applied. Drop it at the service boundary (so job.json is truthful) and
        // tell the caller; the adapter also emits an event for direct users.
        const effort = provider.supportsEffort === false ? undefined : request.effort;
        if (request.effort !== undefined && provider.supportsEffort === false) {
            warnings.push(`kimi has no per-run effort flag; effort "${request.effort}" was ignored. Set [thinking].effort or a model alias default_effort in config.toml.`);
        }
        if (request.model !== undefined || effort !== undefined) {
            warnings.push(...checkAgainstCatalog(provider.name, request.model, effort, await this.catalogFor(provider.name)));
        }
        let modelResolved = request.model ?? null;
        let modelSource = request.model === undefined ? 'unknown' : 'requested';
        if (request.model === undefined) {
            // Config-file read only: no CLI, so spawn stays instant (see server.ts no-long-call rule).
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
            preset,
            cwd,
            context: request.context,
            checks: request.checks,
            pipelineStage: request.pipeline !== undefined && request.pipeline !== null,
            resuming,
        });
        // A caller that already starts its prompt with the brief gets it once, not twice.
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
        const requestedFiles = request.files !== undefined && request.previousWatchedFiles !== undefined
            ? request.files.filter((f) => {
                if (!(f in request.previousWatchedFiles) || existsSync(path.resolve(this.repo, f)))
                    return true;
                warnings.push(`dropped deleted watched file "${f}" from previous turn`);
                return false;
            })
            : request.files;
        const watchedFiles = requestedFiles !== undefined && requestedFiles.length > 0
            ? syncWatchedFiles(this.repo, cwd, requestedFiles, request.previousWatchedFiles, (w) => warnings.push(w))
            : undefined;
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
            pipeline: request.pipeline ?? null,
            stage: request.stage ?? null,
            attempt: request.attempt ?? null,
            onPrepared: request.onPrepared,
        };
        // Anchor first. Everything after this point can fail loudly; nothing after
        // this point can make the job invisible.
        writer.start(turnStartInput(provider.name, spec, {
            prompt,
            // Exactly what was prepended, so the /forge pane's "Show preamble" matches what the worker read.
            preamble: prependBrief ? brief : undefined,
            preambleApplied,
            conversation: request.conversation ?? null,
            task: request.task,
            watchedFiles,
        }));
        try {
            if (request.checks !== undefined)
                writeJsonAtomic(jobFile(this.repo, jobId, FILES.checksSpec), request.checks);
            await request.onPrepared?.(jobId);
        }
        catch (error) {
            writer.abort('failed', `setup failed · ${String(error)}`);
            throw error;
        }
        this.spawnedIds.add(jobId);
        const ack = {
            jobId,
            name,
            workerId,
            role: mode,
            provider: provider.name,
            status: 'running',
            dir: jobDir(this.repo, jobId),
            repo: this.repo,
            timeoutMs,
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
        const done = this.pump(writer, provider, spec);
        return { ack, done };
    }
    /**
     * The detached pump: spawn, stream, record, chain steered turns, resolve.
     *
     * Never rejects. Every exit path lands on writer.finish() or writer.abort(),
     * because a job that stops being `running` is the only promise this function
     * makes to every reader on the other side of the filesystem. When a steer is
     * queued or interrupts the turn, this loop is the sole owner that opens the
     * child anchor and marks the parent superseded.
     */
    async pump(initialWriter, provider, spec) {
        let currentWriter = initialWriter;
        let currentJobId = spec.jobId;
        let currentPrompt = spec.prompt;
        let currentConversation = spec.conversation;
        let liveEntry = newLiveJob(currentWriter, spec.timeoutMs);
        // Register synchronously before the first await so a steer or cancel arriving
        // right after spawn_job finds the live entry in this.live.
        this.live.set(currentJobId, liveEntry);
        while (true) {
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
                    // THE KEY LINE. Handing the provider adapter OUR job directory as its
                    // stateDir means events.jsonl / argv.json / stderr.log / result.json are
                    // written by the already-verified plumbing in providers/ndjson.ts, for
                    // all four providers, instead of being copied across afterwards by us.
                    stateDir: jobDir(this.repo, currentJobId),
                    jobId: currentJobId,
                });
            }
            catch (err) {
                this.live.delete(currentJobId);
                return (currentWriter.abort('failed', `couldn't start · ${describe(err)}`) ??
                    currentWriter.snapshot() ??
                    { jobId: currentJobId });
            }
            liveEntry.handle = handle;
            const unsubscribe = pipeEvents(currentWriter, handle);
            let interruptDetectedAt = null;
            let lastPendingSteers = 0;
            let pollWarned = false;
            const syncSteerAndCancel = () => {
                if (existsSync(jobFile(this.repo, currentJobId, FILES.cancel))) {
                    liveEntry.userCanceled = true;
                }
                if (liveEntry.userCanceled) {
                    currentWriter.requestCancel();
                    handle.cancel();
                    return;
                }
                const entries = readSteerEntries(this.repo, currentJobId);
                const unconsumed = entries.slice(liveEntry.consumedSteers);
                if (unconsumed.length !== lastPendingSteers) {
                    lastPendingSteers = unconsumed.length;
                    currentWriter.setPendingSteers(unconsumed.length);
                }
                if (unconsumed.some((e) => e.delivery === 'interrupt') || existsSync(jobFile(this.repo, currentJobId, FILES.cancelSteer))) {
                    liveEntry.interruptRequested = true;
                }
                if (liveEntry.interruptRequested && !liveEntry.interruptFired) {
                    if (interruptDetectedAt === null)
                        interruptDetectedAt = Date.now();
                    const hasConversation = currentWriter.currentConversation() !== null;
                    const waitElapsed = Date.now() - interruptDetectedAt >= STEER_CONVERSATION_WAIT_MS;
                    if (hasConversation || waitElapsed) {
                        liveEntry.interruptFired = true;
                        handle.cancel();
                    }
                }
            };
            // A poll or an event tap must not be able to reject the pump: a disk error
            // in setPendingSteers is a warning, not the end of the worker.
            const safeSyncSteerAndCancel = () => {
                try {
                    syncSteerAndCancel();
                }
                catch (err) {
                    if (!pollWarned) {
                        pollWarned = true;
                        process.stderr.write(`agent-smith steer poll ${currentJobId}: ${describe(err)}\n`);
                    }
                }
            };
            const unsubSteerTap = handle.onEvent((ev) => {
                if (ev.kind === 'started' && liveEntry.interruptRequested && !liveEntry.interruptFired) {
                    safeSyncSteerAndCancel();
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
                await currentWriter.prepareFinish();
                const report = reportFor(result);
                safeSyncSteerAndCancel();
                const entries = readSteerEntries(this.repo, currentJobId);
                const unconsumed = entries.slice(liveEntry.consumedSteers);
                const alreadyTerminal = result.status === 'cancelled' ? 'canceled' : null;
                const verdict = deriveStatus({
                    alreadyTerminal,
                    ok: result.ok,
                    jobStatus: result.status,
                    deniedActions: result.deniedActions ?? [],
                    report: report === '' ? null : report,
                });
                const shouldChain = !liveEntry.userCanceled &&
                    unconsumed.length > 0 &&
                    (liveEntry.interruptRequested || verdict.status === 'succeeded');
                if (!shouldChain && !liveEntry.userCanceled && unconsumed.length > 0) {
                    const count = unconsumed.length;
                    currentWriter.warn(`${count} queued steer${count === 1 ? '' : 's'} not applied: the turn ended ${verdict.status}. ` +
                        'Use resume_job or steer_job again.');
                }
                if (shouldChain) {
                    const next = await this.chainContinuation({
                        provider, spec, parent: { writer: currentWriter, jobId: currentJobId, live: liveEntry },
                        result, report, entries, unconsumed, verdictStatus: verdict.status,
                    });
                    currentWriter = next.writer;
                    currentJobId = next.jobId;
                    currentPrompt = next.prompt;
                    currentConversation = next.conversation;
                    liveEntry = next.live;
                    continue;
                }
                const manifest = currentWriter.finish(result, report === '' ? null : report);
                this.live.delete(currentJobId);
                return manifest;
            }
            catch (err) {
                clearInterval(cancelPoll);
                unsubSteerTap();
                unsubscribe();
                this.live.delete(currentJobId);
                return (currentWriter.abort('failed', `crashed · ${describe(err)}`) ??
                    currentWriter.snapshot() ??
                    { jobId: currentJobId });
            }
        }
    }
    /**
     * Open the child turn of a steered chain and hand the job over to it.
     *
     * The order is the contract readers rely on: the child anchor is on disk
     * before the parent is finished, so anyone following `supersededBy` or
     * `steer.head` always finds a real job.
     */
    async chainContinuation(input) {
        const { provider, spec, parent, result, report, entries, unconsumed, verdictStatus } = input;
        const conversation = parent.writer.currentConversation();
        const wasInterrupted = parent.live.interruptRequested && verdictStatus !== 'succeeded';
        if (conversation === null && !wasInterrupted) {
            parent.writer.warn('provider did not report a resumable conversation ID; continuing in a fresh session');
        }
        parent.live.consumedSteers = entries.length;
        try {
            unlinkSync(jobFile(this.repo, parent.jobId, FILES.cancelSteer));
        }
        catch { /* no steer marker present */ }
        const nextJobId = newJobId(spec.mode);
        const nextWriter = this.newWriter(nextJobId);
        const latestContext = [...unconsumed].reverse().find((e) => e.context !== undefined)?.context ?? spec.context;
        const resuming = conversation !== null;
        const parentWatched = parent.writer.snapshot()?.watchedFiles;
        const explicitSteerFiles = new Set(unconsumed.flatMap((e) => e.files ?? []));
        const inheritedWatchedPaths = Object.keys(parentWatched ?? {}).filter((f) => {
            if (existsSync(path.resolve(this.repo, f)))
                return true;
            parent.writer.warn(`dropped deleted watched file "${f}" from continuation turn`);
            return false;
        });
        const mergedWatchedPaths = [
            ...new Set([
                ...inheritedWatchedPaths,
                ...explicitSteerFiles,
            ]),
        ];
        let nextWatchedFiles;
        const syncedFiles = [];
        const syncWarnings = [];
        if (mergedWatchedPaths.length > 0) {
            try {
                nextWatchedFiles = syncWatchedFiles(this.repo, spec.cwd, mergedWatchedPaths, parentWatched, (w) => syncWarnings.push(w));
                for (const [rel, sigs] of Object.entries(nextWatchedFiles)) {
                    const prev = parentWatched?.[rel];
                    if (prev === undefined || (prev.repoSig !== sigs.repoSig && sigs.cwdSig === sigs.repoSig)) {
                        syncedFiles.push(rel);
                    }
                }
            }
            catch (err) {
                parent.writer.warn(`watched file sync warning: ${describe(err)}`);
            }
        }
        const nextBrief = buildBrief({
            preset: spec.preset,
            cwd: spec.cwd,
            context: latestContext,
            checks: spec.checks,
            pipelineStage: spec.pipeline !== null,
            resuming,
        });
        const { rawPrompt, sentPrompt, prependBrief } = buildSteeredPrompt({
            parentJobId: parent.jobId,
            wasInterrupted,
            freshContinuation: !resuming,
            toolCalls: parent.writer.snapshot()?.toolCalls ?? 0,
            responseTail: result.response.trim().slice(-600),
            entries: unconsumed,
            syncedFiles,
            brief: nextBrief,
        });
        const nextLiveEntry = newLiveJob(nextWriter, spec.timeoutMs);
        // 1. Open child anchor on disk BEFORE finishing the parent so any reader
        //    following `supersededBy` finds the child anchor immediately.
        nextWriter.start(turnStartInput(provider.name, spec, {
            prompt: rawPrompt,
            preamble: prependBrief ? nextBrief : undefined,
            preambleApplied: nextBrief !== '',
            conversation,
            task: parent.writer.snapshot()?.task ?? spec.task,
            watchedFiles: nextWatchedFiles,
            steeredFrom: parent.jobId,
        }));
        if (spec.checks !== undefined)
            writeJsonAtomic(jobFile(this.repo, nextJobId, FILES.checksSpec), spec.checks);
        for (const w of syncWarnings)
            nextWriter.warn(w);
        // The child anchor exists; publish its id before the parent's terminal
        // write so resolveHead can cross the finish window.
        writeAtomic(jobFile(this.repo, parent.jobId, FILES.steerHead), `${nextJobId}\n`);
        // 2. Register child in spawnedIds and live map before removing parent.
        this.spawnedIds.add(nextJobId);
        this.live.set(nextJobId, nextLiveEntry);
        try {
            await spec.onPrepared?.(nextJobId);
        }
        catch { /* best-effort callback for continuation turn */ }
        // 3. Stamp supersededBy on parent and write parent's terminal manifest atomically.
        parent.writer.markSuperseded(nextJobId);
        parent.writer.finish(result, report === '' ? null : report);
        this.live.delete(parent.jobId);
        return { writer: nextWriter, jobId: nextJobId, live: nextLiveEntry, prompt: sentPrompt, conversation: conversation ?? undefined };
    }
    /**
     * Cancel a job.
     *
     * TWO STAGES, and the split is the honest answer rather than a hedge:
     *   - Marker written, live handle signalled. The worker is actually stopped and
     *     the state file says `canceled` within one poll interval.
     *   - Marker written, NO live handle. This process did not start the job (the
     *     server restarted, or the job belongs to another session). We record the
     * *intent* so every reader agrees the job was asked to stop, and we say so.
     *     We do NOT claim it was stopped, because we have no pid to signal and
     *     `WorkerHandle` does not expose one — inventing that field in four
     *     verified adapters for one cosmetic gain is not worth it.
     */
    cancel(jobId) {
        const known = this.live.has(jobId) || existsSync(jobDir(this.repo, jobId));
        if (!known) {
            throw new Error(`no job "${jobId}" in ${jobsDir(this.repo)}; call list_jobs for valid job IDs.`);
        }
        const headId = this.resolveHead(jobId);
        for (const id of new Set([jobId, headId])) {
            try {
                unlinkSync(jobFile(this.repo, id, FILES.cancelSteer));
            }
            catch { /* no steer marker present */ }
            const live = this.live.get(id);
            const writer = live?.writer ??
                this.newWriter(id);
            writer.requestCancel();
            if (live !== undefined) {
                live.userCanceled = true;
                live.handle?.cancel();
            }
        }
        const resolvedFrom = headId !== jobId ? jobId : null;
        const headLive = this.live.get(headId);
        if (headLive === undefined) {
            return {
                jobId: headId,
                ...(resolvedFrom === null ? {} : { resolvedFrom }),
                requested: true,
                signalled: false,
                note: 'Cancel recorded; no live worker here to signal directly. A live owning supervisor will stop it.',
            };
        }
        return {
            jobId: headId,
            ...(resolvedFrom === null ? {} : { resolvedFrom }),
            requested: true,
            signalled: headLive.handle !== null,
            note: headLive.handle === null
                ? 'Cancel recorded; the continuation has not started yet and will be cancelled before it runs.'
                : 'Canceled.',
        };
    }
    /**
     * Steer a running worker by recording durable intent (`steer.jsonl`) and,
     * when `delivery: 'interrupt'`, signalling the running turn to stop so the
     * pump can open the continuation turn.
     */
    async steer(request) {
        const prompt = request.prompt;
        if (prompt.trim() === '') {
            throw new Error('prompt is empty; there is nothing to hand the worker.');
        }
        if (request.delivery !== 'queue' && request.delivery !== 'interrupt') {
            throw new Error('delivery is required; must be "queue" or "interrupt".');
        }
        const target = await this.resolveSteerTarget(request.worker);
        const latestManifest = this.readManifestSync(target.jobId) ?? target.manifest;
        if (latestManifest.pipeline !== null && latestManifest.pipeline !== undefined) {
            throw new Error(`Cannot steer pipeline stage "${latestManifest.name}" (${target.jobId}); pipeline stages are managed by run_pipeline.`);
        }
        if (latestManifest.status !== 'running') {
            throw new Error(`"${latestManifest.name}" (${target.jobId}) is already ${latestManifest.status}; use resume_job to continue a finished worker.`);
        }
        const live = this.live.get(target.jobId);
        if (live?.userCanceled || existsSync(jobFile(this.repo, target.jobId, FILES.cancel))) {
            throw new Error(`"${latestManifest.name}" (${target.jobId}) is already canceling; use resume_job after it stops.`);
        }
        if (live === undefined) {
            if (!ownerAlive(latestManifest)) {
                reconcileOrphan(this.repo, target.jobId);
                throw new Error(`"${latestManifest.name}" (${target.jobId}) has no live owner process; it cannot be steered. Use resume_job to continue it.`);
            }
        }
        const resumable = (typeof latestManifest.conversation === 'string' && latestManifest.conversation !== '') ||
            (live?.writer.currentConversation() ?? null) !== null;
        const resumableNote = resumable
            ? ''
            : ' No conversation handle is known yet; if none arrives before this turn ends, the continuation starts fresh.';
        const validFiles = request.files !== undefined && request.files.length > 0
            ? validateWatchedFiles(this.repo, request.files)
            : undefined;
        const at = new Date().toISOString();
        const entry = {
            id: `steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: at,
            prompt,
            ...(request.context === undefined ? {} : { context: request.context }),
            ...(validFiles === undefined ? {} : { files: validFiles }),
            delivery: request.delivery,
        };
        appendSteerEntry(this.repo, target.jobId, entry);
        const allEntries = readSteerEntries(this.repo, target.jobId);
        const pendingSteers = Math.max(1, allEntries.length - (live?.consumedSteers ?? 0));
        if (live !== undefined) {
            live.writer.setPendingSteers(pendingSteers, at);
        }
        if (request.delivery === 'interrupt') {
            writeAtomic(jobFile(this.repo, target.jobId, FILES.cancelSteer), `${at}\n`);
            if (live !== undefined) {
                live.interruptRequested = true;
                if (live.handle !== null && live.writer.currentConversation() !== null && !live.interruptFired) {
                    live.interruptFired = true;
                    live.handle.cancel();
                }
            }
        }
        const signalled = Boolean(live?.handle);
        const status = request.delivery === 'interrupt' ? 'interrupting' : 'queued';
        const note = request.delivery === 'interrupt'
            ? live !== undefined
                ? `Interrupting current turn; continuation turn will start automatically.${resumableNote}`
                : `Interrupt recorded for owner process; continuation turn will start after current turn stops.${resumableNote}`
            : `Queued behind current turn (${pendingSteers} pending).${resumableNote}`;
        return {
            jobId: target.jobId,
            name: latestManifest.name ?? target.jobId,
            workerId: latestManifest.workerId ?? target.jobId,
            provider: latestManifest.provider,
            delivery: request.delivery,
            status,
            pendingSteers,
            signalled,
            resumable,
            repo: this.repo,
            dir: jobDir(this.repo, target.jobId),
            timeoutMs: live?.timeoutMs ?? latestManifest.timeoutMs ?? DEFAULT_TIMEOUT_MS$1,
            note,
        };
    }
    readManifestSync(id) {
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
    /**
     * Follow a steered chain to its latest turn.
     *
     * `supersededBy` is authoritative once the parent's terminal manifest lands,
     * but the pump writes the child anchor first. `steer.head` covers that
     * finish window, so a cancel or status arriving between the two resolves to
     * the child instead of the turn that is already exiting.
     */
    resolveHead(jobId) {
        const trimmed = jobId.trim();
        const seen = new Set();
        let curId = trimmed;
        let curManifest = this.readManifestSync(curId);
        if (curManifest === null)
            return trimmed;
        while (!seen.has(curId)) {
            seen.add(curId);
            const nextId = curManifest.supersededBy ?? readSteerHead(this.repo, curId);
            if (nextId === null || nextId === undefined || nextId === '')
                break;
            const nextManifest = this.readManifestSync(nextId);
            if (nextManifest === null)
                break;
            curId = nextId;
            curManifest = nextManifest;
        }
        return curId;
    }
    async resolveSteerTarget(worker) {
        const trimmed = worker.trim();
        if (existsSync(pipelineRecordPath(this.repo, trimmed))) {
            throw new Error(`Cannot steer pipeline run "${trimmed}"; steer_job only applies to solo workers.`);
        }
        const followChain = (startId) => {
            const headId = this.resolveHead(startId);
            const manifest = this.readManifestSync(headId);
            return manifest === null ? null : { jobId: headId, manifest };
        };
        if (this.live.has(trimmed) || existsSync(jobDir(this.repo, trimmed))) {
            const resolved = followChain(trimmed);
            if (resolved !== null)
                return resolved;
        }
        for (const [id, live] of this.live.entries()) {
            const snap = live.writer.snapshot();
            if (snap !== null && snap.name === trimmed && snap.status === 'running') {
                return { jobId: id, manifest: snap };
            }
        }
        const candidates = (await this.list({ limit: 500 })).filter((j) => j.name === trimmed);
        if (candidates.length === 0) {
            throw new Error(`No worker "${trimmed}"; see list_jobs.`);
        }
        const running = candidates.filter((j) => j.status === 'running');
        if (running.length === 1) {
            const resolved = followChain(running[0].jobId);
            if (resolved !== null)
                return resolved;
        }
        if (running.length > 1) {
            throw new Error(`"${trimmed}" matches ${running.length} running workers; pass a job ID from list_jobs.`);
        }
        const identities = new Set(candidates.map((j) => j.workerId));
        if (identities.size !== 1) {
            throw new Error(`"${trimmed}" matches ${identities.size} workers; pass a job ID from list_jobs.`);
        }
        candidates.sort((a, b) => Date.parse(b.startedAt ?? b.updatedAt ?? '') - Date.parse(a.startedAt ?? a.updatedAt ?? ''));
        const latest = followChain(candidates[0].jobId);
        if (latest !== null)
            return latest;
        throw new Error(`No worker "${trimmed}"; see list_jobs.`);
    }
    /**
     * One worker by job id or name, as the detail of its latest turn.
     *
     * An id (any turn of a steered chain) wins; otherwise the name must belong to
     * exactly one worker, and its newest turn is returned. Throws
     * WorkerLookupError when nothing matches or the name is ambiguous.
     */
    async resolveWorker(nameOrId) {
        try {
            return await this.detail(this.resolveHead(nameOrId));
        }
        catch { /* not a job id: try it as a worker name */ }
        const candidates = (await this.list({ limit: 500 })).filter((j) => j.name === nameOrId);
        const identities = new Set(candidates.map((j) => j.workerId));
        if (candidates.length === 0)
            throw new WorkerLookupError(`No worker "${nameOrId}"; see list_jobs.`, 'missing');
        if (identities.size !== 1) {
            throw new WorkerLookupError(`"${nameOrId}" matches ${identities.size} workers; pass a job ID from list_jobs.`, 'ambiguous', candidates.map((j) => j.jobId));
        }
        candidates.sort((a, b) => Date.parse(b.startedAt ?? b.updatedAt ?? '') - Date.parse(a.startedAt ?? a.updatedAt ?? ''));
        return this.detail(this.resolveHead(candidates[0].jobId));
    }
    /** Jobs the pane would draw. Ours by default; interop history on request. */
    async list(filter = {}) {
        for (const id of this.spawnedRuns) {
            for (const stage of Object.values(readPipeline(this.repo, id)?.stageResults ?? {})) {
                if (stage.jobId)
                    this.spawnedIds.add(stage.jobId);
            }
        }
        for (const id of this.spawnedIds)
            this.spawnedIds.add(this.resolveHead(id));
        const source = filter.provider ?? 'agent-smith';
        const out = [];
        if (source === 'agent-smith' || source === 'all') {
            out.push(...(await this.readSource('agent-smith', new AgentSmithReader())));
        }
        if (source === 'agy-staff' || source === 'all') {
            // The interop source. Our own ids are filtered out because the compat
            // mirror makes them visible there too, and one job must have one verdict.
            out.push(...(await this.readSource('agy-staff', new AgyStaffReader(), isForgeJobId)));
        }
        const touched = (j) => Date.parse(j.finishedAt ?? j.updatedAt ?? j.startedAt ?? '');
        const filtered = out.filter((j) => (filter.status === undefined || j.status === filter.status) &&
            (filter.ids === undefined || filter.ids.has(j.jobId)) &&
            (filter.sinceMs === undefined || touched(j) >= filter.sinceMs));
        // Live first, then newest — the same ordering the band draws, so the list a
        // model reads and the list a human sees put the same job on top.
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
    /**
     * One job in full.
     *
     * Reads from DISK, not from the in-memory map, so `status` works for a job this
     * process did not start. The in-memory manifest is only consulted to answer
     * `cancellable`.
     */
    async detail(jobId) {
        reconcileOrphan(this.repo, jobId);
        const observed = await readObservedJob('agent-smith', this.repo, jobId);
        if (observed === null) {
            const interop = await readObservedJob('agy-staff', this.repo, jobId);
            if (interop === null) {
                throw new Error(`no job "${jobId}" in ${jobsDir(this.repo)}; call list_jobs for valid job IDs.`);
            }
            return { ...toSummary(interop, 'agy-staff'), report: interop.output, error: null, exitCode: null, unrestricted: interop.label === 'unrestricted', pipeline: null, stage: null, usage: null, conversation: null, effort: null, cwd: null, cancellable: false };
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
        catch { /* partial state */ }
        const liveStale = manifest?.status === 'running' && manifest.watchedFiles !== undefined
            ? computeStaleReads(this.repo, manifest.cwd, manifest.watchedFiles, this.live.get(jobId)?.writer.editedFiles(Object.keys(manifest.watchedFiles)) ?? manifest.changedFiles)
            : [];
        const staleReads = [...new Set([...(manifest?.staleReads ?? []), ...liveStale])].sort();
        return {
            ...toSummary(observed, 'agent-smith'),
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
    /**
     * The job's recent tool rows, for the pipeline runner's observation tap.
     *
     * LIVE FIRST, disk second. While the job runs this process holds the writer,
     * and asking the writer is exact. Once it is over (or if it was started by
     * another process) we fall back to reading progress.json back through the
     * reader — which is the same file the pane draws from, so the observations
     * routing.ts escalates on are literally the tool calls a human would see.
     */
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
    /**
     * The job's current state, terminal or not.
     *
     * `unknown` is returned AS `unknown`, never coerced to `running`. The runner's
     * poll loop depends on being able to tell "still going" from "cannot tell",
     * and collapsing the second into the first is how an observation series gets
     * silently truncated.
     */
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
    async readSource(provider, reader, skip = () => false) {
        const ids = await reader.discover(this.repo);
        const out = [];
        for (const id of ids) {
            if (skip(id))
                continue;
            if (provider === 'agent-smith')
                reconcileOrphan(this.repo, id);
            const observed = await readObservedJob(provider, this.repo, id);
            if (observed === null)
                continue;
            const summary = toSummary(observed, provider === 'agent-smith' ? 'agent-smith' : 'agy-staff');
            if (provider !== 'agent-smith') {
                out.push(summary);
                continue;
            }
            // Attach acceptance from the sidecar so a list row carries the verdict the
            // caller would otherwise have to poll `status` for once per job. Absent
            // (unchecked, no checks) means nothing to say: the row stays as it was.
            const found = readAcceptance(this.repo, id);
            const acceptance = 'checks' in found ? found : { state: 'unchecked', checks: [] };
            const meaningful = acceptance.state !== 'unchecked' || acceptance.pending === true || acceptance.checks.length > 0;
            out.push(meaningful ? { ...summary, acceptance } : summary);
        }
        return out;
    }
}
function findActiveIdentity(repo, name, workerId) {
    let entries;
    try {
        entries = readdirSync(jobsDir(repo));
    }
    catch {
        return null;
    }
    for (const id of entries) {
        let manifest;
        try {
            manifest = readManifest(repo, id);
        }
        catch {
            continue;
        }
        if (manifest.status !== 'running')
            continue;
        if (manifest.workerId === workerId || manifest.name === name)
            return manifest;
    }
    return null;
}
function describe(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}export{ForgeService as F,MAX_WATCHED_FILES as M,getInstalledProviders as a,getCatalogs as g,launchPipeline as l};