import path from'node:path';import {fileURLToPath}from'node:url';import {r as reasonFromText,a as readAcceptance,i as isTerminalForgeStatus}from'./chunk-checks.js';import {a as claudeText,A as ACCEPTANCE_HOLD_MS,b as pipelineOutcome}from'./chunk-notice.js';import {k as readJsonSafe,d as pipelineRecordPath,A as AgentSmithReader,n as normalize}from'./chunk-execute.js';import {l as livenessOf,i as isStalled}from'./chunk-stale.js';/**
 * policy.ts — when the channel is allowed to speak into Claude's context.
 *
 * This file is the whole point of Surface 2, and it is pure so it can be tested
 * exhaustively. If this logic is wrong the channel is not merely noisy, it is
 * actively harmful: every pushed event is tokens the user pays for on every
 * subsequent turn, and a channel that pushes progress ticks would push more
 * context than the conversation it is meant to inform.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DESIGN RULE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   PUSH STATE CHANGES ONLY. NEVER PROGRESS TICKS.
 *
 * The mod already shows progress, for free, every second, to the human. A channel
 * cannot draw and a human cannot read Claude's context. So the channel's only
 * job is the one thing the mod cannot do: wake Claude when something CHANGED that
 * Claude would otherwise not notice.
 *
 * Four pushable events. That is the entire vocabulary:
 *
 *   finished  the job reached a terminal success
 *   failed    it reached a terminal failure, or a suspicious success
 *   attention it went silent past the grace period (no event, process alive or
 *             unknown), or its process stopped while it is still marked running
 *   cancelled a human stopped it
 *
 * Not pushable, and the reasoning matters:
 *   running     — this is a progress tick. The definition of the thing we forbid.
 *   unknown     — we do not know what happened. Telling Claude "something
 *                 happened and I don't know what" costs tokens and buys nothing.
 *   succeeded→? — a re-read of an unchanged terminal job is not a change.
 *
 * Budget: one short line per job plus a closing next step (the text is
 * mod/hooks/notice.ts claudeText). Worker prose is excerpted, never pasted whole.
 */
// The words live in the mod (hooks/notice.ts), which announces the same jobs
// when it is loaded: one renderer, so the hook and the mod cannot drift apart.
/**
 * Which pushable event, if any, this job's current state represents.
 *
 * Returns null for every state we refuse to speak about. Keeping the refusal in
 * one function means "did we push a tick?" is answerable by reading one map.
 */
function pushKindFor(job) {
    switch (job.status) {
        case 'succeeded':
            return 'finished';
        case 'failed':
            return 'failed';
        case 'canceled':
            return 'cancelled';
        case 'attention':
            return 'attention';
        // 'running' and 'unknown' deliberately fall through to null.
        default:
            return null;
    }
}
// ── dedupe ──────────────────────────────────────────────────────────────────
/**
 * The dedupe key: identity + the specific state we announced.
 *
 * WHY THE STATE IS PART OF THE KEY AND NOT JUST THE JOB ID:
 * a job that fails and is then re-run to success is two distinct facts. If the
 * key were just the job id, the success would be swallowed as a duplicate of the
 * failure, and Claude would sit on a stale "this failed" belief. Including the
 * state lets a job speak twice, but only if it genuinely changed its mind.
 *
 * WHY `finishedAt` IS NOT IN THE KEY:
 * it is the natural instinct and it is wrong. Keying on a timestamp that the worker does not promise to be stable converts a
 * re-read into a fake "new" event. The state is the fact; the timestamp is not.
 *
 * WHY `attention` IS NOT IN THE KEY:
 * a stall can be detected, resolve, and be detected again. That IS one story
 * ("this job stalls"), and the user needs to hear it once. The `epoch` argument
 * exists only so a caller can deliberately re-announce a job that recovered and
 * stalled again, and the default epoch never changes.
 */
function dedupeKey(job, epoch = 0) {
    // A job that exited with checks still running speaks again when the verdict lands.
    // A silent job whose process then dies is a second fact: dead is keyed apart.
    const dead = job.status === 'attention' && job.liveness?.state === 'dead' ? '#dead' : '';
    return `${job.id}#${job.status}${dead}${job.checksRunning === undefined ? '' : '#checks'}#${epoch}`;
}
/**
 * True if this job should be pushed right now.
 *
 * FOUR GATES, in order. Each one alone is insufficient, which is why they stack:
 *
 *  1. the state must be pushable        — kills progress ticks and `unknown`
 *  2. the key must be new                — kills a re-read of the same terminal state
 *  3. a terminal state must be *settled* — kills the mid-flight flap where a
 *     finished job is briefly unreadable and normalizes to `unknown` and back
 *  4. attention must be a transition     — a job that has been stalled since the
 *     channel started is a known quantity, not news
 *
 * GATE 3 EXISTS BECAUSE OF A REAL HAZARD. There is a window in which the
 * terminal status file is being written while we read. A reader that samples that window
 * sees a finished job as `running`, then `succeeded` again. Without gate 3 that
 * flaps as push, silence, push. With it, a push requires the job to have actually
 * finished — a finished_at that exists — so a flap cannot produce a second event.
 */
function shouldPush(candidate, now) {
    const { job, seen } = candidate;
    // A superseded turn is an intermediate step in a steered worker chain; its
    // continuation owns the terminal announcement.
    if (job.supersededBy)
        return false;
    // Gate 1 — is this state speakable at all?
    const kind = pushKindFor(job);
    if (kind === null)
        return false;
    // Gate 2 — have we already said this exact thing?
    if (seen.has(dedupeKey(job)))
        return false;
    // Gate 3 — terminal claims must be backed by a terminal timestamp.
    if (kind === 'finished' || kind === 'failed' || kind === 'cancelled') {
        if (job.finishedAt === null)
            return false;
    }
    // Gate 4 — `attention` is only news if it is NEW. A channel that connects to a
    // directory which already contains stalled jobs says nothing about them: it did
    // not observe them stall, so it has no news, only a backlog. Announcing the
    // backlog would be the channel's first impression being 16 lines of alarm.
    if (kind === 'attention') {
        if (!candidate.knownBefore)
            return false;
        // A stall with no last_event_at is not a stall we can describe. We know the job
        // exists and that it is not reporting; we do not know that it went quiet, and
        // a reader that just started will produce exactly this state for every job.
        // Saying "has stopped making progress" about a job whose progress we have
        // never observed would be a confident sentence about nothing.
        // A dead process is a fact of its own (its heartbeat stopped), event times or not.
        if (job.lastEventAt === null && job.liveness?.state !== 'dead')
            return false;
    }
    return true;
}
/**
 * Collapse a poll's candidates into at most one notification.
 *
 * PURE. Given the same candidates and the same `seen`, always the same batch.
 *
 * The headline counts by KIND. "three succeeded, one failed" is a different
 * piece of news from "four failed", and Claude's useful next action differs:
 * several successes is usually "carry on", several failures is usually "stop
 * and look". Each job still gets its own line so Claude can act on its id.
 */
function buildBatch(candidates, now) {
    const pushable = candidates.filter((c) => shouldPush(c));
    if (pushable.length === 0) {
        return { content: null, keys: [] };
    }
    const keys = pushable.map((c) => dedupeKey(c.job));
    const content = claudeText(pushable.map((c) => toNotice(c.job, pushKindFor(c.job), now)));
    return { content, keys };
}
/**
 * A watched job as the shared notice shape. A pipeline run (role `pipeline`)
 * carries its stage verdicts as `outcome`; a job carries its failure reason.
 */
function toNotice(job, kind, now) {
    const run = job.role === 'pipeline' && job.outcome !== undefined;
    const dead = kind === 'attention' && job.liveness?.state === 'dead';
    const span = dead
        ? (job.liveness?.since == null ? NaN : now - job.liveness.since)
        : kind === 'attention'
            ? (job.lastEventAt === null ? NaN : now - Date.parse(job.lastEventAt))
            : (job.startedAt && job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : NaN);
    return {
        id: job.id, kind, name: job.name ?? null, provider: job.provider ?? null, role: job.role ?? null,
        run,
        durationMs: Number.isFinite(span) ? span : null,
        changedFiles: job.changedFileCount ?? null,
        checks: job.checks ?? null,
        reason: run ? job.outcome : kind === 'failed' ? job.failureDetail || reasonFromText(job.failureReason) : null,
        summary: job.summarySource === 'worker' ? job.latestSummary ?? null : null,
        ...(job.staleReads && job.staleReads.length > 0 ? { staleReads: job.staleReads } : {}),
        ...(job.steeredFrom ? { steered: true } : {}),
        ...(job.steerNotApplied ? { steerNotApplied: true } : {}),
        ...(kind === 'finished' && job.checksRunning !== undefined ? { checksRunning: job.checksRunning } : {}),
        ...(kind === 'attention' && job.liveness ? { liveness: { state: job.liveness.state, ...(job.liveness.tool ? { tool: job.liveness.tool } : {}) } } : {}),
    };
}/**
 * watch-source.ts — what the channel reads.
 *
 * Deliberately a thin adapter over the same harness readers the mod pane is built
 * on, so the two surfaces CANNOT disagree about a job's state. That is the whole
 * claim in docs/ARCHITECTURE.md: "two surfaces cost one implementation". If this
 * file had its own status rules, the channel could announce a failure the pane
 * draws as a success, and there would be no way for a user to tell which one is
 * lying.
 *
 * Re-implementing the reader's rules here (the cancel marker outranks job.json;
 * the anchor is never deleted) would create a second source of truth for the
 * exact failures that are hardest to debug. One place, one answer.
 */
const reader = new AgentSmithReader();
function acceptancePending(cwd, job, now) {
    if (job.finishedAt === null)
        return false;
    const finished = Date.parse(job.finishedAt);
    const placeholder = readAcceptance(cwd, job.id);
    if (placeholder.pending !== true)
        return false;
    const budget = typeof placeholder.budgetMs === 'number' && placeholder.budgetMs > 0 ? placeholder.budgetMs : ACCEPTANCE_HOLD_MS;
    return !(Number.isFinite(finished) && now - finished > budget);
}
const isTerminal = (job) => isTerminalForgeStatus(job.status) && job.finishedAt !== null;
/** Project a pipeline record onto the watchable shape; null for a malformed record. */
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
/** Read one pipeline record by run id (file name is the sanitized id). */
async function readPipelineRecord(cwd, runId) {
    const run = await readJsonSafe(pipelineRecordPath(cwd, runId));
    const job = pipelineToWatchable(run);
    if (job === null || run === null)
        return null;
    const stageJobIds = Object.values(run.stageResults).flatMap(s => (s && typeof s.jobId === 'string' ? [s.jobId] : []));
    return { job, stageJobIds };
}
/** Read exactly one job by id. Never throws. */
async function readJob(cwd, jobId, now = Date.now()) {
    const own = await readOne(cwd, jobId, now);
    // A watcher polls until the job settles: while its checks are inside their budget it is still in flight.
    if (own !== null && isTerminal(own) && acceptancePending(cwd, own, now))
        return { ...own, status: 'running', finishedAt: null };
    return own;
}
/**
 * One job, projected onto the minimal shape the policy reasons about.
 *
 * We project down to five fields on purpose. The policy module has no access to
 * the provider payload, so it CANNOT accidentally start depending on it, and a
 * reader change cannot silently alter what gets pushed into someone's context.
 */
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
    // `warned` covers both sources harness tracks: a recorded failure reason and
    // any warning strings the provider reported. The notice states the failure
    // reason itself (`failureReason`), so only the boolean is kept here.
    const warned = observed.warnings.length > 0;
    const raw = observed.raw;
    const acceptance = readAcceptance(cwd, observed.jobId);
    const checks = Array.isArray(acceptance.checks) && acceptance.checks.length > 0
        ? {
            passed: acceptance.checks.filter((c) => c?.ok === true).length, total: acceptance.checks.length,
            failed: acceptance.checks.flatMap((c) => (c?.ok !== true && typeof c?.name === 'string' ? [c.name] : [])),
        } : null;
    return {
        id: observed.jobId,
        name: typeof observed.raw['name'] === 'string' ? observed.raw['name'] : undefined,
        role: typeof observed.raw['role'] === 'string' ? observed.raw['role'] : observed.mode ?? undefined,
        provider: typeof observed.raw['provider'] === 'string' ? observed.raw['provider'] : undefined,
        startedAt: observed.startedAt,
        changedFileCount: Array.isArray(observed.raw['changed_files']) ? observed.raw['changed_files'].length : undefined,
        latestSummary: typeof raw['latestSummary'] === 'string' ? raw['latestSummary'] : null,
        failureReason: [raw['reason'], raw['error']].find((v) => typeof v === 'string' && v !== '') ?? null,
        failureDetail: typeof raw['error'] === 'string' ? raw['error'] : null,
        checks,
        ...(observed.status === 'succeeded' && acceptance.pending === true
            ? { checksRunning: typeof acceptance.running === 'string' && acceptance.running !== '' ? acceptance.running : true } : {}),
        summarySource: observed.raw['summarySource'] === 'worker' ? 'worker' : null,
        status: toWatchStatus(observed, now),
        ...livenessField(watchLiveness(observed, now)),
        lastEventAt: observed.updatedAt,
        finishedAt: observed.finishedAt,
        warned,
        supersededBy: typeof raw['supersededBy'] === 'string' && raw['supersededBy'] !== '' ? raw['supersededBy'] : null,
        steeredFrom: typeof raw['steeredFrom'] === 'string' && raw['steeredFrom'] !== '' ? raw['steeredFrom'] : null,
        ...(observed.warnings.some((w) => w.code === 'steer_not_applied') ? { steerNotApplied: true } : {}),
        ...(Array.isArray(raw['staleReads']) && raw['staleReads'].length > 0
            ? { staleReads: raw['staleReads'].filter((f) => typeof f === 'string' && f.trim() !== '') }
            : {}),
    };
}
/**
 * The shared liveness rule (mod/hooks/stale.ts) over an observed job: event
 * silence, the open tool call and the process owner's heartbeat. Null unless running.
 */
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
/** Only the quiet states travel to the notice: they are what `attention` means. */
function livenessField(l) {
    if (l === null || (l.state !== 'silent' && l.state !== 'dead'))
        return {};
    return { liveness: { state: l.state, silentForMs: l.silentForMs, since: l.since, ...(l.tool ? { tool: l.tool } : {}) } };
}
/**
 * ObservedStatus → WatchStatus, plus the liveness escalation.
 *
 * The rule is mod/hooks/stale.ts livenessOf, shared with the pane, so the two
 * cannot disagree about when a job needs attention (silent or dead).
 *
 * WHY ESCALATE HERE AND NOT IN THE POLICY: a stall is a fact about the job, and
 * a fact belongs to the reader. The policy's job is only to decide whether a fact
 * is worth 50 tokens.
 */
function toWatchStatus(observed, now) {
    if (observed.status !== 'running')
        return observed.status;
    // silent or dead needs eyes; active and in-tool (a long command) do not. No
    // event time at all is `silent`: "we do not know" is never drawn as "fine".
    return isStalled(watchLiveness(observed, now)) ? 'attention' : 'running';
}/**
 * Job-scoped monitor entrypoint (the `notify.fallback` monitorCommand).
 *
 * This process is deliberately separate from the MCP server: Claude Code can
 * launch it with `--job`/`--run` and consume one human-readable line per
 * milestone from stdout. Routine running/progress polls produce no stdout.
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
 * Watch specific jobs/runs until each is terminal. There is NO silent
 * baseline: a job that already finished before the watcher
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
            // Announcing once: a stage that exited with its checks still running waits for its verdict
            // rather than contributing a "checks running" line that the one write would carry twice.
            const announce = options.announceOnce === true
                ? [...jobs.values()].filter((job) => job.checksRunning === undefined || want.has(job.id))
                : [...jobs.values()];
            const batch = buildBatch(announce.map((job) => ({ job, seen: seen.get(job.id) ?? new Set(), knownBefore: true })), t);
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
                // Exited with checks still running: the verdict is a second notice, so keep watching (unless announcing once).
                if (job && isTerminalForgeStatus(job.status) && (options.announceOnce === true || job.checksRunning === undefined) && (seen.get(id)?.has(dedupeKey(job)) ?? false))
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