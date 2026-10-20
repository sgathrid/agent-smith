#!/usr/bin/env node
// Fails when the shipped plugin changed since <base> but its version did not
// rise, or when package.json and the plugin manifest disagree.
// Usage: node scripts/check-version.mjs origin/main
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BUILD = 'builds/local-plugin/agent-smith';
const MANIFEST = `${BUILD}/.claude-plugin/plugin.json`;
const base = process.argv[2] ?? 'origin/main';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const versionOf = (text) => JSON.parse(text).version;
const newer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
const fail = (message) => { console.log(`::error::${message}`); process.exit(1); };

const head = versionOf(readFileSync(MANIFEST, 'utf8'));
const pkg = versionOf(readFileSync('package.json', 'utf8'));
if (pkg !== head) fail(`package.json is ${pkg} but ${MANIFEST} is ${head}; bump both.`);

const changed = git('diff', '--name-only', `${base}...HEAD`, '--', BUILD).trim();
if (changed === '') { console.log(`${BUILD} unchanged since ${base}.`); process.exit(0); }

const was = versionOf(git('show', `${base}:${MANIFEST}`));
if (!newer(head, was)) fail(`${BUILD} changed but its version is still ${head} (was ${was}). Users only receive a higher version: bump package.json and the-codes/surfaces/mod/.claude-plugin/plugin.json.`);
console.log(`${BUILD} changed; version ${was} → ${head}.`);
