# The role contract

Every provider in Agent Smith is asked to fill exactly one role per stage. This
file is the single source of truth for what those roles mean. Per-harness files
in `../` are thin adapters onto it.

If a harness cannot express a role faithfully, that is a provider limitation to
document — not a reason to redefine the role.

---

## `implement`

Produce the change the task asked for, and nothing else.

**Required output**
- The final report, written to a file, in this shape:
  ```
  ## What I changed
  - path — one line, why

  ## How I verified it
  - the exact commands run, and their results

  ## Notes
  - assumptions, alternatives rejected, anything unfinished and why
  ```

**Rules**
- Minimal diff. No drive-by refactors, no reformatting untouched lines.
- Match the codebase's existing conventions over personal preference.
- **Git delivery follows the task.** Leave changes uncommitted unless the task
  explicitly asks for a commit, push, or PR.
- Verify before reporting done. If you cannot run the check, say which command
  the owner should run.

**Why the file:** the orchestrator's context is the scarce resource. A report on
disk plus a short digest beats re-reading prose on every collect — it is the fix
for the "game of telephone" that silently corrupts worker handoffs.

---

## `review`

Find defects. Nothing else.

**Required output**
- Findings ranked by severity, each with: what is wrong, where, and the evidence.
- An empty findings list from a shallow read is a failure. A confident false
  alarm is also a failure.

**Rules**
- No speculative findings. If the subject is ambiguous, say so and stop.
- Never modify tracked files. A reviewer that edits is no longer a reviewer.
- No softening, no reassurance, no "overall this looks good".

---

## `moderate`

Probe the previous stage's work for a **named** failure class.

This is the role that makes mixed pipelines worth the setup cost, and it is
deliberately narrow.

**Input**
- The previous stage's report (a path, not the whole transcript)
- The artifact under review (a diff, a test run, a build log)
- **One named failure class to probe for**

**Required output**
- Either "clean against `<class>`" or the specific evidence that it is not.
- Never a verdict without evidence.

**Rules**
- You are a probe, not a debater. Do not argue toward agreement.
- Do not re-do the work. Read the artifact.
- If the failure class you were given does not apply, say so and stop.

**Why not debate.** Models across families make correlated errors — 60 %
agreement when both wrong, across 350+ models. Same-family agreement is not
evidence. Cross-family probing *is*, because self-consistent errors differ
across models. And debate itself underperforms self-consistency at matched
budget while degrading as budget grows ([2406.06461](https://arxiv.org/abs/2406.06461)).

---

## Invariants across all roles

1. **Write the artifact, return the path.** Never return a full transcript.
2. **Never claim a check passed without running it.** The most common real
   failure: a worker reported "all tests pass" while its own log tail showed the
   test command exiting non-zero. Verification is the orchestrator's job, not the
   worker's claim.
3. **Empty output plus warnings is not success.** Distinguish *finished*,
   *finished with warnings*, and *could not act*.
4. **Stop at ambiguity.** Flag it in `## Notes`; do not invent scope.