/** The band above the prompt and the /forge sidebar share canonical state and views. */
import { atom, read, update } from 'claude-code';
import type { EngineInterface, PostToolUseEvent, Register, UiRenderEvent } from 'claude-code';

import type { RadarJob } from '../types/index.d.ts';
import { isTerminal } from './format.ts';
import { findWorker, recordLaunch, scopeLine, sessionJobs, type Launched } from './dashboard.ts';
import { renderList, renderWorker, type ViewActions, type ViewOptions } from './views.tsx';
import type { ForgeDetail } from './canonical.ts';
// ── BAND IMPORTS (band author) ────────────────────────────────────────────────
// § PANE reads through this module too, and for the same reason the band does: it
// is the mod's only reader, it takes an FsLike, and it is handed `$.fs`. See the
// merge note at the top of this file.
import {
  buildLine,
  isShown,
  noColor,
  overflowLine,
  reconcile,
  rowBudget,
} from './band.ts';
import {
  DEFAULT_REPO,
  readAllJobs,
  readJob,
  readToolHistory,
  readTranscript,
  type FsLike,
} from './jobs.ts';
import { sortForBand } from './format.ts';
import { readForgeJobs, readForgeDetail } from './canonical.ts';
import {
  LAUNCH_TOOL,
  STATUS_TOOL,
  asRunRecord,
  claim,
  claimMarkerPath,
  claudeText,
  displayNoticeText,
  due,
  parseLaunch,
  parseSettledRead,
  runFileName,
  unclaim,
  type Launch,
  type Owned,
  type RunRecord,
} from './notice.ts';
import {
  nativeJobsFromRadar,
  syncNativeTasks,
  type NativeTaskClient,
  type NativeTaskLinks,
} from './native.ts';

/** Pane id. Must match the `requestId` in the ui.render matcher below. */
const PANE = 'agent-smith';

/** Before the host measures the terminal, ask for a compact pane width. */
const PANE_FALLBACK_COLUMNS = 60;
const PANE_MIN_COLUMNS = 24;

/** Last measured whole-terminal width, supplied by the host render event. */
let lastViewportColumns: number | null = null;
/** Width last requested from ui.open, avoiding render-triggered reopen loops. */
let lastPaneRequest: number | null = null;

/** A pane request for the rightmost third, respecting the host's 24-column floor. */
export function paneWidthRequest(viewportColumns: number | null): number {
  if (viewportColumns === null || !Number.isFinite(viewportColumns) || viewportColumns <= 0) {
    return PANE_FALLBACK_COLUMNS;
  }
  return Math.max(PANE_MIN_COLUMNS, Math.floor(viewportColumns / 3));
}

function noteViewport(columns: number | undefined): void {
  if (typeof columns === 'number' && Number.isFinite(columns) && columns > 0) {
    lastViewportColumns = Math.floor(columns);
  }
}

async function requestPane($: EngineInterface, force = false): Promise<void> {
  const columns = paneWidthRequest(lastViewportColumns);
  if (!force && lastPaneRequest === columns) return;
  // Set before awaiting: a Pane render can arrive while ui.open is still pending.
  lastPaneRequest = columns;
  await $.ui.open({
    id: PANE,
    title: 'Agent Smith',
    ...(force ? { focus: true } : {}),
    columns,
  });
}

// ── state ───────────────────────────────────────────────────────────────────
//
// DECLARED AT MODULE SCOPE, NOT INSIDE register(). An atom created inside the
// hook closure would be a brand-new store on every hot reload, so reloading this
// file would silently drop the user's selection. The host owns these, keyed by
// plugin name, and they survive reloads.
//
// The band owns `now`. Both halves need a clock and both must subscribe to the
// SAME one, or the band would tick and the pane would not, and the two would show
// elapsed times that disagree by up to a second.

const selected = atom({ plugin: 'agent-smith', key: 'selected' } as const, null as string | null);
const now = atom({ plugin: 'agent-smith', key: 'now' } as const, 0);

/**
 * Whether the worker view keeps its end in view. A person scrolling up pauses
 * it; scrolling back to the bottom resumes it.
 */
const follow = atom({ plugin: 'agent-smith', key: 'follow' } as const, true as boolean);
/** The task line is expanded: the prompt as sent, preamble included. */
const taskOpen = atom({ plugin: 'agent-smith', key: 'taskOpen' } as const, false as boolean);
const listPage = atom({ plugin: 'agent-smith', key: 'listPage' } as const, 0);
const paneOpen = atom({ plugin: 'agent-smith', key: 'paneOpen' } as const, false);
const readError = atom({ plugin: 'agent-smith', key: 'readError' } as const, null as string | null);
const expandedTools = atom({ plugin: 'agent-smith', key: 'expandedTools' } as const, [] as string[]);
/** The worker the host was last asked to keep at its end; null re-anchors on the next draw. */
let followingSite: string | null = null;
const nativeTaskLinks = atom(
  { plugin: 'agent-smith', key: 'nativeTaskLinks' } as const,
  {} as NativeTaskLinks,
);

// ── BAND STATE (band author) ──────────────────────────────────────────────────
// The band, pane list and native task projection share this polled snapshot.
// Detail reads the selected job's bounded view on demand. Configuration is
// resolved once at session start, including explicit legacy-view opt-in.

const bandJobs = atom({ plugin: 'agent-smith', key: 'bandJobs' } as const, [] as RadarJob[]);
const bandConfig = atom({ plugin: 'agent-smith', key: 'bandConfig' } as const, {
  repo: DEFAULT_REPO,
  colour: true,
  legacy: false,
});

/**
 * Launches this session claimed (see `claimLaunch`), until announced. Session
 * state, reset by /clear: a job claimed before a /clear is not announced after
 * it, and leaves this session's view (`/forge all` still lists it).
 */
const notices = atom({ plugin: 'agent-smith', key: 'notices' } as const, [] as Owned[]);

/**
 * Launches this session made in this repo, for the views. Unlike `notices`,
 * nothing prunes it: an announced or expired claim leaves `notices`, but its
 * finished job stays in this session's list. Session state, reset like `notices`.
 */
const launched = atom({ plugin: 'agent-smith', key: 'launched' } as const, { jobs: [], runs: [] } as Launched);
/** The /forge list shows this session's workers, or the repository's history. */
const listScope = atom({ plugin: 'agent-smith', key: 'listScope' } as const, 'session' as 'session' | 'all');

/**
 * The rows the band, the session list and native tasks show: this session's
 * launches. Legacy jobs are started outside the launch tools, so ownership is
 * unknowable there and the legacy view stays the whole repository.
 */
async function sessionRows($: EngineInterface): Promise<RadarJob[]> {
  const cfg = await read($, bandConfig);
  const jobs = await read($, bandJobs);
  const mine = await read($, launched);
  return cfg.legacy ? jobs : sessionJobs(jobs, mine);
}

// =============================================================================
// § BAND — band author. See MERGE NOTE above.
//
// The band is the 1–4 line strip between the transcript and the prompt. It owns:
//   - the `ui.render` matcher for component 'AbovePrompt'
//   - the session.start wiring: config, the 1 s band clock, the 3 s data poll
//   - an immediate poll when a Bash call looks like a dispatch
//
// It is exported as a function rather than registered inline because `register`
// below belongs to the pane and must not be edited to fix a band bug. The pane
// calls `registerBand(on)` from its own `register`; that one call is the whole
// coupling. If the band half is dropped, delete that call and nothing else.
//
// EVERY RULE HERE CITES agent-configs/shared/TERMINAL-UI.md. The three that
// shape the code most:
//   L22-35  nothing on screen moves unless the user caused it
//   L170-176 yield to the host; render nothing when there is nothing to say
//   L155-162 the tick is gated on visibility
// =============================================================================

/** Band clock: 1 s. TERMINAL-UI.md L147 — the seconds digit is all that moves. */
const BAND_TICK_MS = 1000;

/** Data poll: 3 s. TERMINAL-UI.md L148 — file reads are not free. */
const POLL_MS = 3000;

/** `$.fs` narrowed to what ./jobs.ts asks of it. */
const fsOf = ($: EngineInterface): FsLike => ({
  read: (p) => $.fs.read(p),
  list: (p) => $.fs.list(p),
  exists: (p) => $.fs.exists(p),
});

/**
 * One sweep of the jobs directory into the `bandJobs` atom.
 *
 * Read failures retain the last snapshot and expose an error to the user.
 */
async function pollBand($: EngineInterface): Promise<void> {
  const cfg = await read($, bandConfig);
  const at = await $.clock.now();
  let fresh: RadarJob[];
  try {
    fresh = cfg.legacy ? await readAllJobs(fsOf($), cfg.repo, at) : await readForgeJobs(fsOf($), cfg.repo, at);
    if (await read($, readError) !== null) await update($, readError, () => null);
  } catch (error) {
    const message = `Unable to read Forge state: ${String(error).slice(0, 200)}`;
    if (await read($, readError) !== message) await update($, readError, () => message);
    return; // Retain the last observed rows; a read failure is not an empty project.
  }


  // The legacy adapter reconciles partial files. Canonical records are atomic
  // and authoritative; all three surfaces receive exactly that projection.
  const previous = await read($, bandJobs);
  const byId = new Map(previous.map((j) => [j.id, j]));
  const next = cfg.legacy ? fresh.map((job) => reconcile(byId.get(job.id), job)) : fresh;

  // Only write when something actually changed. A 3 s poll that rewrites an
  // identical list would invalidate the band on every tick for no reason, and
  // `ui.invalidate` is rate-limited by the engine for good cause.
  const before = JSON.stringify(previous);
  if (before !== JSON.stringify(next)) await update($, bandJobs, () => next);
  if (!cfg.legacy) await pollNativeTasks($, next);
}

// ── completion notices ───────────────────────────────────────────────────────
//
// The plugin's PostToolUse command hook (watch-hook.js) can wake Claude, but
// the host labels its exit-2 wake "Stop hook feedback", which reads as an error.
// When this mod is loaded it claims the launch (tool.call, or
// classic.PostToolUse where delivered) and announces it itself, with one
// `$.prompt.submit` turn credited to this plugin. Claude Code shows that
// message to the user in full, so it is the only notice.

/** Repo paths compare without trailing slashes. */
const sameRepo = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/**
 * Claim a launch for this session, so the mod (and only the mod) announces it.
 *
 * THE ONE DECISION POINT. Modules sit above settings and plugin command hooks
 * in the `classic.*` chain, so answering without `next` means the command hook
 * for this call never starts: there is no second announcer to race. Every case
 * the mod cannot watch calls `next`, and the hook behaves as it does without
 * the mod. The claim is the last fallible step before the answer, and there is
 * deliberately no `.catch`: a hook that throws is skipped, so the command hook
 * runs, which is the safe way to fail.
 *
 * Ownership is per session by construction: this event fires for this
 * session's own tool calls, and `notices` is session state.
 */
async function claimLaunch($: EngineInterface, e: PostToolUseEvent, next: (e: unknown) => Promise<unknown>): Promise<unknown> {
  const launch = parseLaunch(e.tool_name, e.tool_response);
  if (launch === null) return next(e);
  return await takeLaunch($, launch, typeof e.cwd === 'string' ? e.cwd : '') ? {} : next(e);
}

/**
 * Record a launch for this session's view and, where the mod can watch it,
 * claim its announcement. True when claimed. Idempotent: `tool.call` and
 * `classic.PostToolUse` may both deliver the same launch.
 */
async function takeLaunch($: EngineInterface, launch: Launch, cwd: string): Promise<boolean> {
  const cfg = await read($, bandConfig);
  const repo = launch.repo ?? cwd;
  // Whether this session shows the job is a separate question from who
  // announces it: any launch in this repo is shown, even one the hook keeps.
  if (cfg.repo !== '' && sameRepo(repo, cfg.repo)) await update($, launched, (l) => recordLaunch(l, launch));
  // Legacy mode reads the agy-staff layout, and a read error means no rows: the
  // mod could not see this job finish, so the hook keeps it.
  if (cfg.legacy || cfg.repo === '' || await read($, readError) !== null) return false;
  if (!sameRepo(repo, cfg.repo)) return false;
  const at = await $.clock.now();
  await update($, notices, (owned) => claim(owned, launch, at));
  // The hook finds this marker when the job ends and stays silent. Where the
  // host skips user-tier modules for classic.PostToolUse (observed: "bypassed by
  // cc-plugin-sec-default"), this marker is the only thing that stops a second
  // notice, so the tool.call path below writes it too.
  await $.fs.write(claimMarkerPath(cfg.repo, launch.kind, launch.id), `${new Date(at).toISOString()}\n`).catch(() => {});
  return true;
}

// A slow pass can overlap the next tick; one announcement pass at a time.
let announcing = false;

/** Announce every claimed launch that has news: one log block, one turn. */
async function announce($: EngineInterface, repo: string, jobs: readonly RadarJob[], at: number): Promise<void> {
  if (announcing) return;
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
      } catch {
        // Mid-write or unreadable: try again next poll.
      }
    }
    const result = due(owned, jobs, runs, at);
    const changed = result.notices.length > 0 || result.owned.length !== owned.length;
    if (!changed) return;
    // Record before speaking, so a notice is said once even if the turn it
    // asks for never starts. Claims made since the read above are kept.
    const seen = new Set(owned.map((o) => `${o.kind}:${o.id}`));
    await update($, notices, (current) => [...result.owned, ...current.filter((c) => !seen.has(`${c.kind}:${c.id}`))]);
    if (result.notices.length === 0) return;
    // Resolves when the turn starts, which waits for the session to be idle.
    // `asUser: true` omits the host's "The agent-smith plugin sent a message …
    // This is how Claude Code surfaces a prompt a plugin submits between turns"
    // wrapper while keeping `{ kind: 'plugin', name: 'agent-smith' }` origin.
    void $.prompt.submit({ text: claudeText(result.notices), asUser: true }).catch(() => {});
  } finally {
    announcing = false;
  }
}

/**
 * The band's half of session start. Await this INSIDE the pane's own
 * `session.start` handler, after its `await next(e)`.
 *
 * WHY A SEPARATE FUNCTION AND NOT A SECOND `on('session.start')`
 * ─────────────────────────────────────────────────────────────
 * Two constraints, both VERIFIED against the loader, and together they force
 * this shape:
 *
 *   1. Registering the same matcher-less event twice in one module is refused:
 *      `on("session.start") is registered twice without a matcher; the first is
 *       at …/register.tsx:57`. Two engineers owning two halves of one file
 *      therefore cannot both claim `session.start`.
 *   2. `$` may only be passed to a call to a function DECLARED at the top of the
 *      file (or a const bound to one): `$ is passed to "bandStart", which is not
 *      a function declared at the top of this file`. And a registration callback
 *      may not return a value the pane could hold: `the value of registerBand(on)
 *      is kept … it takes .catch(handler) where it is called and nothing else`.
 *
 * So the band exports a plain top-level function and the pane awaits it. That is
 * also why `registerBand` returns void.
 *
 * NEVER THROWS. A band that fails to configure itself must not take the
 * session's start — or the pane — down with it.
 */
export async function startBand($: EngineInterface, cwd?: string): Promise<void> {

  // NO_COLOR first, because it decides every colour prop from here on.
  // `$.env.get` requires a string LITERAL name (VERIFIED: a computed name is
  // refused at compile time, "so the variables a module reads and writes can be
  // listed"), so each is spelled out. no-color.org: present AND non-empty means
  // no colour; FORCE_COLOR=0/false and TERM=dumb are the same request.
  const [nc, force, term, repo, legacy] = await Promise.all([
    $.env.get('NO_COLOR').catch(() => undefined),
    $.env.get('FORCE_COLOR').catch(() => undefined),
    $.env.get('TERM').catch(() => undefined),
    $.env.get('AGY_RADAR_REPO').catch(() => undefined),
    $.env.get('AGENT_SMITH_LEGACY_JOBS').catch(() => undefined),
  ]);
  await update($, bandConfig, () => ({
    // Precedence: explicit AGY_RADAR_REPO, else the session cwd, else
    // DEFAULT_REPO (empty by design). A hardcoded developer path here would
    // make the plugin show another machine's jobs.
    repo: repo !== undefined && repo.trim() !== '' ? repo.trim()
      : (cwd !== undefined && cwd !== '' ? cwd : DEFAULT_REPO),
    colour: !noColor({ NO_COLOR: nc, FORCE_COLOR: force, TERM: term }),
    legacy: legacy === '1',
  }));

  // First read is immediate and warm. TERMINAL-UI.md L140-146 INVERTS the web
  // skill's 150–300 ms delay deliberately: there is no network here and no
  // paint to hide behind, so a delay is pure loss.
  await pollBand($).catch(() => {});

  // Seed the clock BEFORE the first render. `now` is an atom initialised to 0,
  // and a running row's elapsed cell is `now - startedAt`. With `now === 0` that
  // is a NEGATIVE span, which `elapsed()` clamps to `0s` — so without this seed a
  // job that has been working for twelve minutes shows `0s` on its first paint
  // and only becomes honest a second later, when the tick runs. That is a
  // fabricated reading, which is the one thing a status line must not do, and it
  // is exactly the "flash of wrong content" the one-rule (L22-35) is about.
  const seeded = await $.clock.now();
  await update($, now, () => seeded).catch(() => {});

  // Tick while a row was visible at the previous time, so its expiry gets one
  // final redraw. Keep ticking for an open pane; become idle only afterwards.
  $.clock.every(BAND_TICK_MS, () => {
    void (async () => {
      const at = await $.clock.now();
      const previousTime = await read($, now);
      const visible = (await sessionRows($)).some(j => isShown(j, previousTime));
      // Draw once across the expiry boundary before becoming idle.
      if (visible || await read($, paneOpen)) await update($, now, () => at);
    })().catch(() => {});
  });

  // The data poll, on its own slower cadence. Notices go out from here only:
  // a timer runs outside any event, which is where `$.prompt.submit` belongs.
  // The other pollBand callers run inside a hook (a Bash tool.call, /forge),
  // where a submit could be refused after the notice was already recorded.
  $.clock.every(POLL_MS, () => {
    void (async () => {
      await pollBand($);
      const cfg = await read($, bandConfig);
      if (cfg.legacy || await read($, readError) !== null) return;
      await announce($, cfg.repo, await read($, bandJobs), await $.clock.now());
    })().catch(() => {});
  });
}

// Clock ticks can arrive while the host's TaskCreate/TaskUpdate call is still
// resolving. The durable map lives in plugin state; this is only an overlap
// guard for the mod's current engine session.
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
    // Only this session's launches get a new task; tasks already linked finish as before.
    const mine = new Set(sessionJobs(rows, await read($, launched)).map((job) => job.id));
    const next = await syncNativeTasks(nativeJobsFromRadar(rows), previous, client, await $.clock.now(), (id) => mine.has(id));
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      await update($, nativeTaskLinks, () => next);
    }
  } catch {
    // The native task list is an optional view. Its failure cannot interrupt
    // worker execution, the pane, or the existing progress band.
  } finally {
    nativeSyncing = false;
  }
}

// ── the band's remaining registrations ─────────────────────────────────────
//
// Its session-start half is `startBand` above, because the engine refuses two
// matcher-less registrations of the same event in one module. These two need
// nothing from the pane, so they are registered here.

/**
 * Register the band. Called from the pane's `register`.
 *
 * The band registers NO `command.run` handler: `/forge` belongs to the pane
 * half. Its rows' digit hotkeys open the pane through `openForge`.
 */
export function registerBand(on: Parameters<Register>[0]): void {
  // A Bash call that looks like a dispatch: refresh NOW, not in up to 3 s.
  // TERMINAL-UI.md L22-35 says nothing moves unless the user caused it, and the
  // user causing it here is dispatching a job. Making them wait 3 s to see the
  // job they just started is the delay they would notice and blame the band for.
  // The trigger is deliberately narrow: refreshing on every Bash call would poll
  // on every `ls`.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = typeof e.command === 'string' ? e.command : '';
    if (/agy-staff|\bagy\s+(implement|review|moderate|researcher|implementer|reviewer)\b/.test(command)) {
      await pollBand($).catch(() => {});
    }
    return next(e);
  });

  // A launch this session made: claim it for the mod's notices (see claimLaunch).
  on('classic.PostToolUse', { tool_name: LAUNCH_TOOL }, claimLaunch);
  // The path that works when classic.PostToolUse is withheld from user-tier
  // modules: wrap the launch tool, read its result, return it untouched.
  on('tool.call', { tool: LAUNCH_TOOL }, async ($, e, next) => {
    const r = await next(e) as { result?: unknown; text?: unknown; deny?: string; isError?: boolean } | undefined;
    if (r && r.deny === undefined && r.isError !== true) {
      const launch = parseLaunch(e.tool, r.result) ?? parseLaunch(e.tool, r.text);
      if (launch !== null) await takeLaunch($, launch, '').catch(() => {});
    }
    return r;
  });

  // When Claude reads a job or pipeline that has already settled via status /
  // pipeline_status, retire its pending notice so we don't wake Claude a second time.
  on('classic.PostToolUse', { tool_name: STATUS_TOOL }, async ($, e, next) => {
    const settled = parseSettledRead(e.tool_name, e.tool_response);
    if (settled !== null) await update($, notices, (owned) => unclaim(owned, settled)).catch(() => {});
    return next(e);
  });
  on('tool.call', { tool: STATUS_TOOL }, async ($, e, next) => {
    const r = await next(e) as { result?: unknown; text?: unknown; deny?: string; isError?: boolean } | undefined;
    if (r && r.deny === undefined && r.isError !== true) {
      const settled = parseSettledRead(e.tool, r.result) ?? parseSettledRead(e.tool, r.text);
      if (settled !== null) await update($, notices, (owned) => unclaim(owned, settled)).catch(() => {});
    }
    return r;
  });

  // Render our completion notices in the transcript as a single clean status
  // line, while leaving the stored prompt (and ctrl+o expanded view) intact.
  on('ui.render', { component: 'UserMessage' }, async (_$, e, next) => {
    const origin = e.props.origin;
    if (
      origin?.kind === 'plugin' &&
      origin.name === 'agent-smith' &&
      e.props.isExpanded !== true &&
      typeof e.props.text === 'string'
    ) {
      return next({ ...e, props: { ...e.props, text: displayNoticeText(e.props.text) } });
    }
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    noteViewport(e.viewport?.columns);
    // Yield FIRST. Everything Claude Code and every other mod draw in this band
    // comes back in `rest`, and we return it as our LAST child, untouched.
    // TERMINAL-UI.md L170-173.
    const rest = await next(e);

    // Subscribe. `await read($, now)` is what makes a clock tick repaint this
    // element; reading bandJobs (in sessionRows) is what makes a poll repaint it.
    const at = await read($, now);
    const cfg = await read($, bandConfig);
    const all = await sessionRows($);

    // A survey holds the band. Standing aside is not politeness: a survey is a
    // question being asked, and the band would push it off screen.
    if (e.props.hasSurvey) return rest;

    const error = await read($, readError);
    if (error) {
      const { Box, Text } = $.ui.resolve(e);
      return <Box flexDirection="column"><Text wrap="truncate-end">{error}</Text>{rest}</Box>;
    }
    const shown = sortForBand(all).filter((j) => isShown(j, at));
    // No jobs → render NOTHING (TERMINAL-UI.md L168-171). Not "no jobs", not an
    // empty box: the host's own output, exactly as it was. A band that "appears
    // to say nothing" is noise.
    if (shown.length === 0) return rest;

    // `maxRows` is the engine's own budget for this site — the fullscreen bottom
    // slot's, or the terminal's height. Passing it in means the band cannot be
    // the reason the prompt leaves the screen in a short terminal, which is rule
    // #1 in a way the rule does not otherwise mention.
    const budget = rowBudget(shown, Math.max(1, (e.props.maxRows ?? 10) - 1));
    const { Box, Text, Button } = $.ui.resolve(e);
    // A plain Button draws `1: ` before its children, so the row is sized to the rest.
    const width = Math.max(1, e.props.bodyColumns - 3);

    return (
      <Box flexDirection="column">
        {budget.rows.map((job, i) => {
          const line = buildLine(job, at, { colour: cfg.colour, width });
          const detail = job.acceptance?.pending && isTerminal(job.status) ? 'checks pending' :
            job.acceptance?.state === 'rejected' ? 'checks rejected' : line.detail;
          // A bare digit in an empty prompt presses a band Button without focusing
          // the band, so one key opens the sidebar on this worker.
          return (
            <Button key={`band-${job.id}`} plain hotkey={String(i + 1)} label={line.plain.trim()} onPress={() => openForge($, job.id)}>
            <Text dimColor={line.recessive} wrap="truncate-end">
              {/* Segment 1: the GLYPH ALONE, in the accent and bold while live.
                  `accent` is undefined under NO_COLOR and for canceled/unknown,
                  and `color={undefined}` draws in the terminal's default — the
                  glyph still carries the state, which is the whole point.

                  It is the glyph alone rather than "glyph + identity" because a
                  44-column task title painted yellow is not an accent, it is a
                  highlighted sentence. One accent per line, spent on the one
                  character that means something. */}
              <Text color={line.accent} bold={line.bold} wrap="truncate-end">
                {line.glyph}
              </Text>
              {/* Segment 2: the task and the state, default foreground — this is
                  level-1 identity and it must be as readable as anything else on
                  the line. Segment 3 is the detail; segment 4 is the clock, LAST
                  and dim. `wrap` on every one of them: TERMINAL-UI.md L124-126
                  says EVERY Text, not just the outermost, and the engine tests
                  the rule per element. */}
              <Text wrap="truncate-end">{` ${line.label}`}</Text>
              <Text dimColor={!line.recessive} wrap="truncate-end">
                {` ${detail} ${line.clock}`.replace(/\s+$/, '')}
              </Text>
            </Text>
            </Button>
          );
        })}
        {budget.hidden > 0 && (
          // TERMINAL-UI.md L151: cap at 4, then `+N more`. Dim, and it names the
          // command, so the overflow row is an invitation rather than a wall.
          <Text dimColor wrap="truncate-end">
            {overflowLine(budget.hidden)}
          </Text>
        )}
        {rest}
      </Box>
    );
  });
}

// =============================================================================
// § PANE — everything below this line belongs to the /forge pane.
// =============================================================================

/** `register(on, options)` is the mod entry point. hooks.json names this file. */
export const register: Register = (on) => {
  // ── the band ───────────────────────────────────────────────────────────────
  //
  // TWO calls are the entire band↔pane coupling.
  //
  //   registerBand  registers the band's AbovePrompt render hook and its
  //              Bash-dispatch poll, and stores its session-start half.
  //   startBand()   that stored half, awaited inside the handler below. It cannot
  //              register its own `session.start`: VERIFIED, the engine refuses
  //              two matcher-less registrations of one event in a module
  //              ("on("session.start") is registered twice without a matcher").
  //
  // The pane below knows none of this and would work unchanged if both lines were
  // deleted. See § BAND above.
  registerBand(on);

  // ── the command ───────────────────────────────────────────────────────────
  //
  // `.catch(() => {})` because Claude Code refuses a command name it already owns,
  // and refusing to start would take the band down with it. Losing `/forge` to
  // a name collision is acceptable; losing the whole mod is not.
  on('session.start', async ($, e, next) => {
    const rest = await next(e);
    // Band first, and it never throws: a slow or failing band config must not
    // delay `/forge` appearing or take the session's start with it.
    await startBand($, typeof e.cwd === 'string' ? e.cwd : undefined);

    await $.command
      .register({
        name: 'forge',
        immediate: true,
        description: 'Show this session\'s workers; /forge all shows the repository\'s; /forge <name> opens one worker',
      })
      .catch(() => {});
    return rest;
  });

  // `next` is unused and deliberately so. A command handler's `next` would render
  // some other handler's contribution to the command; there is nothing to chain
  // here, and the reference mod's command handler also ignores it.
  //
  // The matcher must equal the name registered above — 'forge', not the plugin
  // name. A matcher that matches nothing is a pane nobody can open, and it fails
  // SILENTLY, so the two strings are deliberately the same string.
  on('command.run', { command: 'forge' }, async ($, e) => {
    await pollBand($);
    const cfg = await read($, bandConfig);
    const jobs = await read($, bandJobs);
    const mine = await sessionRows($);
    const args = typeof e.args === 'string' ? e.args.trim() : '';
    // `/forge pane` is the session list, kept because people have typed it.
    // Legacy jobs have no session owner, so legacy is always the repository.
    const scope = args === 'all' || cfg.legacy ? 'all' : 'session';
    const query = args === 'pane' || args === 'all' ? '' : args;
    // This session's worker first; then the repository's, so an older one still opens by name.
    const job = query === '' ? undefined : findWorker(mine, query) ?? findWorker(jobs, query);
    if (query !== '' && job === undefined) await $.ui.toast(`No worker matches "${query}"; showing the list`);
    await update($, listScope, () => scope);
    await openForge($, job?.id ?? null);
    return { text: scopeLine(scope === 'all' ? jobs : mine, scope) };
  });

  // Scrolling up pauses following; scrolling back to the end resumes it.
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
    if (e.id === PANE) await update($, paneOpen, () => false);
    return next(e);
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    noteViewport(e.viewport?.columns);
    if (lastPaneRequest !== null && lastPaneRequest !== paneWidthRequest(lastViewportColumns)) await requestPane($).catch(() => {});
    return renderForge($, e);
  });
};

/** Show one worker (or the list, for null) in the sidebar, following its end. */
async function show($: EngineInterface, id: string | null): Promise<void> {
  await update($, selected, () => id);
  await update($, follow, () => true);
  await update($, taskOpen, () => false);
  await update($, expandedTools, () => []);
  followingSite = null;
  await $.ui.scroll({ to: 'start', in: PANE }).catch(() => {});
}

/** Open the sidebar focused, on one worker or on the list. */
async function openForge($: EngineInterface, id: string | null): Promise<void> {
  await show($, id);
  if (id === null) await update($, listPage, () => 0);
  await update($, paneOpen, () => true);
  await requestPane($, true);
}

async function scrollEnd($: EngineInterface): Promise<void> {
  const result = await $.ui.scroll({ to: 'end', in: PANE });
  if (result.deny) throw new Error(result.deny);
}

// Clock and control redraws reuse the bounded detail until the next data cadence.
let detailCache: { key: string; at: number; detail: ForgeDetail | null } | null = null;
async function loadDetail($: EngineInterface, repo: string, legacy: boolean, id: string, t: number): Promise<ForgeDetail | null> {
  const key = `${repo}:${legacy}:${id}`;
  if (detailCache?.key === key && t >= detailCache.at && t - detailCache.at < POLL_MS) return detailCache.detail;
  const fs = fsOf($);
  let detail: ForgeDetail | null;
  if (legacy) {
    const job = await readJob(fs,repo,id,t);
    detail = job ? { job, history:await readToolHistory(fs,repo,id), transcript:await readTranscript(fs,repo,id), timeline:null } : null;
  } else detail = await readForgeDetail(fs,repo,id,t);
  detailCache = { key, at:t, detail };
  return detail;
}

async function renderForge($: EngineInterface, e: UiRenderEvent): Promise<JSX.Element> {
  const W = $.ui.resolve(e);
  const { Box, Text } = W;
  const cfg = await read($, bandConfig);
  const t = await read($, now);
  const jobs = await read($, bandJobs);
  const mine = await sessionRows($);
  const chosen = await read($, listScope);
  const scope = cfg.legacy ? 'all' : chosen;
  const pick = await read($, selected);
  const error = await read($, readError);
  const o: ViewOptions = {
    width: e.props.bodyColumns, now: t, colour: cfg.colour, page: await read($, listPage), scope,
    following: await read($, follow), taskOpen: await read($, taskOpen), tools: await read($, expandedTools),
  };
  const a: ViewActions = {
    // Legacy has no session to switch to.
    ...(cfg.legacy ? {} : { scope: async (next: 'session' | 'all') => { await update($, listScope, () => next); await update($, listPage, () => 0); } }),
    pick: (job) => show($, job.id),
    page: async (page) => { await update($, listPage, () => page); },
    back: () => show($, null),
    task: async () => { await update($, taskOpen, (open) => !open); },
    tool: async (key) => { await update($, expandedTools, (keys) => keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]); },
    close: async () => { await update($, paneOpen, () => false); await $.ui.close({ id: PANE }); },
  };
  let content = renderList(W, scope === 'all' ? jobs : mine, o, a);
  if (pick !== null) {
    try {
      const detail = await loadDetail($, cfg.repo, cfg.legacy, pick, t);
      if (detail) {
        content = renderWorker(W, detail, o, a, jobs.filter((job) => job.id !== pick && job.workerId != null && job.workerId === detail.job.workerId));
        if (o.following && followingSite !== pick) {
          // Host end anchors keep following a growing tree until a person scrolls.
          try { await scrollEnd($); followingSite = pick; }
          catch (failure) {
            // The testkit has no painted scroll surface. A live refusal is retried
            // after the new tree is installed, rather than treated as success.
            if (String(failure).includes('no implementation for ui.scroll')) followingSite = pick;
          }
        }
      }
    } catch (failure) {
      content = <Box flexDirection="column"><Text wrap="wrap">{`Unable to read job detail: ${String(failure).slice(0, 200)}`}</Text>{content}</Box>;
    }
  }
  return error ? <Box flexDirection="column"><Text wrap="wrap">{error}</Text>{content}</Box> : content;
}

export { EMPTY_STATE, describeTool, elapsed, elapsedCell, formatHeaderLine, formatJobLine,
  pickGlyph, pickColor, isRecessive, isTerminal, countSummary, oneLine } from './format.ts';
