import { ForgeService } from '../../../../forge/service.ts';

/** A hand-built service double with the real worker lookup, so resume_job resolves names and ids as in production. */
export function withWorkerLookup<T extends object>(service: T): T {
  return Object.assign({ resolveHead: (id: string) => id }, service, { resolveWorker: ForgeService.prototype.resolveWorker });
}
