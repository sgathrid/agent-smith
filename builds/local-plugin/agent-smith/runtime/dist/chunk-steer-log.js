import {readFileSync,existsSync,mkdirSync,appendFileSync}from'node:fs';import {b as jobFile,F as FILES,S as SCHEMA_VERSION,x as validOwnerPid,o as ownerAlive,i as isTerminalForgeStatus,h as reportFor,y as cwdFacts,z as deriveOrphan,k as deriveStatus,l as writeAtomic,w as writeJsonAtomic,A as summaryTail,B as failureFields,R as REASONS,a as readAcceptance,C as writeAcceptance,j as jobDir}from'./chunk-checks.js';/** Service-owned recovery of abandoned jobs. Readers never write job records. */
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
        // Without the writer, the cwd and the mode (plus the completed-edit count
        // in progress.json) are all recovery can prove about a writing job.
        const facts = cwdFacts(manifest.cwd, manifest.mode, editedOnDisk(repo, jobId));
        const verdict = result === null
            ? deriveOrphan(manifest, null, now, undefined, canceled)
            : deriveStatus({
                alreadyTerminal: canceled || result.status === 'cancelled' ? 'canceled' : null,
                ok: result.ok, jobStatus: result.status,
                deniedActions: result.deniedActions ?? [], report,
                ...facts,
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
                // The conclusion is at the end of the response (same rule as writer.finish).
                latestSummary: summaryTail(result.response, 1_000) || manifest.latestSummary || null,
                summarySource: result.response.trim() || manifest.latestSummary ? 'worker' : null,
                // Recovery never runs the finish-time git diff.
                changedFilesUnknown: true,
                ...(facts.cwdMissing ? { cwdMissingAtFinish: true } : {}),
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
/**
 * progress.json recorded at least one completed edit (evidence the job wrote).
 * `editsCompleted` counts only edits that ended without error; the digest's
 * `editedCount` counts at start and is read only for files written before the
 * counter existed.
 */
function editedOnDisk(repo, jobId) {
    try {
        const p = JSON.parse(readFileSync(jobFile(repo, jobId, FILES.progress), 'utf8'));
        if (typeof p.editsCompleted === 'number')
            return p.editsCompleted > 0;
        return typeof p.digest?.editedCount === 'number' && p.digest.editedCount > 0;
    }
    catch {
        return false;
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
}export{readSteerEntries as a,buildSteeredPrompt as b,appendSteerEntry as c,readSteerHead as d,reconcileOrphan as r};