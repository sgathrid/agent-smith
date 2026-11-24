---
name: interrogate
description: Adversarially review a change to find real bugs and design problems before it ships, using independent reviewers when the change is big enough to deserve them. Type it for "challenge this", "tear this apart", or a hard second look at a diff.
disable-model-invocation: true
---

# Interrogate

Find what is actually wrong with a change, verify each finding against the code, and hand back a short verdict the person can act on. Do not apply fixes unless asked.

## Scope and intent

Take what the person points at. Otherwise review the current branch against its base, or the uncommitted work. Gather the context a reviewer needs beyond the diff: callers, the types involved, the tests.

State the intent in one paragraph, from the person's words, commit messages, the review description and the code. Reviewers judge against it. If you cannot tell what the change is for, ask before reviewing.

## Scale the review

- Small diff, low risk: review it yourself, inline, against `${CLAUDE_PLUGIN_ROOT}/skills/interrogate/references/rubric.md`.
- Medium: one fresh reviewer with no stake in the change.
- Large or risky (security, data, concurrency, public interfaces, migrations): the stakes usually justify two or more reviewers, on different model families when available (`${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#diversity`).

Follow `${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#scale` when choosing. Say which level you used and why.

## Brief the reviewers

Every reviewer gets the same brief (`${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#brief`): the intent, the diff, where to find context, and the rubric file. Reviewers are read-only and spawn nothing. Tell them that "no findings" is a valid result, that praise is not wanted, and that every finding must show the execution path or input that triggers it, with file:line and a severity. Diversity comes from different models; do not hand out personas.

## Verify every finding

You are the lead reviewer, and reviewer reports are claims (`${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#reports`). For each finding, open the code:

- Hypothetical or actual. "What if this is null" counts only if a caller can pass null. Trace the call site. If upstream validation or the type system rules it out, drop it.
- Missing context. Reviewers see a slice. Drop findings that flag code the change did not touch, patterns consistent with the rest of the codebase, or fixes that conflict with constraints you know.
- Preference. "I would have done it differently" with no concrete failure is not a finding.
- Nitpick gravity. Reviewers inflate small things when they find nothing big. If a reviewer's list is all style, the code is probably fine; say so.

Merge duplicates and note which reviewers raised each one. Independent agreement between reviewers raises confidence. Be slow to drop correctness and security findings, even from a single reviewer; push them as far up `${CLAUDE_PLUGIN_ROOT}/shared/evidence.md#depth` as is cheap.

## Verdict

Sort what survives into the buckets in `${CLAUDE_PLUGIN_ROOT}/shared/evidence.md#verdicts`. Each finding gets a one-line description, where it is (file:line), who raised it, and why it sits in its bucket. If more than five land in Act on, you are not filtering hard enough. Drop nitpicks without listing them; list the substantive findings you dropped, with the reason, so the person can overrule you.

Open with the intent and the review level used. When several reviewers ran, add a line on where they agreed and where they split.
