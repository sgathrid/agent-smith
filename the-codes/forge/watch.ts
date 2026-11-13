/**
 * forge/watch.ts — wake when a job's files change, instead of re-reading them on a timer.
 *
 * A worker runs in another process (the detached supervisor) and reports only through
 * its job directory. The OS tells us when that directory changes (FSEvents on macOS,
 * inotify on Linux) through fs.watch, so a caller waiting on a job wakes the moment the
 * writer renames a new job.json or progress.json into place.
 *
 * The timer is a fallback only: when the directory cannot be watched (it does not exist
 * yet, or the filesystem has no change events) the wait sleeps `fallbackMs` instead.
 */
import { watch } from 'node:fs';

/**
 * Resolves on the first change in `dir`, after `timeoutMs`, or when `signal` aborts,
 * whichever is first. `'change'`, `'timeout'` or `'aborted'` says which; `'polled'`
 * means the directory could not be watched and the fallback sleep ran instead.
 */
export function waitForChange(dir: string, timeoutMs: number, opts: { signal?: AbortSignal; fallbackMs?: number } = {}): Promise<'change' | 'timeout' | 'aborted' | 'polled'> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) { resolve('aborted'); return; }
    let done = false;
    let watcher: ReturnType<typeof watch> | null = null;
    const finish = (why: 'change' | 'timeout' | 'aborted' | 'polled') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      try { watcher?.close(); } catch { /* already closed */ }
      resolve(why);
    };
    const onAbort = () => finish('aborted');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout>;
    try {
      watcher = watch(dir, { persistent: false }, () => finish('change'));
      watcher.on('error', () => { timer = setTimeout(() => finish('polled'), Math.min(opts.fallbackMs ?? 500, Math.max(0, timeoutMs))); });
      timer = setTimeout(() => finish('timeout'), Math.max(0, timeoutMs));
    } catch {
      // No watchable directory: fall back to one short sleep.
      timer = setTimeout(() => finish('polled'), Math.min(opts.fallbackMs ?? 500, Math.max(0, timeoutMs)));
    }
  });
}
