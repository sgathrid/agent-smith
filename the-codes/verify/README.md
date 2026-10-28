# verify/ — executable verification

The orchestrator consumes **a boolean**, never prose.

## Why

A real agy job reported "All tests pass with zero warnings" while its own log
tail showed `cargo test` exiting **CODE 1 — twice**. Fluent, confident, wrong,
about a fact already in its transcript. Alongside: external checklist 10/10 vs
generic self-check 5/10 (p=0.0325); self-assessment loses half its runs;
self-correction via prompting does not work (TACL 2024).

An exit code has no room for that failure mode. A model asked to read the log and
report would re-implement the exact step that failed.

## Layers

- `types.ts` — `Check` (`command`/`cwd`/`timeoutMs`/`expect`), `Verdict`
  (`passed` + `exitCode` + bounded `stdoutTail`/`stderrTail`).
- `runner.ts` — runs checks against the **working tree**, not a summary. 8KB
  tails, marked when truncated. Always kills on timeout.

Policy (accept, retry, stop) lives with the callers: `forge/checks.ts` runs
acceptance checks and `pipeline/` decides what a failure means. Escalation is
capped (see `pipeline/routing.ts`) because a loop is worse than a stop; any
rerun gets the failing command and its bounded output as **context, not
instruction** ("fix this" reproduces the 5/10 generic self-check). Timeouts are
reported separately from failures: "it hung" is not "it failed".

## Two honesty rules

- A check that never ran is reported `skipped` and is **not** a pass.
- Nothing executed → `unverifiable`, never an automatic accept.

## Process-group kill

`spawn(..., { detached: true })` makes the child a group leader; cleanup signals
`-pid`. `kill(pid)` reaps only the shell and orphans grandchildren — which keep
writing into the tree we just declared broken. SIGTERM, then SIGKILL after grace.

Tests: `node --test the-codes/verify/`.