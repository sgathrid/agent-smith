/**
 * providers/codex.ts — OpenAI Codex CLI adapter (`codex exec`).
 *
 * VERIFICATION LEVEL: HIGH. Every flag below was read out of `codex exec --help`
 * on codex-cli 0.160.1 on this machine, and the whole invocation was then run
 * live end to end. See the transcript at the bottom of this file header.
 *
 * ----------------------------------------------------------------------------
 * VERIFIED FLAGS (`codex exec --help`, v0.160.1)
 * ----------------------------------------------------------------------------
 *   codex exec [PROMPT]            non-interactive; "Use Codex non-interactively"
 *   --json                         "Print events to stdout as JSONL"
 *   -m, --model <MODEL>
 *   -C, --cd <DIR>                 working root, independent of our spawn cwd
 *   -s, --sandbox <read-only|workspace-write|danger-full-access>
 *   --add-dir <DIR>                widen the writable sandbox
 *   --skip-git-repo-check          "Allow running Codex outside a Git repository"
 *   --dangerously-bypass-approvals-and-sandbox
 *                                  "Skip all confirmation prompts and execute
 *                                   commands without sandboxing."
 *   --ephemeral                    do not persist session files
 *   --ignore-user-config           skip ~/.codex/config.toml (auth still used)
 *   -c key=value                   dotted-path config override, TOML-parsed
 *   -o, --output-last-message <FILE>  write final message to a file
 *   --output-schema <FILE>         JSON Schema for the final response
 *
 * VERIFIED EVENT SHAPES (live, codex exec --json):
 *
 *   {"type":"thread.started","thread_id":"01a113ee-..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
 *   {"type":"turn.completed","usage":{"input_tokens":22319,
 *       "cached_input_tokens":12288,"cache_write_input_tokens":0,
 *       "output_tokens":5,"reasoning_output_tokens":0}}
 *
 * NOTE ON THE USAGE SHAPE: codex reports `cached_input_tokens` and
 * `cache_write_input_tokens`, NOT `cache_read_tokens` as agy does. We map
 * cached -> cacheReadTokens and cache_write -> cacheWriteTokens. There is no
 * `total_tokens`; we leave it undefined rather than inventing one. (Note also
 * that codex's input_tokens already appears to INCLUDE cached tokens in this
 * run — 22319 in, 12288 cached. We report what the CLI says and let core/
 * decide the accounting policy; silently double-subtracting would be worse.)
 *
 * UNVERIFIED (documented in --help or upstream docs but NOT observed locally):
 *   - `item.started` and `item.updated`. `--help` does not enumerate event
 *     names and my live run produced no tool calls, so I never saw an in-flight
 *     tool event. The parser below HANDLES them if they exist and ignores them
 *     if they do not. See README "UNVERIFIED".
 *   - The exact `item.type` vocabulary for tools. I observed `agent_message`
 *     only. `command_execution`, `file_change`, `mcp_tool_call`, `reasoning`
 *     and `todo_list` appear in Codex's own docs and are handled defensively.
 *   - Whether `codex exec` ever exits 0 on a failed turn. Assumed it does not,
 *     but exit code is treated as corroboration, not proof — see buildResult.
 *
 * ----------------------------------------------------------------------------
 * TWO BEHAVIOURS THAT WILL BITE ANYONE WHO SPAWNS THIS NAIVELY
 * ----------------------------------------------------------------------------
 * 1. STDIN. With stdin as a pipe (or inherited from a non-tty parent), codex
 *    prints "Reading additional input from stdin..." and waits. The documented
 *    contract is "If stdin is piped and a prompt is also provided, stdin is
 *    appended as a `<stdin>` block". Our spawnWorker uses stdio[0]='ignore',
 *    which is a closed/absent fd rather than a pipe — so codex does not enter
 *    the stdin path and returns immediately. Verified. If you ever change
 *    stdio[0] to 'pipe', this adapter will hang forever.
 * 2. TRUSTED DIRECTORY. Outside a git repo, codex exits with
 *    "Not inside a trusted directory and --skip-git-repo-check was not
 *    specified." and writes NOTHING to stdout — not even an error event. So the
 *    absence of a result event is a real, reachable failure mode here and we
 *    map it to JobStatus 'malformed' with the stderr tail attached. Verified.
 *    We always pass --skip-git-repo-check for this reason: agent-smith runs
 *    workers in scratch dirs and vendored checkouts, and refusing to run
 *    because there is no .git is not a useful policy for an orchestrator.
 *
 * LIVE TRANSCRIPT (2026-10-06, codex-cli 0.160.1):
 *   $ codex exec --json --skip-git-repo-check -s read-only "Reply with exactly: OK" < /dev/null
 *   Reading additional input from stdin...            <- stderr, not stdout
 *   {"type":"thread.started","thread_id":"01a113ee-7022-7bf0-a5d8-e4c56fc61ce9"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
 *   {"type":"turn.completed","usage":{"input_tokens":22319,"cached_input_tokens":12288,
 *    "cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
 *   $ echo $?   -> 0
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
import { DEFAULT_DISCOVERY_TIMEOUT_MS, configDir, errMessage, readTextSafe, runCapture } from './discovery.ts';
import type { RunFn } from './discovery.ts';
import path from 'node:path';
import { noResultText, stderrClause, timedOutText } from './failure-text.ts';

export const CODEX_BINARY = process.env['AGENT_SMITH_CODEX_BIN'] ?? 'codex';

/** Sandbox modes accepted by -s. Verified from `codex exec --help`. */
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

/**
 * Map SpawnSpec.unrestricted onto a codex sandbox policy.
 *
 * WHY THIS IS A THREE-WAY CHOICE AND NOT A BOOLEAN
 * ------------------------------------------------
 * Codex has no "prompt for approval" headless mode worth using: it would stall
 * the worker forever waiting for a human who does not exist. So the only two
 * sane headless policies are "locked down" and "wide open".
 *
 *   unrestricted=true  -> --dangerously-bypass-approvals-and-sandbox.
 *     Verified help text: "Skip all confirmation prompts and execute commands
 *     without sandboxing." This is the honest expression of "I trust this
 *     worker in this directory", and it matches agy's
 *     --dangerously-skip-permissions and claude's
 *     --dangerously-skip-permissions, so all three providers mean the same
 *     thing when the pipeline says unrestricted.
 *
 *   unrestricted=false -> -s workspace-write.
 *     NOT read-only. A review or moderate stage that cannot write a scratch
 *     note cannot do its job, and workspace-write is codex's own default
 *     non-interactive posture. A caller that genuinely needs a read-only prober
 *     sets AGENT_SMITH_CODEX_SANDBOX=read-only (see configOverrides below),
 *     which overrides this mapping. Documented in the README as a deliberate
 *     asymmetry with agy, which has no equivalent knob.
 *
 * NOT USED: -s danger-full-access without the bypass flag. It grants the same
 * filesystem reach but leaves approval prompts in the loop, which in headless
 * mode means a stall. Combining them is strictly worse than the bypass alone.
 */
export function sandboxFor(unrestricted: boolean): { argv: string[]; note: string } {
  if (unrestricted) {
    return {
      argv: ['--dangerously-bypass-approvals-and-sandbox'],
      note: 'unrestricted -> bypass approvals and sandbox',
    };
  }
  return { argv: ['-s', 'workspace-write'], note: 'restricted -> sandbox workspace-write' };
}

/** Valid AGENT_SMITH_CODEX_SANDBOX value, if any. */
function envSandbox(): CodexSandbox | undefined {
  const v = process.env['AGENT_SMITH_CODEX_SANDBOX'];
  return v === 'read-only' || v === 'workspace-write' || v === 'danger-full-access' ? v : undefined;
}

/**
 * The single source of truth for codex sandbox flags, used by buildArgv AND
 * describeSandbox. Precedence: AGENT_SMITH_CODEX_SANDBOX env > unrestricted
 * (bypass) > readOnly (`-s read-only`) > workspace-write. On resume `-s` is not
 * exposed, so the same mode goes through `-c sandbox_mode="..."`.
 */
export function sandboxPlan(
  spec: Pick<SpawnSpec, 'unrestricted' | 'readOnly' | 'artifactPath'>,
  resuming = false,
): SandboxInfo {
  const mode = (m: CodexSandbox): SandboxInfo => {
    const flags = resuming ? ['-c', `sandbox_mode=${JSON.stringify(m)}`] : ['-s', m];
    return { sandbox: `codex ${flags.join(' ')}`, flags, readOnlyEnforced: m === 'read-only' };
  };
  const forced = envSandbox();
  if (forced !== undefined) {
    const info = mode(forced);
    return { ...info, sandbox: `${info.sandbox} (AGENT_SMITH_CODEX_SANDBOX)` };
  }
  if (spec.unrestricted) {
    const flags = sandboxFor(true).argv;
    return { sandbox: `codex ${flags[0]} (unrestricted)`, flags, readOnlyEnforced: false };
  }
  if (spec.readOnly === true && spec.artifactPath !== undefined) {
    // `-s read-only` blocks every write, `--add-dir` included (verified on codex
    // 0.162.1), so a pipeline stage could not write its artifact. A permission
    // profile that reads everything and writes exactly that file can; it cannot
    // be combined with `-s`.
    const artifact = path.resolve(spec.artifactPath);
    const flags = [
      '-c', `default_permissions=${JSON.stringify(ARTIFACT_PROFILE)}`,
      '-c', `permissions.${ARTIFACT_PROFILE}.filesystem=${tomlInlineTable({ ':root': 'read', [artifact]: 'write' })}`,
    ];
    return { sandbox: `codex read-only except the output artifact ${artifact}`, flags, readOnlyEnforced: true };
  }
  return mode(spec.readOnly === true ? 'read-only' : 'workspace-write');
}

const ARTIFACT_PROFILE = 'agent-smith-artifact';

function tomlInlineTable(entries: Record<string, string>): string {
  return `{${Object.entries(entries).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(', ')}}`;
}

/**
 * SpawnSpec has no field for arbitrary CLI config overrides, and inventing one
 * here would fork the shared interface while core/types.ts is still in flight.
 * So: pass through the two config overrides that actually matter, read from the
 * environment with an AGENT_SMITH_ prefix. Documented in the README.
 */
function configOverrides(): string[] {
  const argv: string[] = [];
  const model = process.env['AGENT_SMITH_CODEX_MODEL'];
  // -c model="x" — note the value is TOML-parsed, so a bare number would become
  // a TOML integer. Model ids are never numeric, so a plain string is safe.
  if (model !== undefined && model !== '') argv.push('-c', `model="${model}"`);
  return argv;
}

/**
 * Build the exact argv for one codex worker.
 *
 * ORDER: `codex exec` must come first (it is the subcommand), then flags, then
 * the prompt as a trailing positional. Verified: `codex exec [OPTIONS] [PROMPT]`.
 *
 * The prompt is a positional argument, NOT attached to a flag and NOT stdin.
 * That is the difference from agy, whose `--print` CONSUMES the next token when
 * separated by a space — which is why agy needs the attached form and codex
 * does not. Verified live with a multi-word prompt.
 */
export function buildArgv(spec: SpawnSpec): string[] {
  const resuming = spec.conversation !== undefined && spec.conversation !== '';
  const argv: string[] = resuming
    ? ['exec', 'resume', spec.conversation!]
    : ['exec'];

  // Verified: "--json  Print events to stdout as JSONL". Without it codex prints
  // human-formatted prose and we would have nothing to parse.
  argv.push('--json');

  // Verified necessary outside a git repo; see header note 2.
  argv.push('--skip-git-repo-check');

  // `exec resume --help` does not expose -C; resumed sessions retain their
  // original working directory. New sessions get an explicit root.
  if (!resuming) argv.push('-C', spec.cwd);

  if (spec.model !== undefined && spec.model !== '') argv.push('--model', spec.model);

  if (spec.effort !== undefined && spec.effort !== '') {
    const supported = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    if (!supported.includes(spec.effort)) {
      throw new RangeError(`codex does not support effort '${spec.effort}'; expected one of ${supported.join(', ')}`);
    }
    // Codex exposes reasoning effort as config, not a dedicated exec flag.
    // `-c` applies to both exec and exec resume (verified with installed CLI help).
    argv.push('-c', `model_reasoning_effort=${JSON.stringify(spec.effort)}`);
  }

  // The prompt goes LAST so a prompt that begins with "-" cannot be mistaken
  // for a flag. (`--` would be the other fix; trailing positional is what the
  // help text documents and what I verified.)
  if (resuming && (spec.addDirs?.length ?? 0) > 0) {
    throw new RangeError('codex exec resume does not support --add-dir; remove addDirs or start a new session');
  }
  for (const dir of resuming ? [] : spec.addDirs ?? []) {
    argv.push('--add-dir', dir);
  }

  // Resume omits -s from its help but accepts generic -c; sandboxPlan handles both.
  argv.push(...sandboxPlan(spec, resuming).flags);
  argv.push(...configOverrides());

  argv.push(spec.prompt);
  return argv;
}

// ---------------------------------------------------------------------------
// Event translation
// ---------------------------------------------------------------------------

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

function toTokenUsage(u: CodexUsage | undefined): TokenUsage | undefined {
  if (u === undefined) return undefined;
  const out: TokenUsage = {};
  if (u.input_tokens !== undefined) out.inputTokens = u.input_tokens;
  if (u.output_tokens !== undefined) out.outputTokens = u.output_tokens;
  if (u.reasoning_output_tokens !== undefined) out.thinkingTokens = u.reasoning_output_tokens;
  // codex names its cache-read counter `cached_input_tokens`. Mapping it to the
  // same field agy calls cache_read_tokens is what lets core/ total them
  // without caring which provider a row came from.
  if (u.cached_input_tokens !== undefined) out.cacheReadTokens = u.cached_input_tokens;
  if (u.cache_write_input_tokens !== undefined) out.cacheWriteTokens = u.cache_write_input_tokens;
  // No total_tokens from codex. Deliberately left undefined — see header.
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Codex item types that represent a tool call, and the label we show for each.
 *
 * ONLY `agent_message` is VERIFIED (observed live). The rest come from Codex's
 * public docs and are mapped defensively: an unknown item type falls through to
 * a generic tool activity rather than being dropped, so progress never silently
 * disappears because the CLI added a type.
 */
const KNOWN_ITEM_TYPES = new Set([
  'agent_message',
  'reasoning',
  'command_execution',
  'file_change',
  'mcp_tool_call',
  'web_search',
  'todo_list',
  'error',
]);

/** Item types that are NOT tool calls and must not become activities. */
const NON_TOOL_ITEM_TYPES = new Set(['agent_message', 'reasoning', 'todo_list']);

interface CodexTranslator {
  onEvent(raw: Record<string, unknown>): ProviderEvent[];
  threadId?: string;
  sawTurnCompleted: boolean;
  error?: string;
  finalText: string;
  usage?: TokenUsage;
}

/**
 * Incremental step counter.
 *
 * WHY NOT THE item.id: `item_0` is per-turn, not per-job — a second turn resets
 * numbering. Our ProviderEvent.activity.stepIndex must be monotonic within a
 * job because core/ uses it as the activity key. So we mint our own.
 */
export function createCodexTranslator(maxChars: number): CodexTranslator {
  let step = 0;
  const state: CodexTranslator = {
    sawTurnCompleted: false,
    finalText: '',
    onEvent: () => [],
  };
  /** item.id -> stepIndex, so item.started/completed pair up. */
  const itemStep = new Map<string, number>();
  /** item.id -> tool label, for the DONE event (the START may be absent). */
  const itemTool = new Map<string, string>();

  state.onEvent = (raw: Record<string, unknown>): ProviderEvent[] => {
    const out: ProviderEvent[] = [];
    const type = str(raw, 'type');
    const at = nowIso();

    if (type === 'thread.started') {
      // thread_id is codex's resume handle — the SpawnSpec.conversation value for
      // a follow-up run. Recorded on the event AND on the translator so it can
      // end up in JobResult.raw.
      const threadId = str(raw, 'thread_id');
      if (threadId !== undefined) state.threadId = threadId;
      const ev: ProviderEvent = { kind: 'started', at, raw };
      if (threadId !== undefined) ev.conversationId = threadId;
      const m = str(raw, 'model');
      if (m !== undefined) ev.model = m;
      out.push(ev);
      return out;
    }

    if (type === 'turn.started') {
      out.push({ kind: 'notice', at, level: 'info', message: 'codex turn started', raw });
      return out;
    }

    if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
      const item = obj(raw, 'item');
      if (item === undefined) return out;
      const itemId = str(item, 'id') ?? `anon-${step}`;
      const itemType = str(item, 'type') ?? 'unknown';

      // An item type we have never heard of. Not an error: surface it, do not
      // silently drop it. This is the whole reason the translation is a
      // whitelist-of-behaviour rather than a whitelist-of-types.
      if (!KNOWN_ITEM_TYPES.has(itemType)) {
        out.push({
          kind: 'notice',
          at,
          level: 'info',
          message: `codex emitted unrecognised item type "${itemType}"`,
          raw: item,
        });
        return out;
      }

      // Assistant prose.
      if (itemType === 'agent_message') {
        const text = str(item, 'text');
        if (text !== undefined && text !== '') {
          if (state.finalText !== '') state.finalText += '\n';
          state.finalText += text;
          out.push({ kind: 'text', at, text, stream: 'assistant' });
        }
        return out;
      }

      // Reasoning. codex does not stream reasoning text in the JSONL we verified,
      // only a token count in usage, so there is nothing to emit here beyond a
      // notice. Kept so the branch is explicit rather than accidental.
      if (itemType === 'reasoning') {
        const summary = preview(item['summary'], maxChars);
        if (summary !== undefined) {
          out.push({ kind: 'text', at, text: summary.text, stream: 'thinking' });
        }
        return out;
      }

      if (itemType === 'todo_list') {
        out.push({ kind: 'notice', at, level: 'info', message: 'codex updated its todo list', raw: item });
        return out;
      }

      if (NON_TOOL_ITEM_TYPES.has(itemType)) return out;

      // ---- tool-ish items ----------------------------------------------------
      const tool = itemTool.get(itemId) ?? str(item, 'command') ?? itemType;
      if (!itemTool.has(itemId)) itemTool.set(itemId, tool);

      // Command output arrives as `aggregated_output` / `output` on the item.
      // The parameter shape differs per item type, so preview the whole item
      // minus the id and hand it to the truncation helper. Better a slightly
      // noisy preview than no visibility into what the worker ran.
      const inputPreview =
        itemType === 'command_execution' ? preview(item['command'], maxChars) : preview(item['input'], maxChars);
      const outputPreview = preview(item['aggregated_output'] ?? item['output'], maxChars);

      if (type === 'item.started') {
        const idx = step++;
        itemStep.set(itemId, idx);
        const ref: ActivityRef = { stepIndex: idx, tool };
        if (inputPreview !== undefined) ref.input = inputPreview.text;
        if (inputPreview?.truncated === true) ref.truncated = true;
        out.push({ kind: 'activity-start', at, activity: ref });
        return out;
      }

      // item.updated: incremental progress for the same item.
      if (type === 'item.updated') {
        const idx = itemStep.get(itemId);
        if (idx === undefined) return out;
        const ref: ActivityRef = { stepIndex: idx, tool };
        if (inputPreview !== undefined) ref.input = inputPreview.text;
        if (outputPreview !== undefined) {
          ref.output = outputPreview.text;
          if (outputPreview.truncated) ref.truncated = true;
        }
        out.push({ kind: 'activity-update', at, activity: ref });
        return out;
      }

      // item.completed: terminal.
      const idx = itemStep.get(itemId) ?? step++;
      itemStep.set(itemId, idx);

      // codex item status field: UNVERIFIED name/shape. We read a few plausible
      // spellings and fall back to "done", because a completed item that
      // carries an explicit failure must not render as green.
      const itemStatus = str(item, 'status') ?? str(item, 'state');
      const exitCode = itemType === 'command_execution' ? num(item, 'exit_code') : undefined;
      const itemResult = obj(item, 'result');
      const explicitError =
        itemType === 'error' || itemStatus === 'failed' || itemStatus === 'error' ||
        item['isError'] === true || item['is_error'] === true || item['error'] != null ||
        itemResult?.['isError'] === true || itemResult?.['is_error'] === true ||
        (exitCode !== undefined && exitCode !== 0);
      let status: ActivityStatus = explicitError ? 'error' : 'done';

      // A codex tool call that needs approval it cannot get is the same failure
      // shape as agy's soft denial: the work silently did not happen. We do not
      // have a verified codex denial field, but the message text is stable
      // enough to detect, and mis-rendering this as success is the expensive
      // error. UNVERIFIED — see README.
      const error = obj(item, 'error');
      const denialReason = str(item, 'decision') ?? str(item, 'approval_status') ?? str(error, 'type');
      const messages = [str(error, 'message'), str(item, 'message')].filter((m) => m !== undefined).map((m) => m.toLowerCase());
      const denied = item['permission_denied'] === true || item['denied'] === true ||
        itemStatus === 'denied' || itemStatus === 'rejected' || itemStatus === 'declined' ||
        (denialReason !== undefined && /^(?:denied|rejected|declined|approval_denied|permission_denied)$/i.test(denialReason)) ||
        messages.some((m) => /(?:permission|approval).{0,50}(?:denied|rejected)|(?:denied|rejected).{0,50}(?:permission|approval)|(?:rejected|declined) by (?:the )?user/.test(m));
      if (denied) status = 'denied';

      const ref: ActivityRef = { stepIndex: idx, tool };
      ref.toolCallId = itemId;
      if (inputPreview !== undefined) ref.input = inputPreview.text;
      if (outputPreview !== undefined) {
        ref.output = outputPreview.text;
        if (outputPreview.truncated) ref.truncated = true;
      }
      if (denied) ref.denied = true;

      const ev: ProviderEvent = { kind: 'activity-end', at, activity: ref, status };
      const dur = num(item, 'duration_ms');
      if (dur !== undefined) ev.durationSeconds = dur / 1000;
      out.push(ev);
      return out;
    }

    if (type === 'turn.completed') {
      state.sawTurnCompleted = true;
      const usage = toTokenUsage(obj(raw, 'usage') as CodexUsage | undefined);
      if (usage !== undefined) {
        state.usage = usage;
        out.push({ kind: 'usage', at, usage });
      }
      return out;
    }

    if (type === 'turn.failed') {
      // UNVERIFIED: not observed locally, but it is the shape codex's docs
      // describe for a failed turn. Handled so a failure is not mistaken for
      // "the stream just ended".
      state.error = str(obj(raw, 'error'), 'message') ?? 'codex turn failed';
      out.push({
        kind: 'notice',
        at,
        level: 'error',
        message: state.error,
        raw,
      });
      return out;
    }

    if (type === 'error') {
      // `error` may be an object (codex's error envelope) or a bare string,
      // depending on the event. Try both rather than assume one shape.
      const e = obj(raw, 'error');
      const eString = typeof raw['error'] === 'string' ? (raw['error'] as string) : undefined;
      const message = str(e, 'message') ?? eString ?? str(raw, 'message') ?? 'codex reported an error';
      state.error = message;
      out.push({
        kind: 'notice',
        at,
        level: 'error',
        message,
        raw,
      });
      return out;
    }

    return out;
  };

  return state;
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

function buildResult(args: {
  jobId: string;
  startedAtMs: number;
  stateDir: string;
  exit: ExitInfo;
  tx: CodexTranslator;
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
    error = timedOutText(durationMs);
  } else if (!tx.sawTurnCompleted) {
    // The reachable case in practice is the untrusted-directory refusal, which
    // writes NOTHING to stdout and prints only to stderr. Guessing 'success'
    // here would be a lie.
    status = exit.code === 0 ? 'malformed' : 'error';
    // Usual causes: an untrusted directory, an auth failure, or an output-format change.
    error = tx.error ?? noResultText(exit);
  } else if (exit.code !== 0) {
    // turn.completed arrived but the process still failed. Corroboration wins.
    status = 'error';
    error = tx.error ?? `exited ${exit.code}${stderrClause(exit.stderr)}`;
  } else {
    status = 'success';
  }

  const out: JobResult = {
    jobId,
    provider: 'codex',
    ok: status === 'success',
    status,
    exitCode: exit.code,
    signal: exit.signal,
    // codex has no single "response" field; the concatenated agent_message items
    // are the equivalent. If there were none, this is legitimately "".
    response: tx.finalText,
    durationMs,
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt,
    stateDir,
  };
  if (error !== undefined) out.error = error;
  if (tx.usage !== undefined) out.usage = tx.usage;
  if (tx.threadId !== undefined) out.raw = { threadId: tx.threadId };
  return out;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Codex home: AGENT_SMITH_CODEX_HOME, then CODEX_HOME, then ~/.codex. */
export function codexHome(): string {
  return configDir(['AGENT_SMITH_CODEX_HOME', 'CODEX_HOME'], '.codex');
}

/**
 * Extract ONLY the `models` array from either `codex debug models` output or
 * models_cache.json. Nothing else (notably `identity`) is passed through.
 */
export function parseCodexModels(text: string): ModelInfo[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const list = (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return undefined;
  const out: ModelInfo[] = [];
  for (const m of list) {
    if (m === null || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    if (typeof r['slug'] !== 'string' || r['slug'] === '') continue;
    const levels = Array.isArray(r['supported_reasoning_levels']) ? r['supported_reasoning_levels'] : [];
    const efforts: string[] = [];
    for (const l of levels) {
      const e = typeof l === 'string' ? l : (l as { effort?: unknown } | null)?.effort;
      if (typeof e === 'string' && e !== '' && !efforts.includes(e)) efforts.push(e);
    }
    const info: ModelInfo = {
      id: r['slug'],
      label: typeof r['display_name'] === 'string' && r['display_name'] !== '' ? r['display_name'] : r['slug'],
      efforts,
    };
    if (typeof r['default_reasoning_level'] === 'string' && r['default_reasoning_level'] !== '') {
      info.defaultEffort = r['default_reasoning_level'];
    }
    out.push(info);
  }
  return out;
}

/** Top-level `key = "value"` pairs of a config.toml (stops at the first [table]). */
export function parseTomlTopLevel(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/);
    if (m) out[m[1]!] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/** Lazy, never throws. `run` and `home` are injectable for tests. */
export async function listCodexModels(
  run: RunFn,
  options?: ListModelsOptions,
  home: string = codexHome(),
): Promise<ModelCatalog> {
  const cat: ModelCatalog = {
    provider: 'codex',
    models: [],
    defaultSource: 'unknown',
    source: 'live',
    stale: false,
    verified: true,
  };
  try {
    let error: string | undefined;
    let models: ModelInfo[] | undefined;
    const r = await run(CODEX_BINARY, ['debug', 'models'], options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
    if (r.error === undefined) models = parseCodexModels(r.stdout);
    if (models === undefined || models.length === 0) {
      error = r.error ?? '`codex debug models` returned no models';
      const cached = readTextSafe(path.join(home, 'models_cache.json'));
      const fromCache = cached === undefined ? undefined : parseCodexModels(cached);
      if (fromCache !== undefined && fromCache.length > 0) {
        models = fromCache;
        cat.source = 'cache';
        // The live listing failed, so this is last-known data: callers must not
        // reject unknown ids against it.
        cat.stale = true;
        cat.error = `live listing failed (${error}); using ~/.codex/models_cache.json`;
      } else {
        models = [];
      }
    }
    cat.models = models;
    if (models.length === 0) cat.error = error;
    const cfgText = readTextSafe(path.join(home, 'config.toml'));
    if (cfgText !== undefined) {
      const cfg = parseTomlTopLevel(cfgText);
      if (cfg['model']) cat.defaultModel = cfg['model'];
      if (cfg['model_reasoning_effort']) cat.defaultEffort = cfg['model_reasoning_effort'];
      if (cat.defaultModel !== undefined || cat.defaultEffort !== undefined) cat.defaultSource = 'harness-config';
    }
  } catch (e) {
    cat.error = errMessage(e);
  }
  return cat;
}

/** Default model/effort from <home>/config.toml. Sync file read only. */
export function codexHarnessDefaults(home: string = codexHome()): { model?: string; effort?: string } {
  const cfgText = readTextSafe(path.join(home, 'config.toml'));
  if (cfgText === undefined) return {};
  const cfg = parseTomlTopLevel(cfgText);
  const out: { model?: string; effort?: string } = {};
  if (cfg['model']) out.model = cfg['model'];
  if (cfg['model_reasoning_effort']) out.effort = cfg['model_reasoning_effort'];
  return out;
}

/** Known model discovery noise does not describe the outcome of a worker turn. */
export function codexStderrLevel(text: string): 'info' | 'warn' {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const refreshTimeout = /^(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+)?(?:ERROR\s+)?(?:(?:codex_models_manager::manager|codex_core::models_manager):\s+)?failed to refresh available models: request timed out\.?$/i;
  if (lines.length > 0 && lines.every(line => refreshTimeout.test(line))) return 'info';
  return /not inside a trusted directory|no such file|error/i.test(text) ? 'warn' : 'info';
}

export const codexProvider: Provider = {
  name: 'codex',
  harnessDefaults: () => codexHarnessDefaults(),

  async available(): Promise<boolean> {
    try {
      return await binaryOnPath(CODEX_BINARY);
    } catch {
      return false;
    }
  },

  describeSandbox: (spec) => sandboxPlan(spec),

  listModels: (options) => listCodexModels(runCapture, options),

  async spawn(spec: SpawnSpec): Promise<WorkerHandle> {
    const jobId = spec.jobId ?? newJobId();
    const stateDir = writeStateDir('codex', jobId, spec.stateDir);
    const argv = buildArgv(spec);
    writeArgv(stateDir, argv, spec.cwd);

    const maxChars = spec.maxOutputChars ?? 2000;
    const bus = createEventBus();
    const tx = createCodexTranslator(maxChars);

    const publish = (events: ProviderEvent[]): void => {
      for (const e of events) {
        bus.emit(e);
        appendEventLog(stateDir, e);
      }
    };

    const startedAtMs = Date.now();

    const proc = await spawnWorker({
      provider: 'codex',
      binary: CODEX_BINARY,
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
            message: `codex stdout (non-JSON): ${truncate(line, 400).text}`,
          });
          return;
        }
        publish(tx.onEvent(raw));
      },
      onStderr(chunk) {
        const text = chunk.trim();
        if (text === '') return;
        // "Not inside a trusted directory..." is the single most useful line
        // codex emits and it is INFO-level, not an error — but it means the job
        // is dead. Level is about presentation, not job status.
        const level = codexStderrLevel(text);
        bus.emit({ kind: 'notice', at: nowIso(), level, message: truncate(text, 800).text });
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

export const codex = codexProvider;
