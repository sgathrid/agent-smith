# agent-smith — the band

A Claude Code mod that draws **one live line per running agy / Codex / OpenCode
job** in the `AbovePrompt` band. `/forge` expands the roster and worker detail
above the prompt; `/forge pane` requests the optional inspector.

```
 ● implement-musm82da-f1dc1fe4 cargo test --workspace · 341 tools ·     12m04s
 ● implement-muroviej-a23df195 reading decoded_view.rs ·  22 tools ·     02m18s
 ! implement-musm82da-f1dc1fe4 stalled ·  341 tools · 1h02m03s
 ✓ research-muroabc-f1dc1fe4 finished, warnings ·  8 tools ·      48s
   +2 more · /forge
```

This file covers tracking and the band. Legacy adapter notes follow the current
canonical contract below.

---

## What it does

One line per job, in this order — TERMINAL-UI.md's own hierarchy (identity →
liveness → outcome), with the **elapsed time last**:

| state | glyph | colour | line |
|---|---|---|---|
| running | `●` | yellow, bold | `● <id> <activity> · N tools · 12m04s` |
| stalled | `!` | cyan, bold | `! <id> stalled · N tools · 1h02m03s` |
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
- **Nothing renders when there is nothing to say.** Not "0 jobs", not an empty
  box. The host's own output comes back untouched, as our last child.
- **A survey holds the band.** `e.props.hasSurvey` → we draw nothing.
- **Zero animation, no spinner.** Both reference mods ship zero and are calmer
  for it (L191).
- **The 1 Hz clock is gated on visibility.** Idle costs one comparison a second
  and never a redraw. A 1 Hz repaint of nothing is a laptop fan (L161).

## Install

```bash
claude plugin validate the-codes/surfaces/mod    # must pass
claude --plugin-dir the-codes/surfaces/mod       # or install it
```

Then, in the repo you want to watch:

```bash
claude          # launched IN the repo; .agent-smith/jobs is found there
```

The band needs no flags, no channels, and no model tokens. It reads
`<repo>/.agent-smith/jobs/` by default. To view legacy jobs, set
`AGENT_SMITH_LEGACY_JOBS=1` before launching Claude.

To watch a *different* repo from the one you launched in:

```bash
export AGY_RADAR_REPO=/path/to/repo
claude
```

### Configuration

| variable | default | meaning |
|---|---|---|
| `AGY_RADAR_REPO` | the session's cwd | the repo whose `.agent-smith/jobs/` to read |
| `AGENT_SMITH_LEGACY_JOBS` | unset | `1` selects the legacy `.agy-staff/jobs/` reader |
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

**`DEFAULT_REPO` in `hooks/jobs.ts` is now the empty string.** It used to be
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

`/forge` opens during a turn and expands in the bottom band, whose height and
scroll window the host controls. It preserves the host's band content and yields
while a survey is displayed. It never opens a sidebar automatically.

| Control | Action |
|---|---|
| Ctrl+X then Tab | Focus the band or inspector; the pane shows this hint beside its controls |
| `a` / `h` in roster | Active / History |
| `1`–`9` | Open a visible worker |
| `n` / `p` in roster | Next / previous page |
| `a` / `t` / `r` / `k` in detail | Activity / Task / Result / Checks |
| `b` | Back to the roster |
| `y` in a settled failed or rejected job | Acknowledge it and move it to History |
| `f` in Activity | Toggle following; manual scrolling pauses it |
| `p` in Task | Show or hide the prompt preamble |
| `c` / `u` in roster | Acknowledge settled attention items and dismiss other settled rows / restore them |
| `e` | Open the larger inspector |
| `x` | Collapse the bottom view or close the inspector |
| Escape | Return keyboard focus to the prompt |

The inspector uses the same views. The host chooses its placement: docked on a
wide fullscreen terminal, otherwise inline. Arrow keys, page keys and the wheel
use the host's scrolling behavior; the mod does not bind those keys itself.

Acknowledged failures leave Active and remain visible in History. Their
acknowledgement is stored by repository and job ID in host plugin state, so a
reload does not reopen the same attention item. Running jobs and pending checks
stay visible. Restore dismissed resets the acknowledgements as well as settled
row dismissals. The engine test harness presses rendered component keys; it does
not inject physical hotkeys. Verify shortcuts in the host by opening `/forge`,
pressing Ctrl+X then Tab, pressing `h` and `a` to switch roster tabs, and Escape
to return focus to the prompt.

New writer snapshots add an ordered `timeline` alongside the older fields, with
up to 100 activity rows, 60 tools and 64,000 assistant characters. Tool completion
updates its original row. Missing timelines show an explicit old-snapshot fallback.
Activity defaults for live/checking jobs; Result defaults for settled jobs. Checks
show execution-independent acceptance and expandable results. Errors expand by
default. Recorded worker IDs group invocations; Task links to earlier runs.
Detail reads are cached for the three-second data cadence. Selection persists
through completion, and scrolling the output pauses automatic following.

Native tasks use real host TaskCreate/TaskUpdate IDs. They are a task projection,
not Claude Agent/subagent sessions. Pending acceptance keeps them in progress.
Successful settled tasks close after ten seconds; failed, canceled or rejected
tasks remain completed with an explicit outcome in their subject.

## Legacy adapter evidence

The remaining sections document the opt-in `.agy-staff` adapter and its original
corpus investigation. They do not describe the default canonical reader.

## What it reads

Nothing is spawned. agy-staff already writes a continuously-updated snapshot for
every job; the band reads it. Verified against 20 real jobs in
`/Users/gathrid/Repos/renyi/.agy-staff/jobs/`:

```
<id>.spec.json              mode, model, profile, task title
<id>.progress.json          recent_activities[≤5], last_event_at, warnings   (~100ms)
<id>.events.jsonl           tool counts from the highest step_index; tool history
                            (pane's detail view only, DONE records only)
<id>.log                    the ONLY start time: "worker started … at ISO"
<id>.result.md.status.json  status, warnings, finished_at      <- the terminal anchor
<id>.result.md              EMPTINESS decides status, always; the CONTENTS are
                            read only when the pane's detail view asks
<id>.spec.json.cancel       the cancellation instant
```

### The three hazards, and where each is handled

| hazard | what happens | where |
|---|---|---|
| **A** | on a warning-free success agy-staff **deletes** `progress.json` and `events.jsonl`. A missing progress file means FINISHED, never "missing". | `jobs.ts resolve()` — no status row reads terminal state out of an absent file; `band.ts reconcile()` — a terminal row never un-finishes on weaker evidence |
| **B** | a `.spec.json.cancel` marker can be written *before* `status.json` is finalised | `jobs.ts resolve()` row 1, outranking `status.json` |
| **C** | some `result.md` carry leading `<system_notification>` blocks (12 in one real job) | `jobs.ts stripSystemNotifications()` — called by both `looksEmpty()` (status) and `reportBody()` (the pane's rendered report), so the two cannot disagree |

### The headline rule

> An empty response with warnings is **not** a clean success.

agy-staff writes `{status:'done', warnings:true}` and an empty `result.md` when a
tool is soft-denied, then exits 0 having done nothing. `resolve()` maps that to
`failed`, so the band draws `✗ … failed · suspicious success`, never a green ✓.

The downgrade fires on **emptiness regardless of the `warnings` flag** — an empty
result is empty whether or not agy-staff noticed, and a rule gated on its
self-report is a rule it can forget to apply.

The converse is also honoured: a **non-empty** result with `warnings:true` stays
`succeeded` and says `finished, warnings` *in words*. Recolouring it would
contradict `harness/normalize.ts`, and red is reserved for real failures.

## Layout

```
.claude-plugin/plugin.json   the manifest; `types` points at types/index.d.ts
hooks/hooks.json            { "modules": ["./register.tsx"] }   — exactly, max 1
hooks/register.tsx          § BAND (band author) + § PANE (pane author)
hooks/band.ts               the band's pure rules
hooks/jobs.ts               THE READER — one, over an injected filesystem
hooks/format.ts             pure formatting, shared by band and pane
hooks/stale.ts              the stall threshold, shared by band and channel
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

- `band.ts` — glyphs, NO_COLOR, linger, the row cap, the anti-flicker fold, the
  line. Imports `./format.ts` (the shared vocabulary), not `claude-code`.
- `jobs.ts` — takes an `FsLike` and is handed `$.fs`. Imports no `node:` builtin
  and no `claude-code`.

`register.tsx` then does nothing but register hooks and lay out what those
return.

## One reader

**`hooks/jobs.ts` is the only file in the mod that reads `.agy-staff/jobs/`, and
`resolve()` is the only function that decides a job's status.** § BAND and § PANE
both call it, so the band above the prompt and the list inside `/forge` cannot
report different states for the same job. Two readers would mean two answers to
"is this job still running", which is the drift this project exists to eliminate.

This was not free. The pane used to have its own reader, `hooks/job-source.ts`,
and it could not load — it imported `node:path`, `node:fs/promises` and
`../../../harness/`, all of which the mod loader refuses:

```
agy-radar: hooks module did not load: cannot import "node:path" (from hooks/job-source.ts):
  a hooks module imports its own files by relative path and "claude-code", nothing else
```

It was deleted rather than repaired, and its capability came here instead:

| capability | where it lives now | note |
|---|---|---|
| status, elapsed, tool count, activity, task, warnings | `jobs.ts resolve()` | was already here — **this was the drift** |
| `result.md` contents for the detail view | `jobs.ts`, behind `withReport` | `reportBody()` strips hazard C first |
| tool history for the detail view | `jobs.ts readToolHistory()` | reads `DONE` records only |
| `stripSystemNotifications` | `jobs.ts`, exported | one de-polluter, not two |
| `sortJobs`, `countSummary` | `format.ts` | pure presentation, never touched the disk |

### Why it was not vendored instead

The alternative was copying `harness/agy-staff.ts`'s reader and
`harness/normalize.ts`'s rules into the plugin folder. That would have made the
mod *load* while leaving two readers with two precedence tables and two answers
to the same question — a slower, better-documented version of the problem. Vendoring
the one genuinely-shared pure helper (`stripSystemNotifications`, 10 lines) is
where the boundary belongs.

### The cost of the merge, stated plainly

`readToolHistory` used to tail-read the last 256 KB of `events.jsonl` with
`node:fs`'s `open()`. `$.fs` has no partial read, so it now reads the whole file:
**803 KB worst case in the real corpus, against a verified 4 MiB `$.fs` limit.**
A file over the cap rejects, is caught, and yields no history. That is fine today
and is the thing to revisit if jobs ever get long enough to matter.

Two smaller notes, both verified against the 2.1.292 loader rather than assumed:

- **`$.cwd` is refused**: "`$.cwd` is used as a value … `$` is always spelled
  `$.noun.event(...)`". The repo comes from `session.start`'s `e.cwd`, folded into
  the `bandConfig` atom once at start, and **§ PANE reads it from that same atom**
  so the two halves cannot be pointed at different repos.
- **`$.fs.ancestors` is not directory ancestry.** It resolves names for the host's
  own `.md` files and rejects anything else. `AGY_RADAR_REPO` → session cwd is the
  whole resolution chain, and there is no third fallback to reach for.

## Tests

**Two runners, two questions. Both are needed.**

```bash
# the RULES — 63 tests
npm test                                  # from the repo root
node --test --experimental-strip-types "the-codes/surfaces/mod/tests/*.test.ts"

# the RENDERING — 13 tests
claude plugin test the-codes/surfaces/mod
```

`tests/band.test.ts` and `tests/jobs.test.ts` are the ones the brief asks for:
pure functions, no TUI, no engine — elapsed padding, truncation, the 4-row cap,
glyph choice, `noColor`, the anti-flicker fold, and a filesystem assembled from
the **real corpus files** so a layout change in agy-staff fails a test rather
than silently emptying the band.

`tests/engine/band.engine.test.tsx` loads the plugin through the engine's own
host and asserts on the drawn elements: the running row is `yellow`+`bold` and
reads `12m04s` from the real log's timestamp, every `<Text>` carries
`wrap="truncate-end"`, `hasSurvey` yields to the host, and the deleted-progress
case draws `✓ … finished` rather than disappearing.

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

## Pushback: `341 tools` is not knowable for most finished jobs

The mock's `341 tools` comes from `events.jsonl`. agy-staff **deletes
`events.jsonl` on a warning-free success** — the same hazard A that applies to
`progress.json`. In the real 20-job corpus all 20 have `warnings: true`, so all
20 still have their events file and all 20 produce a real count. A warning-free
success would not.

So the band omits the segment when there is no count, rather than printing `0`
(a fabrication about a job that ran hundreds of steps) or `?` (which implies we
looked and failed). A `0 tools` on a line the user has read is worse than a
slightly shorter line.

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

So the mod did not load at all, and nothing in it worked. It is now one reader
with one status function — see [§ One reader](#one-reader) for what happened to
its capability and why vendoring was the wrong fix.

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

The band owns `hooks/band.ts`, `hooks/jobs.ts`, and § BAND of `hooks/register.tsx`
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
preference, and it is why three small helpers (`stripSystemNotifications`, the
stall grace, the activity phrasing) are restated inside `hooks/` rather than
imported from `harness/` and `core/`.

The coupling that *does* exist is one-directional and written down:

| in the mod | must stay in step with | if it drifts |
|---|---|---|
| `hooks/jobs.ts stripSystemNotifications` | `harness/agy-staff.ts` | one says a report is empty and the other does not |
| `hooks/stale.ts STALL_GRACE_MS` | `core/liveness.ts DEFAULT_GRACE_MS` | the band says healthy while the channel says stalled — the exact contradiction this project exists to prevent |
| `hooks/jobs.ts resolve()` | `harness/normalize.ts` | the band draws `✓` where the channel draws `failed` |
| `types/index.d.ts RadarJob` | `core/types.ts Job` | two row shapes, one UI |

Each restatement says so at the point of use and names the counterpart.
`hooks/stale.ts` is a whole file for one constant, which is the honest shape of
this problem.
