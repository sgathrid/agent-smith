// Enable the built plugin for this checkout only. Never writes user settings.
import { mkdir, readFile, access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(root, 'builds', 'local-plugin', 'agent-smith');
await access(path.join(plugin, '.claude-plugin', 'plugin.json'));
const directory = path.join(root, '.claude');
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
settings.extraKnownMarketplaces = {
  ...settings.extraKnownMarketplaces,
  'agent-smith-dev': { source: { source: 'directory', path: root } },
};
settings.enabledPlugins = { ...settings.enabledPlugins, 'agent-smith@agent-smith-dev': true };
await mkdir(directory, { recursive: true });
await writeFile(settingsFile, JSON.stringify(settings, null, 2) + '\n');
process.stdout.write(`Agent Smith enabled in ${settingsFile}\nStart Claude from ${root} with: claude\nClaude maintains its own plugin runtime state under ~/.claude/plugins.\n`);
