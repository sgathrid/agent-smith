/**
 * watched-files.ts — brief/spec files a worker is told to read, copied into its
 * cwd and tracked by signature so a later edit on either side is noticed.
 */

import { copyFileSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { WatchedFileSigs } from './format.ts';
import { fileSig } from './writer.ts';

export const MAX_WATCHED_FILES = 32;
export const MAX_WATCHED_BYTES = 4 * 1024 * 1024;

export function validateWatchedFiles(repo: string, files: readonly string[]): string[] {
  const repoRoot = path.resolve(repo);
  let realRepoRoot = repoRoot;
  try {
    realRepoRoot = realpathSync(repoRoot);
  } catch { /* non-existent repo root caught by per-file stat below */ }
  const seen = new Set<string>();
  const out: string[] = [];
  let totalBytes = 0;
  for (const raw of files) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      throw new Error('files entry must be a non-empty relative path inside the repository.');
    }
    if (path.isAbsolute(trimmed)) {
      throw new Error(`watched file "${trimmed}" must be a relative path inside the repository.`);
    }
    const abs = path.resolve(repoRoot, trimmed);
    const rel = path.relative(repoRoot, abs);
    if (rel === '' || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`watched file "${trimmed}" escapes repository root ${repoRoot}.`);
    }
    const normalized = rel.split(path.sep).join('/');
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new Error(`watched file "${normalized}" does not exist in ${repoRoot}.`);
    }
    if (!st.isFile()) {
      throw new Error(`watched file "${normalized}" is not a regular file.`);
    }
    let realAbs: string;
    try {
      realAbs = realpathSync(abs);
    } catch {
      throw new Error(`watched file "${normalized}" does not exist in ${repoRoot}.`);
    }
    const realRel = path.relative(realRepoRoot, realAbs);
    if (realRel === '' || realRel === '.' || realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error(`watched file "${normalized}" resolves outside repository root ${repoRoot}.`);
    }
    if (!seen.has(normalized)) {
      if (out.length >= MAX_WATCHED_FILES) {
        throw new Error(`files exceeds maximum of ${MAX_WATCHED_FILES} watched files (${files.length} requested).`);
      }
      totalBytes += st.size;
      if (totalBytes > MAX_WATCHED_BYTES) {
        throw new Error(`watched files exceed maximum total size of ${MAX_WATCHED_BYTES} bytes.`);
      }
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

export function syncWatchedFiles(
  repo: string,
  cwd: string,
  files: readonly string[],
  previousWatched?: Readonly<Record<string, WatchedFileSigs>> | null,
  onWarning?: (message: string) => void,
): Record<string, WatchedFileSigs> {
  const normalized = validateWatchedFiles(repo, files);
  const repoRoot = path.resolve(repo);
  const cwdRoot = path.resolve(cwd);
  const sameRoot = repoRoot === cwdRoot;
  const out: Record<string, WatchedFileSigs> = {};
  for (const rel of normalized) {
    const repoSig = fileSig(repoRoot, rel);
    if (!sameRoot) {
      const src = path.join(repoRoot, rel);
      const dst = path.join(cwdRoot, rel);
      // Resolve every existing component, including a symlink at the file itself.
      // Missing suffixes are safe only after their nearest existing parent passed.
      const realRoot = realpathSync(cwdRoot);
      let component = cwdRoot;
      for (const part of rel.split('/')) {
        component = path.join(component, part);
        try { lstatSync(component); } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') break;
          throw err;
        }
        const resolved = realpathSync(component);
        const relative = path.relative(realRoot, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error(`watched file "${rel}" destination resolves outside worker cwd ${cwdRoot}.`);
        }
      }
      const prev = previousWatched?.[rel];
      const currentCwdSig = fileSig(cwdRoot, rel);
      if (prev === undefined || currentCwdSig === 'gone') {
        mkdirSync(path.dirname(dst), { recursive: true });
        copyFileSync(src, dst);
      } else if (prev.repoSig !== repoSig) {
        if (currentCwdSig !== prev.cwdSig) {
          onWarning?.(`watched file "${rel}" changed in both repo and worktree; kept worktree copy`);
        } else {
          mkdirSync(path.dirname(dst), { recursive: true });
          copyFileSync(src, dst);
        }
      }
    }
    const cwdSig = sameRoot ? repoSig : fileSig(cwdRoot, rel);
    const prev = previousWatched?.[rel];
    // Keep the last shared baseline until worker edits are reconciled. Retaining
    // a divergent copy must never make it replaceable on the following sync.
    out[rel] = prev !== undefined && cwdSig !== repoSig && cwdSig !== prev.cwdSig
      ? prev : { repoSig, cwdSig };
  }
  return out;
}
