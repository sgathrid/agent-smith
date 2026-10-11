import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSmokeServerEnv } from './smoke-env.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('smoke runner exercises isolated MCP scenarios and reports cleanup', () => {
  const result = spawnSync(process.execPath, ['scripts/smoke.mjs'], { cwd: repo, encoding: 'utf8', timeout: 45_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.mode, 'fake');
  assert.equal(summary.cleanup, 'removed');
  for (const name of [
    'MCP stdio tool discovery',
    'solo review and named resume',
    'cross-provider implement to review with executable check',
    'cancellation',
    'timeout',
    'concurrency limit',
  ]) assert.equal(summary.scenarios.find((scenario) => scenario.name === name)?.status, 'pass', name);
  assert.equal(existsSync(summary.scratch), false, 'scratch tree should be removed by default');
});

test('live server env removes only fixture binary overrides', () => {
  const env = buildSmokeServerEnv({ PATH: '/bin', AGENT_SMITH_CODEX_BIN: '/tmp/fake-codex', AGENT_SMITH_AGY_BIN: '/tmp/fake-agy', AGENT_SMITH_CLAUDE_BIN: '/opt/claude' }, {
    repo: '/tmp/smoke-repo', stateDir: '/tmp/smoke-state', fixtureBins: ['/tmp/fake-codex', '/tmp/fake-agy'],
  });
  assert.equal(env.AGY_WATCH_CWD, '/tmp/smoke-repo');
  assert.equal(env.AGENT_SMITH_STATE_DIR, '/tmp/smoke-state');
  assert.equal(env.AGENT_SMITH_CODEX_BIN, undefined);
  assert.equal(env.AGENT_SMITH_AGY_BIN, undefined);
  assert.equal(env.AGENT_SMITH_CLAUDE_BIN, '/opt/claude', 'caller-installed provider path should be retained');
});
