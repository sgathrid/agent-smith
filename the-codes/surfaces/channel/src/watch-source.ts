/**
 * watch-source.ts — the channel's read of agy-staff job state.
 *
 * Deliberately a thin adapter over the same harness reader the mod pane uses, so
 * the two surfaces CANNOT disagree about a job's state. That is the whole claim
 * in docs/ARCHITECTURE.md: "two surfaces cost one implementation". If this file
 * had its own status rules, the channel could announce a failure the pane draws
 * as a success, and there would be no way for a user to tell which one is lying.
 *
 * COUPLING NOTE: imports harness/, does not modify it. Same three imports as the
 * mod's job-source.ts:
 *   AgyStaffReader, normalize, stripSystemNotifications.
 *
 * Unlike the mod, this surface may use third-party packages (it has the MCP SDK).
 * It still does not need anything else: harness is Node-builtins-only, and that is
 * the entire dependency graph of a reader.
 *
 * WHY THE HAZARDS ARE HANDLED BY DELEGATING RATHER THAN REPEATED:
 *   A. progress.json deleted on clean success → harness anchors on
 *      result.md.status.json, and we never read progress for terminal state.
 *   B. .spec.json.cancel marker → harness folds it into ObservedStatus before
 *      status.json is even consulted.
 *   C. polluted result.md → harness's reader strips <system_notification> blocks
 *      before the payload is built.
 *
 * Re-implementing any of these here would create a second source of truth for the
 * exact failures that are hardest to debug. One place, one answer.
 */

import path from 'node:path';

import { AgyStaffReader } from '../../../harness/agy-staff.ts';
import { normalize } from '../../../harness/normalize.ts';
import { existsSafe } from '../../../harness/safe-fs.ts';
import type { ObservedJob } from '../../../harness/types.ts';
// Cross-surface import, and deliberately so. The mod ships as a STANDALONE plugin
// directory — it cannot reach outside its own folder — so it has to own any
// constant the channel also needs. One owner, two importers, no drift. The same
// reasoning puts the dedupe rules in ./policy.ts rather than in the server: the
// server is the only thing that could not be reused.
import { STALL_GRACE_MS } from '../../mod/hooks/stale.ts';
import type { WatchableJob, WatchStatus } from './policy.ts';

const READER = new AgyStaffReader();

/** Jobs live at `<repo>/.agy-staff/jobs/`. */
const JOBS_DIR = ['.agy-staff', 'jobs'];

/** One read of every job. Never throws; an unreadable directory yields []. */
export async function readAll(cwd: string, now: number = Date.now()): Promise<WatchableJob[]> {
  if (!(await existsSafe(path.join(cwd, ...JOBS_DIR)))) return [];

  let ids: string[];
  try {
    ids = await READER.discover(cwd);
  } catch {
    return [];
  }

  const out: WatchableJob[] = [];
  // Sequential, for the same reason the pane reads serially: agy-staff is
  // rewriting these files right now, and a burst of parallel readers maximises
  // the chance of catching one mid-write. safe-fs tolerates it either way, but
  // tolerating is not the same as not happening.
  for (const id of ids) {
    const job = await readOne(cwd, id, now);
    if (job !== null) out.push(job);
  }
  return out;
}

/**
 * One job, projected onto the minimal shape the policy reasons about.
 *
 * We project down to five fields on purpose. The policy module has no access to
 * the provider payload, so it CANNOT accidentally start depending on it, and a
 * reader change cannot silently alter what gets pushed into someone's context.
 */
async function readOne(cwd: string, jobId: string, now: number): Promise<WatchableJob | null> {
  let observed: ObservedJob;
  try {
    const raw = await READER.read(cwd, jobId);
    if (raw === null) return null;
    observed = normalize(raw);
  } catch {
    return null;
  }

  // `warned` covers both sources harness tracks: the status.json warnings flag
  // and the progress.json warning strings. We only need the boolean, because the
  // message we push says "with warnings" and nothing more.
  const warned =
    observed.warnings.some((w) => w.code === 'suspicious_success' || w.code === 'tool_error') ||
    observed.warnings.length > 0;

  return {
    id: observed.jobId,
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
export function toWatchStatus(observed: ObservedJob, now: number): WatchStatus {
  if (observed.status !== 'running') return observed.status;
  if (observed.updatedAt === null) {
    // No evidence of progress at all. Treat as needing eyes rather than healthy:
    // "we do not know" must never be drawn as "fine" (the asymmetry
    // core/liveness.ts documents).
    return 'attention';
  }
  const then = Date.parse(observed.updatedAt);
  if (Number.isNaN(then)) return 'attention';
  return now - then > STALL_GRACE_MS ? 'attention' : 'running';
}