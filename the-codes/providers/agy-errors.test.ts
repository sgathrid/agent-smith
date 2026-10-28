/**
 * Regression tests for agy stale/recovered result.error handling and
 * error_message notice text.
 *
 * Fixture shapes are trimmed from two real pulsar jobs on conversation
 * cb4b43aa-dc46-47e7-98b3-3ebcf6c8219c:
 *   1. implement-smith-615fa42d — three 429 RESOURCE_EXHAUSTED error_message
 *      steps, followed by successful tool + model response steps, ending with
 *      result.status === "ERROR" and a full response.
 *   2. implement-smith-431a1f0e — resumed conversation with no error_message
 *      steps of its own, ending with result.status === "ERROR" carrying an
 *      earlier run's "The stream was interrupted..." error and a full response.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildResult, createAgyTranslator, recoveredNotice } from './agy.ts';
import { JobWriter } from '../forge/writer.ts';

const CONV_ID = 'cb4b43aa-dc46-47e7-98b3-3ebcf6c8219c';

/**
 * Shape 1 (trimmed from implement-smith-615fa42d):
 * Three 429 error_message steps, then model + tool progress, then final result
 * with status: "ERROR" carrying the last 429 error and a finished response.
 */
const RECOVERED_429_LINES = [
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'init',
    init: { agent: 'agy', model: 'claude-opus-4-6', permission_mode: 'proceed-in-sandbox' },
  }),
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'step_update',
    step_update: {
      conversation_id: CONV_ID,
      duration_seconds: 0,
      state: 'DONE',
      step_index: 467,
      step_type: 'error_message',
    },
  }),
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'step_update',
    step_update: {
      conversation_id: CONV_ID,
      duration_seconds: 0,
      state: 'DONE',
      step_index: 468,
      step_type: 'error_message',
    },
  }),
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'step_update',
    step_update: {
      conversation_id: CONV_ID,
      duration_seconds: 0,
      state: 'DONE',
      step_index: 469,
      step_type: 'error_message',
    },
  }),
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'step_update',
    step_update: {
      conversation_id: CONV_ID,
      state: 'ACTIVE',
      step_index: 470,
      step_type: 'agent_response',
      text_delta: 'Running the test suite to verify.',
    },
  }),
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'step_update',
    step_update: {
      conversation_id: CONV_ID,
      duration_seconds: 0,
      state: 'DONE',
      step_index: 470,
      step_type: 'agent_response',
      usage: { input_tokens: 185, output_tokens: 94, cache_read_tokens: 171186, total_tokens: 171465 },
    },
  }),
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'step_update',
    step_update: {
      conversation_id: CONV_ID,
      state: 'ACTIVE',
      step_index: 471,
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'pytest' } },
    },
  }),
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'step_update',
    step_update: {
      conversation_id: CONV_ID,
      duration_seconds: 4.2,
      state: 'DONE',
      step_index: 471,
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', output: '956 passed in 4.10s' },
    },
  }),
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'result',
    result: {
      conversation_id: CONV_ID,
      duration_seconds: 1559.17,
      error:
        "Error: API error (attempt 3): RESOURCE_EXHAUSTED (code 429): Quota exceeded for quota metric 'Hiemannlace' and limit 'Hiemannlace per day' of service 'aimer.googleapis.com' for consumer 'project_number:585807405832'.",
      num_turns: 1,
      response: 'Done.\n\n### Summary\nAll 956 tests passed.',
      status: 'ERROR',
      usage: { input_tokens: 60423, output_tokens: 57188, thinking_tokens: 2450, cache_read_tokens: 34479266, total_tokens: 34599327 },
    },
  }),
];

/**
 * Shape 2 (trimmed from implement-smith-431a1f0e):
 * Resumed conversation with no error_message step in this run, but final result
 * carries status: "ERROR" and an earlier job's stream interruption error.
 */
const STALE_PRIOR_RUN_ERROR_LINES = [
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'init',
    init: { agent: 'agy', model: 'claude-opus-4-6', permission_mode: 'proceed-in-sandbox' },
  }),
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'step_update',
    step_update: {
      conversation_id: CONV_ID,
      state: 'ACTIVE',
      step_index: 416,
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'pytest' } },
    },
  }),
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'step_update',
    step_update: {
      conversation_id: CONV_ID,
      duration_seconds: 1.8,
      state: 'DONE',
      step_index: 416,
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', output: '69 passed' },
    },
  }),
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'step_update',
    step_update: {
      conversation_id: CONV_ID,
      state: 'ACTIVE',
      step_index: 417,
      step_type: 'agent_response',
      text_delta: 'Done.\n\n### What Changed\n- Updated call sites.',
    },
  }),
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'step_update',
    step_update: {
      conversation_id: CONV_ID,
      duration_seconds: 0,
      state: 'DONE',
      step_index: 417,
      step_type: 'agent_response',
      usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200 },
    },
  }),
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'result',
    result: {
      conversation_id: CONV_ID,
      duration_seconds: 583.04,
      error:
        'Error: The stream was interrupted. This can happen due to poor network connectivity or hitting usage limits. Please try again.',
      num_turns: 1,
      response: 'Done.\n\n### What Changed\n- Updated call sites.',
      status: 'ERROR',
      usage: { input_tokens: 17025, output_tokens: 20092, thinking_tokens: 774, cache_read_tokens: 9076681, total_tokens: 9114572 },
    },
  }),
];

/**
 * Shape 3:
 * An error_message step with no later progress and an empty response remains a failure.
 */
const UNRECOVERED_ERROR_LINES = [
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'init',
    init: { agent: 'agy', model: 'claude-opus-4-6', permission_mode: 'proceed-in-sandbox' },
  }),
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'step_update',
    step_update: {
      conversation_id: CONV_ID,
      duration_seconds: 0,
      state: 'DONE',
      step_index: 469,
      step_type: 'error_message',
    },
  }),
  JSON.stringify({
    conversation_id: CONV_ID,
    event: 'result',
    result: {
      conversation_id: CONV_ID,
      duration_seconds: 12.4,
      error:
        "Error: API error (attempt 3): RESOURCE_EXHAUSTED (code 429): Quota exceeded for quota metric 'Hiemannlace' and limit 'Hiemannlace per day' of service 'aimer.googleapis.com' for consumer 'project_number:585807405832'.",
      num_turns: 1,
      response: '',
      status: 'ERROR',
      usage: { input_tokens: 180, output_tokens: 0, total_tokens: 180 },
    },
  }),
];

describe('agy stale and recovered error handling', () => {
  it('treats recovered 429 error_message steps followed by progress and a response as success with a warning', () => {
        const repo = mkdtempSync(join(tmpdir(), 'agy-forge-test-'));
    try {
      const tx = createAgyTranslator(2000);
      const events = RECOVERED_429_LINES.flatMap((l) => tx.onEvent(JSON.parse(l)));
      const resultEvent = JSON.parse(RECOVERED_429_LINES.at(-1)!).result;

      const notices = events.filter(
        (e): e is Extract<(typeof events)[number], { kind: 'notice' }> => e.kind === 'notice',
      );
      // agy's stream carries no error text at the step; the result names it.
      assert.deepEqual(notices.map((n) => n.message), ['agy error', 'agy error', 'agy error']);

      const res = buildResult({
        jobId: 'implement-smith-615fa42d',
        resultEvent,
        exit: { code: 0, signal: null, killReason: undefined, stderr: '' },
        startedAtMs: Date.now() - 1_559_000,
        stateDir: repo,
        denials: tx.denials,
        sawAnyToolCall: tx.stepsWereTools(),
        errorIsStale: tx.errorIsStale(),
      });

      assert.equal(res.status, 'success');
      assert.equal(res.ok, true);
      assert.equal(res.error, undefined);
      assert.match(res.response, /956 tests passed/);
      const recovered = recoveredNotice(res, resultEvent);
      assert.equal(recovered?.kind === 'notice' && recovered.level, 'warn');
      assert.equal(recovered?.kind === 'notice' && recovered.message, 'recovered: 429 resource exhausted');
      events.push(recovered!);

      // Verify the notice -> progress.warnings path via JobWriter.
      const writer = new JobWriter({ repo, jobId: 'implement-smith-615fa42d', flushMs: 0 });
      writer.start({
        provider: 'agy',
        mode: 'implement',
        model: 'claude-opus-4-6',
        effort: null,
        cwd: repo,
        prompt: 'test',
        unrestricted: true,
        timeoutMs: 0,
        conversation: CONV_ID,
        pipeline: null,
        stage: null,
        attempt: null,
      });
      for (const ev of events) writer.onEvent(ev);
      const manifest = writer.finish(res, res.response);
      assert.equal(manifest.status, 'succeeded');

      const progress = JSON.parse(
        readFileSync(join(repo, '.agent-smith', 'jobs', 'implement-smith-615fa42d', 'progress.json'), 'utf8'),
      ) as { warnings: string[] };
      assert.ok(progress.warnings.includes('recovered: 429 resource exhausted'));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('treats a stale error from an earlier run on a resumed conversation as success with a warning', () => {
    const repo = mkdtempSync(join(tmpdir(), 'agy-forge-stale-'));
    try {
      const tx = createAgyTranslator(2000);
      const events = STALE_PRIOR_RUN_ERROR_LINES.flatMap((l) => tx.onEvent(JSON.parse(l)));
      const resultEvent = JSON.parse(STALE_PRIOR_RUN_ERROR_LINES.at(-1)!).result;

      assert.equal(tx.errorIsStale(), true);

      const notices = events.filter(
        (e): e is Extract<(typeof events)[number], { kind: 'notice' }> => e.kind === 'notice',
      );
      assert.equal(notices.length, 0);

      const res = buildResult({
        jobId: 'implement-smith-431a1f0e',
        resultEvent,
        exit: { code: 0, signal: null, killReason: undefined, stderr: '' },
        startedAtMs: Date.now() - 583_000,
        stateDir: repo,
        denials: tx.denials,
        sawAnyToolCall: tx.stepsWereTools(),
        errorIsStale: tx.errorIsStale(),
      });

      assert.equal(res.status, 'success');
      assert.equal(res.ok, true);
      assert.equal(res.error, undefined);
      assert.match(res.response, /What Changed/);
      const recovered = recoveredNotice(res, resultEvent);
      assert.equal(recovered?.kind === 'notice' && recovered.message, 'recovered: the stream was interrupted');
      events.push(recovered!);

      const writer = new JobWriter({ repo, jobId: 'implement-smith-431a1f0e', flushMs: 0 });
      writer.start({
        provider: 'agy',
        mode: 'implement',
        model: 'claude-opus-4-6',
        effort: null,
        cwd: repo,
        prompt: 'test',
        unrestricted: true,
        timeoutMs: 0,
        conversation: CONV_ID,
        pipeline: null,
        stage: null,
        attempt: null,
      });
      for (const ev of events) writer.onEvent(ev);
      const manifest = writer.finish(res, res.response);
      assert.equal(manifest.status, 'succeeded');

      const progress = JSON.parse(
        readFileSync(join(repo, '.agent-smith', 'jobs', 'implement-smith-431a1f0e', 'progress.json'), 'utf8'),
      ) as { warnings: string[] };
      assert.deepEqual(progress.warnings, ['recovered: the stream was interrupted']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps an error with no later progress and an empty response as a failure', () => {
    const tx = createAgyTranslator(2000);
    const events = UNRECOVERED_ERROR_LINES.flatMap((l) => tx.onEvent(JSON.parse(l)));
    const resultEvent = JSON.parse(UNRECOVERED_ERROR_LINES.at(-1)!).result;

    assert.equal(tx.errorIsStale(), false);

    const notices = events.filter(
      (e): e is Extract<(typeof events)[number], { kind: 'notice' }> => e.kind === 'notice',
    );
    // Only the error_message notice, no recovered warning
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.level, 'error');
    assert.equal(notices[0]!.message, 'agy error');

    const res = buildResult({
      jobId: 'failed-job',
      resultEvent,
      exit: { code: 0, signal: null, killReason: undefined, stderr: '' },
      startedAtMs: Date.now() - 12_000,
      stateDir: '/tmp/nowhere',
      denials: tx.denials,
      sawAnyToolCall: tx.stepsWereTools(),
      errorIsStale: tx.errorIsStale(),
    });

    assert.equal(res.status, 'error');
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /RESOURCE_EXHAUSTED/);
  });

  it('keeps an error with no later progress as a failure even when there is a response', () => {
    const tx = createAgyTranslator(2000);
    tx.onEvent({ event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'partial notes' } });
    tx.onEvent({ event: 'step_update', step_update: { step_index: 2, step_type: 'error_message', state: 'DONE' } });
    assert.equal(tx.errorIsStale(), false);
    const resultEvent = { status: 'ERROR', response: 'partial notes', error: 'API error: RESOURCE_EXHAUSTED (code 429)' };
    const res = buildResult({
      jobId: 'unrecovered', resultEvent: resultEvent as never, exit: { code: 0, signal: null, killReason: undefined, stderr: '' },
      startedAtMs: Date.now() - 1, stateDir: '/tmp', denials: tx.denials, sawAnyToolCall: false, errorIsStale: tx.errorIsStale(),
    });
    assert.equal(res.status, 'error');
    assert.equal(recoveredNotice(res, resultEvent as never), undefined, 'no warning when the run failed');
  });

  it('gives no recovered warning when the verdict is not success (non-zero exit, cancel)', () => {
    const resultEvent = { status: 'ERROR', response: 'done', error: 'The stream was interrupted.' };
    for (const exit of [{ code: 1, signal: null, killReason: undefined, stderr: '' }, { code: null, signal: 'SIGTERM', killReason: 'cancelled', stderr: '' }]) {
      const res = buildResult({
        jobId: 'x', resultEvent: resultEvent as never, exit: exit as never, startedAtMs: Date.now() - 1, stateDir: '/tmp',
        denials: [], sawAnyToolCall: false, errorIsStale: true,
      });
      assert.notEqual(res.status, 'success');
      assert.equal(recoveredNotice(res, resultEvent as never), undefined);
    }
  });
});
