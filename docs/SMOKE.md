# Isolated smoke runner

Run `node scripts/smoke.mjs` from the repository root to exercise the channel's real MCP stdio boundary with deterministic fake agy and Codex commands. The runner creates a temporary scratch root containing both the work repository and provider state. It never points Forge at the caller's checkout. By default it removes the scratch tree and prints a JSON summary with each scenario's status and cleanup result.

The fake run covers tool discovery, a solo review followed by resume by worker name and recorded conversation handle, a cross-provider implement-to-review pipeline that verifies the artifact text reaches the reviewer, a blocking executable check, cancellation, timeout, overlapping stages at concurrency two, and serialized stages at concurrency one. Fake providers require the pipeline-created artifact directory to exist. Fixture commands return deterministic text and do not call an external model.

Pass `--keep` to preserve the scratch root and all MCP evidence for inspection. The summary prints its path. Remove that directory manually when finished.

Pass `--live` to open a separate MCP server process without the fake executable overrides, refresh installed-provider and catalog discovery, then submit one short review prompt to each available provider. Use `--providers=agy,codex,kimi` to bound live runs; unknown or unavailable names fail explicitly. The runner leaves model selection to each provider's configured default and does not hardcode model IDs. Live calls may use provider quota. Add `--keep` to preserve discovery and job evidence.

The runner requires Node 22.18 or newer and the MCP SDK installed by `the-codes/surfaces/channel`. It accepts no repo path override so the scratch boundary stays explicit.
