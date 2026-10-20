/**
 * update.ts: whether a newer agent-smith has been released. Pure; no host API.
 *
 * Claude Code updates a third-party marketplace's plugins only when the user
 * turned auto-update on for it, and says nothing when one is out of date. The
 * mod reads the released manifest once a session and shows one toast.
 */

/** The manifest `claude plugin update` would install: the committed build on main. */
export const RELEASED_MANIFEST =
  'https://raw.githubusercontent.com/sgathrid/agent-smith/main/builds/local-plugin/agent-smith/.claude-plugin/plugin.json';

/** A manifest's `version`, or null when the text is not a manifest that states one. */
export function manifestVersion(text: string): string | null {
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === 'string' && /^\d+(?:\.\d+)*$/.test(version) ? version : null;
  } catch {
    return null;
  }
}

/** True when `latest` is a higher dotted version than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const a = latest.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** The toast, or null when there is nothing to say. */
export function updateLine(current: string | null, latest: string | null): string | null {
  if (current === null || latest === null || !isNewer(latest, current)) return null;
  return `agent-smith update available: v${current} → v${latest}`;
}
