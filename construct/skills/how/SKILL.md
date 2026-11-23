---
name: how
description: Explain how a piece of code or a subsystem works, at the depth a senior engineer needs before changing it. Type it for "how does X work", a walkthrough before an edit, or "where should this live".
disable-model-invocation: true
---

# How

Give the person a working mental model of the code: the one a senior engineer builds in their first week on a subsystem. Enough to change it safely and predict what it does. Annotated source is too much; a vague tour is too little.

## Scope

Pick the target from the question and the conversation. If it is ambiguous, state your reading in one line and go; the person can redirect.

Placement questions ("where should this live", "which layer owns this", "is this the right module") are how questions. Answer them by mapping who owns which state and decision first, then say where the new thing fits and why.

## Gather

Use the strongest tool you have, in this order:

1. A code index or call-graph tool, if one exists. One query for a symbol's callers or a file's API often replaces several reads.
2. Search for symbols, string literals, config keys, routes and error messages.
3. Reading. Read the implementation; names and comments drift from behavior.

Start at an entry point (a user action, a request handler, a scheduled job, a command, a test) and follow the flow until you can tell it without hand-waving. Read the types at each hop. Note where data changes shape, where decisions branch, and where the subsystem meets others.

Work inline by default. For a broad subsystem that spans many files, services or processes, and where getting it wrong would cost real time, brief 2-4 read-only helpers on distinct angles, for example the request path, storage, background work and configuration. Follow `${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#brief` and size the fan-out per `${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#scale`. Ask each helper for components, the flow with file:line, boundaries, surprises, and what it could not trace.

Helper reports are claims (`${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#reports`). Check every load-bearing one against the code before it goes in your answer.

## The answer

You write it, at the top level. Cover what applies and drop the rest:

- What it is and why it exists, in a paragraph someone could stop after.
- The key abstractions, briefly.
- The flow from trigger to result, in prose, with its decision points.
- Boundaries: what comes in, what goes out, who owns which state.
- Where things live: the few files someone would open first.
- Gotchas: surprising behavior, leftovers from old designs, easy mistakes.
- Open questions: what you could not trace and where you stopped.

Every fact carries file:line. Be concrete: "`OrderService.submit` calls `Ledger.reserve` (orders/service.ts:88)" tells the reader more than "the service delegates to the ledger". Add a diagram only when several components talk to each other and prose gets tangled. When something is complex, say why. When it is simple, keep it short.

Say what you could not trace. "Nothing I found writes `retryBudget` after startup" helps the reader; a smooth guess sends them the wrong way. Mark anything you inferred from names or patterns as inferred (`${CLAUDE_PLUGIN_ROOT}/shared/evidence.md#source`).

If the person really wants the reasons behind the shape, answer the how part and offer to read and follow `${CLAUDE_PLUGIN_ROOT}/skills/why/SKILL.md`. Do not run it unasked.
