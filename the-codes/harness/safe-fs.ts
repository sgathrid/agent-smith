/**
 * safe-fs.ts — race-tolerant filesystem primitives shared by every reader.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every reader in this directory observes state that another process is
 * *actively mutating*. agy-staff rewrites `progress.json` every ~100ms and then
 * **deletes** it the moment a job finishes cleanly. Claude Code appends to a
 * subagent `.jsonl` while we read it. So between our `readdir` and our `read`,
 * a path can vanish, be truncated mid-write, or be replaced by a directory.
 *
 * Throwing here is never correct: a missing file is *information* (see hazard A
 * in agy-staff.ts), not an error. Every function in this module returns
 * `null` / `[]` / `false` instead of throwing. This is the single most
 * important flake-prevention rule in the harness.
 */

import { constants } from "node:fs";
import { access, open, readdir, stat } from "node:fs/promises";

/** Substrings of fs error codes that mean "the world moved on, carry on". */
const TRANSIENT_CODES = new Set([
  "ENOENT", // deleted between readdir and read (hazard A: clean-success cleanup)
  "EACCES", // macOS TCC / permissions
  "EPERM",
  "EISDIR", // a path we expected to be a file is a dir
  "ENOTDIR", // ...or vice versa
  "EBUSY",
  "ELOOP",
  "EMFILE",
  "ENFILE",
]);

/**
 * Default byte cap for text reads.
 *
 * WHY: `events.jsonl` reached 492KB and a Claude subagent transcript 526KB in
 * the sample corpus. We only ever want the *head* of a stream for display; a
 * viewer that OOMs on a long job is worse than one that truncates. Callers
 * that genuinely need everything pass a bigger number.
 */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function isTransient(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return true; // be paranoid
  const code = (err as { code?: unknown }).code;
  // A non-Error throw is by definition something we did not anticipate.
  if (typeof code !== "string") return true;
  return TRANSIENT_CODES.has(code);
}

/** `fs.stat` that returns `null` instead of throwing. */
export async function statSafe(
  path: string,
): Promise<{ size: number; mtimeMs: number; isDir: boolean } | null> {
  try {
    const st = await stat(path);
    return { size: st.size, mtimeMs: st.mtimeMs, isDir: st.isDirectory() };
  } catch (err) {
    if (!isTransient(err)) throw err;
    return null;
  }
}

/** `fs.access(F_OK)` that returns a boolean instead of throwing. */
export async function existsSafe(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a file as UTF-8 text, capped at `maxBytes`.
 *
 * Returns `null` if the file is gone, unreadable, or a directory. Never throws.
 * A short read is *normal* here — it means we caught a half-written file, which
 * is exactly what we want the JSON parser downstream to survive.
 */
export async function readTextSafe(
  path: string,
  maxBytes: number = DEFAULT_MAX_BYTES,
): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, "r");
    // +4 bytes so a multi-byte UTF-8 sequence straddling the cap does not
    // become a replacement character at the boundary.
    const buf = Buffer.allocUnsafe(maxBytes + 4);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead === 0) return ""; // genuinely empty file is not "missing"
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch (err) {
    if (!isTransient(err)) throw err;
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Read and JSON.parse, tolerating every way that can go wrong.
 *
 * Returns `null` for: missing file, unreadable file, empty file, invalid JSON.
 * Invalid JSON is EXPECTED, not exceptional — agy-staff writes with a plain
 * `writeFile`, so a reader that arrives mid-write sees a truncated document.
 * Treating that as `null` and retrying on the next poll is the whole strategy.
 */
export async function readJsonSafe<T = unknown>(
  path: string,
  maxBytes?: number,
): Promise<T | null> {
  const text = await readTextSafe(path, maxBytes);
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === "") return null; // empty or all-whitespace ⇒ mid-write
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null; // half-written JSON. Next poll will get it.
  }
}

/**
 * `fs.readdir` that returns `[]` instead of throwing.
 *
 * NOTE: we do NOT `stat` each entry here. That would double the syscalls and
 * reintroduce the very race we are defending against. Callers should treat
 * every returned name as a *hypothesis* to be confirmed by a tolerant read.
 */
export async function readdirSafe(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (err) {
    if (!isTransient(err)) throw err;
    return [];
  }
}

/**
 * Read a byte-capped prefix of a text file, spanning MULTIPLE lines.
 *
 * WHY: Claude Code subagent transcripts are append-only NDJSON up to ~500KB.
 * To discover which project a subagent belongs to we only need a `cwd` from its
 * leading records — reading whole files across 696 subagents to find one field
 * would be absurd.
 *
 * WHY "prefix" and not "first line": fork subagents do not begin with a
 * conversation record. They begin with a `{"type":"fork-context-ref", ...}`
 * header that has NO `cwd`; the first record that has one is a line later. A
 * single-line head read therefore makes every fork subagent invisible. Callers
 * scan the lines themselves and stop when they have what they need.
 *
 * The final line may be cut mid-record; that is fine and expected — consumers
 * parse line-by-line and skip anything that does not parse.
 */
export async function readPrefixSafe(
  path: string,
  maxBytes: number = 16 * 1024,
): Promise<string | null> {
  return readTextSafe(path, maxBytes);
}