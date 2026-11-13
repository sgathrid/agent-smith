/** Pure decision logic for native Claude Code subagent turn.step hooks driving agent-smith workers. */

export interface DriverToolUse {
  id: string;
  name: string;
  input: unknown;
  resultText?: string;
  isError?: boolean;
}

export interface DriverMessage {
  role: 'user' | 'assistant';
  text: string;
  toolUses: DriverToolUse[];
}

export interface DriverInput {
  messages: readonly DriverMessage[];
  toolPrefix: string;
  defaults: {
    provider?: string;
    model?: string;
    effort?: string;
    mode?: string;
  };
  agentName: string;
}

export type DriverStep = {
  text: string;
  tool?: { name: string; input: Record<string, unknown> };
};

export interface PromptHeaders {
  mode?: string;
  model?: string;
  effort?: string;
  cwd?: string;
  provider?: string;
}

export interface ParsedPrompt {
  headers: PromptHeaders;
  prompt: string;
}

const HEADER_RE = /^[ \t]*(mode|model|effort|cwd|provider)[ \t]*:[ \t]*(.+?)[ \t]*$/i;
const REMINDER_RE = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder\b[^>]*>/gi;
const COORDINATOR_MARKER = 'The coordinator sent a message while you were working:';
/** Engine reminders, with or without an id attribute: `<system-reminder id="…">…</system-reminder id="…">`. */
const ANY_REMINDER_RE = /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder\b[^>]*>/gi;

/** Text with the engine's reminder blocks removed, so headers and JSON are read from what the caller wrote. */
export function withoutReminders(text: string): string {
  return text.replace(ANY_REMINDER_RE, '').trim();
}

/** Parse optional leading header lines (`mode:`, `model:`, `effort:`, `cwd:`, `provider:`) from a task prompt. */
export function parseHeader(raw: string): ParsedPrompt {
  const lines = raw.split(/\r?\n/);
  const headers: PromptHeaders = {};
  let index = 0;

  while (index < lines.length) {
    const match = HEADER_RE.exec(lines[index]!);
    if (!match) break;
    const key = match[1]!.toLowerCase() as keyof PromptHeaders;
    const value = match[2]!.trim();
    if (!value) break;
    headers[key] = value;
    index++;
  }

  if (index === 0) return { headers, prompt: raw };

  while (index < lines.length && lines[index]!.trim() === '') index++;
  return { headers, prompt: lines.slice(index).join('\n') };
}

/** Extract coordinator SendMessage bodies delivered inside `<system-reminder>` user messages. */
export function coordinatorMessages(messages: readonly DriverMessage[]): string[] {
  const result: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'user' || !msg.text) continue;
    REMINDER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REMINDER_RE.exec(msg.text)) !== null) {
      const inner = match[1]!;
      const markerIdx = inner.indexOf(COORDINATOR_MARKER);
      if (markerIdx === -1) continue;
      const body = inner.slice(markerIdx + COORDINATOR_MARKER.length).trim();
      if (body) result.push(body);
    }
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  const clean = withoutReminders(text);
  try {
    return asRecord(JSON.parse(clean));
  } catch {
    // A tool result may carry text after its JSON: read the leading object.
    const start = clean.indexOf('{');
    if (start === -1) return null;
    let depth = 0; let inString = false; let escaped = false;
    for (let i = start; i < clean.length; i++) {
      const ch = clean[i]!;
      if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { return asRecord(JSON.parse(clean.slice(start, i + 1))); } catch { return null; }
      }
    }
    return null;
  }
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

/** Deterministic FNV-1a 32-bit hex suffix so worker names are unique-ish per prompt without I/O or randomness. */
function uniqueWorkerName(agentName: string, seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const base = (agentName.trim() || 'worker').slice(0, 60);
  const suffix = (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6);
  return `${base}-${suffix}`;
}

function handback(text: string, message: string): DriverStep {
  return { text, tool: { name: 'SubagentHandback', input: { message } } };
}

function formatActivity(value: unknown): string | null {
  if (typeof value === 'string') {
    const line = value.replace(/[\r\n]+/g, ' ').trim();
    return line || null;
  }
  const rec = asRecord(value);
  if (!rec) return null;
  for (const key of ['text', 'summary', 'tool', 'command']) {
    if (typeof rec[key] === 'string' && rec[key].trim()) {
      return rec[key].replace(/[\r\n]+/g, ' ').trim();
    }
  }
  return null;
}

/** How long each status call waits for the job to change: short enough that progress shows. */
export const WAIT_MS = 20_000;
/** Longest wait_ms `status` accepts (MAX_WAIT_MS in tool-defs.ts), used when a poll saw no change. */
export const MAX_STATUS_WAIT_MS = 60_000;

/** Decide whether the fallback status loop is done, and what wait_ms to pass next. */
export function statusPollState(statusData: Record<string, unknown>, changed: boolean): { done: boolean; waitMs: number } {
  const acc = asRecord(statusData.acceptance);
  const pendingChecks = acc?.pending === true;
  const running = statusData.status === 'running' || statusData.stillRunning === true;
  if (!running && !pendingChecks) return { done: true, waitMs: WAIT_MS };
  const idleOrPendingChecks = !changed || (statusData.waited === true && statusData.stillRunning === false && pendingChecks);
  return { done: false, waitMs: idleOrPendingChecks ? MAX_STATUS_WAIT_MS : WAIT_MS };
}

/** One line of what the worker is doing, from the concise status: phase, counts, latest step. */
export function formatProgress(statusData: Record<string, unknown>): string {
  const parts: string[] = [];
  const digest = asRecord(statusData.digest);
  if (typeof digest?.phase === 'string' && digest.phase.trim()) parts.push(digest.phase.trim());
  const count = (n: unknown, one: string, many: string) => (typeof n === 'number' && n > 0 ? `${n} ${n === 1 ? one : many}` : null);
  for (const c of [
    count(digest?.filesRead, 'file read', 'files read'),
    count(digest?.editedCount, 'file edited', 'files edited'),
    count(digest?.testRuns, 'test run', 'test runs'),
    count(statusData.toolCalls, 'tool call', 'tool calls'),
  ]) if (c) parts.push(c);
  const activity = formatActivity(statusData.lastActivity);
  // `step 12: read_file {"Path":"/a/b/c.ts"} (done)` -> `read_file c.ts`
  if (activity) parts.push(activity.replace(/^step \d+:\s*/, '').replace(/\s*\((?:done|active|error)\)$/, '').replace(/\{[^}]*"(?:Path|path|file_path|command|CommandLine)"\s*:\s*"([^"]*)"[^}]*\}?/, (_m, v: string) => v.split('/').pop() ?? v).slice(0, 100));
  if (parts.length > 0) return parts.join(' · ');
  const acceptance = asRecord(statusData.acceptance);
  return acceptance?.pending === true ? 'Waiting for acceptance checks…' : 'Waiting on worker…';
}

function formatAcceptanceLine(acceptance: Record<string, unknown> | null): string | null {
  if (!acceptance) return null;
  const state = acceptance.state;
  const passed = stringArray(acceptance.passed);
  const failed = stringArray(acceptance.failed);
  const total = passed.length + failed.length;

  if (state === 'accepted') {
    return total > 0 ? `Acceptance: accepted (${passed.length}/${total} checks)` : 'Acceptance: accepted';
  }
  if (state === 'rejected') {
    if (failed.length > 0) {
      return total > 0
        ? `Acceptance: rejected (${passed.length}/${total} checks; failed: ${failed.join(', ')})`
        : `Acceptance: rejected (failed: ${failed.join(', ')})`;
    }
    if (typeof acceptance.reason === 'string' && acceptance.reason.trim()) {
      return `Acceptance: rejected (${acceptance.reason.trim()})`;
    }
    return 'Acceptance: rejected';
  }
  return null;
}

function findPendingCoordinatorMessage(
  messages: readonly DriverMessage[],
  allTools: readonly DriverToolUse[],
  deliveryToolNames: readonly string[],
): string | null {
  const coordMsgs = coordinatorMessages(messages);
  if (coordMsgs.length === 0) return null;

  const steeredCounts = new Map<string, number>();
  for (const tool of allTools) {
    // A failed steer or resume did not deliver: the message is still pending.
    if (!deliveryToolNames.includes(tool.name) || tool.isError) continue;
    const prompt = asRecord(tool.input)?.prompt;
    if (typeof prompt === 'string') {
      steeredCounts.set(prompt, (steeredCounts.get(prompt) ?? 0) + 1);
    }
  }

  for (const msg of coordMsgs) {
    const count = steeredCounts.get(msg) ?? 0;
    if (count > 0) {
      steeredCounts.set(msg, count - 1);
      continue;
    }
    return msg;
  }
  return null;
}

/** '' when the agent's last line already said `line`. */
function unchanged(messages: readonly DriverMessage[], line: string): string {
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.text.trim() !== '');
  return last?.text.trim() === line ? '' : line;
}

/** Decide the next tool call (or SubagentHandback) for a subagent step from its conversation transcript. */
export function nextStep(input: DriverInput): DriverStep {
  const firstUser = input.messages.find((m) => m.role === 'user');
  if (!firstUser) {
    return handback('Missing task prompt.', 'Status: BLOCKED\nNo task prompt found.');
  }

  const parsed = parseHeader(withoutReminders(firstUser.text));
  const mode = parsed.headers.mode ?? input.defaults.mode ?? 'implement';
  const provider = parsed.headers.provider ?? input.defaults.provider;
  const model = parsed.headers.model ?? input.defaults.model;
  const effort = parsed.headers.effort ?? input.defaults.effort;
  const cwd = parsed.headers.cwd;

  const spawnName = `${input.toolPrefix}spawn_job`;
  const statusName = `${input.toolPrefix}status`;
  const steerName = `${input.toolPrefix}steer_job`;
  const resumeName = `${input.toolPrefix}resume_job`;
  const allTools = input.messages.flatMap((m) => m.toolUses);

  // Rule 1: No spawn_job call yet.
  const spawnTool = allTools.find((t) => t.name === spawnName);
  if (!spawnTool) {
    const spawnInput: Record<string, unknown> = {
      mode,
      prompt: parsed.prompt,
      name: uniqueWorkerName(input.agentName, firstUser.text),
    };
    if (provider) spawnInput.provider = provider;
    if (model) spawnInput.model = model;
    if (effort) spawnInput.effort = effort;
    if (cwd) spawnInput.cwd = cwd;

    const target = provider && model ? `${provider}/${model}` : provider || model || 'worker';
    return {
      text: `Starting ${target}…`,
      tool: { name: spawnName, input: spawnInput },
    };
  }

  // Rule 2: spawn_job failed or returned no jobId.
  const spawnData = parseJson(spawnTool.resultText);
  const spawnJobId = typeof spawnData?.jobId === 'string' && spawnData.jobId ? spawnData.jobId : null;
  if (spawnTool.isError || !spawnData || !spawnJobId) {
    const errText =
      (typeof spawnData?.error === 'string' && spawnData.error) ||
      (spawnTool.resultText ? withoutReminders(spawnTool.resultText) : "") ||
      'spawn_job returned no jobId';
    return handback('Worker failed to start.', `Status: BLOCKED\n${errText}`);
  }

  // Walk status calls chronologically, following jobId across steers.
  let jobId = spawnJobId;
  let lastStatusData: Record<string, unknown> = spawnData;
  let lastStatusError: string | null = null;
  let reportTool: DriverToolUse | null = null;

  // A spawn ack without a status is a job that just started.
  if (typeof lastStatusData.status !== 'string') lastStatusData = { ...lastStatusData, status: 'running' };

  for (const tool of allTools) {
    if ((tool.name === resumeName || tool.name === steerName) && !tool.isError) {
      // A resume (and a steer's continuation) runs as a new turn: wait on it again.
      const ack = parseJson(tool.resultText);
      if (tool.name === resumeName && typeof ack?.jobId === 'string' && ack.jobId) {
        jobId = ack.jobId; lastStatusData = { ...ack, status: 'running' }; reportTool = null;
      }
      continue;
    }
    if (tool.name !== statusName) continue;
    const toolInput = asRecord(tool.input);
    if (toolInput?.report_only === true) {
      if (toolInput.jobId === jobId || !toolInput.jobId) {
        if (tool.isError || parseJson(tool.resultText) === null) {
          lastStatusError = (tool.resultText ? withoutReminders(tool.resultText) : '') || 'could not read the report';
          continue;
        }
        reportTool = tool;
      }
      continue;
    }
    if (tool.isError) {
      lastStatusError = (tool.resultText ? withoutReminders(tool.resultText) : "") || 'status call failed';
      continue;
    }
    const data = parseJson(tool.resultText);
    if (!data) {
      lastStatusError = (tool.resultText ? withoutReminders(tool.resultText) : "") || 'status returned invalid JSON';
      continue;
    }
    lastStatusError = null;
    lastStatusData = data;
    if (typeof data.jobId === 'string' && data.jobId && data.jobId !== jobId) {
      jobId = data.jobId;
      reportTool = null;
    }
  }

  if (lastStatusError) {
    return handback('Worker status check failed.', `Status: BLOCKED\n${lastStatusError}`);
  }

  // Rule 3: an unhandled coordinator message. A running job is steered; a finished one is
  // resumed with it (a message that lands after the job ends must not be dropped).
  const pendingMsg = findPendingCoordinatorMessage(input.messages, allTools, [steerName, resumeName]);
  if (pendingMsg !== null) {
    return lastStatusData.status === 'running'
      ? { text: 'Forwarding coordinator message…', tool: { name: steerName, input: { worker: jobId, prompt: pendingMsg, delivery: 'queue' } } }
      : { text: 'Sending coordinator message as a follow-up…', tool: { name: resumeName, input: { worker: jobId, prompt: pendingMsg } } };
  }

  // Rule 4: Job is running or acceptance checks are still pending.
  const acceptance = asRecord(lastStatusData.acceptance);
  if (lastStatusData.status === 'running' || acceptance?.pending === true) {
    return {
      // A line only when progress changed: an unchanged poll adds nothing to the transcript.
      text: unchanged(input.messages, formatProgress(lastStatusData)),
      tool: { name: statusName, input: { jobId, wait_ms: WAIT_MS } },
    };
  }

  // Rule 5: Job is terminal and no report has been fetched for the current jobId yet.
  if (!reportTool) {
    return {
      text: 'Fetching worker report…',
      tool: { name: statusName, input: { jobId, report_only: true } },
    };
  }

  // Rule 6: Report has been fetched; hand back final result.
  const reportData = parseJson(reportTool.resultText);
  const rawReport = typeof reportData?.report === 'string' ? reportData.report.trimEnd() : '';
  const jobStatus =
    (typeof lastStatusData.status === 'string' && lastStatusData.status) ||
    (typeof reportData?.status === 'string' && reportData.status) ||
    'unknown';
  const failed = jobStatus !== 'succeeded';
  const errorText =
    (typeof lastStatusData.error === 'string' && lastStatusData.error) ||
    (typeof reportData?.error === 'string' && reportData.error) ||
    (reportTool.isError ? reportTool.resultText ?? '' : '');

  let message = rawReport;
  if (failed) {
    if (errorText && !message.includes(errorText)) {
      message = message ? `${message}\nError: ${errorText}` : errorText;
    }
    if (!message) message = `Worker ${jobStatus}.`;
    if (!/^Status:/i.test(message.trimStart())) {
      message = `Status: BLOCKED\n${message}`;
    }
  } else if (!message) {
    message = '(no report)';
  }

  const acceptanceLine = formatAcceptanceLine(acceptance);
  if (acceptanceLine) {
    message = `${message}\n${acceptanceLine}`;
  }

  return handback('Delivering worker report.', message);
}

/** The API view of an agent's conversation as the driver reads it: text, tool calls and their results paired by id. */
export function toDriverMessages(api: readonly { role: 'user' | 'assistant'; content: unknown }[]): DriverMessage[] {
  const out: DriverMessage[] = [];
  const byId = new Map<string, DriverMessage['toolUses'][number]>();
  for (const m of api) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content.filter(isObj) : [];
    const texts: string[] = [];
    const toolUses: DriverMessage['toolUses'] = [];
    for (const b of blocks) {
      if (b['type'] === 'text' && typeof b['text'] === 'string') texts.push(b['text']);
      else if (b['type'] === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
        const use = { id: b['id'], name: b['name'], input: b['input'] };
        toolUses.push(use); byId.set(b['id'], use);
      } else if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
        const use = byId.get(b['tool_use_id']);
        const c = b['content'];
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(isObj).map((x) => (typeof x['text'] === 'string' ? x['text'] : '')).join('') : '';
        if (use) Object.assign(use, { resultText: text, ...(b['is_error'] === true ? { isError: true } : {}) });
      }
    }
    out.push({ role: m.role, text: texts.join('\n'), toolUses });
  }
  return out;
}

export const HANDBACK = 'SubagentHandback';

/**
 * Whether this host takes a subagent's result through the SubagentHandback tool rather than
 * its final text: some harnesses say so in the agent's opening reminder. A handback call that
 * errored (no such tool) means it does not, so the agent never retries it.
 */
export function handbackByTool(messages: readonly DriverMessage[]): boolean {
  const failed = messages.some((m) => m.toolUses.some((t) => t.name === HANDBACK && t.isError === true));
  if (failed) return false;
  return messages.some((m) => m.role === 'user' && /delivered through SubagentHandback|Call SubagentHandback/.test(m.text));
}


const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A timeline event as the job's view.json records it (types/index.d.ts ActivityEvent). */
export type StepEvent =
  | { sequence: number; kind: 'assistant'; text: string }
  | { sequence: number; kind: 'tool'; tool: string; input: string; state: string };

/**
 * The worker's finished steps after `afterSequence`, one line each, the way a native subagent's
 * transcript lists its tool calls: `Read AGENTS.md`, `✗ Ran npm test`, and its own words.
 * A call still running is left for the next wake, so no step is printed twice.
 */
export function stepLines(events: readonly StepEvent[], afterSequence: number, label: (tool: string, input: string) => string): { lines: string[]; last: number } {
  const lines: string[] = [];
  let last = afterSequence;
  for (const ev of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (ev.sequence <= afterSequence) continue;
    if (ev.kind === 'tool' && ev.state === 'active') break;
    last = ev.sequence;
    if (ev.kind === 'assistant') {
      const text = ev.text.replace(/\s+/g, ' ').trim();
      if (text !== '') lines.push(text.length > 160 ? `${text.slice(0, 157)}…` : text);
      continue;
    }
    const phrase = label(ev.tool, ev.input);
    const line = phrase.charAt(0).toUpperCase() + phrase.slice(1);
    lines.push(ev.state === 'error' ? `✗ ${line}` : line);
  }
  return { lines, last };
}

/** Append `chunk` to `buffer` and split complete `\n` / `\r\n` lines, keeping any trailing partial line in `rest`. */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const data = buffer === '' ? chunk : buffer + chunk;
  let nl = data.indexOf('\n');
  if (nl === -1) return { lines: [], rest: data };
  const lines: string[] = [];
  let start = 0;
  while (nl !== -1) {
    const end = nl > start && data.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
    lines.push(data.slice(start, end));
    start = nl + 1;
    nl = data.indexOf('\n', start);
  }
  return { lines, rest: start < data.length ? data.slice(start) : '' };
}

export interface TailState {
  readonly jobId: string;
  readonly settled: boolean;
  readonly step: string | null;
}

/** Pure reducer for one parsed NDJSON record from `tail.js` (`step`, `job`, `settled`). */
export function applyTailRecord(state: TailState, record: unknown): TailState {
  if (!isObj(record)) {
    return state.step === null ? state : { jobId: state.jobId, settled: state.settled, step: null };
  }
  switch (record['kind']) {
    case 'step': {
      const step = typeof record['text'] === 'string' && record['text'] !== '' ? record['text'] : null;
      return { jobId: state.jobId, settled: state.settled, step };
    }
    case 'job': {
      const jobId = typeof record['jobId'] === 'string' && record['jobId'] !== '' ? record['jobId'] : state.jobId;
      return { jobId, settled: state.settled, step: null };
    }
    case 'settled': {
      const jobId = typeof record['jobId'] === 'string' && record['jobId'] !== '' ? record['jobId'] : state.jobId;
      return { jobId, settled: true, step: null };
    }
    default:
      return state.step === null ? state : { jobId: state.jobId, settled: state.settled, step: null };
  }
}
