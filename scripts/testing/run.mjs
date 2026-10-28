#!/usr/bin/env node
/**
 * run.mjs — `npm test`: the node test runner inside a run-scoped temp root.
 *
 * Tests (and the workers, supervisors and git processes they spawn) create temp
 * directories freely; many never delete them. Pointing TMPDIR at one directory
 * per run and removing it afterwards means a run leaves nothing behind, however
 * it ends, and parallel runs never share a temp tree.
 *
 * The git/probe caps are product timeouts tuned for an idle machine; tests check
 * diff and probe logic, not how fast git runs on a loaded CI VM, so they get
 * generous caps here. Extra arguments are passed to `node --test` (e.g. a file).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = mkdtempSync(path.join(os.tmpdir(), 'agent-smith-test-'));
const cleanup = () => rmSync(root, { recursive: true, force: true });

const extra = process.argv.slice(2);
const files = extra.length > 0 ? extra : [
  'the-codes/**/*.test.ts', 'the-codes/**/*.node-test.ts', '!the-codes/**/node_modules/**', 'scripts/testing/smoke.test.mjs',
];

const child = spawn(process.execPath, ['--test', '--test-timeout=300000', '--experimental-strip-types', ...files], {
  cwd: repo,
  stdio: 'inherit',
  env: {
    ...process.env,
    TMPDIR: root, TMP: root, TEMP: root,
    AGENT_SMITH_GIT_TIMEOUT_MS: process.env.AGENT_SMITH_GIT_TIMEOUT_MS ?? '60000',
    AGENT_SMITH_PROBE_TIMEOUT_MS: process.env.AGENT_SMITH_PROBE_TIMEOUT_MS ?? '60000',
  },
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  cleanup();
  process.exitCode = code ?? (signal ? 1 : 0);
});
