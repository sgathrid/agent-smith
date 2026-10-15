import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgyTranslator, isDenialError } from './agy.ts';

// Verbatim shape from job review-smith-506c2cfe step 18 (path shortened).
const ENOENT = {
  type: 'TOOL_ERROR',
  message: 'declaring permissions: cortex tool view_file: convert tool call for permissions: model output error: ' +
    'invalid tool call error (invalid_args) failed to read file: stat /w/pkg/missing.py: no such file or directory',
};

test('agy: a missing-file read prefixed "declaring permissions" is an error, not a denial', () => {
  assert.equal(isDenialError(ENOENT), false);
  const tx = createAgyTranslator(400);
  tx.onEvent({ event: 'step_update', step_update: { step_index: 18, step_type: 'tool', state: 'ACTIVE',
    tool_name: 'view_file', tool_info: { parameters: { AbsolutePath: '/w/pkg/missing.py' } } } });
  const end = tx.onEvent({ event: 'step_update', step_update: { step_index: 18, step_type: 'tool', state: 'ERROR',
    tool_name: 'view_file', tool_info: { error: ENOENT } } }).at(-1);
  assert.ok(end?.kind === 'activity-end');
  assert.equal(end.status, 'error');
  assert.equal(tx.denials.length, 0);
});

test('agy: real headless denials still classify as denied', () => {
  for (const message of [
    'permission check failed for command "echo hi": user denied permission to run command: Proceed without performing this action.',
    'permission check failed',
  ]) assert.equal(isDenialError({ type: 'TOOL_ERROR', message }), true, message);
});
