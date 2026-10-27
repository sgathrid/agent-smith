import path from'node:path';import {fileURLToPath}from'node:url';import {g as isTerminalForgeStatus}from'./chunk-execute.js';import {r as readJob,b as readPipelineRecord,d as buildBatch,e as dedupeKey,f as resetPoller,p as pollOnce,g as readAll}from'./chunk-poller.js';/**
 * Native Claude monitor entrypoint.
 *
 * This process is deliberately separate from the MCP server: Claude Code can
 * launch it as a repo-local monitor and consume one human-readable line per
 * milestone from stdout. It uses the same filesystem reader and poller as the
 * channel, so startup baselining, status rules, and deduplication stay identical.
 * Routine running/progress polls produce no stdout.
 */
function delay(ms, signal) {
    if (signal?.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
    });
}
/**
 * Monitor until aborted. Each send is one deduplicated policy batch; progress
 * is suppressed by policy and no startup backlog is emitted.
 */
async function runMonitor(options) {
    const intervalMs = Math.max(100, options.intervalMs ?? 5_000);
    const now = options.now ?? Date.now;
    const read = options.read ?? readAll;
    const emit = options.emit ?? emitStdout;
    const onError = options.onError ?? ((error) => {
        process.stderr.write(`agent-smith monitor: ${String(error)}\n`);
    });
    // A monitor is a fresh observer. Existing jobs become the silent baseline;
    // only transitions seen after this point can reach Claude.
    resetPoller();
    while (!options.signal?.aborted) {
        try {
            await pollOnce(options.cwd, now(), async (batch) => {
                if (batch.content === null)
                    return;
                // One stdout line per milestone; the notice already names Agent Smith.
                const line = batch.content.replace(/\s+/g, ' ').trim();
                await emit(line, batch);
            }, read);
        }
        catch (error) {
            // A transient output or poll failure must not prevent the next observation.
            onError(error);
        }
        if (options.signal?.aborted)
            break;
        await delay(intervalMs, options.signal);
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
/**
 * Watch specific jobs/runs until each is terminal. Unlike the full-scan monitor
 * there is NO silent baseline: a job that already finished before the watcher
 * started is reported on the first observation.
 */
async function runJobWatch(options) {
    const intervalMs = Math.max(50, options.intervalMs ?? 2_000);
    const timeoutMs = options.timeoutMs ?? DEFAULT_WATCH_TIMEOUT_MS;
    const now = options.now ?? Date.now;
    const rj = options.readJob ?? readJob;
    const rr = options.readRun ?? readPipelineRecord;
    const emit = options.emit ?? emitStdout;
    const onError = options.onError ?? ((error) => { process.stderr.write(`agent-smith monitor: ${String(error)}\n`); });
    const jobIds = [...new Set(options.jobIds ?? [])];
    const runIds = [...new Set(options.runIds ?? [])];
    const seen = new Map();
    const done = new Set();
    let startedAt = now();
    while (!options.signal?.aborted) {
        try {
            const t = now();
            const jobs = new Map();
            const want = new Set(jobIds);
            for (let i = 0; i < jobIds.length; i++) {
                const id = jobIds[i];
                const job = await rj(options.cwd, id, t);
                if (!job)
                    continue;
                jobs.set(job.id, job);
                if (job.supersededBy && job.supersededBy !== job.id) {
                    if (jobIds.includes(job.supersededBy)) {
                        done.add(job.id);
                    }
                    else {
                        const childJob = await rj(options.cwd, job.supersededBy, t);
                        if (childJob) {
                            done.add(job.id);
                            jobIds.push(job.supersededBy);
                            want.add(job.supersededBy);
                            startedAt = t;
                        }
                    }
                }
            }
            for (const id of runIds) {
                const rec = await rr(options.cwd, id);
                if (!rec)
                    continue;
                jobs.set(rec.job.id, rec.job);
                want.add(rec.job.id);
                for (const sid of rec.stageJobIds) {
                    if (jobs.has(sid))
                        continue;
                    const sj = await rj(options.cwd, sid, t);
                    if (sj)
                        jobs.set(sj.id, sj);
                }
            }
            const batch = buildBatch([...jobs.values()].map((job) => ({ job, seen: seen.get(job.id) ?? new Set(), knownBefore: true })), t);
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
            for (const id of want) {
                const job = jobs.get(id);
                if (job?.supersededBy) {
                    if (want.has(job.supersededBy))
                        done.add(id);
                    continue;
                }
                if (job && isTerminalForgeStatus(job.status) && (seen.get(id)?.has(dedupeKey(job)) ?? false))
                    done.add(id);
            }
            if (want.size > 0 && [...want].every((id) => done.has(id)))
                return 'done';
        }
        catch (error) {
            onError(error);
        }
        if (now() - startedAt >= timeoutMs) {
            const ids = [...jobIds, ...runIds].filter((id) => !done.has(id));
            try {
                await emit(`Agent Smith · still running: ${ids.join(', ')}`, null);
            }
            catch (error) {
                onError(error);
            }
            return 'timeout';
        }
        await delay(intervalMs, options.signal);
    }
    return 'aborted';
}
function parseArgs(argv, env = process.env) {
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
    if (out.cwd === null) {
        const e = env['AGY_WATCH_CWD'];
        out.cwd = typeof e === 'string' && e.length > 0 ? path.resolve(e) : process.cwd();
    }
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
        return;
    }
    await runMonitor({ cwd: args.cwd, signal: controller.signal });
}
if (isEntrypoint())
    await startCliMonitor();export{runJobWatch as r,startCliMonitor as s};