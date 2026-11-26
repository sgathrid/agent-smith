import {watch}from'node:fs';import {r as reasonFromText,ah as checksReason,ai as toolLabel}from'./chunk-normalize.js';/**
 * forge/watch.ts — wake when a job's files change, instead of re-reading them on a timer.
 *
 * A worker runs in another process (the detached supervisor) and reports only through
 * its job directory. The OS tells us when that directory changes (FSEvents on macOS,
 * inotify on Linux) through fs.watch, so a caller waiting on a job wakes the moment the
 * writer renames a new job.json, progress.json, or acceptance.json into place.
 *
 * The timer is a fallback only: when the directory cannot be watched (it does not exist
 * yet, or the filesystem has no change events) the wait sleeps `fallbackMs` instead.
 */
/**
 * Resolves on the first change in `dir`, after `timeoutMs`, or when `signal` aborts,
 * whichever is first. `'polled'` means the directory could not be watched and the
 * fallback sleep ran instead.
 */
function waitForChange(dir, timeoutMs, opts = {}) {
    if (opts.signal?.aborted)
        return Promise.resolve('aborted');
    if (!(timeoutMs > 0))
        return Promise.resolve('timeout');
    return new Promise((resolve) => {
        let done = false;
        let watcher = null;
        let timer = null;
        const deadline = Date.now() + timeoutMs;
        const fallbackMs = Math.min(opts.fallbackMs ?? 500, timeoutMs);
        const closeWatcher = () => {
            if (watcher === null)
                return;
            const w = watcher;
            watcher = null;
            try {
                w.close();
            }
            catch { /* already closed */ }
        };
        const finish = (why) => {
            if (done)
                return;
            done = true;
            if (timer !== null)
                clearTimeout(timer);
            opts.signal?.removeEventListener('abort', onAbort);
            closeWatcher();
            resolve(why);
        };
        const fallBack = () => {
            if (done)
                return;
            closeWatcher();
            if (timer !== null)
                clearTimeout(timer);
            const delay = Math.min(fallbackMs, Math.max(0, deadline - Date.now()));
            timer = setTimeout(() => finish('polled'), delay);
        };
        const onAbort = () => finish('aborted');
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        try {
            watcher = watch(dir, { persistent: false }, () => finish('change'));
            watcher.on('error', fallBack);
            timer = setTimeout(() => finish('timeout'), timeoutMs);
        }
        catch {
            fallBack();
        }
    });
}function isTerminal(status) {
    return status === 'succeeded' || status === 'failed' || status === 'canceled';
}const ACCEPTANCE_HOLD_MS = 5 * 60_000;
const GLYPH = { finished: '✓', failed: '✗', cancelled: '■', attention: '!' };
function compactExcerpt(value, max) {
    const text = value.replace(/\s+/g, ' ').trim();
    if (text.length <= max)
        return text;
    const prefix = text.slice(0, Math.max(0, max - 1));
    const sentence = [...prefix.matchAll(/[.!?](?=\s)/g)].at(-1)?.index;
    const end = sentence !== undefined && sentence >= max / 2 ? sentence + 1 : prefix.lastIndexOf(' ');
    return `${end > 0 ? prefix.slice(0, end).trimEnd() : ''}…`;
}
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
function chosenName(job) {
    if (!job.name)
        return null;
    return !job.run && job.id.length >= 8 && job.name.endsWith(`-${job.id.slice(-8)}`) ? null : job.name;
}
function who(job) {
    const identity = [job.provider, job.role].filter(Boolean).join(' ');
    const name = chosenName(job);
    if (job.run)
        return name ?? `pipeline ${job.id}`;
    if (name)
        return identity ? `${name} (${identity})` : name;
    return identity ? `${job.id} (${identity})` : `job ${job.id}`;
}
function rejected(job) {
    return job.kind === 'finished' && !job.run && job.checks != null && job.checks.passed < job.checks.total;
}
function headline(job) {
    const d = durationWords(job.durationMs);
    const reason = job.reason ? compactExcerpt(job.reason, 160) : '';
    const bad = rejected(job);
    const awaiting = job.kind === 'finished' && !job.run && !bad && job.checksRunning !== undefined;
    const glyph = bad ? GLYPH.failed : awaiting ? '…' : GLYPH[job.kind];
    const parts = [`${glyph} ${who(job)}`];
    switch (job.kind) {
        case 'finished':
            if (job.run)
                parts.push(reason || 'done');
            else if (bad)
                parts.push(checksReason(job.checks?.failed ?? []));
            else if (awaiting) {
                parts.push('exited', typeof job.checksRunning === 'string' ? `checks running: ${job.checksRunning}` : 'checks pending');
            }
            else if (job.checks && job.checks.total > 0) {
                parts.push(`checks ${job.checks.passed}/${job.checks.total}`);
            }
            else {
                parts.push('done');
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
    if (d && job.kind !== 'attention')
        parts.push(d);
    if (job.turns) {
        if (job.turns.from < job.turns.to)
            parts.push(`turns ${job.turns.from}–${job.turns.to}`);
        else if (job.turns.to > 1)
            parts.push(`turn ${job.turns.to}`);
    }
    if (job.steerNotApplied)
        parts.push(`queued follow-up not sent${job.droppedMessage ? `: "${compactExcerpt(job.droppedMessage, 80)}"` : ''}`);
    if (job.staleReads && job.staleReads.length > 0) {
        const first = job.staleReads[0];
        const extra = job.staleReads.length > 1 ? ` +${job.staleReads.length - 1}` : '';
        parts.push(`stale brief: ${first}${extra}`);
    }
    return parts.join(' · ');
}
const CLAUDE_JOBS = 8;
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
    const ids = (run) => listed.filter((j) => !!j.run === run).map((j) => (run ? j.id : j.workerId ?? j.id));
    if (ids(false).length > 0)
        lines.push(`status ${ids(false).join(', ')}`);
    if (ids(true).length > 0)
        lines.push(`pipeline_status ${ids(true).join(', ')}`);
    return lines.join('\n');
}
function shown(counts) {
    return ['done', 'exited', 'failed', 'canceled', 'no output', 'process gone'].flatMap((k) => (counts.has(k) ? [[k, counts.get(k)]] : []));
}
const STATE = {
    finished: 'done', failed: 'failed', cancelled: 'canceled', attention: 'no output',
};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
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
    if (isObj(response['_meta']) && response['_meta']['io.agent-smith/task-result'] === true)
        return null;
    if (isObj(response['structuredContent']))
        return response['structuredContent'];
    if (Array.isArray(response['content']))
        return unwrapResponse(response['content'], depth + 1);
    return response;
}
const LAUNCH = { spawn_job: 'job', follow_up: 'job', steer: 'job', run_pipeline: 'run' };
function launchKind(toolName) {
    if (typeof toolName !== 'string')
        return null;
    const bare = toolName.includes('__') ? toolName.slice(toolName.lastIndexOf('__') + 2) : toolName;
    return LAUNCH[bare] ?? null;
}
const trimSlash = (p) => p.replace(/\/+$/, '');
function repoAbove(file, dir) {
    const parts = trimSlash(file).split('/');
    return parts.length >= 3 && parts.at(-2) === dir && parts.at(-3) === '.agent-smith' ? parts.slice(0, -3).join('/') || '/' : null;
}
function claimMarkerPath(repo, kind, id) {
    return `${repo.replace(/\/+$/, '')}/.agent-smith/claims/${kind}-${encodeURIComponent(id)}`;
}
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
    const workerId = kind === 'job' && typeof payload['workerId'] === 'string' && payload['workerId'].length > 0
        ? payload['workerId'] : undefined;
    let repo = null;
    if (typeof payload['repo'] === 'string' && payload['repo'].length > 0)
        repo = trimSlash(payload['repo']);
    else if (kind === 'job' && typeof payload['dir'] === 'string')
        repo = repoAbove(payload['dir'], 'jobs');
    else if (kind === 'run' && typeof payload['recordPath'] === 'string')
        repo = repoAbove(payload['recordPath'], 'pipelines');
    const t = payload['timeoutMs'];
    return {
        kind,
        id,
        ...(workerId !== undefined ? { workerId } : {}),
        ...(payload['action'] === 'started' ? { startsTurn: true } : {}),
        repo,
        timeoutMs: typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : null,
    };
}
function droppedMessageQuote(message) {
    if (typeof message !== 'string')
        return null;
    const m = /"([^"\n]+)|“([^”\n]+)/.exec(message);
    const text = (m?.[1] ?? m?.[2] ?? '').trim();
    return text === '' ? null : text;
}
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
}const STALL_GRACE_MS = 15 * 60 * 1000;
const ALIVE_GRACE_MS = 2 * 60_000;
const LIVENESS_STATES = ['active', 'in-tool', 'waiting', 'silent', 'dead'];
function epoch(v) {
    if (typeof v === 'number')
        return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string' || v === '')
        return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
}
function livenessOf(i) {
    if (i.status !== 'running' && i.status !== 'attention')
        return null;
    const times = [epoch(i.lastEventAt), epoch(i.updatedAt)].filter((t) => t !== null);
    const lastSeen = times.length > 0 ? Math.max(...times) : null;
    const silentForMs = lastSeen === null ? 0 : Math.max(0, i.now - lastSeen);
    const alive = epoch(i.lastAliveAt);
    const a = i.lastActivity;
    const open = a != null && a.status === 'active' && typeof a.tool === 'string' && a.tool !== '';
    const tool = open ? toolLabel(a.tool, typeof a.input === 'string' ? a.input : null) : undefined;
    const withTool = tool === undefined ? {} : { tool };
    if (alive !== null && i.now - alive > ALIVE_GRACE_MS)
        return { state: 'dead', silentForMs, since: alive, forMs: i.now - alive, ...withTool };
    if (lastSeen === null)
        return { state: 'silent', silentForMs, since: null, forMs: silentForMs, ...withTool };
    if (alive === null && silentForMs > STALL_GRACE_MS)
        return { state: 'silent', silentForMs, since: lastSeen, forMs: silentForMs, ...withTool };
    if (open)
        return { state: 'in-tool', silentForMs, since: lastSeen, forMs: silentForMs, ...withTool };
    if (silentForMs > STALL_GRACE_MS)
        return { state: 'silent', silentForMs, since: lastSeen, forMs: silentForMs };
    return { state: 'active', silentForMs, since: lastSeen, forMs: silentForMs };
}export{ACCEPTANCE_HOLD_MS as A,LIVENESS_STATES as L,claudeText as a,pipelineOutcome as b,claimMarkerPath as c,droppedMessageQuote as d,livenessOf as l,parseLaunches as p,unwrapResponse as u,waitForChange as w};