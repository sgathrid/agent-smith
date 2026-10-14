// Enable the built plugin for one project only (default: this checkout, or --repo DIR).
// Never writes user settings.
import { mkdir, readFile, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(root, 'builds', 'local-plugin', 'agent-smith');
await access(path.join(plugin, '.claude-plugin', 'plugin.json'));
const repoFlag = process.argv.indexOf('--repo');
const target = repoFlag === -1 ? root : path.resolve(process.argv[repoFlag + 1] ?? '');
if (repoFlag !== -1) await access(target);
const directory = path.join(target, '.claude');
const settingsFile = path.join(directory, 'settings.local.json');
let settings = {};
try {
  settings = JSON.parse(await readFile(settingsFile, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
  throw new Error('Local Claude settings must be a JSON object.');
}
// Local settings cannot set CLAUDE_CODE_PLUGIN_DIRS. A directory marketplace
// with a relative plugin source loads the built files in place instead.
await access(path.join(root, '.claude-plugin', 'marketplace.json'));
const extraKnownMarketplaces = { ...settings.extraKnownMarketplaces };
delete extraKnownMarketplaces['agent-smith-dev'];
extraKnownMarketplaces['agent-smith'] = { source: { source: 'directory', path: root } };
settings.extraKnownMarketplaces = extraKnownMarketplaces;

const enabledPlugins = { ...settings.enabledPlugins };
delete enabledPlugins['agent-smith@agent-smith-dev'];
enabledPlugins['agent-smith@agent-smith'] = true;
settings.enabledPlugins = enabledPlugins;
await mkdir(directory, { recursive: true });
await writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n');
process.stdout.write(`Agent Smith enabled in ${settingsFile}\nStart Claude from ${target} with: claude\nClaude maintains its own plugin runtime state under ~/.claude/plugins.\n`);
