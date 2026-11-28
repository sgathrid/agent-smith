/**
 * agy-team.ts — observes the sub-agents an agy worker starts (a /swarm, or
 * invoke_subagent helpers) from agy's own on-disk state, read-only.
 *
 * CONTRACT (implemented by the reader; callers rely only on this):
 *   - `createAgyTeamReader({ conversationId, cwd })` is cheap and never throws.
 *   - `poll(nowMs)` reads what changed since the last poll and returns the full
 *     current snapshot, or `null` when the conversation has no sub-agents or
 *     agy's files are missing or not in the expected shape. Never throws.
 *   - It never writes, never opens a network connection, and reads only under
 *     `agyBrainRoot()`.
 *
 * WHAT AGY WRITES, under `<brain>/<conv>/.system_generated/`:
 *   - `swarm/` only when the conversation coordinates a swarm: `members.json`
 *     (roster, rewritten in place), `board.jsonl` (append-only posts; a rewrite
 *     restarts it), `plan.json` (optional task lines).
 *   - `subagents/<child>.json` per invoke_subagent child (and per swarm worker).
 *   - Each member's own `logs/chunks/transcript/NNNNNNNN.jsonl`: one step per
 *     line, cut into fixed-size slices of ONE byte stream, so a line can span
 *     two chunk files. The reader tails the stream by (chunk, offset) and holds
 *     the unfinished line's bytes until its newline lands.
 *
 * Member state follows agy's own swarm board (`board.StateOf`): killed if the
 * roster says so; waiting when the member's run has stopped (its newest step is
 * a reply with no tool calls, or the results of a batch including `swarm_wait`
 * whose own result is DONE); else working.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ActivityEvent, MemberView, Team, TeamMember, TeamMemberState } from '../surfaces/mod/types/index.d.ts';
import { classify } from '../surfaces/mod/hooks/progress.ts';
import { fitCell, oneLine } from '../surfaces/mod/hooks/text.ts';

export function agyBrainRoot(): string {
  return process.env['AGENT_SMITH_AGY_BRAIN'] ?? path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
}

export interface AgyTeamReaderOptions {
  /** The worker's (coordinator's) agy conversation id, from the `init` event. */
  readonly conversationId: string;
  /** The worker's cwd. */
  readonly cwd: string;
  /** Defaults to `agyBrainRoot()`. */
  readonly brainRoot?: string;
}

export interface AgyTeamRead {
  readonly team: Team;
  readonly views: readonly MemberView[];
}

export interface AgyTeamReader {
  poll(nowMs: number): AgyTeamRead | null;
}

/** Ids from agy's files are joined into paths, so nothing with a separator or dot gets through. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CHUNK_RE = /^\d{1,12}\.jsonl$/;
const TEXT_CAP = 2_000;
const EVENT_CAP = 200;
const POLL_BUDGET = 8 << 20;
const STREAM_BUDGET = 2 << 20;
/** An append-only file whose first bytes changed was rewritten, whatever its size. */
const SIG_BYTES = 256;
const NL = 0x0a;

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const cap = (s: string): string => (s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) : s);
const firstLine = (s: string): string => oneLine(s.split('\n').find((l) => l.trim() !== '') ?? '', 200);
const timeMs = (v: unknown): number | null => {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

function readRange(file: string, start: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const fd = openSync(file, 'r');
  try {
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buf, got, length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return got === length ? buf : buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

function sizeOf(file: string): number | null {
  try {
    const st = statSync(file);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

function sameStart(file: string, sig: Buffer | null): boolean {
  return sig === null || readRange(file, 0, sig.length).equals(sig);
}

/** Small JSON files, re-read only when their mtime or size moves. A torn read mid-rewrite keeps the last good parse. */
class JsonFiles {
  private readonly cache = new Map<string, { mtimeMs: number; size: number; value: unknown }>();

  read(file: string): unknown {
    let st;
    try { st = statSync(file); } catch { this.cache.delete(file); return undefined; }
    const hit = this.cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    try {
      const value: unknown = JSON.parse(readRange(file, 0, st.size).toString('utf8'));
      this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
      return value;
    } catch {
      return hit?.value;
    }
  }

  forget(keep: (file: string) => boolean): void {
    for (const file of this.cache.keys()) if (!keep(file)) this.cache.delete(file);
  }
}

/** Complete lines out of an append-only byte stream; the unfinished tail waits in `carry` as bytes (a UTF-8 character can split too). */
class LineCarry {
  carry: Buffer = Buffer.alloc(0);

  feed(chunk: Buffer, onLine: (line: string) => boolean): boolean {
    const data = this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk]);
    const end = data.lastIndexOf(NL);
    if (end === -1) { this.carry = Buffer.from(data); return true; }
    this.carry = Buffer.from(data.subarray(end + 1));
    for (const line of data.subarray(0, end).toString('utf8').split('\n')) {
      if (line.trim() !== '' && !onLine(line)) return false;
    }
    return true;
  }
}

function parseLine(line: string): Json | null {
  try {
    const v: unknown = JSON.parse(line);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** The compact transcript JSON-quotes each argument value (`"since":"9"`), and cuts a long one short, closing quote and all. */
function unquote(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (s.startsWith('"')) {
    try { return JSON.parse(s); } catch { /* cut short: close it ourselves */ }
    const body = s.length >= 2 && s.endsWith('"') ? s.slice(1, -1) : s.slice(1);
    const closed = body.replace(/\\+$/, (m) => (m.length % 2 === 1 ? m.slice(1) : m));
    try { return JSON.parse(`"${closed}"`); } catch { return body; }
  }
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  return v;
}

function decodeArgs(args: unknown): Json {
  if (!isObj(args)) return {};
  const out: Json = {};
  for (const [k, v] of Object.entries(args)) out[k] = unquote(v);
  return out;
}

/** A tool result's content opens with `Created At:` / `Completed At:` lines (once per call in a batch). */
function stripStamps(content: string): string {
  return content.replace(/^(?:(?:Created|Completed) At:[^\n]*\n?)+/, '');
}

const BOARD_TOOLS: Record<string, string> = { swarm_wait: 'waiting for posts', read_board: 'reading the board', post_message: 'posting' };

function postedSeq(content: string): number | null {
  const m = /"status"\s*:\s*"posted"\s*,\s*"seq"\s*:\s*(\d+)/.exec(content);
  return m ? Number(m[1]) : null;
}

type ToolEvent = Extract<ActivityEvent, { kind: 'tool' }>;

interface Planner {
  readonly calls: readonly { name: string; input: string }[];
  readonly tools: ToolEvent[];
  readonly results: { status: string; content: string }[];
  /** False once anything but a tool result lands after this planner step. */
  onlyResults: boolean;
}

/** One member's transcript folded into aggregates and a bounded timeline; never holds the steps themselves. */
class MemberLog {
  startedAt: number | null = null;
  lastEventAt: number | null = null;
  model: string | null = null;
  tokensOut: number | null = null;
  toolCount = 0;
  events: ActivityEvent[] = [];
  truncated = false;
  planner: Planner | null = null;
  lastType = '';
  lastReply: string | null = null;
  brief: string | null = null;
  private readonly parentConv: string;

  constructor(parentConv: string) { this.parentConv = parentConv; }

  // agy logs a few steps out of order (a planner step after the input that followed it), so step_index is not a rewrite signal.
  add(step: Json): void {
    const index = Number(step['step_index']);
    if (!Number.isFinite(index)) return;
    const type = String(step['type'] ?? '');
    const at = str(step['created_at']) ?? '';
    const ms = timeMs(at);
    if (ms !== null) {
      this.startedAt ??= ms;
      this.lastEventAt = Math.max(this.lastEventAt ?? ms, ms);
    }
    this.lastType = type;
    if (type === 'PLANNER_RESPONSE') this.addPlanner(step, index, at);
    else if (type === 'GENERIC') this.addResult(step, index);
    else {
      if (this.planner) this.planner.onlyResults = false;
      if (this.brief === null) this.brief = this.briefFrom(type, str(step['content']));
    }
  }

  private addPlanner(step: Json, index: number, at: string): void {
    const out = step['output_tokens'];
    if (typeof out === 'number' && Number.isFinite(out)) this.tokensOut = (this.tokensOut ?? 0) + out;
    this.model = str(step['model']) ?? this.model;
    const raw = Array.isArray(step['tool_calls']) ? step['tool_calls'] : [];
    const calls = raw.filter(isObj).map((c) => ({ name: String(c['name'] ?? ''), input: JSON.stringify(decodeArgs(c['args'])) }));
    this.toolCount += calls.length;
    const content = str(step['content']);
    if (content !== null && content.trim() !== '') this.push({ sequence: index, kind: 'assistant', at, text: cap(content) });
    if (calls.length === 0) this.lastReply = content ?? '';
    const tools = calls.map((c, i): ToolEvent => ({
      sequence: index + 1 + i, kind: 'tool', at, stepIndex: index + 1 + i, tool: c.name, input: cap(c.input), output: '', state: 'active',
    }));
    for (const t of tools) this.push(t);
    this.planner = { calls, tools, results: [], onlyResults: true };
  }

  private addResult(step: Json, index: number): void {
    const p = this.planner;
    if (!p || p.results.length >= p.calls.length) return;
    const status = String(step['status'] ?? '');
    const content = stripStamps(String(step['content'] ?? ''));
    const ev = p.tools[p.results.length]!;
    ev.sequence = index;
    ev.stepIndex = index;
    ev.output = cap(content);
    ev.state = status === 'DONE' ? 'done' : status === 'ERROR' ? 'error' : 'active';
    p.results.push({ status, content });
  }

  /** A sub-agent's brief is the first message its parent sent: `[Message] … sender=<parent> … content=<brief>`. */
  private briefFrom(type: string, content: string | null): string | null {
    if (content === null) return null;
    if (type === 'USER_INPUT') return content.trim();
    if (type !== 'SYSTEM_MESSAGE') return null;
    const m = /\[Message\][^\n]*?\bsender=(\S+)[^\n]*?\bcontent=([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/.exec(content);
    return m && m[1] === this.parentConv ? m[2]!.trim() : null;
  }

  private push(ev: ActivityEvent): void {
    this.events.push(ev);
    if (this.events.length > EVENT_CAP) {
      this.events.splice(0, this.events.length - EVENT_CAP);
      this.truncated = true;
    }
  }

  /** agy's turnEnded: a reply with no tool calls, or a batch with swarm_wait whose own result is DONE. */
  runStopped(): boolean {
    if (this.lastType === 'PLANNER_RESPONSE') return this.planner?.calls.length === 0;
    const p = this.planner;
    if (this.lastType !== 'GENERIC' || !p || !p.onlyResults) return false;
    const wait = p.calls.findIndex((c) => c.name === 'swarm_wait');
    return wait >= 0 && p.results.length >= p.calls.length && p.results[wait]!.status === 'DONE';
  }

  finalReply(): string | null {
    return this.lastType === 'PLANNER_RESPONSE' && this.planner?.calls.length === 0 ? this.lastReply : null;
  }

  activity(): string | null {
    const p = this.planner;
    if (!p) return null;
    if (p.calls.length === 0) return 'replied';
    const post = p.calls.findIndex((c) => c.name === 'post_message');
    const seq = post >= 0 && p.results[post] ? postedSeq(p.results[post]!.content) : null;
    if (seq !== null) return `posted #${seq}`;
    const last = p.calls[p.calls.length - 1]!;
    return BOARD_TOOLS[last.name] ?? classify(last.name, last.input).label;
  }
}

/** A member's transcript stream: chunk files in order, or the single transcript.jsonl when agy wrote no chunks. A shrink or a changed first chunk starts it over. */
class Transcript {
  log: MemberLog;
  private files: string[] = [];
  private sig: Buffer | null = null;
  private index = 0;
  private offset = 0;
  private lines = new LineCarry();
  private readonly logsDir: string;
  private readonly parentConv: string;

  constructor(logsDir: string, parentConv: string) {
    this.logsDir = logsDir;
    this.parentConv = parentConv;
    this.log = new MemberLog(parentConv);
  }

  get partial(): boolean { return this.lines.carry.length > 0; }

  private reset(): void {
    this.log = new MemberLog(this.parentConv);
    this.files = [];
    this.sig = null;
    this.index = 0;
    this.offset = 0;
    this.lines = new LineCarry();
  }

  private listFiles(): string[] {
    const dir = path.join(this.logsDir, 'chunks', 'transcript');
    try {
      return readdirSync(dir).filter((n) => CHUNK_RE.test(n)).sort().map((n) => path.join(dir, n));
    } catch {
      const single = path.join(this.logsDir, 'transcript.jsonl');
      return sizeOf(single) === null ? [] : [single];
    }
  }

  /** Reads up to `budget` new bytes; returns the bytes read. */
  read(budget: number): number {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const used = this.readOnce(budget);
      if (used !== null) return used;
      this.reset();
    }
    return 0;
  }

  /** null when the stream was rewritten under us. */
  private readOnce(budget: number): number | null {
    const files = this.listFiles();
    if (this.files.length > 0 && files[this.index] !== this.files[this.index]) return null;
    this.files = files;
    if (files.length > 0 && !sameStart(files[0]!, this.sig)) return null;
    if (files.length > 0 && (this.sig === null || this.sig.length < SIG_BYTES)) this.sig = readRange(files[0]!, 0, Math.min(sizeOf(files[0]!) ?? 0, SIG_BYTES));
    let used = 0;
    while (this.index < files.length && used < budget) {
      const size = sizeOf(files[this.index]!);
      if (size === null || size < this.offset) return null;
      const n = Math.min(size - this.offset, budget - used, STREAM_BUDGET);
      if (n > 0) {
        const chunk = readRange(files[this.index]!, this.offset, n);
        this.offset += chunk.length;
        used += chunk.length;
        this.lines.feed(chunk, (line) => { const step = parseLine(line); if (step) this.log.add(step); return true; });
        if (chunk.length < n) break;
      }
      if (this.offset < size) break;
      if (this.index + 1 >= files.length) break;
      this.index += 1;
      this.offset = 0;
    }
    return used;
  }
}

interface Post { readonly seq: number; readonly text: string }

/** board.jsonl tailed by byte offset; a shrink, a changed first line or a seq that does not follow restarts it. */
class Board {
  head: number | null = null;
  readonly lastPosts = new Map<string, Post>();
  readonly briefs = new Map<string, string>();
  private offset = 0;
  private sig: Buffer | null = null;
  private lines = new LineCarry();
  private readonly file: string;

  constructor(file: string) { this.file = file; }

  private reset(): void {
    this.head = null;
    this.lastPosts.clear();
    this.briefs.clear();
    this.offset = 0;
    this.sig = null;
    this.lines = new LineCarry();
  }

  read(budget: number, coordinator: string | null): number {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const used = this.readOnce(budget, coordinator);
      if (used !== null) return used;
      this.reset();
    }
    return 0;
  }

  private readOnce(budget: number, coordinator: string | null): number | null {
    const size = sizeOf(this.file);
    if (size === null) return this.offset === 0 ? 0 : null;
    if (size < this.offset) return null;
    if (!sameStart(this.file, this.sig)) return null;
    if (this.sig === null || this.sig.length < SIG_BYTES) this.sig = readRange(this.file, 0, Math.min(size, SIG_BYTES));
    const n = Math.min(size - this.offset, budget);
    if (n <= 0) return 0;
    // From the start, the file's own order stands: a rewrite is only a seq going back after what we already hold.
    const fresh = this.offset === 0;
    const chunk = readRange(this.file, this.offset, n);
    this.offset += chunk.length;
    const ok = this.lines.feed(chunk, (line) => {
      const post = parseLine(line);
      if (!post) return true;
      const seq = Number(post['seq']);
      if (!Number.isFinite(seq)) return true;
      if (this.head !== null && seq <= this.head) return fresh;
      this.head = seq;
      const agent = String(post['agent'] ?? '');
      const text = String(post['text'] ?? '');
      this.lastPosts.set(agent, { seq, text });
      if (post['kind'] === 'brief' || agent === coordinator) this.noteBrief(text);
      return true;
    });
    return ok ? chunk.length : null;
  }

  /** `@alpha @beta <brief>`: the first such post for a name is its brief. */
  private noteBrief(text: string): void {
    const names: string[] = [];
    let rest = text;
    for (let m = /^\s*@([A-Za-z0-9_.-]+)\s+/.exec(rest); m; m = /^\s*@([A-Za-z0-9_.-]+)\s+/.exec(rest)) {
      names.push(m[1]!);
      rest = rest.slice(m[0].length);
    }
    for (const name of names) if (name !== 'all' && !this.briefs.has(name)) this.briefs.set(name, rest.trim());
  }
}

/** `gemini-4-neon-high` → `Gemini 4 Neon (High)`. */
export function agyModelLabel(model: string | null): string | null {
  if (model === null || !/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(model)) return null;
  const words = model.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1));
  const effort = /^(?:minimal|low|medium|high|xhigh|max)$/i.test(words[words.length - 1]!) ? words.pop()! : null;
  return effort ? `${words.join(' ')} (${effort})` : words.join(' ');
}

/** A role line as a name: `Swarm Worker (alpha)` → `alpha`; otherwise the line cut to a cell. */
function shortName(role: string | null, id: string): string {
  if (role === null) return id.slice(0, 8);
  const m = /^Swarm Worker \(([^)]+)\)$/.exec(role);
  return m ? m[1]! : fitCell(oneLine(role), 28).trimEnd();
}

interface Seat {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly conv: string | null;
  readonly model: string | null;
  readonly killed: boolean;
  readonly wakeMode: string | null;
  readonly order: number;
}

export function createAgyTeamReader(options: AgyTeamReaderOptions): AgyTeamReader {
  const root = path.resolve(options.brainRoot ?? agyBrainRoot());
  const conv = options.conversationId;
  const base = path.join(root, conv, '.system_generated');
  const swarmDir = path.join(base, 'swarm');
  const subDir = path.join(base, 'subagents');
  const json = new JsonFiles();
  const transcripts = new Map<string, Transcript>();
  let board: Board | null = null;

  const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

  function swarmSeats(): { seats: Seat[]; title: string | null; coordinator: string | null } | null {
    const roster = json.read(path.join(swarmDir, 'members.json'));
    if (!isObj(roster) || !isObj(roster['members'])) return null;
    const seats: Seat[] = [];
    let coordinator: string | null = null;
    let order = 0;
    for (const [name, m] of Object.entries(roster['members'])) {
      if (!isObj(m)) continue;
      const memberConv = str(m['conversation_id']);
      if (memberConv === conv || m['role'] === 'coordinator') { coordinator = name; continue; }
      const model = str(m['applied_model']) ?? str(m['model']) ?? str(m['desired_model']);
      seats.push({
        id: name, name, role: str(m['role']) ?? 'worker', conv: memberConv && ID_RE.test(memberConv) ? memberConv : null,
        model, killed: m['killed'] === true, wakeMode: str(m['wake_mode']), order: order++,
      });
    }
    return { seats, title: str(roster['title']), coordinator };
  }

  function subagentSeats(): Seat[] {
    let names: string[];
    try { names = readdirSync(subDir).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
    const seats: Seat[] = [];
    for (const n of names) {
      const file = path.join(subDir, n);
      const j = json.read(file);
      if (!isObj(j)) continue;
      const child = str(j['conversationId']);
      if (child === null || !ID_RE.test(child)) continue;
      const desc = isObj(j['subagentDescriptor']) ? j['subagentDescriptor'] : {};
      const role = str(desc['role']) ?? str(desc['typeName']);
      const spawn = Number(j['spawnStepIndex']);
      seats.push({
        id: child, name: shortName(role, child), role: role ?? 'sub-agent', conv: child, model: null,
        killed: j['state'] === 'SUBAGENT_STATE_KILLED', wakeMode: null,
        order: Number.isFinite(spawn) ? spawn : Number.MAX_SAFE_INTEGER,
      });
    }
    json.forget((f) => path.dirname(f) !== subDir || names.includes(path.basename(f)));
    return seats.sort((a, b) => a.order - b.order);
  }

  function transcriptFor(memberConv: string): Transcript {
    let t = transcripts.get(memberConv);
    if (!t) {
      t = new Transcript(path.join(root, memberConv, '.system_generated', 'logs'), conv);
      transcripts.set(memberConv, t);
    }
    return t;
  }

  function stateOf(seat: Seat, t: Transcript | null, swarm: boolean): TeamMemberState {
    const log = t?.log ?? null;
    const hasSteps = log !== null && log.lastType !== '';
    const stopped = hasSteps && !t!.partial && log.runStopped();
    if (swarm) {
      if (seat.killed) return 'killed';
      if (hasSteps) return stopped ? 'waiting' : 'working';
      return seat.wakeMode === 'mentions' || seat.wakeMode === 'anything' ? 'waiting' : 'working';
    }
    // A sub-agent's final reply is its result; agy marks it KILLED once reaped, which is not a failure.
    if (stopped && log!.finalReply() !== null) return 'done';
    if (seat.killed) return 'killed';
    return stopped ? 'waiting' : 'working';
  }

  function poll(nowMs: number): AgyTeamRead | null {
    if (!ID_RE.test(conv)) return null;
    const swarm = isDir(swarmDir);
    if (!swarm && !isDir(subDir)) return null;
    let seats: Seat[];
    let title: string | null = null;
    let coordinator: string | null = null;
    if (swarm) {
      const s = swarmSeats();
      if (s === null) return null;
      ({ seats, title, coordinator } = s);
    } else {
      seats = subagentSeats();
    }
    if (seats.length === 0) return null;

    let budget = POLL_BUDGET;
    if (swarm) {
      board ??= new Board(path.join(swarmDir, 'board.jsonl'));
      budget -= board.read(budget, coordinator);
    }
    const plan = swarm ? json.read(path.join(swarmDir, 'plan.json')) : undefined;
    const tasks = isObj(plan) && isObj(plan['tasks']) ? plan['tasks'] : {};

    const live = new Set(seats.map((s) => s.conv).filter((c): c is string => c !== null));
    for (const c of transcripts.keys()) if (!live.has(c)) transcripts.delete(c);
    for (const seat of seats) {
      if (seat.conv === null) continue;
      budget -= transcriptFor(seat.conv).read(Math.max(0, budget));
    }

    const members: TeamMember[] = [];
    const views: MemberView[] = [];
    for (const seat of seats) {
      const t = seat.conv ? transcripts.get(seat.conv) ?? null : null;
      const log = t?.log ?? null;
      const brief = (swarm ? board?.briefs.get(seat.name) : undefined) ?? log?.brief ?? null;
      const post = swarm ? board?.lastPosts.get(seat.name) ?? null : null;
      const taskLine = str(tasks[seat.name]);
      const model = seat.model ?? log?.model ?? null;
      members.push({
        id: seat.id, name: seat.name, role: seat.role, model, modelLabel: agyModelLabel(model),
        task: taskLine !== null ? firstLine(taskLine) : brief !== null ? firstLine(brief) || null : null,
        state: stateOf(seat, t, swarm),
        activity: log?.activity() ?? null,
        toolCount: log?.toolCount ?? 0,
        tokensOut: log?.tokensOut ?? null,
        startedAt: log?.startedAt ?? null,
        lastEventAt: log?.lastEventAt ?? null,
        lastPost: post ? { seq: post.seq, text: firstLine(post.text) } : null,
      });
      views.push({
        schema: 1, id: seat.id, name: seat.name, brief,
        report: post?.text ?? log?.finalReply() ?? null,
        timeline: (log?.events ?? []).map((e) => ({ ...e })),
        truncated: log?.truncated ?? false,
      });
    }
    return {
      team: { schema: 1, source: swarm ? 'agy-swarm' : 'agy-subagents', title, boardHead: board?.head ?? null, members, updatedAt: nowMs },
      views,
    };
  }

  return {
    poll(nowMs: number): AgyTeamRead | null {
      try { return poll(nowMs); } catch { return null; }
    },
  };
}
