---
name: tdd
description: Make a bug executable as a failing test, confirm it fails for the right reason, then fix it until the test passes. Type it when you want a regression test written before the fix.
disable-model-invocation: true
---

# TDD

Turn the broken behavior into a test that fails before you change production code, then make the smallest fix that turns it green. The test is the proof that the fix fixed this bug.

## When to skip

Use this when a cheap test path exists near the broken code. If the only available test needs broad harness setup, production-only state, slow end-to-end infrastructure, mocks of most of the system, or a vague repro, skip the new test. Use the closest executable check instead: a short script, a command and its output, or a scripted run against the real app. Say which you used and why.

Prefer no new test over a bad one. A bad test mostly exercises mocks, restates the implementation, depends on timing or unrelated global state, or would be deleted right after proving the fix.

## Cycle

Know the intended behavior, the current behavior and the smallest observable repro before you write anything.

Write the narrowest test that would have caught the bug, in the test style and location the codebase already uses for that path. Test behavior the way `${CLAUDE_PLUGIN_ROOT}/shared/principles.md#tests` describes: call the code as its users do and assert a literal result they would see.

Run it before the fix. It must fail, and for the reason you expect. A test that passes, or fails on a typo, a missing import or a fixture error, proves nothing yet. Correct the test until its failure names the bug.

Make the smallest production change that satisfies the intended behavior and keeps nearby contracts. Run the test again and confirm it passes, then run the tests around it.

## Guardrails

- Never change a test to match a wrong implementation, and never weaken an existing assertion unless the expected behavior truly changed and you can say why.
- For a flaky bug, make the test deterministic and name the signal it locks down.
- If the bug belongs to a wider class, land the focused test first; add sibling coverage only where it would catch something real.

## Report

Name the failing-before test and the failure it produced, and the passing-after run with any nearby tests you ran. If you could not show a failing-before result, say why and name the check you used instead.
