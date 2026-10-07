/**
 * shim.ts — point the agy adapter at the local fixture, before it can be loaded.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS, AND WHY IMPORT ORDER IS LOAD-BEARING
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `providers/agy.ts` does this, once, at module scope:
 *
 *     export const AGY_BINARY = process.env['AGENT_SMITH_AGY_BIN'] ?? 'agy';
 *
 * ES module semantics make that a one-shot read. If anything in a test file's
 * import graph reaches providers/agy.ts before the assignment runs, the adapter
 * has already captured `'agy'` and every later assignment is silently ignored.
 *
 * That is not hypothetical: an earlier draft of the runner suite set the env var in
 * the test file's body, after its static imports had already evaluated the
 * adapter. The suite then spawned the REAL agy binary — which soft-denied the
 * tool, exited 0, reported "SUCCESS" with an empty response, and passed the
 * "denial is a failure" assertions for entirely the wrong reason.
 *
 * Importing THIS module first is the fix: it has no dependency on anything in the
 * package, so ES module evaluation order guarantees it runs before the adapter is
 * loaded. Every suite that spawns a worker imports it as its FIRST import, and the
 * comment on each of those lines says why the position matters.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SHELL SHIM AND NOT A NODE WRAPPER
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * agy's own `buildArgv` emits `--print=<prompt>` as the FIRST argument and never
 * emits a positional, so there is nowhere to hide a script path. A one-line `sh`
 * shim lets the adapter see exactly the argv it would see against the real
 * binary, which means the argv builder, the stream-json pump, the denial logic and
 * the exit handling all run unmodified. A node wrapper would have to either
 * rewrite argv or accept a divergence that would hide the very bugs this fixture
 * exists to catch.
 */

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGY = path.resolve(HERE, 'fake-agy.mjs');

/** Create the shim in its own directory, outside any repo under test. */
function installFakeProviderShim(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-smith-fake-agy-'));
  const shim = path.join(dir, 'agy');
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGY)} "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

/** The fixture binary. Exported so a test can assert on which binary it is. */
export const FAKE_AGY_BINARY = installFakeProviderShim();

process.env['AGENT_SMITH_AGY_BIN'] = FAKE_AGY_BINARY;

/**
 * A guard against the failure this file exists to prevent.
 *
 * If the real binary somehow got captured, every "denial is a failure" test in the
 * suite would still pass — for the wrong reason, having quietly spent the user's
 * model quota. So the value is asserted rather than assumed.
 */
export function assertFakeProviderActive(): void {
  const captured = process.env['AGENT_SMITH_AGY_BIN'];
  if (captured !== FAKE_AGY_BINARY) {
    throw new Error(
      `the agy adapter was not pointed at the fixture: AGENT_SMITH_AGY_BIN=${captured ?? '(unset)'}, ` +
        `expected ${FAKE_AGY_BINARY}. Import ./shim.ts BEFORE anything that reaches providers/agy.ts.`,
    );
  }
}