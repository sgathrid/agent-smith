---
name: unslop
description: Edit prose to remove the patterns that make writing read machine-generated. Type it on a draft doc, README, message or description before you send or commit it.
disable-model-invocation: true
---

# Unslop

Edit the text to remove AI writing patterns. Preserve the meaning and match the intended tone. Scan for the patterns below, then rewrite. When a fix makes a sentence worse, fix it another way or leave it.

For code comments and docstrings, read and follow `${CLAUDE_PLUGIN_ROOT}/skills/no-comments/SKILL.md` instead. Most of them should go, so delete before you polish.

## Content

- **Superficial -ing phrases.** "highlighting...", "ensuring...", "reflecting...", "showcasing...". Delete them or replace them with a real fact.
- **Vague attributions.** "Experts believe", "Industry reports suggest". Name the source or delete the claim.
- **Generic conclusions.** "The future looks bright." State the specific plan or fact, or end earlier.

## Language

- **AI vocabulary.** Additionally, crucial, delve, enduring, enhance, fostering, garner, interplay, intricate, landscape (abstract), pivotal, showcase, tapestry, testament, underscore, vibrant. Use plain words.
- **Fancy ways to say "is".** "serves as", "stands as", "boasts", "features". Say "is" or "has".
- **"Not just X, but Y."** State the point directly. The same goes for "it's not X, it's Y".
- **Rule of three.** Ideas forced into groups of three. Use the natural number.
- **Synonym cycling.** Four names for one thing in one paragraph. Pick one name and repeat it.
- **The plain word.** "utilize" is "use", "leverage" is "use", "facilitate" is "help", "numerous" is "many", "in the event that" is "if".

## Style

- **Em dashes.** Avoid them entirely. Use periods or commas. Do not substitute parentheses, en dashes or hyphens. If a thought needs separation, end the sentence.
- **Colon overuse.** Colons are fine before a list or an example. As a mid-sentence connector they add drama and nothing else. Let the point stand on its own.
- **Boldface overuse.** Do not bold every proper noun or acronym.
- **Inline-header lists.** The tell is a bold label and colon that restate the line: "**Performance:** Performance improved...". Convert to prose. A bold lead-in that ends in a period and is followed by new detail is fine.
- **Title case headings.** Use sentence case unless the project uses title case.
- **Decorative emojis.** Remove them from headings and bullets.

## Chat residue

- **Chatbot phrases.** "I hope this helps!", "Let me know if...", "Certainly!", "Found the smoking gun!" Remove them.
- **Sycophancy.** "Great question! You're absolutely right!" Respond directly.

## Filler

- **Filler phrases.** "In order to" is "to". "Due to the fact that" is "because". "It is important to note that" is nothing.
- **Hedging.** "could potentially possibly be argued that it might" is "may". Hedge once, where the uncertainty is real.
- **Adverbs propping up weak verbs.** "runs quickly" becomes "is fast" or the number. "significantly improves" becomes the measured delta.

## Jargon and figures

- **Abstract metaphor nouns.** Substrate, wedge, vector, locus, vantage, nexus, bedrock, scaffolding (as metaphor), modality, paradigm, gold-plating, ratchet (as metaphor), evacuate (for moving code), endgame, north star, flywheel. Pick the concrete word: "substrate" is "base", "wedge in" is "add", "ratchet" is the mechanism's real name or "a limit that only tightens", "evacuate" is "move out".
- **Mannered prose.** Aphorisms ("wire it or delete it"), fragments for effect, personified code ("the plan holds it"), figurative verbs ("rides along", "stands on"). "A dial worth turning" becomes "a parameter worth varying". Say it literally.

## Plain speech

- **Feelings in place of mechanisms.** "SQL you can read" and "types that follow your schema" name a feeling. Name the mechanism or a number instead: "`.toSQL()` returns the exact string sent to the database", "a column rename fails the build". If a sentence could appear unchanged in another project's docs, it says nothing about this one. Cut it.
- **Dense sentences.** If the reader has to backtrack, split the sentence or drop clauses. One idea per sentence.
- **Passive voice.** Catch "is/are/was/were + past participle" and name the actor: "queries are validated" becomes "the compiler validates queries". Passive is fine when the actor is unknown or does not matter.
- **Over-compression.** Dropped articles, verbless fragments, arrows and private abbreviations make the reader decode. "Parser rejects bad date → exit 2, no write" becomes "The parser rejects a bad date, exits with code 2, and writes nothing."
