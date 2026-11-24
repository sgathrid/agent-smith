---
name: deslop
description: Remove AI-generated code slop from the branch diff while keeping behavior the same. Type it after an agent wrote code and before you review or commit it.
disable-model-invocation: true
---

# Deslop

Generated code tends to look careful while saying less. Clean the code this branch added so it reads as if the file's best author wrote it.

## Scope

Use the files or diff the person gave. Otherwise use the current branch's diff against its base branch, including staged, unstaged and untracked changes. Touch only lines this branch added or changed. Pre-existing code in the same file is out of scope even when it has the same problems.

Read each touched file in full before editing. The file and its neighbors set the style: naming, error handling, nesting, helper size, how types are written.

## What to remove

- Defensive checks that are abnormal for a trusted path: null checks on values a caller or type already guarantees, re-validation of data validated at the boundary, fallbacks for states that cannot occur.
- try/catch blocks that swallow the error, log and continue, or rethrow without adding anything. Let the error propagate the way the rest of the file does.
- Casts and escape hatches that dodge a type error, e.g. casting to `any`, a non-null assertion on a value that can be null, an unchecked unwrap. Fix the type, or narrow it where the value enters.
- Needless nesting. Use early returns and guard clauses where the file already does.
- Helpers, wrappers and constants used once, when inlining them reads better. Keep a helper whose name carries meaning the call site lacks.
- Parameters, options and branches nothing uses, and configuration for cases no caller has.
- Anything else out of style with the file: a different logging call, a different error type, verbose names next to terse ones, a new pattern for something the file already does one way.

A check belongs where untrusted data enters: user input, network, files, environment, another process. Keep those. Delete only checks that repeat a guarantee already made.

## Comments

Do not edit comments in this pass. When code cleanup is done, read and follow `${CLAUDE_PLUGIN_ROOT}/skills/no-comments/SKILL.md` on the same scope.

## Guardrails

Keep behavior the same unless you are fixing a clear bug. Name every bug fix in the report so it gets reviewed as a behavior change.

Prefer small, local edits over rewrites. If cleaning something properly needs a new shape, stop and report it instead of redesigning inside a cleanup.

Run the tests and checks that cover the touched files after editing. If one fails, the cleanup changed behavior; fix or revert that edit.

## Report

Reply in one to three sentences: what kinds of slop you removed and where, any bug you fixed, and anything you left for a larger change.
