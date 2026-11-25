import { WorkerLookupError, type ForgeService, type JobDetail } from '../../../../forge/service.ts';

export type ServiceLookup = Pick<ForgeService,
  'resolveTurn' | 'resolveWorkerHeadId' | 'resolveWorker' | 'resolveWorkerHead' | 'messageTarget' | 'earlierTurns' | 'followUp' | 'steer' | 'cancel' | 'spawnedIds'>;

interface LooseSource {
  readonly detail?: (id: string) => Promise<unknown>;
  readonly list?: (filter?: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
}

export function withWorkerLookup<T extends object>(service: T): T & ServiceLookup {
  const merged = {} as T & ServiceLookup;
  const src = merged as unknown as LooseSource;
  async function lookup(nameOrId: string): Promise<JobDetail> {
    const trimmed = nameOrId.trim();
    const headId = merged.resolveTurn(trimmed);
    if (src.detail) {
      try {
        return await src.detail(headId) as JobDetail;
      } catch {
      }
    }
    if (src.list) {
      const allTurns = await src.list({ limit: 500, groupByWorker: false });
      const candidates = allTurns.filter((j) => j.name === trimmed || j.workerId === trimmed || j.jobId === trimmed);
      const identities = new Set(candidates.map((j) => String(j.workerId ?? j.jobId)));
      if (candidates.length === 0) throw new WorkerLookupError(`No worker "${nameOrId}".`, 'missing');
      if (identities.size !== 1) {
        throw new WorkerLookupError(`"${nameOrId}" matches ${identities.size} workers; pass a jobId.`, 'ambiguous', [...identities]);
      }
      const targetId = merged.resolveTurn([...identities][0]!);
      if (src.detail) return await src.detail(targetId) as JobDetail;
      return candidates[candidates.length - 1] as unknown as JobDetail;
    }
    throw new WorkerLookupError(`No worker "${nameOrId}".`, 'missing');
  }
  const notMocked = (name: string) => () => { throw new Error(`${name} is not mocked`); };
  const defaults: ServiceLookup = {
    resolveTurn: (id) => id.trim(),
    resolveWorkerHeadId: (ref) => ref.trim(),
    resolveWorker: lookup,
    resolveWorkerHead: lookup,
    messageTarget: lookup,
    earlierTurns: async () => [],
    followUp: async () => notMocked('followUp')(),
    steer: async () => notMocked('steer')(),
    cancel: notMocked('cancel'),
    spawnedIds: new Set<string>(),
  };
  return Object.assign(merged, defaults, service);
}
