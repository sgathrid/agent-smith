#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PLUGINS = [
  { dir: 'builds/local-plugin/agent-smith', bump: 'bump package.json and the-codes/surfaces/mod/.claude-plugin/plugin.json' },
  { dir: 'construct', bump: 'raise the version in construct/.claude-plugin/plugin.json' },
];
const base = process.argv[2] ?? 'origin/main';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const gitQuiet = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const versionOf = (text) => JSON.parse(text).version;
const newer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
const fail = (message) => { console.log(`::error::${message}`); process.exit(1); };
const manifestOf = (dir) => `${dir}/.claude-plugin/plugin.json`;

const smith = versionOf(readFileSync(manifestOf(PLUGINS[0].dir), 'utf8'));
const pkg = versionOf(readFileSync('package.json', 'utf8'));
if (pkg !== smith) fail(`package.json is ${pkg} but ${manifestOf(PLUGINS[0].dir)} is ${smith}; bump both.`);

for (const { dir, bump } of PLUGINS) {
  const head = versionOf(readFileSync(manifestOf(dir), 'utf8'));
  const changed = git('diff', '--name-only', `${base}...HEAD`, '--', dir).trim();
  if (changed === '') { console.log(`${dir} unchanged since ${base}.`); continue; }
  let was;
  try { was = versionOf(gitQuiet('show', `${base}:${manifestOf(dir)}`)); } catch { console.log(`${dir} is new at ${head}.`); continue; }
  if (!newer(head, was)) fail(`${dir} changed but its version is still ${head} (was ${was}). Users only receive a higher version: ${bump}.`);
  console.log(`${dir} changed; version ${was} → ${head}.`);
}
