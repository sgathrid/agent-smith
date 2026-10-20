# Agent Smith: working in this repo

`npm run verify` (typecheck and node tests) and `npm run test:plugin` (the mod under Claude Code's engine) must pass. CI runs both, plus the two release checks below.

## Shipping a change to users

Users install the committed build in `builds/local-plugin/agent-smith/`, not the source. Claude Code stores an installed plugin by its `version`. If the build changes and the version doesn't, users never receive it, and `claude plugin update` tells them they're current.

When you change anything under `the-codes/` that ends up in the build:

1. Run `npm run bump` (patch) or `npm run bump -- minor`, `-- major` or `-- x.y.z`. It raises the version in `package.json`, `package-lock.json` and `the-codes/surfaces/mod/.claude-plugin/plugin.json`, then rebuilds `builds/`. Commit all of it. Use a patch bump unless told otherwise. Versions are plain `x.y.z`: the update check and CI don't understand pre-release suffixes such as `-beta.1`.
2. CI rebuilds and fails if `builds/` differs from source. `scripts/check-version.mjs` fails the PR if the build changed and the version didn't rise, or if the version files disagree. Bump once per PR; after later source changes, run `npm run build:plugin` again.

Don't get past either check by editing `builds/` by hand or lowering the base version. Fix the source, rebuild and bump.

After the merge, the `Release tag` workflow tags `main` as `agent-smith--v<version>` (the name `claude plugin tag` uses). Don't tag by hand.

## How users learn about an update

- Claude Code auto-updates a third-party marketplace like this one only if the user turned auto-update on for it (README, "Updates").
- Otherwise the mod tells them: on session start it fetches the released `plugin.json` on `main` and shows one toast, `agent-smith update available: vX → vY` (`the-codes/surfaces/mod/hooks/update.ts`). It is skipped under `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. This only works if the version on `main` actually rises, which is the second reason to bump.

## Text Claude reads vs. text the user sees

The plugin talks to two audiences. Keep them apart:

- **Claude** reads the MCP server instructions (`surfaces/channel/src/server.ts`), tool descriptions and ack fields (`surfaces/channel/src/tools.ts`), the `delegate` skill (`surfaces/mod/skills/delegate/SKILL.md`), and completion notices. Put only what Claude acts on there. Leave out user-only features such as `/forge`, the band or the pane, and internal mechanism such as hook wiring.
- **The user** sees the band, the `/forge` pane, toasts, and the transcript row for a notice (cleaned by the `UserMessage` render hook).

## Claude Code hooks

The mod hooks `tool.call`, never `classic.*`. Claude Code's built-in guard sends `classic.*` events past user-installed mods, so a classic handler never runs. See the "completion notices" comment in `surfaces/mod/hooks/register.tsx` and `docs/ARCHITECTURE.md`.
