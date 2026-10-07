/**
 * The one place the stall threshold is defined.
 *
 * WHY THIS FILE EXISTS: two surfaces (the mod pane and the channel) each need to
 * answer "is this running job actually working?", and if they disagree the user
 * gets a band that says a job is fine while the channel tells Claude it is stuck.
 * That contradiction is the exact failure this project exists to eliminate, so the
 * number is stated once.
 *
 * WHY IT IS NOT IMPORTED FROM core/liveness.ts: that module's DEFAULT_GRACE_MS is
 * the right number, but it is a sibling package the mod cannot resolve a bare
 * specifier for, and duplicating the literal in two files is how they drift. So:
 * one constant, here, imported by both surfaces, with a comment tying it to
 * core/liveness.ts so a future change there has an obvious counterpart here.
 *
 * Value: core/liveness.ts's DEFAULT_GRACE_MS, 15 minutes.
 * Reasoning that number is defensible: agy-staff's own default timeout is 60m
 * (every real spec.json in the corpus says `timeout: "60m"`), so 15m of silence
 * is a quarter of the budget gone with nothing to show, while still leaving ample
 * room for a genuinely long single command like `cargo test --workspace` on a
 * cold target directory.
 */
export const STALL_GRACE_MS = 15 * 60 * 1000;