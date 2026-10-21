import {r as reasonFromText,H as checksReason,I as readJsonSafe,J as readdirSafe,q as normalize,a as readAcceptance,K as existsSafe,A as AgentSmithReader,p as AgyStaffReader,B as isForgeJobId}from'./chunk-checks.js';import path from'node:path';/**
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
        reason: run ? job.outcome : kind === 'failed' ? job.failureDetail || reasonFromText(job.failureReason) : null,
        summary: job.summarySource === 'worker' ? job.latestSummary ?? null : null,
        ...(job.staleReads && job.staleReads.length > 0 ? { staleReads: job.staleReads } : {}),
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
        failureDetail: typeof raw['error'] === 'string' ? raw['error'] : null,
        checks,
        ...(source === 'agy-staff' ? { source } : {}),
        summarySource: observed.raw['summarySource'] === 'worker' ? 'worker' : null,
        status: toWatchStatus(observed, now),
        lastEventAt: observed.updatedAt,
        finishedAt: observed.finishedAt,
        warned,
        supersededBy: typeof raw['supersededBy'] === 'string' && raw['supersededBy'] !== '' ? raw['supersededBy'] : null,
        steeredFrom: typeof raw['steeredFrom'] === 'string' && raw['steeredFrom'] !== '' ? raw['steeredFrom'] : null,
        ...(Array.isArray(raw['staleReads']) && raw['staleReads'].length > 0
            ? { staleReads: raw['staleReads'].filter((f) => typeof f === 'string' && f.trim() !== '') }
            : {}),
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
}export{POLL_MS as P,STALL_GRACE_MS as S,parseLaunch as a,readPipelineRecord as b,claimMarkerPath as c,buildBatch as d,dedupeKey as e,resetPoller as f,readAll as g,pollOnce as p,readJob as r,scheduleLoop as s};