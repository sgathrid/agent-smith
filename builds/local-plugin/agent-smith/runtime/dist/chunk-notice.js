import {r as reasonFromText,O as checksReason}from'./chunk-checks.js';/**
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
 * WHY THE JOB ID IS NOT ON THE ROW ANY MORE. Measured against 20 real jobs:
 * every id looked like `implement-musm82da-f1dc1fe4`. That is
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
function isTerminal(status) {
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
/** `Ada (codex review)`, `review-smith-1a2b3c4d (agy review)`, or `job <id>`. */
function who(job) {
    const identity = [job.provider, job.role].filter(Boolean).join(' ');
    const name = chosenName(job);
    if (job.run)
        return name ?? `pipeline ${job.id}`;
    if (name)
        return identity ? `${name} (${identity})` : name;
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
/**
 * Every launch an ack started. A `variants` spawn answers `{ jobs: [ack | {name, error}, ...] }`:
 * one launch per item that started a job, none for an item that failed. Any other ack is
 * the single launch parseLaunch reads.
 */
function parseLaunches(toolName, response) {
    const kind = launchKind(toolName);
    if (kind === null)
        return [];
    const payload = unwrapResponse(response);
    if (payload === null || typeof payload['error'] === 'string')
        return [];
    const jobs = payload['jobs'];
    if (kind === 'job' && Array.isArray(jobs)) {
        return jobs.flatMap((item) => {
            const one = isRecord(item) ? launchFromPayload('job', item) : null;
            return one === null ? [] : [one];
        });
    }
    const one = launchFromPayload(kind, payload);
    return one === null ? [] : [one];
}
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function launchFromPayload(kind, payload) {
    if (typeof payload['error'] === 'string')
        return null;
    const id = kind === 'job' ? payload['jobId'] : payload['runId'];
    // Hosts may expose only structuredContent and omit the outer MCP metadata.
    if (kind === 'job' && isTerminal(String(payload['status'])))
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
}export{ACCEPTANCE_HOLD_MS as A,claudeText as a,pipelineOutcome as b,claimMarkerPath as c,parseLaunches as p};