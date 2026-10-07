// =============================================================================
// register.tsx — the /agent-smith pane, in an AbovePrompt-style mod.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ MERGE NOTE — READ THIS BEFORE EDITING. ⚠
// ─────────────────────────────────────────────────────────────────────────────
// Another engineer may be writing the BAND half of this file concurrently. The
// band is the 1–4 line strip above the prompt; the pane is what /agent-smith opens.
//
// The split is structural, not advisory:
//
//   § BAND  — owned by the band author. Do not edit to fix a pane bug.
//   § PANE  — owned by this file. Entirely self-contained below the marker.
//
// Every pane helper lives in ./format.ts (pure) and ./jobs.ts (I/O), both of
// which are modules with no JSX. So merging this half is: copy the § PANE
// section, add its four imports, and add the pane's `on(...)` calls to
// register(). There is no shared local state between the halves beyond the atom
// block at the top, which is documented per-atom.
//
// WHY THE PANE'S LOGIC IS NOT IN THIS FILE AT ALL:
// `node --test --experimental-strip-types` cannot load a .tsx — TypeScript's type
// stripping has no JSX transform, so any JSX in an imported module is a hard parse
// error. Logic living here would be untestable under the repo's own test runner.
// Everything testable is in format.ts (pure) and jobs.ts (I/O).
//
// ONE READER, AND WHY THE PANE USES ./jobs.ts
// ──────────────────────────────────────────
// § BAND and § PANE both read through ./jobs.ts. There is no second reader. The
// pane used to have its own (./job-source.ts), and it could not load: it imported
// `node:path`, `node:fs/promises` and `../../../harness/`, and a hooks module may
// import only its own files by relative path and "claude-code". Two readers would
// also have meant two answers to "is this job still running", which is the drift
// this project exists to prevent. Its extra capability — result.md, the tool
// history, stripSystemNotifications — now lives in jobs.ts behind flags, so the
// status function is still the only one.
// =============================================================================

import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register, UiComponents, UiRenderEvent } from 'claude-code';

import type { RadarJob } from '../types/index.d.ts';
import {
  EMPTY_STATE,
  countSummary,
  describeTool,
  elapsedCell,
  formatHeaderLine,
  formatJobLine,
  isTerminal,
  oneLine,
  pickColor,
  pickGlyph,
  sortJobs,
  toolCountCell,
} from './format.ts';
// ── BAND IMPORTS (band author) ────────────────────────────────────────────────
// § PANE reads through this module too, and for the same reason the band does: it
// is the mod's only reader, it takes an FsLike, and it is handed `$.fs`. See the
// merge note at the top of this file.
import {
  BAND_ROWS,
  TICK_CUSHION_MS,
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
  sortForBand,
  type FsLike,
} from './jobs.ts';
import type { ToolEntry } from '../types/index.d.ts';

/** Pane id. Must match the `requestId` in the ui.render matcher below. */
const PANE = 'agent-smith';

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
 * Job ids the user has dismissed with `c`.
 *
 * WHY THIS IS AN ATOM AND NOT A FILTER ON THE READ: the pane is a READ-ONLY
 * projection (docs/ARCHITECTURE.md) and agy-staff owns `.agy-staff/jobs/`. Deleting
 * or hiding files there would be destroying another process's state to satisfy a UI
 * preference. So `c` records the dismissal locally and the list filters against it.
 *
 * Kept as a list rather than a Set because it round-trips through JSON in host
 * state, and an array survives that where a Set does not.
 */
const cleared = atom({ plugin: 'agent-smith', key: 'cleared' } as const, [] as string[]);

// ── BAND STATE (band author) ──────────────────────────────────────────────────
// `jobs` is the band's own snapshot of the jobs directory. It is NOT shared with
// the pane on purpose: the pane re-reads on demand (a press is a deliberate act
// and deserves fresh data), while the band is driven by a 3 s poll and must not
// block a redraw on 20 file reads. Both are read-only projections of the same
// files, so they cannot disagree about the truth — only about when they looked.
//
// `config` holds the two things resolved once at session start: which repo to
// watch, and whether colour is allowed. Re-reading env on every render would be
// a filesystem-free but pointless syscall per frame.

const bandJobs = atom({ plugin: 'agent-smith', key: 'bandJobs' } as const, [] as RadarJob[]);
const bandConfig = atom({ plugin: 'agent-smith', key: 'bandConfig' } as const, {
  repo: DEFAULT_REPO,
  colour: true,
});

/** Rows visible in the list before `… N older`. Pane height is bounded. */
const LIST_ROWS = 9;

/** Tool calls shown in the detail pane's history. */
const HISTORY_ROWS = 12;

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
 * NEVER THROWS. A read failure of one job is that job's absence, not a dead
 * band. See the fault-isolation note in ./jobs.ts readAllJobs.
 */
async function pollBand($: EngineInterface): Promise<void> {
  const cfg = await read($, bandConfig);
  const at = await $.clock.now();
  const fresh = await readAllJobs(fsOf($), cfg.repo, at);

  // Fold over what we already had. `reconcile` is what makes a transient read
  // failure unable to blink a row out — see its doc comment for the two halves
  // (terminal-anchored status in ./jobs.ts, stickiness once terminal).
  const previous = await read($, bandJobs);
  const byId = new Map(previous.map((j) => [j.id, j]));
  const next = fresh.map((job) => reconcile(byId.get(job.id), job));

  // Only write when something actually changed. A 3 s poll that rewrites an
  // identical list would invalidate the band on every tick for no reason, and
  // `ui.invalidate` is rate-limited by the engine for good cause.
  const before = JSON.stringify(previous);
  if (before === JSON.stringify(next)) return;
  await update($, bandJobs, () => next);
}

/**
 * What `registerBand` hands back: a continuation to run INSIDE the pane's own
 * `session.start` handler.
 *
 * WHY IT IS NOT A SECOND `on('session.start')`
 * ────────────────────────────────────────────
 * VERIFIED against the loader: registering the same matcher-less event twice is
 * refused outright —
 *   `on("session.start") is registered twice without a matcher; the first is at
 *    …/register.tsx:57`
 * So two `on(...)` calls cannot coexist in one module, whoever owns them. The
 * band therefore returns its session-start work as a function and the pane
 * `await`s it as the first thing in the handler it already has. One extra line
 * in § PANE, and the band keeps every other registration to itself.
 */
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
  const [nc, force, term, repo] = await Promise.all([
    $.env.get('NO_COLOR').catch(() => undefined),
    $.env.get('FORCE_COLOR').catch(() => undefined),
    $.env.get('TERM').catch(() => undefined),
    $.env.get('AGY_RADAR_REPO').catch(() => undefined),
  ]);
  await update($, bandConfig, () => ({
    // Precedence: explicit AGY_RADAR_REPO, else the session cwd, else
    // DEFAULT_REPO (empty by design). A hardcoded developer path here would
    // make the plugin show another machine's jobs.
    repo: repo !== undefined && repo.trim() !== '' ? repo.trim()
      : (cwd !== undefined && cwd !== '' ? cwd : DEFAULT_REPO),
    colour: !noColor({ NO_COLOR: nc, FORCE_COLOR: force, TERM: term }),
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

  // The band clock, GATED. TERMINAL-UI.md L155-162: "Idle means idle. A 1Hz
  // repaint of nothing is a laptop fan." Each tick reads the clock, asks
  // whether anything would still be on screen in three seconds, and writes
  // only then. So an idle session costs one comparison a second and never a
  // redraw. The cushion is why the row that expires is dropped on THIS tick
  // rather than surviving one extra.
  $.clock.every(BAND_TICK_MS, () => {
    void (async () => {
      const at = await $.clock.now();
      const visible = (await read($, bandJobs)).some((j) =>
        isShown(j, at + TICK_CUSHION_MS),
      );
      if (visible) await update($, now, () => at);
    })().catch(() => {});
  });

  // The data poll, on its own slower cadence.
  $.clock.every(POLL_MS, () => {
    void pollBand($).catch(() => {});
  });
}

// ── the band's remaining registrations ─────────────────────────────────────
//
// Its session-start half is `startBand` above, because the engine refuses two
// matcher-less registrations of the same event in one module. These two need
// nothing from the pane, so they are registered here.

/**
 * Register the band. Called from the pane's `register`.
 *
 * The band deliberately registers NO `command.run` handler and opens NO pane:
 * `/agent-smith` belongs to the pane half, and two handlers for one command is a
 * coin toss over which one the engine picks.
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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Yield FIRST. Everything Claude Code and every other mod draw in this band
    // comes back in `rest`, and we return it as our LAST child, untouched.
    // TERMINAL-UI.md L170-173.
    const rest = await next(e);

    // Subscribe. `await read($, now)` is what makes a clock tick repaint this
    // element; reading bandJobs is what makes a poll repaint it.
    const at = await read($, now);
    const cfg = await read($, bandConfig);
    const all = await read($, bandJobs);

    // A survey holds the band. Standing aside is not politeness: a survey is a
    // question being asked, and the band would push it off screen.
    if (e.props.hasSurvey) return rest;

    const shown = sortForBand(all).filter((j) => isShown(j, at));
    // No jobs → render NOTHING (TERMINAL-UI.md L168-171). Not "no jobs", not an
    // empty box: the host's own output, exactly as it was. A band that "appears
    // to say nothing" is noise.
    if (shown.length === 0) return rest;

    // `maxRows` is the engine's own budget for this site — the fullscreen bottom
    // slot's, or the terminal's height. Passing it in means the band cannot be
    // the reason the prompt leaves the screen in a short terminal, which is rule
    // #1 in a way the rule does not otherwise mention.
    const budget = rowBudget(shown, e.props.maxRows);
    const { Box, Text } = $.ui.resolve(e);

    return (
      <Box flexDirection="column">
        {budget.rows.map((job) => {
          const line = buildLine(job, at, { colour: cfg.colour });
          return (
            <Text key={job.id} wrap="truncate-end">
              {/* Segment 1: identity + outcome, in the accent. `accent` is
                  undefined under NO_COLOR and for canceled/unknown, and
                  `color={undefined}` draws in the terminal's default — the
                  glyph still carries the state, which is the whole point. */}
              <Text color={line.accent} bold={line.bold} wrap="truncate-end">
                {line.head}
              </Text>
              {/* Segment 2: everything secondary, `dimColor`. NEVER `gray`: it is
                  a fixed colour that disappears on one of light/dark terminals
                  (TERMINAL-UI.md L84-85). `wrap` here too — TERMINAL-UI.md
                  L124-126 says EVERY Text, not just the outermost one, and the
                  engine tests the rule per element. */}
              <Text dimColor wrap="truncate-end">
                {line.tail}
              </Text>
            </Text>
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
// § PANE — everything below this line belongs to the /agent-smith pane.
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
  // and refusing to start would take the band down with it. Losing `/agent-smith` to
  // a name collision is acceptable; losing the whole mod is not.
  on('session.start', async ($, e, next) => {
    const rest = await next(e);
    // Band first, and it never throws: a slow or failing band config must not
    // delay `/agent-smith` appearing or take the session's start with it.
    await startBand($, typeof e.cwd === 'string' ? e.cwd : undefined);
    await $.command
      .register({
        name: 'radar',
        description: 'Browse worker jobs: tool history, warnings, and the final report',
      })
      .catch(() => {});
    return rest;
  });

  // `next` is unused and deliberately so. A command handler's `next` would render
  // some other handler's contribution to the command; there is nothing to chain
  // here, and the reference mod's command handler also ignores it.
  //
  // The matcher must equal the name registered above — 'radar', not the plugin
  // name. A matcher that matches nothing is a pane nobody can open, and it fails
  // SILENTLY, so the two strings are deliberately the same string.
  on('command.run', { command: 'radar' }, async ($, _e, _next) => {
    // Reset the selection so the pane always opens on the list. Opening directly
    // into a stale detail view would be disorienting: the user asked for a
    // browser, not for wherever they happened to be last time.
    await update($, selected, () => null);
    await $.ui.open({ id: PANE, title: 'Agent Smith', focus: true });

    // Read once here so the command's own return value is honest about what is
    // running. The pane re-reads on every render; this is just for the command's
    // response text.
    //
    // THE REPO COMES FROM `bandConfig`, NOT FROM `$.cwd`. `$.cwd` is refused at
    // compile time — "`$.cwd` is used as a value … `$` is always spelled
    // `$.noun.event(...)`" — and `session.start`'s `e.cwd` is already folded into
    // that atom by startBand. Reading it from there rather than re-deriving it
    // also means the band and the pane cannot end up pointed at different repos.
    const cfg = await read($, bandConfig);
    const jobs = await readAllJobs(fsOf($), cfg.repo, await $.clock.now());
    const { running, finished } = countSummary(jobs);
    return { text: formatHeaderLine(running, finished) };
  });

  // ── the pane itself ───────────────────────────────────────────────────────
  //
  // A PANE IS OURS. Unlike the band, we do NOT call `next(e)` and we do not defer
  // to the host: a pane exists to be our own surface, and there is no host content
  // in it to preserve. TERMINAL-UI.md's "yield to the host" rule applies to the
  // band, where other mods and Claude Code draw above the prompt; it does not
  // apply here, and calling next(e) would be cargo-culting.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, _next) => {
    const { Box, Text, Button, Markdown, Code } = $.ui.resolve(e);

    // Subscribe to the clock. This read is what repaints the pane as elapsed cells
    // tick; without it the pane would redraw only when something else changed.
    const clock: number = await read($, now);
    const t = clock > 0 ? clock : Date.now();

    const pick: string | null = await read($, selected);
    const hidden: string[] = await read($, cleared);
    // Same `bandConfig.repo` the band reads: one repo, resolved once. See the note
    // on the `command.run` handler above for why this is not `$.cwd`.
    const repo = (await read($, bandConfig)).repo;
    const fs = fsOf($);

    if (pick !== null) {
      // WITH REPORTS. The detail view is the one place a report is shown, and it
      // shows one at a time — unlike the band, which would be re-reading and
      // re-stringifying every report in the directory on a 3 s poll forever.
      const job = await readJob(fs, repo, pick, t);
      if (job !== null) {
        // Read the tool history HERE, not inside the history component: components
        // here are synchronous factory functions, so an async one would return a
        // Promise, and a Promise is not a renderable element. Reading in the hook
        // also means exactly one read per render.
        const history = await readToolHistory(fs, repo, pick);
        return renderDetail($, e, job, t, history, hidden, { Box, Text, Button, Markdown, Code });
      }
      // The selected job vanished — agy-staff cleaned the directory, or the id
      // came from a stale list. Fall back to the list rather than rendering a
      // detail view for nothing; a blank pane reads as a crash.
      await update($, selected, () => null);
    }

    // WITHOUT reports: the list row is a glyph, a clock and a count. Pulling
    // 256 KB of markdown into a list of 20 rows to draw none of it is the kind
    // of read that makes a pane feel broken.
    return renderList($, e, await readAllJobs(fs, repo, t), t, hidden, { Box, Text, Button });
  });
};

/**
 * The components `$.ui.resolve(e)` hands back.
 *
 * Resolved ONCE per render and threaded through the two view functions, rather
 * than re-resolved inside each. `resolve` is cheap, but threading them makes it
 * structurally impossible for the list and the detail view to disagree about
 * which component set they are drawing with.
 */
interface Widgets extends UiComponents {}

/** The subset the list needs. The detail view needs all five. */
type ListWidgets = Pick<Widgets, 'Box' | 'Text' | 'Button'>;

// ── level 1: the list ───────────────────────────────────────────────────────

/**
 * The list level of the two-level pane.
 *
 * Header, then one Button per job, then the footer. The header carries the counts
 * because a count is a determinate quantity and a spinner is not: polling has no
 * progress to report, so an indeterminate spinner would claim work that is not
 * happening (TERMINAL-UI.md §Empty/loading).
 *
 * JOBS ARE `Button`s, NOT `Text`s. That is what makes the list navigable — every
 * row gets a hotkey and keyboard selection for free, and a pane the user can only
 * read by clicking is a worse pane.
 */
function renderList(
  $: EngineInterface,
  e: UiRenderEvent,
  all: readonly RadarJob[],
  t: number,
  hidden: readonly string[],
  W: ListWidgets,
): JSX.Element {
  const { Box, Text, Button } = W;
  // `c` filters locally rather than deleting anything: agy-staff owns this
  // directory and a UI preference must not destroy another process's state.
  const sorted = sortJobs(all.filter((j) => !hidden.includes(j.id) || !isTerminal(j.status)));
  const { running, finished } = countSummary(sorted);

  // Empty state: one literal line. NOT a box, NOT a spinner, NOT "0 jobs".
  // A pane whose whole content is a border and the word "empty" is louder than a
  // pane with nothing in it.
  if (sorted.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">{EMPTY_STATE}</Text>
        {footer($, W, false, hidden)}
      </Box>
    );
  }

  // Left-align the id column to the widest id actually on screen, capped so one
  // pathological id cannot push every row's clock off the pane.
  const idWidth = Math.min(
    28,
    Math.max(...sorted.slice(0, LIST_ROWS).map((j) => j.id.length)),
  );

  const shown = sorted.slice(0, LIST_ROWS);

  return (
    <Box flexDirection="column">
      {/* Counts, not a spinner. `wrap="truncate-end"` on every Text: a wrapped
          status line becomes two rows and the pane's height changes under the
          user's cursor. */}
      <Text bold wrap="truncate-end">{formatHeaderLine(running, finished)}</Text>

      {shown.map((job, i) => (
        <Button
          key={`job-${job.id}`}
          plain
          hotkey={String(i + 1)}
          // dimColor only for jobs that are over. The BAND owns this decision for
          // running rows; here it is a secondary signal, so it is dimColor and
          // never `gray` (TERMINAL-UI.md §Colour).
          dimColor={isTerminal(job.status)}
          label={formatJobLine(job, { idWidth, now: t })}
          // `void`: Button.onPress is Promise<void> and update() resolves to the new
          // value, which is not assignable. The value is discarded by design.
          onPress={() => void update($, selected, () => job.id)}
        />
      ))}

      {/* Row cap. A list that grows without bound pushes the footer off screen. */}
      {sorted.length > LIST_ROWS && (
        <Text dimColor wrap="truncate-end">{`  … ${sorted.length - LIST_ROWS} older`}</Text>
      )}

      {footer($, W, false, hidden)}
    </Box>
  );
}

// ── level 2: the detail view ────────────────────────────────────────────────

/**
 * The detail level: task, tool history, current reasoning, warnings, report.
 *
 * THE ORDER IS AN ARGUMENT. The user's first question about a job is "what did it
 * do", so the task comes first and the report last: a reader who stops after the
 * first screen has still learned what the job was for. Warnings sit immediately
 * above the report because a warning changes how the report should be read — a
 * "done" job with `suspicious_success` must not be read as a success, and burying
 * that below the report would guarantee it gets missed.
 */
function renderDetail(
  $: EngineInterface,
  e: UiRenderEvent,
  job: RadarJob,
  t: number,
  history: readonly ToolEntry[],
  hidden: readonly string[],
  W: Widgets,
): JSX.Element {
  const { Box, Text, Button, Markdown, Code } = W;

  return (
    <Box flexDirection="column">
      {/* Header: identity, then liveness. Same order as the list row so the two
          levels look like the same product. */}
      <Text wrap="truncate-end">
        <Text color={pickColor(job.status)} bold>
          {`${pickGlyph(job.status)} ${job.id}`}
        </Text>
        <Text dimColor>{`  ${detailSummary(job, t)}`}</Text>
      </Text>

      {/* The task. prompt_source.task's first line only — the real tasks run to
          60+ lines and the pane has no room, and the whole body is available in
          the spec file if anyone needs it. */}
      {job.task.length > 0 && (
        <Text wrap="truncate-end">{oneLine(job.task, e.props.bodyColumns - 2)}</Text>
      )}

      {/* Current reasoning. Only for a live job: a finished job's last thought is
          not news, and its report says the same thing better. */}
      {job.status === 'running' && job.reasoning !== null && (
        <Text dimColor wrap="truncate-end">{oneLine(job.reasoning, 300)}</Text>
      )}

      <Text dimColor>{'─'.repeat(Math.max(10, e.props.bodyColumns - 2))}</Text>

      {/* Tool history, newest last so it reads forward in time. Empty is stated in
          words: for a cleanly finished job there IS no history on disk, and a
          silent section would look like a rendering failure. */}
      <ToolHistory entries={history} W={W} />

      {/* Warnings, above the report on purpose. See the order note above. */}
      {job.warnings.length > 0 && (
        <>
          <Text bold wrap="truncate-end">{`Warnings (${job.warnings.length})`}</Text>
          {job.warnings.map((w) => (
            <Text key={`w-${w.code}`} color="yellow" wrap="truncate-end">
              {`! ${oneLine(w.message, 300)}`}
            </Text>
          ))}
          <Text dimColor>{'─'.repeat(Math.max(10, e.props.bodyColumns - 2))}</Text>
        </>
      )}

      {/* The report. Markdown, not Code: it is prose written by a worker, and
          rendering it as a monospace blob would make it harder to skim than the
          one-line summary above it already did. */}
      {job.report !== null && job.report.trim().length > 0 ? (
        <Markdown source={job.report} />
      ) : (
        // No report. On a terminal status this is the headline rule from
        // normalize.ts: empty output + warnings is a suspicious success, not a
        // success, so we say plainly that there is nothing to read.
        <Text dimColor wrap="truncate-end">
          {isTerminal(job.status) ? 'No report was written.' : 'No report yet — still running.'}
        </Text>
      )}

      {footer($, W, true, hidden)}
    </Box>
  );
}

/**
 * The one-line liveness summary for the detail header: `running · 12m04s · 341 tools`.
 *
 * A separate helper rather than slicing the output of formatJobLine: slicing a
 * formatted line back into parts means the header silently breaks the day
 * formatJobLine's layout changes. Both call the same primitives instead, so they
 * cannot drift, and neither depends on the other's string layout.
 */
function detailSummary(job: RadarJob, t: number): string {
  // Annotated as string[] because the first element is a RadarStatus and TS would
  // otherwise infer the array as RadarStatus[] and reject the strings pushed after.
  const bits: string[] = [job.status];
  const span = job.startedAt === null ? null : (job.endedAt ?? t) - job.startedAt;
  // A blank clock when the start is unknown, matching the list row's rule.
  const clock = span === null ? '' : elapsedCell(span);
  if (clock !== '') bits.push(clock);
  const tools = toolCountCell(job.toolCount);
  if (tools !== '') bits.push(`${tools} tools`);
  return bits.join(' · ');
}

/**
 * The tool history section.
 *
 * PURE and SYNCHRONOUS by design. An earlier draft made this an async component
 * that read events.jsonl itself, which does not work: an async function returns a
 * Promise, and a Promise is not a valid JSX element. The read is hoisted into the
 * render hook (see the call to readToolHistory above), which also means it happens
 * exactly once per render instead of once per component mount.
 *
 * events.jsonl is 500 KB on a long job, and the list view never touches it at all —
 * a pane that read half a megabyte per job per render would be unusable, and would
 * pay that cost for a section most users never open.
 */
function ToolHistory({ entries, W }: { entries: readonly ToolEntry[]; W: Widgets }): JSX.Element {
  const { Box, Text } = W;

  if (entries.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">No tool history available.</Text>
      </Box>
    );
  }

  const shown = entries.slice(-HISTORY_ROWS);
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">{`Tools (last ${shown.length})`}</Text>
      {shown.map((entry, i) => (
        <Text key={`t-${i}-${entry.tool}`} wrap="truncate-end">
          {/* One accent per line maximum, and red is reserved (TERMINAL-UI.md
              §Colour): the tool name is coloured, its output never is. */}
          <Text color={entry.state === 'error' ? 'red' : 'cyan'}>{`${entry.tool} `}</Text>
          <Text dimColor wrap="truncate-end">
            {entry.output.length > 0 ? `${entry.label} → ${oneLine(entry.output, 120)}` : entry.label}
          </Text>
        </Text>
      ))}
      {entries.length > HISTORY_ROWS && (
        <Text dimColor wrap="truncate-end">{`  … ${entries.length - HISTORY_ROWS} earlier`}</Text>
      )}
    </Box>
  );
}

// ── the footer ──────────────────────────────────────────────────────────────

/**
 * The footer. Identical in both levels except for the `back` button, which exists
 * only in the detail view — the same key in both levels keeps muscle memory.
 *
 * Buttons rather than a text line: the host renders the hotkey hints, so `q` and
 * `c` are discoverable without this file having to draw them, and the reference
 * mod's shape is a Button row for exactly this reason.
 */
function footer(
  $: EngineInterface,
  W: ListWidgets,
  inDetail: boolean,
  hiddenFinished: readonly string[],
): JSX.Element {
  const { Box, Button } = W;
  return (
    <Box flexDirection="row" gap={1}>
      {/* `b` in the detail view only; `c` on the list only. Deliberately the SAME
          letter across both levels where they overlap, so muscle memory survives
          navigating. `q` closes from anywhere. */}
      {inDetail && (
        <Button
          key="back"
          label="Back"
          hotkey="b"
          variant="primary"
          // `void` on every onPress: Button's onPress is typed `Promise<void>`, and
          // update() resolves to the new value (string | null here), which is not
          // assignable. The value is discarded by design — this is a command, not a
          // query.
          onPress={() => void update($, selected, () => null)}
        />
      )}
      {!inDetail && (
        <Button
          key="clear"
          label="Clear finished"
          hotkey="c"
          // Dismiss the FINISHED jobs only. A running job is never dismissed: hiding
          // work in flight would defeat the point of the surface.
          onPress={() => void update($, cleared, () => hiddenFinished)}
        />
      )}
      <Button
        key="close"
        label="Close"
        hotkey="q"
        onPress={() => void $.ui.close({ id: PANE })}
      />
    </Box>
  );
}

// =============================================================================
// § END PANE — end of this file's section.
// =============================================================================

/**
 * Re-exported so the pane's pure surface is importable from one place, and so the
 * band half (if it wants the same line formatting) does not have to know which
 * module the helpers live in.
 */
export {
  EMPTY_STATE,
  describeTool,
  elapsed,
  elapsedCell,
  formatHeaderLine,
  formatJobLine,
  isTerminal,
  oneLine,
  pickColor,
  pickGlyph,
} from './format.ts';

export type { RadarJob, RadarStatus } from '../types/index.d.ts';