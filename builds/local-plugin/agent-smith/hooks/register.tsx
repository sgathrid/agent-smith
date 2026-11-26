import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, UiRenderEvent } from 'claude-code';

import type { RadarJob } from '../types/index.d.ts';
import { jobLabel, oneLine, sanitizeText } from './format.ts';
import { commandTerminalColumns, findWorker, groupWorkers, isLive, measurePaneTerminalColumns, paneWidthRequest, recordLaunch, scopeLine, sessionBoard, sessionJobs, workerHead, workerTurns, type Launched } from './dashboard.ts';
import { renderList, renderWorker, type ViewActions, type ViewOptions } from './views.tsx';
import type { ForgeDetail } from './canonical.ts';
import {
  buildLine,
  isShown,
  noColor,
  overflowLine,
  rowBudget,
} from './band.ts';
import type { FsLike } from './fs.ts';
import { sortForBand } from './format.ts';
import { isSettledForCache, readForgeJobs, readForgeDetail } from './canonical.ts';
import {
  LAUNCH_TOOL,
  STATUS_TOOL,
  asRunRecord,
  claim,
  claimMarkerPath,
  claudeText,
  displayNoticeText,
  due,
  parseLaunches,
  parseSettledRead,
  refusesStatusWait,
  runFileName,
  unclaim,
  type Launch,
  type Owned,
  type RunRecord,
} from './notice.ts';
import {
  hasPendingNativeClose,
  nativeJobsFromRadar,
  syncNativeTasks,
  type NativeTaskClient,
  type NativeTaskLinks,
} from './native.ts';
import { RELEASED_MANIFEST, manifestVersion, updateLine } from './update.ts';

const PANE = 'agent-smith';

let lastViewportColumns: number | null = null;
let lastPaneRequest: number | null = null;

function noteViewport(columns: number | undefined): void {
  if (typeof columns === 'number' && Number.isFinite(columns) && columns > 0) {
    lastViewportColumns = Math.floor(columns);
  }
}

async function requestPane($: EngineInterface, force = false): Promise<void> {
  const columns = paneWidthRequest(lastViewportColumns);
  if (!force && lastPaneRequest === columns) return;
  lastPaneRequest = columns;
  await $.ui.open({
    id: PANE,
    title: 'Agent Smith',
    ...(force ? { focus: true } : {}),
    columns,
  });
}

const selected = atom({ plugin: 'agent-smith', key: 'selected' } as const, null as string | null);
const pinnedTurnId = atom({ plugin: 'agent-smith', key: 'pinnedTurnId' } as const, null as string | null);
const now = atom({ plugin: 'agent-smith', key: 'now' } as const, 0);

const follow = atom({ plugin: 'agent-smith', key: 'follow' } as const, true as boolean);
const taskOpen = atom({ plugin: 'agent-smith', key: 'taskOpen' } as const, false as boolean);
const listPage = atom({ plugin: 'agent-smith', key: 'listPage' } as const, 0);
const paneOpen = atom({ plugin: 'agent-smith', key: 'paneOpen' } as const, false);
const readError = atom({ plugin: 'agent-smith', key: 'readError' } as const, null as string | null);
const expandedTools = atom({ plugin: 'agent-smith', key: 'expandedTools' } as const, [] as string[]);
let followingSite: string | null = null;
const nativeTaskLinks = atom(
  { plugin: 'agent-smith', key: 'nativeTaskLinks' } as const,
  {} as NativeTaskLinks,
);

const DEFAULT_REPO = '';

const bandJobs = atom({ plugin: 'agent-smith', key: 'bandJobs' } as const, [] as RadarJob[]);
const bandConfig = atom({ plugin: 'agent-smith', key: 'bandConfig' } as const, {
  repo: DEFAULT_REPO,
  colour: true,
  source: 'cwd' as 'cwd' | 'launch',
});

const notices = atom({ plugin: 'agent-smith', key: 'notices' } as const, [] as Owned[]);

const launched = atom({ plugin: 'agent-smith', key: 'launched' } as const, { jobs: [], runs: [] } as Launched);
const listScope = atom({ plugin: 'agent-smith', key: 'listScope' } as const, 'session' as 'session' | 'all');

async function sessionRows($: EngineInterface): Promise<RadarJob[]> {
  const jobs = await read($, bandJobs);
  const mine = await read($, launched);
  return sessionJobs(jobs, mine);
}

const BAND_TICK_MS = 1000;

const POLL_MS = 1000;

const settledJobCache = new Map<string, RadarJob>();

const fsOf = ($: EngineInterface): FsLike => ({
  read: (p) => $.fs.read(p),
  list: (p) => $.fs.list(p),
  exists: (p) => $.fs.exists(p),
});

async function pollBand($: EngineInterface): Promise<void> {
  const cfg = await read($, bandConfig);
  if (cfg.repo === '') return;
  const at = await $.clock.now();
  let next: RadarJob[];
  try {
    next = await readForgeJobs(fsOf($), cfg.repo, at, settledJobCache);
    if (await read($, readError) !== null) await update($, readError, () => null);
  } catch (error) {
    const message = `Can't read job state: ${String(error).slice(0, 200)}`;
    if (await read($, readError) !== message) await update($, readError, () => message);
    return;
  }

  const previous = await read($, bandJobs);

  const before = JSON.stringify(previous);
  if (before !== JSON.stringify(next)) {
    detailCache = null;
    await update($, bandJobs, () => next);
  }
  await pollNativeTasks($, next);
}

// ── completion notices ───────────────────────────────────────────────────────
//
// The plugin's PostToolUse command hook (watch-hook.js) can wake Claude, but
// the host labels its exit-2 wake "Stop hook feedback", which reads as an error.
// When this mod is loaded it claims the launch (tool.call) and announces it
// itself, with one `$.prompt.submit` turn credited to this plugin. Claude Code
// shows that message to the user in full, so it is the only notice.
//
// The mod hooks `tool.call` only, never `classic.PostToolUse`: Claude Code's
// built-in guard (cc-plugin-sec-default) sends classic.* events past user-tier
// modules, so a classic handler here never runs and the host says so in the
// transcript on every launch.

const sameRepo = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

async function takeLaunch($: EngineInterface, launch: Launch, cwd: string): Promise<boolean> {
  const repo = launch.repo ?? cwd;
  const switched = repo !== '' && await adoptRepo($, repo);
  const cfg = await read($, bandConfig);
  const inWatchedRepo = cfg.repo !== '' && sameRepo(repo, cfg.repo);
  if (inWatchedRepo) await update($, launched, (l) => recordLaunch(l, launch));
  if (switched || inWatchedRepo) {
    detailCache = null;
    await pollBand($).catch(() => {});
    const atNow = await $.clock.now();
    await update($, now, () => atNow).catch(() => {});
  }
  if (cfg.repo === '' || await read($, readError) !== null) return false;
  if (!sameRepo(repo, cfg.repo)) return false;
  const at = await $.clock.now();
  await update($, notices, (owned) => claim(owned, launch, at));
  await $.fs.write(claimMarkerPath(cfg.repo, launch.kind, launch.id), `${new Date(at).toISOString()}\n`).catch(() => {});
  return true;
}

async function adoptRepo($: EngineInterface, repo: string): Promise<boolean> {
  const cfg = await read($, bandConfig);
  if (sameRepo(repo, cfg.repo)) {
    if (cfg.source !== 'launch') await update($, bandConfig, (c) => ({ ...c, source: 'launch' as const }));
    return false;
  }
  settledJobCache.clear();
  detailCache = null;
  idleEntries = null;
  await update($, bandConfig, (c) => ({ ...c, repo: trimSlashes(repo), source: 'launch' as const }));
  await update($, bandJobs, () => []);
  await update($, readError, () => null);
  return true;
}

const trimSlashes = (p: string): string => p.replace(/\/+$/, '') || p;

let announcing = false;
let submittingNotice = false;
let inMainTurn = false;
let interactive = false;
let turnHooksRegistered = false;

function setMainTurn(active: boolean): void {
  if (active && (!interactive || !turnHooksRegistered)) return;
  inMainTurn = active;
}

function isPromptDropped(result: unknown): boolean {
  return result !== null && typeof result === 'object' && typeof (result as { drop?: unknown }).drop === 'string';
}

async function commitNoticeState(
  $: EngineInterface,
  repo: string,
  prevOwned: readonly Owned[],
  nextOwned: readonly Owned[],
  at: number,
): Promise<void> {
  for (const o of nextOwned) {
    if (!prevOwned.some((prev) => prev.kind === o.kind && prev.id === o.id)) {
      await $.fs.write(claimMarkerPath(repo, o.kind, o.id), `${new Date(at).toISOString()}\n`).catch(() => {});
    }
  }
  const prevByKey = new Map(prevOwned.map((o) => [`${o.kind}:${o.id}`, o]));
  const nextByKey = new Map(nextOwned.map((o) => [`${o.kind}:${o.id}`, o]));
  await update($, notices, (current) => {
    const updated: Owned[] = [];
    const seenCurrent = new Set<string>();
    for (const c of current) {
      const k = `${c.kind}:${c.id}`;
      seenCurrent.add(k);
      const prev = prevByKey.get(k);
      const next = nextByKey.get(k);
      if (next !== undefined) {
        updated.push({
          ...next,
          ...(c.readHead !== undefined ? { readHead: c.readHead } : {}),
        });
      } else if (prev === undefined || c.readHead !== undefined) {
        updated.push(c);
      }
    }
    for (const o of nextOwned) {
      const k = `${o.kind}:${o.id}`;
      if (!seenCurrent.has(k) && !prevByKey.has(k)) {
        updated.push(o);
      }
    }
    return updated;
  });
}

function ownedDiffers(a: readonly Owned[], b: readonly Owned[]): boolean {
  return a.length !== b.length ||
    a.some((o, i) =>
      o.id !== b[i]?.id ||
      o.kind !== b[i]?.kind ||
      o.workerId !== b[i]?.workerId ||
      o.saidAttention !== b[i]?.saidAttention ||
      o.saidDead !== b[i]?.saidDead ||
      o.saidExited !== b[i]?.saidExited ||
      o.fromTurn !== b[i]?.fromTurn ||
      o.readHead !== b[i]?.readHead);
}

async function holdAndCommitNotices(
  $: EngineInterface,
  repo: string,
  jobs: readonly RadarJob[],
  runs: ReadonlyMap<string, RunRecord>,
  at: number,
): Promise<void> {
  if (inMainTurn) return;
  const latest = await read($, notices);
  if (latest.length === 0) return;
  const fresh = due(latest, jobs, runs, at);
  if (fresh.notices.length === 0) {
    if (ownedDiffers(latest, fresh.owned)) {
      await commitNoticeState($, repo, latest, fresh.owned, at);
    }
    return;
  }
  if (inMainTurn || submittingNotice) return;
  submittingNotice = true;
  void $.prompt
    .submit({ text: claudeText(fresh.notices) })
    .then(async (res) => {
      if (!isPromptDropped(res)) {
        await commitNoticeState($, repo, latest, fresh.owned, at);
      }
    })
    .catch(() => {})
    .finally(() => {
      submittingNotice = false;
    });
}

async function announce($: EngineInterface, repo: string, jobs: readonly RadarJob[], at: number): Promise<void> {
  if (inMainTurn || announcing || submittingNotice) return;
  announcing = true;
  try {
    const owned = await read($, notices);
    if (owned.length === 0) return;
    const runs = new Map<string, RunRecord>();
    for (const o of owned) {
      if (o.kind !== 'run') continue;
      const file = `${repo.replace(/\/+$/, '')}/.agent-smith/pipelines/${runFileName(o.id)}`;
      try {
        const run = await $.fs.exists(file) ? asRunRecord(JSON.parse(await $.fs.read(file))) : null;
        if (run) runs.set(o.id, run);
      } catch {}
    }
    const result = due(owned, jobs, runs, at);
    if (result.notices.length === 0 && !ownedDiffers(owned, result.owned)) return;
    await holdAndCommitNotices($, repo, jobs, runs, at);
  } finally {
    announcing = false;
  }
}

async function checkForUpdate($: EngineInterface): Promise<void> {
  if (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC').catch(() => undefined)) return;
  const current = manifestVersion(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`));
  const released = await $.http.fetch(RELEASED_MANIFEST);
  const line = updateLine(current, released.ok ? manifestVersion(released.text) : null);
  if (line !== null) await $.ui.toast(line);
}

let polling = false;

let idleEntries: string | null = null;

async function jobsListing($: EngineInterface, repo: string): Promise<string> {
  try {
    const entries = await $.fs.list(`${repo.replace(/\/+$/, '')}/.agent-smith/jobs`);
    return entries.filter((e) => e.kind === 'dir' && !e.name.startsWith('.')).map((e) => e.name).sort().join('\n');
  } catch {
    return '';
  }
}

export async function startBand($: EngineInterface, cwd?: string): Promise<void> {
  lastViewportColumns = null;
  lastPaneRequest = null;
  followingSite = null;
  detailCache = null;
  polling = false;
  setMainTurn(false);
  idleEntries = null;
  settledJobCache.clear();

  // NO_COLOR first, because it decides every colour prop from here on.
  // `$.env.get` requires a string LITERAL name (VERIFIED: a computed name is
  // refused at compile time, "so the variables a module reads and writes can be
  // listed"), so each is spelled out. no-color.org: present AND non-empty means
  // no colour; FORCE_COLOR=0/false and TERM=dumb are the same request.
  const [nc, force, term] = await Promise.all([
    $.env.get('NO_COLOR').catch(() => undefined),
    $.env.get('FORCE_COLOR').catch(() => undefined),
    $.env.get('TERM').catch(() => undefined),
  ]);
  await update($, bandConfig, (previous) => ({
    ...(previous.source === 'launch' && previous.repo !== '' ? { repo: previous.repo, source: 'launch' as const }
      : { repo: cwd !== undefined && cwd !== '' ? cwd : DEFAULT_REPO, source: 'cwd' as const }),
    colour: !noColor({ NO_COLOR: nc, FORCE_COLOR: force, TERM: term }),
  }));

  await pollBand($).catch(() => {});

  const seeded = await $.clock.now();
  await update($, now, () => seeded).catch(() => {});

  $.clock.every(BAND_TICK_MS, () => {
    void (async () => {
      const at = await $.clock.now();
      const previousTime = await read($, now);
      const visible = groupWorkers(await sessionRows($)).some(j => isShown(j, previousTime));
      if (visible || await read($, paneOpen)) await update($, now, () => at);
    })().catch(() => {});
  });

  $.clock.every(POLL_MS, () => {
    void (async () => {
      if (polling) return;
      polling = true;
      try {
        const cfg = await read($, bandConfig);
        if (cfg.repo === '') return;
        const isPaneOpen = await read($, paneOpen);
        const owned = await read($, notices);
        const currentJobs = await read($, bandJobs);
        if (currentJobs.some(isLive) || owned.length > 0 || isPaneOpen || (await read($, readError)) !== null) {
          await pollBand($);
          if (await read($, readError) !== null) return;
          await announce($, cfg.repo, await read($, bandJobs), await $.clock.now());
        } else {
          const listing = await jobsListing($, cfg.repo);
          if (listing !== idleEntries) {
            await pollBand($);
            const rows = new Set((await read($, bandJobs)).map((job) => job.id));
            idleEntries = listing.split('\n').every((name) => name === '' || rows.has(name)) ? listing : null;
            return;
          }
          const links = await read($, nativeTaskLinks);
          if (hasPendingNativeClose(currentJobs, links)) {
            await pollNativeTasks($, currentJobs);
          }
        }
      } finally {
        polling = false;
      }
    })().catch(() => {});
  });
}

let nativeSyncing = false;

async function pollNativeTasks($: EngineInterface, rows: readonly RadarJob[]): Promise<void> {
  if (nativeSyncing) return;
  nativeSyncing = true;
  try {
    const previous = await read($, nativeTaskLinks);
    const client: NativeTaskClient = {
      create: (input) => $.tool.call({ tool: 'TaskCreate', ...input }),
      update: (input) => $.tool.call({ tool: 'TaskUpdate', ...input }),
    };
    const mine = new Set(sessionJobs(rows, await read($, launched)).map((job) => job.id));
    const next = await syncNativeTasks(nativeJobsFromRadar(rows), previous, client, await $.clock.now(), (id) => mine.has(id));
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      await update($, nativeTaskLinks, () => next);
    }
  } catch {} finally {
    nativeSyncing = false;
  }
}

async function flushTurnNotices($: EngineInterface): Promise<void> {
  const cfg = await read($, bandConfig);
  if (cfg.repo === '' || await read($, readError) !== null) return;
  if ((await read($, notices)).length === 0) return;
  await pollBand($);
  if (await read($, readError) !== null) return;
  await announce($, cfg.repo, await read($, bandJobs), await $.clock.now());
}

function isMainLoopCall(e: { agentId?: unknown }, next: unknown): boolean {
  if (e.agentId !== undefined) return false;
  const origin = (next as { origin?: { plugin?: string } }).origin;
  return origin === undefined || origin.plugin === 'engine';
}

function registerBand(on: Parameters<Register>[0]): void {
  try {
    on('turn.start', async (_$, e, next) => {
      if (e.agentId === undefined) setMainTurn(true);
      return next(e);
    });

    on('turn.complete', async ($, e, next) => {
      try {
        return await next(e);
      } finally {
        if (e.agentId === undefined) {
          setMainTurn(false);
          await flushTurnNotices($).catch(() => {});
        }
      }
    });
    turnHooksRegistered = true;
  } catch {
    turnHooksRegistered = false;
  }
  on('tool.call', { tool: LAUNCH_TOOL }, async ($, e, next) => {
    if (isMainLoopCall(e, next)) setMainTurn(true);
    const r = await next(e) as { result?: unknown; text?: unknown; deny?: string; isError?: boolean } | undefined;
    if (r && r.deny === undefined && r.isError !== true) {
      let launches = parseLaunches(e.tool, r.result);
      if (launches.length === 0) launches = parseLaunches(e.tool, r.text);
      for (const launch of launches) await takeLaunch($, launch, '').catch(() => {});
    }
    return r;
  });

  on('tool.call', { tool: STATUS_TOOL }, async ($, e, next) => {
    if (isMainLoopCall(e, next)) setMainTurn(true);
    if (
      interactive && e.agentId === undefined && typeof e.tool === 'string' && e.tool.endsWith('__status') && e.wait_ms !== undefined && typeof e.id === 'string' &&
      await read($, readError) === null && refusesStatusWait(await read($, notices), await read($, bandJobs), e.id)
    ) {
      return { deny: `${e.id} will be announced when it finishes. Call status without wait_ms to check it now.` };
    }
    const r = await next(e) as { result?: unknown; text?: unknown; deny?: string; isError?: boolean } | undefined;
    if (r && r.deny === undefined && r.isError !== true && e.agentId === undefined) {
      const settled = parseSettledRead(e.tool, r.result) ?? parseSettledRead(e.tool, r.text);
      if (settled !== null) await update($, notices, (owned) => unclaim(owned, settled)).catch(() => {});
    }
    return r;
  });

  on('ui.render', { component: 'UserMessage' }, async (_$, e, next) => {
    const isPlugin = (o: { readonly kind: string; readonly name?: string } | undefined): boolean =>
      o?.kind === 'plugin' && typeof o.name === 'string' && /^(?:plugin:)?agent-smith(?:[@:]|$)/.test(o.name);
    if (
      (isPlugin(e.props.origin) || isPlugin(e.props.stored)) &&
      typeof e.props.text === 'string'
    ) {
      return next({ ...e, props: { ...e.props, text: sanitizeText(displayNoticeText(e.props.text)) } });
    }
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // When the dock pane is open (or requested), AbovePrompt's viewport.columns
    // is narrowed to conversationColumns, not the full terminal width. Only record
    // AbovePrompt's viewport while the pane is closed.
    if (lastPaneRequest === null && !await read($, paneOpen)) {
      noteViewport(e.viewport?.columns);
    }
    const rest = await next(e);

    const at = await read($, now);
    const cfg = await read($, bandConfig);
    const all = await sessionRows($);

    if (e.props.hasSurvey) return rest;
    if (e.props.view?.agentId !== undefined) return rest;

    const error = await read($, readError);
    if (error) {
      const { Box, Text } = $.ui.resolve(e);
      return <Box flexDirection="column"><Text wrap="truncate-end">{oneLine(error)}</Text>{rest}</Box>;
    }
    const shown = sortForBand(groupWorkers(all)).filter((j) => isShown(j, at));
    if (shown.length === 0) return rest;

    const budget = rowBudget(shown, Math.max(1, (e.props.maxRows ?? 10) - 1));
    const { Box, Text, Button } = $.ui.resolve(e);
    // A plain Button draws `1: ` before its children, so the row is sized to the rest.
    const width = Math.max(1, e.props.bodyColumns - 3);
    const longestLabel = Math.max(0, ...budget.rows.map((job) => jobLabel(job).length));

    return (
      <Box flexDirection="column">
        {budget.rows.map((job, i) => {
          const line = buildLine(job, at, { colour: cfg.colour, width, longestLabel });
          return (
            <Button key={`band-${job.workerId}`} plain hotkey={String(i + 1)} label={line.plain.trim()} onPress={() => openForge($, job.workerId)}>
            <Text dimColor={line.recessive} wrap="truncate-end">
              <Text color={line.accent} bold={line.bold} wrap="truncate-end">
                {line.glyph}
              </Text>
              <Text wrap="truncate-end">{` ${line.label}`}</Text>
              <Text dimColor={!line.recessive} wrap="truncate-end">
                {` ${line.detail} ${line.clock}`.replace(/\s+$/, '')}
              </Text>
            </Text>
            </Button>
          );
        })}
        {budget.hidden > 0 && (
          <Text dimColor wrap="truncate-end">
            {overflowLine(budget.hidden)}
          </Text>
        )}
        {rest}
      </Box>
    );
  });
}

export const register: Register = (on) => {
  registerBand(on);

  on('session.start', async ($, e, next) => {
    const rest = await next(e);
    interactive = e.isInteractive === true;
    await startBand($, typeof e.cwd === 'string' ? e.cwd : undefined);
    void checkForUpdate($).catch(() => {});

    await $.command
      .register({
        name: 'forge',
        immediate: true,
        description: 'Show this session\'s workers; /forge all shows the repository\'s; /forge recap prints a factual board; /forge <name> opens one worker',
      })
      .catch(() => {});
    return rest;
  });

  on('command.run', { command: 'forge' }, async ($, e) => {
    noteViewport(commandTerminalColumns(e.presentation));
    await pollBand($);
    const cfg = await read($, bandConfig);
    const jobs = await read($, bandJobs);
    const mine = await sessionRows($);
    const args = typeof e.args === 'string' ? e.args.trim() : '';
    const tokens = args.split(/\s+/).filter((token) => token !== '');
    const isRecap = tokens.includes('recap');
    const rest = isRecap ? tokens.filter((token) => token !== 'recap') : tokens;
    const word = rest[0] ?? '';
    const scope = word === 'all' ? 'all' : 'session';
    const query = isRecap || word === 'pane' || word === 'all' ? '' : rest.join(' ');
    const job = query === '' ? undefined : findWorker(mine, query) ?? findWorker(jobs, query);
    if (query !== '' && job === undefined) await $.ui.toast(`No worker matches "${query}"; showing the list`);
    await update($, listScope, () => scope);
    if (isRecap) {
      await openForge($, null);
      return { text: sessionBoard(scope === 'all' ? jobs : mine, scope, await $.clock.now()) };
    }
    await openForge($, job?.workerId ?? null);
    return { text: scopeLine(scope === 'all' ? jobs : mine, scope) };
  });

  on('ui.scroll', async ($, e, next) => {
    if (e.component === 'Pane' && e.requestId === PANE && e.origin.kind === 'person' && await read($, selected) !== null) {
      const atEnd = e.offset >= e.contentRows - e.bodyRows;
      if (atEnd !== await read($, follow)) {
        followingSite = null;
        await update($, follow, () => atEnd);
      }
    }
    return next(e);
  });

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      lastPaneRequest = null;
      await update($, paneOpen, () => false);
    }
    return next(e);
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    noteViewport(measurePaneTerminalColumns(e.viewport, e.props));
    if (lastPaneRequest !== null) await requestPane($).catch(() => {});
    return renderForge($, e);
  });
};

async function show($: EngineInterface, workerId: string | null): Promise<void> {
  await update($, selected, () => workerId);
  await update($, pinnedTurnId, () => null);
  await update($, follow, () => true);
  await update($, taskOpen, () => false);
  await update($, expandedTools, () => []);
  followingSite = null;
  await $.ui.scroll({ to: 'start', in: PANE }).catch(() => {});
}

async function pinTurn($: EngineInterface, turnJobId: string | null): Promise<void> {
  await update($, pinnedTurnId, () => turnJobId);
  await update($, follow, () => turnJobId === null);
  await update($, taskOpen, () => false);
  await update($, expandedTools, () => []);
  followingSite = null;
  await $.ui.scroll({ to: 'start', in: PANE }).catch(() => {});
}

async function openForge($: EngineInterface, workerId: string | null): Promise<void> {
  detailCache = null;
  await show($, workerId);
  if (workerId === null) await update($, listPage, () => 0);
  await update($, paneOpen, () => true);
  const at = await $.clock.now();
  await update($, now, () => at);
  await pollBand($).catch(() => {});
  await requestPane($, true);
}

async function scrollEnd($: EngineInterface): Promise<void> {
  const result = await $.ui.scroll({ to: 'end', in: PANE });
  if (result.deny) throw new Error(result.deny);
}

let detailCache: { key: string; at: number; detail: ForgeDetail | null; settled: boolean } | null = null;
async function loadDetail($: EngineInterface, repo: string, id: string, t: number): Promise<ForgeDetail | null> {
  const key = `${repo}\0${id}`;
  if (detailCache?.key === key && (detailCache.settled || (t >= detailCache.at && t - detailCache.at < POLL_MS))) {
    return detailCache.detail;
  }
  const detail = await readForgeDetail(fsOf($), repo, id, t);
  const settled = detail !== null && isSettledForCache(detail.job);
  detailCache = { key, at: t, detail, settled };
  return detail;
}

async function renderForge($: EngineInterface, e: UiRenderEvent): Promise<JSX.Element> {
  const W = $.ui.resolve(e);
  const { Box, Text } = W;
  const cfg = await read($, bandConfig);
  const t = await read($, now);
  const jobs = await read($, bandJobs);
  const mine = await sessionRows($);
  const scope = await read($, listScope);
  const pick = await read($, selected);
  const pinned = await read($, pinnedTurnId);
  const error = await read($, readError);
  const o: ViewOptions = {
    width: e.props.bodyColumns, now: t, colour: cfg.colour, page: await read($, listPage), scope,
    following: await read($, follow), taskOpen: await read($, taskOpen), tools: await read($, expandedTools),
    pinnedTurnId: pinned,
  };
  const a: ViewActions = {
    scope: async (next: 'session' | 'all') => { await update($, listScope, () => next); await update($, listPage, () => 0); },
    pick: (job) => show($, job.workerId),
    pickTurn: (jobId) => pinTurn($, jobId),
    page: async (page) => { await update($, listPage, () => page); },
    back: () => show($, null),
    task: async () => { await update($, taskOpen, (open) => !open); },
    tool: async (key) => { await update($, expandedTools, (keys) => keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]); },
    close: async () => { lastPaneRequest = null; await update($, paneOpen, () => false); await $.ui.close({ id: PANE }); },
  };
  let content = renderList(W, scope === 'all' ? jobs : mine, o, a);
  if (pick !== null) {
    try {
      const turns = workerTurns(jobs, pick);
      const head = workerHead(jobs, pick);
      const targetId = pinned !== null && turns.some((job) => job.id === pinned)
        ? pinned
        : (head?.id ?? pick);
      const detail = await loadDetail($, cfg.repo, targetId, t);
      if (detail) {
        content = renderWorker(W, detail, o, a, turns);
        if (o.following && followingSite !== targetId) {
          try { await scrollEnd($); followingSite = targetId; }
          catch (failure) {
            // The testkit has no painted scroll surface. A live refusal is retried
            // after the new tree is installed, rather than treated as success.
            if (String(failure).includes('no implementation for ui.scroll')) followingSite = targetId;
          }
        }
      }
    } catch (failure) {
      content = <Box flexDirection="column"><Text wrap="wrap">{sanitizeText(`Unable to read job detail: ${String(failure).slice(0, 200)}`)}</Text>{content}</Box>;
    }
  }
  return error ? <Box flexDirection="column"><Text wrap="wrap">{sanitizeText(error)}</Text>{content}</Box> : content;
}
