# verify/ — executable verification gates

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
- `gate.ts` — `decideGate` is the whole policy in three lines, exported pure so it
  can be read and tested on its own.
- `checks/typescript.ts` — typecheck/test/lint presets; configurable, and they
  read `package.json` rather than guessing script names.

## Gate decision

```
checks pass   → ACCEPT
checks fail   → ESCALATE once (rerun worker, failing command + output as context)
still failing → STOP, surface the exact failing command to a human
```

`ESCALATION_CEILING = 1`, not a default — a limit. A loop is worse than a stop.
The rerun gets the failing command and its bounded output as **context, not
instruction** ("fix this" reproduces the 5/10 generic self-check). Timeouts are
reported separately from failures: "it hung" ≠ "it failed".

## Two honesty rules

- A check that never ran is reported `skipped` and is **not** a pass.
- Nothing executed → `unverifiable`, never an automatic accept.

## Process-group kill

`spawn(..., { detached: true })` makes the child a group leader; cleanup signals
`-pid`. `kill(pid)` reaps only the shell and orphans grandchildren — which keep
writing into the tree we just declared broken. SIGTERM, then SIGKILL after grace.

Tests: `node --test the-codes/verify/` — 52 tests.