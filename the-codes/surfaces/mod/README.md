# `agy-radar` — the pane

A Claude Code mod. `/agy-radar` opens a browsable pane over every
[agy-staff](https://github.com/) job in the current repo: what is running, what
each job did, what it warned about, and the report it produced.

This is **Surface 1** of two. It reaches your eyes and costs zero tokens. The
[channel](../channel/README.md) reaches Claude's cognition and costs ~50 tokens
per event. Neither replaces the other; see `docs/ARCHITECTURE.md`.

---

## Install

The mod is dependency-free (Node builtins only) and ships as a directory.

```
the-codes/surfaces/mod/
├── .claude-plugin/plugin.json
├── hooks/
│   ├── hooks.json          { "modules": ["./register.tsx"] }
│   ├── register.tsx        band + pane (see MERGE NOTE)
│   ├── format.ts           PURE formatters — no JSX, no I/O
│   ├── job-source.ts       the only file that touches the filesystem
│   ├── stale.ts            the shared stall threshold
│   ├── band.ts             the band half (other engineer)
│   └── __tests__/
└── types/
    ├── index.d.ts          RadarJob + PluginState
    └── claude-code.d.ts    a local, PARTIAL declaration of the mod API
```

Point Claude Code at `the-codes/surfaces/mod`, then run `/agy-radar`.

### `hooks.json` has no `modulePath`

```json
{ "modules": ["./register.tsx"] }
```

That is the whole file. Verified in 2.1.292 — `modulePath` is not a key this API
accepts, and a `hooks.json` containing one silently loads nothing.

---

## MERGE NOTE — the band is a separate engineer's file

`register.tsx` is shared with a concurrent author writing the **band** (the
1–4 line strip above the prompt). The split is structural, not a promise:

| Section | Owner | Rule |
|---|---|---|
| `band.ts` | band author | Pure band logic, no JSX. Do not edit to fix a pane bug. |
| `register.tsx` § PANE | this file | Self-contained below the marker. |
| `format.ts` | **shared** | Both halves import it. The single source of truth for a job line. |

The pane half needs exactly one thing from the band half: the `now` atom. Both
sides import the same atom object, so there is one clock and the band and the pane
cannot show elapsed times that disagree.

Merging is: copy the `§ PANE` section, add its imports, add its `on(...)` calls to
`register()`. There is no shared local state beyond the atom block.

---

## Why the pure code is not in `register.tsx`

`node --test --experimental-strip-types` **cannot load a `.tsx` file** — TypeScript's
type stripping has no JSX transform, so any JSX in an imported module is a hard parse
error. Verified before writing any of this.

So everything testable lives in `format.ts` (pure) and `job-source.ts` (I/O), and
`register.tsx` contains only layout. That also happens to be the right architecture:
the pane's logic is testable without the mod API, which is a mock I would otherwise
have to write.

```sh
node --test --experimental-strip-types "the-codes/surfaces/mod/**/*.test.ts"
```

---

## The two-level pane

### Level 1 — the list

```
 2 running · 14 finished

 ● implement-musm82da   12m04s · 341 tools · cargo test --workspace
 ● review-muroviej      2m18s  · 22 tools · reading decoded_view.rs
 ✓ research-muroabc     48s · 8 tools

 q close   c clear finished
```

Rows are `Button`s with digit hotkeys, so the whole list is keyboard-navigable.
`q` closes. `c` dismisses finished jobs **locally** — see below.

### Level 2 — the detail

Selecting a row opens the job, in this order, and the order is an argument:

| Section | Why there |
|---|---|
| status · elapsed · tool count | same shape as the list row, so the levels look like one product |
| task | the first question about a job is "what was it for" |
| current reasoning | live jobs only; a finished job's last thought is not news |
| tool history | newest last, so it reads forward in time |
| **warnings** | **directly above the report, on purpose** |
| report | markdown, from `<jobId>.result.md` |

Warnings sit above the report because a warning changes how the report should be
read. A job that reports `warnings: true` with an empty result is a **suspicious
success**, not a success, and burying that under 8 KB of prose guarantees it gets
missed.

---

## The three hazards, and where they are handled

agy-staff's on-disk layout has three real traps. All three are verified against the
20 real jobs in `/Users/gathrid/Repos/renyi/.agy-staff/jobs`, and all three are
handled by **delegating to `harness/`** rather than by re-implementing them.

| | Hazard | Handling |
|---|---|---|
| **A** | `progress.json` and `events.jsonl` are **deleted** on a warning-free success | Terminal state is anchored on `result.md.status.json`, which is always written. A vanished `progress.json` means **finished**, never "missing job". |
| **B** | `.spec.json.cancel` marks cancellation, and can appear *before* `status.json` is final | `normalize()` folds the marker in ahead of `status.json`. |
| **C** | `result.md` can carry **12** prepended `<system_notification>` blocks | Stripped by the reader via `stripSystemNotifications()`. |

Verified on the real corpus:

```
raw result.md          15857 chars, 12 <system_notification> blocks
after strip            8163 chars, starts "## What I changed"
warnings               polluted_result · tool_error · suspicious_success
```

The tool count is `null` whenever `events.jsonl` is absent — which, per hazard A, is
most cleanly-finished jobs. The pane renders a **blank cell**, never `0 tools`,
because "we cannot know" and "it used no tools" are different facts.

### "Empty output + warnings is not success"

`harness/normalize.ts` already implements this. The pane inherits it: such a job
renders as `✗` with a `suspicious_success` warning, and the detail view says
`No report was written.` rather than showing a green tick.

---

## Coupling: what we import and why we do not modify

`job-source.ts` is the mod's **entire** coupling surface to the rest of the repo.
Three imports, all from `harness/`:

```ts
import { AgyStaffReader, stripSystemNotifications } from '../../../harness/agy-staff.ts';
import { normalize } from '../../../harness/normalize.ts';
import { existsSafe, readTextSafe, statSafe } from '../../../harness/safe-fs.ts';
```

Relative paths, because the mod ships as a standalone plugin directory and cannot
resolve a bare specifier for a sibling package. `harness/` is Node-builtins-only, so
this adds **nothing** to the mod's dependency count.

**We do not go through `core/store.ts`.** The store is a SQLite projection built for
history and querying. The pane needs a live read of files another process is
actively rewriting, and the reader already survives that (`safe-fs.ts`). Going
through the store would add a write path the mod has no business owning — surfaces
are read-only projections (`docs/ARCHITECTURE.md`).

### One reader, or two?

**There are two readers in the mod** (`job-source.ts` and `jobs.ts`, the latter
written by the band author). They must agree, and the thing keeping them honest is
that both project onto the **same** `RadarJob` type from `types/index.d.ts`, and both
take their status truth from `harness/normalize()`. Neither re-derives status. If
you add a reader, add a `projectRadarJob` to it, do not add status rules.

> **Known issue, not mine to fix.** `jobs.ts` currently fails `tsc`:
> `Property 'push' does not exist on type 'readonly { code; message }[]'` (4 errors).
> `RadarJob.warnings` is intentionally `readonly` — a rendered snapshot should not be
> mutable. The fix is a local `const w: {...}[] = []` in `jobs.ts`, then assign.

---

## `c clear finished` does not delete anything

`c` records dismissed ids in a host-persisted atom and the list filters against it.

It does **not** touch `.agy-staff/jobs/`. agy-staff owns that directory; deleting
files there to satisfy a UI preference would destroy another process's state, and a
surface is a read-only projection. Running jobs are never dismissible — hiding work
in flight would defeat the point of the surface.

---

## `$.session.messages({ agentId })` — different feature

Worth being explicit, because the reference mod's pane uses it and it does not apply
here.

`$.session.messages({ agentId })` reads a **Claude Code subagent transcript**
(`~/.claude/projects/…/subagents/agent-*.jsonl`). agy-staff jobs have no `agentId`;
they are separate processes writing files to `.agy-staff/jobs/`. Calling it for an
agy job returns `[]` or an error discriminant, never job messages.

So the detail view's "messages" section is built from what agy-staff actually wrote:
`events.jsonl` tool steps and `progress.json`'s `latest_text`. Two different
transcripts, two different sources.

---

## Rules from `TERMINAL-UI.md`, and where they bit

- **Glyphs `● ✓ ✗` only.** Verified by test, not by eye: every glyph is asserted to
  be a single BMP code point with no `Extended_Pictographic`. `⏳`/`✅` are the reason
  this rule exists — terminals render them double-width and silently break every
  column after them.
- **`canceled` is `·`, not `✗`.** `core/types.ts` says a cancelled job is not a bug
  and that alerting on one trains people to ignore alerts. Painting it with the
  failure glyph would contradict the contract that defines it.
- **Colour never carries meaning alone.** Every coloured state also has a distinct
  glyph, so a monochrome terminal loses nothing.
- **`dimColor` for all secondary text, never `gray`.** `gray` is a fixed value that
  vanishes on one of light/dark terminals.
- **`wrap="truncate-end"` on every `<Text>`.** A wrapped status line becomes two rows
  and moves the prompt.
- **Empty state is literally `No jobs yet`** — no box, no spinner, no second line.

### Pushback: the design mock is not internally aligned

The three sample rows in the design put the clock at column 20 on line 1 and column
21 on line 2. The mock is hand-drawn and its own rows disagree. Matching it
byte-for-byte would ship a layout that visibly tears the moment a 3-digit job id
appears.

We implement the **rule** — fixed-width, right-aligned, identical columns — rather
than the typo. `format.test.ts` asserts the property that actually matters (the
clock and tool columns sit at identical offsets across rows of differing id and
clock widths) rather than the exact spacing in an example.

The second reconciliation: `TERMINAL-UI.md` says "put the volatile field last", and
the design puts `elapsed` **before** the activity text. Both are satisfiable because
`elapsed()` is padded to a fixed 6 columns (`ELAPSED_WIDTH`) — so the ticking digit
is the last character of a constant-width cell and nothing to its right moves. See
the comment on `ELAPSED_WIDTH` in `format.ts`.

### Other judgement calls

- **Start time** comes from `[agy-staff] worker started … at <ISO>` in the `.log`
  (present in all 20 real jobs), falling back to `spec.json`'s mtime. We deliberately
  do **not** use the log's `duration=`: it disagrees with wall clock on real jobs
  (`implement-mus165dn` reports `duration=2652s` but ran 7201s from dispatch to
  finish, because it hit a hard execution limit and the response was delivered
  late). Elapsed time is a wall-clock question.
- **Tool count** is the highest step ordinal carrying a tool call, not a line count.
  Each tool step emits an `ACTIVE` and a `DONE` record at the same `step_index`, so
  counting records double-counts. Measured: `implement-muroviej` has 338 tool
  records / 169 distinct step indices.
- **`events.jsonl` is read as a 256 KB tail.** The real file is 516 KB and we re-poll
  every 3 s; the oldest calls are only ever a count.
- **A pane does not call `next(e)`.** `TERMINAL-UI.md`'s "yield to the host" rule is
  about the `AbovePrompt` band, where other mods and Claude Code draw. A pane is ours.

---

## The mod API, as used here

Verified in 2.1.292. `types/claude-code.d.ts` is a **deliberately partial** local
declaration — exactly the surface this mod touches, so that a host API change stops
the build instead of being masked by a permissive stub.

```ts
export const register: Register = (on) => {
  on('session.start', async ($, e, next) => { const rest = await next(e); /* … */ return rest; });
  on('command.run', { command: 'agy-radar' }, async ($) => { /* … */ });
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => { /* … */ });
};

await $.ui.open({ id: PANE, title: 'Agent Smith', focus: true });
await $.ui.close({ id: PANE });
const { Box, Text, Button, Markdown, Code } = $.ui.resolve(e);
```

Atoms are declared at **module scope**, outside the hook closures. An atom created
inside `register()` is a new store on every hot reload, which silently drops the
user's selection:

```ts
const selected = atom({ plugin: 'agy-radar', key: 'selected' }, null as string | null);
```

---

## Known limitations

- **`Box`/`Text`/`Button` are ambient JSX names.** They are resolved at runtime from
  `$.ui.resolve(e)` and never imported, which is why `types/claude-code.d.ts`
  declares a global `JSX` namespace.
- **Read-only by design.** Nothing here writes to `.agy-staff/jobs/`, and `c` filters
  locally. A future "forget this job" feature belongs in `core/store.ts`.
- **agy-staff only.** The reader is one `AgyStaffReader`. Adding Codex or OpenCode
  means another reader projecting onto the same `RadarJob` — no change to any
  formatter or to the render code.