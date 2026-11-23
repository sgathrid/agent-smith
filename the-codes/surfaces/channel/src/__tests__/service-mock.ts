import { ForgeService, WorkerLookupError } from '../../../../forge/service.ts';

/** A hand-built service double with worker lookup matching ForgeService.resolveWorker for in-memory mocks. */
export function withWorkerLookup<T extends object>(service: T): T {
  return Object.assign(
    {
      resolveHead: (id: string) => id,
      isSafeJobId: (ForgeService.prototype as unknown as { isSafeJobId: (id: string) => boolean }).isSafeJobId,
      live: new Map(),
      async resolveWorker(this: {
        resolveHead: (id: string) => string;
        detail?: (id: string) => Promise<unknown>;
        list?: (opts?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
      }, nameOrId: string) {
        const trimmed = nameOrId.trim();
        const headId = this.resolveHead(trimmed);
        if (this.detail) {
          try {
            return await this.detail(headId);
          } catch {
            // Fall through to list-based lookup
          }
        }
        if (this.list) {
          const allTurns = await this.list({ limit: 500, groupByWorker: false });
          const candidates = allTurns.filter((j) => j.name === trimmed || j.workerId === trimmed || j.jobId === trimmed);
          const identities = new Set(candidates.map((j) => String(j.workerId ?? j.jobId)));
          if (candidates.length === 0) throw new WorkerLookupError(`No worker "${nameOrId}"; see list_jobs.`, 'missing');
          if (identities.size !== 1) {
            const headIds = [...identities].map((wid) => this.resolveHead(wid));
            throw new WorkerLookupError(
              `"${nameOrId}" matches ${identities.size} workers; pass a job ID from list_jobs.`,
              'ambiguous',
              headIds,
            );
          }
          const wid = [...identities][0]!;
          const targetId = this.resolveHead(wid);
          if (this.detail) return this.detail(targetId);
          return candidates[candidates.length - 1];
        }
        throw new WorkerLookupError(`No worker "${nameOrId}"; see list_jobs.`, 'missing');
      },
    },
    service,
  );
}
