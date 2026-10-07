/**
 * forge/modes.ts — the closed set of job modes and what each one actually does.
 *
 * A mode sets ONLY provider-agnostic behavior: a prompt preamble and a
 * sandbox posture. It never picks a provider or a model.
 */
export const MODES = ['implement', 'review', 'moderate', 'verify'] as const;
export type Mode = (typeof MODES)[number];

export interface ModePreset {
  readonly description: string;
  /** Prepended to the caller's prompt. */
  readonly preamble: string;
  /** Run read-only where the provider can enforce it. */
  readonly readOnly: boolean;
  /** True when the mode normally runs shell commands (preflight uses this). */
  readonly runsCommands: boolean;
}

export const MODE_PRESETS: Readonly<Record<Mode, ModePreset>> = Object.freeze({
  implement: {
    description: 'Make the change and report what changed and found.',
    preamble: 'Do the work and report what you changed and found.',
    readOnly: false,
    runsCommands: true,
  },
  review: {
    description: 'Read-only review: report defects, missed cases and unsupported claims.',
    preamble: 'Review the work. Report defects, missed cases, and unsupported claims with evidence. Do not edit or rewrite files; put findings in your reply.',
    readOnly: true,
    runsCommands: false,
  },
  moderate: {
    description: 'Independently probe prior work and reviewer findings; findings only.',
    preamble: 'Probe the prior work independently. Report findings only, with evidence. Do not edit files.',
    readOnly: true,
    runsCommands: false,
  },
  verify: {
    description: 'Run the checks and report what actually happened.',
    preamble: 'Run the checks and report what actually happened, including exact failures.',
    readOnly: false,
    runsCommands: true,
  },
});

export function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value);
}
