/**
 * Small shared pieces for the mod's readers. No `claude-code` and no `node:`
 * import: the engine hands readers `$.fs`, narrowed to this shape.
 */

export interface FsLike {
  /** Reads a file as text. REJECTS when missing — never fatal here. */
  read(path: string): Promise<string>;
  /** Lists a directory, `{ name, kind, size }` per entry. Rejects when missing. */
  list(path: string): Promise<readonly { name: string; kind: string; size: number }[]>;
  /** Never rejects. */
  exists(path: string): Promise<boolean>;
}

/** ISO-8601 → epoch ms, or null. NaN never becomes a number here. */
export function toEpoch(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}
