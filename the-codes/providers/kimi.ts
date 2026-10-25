/**
 * providers/kimi.ts — Kimi Code CLI adapter (`kimi -p`).
 *
 * ============================================================================
 * VERIFICATION LEVEL: HIGH. LIVE-VERIFIED ON 2.1.1 (fresh turn + resume),
 * SOURCE-VERIFIED FOR FLAGS AND STREAM-JSON.
 * ============================================================================
 *
 * The CLI surface and the stream-json schema below were read from the upstream
 * repository (MoonshotAI/kimi-code, main, 2026-10), then exercised against the
 * installed binary:
 *
 *   apps/kimi-code/src/cli/commands.ts        option definitions
 *   apps/kimi-code/src/cli/options.ts         prompt-mode conflicts
 *   apps/kimi-code/src/cli/prompt-render.ts   the stream-json writer
 *   apps/kimi-code/src/cli/v2/run-v2-print.ts print-mode runner
 *
 * LIVE TRANSCRIPT (2026-10-24, kimi 2.1.1):
 *   $ kimi --output-format stream-json -p 'Reply with exactly: OK'
 *   {"role":"assistant","content":"OK"}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_...",
 *    "command":"kimi -r session_...","content":"To resume this session: ..."}
 *   -> success, 7.9 s, response "OK", session id captured.
 *   A second run with `--session session_...` and the SAME cwd returned
 *   "RESUMED" in 6.2 s and kept the id.
 *   A third run asked for `printf hello > proof.txt` via Bash: one activity
 *   step carried tool "Bash" (input and output), the file existed afterwards,
 *   and the final response was "DONE" (6.8 s).
 *
 * RESUME REQUIRES THE ORIGINAL CWD. `kimi --session <id>` refuses a session
 * created under a different directory ("Session ... was created under a
 * different directory", exit 1). Agent Smith's resume_job defaults to the
 * original job's cwd, so the normal path works; overriding cwd to a different
 * directory fails loudly with that message. `--continue` is never used: it is
 * cwd-ambiguous and would let parallel workers collide.
 *
 * NO IN-FLIGHT TOOL DISPLAY. The writer buffers assistant text and tool calls
 * and flushes them when the step ends or the tool result arrives, so the band
 * learns about a tool call at completion, not while it runs. A long Bash call
 * is therefore a silent gap. This is a stream-json limitation, not a parser
 * choice.
 *
 * Still source-verified rather than live-exercised: retry meta and `--add-dir`.
 *
 * ----------------------------------------------------------------------------
 * VERIFIED CLI SURFACE
 * ----------------------------------------------------------------------------
 *   kimi -p <prompt> --output-format stream-json
 *     -p, --prompt <prompt>          run one prompt, non-interactively
 *     --output-format <format>       "text" (default) or "stream-json"
 *     -m, --model <model>            model ALIAS from config.toml [models]
 *     -S, --session [id]             resume an existing session by id
 *     -c, --continue                 continue the most recent session for cwd
 *     --add-dir <dir>                extra workspace dir; may be repeated
 *     -y, --yolo / --auto / --plan   interactive permission modes
 *
 * `--session` takes an OPTIONAL value, so the adapter emits the attached
 * `--session=<id>` form: with a space, an id beginning with "-" would be parsed
 * as another option. An id beginning with "-" is rejected before spawn too.
 *
 * CONFLICT: `-p` cannot be combined with `--yolo` (options.ts throws). `--auto`
 * is pointless here because print mode force-sets the auto policy anyway (see
 * below). `-c` is cwd-ambiguous: with several workers in one repository it can
 * resume another worker's session, so this adapter never emits it. Resume uses
 * `--session=<id>` only.
 *
 * ----------------------------------------------------------------------------
 * PERMISSIONS: PRINT MODE IS ALWAYS UNRESTRICTED
 * ----------------------------------------------------------------------------
 * run-v2-print.ts calls forceAuto(agent), which sets the session's permission
 * mode to "auto" before the turn. There is no flag to restrict print mode, no
 * approval prompt, and `--yolo` is rejected with `-p`. Static deny rules from
 * config.toml still apply, but Agent Smith cannot turn them on per run.
 *
 * Consequences, stated plainly:
 *   - `unrestricted` has no effect. spawn_job defaults it to true for kimi
 *     (forge/service.ts) and the ack's sandbox string reports the real posture.
 *   - `readOnly` is not enforceable. describeSandbox reports
 *     readOnlyEnforced:false so a review mode is never silently trusted.
 *   - A job cannot end "denied" from a policy prompt. A config deny rule shows
 *     up as tool output, not as a structured denial, so it is not reclassified;
 *     acceptance checks are the reliable detector for that case.
 *
 * ----------------------------------------------------------------------------
 * EFFORT: NO PER-RUN FLAG
 * ----------------------------------------------------------------------------
 * `kimi` has no --effort. Thinking effort comes from `[thinking].effort` or a
 * model alias's `default_effort` in config.toml. SpawnSpec.effort is therefore
 * ignored: forge/service.ts drops it before recording job.json and adds an ack
 * warning, and the adapter also emits a warning event for direct callers.
 * buildArgv never emits a flag the CLI does not have. listModels() reports
 * efforts:[] for the same reason: advertising efforts would invite a request we
 * cannot honor.
 *
 * ----------------------------------------------------------------------------
 * STREAM-JSON SCHEMA (from prompt-render.ts)
 * ----------------------------------------------------------------------------
 * One JSON object per stdout line, in this vocabulary:
 *
 *   {"role":"meta","type":"system.version","version":"..."}
 *   {"role":"assistant","content":"...","tool_calls":[
 *      {"type":"function","id":"...","function":{"name":"Bash","arguments":"{...}"}}]}
 *   {"role":"tool","tool_call_id":"...","content":"..."}
 *   {"role":"meta","type":"turn.step.retrying","failed_attempt":1,"next_attempt":2,
 *    "max_attempts":10,"delay_ms":...,"error_name":"...","error_message":"..."}
 *   {"role":"meta","type":"session.resume_hint","session_id":"...","command":"kimi -r ...","content":"..."}
 *
 * Assistant text and its tool calls are flushed TOGETHER when the step ends or
 * a tool result arrives. Tool results are a separate line keyed by
 * tool_call_id. Thinking deltas are NOT emitted in JSON mode. Token usage is
 * NOT emitted by this writer; the adapter leaves usage absent rather than
 * fabricating it. The final line carries the session id, which is the only
 * resume handle available: `started` is emitted when it arrives, late in the
 * run, and the job's JobResult.raw.sessionId records it too.
 *
 * TOOL ERRORS: PromptJsonWriter.writeToolResult receives ToolResultEvent.output
 * but drops the sibling `isError` field. The content may still be a JSON object
 * with an isError/status field, so the translator looks for one defensively;
 * otherwise it marks the activity done. A failed shell command is visible in
 * the output text, not in a status bit we were given.
 *
 * EXIT CODE: print mode exits non-zero on failure, but a clean exit is still
 * only corroboration. No assistant text after a zero exit is `malformed`, not
 * an empty success.
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
  truncate,
  tryParseObject,
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
import {
  DEFAULT_DISCOVERY_TIMEOUT_MS,
  configDir,
  errMessage,
  parseTomlTopLevel,
  readTextSafe,
  runCapture,
} from './discovery.ts';
import type { RunFn } from './discovery.ts';
import { noResultText, stderrClause, timedOutText } from './failure-text.ts';
import path from 'node:path';

export const KIMI_BINARY = process.env['AGENT_SMITH_KIMI_BIN'] ?? 'kimi';

/** Kimi config dir: AGENT_SMITH_KIMI_HOME, then KIMI_CODE_HOME, then ~/.kimi-code. */
export function kimiHome(): string {
  return configDir(['AGENT_SMITH_KIMI_HOME', 'KIMI_CODE_HOME'], '.kimi-code');
}

/**
 * The posture print mode actually applies, in one line for the spawn ack.
 * `spec` is accepted to match the Provider contract; there is nothing in it
 * this CLI can honor. See the header.
 */
export function sandboxPlan(spec: Pick<SpawnSpec, 'unrestricted' | 'readOnly'>): SandboxInfo {
  void spec;
  return {
    sandbox: 'kimi print mode: auto permission policy (no approval prompts; config deny rules still apply)',
    flags: [],
    readOnlyEnforced: false,
  };
}

/**
 * Build the exact argv for one Kimi worker.
 *
 * Flags first, prompt last. `-p` takes a value, so a prompt starting with "-"
 * is consumed as that value rather than parsed as an option.
 *
 * NOT EMITTED, deliberately:
 *   --effort    does not exist; effort lives in config.toml.
 *   --continue  cwd-ambiguous and unsafe with parallel workers.
 *   --yolo      rejected in prompt mode.
 *   --auto      redundant: print mode forces auto.
 */
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

// ---------------------------------------------------------------------------
// Defensive extraction
// ---------------------------------------------------------------------------

/** Normalize an OpenAI-shaped usage object, if a future version emits one. */
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

/** Render a tool-result value as text without dropping a non-string payload. */
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
  /** All assistant text, step by step, in stream order. */
  finalText: string;
  sawError: boolean;
  error?: string;
  usage?: TokenUsage;
  sessionId?: string;
  /** Completed tool steps. Used to explain a zero-exit run with no text. */
  completedTools: number;
  unrecognised: Set<string>;
}

/**
 * Build the translator. Every line is handled by role because that is the
 * writer's actual discriminator; `type` is only read inside meta lines. A shape
 * this parser does not recognise becomes a notice with its payload preserved,
 * never a silent drop.
 */
export function createKimiTranslator(maxChars: number): KimiTranslator {
  const tx: KimiTranslator = {
    finalText: '',
    sawError: false,
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

  tx.onEvent = (raw: Record<string, unknown>): ProviderEvent[] => {
    const out: ProviderEvent[] = [];
    const at = nowIso();
    const role = str(raw, 'role');
    const type = str(raw, 'type') ?? '';

    // ---- session id: the resume handle arrives on the final meta line -------
    // It is accepted ONLY there. Any other line carrying a session_id is a
    // shape the writer does not produce; letting it overwrite the handle would
    // make a resume point at an id the CLI never issued.

    // ---- usage, if a future writer adds it --------------------------------
    const usage = toTokenUsage(obj(raw, 'usage') ?? obj(raw, 'tokens') ?? {});
    if (usage !== undefined) {
      tx.usage = usage;
      out.push({ kind: 'usage', at, usage });
    }

    // ---- meta lines -------------------------------------------------------
    if (role === 'meta') {
      if (type === 'system.version') {
        // Version banner. Known, carries nothing a consumer acts on.
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
        // A retry that eventually succeeds is not a failed job, so this is a
        // warning, not sawError.
        out.push({ kind: 'notice', at, level: 'warn', message: `kimi ${name}${attempt}${retrying}: ${message}`.trim(), raw });
        return out;
      }
      if (type === 'error') {
        tx.sawError = true;
        tx.error = str(obj(raw, 'error'), 'message') ?? str(raw, 'message') ?? str(raw, 'error_message') ?? 'kimi error';
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

    // ---- assistant message: text plus the tool calls it invoked -----------
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
              } catch {
                // Keep the raw string; preview() renders it without inventing structure.
              }
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

    // ---- tool result: closes the matching call ----------------------------
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
      // The writer uses stringifyToolOutput(), but a future/hostile shape may
      // hand us an object. Coercing it keeps the payload and its error flag.
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
      // A result before its call must not be re-opened by the late call line.
      started.add(id);
      ended.add(id);
      tx.completedTools += 1;
      out.push({ kind: 'activity-end', at, activity: ref, status });
      return out;
    }

    // ---- top-level error shape (defensive; the current writer never emits) -
    if (type === 'error' || obj(raw, 'error') !== undefined) {
      tx.sawError = true;
      tx.error = str(obj(raw, 'error'), 'message') ?? str(raw, 'message') ?? 'kimi error';
      out.push({ kind: 'notice', at, level: 'error', message: tx.error, raw });
      return out;
    }

    // ---- fallthrough: never drop data -------------------------------------
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
  /** Set when spawnWorker reports that the binary could not be started. */
  spawnError?: string;
}

export function buildResult(args: {
  jobId: string;
  startedAtMs: number;
  stateDir: string;
  exit: ExitInfo;
  tx: KimiTranslator;
}): JobResult {
  const { jobId, startedAtMs, stateDir, exit, tx } = args;
  const finishedAt = nowIso();
  const durationMs = Date.now() - startedAtMs;
  const unrecognised = tx.unrecognised.size > 0
    ? ` · unrecognised lines: ${[...tx.unrecognised].join(', ')}`
    : '';

  let status: JobStatus;
  let error: string | undefined;
  if (exit.killReason === 'cancelled') {
    status = 'cancelled';
    error = 'canceled';
  } else if (exit.killReason === 'timeout') {
    status = 'timeout';
    error = timedOutText(durationMs);
  } else if (tx.sawError) {
    status = 'error';
    error = `${tx.error ?? 'worker error'}${unrecognised}${stderrClause(exit.stderr)}`;
  } else if (exit.spawnError !== undefined) {
    // spawnWorker reports ENOENT/bad-cwd through onStderr and resolves with a
    // null exit code. Without this branch the operator sees "exited null".
    status = 'spawn-failed';
    error = `${exit.spawnError}${unrecognised}`;
  } else if (exit.code !== 0) {
    status = 'error';
    error = exit.code === null
      ? `${noResultText({ code: exit.code, signal: exit.signal, stderr: '' })}${unrecognised}${stderrClause(exit.stderr)}`
      : `exited ${exit.code}${unrecognised}${stderrClause(exit.stderr)}`;
  } else if (tx.finalText.trim() === '') {
    // Zero exit and no assistant text. With a source-verified parser this is
    // more likely an account/network failure or a silent policy denial than an
    // empty model reply, and neither is a success. A completed tool step is
    // still worth naming, because it explains where the turn went.
    const tools = tx.completedTools > 0 ? ` · ${tx.completedTools} tool step(s) completed` : '';
    status = 'malformed';
    error = `no output${unrecognised}${tools}${stderrClause(exit.stderr)}`;
  } else {
    status = 'success';
  }

  const out: JobResult = {
    jobId,
    provider: 'kimi',
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
  if (tx.usage !== undefined) out.usage = tx.usage;
  const raw: Record<string, unknown> = {};
  if (tx.sessionId !== undefined) raw['sessionId'] = tx.sessionId;
  if (tx.unrecognised.size > 0) raw['unrecognisedLines'] = [...tx.unrecognised];
  if (Object.keys(raw).length > 0) out.raw = raw;
  return out;
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/**
 * Parse `kimi provider list --json`.
 *
 * Shape (sub/provider.ts + config-manifest.toml):
 *   { providers: { <id>: {...} }, models: { <alias>: {
 *       provider, model, display_name?, support_efforts?, default_effort?, overrides? } } }
 *
 * The key is the alias `-m` accepts. Live 2.1.1 output uses camelCase keys
 * (`supportEfforts`, `defaultEffort`, `displayName`) even though config.toml is
 * snake_case, so both spellings are accepted. `overrides` wins over the
 * top-level field, matching the CLI's own precedence. Efforts are reported as
 * [] because print mode has no per-run effort flag; see the header.
 */
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

/** Lazy, never throws. Live-verified on 2.1.1. */
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
    const r = await run(KIMI_BINARY, ['provider', 'list', '--json'], options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
    const models = r.error === undefined ? parseKimiModels(r.stdout) : undefined;
    if (models !== undefined && models.length > 0) cat.models = models;
    else cat.error = r.error ?? '`kimi provider list --json` returned no models';

    // The top-level default_model is not part of `provider list --json`; it is
    // read from the same config file the CLI reads.
    const cfg = readTextSafe(path.join(home, 'config.toml'));
    if (cfg !== undefined) {
      const model = parseTomlTopLevel(cfg)['default_model'];
      if (model !== undefined && model !== '') {
        cat.defaultModel = model;
        cat.defaultSource = 'harness-config';
      }
    }
  } catch (e) {
    cat.error = errMessage(e);
  }
  return cat;
}

/** Default model from <home>/config.toml top-level `default_model`. Sync, no CLI, never throws. */
export function kimiHarnessDefaults(home: string = kimiHome()): { model?: string; effort?: string } {
  const text = readTextSafe(path.join(home, 'config.toml'));
  if (text === undefined) return {};
  const model = parseTomlTopLevel(text)['default_model'];
  return model !== undefined && model !== '' ? { model } : {};
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const kimiProvider: Provider = {
  name: 'kimi',
  // Print mode has no --effort; effort lives in config.toml. The service must
  // not record a request it cannot apply.
  supportsEffort: false,

  harnessDefaults: () => kimiHarnessDefaults(),

  async available(): Promise<boolean> {
    try {
      return await binaryOnPath(KIMI_BINARY);
    } catch {
      return false;
    }
  },

  describeSandbox: (spec) => sandboxPlan(spec),

  listModels: (options) => listKimiModels(runCapture, options),

  async spawn(spec: SpawnSpec): Promise<WorkerHandle> {
    const jobId = spec.jobId ?? newJobId();
    const stateDir = writeStateDir('kimi', jobId, spec.stateDir);
    const argv = buildArgv(spec);
    writeArgv(stateDir, argv, spec.cwd);

    const maxChars = spec.maxOutputChars ?? 2000;
    const bus = createEventBus();
    const tx = createKimiTranslator(maxChars);

    const publish = (events: ProviderEvent[]): void => {
      for (const e of events) {
        bus.emit(e);
        appendEventLog(stateDir, e);
      }
    };

    if (spec.effort !== undefined && spec.effort !== '') {
      // Do not silently pretend the effort was applied. The CLI reads effort
      // from config.toml, not from a flag.
      publish([{
        kind: 'notice',
        at: nowIso(),
        level: 'warn',
        message: `kimi has no per-run effort flag; ignoring effort "${spec.effort}". ` +
          'Set [thinking].effort or a model alias default_effort in config.toml instead.',
      }]);
    }

    const startedAtMs = Date.now();
    let spawnError: string | undefined;

    const proc = await spawnWorker({
      provider: 'kimi',
      binary: KIMI_BINARY,
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
          // stream-json is one object per line; a banner or a future format
          // change must be visible rather than silently dropped. publish() also
          // puts it in events.jsonl, not only in the live bus.
          publish([{
            kind: 'notice',
            at: nowIso(),
            level: 'warn',
            message: `kimi stdout (non-JSON): ${truncate(line, 400).text}`,
          }]);
          return;
        }
        publish(tx.onEvent(raw));
      },
      onStderr(chunk) {
        const text = chunk.trim();
        if (text === '') return;
        if (text.startsWith('spawn error:')) spawnError = text;
        publish([{ kind: 'notice', at: nowIso(), level: 'info', message: truncate(text, 800).text }]);
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
        exit: { code, signal, killReason: proc.killReason, stderr: stderrTailOf(proc), ...(spawnError === undefined ? {} : { spawnError }) },
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

export const kimi = kimiProvider;
