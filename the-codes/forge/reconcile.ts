/** Service-owned recovery of abandoned jobs. Readers never write job records. */
import { existsSync, readFileSync } from 'node:fs';
import { FILES, SCHEMA_VERSION, deriveOrphan, isPidAlive, jobFile, type ForgeManifest } from './format.ts';
import { writeJsonAtomic } from './atomic.ts';
import { readAcceptance, writeAcceptance } from './checks.ts';

/**
 * A dead recorded supervisor cannot complete another write. Do not persist the
 * timeout heuristic for PID-less legacy jobs: their writer may still be alive.
 * Re-read the anchor and result immediately before writing, without yielding,
 * so an already published completion always wins. Concurrent recovery passes
 * may publish the same failed verdict; neither can replace a terminal anchor.
 */
export function reconcileOrphan(repo: string, jobId: string, now = Date.now()): boolean {
  const file = jobFile(repo, jobId, FILES.job);
  try {
    const before = readFileSync(file, 'utf8');
    const manifest = JSON.parse(before) as ForgeManifest;
    if (manifest.schema === SCHEMA_VERSION && manifest.status === 'failed'
        && manifest.jobStatus === 'orphaned' && manifest.finishedAt !== null) {
      settleAcceptance(repo, jobId, manifest.finishedAt);
      return false;
    }
    if (manifest.schema !== SCHEMA_VERSION || manifest.status !== 'running'
        || typeof manifest.ownerPid !== 'number' || isPidAlive(manifest.ownerPid)
        || existsSync(jobFile(repo, jobId, FILES.result))) return false;
    const verdict = deriveOrphan(manifest, null, now);
    if (verdict === null) return false;
    if (readFileSync(file, 'utf8') !== before || isPidAlive(manifest.ownerPid)
        || existsSync(jobFile(repo, jobId, FILES.result))) return false;
    const at = new Date(now).toISOString();
    writeJsonAtomic(file, {
      ...manifest, status: verdict.status, error: verdict.reason, jobStatus: 'orphaned',
      updatedAt: at, finishedAt: at,
    });
    settleAcceptance(repo, jobId, at);
    return true;
  } catch { return false; } // Partial/unreadable state remains unknown; do not invent it.
}

function settleAcceptance(repo: string, jobId: string, at: string): void {
  const acceptance = readAcceptance(repo, jobId);
  if ('pending' in acceptance && acceptance.pending === true) {
    writeAcceptance(repo, jobId, {
      state: 'rejected', checks: [], at, pending: false,
      reason: 'supervisor exited; acceptance checks not run',
    });
  }
}
