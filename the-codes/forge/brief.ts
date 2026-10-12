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
  /** Undefined for pipeline roles outside the closed mode set. */
  readonly preset?: ModePreset | undefined;
  readonly cwd: string;
  /** Why the work matters and who it is for, in the orchestrator's words. */
  readonly context?: string | undefined;
  readonly checks?: readonly BriefCheck[] | undefined;
  /** Pipeline stages get their workspace and artifact lines from runner.ts. */
  readonly pipelineStage?: boolean | undefined;
  /** A resumed conversation has seen the brief already. */
  readonly resuming?: boolean | undefined;
}

function checkLine(check: BriefCheck): string {
  const command = check.command.includes('`') ? check.command : `\`${check.command}\``;
  return `- ${check.name}: ${command}${check.cwd === undefined ? '' : ` (in ${check.cwd})`}`;
}

function checkLines(checks: readonly BriefCheck[]): string[] {
  const gating = checks.filter((c) => c.blocking !== false);
  const advisory = checks.filter((c) => c.blocking === false);
  return [
    ...(gating.length === 0
      ? []
      : [
          "You're done when these checks pass. They run after you finish, so run them yourself first if you can:",
          ...gating.map(checkLine),
        ]),
    ...(advisory.length === 0
      ? []
      : ['These also run afterwards, for information only:', ...advisory.map(checkLine)]),
  ];
}

/** The brief, or '' when there is nothing to add. Joined to the prompt with a blank line. */
export function buildBrief(input: BriefInput): string {
  const context = input.context?.trim();
  const contextLines = context ? [`Context: ${context}`] : [];
  const checks = input.checks?.length ? checkLines(input.checks) : [];
  if (input.resuming === true) return [...contextLines, ...checks].join('\n');

  return [
    "You're working for an orchestrating agent that will check your work and act on your report.",
    ...(input.pipelineStage === true
      ? []
      : [
          `Workspace: ${input.cwd}. Make your changes only inside it: that's where the orchestrator reviews them, ` +
            'and edits elsewhere would go unreviewed.',
        ]),
    ...contextLines,
    ...checks,
    ...(input.preset === undefined ? [] : [input.preset.guidance]),
    'In your report, only claim what you can point to: command output, file contents or a diff. ' +
      "If you couldn't verify something, say so.",
  ].join('\n');
}
