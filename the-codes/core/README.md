# core/

Provider-agnostic job model, store, bus, liveness. Node builtins only.

## Type contract

`types.ts` is the seam everything plugs into. Nothing here names a worker.

- **`JobStatus`** — `running | done | failed | cancelled | attention | unknown`.
  These are *claims*, not facts: state is inferred from artifacts a worker wrote.
  `unknown` exists so "no data" never masquerades as `running`. `attention` is
  non-terminal and means "human, now".
- **`lastEventAt`** — the progress clock. Advances only on `tool_call` and
  `message`. Never on re-reads, polls, or redraws: if the worker's behaviour did
  not change, this must not move, or a dead worker whose state file is still on
  disk looks alive forever.
- **`warnings`** — non-fatal signals, accumulated, never auto-cleared. Weaker
  than `attention`: information, not a request for eyes.
- **`JobEvent`** — append-only audit trail. `seq` is store-assigned and
  monotonic, because provider clocks disagree and sequences cannot.
- **`EventKind`** — split by whether the event proves progress, so the liveness
  rule is checkable by reading one file.

`store.ts` is `node:sqlite` + WAL: `upsertJob`, `getJob`, `listJobs(filter)`,
`appendEvent`, `recentEvents(jobId, n)`, `prune(olderThanMs)`. Timestamps are
ISO-8601 TEXT: they sort lexicographically and read cleanly in dumps.

`liveness.ts` is pure with `now` injected, so boundaries are testable.
`evaluateLiveness` and `detectToolLoop` (same tool + same input hash, twice
running) answer separate questions: a silent job is probably slow, while one
repeating the identical call is going in circles, and waiting does not help it.

## Consuming it

A surface never polls; it subscribes. Subscribers must be idempotent, since
`upsertJob` fires for unchanged rows too.

```ts
const bus = new EventBus();
const store = new JobStore({ path: 'jobs.sqlite', bus });
bus.subscribe('job.upserted', (job) =>
  render(job, assessJob(job, store.recentEvents(job.id, 20), Date.now())));
const jobs = store.listJobs({ status: 'running', limit: 50 });
```