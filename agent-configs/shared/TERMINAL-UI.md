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
| running | `●` | `yellow` | bold |
| done | `✓` | `green` | — |
| failed | `✗` | `red` | — |
| needs you | `!` | `cyan` | bold |

If the terminal is monochrome, or the user is colourblind, the glyph still
reads. This is the terminal's version of WCAG's non-colour channel. [S]

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

**[I] Choose single-width, ASCII-adjacent glyphs. This is a correctness issue,
not a taste issue.**

A TUI aligns with spaces. `⏳` and `✅` are emoji: most terminals render them
**double-width**, which silently breaks every column after them. Both reference
mods ship this bug — `agent-radar` uses `● ✓ ✗` and aligns; `review-watch`
uses `⏳ ✅ ✗` and does not. We follow the first.

Safe, single-width, near-universally supported:

```
●  ✓  ✗  ·  └  …  ⏵(check before use)
```

Risky — avoid in aligned columns:

```
emoji (double-width)   ⏳ ✅ ❌ ⚠️
box drawing (font-dependent)
braille spinners       ⠋⠙⠹  (fine only as a whole-cell animation)
```

If a box-drawing frame is wanted, verify the user's font first; assume not. [S]

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
| Row cap | **4**, then `+N more` | a band that grows without bound pushes the prompt off screen [I] |

**The tick must be gated on visibility.** Both reference mods read the clock and
only redraw when something is shown:

```ts
$.clock.every(1000, () => {
  if (jobs.some(j => isShown(j, Date.now() - 3_000))) update($, now, () => Date.now())
})
```

Idle means idle. A 1 Hz repaint of nothing is a laptop fan. [S, shipped mods]

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
| `prefers-reduced-motion` | use zero animation | **[I]** ours defaults to zero |
| `prefers-contrast: more` | `NO_COLOR`, bold instead of colour | **[S]** partly exists |
| screen-reader semantics | — | **not available.** Do not pretend |

Claude Code has an `ax-screen-reader` mode (6 references in the binary) that
renders a flat text view. It strips decoration, which means **a band that
communicates only through colour disappears in that mode** — another reason the
glyph is load-bearing. [S]

---

## Review checklist

1. Does the band change height while the user is mid-prompt?
2. Does every line read in its first 40 columns?
3. Would it survive `--no-color`? Does every state have a glyph?
4. Any emoji or double-width glyph in an aligned column?
5. Is the ticking field the last thing on the line?
6. Does `wrap="truncate-end"` cover every `<Text>`?
7. Does it return `next(e)`'s output untouched, and skip when `hasSurvey`?
8. Does the clock skip work when nothing is shown?
9. Is more than one thing on the line red?
10. Is there a colour here that should be `dimColor`?

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