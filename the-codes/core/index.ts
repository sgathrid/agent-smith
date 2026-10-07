/**
 * core/ — the provider-agnostic heart of agent-smith.
 *
 * Everything else in the system is a plugin against this module's types:
 * providers/ and harness/ write here, surfaces/ read from here. Nothing in core
 * knows a worker exists by name.
 */

export type {
  Activity,
  ActivityKind,
  EventKind,
  Job,
  JobEvent,
  JobFilter,
  JobStatus,
  ProviderName,
  Warning,
  KnownProviderName,
} from './types.ts';

export {
  ACTIVE_STATUSES,
  KNOWN_PROVIDERS,
  PROGRESS_EVENT_KINDS,
  TERMINAL_STATUSES,
  isProgressEvent,
  isTerminalStatus,
} from './types.ts';

export { EventBus } from './bus.ts';
export type { BusEvents, Listener, Unsubscribe } from './bus.ts';

export { JobStore } from './store.ts';
export type { JobStoreOptions, PruneResult } from './store.ts';

export {
  DEFAULT_DEAD_MS,
  DEFAULT_GRACE_MS,
  DEFAULT_REPEAT_THRESHOLD,
  assessJob,
  detectToolLoop,
  evaluateLiveness,
  hashToolInput,
  silenceMs,
} from './liveness.ts';
export type { Liveness, LivenessOptions, ToolLoop, ToolLoopOptions } from './liveness.ts';