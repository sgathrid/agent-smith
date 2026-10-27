/**
 * providers/agy.ts — Antigravity CLI (`agy`) adapter.
 *
 * ============================================================================
 * EVERYTHING IN THIS FILE'S EVENT SCHEMA WAS VERIFIED AGAINST THE REAL BINARY.
 * ============================================================================
 * Verified on 2026-10-06 with:
 *   $ agy --print=hello --print-timeout=20s --output-format stream-json \
 *         --model gemini-3.8-flash-low
 * plus cross-checked against 20 archived agy-staff jobs in
 * ~/Repos/renyi/.agy-staff/jobs/ (~14 900 step_update records).
 * Commands used to check: `agy --help`, `agy models`, and live `--print` runs.
 * ============================================================================
 *
 * ----------------------------------------------------------------------------
 * THE TRAP: exit 0, status "SUCCESS", empty response.
 * ----------------------------------------------------------------------------
 * agy runs headless. Headless agy CANNOT PROMPT for tool permission. So when a
 * tool needs approval nobody can give, agy auto-denies it, prints a human
 * warning to stderr, and then reports:
 *
 *     {"event":"result","result":{
 *        "conversation_id":"...","status":"SUCCESS","response":"",
 *        "duration_seconds":2.6,"num_turns":1,"usage":{...},
 *        "denied_actions":[{"action":"command","display_name":"RunCommand"}]}}
 *
 * The process exits 0. `result.status` is the string "SUCCESS". `response` is
 * empty. VERIFIED LIVE:
 *
 *     $ agy --print="Run the shell command: echo hi" --output-format stream-json ...
 *     ... step_update step_index=2 state=ERROR step_type=tool tool_name=run_command
 *         tool_info.error.type = "TOOL_ERROR"
 *         tool_info.error.message = "permission check failed for command \"echo hi\":
 *             user denied permission to run command: ... Proceed without
 *             performing this action."
 *     stderr: jetski: no output produced — a tool required the "command"
 *             permission that headless mode cannot prompt for, so it was
 *             auto-denied. ... Alternatively, re-run with
 *             --dangerously-skip-permissions to auto-approve all tools.
 *     $ echo $?
 *     0
 *
 * EVERY NAIVE INTEGRATION READS THIS AS A SUCCESSFUL JOB THAT PRODUCED NOTHING.
 * A pipeline that chains implement -> review would then review a patch that was
 * never written, and report green. That is worse than a crash, because it is
 * quiet.
 *
 * So `result.denied_actions` IS TREATED AS A FIRST-CLASS FAILURE SIGNAL, and
 * there are actually THREE independent ways to detect it in this file, because
 * each fails in a different situation:
 *
 *   (1) result.denied_actions is non-empty  -> JobStatus 'denied'.  [primary]
 *       Unless agy still finished with SUCCESS, exit 0 and a non-empty report:
 *       then 'success' with the denials marked nonfatal, as claude does.
 *   (2) tool_info.error.type === 'TOOL_ERROR' whose message mentions a
 *       permission check failure or denial            -> 'denied'.  [early signal]
 *   (3) status !== 'SUCCESS'                        -> 'error'.
 *       Unless agy delivered a non-empty response and the error is stale
 *       (no error_message step in this run, or later steps succeeded):
 *       then 'success' with a warning notice.
 *   (4) status === 'SUCCESS' AND response.trim() === '' AND no usage beyond the
 *       preamble -> still 'denied'/'error', never 'success'. [last-resort net]
 *
 * (4) is deliberately paranoid. An empty response from a model that burned
 * 135 output tokens is not a success; it is a model that was told to stop. We
 * only allow the empty-response case to be benign if the job also had zero tool
 * calls, because "you asked me nothing and I said nothing" is a legitimate
 * (if useless) success.
 *
 * THE FIX IS UPSTREAM TOO: `unrestricted: true` adds --dangerously-skip-permissions,
 * which is what makes this whole class of silent failure disappear. But we still
 * check, because a config-level allow-rule can deny a single command and the
 * flag does not override an explicit deny.
 *
 * ----------------------------------------------------------------------------
 * THE OTHER TRAP: agy-staff DELETES progress.json on clean success.
 * ----------------------------------------------------------------------------
 * agy-staff (the host harness that used to drive agy) writes job state under
 *   <cwd>/.agy-staff/jobs/<jobId>.{spec.json,progress.json,events.jsonl,log,
 *                                   result.md,result.md.status.json}
 * On a run with NO warnings it DELETES progress.json and events.jsonl when the
 * job completes. This is not a bug and not a crash — it is the good path.
 *
 * CONSEQUENCE FOR ANY WATCHER (including harness/, and including anyone tempted
 * to poll progress.json from this file): a MISSING progress.json MEANS "JOB
 * FINISHED", NEVER "JOB VANISHED". Treating absence as liveness is how you get
 * a watcher that reports every healthy job as missing. The authoritative
 * terminal signal is the existence of result.md + result.md.status.json.
 *
 * We do NOT poll progress.json here — this adapter owns the live stream, and
 * stdio is authoritative. But we do not touch that tree either: it belongs to
 * harness/. Flagged loudly because it is the single most misreadable fact in
 * the whole system.
 */

import {
  appendEventLog,
  binaryOnPath,
  createEventBus,
  newJobId,
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
import { deniedText, noResultText, stderrClause, timedOutText } from './failure-text.ts';

export const AGY_BINARY = process.env['AGENT_SMITH_AGY_BIN'] ?? 'agy';

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
 * says `0s`), and agy-staff's resolved spec.json carries `"timeout":"120m"`,
 * i.e. the same grammar. Verified that `20s` is accepted.
 * NOTE: Go durations have no day component; >24h wraps. We clamp to hours.
 */
export function toGoDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h${m}m${s}s`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

/**
 * Does this agy model id already encode a reasoning effort?
 *
 * WHY: `agy --help` exposes BOTH `--effort <low|medium|high|xhigh|max>` and
 * `--model <id>`, but ag-staff's resolved specs use effort-SUFFIXED ids
 * ("gemini-3.8-flash-high", "gemini-3.8-flash-low") rather than a separate
 * effort flag. Passing both is at best redundant and at worst contradictory,
 * so we only add --effort when the id does not already carry one.
 */
export function modelCarriesEffort(model: string): boolean {
  return /-(low|medium|high|xhigh|max)$/i.test(model);
}

const COMPOSABLE_EFFORTS = ['low', 'medium', 'high'];

/**
 * Decide the --model / --effort pair. `agy models` lists effort-SUFFIXED ids and
 * discovery (listModels) exposes BASE ids, so a base id + low|medium|high effort
 * composes to `<base>-<effort>` (the form agy actually knows) and no --effort is
 * passed. Other efforts (xhigh/max) keep the separate --effort flag. An id that
 * already carries a suffix is used as-is; a conflicting effort throws.
 */
export function resolveModelAndEffort(spec: Pick<SpawnSpec, 'model' | 'effort'>): {
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
    };
  }
  return {
    sandbox: 'agy proceed-in-sandbox (cannot prompt; unapproved tools are auto-denied)',
    flags: [],
    readOnlyEnforced: false,
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
 *   --new-project      agy-staff passes --project for grouped sessions; that is
 *                      a harness concern, and SpawnSpec has no field for it.
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
  denied?: boolean;
  startedAt?: string;
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
  /** Set by any denial signal; carried into JobResult. */
  const denials: DeniedAction[] = [];
  // agy's final status repeats the conversation's last error, even one it
  // recovered from or one from an earlier run on the same conversation. Stale:
  // none this run, or a step finished after it. Trade-off: a failure agy
  // reports only in the result (no error step this run) also reads as stale;
  // buildResult still requires a response and exit 0 before calling it success.
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
        if (delta !== undefined && delta !== '') {
          // agy streams prose as many small text_delta slices. We forward each
          // one rather than buffering: the mod surface renders incrementally and
          // a long answer would otherwise be invisible for minutes.
          out.push({ kind: 'text', at, text: delta, stream: 'assistant', delta: true });
        }
        return out;
      }

      // --- tool calls ---------------------------------------------------------
      if (stepType === 'tool') {
        const info = su.tool_info;
        const toolName = su.tool_name ?? info?.name ?? 'unknown';
        const mem = steps.get(stepIndex) ?? {};
        steps.set(stepIndex, mem);

        if (state === 'ACTIVE') {
          mem.tool = toolName;
          mem.startedAt = at;
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
          mem.denied = true;
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
        sawErrorStep = true;
        progressedAfterError = false;
        // agy's stream carries no error text here; the final result does.
        out.push({ kind: 'notice', at, level: 'error', message: 'agy error', raw: su });
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
    denials,
    toolCallCount: () => steps.size,
    stepsWereTools: (): boolean => [...steps.values()].some((m) => m.tool !== undefined),
    errorIsStale,
  };
}

// ---------------------------------------------------------------------------
// JobResult construction
// ---------------------------------------------------------------------------

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  killReason: 'cancelled' | 'timeout' | undefined;
  stderr: string;
}

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
}): JobResult {
  const { jobId, resultEvent, exit, startedAtMs, stateDir, denials, sawAnyToolCall } = args;
  const { errorIsStale } = args;
  const finishedAt = nowIso();
  const durationMs = Date.now() - startedAtMs;

  const response = resultEvent?.response ?? '';
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
  if (exit.killReason === 'cancelled') {
    status = 'cancelled';
    error = 'canceled';
  } else if (exit.killReason === 'timeout') {
    status = 'timeout';
    error = timedOutText(durationMs);
  } else if (distinctDenials.length > 0 && reportedStatus === 'SUCCESS' && exit.code === 0 && response.trim() !== '') {
    // Denied calls, but agy finished and delivered a report: a success with a
    // warning, exactly as claude reports it. The forge verdict keeps the
    // denials visible as a note; an empty report still falls to THE TRAP.
    status = 'success';
    for (const d of distinctDenials) d.nonfatal = true;
  } else if (distinctDenials.length > 0) {
    // THE TRAP. exit code 0, status "SUCCESS", empty response — and yet the
    // job did nothing. Reported as a failure, loudly.
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
  } else if (response.trim() === '' && sawAnyToolCall) {
    // Paranoia net for (4) above. The model burned tokens and made tool calls
    // but produced no final text, with no explicit denial. That is a failure
    // shaped like a success. We allow the genuinely-empty case (no tool calls,
    // nothing asked) to pass as success.
    status = 'denied';
    error = `no output${stderrClause(exit.stderr)}`;
  } else {
    status = 'success';
  }

  // Exit code is corroboration, not the decision. A non-zero exit with a
  // SUCCESS-looking result event still has to be a failure.
  if (status === 'success' && exit.code !== 0) {
    status = 'error';
    error = exit.code === null ? `exited on ${exit.signal ?? 'a signal'}` : exitReason(exit.code);
  }

  const out: JobResult = {
    jobId,
    provider: 'agy',
    ok: status === 'success',
    status,
    exitCode: exit.code,
    signal: exit.signal,
    response,
    durationMs,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt,
    stateDir,
  };
  if (error !== undefined) out.error = error;
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
    const r = await run(AGY_BINARY, ['models'], options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
    const models = parseAgyModels(r.stdout);
    if (r.error !== undefined && models.length === 0) return { ...base, error: r.error };
    if (models.length === 0) return { ...base, error: '`agy models` printed no models' };
    return { ...base, models };
  } catch (e) {
    return { ...base, error: errMessage(e) };
  }
}

export const agyProvider: Provider = {
  name: 'agy',

  /**
   * PATH probe only. We deliberately do NOT run `agy models` here: available()
   * is called for every provider on every startup and a network-touching probe
   * would make startup slow and flaky. A resolvable binary is the contract;
   * auth problems surface as a job error instead.
   */
  async available(): Promise<boolean> {
    try {
      return await binaryOnPath(AGY_BINARY);
    } catch {
      return false;
    }
  },

  describeSandbox: (spec) => sandboxPlan(spec),

  listModels: (options) => listAgyModels(runCapture, options),

  async spawn(spec: SpawnSpec): Promise<WorkerHandle> {
    const jobId = spec.jobId ?? newJobId();
    const stateDir = writeStateDir('agy', jobId, spec.stateDir);
    const argv = buildArgv(spec);
    writeArgv(stateDir, argv, spec.cwd);

    const maxChars = spec.maxOutputChars ?? 2000;
    const bus = createEventBus();
    const translator = createAgyTranslator(maxChars);

    let resultEvent: AgyResultEvent | undefined;
    let startedAtMs = Date.now();

    const publish = (events: ProviderEvent[]): void => {
      for (const e of events) {
        bus.emit(e);
        appendEventLog(stateDir, e);
      }
    };

    const proc = await spawnWorker({
      provider: 'agy',
      binary: AGY_BINARY,
      argv,
      cwd: spec.cwd,
      timeoutMs: spec.timeoutMs,
      stateDir,
      jobId,
      mode: spec.mode,
      // Liveness only: on the bus, never in events.jsonl (see ProviderEvent 'heartbeat').
      onHeartbeat: (at, pid) => bus.emit({ kind: 'heartbeat', at, ...(pid === undefined ? {} : { pid }) }),
      ...(spec.env !== undefined ? { env: spec.env } : {}),
      onStdoutLine(line) {
        const raw = tryParseObject(line);
        if (raw === undefined) {
          // agy is supposed to emit only NDJSON on stdout. A bare line here
          // means either a stray print or a CLI change. Surface, do not crash.
          bus.emit({ kind: 'notice', at: nowIso(), level: 'warn', message: `agy stdout: ${truncate(line, 400).text}` });
          return;
        }
        if (raw['event'] === 'result') {
          const r = obj(raw, 'result');
          if (r !== undefined) resultEvent = r as AgyResultEvent;
          return;
        }
        publish(translator.onEvent(raw));
      },
      onStderr(chunk) {
        // agy writes human-facing warnings to stderr, most importantly the
        // auto-denial notice quoted at the top of this file. That notice is our
        // earliest operator-facing hint that a job is going to come back empty.
        const text = chunk.trim();
        if (text === '') return;
        const level: 'info' | 'warn' | 'error' =
          text.includes('auto-denied') || text.includes('denied') || text.includes('permission')
            ? 'warn'
            : 'info';
        bus.emit({ kind: 'notice', at: nowIso(), level, message: truncate(text, 800).text });
      },
    });

    startedAtMs = Date.now();

    let resolveResult: (r: JobResult) => void = () => {};
    const resultPromise = new Promise<JobResult>((resolve) => {
      resolveResult = resolve;
    });

    const exit = proc.exited.then<ExitInfo>(({ code, signal }) => ({
      code,
      signal,
      killReason: proc.killReason,
      stderr: stderrTailOf(proc),
    }));

    void exit.then((info) => {
      proc.closeLog();
      const final = buildResult({
        jobId,
        resultEvent,
        exit: info,
        startedAtMs,
        stateDir,
        denials: translator.denials,
        sawAnyToolCall: translator.stepsWereTools(),
        errorIsStale: translator.errorIsStale(),
      });
      const recovered = recoveredNotice(final, resultEvent);
      if (recovered !== undefined) bus.emit(recovered);
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

/** Convenience alias so `import { agy } from './providers/agy.js'` reads well. */
export const agy = agyProvider;
