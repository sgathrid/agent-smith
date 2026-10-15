import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResult, createAgyTranslator, isDenialError } from './agy.ts';
import { deriveStatus } from '../forge/format.ts';

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

const REAL_DENIAL = { type: 'TOOL_ERROR', message: 'permission check failed for command "rm x": user denied permission to run command' };
function deniedRun(response: string, status = 'SUCCESS', code: number | null = 0) {
  const tx = createAgyTranslator(400);
  tx.onEvent({ event: 'step_update', step_update: { step_index: 3, step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: {} } });
  tx.onEvent({ event: 'step_update', step_update: { step_index: 3, step_type: 'tool', state: 'ERROR', tool_name: 'run_command', tool_info: { error: REAL_DENIAL } } });
  return buildResult({
    jobId: 'agy-denied', startedAtMs: Date.now() - 1, stateDir: '/tmp', denials: tx.denials, sawAnyToolCall: true, errorIsStale: false,
    exit: { code, signal: null, stderr: '' } as never,
    resultEvent: { status, response } as never,
  });
}

test('agy: a real denial with a delivered report succeeds with a warning, like claude', () => {
  const result = deniedRun('# Review\n\nThree findings, with evidence.');
  assert.equal(result.status, 'success');
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.ok(result.deniedActions?.length && result.deniedActions.every((d) => d.nonfatal === true));
  const verdict = deriveStatus({ ok: result.ok, jobStatus: result.status, deniedActions: result.deniedActions, report: result.response });
  assert.equal(verdict.status, 'succeeded');
  assert.match(verdict.note ?? '', /call denied/);
});

test('agy: a real denial with an empty report, or an unclean finish, still fails', () => {
  const empty = deniedRun('');
  assert.equal(empty.status, 'denied');
  assert.match(empty.error ?? '', /^denied /);
  assert.equal(empty.deniedActions?.some((d) => d.nonfatal), false);
  assert.equal(deriveStatus({ ok: empty.ok, jobStatus: empty.status, deniedActions: empty.deniedActions, report: '' }).status, 'failed');

  const crashed = deniedRun('partial notes', 'ERROR', 1);
  assert.equal(crashed.status, 'denied');
  assert.match(crashed.error ?? '', /^denied /);
});
