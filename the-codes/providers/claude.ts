import {
  binaryAvailable,
  earlyVerdict,
  jobResult,
  nowIso,
  num,
  obj,
  preview,
  runNdjsonWorker,
  str,
} from './ndjson.ts';
import type { ExitInfo, LiveInput } from './ndjson.ts';
import type { Writable } from 'node:stream';
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
import { deniedText, noResultText, stderrClause } from './failure-text.ts';

export function claudeBinary(): string {
  return process.env['AGENT_SMITH_CLAUDE_BIN'] ?? 'claude';
}

const READ_ONLY_ALLOWED: readonly string[] = [
  'Read', 'Grep', 'Glob',
  ...['cat', 'head', 'tail', 'wc', 'xxd', 'od', 'ls', 'file', 'stat', 'rg', 'grep', 'diff',
    'git diff', 'git show', 'git log', 'git status', 'git blame'].map((c) => `Bash(${c}:*)`),
];
const READ_ONLY_DENIED: readonly string[] = ['Edit', 'Write', 'NotebookEdit'];

/**
 * Allow rule for the one file a read-only pipeline stage may write.
 *
 * Verified on claude 2.1.296 (dontAsk): `Write(<path>)` rules never match, in
 * `/abs`, `//abs` or glob form, so the write is denied. `Edit(//<abs path>)` is
 * the rule that matches, and it covers the Write tool for exactly that file;
 * `//` marks a filesystem-absolute path. A bare `Edit` deny does not shadow it.
 */
function artifactWriteRule(artifactPath: string): string {
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

  // Live input (Provider.liveInput). Verified live on 2.1.331 through this
  // adapter (haiku, dontAsk, one send during a 6 s Bash call): a stdin user
  // message written while a tool runs does not interrupt it; it joins the SAME
  // turn at the next tool round (one result event), and --replay-user-messages
  // re-emits it on stdout at that moment, which is our proof it was read. In
  // this mode claude waits for more stdin after each result, so the adapter
  // ends stdin when the result arrives (ClaudeLiveInput.end); claude then
  // exited 0 within a second. The initial prompt's replay is swallowed.
  argv.push('--input-format', 'stream-json', '--replay-user-messages');

  argv.push('--output-format', 'stream-json');

  // WHY --verbose IS NOT OPTIONAL HERE: with --print, the full event stream is
  // only emitted in verbose mode. Without it claude emits a single result
  // object and we lose every tool call. Verified in my live run, which I
  // passed --verbose to.
  argv.push('--verbose');

  argv.push('--forward-subagent-text');

  if (spec.model !== undefined && spec.model !== '') {
    argv.push('--model', spec.model);
  }

  if (spec.effort !== undefined && spec.effort !== '') {
    if (!CLAUDE_EFFORTS.includes(spec.effort)) {
      throw new RangeError(`claude does not support effort '${spec.effort}'; expected one of ${CLAUDE_EFFORTS.join(', ')}`);
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

  argv.push(...sandboxPlan(spec).flags);

  if (spec.conversation !== undefined && spec.conversation !== '') {
    // --session-id starts a new session with a chosen id. --resume is the CLI's
    // continuation path and preserves the prior conversation.
    argv.push('--resume', spec.conversation);
  }

  const bare = process.env['AGENT_SMITH_CLAUDE_BARE'] === '1';
  if (bare) {
    argv.push('--bare');
  } else {
    const sources = process.env['AGENT_SMITH_CLAUDE_SETTING_SOURCES'] ?? 'user';
    if (sources !== '') argv.push('--setting-sources', sources);
  }

  return argv;
}

export function streamJsonUserMessage(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}

export class ClaudeLiveInput implements LiveInput {
  private stdin: Writable | null = null;
  private open = true;
  private readonly pending: { text: string; initial: boolean }[] = [];
  private readonly prompt: string;

  constructor(prompt: string) {
    this.prompt = prompt;
  }

  attach(stdin: Writable | null): void {
    this.stdin = stdin;
    if (stdin === null) {
      this.open = false;
      return;
    }
    // EPIPE when claude exits (or never started) must not crash the owner.
    stdin.on('error', () => { this.open = false; });
    this.write(this.prompt, true);
  }

  send(text: string): boolean {
    if (text.trim() === '') return false;
    return this.write(text, false);
  }

  end(): void {
    this.open = false;
    const s = this.stdin;
    if (s !== null && !s.destroyed && !s.writableEnded) s.end();
  }

  replayed(text: string): string | undefined {
    let i = this.pending.findIndex((p) => p.text === text);
    if (i < 0) i = this.pending.findIndex((p) => p.text.trim() === text.trim());
    if (i < 0) return undefined;
    const [hit] = this.pending.splice(i, 1);
    return hit === undefined || hit.initial ? undefined : hit.text;
  }

  unread(): string[] {
    return this.pending.filter((p) => !p.initial).map((p) => p.text);
  }

  private write(text: string, initial: boolean): boolean {
    const s = this.stdin;
    if (!this.open || s === null || s.destroyed || s.writableEnded) return false;
    this.pending.push({ text, initial });
    s.write(streamJsonUserMessage(text));
    return true;
  }
}

function userText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') return undefined;
    const b = block as Record<string, unknown>;
    if (str(b, 'type') !== 'text') return undefined;
    parts.push(str(b, 'text') ?? '');
  }
  return parts.join('\n');
}

function toTokenUsage(usage: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined;
  const out: TokenUsage = {};
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
  return Object.keys(out).length > 0 ? out : undefined;
}

function isPermissionDenial(text: string | undefined): boolean {
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

export function createClaudeTranslator(
  maxChars: number,
  input?: Pick<ClaudeLiveInput, 'replayed' | 'end'>,
): ClaudeTranslator {
  const tx: ClaudeTranslator = {
    finalText: '',
    sawResult: false,
    sawErrorResult: false,
    deniedTools: [],
    onEvent: () => [],
  };
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
        out.push({
          kind: 'notice',
          at,
          level: 'info',
          message: `claude hook ${str(raw, 'hook_name') ?? subtype}`,
          raw,
        });
        return out;
      }
      out.push({ kind: 'notice', at, level: 'info', message: `claude system.${subtype ?? 'unknown'}`, raw });
      return out;
    }

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

    if (type === 'user') {
      const message = obj(raw, 'message');
      // A replayed stdin message (--replay-user-messages): top level only, as a
      // forwarded subagent message carries parent_tool_use_id.
      const parentId = raw['parent_tool_use_id'];
      if (input !== undefined && (parentId === undefined || parentId === null)) {
        const text = userText(message?.['content']);
        const sent = text === undefined ? undefined : input.replayed(text);
        if (sent !== undefined) out.push({ kind: 'user-message', at, text: sent });
      }
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

    if (type === 'result') {
      tx.sawResult = true;
      // The turn is over: end stdin, or claude waits for another message forever.
      input?.end();
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

export function buildResult(args: {
  jobId: string;
  startedAtMs: number;
  stateDir: string;
  exit: ExitInfo;
  tx: ClaudeTranslator;
}): JobResult {
  const { jobId, startedAtMs, stateDir, exit, tx } = args;
  const durationMs = Date.now() - startedAtMs;

  let status: JobStatus;
  let error: string | undefined;

  const early = earlyVerdict(exit, durationMs);
  if (early !== undefined) {
    ({ status, error } = early);
  } else if (tx.deniedTools.length > 0 && !(tx.sawResult && !tx.sawErrorResult && exit.code === 0 && tx.finalText.trim() !== '')) {
    status = 'denied';
    error = deniedText(tx.deniedTools, exit.stderr);
  } else if (!tx.sawResult) {
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

  const out = jobResult({ provider: 'claude', jobId, status, error, exit, response: tx.finalText, startedAtMs, durationMs, stateDir });
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

const CLAUDE_ALIASES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function claudeHome(): string {
  return configDir(['AGENT_SMITH_CLAUDE_HOME', 'CLAUDE_CONFIG_DIR'], '.claude');
}

function readDefaultModel(home: string): string | undefined {
  const text = readTextSafe(path.join(home, 'settings.json'));
  const model = text === undefined ? undefined : (JSON.parse(text) as { model?: unknown } | null)?.model;
  return typeof model === 'string' && model !== '' ? model : undefined;
}

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
    const model = readDefaultModel(home);
    if (model !== undefined) {
      cat.defaultModel = model;
      cat.defaultSource = 'harness-config';
    }
  } catch (e) {
    cat.error = `could not parse settings.json: ${errMessage(e)}`;
  }
  return cat;
}

function claudeHarnessDefaults(home: string = claudeHome()): { model?: string; effort?: string } {
  try {
    const model = readDefaultModel(home);
    return model === undefined ? {} : { model };
  } catch {
    return {};
  }
}

export const claudeProvider: Provider = {
  harnessDefaults: () => claudeHarnessDefaults(),
  name: 'claude',

  available: () => binaryAvailable(claudeBinary()),

  describeSandbox: sandboxPlan,

  listModels: (options) => listClaudeModels(options),

  liveInput: true,

  spawn(spec: SpawnSpec): Promise<WorkerHandle> {
    const input = new ClaudeLiveInput(spec.prompt);
    const tx = createClaudeTranslator(spec.maxOutputChars ?? 2000, input);
    return runNdjsonWorker({
      provider: 'claude',
      binary: claudeBinary(),
      spec,
      input,
      buildArgv,
      translate: tx.onEvent,
      buildResult: (ctx) => buildResult({ ...ctx, tx }),
    });
  },
};
