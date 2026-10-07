#!/usr/bin/env node
/**
 * fake-worker.mjs — a local stand-in for the agy / codex / claude CLIs.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * Proving the spine requires a REAL job: spawn → stream → translate → store →
 * project → read back with the UI's own reader. A real `agy` job cannot be used
 * for that — it is OAuth-bound and every run spends the user's quota — so this
 * script stands in at exactly the boundary that matters: it is the CHILD PROCESS,
 * emitting a stream-json dialect on stdout.
 *
 * Everything above that boundary is the real code. This is not a mock of the
 * runner; it is a mock of the BINARY, which is the only part we cannot run
 * without spending money.
 *
 * ============================================================================
 * THREE DIALECTS, TRANSCRIBED NOT INVENTED
 * ============================================================================
 * Every event shape below is transcribed from the corresponding adapter's header,
 * each of which documented its shapes from a live run:
 *   - agy   → providers/agy.ts   (live, plus 14 900 archived records)
 *   - codex → providers/codex.ts (live `codex exec --json`)
 *   - claude→ providers/claude.ts(live `claude -p --output-format stream-json`)
 *
 * The dialect is chosen by FAKE_DIALECT (agy | codex | claude), which is what
 * makes the MIXED-PROVIDER path testable: point AGENT_SMITH_AGY_BIN,
 * AGENT_SMITH_CODEX_BIN and AGENT_SMITH_CLAUDE_BIN all at this script and a
 * three-worker DAG really does dispatch three different adapters.
 *
 * Details that matter and are easy to get wrong:
 *   - agy takes the prompt ATTACHED (`--print=<prompt>`); a space-separated
 *     `--print` swallows the prompt as the next token.
 *   - codex takes the prompt as a trailing POSITIONAL.
 *   - claude takes the prompt as a trailing positional too, after `-p`.
 *   - an agy tool is TWO records, ACTIVE then DONE/ERROR, with parameters only on
 *     the ACTIVE one.
 *   - codex's usage has no total_tokens and names its cache counter
 *     `cached_input_tokens`.
 *
 * ============================================================================
 * MODES (env FAKE_MODE) — one per behaviour worth proving
 * ============================================================================
 *   clean     (default) tool call, prose, non-empty result. Exit 0.
 *   denied    the REAL TRAP: tool soft-denied, status "SUCCESS", response "",
 *             denied_actions present, EXIT 0. Must produce a FAILED stage.
 *   empty     status "SUCCESS", exit 0, response "" — with tool calls. Also must
 *             fail, via the runner's independent empty-deliverable net.
 *   crash     exits 3 with no result event at all.
 *   slow      streams for FAKE_DELAY_MS, so cancel/timeout can be exercised.
 *
 * No dependencies, no network, no writes outside the given cwd.
 */

const argv = process.argv.slice(2);
const mode = process.env['FAKE_MODE'] ?? process.env['FAKE_AGY_MODE'] ?? 'clean';
const dialect = process.env['FAKE_DIALECT'] ?? 'agy';
const delayMs = Number(process.env['FAKE_DELAY_MS'] ?? process.env['FAKE_AGY_DELAY_MS'] ?? '0');

/**
 * The prompt, in whichever of the three forms its CLI takes.
 *
 * agy: ATTACHED `--print=<prompt>` — separated, `--print` swallows the next
 * token as its value, which is why providers/agy.ts is emphatic about it.
 * codex and claude: a trailing POSITIONAL, last argument.
 */
function promptFromArgv(args, dia) {
  if (dia === 'agy') {
    for (const a of args) {
      if (a.startsWith('--print=')) return a.slice('--print='.length);
    }
    return '';
  }
  // Trailing positional: the last argument that is not a flag and is not the
  // value of a preceding flag. Scanning backwards and stopping at the first
  // `--flag` is enough for the argv our adapters build.
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i] ?? '';
    if (a.startsWith('-')) continue;
    if (i > 0 && (args[i - 1] ?? '').startsWith('-')) continue; // a flag's value
    return a;
  }
  return '';
}

function modelFromArgv(args) {
  const i = args.indexOf('--model');
  return i === -1 ? null : (args[i + 1] ?? null);
}

const prompt = promptFromArgv(argv, dialect);
const model = modelFromArgv(argv);
const conversationId = `fake-${Math.random().toString(36).slice(2, 10)}`;

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** agy's ACTIVE record. Note `parameters` appears ONLY here. */
function toolActive(stepIndex, toolName, parameters) {
  emit({
    event: 'step_update',
    conversation_id: conversationId,
    step_update: {
      conversation_id: conversationId,
      step_index: stepIndex,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: toolName,
      tool_info: { name: toolName, parameters },
    },
  });
}

/** agy's DONE record. Carries output; NO parameters. */
function toolDone(stepIndex, toolName, output, durationSeconds) {
  emit({
    event: 'step_update',
    conversation_id: conversationId,
    step_update: {
      conversation_id: conversationId,
      step_index: stepIndex,
      state: 'DONE',
      step_type: 'tool',
      tool_name: toolName,
      tool_info: { name: toolName, output },
      duration_seconds: durationSeconds,
      usage: { input_tokens: 1200, output_tokens: 180, thinking_tokens: 40, total_tokens: 1420 },
    },
  });
}

function toolError(stepIndex, toolName, error, durationSeconds) {
  emit({
    event: 'step_update',
    conversation_id: conversationId,
    step_update: {
      conversation_id: conversationId,
      step_index: stepIndex,
      state: 'ERROR',
      step_type: 'tool',
      tool_name: toolName,
      tool_info: {
        name: toolName,
        error: { type: 'TOOL_ERROR', message: error },
      },
      duration_seconds: durationSeconds,
    },
  });
}

function agentText(stepIndex, text) {
  emit({
    event: 'step_update',
    conversation_id: conversationId,
    step_update: {
      conversation_id: conversationId,
      step_index: stepIndex,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: text,
      usage: { input_tokens: 900, output_tokens: 90, thinking_tokens: 20, total_tokens: 1010 },
    },
  });
}

function result(status, response, extra = {}) {
  emit({
    event: 'result',
    result: {
      conversation_id: conversationId,
      status,
      response,
      duration_seconds: 1.5,
      num_turns: 3,
      usage: { input_tokens: 2100, output_tokens: 270, thinking_tokens: 60, total_tokens: 2430 },
      ...extra,
    },
  });
}

// A stderr line, mirroring how agy reports an auto-denial. The adapter keys its
// warn level off these words, so the fixture has to contain them to exercise the
// path the real binary takes.
function denyNotice(tool) {
  process.stderr.write(
    `jetski: no output produced — a tool required the "command" permission that ` +
      `headless mode cannot prompt for (${tool}), so it was auto-denied. ` +
      `Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.\n`,
  );
}

async function main() {
  // agy's `init` event. The adapter reads conversation_id and model from it.
  emit({ event: 'init', conversation_id: conversationId, init: { model, permission_mode: mode === 'denied' ? 'proceed-in-sandbox' : 'proceed' } });

  if (mode === 'crash') {
    // No result event at all: the adapter must reach 'malformed'/'error', never
    // 'success'. Exiting non-zero makes it unambiguous.
    process.stderr.write('fake-agy: simulated crash before any result event\n');
    process.exit(3);
    return;
  }

  agentText(1, `Working on: ${prompt.slice(0, 80)}\n`);

  if (mode === 'slow') {
    // Emit an ACTIVE, then dribble updates for the whole delay. The updates are
    // what prove the liveness clock advances during a long tool call.
    toolActive(2, 'run_command', { CommandLine: 'sleep 30' });
    for (let i = 0; i < Math.max(1, Math.ceil(delayMs / 500)); i++) {
      await sleep(Math.min(500, delayMs));
      emit({
        event: 'step_update',
        conversation_id: conversationId,
        step_update: {
          conversation_id: conversationId,
          step_index: 2,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { name: 'run_command', output: `still running… ${i}` },
        },
      });
    }
    toolDone(2, 'run_command', 'ok', delayMs / 1000);
    result('SUCCESS', 'The slow command finished. Nothing else was needed.\n');
    return;
  }

  if (mode === 'denied') {
    // ── THE VERIFIED TRAP, reproduced ──────────────────────────────────────
    // A tool is denied, agy prints the warning to stderr, then reports SUCCESS
    // with an EMPTY response and a non-empty denied_actions — and exits 0.
    denyNotice('run_command');
    toolActive(2, 'run_command', { CommandLine: 'echo hi' });
    toolError(
      2,
      'run_command',
      'permission check failed for command "echo hi": user denied permission to run command: ' +
        'Proceed without performing this action.',
      0.1,
    );
    result('SUCCESS', '', {
      denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
    });
    process.exit(0);
    return;
  }

  if (mode === 'empty') {
    // Success, exit 0, tool calls made, NO output at all and no denial. Only the
    // runner's independent "empty deliverable after tool calls" check catches
    // this one — the provider adapter calls it a legitimate result.
    toolActive(2, 'run_command', { CommandLine: 'ls -la' });
    toolDone(2, 'run_command', 'total 8\ndrwxr-xr-x  . \n', 0.2);
    agentText(3, 'Finished the listing.\n');
    result('SUCCESS', '');
    process.exit(0);
    return;
  }

  // --- clean -----------------------------------------------------------------
  toolActive(2, 'view_file', { AbsolutePath: '/tmp/fake-target.ts' });
  toolDone(2, 'view_file', 'export const x = 1;\n', 0.3);
  toolActive(3, 'replace_file_content', { TargetFile: '/tmp/fake-target.ts' });
  toolDone(3, 'replace_file_content', 'edited 1 line', 0.4);
  // A verification run: this is what distinguishes 'edit' from 'verification'
  // in the observation stream, so `edit-churn-unverified` can ever fire.
  toolActive(4, 'run_command', { CommandLine: 'npm test' });
  toolDone(4, 'run_command', 'pass 4 fail 0', 1.1);
  agentText(5, 'Done: one edit, tests pass.\n');
  result(
    'SUCCESS',
    'Changed fake-target.ts: bumped the export. Verified with `npm test` (4 passing).\n',
  );
  process.exit(0);
}

/* ========================================================================== */
/* CODEX DIALECT  — transcribed from providers/codex.ts's "VERIFIED EVENT       */
/* SHAPES (live, codex exec --json)" block.                                  */
/* ========================================================================== */

function codexThreadStarted() {
  emit({ type: 'thread.started', thread_id: conversationId, model });
}

function codexItem(itemId, type, extra) {
  emit({ type: 'item.started', item: { id: itemId, type, ...extra } });
  emit({ type: 'item.completed', item: { id: itemId, type, status: 'completed', ...extra } });
}

function codexAgentMessage(text) {
  emit({ type: 'item.completed', item: { id: `msg_${step++}`, type: 'agent_message', text } });
}

function codexTurnCompleted() {
  // NOTE: no total_tokens, and the cache counter is `cached_input_tokens`.
  // providers/codex.ts maps that to cacheReadTokens and leaves totalTokens
  // undefined rather than inventing one — so this fixture does not supply one,
  // or the test would not be testing the mapping.
  emit({
    type: 'turn.completed',
    usage: {
      input_tokens: 22319,
      cached_input_tokens: 12288,
      cache_write_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    },
  });
}

async function runCodex() {
  codexThreadStarted();
  emit({ type: 'turn.started' });

  if (mode === 'crash') {
    process.stderr.write('fake-worker(codex): simulated crash before any terminal event\n');
    process.exit(3);
    return;
  }

  if (mode === 'slow') {
    codexItem('item_0', 'command_execution', { command: 'sleep 30' });
    for (let i = 0; i < Math.max(1, Math.ceil(delayMs / 500)); i++) {
      await sleep(Math.min(500, delayMs));
      emit({
        type: 'item.updated',
        item: { id: 'item_0', type: 'command_execution', command: 'sleep 30', aggregated_output: `running… ${i}` },
      });
    }
    // codex has no `response` field: its final text comes from an
    // `agent_message` item. Without one the adapter's response is "" and the
    // runner's empty-deliverable check correctly fails the stage — which is why
    // this line exists in the fixture rather than being omitted.
    codexAgentMessage('The slow command finished. Nothing else was needed.\n');
    codexTurnCompleted();
    process.exit(0);
    return;
  }

  if (mode === 'denied') {
    // codex's denial shape is UNVERIFIED in the adapter's own words; it detects
    // it from message text. Emitting that text exercises the detection honestly.
    denyNotice('command_execution');
    emit({
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'command_execution',
        command: 'echo hi',
        status: 'failed',
        message: 'denied: approval rejected by the user',
        exit_code: 1,
      },
    });
    codexTurnCompleted();
    // codex has no `denied_actions`; the adapter's text match is the only signal,
    // so this run proves the SECOND line of defence rather than the first.
    process.exit(1);
    return;
  }

  codexItem('item_0', 'file_change', { input: 'export const x = 1;' });
  codexItem('item_1', 'command_execution', { command: 'npm test', aggregated_output: 'pass 4 fail 0' });
  codexAgentMessage(`codex reviewed: ${prompt.slice(0, 60)}`);
  codexTurnCompleted();
  process.exit(0);
}

/* ========================================================================== */
/* CLAUDE DIALECT — transcribed from providers/claude.ts's "VERIFIED EVENT      */
/* SHAPES (live run of claude -p --output-format stream-json …)" block.       */
/* ========================================================================== */

function claudeInit() {
  emit({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: conversationId,
    model: model ?? 'claude-sonnet-4-5',
    tools: ['Task', 'Bash', 'Read', 'Edit'],
  });
}

function claudeAssistant(content, usage) {
  emit({
    type: 'assistant',
    message: { id: `msg_${step++}`, role: 'assistant', content, model: model ?? 'claude-sonnet-4-5', ...(usage ? { usage } : {}) },
    session_id: conversationId,
  });
}

function claudeToolUse(name, input) {
  claudeAssistant([{ type: 'tool_use', id: `toolu_${step}`, name, input }]);
}

function claudeToolResult(toolUseId, content, isError) {
  emit({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
    session_id: conversationId,
  });
}

function claudeResult(subtype, result, extra) {
  emit({
    type: 'result',
    subtype,
    duration_ms: 1500,
    is_error: subtype !== 'success',
    result,
    session_id: conversationId,
    total_cost_usd: 0.03,
    num_turns: 3,
    stop_reason: 'end_turn',
    // claude nests thinking under output_tokens_details; the adapter reads it
    // from there, so the fixture puts it there rather than at the top level.
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 24425,
      cache_read_input_tokens: 0,
      output_tokens: 70,
      output_tokens_details: { thinking_tokens: 63 },
    },
    ...extra,
  });
}

async function runClaude() {
  claudeInit();

  if (mode === 'crash') {
    process.stderr.write('fake-worker(claude): simulated crash before any result event\n');
    process.exit(3);
    return;
  }

  if (mode === 'slow') {
    claudeToolUse('Bash', { command: 'sleep 30' });
    for (let i = 0; i < Math.max(1, Math.ceil(delayMs / 500)); i++) {
      await sleep(Math.min(500, delayMs));
      claudeToolResult(`toolu_${step}`, `running… ${i}`, false);
    }
    claudeResult('success', 'The slow command finished.\n');
    process.exit(0);
    return;
  }

  if (mode === 'denied') {
    denyNotice('Bash');
    claudeToolUse('Bash', { command: 'echo hi' });
    claudeToolResult(`toolu_${step}`, 'permission denied: user rejected', true);
    // claude reports the denial as an ERROR result, unlike agy's exit-0 SUCCESS,
    // so the failure here is honest rather than a trap reproduction.
    claudeResult('error_during_execution', '', { permission_denials: [{ tool_name: 'Bash' }] });
    process.exit(1);
    return;
  }

  claudeAssistant([{ type: 'thinking', thinking: 'The implement stage claims tests pass; check.', signature: 'sig' }]);
  claudeToolUse('Read', { file_path: '/tmp/fake-target.ts' });
  claudeToolResult(`toolu_${step}`, 'export const x = 1;', false);
  claudeToolUse('Bash', { command: 'npm test' });
  claudeToolResult(`toolu_${step}`, 'pass 4 fail 0', false);
  claudeAssistant(
    [{ type: 'text', text: `claude moderated: ${prompt.slice(0, 60)}` }],
    { input_tokens: 900, output_tokens: 90 },
  );
  claudeResult('success', 'claude moderated the artifact and found nothing blocking.\n');
  process.exit(0);
}

/* -------------------------------------------------------------------------- */

let step = 0;

if (dialect === 'codex') {
  await runCodex();
} else if (dialect === 'claude') {
  await runClaude();
} else {
  await main();
}