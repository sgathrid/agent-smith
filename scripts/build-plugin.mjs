#!/usr/bin/env node
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import nodeResolve from '@rollup/plugin-node-resolve';
import { rollup } from 'rollup';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

function required(file, label) {
  if (!existsSync(file)) throw new Error(`Missing ${label}: ${file}`);
}

function copyTree(source, destination, { excludeTests = false } = {}) {
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter(sourcePath) {
      if (!excludeTests) return true;
      const relative = path.relative(source, sourcePath);
      if (relative === '') return true;
      return !relative.split(path.sep).some((part) => part === '__tests__' || part === 'tests') &&
        !/\.(?:test|spec)\.[^.]+$/.test(path.basename(sourcePath));
    },
  });
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Bundle the channel entrypoints and MCP SDK into self-contained ESM files with no node_modules. */
async function bundleRuntime({ channelRoot, serverSource, monitorSource, watchHookSource, outDir }) {
  const bundle = await rollup({
    input: {
      server: serverSource,
      monitor: monitorSource,
      'watch-hook': watchHookSource,
    },
    plugins: [
      nodeResolve({ preferBuiltins: true, rootDir: channelRoot }),
      commonjs(),
      json(),
    ],
    onwarn(warning, warn) {
      if (warning.code === 'CIRCULAR_DEPENDENCY' || warning.code === 'INVALID_ANNOTATION') return;
      warn(warning);
    },
  });
  try {
    await bundle.write({
      dir: outDir,
      format: 'esm',
      compact: true,
      entryFileNames: '[name].js',
      chunkFileNames: 'chunk-[name].js',
    });
  } finally {
    await bundle.close();
  }
  for (const name of ['server.js', 'monitor.js', 'watch-hook.js']) {
    chmodSync(path.join(outDir, name), 0o755);
  }
}

/** Build the self-contained local Claude plugin into outputRoot/agent-smith. */
export async function buildPlugin({ repoRoot = DEFAULT_ROOT, outputRoot = path.join(repoRoot, 'builds', 'local-plugin'), modRoot = path.join(repoRoot, 'the-codes', 'surfaces', 'mod'), channelRoot = path.join(repoRoot, 'the-codes', 'surfaces', 'channel') } = {}) {
  const sourceManifest = path.join(modRoot, '.claude-plugin', 'plugin.json');
  const hooksSource = path.join(modRoot, 'hooks');
  const typesSource = path.join(modRoot, 'types');
  const skillsSource = path.join(modRoot, 'skills');
  const serverSource = path.join(channelRoot, 'dist', 'server.js');
  const monitorSource = path.join(channelRoot, 'dist', 'monitor.js');
  const watchHookSource = path.join(channelRoot, 'dist', 'watch-hook.js');
  const modulesSource = path.join(channelRoot, 'node_modules');
  const channelPackagePath = path.join(channelRoot, 'package.json');

  // Validate every required input before creating or replacing the output.
  required(sourceManifest, 'plugin manifest');
  required(hooksSource, 'plugin hooks');
  required(typesSource, 'plugin types');
  required(serverSource, 'built MCP server');
  required(monitorSource, 'built monitor entrypoint');
  required(watchHookSource, 'built watch hook entrypoint (run the channel build; src/watch-hook.ts must exist)');
  required(modulesSource, 'channel runtime node_modules');
  required(channelPackagePath, 'channel package metadata');

  const manifest = JSON.parse(readFileSync(sourceManifest, 'utf8'));
  const runtimePackage = JSON.parse(readFileSync(channelPackagePath, 'utf8'));
  if (typeof runtimePackage.dependencies?.['@modelcontextprotocol/server'] !== 'string') {
    throw new Error(`Channel package is missing @modelcontextprotocol/server: ${channelPackagePath}`);
  }

  mkdirSync(outputRoot, { recursive: true });
  const target = path.join(outputRoot, 'agent-smith');
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const staging = path.join(outputRoot, `.agent-smith-stage-${nonce}`);
  const backup = path.join(outputRoot, `.agent-smith-backup-${nonce}`);

  try {
    mkdirSync(staging, { recursive: true });
    copyTree(path.dirname(sourceManifest), path.join(staging, '.claude-plugin'), { excludeTests: true });
    // Keep the canonical plugin manifest, while dropping source-only type build files.
    for (const name of ['types', 'tsconfig.json']) {
      rmSync(path.join(staging, '.claude-plugin', name), { recursive: true, force: true });
    }
    copyTree(hooksSource, path.join(staging, 'hooks'), { excludeTests: true });
    copyTree(typesSource, path.join(staging, 'types'), { excludeTests: true });
    if (existsSync(skillsSource)) copyTree(skillsSource, path.join(staging, 'skills'), { excludeTests: true });

    const runtime = path.join(staging, 'runtime');
    const runtimeDist = path.join(runtime, 'dist');
    mkdirSync(runtimeDist, { recursive: true });
    await bundleRuntime({ channelRoot, serverSource, monitorSource, watchHookSource, outDir: runtimeDist });
    writeJson(path.join(runtime, 'package.json'), {
      name: 'agent-smith-runtime',
      private: true,
      type: 'module',
    });

    const toolPrefix = 'mcp__plugin_agent-smith_agent-smith__';
    writeJson(path.join(staging, 'hooks', 'watch-hooks.json'), {
      hooks: {
        PostToolUse: [{
          matcher: ['spawn_job', 'run_pipeline', 'resume_job'].map((n) => `${toolPrefix}${n}`).join('|'),
          hooks: [{
            type: 'command',
            command: 'node "${CLAUDE_PLUGIN_ROOT}/runtime/dist/watch-hook.js"',
            asyncRewake: true,
            timeout: 21_900,
          }],
        }],
      },
    });

    const pluginManifest = {
      ...manifest,
      mcpServers: {
        ...(manifest.mcpServers ?? {}),
        'agent-smith': {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/runtime/dist/server.js'],
          env: { AGENT_SMITH_CHANNEL: '0' },
        },
      },
      // The always-on monitor is gone: a running monitor shows in Claude's exit
      // dialog and polls forever. A job-scoped asyncRewake hook replaces it.
      hooks: './hooks/watch-hooks.json',
    };
    writeJson(path.join(staging, '.claude-plugin', 'plugin.json'), pluginManifest);

    // Ensure the staging output is complete before replacing the last good build.
    required(path.join(staging, 'runtime', 'dist', 'server.js'), 'staged MCP server');
    required(path.join(staging, 'runtime', 'dist', 'monitor.js'), 'staged monitor entrypoint');
    required(path.join(staging, 'runtime', 'dist', 'watch-hook.js'), 'staged watch hook entrypoint');
    required(path.join(staging, 'hooks', 'watch-hooks.json'), 'staged watch hooks');

    if (existsSync(target)) renameSync(target, backup);
    try {
      renameSync(staging, target);
    } catch (error) {
      if (existsSync(backup)) renameSync(backup, target);
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
    return target;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const target = await buildPlugin();
    process.stdout.write(`Built local Claude plugin: ${target}${os.EOL}`);
  } catch (error) {
    process.stderr.write(`build:plugin failed: ${error instanceof Error ? error.message : String(error)}${os.EOL}`);
    process.exitCode = 1;
  }
}
