# Construct

*Construct as in the Matrix's Construct, not the building site. It's the white loading program where Tank uploads kung fu into Neo's head in ten seconds. This one loads engineering habits into your coding agent.*

Construct is a set of skills for working on real code: understanding it, designing changes, reviewing them, writing about them, fixing bugs and proving the fix. It works in any repository and any language, and it never runs on its own. Nothing happens until you type a command.

> Tank, load the debug program.

```
/construct:debug the export button does nothing on the second click
```

## The programs

Not sure which one fits? Type `/construct:load` with your task and it picks one for you.

| Command | Use it when you want to… |
|---|---|
| `how` | understand how some code works before touching it |
| `why` | find out why it was built that way, with sources and confidence |
| `architect` | settle the shape (usage, types, modules) before writing code |
| `arena` | run several independent attempts and keep the best parts of each |
| `interrogate` | have fresh reviewers, ideally on other models, try to break a change |
| `no-comments` | strip pointless comments and turn real constraints into checks |
| `deslop` | clean AI-flavored code out of a branch |
| `unslop` | clean AI-flavored prose out of writing |
| `technical-writing` | write a README, guide or reference that people can follow |
| `debug` | find and fix a bug from a confirmed reproduction |
| `tdd` | write the failing test first, then the fix |
| `blast-radius` | learn what else a small change could break, and prove it's safe |
| `verify` | prove a claim with before-and-after evidence |
| `verification-harness` | build or repair a script that drives your real app |

## How it behaves

- **You start everything.** Skills are user-invoked only. A running skill may tell your agent to read another one (`no-comments` leans on `how` and `architect`), but nothing starts by itself.
- **Effort fits the job.** A small question gets a direct answer. Helpers, and helpers on other model families, only come in when the stakes justify the cost.
- **It brings no tools of its own.** Skills describe what they need ("a reviewer on a different model, if one is available") and your agent uses whatever you have. With [agent-smith](../README.md) installed, that includes Codex, OpenCode, agy and Kimi workers. Without it, everything still works.
- **Reports are claims.** Whatever a helper says gets checked against the code before it reaches you.

## Install

**Claude Code**

```sh
claude plugin install construct --marketplace sgathrid/agent-smith
```

Restart Claude Code. Commands appear as `/construct:<name>`.

**Codex or OpenCode**

From a clone of this repository:

```sh
node construct/scripts/install.mjs --codex      # or --opencode, or both
```

The installer copies the skills, points their cross-references at the copy, and marks each one user-invoked only. Run it again to update; add `--uninstall` to remove exactly what it installed.

## One more thing worth pasting

Skills load only when you call them. [`stance.md`](stance.md) holds the handful of habits that matter in every task. Paste it into your repo's `AGENTS.md` or `CLAUDE.md`.

## Changing Construct

Run `node construct/scripts/check.mjs` before you commit. It fails on dangling references, oversize skills, missing frontmatter, em dashes, and any skill that names a specific tool or model. Raise the version in `.claude-plugin/plugin.json` with every change, or installed copies never update.

Construct distills ideas from [P-Stack](https://github.com/cursor/plugins/tree/main/pstack) and the [Cursor team kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit), both MIT licensed. See [NOTICE](NOTICE).
