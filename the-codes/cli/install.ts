/** `agent-smith setup` and `uninstall`: wire the plugin into Claude Code's settings, and remove it again. */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ForgeService } from '../forge/service.ts';
import { isForgeJobId, isPidAlive, jobsDir } from '../forge/format.ts';
import { MIRROR_MARKER, mirrorDir } from '../forge/mirror.ts';
import { cancelPipeline, readPipeline } from '../forge/execute.ts';
import { checkCompatibility } from '../providers/compatibility.ts';
import { detectAvailable, providerNames } from '../providers/registry.ts';
import { EXIT, UsageError } from './common.ts';
import { readJobRecord } from './gc.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface SetupArgs {
  readonly scope?: string;
  readonly local?: boolean;
  readonly repo?: string;
  readonly marketplace?: string;
}

const CHECKOUT_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_MARKETPLACE = 'sgathrid/agent-smith';

function configureLocalClaudeSettings(targetRepo: string, marketplaceRoot = CHECKOUT_ROOT): string {
  const pluginManifest = path.join(marketplaceRoot, 'builds', 'local-plugin', 'agent-smith', '.claude-plugin', 'plugin.json');
  const marketplaceManifest = path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json');
  if (!existsSync(pluginManifest)) throw new Error(`Missing built plugin manifest at ${pluginManifest}. Run 'npm run build:plugin' first.`);
  if (!existsSync(marketplaceManifest)) throw new Error(`Missing marketplace manifest at ${marketplaceManifest}.`);
  const directory = path.join(targetRepo, '.claude');
  const settingsFile = path.join(directory, 'settings.local.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsFile)) {
    const parsed: unknown = JSON.parse(readFileSync(settingsFile, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Local Claude settings must be a JSON object.');
    }
    settings = { ...(parsed as Record<string, unknown>) };
  }
  const marketplaces = typeof settings['extraKnownMarketplaces'] === 'object' && settings['extraKnownMarketplaces'] !== null && !Array.isArray(settings['extraKnownMarketplaces'])
    ? { ...(settings['extraKnownMarketplaces'] as Record<string, unknown>) }
    : {};
  delete marketplaces['agent-smith-dev'];
  marketplaces['agent-smith'] = { source: { source: 'directory', path: marketplaceRoot } };
  settings['extraKnownMarketplaces'] = marketplaces;

  const enabled = typeof settings['enabledPlugins'] === 'object' && settings['enabledPlugins'] !== null && !Array.isArray(settings['enabledPlugins'])
    ? { ...(settings['enabledPlugins'] as Record<string, unknown>) }
    : {};
  delete enabled['agent-smith@agent-smith-dev'];
  enabled['agent-smith@agent-smith'] = true;
  settings['enabledPlugins'] = enabled;

  mkdirSync(directory, { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  return settingsFile;
}

export async function cmdSetup(args: SetupArgs = {}): Promise<number> {
  const scope = args.local === true ? 'local' : (args.scope ?? (args.repo !== undefined ? 'local' : 'user'));
  if (scope !== 'user' && scope !== 'project' && scope !== 'local') {
    throw new UsageError(`--scope must be user, project, or local; got '${scope}'`);
  }
  if (scope === 'local' && args.marketplace === undefined) {
    const targetRepo = path.resolve(args.repo ?? process.cwd());
    if (!existsSync(targetRepo)) throw new UsageError(`repository path does not exist: ${targetRepo}`);
    const settingsFile = configureLocalClaudeSettings(targetRepo);
    process.stdout.write(`Agent Smith enabled in ${settingsFile}\nRun claude from ${targetRepo}.\n\n`);
    return cmdDoctor();
  }
  // Never default to this checkout: a project-scope install would commit an
  // absolute local path that no teammate can resolve. Use --local for dev.
  const marketplace = args.marketplace ?? DEFAULT_MARKETPLACE;
  const claudeBin = process.env['AGENT_SMITH_CLAUDE_BIN'] || 'claude';
  const cwd = args.repo === undefined ? process.cwd() : path.resolve(args.repo);
  const result = spawnSync(claudeBin, ['plugin', 'install', 'agent-smith', '--marketplace', marketplace, '--scope', scope], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error !== undefined) {
    process.stderr.write(`agent-smith: failed to run '${claudeBin} plugin install': ${result.error.message}\n`);
    return EXIT.failed;
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) return EXIT.failed;
  process.stdout.write('\n');
  return cmdDoctor();
}

export interface UninstallArgs {
  readonly local?: boolean;
  readonly repo?: string;
  readonly keepJobs?: boolean;
  readonly homeDir?: string;
  /** How long to wait for cancelled workers to stop before giving up. */
  readonly settleMs?: number;
}

const UNINSTALL_SETTLE_MS = 15_000;

const MARKETPLACE_KEYS = ['agent-smith', 'agent-smith-dev'] as const;
const PLUGIN_IDS = ['agent-smith@agent-smith', 'agent-smith@agent-smith-dev', 'agent-smith@inline'] as const;
const MIRROR_SUFFIXES = ['.spec.json', '.progress.json', '.result.md.status.json', '.result.md', '.log', '.events.jsonl', '.spec.json.cancel'] as const;

function removeEmptyDirIfPossible(dir: string): void {
  try {
    if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
  } catch { /* non-empty or raced */ }
}

/** Remove Agent Smith entries from a Claude settings JSON file; delete the file if it becomes empty. */
function scrubClaudeSettingsFile(settingsFile: string): boolean {
  if (!existsSync(settingsFile)) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { return false; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  const settings = { ...(parsed as Record<string, unknown>) };
  let changed = false;

  for (const [sectionKey, targetKeys] of [
    ['extraKnownMarketplaces', MARKETPLACE_KEYS],
    ['enabledPlugins', PLUGIN_IDS],
    ['pluginConfigs', PLUGIN_IDS],
  ] as const) {
    const raw = settings[sectionKey];
    if (isRecord(raw)) {
      const copy = { ...raw };
      if (deleteKeys(copy, targetKeys)) changed = true;
      if (Object.keys(copy).length === 0) delete settings[sectionKey];
      else settings[sectionKey] = copy;
    }
  }
  if (!changed) return false;
  if (Object.keys(settings).length === 0) {
    try { unlinkSync(settingsFile); } catch { /* ignore */ }
    removeEmptyDirIfPossible(path.dirname(settingsFile));
  } else {
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return true;
}

/** Remove only Agent Smith's own mirrored files from `<repo>/.agy-staff/jobs/`, leaving genuine agy-staff jobs untouched. */
function scrubMirrorDir(repo: string): number {
  const dir = mirrorDir(repo);
  if (!existsSync(dir)) return 0;
  let removedJobs = 0;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const name of entries) {
    if (!name.endsWith('.spec.json')) continue;
    const jobId = name.slice(0, -'.spec.json'.length);
    let ours = isForgeJobId(jobId);
    if (!ours) {
      try {
        const spec = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>;
        ours = spec[MIRROR_MARKER] === true;
      } catch { /* unreadable spec: leave it alone */ }
    }
    if (!ours) continue;
    for (const suffix of MIRROR_SUFFIXES) {
      rmSync(path.join(dir, `${jobId}${suffix}`), { force: true });
    }
    removedJobs += 1;
  }
  removeEmptyDirIfPossible(dir);
  removeEmptyDirIfPossible(path.dirname(dir));
  return removedJobs;
}

/** Running jobs in `repo` whose owning process is still alive. */
function liveJobs(repo: string): string[] {
  const live: string[] = [];
  try {
    for (const entry of readdirSync(jobsDir(repo), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const job = readJobRecord(repo, entry.name);
      const owner = job?.['ownerPid'];
      if (job?.['status'] === 'running' && typeof owner === 'number' && isPidAlive(owner)) live.push(entry.name);
    }
  } catch { /* no jobs dir */ }
  return live;
}

/**
 * A cancel from this process is only a marker; the owning process must see it
 * and stop the worker. Removing state first would delete the marker unseen.
 */
async function settleLiveWork(repo: string, timeoutMs: number): Promise<{ jobs: string[]; pipelines: string[] }> {
  const deadline = Date.now() + timeoutMs;
  let jobs = liveJobs(repo);
  let pipelines = runningPipelines(repo);
  while ((jobs.length > 0 || pipelines.length > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    jobs = liveJobs(repo);
    pipelines = runningPipelines(repo);
  }
  return { jobs, pipelines };
}

/** Pipeline runs still marked running. Records carry no owner PID, so an orphan looks the same. */
function runningPipelines(repo: string): string[] {
  const running: string[] = [];
  try {
    for (const name of readdirSync(path.join(repo, '.agent-smith', 'pipelines'))) {
      if (!name.endsWith('.json')) continue;
      const runId = name.slice(0, -'.json'.length);
      try { if (readPipeline(repo, runId)?.status === 'running') running.push(runId); } catch { /* unreadable */ }
    }
  } catch { /* no pipelines dir */ }
  return running;
}

/** Request cancellation of any live pipelines or jobs in `repo`. */
function cancelLiveWorkInRepo(repo: string): void {
  for (const runId of runningPipelines(repo)) {
    try { cancelPipeline(repo, runId); } catch { /* ignore */ }
  }
  try {
    const service = new ForgeService({ repo });
    for (const entry of readdirSync(jobsDir(repo), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const job = readJobRecord(repo, entry.name);
      if (job?.['status'] === 'running') {
        try { service.cancel(entry.name); } catch { /* ignore */ }
      }
    }
  } catch { /* no jobs dir */ }
}

/** Remove Agent Smith entries and cached directories under `~/.claude/plugins`. */
function scrubClaudePluginsRoot(pluginsRoot: string): string[] {
  const removed: string[] = [];
  for (const rel of [
    path.join('cache', 'agent-smith'),
    path.join('cache', 'agent-smith-dev'),
    path.join('marketplaces', 'agent-smith'),
    path.join('marketplaces', 'agent-smith-dev'),
    path.join('data', 'agent-smith-agent-smith'),
    path.join('data', 'agent-smith-agent-smith-dev'),
    path.join('store', 'agent-smith'),
    path.join('store', 'agent-smith-agent-smith'),
  ]) {
    const target = path.join(pluginsRoot, rel);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    }
  }
  scrubJsonKeys(path.join(pluginsRoot, 'known_marketplaces.json'), (json) => deleteKeys(json, MARKETPLACE_KEYS));
  scrubJsonKeys(path.join(pluginsRoot, 'installed_plugins.json'), (json) => {
    const plugins = json['plugins'];
    const nested = isRecord(plugins) && deleteKeys(plugins, PLUGIN_IDS);
    return deleteKeys(json, PLUGIN_IDS) || nested;
  });
  return removed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Delete `keys` from `target` in place; true when any was present. */
function deleteKeys(target: Record<string, unknown>, keys: readonly string[]): boolean {
  let changed = false;
  for (const key of keys) {
    if (key in target) { delete target[key]; changed = true; }
  }
  return changed;
}

/** Rewrite a JSON object file when `mutate` reports a change; leave unreadable files alone. */
function scrubJsonKeys(file: string, mutate: (json: Record<string, unknown>) => boolean): void {
  if (!existsSync(file)) return;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isRecord(parsed) && mutate(parsed)) writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  } catch { /* leave unreadable file alone */ }
}

/**
 * Agent Smith's own state outside the repo. `~/.agent-smith` (or
 * `$AGENT_SMITH_HOME/.agent-smith`) is ours entirely. AGENT_SMITH_STATE_DIR may
 * point anywhere, so only the provider directories we write there are removed.
 */
function removeUserState(home: string): string[] {
  const removed: string[] = [];
  const userRoot = path.join(home, '.agent-smith');
  if (existsSync(userRoot)) {
    rmSync(userRoot, { recursive: true, force: true });
    removed.push(userRoot);
  }
  const stateDir = process.env['AGENT_SMITH_STATE_DIR'];
  if (stateDir) {
    const root = path.resolve(stateDir);
    for (const provider of providerNames()) {
      const dir = path.join(root, provider);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    }
    removeEmptyDirIfPossible(root);
  }
  return removed;
}

/**
 * Leave-zero-trace uninstaller: removes plugin/mod/hooks/MCP registrations,
 * immediate-purges Claude Code's 14-day plugin cache/data/marketplace clones,
 * and cleans `.agent-smith/` + mirrored `.agy-staff/jobs/` entries.
 */
export async function cmdUninstall(args: UninstallArgs = {}): Promise<number> {
  const targetRepo = path.resolve(args.repo ?? process.cwd());
  const localOnly = args.local === true;
  const home = args.homeDir ?? os.homedir();
  const actions: string[] = [];

  cancelLiveWorkInRepo(targetRepo);
  const stillLive = await settleLiveWork(targetRepo, args.settleMs ?? UNINSTALL_SETTLE_MS);
  if (stillLive.jobs.length > 0) {
    process.stderr.write(
      `agent-smith: still running after cancel: ${stillLive.jobs.join(', ')}.\n` +
      'Close their Claude session or wait, then run uninstall again. Nothing was removed.\n');
    return EXIT.failed;
  }
  // With no live worker left, a run still marked running is most likely an
  // orphan whose owner exited; it cannot be told apart from one between stages.
  if (stillLive.pipelines.length > 0) {
    process.stderr.write(`agent-smith: runs still marked running, treated as orphaned: ${stillLive.pipelines.join(', ')}.\n`);
  }

  if (!localOnly) {
    const claudeBin = process.env['AGENT_SMITH_CLAUDE_BIN'] || 'claude';
    for (const mkt of MARKETPLACE_KEYS) {
      spawnSync(claudeBin, ['plugin', 'uninstall', `agent-smith@${mkt}`], { cwd: targetRepo, encoding: 'utf8', env: process.env });
      spawnSync(claudeBin, ['plugin', 'marketplace', 'remove', mkt], { cwd: targetRepo, encoding: 'utf8', env: process.env });
    }
  }

  for (const settingsFile of [
    path.join(targetRepo, '.claude', 'settings.local.json'),
    path.join(targetRepo, '.claude', 'settings.json'),
    ...(localOnly ? [] : [path.join(home, '.claude', 'settings.json')]),
  ]) {
    if (scrubClaudeSettingsFile(settingsFile)) actions.push(`cleaned ${settingsFile}`);
  }

  if (!localOnly) {
    const pluginsRoot = process.env['CLAUDE_CODE_PLUGIN_CACHE_DIR'] || path.join(home, '.claude', 'plugins');
    for (const dir of scrubClaudePluginsRoot(pluginsRoot)) actions.push(`removed ${dir}`);
  }

  if (args.keepJobs !== true) {
    const repoState = path.join(targetRepo, '.agent-smith');
    if (existsSync(repoState)) {
      rmSync(repoState, { recursive: true, force: true });
      actions.push(`removed ${repoState}`);
    }
    const mirrored = scrubMirrorDir(targetRepo);
    if (mirrored > 0) actions.push(`removed ${mirrored} mirrored job(s) from ${mirrorDir(targetRepo)}`);

    if (!localOnly) {
      const agentHome = args.homeDir ?? process.env['AGENT_SMITH_HOME'] ?? home;
      for (const dir of removeUserState(agentHome)) actions.push(`removed ${dir}`);
    }
  }

  if (actions.length === 0) {
    process.stdout.write('Nothing to remove.\n');
  } else {
    for (const line of actions) process.stdout.write(`✓ ${line}\n`);
    process.stdout.write('Agent Smith removed.\n');
  }
  return EXIT.ok;
}

export async function cmdDoctor(): Promise<number> {
  process.stdout.write('agent-smith doctor\n\n');
  const rows = await detectAvailable();
  const compatibility = await Promise.all(rows.map(row => row.available
    ? checkCompatibility(row.name, row.binary) : Promise.resolve(null)));
  const width = Math.max(0, ...rows.map((row) => row.name.length));
  let any = false;
  for (const [index, row] of rows.entries()) {
    const diagnostic = compatibility[index];
    if (diagnostic?.state === 'compatible') any = true;
    process.stdout.write(` ${diagnostic?.state === 'compatible' ? '●' : '○'} ${row.name.padEnd(width)}  ${diagnostic?.state ?? 'not installed'}  (${row.binary})\n`);
    if (diagnostic) process.stdout.write(`   ${diagnostic.version ?? 'version unknown'} — ${diagnostic.reason}\n`);
  }
  process.stdout.write(`\nstate\n  repo  ${process.cwd()}\n  jobs  ${path.join(process.cwd(), '.agent-smith', 'jobs')}\n`);
  return any ? EXIT.ok : EXIT.failed;
}
