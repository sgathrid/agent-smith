---
name: architect
description: Design the shape of non-trivial code before writing it (the caller's usage, data structures, signatures and module boundaries), then implement against that sketch. Type it when jumping straight to code would lock in the wrong shape.
disable-model-invocation: true
---

# Architect

Settle the shape before the code. Sketch usage, types, signatures and module boundaries with unimplemented bodies, choose among real alternatives, then fill in code against the sketch. If implementation proves the sketch wrong, throw it out and redesign.

## Ground

Build a real mental model of every system the new code touches: read and follow `${CLAUDE_PLUGIN_ROOT}/skills/how/SKILL.md` over them. Naming a file is not grounding; trace the flow and the owners. When the design moves ownership or layering, also read and follow `${CLAUDE_PLUGIN_ROOT}/skills/why/SKILL.md` on the current shape, so the reasons behind it become constraints instead of guesses.

Skip grounding only for greenfield work with nothing around it to integrate.

## Sketch

Write the caller's usage first: the short readme a consumer would read and two or three realistic call sites in their code. What they import, what they call, what comes back. Derive the types from the usage. When the two disagree, fix the types to fit the usage.

Then data structures. Get the core types right and the code becomes obvious. Trace each main access pattern through the proposed structure; if the answer is "add an index or cache later", the structure is wrong. Encode invariants in types where you can (`${CLAUDE_PLUGIN_ROOT}/shared/principles.md#encode`), validate at the boundary and trust the types inside (`${CLAUDE_PLUGIN_ROOT}/shared/principles.md#shape`), and give each piece of state one owner (`${CLAUDE_PLUGIN_ROOT}/shared/principles.md#ownership`).

For anything hard to reverse (a public interface, a storage format, a module boundary, a protocol), sketch at least two structurally different shapes before choosing (`${CLAUDE_PLUGIN_ROOT}/shared/principles.md#design-space`). Different shapes means different data models or boundaries; variations inside one shape do not count. For a small or easily reversed change, one sketch is enough.

Screen every candidate against `${CLAUDE_PLUGIN_ROOT}/skills/architect/references/red-flags.md`. Assume the next contributor sees only the files it opens, copies the nearest example, and takes the shortest path that compiles. Prefer the shape where a change that looks right from one file is right for the whole codebase.

Compare candidates on interface depth. Prefer the deep module: a small, simple public surface hiding a lot of behavior. A deep module concentrates capability; a deep call chain scatters it.

When the design space is wide open and the stakes are high, you may read and follow `${CLAUDE_PLUGIN_ROOT}/skills/arena/SKILL.md` to get independent candidate designs. It is optional; most designs do not need it.

## Deliverable

- The usage sketch.
- Types and signatures, with bodies left unimplemented and pseudocode for the tricky parts. One file for a small change; a module map plus types for larger work.
- A short rationale: the load-bearing decisions, the alternatives rejected with one line each on why, and the tradeoffs accepted ("we accept X in exchange for Y"), including anything a later reader might mistake for an oversight.

When another skill sends you here for a sketch, stop after the deliverable and return to that skill.

## Check in, then implement

Before implementing work that is hard to undo, show the person the sketch and wait for their call. Otherwise go ahead. If they push back on the shape, treat it as new grounding and re-sketch before writing more code.

Implement against the sketch; it is the contract. Surface every deviation. If a function needs a parameter the sketch did not expect, decide whether the sketch was wrong, a requirement was missed, or the implementation is overreaching, and say which.

## Scrap when the friction repeats

When implementation keeps producing friction the sketch cannot absorb, stop patching and redesign (`${CLAUDE_PLUGIN_ROOT}/shared/principles.md#redesign`). One awkward edge case does not condemn a design. These tells, recurring, do:

- The same workaround showing up in unrelated places.
- Unrelated edge cases that each need a special branch.
- Types that need escape hatches (casts, untyped values, optional fields always set in practice) to compile.
- A lock appearing where the sketch said the state was not shared.
- Callers needing to know the abstraction's internal rules to use it.
- Several implementation deviations with the same shape.

Complex data is not a complex design. When you scrap, re-ground on what was built, redesign as if the new constraints were known on day one, and make the new sketch smaller than the old one before it grows (`${CLAUDE_PLUGIN_ROOT}/shared/principles.md#less`).
