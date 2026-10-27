# harness/ — read the state workers already write
Spawns nothing. Jobs already write a continuously-updated snapshot to disk; we
just read it. `safe-fs.ts` holds race-tolerant I/O, `types.ts` the contract.

## Reader interface

```ts
interface JobStateReader {
  provider: string;
  discover(cwd: string): Promise<string[]>;
  read(cwd: string, jobId: string): Promise<RawJobState | null>;
}
```
`read()` gives a provider payload, or `null` if the provider doesn't know the job;
`normalize.ts` maps it to `ObservedJob`, the provider-agnostic shape consumers
read. `registry.ts` exposes `readObservedJob(provider, cwd, jobId)`, which
isolates reader failures (an `unknown` job, never a throw).

| provider | source | job id |
|---|---|---|
| `agent-smith` (primary) | `<repo>/.agent-smith/jobs/<id>/job.json` and sidecars | `<mode>-smith-<8 hex>` |
| `agy-staff` (interop, read-only) | `<repo>/.agy-staff/jobs/` | `implement-musm82da-f1dc1fe4` |

The `agent-smith` reader owns forge ids. The compat mirror in `.agy-staff/jobs/`
makes them visible to the interop reader too, so callers skip forge ids
(`isForgeJobId`) when reading `agy-staff`: one job, one verdict.

## The three agy-staff hazards

**A. Deleted `progress.json` means FINISHED, not missing.** On a warning-free
success agy-staff deletes `progress.json` *and* `events.jsonl`. Treating that as
"no such job" silently loses completed work. Terminal state is anchored on the
always-written `<jobId>.result.md.status.json`; progress/events are only optional
liveness evidence, so a finished job still returns a full snapshot.

**B. `.spec.json.cancel` markers.** Cancelled jobs get a sibling marker file whose
body is the cancel timestamp. It can appear before `status.json` is finalized, so
it outranks it (2 of 20 real jobs).

**C. Polluted `result.md`.** Some reports carry `<system_notification>…</system_notification>`
blocks agy-staff never stripped; `stripSystemNotifications()` removes them. Real
job `implement-musm82da-f1dc1fe4.result.md` has 12. Clean upstream PR.

## The headline rule

**An empty response with warnings is NOT a clean success.** agy-staff will write
`{status:'done', warnings:true}` with an empty `result.md`. That normalizes to
`failed` + `suspicious_success`, never `succeeded`.

Missing files ⇒ `null`, invalid JSON ⇒ `null`, unknown shapes ⇒ skipped and
counted; `registry.ts` isolates reader failures.

```sh
node --test --experimental-strip-types the-codes/harness/__tests__/*.test.ts
```
