/**
 * forge/modes.ts — the closed set of job modes and what each one actually does.
 *
 * A mode sets ONLY provider-agnostic behavior: a line of guidance for the
 * worker's brief (forge/brief.ts) and a sandbox posture. It never picks a
 * provider or a model.
 *
 * The guidance gives the reason with the request. Workers follow a reason
 * better than a bare prohibition, and a reason also tells them what to do in
 * the cases a rule did not anticipate.
 */
export const MODES = ['implement', 'review', 'moderate', 'verify'] as const;
export type Mode = (typeof MODES)[number];

export interface ModePreset {
  readonly description: string;
  /** The mode's line in the worker brief (forge/brief.ts). */
  readonly guidance: string;
  /** Run read-only where the provider can enforce it. */
  readonly readOnly: boolean;
  /** True when the mode normally runs shell commands (preflight uses this). */
  readonly runsCommands: boolean;
}

export const MODE_PRESETS: Readonly<Record<Mode, ModePreset>> = Object.freeze({
  implement: {
    description: 'Make the change and report what changed and found.',
    guidance: 'Make the change, keeping it as small as the task allows. The orchestrator reviews the diff, and unrelated edits make that review harder. Say what you changed and why.',
    readOnly: false,
    runsCommands: true,
  },
  review: {
    description: 'Read-only review: report defects, missed cases and unsupported claims.',
    guidance: "Find problems; don't fix them. The author fixes from your findings, and your edits would change the work you're judging, so leave the files as they are. Give each defect, missed case or unsupported claim with its evidence (file:line, a failing input or command). Skip style nits unless asked.",
    readOnly: true,
    runsCommands: false,
  },
  moderate: {
    description: 'Independently probe prior work and reviewer findings; findings only.',
    guidance: "Test the earlier work and any reviewer's claims independently, and confirm or refute each one with evidence. Leave the files as they are: the author fixes from your findings, and your edits would change the work you're judging.",
    readOnly: true,
    runsCommands: false,
  },
  verify: {
    description: 'Run the checks and report what actually happened.',
    guidance: 'Run the checks and report exactly what happened, including the failing output. If something fails, report it rather than fixing it, so your result describes the work as it was handed to you.',
    readOnly: false,
    runsCommands: true,
  },
});

export function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value);
}
