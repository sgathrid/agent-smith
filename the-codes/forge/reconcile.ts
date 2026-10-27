/** Service-owned recovery of abandoned jobs. Readers never write job records. */
import { existsSync, readFileSync } from 'node:fs';
import { REASONS } from '../surfaces/mod/hooks/reasons.ts';
import { FILES, SCHEMA_VERSION, cwdFacts, deriveOrphan, failureFields, deriveStatus, isPidAlive, jobFile, type ForgeManifest } from './format.ts';
import { writeAtomic, writeJsonAtomic } from './atomic.ts';
import { readAcceptance, writeAcceptance } from './checks.ts';
import { reportFor, summaryTail } from './writer.ts';
import type { JobResult } from '../providers/types.ts';

/**
 * A dead recorded supervisor cannot complete another write. Do not persist the
 * timeout heuristic for PID-less legacy jobs: their writer may still be alive.
 * Re-read the anchor and result immediately before writing, without yielding,
 * so an already published completion always wins. Concurrent recovery passes
 * may publish the same verdict; neither can replace a terminal anchor.
 */
export function reconcileOrphan(repo: string, jobId: string, now = Date.now()): boolean {
  const file = jobFile(repo, jobId, FILES.job);
  try {
    const before = readFileSync(file, 'utf8');
    const manifest = JSON.parse(before) as ForgeManifest;
    if (manifest.schema !== SCHEMA_VERSION || manifest.jobId !== jobId
        || !Number.isInteger(manifest.ownerPid) || typeof manifest.ownerPid !== 'number' || manifest.ownerPid <= 0
        || isPidAlive(manifest.ownerPid)) return false;
    if (manifest.status !== 'running') {
      if (['succeeded', 'failed', 'canceled'].includes(manifest.status)
          && typeof manifest.finishedAt === 'string') settleAcceptance(repo, jobId, manifest.finishedAt);
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
    if (verdict === null) return false;
    if (readFileSync(file, 'utf8') !== before || isPidAlive(manifest.ownerPid)
        || readOptional(resultFile) !== resultBefore
        || (existsSync(cancelFile) || existsSync(cancelSteerFile)) !== canceled) return false;
    if (result !== null) {
      // The provider persisted completion before the supervisor published its
      // anchor. Restore the same report/verdict, without replaying checks or
      // claiming that finish-time git attribution was captured.
      writeAtomic(jobFile(repo, jobId, FILES.report), report ?? '');
      if (readFileSync(file, 'utf8') !== before || isPidAlive(manifest.ownerPid)
          || readOptional(resultFile) !== resultBefore
          || (existsSync(cancelFile) || existsSync(cancelSteerFile)) !== canceled) return false;
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
        usage: result.usage === undefined ? null : Object.fromEntries(
          Object.entries(result.usage).filter((entry) => typeof entry[1] === 'number')),
        // The conclusion is at the end of the response (same rule as writer.finish).
        latestSummary: summaryTail(result.response, 1_000) || manifest.latestSummary || null,
        summarySource: result.response.trim() || manifest.latestSummary ? 'worker' : null,
        // Recovery never runs the finish-time git diff.
        changedFilesUnknown: true,
        ...(facts.cwdMissing ? { cwdMissingAtFinish: true } : {}),
      });
      settleAcceptance(repo, jobId, result.finishedAt);
      return true;
    }
    const at = new Date(now).toISOString();
    writeJsonAtomic(file, {
      ...manifest, status: verdict.status, error: verdict.reason,
      reason: verdict.status === 'failed' ? REASONS.serverStopped : null, jobStatus: 'orphaned',
      updatedAt: at, finishedAt: at,
    });
    settleAcceptance(repo, jobId, at);
    return true;
  } catch { return false; } // An unreadable anchor remains unknown; do not invent it.
}

function settleAcceptance(repo: string, jobId: string, at: string): void {
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
function editedOnDisk(repo: string, jobId: string): boolean {
  try {
    const p = JSON.parse(readFileSync(jobFile(repo, jobId, FILES.progress), 'utf8')) as { editsCompleted?: unknown; digest?: { editedCount?: unknown } };
    if (typeof p.editsCompleted === 'number') return p.editsCompleted > 0;
    return typeof p.digest?.editedCount === 'number' && p.digest.editedCount > 0;
  } catch { return false; }
}

/** Missing or partially written provider output cannot keep a dead job running. */
function readOptional(file: string): string | null {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

function recoverableResult(body: string | null, manifest: ForgeManifest): JobResult | null {
  if (body === null) return null;
  try {
    const result = JSON.parse(body) as JobResult;
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
          || Array.isArray(result.usage)))) return null;
    return result;
  } catch { return null; }
}

/** Older running anchors did not persist the provider's started-event identity. */
function recoveredConversation(result: JobResult): string | null {
  if (result.raw === null || typeof result.raw !== 'object') return null;
  const raw = result.raw as Record<string, unknown>;
  const key = result.provider === 'agy' ? 'conversation_id'
    : result.provider === 'codex' ? 'threadId'
      : result.provider === 'claude' || result.provider === 'opencode' || result.provider === 'kimi' ? 'sessionId' : null;
  const value = key === null ? null : raw[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
