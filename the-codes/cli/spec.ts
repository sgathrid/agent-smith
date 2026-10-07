/**
 * cli/spec.ts — read a pipeline spec from YAML, with no dependencies.
 *
 * ============================================================================
 * WHY A SUBSET PARSER AND NOT A YAML LIBRARY
 * ============================================================================
 * The constraint is node-builtins-only. There is no YAML parser in Node and
 * there is no `node_modules/yaml`. So this parses the SUBSET of YAML that
 * pipeline specs actually use, and — this is the important half — REFUSES
 * everything else loudly instead of guessing.
 *
 * A spec that silently loses a field is the worst possible failure here: the
 * pipeline would run a `moderate` stage with the implementer's model, which is
 * precisely the correlated-agreement mistake ARCHITECTURE.md is built against.
 * Guessing is not an option; a clear error is.
 *
 * THE SUBSET:
 *   - two-space (or any consistent) indentation, block style only
 *   - mappings:  `key: value` / `key:` followed by an indented block
 *   - sequences: `- item` and `- key: value` (a map inside a list item)
 *   - scalars: plain, 'single', "double", and `|` literal block scalars
 *   - comments: `#` at the start of a line or after whitespace
 *   - `[a, b]` inline flow sequences, ONLY of scalars (needed for dependsOn)
 *
 * EXPLICITLY UNSUPPORTED, each with an error rather than a silent drop:
 *   anchors/aliases (`&x`, `*x`), tags (`!!str`), flow mappings (`{a: b}`),
 *   multi-document (`---`), complex keys (`? `), merge keys (`<<`).
 */

import { readFileSync } from 'node:fs';

import { PipelineSpecError } from '../pipeline/pipeline.ts';
import type { Effort, PipelineSpec, Stage, StageCheck, StageRole } from '../pipeline/types.ts';

/** Raised for anything this parser will not interpret. Never a guess. */
export class SpecParseError extends Error {
  // An explicit field, not a constructor parameter property: this project runs
  // under `--experimental-strip-types`, which has no emit step and therefore
  // cannot transform parameter properties. See pipeline.ts's Scheduler for the
  // same constraint stated at its class site.
  readonly line: number;

  constructor(message: string, line: number) {
    super(`pipeline spec line ${line}: ${message}`);
    this.name = 'SpecParseError';
    this.line = line;
  }
}

/* -------------------------------------------------------------------------- */
/* Lines                                                                       */
/* -------------------------------------------------------------------------- */

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly no: number;
}

/** Strip comments and blank lines, and record indentation. */
function lex(source: string): Line[] {
  const out: Line[] = [];
  const raw = source.split('\n');
  for (let i = 0; i < raw.length; i++) {
    const original = raw[i] ?? '';
    // Block scalars are handled during parse, not here, so a `#` inside one
    // must not be stripped here. The parser asks for the raw lines directly.
    const withoutIndent = original.replace(/^\s*/, '');
    const indent = original.length - withoutIndent.length;
    const trimmed = stripComment(withoutIndent).replace(/\s+$/, '');
    if (trimmed === '') continue;
    if (trimmed === '---') {
      throw new SpecParseError(
        'multi-document YAML is not supported; a pipeline spec is one document',
        i + 1,
      );
    }
    out.push({ indent, text: trimmed, no: i + 1 });
  }
  return out;
}

/**
 * Remove a trailing `#` comment.
 *
 * Only when the `#` is at the start of the content or preceded by whitespace, so
 * a `#` inside a quoted string or a shell command survives. That case is real:
 * `prompt: run make test #3 in CI` must keep its `#3`.
 */
function stripComment(text: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(text[i - 1] ?? ''))) {
      return text.slice(0, i);
    }
  }
  return text;
}

/* -------------------------------------------------------------------------- */
/* Scalars                                                                     */
/* -------------------------------------------------------------------------- */

type Scalar = string | number | boolean | null | Scalar[];

/**
 * A parsed YAML node. `Node` exists as a separate name from `Scalar` only so
 * the casts at the parse boundaries read as what they are: `Node` is "anything
 * the parser can produce", `Scalar` is "anything a KEY can hold".
 */
type Node = Map<string, Scalar> | Scalar[] | Scalar;

/**
 * Parse one scalar, with an explicit type ladder.
 *
 * NUMBERS become numbers so `timeoutMs: 600000` is not the string "600000",
 * which would compare wrong against a real number later. BOOLEANS likewise,
 * because `background: false` as the string "false" is truthy.
 */
export function parseScalar(raw: string, no: number): Scalar {
  const t = raw.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d*\.\d+$/.test(t)) return Number(t);

  if (t.startsWith('[')) {
    if (!t.endsWith(']')) throw new SpecParseError(`unterminated flow sequence '${t}'`, no);
    const inner = t.slice(1, -1).trim();
    if (inner === '') return [];
    // Flow sequences of SCALARS only. A flow mapping inside would need real
    // YAML and we refuse rather than mis-parse it.
    if (inner.includes('{')) {
      throw new SpecParseError('flow mappings ({a: b}) are not supported', no);
    }
    return inner.split(',').map((part) => parseScalar(part, no));
  }

  if (t.startsWith('{')) {
    throw new SpecParseError('flow mappings ({a: b}) are not supported', no);
  }

  if (t.startsWith("'")) {
    if (!t.endsWith("'") || t.length < 2) throw new SpecParseError('unterminated single quote', no);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t.startsWith('"')) {
    if (!t.endsWith('"') || t.length < 2) throw new SpecParseError('unterminated double quote', no);
    // Only the two escapes that appear in practice in a prompt. Anything else is
    // passed through, which is the safer failure for prose.
    return t
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  // Anchors, aliases and tags are the classic silent-corruption path: `&base`
  // would parse as a string and be used as a model name.
  if (/^[&*]/.test(t)) throw new SpecParseError(`anchors/aliases ('${t}') are not supported`, no);
  if (t.startsWith('!!')) throw new SpecParseError(`tags ('${t}') are not supported`, no);
  if (t.startsWith('<<')) throw new SpecParseError('merge keys (<<) are not supported', no);

  return t;
}

/* -------------------------------------------------------------------------- */
/* Block parser                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parse a block at `lines[start]`, consuming through `lines[end)`.
 *
 * Recursive-descent over indentation. The one subtlety worth naming: a literal
 * block scalar (`|`) must read the ORIGINAL lines, not the lexed ones, because
 * lexing strips comments — and a prompt containing `#` on its own line is
 * ordinary. So `source` is threaded through for that case only.
 */
function parseBlock(
  lines: readonly Line[],
  source: readonly string[],
  start: number,
  indent: number,
): { node: Node; next: number } {
  const first = lines[start];
  if (first === undefined) return { node: new Map(), next: start };
  if (first.text.startsWith('- ') || first.text === '-') {
    return parseSequence(lines, source, start, indent);
  }
  return parseMapping(lines, source, start, indent);
}

function parseMapping(
  lines: readonly Line[],
  source: readonly string[],
  start: number,
  indent: number,
): { node: Map<string, Scalar>; next: number } {
  const map = new Map<string, Scalar>();
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    // A DEDENT ends this block. A line at the same indent continues it. A line
    // deeper than expected would be a malformed spec; parseBlock would have
    // consumed it, so it can only be a sibling that over-indented. Treated as
    // end-of-block rather than as an error, because the caller's loop reports
    // the "unknown key" case with better context.
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new SpecParseError(
        `unexpected indentation (expected ${indent}, got ${line.indent}); check for a missing '- '`,
        line.no,
      );
    }

    const colon = findKeyColon(line.text);
    if (colon === -1) {
      throw new SpecParseError(`expected 'key: value', got '${line.text}'`, line.no);
    }
    const key = line.text.slice(0, colon).trim();
    const rest = line.text.slice(colon + 1).trim();
    if (key === '') throw new SpecParseError('empty key', line.no);

    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      // Bridge between the two coordinate systems: `i` indexes the LEXED lines
      // (which have lost blanks and comment-only lines), while the block reader
      // works in SOURCE line numbers so it can see them again.
      const blockStartLine = lines[i + 1]?.no ?? line.no + 1;
      const block = readLiteralBlock(
        source,
        blockStartLine,
        indent,
        rest.endsWith('-') ? 'strip' : 'clip',
        rest.startsWith('>'),
      );
      map.set(key, block.text);
      // Resume at the first lexed line at or after the block's end.
      i = firstLineAtOrAfter(lines, i + 1, block.nextLine);
      continue;
    }

    if (rest !== '') {
      map.set(key, parseScalar(rest, line.no));
      i += 1;
      continue;
    }

    // `key:` with nothing after it: a nested block, or an explicit null.
    const next = lines[i + 1];
    if (next === undefined || next.indent <= indent) {
      map.set(key, null);
      i += 1;
      continue;
    }
    const child = parseBlock(lines, source, i + 1, next.indent);
    // Through `unknown`: a nested block may be a mapping, which `Scalar` cannot
    // describe, yet a KEY's value legitimately can be one. The widening is
    // confined to this line and to the two sequence equivalents.
    map.set(key, child.node as unknown as Scalar);
    i = child.next;
  }
  return { node: map, next: i };
}

function parseSequence(
  lines: readonly Line[],
  source: readonly string[],
  start: number,
  indent: number,
): { node: Scalar[]; next: number } {
  const out: Scalar[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new SpecParseError(`unexpected indentation inside a sequence`, line.no);
    }
    if (!line.text.startsWith('- ') && line.text !== '-') break;

    const inline = line.text === '-' ? '' : line.text.slice(2).trim();
    const childIndent = line.indent + 2;

    if (inline === '') {
      const next = lines[i + 1];
      if (next === undefined || next.indent <= line.indent) {
        out.push(null);
        i += 1;
        continue;
      }
      const child = parseBlock(lines, source, i + 1, next.indent);
      out.push(child.node as Scalar);
      i = child.next;
      continue;
    }

    // `- key: value` — a mapping whose first key shares the dash's line. The
    // remaining keys are indented to where the key started.
    const colon = findKeyColon(inline);
    if (colon !== -1 && !isFlowOnly(inline)) {
      const synthetic: Line = { indent: childIndent, text: inline, no: line.no };
      // The continuation lines must be re-lexed at childIndent so the mapping
      // parser sees them at the same level as the synthetic one.
      const consumed = collectSequenceContinuation(lines, i + 1, childIndent);
      const sub = parseMapping([synthetic, ...consumed.lines], source, 0, childIndent);
      out.push(sub.node as unknown as Scalar);
      i = consumed.next;
      continue;
    }

    out.push(parseScalar(inline, line.no));
    i += 1;
  }
  return { node: out, next: i };
}

/** Gather the continuation lines of a `- key: value` item at `indent`. */
function collectSequenceContinuation(
  lines: readonly Line[],
  start: number,
  indent: number,
): { lines: Line[]; next: number } {
  const out: Line[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.indent < indent) break;
    // A new item at the PARENT sequence indentation ends this map item. A
    // nested sequence is part of the map value and must remain in the slice.
    if ((line.text.startsWith('- ') || line.text === '-') && line.indent === indent - 2) break;
    out.push(line);
    i += 1;
  }
  return { lines: out, next: i };
}

/**
 * Read a `|` / `>` block scalar.
 *
 * `|` keeps newlines verbatim; `>` FOLDS them into spaces, which is what a long
 * single-paragraph prompt wants and what the YAML spec means by a folded scalar.
 * `-` on either is "strip" chomping: no trailing newline. Bare `|`/`>` is "clip"
 * chomping: exactly ONE trailing newline, which is the YAML default and the
 * reason a prompt written under `prompt: |` ends with `\n` rather than running
 * straight into whatever the author typed next.
 *
 * The INDENT OF THE FIRST NON-BLANK LINE defines the block's own indent, and that
 * many characters are stripped from every line — standard YAML, and the only sane
 * reading when a prompt is indented under its key.
 *
 * THIS READS `source`, NOT `lines`, and that is load-bearing rather than
 * stylistic. `lex` has already removed every line that became empty after
 * comment-stripping, which includes any line that is ONLY a `#` comment. Indexing
 * the lexed lines would therefore silently delete a `# heading` from the middle
 * of a prompt — the one case where a prompt legitimately contains lines that
 * look like comments.
 *
 * `startLine` is a 1-based source line number; the returned `nextLine` is the
 * 1-based number of the first line NOT in the block.
 */
function readLiteralBlock(
  source: readonly string[],
  startLine: number,
  parentIndent: number,
  chomp: 'clip' | 'strip',
  fold: boolean,
): { text: string; nextLine: number } {
  // `startLine` is 1-based (it comes from `Line.no`, which is what `lex` records
  // and what an error message quotes). Convert ONCE here to a 0-based index so
  // the two coordinate systems cannot drift; an off-by-one in this function eats
  // the first line of every block scalar in a spec, which is a silent data loss.
  let idx = startLine - 1;
  const indentOf = (raw: string): number => raw.length - raw.replace(/^\s*/, '').length;

  // The block's own indent is the indent of its first non-blank line, found by
  // scanning forward: the line right after `|` is not necessarily part of the
  // block (there can be a blank one).
  let blockIndent = -1;
  for (let n = idx; n < source.length; n++) {
    const raw = source[n] ?? '';
    if (raw.trim() === '') continue;
    blockIndent = indentOf(raw);
    break;
  }
  if (blockIndent <= parentIndent) blockIndent = parentIndent + 2;

  const collected: string[] = [];
  for (; idx < source.length; idx++) {
    const raw = source[idx] ?? '';
    if (raw.trim() === '') {
      // A blank line belongs to the block only if more content follows at this
      // indent; a blank line before a dedent ends the block.
      const nextRaw = source[idx + 1] ?? '';
      if (nextRaw.trim() === '') {
        collected.push('');
        continue;
      }
      if (indentOf(nextRaw) < blockIndent) break;
      collected.push('');
      continue;
    }
    if (indentOf(raw) < blockIndent) break;
    collected.push(raw.slice(blockIndent).replace(/\s+$/, ''));
  }

  // Trailing blanks belong to the chomping rule, not to the content.
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();

  let text: string;
  if (fold) {
    // Folded scalar: consecutive non-blank lines join with a space; a blank line
    // becomes a paragraph break. This is why a `>` prompt reads as one paragraph
    // while still being writable across several source lines.
    const paragraphs: string[] = [];
    let current: string[] = [];
    for (const l of collected) {
      if (l.trim() === '') {
        paragraphs.push(current.join(' '));
        current = [];
      } else {
        current.push(l.trim());
      }
    }
    paragraphs.push(current.join(' '));
    text = paragraphs.filter((p) => p !== '').join('\n');
  } else {
    text = collected.join('\n');
  }

  // CLIP keeps exactly one trailing newline; STRIP keeps none.
  if (chomp === 'clip' && text !== '') text += '\n';
  // Back to 1-based: `idx` is the 0-based index of the first line NOT in the
  // block, which is the same line as 1-based `idx + 1`.
  return { text, nextLine: idx + 1 };
}

/**
 * Index of the first lexed line at or after a 1-based SOURCE line number.
 *
 * The translation back from `readLiteralBlock`'s source-line coordinate into the
 * lexed array. Returns `lines.length` when the block ran to the end of the file,
 * which is the correct "nothing left to parse" answer.
 */
function firstLineAtOrAfter(lines: readonly Line[], from: number, sourceLine: number): number {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && line.no >= sourceLine) return i;
  }
  return lines.length;
}

/** Index of the `:` that separates a key from its value, or -1. */
function findKeyColon(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ':' && !inSingle && !inDouble) {
      // `key:value` is a plain scalar in YAML; `key: value` is a mapping. We
      // require the space, because a model id or a URL can contain a colon and
      // guessing wrong would produce a key named `https`.
      if (i === text.length - 1 || /\s/.test(text[i + 1] ?? '')) return i;
    }
  }
  return -1;
}

/** `[a, b]` starts with `[` and has no top-level colon → a scalar, not a mapping. */
function isFlowOnly(inline: string): boolean {
  return inline.startsWith('[') && findKeyColon(inline) === -1;
}

/* -------------------------------------------------------------------------- */
/* The public parse                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Parse YAML source into a plain tree. Exported for tests.
 *
 * Returns a `Map` rather than a plain object so key ORDER is preserved and a
 * `__proto__` key in a spec cannot pollute anything.
 */
export function parseYaml(source: string): Map<string, Scalar> {
  const lines = lex(source);
  if (lines.length === 0) return new Map();
  const base = lines[0];
  if (base === undefined) return new Map();
  const { node } = parseBlock(lines, source.split('\n'), 0, base.indent);
  if (!(node instanceof Map)) {
    throw new SpecParseError('a pipeline spec must be a mapping at the top level', base.no);
  }
  return node;
}

/* -------------------------------------------------------------------------- */
/* Spec mapping                                                                */
/* -------------------------------------------------------------------------- */

const KNOWN_STAGE_KEYS = new Set([
  'name',
  'agentName',
  'workerId',
  'conversation',
  'provider',
  'model',
  'effort',
  'dependsOn',
  'role',
  'prompt',
  'title',
  'workDir',
  'resultPath',
  'consumes',
  'timeoutMs',
  'timeout',
  'routingPinned',
  'checks',
]);

const KNOWN_SPEC_KEYS = new Set(['name', 'stages', 'concurrency', 'workDir']);

/**
 * A stage `timeout` as a DURATION STRING, e.g. `45m`, `90s`, `1h30m`.
 *
 * Needed because the CLI's own flag is `--timeout 60m` (the brief's example), so
 * a spec author will reach for the same syntax. Returns ms, or throws — never 0,
 * because a 0 timeout means "no timeout" to the pipeline and silently removing a
 * wall-clock budget is the opposite of the intent.
 */
export function parseDuration(raw: string): number {
  const t = raw.trim();
  const re = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/;
  const m = re.exec(t);
  if (m === null || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) {
    throw new Error(`'${raw}' is not a duration. Use e.g. 45m, 90s, 1h30m.`);
  }
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  const ms = (h * 3600 + min * 60 + s) * 1000;
  if (ms <= 0) throw new Error(`'${raw}' is not a positive duration`);
  return ms;
}

function asString(v: Scalar, key: string, no: number): string | undefined {
  if (v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new SpecParseError(`'${key}' must be a string`, no);
}

function asStringArray(v: Scalar, key: string, no: number): string[] | undefined {
  if (v === null) return undefined;
  if (!Array.isArray(v)) throw new SpecParseError(`'${key}' must be a list`, no);
  return v.map((item) => {
    if (typeof item !== 'string') {
      throw new SpecParseError(`'${key}' must be a list of stage names`, no);
    }
    return item;
  });
}

function checksFromYaml(value: Scalar | undefined, stage: string, index: number): StageCheck[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new PipelineSpecError(`stage '${stage}': checks must be a list`);
  return value.map((entry, checkIndex) => {
    if (!(entry instanceof Map)) throw new PipelineSpecError(`stage '${stage}': checks[${checkIndex}] must be a mapping`);
    const allowed = new Set(['name', 'command', 'cwd', 'timeoutMs', 'blocking']);
    for (const key of entry.keys()) {
      if (!allowed.has(key)) throw new PipelineSpecError(`stage '${stage}': checks[${checkIndex}] has unknown key '${key}'`);
    }
    const name = asString(entry.get('name') ?? null, `checks[${checkIndex}].name`, index);
    const command = asString(entry.get('command') ?? null, `checks[${checkIndex}].command`, index);
    if (name === undefined || name.trim() === '' || command === undefined || command.trim() === '') {
      throw new PipelineSpecError(`stage '${stage}': checks[${checkIndex}] needs nonempty name and command`);
    }
    const cwd = asString(entry.get('cwd') ?? null, `checks[${checkIndex}].cwd`, index);
    const timeoutMs = entry.get('timeoutMs');
    if (timeoutMs !== undefined && timeoutMs !== null && (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
      throw new PipelineSpecError(`stage '${stage}': checks[${checkIndex}].timeoutMs must be a positive integer`);
    }
    const blocking = entry.get('blocking');
    if (blocking !== undefined && blocking !== null && typeof blocking !== 'boolean') {
      throw new PipelineSpecError(`stage '${stage}': checks[${checkIndex}].blocking must be true or false`);
    }
    return {
      name,
      command,
      ...(cwd === undefined ? {} : { cwd }),
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
      ...(typeof blocking === 'boolean' ? { blocking } : {}),
    };
  });
}

/**
 * Validate and map a stage. UNKNOWN KEYS THROW.
 *
 * This is the enforcement point for the claim the parser makes. A typo like
 * `dependOn:` (missing the 's') would otherwise produce a stage with no
 * dependencies — which RUNS CONCURRENTLY WITH THE STAGE THAT WAS SUPPOSED TO
 * PRODUCE ITS INPUT, and then reads a file that does not exist yet. That is a
 * silent, concurrent, wrong result, so it must not be a default.
 */
export function stageFrom(node: Scalar, index: number): Stage {
  if (!(node instanceof Map)) {
    throw new PipelineSpecError(`stages[${index}] must be a mapping`);
  }
  for (const key of node.keys()) {
    if (!KNOWN_STAGE_KEYS.has(key)) {
      throw new PipelineSpecError(
        `stages[${index}] has unknown key '${key}'. Known keys: ` +
          `${[...KNOWN_STAGE_KEYS].sort().join(', ')}. ` +
          'A silently-ignored key here becomes a stage that runs with the wrong ' +
          'dependencies, which is worse than refusing to start.',
      );
    }
  }

  const name = asString(node.get('name') ?? null, 'name', index);
  if (name === undefined || name === '') {
    throw new PipelineSpecError(`stages[${index}] needs a name`);
  }
  const provider = asString(node.get('provider') ?? null, 'provider', index);
  if (provider === undefined || provider === '') {
    throw new PipelineSpecError(`stage '${name}' needs a provider`);
  }

  const stage: Record<string, unknown> = { name, provider };

  for (const key of ['agentName', 'workerId', 'conversation'] as const) {
    const value = asString(node.get(key) ?? null, key, index);
    if (value !== undefined) {
      if (value.trim() === '') throw new PipelineSpecError(`stage '${name}': ${key} must be nonempty`);
      stage[key] = value;
    }
  }

  const model = asString(node.get('model') ?? null, 'model', index);
  if (model !== undefined) stage['model'] = model;

  const effortRaw = asString(node.get('effort') ?? null, 'effort', index);
  if (effortRaw !== undefined) {
    if (effortRaw !== 'low' && effortRaw !== 'medium' && effortRaw !== 'high' && effortRaw !== 'xhigh' && effortRaw !== 'max') {
      throw new PipelineSpecError(
        `stage '${name}': effort must be low|medium|high|xhigh|max, got '${effortRaw}'.`,
      );
    }
    stage['effort'] = effortRaw as Effort;
  }

  const dependsOn = asStringArray(node.get('dependsOn') ?? null, 'dependsOn', index);
  if (dependsOn !== undefined) stage['dependsOn'] = dependsOn;

  const role = asString(node.get('role') ?? null, 'role', index);
  if (role !== undefined) stage['role'] = role as StageRole;

  const prompt = asString(node.get('prompt') ?? null, 'prompt', index);
  if (prompt !== undefined) stage['prompt'] = prompt;

  const title = asString(node.get('title') ?? null, 'title', index);
  if (title !== undefined) stage['title'] = title;

  const workDir = asString(node.get('workDir') ?? null, 'workDir', index);
  if (workDir !== undefined) stage['workDir'] = workDir;

  const resultPath = asString(node.get('resultPath') ?? null, 'resultPath', index);
  if (resultPath !== undefined) stage['resultPath'] = resultPath;

  const timeoutMs = node.get('timeoutMs');
  if (timeoutMs !== null && timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new PipelineSpecError(`stage '${name}': timeoutMs must be a positive integer number of milliseconds`);
    }
    stage['timeoutMs'] = timeoutMs;
  }
  const timeout = asString(node.get('timeout') ?? null, 'timeout', index);
  if (timeout !== undefined) {
    if (timeoutMs !== null && timeoutMs !== undefined) {
      throw new PipelineSpecError(`stage '${name}': set only one of timeout and timeoutMs`);
    }
    try {
      stage['timeoutMs'] = parseDuration(timeout);
    } catch (err) {
      throw new PipelineSpecError(
        `stage '${name}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const pinned = node.get('routingPinned');
  if (pinned !== null && pinned !== undefined) {
    if (typeof pinned !== 'boolean') {
      throw new PipelineSpecError(`stage '${name}': routingPinned must be true or false`);
    }
    stage['routingPinned'] = pinned;
  }

  const checks = checksFromYaml(node.get('checks'), name, index);
  if (checks !== undefined) stage['checks'] = checks;

  const consumes = node.get('consumes');
  if (consumes !== null && consumes !== undefined) {
    if (!Array.isArray(consumes)) {
      throw new PipelineSpecError(`stage '${name}': consumes must be a list`);
    }
    stage['consumes'] = consumes.map((entry, i) => {
      if (!(entry instanceof Map)) {
        throw new PipelineSpecError(`stage '${name}': consumes[${i}] must be a mapping`);
      }
      const s = asString(entry.get('stage') ?? null, 'consumes[].stage', index);
      const p = asString(entry.get('path') ?? null, 'consumes[].path', index);
      if (s === undefined || p === undefined) {
        throw new PipelineSpecError(
          `stage '${name}': consumes[${i}] needs both 'stage' and 'path'`,
        );
      }
      const label = asString(entry.get('label') ?? null, 'consumes[].label', index);
      return { stage: s, path: p, ...(label === undefined ? {} : { label }) };
    });
  }

  return stage as unknown as Stage;
}

/**
 * Map a parsed tree onto a `PipelineSpec`.
 *
 * Separated from parsing so the error messages here talk about PIPELINE concepts
 * ("stage 'review' depends on 'implement'") rather than about YAML.
 */
export function specFrom(tree: Map<string, Scalar>): PipelineSpec {
  for (const key of tree.keys()) {
    if (!KNOWN_SPEC_KEYS.has(key)) {
      throw new PipelineSpecError(
        `unknown top-level key '${key}'. Known keys: ${[...KNOWN_SPEC_KEYS].sort().join(', ')}.`,
      );
    }
  }
  const name = asString(tree.get('name') ?? null, 'name', 0);
  if (name === undefined || name === '') {
    throw new PipelineSpecError("a pipeline spec needs a 'name'");
  }
  const stagesNode = tree.get('stages') ?? null;
  if (!Array.isArray(stagesNode)) {
    throw new PipelineSpecError("a pipeline spec needs a 'stages' list");
  }
  if (stagesNode.length === 0) {
    throw new PipelineSpecError('a pipeline spec needs at least one stage');
  }
  const stages = stagesNode.map((node, i) => stageFrom(node, i));

  const spec: Record<string, unknown> = { name, stages };
  const concurrency = tree.get('concurrency') ?? null;
  if (concurrency !== null) {
    if (typeof concurrency !== 'number' || !Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new PipelineSpecError('concurrency must be a positive integer');
    }
    spec['concurrency'] = concurrency;
  }
  const workDir = asString(tree.get('workDir') ?? null, 'workDir', 0);
  if (workDir !== undefined) spec['workDir'] = workDir;
  return spec as unknown as PipelineSpec;
}

/** Read and parse a spec file. */
export function loadSpec(path: string): PipelineSpec {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (err) {
    throw new PipelineSpecError(
      `cannot read '${path}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return specFrom(parseYaml(source));
}
