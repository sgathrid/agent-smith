---
name: terminal-ui
description: House rules for the agent-smith terminal UI — the band above the prompt and the /agy-radar pane. Adapted from Renyi's ui-motion-loading skill (Geist + Vercel Web Interface Guidelines + Apple HIG) to a redrawn-in-place terminal surface, and reconciled against what Claude Code's mod API and the shipped reference mods actually do. Read before writing any `surfaces/` rendering code. Covers hierarchy, colour, glyphs, width, timing, truncation and empty states.
---

# Terminal UI for agent-smith

Two surfaces, both in a terminal that is **redrawn, not composited**:

| Surface | Region | Job |
| --- | --- | --- |
| **Band** | 1–4 lines above the prompt | one line per running worker, always glanceable |
| **Pane** | opened with `/agy-radar` | browsable detail: tool history, output, the report |

Sourced rules are **[S]**. House choices where the sources are silent are **[I]**.
Terminal reality is a different medium from the web skill this adapts: **no
layout engine, no pixel widths, no compositing, no `prefers-reduced-motion`.**
Most web rules translate; a few invert. The inversions are called out.

---

## The one rule, unchanged

**Nothing on screen moves unless the user caused it.** [S]

In a terminal this is stronger, not weaker. There is no reflow: text you have
read does not get re-wrapped when a column changes. So the band must:

- **never insert rows above the prompt** the user is composing into
- **never change its row count while the user is mid-prompt**
- **reserve its height**, or hold it at zero

The web analogue is CLS ≤ 0.1 [S, web.dev]; the terminal failure is worse —
content the user is *typing at* moves. `[I]`

---

## Hierarchy: three levels, and only three

Every value shown must answer exactly one of three questions, in priority order.

| Level | Answers | Shown as | Example |
| --- | --- | --- | --- |
| **1. Identity** | what is this? | glyph + short label | `● implement-musm82da` |
| **2. Liveness** | is it moving? | elapsed + activity | `12m04s · cargo test --workspace` |
| **3. Outcome** | did it work? | glyph + verdict | `✗ failed · cargo test exit 1` |

**[I] The single most important rule in this file:** a line must be readable in
its **first 40 columns**. Everything past that is for someone who has already
decided to look, and may be truncated without loss.

What does **not** belong on a band line: token counts, model ids, prompts,
paths, progress percentages, config. That is pane content. Both reference mods
learn this — `agent-radar` caps at `elapsed · tools`, and `review-watch` keeps
findings off the line until the review ends. [S, shipped mods]

---

## Colour

**[S] Never encode meaning by colour alone.** Redundant encoding, three ways:

| State | Glyph | Colour | Weight |
| --- | --- | --- | --- |
| running | `◌` | `yellow` | bold |
| done | `✓` | `green` | — |
| failed | `✗` | `red` | — |
| needs you | `⚠` | `cyan` | bold |

All four are `EAW=Neutral` — one column in every locale. See **Glyphs** below;
an earlier draft used `●` and that was wrong.

If the terminal is monochrome, or the user is colourblind, the glyph still
reads. This is the terminal's version of WCAG's non-colour channel, and Apple
HIG names the exact failure: users *"have particular difficulty with pairings
such as red-green"*. [S]

**Palette — the whole set.** Claude Code's `Text` accepts exactly these named
values (verified in 2.1.292): `red` `green` `yellow` `blue` `magenta` `cyan`
`white` `gray`/`grey` + the `dimColor`/`bold`/`italic`/`underline`/`inverse`
modifiers. There is no hex, so **the palette is fixed and must be chosen once.**

Rules: [S, mod API]

- **Yellow = running, green = done, red = failed.** Git, cargo, pytest and CI
  all agree; do not invent a local convention.
- **`dimColor` for all secondary text** — elapsed time, tool counts, the
  detail sub-line. Never `gray`; `dim` is the theme-aware one and survives
  light and dark terminals. **`gray` is a fixed colour and goes invisible on
  one of them.** This is the most common terminal-UI mistake.
- **Red is reserved.** If everything that is not the status is also red, a real
  failure stops standing out. One accent per line maximum.
- **Honour `NO_COLOR`** (https://no-color.org/). Claude Code already tracks it
  (18 references in the binary). Drop to glyph-only; do not substitute your own
  palette. [S]

---

## Glyphs

**[S] Choose `EAW=Neutral` glyphs — one column in every locale.** This is a
correctness issue, not taste. Width is UAX #11 East Asian Width:
`Neutral`/`Narrow` = 1 column always; `Wide`/`Fullwidth` = 2; **`Ambiguous`/`A`
= 1 column in Western terminals but 2 in CJK-locale terminals.** Per UAX #11
§4.2 the recommended default is to treat ambiguous as narrow — but terminals
differ, and the failure is silent column drift.

Verified against UCD `EastAsianWidth.txt`:

| Glyph | EAW | Verdict |
| --- | --- | --- |
| `✓` `✗` `✔` `◌` `∙` `⚠` `▸` | **N** | **safe** — 1 column everywhere |
| `●` `·` `…` `–` `│` `─` `└` | **A** | risky in CJK locales |
| `⏳` `✅` `❌` | **W** | **never** — 2 columns |

**Correction to the first draft of this file:** `●` was listed as safe. It is
not — it is Ambiguous. That is exactly why **Claude Code ships a different
codepoint per platform**: `U+23FA ⏺` on macOS, `U+25CF ●` elsewhere. Even
Anthropic treats glyph choice as a per-platform negotiation, not solved.

Our set, all `EAW=N`:

```
running    ◌   (U+25CC)   static liveness dot
done       ✓   (U+2713)
failed     ✗   (U+2717)
needs you  ⚠   (U+26A0)
neutral    ∙   (U+2219)
```

We use **`◌` for running, not `●`** — same meaning, genuinely single-width.

**Both reference mods ship the emoji bug.** `review-watch` uses `⏳ ✅ ✗`: the
first two are `EAW=Wide`, so every column after them misaligns. `agent-radar`'s
`● ✓ ✗` is *mostly* fine (only `●` is Ambiguous). We follow neither.

**If you must ship an emoji-block glyph**, append `U+FE0E` to force text
presentation — Claude Code's binary contains `"·✔︎·"`, a check mark with VS15
attached. Belt and braces; the real fix is not using the glyph. [S]

**Never use `String.length` for layout.** It counts UTF-16 units, not columns.
We sidestep it: **reserve a fixed 2-cell gutter** and truncate from the end, so
we never compute a column count at runtime. If a subtraction is ever needed,
guard it and fall back to prefix-only rather than rendering at width zero. [S]

---

## Width and truncation

- **Always `wrap="truncate-end"`.** Never let a line wrap. A wrapped status line
  becomes two rows, the band grows, and the prompt moves — the one-rule
  violation above. [S, shipped mods]
- **Measure by eye, not by `String.length`.** `string.length` counts UTF-16
  units, not terminal columns. Emoji and CJK break naive padding. If you need
  padding, reserve the width rather than computing it. [S]
- **Put the volatile field last.** Elapsed time ticks every second; if it sits
  mid-line, everything after it shifts horizontally each tick. Both reference
  mods put `elapsed` at the end for this reason. [S, shipped mods]
- **Tabular alignment for timers:** `padStart(2, '0')` — `9s` and `12s` must
  occupy the same width. The web skill's `tabular-nums` has no terminal
  equivalent; fixed-width padding is it. [I]

---

## Layout contract

**[S] The engine hands you the budget. Use it.** `AbovePrompt` arrives with
`e.props.maxRows`, `bodyColumns`, `isWorking` and `hasSurvey`. `maxRows` is our
layout contract — the band never exceeds it, and overflow folds rather than
pushes.

Codex names the failure mode exactly, and it is the same one: *"Keeping these
pieces on one line avoids **vertical layout churn in the bottom pane**."* Their
fixes, all of which we adopt: [S]

- **Everything essential on one row.** Optional detail folds to up to 3
  `└`-prefixed dimmed lines, never displacing controls.
- **Core affordances stay in a fixed visual location.** Put the ticking field
  last so nothing after it shifts.
- **Fixed-width timer format** so digits never reflow: `0s`, `59s`, `1m 00s`,
  `59m 59s`, `1h 00m 00s`, `2h 03m 09s`.
- **Clamp counts.** Claude Code's agent footer shows `99+` above 99. Do the same.
- **Hysteresis on thresholds.** Do not show the band at ≥1 job and hide it at
  ≥2. A threshold that flips on the boundary flickers.

---

## Timing

The web skill's loading rules **invert** here. In a browser you delay a spinner
150–300 ms to avoid a flash [S, Vercel]. In a TUI there is no network and no
paint — **the first poll is already warm.** Adding latency is pure loss.

| Thing | Value | Why |
| --- | --- | --- |
| Band clock | **1 s** | matches the fastest meaningful human read; the second digit is all that changes |
| Data poll | **3 s** | both reference mods use 3 000 ms; file reads are not free |
| Draw | **only on change** | never repaint an unchanged band |
| Finish linger | **30 s** | a result that vanishes instantly is never seen [S, shipped mods] |
| Row cap | **4**, then `+N more` | a band that grows without bound pushes the prompt off screen [S, k9s enforces a *minimum* refresh too, with a warning rather than a 10× CPU bill] |

**The tick must be gated on visibility.** Both reference mods read the clock and
only redraw when something is shown:

```ts
$.clock.every(1000, () => {
  if (jobs.some(j => isShown(j, Date.now() - 3_000))) update($, now, () => Date.now())
})
```

Idle means idle. A 1 Hz repaint of nothing is a laptop fan. [S, shipped mods]

**Redraw caps are enforced by the engine** — 10/s, or 30/s for the visible pane,
expanded band and hint line. We stay far below that. If a future animation is
needed, derive the frame index from **wall-clock elapsed, not an incrementing
counter**: a counter drifts and speeds up when the event loop is busy. Both
Claude Code and Codex do the former. [S]

---

## Empty, loading and error

- **No jobs → render nothing.** Not "no jobs", not an empty box. A band that
  appears to say nothing is noise. Both reference mods return the host's own
  output unchanged when `shown.length === 0`. [S, shipped mods]
- **Yield to the host.** `const rest = await next(e)` first, then render above
  it. Never replace what Claude Code or another mod drew. Same for
  `e.props.hasSurvey` — a survey is not decoration to overwrite. [S, shipped mods]
- **Never an indeterminate spinner for a poll.** Polling has no progress; a
  spinner would claim work that is not happening. [I]
- **Determinate where possible.** Elapsed time and tool count are real
  quantities — show them rather than a percentage you would have to invent.
  The web skill's "never swap indicator shape mid-task" [S, Apple] becomes
  "never change what a column means between renders."

### Five distinct empty/error states, never collapsed [S, HIG]

Each gets its own copy. Collapsing them is how a status UI ends up saying
"loading" when it should say "no data yet."

| State | Copy | Example |
| --- | --- | --- |
| **Loading** | the specific verb, never "loading" | `Reading job state` |
| **Empty — never had data** | why it's empty, and when it fills | `No jobs yet · run /agy:implement to start one` |
| **Empty — filtered** | name the filter | `No running jobs · 14 finished` |
| **Error** | what failed **and what to do** | `.agy-staff unreadable · is the path right?` |
| **Nothing selected** (pane) | list with no highlighted row | never a fake selection on row 0 |

The pattern to copy is Claude Code's usage panel: *"No attribution data yet ·
accumulates as you use Claude"* and *"Nothing over 10% in this period — try the
other window."* Both dimmed, both one line, both tell you what to do. [S]

Apple HIG: *"Avoid vague terms like loading or authenticating because they
seldom add value."* [S]

---

## Motion

There is no `prefers-reduced-motion` in a terminal and no compositing, so the
web skill's motion budget does not transfer. What survives: [I]

- **One animation, maximum, and it is the spinner** — a whole-cell cycle. If
  you are not showing liveness by glyph and colour, do not add one.
- **Frame rate 10–12 fps.** Faster reads as noise and competes with the user's
  own typing. Both reference mods use **zero** animation and are calmer for it.
  Prefer zero.
- **Never animate text the user is reading.** A moving character in a status
  line is unreadable by construction.
- **Terse tool descriptions, never raw output.** `cargo test --workspace`, not
  forty lines of compiler output. Truncate at the source.

---

## Accessibility

Terminal equivalents, and what actually exists:

| Web | Terminal | Status |
| --- | --- | --- |
| colour is never the only channel | glyph + colour | **[S]** required |
| `prefers-reduced-motion` | Claude Code `prefersReducedMotion` setting | **[S]** exists |
| `prefers-contrast: more` | `NO_COLOR`, bold instead of colour | **[S]** partly exists |
| screen-reader semantics | `--ax-screen-reader` | **[S]** exists, and it **hides the band entirely** |

**Three things we now know exist that an earlier draft of this file denied:**

1. **`prefersReducedMotion` is a real Claude Code setting** — *"Reduce or disable
   animations for accessibility."* Codex goes further and reads the **OS**
   setting directly (macOS `accessibilityDisplayShouldReduceMotion`, Windows
   `SPI_GETCLIENTAREAANIMATION`, Linux xdg portal) with an explicit substitute per
   element: animated spinner → static `◌`, shimmered dot → dimmed `•`. We take
   the same substitution: **zero animation is our default anyway**, so the
   setting costs us nothing. [S]

2. **`--ax-screen-reader` renders a flat text view** — no box drawing, no
   colour-only cues, spinners as static text — and the agent-footer hint is
   *hidden* in that mode. So a band communicating only through colour does not
   merely degrade, it **disappears**. The glyph is load-bearing. [S]

3. **`NO_COLOR` semantics are precise and I had them wrong.** [S, no-color.org]
   - It is **present-and-non-empty** that counts. `NO_COLOR=0` still disables
     colour. Checking `=== '1'` is a bug.
   - It covers **colour only** — *"Should the presence of `NO_COLOR` disable
     other styling such as bold, underline, and italic? **No.**"* So under
     `NO_COLOR` we keep `dimColor`, `bold` and glyphs; we drop only hue.
   - CLI flags override the env var.
   - `FORCE_COLOR` is the counterpart, and Node's is numeric: `1`/`true`/`""` =
     16-colour, `2` = 256, `3` = truecolor — and it **overrides** `NO_COLOR`.
   - `CLICOLORS`/`CLICOLOR_FORCE` is [deprecated](https://bixense.com/clicolors/).
     Don't use it.

**And the reason colour is harder here than on the web**, which is worth knowing
before adding a fifth colour: the user owns the palette, so your hex is a
*request*; the background may be un-queryable over SSH or tmux; and ANSI 16 is
not perceptually uniform — default green `#00aa00` vs yellow `#aa5500` is a ~2×
lightness difference, not a hue difference. That is why the mod API takes named
colours only, and why the palette is frozen.

**No screen-reader semantics exist for mod content.** Do not pretend otherwise;
rely on redundancy instead.

---

## Review checklist

1. Does the band change height while the user is mid-prompt? Does it respect
   `e.props.maxRows`?
2. Does every line read in its first 40 columns?
3. Would it survive `--no-color`? Does every state have a glyph?
4. **Is every glyph `EAW=Neutral`?** Any emoji, or any `● · … – │ ─ └`?
5. Is the ticking field last, and zero-padded (`1m 05s`, not `1m 5s`)?
6. Does `wrap="truncate-end"` cover every `<Text>`?
7. Does it return `next(e)`'s output untouched, and skip when `hasSurvey`?
8. Does the clock skip work when nothing is shown?
9. Is more than one thing on the line red? Is anything `gray` instead of
   `dimColor`?
10. Is `NO_COLOR` tested as **present-and-non-empty**, not `=== '1'`?
11. Does every empty/error state have its own copy, naming what to do?
12. Are thresholds hysteretic — does a count at the boundary flicker?

---

## Sources

- Adapted from Renyi's `ui-motion-loading` skill (Geist, Vercel Web Interface
  Guidelines, Apple HIG) — web rules re-derived for a redrawn terminal.
- Shipped reference mods, read directly:
  [hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods) —
  `agent-radar`, `review-watch`, `context-bar`, `cache-clock`. The band
  conventions here (4-row cap, 30 s linger, 1 s clock / 3 s poll,
  `truncate-end`, elapsed-last, `next(e)` deference) are theirs.
- Mod API surface, verified in the 2.1.292 binary: `Text` colour names, style
  props, `AbovePrompt` / `Pane` / `Spinner` render sites, `clock.every`.
- [NO_COLOR](https://no-color.org/)
- Apple HIG progress indicators, motion, accessibility.
- Vercel Web Interface Guidelines — animation and colour-usage rules.