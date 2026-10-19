/**
 * claude-code.d.ts — a local declaration of the Claude Code mod API.
 *
 * WHY THIS FILE EXISTS. `hooks/register.tsx` imports { atom, read, update } from
 * 'claude-code'. In a real install that module is provided by the Claude Code mod
 * SDK. It is not a dependency of this repo, and adding the SDK as a devDependency
 * would mean the terminal surface's types were versioned by something we do not
 * control. So we declare the surface we use.
 *
 * This is a DELIBERATE, PARTIAL declaration, and the partiality is the point:
 * it is exactly the API this mod touches, so if the host API changes shape, this
 * file is the thing that stops compiling. A fuller stub would be better at hiding
 * breakage and worse at catching it.
 *
 * Everything here is verified against Claude Code 2.1.292 — the hook names, the
 * `on(event, matcher, handler)` shape, the `{ modules: [...] }` hooks.json form
 * with no `modulePath` key, the `ui.render` + `component: 'Pane'` + `requestId`
 * targeting, `$.ui.open/close/resolve`, the `Button` prop set, and the component
 * names. Anything not listed here is not used by this mod and is not declared.
 */

declare module 'claude-code' {
  // ── state ──────────────────────────────────────────────────────────────────

  /**
   * A host-persisted state cell. Keyed by `{ plugin, key }` so two plugins cannot
   * collide and a hot reload keeps its value.
   *
   * Atoms MUST be declared at module scope. One created inside a hook closure is a
   * new store on every reload, which loses the user's selection.
   */
  export function atom<T>(
    ref: { plugin: string; key: string },
    initial: T,
  ): Atom<T>;

  export interface Atom<T> {
    readonly plugin: string;
    readonly key: string;
  }

  /**
   * Read a host-persisted value.
   *
   * `$` is the engine, and reading THROUGH it is what subscribes the calling
   * render to the atom: a render that reads `now` repaints when `now` changes. That
   * is the mechanism behind the pane's ticking clock — there is no separate
   * "subscribe" call.
   */
  export function read<T>($: EngineInterface, atom: Atom<T>): Promise<T>;

  /** Atomically write a host-persisted value. The function receives the current value. */
  export function update<T>($: EngineInterface, atom: Atom<T>, fn: (prev: T) => T): Promise<T>;

  // ── hooks ─────────────────────────────────────────────────────────────────

  /** What the engine looks like to a hook handler. Only what we use is declared. */
  export interface EngineInterface {
    /** The working directory of the session. */
    readonly cwd: string;
    readonly ui: UiApi;
    readonly command: CommandApi;
    readonly clock: ClockApi;
    /** Host-built tools such as TaskCreate and TaskUpdate. */
    readonly tool: ToolApi;
    /**
     * Host-provided filesystem access.
     *
     * The band half polls `.agy-staff/jobs/` through this rather than through
     * `node:fs`, which lets the host mediate I/O and lets tests inject a fake —
     * that is what `./jobs.ts`'s `FsLike` parameter is for.
     */
    readonly fs: FsApi;
    readonly env: EnvApi;
    /** Start a turn. Agent Smith uses it to hand Claude a completion notice. */
    readonly prompt: PromptApi;
  }

  /**
   * `$.prompt.submit({ text })`: the event `prompt.submit` with origin
   * `{ kind: 'plugin', name }`. It runs once the session is idle, and Claude
   * reads the text after a sentence naming this plugin as the sender. It
   * resolves when that turn STARTS, so a poll must not await it. (Host types,
   * CoreEngineInterface.prompt.submit; docs mods/api "Start a turn from a
   * background job".)
   */
  export interface PromptApi {
    submit(input: { text: string; asUser?: true }): Promise<unknown>;
  }

  /**
   * Host filesystem primitives.
   *
   * `read` and `list` REJECT when the path is missing and `exists` never does. That
   * asymmetry is deliberate on the host's side and callers rely on it: a missing
   * file in `.agy-staff/jobs/` is the NORMAL case (agy-staff deletes
   * progress.json on a clean success), so `exists` is the tolerant probe and the
   * other two are allowed to fail loudly.
   */
  export interface FsApi {
    read(path: string): Promise<string>;
    list(path: string): Promise<readonly FsEntry[]>;
    exists(path: string): Promise<boolean>;
    /** Writes the whole file, creating it and its directories (host types, 2.1.274+). */
    write(path: string, text: string): Promise<void>;
  }

  /** One directory entry. `kind` distinguishes 'file' from 'dir'. */
  export interface FsEntry {
    readonly name: string;
    readonly kind: string;
    readonly size: number;
  }

  /**
   * Host environment access.
   *
   * `get` takes a STRING LITERAL name — the host requires it so the variables a
   * module reads can be statically listed. A computed name is refused at compile
   * time, which is why every call site spells its variable out.
   *
   * `NO_COLOR` is honoured here per TERMINAL-UI.md §Colour: Claude Code already
   * tracks it, so we drop to glyph-only rather than substituting our own palette.
   */
  export interface EnvApi {
    get(name: string): Promise<string | undefined>;
  }

  export interface UiApi {
    /**
     * Open a pane.
     *
     * `columns` and `rows` are SIZE REQUESTS, verified against the 2.1.292
     * binary rather than guessed. The schema describes them as "The body columns
     * its content asked for while docked; a request the person's own sizing
     * overrides", and the terminal surface resolves the column request as
     *
     *     min(terminalColumns - 24, max(24, requested))
     *
     * with the width the person dragged the dock to (`pluginPanes.dockColumns`)
     * taking precedence over the request. With NO request at all the default is
     *
     *     min(floor(terminalColumns * 0.45), 90, terminalColumns - 70)
     *
     * which is 85 columns on a 190-column terminal — a right-hand third, with
     * rows wrapping at 90 while 190 sat unused. Passing `columns` is therefore the
     * difference between a pane that wastes two thirds of the screen and one that
     * uses it, and it costs one property.
     *
     * Only what this mod passes is declared, per this file's rule.
     */
    open(opts: {
      id: string;
      title: string;
      focus?: boolean;
      /** Requested pane width in columns; the surface clamps it. */
      columns?: number;
    }): Promise<unknown>;
    close(opts: { id: string }): Promise<unknown>;
    scroll(opts: { to: 'start' | 'end' | { key: string }; in?: string; block?: 'start' | 'end' | 'nearest' }): Promise<{ deny?: string }>;
    /** Resolve the render components for this render site. */
    resolve(e: UiRenderEvent): UiComponents;
    toast(text: string): Promise<unknown>;
    /**
     * One dim transcript line, prefixed by the host with this plugin's name.
     * Not sent to the model, and it does not start a turn. Returns void.
     */
    log(text: string): void;
  }

  export interface CommandApi {
    /**
     * Register a slash command. REJECTS if Claude Code already owns the name, which
     * is why every call site `.catch(() => {})`es it: refusing to start would take
     * the whole mod down over a name collision.
     */
    register(opts: { name: string; description: string; immediate?: true }): Promise<unknown>;
  }

  export interface ClockApi {
    /**
     * A repeating timer. Must be cancelled by the host on unload.
     *
     * Gate the work on visibility: a 1 Hz repaint of nothing is a laptop fan.
     * See TERMINAL-UI.md §Timing.
     */
    every(ms: number, fn: () => void | Promise<void>): unknown;
    /**
     * The current time in epoch ms.
     *
     * Preferred over `Date.now()` in a render path: it is the same clock the host
     * ticks against, so a pane drawing from it cannot disagree with a band drawing
     * from `clock.every` by a visible margin.
     */
    now(): Promise<number>;
  }

  export interface ToolApi {
    call(input:
      | {
          tool: 'TaskCreate';
          subject: string;
          description: string;
          activeForm?: string;
          metadata?: Record<string, unknown>;
        }
      | {
          tool: 'TaskUpdate';
          taskId: string;
          subject?: string;
          description?: string;
          activeForm?: string;
          status?: 'pending' | 'in_progress' | 'completed' | 'deleted';
        }
    ): Promise<{ result?: unknown; isError?: boolean; deny?: string; text?: string }>;
  }

  // ── render sites ───────────────────────────────────────────────────────────

  export interface UiRenderEvent {
    /** Whole window measurement; bodyColumns remains the pane's own budget. */
    readonly viewport?: { readonly columns: number; readonly rows: number; readonly isFullscreen?: boolean };
    /** 'AbovePrompt' | 'Pane' | 'Spinner' — where the host is drawing. */
    readonly component: string;
    /** For panes: the id passed to ui.open. Matched by `requestId`. */
    readonly requestId?: string;
    readonly props: {
      /**
       * The width available to this component's body, in columns. THE ENGINE
       * HANDS YOU THE BUDGET AND YOU MUST USE IT (TERMINAL-UI.md §Layout
       * contract): sizing a row's columns against the width of its own content
       * instead is what made the pane's rows wrap to two lines.
       */
      readonly bodyColumns: number;
      readonly hasSurvey?: boolean;
      readonly isWorking?: boolean;
      readonly isFocused?: boolean;
      readonly title?: string;
      /**
       * Rows the AbovePrompt band may occupy. The band honours it because a band
       * that grows without bound pushes the prompt off screen
       * (TERMINAL-UI.md §Timing: cap at 4, then `+N more`).
       */
      readonly maxRows?: number;
      /**
       * AbovePrompt: which transcript is on screen. `{}` on the main thread;
       * `{ agentId }` while the person is viewing a subagent (Claude Code 2.1.300).
       */
      readonly view?: { readonly agentId?: string };
      readonly scroll?: { readonly offset: number; readonly bodyRows: number };
      readonly text?: string;
      readonly isExpanded?: boolean;
      readonly origin?: { readonly kind: string; readonly name?: string; readonly asUser?: boolean };
      /** The same origin, under the name Claude Code 2.1.300 uses for the UserMessage site. */
      readonly stored?: { readonly kind: string; readonly name?: string; readonly asUser?: boolean };
    };
  }

  /**
   * The component set returned by `ui.resolve(e)`.
   *
   * Each returns a `JSX.Element`, NOT `unknown`. That distinction is load-bearing:
   * TypeScript rejects a component whose return type is `unknown` with
   * "cannot be used as a JSX component", so returning `unknown` here would make
   * every `<Box>` in the mod a compile error. The components are real JSX
   * factories at runtime; declaring them as anything else is a lie that the
   * compiler catches immediately.
   */
  export interface UiComponents {
    Box(props: BoxProps): JSX.Element;
    Text(props: TextProps): JSX.Element;
    Button(props: ButtonProps): JSX.Element;
    Markdown(props: MarkdownProps): JSX.Element;
  }

  /**
   * A hook handler.
   *
   * `next` is ALWAYS provided by the host and is what renders the rest of the
   * chain. It is declared non-optional because calling it is mandatory for the
   * AbovePrompt site: a band that does not return `next(e)`'s output erases what
   * Claude Code and other mods drew above the prompt. (A Pane handler legitimately
   * ignores it — see register.tsx.)
   */
  export type Handler<E = Record<string, unknown>> = (
    $: EngineInterface,
    e: E,
    // `next` is typed on `any` rather than `E` DELIBERATELY. The host hands the
    // same event object to both `next` and the handler, but a handler that declared
    // `next: (e: E) => …` and then calls `await next(e)` would be contravariant in a
    // way TS rejects for the ui.render site, where `e` is `UiRenderEvent`. Typing it
    // `any` makes "pass the event straight through" — the overwhelmingly common
    // case, and the one TERMINAL-UI.md requires — expressible.
    next: (e: any) => Promise<any>,
  ) => Promise<unknown>;

  /** A handler that returns a plain `{ text }` command result. */
  export type CommandHandler = (
    $: EngineInterface,
    e: Record<string, unknown>,
    next: (e: unknown) => Promise<unknown>,
  ) => Promise<unknown>;

  /**
   * Narrowing matcher. A handler given a matcher only fires for matching events —
   * this is how `ui.render` targets one pane instead of all of them, and how
   * `command.run` targets one command.
   */
  export interface Matcher {
    /** For ui.render: the render site. For command.run: the command name. */
    readonly component?: string;
    readonly requestId?: string;
    readonly command?: string;
  }

  /**
   * Narrowing matchers, one per event.
   *
   * The band uses `tool.call` with a `{ tool: 'Bash' }` matcher to detect a job
   * being dispatched and refresh immediately — TERMINAL-UI.md's "nothing moves
   * unless the user caused it", where the user causing it is dispatching work.
   */
  export interface ToolCallMatcher {
    readonly tool: string | RegExp;
  }

  export interface Registrar {
    (event: 'ui.render', matcher: Matcher, handler: Handler<UiRenderEvent>): void;
    (event: 'command.run', matcher: { command: string }, handler: CommandHandler): void;
    (event: 'tool.call', matcher: ToolCallMatcher, handler: Handler<ToolCallEvent>): void;
    (event: 'session.start', handler: Handler): void;
    (event: 'ui.close', handler: Handler<{ id: string }>): void;
    (event: 'ui.scroll', handler: Handler<{ component: string; requestId: string; origin: { kind: 'person' | 'plugin' }; offset: number; by: number; bodyRows: number; contentRows: number }>): void;
  }

  /** A tool invocation. Only the fields this mod reads are declared. */
  export interface ToolCallEvent {
    /** Tool name, e.g. 'Bash'. */
    readonly tool: string | RegExp;
    /** For Bash: the command line. */
    readonly command?: string;
    /** The loop the call runs in: set in a subagent, absent on the main loop. */
    readonly agentId?: string;
    [key: string]: unknown;
  }

  /**
 * The mod entry point. hooks.json's `modules` array names the file exporting this.
 *
 * RETURNS VOID — it does not return the band half's session-start handler — and the
 * reason is worth recording, because it is verified behaviour rather than a
 * preference: the engine REFUSES two matcher-less registrations of one event in a
 * module ("on(\"session.start\") is registered twice without a matcher").
 *
 * Both halves need session.start (the band to read `AGY_RADAR_REPO` and honour
 * `NO_COLOR`; the pane to register `/forge`), so the band half parks its handler
 * in a module-level variable and the pane half — which owns the single registration
 * — awaits it. That is the whole band↔pane coupling: two calls.
 */
  export type Register = (on: Registrar, options?: unknown) => void;

  // ── UI props we actually pass ──────────────────────────────────────────────
  //
  // Documented here rather than inline at the call sites because these are the
  // values that are easy to get wrong: `dimColor` is theme-aware and `gray` is a
  // fixed colour that vanishes on one of light/dark, and `wrap="truncate-end"` is
  // what stops a status line from becoming two rows and pushing the prompt.

  /** Colour values Claude Code's Text accepts. Verified in 2.1.292. */
  export type TextColor =
    | 'red'
    | 'green'
    | 'yellow'
    | 'blue'
    | 'magenta'
    | 'cyan'
    | 'white'
    | 'gray'
    | 'grey'
    | undefined;

  /** Never `gray` for secondary text — see TERMINAL-UI.md §Colour. */
  export interface TextProps {
    /**
     * `key` is part of the props object rather than a JSX attribute the compiler
     * strips, because these components are plain factory functions at runtime, not
     * JSX intrinsics. Every mapped row needs one, or a re-render reuses the wrong
     * element.
     */
    key?: string;
    color?: TextColor;
    dimColor?: boolean;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    inverse?: boolean;
    /** 'truncate-end' is the only value used for status lines. */
    wrap?: 'truncate-end' | 'wrap';
    children?: unknown;
  }

  export interface ButtonProps {
    key?: string;
    label: string;
    /** A single character. Digits for list rows, letters for the footer. */
    hotkey?: string;
    variant?: 'primary' | 'secondary' | 'danger';
    plain?: boolean;
    dimColor?: boolean;
    onPress: () => void | Promise<void>;
    /** Strings and `Text` drawn in the label's place; the label then names the control. */
    children?: unknown;
  }

  export interface BoxProps {
    key?: string;
    flexDirection?: 'row' | 'column';
    gap?: number;
    children?: unknown;
  }

  export interface MarkdownProps {
    /**
     * The markdown body.
     *
     * `text`, NOT `source` — a vendored declaration guessed `source` and the
     * engine refused it at render time:
     *   "JSX element <Markdown> needs text, a string (the markdown)"
     * When the two disagree, the runtime error IS the specification.
     */
    text: string;
    key?: string;
  }

  // CodeProps deliberately NOT declared. It was a guess (`source`), and the
  // Markdown guess was wrong the same way. The engine is the spec: find out by
  // using it once and reading the thrown HooksError, not by inventing a shape.
}

// ── JSX ────────────────────────────────────────────────────────────────────
//
// Declared at GLOBAL scope, not inside `declare module`, because JSX typechecking
// looks for a global JSX namespace — this is the classic-react shape that works
// with `"jsx": "preserve"`.
//
// The four container components are uppercase JSX names resolved at RUNTIME from
// `$.ui.resolve(e)`; they are never imported. That is why they appear here as
// intrinsic-ish names rather than as imports: nothing in this file is a real
// module, and pretending otherwise would make the mod look importable when it is
// not.

// Declared at the TOP LEVEL of this file, not inside `declare global`. This file is
// a script (it has no top-level import/export), so its top level already IS the
// global scope — `declare global` would require the file to be a module and would
// silently do nothing useful here. `namespace JSX` with the classic-react shape is
// what `"jsx": "preserve"` looks for.
declare namespace JSX {
  interface Element {
    readonly __jsxBrand: unique symbol;
  }

  interface ElementChildrenAttribute {
    children: Record<string, unknown>;
  }

  /**
   * `children` is deliberately loose. Nesting <Text> inside <Text> is how the
   * colour of a run of characters is set, and typing that precisely buys nothing —
   * the render output is validated by Claude Code at runtime, not by tsc.
   */
  interface IntrinsicElements {
    Box: import('claude-code').BoxProps;
    Text: import('claude-code').TextProps;
    Button: import('claude-code').ButtonProps;
    Markdown: import('claude-code').MarkdownProps;
    Code: import('claude-code').CodeProps;
  }
}
