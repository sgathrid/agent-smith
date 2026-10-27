import {a1 as toolLabel}from'./chunk-execute.js';/**
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
const STALL_GRACE_MS = 15 * 60 * 1000;
/** A heartbeat older than this, on a job still marked running, means nobody is running it. */
const ALIVE_GRACE_MS = 2 * 60_000;
const LIVENESS_STATES = ['active', 'in-tool', 'waiting', 'silent', 'dead'];
function epoch(v) {
    if (typeof v === 'number')
        return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string' || v === '')
        return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
}
/**
 * The one liveness rule. Both surfaces call it (the channel for `status` and
 * `list_jobs` and its attention push, the mod for the band, pane and notices),
 * so they cannot disagree. Null for a job that is not running.
 */
function livenessOf(i) {
    if (i.status !== 'running' && i.status !== 'attention')
        return null;
    const times = [epoch(i.lastEventAt), epoch(i.updatedAt)].filter((t) => t !== null);
    const lastSeen = times.length > 0 ? Math.max(...times) : null;
    const silentForMs = lastSeen === null ? 0 : Math.max(0, i.now - lastSeen);
    const alive = epoch(i.lastAliveAt);
    const a = i.lastActivity;
    const open = a != null && a.status === 'active' && typeof a.tool === 'string' && a.tool !== '';
    const tool = open ? toolLabel(a.tool, typeof a.input === 'string' ? a.input : null) : undefined;
    const withTool = tool === undefined ? {} : { tool };
    if (alive !== null && i.now - alive > ALIVE_GRACE_MS)
        return { state: 'dead', silentForMs, since: alive, forMs: i.now - alive, ...withTool };
    // No event time at all: unknown is never drawn as healthy.
    if (lastSeen === null)
        return { state: 'silent', silentForMs, since: null, forMs: silentForMs, ...withTool };
    // An older build wrote no heartbeat: only the old silence rule is provable.
    if (alive === null && silentForMs > STALL_GRACE_MS)
        return { state: 'silent', silentForMs, since: lastSeen, forMs: silentForMs, ...withTool };
    if (open)
        return { state: 'in-tool', silentForMs, since: lastSeen, forMs: silentForMs, ...withTool };
    if (silentForMs > STALL_GRACE_MS)
        return { state: 'silent', silentForMs, since: lastSeen, forMs: silentForMs };
    return { state: 'active', silentForMs, since: lastSeen, forMs: silentForMs };
}
/** The old boolean, derived: true for `silent` or `dead`. */
function isStalled(l) {
    return l !== null && (l.state === 'silent' || l.state === 'dead');
}export{LIVENESS_STATES as L,isStalled as i,livenessOf as l};