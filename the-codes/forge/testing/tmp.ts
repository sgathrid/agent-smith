/**
 * tmp.ts — test helper: temp directories removed in one `test.after`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

/** Returns a `makeDir()` whose directories are all deleted when the calling test file finishes. */
export function trackedTempDirs(prefix: string): () => string {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  return () => {
    const d = mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  };
}
