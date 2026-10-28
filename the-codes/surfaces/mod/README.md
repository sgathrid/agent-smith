# agent-smith — the band

A Claude Code mod that draws **one live line per running agy / Codex / OpenCode /
Kimi / Claude job** in the `AbovePrompt` band. Each line has a digit: pressing it in an empty
prompt opens the focused sidebar on that worker's live view. `/forge` opens the
sidebar on the worker list; `/forge <name or job id>` opens one worker.

Like Claude Code's own sub-agents, the band, `/forge` and native tasks show only
the workers **this session** launched (and the stage jobs of pipelines it ran),
and `/clear`, `/resume` and `/branch` start that list afresh. `/forge all` lists
every job in the repository.

```
 ● implement-musm82da-f1dc1fe4 cargo test --workspace · 341 tools ·     12m04s
 ● implement-muroviej-a23df195 reading decoded_view.rs ·  22 tools ·     02m18s
 ● implement-musm82da-f1dc1fe4 in `cargo test` 16m ·  341 tools ·   38m10s
 ! implement-muroviej-a23df195 no output 16m ·  22 tools ·   41m02s
 ✓ research-muroabc-f1dc1fe4 finished, warnings ·  8 tools ·      48s
   +2 more · /forge
```

## What it does

One line per job, in this order — TERMINAL-UI.md's own hierarchy (identity →
liveness → outcome), with the **elapsed time last**:

| state | glyph | colour | line |
|---|---|---|---|
| running | `●` | yellow, bold | `● <id> <activity> · N tools · 12m04s` |
| running, one call open for over a minute | `●` | yellow, bold | ``● <id> in `cargo test` 16m · N tools · 38m10s`` |
| quiet: no output (`silent`) | `!` | cyan, bold | `! <id> no output 16m · N tools · 1h02m03s` |
| quiet: process gone (`dead`) | `!` | cyan, bold | `! <id> process gone 3m · N tools · 1h02m03s` |
| succeeded | `✓` | green | `✓ <id> finished · N tools · 48s` |
| succeeded with warnings | `✓` | green | `✓ <id> finished, warnings · 48s` |
| failed | `✗` | red | `✗ <id> failed · suspicious success · 48s` |
| cancelled | `·` | dim only | `· <id> canceled · 48s` |
| unknown | `?` | dim only | `? <id> no state yet · 48s` |

Rules, all from `agent-configs/shared/TERMINAL-UI.md`, cited in the code by line
number:

- **Glyphs are `● ✓ ✗ ! · ?` only.** Never emoji. `⏳` and `✅` are
  East-Asian-Wide and silently break every column after them — the bug
  TERMINAL-UI.md L99-101 attributes to the shipped `review-watch` mod.
- **Colour is never the only channel.** Every state has its own glyph, so
  `--no-color`, a monochrome terminal, and `--ax-screen-reader` all still read.
- **`dimColor` for all secondary text. Never `gray`** — `gray` is a fixed colour
  that disappears on one of light or dark terminals (L84-85).
- **`wrap="truncate-end"` on every `<Text>`**, nested segments included. A
  wrapped status line becomes two rows, the band grows, and the prompt moves.
- **At most 4 rows, then `+N more`.** And never more than the engine's own
  `maxRows` allows, minus the row the engine reserves for its overflow line.
- **Finished jobs linger 10 s, then leave.** Pending acceptance stays visible.
  Linger is measured from the execution finish time — *not* from when we first noticed — so a corpus of 20
  jobs finished hours ago draws nothing instead of claiming four are in flight.
- **Quiet is a fact, never "stalled".** Liveness comes from `hooks/stale.ts`
  `livenessOf` (the channel uses the same function): a call still open is
  `in \`<command>\` <time>`, 15 minutes without output is `no output <time>`, a
  worker process whose heartbeat stopped 2 minutes ago is `process gone <time>`.
  Only the last two are `!`; a long command stays `●`.
- **Nothing renders when there is nothing to say.** Not "0 jobs", not an empty
  box. The host's own output comes back untouched, as our last child.
- **A survey holds the band.** `e.props.hasSurvey` → we draw nothing.
- **Zero animation, no spinner.** Both reference mods ship zero and are calmer
  for it (L191).
- **The 1 Hz clock is gated on visibility.** Idle costs one comparison a second
  and never a redraw. A 1 Hz repaint of nothing is a laptop fan (L161).

## Install

Install the full plugin in Claude Code:

```text
/plugin install agent-smith --marketplace sgathrid/agent-smith
```

Or load the mod directory on its own for a single session:

```bash
claude plugin validate the-codes/surfaces/mod    # must pass
claude --plugin-dir the-codes/surfaces/mod       # or install it
```

Then, in the repo you want to watch:

```bash
claude          # launched IN the repo; .agent-smith/jobs is found there
```

The band needs no flags, no channels, and no model tokens. It reads
`<repo>/.agent-smith/jobs/`.

To watch a *different* repo from the one you launched in:

```bash
export AGY_RADAR_REPO=/path/to/repo
claude
```

### Configuration

| variable | default | meaning |
|---|---|---|
| `AGY_RADAR_REPO` | the session's cwd | the repo whose `.agent-smith/jobs/` to read |
| `NO_COLOR` | unset | any non-empty value drops all colour (glyphs remain) |
| `FORCE_COLOR` | unset | `0` or `false` treated as `NO_COLOR` |
| `TERM` | unset | `dumb` treated as `NO_COLOR` |

`.agent-smith/` is per-repo state, so the repo you launched Claude in *is* the right
default and there is no third fallback: `$.fs.ancestors` turned out not to be
directory ancestry (see [§ Resolved](#resolved-the-pane-s-reader-used-not-to-load)),
so "search upward for a jobs directory" is not available, and inventing a default
path would make the mod report another machine's jobs.

`$.env.get` requires each name as a string literal (VERIFIED — a computed name
is refused at compile time), which is why they are spelled out rather than
looped over.

**`DEFAULT_REPO` in `hooks/register.tsx` is the empty string.** It used to be
`/Users/gathrid/Repos/renyi`, which is not a thing a shipped plugin should
contain: on another machine that path is either absent or — worse — someone
else's repo, and the band would confidently draw their jobs. It is empty now, and
`session.start`'s `e.cwd` fills it in; `register.tsx` reads the result from the
`bandConfig` atom so both surfaces use it.

## Canonical tracking

`hooks/canonical.ts` supplies the same job projection to the band, pane and
native task bridge. Lists read `job.json`, optional `progress.json` and
`acceptance.json`, plus an orphan marker; they never scan event logs or reports.
An unreadable snapshot shows an error while retaining the last observed rows.

Detail reads the selected job's report and bounded `view.json`: up to 60 tool
previews, 200 assistant messages / 64,000 characters, 64,000 prompt characters
and 4,000 preamble characters. Truncation is explicit. Older jobs without a view
show a warning, summary and report; the UI does not backfill by scanning logs.

The band is only the glance: live workers plus finished ones for the linger
window, at most four rows. Each row is a plain Button with hotkey `1`–`4`. The
host answers a bare digit in an empty prompt by pressing a band Button without
focusing the band, so one key opens the sidebar on that worker. `/forge` opens
the sidebar on this session's list, `/forge all` on the repository's, and
`/forge <name or job id>` on one worker from either, this session's first; an
unknown name shows a toast and the list. `/forge pane` is the session list too.
Each of these asks `ui.open` for focus, which the host grants only over an empty
prompt. The command's reply counts this session's workers (`2 running · 1
finished`, or `No agents in this session`); `/forge all` labels its counts
`repository: …`.

The list shows running and checking workers first, then a "Recent" section of
settled ones, most recent first. A settled row ends with `started HH:MM`, so two workers
with alike names can be told apart. A worker that exited while its checks run reads
`exited · checking: <check>`, never `done`. A failure from the last 24 hours is drawn red
with its failure label; after that it is drawn dim like other finished work.

The worker view is one scroll: a header (status, name, provider·model, elapsed
or duration, checks), the task as one line, the live transcript of assistant
text and tool rows, then the result and the output of failing checks once the
worker has finished. It keeps its end in view as output arrives. Scrolling up
pauses that; scrolling back to the bottom resumes it.

| Control | Action |
|---|---|
| `1`–`4` in an empty prompt | Open the sidebar on that band row's worker |
| `1`–`9` in the list | Open a worker; Tab and Enter work too |
| `n` / `p` in the list | Next / previous page, shown only past nine workers |
| `a` / `s` in the list | Show the repository's workers / this session's again |
| `t` in a worker | Expand the task to the prompt as sent, preamble included |
| Enter on a tool row | Show its input and output |
| `b` | Back to the list |
| `x` | Close the sidebar |
| Escape | Return keyboard focus to the prompt (host behaviour) |

Escape cannot also mean "back": the host never delivers it to a mod, it returns
the focus. The engine test harness presses rendered component keys; it does not
inject physical hotkeys, so verify the digits in a real session.

New writer snapshots add an ordered `timeline` alongside the older fields, with
up to 100 activity rows, 60 tools and 64,000 assistant characters. Tool completion
updates its original row. Missing timelines show an explicit old-snapshot fallback.
Recorded worker IDs group invocations into one list row; the worker view links to
earlier runs. Detail reads are cached for the three-second data cadence.

Native tasks use real host TaskCreate/TaskUpdate IDs. They are a task projection,
not Claude Agent/subagent sessions, and are created only for this session's
live launches. Pending acceptance keeps them in progress.
Successful settled tasks close after ten seconds; failed, canceled or rejected
tasks remain completed with an explicit outcome in their subject.

## Layout

```
.claude-plugin/plugin.json   the manifest; `types` points at types/index.d.ts
hooks/hooks.json            { "modules": ["./register.tsx"] }   — exactly, max 1
hooks/register.tsx          § BAND (band author) + § PANE (pane author)
hooks/band.ts               the band's pure rules
hooks/canonical.ts          THE READER — over `.agent-smith/jobs`, via an injected filesystem
hooks/fs.ts                 `FsLike` and `toEpoch`, shared by the readers
hooks/format.ts             pure formatting, shared by band and pane
hooks/stale.ts              livenessOf and its thresholds, shared by band and channel
hooks/notice.ts             completion notice words and who may announce
types/index.d.ts            RadarJob + the PluginState declaration
tests/                      node --test: the RULES
tests/engine/               claude plugin test: the RENDERING
```

### Why the logic is not in `register.tsx`

A hooks module may import only `claude-code` and files inside the plugin folder,
and `claude-code` resolves only inside Claude Code. Node's type stripping has no
JSX transform, so **any `.tsx` import is a hard parse error under
`node --test`**. Logic living in `register.tsx` would therefore be untestable —
which defeats the point of making it pure. So:

- `band.ts` — glyphs, NO_COLOR, linger, the row cap, the
  line. Imports `./format.ts` (the shared vocabulary), not `claude-code`.
- `canonical.ts` — takes an `FsLike` (`fs.ts`) and is handed `$.fs`. Imports no
  `node:` builtin and no `claude-code`.

`register.tsx` then does nothing but register hooks and lay out what those
return.

## Tests

**Two runners, two questions. Both are needed.**

```bash
# the RULES
npm test                                  # from the repo root
node --test --experimental-strip-types "the-codes/surfaces/mod/tests/*.test.ts"

# the RENDERING
claude plugin test the-codes/surfaces/mod
```

`tests/*.node-test.ts` are pure functions, no TUI, no engine: elapsed padding,
truncation, the 4-row cap, glyph choice, `noColor`, and the canonical reader over
an in-memory filesystem.

`tests/engine/band.engine.test.tsx` loads the plugin through the engine's own
host and asserts on the drawn elements: every `<Text>` carries
`wrap="truncate-end"`, `hasSurvey` yields to the host, and a finished row expires.

**`claude plugin test` reports the two `node --test` files as "did not load",
and that is expected.** It refuses `node:assert` / `node:test` outright
(VERIFIED: "cannot import 'node:assert/strict' … a hooks module imports its own
files by relative path and 'claude-code', nothing else"), so it can never be the
runner for them. The pane's `hooks/__tests__/format.test.ts` has the same
property. They are complementary, not alternative.

## Deviation from TERMINAL-UI.md: elapsed is last

The brief's sample layout and TERMINAL-UI.md L129-132 disagree:

```
 ● implement-musm82da  12m04s · 341 tools · cargo test --workspace   ← the mock
```

That puts the ticking field in the middle, which L129-132 forbids: "the volatile
field ticks every second; if it sits mid-line, everything after it shifts
horizontally each tick."

**The band puts elapsed last.** The mock's own justification is that the band
must read in its first 40 columns, and `12m04s` at column 3–8 is inside 40; the
activity clause past column 40 is exactly the "everything past that may be
truncated without loss" the same rule allows.

**The pane keeps the mock's order**, and it is right there. `format.ts`'s
`ELAPSED_WIDTH = 6` right-alignment makes the cell constant-width, so nothing to
its right moves — and a pane's rows are redrawn on a *press*, not on a tick, so
the clock is never the only thing changing. The band has no such guarantee: its
only in-place redraw is the 1 Hz tick, which changes the clock and nothing else.

Both orderings use the same 6-column cell, so the two surfaces agree on how much
room the clock takes. They differ in order only.

## Pushback: the design mock is not internally aligned

```
 ● implement-musm82da  12m04s · 341 tools · cargo test --workspace
 ● review-muroviej      2m18s ·  22 tools · reading decoded_view.rs
 ✓ research-muroabc finished (48s · 8 tools)
```

The three clocks do not line up in a monospace terminal — `12m04s` is 6 columns,
`2m18s` is 5, `48s` is 3, and the `·` separators after them land on different
columns. The pane fixes this with `ELAPSED_WIDTH` right-alignment and a padded
tool-count cell (`TOOL_COUNT_WIDTH = 3`). The band does not pad the tool count,
because the band never compares rows to each other the way a list does — the
activity clause is the varying field and it is truncated at the source anyway.

## Resolved: the pane's reader used not to load

**CLOSED.** `hooks/job-source.ts` imported `node:path` and reached into
`../../../harness/`, and the 2.1.292 loader refuses both:

```
cannot import "node:path" (from hooks/job-source.ts): a hooks module
  imports its own files by relative path and "claude-code", nothing else
cannot import "../../../harness/agy-staff.ts": it is outside the plugin's folder
```

So the mod did not load at all, and nothing in it worked. It is now one reader,
`hooks/canonical.ts`, over `.agent-smith/jobs`.

The acceptance test is a real run, not `plugin validate`, because the failure
mode is a load-time refusal that a typechecker cannot see:

```bash
claude --plugin-dir ./the-codes/surfaces/mod -p "ok"
# must print no "hooks module did not load" line
```

### Other engine constraints this code was written against

All VERIFIED against the 2.1.292 binary by running it, not assumed:

- `$.fs` is the **only** file access. `node:fs`, `node:path` and friends are
  refused in a hooks module, and so is any import escaping the plugin folder.
  Relative imports *within* the plugin are fine.
- **`$.cwd` is refused** — `$` is only ever spelled `$.noun.event(...)`. The
  session's cwd arrives as `session.start`'s `e.cwd`.
- **`$.fs.ancestors` is not directory ancestry.** It resolves names for the
  host's own `.md` files and rejects anything else.
- `$.fs` reads and writes text, capped at 4 MiB (VERIFIED: writing 6 MiB is
  refused by byte count). 803 KB is the largest `events.jsonl` in the corpus.
- **`process` is undefined** in a hooks module. No `process.stdout`, no
  `process.cwd()`.
- **One matcher-less registration per event per module.** Registering
  `session.start` twice is refused outright, which is why the band's session
  start is an exported `startBand($)` the pane awaits inside the handler it
  already has, rather than a second `on('session.start')`.
- **A `command.run` matcher must equal the registered command name.** They were
  `'agent-smith'` and `'radar'` for one commit, which fails silently: the pane
  simply never opens.
- **`$` may only be passed to a top-level function declaration**, and a
  registration callback may not return a value the caller keeps. Hence
  `fsOf($)` builds an object of arrow functions rather than passing `$`.
- **`plugin.json`'s `name` must equal the atom keys' `plugin`.** Mismatched, the
  validator reports "only a value's owner writes it".
- Atom keys must be declared in the manifest's `types` contract.

## Scope boundary

The band owns `hooks/band.ts` and § BAND of `hooks/register.tsx`
(plus the four `PluginState` atoms it adds). It does **not** touch
`hooks/format.ts`, `hooks/stale.ts`, `hooks/__tests__/format.test.ts`, or
§ PANE. The band↔pane coupling is three statements in `register`:

```ts
registerBand(on);   // registers the band's render hook + dispatch poll
// …inside the pane's own session.start:
await startBand($, e.cwd); // the band's config, first poll, and two clocks
```

…and one shared atom. § PANE reads `bandConfig.repo` rather than `$.cwd`, because
`$.cwd` is refused and the session cwd has to be captured somewhere; sharing the
atom is what stops the band and the pane watching different repos.

Deleting the band leaves the pane working unchanged.

## Coupling to the rest of the repo

**None at runtime.** A hooks module cannot import from outside its folder, so
the mod is standalone. That is a hard constraint of the mod API, not a
preference, and it is why small helpers (the stall grace, the activity phrasing) are restated inside `hooks/` rather than
imported from `harness/`.

The coupling that *does* exist is one-directional and written down:

| in the mod | must stay in step with | if it drifts |
|---|---|---|
| `hooks/stale.ts STALL_GRACE_MS` | `surfaces/channel/src/watch-source.ts` (imports it) | the band says healthy while the channel says stalled — the exact contradiction this project exists to prevent |
| `hooks/canonical.ts readForgeJob()` | `harness/normalize.ts` | the band draws `✓` where the channel draws `failed` |

Each restatement says so at the point of use and names the counterpart.
`hooks/stale.ts` is a whole file for one constant, which is the honest shape of
this problem.
