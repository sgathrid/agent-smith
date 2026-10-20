#!/usr/bin/env node
// Raises the plugin version everywhere it is stated, then rebuilds the plugin.
// Usage: npm run bump -- patch|minor|major|<x.y.z>   (default: patch)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const MANIFEST = 'the-codes/surfaces/mod/.claude-plugin/plugin.json';
const arg = process.argv[2] ?? 'patch';

const current = JSON.parse(readFileSync('package.json', 'utf8')).version;
const [major, minor, patch] = current.split('.').map(Number);
const next = arg === 'major' ? `${major + 1}.0.0`
  : arg === 'minor' ? `${major}.${minor + 1}.0`
  : arg === 'patch' ? `${major}.${minor}.${patch + 1}`
  : arg;
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`bump: expected patch, minor, major or x.y.z, got "${arg}".`);
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
// package.json and package-lock.json together.
run('npm', ['version', next, '--no-git-tag-version', '--allow-same-version']);
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
manifest.version = next;
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
run('npm', ['run', 'build:plugin']);
console.log(`agent-smith ${current} → ${next}. Commit package.json, package-lock.json, ${MANIFEST} and builds/.`);
