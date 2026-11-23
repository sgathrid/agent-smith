---
name: redpill
description: Start a working session where your agent may use any Construct skill when a task calls for it, and does small tasks directly. Type it at the start of a session when you want the skills on hand without naming each one.
disable-model-invocation: true
---

# Red pill

The person started this mode, so for the rest of the session every Construct skill is available to you. The skills load only from a slash command, so this file is how you find them. The list and how to choose among them are in `${CLAUDE_PLUGIN_ROOT}/skills/load/SKILL.md#catalog` and `${CLAUDE_PLUGIN_ROOT}/skills/load/SKILL.md#choosing`. Read that file now as the list of skills, not as an instruction to pick one.

## Use a skill when it pays

Most tasks need no skill. A rename, a one-line fix, or a question the code answers in a minute: do it directly. Open a skill when the task matches what it is for and its cost (reading, reproducing, extra reviewers) buys something, such as a bug whose cause is not obvious, a shape that is hard to reverse, or a change you do not trust yet. Several skills can run over one session, one task at a time.

Before you start one, say in a line which skill and why, so the person can stop you. A skill's own scaling rules still apply, and the same judgment covers any skill it links to.

The mode lasts until the person ends it. After that, a skill runs only when they type it.

## Helpers

Helpers cannot load these skills. When a helper should follow one, put the skill's file path in its brief and tell it to read the file (`${CLAUDE_PLUGIN_ROOT}/shared/briefing.md#brief`).
