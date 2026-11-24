import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGY = path.resolve(HERE, 'fake-agy.mjs');

function installFakeProviderShim(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-smith-fake-agy-'));
  const shim = path.join(dir, 'agy');
  writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AGY)} "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

export const FAKE_AGY_BINARY = installFakeProviderShim();

process.env['AGENT_SMITH_AGY_BIN'] = FAKE_AGY_BINARY;

export function assertFakeProviderActive(): void {
  const captured = process.env['AGENT_SMITH_AGY_BIN'];
  if (captured !== FAKE_AGY_BINARY) {
    throw new Error(
      `the agy adapter was not pointed at the fixture: AGENT_SMITH_AGY_BIN=${captured ?? '(unset)'}, ` +
        `expected ${FAKE_AGY_BINARY}.`,
    );
  }
}