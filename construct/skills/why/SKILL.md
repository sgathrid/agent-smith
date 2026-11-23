---
name: why
description: Find the evidence for why code is the way it is, meaning the decision, constraint, incident or tradeoff behind it, graded by how sure we can be. Type it for "why does X work this way", "why did we pick Y", a regression's origin, or where a threshold came from.
disable-model-invocation: true
---

# Why

Produce evidence about intent: what forces gave this code its shape, how sure you are of each, and what you looked for and did not find. "We could not find out" is a valid answer. A confident guess is a harmful one, because people act on it.

## Target and question

Name the target (lines, a pattern, a feature, a named decision) and the question (rationale, tradeoff, motivating edge case, outside constraint, dead code, origin of a number, cause of a regression). If the target is vague, guess from the conversation, state your reading in one line, and proceed.

If the question carries a hypothesis ("I assume it's for performance"), treat it as one candidate among several and check it like any other.

## Anchor in the code first

Before any other source, build the anchor:

- File paths, line ranges and the key symbols.
- Last-touch commits from blame, and the file's history through renames.
- A pickaxe search for the exact literal, constant or condition, to find the commit that introduced it.
- Review threads, tickets and incident ids those commits link or mention.
- Tests that pin the behavior; their names often state the edge case.

The anchor seeds every later search: hashes, review numbers, ticket ids, dates, authors, error strings. Read diffs, not only messages; "small cleanup" sometimes hides a deliberate behavior change. Skip bot and automated commits. If the pattern was copied from elsewhere in the repo, trace the original.

## Other sources

`${CLAUDE_PLUGIN_ROOT}/skills/why/references/sources.md` describes each kind of history source and what it uniquely shows. Check which kinds are actually connected in this session (tools, servers, command-line clients). Search the connected ones with the anchor's identifiers and dates. Record every kind as one of: searched with findings, searched and empty (with what you searched), or not connected. When the target is defensive code (retries, timeouts, null guards, rate limits, feature flags, catch blocks), also take the incident angle in that file.

## Effort

Answer inline when the target is small and the anchor plus one or two sources settle it. When the question is broad, such as a decision spread over years or a regression with a thin trail, brief one helper per connected source kind, each owning exactly one kind (`${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#brief`). Give each the anchor and the question. Helpers need tool access to their source and write nothing.

Their reports are claims. Open the cited commit, thread or record yourself before an answer rests on it.

## Grade every claim

Grade each claim per `${CLAUDE_PLUGIN_ROOT}/shared/evidence.md#source` and keep the phrasing in step with the grade:

- Causal words ("because", "was designed to", "the team decided") need a citation right next to them.
- Inferences say so ("likely", "suggests", "is consistent with") and spell out the chain: given A and B, C seems likely because D.
- The code is never evidence for its own intent. A function name tells you what someone called it, not why it exists.
- Absence of evidence is not evidence of absence. "Nobody mentioned security" does not mean it was not a concern.
- When sources disagree, show both with citations. Do not pick the tidier story.

Beware recency bias. The latest commit is rarely the origin; the current shape is often several decisions stacked over time. Trace back to where the pattern or number first appeared.

## The answer

Lead with the direct answer and its grade. Then give the evidence with citations (hash, review, ticket, doc, thread, file:line), the inferences marked as inferences, any competing hypotheses still standing, and what remains unknown, naming who could answer it. Close with the sources consulted: one line per kind, including the empty and unconnected ones. If you edit a helper's wording, keep its confidence language.

If a change follows from the question, end with constraints for it:

- Preserve: behavior the evidence shows was deliberate.
- Change: what the evidence shows is obsolete or accidental.
- Avoid: approaches already tried and rejected, with the citation.
- Risk: what could break, and which past incident it could repeat.
