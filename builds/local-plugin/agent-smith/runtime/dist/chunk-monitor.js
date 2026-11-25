import path from'node:path';import {fileURLToPath}from'node:url';import {r as reasonFromText,ab as readJsonSafe,ac as pipelineRecordPath,A as AgentSmithReader,x as normalize,e as readAcceptance,T as normalizeContinuationKind,l as isTerminalForgeStatus,W as WORKERS_DIR,g as isWorkerIdle,O as jobsDir,j as jobDir,a6 as pickHead,ad as workerIndexPath,Q as parseWorkerIndex}from'./chunk-normalize.js';import {a as claudeText,d as droppedMessageQuote,b as pipelineOutcome,A as ACCEPTANCE_HOLD_MS,l as livenessOf,w as waitForChange}from'./chunk-stale.js';function pushKindFor(job) {
    switch (job.status) {
        case 'succeeded':
            return 'finished';
        case 'failed':
            return 'failed';
        case 'canceled':
            return 'cancelled';
        case 'attention':
            return 'attention';
        default:
            return null;
    }
}
function dedupeKey(job) {
    const dead = job.status === 'attention' && job.liveness?.state === 'dead' ? '#dead' : '';
    return `${job.id}#${job.status}${dead}${job.checksRunning === undefined ? '' : '#checks'}`;
}
function shouldPush(candidate) {
    const { job, seen } = candidate;
    if (job.supersededBy || job.followedBy || job.acceptancePending)
        return false;
    const kind = pushKindFor(job);
    if (kind === null)
        return false;
    if (seen.has(dedupeKey(job)))
        return false;
    if (kind === 'finished' || kind === 'failed' || kind === 'cancelled') {
        if (job.finishedAt === null)
            return false;
    }
    if (kind === 'attention') {
        if (!candidate.observedInPriorPoll)
            return false;
        if (job.lastEventAt === null && job.liveness?.state !== 'dead')
            return false;
    }
    return true;
}
function buildBatch(candidates, now) {
    const pushable = candidates.filter(shouldPush);
    if (pushable.length === 0) {
        return { content: null, keys: [] };
    }
    const keys = pushable.map((c) => dedupeKey(c.job));
    const content = claudeText(pushable.map((c) => toNotice(c.job, pushKindFor(c.job), now)));
    return { content, keys };
}
function toNotice(job, kind, now) {
    const run = job.role === 'pipeline' && job.outcome !== undefined;
    const dead = kind === 'attention' && job.liveness?.state === 'dead';
    const start = job.chainStartedAt ?? job.startedAt;
    const span = dead
        ? (job.liveness?.since == null ? NaN : now - job.liveness.since)
        : kind === 'attention'
            ? (job.lastEventAt === null ? NaN : now - Date.parse(job.lastEventAt))
            : (start && job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(start) : NaN);
    return {
        id: job.id, kind, name: job.name ?? null, provider: job.provider ?? null, role: job.role ?? null,
        run,
        durationMs: Number.isFinite(span) ? span : null,
        changedFiles: job.changedFileCount ?? null,
        checks: job.checks ?? null,
        reason: run ? job.outcome : kind === 'failed' ? job.failureDetail || reasonFromText(job.failureReason) : null,
        summary: job.summarySource === 'worker' ? job.latestSummary ?? null : null,
        ...(job.staleReads && job.staleReads.length > 0 ? { staleReads: job.staleReads } : {}),
        ...(job.continuationKind ? { continuationKind: job.continuationKind } : {}),
        ...(job.steerNotApplied ? { steerNotApplied: true } : {}),
        ...(job.droppedMessage ? { droppedMessage: job.droppedMessage } : {}),
        ...(job.alsoRan ? { alsoRan: job.alsoRan } : {}),
        ...(kind === 'finished' && job.checksRunning !== undefined ? { checksRunning: job.checksRunning } : {}),
        ...(kind === 'attention' && job.liveness ? { liveness: { state: job.liveness.state, ...(job.liveness.tool ? { tool: job.liveness.tool } : {}) } } : {}),
    };
}const reader = new AgentSmithReader();
function isAcceptancePending(finishedAt, placeholder, now) {
    if (finishedAt === null || placeholder.pending !== true)
        return false;
    const finished = Date.parse(finishedAt);
    const budget = typeof placeholder.budgetMs === 'number' && placeholder.budgetMs > 0 ? placeholder.budgetMs : ACCEPTANCE_HOLD_MS;
    return !(Number.isFinite(finished) && now - finished > budget);
}
function pipelineToWatchable(run) {
    if (!run || typeof run.runId !== 'string' || typeof run.pipeline !== 'string' ||
        !Number.isFinite(run.startedAt) || (run.finishedAt !== null && !Number.isFinite(run.finishedAt)) ||
        !['running', 'passed', 'partial', 'failed'].includes(run.status) ||
        run.stageResults === null || typeof run.stageResults !== 'object')
        return null;
    return {
        id: run.runId, name: run.pipeline, role: 'pipeline',
        status: run.status === 'running' ? 'running' : run.status === 'passed' ? 'succeeded' : 'failed',
        startedAt: new Date(run.startedAt).toISOString(),
        lastEventAt: new Date(run.startedAt).toISOString(),
        finishedAt: run.finishedAt === null ? null : new Date(run.finishedAt).toISOString(),
        warned: run.status !== 'passed' && run.status !== 'running',
        outcome: run.status === 'running' ? undefined : pipelineOutcome(run),
    };
}
async function readPipelineRecord(cwd, runId) {
    const run = await readJsonSafe(pipelineRecordPath(cwd, runId));
    const job = pipelineToWatchable(run);
    if (job === null || run === null)
        return null;
    const stageJobIds = Object.values(run.stageResults).flatMap(s => (s && typeof s.jobId === 'string' ? [s.jobId] : []));
    return { job, stageJobIds };
}
async function readJob(cwd, jobId, now = Date.now()) {
    return readOne(cwd, jobId, now);
}
async function readOne(cwd, jobId, now) {
    let observed;
    try {
        const raw = await reader.read(cwd, jobId);
        if (raw === null)
            return null;
        observed = normalize(raw);
    }
    catch {
        return null;
    }
    const warned = observed.warnings.length > 0;
    const raw = observed.raw;
    const acceptance = readAcceptance(cwd, observed.jobId);
    const checks = Array.isArray(acceptance.checks) && acceptance.checks.length > 0
        ? {
            passed: acceptance.checks.filter((c) => c?.ok === true).length, total: acceptance.checks.length,
            failed: acceptance.checks.flatMap((c) => (c?.ok !== true && typeof c?.name === 'string' ? [c.name] : [])),
        } : null;
    const continuedFrom = typeof raw['continuedFrom'] === 'string' && raw['continuedFrom'] !== '' ? raw['continuedFrom'] : null;
    const continuationKind = normalizeContinuationKind(raw['continuationKind']) ?? (continuedFrom !== null ? 'follow-up' : null);
    const dropped = observed.warnings.find((w) => w.code === 'steer_not_applied');
    const droppedMessage = dropped ? droppedMessageQuote(dropped.message) : null;
    const pending = raw['pendingSteers'];
    const status = toWatchStatus(observed, now);
    const acceptancePending = isTerminalForgeStatus(status) && isAcceptancePending(observed.finishedAt, acceptance, now);
    return {
        id: observed.jobId,
        workerId: typeof raw['workerId'] === 'string' && raw['workerId'] !== '' ? raw['workerId'] : observed.jobId,
        name: typeof observed.raw['name'] === 'string' ? observed.raw['name'] : undefined,
        turn: typeof raw['turn'] === 'number' && Number.isInteger(raw['turn']) && raw['turn'] >= 1 ? raw['turn'] : 1,
        role: typeof observed.raw['role'] === 'string' ? observed.raw['role'] : observed.mode ?? undefined,
        provider: typeof observed.raw['provider'] === 'string' ? observed.raw['provider'] : undefined,
        startedAt: observed.startedAt,
        chainStartedAt: typeof raw['chainStartedAt'] === 'string' && raw['chainStartedAt'] !== '' ? raw['chainStartedAt'] : observed.startedAt,
        changedFileCount: Array.isArray(observed.raw['changed_files']) ? observed.raw['changed_files'].length : undefined,
        latestSummary: typeof raw['latestSummary'] === 'string' ? raw['latestSummary'] : null,
        failureReason: [raw['reason'], raw['error']].find((v) => typeof v === 'string' && v !== '') ?? null,
        failureDetail: typeof raw['error'] === 'string' ? raw['error'] : null,
        checks,
        ...(observed.status === 'succeeded' && acceptance.pending === true
            ? { checksRunning: typeof acceptance.running === 'string' && acceptance.running !== '' ? acceptance.running : true } : {}),
        ...(acceptancePending ? { acceptancePending: true } : {}),
        summarySource: observed.raw['summarySource'] === 'worker' ? 'worker' : null,
        status,
        ...livenessField(watchLiveness(observed, now)),
        lastEventAt: observed.updatedAt,
        finishedAt: observed.finishedAt,
        warned,
        supersededBy: typeof raw['supersededBy'] === 'string' && raw['supersededBy'] !== '' ? raw['supersededBy'] : null,
        followedBy: typeof raw['followedBy'] === 'string' && raw['followedBy'] !== '' ? raw['followedBy'] : null,
        ...(typeof pending === 'number' && Number.isFinite(pending) && pending > 0 ? { pendingMessages: pending } : {}),
        continuedFrom,
        continuationKind,
        ...(dropped ? { steerNotApplied: true } : {}),
        ...(droppedMessage ? { droppedMessage } : {}),
        ...(Array.isArray(raw['staleReads']) && raw['staleReads'].length > 0
            ? { staleReads: raw['staleReads'].filter((f) => typeof f === 'string' && f.trim() !== '') }
            : {}),
    };
}
function watchLiveness(observed, now) {
    const raw = observed.raw;
    const activity = raw['last_activity'];
    return livenessOf({
        status: observed.status, updatedAt: observed.updatedAt, now,
        lastEventAt: typeof raw['last_event_at'] === 'string' ? raw['last_event_at'] : null,
        lastAliveAt: typeof raw['last_alive_at'] === 'string' ? raw['last_alive_at'] : null,
        lastActivity: activity !== null && typeof activity === 'object' ? activity : null,
    });
}
function livenessField(l) {
    if (l === null || (l.state !== 'silent' && l.state !== 'dead'))
        return {};
    return { liveness: { state: l.state, silentForMs: l.silentForMs, since: l.since, ...(l.tool ? { tool: l.tool } : {}) } };
}
function toWatchStatus(observed, now) {
    if (observed.status !== 'running')
        return observed.status;
    const live = watchLiveness(observed, now);
    return live !== null && (live.state === 'silent' || live.state === 'dead') ? 'attention' : 'running';
}function safeJobDir(cwd, id) {
    try {
        return jobDir(cwd, id);
    }
    catch {
        return jobsDir(cwd);
    }
}
async function waitForAnyChange(dirs, fallbackDir, timeoutMs, opts) {
    if (opts.signal?.aborted || !(timeoutMs > 0))
        return;
    const unique = [...new Set(dirs)];
    if (unique.length === 0) {
        await waitForChange(fallbackDir, timeoutMs, opts);
        return;
    }
    if (unique.length === 1) {
        await waitForChange(unique[0], timeoutMs, opts);
        return;
    }
    const slice = new AbortController();
    const onAbort = () => slice.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
        await Promise.race(unique.map((dir) => waitForChange(dir, timeoutMs, { signal: slice.signal, fallbackMs: opts.fallbackMs })));
    }
    finally {
        slice.abort();
        opts.signal?.removeEventListener('abort', onAbort);
    }
}
async function emitStdout(line) {
    if (process.stdout.write(`${line}\n`))
        return;
    await new Promise((resolve, reject) => {
        const cleanup = () => {
            process.stdout.off('drain', onDrain);
            process.stdout.off('error', onError);
        };
        const onDrain = () => { cleanup(); resolve(); };
        const onError = (error) => { cleanup(); reject(error); };
        process.stdout.once('drain', onDrain);
        process.stdout.once('error', onError);
    });
}
const DEFAULT_WATCH_TIMEOUT_MS = 45 * 60_000 + 60_000;
const WATCH_RECHECK_MS = 5_000;
const WATCH_FALLBACK_MS = 500;
function watchTurn(job) {
    return {
        jobId: job.id, status: job.status, turn: job.turn, supersededBy: job.supersededBy, followedBy: job.followedBy,
        startedAt: job.startedAt, acceptancePending: job.acceptancePending, pendingMessages: job.pendingMessages,
    };
}
async function readWorkerIndex(cwd, workerId) {
    let file;
    try {
        file = workerIndexPath(cwd, workerId);
    }
    catch {
        return null;
    }
    return parseWorkerIndex(await readJsonSafe(file));
}
const MAX_TURNS_READ = 64;
async function followWorkerHead(cwd, rootId, root, now, readJobFn, readIndexFn) {
    const rows = new Map([[root.id, root]]);
    const index = root.workerId ? await readIndexFn(cwd, root.workerId) : null;
    const at = index ? index.turns.indexOf(rootId) : -1;
    for (const id of at >= 0 ? index.turns.slice(at + 1) : []) {
        if (rows.size >= MAX_TURNS_READ)
            break;
        const row = await readJobFn(cwd, id, now);
        if (row)
            rows.set(row.id, row);
    }
    let head = pickHead([...rows.values()].map((r) => ({ ...watchTurn(r), row: r }))).row;
    let missingNextId = null;
    for (let next = head.supersededBy ?? head.followedBy; next && !rows.has(next) && rows.size < MAX_TURNS_READ; next = head.supersededBy ?? head.followedBy) {
        const row = await readJobFn(cwd, next, now);
        if (!row) {
            missingNextId = next;
            break;
        }
        rows.set(row.id, row);
        head = pickHead([...rows.values()].map((r) => ({ ...watchTurn(r), row: r }))).row;
    }
    return { head, missingNextId };
}
async function runJobWatch(options) {
    const recheckMs = Math.max(50, options.intervalMs ?? WATCH_RECHECK_MS);
    const fallbackMs = Math.max(50, options.intervalMs ?? WATCH_FALLBACK_MS);
    const timeoutMs = options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS;
    const now = options.now ?? Date.now;
    const rj = options.readJob ?? readJob;
    const rr = options.readRun ?? readPipelineRecord;
    const ri = options.readIndex ?? readWorkerIndex;
    const emit = options.emit ?? emitStdout;
    const onError = options.onError ?? ((error) => { process.stderr.write(`agent-smith monitor: ${String(error)}\n`); });
    const workers = [...new Set(options.jobIds ?? [])].map((root) => ({ root, rootTurn: null, head: null }));
    const runIds = [...new Set(options.runIds ?? [])];
    const seen = new Map();
    const done = new Set();
    let startedAt = now();
    while (!options.signal?.aborted) {
        const watchDirs = [];
        try {
            const t = now();
            const candidates = [];
            const finals = new Map();
            for (const w of workers) {
                if (done.has(w.root))
                    continue;
                const root = await rj(options.cwd, w.root, t);
                if (!root) {
                    watchDirs.push(safeJobDir(options.cwd, w.root));
                    continue;
                }
                w.rootTurn ??= root.turn ?? 1;
                const { head, missingNextId } = await followWorkerHead(options.cwd, w.root, root, t, rj, ri);
                if (missingNextId !== null)
                    watchDirs.push(safeJobDir(options.cwd, missingNextId));
                if (w.head !== null && w.head !== head.id)
                    startedAt = t;
                w.head = head.id;
                if (root.workerId)
                    watchDirs.push(path.join(options.cwd, WORKERS_DIR));
                watchDirs.push(safeJobDir(options.cwd, head.id));
                const turn = head.turn ?? 1;
                const announced = w.rootTurn !== null && turn > w.rootTurn ? { ...head, alsoRan: { from: w.rootTurn, to: turn - 1 } } : head;
                if (head.status === 'attention' || isWorkerIdle(watchTurn(head))) {
                    candidates.push(announced);
                    if (isWorkerIdle(watchTurn(head)))
                        finals.set(w.root, announced);
                }
            }
            for (const id of runIds) {
                if (done.has(id))
                    continue;
                const rec = await rr(options.cwd, id);
                if (!rec) {
                    watchDirs.push(path.dirname(pipelineRecordPath(options.cwd, id)));
                    continue;
                }
                candidates.push(rec.job);
                finals.set(id, rec.job);
                watchDirs.push(path.dirname(pipelineRecordPath(options.cwd, id)));
                for (const sid of rec.stageJobIds) {
                    watchDirs.push(safeJobDir(options.cwd, sid));
                    const sj = await rj(options.cwd, sid, t);
                    if (sj && !(options.announceOnce === true && sj.checksRunning !== undefined))
                        candidates.push(sj);
                }
            }
            const unique = [...new Map(candidates.map((job) => [job.id, job])).values()];
            const batch = buildBatch(unique.map((job) => ({ job, seen: seen.get(job.id) ?? new Set(), observedInPriorPoll: true })), t);
            if (batch.content !== null) {
                await emit(batch.content.replace(/\s+/g, ' ').trim(), batch);
                for (const key of batch.keys) {
                    const id = key.slice(0, key.indexOf('#'));
                    const set = seen.get(id);
                    if (set)
                        set.add(key);
                    else
                        seen.set(id, new Set([key]));
                }
            }
            for (const [id, job] of finals) {
                if (isTerminalForgeStatus(job.status) && !job.acceptancePending && (options.announceOnce === true || job.checksRunning === undefined) &&
                    (seen.get(job.id)?.has(dedupeKey(job)) ?? false))
                    done.add(id);
            }
            const all = [...workers.map((w) => w.root), ...runIds];
            if (all.length > 0 && all.every((id) => done.has(id)))
                return 'done';
        }
        catch (error) {
            onError(error);
        }
        const elapsed = now() - startedAt;
        if (elapsed >= timeoutMs) {
            const ids = [...workers.filter((w) => !done.has(w.root)).map((w) => w.head ?? w.root), ...runIds.filter((id) => !done.has(id))];
            try {
                await emit(`Agent Smith · still running: ${ids.join(', ')}`, null);
            }
            catch (error) {
                onError(error);
            }
            return 'timeout';
        }
        await waitForAnyChange(watchDirs, jobsDir(options.cwd), Math.min(recheckMs, Math.max(1, timeoutMs - elapsed)), { signal: options.signal, fallbackMs });
    }
    return 'aborted';
}
function parseArgs(argv) {
    const out = { cwd: null, jobIds: [], runIds: [], exitCode: 0, timeoutMs: DEFAULT_WATCH_TIMEOUT_MS };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const v = argv[i + 1];
        if (a === '--job' && v) {
            out.jobIds.push(v);
            i++;
        }
        else if (a === '--run' && v) {
            out.runIds.push(v);
            i++;
        }
        else if (a === '--cwd' && v) {
            out.cwd = path.resolve(v);
            i++;
        }
        else if (a === '--exit-code' && v && Number.isInteger(Number(v))) {
            out.exitCode = Number(v);
            i++;
        }
        else if (a === '--timeout-ms' && v && Number(v) > 0) {
            out.timeoutMs = Number(v);
            i++;
        }
        else if (!a.startsWith('--') && out.cwd === null && i === 0)
            out.cwd = path.resolve(a);
    }
    if (out.cwd === null)
        out.cwd = process.cwd();
    return out;
}
function isEntrypoint() {
    const invoked = process.argv[1];
    return invoked !== undefined && path.resolve(invoked) === fileURLToPath(import.meta.url);
}
async function startCliMonitor() {
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    process.once('SIGTERM', () => controller.abort());
    const args = parseArgs(process.argv.slice(2));
    if (args.jobIds.length > 0 || args.runIds.length > 0) {
        await runJobWatch({ cwd: args.cwd, jobIds: args.jobIds, runIds: args.runIds, timeoutMs: args.timeoutMs, signal: controller.signal });
        process.exitCode = args.exitCode;
    }
}
if (isEntrypoint())
    await startCliMonitor();export{runJobWatch as r,startCliMonitor as s};