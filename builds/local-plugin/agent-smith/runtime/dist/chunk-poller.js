import path from'node:path';import {constants,existsSync,readFileSync,mkdirSync,writeFileSync,renameSync}from'node:fs';import {readdir,open,access}from'node:fs/promises';import {randomBytes}from'node:crypto';import os from'node:os';import {spawn}from'node:child_process';/**
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
const QUOTA_RE = /insufficient[_ ]quota|quota (?:exceeded|exhausted)|exceeded.{0,30}quota|credit balance.{0,30}(?:low|exhausted)|billing.{0,30}(?:limit|exhausted)|out of credits/i;
const COMPATIBILITY_RE = /unknown (?:option|argument|flag)|unrecognized (?:option|argument|flag|subcommand)|unexpected argument|unsupported (?:option|flag)|invalid value.{0,80}(?:--model|--effort|reasoning_effort)|unknown model|does not support effort|bad flag or model/i;
const START_RE = /\bENOENT\b|spawn.{0,100}(?:not found|no such file)|couldn't start|could not start/i;
/** The orphan reason, old and new wording: the process that owned the job is gone. */
const ORPHAN_RE = /orphaned|supervisor process exited|server stopped/i;
const DENIED_RE = /\bdenied\b|soft-denied/i;
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
 * notice.ts: the words Agent Smith uses to say a job finished, and which jobs
 * this session may announce. Pure; no host API, no `node:` imports.
 *
 * One owner, two speakers. The mod announces through `$.ui.log` (the user's
 * line) and `$.prompt.submit` (Claude's turn, credited to the plugin). Without
 * the mod, the PostToolUse command hook (channel/src/watch-hook.ts) wakes Claude
 * with exit 2. Both render here, so the two paths cannot drift apart.
 *
 * Who announces is decided once per launch, when the mod sees the launch
 * (`tool.call`, or `classic.PostToolUse` where the host delivers it): the mod
 * claims the job and writes a claim marker; the command hook, if it starts at
 * all, finds the marker when the job ends and stays silent. Nothing else
 * announces a claimed job (see register.tsx, `takeLaunch`).
 */
/**
 * Acceptance checks run after a job ends, so a finished job briefly carries a
 * pending placeholder. Hold its notice until the verdict lands, never longer
 * than this: a crashed checker must not silence a finished job.
 */
const ACCEPTANCE_HOLD_MS = 5 * 60_000;
const GLYPH = { finished: '✓', failed: '✗', cancelled: '■', attention: '!' };
// ── text ────────────────────────────────────────────────────────────────────
/** Bound prose at a sentence or word boundary, never mid-word. */
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
 *   ! Di (opencode research) · stalled 16m
 */
function headline(job) {
    const d = durationWords(job.durationMs);
    const reason = job.reason ? compactExcerpt(job.reason, 160) : '';
    const bad = rejected(job);
    const glyph = bad ? GLYPH.failed : GLYPH[job.kind];
    const parts = [`${glyph} ${who(job)}${d && job.kind !== 'attention' ? ` ${d}` : ''}`];
    switch (job.kind) {
        case 'finished':
            if (job.run)
                parts.push(reason || 'done');
            else if (bad)
                parts.push(checksReason(job.checks?.failed ?? []));
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
            parts.push(`stalled${d ? ` ${d}` : ''}`);
            break;
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
            const label = rejected(job) ? 'failed' : STATE[job.kind];
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
    return ['done', 'failed', 'canceled', 'stalled'].flatMap((k) => (counts.has(k) ? [[k, counts.get(k)]] : []));
}
const STATE = {
    finished: 'done', failed: 'failed', cancelled: 'canceled', attention: 'stalled',
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
/** The three launch tools, by bare name. */
const LAUNCH = { spawn_job: 'job', resume_job: 'job', run_pipeline: 'run' };
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
 * before waking Claude, so a launch is announced once even if answering
 * `classic.PostToolUse` without `next` fails to stop the hook from starting.
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
    if (kind === 'job' && ['succeeded', 'failed', 'canceled'].includes(String(payload['status'])))
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
 *   attention it went silent past the grace period and is not coming back
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
    return `${job.id}#${job.status}#${epoch}`;
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
        if (job.lastEventAt === null)
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
        return { content: null, meta: {}, keys: [] };
    }
    const keys = pushable.map((c) => dedupeKey(c.job));
    const content = claudeText(pushable.map((c) => toNotice(c.job, pushKindFor(c.job), now)));
    // Single event: its own kind. Several at once: the batch is one notice, and
    // its meta lists every job.
    if (pushable.length === 1) {
        const only = pushable[0];
        return { content, meta: metaFor(pushKindFor(only.job), [only.job]), keys };
    }
    return { content, meta: metaFor('failed', pushable.map((c) => c.job)), keys };
}
/**
 * A watched job as the shared notice shape. A pipeline run (role `pipeline`)
 * carries its stage verdicts as `outcome`; a job carries its failure reason.
 */
function toNotice(job, kind, now) {
    const run = job.role === 'pipeline' && job.outcome !== undefined;
    const span = kind === 'attention'
        ? (job.lastEventAt === null ? NaN : now - Date.parse(job.lastEventAt))
        : (job.startedAt && job.finishedAt ? Date.parse(job.finishedAt) - Date.parse(job.startedAt) : NaN);
    return {
        id: job.id, kind, name: job.name ?? null, provider: job.provider ?? null, role: job.role ?? null,
        source: job.source ?? null, run,
        durationMs: Number.isFinite(span) ? span : null,
        changedFiles: job.changedFileCount ?? null,
        checks: job.checks ?? null,
        reason: run ? job.outcome : kind === 'failed' ? reasonFromText(job.failureReason) : null,
        summary: job.summarySource === 'worker' ? job.latestSummary ?? null : null,
    };
}
// ── meta ────────────────────────────────────────────────────────────────────
/**
 * Identifier-safe `meta` for the notification.
 *
 * THE CONTRACT: meta keys must match [A-Za-z0-9_]+. Values are strings.
 *
 * Job ids contain hyphens (`implement-musm82da-f1dc1fe4`), which are NOT
 * identifier-safe. The `jobs` value is therefore sanitised by replacing every
 * illegal character with `_`. The human-readable `content` keeps the real ids
 * with their hyphens, because that text is for a person and a model, and neither
 * cares about a metacharacter. Only `meta` is machine-facing, so only `meta` is
 * sanitised.
 */
function metaFor(kind, jobs) {
    return {
        kind,
        count: String(jobs.length),
        jobs: jobs.map((j) => safeId(j.id)).join(','),
    };
}
/**
 * Make an identifier safe for a `meta` value.
 *
 * Note this is deliberately lossy and deliberately NOT injective: two different
 * job ids could sanitise to the same string. That is acceptable, because `meta` is
 * for coarse filtering ("which jobs?") and `content` carries the exact text. A
 * perfect encoding here would cost more tokens than it is worth.
 */
function safeId(id) {
    return id.replace(/[^A-Za-z0-9_]/g, '_');
}
/**
 * Assert a meta object is identifier-safe. Exported for tests and for the
 * startup self-check: a malformed meta makes the notification undeliverable, and
 * an undeliverable notification fails SILENTLY, which is the worst possible
 * failure for a channel whose entire value is being reliably heard.
 */
function assertMetaSafe(meta) {
    return Object.entries(meta).every(([k, v]) => /^[A-Za-z0-9_]+$/.test(k) && typeof v === 'string' && /^[A-Za-z0-9_,]*$/.test(v));
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
 *      is nonfatal and a report was delivered: then succeeded, with a note.
 *   3. ok === false               ⇒ failed. The adapter already weighed exit
 *      code against the result event; we do not second-guess it.
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
    if (denials.length > 0 && d.ok === true && !looksEmpty$1(d.report) && denials.every((x) => x.nonfatal === true || x.action === 'tool')) {
        return {
            status: 'succeeded',
            suspicious: false,
            reason: null,
            note: `${denials.length} ${denials.length === 1 ? 'call' : 'calls'} denied` + (deniedNames(denials) === '' ? '' : `: ${deniedNames(denials)}`),
        };
    }
    if (denials.length > 0) {
        return { status: 'failed', suspicious: true, reason: deniedReason(denialNames(denials)) };
    }
    if (d.ok === false) {
        return {
            status: 'failed',
            suspicious: false,
            reason: d.jobStatus === 'timeout' ? REASONS.timedOut : REASONS.workerError,
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
            [SMITH_PAYLOAD.toolCalls]: progress?.toolCalls ?? manifest?.toolCalls ?? 0,
            [SMITH_PAYLOAD.pipeline]: manifest?.pipeline ?? null,
            [SMITH_PAYLOAD.stage]: manifest?.stage ?? null,
            [SMITH_PAYLOAD.attempt]: manifest?.attempt ?? null,
            [SMITH_PAYLOAD.output]: report,
            [SMITH_PAYLOAD.canceled]: canceled,
            [SMITH_PAYLOAD.cancelAt]: cancelAt,
            [SMITH_PAYLOAD.lastEventAt]: progress?.lastEventAt ?? manifest?.updatedAt ?? null,
            [SMITH_PAYLOAD.recentActivities]: progress?.recentActivities ?? [],
            [SMITH_PAYLOAD.lastActivity]: progress?.lastActivity ?? null,
            [SMITH_PAYLOAD.latestText]: progress?.latestText ?? null,
            [SMITH_PAYLOAD.progressWarnings]: progress?.warnings ?? [],
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
        warnings.push({ code: "tool_error", message: w });
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
            const verdict = await runCheck(check, options);
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
    const rawReport = await runChecks(toVerifyChecks(input.checks, input.baseDir), { signal: input.signal });
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
}/**
 * The one place the stall threshold is defined.
 *
 * WHY THIS FILE EXISTS: two surfaces (the mod pane and the channel) each need to
 * answer "is this running job actually working?", and if they disagree the user
 * gets a band that says a job is fine while the channel tells Claude it is stuck.
 * That contradiction is the exact failure this project exists to eliminate, so the
 * number is stated once.
 *
 * WHY IT IS NOT IMPORTED FROM core/liveness.ts: that module's DEFAULT_GRACE_MS is
 * the right number, but it is a sibling package the mod cannot resolve a bare
 * specifier for, and duplicating the literal in two files is how they drift. So:
 * one constant, here, imported by both surfaces, with a comment tying it to
 * core/liveness.ts so a future change there has an obvious counterpart here.
 *
 * Value: core/liveness.ts's DEFAULT_GRACE_MS, 15 minutes.
 * Reasoning that number is defensible: agy-staff's own default timeout is 60m
 * (every real spec.json in the corpus says `timeout: "60m"`), so 15m of silence
 * is a quarter of the budget gone with nothing to show, while still leaving ample
 * room for a genuinely long single command like `cargo test --workspace` on a
 * cold target directory.
 */
const STALL_GRACE_MS = 15 * 60 * 1000;/**
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
 * WHY THE DEDUPE IS EXPLICIT RATHER THAN INHERITED FROM registry.ts:
 * forge/mirror.ts projects our jobs into `.agy-staff/jobs/` so the UNMODIFIED mod
 * plugin can render them. So the interop reader discovers our job ids too, and a
 * naive concatenation would report every job we spawn TWICE — two independently
 * computed verdicts for one id, inside a single poll. The channel's dedupe map
 * would mask the duplicate for notifications and for nothing else. So the primary
 * reader wins the id, here and in harness/registry.ts, by the same rule.
 *
 * WHY WE DO NOT IMPORT `claude-code`'s reader HERE: this surface is a channel
 * about WORKERS WE SPAWN. Folding in every Claude Code subagent transcript would
 * turn a 4-event vocabulary into a firehose of the user's own internal reasoning,
 * and it would spend tokens on events nobody asked to hear.
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
/** Our own jobs directory. Read first, so it claims ids before interop sees them. */
const OWN_JOBS_DIR = ['.agent-smith', 'jobs'];
/** agy-staff's jobs directory, read second, for history. */
const INTEROP_JOBS_DIR = ['.agy-staff', 'jobs'];
/**
 * Terminal jobs/pipelines already read, keyed by `cwd\0id`. A terminal verdict is
 * final for the purposes of this reader, so the full scan skips re-reading them.
 * Only the cheap directory listing is repeated each poll.
 */
const terminalCache = new Map();
function acceptancePending(cwd, job, now) {
    if (job.finishedAt === null)
        return false;
    const finished = Date.parse(job.finishedAt);
    if (Number.isFinite(finished) && now - finished > ACCEPTANCE_HOLD_MS)
        return false;
    return readAcceptance(cwd, job.id).pending === true;
}
const isTerminal = (job) => (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') && job.finishedAt !== null;
function cacheKey(cwd, id) {
    return `${cwd}\0${id}`;
}
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
    const file = path.join(cwd, '.agent-smith', 'pipelines', `${runId.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 100) || 'pipeline'}.json`);
    const run = await readJsonSafe(file);
    const job = pipelineToWatchable(run);
    if (job === null || run === null)
        return null;
    const stageJobIds = Object.values(run.stageResults).flatMap(s => (s && typeof s.jobId === 'string' ? [s.jobId] : []));
    return { job, stageJobIds };
}
/** Read exactly one job by id from either source (primary first). Never throws. */
async function readJob(cwd, jobId, now = Date.now()) {
    return (await readOne(new AgentSmithReader(), 'agent-smith', cwd, jobId, now)) ?? (await readOne(new AgyStaffReader(), 'agy-staff', cwd, jobId, now));
}
/** One read of every job. Never throws; an unreadable directory yields []. */
async function readAll(cwd, now = Date.now()) {
    const claimed = new Set();
    const out = [];
    // Primary first. `discover` returns [] for a repo that has never spawned, which
    // is the ordinary case and not an error — that is why the existsSafe pre-check
    // below is a cost we only pay when we are going to read anyway.
    await collect(new AgentSmithReader(), 'agent-smith', cwd, now, claimed, out, () => false);
    await collect(new AgyStaffReader(), 'agy-staff', cwd, now, claimed, out, isForgeJobId);
    // Pipeline acceptance happens after harness execution. Announce its own
    // terminal transition so a failing check cannot be hidden by a green job.
    const runs = path.join(cwd, '.agent-smith', 'pipelines');
    for (const file of await readdirSafe(runs)) {
        if (!file.endsWith('.json'))
            continue;
        const cached = terminalCache.get(cacheKey(cwd, `pipeline:${file}`));
        if (cached) {
            out.push(cached);
            continue;
        }
        const job = pipelineToWatchable(await readJsonSafe(path.join(runs, file)));
        if (job === null)
            continue;
        if (isTerminal(job))
            terminalCache.set(cacheKey(cwd, `pipeline:${file}`), job);
        out.push(job);
    }
    return out;
}
/** Read one source's jobs, skipping ids another source already claimed. */
async function collect(reader, source, cwd, now, claimed, out, skip) {
    const dir = source === 'agent-smith' ? OWN_JOBS_DIR : INTEROP_JOBS_DIR;
    if (!(await existsSafe(path.join(cwd, ...dir))))
        return;
    let ids;
    try {
        ids = await reader.discover(cwd);
    }
    catch {
        return;
    }
    // Sequential, for the same reason the pane reads serially: these files are
    // being rewritten right now, and a burst of parallel readers maximises the
    // chance of catching one mid-write. safe-fs tolerates it either way, but
    // tolerating is not the same as not happening.
    for (const id of ids) {
        if (claimed.has(id))
            continue;
        if (skip(id))
            continue;
        claimed.add(id);
        const cached = terminalCache.get(cacheKey(cwd, id));
        if (cached) {
            out.push(cached);
            continue;
        }
        const job = await readOne(reader, source, cwd, id, now);
        if (job === null)
            continue;
        if (isTerminal(job) && acceptancePending(cwd, job, now)) {
            // Not cached and not emitted: re-read next poll, once the verdict is written.
            claimed.delete(id);
            continue;
        }
        if (isTerminal(job))
            terminalCache.set(cacheKey(cwd, id), job);
        out.push(job);
    }
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
        checks,
        ...(source === 'agy-staff' ? { source } : {}),
        summarySource: observed.raw['summarySource'] === 'worker' ? 'worker' : null,
        status: toWatchStatus(observed, now),
        lastEventAt: observed.updatedAt,
        finishedAt: observed.finishedAt,
        warned,
    };
}
/**
 * ObservedStatus → WatchStatus, plus the stall escalation.
 *
 * The stall threshold is imported from ./stale.ts rather than duplicated, so the
 * pane and the channel cannot disagree about when a job counts as stalled. The
 * number itself matches core/liveness.ts's DEFAULT_GRACE_MS (15 min).
 *
 * WHY ESCALATE HERE AND NOT IN THE POLICY: a stall is a fact about the job, and
 * a fact belongs to the reader. The policy's job is only to decide whether a fact
 * is worth 50 tokens.
 */
function toWatchStatus(observed, now) {
    if (observed.status !== 'running')
        return observed.status;
    if (observed.updatedAt === null) {
        // No evidence of progress at all. Treat as needing eyes rather than healthy:
        // "we do not know" must never be drawn as "fine" (the asymmetry
        // core/liveness.ts documents).
        return 'attention';
    }
    const then = Date.parse(observed.updatedAt);
    if (Number.isNaN(then))
        return 'attention';
    return now - then > STALL_GRACE_MS ? 'attention' : 'running';
}/**
 * poller.ts — the poll loop's BRAIN, with no transport attached.
 *
 * WHY THIS IS NOT IN server.ts: server.ts connects a stdio transport at module
 * scope (`await mcp.connect(...)`). Importing it from a test would spawn a real
 * MCP server and hang the test runner on an open stdin. So the decision logic —
 * what to send, what to remember, what to suppress — lives here where it can be
 * tested exhaustively, and server.ts is reduced to wiring.
 *
 * This is the only piece of the channel with real state, so it is also the piece
 * where the dedupe rules have to be provably correct. Every rule is exercised in
 * __tests__/poller.test.ts.
 */
/**
 * What we have already told Claude, per job.
 *
 * Per-job SET rather than one flat set, because the dedupe key includes the job's
 * status: a job that failed and was re-run to success legitimately speaks twice,
 * and we must remember both announcements to suppress a third sighting.
 *
 * UNBOUNDED ON PURPOSE. A day of work is tens of jobs, and pruning would open a
 * window where a long session re-announces something the user already saw — the
 * most annoying failure this surface can have. The channel is a research preview,
 * not a long-lived daemon; if it ever becomes one, this is the line to revisit,
 * and the right eviction is LRU over a session-scoped map rather than a TTL.
 */
const announced = new Map();
/** Job ids present in the previous poll. Drives the `knownBefore` flag. */
let previouslyPresent = new Set();
/** False until the first poll completes. */
let primed = false;
/** Testing hook. Resets all dedupe state between cases. */
function resetPoller() {
    announced.clear();
    previouslyPresent = new Set();
    primed = false;
}
/**
 * ONE POLL.
 *
 * `send` is injected rather than imported so the whole decision path — including
 * "did we suppress this?" — is testable without a transport. The production
 * value is server.ts's `sendBatch`.
 *
 * THE FIRST POLL IS A BASELINE, NOT AN ANNOUNCEMENT. Whatever is already on disk
 * happened before this channel existed. Reporting it would open every session
 * with a wall of notifications about work that completed while nobody was
 * watching, which is both expensive and the fastest possible way to get the
 * feature turned off. We record the keys so that a job which changes afterwards
 * is correctly treated as new.
 */
async function pollOnce(cwd, now, send, read = readAll) {
    let jobs;
    try {
        jobs = await read(cwd, now);
    }
    catch {
        // A read that throws means the directory is mid-rewrite. Staying silent for
        // one tick is strictly better than announcing a half-read state.
        return;
    }
    const present = new Set(jobs.map((j) => j.id));
    const candidates = jobs.map((job) => ({
        job,
        seen: announced.get(job.id) ?? new Set(),
        knownBefore: previouslyPresent.has(job.id),
    }));
    const batch = buildBatch(candidates, now);
    if (!primed) {
        // Baseline. Note we record EVERY pushable state we see, including attention —
        // otherwise a job that was already stalled at startup would be announced the
        // moment its key changed for an unrelated reason.
        for (const c of candidates) {
            if (pushKindFor(c.job) !== null)
                remember(c.job.id, dedupeKey(c.job));
        }
        primed = true;
        previouslyPresent = present;
        return;
    }
    if (batch.content === null) {
        previouslyPresent = present;
        return;
    }
    // Belt and braces on the meta contract. A malformed meta makes the notification
    // undeliverable, and an undeliverable notification fails SILENTLY — we would
    // consume the state transition without Claude ever hearing about it.
    if (!assertMetaSafe(batch.meta)) {
        throw new Error(`refusing to send: meta is not identifier-safe: ${JSON.stringify(batch.meta)}`);
    }
    await send(batch);
    // Record AFTER a successful send. Recording first would mean a failed send
    // loses the event permanently, which is worse than repeating it.
    for (const key of batch.keys) {
        const id = jobIdForKey(key);
        if (id !== null)
            remember(id, key);
    }
    previouslyPresent = present;
}
/** batch keys are `id#status#epoch`. agy job ids contain no '#', so this is exact. */
function jobIdForKey(key) {
    const i = key.indexOf('#');
    return i === -1 ? null : key.slice(0, i);
}
function remember(jobId, key) {
    const set = announced.get(jobId);
    if (set)
        set.add(key);
    else
        announced.set(jobId, new Set([key]));
}
/**
 * Poll interval: 5 seconds.
 *
 * WHY NOT 3, WHICH IS WHAT THE MOD USES: the mod redraws, and a 3 s poll costs
 * nothing because nobody reads between frames. This surface spends TOKENS.
 * Polling faster cannot make a change visible before agy-staff writes it — it
 * republishes every 100 ms, so 3 s versus 5 s is noise — while making us more
 * likely to sample and re-evaluate an intermediate state. The slower cadence is
 * the correct number, not a compromise.
 *
 * Lives here, not in server.ts, so tools.ts can advertise the same cadence as
 * the `pollIntervalMs` of a launch ack without importing the server.
 */
const POLL_MS = 5_000;
/**
 * Self-scheduling poll loop.
 *
 * setTimeout chained onto completion, NOT setInterval. An async callback in
 * setInterval will overlap with itself whenever a read outlasts the interval, and
 * with 20 jobs and a 500 KB events file a slow read is not hypothetical.
 * Overlapping polls would double every read and could push the same event twice
 * from two interleaved ticks. Chaining makes overlap structurally impossible.
 *
 * `unref()` so a pending poll never holds the process open on its own; the stdio
 * transport is what should keep the process alive.
 */
function scheduleLoop(cwd, intervalMs, send, onError) {
    const tick = () => {
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    await pollOnce(cwd, Date.now(), send);
                }
                catch (err) {
                    // One bad poll must not kill the channel. A crash here takes the MCP
                    // server down and Claude Code sees the channel vanish with no
                    // explanation. Report on stderr: stdout is the protocol channel and
                    // writing to it corrupts the JSON-RPC stream.
                    onError(err);
                }
                finally {
                    tick();
                }
            })();
        }, intervalMs);
        timer.unref?.();
    };
    tick();
}export{AgentSmithReader as A,acceptanceState as B,ClaudeCodeReader as C,DEFAULT_TIMEOUT_MS as D,reasonFromText as E,FILES as F,POLL_MS as G,evaluateAcceptance as H,pollOnce as I,scheduleLoop as J,parseLaunch as K,claimMarkerPath as L,readJob as M,readPipelineRecord as N,buildBatch as O,PROGRESS_FLUSH_MS as P,dedupeKey as Q,REASONS as R,SCHEMA_VERSION as S,resetPoller as T,readAll as U,AgyStaffReader as a,attributeChanged as b,deriveStatus as c,diffChangedFiles as d,exitReason as e,failureFields as f,isPidAlive as g,deriveOrphan as h,isForgeStatePath as i,jobFile as j,jobsDir as k,looksEmpty$1 as l,newJobId as m,normalize as n,jobDir as o,isForgeJobId as p,SMITH_PAYLOAD as q,readAcceptance as r,shouldFlush as s,taskTitle as t,nextActionFor as u,toVerifyChecks as v,writeAcceptance as w,normalizeAcceptanceReport as x,runChecks as y,acceptanceChecksFromReport as z};