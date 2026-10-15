/**
 * providers/claude.ts — Claude Code headless adapter.
 *
 * This is agent-smith's PROBER / MODERATOR provider. ARCHITECTURE.md is
 * emphatic about why: "Claude proposes, another model probes." Generative
 * agreement between same-family models is correlated (60% agreement when both
 * err, ICML 2025, 350+ models), so self-consistency is not verification — a
 * different model family is. This adapter exists to be that different family,
 * which means it must be as trustworthy about its own failure modes as agy is.
 *
 * ============================================================================
 * VERIFICATION LEVEL: HIGH. Verified by running `claude --help` (2.1.292) and
 * by executing the exact invocation below against a live model.
 * ============================================================================
 *
 * VERIFIED FLAGS (`claude --help`, 2.1.292):
 *
 *   -p, --print                       "Print response and exit (useful for pipes)".
 *                                     Note the help text itself says the workspace
 *                                     trust dialog is skipped when stdout is not
 *                                     a TTY — which is exactly our spawn shape.
 *   --output-format <text|json|stream-json>   "(only works with --print)"
 *   --input-format <text|stream-json>
 *   --verbose                         required for the full stream in print mode
 *   --forward-subagent-text           "Forward subagent text and thinking blocks as
 *                                     assistant/user messages with
 *                                     parent_tool_use_id set (only works with
 *                                     --print and --output-format=stream-json)"
 *                                     ^^^ THIS IS THE FLAG THAT MAKES A MODERATOR
 *                                     USABLE. Without it, a subagent's reasoning
 *                                     is invisible to us, and a moderator that
 *                                     cannot see what the prober did is just
 *                                     another proposer.
 *   --include-partial-messages        partial chunks as they arrive (stream-json)
 *   --model <model>                   alias ('fable', 'opus', 'sonnet') or full name
 *   --permission-mode <acceptEdits|auto|bypassPermissions|manual|dontAsk|plan>
 *   --permission-prompts <host|none>  who answers permission prompts in print mode
 *   --dangerously-skip-permissions    bypass all permission checks
 *   --allow-dangerously-skip-permissions  make it an *option*, not the default
 *   --add-dir <directories...>        additional directories for tool access
 *   --session-id <uuid>               use a specific session id
 *   --allowedTools, --allowed-tools   allowlist tools
 *   --append-system-prompt <prompt>   append to the default system prompt
 *   --bare                            minimal mode: skip hooks, LSP, plugin sync,
 *                                     auto-memory, CLAUDE.md auto-discovery.
 *                                     STRICTLY auth via ANTHROPIC_API_KEY.
 *   --setting-sources <user,project,local>   which settings files to load
 *   --max-turns <n>                   (listed as -n/--name separately; turn cap
 *                                     is accepted in print mode — see UNVERIFIED)
 *
 * VERIFIED EVENT SHAPES (live run of
 *   claude -p --output-format stream-json --verbose --model haiku "Reply with exactly: OK" < /dev/null):
 *
 *   {"type":"system","subtype":"init","cwd":"...","session_id":"fd8a7751-...",
 *    "tools":["Task","Bash","CronCreate",...],"model":"claude-haiku-4-5-20251001", ...}
 *   {"type":"system","subtype":"thinking_tokens","estimated_tokens":157,
 *    "estimated_tokens_delta":107,"session_id":"...","uuid":"..."}
 *   {"type":"system","subtype":"hook_started","hook_id":"...","hook_name":"SessionStart:startup", ...}
 *   {"type":"system","subtype":"hook_response","hook_id":"...","output":"{...}", ...}
 *   {"type":"assistant","message":{"id":"msg_...","role":"assistant",
 *       "content":[{"type":"thinking","thinking":"...","signature":"..."} |
                   {"type":"text","text":"OK"} | {"type":"tool_use","id":"toolu_...",
                   "name":"Bash","input":{...}}],
 *       "model":"claude-haiku-4-5-20251001","usage":{...}},"session_id":"..."}
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_...",
 *       "content":"...","is_error":false}]},"session_id":"..."}     (documented; not in my run)
 *   {"type":"result","subtype":"success","duration_ms":...,"duration_api_ms":1609,
 *    "is_error":false,"result":"...","session_id":"...","total_cost_usd":0.03089125,
 *    "num_turns":1,"stop_reason":"end_turn",
 *    "usage":{"input_tokens":10,"cache_creation_input_tokens":24425,
 *             "cache_read_input_tokens":0,"output_tokens":70,
 *             "output_tokens_details":{"thinking_tokens":63}}}
 *   Exit code 0.
 *
 * NOTABLE AND IMPORTANT: hooks fire in headless mode. In my run a
 * SessionStart hook from this machine's Claude config ran and injected company
 * knowledge into the run. That means a headless moderator can be steered by
 * whatever hooks happen to be configured. For the prober/moderator role we
 * default to --setting-sources user (so personal hooks still apply) but keep the
 * knob, and `--bare` is available via SpawnSpec.env for callers who need a
 * hermetic run. Documented in the README — this is a real reproducibility trap.
 *
 * TIMEOUT: claude has NO `--print-timeout` equivalent (agy has one, codex does
 * not). We therefore enforce the budget entirely ourselves, via
 * spawnWorker's SIGTERM->SIGKILL escalation. If you kill mid-run, there is no
 * result event and we correctly report 'cancelled'/'timeout', never 'success'.
 */

import {
  appendEventLog,
  binaryOnPath,
  createEventBus,
  newJobId,
  nowIso,
  num,
  obj,
  preview,
  spawnWorker,
  stderrTailOf,
  str,
  tryParseObject,
  truncate,
  writeArgv,
  writeResultFile,
  writeStateDir,
} from './ndjson.ts';
import type {
  ActivityRef,
  ActivityStatus,
  JobResult,
  JobStatus,
  Provider,
  ProviderEvent,
  SpawnSpec,
  TokenUsage,
  WorkerHandle,
} from './types.ts';
import type { ListModelsOptions, ModelCatalog, ModelInfo, SandboxInfo } from './types.ts';
import { DEFAULT_DISCOVERY_TIMEOUT_MS, configDir, errMessage, readTextSafe, runCapture } from './discovery.ts';
import type { RunFn } from './discovery.ts';
import path from 'node:path';
import { deniedText, noResultText, stderrClause, timedOutText } from './failure-text.ts';

export const CLAUDE_BINARY = process.env['AGENT_SMITH_CLAUDE_BIN'] ?? 'claude';

export type ClaudePermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'manual'
  | 'dontAsk'
  | 'plan';

/**
 * Build the exact argv for one claude worker.
 *
 * argv layout: `claude -p <flags> <prompt>`.
 *
 * The prompt is a TRAILING POSITIONAL (help shows `claude [options] [command] [prompt]`),
 * so a prompt beginning with "-" is safe. Combined with `-p`, this is the
 * documented headless invocation.
 */
/**
 * Sandbox/permission flags for claude. Shared by buildArgv and describeSandbox.
 *
 * unrestricted -> --dangerously-skip-permissions ("trusted in this directory").
 * restricted   -> --permission-mode dontAsk + --permission-prompts none. Claude
 *   cannot prompt in print mode, so anything not already allowed (by the user's
 *   settings allow rules or built-in read-only tools) is DENIED, not stalled.
 *   Denials are surfaced as status 'denied' in the JobResult (detected from
 *   tool_result text), so a restricted worker does not silently pass; but
 *   read-only is NOT enforced: user allow rules may still permit writes.
 */
/** Tools a read-only worker may use. Shell is limited to inspection commands. */
export const READ_ONLY_ALLOWED: readonly string[] = [
  'Read', 'Grep', 'Glob',
  ...['cat', 'head', 'tail', 'wc', 'xxd', 'od', 'ls', 'file', 'stat', 'rg', 'grep', 'diff',
    'git diff', 'git show', 'git log', 'git status', 'git blame'].map((c) => `Bash(${c}:*)`),
];
/** Tools a read-only worker may never use, even if user settings would allow them. */
export const READ_ONLY_DENIED: readonly string[] = ['Edit', 'Write', 'NotebookEdit'];

/**
 * Allow rule for the one file a read-only pipeline stage may write.
 *
 * Verified on claude 2.1.296 (dontAsk): `Write(<path>)` rules never match, in
 * `/abs`, `//abs` or glob form, so the write is denied. `Edit(//<abs path>)` is
 * the rule that matches, and it covers the Write tool for exactly that file;
 * `//` marks a filesystem-absolute path. A bare `Edit` deny does not shadow it.
 */
export function artifactWriteRule(artifactPath: string): string {
  return `Edit(/${path.resolve(artifactPath)})`;
}

export function sandboxPlan(spec: Pick<SpawnSpec, 'unrestricted' | 'readOnly' | 'artifactPath'>): SandboxInfo {
  if (spec.unrestricted) {
    return {
      sandbox: 'claude --dangerously-skip-permissions (unrestricted)',
      flags: ['--dangerously-skip-permissions'],
      readOnlyEnforced: false,
    };
  }
  const flags = ['--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
  if (spec.readOnly) {
    // Read-only modes get an explicit allowlist (so a reviewer can inspect bytes
    // and history instead of being denied) and an explicit write-tool denylist,
    // which is what makes read-only enforced rather than merely requested.
    // A stage's output artifact is its one permitted write: Write comes off the
    // denylist and only that file goes on the allowlist, so dontAsk still denies
    // every other write. Edit and NotebookEdit stay denied.
    const artifact = spec.artifactPath;
    const allowed = artifact === undefined ? READ_ONLY_ALLOWED : [...READ_ONLY_ALLOWED, artifactWriteRule(artifact)];
    const denied = artifact === undefined ? READ_ONLY_DENIED : READ_ONLY_DENIED.filter((t) => t !== 'Write');
    flags.push('--allowedTools', ...allowed, '--disallowedTools', ...denied);
    return {
      sandbox: artifact === undefined
        ? 'claude dontAsk + read-only allowlist (writes disallowed; shell limited to inspection commands)'
        : `claude dontAsk + read-only allowlist (writes disallowed except the output artifact ${path.resolve(artifact)}; shell limited to inspection commands)`,
      flags,
      readOnlyEnforced: true,
    };
  }
  return {
    sandbox: 'claude dontAsk (cannot prompt; non-allowed tools are denied and reported as denied)',
    flags,
    readOnlyEnforced: false,
  };
}

export function buildArgv(spec: SpawnSpec): string[] {
  const argv: string[] = ['-p'];

  // NDJSON on stdout. `stream-json` is what lets a moderator show its work.
  argv.push('--output-format', 'stream-json');

  // WHY --verbose IS NOT OPTIONAL HERE: with --print, the full event stream is
  // only emitted in verbose mode. Without it claude emits a single result
  // object and we lose every tool call. Verified in my live run, which I
  // passed --verbose to.
  argv.push('--verbose');

  // Without this, a subagent's text and thinking are dropped from our stream.
  // For a prober/moderator that is disqualifying: we would be judging a
  // subagent's work we cannot see. Documented and verified to exist.
  argv.push('--forward-subagent-text');

  if (spec.model !== undefined && spec.model !== '') {
    // Aliases ('sonnet', 'opus', 'fable') or full model names both work.
    argv.push('--model', spec.model);
  }

  if (spec.effort !== undefined && spec.effort !== '') {
    const supported = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (!supported.includes(spec.effort)) {
      throw new RangeError(`claude does not support effort '${spec.effort}'; expected one of ${supported.join(', ')}`);
    }
    argv.push('--effort', spec.effort);
  }

  const addDirs = spec.addDirs ?? [];
  if (addDirs.length > 0) {
    // --add-dir is VARIADIC ("--add-dir <directories...>"). Emitting the flag
    // once per directory would be wrong: the second occurrence's list would be
    // taken and the first silently dropped. So: one flag, all dirs after it.
    argv.push('--add-dir', ...addDirs);
  }

  // See sandboxPlan for the unrestricted / restricted (dontAsk) rationale.
  argv.push(...sandboxPlan(spec).flags);

  if (spec.conversation !== undefined && spec.conversation !== '') {
    // --session-id starts a new session with a chosen id. --resume is the CLI's
    // continuation path and preserves the prior conversation.
    argv.push('--resume', spec.conversation);
  }

  // Reproducibility knob. --setting-sources controls which settings files load.
  // Default here is 'user' so personal skills/hooks work; set
  // AGENT_SMITH_CLAUDE_SETTING_SOURCES='' to disable the flag entirely, or
  // AGENT_SMITH_CLAUDE_BARE=1 for --bare (no hooks, no CLAUDE.md, keychain
  // auth disabled). See the header for why this matters for a moderator.
  const bare = process.env['AGENT_SMITH_CLAUDE_BARE'] === '1';
  if (bare) {
    argv.push('--bare');
  } else {
    const sources = process.env['AGENT_SMITH_CLAUDE_SETTING_SOURCES'] ?? 'user';
    if (sources !== '') argv.push('--setting-sources', sources);
  }

  // Trailing positional prompt, last.
  argv.push(spec.prompt);
  return argv;
}

// ---------------------------------------------------------------------------
// Event translation
// ---------------------------------------------------------------------------

/**
 * Anthropic usage field names, verified from the live `result` event:
 *   input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
 *   output_tokens, output_tokens_details.thinking_tokens
 *
 * `cache_creation_input_tokens` maps to our `cacheWriteTokens` so the store can
 * sum cache writes across agy (which does not report them) and claude (which
 * does) without either provider needing to know about the other.
 */
function toTokenUsage(usage: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined;
  const out: TokenUsage = {};
  // Anthropic emits these as JSON NUMBERS, so num() is correct here — str()
  // would silently return undefined for every single field.
  const input = num(usage, 'input_tokens');
  const output = num(usage, 'output_tokens');
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  const details = obj(usage, 'output_tokens_details');
  const thinking = num(details, 'thinking_tokens');
  if (thinking !== undefined) out.thinkingTokens = thinking;
  const read = num(usage, 'cache_read_input_tokens');
  if (read !== undefined) out.cacheReadTokens = read;
  const write = num(usage, 'cache_creation_input_tokens');
  if (write !== undefined) out.cacheWriteTokens = write;
  // Anthropic does not send a total. Left undefined on purpose — core/ decides
  // the accounting policy; providers do not invent numbers.
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Is this a tool_result block reporting a permission refusal? */
export function isPermissionDenial(text: string | undefined): boolean {
  if (text === undefined) return false;
  const hay = text.toLowerCase();
  return (
    hay.includes('permission') &&
    (hay.includes('denied') || hay.includes('not allowed') || hay.includes('requested permissions'))
  );
}

interface ClaudeTranslator {
  onEvent(raw: Record<string, unknown>): ProviderEvent[];
  finalText: string;
  sessionId?: string;
  model?: string;
  sawResult: boolean;
  sawErrorResult: boolean;
  resultError?: string;
  cost?: number;
  numTurns?: number;
  usage?: TokenUsage;
  deniedTools: string[];
}

export function createClaudeTranslator(maxChars: number): ClaudeTranslator {
  const tx: ClaudeTranslator = {
    finalText: '',
    sawResult: false,
    sawErrorResult: false,
    deniedTools: [],
    onEvent: () => [],
  };
  /** tool_use_id -> stepIndex */
  const toolStep = new Map<string, number>();
  const deniedIds = new Set<string>();
  let step = 0;

  const recordDenial = (id: string): boolean => {
    if (deniedIds.has(id)) return false;
    deniedIds.add(id);
    tx.deniedTools.push(id);
    return true;
  };

  const denialActivity = (id: string, tool: string, at: string): ProviderEvent | undefined => {
    if (!recordDenial(id)) return undefined;
    const idx = toolStep.get(id) ?? step++;
    toolStep.set(id, idx);
    const activity: ActivityRef = { stepIndex: idx, tool, toolCallId: id, denied: true };
    return { kind: 'activity-end', at, activity, status: 'denied' };
  };

  tx.onEvent = (raw: Record<string, unknown>): ProviderEvent[] => {
    const out: ProviderEvent[] = [];
    const type = str(raw, 'type');
    const at = nowIso();

    const sessionId = str(raw, 'session_id');
    if (sessionId !== undefined) tx.sessionId = sessionId;

    // ---- system / init ------------------------------------------------------
    if (type === 'system') {
      const subtype = str(raw, 'subtype');
      if (subtype === 'permission_denied') {
        const toolUseId = str(raw, 'tool_use_id') ?? str(raw, 'id');
        const toolName = str(raw, 'tool_name') ?? str(raw, 'tool') ?? 'unknown';
        const key = toolUseId ?? `tool:${toolName}`;
        const evidence = denialActivity(key, toolName, at);
        if (evidence !== undefined) out.push(evidence);
        return out;
      }
      if (subtype === 'init') {
        const ev: ProviderEvent = { kind: 'started', at, raw };
        if (sessionId !== undefined) ev.conversationId = sessionId;
        const model = str(raw, 'model');
        if (model !== undefined) {
          ev.model = model;
          tx.model = model;
        }
        out.push(ev);
        return out;
      }
      if (subtype === 'thinking_tokens') {
        // Not text, but the only live signal that the model is thinking. Show
        // it as thinking text so the moderator pane feels alive instead of
        // frozen for 90 seconds.
        const est = raw['estimated_tokens'];
        out.push({
          kind: 'text',
          at,
          text: `thinking… ~${typeof est === 'number' ? est : '?'} tokens`,
          stream: 'thinking',
        });
        return out;
      }
      if (subtype === 'hook_started' || subtype === 'hook_response') {
        // Hooks genuinely run headless (verified — a SessionStart hook fired in
        // my run). An operator watching 16 workers should know they are there.
        out.push({
          kind: 'notice',
          at,
          level: 'info',
          message: `claude hook ${str(raw, 'hook_name') ?? subtype}`,
          raw,
        });
        return out;
      }
      // Other system subtypes (compact_boundary, etc.) are informational.
      out.push({ kind: 'notice', at, level: 'info', message: `claude system.${subtype ?? 'unknown'}`, raw });
      return out;
    }

    // ---- assistant messages --------------------------------------------------
    if (type === 'assistant') {
      const message = obj(raw, 'message');
      const content = Array.isArray(message?.['content']) ? (message['content'] as unknown[]) : [];

      const usage = toTokenUsage(obj(message, 'usage'));
      if (usage !== undefined) {
        tx.usage = usage;
        out.push({ kind: 'usage', at, usage });
      }

      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        const bType = str(b, 'type');

        if (bType === 'text') {
          const text = str(b, 'text');
          if (text !== undefined && text !== '') {
            // parent_tool_use_id present => this text came from a SUBAGENT
            // (forwarded by --forward-subagent-text). We must not fold it into
            // finalText: the top-level result is the moderator's own answer, and
            // a subagent's chatter in there would corrupt the moderated output.
            const parent = str(b, 'parent_tool_use_id');
            if (parent !== undefined) {
              out.push({
                kind: 'text',
                at,
                text: `[subagent] ${text}`,
                stream: 'assistant',
              });
            } else {
              tx.finalText += text;
              out.push({ kind: 'text', at, text, stream: 'assistant' });
            }
          }
          continue;
        }

        if (bType === 'thinking') {
          const thinking = str(b, 'thinking');
          if (thinking !== undefined && thinking !== '') {
            out.push({ kind: 'text', at, text: thinking, stream: 'thinking' });
          }
          continue;
        }

        if (bType === 'tool_use') {
          const toolUseId = str(b, 'id') ?? `toolu-${step}`;
          const toolName = str(b, 'name') ?? 'unknown';
          const idx = step++;
          toolStep.set(toolUseId, idx);
          const input = preview(b['input'], maxChars);
          const ref: ActivityRef = { stepIndex: idx, tool: toolName, toolCallId: toolUseId };
          if (input !== undefined) ref.input = input.text;
          if (input?.truncated === true) ref.truncated = true;
          out.push({ kind: 'activity-start', at, activity: ref });
          continue;
        }
      }
      return out;
    }

    // ---- user messages: tool_result blocks ----------------------------------
    if (type === 'user') {
      const message = obj(raw, 'message');
      const content = Array.isArray(message?.['content']) ? (message['content'] as unknown[]) : [];
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (str(b, 'type') !== 'tool_result') continue;

        const toolUseId = str(b, 'tool_use_id') ?? '';
        const idx = toolStep.get(toolUseId) ?? step++;
        if (toolUseId !== '') toolStep.set(toolUseId, idx);

        // tool_result.content is either a string or an array of content blocks.
        const rawContent = b['content'];
        const text = typeof rawContent === 'string' ? rawContent : preview(rawContent, maxChars)?.text;
        const isError = b['is_error'] === true;

        const denied = isError && isPermissionDenial(text);
        let status: ActivityStatus = 'done';
        if (denied) status = 'denied';
        else if (isError) status = 'error';

        const output = preview(text, maxChars);
        const ref: ActivityRef = { stepIndex: idx, tool: 'tool_result', toolCallId: toolUseId };
        if (output !== undefined) ref.output = output.text;
        if (output?.truncated === true) ref.truncated = true;
        if (denied) ref.denied = true;

        out.push({ kind: 'activity-end', at, activity: ref, status });
        if (denied) {
          const key = toolUseId !== '' ? toolUseId : `tool:${str(b, 'name') ?? 'unknown'}`;
          recordDenial(key);
        }
      }
      return out;
    }

    // ---- result --------------------------------------------------------------
    if (type === 'result') {
      tx.sawResult = true;
      const permissionDenials = Array.isArray(raw['permission_denials']) ? raw['permission_denials'] : [];
      for (const denial of permissionDenials) {
        if (denial === null || typeof denial !== 'object') continue;
        const d = denial as Record<string, unknown>;
        const toolName = str(d, 'tool_name') ?? str(d, 'tool') ?? 'unknown';
        const id = str(d, 'tool_use_id') ?? str(d, 'id') ?? `tool:${toolName}`;
        const evidence = denialActivity(id, toolName, at);
        if (evidence !== undefined) out.push(evidence);
      }
      const subtype = str(raw, 'subtype');
      const isError = raw['is_error'] === true || (subtype !== undefined && subtype !== 'success');
      if (isError) tx.sawErrorResult = true;
      // On success, `result` IS the answer (handled below), so it is only an
      // "error" when it came back on a non-success result event.
      const errText = str(raw, 'error') ?? (isError ? str(raw, 'result') : undefined);
      if (errText !== undefined) tx.resultError = errText;

      const usage = toTokenUsage(obj(raw, 'usage'));
      if (usage !== undefined) {
        tx.usage = usage;
        out.push({ kind: 'usage', at, usage });
      }
      const cost = raw['total_cost_usd'];
      if (typeof cost === 'number') tx.cost = cost;
      const turns = raw['num_turns'];
      if (typeof turns === 'number') tx.numTurns = turns;

      // The top-level `result` string is the authoritative final answer. Prefer
      // it over our concatenation of text blocks: if the run used
      // --forward-subagent-text, the concatenation includes subagent chatter we
      // deliberately excluded, but if claude compressed or re-emitted text the
      // `result` field is still correct.
      const finalAnswer = str(raw, 'result');
      if (finalAnswer !== undefined && finalAnswer !== '') tx.finalText = finalAnswer;
      return out;
    }

    if (type === 'error') {
      tx.sawErrorResult = true;
      out.push({
        kind: 'notice',
        at,
        level: 'error',
        message: str(obj(raw, 'error'), 'message') ?? str(raw, 'message') ?? 'claude error',
        raw,
      });
      return out;
    }

    return out;
  };

  return tx;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  killReason: 'cancelled' | 'timeout' | undefined;
  stderr: string;
}

export function buildResult(args: {
  jobId: string;
  startedAtMs: number;
  stateDir: string;
  exit: ExitInfo;
  tx: ClaudeTranslator;
}): JobResult {
  const { jobId, startedAtMs, stateDir, exit, tx } = args;
  const finishedAt = nowIso();
  const durationMs = Date.now() - startedAtMs;

  let status: JobStatus;
  let error: string | undefined;

  if (exit.killReason === 'cancelled') {
    status = 'cancelled';
    error = 'canceled';
  } else if (exit.killReason === 'timeout') {
    status = 'timeout';
    // NOTE: claude has no --print-timeout. This kill is entirely ours, which is
    // why we must never infer success from "it produced a lot of output".
    error = timedOutText(durationMs);
  } else if (tx.deniedTools.length > 0 && !(tx.sawResult && !tx.sawErrorResult && exit.code === 0 && tx.finalText.trim() !== '')) {
    // Same discipline as agy. A moderator whose tools were denied has not
    // moderated anything, and claude may still report subtype "success".
    status = 'denied';
    error = deniedText(tx.deniedTools, exit.stderr);
  } else if (!tx.sawResult) {
    // No result event: killed early, crashed, or a CLI output change.
    status = exit.code === 0 ? 'malformed' : 'error';
    error = noResultText(exit);
  } else if (tx.sawErrorResult) {
    status = 'error';
    error = tx.resultError ?? 'worker error';
  } else if (exit.code !== 0) {
    status = 'error';
    error = `exited ${exit.code}${stderrClause(exit.stderr)}`;
  } else {
    status = 'success';
  }

  const out: JobResult = {
    jobId,
    provider: 'claude',
    ok: status === 'success',
    status,
    exitCode: exit.code,
    signal: exit.signal,
    response: tx.finalText,
    durationMs,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt,
    stateDir,
  };
  if (error !== undefined) out.error = error;
  // A report was delivered despite denied calls: the job succeeded, but the
  // orchestrator must know some checks did not run (normalize.ts turns this
  // into a warning).
  if (tx.deniedTools.length > 0) {
    out.deniedActions = tx.deniedTools.map((id) => ({ action: 'tool', displayName: id, nonfatal: true }));
  }
  if (tx.usage !== undefined) out.usage = tx.usage;
  const raw: Record<string, unknown> = {};
  if (tx.sessionId !== undefined) raw['sessionId'] = tx.sessionId;
  if (tx.model !== undefined) raw['model'] = tx.model;
  if (tx.cost !== undefined) raw['totalCostUsd'] = tx.cost;
  if (tx.numTurns !== undefined) raw['numTurns'] = tx.numTurns;
  if (Object.keys(raw).length > 0) out.raw = raw;
  return out;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Aliases documented by `claude --help`. */
export const CLAUDE_ALIASES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Claude config dir: AGENT_SMITH_CLAUDE_HOME, CLAUDE_CONFIG_DIR, then ~/.claude. */
export function claudeHome(): string {
  return configDir(['AGENT_SMITH_CLAUDE_HOME', 'CLAUDE_CONFIG_DIR'], '.claude');
}

/** Static alias catalog; default model from <home>/settings.json top-level `model`. Never throws. */
export async function listClaudeModels(_options?: ListModelsOptions, home: string = claudeHome()): Promise<ModelCatalog> {
  const cat: ModelCatalog = {
    provider: 'claude',
    models: CLAUDE_ALIASES.map((a) => ({ id: a.id, label: a.label, efforts: [...CLAUDE_EFFORTS] })),
    defaultSource: 'unknown',
    source: 'static',
    stale: false,
    verified: true,
  };
  try {
    const text = readTextSafe(path.join(home, 'settings.json'));
    if (text !== undefined) {
      const model = (JSON.parse(text) as { model?: unknown } | null)?.model;
      if (typeof model === 'string' && model !== '') {
        cat.defaultModel = model;
        cat.defaultSource = 'harness-config';
      }
    }
  } catch (e) {
    cat.error = `could not parse settings.json: ${errMessage(e)}`;
  }
  return cat;
}

/** Default model from <home>/settings.json. Sync file read only; never throws. */
export function claudeHarnessDefaults(home: string = claudeHome()): { model?: string; effort?: string } {
  try {
    const text = readTextSafe(path.join(home, 'settings.json'));
    const model = text === undefined ? undefined : (JSON.parse(text) as { model?: unknown } | null)?.model;
    return typeof model === 'string' && model !== '' ? { model } : {};
  } catch {
    return {};
  }
}

export const claudeProvider: Provider = {
  harnessDefaults: () => claudeHarnessDefaults(),
  name: 'claude',

  async available(): Promise<boolean> {
    try {
      return await binaryOnPath(CLAUDE_BINARY);
    } catch {
      return false;
    }
  },

  describeSandbox: (spec) => sandboxPlan(spec),

  listModels: (options) => listClaudeModels(options),

  async spawn(spec: SpawnSpec): Promise<WorkerHandle> {
    const jobId = spec.jobId ?? newJobId();
    const stateDir = writeStateDir('claude', jobId, spec.stateDir);
    const argv = buildArgv(spec);
    writeArgv(stateDir, argv, spec.cwd);

    const maxChars = spec.maxOutputChars ?? 2000;
    const bus = createEventBus();
    const tx = createClaudeTranslator(maxChars);

    const publish = (events: ProviderEvent[]): void => {
      for (const e of events) {
        bus.emit(e);
        appendEventLog(stateDir, e);
      }
    };

    const startedAtMs = Date.now();

    const proc = await spawnWorker({
      provider: 'claude',
      binary: CLAUDE_BINARY,
      argv,
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
      stateDir,
      jobId,
      mode: spec.mode,
      ...(spec.env !== undefined ? { env: spec.env } : {}),
      onStdoutLine(line) {
        const raw = tryParseObject(line);
        if (raw === undefined) {
          bus.emit({
            kind: 'notice',
            at: nowIso(),
            level: 'warn',
            message: `claude stdout (non-JSON): ${truncate(line, 400).text}`,
          });
          return;
        }
        publish(tx.onEvent(raw));
      },
      onStderr(chunk) {
        const text = chunk.trim();
        if (text === '') return;
        bus.emit({ kind: 'notice', at: nowIso(), level: 'info', message: truncate(text, 800).text });
      },
    });

    let resolveResult: (r: JobResult) => void = () => {};
    const resultPromise = new Promise<JobResult>((resolve) => {
      resolveResult = resolve;
    });

    void proc.exited.then(({ code, signal }) => {
      proc.closeLog();
      const final = buildResult({
        jobId,
        startedAtMs,
        stateDir,
        tx,
        exit: { code, signal, killReason: proc.killReason, stderr: stderrTailOf(proc) },
      });
      bus.close();
      writeResultFile(stateDir, final);
      resolveResult(final);
    });

    return {
      id: jobId,
      stateDir,
      cancel: () => proc.terminate('cancelled'),
      waitForResult: () => resultPromise,
      onEvent: (listener) => bus.onEvent(listener),
      events: bus.events,
    };
  },
};

export const claude = claudeProvider;
