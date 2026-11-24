---
name: load
description: Type load (in a plugin install, /construct:load) with what you are trying to do and this front door picks the one skill that fits, then reads and follows it. Tank, load the program.
disable-model-invocation: true
---

# Load

Pick the one skill that fits the person's task, then read and follow it.

If they gave no task, or the task could fit two skills in very different ways, ask one short question about what they are trying to get done. Then choose.

## Catalog

- no-comments: delete comments the code should make unnecessary and fix what they hid. `${CLAUDE_PLUGIN_ROOT}/skills/no-comments/SKILL.md`
- how: explain how a piece of code works. `${CLAUDE_PLUGIN_ROOT}/skills/how/SKILL.md`
- why: find out why code is the way it is, from history and records. `${CLAUDE_PLUGIN_ROOT}/skills/why/SKILL.md`
- architect: design the shape of a change before writing it. `${CLAUDE_PLUGIN_ROOT}/skills/architect/SKILL.md`
- arena: several independent attempts at one task, then merge the best. `${CLAUDE_PLUGIN_ROOT}/skills/arena/SKILL.md`
- interrogate: have independent reviewers try to break a change. `${CLAUDE_PLUGIN_ROOT}/skills/interrogate/SKILL.md`
- technical-writing: write or restructure docs, READMEs and specs. `${CLAUDE_PLUGIN_ROOT}/skills/technical-writing/SKILL.md`
- unslop: strip machine-sounding patterns from prose. `${CLAUDE_PLUGIN_ROOT}/skills/unslop/SKILL.md`
- deslop: strip machine-sounding patterns from code. `${CLAUDE_PLUGIN_ROOT}/skills/deslop/SKILL.md`
- debug: reproduce a bug, fix its root cause, prove it gone. `${CLAUDE_PLUGIN_ROOT}/skills/debug/SKILL.md`
- tdd: write a failing test first, then the fix. `${CLAUDE_PLUGIN_ROOT}/skills/tdd/SKILL.md`
- blast-radius: find what a change could break elsewhere and prove why it is safe. `${CLAUDE_PLUGIN_ROOT}/skills/blast-radius/SKILL.md`
- verify: prove or disprove a claim with before and after evidence. `${CLAUDE_PLUGIN_ROOT}/skills/verify/SKILL.md`
- verification-harness: create or maintain a skill that drives the real app. `${CLAUDE_PLUGIN_ROOT}/skills/verification-harness/SKILL.md`

## Choosing

Match on what the person wants at the end. A bug report goes to debug, even if they said "test". A question about a claim's truth goes to verify. A diff they distrust goes to blast-radius; a diff they want attacked from several angles goes to interrogate.

Pick exactly one. If the chosen skill tells you to read another, that is its call to make.

Tell the person in one line which skill you picked, then read and follow its file with their task as the input.

If nothing fits, do the task directly and say that no skill matched. Work under the working stance: smallest change that solves it, fix root causes, check the real thing before saying done, ask before irreversible or outward-facing actions, and say how sure you are.
