#!/usr/bin/env node
/** Local, quota-free fixture for the verified agy stream-json adapter. */
import process from 'node:process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const prompt = argv.find((arg) => arg.startsWith('--print='))?.slice('--print='.length) ?? '';
const lower = prompt.toLowerCase();
const scenario = process.env.FAKE_AGY_SCENARIO ??
  (lower.includes('deny') ? 'denied' : lower.includes('silent') ? 'silent' : lower.includes('crash') ? 'crash' : lower.includes('slow') ? 'slow' : 'ok');
const sleepMs = scenario === 'slow' ? Number(process.env.FAKE_AGY_SLEEP_MS ?? '3000') : 0;
const conversation = `conv-fake-${scenario}-0001`;
const report = '# Fixture report\n\nTwo tool steps were executed and this is the deliverable text.\n';

function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function step(index, state, tool, parameters, extra = {}) {
  out({ event: 'step_update', step_update: {
    conversation_id: conversation,
    step_index: index,
    state,
    step_type: 'tool',
    tool_name: tool,
    ...(parameters === undefined ? {} : { tool_info: { parameters } }),
    ...extra,
  } });
}

function emit() {
  out({ event: 'init', init: { model: 'fake-model-1', conversation_id: conversation, permission_mode: 'proceed-in-sandbox' } });
  if (scenario === 'crash') process.exit(3);

  if (scenario === 'denied') {
    step(2, 'ERROR', 'run_command', { command: 'echo hi' }, { tool_info: { parameters: { command: 'echo hi' }, error: { type: 'TOOL_ERROR', message: 'permission check failed' } } });
    out({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: '', duration_seconds: 0.1, num_turns: 1, usage: { input_tokens: 10, output_tokens: 0 }, denied_actions: [{ action: 'command', display_name: 'RunCommand' }] } });
    return;
  }

  if (scenario !== 'silent') {
    const outputMatch = prompt.match(/Write your full answer to (.+?)\. That file is what/);
    if (outputMatch?.[1]) {
      mkdirSync(path.dirname(outputMatch[1]), { recursive: true });
      writeFileSync(outputMatch[1], `${report}\nWorker-authored detail preserved by the forge runner.\n`);
    }
    step(2, 'ACTIVE', 'read_file', { path: 'src/index.ts' });
    step(2, 'DONE', 'read_file');
    step(3, 'ACTIVE', 'run_command', { command: 'npm test' });
    step(3, 'DONE', 'run_command');
    out({ event: 'step_update', step_update: { conversation_id: conversation, step_index: 4, state: 'DONE', step_type: 'agent_response', text_delta: report } });
  }

  out({ event: 'result', result: {
    conversation_id: conversation,
    status: 'SUCCESS',
    response: scenario === 'silent' ? '' : report,
    duration_seconds: (Date.now() - startedAt) / 1000,
    num_turns: scenario === 'silent' ? 0 : 3,
    usage: { input_tokens: 20, output_tokens: scenario === 'silent' ? 0 : 30, total_tokens: scenario === 'silent' ? 20 : 50 },
  } });
}

const startedAt = Date.now();
const timeoutIndex = argv.indexOf('--print-timeout');
if (timeoutIndex >= 0) process.stderr.write(`fake-agy: print-timeout=${argv[timeoutIndex + 1] ?? ''}\n`);
if (sleepMs > 0) setTimeout(emit, sleepMs);
else emit();
