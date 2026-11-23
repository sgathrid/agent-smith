# Evidence

How to say how much you know. Readers act on your confidence, so make it accurate.

## Source

Label where each claim comes from and phrase it to match:
- **Direct**: someone wrote down why (a commit message, a design doc, a comment, an issue). Quote it and link it.
- **Supported**: several indirect pieces converge (history, call sites, tests, naming). Say "the evidence points to".
- **Inferred**: your reading of the code. Say "likely" or "my reading is".
- **Unknown**: nothing found. Say so and stop there.

Record what you searched, so a "nothing found" can be checked and extended.

## Depth

How far a claim was checked, from weakest to strongest:
1. Said so: a person, doc or report asserts it.
2. Pointed at code: file:line shows it.
3. Traced the path: you followed every route to or from it.
4. Ran it: a command or test exercised it.
5. Reproduced it in the real running thing.

Push each load-bearing fact as high as is cheap, and say where it stopped.

## Verdicts

- **VERIFIED**: a check ran against the real artifact and the result matches the claim.
- **NOT VERIFIED**: a check ran and contradicts the claim, or the claim failed its stated test.
- **INCONCLUSIVE**: no check could settle it, or results disagree. Say what would settle it. An honest inconclusive beats a confident guess.

When triaging review findings, sort them into:
- **Act on**: real, in scope, worth fixing now.
- **Consider**: plausible, a judgment call for the person.
- **Dropped**: each with its reason (wrong, out of scope, already handled, not worth the change).
