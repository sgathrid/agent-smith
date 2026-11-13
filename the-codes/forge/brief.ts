/**
 * forge/brief.ts — the short brief prepended to every worker's prompt.
 *
 * A worker used to receive one line of mode framing and the caller's prompt. It
 * was told what to do but not who it was working for, where its boundary was,
 * why the work mattered, or which checks would judge it. This builds those
 * lines from data the service already holds, and nothing else: every line has
 * to earn its place in every job's prompt.
 *
 * PURE, so the service, the tests and the docs all see the same text.
 *
 * A resumed conversation already holds the brief, so a resume gets only the
 * context and checks lines, and only when the caller supplied them again.
 *
 * Pipeline stages omit the workspace line: forge/runner.ts `buildStagePrompt`
 * already names the source workspace and the output artifact, and two
 * descriptions of one boundary invite the worker to reconcile them.
 */
import type { ModePreset } from './modes.ts';

/** What the worker is told about a check. Execution lives in forge/checks.ts. */
export interface BriefCheck {
  readonly name: string;
  readonly command: string;
  readonly cwd?: string | undefined;
  /** False means reported but never gating (forge/checks.ts). Default true. */
  readonly blocking?: boolean | undefined;
}

export interface BriefInput {
  /** Job mode name (e.g. 'implement', 'review', 'moderate', 'verify'). */
  readonly mode?: string | undefined;
  /** Undefined for pipeline roles outside the closed mode set. */
  readonly preset?: ModePreset | undefined;
  readonly cwd: string;
  /** Why the work matters and who it is for, in the orchestrator's words. */
  readonly context?: string | undefined;
  readonly checks?: readonly BriefCheck[] | undefined;
  /** Paths already modified in the workspace before the worker started. */
  readonly dirtyFiles?: readonly string[] | undefined;
  /** Pipeline stages get their workspace and artifact lines from runner.ts. */
  readonly pipelineStage?: boolean | undefined;
  /** A resumed conversation has seen the brief already. */
  readonly resuming?: boolean | undefined;
}

const DIRTY_FILES_CAP = 20;

function workspaceLine(mode: string | undefined, cwd: string): string {
  if (mode === 'review' || mode === 'moderate') return `Workspace: ${cwd}.`;
  return `Workspace: ${cwd}. Make changes only inside it; edits elsewhere go unreviewed.`;
}

function dirtyFilesLine(dirtyFiles: readonly string[] | undefined): string | null {
  if (dirtyFiles === undefined || dirtyFiles.length === 0) return null;
  const shown = dirtyFiles.slice(0, DIRTY_FILES_CAP);
  const rest = dirtyFiles.length - shown.length;
  const list = rest > 0 ? `${shown.join(', ')}, and ${rest} more` : shown.join(', ');
  return `Already modified before you started; not yours, leave them unless the task says otherwise: ${list}`;
}

function checkLine(check: BriefCheck): string {
  const command = check.command.includes('`') ? check.command : `\`${check.command}\``;
  return `- ${check.name}: ${command}${check.cwd === undefined ? '' : ` (in ${check.cwd})`}`;
}

function checkLines(checks: readonly BriefCheck[], mode?: string): string[] {
  const gating = checks.filter((c) => c.blocking !== false);
  const advisory = checks.filter((c) => c.blocking === false);
  const gatingHeader =
    mode === 'review' || mode === 'moderate' || mode === 'verify'
      ? 'These run after you finish; report their result if you run them:'
      : "You're done when these checks pass. They run after you finish, so run them yourself first if you can:";
  return [
    ...(gating.length === 0 ? [] : [gatingHeader, ...gating.map(checkLine)]),
    ...(advisory.length === 0
      ? []
      : ['These also run afterwards, for information only:', ...advisory.map(checkLine)]),
  ];
}

/** The brief, or '' when there is nothing to add. Joined to the prompt with a blank line. */
export function buildBrief(input: BriefInput): string {
  const context = input.context?.trim();
  const contextLines = context ? [`Context: ${context}`] : [];
  const checks = input.checks?.length ? checkLines(input.checks, input.mode) : [];
  if (input.resuming === true) return [...contextLines, ...checks].join('\n');

  const dirtyLine = input.pipelineStage === true ? null : dirtyFilesLine(input.dirtyFiles);

  return [
    "You're working for an orchestrating agent that will check your work and act on your report.",
    ...(input.pipelineStage === true ? [] : [workspaceLine(input.mode, input.cwd)]),
    ...(dirtyLine === null ? [] : [dirtyLine]),
    ...contextLines,
    ...checks,
    ...(input.preset === undefined ? [] : [input.preset.guidance]),
    'Start your report with `Status: DONE`, `Status: DONE_WITH_CONCERNS` or `Status: BLOCKED`. ' +
      "Only claim what you can point to (command output, file contents, a diff); say what you couldn't verify. " +
      'If the task conflicts with what you find, say so rather than guess.',
  ].join('\n');
}
