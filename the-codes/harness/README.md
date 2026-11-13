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
| `agent-smith` | `<repo>/.agent-smith/jobs/<id>/job.json` and sidecars | `<mode>-smith-<8 hex>` |

The cancel marker outranks `job.json`: it can exist before the worker is reaped.
An empty response is never a clean success; that verdict is decided once, when
the job is written (`forge/format.ts`), not re-derived on read.

Missing files ⇒ `null`, invalid JSON ⇒ `null`, unknown shapes ⇒ skipped and
counted; `registry.ts` isolates reader failures.

```sh
node --test --experimental-strip-types the-codes/harness/__tests__/*.test.ts
```
