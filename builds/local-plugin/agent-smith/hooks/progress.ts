/**
 * progress.ts — what a worker is doing, from its tool calls, for every provider.
 *
 * ONE CLASSIFIER, TWO CALLERS. The forge writer (server side) feeds every tool
 * call through `ProgressTracker` and stores the digest in progress.json; the band
 * and the pane read that digest and phrase it with `progressPhrase`. It lives in
 * the mod because the mod loader only admits files inside the plugin folder, and
 * the forge can import a plain module from here; the reverse is impossible. No
 * `claude-code` import, no filesystem, no clock: pure, so both sides can test it.
 *
 * HONESTY RULES, because this is the field people read to decide whether to
 * worry:
 *   - Never a green test verdict. agy reports no exit codes and `cmd | tail`
 *     hides them everywhere, so the digest says tests RAN, and that the last run
 *     FAILED only when the provider explicitly ended it as an error.
 *   - Never "0 files edited". codex edits through the shell, which no tool event
 *     shows, so an absent edit count means "not visible", not zero.
 */
import type { ProgressDigest, ProgressPhase } from '../types/index.d.ts';
import { basename, describeTool, humanCommand, oneLine, parseInputPreview } from './format.ts';

export type { ProgressDigest, ProgressPhase };
export type ProgressKind = 'read' | 'search' | 'edit' | 'test' | 'command' | 'other';

export interface Classified {
  readonly kind: ProgressKind;
  /** A short human phrase: `reading config.py`, `running tests`, `git grep`. */
  readonly label: string;
  /** The file this call reads or edits, when it names exactly one. */
  readonly path?: string;
}


const READ_TOOLS = new Set(['view_file', 'read', 'list_dir', 'ls', 'list', 'notebookread']);
const SEARCH_TOOLS = new Set(['grep_search', 'grep', 'glob', 'find_by_name', 'codebase_search', 'search_web', 'web_search', 'websearch', 'webfetch']);
const EDIT_TOOLS = new Set(['write_to_file', 'replace_file_content', 'edit', 'multiedit', 'write', 'notebookedit', 'patch', 'file_change', 'apply_patch']);
const COMMAND_TOOLS = new Set(['run_command', 'bash', 'shell', 'command_execution', 'exec']);

const PATH_KEYS = ['AbsolutePath', 'TargetFile', 'file_path', 'filePath', 'notebook_path', 'path'];
const COMMAND_KEYS = ['CommandLine', 'command', 'cmd'];

/** `/bin/zsh -lc 'cat x'` and `bash -lc "…"` → the command inside. codex names a shell call by its command line. */
export function unwrapShell(command: string): string {
  const m = /^\s*(?:\S*\/)?(?:ba|z|)sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  return m ? m[2]! : command;
}

const TEST_RE = /\b(?:pytest|jest|vitest|mocha|tox|nox|rspec|phpunit|ctest|unittest)\b|\b(?:cargo|go|npm|pnpm|yarn|bun|deno|dotnet|mvn|gradle|swift|mix)\s+(?:run\s+)?(?:test|nextest|verify)\b|\bmake\s+(?:test|check)\b|\bnode\s+--test\b/;
const SEARCH_PROGS = new Set(['grep', 'rg', 'ag', 'ack', 'find', 'fd']);
/** Steps that prepare a shell rather than do the work. */
const SETUP_PROGS = new Set(['cd', 'pushd', 'popd', 'export', 'unset', 'source', '.', 'set', 'ulimit']);
const READ_PROGS = new Set(['cat', 'sed', 'head', 'tail', 'nl', 'less', 'ls', 'tree', 'wc']);

function classifyCommand(raw: string): Classified {
  // A leading `!` negates the exit status; it is not the program.
  const command = unwrapShell(raw).replace(/\s+/g, ' ').trim().replace(/^!\s*/, '');
  const segments = command.split(/\s*(?:&&|\|\||;|\|)\s*/).filter((s) => s !== '');
  const program = (segment: string) => segment.split(' ').filter((w) => w !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  // `unset VIRTUAL_ENV; uv run pytest`: the setup step is not what the command does.
  const first = segments.find((s) => !SETUP_PROGS.has(basename(program(s)[0] ?? ''))) ?? segments[0] ?? command;
  const words = program(first);
  const prog = basename(words[0] ?? '');
  const sub = subcommand(words);
  if (prog === 'git' && sub === 'grep') return { kind: 'search', label: 'git grep' };
  if (SEARCH_PROGS.has(prog)) return { kind: 'search', label: humanCommand(first) };
  if (READ_PROGS.has(prog)) return { kind: 'read', label: humanCommand(first) };
  if (TEST_RE.test(command)) return { kind: 'test', label: 'running tests' };
  return { kind: 'command', label: humanCommand(first) };
}

/** Global options that take a value, so `git -C dir grep` finds `grep`, not `dir`. */
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

function subcommand(words: readonly string[]): string {
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i]!;
    if (VALUE_OPTIONS.has(w)) { i += 1; continue; }
    if (!w.startsWith('-')) return w;
  }
  return '';
}

function firstString(params: Record<string, unknown>, keys: readonly string[], raw = ''): string {
  for (const k of keys) {
    const v = params[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  // A long input (a Write's file body) arrives truncated and no longer parses;
  // its leading keys are still readable.
  for (const k of keys) {
    const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
    if (m) {
      try { return JSON.parse(`"${m[1]}"`) as string; } catch { return m[1]!; }
    }
  }
  return '';
}

/**
 * One tool call → its kind and a phrase. Every provider's tool vocabulary:
 * agy (view_file, run_command, …), claude (Read, Edit, Bash, …), opencode (read,
 * edit, bash, …) and codex (a shell command line as the tool, or file_change).
 * Input may be truncated JSON; a parse failure falls back to the bare tool name.
 */
export function classify(tool: string, input: string | null | undefined): Classified {
  const params = parseInputPreview(input);
  const name = tool.trim();
  const lower = name.toLowerCase();
  const path = firstString(params, PATH_KEYS, input ?? '');
  const file = path === '' ? '' : basename(path);

  if (COMMAND_TOOLS.has(lower)) return classifyCommand(firstString(params, COMMAND_KEYS, input ?? ''));
  if (EDIT_TOOLS.has(lower)) {
    if (lower === 'file_change') {
      const changes = Array.isArray(params['changes']) ? params['changes'] : [];
      const first = changes.map((c) => (c && typeof c === 'object' ? (c as Record<string, unknown>)['path'] : undefined))
        .find((p): p is string => typeof p === 'string');
      return { kind: 'edit', label: first ? `editing ${oneLine(basename(first))}` : 'editing files', ...(first ? { path: first } : {}) };
    }
    return { kind: 'edit', label: file ? `editing ${oneLine(file)}` : 'editing', ...(path ? { path } : {}) };
  }
  if (READ_TOOLS.has(lower)) {
    const listing = lower === 'list_dir' || lower === 'ls' || lower === 'list';
    return { kind: 'read', label: file ? `${listing ? 'listing' : 'reading'} ${oneLine(file)}` : 'reading', ...(path && !listing ? { path } : {}) };
  }
  if (SEARCH_TOOLS.has(lower)) {
    const query = oneLine(firstString(params, ['Query', 'Pattern', 'pattern', 'query', 'url'], input ?? ''));
    const short = query.length > 24 ? `${query.slice(0, 23)}…` : query;
    return { kind: 'search', label: short ? `searching ${short}` : 'searching' };
  }
  // codex: the tool IS the command line.
  if (/\s/.test(name) || /^(?:\S*\/)?(?:ba|z)?sh$/.test(name)) return classifyCommand(name);
  return { kind: 'other', label: describeTool(name, params) };
}

const WINDOW = 8;
const EDITED_CAP = 8;
const REPEAT_MIN = 4;

/** Accumulates one job's tool calls into a ProgressDigest. Feed it every activity start and end. */
export class ProgressTracker {
  private readonly steps = new Map<number, Classified>();
  private readonly read = new Set<string>();
  private readonly editedSet = new Set<string>();
  private edited: string[] = [];
  /** Edits whose file the tool did not name (codex file_change's shape is unverified): still edits. */
  private unnamedEdits = 0;
  private searches = 0;
  private commands = 0;
  private testRuns = 0;
  private lastTestFailed = false;
  private recent: Classified[] = [];
  private repeatKey = '';
  private repeatLabel = '';
  private repeatCount = 0;
  private activeTest = false;

  /** A tool call began. Repeated starts of one step (ACTIVE then DONE) are counted once. */
  start(stepIndex: number, tool: string, input: string | null | undefined): void {
    if (this.steps.has(stepIndex)) return;
    const c = classify(tool, input);
    this.steps.set(stepIndex, c);
    switch (c.kind) {
      case 'read': if (c.path) this.read.add(c.path); break;
      case 'search': this.searches += 1; break;
      case 'edit':
        if (c.path) {
          if (this.editedSet.has(c.path)) this.edited = this.edited.filter((p) => p !== c.path);
          this.editedSet.add(c.path);
          this.edited.push(c.path);
        } else this.unnamedEdits += 1;
        break;
      case 'test': this.testRuns += 1; this.activeTest = true; break;
      case 'command': this.commands += 1; break;
      default: break;
    }
    if (c.kind !== 'other') this.recent = [...this.recent, c].slice(-WINDOW);
    const key = `${c.kind}\u0000${c.label}\u0000${input ?? ''}`;
    if (key === this.repeatKey) this.repeatCount += 1;
    else { this.repeatKey = key; this.repeatLabel = c.label; this.repeatCount = 1; }
  }

  /** A tool call ended. Only an explicit error marks a test run failed. */
  end(stepIndex: number, tool: string, input: string | null | undefined, status: string): void {
    if (!this.steps.has(stepIndex)) this.start(stepIndex, tool, input);
    const c = this.steps.get(stepIndex)!;
    if (c.kind === 'test') {
      this.lastTestFailed = status === 'error';
      this.activeTest = false;
    }
  }

  digest(cwd = ''): ProgressDigest {
    const relative = (p: string): string => {
      const base = cwd.replace(/\/+$/, '');
      return base !== '' && p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p;
    };
    return {
      phase: this.phase(),
      filesRead: this.read.size,
      searches: this.searches,
      edited: this.edited.slice(-EDITED_CAP).map(relative),
      editedCount: this.editedSet.size + this.unnamedEdits,
      commands: this.commands,
      testRuns: this.testRuns,
      lastTestFailed: this.lastTestFailed,
      repeat: this.repeatCount >= REPEAT_MIN ? { label: this.repeatLabel, count: this.repeatCount } : null,
    };
  }

  /** All file paths named by edit tool calls so far, relative to `cwd` when inside it. */
  editedPaths(cwd = ''): string[] {
    const base = cwd.replace(/\/+$/, '');
    return this.edited.map((p) => (base !== '' && p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p));
  }

  /** From a window of recent calls, not the last one alone, so the phase does not flicker. */
  private phase(): ProgressPhase {
    const last = this.recent.at(-1);
    if (last === undefined) return 'starting';
    if (this.activeTest || last.kind === 'test') return 'testing';
    if (this.recent.some((c) => c.kind === 'edit')) return 'editing';
    if (last.kind === 'command') return 'running';
    return 'exploring';
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The band's detail phrase, most important first so truncation drops the least:
 * what it is doing now, then what it has changed, then tests, then exploration.
 */
export function progressPhrase(digest: ProgressDigest, activity: string): string {
  const parts: string[] = [];
  if (digest.repeat !== null) parts.push(`repeating ${oneLine(digest.repeat.label)} ×${digest.repeat.count}`);
  else {
    // A verb phrase ("reading config.py", "running tests") says what is happening.
    // A raw command fallback ("ls tests/", "printf %s") does not; the phase does.
    const now = oneLine(activity);
    parts.push(/^[a-z]+ing\b/.test(now) ? now : oneLine(digest.phase));
  }
  if (digest.editedCount > 0) parts.push(`${plural(digest.editedCount, 'file')} edited`);
  if (digest.testRuns > 0) parts.push(digest.lastTestFailed ? 'last test run failed' : `ran tests ×${digest.testRuns}`);
  if (digest.editedCount === 0 && digest.filesRead > 0) parts.push(`${plural(digest.filesRead, 'file')} read`);
  return parts.filter((p) => p !== '').join(' · ');
}

/** The pane's progress block: a few full lines, nothing truncated mid-thought. */
export function progressLines(digest: ProgressDigest, toolCount: number | null): string[] {
  const lines: string[] = [];
  const phase = oneLine(digest.phase) || 'running';
  const counts = [
    `${phase[0]!.toUpperCase()}${phase.slice(1)}`,
    digest.filesRead > 0 ? `${plural(digest.filesRead, 'file')} read` : '',
    digest.searches > 0 ? plural(digest.searches, 'search', 'searches') : '',
    digest.commands > 0 ? plural(digest.commands, 'command') : '',
    toolCount !== null ? plural(toolCount, 'tool call') : '',
  ].filter((p) => p !== '');
  lines.push(counts.join(' · '));
  if (digest.editedCount > 0) {
    const more = digest.editedCount - digest.edited.length;
    lines.push(digest.edited.length === 0
      ? `Edited: ${plural(digest.editedCount, 'file')}`
      : `Edited: ${shortPaths(digest.edited.map((p) => oneLine(p))).join(', ')}${more > 0 ? ` (+${more} more)` : ''}`);
  }
  if (digest.testRuns > 0) {
    lines.push(`Tests: ran ${plural(digest.testRuns, 'time')}${digest.lastTestFailed ? ' · last run failed' : ''}`);
  }
  if (digest.repeat !== null) lines.push(`Repeating: ${oneLine(digest.repeat.label)} ×${digest.repeat.count}`);
  return lines;
}

/** File names, with the parent folder added where two names would otherwise read the same. */
function shortPaths(paths: readonly string[]): string[] {
  const split = paths.map((p) => p.split('/').filter((s) => s !== ''));
  return split.map((parts, i) => {
    for (let n = 1; n < parts.length; n += 1) {
      const tail = parts.slice(-n).join('/');
      if (split.every((other, j) => j === i || other.slice(-n).join('/') !== tail)) return tail;
    }
    return parts.join('/');
  });
}
