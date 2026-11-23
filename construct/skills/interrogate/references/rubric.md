# Review rubric

Apply the lenses that fit the change; most changes need only a few. Every finding names the input or execution path that triggers it, with file:line. "This could be null" without a caller that passes null is not a finding. No findings is a valid result.

## Correctness

Does the code do what the intent says, on the sad path as well as the happy one? Edge cases: empty input, missing values, boundaries, off-by-one, encoding, overflow, type coercion. Does a bug fix address the cause or mask a symptom? A guard clause, retry or cast that hides a broken contract elsewhere is a finding; say where the real fix belongs.

## Security and privacy

Untrusted input reaching a dangerous sink (query, shell, eval, markup, file path) without sanitizing. Missing authentication or authorization on new entry points. Secrets or personal data in code, logs, error messages or telemetry. Time-of-check to time-of-use gaps on security decisions. Trace the input path and show it.

## Data integrity

Writes that can leave stored data half-updated or inconsistent. Migrations that lose or misread existing data, or cannot run twice. Old stored data the new code can no longer load. Two places that each believe they own the same value.

## Concurrency

Shared mutable state (files, records, caches, branches) touched by more than one actor. Is access serialized by structure (one owner, locks, sequential phases) or only by convention? What happens if the operation runs twice, or crashes halfway and restarts?

## Error paths

Errors swallowed, logged and ignored, or turned into a success value. Cleanup skipped on failure. Retries without a bound or without backoff. Error messages that hide what failed from the person who has to fix it.

## Tests

Does a test cover the new behavior, and would it fail if the behavior broke? Does a bug fix come with a test that fails before the fix? Tests should check behavior through the public surface, not implementation details. Waits on fixed timers, or tests that assert on a mock of the thing under test, are findings.

## API and compatibility

Changes to public interfaces, wire formats, config, file formats or command-line flags that break existing callers or stored data. A new path added next to an old one with no plan to move callers and delete the old one.

## Simplicity

- Does the change delete code where it could? A restructuring that makes a branch, mode or helper disappear beats one that rearranges it.
- Does it reuse the canonical helper or type the codebase already has, or add a near-duplicate?
- Does it insert ad-hoc conditionals or special cases into unrelated flows? Logic that belongs to one concern should live with that concern.
- Abstractions with one caller, options for cases that do not exist, and dead parameters are findings. Three lines of duplication beat a premature abstraction.

## Severity

- High: wrong results, data loss or corruption, a security or privacy hole, a crash or hang on a reachable path, a broken public contract.
- Medium: a real bug on an uncommon but reachable path, a missing test for new risky behavior, a structural problem that will make the next change wrong.
- Low: a real but minor issue, cheap to fix, with no user-visible effect.

Style preferences and "I would have done it differently" have no severity. Leave them out.
