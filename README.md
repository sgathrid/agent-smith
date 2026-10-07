# Agent Smith

**Forge for coding agents.** One task, many workers, one place to watch them.

---

## The problem

You can already hire a cheap agent — [agy](https://antigravity.google) (Gemini),
Codex, OpenCode. What you cannot do is **watch them work**.

The proof is in real data. `agy-staff` runs a background job that streams a
complete, typed event log to disk, republished every 100 milliseconds. It then
instructs the host model *not to look at it*:

> While a job is running, do not proactively call `observe`/`status`, read logs
> or inspect intermediate artifacts.

Measured across 20 real jobs:

| | |
|---|---|
| Jobs | 20 (16 with full telemetry) |
| Compute time | 9.0 h |
| Wall clock | **16.3 h** |
| Max concurrent | **3** |
| Median job | 28 m |
| Tokens that were cache reads | **90.4 %** |

Nine hours of work, spread over sixteen, capped at three in flight, with no live
visibility. The bottleneck was never model capability. **It was observability.**

## What this is

Two surfaces, because they do different jobs:

| Surface | Reaches | Cost | Always on |
|---|---|---|---|
| **mod** | your eyes | zero tokens | yes, no flags |
| **channel** | Claude's cognition | ~50 tokens / event | needs `--channels` |

A **mod** draws live progress in your terminal — a band above the prompt, a
browsable pane — while you watch. It costs no tokens and works every session.

A **channel** pushes state changes into Claude's context so the model *reacts*
without being asked. That is the one thing a mod cannot do.

Neither replaces the other. They read from the same store.

## The screen

```
 ● implement-musm82da  12m04s · 341 tools · cargo test --workspace
 ● review-muroviej      2m18s ·  22 tools · reading decoded_view.rs
 ✓ research-muroabc finished (48s · 8 tools)
   +2 more · /agy-radar
```

## Mixed pipelines

Name a different worker per stage:

```yaml
name: dashboard-rework
stages:
  - implement: { provider: gemini }
  - review:    { provider: codex }
  - moderate:  { provider: claude, model: sonnet }
```

The `moderate` stage is not decoration. Models across families make **correlated**
errors — 60 % agreement when both are wrong, across 350+ models (ICML 2025).
Self-consistency is therefore *not* verification. A different family is.

**Deliberately not built:** debate, voting, consensus. Four budget-matched
replications show multi-agent debate underperforms plain self-consistency, and
gets *worse* with more compute budget ([2406.06461](https://arxiv.org/abs/2406.06461)).
More tokens are cheap here. Correctness is not.

## Layout

```
agent-smith/
├── the-codes/
│   ├── core/        provider-agnostic job model, store, liveness
│   ├── harness/     readers for state workers already write
│   ├── providers/   agy · codex · opencode · claude
│   ├── pipeline/    multi-stage DAG, dynamic routing
│   ├── verify/      executable gates — the highest-value piece
│   └── surfaces/    mod (band + pane) · channel
├── agent-configs/   per-harness config for developers, not the app
├── builds/          packaged artifacts
└── docs/            ARCHITECTURE.md and friends
```

**The one insight that shapes this:** workers already write their own job state
to disk. `harness/` reads those files. We do not instrument the workers at all.
That is why this is cheap, and why it works retroactively — you can point it at
16 jobs you already ran and see them.

## Status

Under construction. See `docs/ARCHITECTURE.md` for the design and the reasoning
behind each rejected alternative.

## License

MIT