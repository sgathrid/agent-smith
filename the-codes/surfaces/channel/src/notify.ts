/** The completion-notice hint and Tasks handle attached to launch acks. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TIMEOUT_MS } from '../../../forge/service.ts';
import { readAcceptance } from '../../../forge/checks.ts';

/** Advertised Tasks poll cadence. */
const POLL_MS = 5_000;
const MONITOR_CAP_MS = 1_800_000;
/** Past the job's own timeout, a missing notice means none is coming (the hook watches timeout + 60 s). */
const NOTICE_GRACE_MS = 120_000;

/** monitor.js sits at dist/monitor.js; resolvable only when running from the built dist/. */
export function builtMonitorPath(moduleFile = fileURLToPath(import.meta.url)): string | undefined {
  const marker = `${path.sep}dist${path.sep}surfaces${path.sep}channel${path.sep}src${path.sep}`;
  const at = moduleFile.lastIndexOf(marker);
  if (at >= 0) return path.join(moduleFile.slice(0, at), 'dist', 'monitor.js');
  const dir = path.dirname(moduleFile);
  if (path.basename(dir) === 'dist' && path.basename(moduleFile) === 'server.js') {
    return path.join(dir, 'monitor.js');
  }
  return undefined;
}

/** The acceptance budget written at spawn, 0 without checks: the verdict can land this long after the job ends. */
function pendingBudgetMs(repo: string, jobId: string): number {
  const b = (readAcceptance(repo, jobId) as { pending?: boolean; budgetMs?: unknown }).budgetMs;
  return typeof b === 'number' && b > 0 ? b : 0;
}

/**
 * The `notify` hint attached to spawn/resume/pipeline acks. Exported for tests.
 *
 * It states that a notice is coming and keeps the monitor command under
 * `fallback`, behind the one condition that calls for it: an agent handed a
 * runnable command at the top level of an ack runs it at once, and then hears
 * about the job twice.
 */
export function notifyHint(target: { job: string } | { run: string }, repo: string, timeoutMs: number | undefined, monitorFile = builtMonitorPath()) {
  const job = 'job' in target;
  const note = `You will be notified when this ${job ? 'job' : 'run'} ends. Silence until then is normal: don't poll or start a monitor.`;
  const noNotice = job
    ? `no notice has arrived ${Math.ceil(((timeoutMs ?? DEFAULT_TIMEOUT_MS) + pendingBudgetMs(repo, target.job) + NOTICE_GRACE_MS) / 60_000)} min after launch`
    : 'pipeline_status shows the run ended and no notice arrived';
  const when = `Only if ${noNotice}, this session can't receive messages between turns (headless), ` +
    'or you are a subagent that must return this result before your turn ends.';
  const read = job ? 'Call status with wait_ms until it settles' : 'Call pipeline_status until the run ends';
  if (!monitorFile) return { mode: 'hook' as const, note, fallback: { when, use: `${read}.` } };
  const flag = job ? `--job ${target.job}` : `--run ${target.run}`;
  return { mode: 'hook' as const, note, fallback: { when, use: `${read}, or run monitorCommand in the background (it stops after monitorTimeoutMs; run it again if the ${job ? 'job' : 'run'} has not ended).`,
    monitorCommand: `node "${monitorFile}" ${flag} --cwd "${repo}"`, monitorTimeoutMs: Math.min(timeoutMs ?? MONITOR_CAP_MS, MONITOR_CAP_MS) } };
}

/**
 * Tasks-shaped handle for a launch ack (vocabulary in views.ts taskStatus). pollIntervalMs is the
 * server's own poll cadence: job state changes are not observed faster than that, so checking more often gains nothing.
 */
export function launchTask(taskId: string) { return { taskId, status: 'working' as const, pollIntervalMs: POLL_MS }; }
