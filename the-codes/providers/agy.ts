import {
  binaryAvailable,
  earlyVerdict,
  jobResult,
  nowIso,
  obj,
  preview,
  runNdjsonWorker,
  str,
  truncate,
} from './ndjson.ts';
import type { ExitInfo } from './ndjson.ts';
import type {
  ActivityRef,
  ActivityStatus,
  DeniedAction,
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
import { exitReason } from '../surfaces/mod/hooks/reasons.ts';
import { deniedText, noResultText, stderrClause } from './failure-text.ts';
import { createAnswer, emptyResponseVerdict, type Answer } from './answer.ts';
import { createAgyTeamReader } from './agy-team.ts';

export function agyBinary(): string {
  return process.env['AGENT_SMITH_AGY_BIN'] ?? 'agy';
}

/** agy's own enum, verified from `agy --help` and from 14.9k live records. */
type AgyStepType = 'tool' | 'agent_response' | 'user_input' | 'system_message' | 'error_message' | 'checkpoint';
type AgyStepState = 'ACTIVE' | 'DONE' | 'ERROR';

interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

interface AgyToolInfo {
  name?: string;
  parameters?: unknown;
  output?: unknown;
  error?: { type?: string; message?: string };
}

interface AgyStepUpdate {
  conversation_id?: string;
  step_index?: number;
  state?: AgyStepState;
  step_type?: AgyStepType;
  tool_name?: string;
  tool_info?: AgyToolInfo;
  text_delta?: string;
  duration_seconds?: number;
  usage?: AgyUsage;
}

interface AgyDeniedAction {
  action?: string;
  display_name?: string;
}

interface AgyResultEvent {
  conversation_id?: string;
  status?: 'SUCCESS' | 'ERROR' | string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgyUsage;
  /** Present only when at least one tool was auto-denied. See THE TRAP above. */
  denied_actions?: AgyDeniedAction[];
}

// ---------------------------------------------------------------------------
// argv construction
// ---------------------------------------------------------------------------

/**
 * Format a millisecond budget as a Go duration string.
 *
 * agy's --print-timeout is typed as a Go `time.Duration` (its help literally
 * says `0s`). Verified that `20s` is accepted.
 * NOTE: Go durations have no day component; >24h wraps. We clamp to hours.
 */
function toGoDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

const COMPOSABLE_EFFORTS = ['low', 'medium', 'high'];

/**
 * Decide the --model / --effort pair. `agy models` lists effort-SUFFIXED ids and
 * discovery (listModels) exposes BASE ids, so a base id + low|medium|high effort
 * composes to `<base>-<effort>` (the form agy actually knows) and no --effort is
 * passed. Other efforts (xhigh/max) keep the separate --effort flag. An id that
 * already carries a suffix is used as-is; a conflicting effort throws.
 */
function resolveModelAndEffort(spec: Pick<SpawnSpec, 'model' | 'effort'>): {
  model?: string;
  effortFlag?: string;
} {
  const model = spec.model !== undefined && spec.model !== '' ? spec.model : undefined;
  const effort = spec.effort !== undefined && spec.effort !== '' ? spec.effort : undefined;
  if (effort === undefined) return model === undefined ? {} : { model };
  if (model === undefined) return { effortFlag: effort };
  const encoded = model.match(/-(low|medium|high|xhigh|max)$/i)?.[1]?.toLowerCase();
  if (encoded !== undefined) {
    if (encoded !== effort) throw new Error(`model ${model} encodes effort ${encoded}, conflicting with ${effort}`);
    return { model };
  }
  if (COMPOSABLE_EFFORTS.includes(effort)) return { model: `${model}-${effort}` };
  return { model, effortFlag: effort };
}

/** Sandbox flags agy gets for a spawn. Shared by buildArgv and describeSandbox. */
export function sandboxPlan(spec: Pick<SpawnSpec, 'unrestricted' | 'readOnly'>): SandboxInfo {
  if (spec.unrestricted) {
    return {
      sandbox: 'agy --dangerously-skip-permissions (unrestricted)',
      flags: ['--dangerously-skip-permissions'],
      readOnlyEnforced: false,
      unrestricted: true,
    };
  }
  return {
    sandbox: 'agy proceed-in-sandbox (cannot prompt; unapproved tools are auto-denied)',
    flags: [],
    readOnlyEnforced: false,
    unrestricted: false,
  };
}

/**
 * Build the exact argv for one agy worker.
 *
 * VERIFIED FLAGS (from `agy --help` on this machine):
 *   --print=<prompt>              NOT `--print <prompt>`: --print consumes the
 *                                 next token when separated by a space, so the
 *                                 attached form is the only safe one. (`-p` is
 *                                 a short alias; we use the long form.)
 *   --output-format stream-json   NDJSON on stdout.
 *   --model <id>
 *   --effort <low|medium|high|xhigh|max>
 *   --print-timeout <dur>         Go duration; 0 = wait forever.
 *   --add-dir <dir>               repeatable.
 *   --dangerously-skip-permissions
 *   --conversation <id>
 *
 * EXPLICITLY NOT PASSED, and why:
 *   --sandbox          agy's default permission_mode is already
 *                      "proceed-in-sandbox" (seen in the init event), so we do
 *                      not re-request it and accidentally widen the sandbox.
 *   --log-file         our own stderr.log in stateDir already captures it.
 *   --new-project      grouped sessions are a harness concern, and SpawnSpec
 *                      has no field for it.
 */
export function buildArgv(spec: SpawnSpec): string[] {
  const argv: string[] = [
    // Attached form. Verified: `--print=<prompt>` parses the whole prompt as one
    // argument even when it contains spaces, newlines and backticks.
    `--print=${spec.prompt}`,
    '--output-format',
    'stream-json',
  ];

  const { model, effortFlag } = resolveModelAndEffort(spec);
  if (model !== undefined) argv.push('--model', model);
  if (effortFlag !== undefined) argv.push('--effort', effortFlag);

  if (spec.timeoutMs > 0) {
    argv.push('--print-timeout', toGoDuration(spec.timeoutMs));
  }

  // Repeatable, one flag per directory.
  for (const dir of spec.addDirs ?? []) {
    argv.push('--add-dir', dir);
  }

  // Without --dangerously-skip-permissions, headless agy auto-denies every tool
  // that needs approval and reports SUCCESS. See THE TRAP.
  argv.push(...sandboxPlan(spec).flags);

  if (spec.conversation !== undefined && spec.conversation !== '') {
    // Resume a conversation thread (UUID from result.conversation_id).
    argv.push('--conversation', spec.conversation);
  }

  return argv;
}

// ---------------------------------------------------------------------------
// ProviderEvent translation
// ---------------------------------------------------------------------------

function toTokenUsage(u: AgyUsage | undefined): TokenUsage | undefined {
  if (u === undefined) return undefined;
  const out: TokenUsage = {};
  if (u.input_tokens !== undefined) out.inputTokens = u.input_tokens;
  if (u.output_tokens !== undefined) out.outputTokens = u.output_tokens;
  if (u.thinking_tokens !== undefined) out.thinkingTokens = u.thinking_tokens;
  if (u.cache_read_tokens !== undefined) out.cacheReadTokens = u.cache_read_tokens;
  if (u.total_tokens !== undefined) out.totalTokens = u.total_tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Is this TOOL_ERROR a permission denial rather than a genuine tool failure?
 *
 * The wording is agy's own (verified in the live run quoted at the top of this
 * file): "permission check failed for command ...: user denied permission to
 * run command". We match on it so the operator sees DENIED, not ERROR, because
 * the remedy is different: ERROR means the tool broke, DENIED means the
 * permission model ate the work.
 */
export function isDenialError(toolError: { type?: string; message?: string } | undefined): boolean {
  if (toolError === undefined) return false;
  const hay = `${toolError.type ?? ''} ${toolError.message ?? ''}`.toLowerCase();
  // Not a bare "permission": agy prefixes ordinary tool failures with its
  // permission-declaration phase ("declaring permissions: ... no such file or
  // directory"), and a missing file must not fail a finished job as denied.
  return (
    hay.includes('permission check failed') ||
    hay.includes('denied') ||
    hay.includes('not permitted')
  );
}

/**
 * Holds the per-job state agy's stream implies but does not state.
 *
 * WHY: agy emits ACTIVE/DONE as SEPARATE step_update records for the same
 * step_index, and only the ACTIVE one carries tool_info.parameters. So the
 * DONE record is useless on its own — we must remember what the tool was.
 * 14 900 archived records confirm this pattern.
 */
interface StepMemory {
  tool?: string;
  input?: string;
  truncated?: boolean;
}

/**
 * agy's leftover error, as a short warning:
 * "API error (attempt 3): RESOURCE_EXHAUSTED (code 429): …" → "recovered: 429 resource exhausted".
 */
function recoveredWarning(rawError: string | undefined): string {
  const raw = (rawError ?? '').replace(/\s+/g, ' ').trim().replace(/^error:\s*/i, '');
  const coded = /\b([A-Z][A-Z0-9_]+)\s*\(code\s+(\d+)\)/.exec(raw);
  const words = coded
    ? `${coded[2]} ${coded[1]!.toLowerCase().replace(/_/g, ' ')}`
    : raw.replace(/\.\s+(?:this can happen|please try again)\b.*$/i, '').replace(/\.$/, '').toLowerCase();
  return truncate(`recovered: ${words || 'worker error'}`, 200).text;
}

/**
 * The warning for a run `buildResult` judged a success although agy reported
 * an error: the error was stale. Issued only after that verdict, so the
 * warning and the status can never disagree.
 */
export function recoveredNotice(final: JobResult, resultEvent: AgyResultEvent | undefined): ProviderEvent | undefined {
  if (final.status !== 'success' || resultEvent === undefined || resultEvent.status === 'SUCCESS') return undefined;
  return { kind: 'notice', at: final.finishedAt, level: 'warn', message: recoveredWarning(resultEvent.error), raw: resultEvent };
}

export function createAgyTranslator(maxChars: number) {
  const steps = new Map<number, StepMemory>();
  const answer = createAnswer('agy');
  const denials: DeniedAction[] = [];
  let sawErrorStep = false;
  let progressedAfterError = false;
  const errorIsStale = (): boolean => !sawErrorStep || progressedAfterError;

  function noteDenial(raw: unknown): void {
    denials.push(raw as DeniedAction);
  }

  function onEvent(raw: Record<string, unknown>): ProviderEvent[] {
    const out: ProviderEvent[] = [];
    const event = str(raw, 'event');
    const at = nowIso();

    if (event === 'init') {
      const init = obj(raw, 'init');
      const ev: ProviderEvent = {
        kind: 'started',
        at,
        raw,
      };
      const conv = str(raw, 'conversation_id') ?? str(init, 'conversation_id');
      if (conv !== undefined) ev.conversationId = conv;
      const model = str(init, 'model');
      if (model !== undefined) ev.model = model;
      out.push(ev);
      return out;
    }

    if (event === 'step_update') {
      const su = obj(raw, 'step_update') as AgyStepUpdate | undefined;
      if (su === undefined) return out;

      const stepIndex = su.step_index ?? 0;
      const stepType = su.step_type;
      const state = su.state;

      // --- usage, attached to almost every DONE record -----------------------
      // Any step that finishes, other than an error, is progress past an earlier error.
      if (state === 'DONE' && stepType !== 'error_message') progressedAfterError = true;

      const usage = toTokenUsage(su.usage);
      if (usage !== undefined) out.push({ kind: 'usage', at, usage });

      // --- agent prose / thinking --------------------------------------------
      if (stepType === 'agent_response') {
        const delta = su.text_delta;
        if (delta !== undefined) {
          answer.text(delta, String(stepIndex));
          if (delta !== '') {
            out.push({ kind: 'text', at, text: delta, stream: 'assistant', delta: true });
          }
        }
        return out;
      }

      // --- tool calls ---------------------------------------------------------
      if (stepType === 'tool') {
        const info = su.tool_info;
        const toolName = su.tool_name ?? info?.name ?? 'unknown';
        answer.tool(toolName);
        const mem = steps.get(stepIndex) ?? {};
        steps.set(stepIndex, mem);

        if (state === 'ACTIVE') {
          mem.tool = toolName;
          const input = preview(info?.parameters, maxChars);
          if (input !== undefined) {
            mem.input = input.text;
            mem.truncated = input.truncated;
          }
          const ref: ActivityRef = { stepIndex, tool: toolName };
          if (mem.input !== undefined) ref.input = mem.input;
          if (mem.truncated !== undefined) ref.truncated = mem.truncated;
          out.push({ kind: 'activity-start', at, activity: ref });
          return out;
        }

        // DONE / ERROR
        const denied = state === 'ERROR' && isDenialError(info?.error);
        if (denied) {
          noteDenial({
            action: toolName,
            displayName: toolName,
            raw: { stepIndex, error: info?.error },
          });
        }
        const output = preview(info?.output ?? info?.error?.message, maxChars);
        const ref: ActivityRef = { stepIndex, tool: toolName };
        if (mem.input !== undefined) ref.input = mem.input;
        if (output !== undefined) ref.output = output.text;
        const anyTrunc = (mem.truncated ?? false) || (output !== undefined && output.truncated);
        if (anyTrunc) ref.truncated = true;
        if (denied) ref.denied = true;

        let status: ActivityStatus;
        if (denied) status = 'denied';
        else if (state === 'ERROR') status = 'error';
        else status = 'done';

        const ev: ProviderEvent = { kind: 'activity-end', at, activity: ref, status };
        if (su.duration_seconds !== undefined) ev.durationSeconds = su.duration_seconds;
        out.push(ev);
        return out;
      }

      // --- error_message: agy's own API/transport errors ----------------------
      if (stepType === 'error_message') {
        answer.work();
        sawErrorStep = true;
        progressedAfterError = false;
        const suObj = obj(raw, 'step_update');
        const detail = (
          str(suObj, 'text_delta') ??
          str(suObj, 'error') ??
          str(obj(suObj, 'error'), 'message') ??
          str(suObj, 'message') ??
          su.tool_info?.error?.message ??
          ''
        ).replace(/\s+/g, ' ').trim();
        const message = detail === '' ? 'agy error' : truncate(`agy error: ${detail}`, 200).text;
        out.push({ kind: 'notice', at, level: 'error', message, raw: su });
        return out;
      }

      // --- system_message / checkpoint / user_input --------------------------
      // Informational. Forward as notices so the operator sees permission
      // prompts and checkpoints without the mod surface needing to know agy.
      if (stepType === 'system_message' || stepType === 'checkpoint') {
        out.push({
          kind: 'notice',
          at,
          level: 'info',
          message: `agy ${stepType} at step ${stepIndex}`,
          raw: su,
        });
      }
      return out;
    }

    if (event === 'result') {
      // The result event itself is not a ProviderEvent. It becomes JobResult,
      // which is built in the exit handler. Nothing to emit here.
      return out;
    }

    // Unknown event name. Not fatal; the CLI gains fields before we gain code.
    return out;
  }

  return {
    onEvent,
    answer,
    denials,
    stepsWereTools: (): boolean => [...steps.values()].some((m) => m.tool !== undefined),
    errorIsStale,
  };
}

// ---------------------------------------------------------------------------
// JobResult construction
// ---------------------------------------------------------------------------

export function buildResult(args: {
  jobId: string;
  resultEvent: AgyResultEvent | undefined;
  exit: ExitInfo;
  startedAtMs: number;
  stateDir: string;
  denials: DeniedAction[];
  sawAnyToolCall: boolean;
  /** From the translator: agy's reported error predates this run's last progress. */
  errorIsStale: boolean;
  answer: Answer;
}): JobResult {
  const { jobId, resultEvent, exit, startedAtMs, stateDir, denials, sawAnyToolCall } = args;
  const { errorIsStale } = args;
  const durationMs = Date.now() - startedAtMs;

  args.answer.providerFinal(resultEvent?.response, 'run-prose');
  const response = args.answer.value();
  const reportedStatus = resultEvent?.status;
  const usage = toTokenUsage(resultEvent?.usage);

  // Normalize agy's denied_actions into our shape. Present-but-empty is the
  // same as absent, so we only set the field when it actually means something.
  // Two SOURCES are merged: the per-tool TOOL_ERROR denials we saw during the
  // stream, and the result event's own denied_actions. Either can fire alone.
  const deniedActions: DeniedAction[] = [...denials];
  for (const d of resultEvent?.denied_actions ?? []) {
    const entry: DeniedAction = { raw: d };
    if (d.action !== undefined) entry.action = d.action;
    if (d.display_name !== undefined) entry.displayName = d.display_name;
    deniedActions.push(entry);
  }
  const distinctDenials: DeniedAction[] = [];
  const seen = new Set<string>();
  for (const d of deniedActions) {
    const key = `${d.action ?? ''}:${d.displayName ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinctDenials.push(d);
  }

  let status: JobStatus;
  let error: string | undefined;

  // ORDER MATTERS. Kill reasons dominate everything: a job we killed has no
  // trustworthy terminal state, whatever agy managed to flush first.
  const early = earlyVerdict(exit, durationMs);
  if (early !== undefined) {
    ({ status, error } = early);
  } else if (distinctDenials.length > 0 && reportedStatus === 'SUCCESS' && exit.code === 0 && response.trim() !== '') {
    status = 'success';
    for (const d of distinctDenials) d.nonfatal = true;
  } else if (distinctDenials.length > 0) {
    status = 'denied';
    // Headless agy auto-denies tools it cannot prompt for unless run with
    // --dangerously-skip-permissions; an explicit deny rule overrides that flag.
    error = deniedText(
      distinctDenials.map((d) => d.displayName ?? d.action).filter((n): n is string => n !== undefined),
      exit.stderr,
    );
  } else if (resultEvent === undefined) {
    // Process ended with no result event at all: a crash, an OOM kill, or a CLI
    // version whose output format changed. Never report success.
    status = exit.code === 0 ? 'malformed' : 'error';
    error = noResultText(exit);
  } else if (reportedStatus !== 'SUCCESS') {
    if (response.trim() !== '' && errorIsStale) {
      status = 'success';
    } else {
      status = 'error';
      error = resultEvent.error ?? 'worker error';
    }
  } else {
    const empty = emptyResponseVerdict(response, exit.stderr, { status: sawAnyToolCall ? 'denied' : 'malformed' });
    if (empty !== undefined) {
      ({ status, error } = empty);
    } else {
      status = 'success';
    }
  }

  // Exit code is corroboration, not the decision. A non-zero exit with a
  // SUCCESS-looking result event still has to be a failure.
  if (status === 'success' && exit.code !== 0) {
    status = 'error';
    error = exit.code === null ? `exited on ${exit.signal ?? 'a signal'}` : exitReason(exit.code);
  }

  const out = jobResult({ provider: 'agy', jobId, status, error, exit, response, startedAtMs, durationMs, stateDir });
  if (distinctDenials.length > 0) out.deniedActions = distinctDenials;
  if (usage !== undefined) out.usage = usage;
  if (resultEvent !== undefined) out.raw = resultEvent;
  return out;
}

// ---------------------------------------------------------------------------
// The Provider
// ---------------------------------------------------------------------------
/**
 * Parse `agy models` stdout (`<id>\t<label>` lines after a "Fetching..." line)
 * into BASE models: the -low/-medium/-high suffix is stripped and collected as efforts.
 */
export function parseAgyModels(stdout: string): ModelInfo[] {
  const order: string[] = [];
  const byBase = new Map<string, ModelInfo>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || !line.includes('\t')) continue;
    const [id = '', label = ''] = line.split('\t');
    const m = id.trim().match(/^(.+)-(low|medium|high)$/);
    const base = m ? m[1]! : id.trim();
    const effort = m ? m[2]! : undefined;
    if (base === '') continue;
    let info = byBase.get(base);
    if (info === undefined) {
      info = { id: base, label: label.replace(/\s*\((low|medium|high)\)\s*$/i, '').trim() || base, efforts: [] };
      byBase.set(base, info);
      order.push(base);
    }
    if (effort !== undefined && !info.efforts.includes(effort)) info.efforts.push(effort);
  }
  const rank = (e: string): number => COMPOSABLE_EFFORTS.indexOf(e);
  return order.map((b) => {
    const i = byBase.get(b)!;
    i.efforts.sort((a, c) => rank(a) - rank(c));
    return i;
  });
}

/** Lazy, never throws. `run` is injectable for tests. */
export async function listAgyModels(run: RunFn, options?: ListModelsOptions): Promise<ModelCatalog> {
  const base: ModelCatalog = {
    provider: 'agy',
    models: [],
    defaultSource: 'unknown',
    source: 'live',
    stale: false,
    verified: true,
  };
  try {
    const r = await run(agyBinary(), ['models'], options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
    const models = parseAgyModels(r.stdout);
    if (r.error !== undefined && models.length === 0) return { ...base, error: r.error };
    if (models.length === 0) return { ...base, error: '`agy models` printed no models' };
    return { ...base, models };
  } catch (e) {
    return { ...base, error: errMessage(e) };
  }
}

export const AGY_TEAM_POLL_MS = 2_000;

export interface AgyTeamDeps {
  readonly createReader: typeof createAgyTeamReader;
  readonly pollMs: number;
}

export interface AgyTeamWatch {
  start(conversationId: string): void;
  tick(nowMs: number): void;
  stop(): void;
}

export function createAgyTeamWatch(cwd: string, emit: (event: ProviderEvent) => void, deps: AgyTeamDeps): AgyTeamWatch {
  let reader: ReturnType<typeof createAgyTeamReader> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let last = '';
  const tick = (nowMs: number): void => {
    if (stopped || reader === undefined) return;
    try {
      const read = reader.poll(nowMs);
      if (read === null) return;
      const key = JSON.stringify([{ ...read.team, updatedAt: 0 }, read.views]);
      if (key === last) return;
      last = key;
      emit({ kind: 'team', at: nowIso(nowMs), team: read.team, views: read.views });
    } catch {}
  };
  return {
    start(conversationId) {
      if (stopped || reader !== undefined) return;
      try { reader = deps.createReader({ conversationId, cwd }); } catch { return; }
      timer = setInterval(() => tick(Date.now()), Math.max(1, deps.pollMs));
      timer.unref?.();
    },
    tick,
    stop() {
      if (stopped) return;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      tick(Date.now());
      stopped = true;
    },
  };
}

export function spawnAgy(spec: SpawnSpec, deps: AgyTeamDeps = { createReader: createAgyTeamReader, pollMs: AGY_TEAM_POLL_MS }): Promise<WorkerHandle> {
  const translator = createAgyTranslator(spec.maxOutputChars ?? 2000);
  let resultEvent: AgyResultEvent | undefined;
  let team: AgyTeamWatch | undefined;

  return runNdjsonWorker({
    provider: 'agy',
    binary: agyBinary(),
    spec,
    buildArgv,
    translate(raw) {
      const out = translator.onEvent(raw);
      for (const e of out) if (e.kind === 'started' && e.conversationId !== undefined) team?.start(e.conversationId);
      return out;
    },
    sidecar: (emit) => (team = createAgyTeamWatch(spec.cwd, emit, deps)),
    // The result event is the verdict, not progress: hold it for buildResult
    // instead of translating it into an activity.
    intercept(raw) {
      if (raw['event'] !== 'result') return false;
      const r = obj(raw, 'result');
      if (r !== undefined) resultEvent = r as AgyResultEvent;
      return true;
    },
    // agy writes human-facing warnings to stderr, most importantly the
    // auto-denial notice quoted at the top of this file. That notice is our
    // earliest operator-facing hint that a job is going to come back empty.
    stderrLevel: (text) => (text.includes('denied') || text.includes('permission') ? 'warn' : 'info'),
    buildResult: (ctx) =>
      buildResult({
        ...ctx,
        resultEvent,
        denials: translator.denials,
        sawAnyToolCall: translator.stepsWereTools(),
        errorIsStale: translator.errorIsStale(),
        answer: translator.answer,
      }),
    afterResult(final) {
      const recovered = recoveredNotice(final, resultEvent);
      return recovered === undefined ? [] : [recovered];
    },
  });
}

export const agyProvider: Provider = {
  name: 'agy',
  defaultUnrestricted: true,

  available: () => binaryAvailable(agyBinary()),

  describeSandbox: sandboxPlan,

  listModels: (options) => listAgyModels(runCapture, options),

  spawn: (spec: SpawnSpec) => spawnAgy(spec),
};
