#!/usr/bin/env node
// Fails on anything that would make a skill misbehave once installed: bad frontmatter,
// oversize files, dangling cross-references, named tools or models, em dashes.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const fail = (file, msg) => problems.push(`${relative(root, file)}: ${msg}`);

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : path.endsWith('.md') ? [path] : [];
});
const files = [...walk(join(root, 'skills')), ...walk(join(root, 'shared')), join(root, 'stance.md')];

const slug = (heading) => heading.trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
const anchors = (path) => {
  let fenced = false;
  return new Set(readFileSync(path, 'utf8').split('\n').filter((l) => {
    if (/^\s*(`{3}|~{3})/.test(l)) fenced = !fenced;
    return !fenced && /^#{1,6} /.test(l);
  }).map((l) => slug(l.replace(/^#+ /, ''))));
};

const BANNED = ['cursor', 'renyi', 'pstack', 'p-stack', 'poteto', 'agent-smith', 'codex', 'opencode', 'claude', 'anthropic', 'openai',
  'opus', 'sonnet', 'haiku', 'gpt', 'grok', 'gemini', 'gitnexus', 'slack', 'notion', 'jira', 'datadog', 'sentry', 'databricks'];
const bannedRe = new RegExp(`\\b(${BANNED.join('|')})\\b`, 'i');
const EM_DASH = '\u{2014}';

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n').length;
  const isSkill = file.endsWith('SKILL.md');
  const limit = isSkill ? 150 : file.endsWith('stance.md') ? 20 : 200;
  if (lines > limit) fail(file, `${lines} lines, limit ${limit}`);
  if (text.includes(EM_DASH)) fail(file, 'contains an em dash');

  const scrubbed = text.replaceAll('${CLAUDE_PLUGIN_ROOT}', '').replace(/\bCLAUDE\.md\b/g, '');
  scrubbed.split('\n').forEach((line, i) => {
    const hit = line.match(bannedRe);
    if (hit) fail(file, `line ${i + 1} names "${hit[1]}"; describe the capability instead`);
  });

  for (const [, path, anchor] of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+?\.md)(?:#([\w-]+))?/g)) {
    const target = join(root, path);
    if (!existsSync(target)) { fail(file, `dangling reference ${path}`); continue; }
    if (anchor && !anchors(target).has(anchor)) fail(file, `no heading for #${anchor} in ${path}`);
  }

  if (isSkill) {
    const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
    const dir = relative(join(root, 'skills'), dirname(file));
    if (!fm) { fail(file, 'missing frontmatter'); continue; }
    if (!new RegExp(`^name: ${dir}$`, 'm').test(fm[1])) fail(file, `frontmatter name must be "${dir}"`);
    if (!/^description: \S/m.test(fm[1])) fail(file, 'missing description');
    if (!/^disable-model-invocation: true$/m.test(fm[1])) fail(file, 'must set disable-model-invocation: true');
  }
}

for (const dir of readdirSync(join(root, 'skills'))) {
  if (!existsSync(join(root, 'skills', dir, 'SKILL.md'))) fail(join(root, 'skills', dir), 'no SKILL.md');
}

if (problems.length) { console.log(problems.join('\n')); process.exit(1); }
console.log(`construct: ${files.length} files OK`);
