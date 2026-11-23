---
name: blast-radius
description: Find what a small-looking change could break outside its diff, and prove the one fact it is safe because of by running real code. Type it on a change you do not fully trust yet.
disable-model-invocation: true
---

# Blast radius

Find what a change breaks somewhere else before it ships. Listing callers is the easy part and anyone can grep for them. The job is the breakage a symbol search will not show you.

A writeup that sounds right is worthless on its own, because it reads as convincing whether or not it is true. Find the one or two facts the change's safety rests on and prove them by running code.

## Read the change

Read the diff and what it now does differently, including what the diff does not spell out: a changed default, a reordered call, a widened type, a value that is now computed later or not at all. Pull the commit messages and any linked discussion for intent.

## Find the safety fact

Most changes that look risky are safe because of a single fact, such as "this call only drops cache entries that are already dead". Find that fact. If it holds, most of the risky cases clear at once. Spend your time here instead of on a long list of maybes.

## Look where search stops

Follow what a symbol search misses:
- the source of the library you call, at its pinned version and with any local patch;
- when things run: async ordering, teardown, retries, the order hooks and handlers fire in;
- data that crosses a boundary: an API response, a database column, a file or wire format, a config key, another language reading the same bytes;
- feature flags, environment-specific paths, and code several hops downstream.

A code index or call-graph tool, if one exists, speeds up the obvious part. It will not find the rest.

## Weigh each risk

Give each risk a real chance of happening and a real cost if it does. Cite a real file:line. A search that finds nothing is still an answer; say what you searched. Never invent a caller or an API. Keep confirmed risks and cleared ones in separate lists.

## Prove it

Take the safety fact as far down `${CLAUDE_PLUGIN_ROOT}/shared/evidence.md#depth` as is cheap, and say where it stopped. Usually that is a small script or test that imports the same code or library the app ships, calls the exact function you are worried about, and fails loudly if you are wrong. Run it and keep the output. If you cannot prove the fact, mark it unproven.

For a wide change with many independent areas, split the areas across helpers per `${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#scale`; each gets a brief per `${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#brief` and returns findings with evidence. Otherwise do it yourself. You own the merged answer.

## Hand back

Keep it short: what the change does, including the non-obvious part; what it touches beyond the diff; the safety fact, the depth it reached and its proof (or "unproven"); the risks left, each with file:line, likelihood, cost and the cheapest check that would catch it; and what you cleared. Include the script you ran so someone can rerun it before merging. Strip anything private before it goes somewhere public.
