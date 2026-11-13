/**
 * registry.ts — `readObservedJob()`, one fault-isolating read of one job.
 *
 * WHY FAULT ISOLATION MATTERS: readers read state a live worker is rewriting. A
 * reader that throws (bad symlink, exotic errno) must degrade to an `unknown`
 * job, never to a crashed band. Every call here is wrapped.
 */

import { AgentSmithReader } from "./agent-smith.ts";
import { normalize } from "./normalize.ts";
import type { JobStateReader, ObservedJob } from "./types.ts";

const READER: JobStateReader = new AgentSmithReader();

/**
 * Read + normalize one job, isolating failures.
 *
 * Returns `null` if the reader returns null (job not known to it), and an
 * `unknown` job if either the read or the normalize threw. A throw here
 * is a bug we want visible in tests, but it must not take down a caller that
 * is polling every 100ms.
 */
export async function readObservedJob(
  cwd: string,
  jobId: string,
): Promise<ObservedJob | null> {
  const provider = READER.provider;
  let raw;
  try {
    raw = await READER.read(cwd, jobId);
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
