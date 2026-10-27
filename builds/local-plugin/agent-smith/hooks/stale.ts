/**
 * The one place the stall threshold is defined.
 *
 * WHY THIS FILE EXISTS: two surfaces (the mod pane and the channel) each need to
 * answer "is this running job actually working?", and if they disagree the user
 * gets a band that says a job is fine while the channel tells Claude it is stuck.
 * That contradiction is the exact failure this project exists to eliminate, so the
 * number is stated once.
 *
 * WHY ONE CONSTANT HERE: the mod cannot resolve a bare specifier for a sibling
 * package, and duplicating the literal in two files is how they drift. So: one
 * constant, here, imported by both surfaces.
 *
 * Value: 15 minutes.
 * Reasoning that number is defensible: agy-staff's own default timeout is 60m
 * (every real spec.json in the corpus says `timeout: "60m"`), so 15m of silence
 * is a quarter of the budget gone with nothing to show, while still leaving ample
 * room for a genuinely long single command like `cargo test --workspace` on a
 * cold target directory.
 */
export const STALL_GRACE_MS = 15 * 60 * 1000;

/**
 * The one stall rule. Only a `running` job can stall (a settled job has nothing
 * left to be silent about). No evidence of progress at all, or a timestamp that
 * does not parse, counts as STALLED: "we do not know" must never be drawn as
 * "fine". `updatedAt` is an ISO string or epoch ms, as each caller holds it.
 */
export function isStalled(status: string, updatedAt: string | number | null | undefined, now: number): boolean {
  if (status !== 'running') return false;
  const then = typeof updatedAt === 'number' ? updatedAt : typeof updatedAt === 'string' ? Date.parse(updatedAt) : NaN;
  return Number.isNaN(then) || now - then > STALL_GRACE_MS;
}
