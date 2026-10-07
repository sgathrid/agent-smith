/**
 * registry.ts — name → reader map, and `discoverAll()`.
 *
 * The registry is intentionally tiny. Its whole job is:
 *   1. hold the set of known readers so core can look one up by provider name
 *   2. fan a single `discoverAll(cwd)` across every reader without letting one
 *      broken/missing provider break the others
 *
 * WHY PER-READER FAULT ISOLATION MATTERS: readers read other people's mutable
 * state on other people's machines. A reader that throws (bad symlink, exotic
 * errno, a Claude Code version with a new layout) must degrade to "that
 * provider contributed nothing this tick" — never to "the mod band crashed".
 * So every call here is wrapped, and a failure becomes an empty contribution.
 */

import { AgentSmithReader } from "./agent-smith.ts";
import { AgyStaffReader } from "./agy-staff.ts";
import { ClaudeCodeReader } from "./claude-code.ts";
import { normalize } from "./normalize.ts";
import { isForgeJobId } from "../forge/format.ts";
import type { JobStateReader, ObservedJob } from "./types.ts";

/**
 * All readers, keyed by provider name. Constructed once and reused.
 *
 * THE ORDER IS THE PRIORITY ORDER, AND THAT IS A DECISION, NOT ALPHABETICAL:
 *
 *   "agent-smith"  PRIMARY.   Every job this repo spawned. Authoritative.
 *   "agy-staff"    INTEROP.   Somebody else's layout, read-only. Kept so the 20
 *                             real jobs under renyi/.agy-staff/jobs stay visible
 *                             and so any future worker that writes that shape is
 *                             picked up for free.
 *   "claude-code"  TRANSCRIPT. Claude Code subagent transcripts.
 *
 * WHY agent-smith COMES FIRST — and why that matters beyond tidiness:
 * forge/mirror.ts projects our jobs into `.agy-staff/jobs/` so an UNMODIFIED mod
 * plugin can render them (see that file's header for why the projection is the
 * only route to the acceptance criterion). The consequence is that the
 * interop reader's `discover()` also returns our job ids.
 *
 * If both readers contributed a verdict for the same id, every spawned job would
 * be reported twice in a single sweep, from two independently computed states.
 * The channel's dedupe would hide that; nothing else would. So
 * `readAllObservedJobs` below resolves the collision explicitly in favour of the
 * primary reader, and this insertion order is what makes the resolution
 * expressible.
 */
const READERS: ReadonlyMap<string, JobStateReader> = new Map<string, JobStateReader>([
  ["agent-smith", new AgentSmithReader()],
  ["agy-staff", new AgyStaffReader()],
  ["claude-code", new ClaudeCodeReader()],
]);

/** Look up one reader by provider name, or undefined if unknown. */
export function getReader(name: string): JobStateReader | undefined {
  return READERS.get(name);
}

/** Every known provider name. */
export function providerNames(): string[] {
  return [...READERS.keys()].sort();
}

/**
 * One provider's contribution to a discovery sweep.
 *
 * `error` is set when that reader threw. It is surfaced rather than thrown so
 * core can log/repaint instead of crashing.
 */
export interface DiscoveryResult {
  readonly provider: string;
  readonly jobIds: readonly string[];
  readonly error?: string;
}

/**
 * Run `discover` on every registered reader for a cwd, isolating failures.
 *
 * NEVER throws. A provider that fails contributes `error` and no jobIds.
 */
export async function discoverAll(cwd: string): Promise<DiscoveryResult[]> {
  const results = await Promise.all(
    providerNames().map(async (provider): Promise<DiscoveryResult> => {
      const reader = getReader(provider);
      if (reader === undefined) {
        // Unreachable via providerNames(), but keeps the type honest.
        return { provider, jobIds: [], error: "reader missing" };
      }
      try {
        const jobIds = await reader.discover(cwd);
        return { provider, jobIds };
      } catch (err) {
        return { provider, jobIds: [], error: errText(err) };
      }
    }),
  );
  return results;
}

/**
 * Read + normalize one job from one provider, isolating failures.
 *
 * Returns `null` if the provider is unknown, if the reader returns null (job
 * not known to it), or if either the read or the normalize threw. A throw here
 * is a bug we want visible in tests, but it must not take down a caller that
 * is polling every 100ms.
 */
export async function readObservedJob(
  provider: string,
  cwd: string,
  jobId: string,
): Promise<ObservedJob | null> {
  const reader = getReader(provider);
  if (reader === undefined) return null;
  let raw;
  try {
    raw = await reader.read(cwd, jobId);
  } catch (err) {
    // Surface as unknown rather than propagating.
    return unknownJob(provider, jobId, errText(err));
  }
  if (raw === null) return null;
  try {
    return normalize(raw);
  } catch (err) {
    return unknownJob(provider, jobId, `normalize: ${errText(err)}`);
  }
}

/**
 * Read + normalize every job for a cwd, across every provider.
 *
 * UNKNOWN/ERRORED ENTRIES ARE DROPPED (the provider-level `error` from
 * discoverAll carries the diagnostic).
 *
 * COLLISION RULE — one verdict per job id, primary reader wins:
 * the compat mirror in `.agy-staff/jobs/` means the interop reader discovers our
 * own job ids too. Left alone, every job we spawn would be counted twice. So a
 * job id that the PRIMARY reader can read is never also read from a lower-priority
 * reader, and the returned list has at most one entry per id.
 *
 * This is the mechanism behind the architecture's claim that two surfaces cannot
 * disagree about a job's state. Without it they would disagree inside a single
 * sweep, which is strictly worse than disagreeing across two surfaces: there is
 * no second opinion to notice.
 */
export async function readAllObservedJobs(cwd: string): Promise<ObservedJob[]> {
  const sweeps = await discoverAll(cwd);
  const claimed = new Set<string>();
  const reads: Array<Promise<ObservedJob | null>> = [];
  for (const sweep of sweeps) {
    for (const jobId of sweep.jobIds) {
      if (claimed.has(jobId)) continue;
      claimed.add(jobId);
      reads.push(readObservedJob(sweep.provider, cwd, jobId));
    }
  }
  const settled = await Promise.all(reads);
  return settled.filter((j): j is ObservedJob => j !== null);
}

/**
 * Is this job id one agent-smith owns?
 *
 * Re-exported from forge/format.ts rather than duplicated, because the id shape
 * is part of the on-disk contract: the `-smith-` segment is what makes a mirrored
 * id distinguishable from a real agy-staff one, in the band, in a job list, and
 * in the channel's `meta`. Two definitions of it would eventually disagree.
 */
export { isForgeJobId };

/** A defensive `unknown` ObservedJob used when a read/normalize fails. */
function unknownJob(provider: string, jobId: string, detail: string): ObservedJob {
  return {
    provider,
    jobId,
    status: "unknown",
    warnings: [
      { code: "incomplete_state", message: `Failed to read state: ${detail}` },
    ],
    output: null,
    startedAt: null,
    updatedAt: null,
    finishedAt: null,
    mode: null,
    model: null,
    label: null,
    outputTruncated: false,
    usage: null,
    partial: true,
    raw: {},
  };
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}