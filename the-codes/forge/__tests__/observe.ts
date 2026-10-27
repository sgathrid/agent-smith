/**
 * Test helper: one verdict per job id across the primary and interop readers.
 * The primary (agent-smith) reader claims forge ids first, so the compat mirror
 * in `.agy-staff/jobs/` does not double-count them. Mirrors the production rule
 * in forge/service.ts and surfaces/channel/src/watch-source.ts.
 */
import { AgentSmithReader } from '../../harness/agent-smith.ts';
import { AgyStaffReader } from '../../harness/agy-staff.ts';
import { readObservedJob } from '../../harness/registry.ts';
import type { ObservedJob } from '../../harness/types.ts';

export async function readAllObservedJobs(cwd: string): Promise<ObservedJob[]> {
  const claimed = new Set<string>();
  const out: ObservedJob[] = [];
  for (const [provider, reader] of [
    ['agent-smith', new AgentSmithReader()],
    ['agy-staff', new AgyStaffReader()],
  ] as const) {
    for (const id of await reader.discover(cwd)) {
      if (claimed.has(id)) continue;
      claimed.add(id);
      const job = await readObservedJob(provider, cwd, id);
      if (job !== null) out.push(job);
    }
  }
  return out;
}
