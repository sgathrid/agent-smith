/**
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
 * reader wins the id, here and in forge/service.ts, by the same rule.
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

import path from 'node:path';

import { AgentSmithReader } from '../../../harness/agent-smith.ts';
import { AgyStaffReader } from '../../../harness/agy-staff.ts';
import { normalize } from '../../../harness/normalize.ts';
import { existsSafe, readdirSafe, readJsonSafe } from '../../../harness/safe-fs.ts';
import { pipelineRecordPath, type PipelineRecord } from '../../../forge/execute.ts';
import type { JobStateReader, ObservedJob } from '../../../harness/types.ts';
import { isForgeJobId, isTerminalForgeStatus } from '../../../forge/format.ts';
import { readAcceptance } from '../../../forge/checks.ts';
// Cross-surface import, and deliberately so. The mod ships as a STANDALONE plugin
// directory — it cannot reach outside its own folder — so it has to own any
// constant the channel also needs. One owner, two importers, no drift. The same
// reasoning puts the dedupe rules in ./policy.ts rather than in the server: the
// server is the only thing that could not be reused.
import { isStalled, livenessOf, type Liveness } from '../../mod/hooks/stale.ts';
import { ACCEPTANCE_HOLD_MS, pipelineOutcome } from '../../mod/hooks/notice.ts';
import type { WatchableJob, WatchStatus } from './policy.ts';

/** Our own jobs directory. Read first, so it claims ids before interop sees them. */
const OWN_JOBS_DIR = ['.agent-smith', 'jobs'];

/** agy-staff's jobs directory, read second, for history. */
const INTEROP_JOBS_DIR = ['.agy-staff', 'jobs'];

/**
 * Terminal jobs/pipelines already read, keyed by `cwd\0id`. A terminal verdict is
 * final for the purposes of this reader, so the full scan skips re-reading them.
 * Only the cheap directory listing is repeated each poll.
 */
const terminalCache = new Map<string, WatchableJob>();

/** Testing hook. */
export function clearReadCache(): void {
  terminalCache.clear();
}

/**
 * Acceptance checks run AFTER the job goes terminal, so for a moment a finished job
 * carries a pending acceptance placeholder. Announcing it then reports `unchecked`
 * and the real verdict lands unannounced. Hold the announcement while the
 * placeholder is pending, but never longer than ACCEPTANCE_HOLD_MS (owned by the
 * mod's notice.ts, which applies the same hold).
 */
export { ACCEPTANCE_HOLD_MS };

function acceptancePending(cwd: string, job: WatchableJob, now: number): boolean {
  if (job.finishedAt === null) return false;
  const finished = Date.parse(job.finishedAt);
  const placeholder = readAcceptance(cwd, job.id) as PendingAcceptance;
  if (placeholder.pending !== true) return false;
  const budget = typeof placeholder.budgetMs === 'number' && placeholder.budgetMs > 0 ? placeholder.budgetMs : ACCEPTANCE_HOLD_MS;
  return !(Number.isFinite(finished) && now - finished > budget);
}
/** Acceptance placeholder fields the hold and the notice read. */
type PendingAcceptance = { pending?: boolean; budgetMs?: unknown; running?: unknown };

const isTerminal = (job: WatchableJob): boolean =>
  isTerminalForgeStatus(job.status) && job.finishedAt !== null;

function cacheKey(cwd: string, id: string): string {
  return `${cwd}\0${id}`;
}

/** Project a pipeline record onto the watchable shape; null for a malformed record. */
export function pipelineToWatchable(run: PipelineRecord | null): WatchableJob | null {
  if (!run || typeof run.runId !== 'string' || typeof run.pipeline !== 'string' ||
      !Number.isFinite(run.startedAt) || (run.finishedAt !== null && !Number.isFinite(run.finishedAt)) ||
      !['running', 'passed', 'partial', 'failed'].includes(run.status) ||
      run.stageResults === null || typeof run.stageResults !== 'object') return null;
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
export async function readPipelineRecord(cwd: string, runId: string): Promise<{ job: WatchableJob; stageJobIds: string[] } | null> {
  const run = await readJsonSafe<PipelineRecord>(pipelineRecordPath(cwd, runId));
  const job = pipelineToWatchable(run);
  if (job === null || run === null) return null;
  const stageJobIds = Object.values(run.stageResults).flatMap(s => (s && typeof s.jobId === 'string' ? [s.jobId] : []));
  return { job, stageJobIds };
}

/** Read exactly one job by id from either source (primary first). Never throws. */
export async function readJob(cwd: string, jobId: string, now: number = Date.now()): Promise<WatchableJob | null> {
  const own = await readOne(new AgentSmithReader(), 'agent-smith', cwd, jobId, now);
  // A watcher polls until the job settles: while its checks are inside their budget it is still in flight.
  if (own !== null && isTerminal(own) && acceptancePending(cwd, own, now)) return { ...own, status: 'running', finishedAt: null };
  return own ?? (await readOne(new AgyStaffReader(), 'agy-staff', cwd, jobId, now));
}

/** One read of every job. Never throws; an unreadable directory yields []. */
export async function readAll(cwd: string, now: number = Date.now()): Promise<WatchableJob[]> {
  const claimed = new Set<string>();
  const out: WatchableJob[] = [];

  // Primary first. `discover` returns [] for a repo that has never spawned, which
  // is the ordinary case and not an error — that is why the existsSafe pre-check
  // below is a cost we only pay when we are going to read anyway.
  await collect(new AgentSmithReader(), 'agent-smith', cwd, now, claimed, out, () => false);
  await collect(new AgyStaffReader(), 'agy-staff', cwd, now, claimed, out, isForgeJobId);

  // Pipeline acceptance happens after harness execution. Announce its own
  // terminal transition so a failing check cannot be hidden by a green job.
  const runs = path.join(cwd, '.agent-smith', 'pipelines');
  for (const file of await readdirSafe(runs)) {
    if (!file.endsWith('.json')) continue;
    const cached = terminalCache.get(cacheKey(cwd, `pipeline:${file}`));
    if (cached) { out.push(cached); continue; }
    const job = pipelineToWatchable(await readJsonSafe<PipelineRecord>(path.join(runs, file)));
    if (job === null) continue;
    if (isTerminal(job)) terminalCache.set(cacheKey(cwd, `pipeline:${file}`), job);
    out.push(job);
  }

  return out;
}

/** Read one source's jobs, skipping ids another source already claimed. */
async function collect(
  reader: JobStateReader,
  source: 'agent-smith' | 'agy-staff',
  cwd: string,
  now: number,
  claimed: Set<string>,
  out: WatchableJob[],
  skip: (jobId: string) => boolean,
): Promise<void> {
  const dir = source === 'agent-smith' ? OWN_JOBS_DIR : INTEROP_JOBS_DIR;
  if (!(await existsSafe(path.join(cwd, ...dir)))) return;

  let ids: string[];
  try {
    ids = await reader.discover(cwd);
  } catch {
    return;
  }

  // Sequential, for the same reason the pane reads serially: these files are
  // being rewritten right now, and a burst of parallel readers maximises the
  // chance of catching one mid-write. safe-fs tolerates it either way, but
  // tolerating is not the same as not happening.
  for (const id of ids) {
    if (claimed.has(id)) continue;
    if (skip(id)) continue;
    claimed.add(id);
    const cached = terminalCache.get(cacheKey(cwd, id));
    if (cached) { out.push(cached); continue; }
    const job = await readOne(reader, source, cwd, id, now);
    if (job === null) continue;
    if (isTerminal(job) && acceptancePending(cwd, job, now)) {
      // Not cached and not emitted: re-read next poll, once the verdict is written.
      claimed.delete(id);
      continue;
    }
    // Past its hold with checks still running: re-read next poll so the verdict is announced too.
    if (isTerminal(job) && job.checksRunning === undefined) terminalCache.set(cacheKey(cwd, id), job);
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
async function readOne(
  reader: JobStateReader,
  source: 'agent-smith' | 'agy-staff',
  cwd: string,
  jobId: string,
  now: number,
): Promise<WatchableJob | null> {
  let observed: ObservedJob;
  try {
    const raw = await reader.read(cwd, jobId);
    if (raw === null) return null;
    observed = normalize(raw);
  } catch {
    return null;
  }

  // `warned` covers both sources harness tracks: a recorded failure reason and
  // any warning strings the provider reported. The notice states the failure
  // reason itself (`failureReason`), so only the boolean is kept here.
  const warned = observed.warnings.length > 0;
  const raw = observed.raw;
  const acceptance = source === 'agent-smith' ? readAcceptance(cwd, observed.jobId) as PendingAcceptance & { checks?: readonly { ok?: unknown; name?: unknown }[] } : {};
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
    failureReason: [raw['reason'], raw['error']].find((v): v is string => typeof v === 'string' && v !== '') ?? null,
    failureDetail: typeof raw['error'] === 'string' ? raw['error'] : null,
    checks,
    ...(source === 'agent-smith' && observed.status === 'succeeded' && acceptance.pending === true
      ? { checksRunning: typeof acceptance.running === 'string' && acceptance.running !== '' ? acceptance.running : true as const } : {}),
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
      ? { staleReads: raw['staleReads'].filter((f): f is string => typeof f === 'string' && f.trim() !== '') }
      : {}),
  };
}

/**
 * The shared liveness rule (mod/hooks/stale.ts) over an observed job: event
 * silence, the open tool call and the process owner's heartbeat. Null unless running.
 */
export function watchLiveness(observed: ObservedJob, now: number): Liveness | null {
  const raw = observed.raw;
  const activity = raw['last_activity'];
  return livenessOf({
    status: observed.status, updatedAt: observed.updatedAt, now,
    lastEventAt: typeof raw['last_event_at'] === 'string' ? raw['last_event_at'] : null,
    lastAliveAt: typeof raw['last_alive_at'] === 'string' ? raw['last_alive_at'] : null,
    lastActivity: activity !== null && typeof activity === 'object' ? activity as { tool?: unknown; input?: unknown; status?: unknown } : null,
  });
}

/** Only the quiet states travel to the notice: they are what `attention` means. */
function livenessField(l: Liveness | null): { liveness?: { state: 'silent' | 'dead'; silentForMs: number; since: number | null; tool?: string } } {
  if (l === null || (l.state !== 'silent' && l.state !== 'dead')) return {};
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
export function toWatchStatus(observed: ObservedJob, now: number): WatchStatus {
  if (observed.status !== 'running') return observed.status;
  // silent or dead needs eyes; active and in-tool (a long command) do not. No
  // event time at all is `silent`: "we do not know" is never drawn as "fine".
  return isStalled(watchLiveness(observed, now)) ? 'attention' : 'running';
}
