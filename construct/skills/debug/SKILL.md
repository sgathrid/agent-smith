---
name: debug
description: Reproduce a bug through the real path, find its root cause, fix it, and show before and after proof. Type it with a bug report, a failing behavior, or an error you want fixed properly.
disable-model-invocation: true
---

# Debug

A fix is only as good as the repro behind it. This skill turns a report into a confirmed, repeatable symptom, finds the mechanism that causes it, fixes that mechanism, and proves the symptom is gone on the same path that showed it.

## Study the report

Collect the exact action path, the expected and observed behavior, frequency, version and environment, error text, and any attachments. Look at screenshots, logs and recordings yourself. If the report is too vague to act on, ask one question that would make it reproducible.

Before you start, check whether a fix already exists: an open change, a merged commit, or a branch that names this bug. If one does, verify it instead of writing over it: read and follow `${CLAUDE_PLUGIN_ROOT}/skills/verify/SKILL.md` with the claim "this fix removes the reported symptom", the code before the fix as baseline and the fix as treatment. Do not edit that fix or author a competing one.

## Reproduce

Drive the real path the user took: the app, CLI or API they used, with the data and state they had. If the repo has a project verification skill (one that drives the real app, made by `${CLAUDE_PLUGIN_ROOT}/skills/verification-harness/SKILL.md`), use it.

Before you call it reproduced, write down:
- the correct final state;
- the broken final state;
- the step where they diverge.

Then observe the broken final state twice, resetting enough state between attempts that the second is independent. Cross-check a real stored value when you can. Inspecting state may confirm what you saw; it must never inject or force the symptom. An expected loading state, dialog or setup step is not the bug.

If it will not reproduce, tighten conditions, synthesize the trigger, or add logging until it fires. Stop when that stops paying off.

No confirmed repro, no authored fix. Report "could not reproduce" with what you tried, or "blocked" with the exact capability or access that was missing. Both are useful answers. A plausible patch for a bug you never saw is a guess.

## Find the cause

Form competing hypotheses and name the evidence that would separate them. Take the test that rules out the most at once, run it, and drop what it refutes. When program state is unclear, instrument the code and read it as it runs instead of guessing. Trace the path through the code and its history; read and follow `${CLAUDE_PLUGIN_ROOT}/skills/how/SKILL.md` or `${CLAUDE_PLUGIN_ROOT}/skills/why/SKILL.md` when the subsystem or its odd shape is unfamiliar.

Confirm the surviving mechanism with runtime evidence before you edit anything. A change that "might help" is a hypothesis and does not ship. When evidence refutes a hypothesis, revert what it motivated.

Helpers, if the work is wide enough to need them (`${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#scale`), are read-only: tracing history, mapping callers, reviewing media. Brief them per `${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#brief`; they return findings per `${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#reports` and never edit or report outside this session.

## Fix

Fix the cause and every instance of the same pattern (`${CLAUDE_PLUGIN_ROOT}/shared/principles.md#root-cause`). Make the smallest change the evidence justifies and keep unrelated cleanup out. If the fix needs a new shape across a function boundary, read and follow `${CLAUDE_PLUGIN_ROOT}/skills/architect/SKILL.md` and stop at its sketch.

When a cheap local test can hold the bug, read and follow `${CLAUDE_PLUGIN_ROOT}/skills/tdd/SKILL.md` and write the failing test before the fix. When the test would be slow, brittle or unclear, skip it and say why.

For a fix that touches shared code, a data format or anything with callers you have not read, read and follow `${CLAUDE_PLUGIN_ROOT}/skills/blast-radius/SKILL.md` on the change.

## Prove it

Run the same real path on the fixed build, twice. Show the broken state is gone and the correct state is in its place, and cross-check the same stored value you used for the repro. A compile, a passing unit test or a plausible diff is not after evidence. Then exercise the nearby states, inputs and failure paths the change could affect.

If a regression remains or the fix outgrew the evidence, stop and report what you have.

Report what was broken, the root cause with its evidence, the fix, and the before and after output from the real path. For "could not reproduce" or "blocked", report that plainly with what you tried.
