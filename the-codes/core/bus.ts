/**
 * A minimal typed event bus.
 *
 * Purpose: surfaces should never poll the store. Polling forces every surface
 * to pick its own cadence, and cadences drift, and a surface that polls at 1Hz
 * turns a 3-worker machine into a 3-core heater for no benefit. The store
 * already knows the moment something changed; the bus is how it says so.
 *
 * Deliberately tiny and dependency-free. It is a `Map<topic, Set<listener>>`
 * and nothing else — no wildcard hierarchies, no async queues, no replay, no
 * error isolation magic. Every feature not listed above was a feature nobody
 * asked for, and each would have needed its own semantics.
 */

import type { Job, JobEvent } from './types.ts';

/**
 * Every message the bus can carry, keyed by topic name.
 *
 * Topic names are plain strings rather than symbols because they appear in
 * `sqlite3` dumps and log lines during debugging, and a symbol there is
 * `Symbol(job.created)` — useless at 3am.
 *
 * - 'job.upserted' a Job row was created or changed. Carries the job *after*
 *   the write. Note this fires for unchanged rows too: a reader re-saving
 *   identical state is normal, and subscribers should be idempotent. Callers
 *   that care about real change should compare `updatedAt`.
 * - 'job.deleted' a job was pruned. Lets a surface drop rows rather than keep
 *   drawing ghosts.
 * - 'event.appended' a JobEvent was appended. This is the expensive one —
 *   a busy job emits many per second — so subscribers that only need job-level
 *   state should ignore it.
 * - 'pruned' a prune() sweep completed. Carries how many jobs and events went
 *   away, so a surface can reconcile instead of guessing.
 */
export interface BusEvents {
  'job.upserted': Job;
  'job.deleted': { id: string };
  'event.appended': JobEvent;
  pruned: { jobs: number; events: number };
}

/** Callback invoked with the payload for one topic. */
export type Listener<T> = (payload: T) => void;

/** Removes the subscription it was returned from. Idempotent. */
export type Unsubscribe = () => void;

export class EventBus {
  /** Insertion-ordered so subscribers fire in registration order. */
  #listeners = new Map<keyof BusEvents, Set<Listener<never>>>();

  /**
   * Subscribe to a topic. Returns an unsubscribe function.
   *
   * Not wrapped in try/catch: a throwing subscriber is a bug in that surface,
   * and swallowing it would make the failure invisible while the rest of the
   * list still fires, producing a half-updated UI that is much harder to
   * diagnose than a stack trace. Exceptions propagate to the publisher.
   */
  subscribe<T extends keyof BusEvents>(
    topic: T,
    listener: Listener<BusEvents[T]>,
  ): Unsubscribe {
    let set = this.#listeners.get(topic);
    if (!set) {
      set = new Set();
      this.#listeners.set(topic, set);
    }
    set.add(listener as Listener<never>);

    return () => {
      // Deleting the topic when empty keeps the Map from growing unboundedly
      // across a long-running process that churns through topics.
      set.delete(listener as Listener<never>);
      if (set.size === 0) this.#listeners.delete(topic);
    };
  }

  /**
   * Publish to a topic. Returns the number of listeners invoked.
   *
   * Synchronous on purpose. Publishers are provider readers running inside a
   * poll tick; making them await would push ordering guarantees onto every
   * reader for the benefit of nobody. A surface that cannot afford to render
   * synchronously should buffer inside its own listener, not by making the
   * writer async.
   *
   * Iterates a copy because a listener is allowed to unsubscribe itself (or a
   * sibling) during dispatch — a very common pattern when a surface tears down a
   * row in response to the event that removed it. Mutating the live Set
   * mid-iteration would skip a listener.
   */
  publish<T extends keyof BusEvents>(topic: T, payload: BusEvents[T]): number {
    const set = this.#listeners.get(topic);
    if (!set) return 0;
    for (const listener of [...set]) {
      (listener as Listener<BusEvents[T]>)(payload);
    }
    return set.size;
  }

  /** Subscriber count for a topic. For tests and for diagnosing a dead surface. */
  listenerCount(topic: keyof BusEvents): number {
    return this.#listeners.get(topic)?.size ?? 0;
  }

  /** Drop every subscriber. For tests; a production surface should unsubscribe. */
  clear(): void {
    this.#listeners.clear();
  }
}