/**
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

import {
  type Batch,
  type Candidate,
  assertMetaSafe,
  buildBatch,
  dedupeKey,
  pushKindFor,
} from './policy.ts';
import type { WatchableJob } from './policy.ts';
import { readAll } from './watch-source.ts';

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
const announced = new Map<string, Set<string>>();

/** Job ids present in the previous poll. Drives the `knownBefore` flag. */
let previouslyPresent = new Set<string>();

/** False until the first poll completes. */
let primed = false;

/** Testing hook. Resets all dedupe state between cases. */
export function resetPoller(): void {
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
export async function pollOnce(
  cwd: string,
  now: number,
  send: (batch: Batch) => Promise<void>,
  read: (cwd: string, now: number) => Promise<WatchableJob[]> = readAll,
): Promise<void> {
  let jobs: WatchableJob[];
  try {
    jobs = await read(cwd, now);
  } catch {
    // A read that throws means the directory is mid-rewrite. Staying silent for
    // one tick is strictly better than announcing a half-read state.
    return;
  }

  const present = new Set(jobs.map((j) => j.id));
  const candidates: Candidate[] = jobs.map((job) => ({
    job,
    seen: announced.get(job.id) ?? new Set<string>(),
    knownBefore: previouslyPresent.has(job.id),
  }));

  const batch = buildBatch(candidates, now);

  if (!primed) {
    // Baseline. Note we record EVERY pushable state we see, including attention —
    // otherwise a job that was already stalled at startup would be announced the
    // moment its key changed for an unrelated reason.
    for (const c of candidates) {
      if (pushKindFor(c.job) !== null) remember(c.job.id, dedupeKey(c.job));
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
    if (id !== null) remember(id, key);
  }

  previouslyPresent = present;
}

/** batch keys are `id#status#epoch`. agy job ids contain no '#', so this is exact. */
function jobIdForKey(key: string): string | null {
  const i = key.indexOf('#');
  return i === -1 ? null : key.slice(0, i);
}

function remember(jobId: string, key: string): void {
  const set = announced.get(jobId);
  if (set) set.add(key);
  else announced.set(jobId, new Set([key]));
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
export const POLL_MS = 5_000;

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
export function scheduleLoop(
  cwd: string,
  intervalMs: number,
  send: (batch: Batch) => Promise<void>,
  onError: (err: unknown) => void,
): void {
  const tick = (): void => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await pollOnce(cwd, Date.now(), send);
        } catch (err) {
          // One bad poll must not kill the channel. A crash here takes the MCP
          // server down and Claude Code sees the channel vanish with no
          // explanation. Report on stderr: stdout is the protocol channel and
          // writing to it corrupts the JSON-RPC stream.
          onError(err);
        } finally {
          tick();
        }
      })();
    }, intervalMs);
    timer.unref?.();
  };
  tick();
}