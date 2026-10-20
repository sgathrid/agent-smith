# Agent Smith <picture><source media="(prefers-color-scheme: dark)" srcset="docs/logo-options/smith-shades-opencode-shadow.svg" /><source media="(prefers-color-scheme: light)" srcset="docs/logo-options/smith-shades-opencode-shadow.svg" /><img alt="" src="docs/logo-options/smith-shades-opencode-shadow.svg" height="45" align="center" /></picture>

**Claude delegates. Other models work. You see it happen.**

Agent Smith brings Codex, OpenCode, and agy into Claude Code's delegation workflow—with native task-list entries, live progress above your prompt, and worker transcripts inside your terminal.

- **Delegate across providers.** Ask Claude to hand off a review, implementation, or verification task in plain English.
- **Keep working.** Workers run in the background. Claude gets notified when they finish, without repeatedly asking for status.
- **See what they're doing.** Follow tool calls, spot stalled work, and inspect failures as they appear. Open `/forge` for the details.

> Have Codex review the changes on this branch. Call the worker Ada.

## Install

You need **Node.js 22.18+**, a current **Claude Code**, and at least one worker CLI (`codex`, `opencode`, or `agy`) installed and authenticated. Agent Smith uses those CLIs and their configured accounts. It also supports separate `claude` workers.

**Inside Claude Code:**

```text
/plugin install agent-smith --marketplace sgathrid/agent-smith
```

**Or one command in your terminal:**

```sh
claude plugin install agent-smith --marketplace sgathrid/agent-smith
```

Restart Claude Code in the project you want to work on. The plugin bundles its runtime; no clone or npm install is needed.

<details>
<summary>If your Claude Code doesn't recognize <code>--marketplace</code></summary>

Add the marketplace, then install the plugin:

```text
/plugin marketplace add sgathrid/agent-smith
/plugin install agent-smith@agent-smith
```

The combined install requires Claude Code v2.1.275+ inside a session or v2.1.292+ from the shell. See [Claude Code's plugin installation guide](https://code.claude.com/docs/en/discover-plugins#add-a-marketplace-and-install-in-one-command).

</details>

### Updates

Claude Code doesn't auto-update third-party marketplaces unless you turn it on. Run `/plugin`, open **Marketplaces**, select `agent-smith` and choose **Enable auto-update**. Or update by hand and restart Claude Code:

```sh
claude plugin update agent-smith@agent-smith
```

Agent Smith checks for a newer release when a session starts and shows `agent-smith update available: v0.2.2 → v0.2.3` when there is one. It skips the check when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set.

## Try it

Start with a review in a repository that has changes:

> Use Agent Smith to have Codex review my diff for bugs and missing tests. Call the worker Ada. Don't change any files.

Ada appears in Claude Code's task list and the live worker band above your prompt. You can keep talking to Claude while the review runs.

| To… | Do this |
|---|---|
| See this session's workers | Run `/forge` |
| Inspect Ada's activity and report | Run `/forge Ada` |
| Open a worker from the live band | Press its number (`1`–`4`) with an empty prompt |
| Inspect a tool call | Press `Enter` on its row in the worker view |

When Ada finishes, Claude receives a completion notice and can read the report. Continue the same worker conversation:

> Ask Ada for a minimal reproducer for her top finding.

Follow-ups resume a finished worker; steering a worker mid-run isn't supported yet.

## Put different models to work

**Build, review, fix:**

> Have agy implement 30-minute idle session expiry. Then have Codex review the diff, and send the findings back to the original agy worker to fix. Require `npm test` to pass.

**Verify a change:**

> Have Codex run the relevant tests for this change and report any failures. Don't edit the code.

**Get another perspective:**

> Have OpenCode review the proposed design for failure modes before we implement it.

Name the provider you want. Claude discovers the installed providers and available models; you don't need to write tool calls or pipeline JSON.

When you attach checks such as `npm test`, Agent Smith runs them after the worker exits and records whether they pass. A finished process and accepted work are tracked separately.

## How it fits into Claude Code

Agent Smith is a Claude Code plugin: a delegation skill, an MCP server that runs the provider CLIs, and an integrated terminal UI. Workers appear in the **native task list**; the live band and `/forge` show their activity, results, and check output.

These are external workers integrated into Claude Code, not sessions created by its built-in `Agent` tool. Each uses its own provider's permissions. In particular, **agy runs unrestricted by default**; review restrictions vary by provider. See [provider permissions](docs/CONFIGURATION.md#harness-default-sources).

For parallel workers editing code, give each its own git worktree. Worker state and reports live in `.agent-smith/` within your project.

## Develop Agent Smith

Clone, install dependencies, and enable the local plugin:

```sh
git clone https://github.com/sgathrid/agent-smith.git
cd agent-smith
npm install
npm run setup:claude
claude
```

`setup:claude` builds and validates the plugin, enables it in this checkout's `.claude/settings.local.json`, and checks provider CLI compatibility. Authenticate your chosen provider separately, then try the review prompt above.

To use your local build in another project, run this from the Agent Smith checkout, then restart Claude Code in that project:

```sh
node scripts/agent-smith.mjs setup --local --repo /absolute/path/to/project
```

```sh
npm run verify         # Typecheck and tests with fake providers; no model calls
npm run smoke          # End-to-end MCP smoke test with fake providers
npm run build:plugin   # Rebuild the plugin after source changes
```

Restart Claude Code to load the rebuilt plugin. For real provider testing, see the [smoke-test guide](docs/SMOKE.md).

Before you open a pull request that changes the plugin, run `npm run bump` (or `npm run bump -- minor`, `-- major`) to raise the version and rebuild, and commit the result. Users only receive a higher version, and CI checks both. [AGENTS.md](AGENTS.md) explains why, for people and coding agents alike.

## Reference

- [Configuration](docs/CONFIGURATION.md) — models, permissions, MCP tools, standalone CLI, and environment variables.
- [Terminal UI](the-codes/surfaces/mod/README.md) — worker views, keyboard controls, and session tracking.
- [Architecture](docs/ARCHITECTURE.md) — execution, progress, acceptance checks, and completion notifications.

<details>
<summary>Update, uninstall, and troubleshoot</summary>

**Update**, then restart Claude Code:

```sh
claude plugin marketplace update agent-smith
claude plugin update agent-smith@agent-smith
```

**Uninstall:**

```sh
claude plugin uninstall agent-smith@agent-smith
```

**Provider unavailable?** Make sure its CLI runs and is authenticated in the shell you launch Claude Code from, then restart Claude Code. From a source checkout, `node scripts/agent-smith.mjs doctor` checks CLI compatibility, but does not test authentication or model access.

**No progress UI or completion notice?** Restart Claude Code after installation and check that Agent Smith is enabled in `/plugin`.

**Releasing a change?** Run `npm run bump` (or `-- minor`, `-- major`) and commit the result. Claude Code caches plugins by version.

</details>

MIT licensed.
