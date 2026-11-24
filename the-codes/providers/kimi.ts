import {
  binaryAvailable,
  earlyVerdict,
  ErrorRecovery,
  jobResult,
  recoveredErrorNotice,
  nowIso,
  num,
  obj,
  preview,
  runNdjsonWorker,
  str,
  truncate,
  tryParseObject,
} from './ndjson.ts';
import type { ExitInfo } from './ndjson.ts';
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
import {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  configDir,
  errMessage,
  parseTomlTopLevel,
  readTextSafe,
  runCapture,
} from './discovery.ts';
import type { RunFn } from './discovery.ts';
import { noResultText, stderrClause } from './failure-text.ts';
import path from 'node:path';

export function kimiBinary(): string {
  return process.env['AGENT_SMITH_KIMI_BIN'] ?? 'kimi';
}

function kimiHome(): string {
  return configDir(['AGENT_SMITH_KIMI_HOME', 'KIMI_CODE_HOME'], '.kimi-code');
}

export function sandboxPlan(spec: Pick<SpawnSpec, 'unrestricted' | 'readOnly'>): SandboxInfo {
  void spec;
  return {
    sandbox: 'kimi print mode: auto permission policy (no approval prompts; config deny rules still apply)',
    flags: [],
    readOnlyEnforced: false,
  };
}

export function buildArgv(spec: SpawnSpec): string[] {
  const argv: string[] = ['--output-format', 'stream-json'];
  if (spec.model !== undefined && spec.model !== '') argv.push('--model', spec.model);
  if (spec.conversation !== undefined && spec.conversation !== '') {
    // --session takes an OPTIONAL value, so `--session <id>` with an id starting
    // with "-" would be parsed as another option. The attached `=` form binds it
    // as a value; reject the remaining hostile shape rather than relying on the
    // CLI's own guard.
    if (spec.conversation.startsWith('-')) {
      throw new Error(`kimi session id must not start with "-": ${spec.conversation}`);
    }
    // A fresh run gets an id from the final resume_hint line; resume requires an
    // existing session, and the CLI refuses one from a different cwd.
    argv.push(`--session=${spec.conversation}`);
  }
  for (const dir of spec.addDirs ?? []) argv.push('--add-dir', dir);
  argv.push('-p', spec.prompt);
  return argv;
}

function toTokenUsage(usage: Record<string, unknown>): TokenUsage | undefined {
  const pick = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = num(usage, k);
      if (v !== undefined && v >= 0) return v;
    }
    return undefined;
  };
  const out: TokenUsage = {};
  const input = pick('prompt_tokens', 'input_tokens', 'inputTokens', 'input');
  const output = pick('completion_tokens', 'output_tokens', 'outputTokens', 'output');
  const thinking = pick('reasoning_tokens', 'thinking_tokens', 'reasoningTokens');
  const cacheRead = pick('cached_tokens', 'cache_read_input_tokens', 'cacheReadTokens');
  const total = pick('total_tokens', 'totalTokens');
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (thinking !== undefined) out.thinkingTokens = thinking;
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead;
  if (total !== undefined) out.totalTokens = total;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Did a serialized tool result carry an explicit error marker?
 *
 * The stream writer drops ToolResultEvent.isError, but the `output` value is
 * passed through stringifyToolOutput(), so a structured result may still carry
 * its own flag. Only explicit fields count; prose containing the word "error"
 * is not evidence.
 */
function toolOutputIsError(content: string): boolean {
  const parsed = tryParseObject(content);
  if (parsed === undefined) return false;
  if (parsed['isError'] === true || parsed['is_error'] === true) return true;
  const status = str(parsed, 'status');
  if (status !== undefined && status.toLowerCase() === 'error') return true;
  return parsed['error'] !== undefined && parsed['error'] !== null && parsed['error'] !== false;
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

export interface KimiTranslator {
  onEvent(raw: Record<string, unknown>): ProviderEvent[];
  finalText: string;
  sawError: boolean;
  recovery: ErrorRecovery;
  error?: string;
  usage?: TokenUsage;
  sessionId?: string;
  completedTools: number;
  unrecognised: Set<string>;
}

export function createKimiTranslator(maxChars: number): KimiTranslator {
  const tx: KimiTranslator = {
    finalText: '',
    sawError: false,
    recovery: new ErrorRecovery(),
    completedTools: 0,
    unrecognised: new Set<string>(),
    onEvent: () => [],
  };
  let step = 0;
  const toolSteps = new Map<string, number>();
  const toolNames = new Map<string, string>();
  const started = new Set<string>();
  const ended = new Set<string>();

  const stepFor = (id: string): number => {
    const known = toolSteps.get(id);
    if (known !== undefined) return known;
    const idx = step++;
    toolSteps.set(id, idx);
    return idx;
  };

  const translate = (raw: Record<string, unknown>): ProviderEvent[] => {
    const out: ProviderEvent[] = [];
    const at = nowIso();
    const role = str(raw, 'role');
    const type = str(raw, 'type') ?? '';

    const usage = toTokenUsage(obj(raw, 'usage') ?? obj(raw, 'tokens') ?? {});
    if (usage !== undefined) {
      tx.usage = usage;
      out.push({ kind: 'usage', at, usage });
    }

    if (role === 'meta') {
      if (type === 'system.version') {
        return out;
      }
      if (type === 'session.resume_hint') {
        const id = str(raw, 'session_id') ?? str(raw, 'sessionId');
        if (id === undefined || id === '') {
          out.push({ kind: 'notice', at, level: 'warn', message: 'kimi resume hint without a session_id', raw });
        } else if (tx.sessionId === undefined) {
          tx.sessionId = id;
          out.push({ kind: 'started', at, conversationId: id, raw });
        } else if (tx.sessionId !== id) {
          out.push({
            kind: 'notice',
            at,
            level: 'warn',
            message: `kimi resume hint changed the session id from ${tx.sessionId} to ${id}; keeping the first`,
            raw,
          });
        }
        return out;
      }
      if (type === 'turn.step.retrying') {
        const failed = num(raw, 'failed_attempt');
        const next = num(raw, 'next_attempt');
        const max = num(raw, 'max_attempts');
        const name = str(raw, 'error_name') ?? 'error';
        const message = str(raw, 'error_message') ?? '';
        const attempt = failed !== undefined && max !== undefined ? ` (attempt ${failed} of ${max})` : '';
        const retrying = next !== undefined ? `; retrying as ${next}` : '';
        out.push({ kind: 'notice', at, level: 'warn', message: `kimi ${name}${attempt}${retrying}: ${message}`.trim(), raw });
        return out;
      }
      if (type === 'error') {
        tx.sawError = true;
        tx.error = str(obj(raw, 'error'), 'message') ?? str(raw, 'message') ?? str(raw, 'error_message') ?? 'kimi error';
        tx.recovery.noteError('a worker error', tx.error, at);
        out.push({ kind: 'notice', at, level: 'error', message: tx.error, raw });
        return out;
      }
      const label = type === '' ? 'unknown' : type;
      tx.unrecognised.add(`meta:${label}`);
      out.push({
        kind: 'notice',
        at,
        level: 'info',
        message: `kimi emitted unrecognised meta line "${label}" (payload preserved in events.jsonl)`,
        raw,
      });
      return out;
    }

    if (role === 'assistant') {
      const content = str(raw, 'content');
      if (content !== undefined && content !== '') {
        if (tx.finalText !== '') tx.finalText += '\n';
        tx.finalText += content;
        out.push({ kind: 'text', at, text: content, stream: 'assistant' });
      }

      const calls = raw['tool_calls'];
      if (calls !== undefined) {
        if (!Array.isArray(calls)) {
          tx.unrecognised.add('assistant:tool_calls');
          out.push({
            kind: 'notice',
            at,
            level: 'warn',
            message: 'kimi assistant tool_calls was not an array (payload preserved in events.jsonl)',
            raw,
          });
        } else {
          for (const rawCall of calls) {
            if (rawCall === null || typeof rawCall !== 'object' || Array.isArray(rawCall)) continue;
            const call = rawCall as Record<string, unknown>;
            const fn = obj(call, 'function');
            const name = str(fn, 'name') ?? str(call, 'name') ?? 'tool';
            const id = str(call, 'id') ?? str(call, 'tool_call_id') ?? `call-${step}`;

            let args: unknown = fn?.['arguments'] ?? call['arguments'];
            if (typeof args === 'string') {
              try {
                args = JSON.parse(args) as unknown;
              } catch {}
            }
            const input = preview(args, maxChars);
            const idx = stepFor(id);
            toolNames.set(id, name);
            if (!started.has(id)) {
              started.add(id);
              const ref: ActivityRef = { stepIndex: idx, tool: name, toolCallId: id };
              if (input !== undefined) {
                ref.input = input.text;
                if (input.truncated) ref.truncated = true;
              }
              out.push({ kind: 'activity-start', at, activity: ref });
            }
          }
        }
      }
      return out;
    }

    if (role === 'tool') {
      const id = str(raw, 'tool_call_id') ?? str(raw, 'id') ?? `tool-${step}`;
      if (ended.has(id)) {
        out.push({
          kind: 'notice',
          at,
          level: 'info',
          message: `kimi repeated tool result for "${id}" (ignored)`,
          raw,
        });
        return out;
      }
      const content = contentText(raw['content']);
      const output = truncate(content, maxChars);
      const status: ActivityStatus = toolOutputIsError(content) ? 'error' : 'done';
      const ref: ActivityRef = {
        stepIndex: stepFor(id),
        tool: toolNames.get(id) ?? 'tool',
        toolCallId: id,
        output: output.text,
      };
      if (output.truncated) ref.truncated = true;
      started.add(id);
      ended.add(id);
      tx.completedTools += 1;
      out.push({ kind: 'activity-end', at, activity: ref, status });
      return out;
    }

    if (type === 'error' || obj(raw, 'error') !== undefined) {
      tx.sawError = true;
      tx.error = str(obj(raw, 'error'), 'message') ?? str(raw, 'message') ?? 'kimi error';
      tx.recovery.noteError('a worker error', tx.error, at);
      out.push({ kind: 'notice', at, level: 'error', message: tx.error, raw });
      return out;
    }

    const label = role ?? (type !== '' ? type : 'unknown');
    const key = role === undefined ? `type:${label}` : `role:${label}`;
    tx.unrecognised.add(key);
    out.push({
      kind: 'notice',
      at,
      level: 'info',
      message: `kimi emitted unrecognised line "${label}" (payload preserved in events.jsonl)`,
      raw,
    });
    return out;
  };

  tx.onEvent = (raw) => {
    const out = translate(raw);
    tx.recovery.observe(out);
    return out;
  };
  return tx;
}

export function buildResult(args: {
  jobId: string;
  startedAtMs: number;
  stateDir: string;
  exit: ExitInfo;
  tx: KimiTranslator;
}): JobResult {
  const { jobId, startedAtMs, stateDir, exit, tx } = args;
  const durationMs = Date.now() - startedAtMs;
  const unrecognised = tx.unrecognised.size > 0
    ? ` · unrecognised lines: ${[...tx.unrecognised].join(', ')}`
    : '';

  let status: JobStatus;
  let error: string | undefined;
  const recovered = tx.recovery.recovered(tx.finalText, exit.code);
  const early = earlyVerdict(exit, durationMs);
  if (early !== undefined) {
    ({ status, error } = early);
  } else if (tx.sawError && recovered === undefined) {
    status = 'error';
    error = `${tx.error ?? 'worker error'}${unrecognised}${stderrClause(exit.stderr)}`;
  } else if (exit.code !== 0 && recovered === undefined) {
    status = 'error';
    error = exit.code === null
      ? `${noResultText({ code: exit.code, signal: exit.signal, stderr: '' })}${unrecognised}${stderrClause(exit.stderr)}`
      : `exited ${exit.code}${unrecognised}${stderrClause(exit.stderr)}`;
  } else if (tx.finalText.trim() === '') {
    const tools = tx.completedTools > 0 ? ` · ${tx.completedTools} tool step(s) completed` : '';
    status = 'malformed';
    error = `no output${unrecognised}${tools}${stderrClause(exit.stderr)}`;
  } else {
    status = 'success';
  }

  const out = jobResult({ provider: 'kimi', jobId, status, error, exit, response: tx.finalText, startedAtMs, durationMs, stateDir });
  if (tx.usage !== undefined) out.usage = tx.usage;
  const raw: Record<string, unknown> = {};
  if (tx.sessionId !== undefined) raw['sessionId'] = tx.sessionId;
  if (tx.unrecognised.size > 0) raw['unrecognisedLines'] = [...tx.unrecognised];
  if (Object.keys(raw).length > 0) out.raw = raw;
  return out;
}

export function parseKimiModels(stdout: string): ModelInfo[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const models = (parsed as { models?: unknown }).models;
  if (models === null || typeof models !== 'object' || Array.isArray(models)) return undefined;

  const out: ModelInfo[] = [];
  for (const [alias, raw] of Object.entries(models as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const overrides = obj(entry, 'overrides') ?? {};
    const label =
      str(overrides, 'display_name') ??
      str(overrides, 'displayName') ??
      str(entry, 'display_name') ??
      str(entry, 'displayName') ??
      str(entry, 'model') ??
      alias;
    out.push({ id: alias, label, efforts: [] });
  }
  return out;
}

export async function listKimiModels(
  run: RunFn,
  options?: ListModelsOptions,
  home: string = kimiHome(),
): Promise<ModelCatalog> {
  const cat: ModelCatalog = {
    provider: 'kimi',
    models: [],
    defaultSource: 'unknown',
    source: 'live',
    stale: false,
    verified: true,
  };
  try {
    const r = await run(kimiBinary(), ['provider', 'list', '--json'], options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
    const models = r.error === undefined ? parseKimiModels(r.stdout) : undefined;
    if (models !== undefined && models.length > 0) cat.models = models;
    else cat.error = r.error ?? '`kimi provider list --json` returned no models';

    // The top-level default_model is not part of `provider list --json`; it is
    // read from the same config file the CLI reads.
    const { model } = kimiHarnessDefaults(home);
    if (model !== undefined) {
      cat.defaultModel = model;
      cat.defaultSource = 'harness-config';
    }
  } catch (e) {
    cat.error = errMessage(e);
  }
  return cat;
}

function kimiHarnessDefaults(home: string = kimiHome()): { model?: string; effort?: string } {
  const text = readTextSafe(path.join(home, 'config.toml'));
  if (text === undefined) return {};
  const model = parseTomlTopLevel(text)['default_model'];
  return model !== undefined && model !== '' ? { model } : {};
}

export const kimiProvider: Provider = {
  name: 'kimi',
  supportsEffort: false,

  harnessDefaults: () => kimiHarnessDefaults(),

  available: () => binaryAvailable(kimiBinary()),

  describeSandbox: sandboxPlan,

  listModels: (options) => listKimiModels(runCapture, options),

  spawn(spec: SpawnSpec): Promise<WorkerHandle> {
    const tx = createKimiTranslator(spec.maxOutputChars ?? 2000);
    return runNdjsonWorker({
      provider: 'kimi',
      binary: kimiBinary(),
      spec,
      buildArgv,
      translate: tx.onEvent,
      ...(spec.effort !== undefined && spec.effort !== '' ? { preamble: [{
        kind: 'notice' as const,
        at: nowIso(),
        level: 'warn' as const,
        message: `kimi has no per-run effort flag; ignoring effort "${spec.effort}". ` +
          'Set [thinking].effort or a model alias default_effort in config.toml instead.',
      }] } : {}),
      buildResult: (ctx) => buildResult({ ...ctx, tx }),
      afterResult(final) {
        const notice = recoveredErrorNotice(tx.recovery.recovered(tx.finalText, final.exitCode), final);
        return notice === undefined ? [] : [notice];
      },
    });
  },
};

