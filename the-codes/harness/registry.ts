/**
 * registry.ts — provider name → reader, and `readObservedJob()`.
 *
 * Production reads one job at a time (forge/service.ts, via the id's known
 * provider), so this stays tiny: two readers and one fault-isolating read.
 *
 *   "agent-smith"  PRIMARY.  Every job this repo spawned. Authoritative.
 *   "agy-staff"    INTEROP.  Somebody else's layout, read-only. Callers skip
 *                            forge ids here: older versions mirrored our jobs
 *                            into `.agy-staff/jobs/` and copies may remain, so
 *                            two verdicts for one id must never exist.
 *
 * WHY FAULT ISOLATION MATTERS: readers read other people's mutable state. A
 * reader that throws (bad symlink, exotic errno) must degrade to an `unknown`
 * job, never to a crashed band. Every call here is wrapped.
 */

import { AgentSmithReader } from "./agent-smith.ts";
import { AgyStaffReader } from "./agy-staff.ts";
import { normalize } from "./normalize.ts";
import type { JobStateReader, ObservedJob } from "./types.ts";

const READERS: ReadonlyMap<string, JobStateReader> = new Map<string, JobStateReader>([
  ["agent-smith", new AgentSmithReader()],
  ["agy-staff", new AgyStaffReader()],
]);

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
  const reader = READERS.get(provider);
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
