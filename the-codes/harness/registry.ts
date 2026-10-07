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

import { AgyStaffReader } from "./agy-staff.ts";
import { ClaudeCodeReader } from "./claude-code.ts";
import { normalize } from "./normalize.ts";
import type { JobStateReader, ObservedJob } from "./types.ts";

/** All readers, keyed by provider name. Constructed once and reused. */
const READERS: ReadonlyMap<string, JobStateReader> = new Map<string, JobStateReader>([
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
 * Unknown/errored entries are dropped (the provider-level `error` already
 * carries the diagnostic from discoverAll).
 */
export async function readAllObservedJobs(cwd: string): Promise<ObservedJob[]> {
  const sweeps = await discoverAll(cwd);
  const reads = await Promise.all(
    sweeps.flatMap((s) => s.jobIds.map(async (jobId): Promise<ObservedJob | null> => {
      return readObservedJob(s.provider, cwd, jobId);
    })),
  );
  return reads.filter((j): j is ObservedJob => j !== null);
}

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