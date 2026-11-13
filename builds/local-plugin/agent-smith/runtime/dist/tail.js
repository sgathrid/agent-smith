#!/usr/bin/env node
import {openSync,fstatSync,readSync,closeSync,watch}from'node:fs';import path from'node:path';import {fileURLToPath}from'node:url';import {j as jobDir,d as readManifest,o as ownerAlive,i as isTerminalForgeStatus,b as jobFile,F as FILES,u as classify,a as readAcceptance,v as oneLine}from'./chunk-checks.js';import {r as reconcileOrphan,d as readSteerHead}from'./chunk-steer-log.js';import {A as ACCEPTANCE_HOLD_MS}from'./chunk-notice.js';import'node:child_process';import'node:crypto';/**
 * tail.ts — live NDJSON step streamer for an agent-smith worker job.
 *
 * Watches a job directory, drains events.jsonl from a byte offset without
 * splitting UTF-8 or partial lines, reduces ProviderEvents into compact step
 * records, follows steer continuations, waits for non-pending acceptance, and
 * reconciles orphaned workers via an inactivity dead-man switch.
 */
const DEFAULT_DEADMAN_MS = 35_000;
const FALLBACK_POLL_MS = 500;
const MAX_ASSISTANT_CHARS = 160;
/**
 * Decode complete `\n`-terminated UTF-8 lines from `buf`, returning only up to
 * the last `0x0a` byte so partial lines and split multi-byte UTF-8 sequences
 * are never emitted.
 */
function splitCompleteLines(buf) {
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline === -1)
        return { lines: [], consumedBytes: 0 };
    const text = buf.subarray(0, lastNewline).toString('utf8');
    const lines = text.split('\n').filter((line) => line.length > 0);
    return { lines, consumedBytes: lastNewline + 1 };
}
function formatAssistantText(raw) {
    const collapsed = oneLine(raw, MAX_ASSISTANT_CHARS + 1);
    if (collapsed.length === 0)
        return '';
    if (collapsed.length <= MAX_ASSISTANT_CHARS)
        return collapsed;
    return `${oneLine(collapsed, MAX_ASSISTANT_CHARS - 1)}…`;
}
function capitalizeFirst(text) {
    if (text.length === 0)
        return text;
    return text.charAt(0).toUpperCase() + text.slice(1);
}
/**
 * Pure reducer from normalized ProviderEvent records to compact step records.
 * Caches tool input by stepIndex across activity-start / activity-update for
 * activity-end, and concatenates delta assistant text until the next boundary.
 */
class EventReducer {
    inputsByStep = new Map();
    textBuffer = '';
    push(event) {
        switch (event.kind) {
            case 'started':
            case 'usage':
            case 'notice':
            case 'heartbeat':
                return [];
            case 'activity-start': {
                const flushed = this.flush();
                if (typeof event.activity.input === 'string' && event.activity.input !== '') {
                    this.inputsByStep.set(event.activity.stepIndex, event.activity.input);
                }
                return flushed;
            }
            case 'activity-update': {
                if (typeof event.activity.input === 'string' && event.activity.input !== '') {
                    this.inputsByStep.set(event.activity.stepIndex, event.activity.input);
                }
                return [];
            }
            case 'activity-end': {
                const cached = this.inputsByStep.get(event.activity.stepIndex);
                this.inputsByStep.delete(event.activity.stepIndex);
                const input = (typeof event.activity.input === 'string' && event.activity.input !== '')
                    ? event.activity.input
                    : cached;
                const label = classify(event.activity.tool, input).label;
                const formatted = capitalizeFirst(label || event.activity.tool);
                const text = event.status === 'error' ? `✗ ${formatted}` : formatted;
                return [{ kind: 'step', text }];
            }
            case 'text': {
                if (event.stream !== 'assistant')
                    return [];
                if (event.delta === true) {
                    this.textBuffer += event.text;
                    return [];
                }
                // Held, not emitted: the worker's last message is its report, which the hand-back
                // carries. A message followed by more work is emitted at the next activity.
                const out = this.flush();
                this.textBuffer = event.text;
                return out;
            }
        }
    }
    /** Flush any buffered delta assistant text as one step record. */
    flush() {
        if (this.textBuffer === '')
            return [];
        const text = formatAssistantText(this.textBuffer);
        this.textBuffer = '';
        return text === '' ? [] : [{ kind: 'step', text }];
    }
    /** Reset state when switching to a steer continuation job. */
    reset() {
        this.inputsByStep.clear();
        this.textBuffer = '';
    }
}
function readNewEventBytes(eventsPath, offset) {
    let fd;
    try {
        fd = openSync(eventsPath, 'r');
        const size = fstatSync(fd).size;
        if (size <= offset)
            return Buffer.alloc(0);
        const len = size - offset;
        const buf = Buffer.allocUnsafe(len);
        let totalRead = 0;
        while (totalRead < len) {
            const n = readSync(fd, buf, totalRead, len - totalRead, offset + totalRead);
            if (n === 0)
                break;
            totalRead += n;
        }
        return totalRead === len ? buf : buf.subarray(0, totalRead);
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return Buffer.alloc(0);
        throw err;
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch { /* ignore */ }
        }
    }
}
function acceptancePending(repo, jobId, finishedAt, now) {
    if (finishedAt === null)
        return false;
    const finished = Date.parse(finishedAt);
    const placeholder = readAcceptance(repo, jobId);
    if (placeholder.pending !== true)
        return false;
    const budget = typeof placeholder.budgetMs === 'number' && placeholder.budgetMs > 0
        ? placeholder.budgetMs
        : ACCEPTANCE_HOLD_MS;
    return !(Number.isFinite(finished) && now - finished > budget);
}
function nextSteerJobId(repo, jobId, manifest) {
    if (typeof manifest.supersededBy === 'string' && manifest.supersededBy.length > 0) {
        return manifest.supersededBy;
    }
    return readSteerHead(repo, jobId);
}
/**
 * Stream reduced steps for `job` in `repo` until it (or its steer chain)
 * settles, writing NDJSON records to `out`.
 */
async function runTail(options) {
    const { job, repo, out, watchFn = (dir, listener) => watch(dir, listener), deadmanMs = DEFAULT_DEADMAN_MS, signal, now = Date.now, } = options;
    if (signal?.aborted)
        return;
    const emit = (record) => {
        out(JSON.stringify(record));
    };
    let currentJobId = job;
    let currentDir = jobDir(repo, currentJobId);
    let offset = 0;
    const reducer = new EventReducer();
    const seen = new Set([currentJobId]);
    let watcher = null;
    let fallbackTimer = null;
    let deadmanTimer = null;
    let done = false;
    let drainInFlight = false;
    let dirty = false;
    const stopWatch = () => {
        if (watcher !== null) {
            try {
                watcher.close();
            }
            catch { /* ignore */ }
            watcher = null;
        }
    };
    const stopFallback = () => {
        if (fallbackTimer !== null) {
            clearInterval(fallbackTimer);
            fallbackTimer = null;
        }
    };
    const stopDeadman = () => {
        if (deadmanTimer !== null) {
            clearTimeout(deadmanTimer);
            deadmanTimer = null;
        }
    };
    const cleanup = () => {
        done = true;
        stopWatch();
        stopFallback();
        stopDeadman();
    };
    const drainEvents = () => {
        const eventsPath = jobFile(repo, currentJobId, FILES.events);
        const buf = readNewEventBytes(eventsPath, offset);
        if (buf.length === 0)
            return;
        const { lines, consumedBytes } = splitCompleteLines(buf);
        if (consumedBytes === 0)
            return;
        offset += consumedBytes;
        for (const line of lines) {
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (parsed === null || typeof parsed !== 'object' || typeof parsed.kind !== 'string') {
                continue;
            }
            for (const rec of reducer.push(parsed)) {
                emit(rec);
            }
        }
    };
    const flushReducer = () => {
        for (const rec of reducer.flush()) {
            emit(rec);
        }
    };
    return await new Promise((resolve, reject) => {
        const finish = (err) => {
            if (done)
                return;
            cleanup();
            signal?.removeEventListener('abort', onAbort);
            if (err !== undefined)
                reject(err);
            else
                resolve();
        };
        const onAbort = () => {
            finish();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        const armDeadman = () => {
            stopDeadman();
            if (done || deadmanMs <= 0)
                return;
            deadmanTimer = setTimeout(() => {
                if (done)
                    return;
                try {
                    const manifest = readManifest(repo, currentJobId);
                    if (!ownerAlive(manifest)) {
                        reconcileOrphan(repo, currentJobId, now());
                    }
                    scheduleDrain();
                    if (!done)
                        armDeadman();
                }
                catch (err) {
                    finish(err);
                }
            }, deadmanMs);
            deadmanTimer.unref?.();
        };
        const startFallback = () => {
            if (done || fallbackTimer !== null)
                return;
            fallbackTimer = setInterval(() => {
                if (!done)
                    scheduleDrain();
            }, FALLBACK_POLL_MS);
        };
        const startWatch = (dir) => {
            stopWatch();
            stopFallback();
            try {
                const w = watchFn(dir, () => {
                    if (done)
                        return;
                    armDeadman();
                    scheduleDrain();
                });
                watcher = w;
                w.on('error', () => {
                    if (done)
                        return;
                    stopWatch();
                    startFallback();
                });
            }
            catch {
                startFallback();
            }
        };
        const drainOnce = () => {
            if (done)
                return;
            drainEvents();
            const manifest = readManifest(repo, currentJobId);
            // Steer handoff MUST be checked before terminal or acceptance.
            const nextId = nextSteerJobId(repo, currentJobId, manifest);
            if (nextId !== null && !seen.has(nextId)) {
                seen.add(nextId);
                // Final drain of the parent before switching to the child.
                drainEvents();
                flushReducer();
                currentJobId = nextId;
                currentDir = jobDir(repo, currentJobId);
                offset = 0;
                reducer.reset();
                startWatch(currentDir);
                emit({ kind: 'job', jobId: currentJobId });
                dirty = true;
                return;
            }
            if (isTerminalForgeStatus(manifest.status) && !acceptancePending(repo, currentJobId, manifest.finishedAt, now())) {
                // Final drain before emitting settled. Buffered assistant text is the report: dropped here.
                drainEvents();
                reducer.reset();
                emit({ kind: 'settled', jobId: currentJobId, status: manifest.status });
                finish();
            }
        };
        const scheduleDrain = () => {
            if (done)
                return;
            if (drainInFlight) {
                dirty = true;
                return;
            }
            drainInFlight = true;
            try {
                do {
                    dirty = false;
                    drainOnce();
                } while (dirty && !done);
            }
            catch (err) {
                finish(err);
            }
            finally {
                drainInFlight = false;
            }
        };
        // 1. Watch the job directory first (never the file itself), arm dead-man,
        //    then perform the immediate initial drain.
        startWatch(currentDir);
        armDeadman();
        scheduleDrain();
    });
}
function parseTailArgs(argv) {
    let job = null;
    let repo = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const val = argv[i + 1];
        if (arg === '--job' && val !== undefined) {
            job = val;
            i++;
        }
        else if (arg === '--repo' && val !== undefined) {
            repo = path.resolve(val);
            i++;
        }
    }
    return { job, repo };
}
let cliStarted = false;
async function startCliTail(argv = process.argv.slice(2)) {
    if (cliStarted)
        return;
    cliStarted = true;
    const { job, repo } = parseTailArgs(argv);
    if (!job || !repo) {
        process.stderr.write('Usage: tail --job <jobId> --repo <absolute repo>\n');
        process.exitCode = 1;
        return;
    }
    const controller = new AbortController();
    const onSignal = () => controller.abort();
    // The reader went away (the hook left its loop, or a stop killed it): stop quietly. The
    // handler stays installed, since writes already queued can fail after runTail returns.
    const onStdoutError = (err) => {
        if (err.code === 'EPIPE') {
            controller.abort();
            process.exitCode = 0;
        }
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    process.stdout.on('error', onStdoutError);
    try {
        await runTail({
            job,
            repo,
            out: (line) => {
                process.stdout.write(`${line}\n`);
            },
            signal: controller.signal,
        });
    }
    catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
    }
    finally {
        process.removeListener('SIGTERM', onSignal);
        process.removeListener('SIGINT', onSignal);
    }
}
function isEntrypoint() {
    const invoked = process.argv[1];
    return invoked !== undefined && path.resolve(invoked) === fileURLToPath(import.meta.url);
}
if (isEntrypoint()) {
    await startCliTail();
}// Generated by scripts/stamp-entrypoint.mjs — do not edit.
await startCliTail();