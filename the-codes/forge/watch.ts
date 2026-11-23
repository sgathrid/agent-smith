/**
 * forge/watch.ts — wake when a job's files change, instead of re-reading them on a timer.
 *
 * A worker runs in another process (the detached supervisor) and reports only through
 * its job directory. The OS tells us when that directory changes (FSEvents on macOS,
 * inotify on Linux) through fs.watch, so a caller waiting on a job wakes the moment the
 * writer renames a new job.json, progress.json, or acceptance.json into place.
 *
 * The timer is a fallback only: when the directory cannot be watched (it does not exist
 * yet, or the filesystem has no change events) the wait sleeps `fallbackMs` instead.
 */
import { watch } from 'node:fs';

export type WatchOutcome = 'change' | 'timeout' | 'aborted' | 'polled';

/**
 * Resolves on the first change in `dir`, after `timeoutMs`, or when `signal` aborts,
 * whichever is first. `'polled'` means the directory could not be watched and the
 * fallback sleep ran instead.
 */
export function waitForChange(
  dir: string,
  timeoutMs: number,
  opts: { signal?: AbortSignal; fallbackMs?: number } = {},
): Promise<WatchOutcome> {
  if (opts.signal?.aborted) return Promise.resolve('aborted');
  if (timeoutMs <= 0) return Promise.resolve('timeout');

  return new Promise((resolve) => {
    let done = false;
    let watcher: ReturnType<typeof watch> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fallbackMs = Math.min(opts.fallbackMs ?? 500, timeoutMs);

    const closeWatcher = () => {
      if (watcher === null) return;
      const w = watcher;
      watcher = null;
      try { w.close(); } catch { /* already closed */ }
    };

    const finish = (why: WatchOutcome) => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      closeWatcher();
      resolve(why);
    };

    const fallBack = () => {
      if (done) return;
      closeWatcher();
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => finish('polled'), fallbackMs);
    };

    const onAbort = () => finish('aborted');
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      watcher = watch(dir, { persistent: false }, () => finish('change'));
      watcher.on('error', fallBack);
      timer = setTimeout(() => finish('timeout'), timeoutMs);
    } catch {
      fallBack();
    }
  });
}
