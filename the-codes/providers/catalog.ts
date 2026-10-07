/**
 * providers/catalog.ts — cached model discovery across providers.
 *
 * Lazy: nothing runs until getCatalogs() is called. Per-provider TTL cache,
 * stale-on-error, parallel fan-out, never rejects.
 */
import { errMessage } from './discovery.ts';
import { PROVIDERS, findProvider } from './registry.ts';
import type { ModelCatalog, Provider } from './types.ts';

export interface CatalogOptions {
  /** Per-provider discovery timeout. Default 10s. */
  timeoutMs?: number;
  /** Bypass the TTL cache. */
  refresh?: boolean;
  /** Restrict to these providers; default = all registered providers that are available. */
  providers?: readonly string[];
}

export const CATALOG_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;

interface CacheEntry {
  catalog: ModelCatalog;
  at: number;
}

const cache = new Map<string, CacheEntry>();
let clock: () => number = Date.now;
let providerSource: () => readonly Provider[] = () => PROVIDERS;

/** TEST ONLY: clear the cache and restore the real clock and provider list. */
export function resetCatalogCacheForTest(
  overrides: { now?: () => number; providers?: () => readonly Provider[] } = {},
): void {
  cache.clear();
  clock = overrides.now ?? Date.now;
  providerSource = overrides.providers ?? (() => PROVIDERS);
}

function lookup(name: string): Provider | undefined {
  return providerSource().find((p) => p.name === name) ?? (providerSource() === PROVIDERS ? findProvider(name) : undefined);
}

function failed(name: string, error: string): ModelCatalog {
  return { provider: name, models: [], defaultSource: 'unknown', source: 'live', stale: false, verified: false, error };
}

async function discover(provider: Provider, timeoutMs: number, refresh: boolean): Promise<ModelCatalog> {
  const name = provider.name;
  const hit = cache.get(name);
  if (!refresh && hit !== undefined && clock() - hit.at < CATALOG_TTL_MS) {
    return { ...hit.catalog, source: hit.catalog.source === 'static' ? 'static' : 'cache', stale: false };
  }
  let fresh: ModelCatalog;
  if (provider.listModels === undefined) {
    fresh = failed(name, 'provider does not support model discovery');
  } else {
    let timer: NodeJS.Timeout | undefined;
    try {
      // Guard: a misbehaving listModels must not hang the whole fan-out.
      const guard = new Promise<ModelCatalog>((resolve) => {
        timer = setTimeout(() => resolve(failed(name, `model discovery timed out after ${timeoutMs} ms`)), timeoutMs + 1_000);
        timer.unref?.();
      });
      fresh = await Promise.race([provider.listModels({ timeoutMs }), guard]);
    } catch (e) {
      fresh = failed(name, errMessage(e));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  const usable = fresh.error === undefined || fresh.models.length > 0;
  if (usable) {
    cache.set(name, { catalog: fresh, at: clock() });
    return fresh;
  }
  if (hit !== undefined) {
    return { ...hit.catalog, source: hit.catalog.source === 'static' ? 'static' : 'cache', stale: true, error: fresh.error! };
  }
  return fresh;
}

/** Names of installed providers. PATH probes only: cheap, no model discovery. */
export async function getInstalledProviders(): Promise<string[]> {
  const all = providerSource();
  const flags = await Promise.all(all.map(async (p) => { try { return await p.available(); } catch { return false; } }));
  return all.filter((_, i) => flags[i]).map((p) => p.name);
}

/** A provider's configured default model/effort from its own config file. Sync, no CLI. */
export function getHarnessDefaults(name: string): { model?: string; effort?: string } {
  try { return lookup(name)?.harnessDefaults?.() ?? {}; } catch { return {}; }
}

/** Catalogs for installed providers. Never throws; per-provider failures appear in `error`. */
export async function getCatalogs(options: CatalogOptions = {}): Promise<ModelCatalog[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const refresh = options.refresh === true;
  try {
    let targets: Provider[];
    const missing: ModelCatalog[] = [];
    if (options.providers !== undefined) {
      targets = [];
      for (const n of options.providers) {
        const p = lookup(n);
        if (p) targets.push(p);
        else missing.push(failed(n, `unknown provider '${n}'`));
      }
    } else {
      const all = providerSource();
      const flags = await Promise.all(
        all.map(async (p) => {
          try {
            return await p.available();
          } catch {
            return false;
          }
        }),
      );
      targets = all.filter((_, i) => flags[i]);
    }
    const results = await Promise.all(
      targets.map((p) => discover(p, timeoutMs, refresh).catch((e) => failed(p.name, errMessage(e)))),
    );
    return [...results, ...missing];
  } catch (e) {
    return [failed('*', errMessage(e))];
  }
}
