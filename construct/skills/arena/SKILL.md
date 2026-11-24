---
name: arena
description: Run several independent attempts at the same task, pick the strongest as a base, and graft the best ideas from the others into it. Type it when one attempt at a non-trivial artifact or design could lock in the wrong shape.
disable-model-invocation: true
---

# Arena

Several independent attempts at one task, read in full, merged by hand into one result that is better than any single attempt. The value comes from real independence and an honest pick.

## When one attempt is enough

Say so and skip the arena when the task is small, the shape is already forced by constraints, or the work is cheap to redo. An arena pays off when the design space is open, the result is hard to reverse, and you cannot tell in advance which approach wins.

## Frame

Every attempt gets the same brief, so the brief is the contract. State the artifact each attempt produces, the grounding they share, and the real constraints (`${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#brief`).

Write the rubric before fan-out: 3-6 concrete criteria you can grade, derived from what success means for this task. The rubric is for picking; attempts see only the task.

## Fan out

Give each attempt its own isolated place to work: a separate worktree where possible, otherwise a separate directory. No attempt reads another's output.

Pick runners from whatever workers this session can reach, preferring different model families (`${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#diversity`). Two is the usual count; add more only when the arena covers several distinct directions. The same model several times is fine when the work is generation-bound and judgment matters less.

Ask each attempt for the artifact plus a short rationale naming the alternatives it considered and rejected. If an attempt fails to produce anything, continue with the rest and note the dropout.

## Judge and pick

After all attempts finish, brief one judge that wrote none of them, on a different family from yours when one is available. It gets the rubric and the attempts by label, scores each criterion, and recommends a base.

Read every attempt end to end yourself. Score criterion by criterion, then compare with the judge. Agreement confirms the pick. Disagreement means one of you is biased or the rubric was vague; read both rationales before deciding. The judge's verdict is a claim like any other report (`${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#reports`).

Pick the base by maintainability: which one a future maintainer can extend without breaking its invariants. When two are close, take the cleaner boundary or the smaller interface.

## Graft

Walk each losing attempt once more for what is worth porting. Expect one or two ideas per attempt, not most of it. Fold each one in by hand so the result still reads as one design under one mental model; never paste blocks across.

If the attempts converge on the same shape, that agreement is strong signal: ship the consensus shape without grafting. If they diverge wildly, the frame was under-specified. Reframe and rerun instead of averaging them.

## Verify

The merged result faces the same proof as any other work (`${CLAUDE_PLUGIN_ROOT}/shared/principles.md#prove-it`). If verification finds a problem, either the frame was wrong (reframe and rerun) or an attempt caught it and you missed the graft (go back and port it).

## Synthesis note

Alongside the result, write a short note: the base and why, each graft and its source, what you rejected and why, any dropouts, the judge's verdict, and how you verified the result.
