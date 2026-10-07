# Agent configs

Per-harness configuration for **developing and using** Agent Smith.

> **Not part of the application.** Nothing in `the-codes/` reads these files.
> They exist so a human (or an agent) can install Agent Smith into each harness,
> and so each harness's agent is told how to behave when it is a worker or a
> moderator in a mixed pipeline.

## Why this directory exists

Agent Smith is provider-agnostic. That only holds if each provider's quirks live
in one place rather than scattered through the code. This is that place.

## Layout

```
agent-configs/
├── claude-code/     mod + channel manifests (the two surfaces)
├── codex/           AGENTS.md instructions for Codex as worker/moderator
├── opencode/        opencode.json skill paths
├── agy/             agy persona prompts per stage role
└── shared/          the role contract every provider must honour
```

## The role contract

Every provider, whatever its harness, is asked to do the same three jobs. The
per-provider files are thin adapters onto these roles.

| Role | Does | Does **not** |
|---|---|---|
| `implement` | Make the change. Minimal diff. | Commit, push, open PRs unless told |
| `review` | Find defects. Severity-ranked evidence. | Fix anything. Soften nothing |
| `moderate` | Probe the previous stage's work for a *named* failure class | Argue until agreement. Vote |

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

Reports which providers are on this machine, which harness configs are
installed, and whether the surfaces can see worker state.