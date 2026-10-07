# pipeline/ — mixed-provider stages

One task, a different worker per stage: `implement → gemini · review → codex ·
moderate → claude-sonnet`.

## The injection point

`StageRunner` in `types.ts` is the only seam:
`run(ctx: StageContext): Promise<StageResult>`. `pipeline/` never imports
`providers/`. Wire it at the composition root in `core/`:

```ts
const runner = createRunnerRouter({ gemini: makeGeminiRunner(c), codex: makeCodexRunner(c) });
await runPipeline(spec, { runner });
```

## Concurrency

Independent stages run **concurrently**, capped by `spec.concurrency`
(default 8). Scheduling is event-driven, not wave-based, so a long `review` never
blocks a 30s `test`. Motivating measurement: 16 jobs, 16.3h wall clock, ceiling
of 3. `peakConcurrency` is reported on every run.

Failures mark dependents `skipped`, never `failed` — they never ran. Each carries
a `skippedBecause` naming the originating failure. `PipelineSpecError` rejects
duplicate names, unknown deps and cycles.

## Escalation rules (`routing.ts`)

1. Default every stage to the **cheapest tier at `low` effort**. Measured: `high`
   = +50% wall clock, 1.9x thinking tokens, zero accuracy gain.
2. Escalate on **stall shapes**, never the first error. Reference job: first tool
   error at **tool #34 of 484 — and it succeeded**. Shapes: `repeat-signature` ·
   `edit-churn-unverified` · `no-progress` · `context-exhaustion` ·
   `declared-stuck`.
3. Escalation **continues from the transcript**; it never restarts.
4. **No confidence prediction, no difficulty classifier** — no reliable pre-hoc
   signal, so routing is post-hoc by construction.
5. `moderate` is a **cross-family probe**, enforced by `assertCrossFamily`.
   Same-family agreement is correlated (60% when both err, ICML 2025), so
   self-consistency is not verification. Not debate (2406.06461).
6. No stall signal = the stage stays cheap. The common case must be cheap.

Ladder `t0-cheap → t1-effort → t2-stronger → t3-cross-family`, ceiling 2.

Tests: `node --test the-codes/pipeline/` — 50 tests.