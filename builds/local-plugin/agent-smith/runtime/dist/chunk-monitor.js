import path from'node:path';import {fileURLToPath}from'node:url';import {r as reasonFromText,$ as checksReason,a0 as readJsonSafe,W as pipelineRecordPath,n as normalize,b as readAcceptance,A as AgentSmithReader,g as isTerminalForgeStatus,k as AgyStaffReader}from'./chunk-execute.js';import {l as livenessOf,i as isStalled}from'./chunk-stale.js';/**
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
 * a parameter, for the same reason the stall check does it: a formatter that
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
/** True for the states that have stopped and will never move again.
 * Takes any string so wire payloads (notice.ts) can ask without a cast; only
 * the three settled names count, so 'unknown' and unrecognised words are not. */
function isTerminal$1(status) {
    return status === 'succeeded' || status === 'failed' || status === 'canceled';
}/**
 * notice.ts: the words Agent Smith uses to say a job finished, and which jobs
 * this session may announce. Pure; no host API, no `node:` imports.
 *
 * One owner, two speakers. The mod announces through `$.ui.log` (the user's
 * line) and `$.prompt.submit` (Claude's turn, credited to the plugin). Without
 * the mod, the PostToolUse command hook (channel/src/watch-hook.ts) wakes Claude
 * with exit 2. Both render here, so the two paths cannot drift apart.
 *
 * Who announces is decided once per launch, when the mod sees the launch
 * (`tool.call`): the mod claims the job and writes a claim marker; the command
 * hook, which still starts, finds the marker when the job ends and stays silent. Nothing else
 * announces a claimed job (see register.tsx, `takeLaunch`).
 */
/**
 * Acceptance checks run after a job ends, so a finished job briefly carries a
 * pending placeholder. Hold its notice until the verdict lands, never longer
 * than this: a crashed checker must not silence a finished job. A placeholder
 * that carries its own `budgetMs` (the checks' timeouts summed) holds that long.
 */
const ACCEPTANCE_HOLD_MS = 5 * 60_000;
const GLYPH = { finished: '✓', failed: '✗', cancelled: '■', attention: '!' };
// ── text ────────────────────────────────────────────────────────────────────
/** Bound prose at a sentence or word boundary, never mid-word. The channel's
 * views.ts `trimWords` is its near-twin. */
function compactExcerpt(value, max) {
    const text = value.replace(/\s+/g, ' ').trim();
    if (text.length <= max)
        return text;
    const prefix = text.slice(0, Math.max(0, max - 1));
    const sentence = [...prefix.matchAll(/[.!?](?=\s)/g)].at(-1)?.index;
    const end = sentence !== undefined && sentence >= max / 2 ? sentence + 1 : prefix.lastIndexOf(' ');
    return `${end > 0 ? prefix.slice(0, end).trimEnd() : ''}…`;
}
/** `43s`, `12m`, `1h05m`; '' for an unknown or negative span. */
function durationWords(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0)
        return '';
    const s = Math.round(ms / 1000);
    if (s < 90)
        return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60)
        return `${m}m`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
/**
 * The service names an unnamed worker `<mode>-<last 8 of the job id>`. Beside
 * the job id that reads as a typo, so it counts as no name.
 */
function chosenName(job) {
    if (!job.name)
        return null;
    return !job.run && job.id.length >= 8 && job.name.endsWith(`-${job.id.slice(-8)}`) ? null : job.name;
}
/** `Ada (codex review)`, `review-smith-1a2b3c4d (agy review)`, or `agy-staff job <id>`. */
function who(job) {
    const identity = [job.provider, job.role].filter(Boolean).join(' ');
    const name = chosenName(job);
    if (job.run)
        return name ?? `pipeline ${job.id}`;
    if (name)
        return identity ? `${name} (${identity})` : name;
    if (job.source === 'agy-staff')
        return `agy-staff job ${job.id}`;
    return identity ? `${job.id} (${identity})` : `job ${job.id}`;
}
/** Execution succeeded but a check failed: the work is not done. */
function rejected(job) {
    return job.kind === 'finished' && !job.run && job.checks != null && job.checks.passed < job.checks.total;
}
/**
 * One line, the outcome last:
 *   ✓ Ada (codex review) 43s · done · checks 2/2
 *   ✗ Bo (agy implement) 45m · failed: timed out
 *   ✗ Cy (codex implement) 3m · checks failed: lint
 *   ✓ Ed (codex review) 6s · done · after steer
 *   ✗ Flo (codex review) 4s · failed: timed out · queued steer not applied
 *   ! Di (opencode research) · no output for 16m
 *   ! Di (opencode research) · no output for 16m (in `npm test`)
 *   ! Di (opencode research) · process gone 3m
 * A quiet job is stated as a fact, never as a prompt to interrupt it.
 */
function headline(job) {
    const d = durationWords(job.durationMs);
    const reason = job.reason ? compactExcerpt(job.reason, 160) : '';
    const bad = rejected(job);
    const awaiting = job.kind === 'finished' && !job.run && !bad && job.checksRunning !== undefined;
    const glyph = bad ? GLYPH.failed : awaiting ? '…' : GLYPH[job.kind];
    const parts = [`${glyph} ${who(job)}${d && job.kind !== 'attention' ? ` ${d}` : ''}`];
    switch (job.kind) {
        case 'finished':
            if (job.run)
                parts.push(reason || 'done');
            else if (bad)
                parts.push(checksReason(job.checks?.failed ?? []));
            else if (awaiting) {
                parts.push('exited', typeof job.checksRunning === 'string' ? `checks running: ${job.checksRunning}` : 'checks pending');
            }
            else {
                parts.push('done');
                if (job.checks && job.checks.total > 0)
                    parts.push(`checks ${job.checks.passed}/${job.checks.total}`);
            }
            break;
        case 'failed':
            parts.push(job.run ? reason || 'failed' : `failed${reason ? `: ${reason}` : ''}`);
            break;
        case 'cancelled':
            parts.push('canceled');
            break;
        case 'attention':
            if (job.liveness?.state === 'dead')
                parts.push(`process gone${d ? ` ${d}` : ''}`);
            else
                parts.push(`no output${d ? ` for ${d}` : ''}${job.liveness?.tool ? ` (in \`${job.liveness.tool}\`)` : ''}`);
            break;
    }
    if (job.steered)
        parts.push('after steer');
    if (job.steerNotApplied)
        parts.push('queued steer not applied');
    if (job.staleReads && job.staleReads.length > 0) {
        const first = job.staleReads[0];
        const extra = job.staleReads.length > 1 ? ` +${job.staleReads.length - 1}` : '';
        parts.push(`stale brief: ${first}${extra}`);
    }
    return parts.join(' · ');
}
const CLAUDE_JOBS = 8;
/**
 * What Claude reads. One line per job, then how to read it:
 *   Agent Smith · ✗ pp-engine (agy implement) 21m · failed: denied view_file
 *   status implement-smith-6b456b3d
 * The worker's own summary is left out: Claude reads the result with status.
 */
function claudeText(jobs) {
    if (jobs.length === 0)
        return '';
    const one = jobs.length === 1;
    const lines = [];
    if (!one) {
        const counts = new Map();
        for (const job of jobs) {
            const label = rejected(job) ? 'failed' : job.checksRunning !== undefined && job.kind === 'finished' && !job.run ? 'exited'
                : job.kind === 'attention' && job.liveness?.state === 'dead' ? 'process gone' : STATE[job.kind];
            counts.set(label, (counts.get(label) ?? 0) + 1);
        }
        lines.push(`Agent Smith · ${jobs.length} jobs: ${[...shown(counts)].map(([k, n]) => `${n} ${k}`).join(', ')}`);
    }
    const listed = jobs.slice(0, CLAUDE_JOBS);
    for (const job of listed)
        lines.push(`${one ? 'Agent Smith · ' : ''}${headline(job)}`);
    if (jobs.length > CLAUDE_JOBS)
        lines.push(`…and ${jobs.length - CLAUDE_JOBS} more; list_jobs shows them.`);
    const ids = (run) => listed.filter((j) => !!j.run === run).map((j) => j.id);
    if (ids(false).length > 0)
        lines.push(`status ${ids(false).join(', ')}`);
    if (ids(true).length > 0)
        lines.push(`pipeline_status ${ids(true).join(', ')}`);
    return lines.join('\n');
}
/** Counts in the order a reader scans them: done first, then what needs a look. */
function shown(counts) {
    return ['done', 'exited', 'failed', 'canceled', 'no output', 'process gone'].flatMap((k) => (counts.has(k) ? [[k, counts.get(k)]] : []));
}
const STATE = {
    finished: 'done', failed: 'failed', cancelled: 'canceled', attention: 'no output',
};
// ── launch acks ─────────────────────────────────────────────────────────────
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Normalise any MCP result shape to the tool's payload object, or null on error/unparseable. */
function unwrapResponse(response, depth = 0) {
    if (depth > 4)
        return null;
    if (typeof response === 'string') {
        try {
            return unwrapResponse(JSON.parse(response), depth + 1);
        }
        catch {
            return null;
        }
    }
    if (Array.isArray(response)) {
        for (const part of response) {
            if (isObj(part) && typeof part['text'] === 'string') {
                const r = unwrapResponse(part['text'], depth + 1);
                if (r)
                    return r;
            }
        }
        return null;
    }
    if (!isObj(response))
        return null;
    if (response['isError'] === true)
        return null;
    // Tasks clients deliver this result themselves; neither notice path owns it.
    if (isObj(response['_meta']) && response['_meta']['io.agent-smith/task-result'] === true)
        return null;
    if (isObj(response['structuredContent']))
        return response['structuredContent'];
    if (Array.isArray(response['content']))
        return unwrapResponse(response['content'], depth + 1);
    return response;
}
/** The launch tools, by bare name. */
const LAUNCH = { spawn_job: 'job', resume_job: 'job', steer_job: 'job', run_pipeline: 'run' };
function launchKind(toolName) {
    if (typeof toolName !== 'string')
        return null;
    const bare = toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
    return LAUNCH[bare] ?? null;
}
const trimSlash = (p) => p.replace(/\/+$/, '');
/** `/repo/.agent-smith/<dir>/<leaf>` → `/repo`, else null. */
function repoAbove(file, dir) {
    const parts = trimSlash(file).split('/');
    return parts.length >= 3 && parts.at(-2) === dir && parts.at(-3) === '.agent-smith' ? parts.slice(0, -3).join('/') || '/' : null;
}
/**
 * The file the mod writes when it claims a launch. The command hook checks it
 * before waking Claude, so a launch the mod claimed is announced once.
 */
function claimMarkerPath(repo, kind, id) {
    return `${repo.replace(/\/+$/, '')}/.agent-smith/claims/${kind}-${encodeURIComponent(id)}`;
}
/** What a successful launch ack started, or null for an error or another tool. */
function parseLaunch(toolName, response) {
    const kind = launchKind(toolName);
    if (kind === null)
        return null;
    const payload = unwrapResponse(response);
    if (payload === null || typeof payload['error'] === 'string')
        return null;
    const id = kind === 'job' ? payload['jobId'] : payload['runId'];
    // Hosts may expose only structuredContent and omit the outer MCP metadata.
    if (kind === 'job' && isTerminal$1(String(payload['status'])))
        return null;
    if (typeof id !== 'string' || id.length === 0)
        return null;
    let repo = null;
    if (typeof payload['repo'] === 'string' && payload['repo'].length > 0)
        repo = trimSlash(payload['repo']);
    else if (kind === 'job' && typeof payload['dir'] === 'string')
        repo = repoAbove(payload['dir'], 'jobs');
    else if (kind === 'run' && typeof payload['recordPath'] === 'string')
        repo = repoAbove(payload['recordPath'], 'pipelines');
    const t = payload['timeoutMs'];
    return { kind, id, repo, timeoutMs: typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null };
}
/**
 * Pipeline outcome: `2/3 stages passed · test: checks failed: lint`. The first
 * stage that did not pass says why, in the shared short words.
 */
function pipelineOutcome(run) {
    const stages = Object.values(run.stageResults)
        .filter((s) => s !== null && typeof s === 'object' && typeof s.stage === 'string');
    const passed = stages.filter((s) => s.status === 'passed' && s.acceptance !== 'failed').length;
    const bad = stages.find((s) => s.status === 'failed' || s.acceptance === 'failed');
    const head = `${passed}/${stages.length} stages passed`;
    if (bad)
        return `${head} · ${String(bad.stage)}: ${stageReason(bad)}`;
    return run.error && run.status !== 'passed' ? `${head} · ${reasonFromText(run.error)}` : head;
}
function stageReason(s) {
    if (s.acceptance === 'failed') {
        const failing = isObj(s.verification) && Array.isArray(s.verification['failing']) ? s.verification['failing'] : [];
        const names = failing.flatMap((v) => (isObj(v) && isObj(v['check']) && typeof v['check']['name'] === 'string' ? [v['check']['name']] : []));
        return checksReason(names);
    }
    const f = isObj(s.failure) ? s.failure : null;
    return reasonFromText(typeof f?.['message'] === 'string' ? f['message'] : typeof f?.['code'] === 'string' ? f['code'] : null);
}/**
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
 * it is the natural instinct and it is wrong. A finished job's status.json is
 * rewritten on cleanup in some agy-staff versions, and the file's mtime moves.
 * Keying on a timestamp that the worker does not promise to be stable converts a
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
 * GATE 3 EXISTS BECAUSE OF A REAL HAZARD. agy-staff deletes progress.json when a
 * job finishes cleanly (hazard A), and there is a window in which the terminal
 * status file is being written while we read. A reader that samples that window
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
        source: job.source ?? null, run,
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
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO READERS, ONE VERDICT PER JOB
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   agent-smith   PRIMARY.  Everything this repo spawned via spawn_job. Our own
 *                            format, our own normalizer, our own status rules.
 *   agy-staff     INTEROP.  Somebody else's on-disk layout, read-only. Kept so
 *                            the 20 real jobs under renyi/.agy-staff/jobs stay
 *                            visible and so a future worker that writes that shape
 *                            is picked up for free.
 *
 * BEFORE THIS EXISTED, this file read agy-staff only. That was correct when
 * nothing in the repo could spawn anything: the only jobs that existed were
 * agy-staff's. It stopped being correct the moment `spawn_job` landed, and a
 * channel that never mentioned the jobs it had just started would be a surface
 * that watches somebody else's work and ignores its own.
 *
 * WHY THE DEDUPE IS EXPLICIT: older versions mirrored our jobs into
 * `.agy-staff/jobs/`, and those copies may still be on disk, so the interop reader
 * can discover our job ids too. A naive concatenation would report such a job
 * twice, with two independently computed verdicts. So the primary reader wins the
 * id, here and in forge/service.ts, by the same rule.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE HAZARDS ARE HANDLED BY DELEGATING RATHER THAN REPEATED
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   A. a deleted live-progress file means FINISHED, never "missing". Our writer
 *      never deletes the anchor (forge/format.ts), so the format we own has no
 *      such hazard; the interop reader still has to survive agy-staff's, and it
 *      does by anchoring on result.md.status.json.
 *   B. a cancel marker outranks the terminal status file, because a job we killed
 *      has no trustworthy terminal state of its own.
 *   C. a polluted result is stripped by the reader before we ever see the text.
 *
 * Re-implementing any of these here would create a second source of truth for the
 * exact failures that are hardest to debug. One place, one answer.
 */
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
/** Read exactly one job by id from either source (primary first). Never throws. */
async function readJob(cwd, jobId, now = Date.now()) {
    const own = await readOne(new AgentSmithReader(), 'agent-smith', cwd, jobId, now);
    // A watcher polls until the job settles: while its checks are inside their budget it is still in flight.
    if (own !== null && isTerminal(own) && acceptancePending(cwd, own, now))
        return { ...own, status: 'running', finishedAt: null };
    return own ?? (await readOne(new AgyStaffReader(), 'agy-staff', cwd, jobId, now));
}
/**
 * One job, projected onto the minimal shape the policy reasons about.
 *
 * We project down to five fields on purpose. The policy module has no access to
 * the provider payload, so it CANNOT accidentally start depending on it, and a
 * reader change cannot silently alter what gets pushed into someone's context.
 */
async function readOne(reader, source, cwd, jobId, now) {
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
    const acceptance = source === 'agent-smith' ? readAcceptance(cwd, observed.jobId) : {};
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
        ...(source === 'agent-smith' && observed.status === 'succeeded' && acceptance.pending === true
            ? { checksRunning: typeof acceptance.running === 'string' && acceptance.running !== '' ? acceptance.running : true } : {}),
        ...(source === 'agy-staff' ? { source } : {}),
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
    }
}
if (isEntrypoint())
    await startCliMonitor();export{claimMarkerPath as c,parseLaunch as p,runJobWatch as r,startCliMonitor as s};