---
name: no-comments
description: Delete comments that the code should make unnecessary, flag the code that needed them, and fix what fits in scope. Type it on a diff or a set of files before review or commit.
disable-model-invocation: true
---

# No comments

A comment that explains our own code admits the code is unclear. This skill deletes those comments, flags the code behind them, and fixes what fits in scope. A short keep list in the brief names every comment that survives.

## Scope

Use the files or diff the person gave. Otherwise use the current branch's diff against its base branch, including staged, unstaged and untracked changes. If the base is not obvious, use the remote's default branch. Every deletion, flag and fix stays inside this scope.

## Review

For a tiny diff with a handful of comments, apply the brief yourself. Otherwise spawn one helper. Brief it per `${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#brief`: the scope plus the full text of `${CLAUDE_PLUGIN_ROOT}/skills/no-comments/references/comment-review-brief.md`. Do not restate or soften its rules. The helper edits comments only and reports.

## Judge the report

The report is a claim. Read the helper's diff and check it against the code. Revert and reject:

- any edit to application code;
- any edit outside the scope;
- a deleted comment that a keep-list clause protects, when you can name the clause and prove it applies;
- a MUST KILL flag with a wrong reason, a symbol outside scope, or one that calls intentional, correct code guilty.

A deleted comment about a surprise in our own code stays deleted even when its flag is weak. Correct the flag; leave the comment gone.

Then look for what the helper missed, mainly scoped lint and type-checker suppressions. A suppression of a rule that catches real bugs or guards correctness stays a MUST KILL.

Verify every thin "IMPORTANT", "do not remove" or "too risky" verdict, kept or deleted. Read the nearby code, blame and history, callers and linked PRs. If that is not enough, read and follow `${CLAUDE_PLUGIN_ROOT}/skills/how/SKILL.md` or `${CLAUDE_PLUGIN_ROOT}/skills/why/SKILL.md` on the symbol. A keep survives only with proof that it concerns something we cannot change. A refuted or still ambiguous keep goes.

If you reject a report, revert its edits and rerun the helper once with the failure named. If the rerun fails too, keep what you verified and report the rest open.

Undo only the helper's own hunks. Never restore a whole file from the index or the last commit, because the scope can hold the person's uncommitted work.

## Constraint comments

Some comments guard a rule the code does not enforce: "do not remove", "do not change this wording", "talk to X before changing". If the rule comes from something we cannot change, the keep list covers it. Otherwise offer the cheapest in-scope encoding that makes breaking the rule fail loudly: a type, a runtime check, a test, or a lint rule. Name the encoding and wait for approval. When running unattended, encode only what the caller approved in advance.

With approval, add the encoding, then delete the comment. Without it, delete the comment and report the constraint as open and unenforced.

## Fix the flags

Fix trivial flags directly: delete the dead path, drop the unused parameter, call the real API, rename the misleading symbol.

When a fix needs a new shape, such as a different type, an extracted unit or a changed flow, read and follow `${CLAUDE_PLUGIN_ROOT}/skills/architect/SKILL.md` once for the whole accepted set and stop at its sketch. Then implement the smallest fix that removes the cause, guided by `${CLAUDE_PLUGIN_ROOT}/shared/principles.md#root-cause` and `${CLAUDE_PLUGIN_ROOT}/shared/principles.md#redesign`. Remove every workaround a flag names. Never add a guard that hides the symptom.

The principles describe a good fix. They do not widen the scope. If the cause lives outside the scope, land the smallest in-scope fix, sketch the rest, and report it open.

## Report

End with a short report: how many comments you deleted, any you restored and why, the MUST KILL flags with what you fixed for each, the encodings you offered and applied, and each open item with one sentence on why it is open.
