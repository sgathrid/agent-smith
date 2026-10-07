# Agent Smith — Architecture

> Forge for coding agents. One task, many workers, one place to watch them.

## The problem

You can already hire a cheap agent (agy, Codex, OpenCode). You cannot see them
work. agy-staff streams a complete event log to disk and then instructs the host
model *not to look at it*. The result: 16 jobs across 16.3 hours of wall clock, a
maximum of 3 concurrent, and zero live visibility.

## The thesis

Two surfaces, because they do different jobs:

| Surface | Reaches | Cost | Always on |
|---|---|---|---|
| **mod** | your eyes | zero tokens | yes, no flags |
| **channel** | Claude's cognition | ~50 tokens/event | needs `--channels` |

A mod can draw while you watch but cannot wake Claude. A channel pushes into
context so Claude reacts unprompted but cannot draw and costs tokens per event.
Neither replaces the other.

## Layered design

```
┌──────────────────────────────────────────────────────────┐
│  surfaces/          mod (band + pane) · channel (events) │
├──────────────────────────────────────────────────────────┤
│  core/              registry · supervisor · store · bus   │
│                     pipeline · verify                      │
├──────────────────────────────────────────────────────────┤
│  providers/         agy · codex · opencode · claude       │
├──────────────────────────────────────────────────────────┤
│  harness/           job-state readers (agy-staff, etc.)   │
└──────────────────────────────────────────────────────────┘
```

**providers/** speaks to workers. **harness/** reads the state workers already
write. **core/** is provider-agnostic and owns no I/O specifics. **surfaces/**
is the only part that knows Claude Code exists.

## The mixed-pipeline idea

A task can name different workers per stage:

```yaml
name: dashboard-rework
stages:
  - implement: { provider: gemini }
  - review:    { provider: codex,  model: gpt-5.6-sol }
  - moderate:  { provider: claude, model: sonnet }
```

The `moderate` stage exists because of a hard-won finding: **Claude proposes,
another model probes.** Generative agreement between same-family models is
correlated (60% agreement when both err, ICML 2025 across 350+ models), so
self-consistency is not verification. A different family is.

Deliberately excluded: debate, voting, consensus. Four budget-matched
replications show debate underperforms plain self-consistency, and gets *worse*
with more budget (2406.06461). Tokens are free here; correctness is not.

## Data flow

```
worker writes job state ──► harness/reader ──► core/store (SQLite)
                                        │             │
                                        ├──► core/bus ─┴──► surfaces/
                                        │                    mod draws
                                        └──► verify            channel notifies
```

The store is the single source of truth. Surfaces are read-only projections of
it. That is why two surfaces cost one implementation.

## Non-goals

- Not a chat wrapper. Providers are spawned headless and never see a terminal.
- Not a tmux manager. No PTY, no scrollback — we consume structured events, so
  scrollback-shaped tools (claude-squad) cannot answer this problem.
- Not an LSP or IDE. It orchestrates; it does not edit.