/** Shape guards shared by the canonical reader and the native-task bridge.
 * Dependency-free: the mod loader allows only sibling files.
 */

/** A plain object, or null for anything else (arrays included). */
export function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/** The first non-blank string, returned as it came (untrimmed), or null. */
export function firstText(...values: unknown[]): string | null {
  return values.find(v => typeof v === 'string' && v.trim() !== '') as string | undefined ?? null;
}

/** The first non-blank string, trimmed, or null. */
export function firstTrimmed(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}
