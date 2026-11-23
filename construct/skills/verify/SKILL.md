---
name: verify
description: Prove or disprove a specific claim with fresh before and after evidence, and return one verdict. Type it on "did this fix it", "is it faster", or any claim you want checked.
disable-model-invocation: true
---

# Verify

Verification proves or disproves one specific claim with evidence someone else could rerun. It is a measurement, and a recap of the change does not count.

## Make the claim falsifiable

Restate the claim as a condition, a metric and a threshold: "with 10k rows, export finishes in under 2 s at the median", "after the fix, saving a note twice leaves one copy". If the claim is vague ("the code is cleaner"), ask for a measurable version or propose one and confirm it.

## Pick the surface

Choose the smallest surface that can disprove the claim:
- code behavior: a focused test or a minimal script against the real code;
- a CLI or TUI: a scripted terminal session and its transcript;
- a UI: browser or desktop automation with screenshots and accessibility snapshots;
- an API: a real request and the full response;
- performance or memory: same-machine timings, profiles or heap snapshots.

If the repo has a project verification skill (one made by `${CLAUDE_PLUGIN_ROOT}/skills/verification-harness/SKILL.md`; look in the repo's skills folder for one whose description says it drives this app), use it to launch, drive and capture the real app. Follow its Doctor before you drive.

A unit test shows how a branch behaves. It does not show that a user-visible bug is gone. When the claim is about what a user sees, drive what the user drives.

## Baseline and treatment

Capture a baseline from the old state (the parent commit, the merge base, the unfixed build or the current broken repro) and a treatment from the new state. Use the same command, data, warmup and environment for both. If you cannot get a valid baseline, the verdict is INCONCLUSIVE; say what is missing.

Check that the work actually happened in both runs: the request reached the server, the rows were written, the result was used. Count errors and wrong outputs alongside successes.

For a performance claim, the numbers must meet `${CLAUDE_PLUGIN_ROOT}/shared/principles.md#numbers`: run each side several times, alternate the sides, report the median and the range, and name the limiter. A gap smaller than the run-to-run spread is no measurable difference.

## Compare

Compare raw artifacts: numbers, transcripts, responses, screenshots, profiles. Do not compare your memory of them.

Keep artifacts in a private local scratch directory, one folder per claim with baseline and treatment side by side, outside the repo. If they may hold sensitive code, data, screenshots or request bodies, keep only the minimal evidence inline and ask before writing more to disk.

## Verdict

Return exactly one verdict from `${CLAUDE_PLUGIN_ROOT}/shared/evidence.md#verdicts`:
- VERIFIED: the change moves the metric in the predicted direction, past the threshold, with no obvious confound.
- NOT VERIFIED: unchanged, moved the wrong way, or missed the threshold.
- INCONCLUSIVE: no valid baseline, noisy signal, a failed measurement, or an environment difference that breaks the comparison.

Shape the answer like this, then add one short paragraph naming the evidence and any confounds:

```text
<VERIFIED | NOT VERIFIED | INCONCLUSIVE>
Claim: <the falsifiable claim>
Evidence: <metric or artifact>: baseline=<...>, treatment=<...>, delta=<...>, threshold=<...>
```

Never soften a negative result. A clear NOT VERIFIED is useful, and an honest INCONCLUSIVE beats a confident guess.
