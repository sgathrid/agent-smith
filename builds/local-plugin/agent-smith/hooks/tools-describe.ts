/** Tool name + parameters → a short human phrase. Shared by the legacy reader
 * (jobs.ts) and the progress digest (progress.ts); never raw tool output.
 */

import { oneLine } from './text.ts';

/**
 * agy tool name + parameters → a short "what is it doing" phrase.
 *
 * Measured against real agy tool calls:
 *   run_command           { CommandLine }
 *   view_file             { AbsolutePath }
 *   write_to_file         { TargetFile }
 *   replace_file_content  { TargetFile }
 *   grep_search           { Query | Pattern }
 *   list_dir              { AbsolutePath }
 *   call_mcp_tool         { ServerName, ToolName, Arguments }
 *   manage_task           { Action, TaskId }
 *   schedule              { DurationSeconds, Prompt }
 *
 * TERMINAL-UI.md §Motion: "terse tool descriptions, never raw output". Every
 * branch truncates at the source; there is no code path that hands raw tool
 * output to a list row.
 */
export function describeTool(tool: string, params: Record<string, unknown>): string {
  const str = (k: string): string => {
    const v = params[k];
    return typeof v === 'string' ? oneLine(v) : '';
  };

  switch (tool) {
    case 'run_command':
      return humanCommand(str('CommandLine'));
    case 'view_file':
      return `reading ${basename(str('AbsolutePath'))}`;
    case 'write_to_file':
      // Same verb as replace_file_content, deliberately: from the reader's side
    // there is no difference between "created" and "changed" a file, and the
    // tool name is an implementation detail of agy, not of the work.
    case 'replace_file_content':
      return `editing ${basename(str('TargetFile'))}`;
    case 'grep_search':
      return `searching ${basename(str('Query') || str('Pattern'))}`;
    case 'list_dir':
      return `listing ${basename(str('AbsolutePath'))}`;
    case 'call_mcp_tool':
      return `${str('ToolName') || str('ServerName') || 'an mcp tool'}`;
    case 'manage_task':
      return `task ${str('Action') || 'update'}`;
    case 'schedule':
      return `waiting ${str('DurationSeconds') || '?'}s`;
    default:
      return SWARM_TOOLS.has(tool) ? labelSwarmCall(tool, params) : `using ${oneLine(tool)}`;
  }
}

/**
 * A shell command → what a person would say they are doing.
 *
 * The corpus is 76 run_command records and the raw line is what put
 * `cargo tree -p renyi-mcp -e features -i` on a status row: real, precise, and
 * unreadable at a glance. So the COMMON commands get a verb, and anything else
 * gets a TRIMMED form rather than an invented one.
 *
 * The fallback rule is the important half. When there is no mapping this shows
 * the command's first two words and stops — `git rebase --onto main feature/x`
 * becomes `git rebase`, not `preparing the branch`. Inventing a plausible verb
 * for an arbitrary command would be a lie the user cannot check, and it would be
 * a lie in the one field the band exists to be trustworthy about. `cargo tree`
 * is in the table because it appears in the corpus four times, not because it
 * is universally understood.
 */
export function humanCommand(cmd: string): string {
  const line = oneLine(cmd);
  if (line === '') return 'running a command';

  // A pipeline or a `&&` chain is several actions; the first is what the job is
  // doing now, and the rest are what it will do after. `cargo test 2>&1 | tail`
  // is "running tests", not "running a shell pipeline".
  const first = line.split(/\s*(?:&&|\|\||;|\||&&)\s*/)[0] ?? line;

  const words = first.split(' ').filter((w) => !w.startsWith('-'));
  const prog = basename(words[0] ?? '');
  const sub = words[1] ?? '';

  switch (prog) {
    case 'cargo':
    case 'rustup':
      switch (sub) {
        case 'test':
        case 'nextest':
          return 'running tests';
        case 'clippy':
          return 'linting';
        case 'fmt':
          return 'formatting';
        case 'build':
          return 'building';
        case 'check':
          return 'checking the build';
        case 'tree':
          return 'inspecting dependencies';
        case 'doc':
          return 'reading the docs';
        case 'run':
          return `running ${basename(words[2] ?? 'the binary')}`;
        default:
          break;
      }
      break;
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      // `npm test` and `npm run test` are the same intent; `npm run build` is
      // building. Anything else under `npm run` is somebody's script and we do
      // not know what it does.
      if (sub === 'test') return 'running tests';
      if (sub === 'run' && (words[2] === 'build')) return 'building';
      if (sub === 'run' && (words[2] === 'test')) return 'running tests';
      return `running ${prog} scripts`;
    case 'python':
    case 'python3':
      return 'running a script';
    case 'git':
      if (sub === 'status' || sub === 'diff' || sub === 'log' || sub === 'show') return 'checking git';
      if (sub === 'commit') return 'committing';
      if (sub === 'push') return 'pushing';
      return `git ${sub}`.trim();
    case 'grep':
    case 'rg':
    case 'ag':
      return 'searching';
    case 'graft':
      return `navigating the graph`;
    default:
      break;
  }

  // The honest fallback: the command's name, and at most one argument.
  // `/Library/Developer/CommandLineTools/usr/bin/git` reads as `git`.
  const trimmed = [prog, ...words.slice(1, 2)].join(' ');
  return trimmed === '' ? 'running a command' : trimmed;
}

/** Last path segment only. */
export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/**
 * `input_preview` is a JSON STRING of the tool parameters, possibly truncated.
 * A truncated JSON string does not parse, so this never throws — a failure just
 * means we have no parameters and the caller falls back to the bare tool name.
 */
export function parseInputPreview(preview: string | null | undefined): Record<string, unknown> {
  if (!preview) return {};
  try {
    const v: unknown = JSON.parse(preview);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The activity phrase for a job, from its most recent activity record.
 * Exported because the band and the pane both call it and must agree.
 */
export function describeActivity(tool: string | null, inputPreview: string | null): string {
  if (!tool) return '';
  return describeTool(tool, parseInputPreview(inputPreview));
}

export const SWARM_TOOLS: ReadonlySet<string> = new Set(['swarm', 'read_board', 'post_message', 'swarm_wait', 'update_steps']);

export function teamPoll(tool: string, input: string | null | undefined): 'status' | 'board' | 'wait' | null {
  if (tool === 'read_board') return 'board';
  if (tool === 'swarm_wait') return 'wait';
  return tool === 'swarm' && rawString(input ?? '', 'action') === 'status' ? 'status' : null;
}

function rawString(raw: string, key: string): string {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
  if (!m) return '';
  try { return oneLine(JSON.parse(`"${m[1]}"`) as string); } catch { return oneLine(m[1]!); }
}

function outputBody(output: string | null | undefined): string {
  return (output ?? '').trim();
}

function parsed(body: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(body);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function inField(params: Record<string, unknown>, raw: string, key: string): string {
  const v = params[key];
  return typeof v === 'string' && v.trim() !== '' ? oneLine(v) : rawString(raw, key);
}

function outField(body: string, json: Record<string, unknown> | null, key: string): string {
  const v = json?.[key];
  return typeof v === 'string' && v.trim() !== '' ? oneLine(v) : rawString(body, key);
}

function boardEntries(body: string): { seqs: number[]; agents: string[]; empty: boolean } {
  const json = parsed(body);
  const messages = json?.['messages'];
  const pairs: Array<[number, string]> = [];
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (m && typeof m === 'object') {
        const { seq, agent } = m as Record<string, unknown>;
        if (typeof seq === 'number') pairs.push([seq, typeof agent === 'string' ? oneLine(agent) : '']);
      }
    }
    return { seqs: pairs.map((p) => p[0]), agents: unique(pairs.map((p) => p[1])), empty: messages.length === 0 };
  }
  for (const m of body.matchAll(/"seq"\s*:\s*(\d+)\s*,\s*"agent"\s*:\s*"([^"]*)"/g)) pairs.push([Number(m[1]), m[2]!]);
  return { seqs: pairs.map((p) => p[0]), agents: unique(pairs.map((p) => p[1])), empty: /"messages"\s*:\s*\[\s*\]/.test(body) };
}

const unique = (xs: readonly string[]): string[] => [...new Set(xs.filter((x) => x !== ''))];

export function boardRange(output: string | null | undefined): string | null {
  const { seqs } = boardEntries(outputBody(output));
  if (seqs.length === 0) return null;
  const lo = Math.min(...seqs);
  const hi = Math.max(...seqs);
  return lo === hi ? `#${lo}` : `#${lo}–#${hi}`;
}

function memberStates(body: string): string[] | null {
  const json = parsed(body);
  const members = json?.['members'];
  const states: string[] = [];
  if (Array.isArray(members)) {
    for (const m of members) {
      if (!m || typeof m !== 'object') continue;
      const { role, state } = m as Record<string, unknown>;
      if (role !== 'coordinator' && typeof state === 'string') states.push(state);
    }
  } else {
    for (const m of body.matchAll(/\{[^{}]*\}/g)) {
      if (/"role"\s*:\s*"coordinator"/.test(m[0])) continue;
      const s = /"state"\s*:\s*"([^"]*)"/.exec(m[0]);
      if (s) states.push(s[1]!);
    }
  }
  return states.length === 0 ? null : states;
}

function teamSummary(states: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const s of states) counts.set(s, (counts.get(s) ?? 0) + 1);
  const order = ['working', 'waiting'];
  const keys = [...order.filter((k) => counts.has(k)), ...[...counts.keys()].filter((k) => !order.includes(k))];
  return keys.map((k) => `${counts.get(k)} ${k}`).join(' · ');
}

export function labelSwarmCall(tool: string, params: Record<string, unknown>, raw = '', output = ''): string {
  const body = outputBody(output);
  const json = parsed(body);
  const inp = (k: string): string => inField(params, raw, k);
  switch (tool) {
    case 'swarm': {
      const action = inp('action');
      const name = inp('name');
      switch (action) {
        case 'add': {
          const made = outField(body, json, 'name');
          if (made === '') return name === '' ? 'adding agent' : `adding ${name}`;
          const model = outField(body, json, 'model_display_name');
          return `added ${made}${model === '' ? '' : ` (${model})`}`;
        }
        case 'status': {
          const states = memberStates(body);
          return states === null ? 'checking team' : `checked team (${teamSummary(states)})`;
        }
        case 'models': return 'listed models';
        case 'title': { const t = inp('title'); return t === '' ? 'named team' : `named team "${t}"`; }
        case 'kill': return name === '' ? 'stopped an agent' : `stopped ${name}`;
        case 'model': {
          const model = inp('model');
          return `switched ${name === '' ? 'an agent' : name}${model === '' ? '' : ` to ${model}`}`;
        }
        default: return action === '' ? 'using swarm' : `swarm ${action}`;
      }
    }
    case 'read_board': {
      if (body === '') return 'reading board';
      const { seqs, agents, empty } = boardEntries(body);
      if (seqs.length === 0) return empty ? 'board: nothing new' : 'reading board';
      const shown = agents.slice(0, 3).join(', ');
      return `board ${boardRange(output)}${shown === '' ? '' : ` · ${shown}${agents.length > 3 ? ` +${agents.length - 3}` : ''}`}`;
    }
    case 'post_message': {
      const seq = json?.['seq'] ?? /"seq"\s*:\s*(\d+)/.exec(body)?.[1];
      return seq === undefined ? 'posting to board' : `posted #${String(seq)}`;
    }
    case 'swarm_wait': return 'waiting on team';
    default: {
      const statuses = [...raw.matchAll(/"status"\s*:\s*"(done|in_progress|pending)"/g)].map((m) => m[1]);
      return statuses.length === 0 ? 'updating plan' : `plan ${statuses.filter((s) => s === 'done').length}/${statuses.length} done`;
    }
  }
}
