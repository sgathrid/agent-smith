---
name: technical-writing
description: Write or restructure documentation so a tired engineer understands it on the first read, starting from which kind of document it is. Type it when drafting or revamping a README, guide, reference page, design doc or RFC.
disable-model-invocation: true
---

# Technical writing

Write for a tired engineer reading once. Decide what kind of document this is before you write a sentence, then write each sentence so it can be read only one way.

Use the codebase's own words. Write the real symbol, file, flag or command name, and never a synonym or a description of it. Make every count, path and example true at the commit that lands it.

## Pick the mode first

One document, one mode. Two questions pick it: does the reader need to act or to understand, and are they learning or working?

- Act while learning: **tutorial**.
- Act while working: **how-to**.
- Understand while working: **reference**.
- Understand while learning: **explanation**.

**Tutorial.** You are responsible for the learner's success. Open with what they will build. Every step produces a visible result, and you tell them what they should see: the output, the log line, the prompt change. Cut explanation to one clause and a link.

**How-to.** Solve a problem a person has, written as steps to their goal. Assume competence. Leave out background and completeness for its own sake, and link to them. Allow forks: "If you want x, do y." Name the guide by the task: "Rotate the signing key".

**Reference.** Describe, and only describe: facts, options, defaults, limits and errors, with no instruction or opinion. Be complete and certain. Mirror the structure of the thing described so readers can move between code and docs. Generate it from code where you can.

**Explanation.** One bounded topic, readable away from the keyboard. Anchor on a real why question and give context: design decisions, history, constraints, rejected alternatives. Opinion belongs here and nowhere else.

When content from a second mode creeps in, split it into its own page and link to it. A tutorial carries no reference tables, reference carries no hand-holding, and a how-to carries no argument.

## READMEs

A README is mostly how-to plus a little reference. Lead with what the project does in one or two sentences, then how to install it and run the most common task. Follow with the reference a user needs often: commands, configuration, environment variables. Put architecture, history and design reasoning in an explanation page and link to it. Keep the README short enough that the first screen answers "what is this and how do I start".

## Write each sentence for the reader

- Address the reader as "you", in the present tense. Use "will" only for things that happen later.
- Write instructions as commands: "Run the migration."
- Put the condition before the step: "To delete the cache, run `make clean`." The reader skips what does not apply.
- Put warnings before the step they guard.
- Put the common case first and exceptions after.
- Use active voice and name the actor: "the server rejects the request".
- One instruction per sentence. Split instructions over about 20 words.
- Keep "the" and "a". "Remove backup file" reads two ways; "Remove the backup file" reads one.
- Call each thing by one name everywhere. A doc that says "the gate", "the check" and "the budget" for one thing teaches three things.
- Pick one verb per action. If you write "start" once, do not write "initiate" later.
- Make every "it", "they" and "this" point at one obvious noun. Repeat the noun when in doubt.
- Keep "only" and "not" next to the word they modify.
- Break up long noun strings: "the proto import budget check script" becomes "the script that checks the proto-import budget".
- Never write "simply", "easy" or "just" in a procedure. If it were easy, the reader would not be here.

## Structure

- Headings state the point or the task: "Pick the mode first", "Create an instance". Use sentence case, one top heading per page, and no skipped levels.
- Use numbered lists for sequences and bullets for everything else. Introduce a list with a full sentence and keep items parallel.
- Put code, paths and commands in code font.
- Link text says where the link goes. Never "click here".
- Do not reword sentences that did not change. Churn costs readers the same as a rename.

## Edit the draft

When the draft is done, read and follow `${CLAUDE_PLUGIN_ROOT}/skills/unslop/SKILL.md` on it. That skill owns the catalog of filler, AI vocabulary, hedging and formatting tells, so this one does not repeat it.

## Worked example

Before:

> Configuration of the proto import ratchet budget script parameters is performed via budget.json. Note that it's important to remember that running with --write, which updates the committed budget to reflect the current count, should only be done when lowering it. If exceeded, CI fails.

After:

> `budget.mjs` reads the committed budget from `budget.json` and counts the files that import protos. If the count exceeds the budget, CI fails. Run `budget.mjs --write` only to lower the budget.
