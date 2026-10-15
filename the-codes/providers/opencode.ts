/**
 * providers/opencode.ts — OpenCode CLI adapter (`opencode run`).
 *
 * ============================================================================
 * VERIFICATION LEVEL: PARTIAL. READ THIS BEFORE TRUSTING THE EVENT PARSER.
 * ============================================================================
 *
 * VERIFIED (by running `opencode run --help` on v2.0.24 and by executing the
 * command twice on this machine):
 *
 *   opencode run [flags] [<message...>]
 *     --format choice     "Output format (choices: default, json)"  -> json
 *     --model, -m string  "Model to use in the format provider/model#variant"
 *     --agent string      "Agent to use"
 *     --auto              "Auto-approve permissions that are not explicitly denied"
 *     --session, -s       "Session ID to continue, or to create if it does not exist"
 *     --continue, -c      "Continue the last session"
 *     --fork              "Fork the session before continuing"
 *     --thinking          "Show thinking blocks"
 *     --standalone        "Run with a private server instead of the background service"
 *     --dir <path>        directory to run in  (docs; NOT in --help output)
 *     --variant <string>  provider-specific reasoning effort (docs; NOT in --help)
 *
 * AND one event shape, observed live:
 *   {"type":"error","timestamp":1791335768123,"sessionID":"ses_eec11658...",
 *    "error":{"type":"provider.quota","message":"Upstream request failed:
 *              Insufficient account funds","status":402,"response":{"body":"..."}}}
 *
 * ============================================================================
 * WHAT I COULD NOT VERIFY, AND WHAT I DID ABOUT IT
 * ============================================================================
 * I could not observe a SUCCESSFUL opencode run. Both attempts failed at the
 * provider layer with `provider.quota` (HTTP 402, "Insufficient account funds")
 * and `provider.no-route` ("Model unavailable"). That is an account problem, not
 * a flag problem: the flags above came from --help and the envelope shape above
 * came from real output. But it means:
 *
 *   *** The success-path event names below are UNVERIFIED. ***
 *
 * OpenCode's documented SSE event vocabulary (from opencode.ai/docs/server,
 * "Events") is namespaced, e.g. `message.part.updated`, `session.idle`,
 * `session.error`, `message.updated`. That is the SERVER bus, and `run
 * --format json` is documented only as "raw JSON events" — it very likely
 * emits the same bus events, but "very likely" is not verification.
 *
 * THEREFORE THE STRATEGY FOR THIS ADAPTER IS DEFENSIVE PARSING, NOT PRECISE
 * PARSING. Concretely:
 *
 *   1. Every line is emitted as a `notice` with its raw payload, so NOTHING is
 *      ever invisible. If the parser misses a shape, the operator still sees the
 *      data and the mod surface still has something to draw. This is the whole
 *      design: an adapter that silently drops events is worse than one that
 *      forwards everything.
 *   2. Text, tool calls and usage are extracted by CONTENT, not by event name:
 *      we look for a `text`/`content`/`delta` string anywhere in the payload, a
 *      `tool`/`toolName` string plus a state field, and a `tokens`/`usage`
 *      object. That works across plausible namings.
 *   3. Unknown event types get an explicit "unrecognised event type" notice
 *      naming the type, so the first run against a real account tells us exactly
 *      what to add. That is a feature, not an apology.
 *   4. We never guess SUCCESS. The final response is taken from whatever text
 *      the stream produced; if the stream ended with an `error` event or the
 *      exit code is non-zero, the job fails. Exit code alone is never enough to
 *      call it a success, for the same reason as agy.
 *
 * ALSO NOTE, and this is a real trap for anyone spawning this: `opencode run`
 * talks to a BACKGROUND SERVER by default. That means (a) it may pick up an
 * unrelated session's state, and (b) the process you spawn is not the process
 * doing the work. We pass `--standalone` so the run gets a private server and
 * the child's lifetime really is the job's lifetime — otherwise a cancel() does
 * nothing and a "finished" worker leaves a server running. `--standalone` is
 * documented but I could not confirm its runtime behaviour without a working
 * account; flagged in the README.
 *
 * MODEL IDs: `--model` takes `provider/model` and optionally `provider/model#variant`
 * ("variant (provider-specific reasoning effort)"). We do not guess how to
 * encode SpawnSpec.effort as a variant, so we pass it through verbatim when it
 * looks like a variant and otherwise append `#<effort>` only if the caller gave
 * an effort AND no `#` is already present. See buildArgv.
 */

import {
  appendEventLog,
  binaryOnPath,
  createEventBus,
  newJobId,
  num,
  nowIso,
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
import { DEFAULT_DISCOVERY_TIMEOUT_MS, errMessage, runCapture } from './discovery.ts';
import type { RunFn } from './discovery.ts';
import { deniedText, stderrClause, timedOutText } from './failure-text.ts';


export const OPENCODE_BINARY = process.env['AGENT_SMITH_OPENCODE_BIN'] ?? 'opencode';

/** Sandbox flags for opencode. Shared by buildArgv and describeSandbox. */
export function sandboxPlan(spec: Pick<SpawnSpec, 'unrestricted' | 'readOnly'>): SandboxInfo {
  if (spec.unrestricted) {
    return { sandbox: 'opencode --auto (approve all non-denied permissions)', flags: ['--auto'], readOnlyEnforced: false };
  }
  return {
    sandbox: "opencode default permissions (agent's configured rules; no CLI flag to restrict or enforce read-only)",
    flags: [],
    readOnlyEnforced: false,
  };
}

/**
 * Build the exact argv for one opencode worker.
 *
 * The message is a TRAILING POSITIONAL (`opencode run [flags] [<message>]`), so
 * a prompt starting with "-" is safe. `--` is not used because --help does not
 * document it for this subcommand and we do not invent flags.
 *
 * KNOWN GAP: there is no verified way to set opencode's sandbox from the CLI.
 * `--auto` approves "permissions that are not explicitly denied", which is the
 * documented auto-approve mechanism and our mapping for unrestricted:true. For
 * unrestricted:false we simply OMIT --auto and rely on the agent's configured
 * permissions, because the CLI gives us no flag to turn auto-approval off and
 * inventing one would be worse than being permissive by default here. The
 * README flags this as a real asymmetry with agy/codex/claude.
 */
export function buildArgv(spec: SpawnSpec): string[] {
  const argv: string[] = ['run'];

  // Private server so the child's lifetime is the job's lifetime.
  argv.push('--standalone');

  // Verified choice: "default" (formatted for humans) or "json" (raw events).
  argv.push('--format', 'json');

  if (spec.model !== undefined && spec.model !== '') {
    argv.push('--model', withEffortVariant(spec.model, spec.effort));
  } else if (spec.effort !== undefined && spec.effort !== '') {
    throw new Error('opencode effort requires an explicit provider/model so its variant can be applied');
  }

  argv.push(...sandboxPlan(spec).flags);

  // --session both continues an existing session and creates it if absent,
  // which is exactly the semantics SpawnSpec.conversation needs.
  if (spec.conversation !== undefined && spec.conversation !== '') {
    argv.push('--session', spec.conversation);
  }

  // addDirs: DELIBERATELY IGNORED.
  //
  // The v2 docs list a `--dir` flag, but it is NOT in `opencode run --help` on
  // v2.0.26, and passing it makes the CLI print usage and exit non-zero — a
  // guaranteed spawn failure for any job that set addDirs. Verified 2026-10-09.
  // Emitting a flag that the binary rejects is strictly worse than not emitting
  // it, so we drop the request rather than pretending the directories were
  // widened. `run` has no sandbox to widen anyway: it works from the cwd we
  // spawn it in, which spawnWorker already sets to spec.cwd. core/ should treat
  // opencode as having no addDirs support rather than assume otherwise.

  // Trailing positional message, last.
  argv.push(spec.prompt);
  return argv;
}

/**
 * Attach a reasoning effort to an opencode model id as `#variant`.
 *
 * WHY SO CAREFUL: `--model` is documented as `provider/model#variant`, so a
 * caller who already wrote the variant in (`anthropic/claude-x#high`) must not
 * get a second `#`. And an effort with no model is meaningless, so we refuse it
 * rather than emit `--effort`, which does not exist as a flag.
 *
 * UNVERIFIED: that opencode accepts an arbitrary variant string, and which
 * variant names are legal per provider. If the CLI rejects one, the job fails
 * with a clear error and no side effects — acceptable for a flag we cannot test.
 */
export function withEffortVariant(model: string, effort: string | undefined): string {
  if (effort === undefined || effort === '') return model;
  if (model.includes('#')) return model; // caller already encoded it
  return `${model}#${effort}`;
}

// ---------------------------------------------------------------------------
// Defensive extraction
// ---------------------------------------------------------------------------

/**
 * Find the first string value under any of `keys`, at the top level or one
 * level down inside `part` / `message` / `properties` / `data`.
 *
 * WHY DEPTH-ONE RECURSION: opencode's part payloads nest the useful fields
 * under `properties` (per its server docs, Part objects carry a `properties`
 * bag). Without this, the text extraction silently returns nothing and the
 * mod surface shows an empty job.
 */
function deepString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(o, k);
    if (v !== undefined && v !== '') return v;
  }
  for (const nest of ['part', 'message', 'properties', 'data', 'info']) {
    const inner = obj(o, nest);
    if (inner === undefined) continue;
    for (const k of keys) {
      const v = str(inner, k);
      if (v !== undefined && v !== '') return v;
    }
  }
  return undefined;
}

/** Locate a `tokens`/`usage` object anywhere one or two levels down. */
function findUsage(o: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = obj(o, 'usage') ?? obj(o, 'tokens');
  if (direct !== undefined) return direct;
  for (const nest of ['properties', 'info', 'message', 'data']) {
    const inner = obj(o, nest);
    if (inner === undefined) continue;
    const u = obj(inner, 'usage') ?? obj(inner, 'tokens');
    if (u !== undefined) return u;
  }
  return undefined;
}

/**
 * Normalize opencode's token counters.
 *
 * UNVERIFIED field names. opencode is models.dev-driven and its counters are
 * likely to mirror Vercel AI SDK naming (promptTokens / completionTokens /
 * cachedInputTokens) rather than snake_case. We accept BOTH spellings and leave
 * anything we do not recognise undefined. We never invent a total.
 */
function toTokenUsage(usage: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (usage === undefined) return undefined;
  const pick = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = num(usage, k);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const out: TokenUsage = {};
  const input = pick('input_tokens', 'inputTokens', 'promptTokens', 'prompt_tokens');
  const output = pick('output_tokens', 'outputTokens', 'completionTokens', 'completion_tokens');
  const thinking = pick('reasoning_tokens', 'thinking_tokens', 'reasoningTokens');
  const cacheRead = pick('cache_read_tokens', 'cacheReadTokens', 'cachedInputTokens');
  const total = pick('total_tokens', 'totalTokens');
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (thinking !== undefined) out.thinkingTokens = thinking;
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead;
  if (total !== undefined) out.totalTokens = total;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Terminal-state words we might see on a tool part. */
const DONE_WORDS = new Set(['completed', 'complete', 'done', 'success', 'succeeded', 'finished']);
const ERROR_WORDS = new Set(['error', 'failed', 'failure', 'cancelled', 'canceled', 'aborted']);

interface OpencodeTranslator {
  onEvent(raw: Record<string, unknown>): ProviderEvent[];
  finalText: string;
  sawTerminal: boolean;
  sawError: boolean;
  usage?: TokenUsage;
  sessionId?: string;
  unrecognised: Set<string>;
  deniedNotices: string[];
}

/**
 * Build the translator.
 *
 * The contract with the caller is deliberately weak: emit a text event for
 * anything textual, an activity for anything tool-shaped, a usage event for any
 * token counters, a notice for EVERYTHING ELSE, and never throw on a shape we
 * did not anticipate. Verified failure modes already handled: `error` events
 * (observed live) and totally unknown types (spec'd above).
 */
function createOpencodeTranslator(maxChars: number): OpencodeTranslator {
  const tx: OpencodeTranslator = {
    finalText: '',
    sawTerminal: false,
    sawError: false,
    unrecognised: new Set<string>(),
    deniedNotices: [],
    onEvent: () => [],
  };
  let step = 0;
  /** partID -> stepIndex */
  const partStep = new Map<string, number>();

  tx.onEvent = (raw: Record<string, unknown>): ProviderEvent[] => {
    const out: ProviderEvent[] = [];
    const at = nowIso();
    const type = str(raw, 'type') ?? 'unknown';

    const sessionId = str(raw, 'sessionID') ?? str(raw, 'session_id');
    if (sessionId !== undefined) tx.sessionId = sessionId;

    // ---- errors: the one shape we verified live -----------------------------
    if (type === 'error') {
      tx.sawError = true;
      const e = obj(raw, 'error');
      const message = str(e, 'message') ?? str(raw, 'message') ?? 'opencode error';
      const errorType = str(e, 'type');
      // Quota / no-route failures are the two I actually hit. They are
      // environment failures (no money, no route) rather than the worker doing
      // something wrong, so we label them distinctly: the operator's fix is
      // billing or config, not a better prompt.
      const isEnv =
        errorType !== undefined && (errorType.startsWith('provider.') || errorType.startsWith('auth.'));
      out.push({
        kind: 'notice',
        at,
        level: 'error',
        message: isEnv ? `environment failure — ${errorType}: ${message}` : message,
        raw,
      });
      return out;
    }

    // ---- usage, wherever it hides -------------------------------------------
    const usage = toTokenUsage(findUsage(raw));
    if (usage !== undefined) {
      tx.usage = usage;
      out.push({ kind: 'usage', at, usage });
    }

    // ---- tool-shaped parts --------------------------------------------------
    // Detection is by content: a `tool`/`toolName` string plus a state word.
    const toolName = deepString(raw, ['tool', 'toolName', 'tool_name', 'name']);
    const stateWord = (deepString(raw, ['state', 'status']) ?? '').toLowerCase();
    const partId = deepString(raw, ['id', 'partID', 'partId', 'callID', 'callId']) ?? `anon-${step}`;

    if (toolName !== undefined && (stateWord !== '' || type.includes('tool'))) {
      const isDone = DONE_WORDS.has(stateWord) || type.endsWith('.completed') || type.endsWith('.done');
      const isErr = ERROR_WORDS.has(stateWord) || type.endsWith('.error');
      const denied =
        deepString(raw, ['error', 'message'])?.toLowerCase().includes('denied') === true ||
        deepString(raw, ['error'])?.toLowerCase().includes('permission') === true;

      const input = preview(obj(raw, 'properties')?.['input'] ?? raw['input'] ?? raw['arguments'], maxChars);
      const output = preview(raw['output'] ?? raw['result'], maxChars);

      if (!partStep.has(partId)) {
        const idx = step++;
        partStep.set(partId, idx);
        const ref: ActivityRef = { stepIndex: idx, tool: toolName, toolCallId: partId };
        if (input !== undefined) ref.input = input.text;
        if (input?.truncated === true) ref.truncated = true;
        if (denied) ref.denied = true;
        out.push({ kind: 'activity-start', at, activity: ref });
      }

      if (isDone || isErr) {
        const idx = partStep.get(partId) ?? step++;
        partStep.set(partId, idx);
        let status: ActivityStatus = isErr ? 'error' : 'done';
        if (denied) status = 'denied';
        const ref: ActivityRef = { stepIndex: idx, tool: toolName, toolCallId: partId };
        if (input !== undefined) ref.input = input.text;
        if (output !== undefined) {
          ref.output = output.text;
          if (output.truncated) ref.truncated = true;
        }
        if (denied) ref.denied = true;
        out.push({ kind: 'activity-end', at, activity: ref, status });
        if (denied) tx.deniedNotices.push(toolName);
        if (isErr) tx.sawError = true;
      } else {
        // In-flight: emit an update so a long tool call is not a silent gap.
        const idx = partStep.get(partId) ?? 0;
        const ref: ActivityRef = { stepIndex: idx, tool: toolName, toolCallId: partId };
        if (input !== undefined) ref.input = input.text;
        if (output !== undefined) ref.output = output.text;
        out.push({ kind: 'activity-update', at, activity: ref });
      }
      return out;
    }

    // ---- text ---------------------------------------------------------------
    const text = deepString(raw, ['text', 'content', 'delta', 'textDelta']);
    const isThinking = type.includes('thinking') || type.includes('reasoning');
    if (text !== undefined && text !== '') {
      if (!isThinking) {
        if (tx.finalText !== '') tx.finalText += '\n';
        tx.finalText += text;
      }
      out.push({ kind: 'text', at, text, stream: isThinking ? 'thinking' : 'assistant' });
      // A text event is also our best evidence the run is producing output, so
      // it doubles as a terminal marker candidate below.
      return out;
    }

    // ---- session lifecycle --------------------------------------------------
    // Documented bus names (opencode.ai/docs/server "Events"), UNVERIFIED for
    // `run --format json`. Treated as terminal only for the unambiguous ones.
    if (type === 'session.idle' || type === 'session.idle.completed' || type === 'session.completed') {
      tx.sawTerminal = true;
      out.push({ kind: 'notice', at, level: 'info', message: `opencode ${type}`, raw });
      return out;
    }
    if (type === 'session.error') {
      tx.sawError = true;
      out.push({ kind: 'notice', at, level: 'error', message: 'opencode session.error', raw });
      return out;
    }

    // ---- fallthrough: never drop data ---------------------------------------
    if (type === 'unknown' || !KNOWN_TYPES.has(type)) {
      tx.unrecognised.add(type);
      out.push({
        kind: 'notice',
        at,
        level: 'info',
        message: `opencode emitted unrecognised event type "${type}" (payload preserved in events.jsonl)`,
        raw,
      });
      return out;
    }

    out.push({ kind: 'notice', at, level: 'info', message: `opencode ${type}`, raw });
    return out;
  };

  return tx;
}

/**
 * The event types we have a behaviour for. Anything outside this set gets the
 * "unrecognised" notice. Kept as a set (rather than a switch with a default) so
 * adding a handled type is a one-line, reviewable change.
 */
const KNOWN_TYPES = new Set([
  'error',
  'session.idle',
  'session.idle.completed',
  'session.completed',
  'session.error',
  'session.updated',
  'message.updated',
  'message.part.updated',
  'message.part.completed',
  'message.completed',
  'tool.started',
  'tool.completed',
  'tool.error',
  'text',
  'unknown',
]);

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  killReason: 'cancelled' | 'timeout' | undefined;
  stderr: string;
}

function buildResult(args: {
  jobId: string;
  startedAtMs: number;
  stateDir: string;
  exit: ExitInfo;
  tx: OpencodeTranslator;
}): JobResult {
  const { jobId, startedAtMs, stateDir, exit, tx } = args;
  const finishedAt = nowIso();
  const durationMs = Date.now() - startedAtMs;

  let status: JobStatus;
  let error: string | undefined;

  // Event types the parser did not know: the clue when a run looks empty or broken.
  const unrecognised = tx.unrecognised.size > 0 ? ` · unrecognised events: ${[...tx.unrecognised].join(', ')}` : '';
  if (exit.killReason === 'cancelled') {
    status = 'cancelled';
    error = 'canceled';
  } else if (exit.killReason === 'timeout') {
    status = 'timeout';
    error = timedOutText(durationMs);
  } else if (tx.sawError) {
    // An `error` event or an error-state tool part. opencode's provider.quota
    // 402 exits 1 with an error event and no text, so this is the common path
    // for a misconfigured account.
    status = 'error';
    error = `worker error${unrecognised}${stderrClause(exit.stderr)}`;
  } else if (tx.deniedNotices.length > 0) {
    // Same reasoning as agy: a denied tool means the work did not happen, and
    // opencode may well exit 0. Do not report that as a success.
    status = 'denied';
    error = deniedText(tx.deniedNotices, '');
  } else if (exit.code !== 0) {
    status = 'error';
    error = `exited ${exit.code}${unrecognised}${stderrClause(exit.stderr)}`;
  } else if (tx.finalText.trim() === '') {
    // Exited 0 with no text and no error event. Do not call that a success.
    // Be honest about why: with an unverified parser this is the shape most
    // likely to mean "we did not understand the output", not "the model said
    // nothing", and the two demand different fixes.
    // Most likely an event-shape gap in the adapter, not an empty model reply:
    // check events.jsonl and extend the parser.
    status = 'malformed';
    error = `no output${unrecognised}${stderrClause(exit.stderr)}`;
  } else {
    status = 'success';
  }

  const out: JobResult = {
    jobId,
    provider: 'opencode',
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
  if (tx.unrecognised.size > 0) out.raw = { unrecognisedEventTypes: [...tx.unrecognised] };
  if (tx.sessionId !== undefined) {
    out.raw = { ...(out.raw ?? {}), sessionId: tx.sessionId };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Parse `opencode models` lines (`provider/model`, optionally `#variant` is not expected). */
export function parseOpencodeModels(stdout: string): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const id = raw.trim().split(/\s+/)[0] ?? '';
    // Accept only provider/model-looking tokens; skip banners and noise.
    if (!/^[A-Za-z0-9_.-]+\/[^\s]+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id, efforts: [] });
  }
  return out;
}

/** Lazy, never throws. verified:false — the output format is unconfirmed. */
export async function listOpencodeModels(run: RunFn, options?: ListModelsOptions): Promise<ModelCatalog> {
  const base: ModelCatalog = {
    provider: 'opencode',
    models: [],
    defaultSource: 'unknown',
    source: 'live',
    stale: false,
    verified: false,
  };
  try {
    const r = await run(OPENCODE_BINARY, ['models'], options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
    const models = parseOpencodeModels(r.stdout);
    if (models.length > 0) return { ...base, models };
    return {
      ...base,
      error: r.error ?? '`opencode models` printed no recognizable models (output format unverified; pass an explicit provider/model)',
    };
  } catch (e) {
    return { ...base, error: errMessage(e) };
  }
}

export const opencodeProvider: Provider = {
  name: 'opencode',

  async available(): Promise<boolean> {
    try {
      return await binaryOnPath(OPENCODE_BINARY);
    } catch {
      return false;
    }
  },

  describeSandbox: (spec) => sandboxPlan(spec),

  listModels: (options) => listOpencodeModels(runCapture, options),

  async spawn(spec: SpawnSpec): Promise<WorkerHandle> {
    const jobId = spec.jobId ?? newJobId();
    const stateDir = writeStateDir('opencode', jobId, spec.stateDir);
    const argv = buildArgv(spec);
    writeArgv(stateDir, argv, spec.cwd);

    const maxChars = spec.maxOutputChars ?? 2000;
    const bus = createEventBus();
    const tx = createOpencodeTranslator(maxChars);

    const publish = (events: ProviderEvent[]): void => {
      for (const e of events) {
        bus.emit(e);
        appendEventLog(stateDir, e);
      }
    };

    const startedAtMs = Date.now();

    const proc = await spawnWorker({
      provider: 'opencode',
      binary: OPENCODE_BINARY,
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
          // `run --format json` is documented as raw JSON events, but --format
          // default prints human text, and a future version could add banner
          // lines. Either way: surface, never crash, never silently drop.
          bus.emit({
            kind: 'notice',
            at: nowIso(),
            level: 'warn',
            message: `opencode stdout (non-JSON): ${truncate(line, 400).text}`,
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

export const opencode = opencodeProvider;
