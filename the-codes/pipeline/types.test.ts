import assert from 'node:assert/strict';
import { test } from 'node:test';

import { deniedEnvReason, validateEnv } from './types.ts';

test('validateEnv refuses keys that change how the worker binary is found or loaded', () => {
  assert.throws(() => validateEnv({ PATH: '/tmp/shims' }), /env\.PATH would change which worker binary runs/);
  assert.throws(() => validateEnv({ NODE_OPTIONS: '--import=data:text/javascript,1' }), /env\.NODE_OPTIONS would run code before the worker starts/);
  assert.throws(() => validateEnv({ DYLD_INSERT_LIBRARIES: '/tmp/x.dylib' }), /env\.DYLD_INSERT_LIBRARIES would change which libraries/);
  assert.throws(() => validateEnv({ AGENT_SMITH_X: '1' }), /env\.AGENT_SMITH_X is Agent Smith's own setting/);
  assert.throws(() => validateEnv({ CODEX_HOME: '/tmp/c' }, 'stages[0].env'), /stages\[0\]\.env\.CODEX_HOME would change the provider's config/);
  for (const key of ['HOME', 'SHELL', 'TMPDIR', 'NODE_PATH', 'LD_PRELOAD', 'CLAUDE_CONFIG_DIR', 'KIMI_CODE_HOME', 'OPENCODE_CONFIG', 'AGY_X', 'XDG_CONFIG_HOME']) {
    assert.notEqual(deniedEnvReason(key), null, key);
  }
});

test('validateEnv matches the denylist case-insensitively', () => {
  assert.throws(() => validateEnv({ path: '/tmp/shims' }), /env\.path would change which worker binary runs/);
  assert.throws(() => validateEnv({ Node_Options: '--require=x' }), /env\.Node_Options/);
});

test('validateEnv accepts ordinary build and logging variables', () => {
  assert.deepEqual(validateEnv({ CARGO_TARGET_DIR: '/tmp/target', RUST_LOG: 'debug' }), { CARGO_TARGET_DIR: '/tmp/target', RUST_LOG: 'debug' });
  // A denied name inside a longer one is not a prefix match.
  assert.deepEqual(validateEnv({ MY_PATH: 'x', GOPATH: 'y' }), { MY_PATH: 'x', GOPATH: 'y' });
});
