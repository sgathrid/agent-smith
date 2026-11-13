/**
 * Agent Smith workers as native Claude Code subagents.
 *
 * The mod registers one agent type per installed provider and per models.json alias
 * (agent-types.ts). An Agent call with one of those types runs a native subagent whose
 * "model" is the `turn.step` hook below: no model request is made. Each step asks the
 * pure driver (agent-driver.ts) for the next tool call, and yields it, so the engine
 * runs spawn_job, status (with wait_ms), steer_job and finally SubagentHandback with
 * the worker's report. A SendMessage to the agent arrives as a coordinator reminder,
 * which the driver turns into steer_job. Stopping the agent cancels the job.
 */
import { atom, update, type EngineInterface, type Register } from 'claude-code';
import { agentSpec, agentTypes, type AgentTypeSpec } from './agent-types.ts';
import { recordLaunch, type Launched } from './dashboard.ts';
import { readForgeDetail } from './canonical.ts';
import { classify } from './progress.ts';
import type { FsLike } from './fs.ts';
import { applyTailRecord, coordinatorMessages, formatProgress, handbackByTool, HANDBACK, nextStep, splitLines, statusPollState, stepLines, toDriverMessages, WAIT_MS, withoutReminders, type DriverMessage, type TailState } from './agent-driver.ts';
export { handbackByTool, toDriverMessages } from './agent-driver.ts';

/** The agent-smith MCP server, as /mcp names it in the built plugin. */
export const SERVER = 'plugin:agent-smith:agent-smith';
export const TOOL_PREFIX = 'mcp__plugin_agent-smith_agent-smith__';

/** Registered types this module drives, by short name (the engine prefixes `<plugin>:`). */
const ours = new Map<string, AgentTypeSpec>();
/** Each agent's job across its turns: a resumed agent follows up on the same worker. */
const runs = new Map<string, { jobId: string; handled: number; task: DriverMessage | undefined; repo: string; nodePath: string | undefined; seq: number }>();
/** Job IDs each running agent started, so a stop can cancel them. */
const jobsByAgent = new Map<string, string>();

const fsOf = ($: EngineInterface): FsLike => ({
  read: (p) => $.fs.read(p),
  list: (p) => $.fs.list(p),
  exists: (p) => $.fs.exists(p),
});

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function payload(result: { content?: unknown; structuredContent?: unknown }): Record<string, unknown> | null {
  if (isObj(result.structuredContent)) return result.structuredContent;
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (isObj(block) && typeof block['text'] === 'string') {
      try { const v = JSON.parse(block['text']) as unknown; if (isObj(v)) return v; } catch { /* not JSON */ }
    }
  }
  return null;
}

/** Ask the server what is installed and configured, and register the agent types. Retries while the server connects. */
async function registerTypes($: EngineInterface, attempt = 0): Promise<void> {
  try {
    const caps = payload(await $.mcp.call(SERVER, 'list_capabilities', {}) as { content?: unknown; structuredContent?: unknown });
    if (caps === null) throw new Error('no capabilities');
    const providers = Array.isArray(caps['providers']) ? caps['providers'].filter(isObj).map((p) => ({
      name: String(p['name']), available: p['available'] === true,
      defaultModel: typeof p['defaultModel'] === 'string' ? p['defaultModel'] : null,
    })) : [];
    const aliasList = isObj(caps['aliases']) && Array.isArray(caps['aliases']['aliases']) ? caps['aliases']['aliases'].filter(isObj) : [];
    const aliases: Record<string, { provider: string; model?: string; effort?: string }> = {};
    for (const a of aliasList) {
      if (typeof a['name'] !== 'string' || typeof a['provider'] !== 'string') continue;
      aliases[a['name']] = { provider: a['provider'], ...(typeof a['model'] === 'string' ? { model: a['model'] } : {}), ...(typeof a['effort'] === 'string' ? { effort: a['effort'] } : {}) };
    }
    ours.clear();
    for (const t of agentTypes({ providers, aliases })) {
      await $.agent.register(agentSpec(t, TOOL_PREFIX) as never);
      ours.set(t.name, t);
    }
  } catch {
    if (attempt < 6) $.clock.after(2_000 * (attempt + 1), () => { void registerTypes($, attempt + 1); });
  }
}



/** The registered type an agent was spawned as, when it is one of ours. */
async function ourType($: EngineInterface, agentId: string | undefined): Promise<{ spec: AgentTypeSpec; name: string } | null> {
  if (agentId === undefined || ours.size === 0) return null;
  const me = (await $.agent.list().catch(() => [] as Awaited<ReturnType<EngineInterface['agent']['list']>>)).find((a) => a.id === agentId);
  const spec = me && me.type.includes(':') ? ours.get(me.type.slice(me.type.lastIndexOf(':') + 1)) : undefined;
  return spec && me ? { spec, name: me.name ?? spec.name } : null;
}

/** True when a tool call comes from one of this module's agents (its notices are its own handback). */
export async function isOurAgent($: EngineInterface, agentId: string | undefined): Promise<boolean> {
  return (await ourType($, agentId)) !== null;
}

/** The session-start half, called from register.tsx's one session.start hook (a second one is refused). Never throws. */
export function startNativeAgents($: EngineInterface): void {
  // An older Claude Code without agent types or MCP calls makes these calls throw: the
  // catch leaves native agents off and the rest of the mod unaffected. (The mod
  // validator allows $ only in call position, so the probe is the call itself.)
  void registerTypes($).catch(() => {});
}

/**
 * A job a native agent started: /forge lists it (`launched`), and the band, native tasks
 * and notices leave it out (`nativeJobs`): Claude Code's own agent row shows it.
 * Same keys as register.tsx's atoms, so both read one state.
 */
const launchedState = atom({ plugin: 'agent-smith', key: 'launched' } as const, { jobs: [], runs: [] } as Launched);
const nativeJobsState = atom({ plugin: 'agent-smith', key: 'nativeJobs' } as const, [] as string[]);
async function noteLaunch($: EngineInterface, jobId: string): Promise<void> {
  await update($, nativeJobsState, (ids) => (ids.includes(jobId) ? ids : [...ids, jobId])).catch(() => {});
  await update($, launchedState, (l) => recordLaunch(l, { kind: 'job', id: jobId })).catch(() => {});
}

export function registerNativeAgents(on: Parameters<Register>[0]): void {

  on('turn.step', async function* ($, e, next) {
    const mine = await ourType($, e.agentId);
    if (mine === null) return yield* next(e);
    const agentId = e.agentId!;
    const api = await $.session.messages({ agentId, as: 'api' } as never) as unknown;
    const messages = Array.isArray(api) ? toDriverMessages(api as never) : [];
    const call = async (tool: string, args: Record<string, unknown>) => {
      const r = await $.mcp.call(SERVER, tool, args).catch((err: unknown) => ({ isError: true, content: [{ type: 'text', text: String(err) }] }));
      const data = payload(r as never);
      const text = Array.isArray((r as { content?: unknown }).content) ? ((r as { content: unknown[] }).content).map((c) => (isObj(c) && typeof c['text'] === 'string' ? c['text'] : '')).join('') : '';
      return { ok: (r as { isError?: boolean }).isError !== true && data !== null, data: data ?? {}, text };
    };
    let shown = '';
    const say = (line: string) => { const chunk = `${shown === '' ? '' : '\n'}${line}`; shown = line; return { kind: 'text' as const, index: 0, text: chunk }; };
    const finish = function* (report: string) {
      // The run is kept: a message after the end resumes this agent on the same worker.
      if (handbackByTool(messages)) {
        const input = { message: report };
        yield { kind: 'tool' as const, index: 1, id: `toolu_smith_${e.turnId.slice(-8)}_${e.index}`, name: HANDBACK };
        yield { kind: 'input' as const, index: 1, json: JSON.stringify(input) };
        yield { kind: 'stop' as const, stopReason: 'tool_use' as const, usage: null };
        return { turnId: e.turnId, index: e.index, answer: shown, toolUses: [{ name: HANDBACK, input }], stopReason: 'tool_use' as const, usage: null };
      }
      yield say(report);
      yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null };
      return { turnId: e.turnId, index: e.index, answer: report, toolUses: [], stopReason: 'end_turn' as const, usage: null };
    };

    // The whole run happens inside this step: agent-smith is called directly, so the
    // transcript holds the progress and the report, not a tool row per call.
    const coords = coordinatorMessages(messages);
    let run = runs.get(agentId);
    const firstUser = messages.find((m) => m.role === 'user');
    if (run === undefined) {
      const plan = nextStep({ messages: firstUser ? [firstUser] : [], toolPrefix: TOOL_PREFIX, defaults: mine.spec.defaults, agentName: mine.name });
      if (plan.tool === undefined || plan.tool.name !== `${TOOL_PREFIX}spawn_job`) return yield* finish(`Status: BLOCKED\n${plan.text}`);
      const ack = await call('spawn_job', plan.tool.input);
      if (!ack.ok || typeof ack.data['jobId'] !== 'string') return yield* finish(`Status: BLOCKED\n${withoutReminders(ack.text) || 'spawn_job returned no job'}`);
      // Name what is running: the header above shows the placeholder model, not the worker.
      yield say(['agent-smith', ack.data['provider'], ack.data['model'] ?? 'default model', plan.tool.input['mode']].filter((x) => typeof x === 'string' && x !== '').join(' · '));
      const nodePath = typeof ack.data['nodePath'] === 'string' && ack.data['nodePath'] !== '' ? ack.data['nodePath'] : undefined;
      run = { jobId: ack.data['jobId'], handled: coords.length, task: firstUser, repo: typeof ack.data['repo'] === 'string' ? ack.data['repo'] : '', nodePath, seq: 0 };
      runs.set(agentId, run);
      await noteLaunch($, run.jobId);
    } else if (coords.length > run.handled) {
      // Resumed by a message that arrived after the job ended: send it as a follow-up.
      for (const prompt of coords.slice(run.handled)) {
        yield say('Sending your message to the worker…');
        const ack = await call('resume_job', { worker: run.jobId, prompt });
        if (!ack.ok || typeof ack.data['jobId'] !== 'string') return yield* finish(`Status: BLOCKED\n${withoutReminders(ack.text) || 'resume_job failed'}`);
        run.jobId = ack.data['jobId'];
        if (typeof ack.data['repo'] === 'string' && ack.data['repo'] !== '') run.repo = ack.data['repo'];
        if (typeof ack.data['nodePath'] === 'string' && ack.data['nodePath'] !== '') run.nodePath = ack.data['nodePath'];
        run.seq = 0;
        await noteLaunch($, run.jobId);
      }
      run.handled = coords.length;
    }

    const activeRun = run;
    jobsByAgent.set(agentId, activeRun.jobId);
    if (next.signal.aborted) { void call('cancel', { jobId: activeRun.jobId }); return; }

    // Fallback when process.spawn is unavailable or tail.js exits without settling.
    const waitByStatus = async function* () {
      let waitMs = WAIT_MS;
      let prevKey = '';
      for (;;) {
        if (next.signal.aborted) return 'aborted' as const;
        const r = await call('status', { jobId: activeRun.jobId, wait_ms: waitMs, until: 'change' });
        if (next.signal.aborted) return 'aborted' as const;
        if (!r.ok) return { blocked: `Status: BLOCKED\n${withoutReminders(r.text) || 'status failed'}` };
        const st = r.data;
        let changed = false;
        if (typeof st['jobId'] === 'string' && st['jobId'] !== '' && st['jobId'] !== activeRun.jobId) {
          activeRun.jobId = st['jobId'];
          activeRun.seq = 0;
          jobsByAgent.set(agentId, activeRun.jobId);
          changed = true;
        }
        // The worker's own steps, one line each, as a native subagent shows its tool calls.
        const detail = activeRun.repo === '' ? null : await readForgeDetail(fsOf($), activeRun.repo, activeRun.jobId, await $.clock.now()).catch(() => null);
        if (detail?.timeline) {
          const { lines, last } = stepLines(detail.timeline as never, activeRun.seq, (tool, input) => classify(tool, input).label);
          if (last !== activeRun.seq) changed = true;
          activeRun.seq = last;
          for (const line of lines) yield say(line);
        } else {
          const line = formatProgress(st);
          if (line !== shown) { yield say(line); changed = true; }
        }
        const acc = isObj(st['acceptance']) ? st['acceptance'] : null;
        const key = `${activeRun.jobId}:${String(st['status'])}:${String(st['toolCalls'] ?? '')}:${String(acc?.['pending'] ?? '')}`;
        if (prevKey !== '' && key !== prevKey) changed = true;
        prevKey = key;
        const poll = statusPollState(st, changed);
        if (poll.done) break;
        waitMs = poll.waitMs;
      }
      // The steps that finished with the job.
      const tail = activeRun.repo === '' ? null : await readForgeDetail(fsOf($), activeRun.repo, activeRun.jobId, await $.clock.now()).catch(() => null);
      if (tail?.timeline) {
        const { lines, last } = stepLines(tail.timeline as never, activeRun.seq, (tool, input) => classify(tool, input).label);
        activeRun.seq = last;
        for (const line of lines) yield say(line);
      }
      return 'settled' as const;
    };

    // Stream worker events from tail.js; leaving the loop on settle or abort kills tail.
    let tailState: TailState = { jobId: activeRun.jobId, settled: false, step: null };
    try {
      const stream = $.process.spawn({
        argv: [activeRun.nodePath ?? 'node', `${$.plugin.root}/runtime/dist/tail.js`, '--job', activeRun.jobId, '--repo', activeRun.repo],
      });
      let buf = '';
      for await (const chunk of stream) {
        if (next.signal.aborted) break;
        if (chunk.stream === 'stderr') continue;
        const split = splitLines(buf, chunk.text);
        buf = split.rest;
        for (const line of split.lines) {
          if (line === '') continue;
          let parsed: unknown;
          try { parsed = JSON.parse(line); } catch { continue; }
          const prevJobId = tailState.jobId;
          tailState = applyTailRecord(tailState, parsed);
          if (tailState.step !== null) yield say(tailState.step);
          if (tailState.jobId !== prevJobId) {
            activeRun.jobId = tailState.jobId;
            jobsByAgent.set(agentId, activeRun.jobId);
          }
          if (tailState.settled) break;
        }
        if (tailState.settled) break;
      }
      if (!tailState.settled && !next.signal.aborted && buf !== '') {
        try {
          const prevJobId = tailState.jobId;
          tailState = applyTailRecord(tailState, JSON.parse(buf));
          if (tailState.step !== null) yield say(tailState.step);
          if (tailState.jobId !== prevJobId) {
            activeRun.jobId = tailState.jobId;
            jobsByAgent.set(agentId, activeRun.jobId);
          }
        } catch { /* trailing partial line */ }
      }
    } catch {
      // process.spawn rejected (outside CLI, missing node or tail.js): fall back below.
    }
    if (next.signal.aborted) { void call('cancel', { jobId: activeRun.jobId }); return; }
    if (!tailState.settled) {
      const outcome = yield* waitByStatus();
      if (outcome === 'aborted') { void call('cancel', { jobId: activeRun.jobId }); return; }
      if (typeof outcome === 'object') { jobsByAgent.delete(agentId); return yield* finish(outcome.blocked); }
    }

    // Compose the hand-back from both the settled concise status (error, acceptance) and full report.
    let fin = await call('status', { jobId: activeRun.jobId });
    if (next.signal.aborted) { void call('cancel', { jobId: activeRun.jobId }); return; }
    if (fin.ok && typeof fin.data['jobId'] === 'string' && fin.data['jobId'] !== '') activeRun.jobId = fin.data['jobId'];
    if (fin.ok && !statusPollState(fin.data, true).done) {
      jobsByAgent.set(agentId, activeRun.jobId);
      const outcome = yield* waitByStatus();
      if (outcome === 'aborted') { void call('cancel', { jobId: activeRun.jobId }); return; }
      if (typeof outcome === 'object') { jobsByAgent.delete(agentId); return yield* finish(outcome.blocked); }
      fin = await call('status', { jobId: activeRun.jobId });
      if (next.signal.aborted) { void call('cancel', { jobId: activeRun.jobId }); return; }
      if (fin.ok && typeof fin.data['jobId'] === 'string' && fin.data['jobId'] !== '') activeRun.jobId = fin.data['jobId'];
    }
    const rep = await call('status', { jobId: activeRun.jobId, report_only: true });
    if (next.signal.aborted) { void call('cancel', { jobId: activeRun.jobId }); return; }
    jobsByAgent.delete(agentId);
    const prefix = TOOL_PREFIX;
    const done = nextStep({ toolPrefix: prefix, defaults: mine.spec.defaults, agentName: mine.name, messages: [
      activeRun.task ?? { role: 'user', text: '', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [
        { id: 'a', name: `${prefix}spawn_job`, input: {}, resultText: JSON.stringify({ jobId: activeRun.jobId, status: 'running' }) },
        { id: 'b', name: `${prefix}status`, input: { jobId: activeRun.jobId }, resultText: fin.ok ? JSON.stringify(fin.data) : fin.text, ...(fin.ok ? {} : { isError: true }) },
        { id: 'c', name: `${prefix}status`, input: { jobId: activeRun.jobId, report_only: true }, resultText: rep.ok ? JSON.stringify(rep.data) : rep.text, ...(rep.ok ? {} : { isError: true }) },
      ] },
    ] });
    const report = typeof done.tool?.input['message'] === 'string' ? done.tool.input['message'] : `Status: BLOCKED\n${done.text}`;
    return yield* finish(report);
  });

  // SendMessage to one of our agents while its job runs: steer the worker now, without
  // waiting for a tool round. Otherwise (no live job: the agent finished) the engine
  // delivers it as usual, which resumes the agent, and the driver sends it as resume_job.
  on('session.send', async ($, e, next) => {
    if (ours.size === 0 || jobsByAgent.size === 0) return next(e);
    const agents = await $.agent.list().catch(() => []);
    const target = agents.find((a) => (a.id === e.to || a.name === e.to) && jobsByAgent.has(a.id));
    const jobId = target ? jobsByAgent.get(target.id) : undefined;
    if (!target || jobId === undefined) return next(e);
    const r = await $.mcp.call(SERVER, 'steer_job', { worker: jobId, prompt: e.text, delivery: 'queue' }).catch(() => null);
    return r !== null && r.isError !== true ? { isDelivered: true } : next(e);
  });

  // A stopped agent (TaskStop, an interrupt) ends its turn without handing back: cancel its job.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e);
    const agentId = (e as { agentId?: string }).agentId;
    const jobId = agentId === undefined ? undefined : jobsByAgent.get(agentId);
    if (agentId !== undefined && jobId !== undefined) {
      jobsByAgent.delete(agentId);
      const status = payload(await $.mcp.call(SERVER, 'status', { jobId }).catch(() => ({})) as { content?: unknown });
      if (status !== null && status['status'] === 'running') await $.mcp.call(SERVER, 'cancel', { jobId }).catch(() => {});
    }
    return r;
  });
}
