# Agent configs

Per-harness configuration for **developing and using** Agent Smith.

The nested `.claude/settings.json` is an example enablement key; Claude does not
read it when launched from the repository root. For an active repo-only setup,
run `npm run setup:claude` from the root. That builds a complete plugin and writes
the root `.claude/settings.local.json`, preserving your existing local settings.
The local file declares this checkout as a directory marketplace and enables its
plugin only here. Claude maintains its own marketplace registry and plugin data
under `~/.claude/plugins`; setup does not change global enablement or user settings.

> **Not part of the application.** Nothing in `the-codes/` reads these files.
> They exist so a human (or an agent) can install Agent Smith into each harness,
> and so each harness's agent is told how to behave when it is a worker or a
> moderator in a mixed pipeline.

## Why this directory exists

Agent Smith is provider-agnostic. Provider quirks live in `the-codes/providers/`;
this directory holds the provider-neutral contract (`shared/`) that every worker is
held to, plus an example plugin enablement key.

## Layout

```
agent-configs/
├── .claude/settings.json   example plugin enablement key (inactive; see above)
└── shared/                 the role contract and terminal-UI rules every provider honours
```

Per-provider adapter files (Codex `AGENTS.md`, OpenCode config, agy personas) are not
checked in. Provider behavior is configured in the provider adapters and, for models, in
`models.json` (see [docs/CONFIGURATION.md](../docs/CONFIGURATION.md)).

## The role contract

Every provider, whatever its harness, is asked to do the same jobs, selected by the
closed job `mode` (`implement`, `review`, `moderate`, `verify`; presets in
`the-codes/forge/modes.ts`). `verify` runs the given checks and reports what happened.

| Role | Does | Does **not** |
|---|---|---|
| `implement` | Make the change. Minimal diff. | Commit, push, open PRs unless told |
| `review` | Find defects. Severity-ranked evidence. | Fix anything. Soften nothing |
| `moderate` | Probe the previous stage's work for a *named* failure class | Argue until agreement. Vote |
| `verify` | Run the checks and report exact results | Claim a pass it did not run |

### Why `moderate` is not `debate`

Models across families make **correlated** errors: 60 % agreement when both are
wrong, measured across 350+ models ([ICML 2025](https://arxiv.org/abs/2506.07962)).
Self-consistent errors do not shrink with scale
([EMNLP 2025](https://arxiv.org/abs/2505.17656)). So running the same family twice
and hoping for agreement is not verification.

`moderate` is therefore **not** a second opinion in a conversation. It is a
probe against a named failure class — "does this compile", "does the diff touch
what the task said", "did the claim of completion survive a check".

Multi-agent debate was explicitly rejected: it underperforms plain
self-consistency at matched budget, and degrades as budget grows
([2406.06461](https://arxiv.org/abs/2406.06461)). Tokens are cheap here.
Correctness is not.

## Verifying the setup

```bash
agent-smith doctor
```

Reports which providers are on this machine (binary found on `PATH`) and where job
state is read from. It does not inspect harness configs or surface health.
