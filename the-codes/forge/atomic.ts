/**
 * atomic.ts — the write primitives the state format depends on.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ===========================
 *
 * `job.json` is the anchor: the one file a reader MUST be able to read, and the
 * file that carries both the terminal verdict and the liveness clock. If it can
 * be observed half-written, then for one poll window every reader sees a
 * malformed manifest, the job reads as `unknown`, and the channel's Gate 3 (a
 * terminal claim needs a terminal timestamp) suppresses the one notification
 * that mattered. We have already paid for this class of bug once — see
 * harness/agy-staff.ts, where every read has to tolerate a half-written JSON
 * body because somebody else writes those files.
 *
 * We write this file, so we do not have to tolerate that.
 *
 * The primitive is the standard one: write a sibling temp file, then rename.
 * `rename(2)` is atomic within a filesystem, so a reader sees either the whole
 * previous file or the whole new one and never a splice of the two.
 *
 * appendFileSync is used for the append-only logs and needs no atomicity: a
 * partially-written LAST LINE is fine for NDJSON, because readers already skip
 * lines that do not parse (see the mod's `toolHistoryFromEvents`, which skips
 * them explicitly). Rewriting them atomically would cost a full copy per event.
 */

import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Monotonic counter so two atomic writes in the same millisecond cannot collide. */
let tempCounter = 0;

/** Write a file so a reader never observes a partial body. Creates parent dirs. */
export function writeAtomic(filePath: string, body: string): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  tempCounter += 1;
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${tempCounter}`);
  try {
    // 'wx' would be stricter but races with nothing here and adds a failure mode
    // (a stale temp from a killed process) that costs more than it prevents.
    writeFileSync(tmp, body);
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the rename may have already consumed it */
    }
    throw err;
  }
}

/** writeAtomic + a JSON body. Pretty-printed, because these files get read by humans. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Append one line to an NDJSON log. Creates the file and its parents. */
export function appendLine(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

/**
 * Create a marker file, writing `body` into it.
 *
 * Return value is whether WE created it. That matters: cancel is idempotent, and
 * the FIRST request is the one whose instant is the cancellation instant.
 */
export function createMarker(filePath: string, body: string): boolean {
  mkdirSync(path.dirname(filePath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(filePath, 'wx');
  } catch {
    return false; // already there
  }
  try {
    writeFileSync(fd, body);
    // Best-effort durability. A cancel marker lost to a machine crash costs one
    // un-cancelled job; an fsync on every cancel would cost the user a stall on
    // a path that runs while they are watching.
    try {
      fsyncSync(fd);
    } catch {
      /* not all filesystems support it; the rename below is the real barrier */
    }
  } finally {
    closeSync(fd);
  }
  return true;
}