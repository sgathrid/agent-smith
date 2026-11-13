/**
 * Test helper: every job the agent-smith reader discovers, read and normalized.
 */
import { AgentSmithReader } from '../../harness/agent-smith.ts';
import { readObservedJob } from '../../harness/registry.ts';
import type { ObservedJob } from '../../harness/types.ts';

export async function readAllObservedJobs(cwd: string): Promise<ObservedJob[]> {
  const out: ObservedJob[] = [];
  for (const id of await new AgentSmithReader().discover(cwd)) {
    const job = await readObservedJob(cwd, id);
    if (job !== null) out.push(job);
  }
  return out;
}
