# agent-smith — the band

A Claude Code mod that draws **one live line per running agy / Codex / OpenCode
job** in the `AbovePrompt` band, and opens a browsable pane on `/radar`.

```
 ● implement-musm82da-f1dc1fe4 cargo test --workspace · 341 tools ·     12m04s
 ● implement-muroviej-a23df195 reading decoded_view.rs ·  22 tools ·     02m18s
 ! implement-musm82da-f1dc1fe4 stalled ·  341 tools · 1h02m03s
 ✓ research-muroabc-f1dc1fe4 finished, warnings ·  8 tools ·      48s
   +2 more · /radar
```

**This file covers the band.** The pane (`/radar`) is a separate surface with
a separate owner; see [§ Scope boundary](#scope-boundary).

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
- **Finished jobs linger 30 s, then leave.** Measured from when agy-staff wrote
  the terminal file — *not* from when we first noticed — so a corpus of 20
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
export AGY_RADAR_REPO=/path/to/repo              # defaults to /Users/gathrid/Repos/renyi
claude
```

The band needs no flags, no channels, and no model tokens. It reads
`<repo>/.agy-staff/jobs/` and nothing else.

### Configuration

| variable | default | meaning |
|---|---|---|
| `AGY_RADAR_REPO` | `/Users/gathrid/Repos/renyi` | the repo whose `.agy-staff/jobs/` to read |
| `NO_COLOR` | unset | any non-empty value drops all colour (glyphs remain) |
| `FORCE_COLOR` | unset | `0` or `false` treated as `NO_COLOR` |
| `TERM` | unset | `dumb` treated as `NO_COLOR` |

`$.env.get` requires each name as a string literal (VERIFIED — a computed name
is refused at compile time), which is why they are spelled out rather than
looped over.

**The default repo is a per-developer absolute path.** That is not a thing a
shipped plugin should contain; it is here because the band was developed against
a real 20-job corpus and a band that has only seen a fixture meets HAZARD A for
the first time in production. Change `DEFAULT_REPO` in `hooks/jobs.ts`, or set
`AGY_RADAR_REPO`, before releasing this.

## What it reads

Nothing is spawned. agy-staff already writes a continuously-updated snapshot for
every job; the band reads it. Verified against 20 real jobs in
`/Users/gathrid/Repos/renyi/.agy-staff/jobs/`:

```
<id>.spec.json              mode, model, profile, task title
<id>.progress.json          recent_activities[≤5], last_event_at, warnings   (~100ms)
<id>.events.jsonl           tool counts, from the highest step_index
<id>.log                    the ONLY start time: "worker started … at ISO"
<id>.result.md.status.json  status, warnings, finished_at      <- the terminal anchor
<id>.result.md              only its EMPTINESS, never its contents
<id>.spec.json.cancel       the cancellation instant
```

### The three hazards, and where each is handled

| hazard | what happens | where |
|---|---|---|
| **A** | on a warning-free success agy-staff **deletes** `progress.json` and `events.jsonl`. A missing progress file means FINISHED, never "missing". | `jobs.ts resolve()` — no status row reads terminal state out of an absent file; `band.ts reconcile()` — a terminal row never un-finishes on weaker evidence |
| **B** | a `.spec.json.cancel` marker can be written *before* `status.json` is finalised | `jobs.ts resolve()` row 1, outranking `status.json` |
| **C** | some `result.md` carry leading `<system_notification>` blocks (12 in one real job) | `jobs.ts looksEmpty()` strips before judging emptiness |

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
hooks/jobs.ts               the reader, over an injected filesystem
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

## Tests

**Two runners, two questions. Both are needed.**

```bash
# the RULES — 57 tests
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

## Known blocker: the pane's reader cannot load

`hooks/job-source.ts` (pane author) imports `node:path` and reaches into
`../../../harness/`. **VERIFIED against the 2.1.292 loader**, both are refused:

```
cannot import "node:fs/promises" (from hooks/register.tsx): a hooks module
  imports its own files by relative path and "claude-code", nothing else
cannot import "../../../harness/agy-staff.ts": it is outside the plugin's folder
```

So `claude plugin validate the-codes/surfaces/mod` currently fails on the **pane's**
file, not on the band's. The band's own code validates: stub `job-source.ts` and
the manifest, the hooks, the atoms and every `$.fs` / `$.env` / `$.clock` /
`$.state` call pass.

Two ways to close it, and the second is better:

1. Port `job-source.ts` to take an `FsLike` like `jobs.ts` does, dropping the
   `node:*` imports and inlining the three harness helpers it uses.
2. **Delete `hooks/jobs.ts` and have the band call `job-source.ts`.** Two readers
   means two answers to "is this job still running", which is the drift this
   project exists to eliminate. `jobs.ts` is a stopgap, not a second opinion.

`register.tsx` also uses `$.cwd` and `process.cwd()` in the pane's half, and
`$.cwd` is refused the same way ("`$` is always spelled `$.noun.event(...)` at
the call site").

### Other engine constraints this code was written against

All VERIFIED with `claude plugin validate` / `claude plugin test`, not assumed:

- `$.fs` is the **only** file access. `node:fs`, `node:path` and friends are
  refused in a hooks module, and so is any import escaping the plugin folder.
- **One matcher-less registration per event per module.** Registering
  `session.start` twice is refused outright, which is why the band's session
  start is an exported `startBand($)` the pane awaits inside the handler it
  already has, rather than a second `on('session.start')`.
- **`$` may only be passed to a top-level function declaration**, and a
  registration callback may not return a value the caller keeps. Hence
  `fsOf($)` builds an object of arrow functions rather than passing `$`.
- **`plugin.json`'s `name` must equal the atom keys' `plugin`.** Mismatched, the
  validator reports "only a value's owner writes it".
- Atom keys must be declared in the manifest's `types` contract.

## Scope boundary

The band owns `hooks/band.ts`, `hooks/jobs.ts`, and § BAND of `hooks/register.tsx`
(plus the four `PluginState` atoms it adds). It does **not** touch
`hooks/format.ts`, `hooks/job-source.ts`, `hooks/stale.ts`,
`hooks/__tests__/format.test.ts`, or § PANE. The band↔pane coupling is two
statements in `register`:

```ts
registerBand(on);   // registers the band's render hook + dispatch poll
// …inside the pane's own session.start:
await startBand($); // the band's config, first poll, and two clocks
```

Deleting both leaves the pane working unchanged.

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