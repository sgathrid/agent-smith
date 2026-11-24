// Installs the construct skills for Codex and OpenCode (Claude Code users: use the plugin marketplace).
// Usage: node install.mjs [--codex] [--opencode] [--dir <path>] [--dry-run] [--uninstall]
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, rmdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const dirIdx = args.indexOf("--dir");
const dirArg = dirIdx >= 0 ? args[dirIdx + 1] : null;
if (dirIdx >= 0 && (!dirArg || dirArg.startsWith("--"))) fail("--dir needs a path");
const dry = has("--dry-run");
const MANIFEST = ".construct-manifest.json";
const TOKEN = "${CLAUDE_PLUGIN_ROOT}";

const targets = [];
if (has("--codex")) targets.push({ name: "codex", skills: join(homedir(), ".agents", "skills"), home: join(homedir(), ".agents", "construct"), policy: "codex" });
if (has("--opencode")) targets.push({ name: "opencode", skills: join(homedir(), ".config", "opencode", "skills"), home: join(homedir(), ".config", "opencode", "construct"), policy: "opencode" });
if (dirArg) {
  const base = resolve(dirArg);
  if (targets.length) for (const t of targets) { t.skills = join(base, t.name, "skills"); t.home = join(base, t.name, "construct"); }
  else targets.push({ name: "custom", skills: join(base, "skills"), home: join(base, "construct"), policy: "frontmatter" });
}
if (!targets.length) {
  console.log("Claude Code: install through the plugin marketplace instead of this script.");
  console.log("Other tools: node install.mjs [--codex] [--opencode] [--dir <path>] [--dry-run] [--uninstall]");
  process.exit(0);
}

function fail(msg) { console.error(msg); process.exit(1); }

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function plan(t) {
  const files = [];
  const add = (from, to) => files.push({ from, to });
  for (const f of walk(join(src, "skills"))) add(f, join(t.skills, relative(join(src, "skills"), f)));
  for (const f of walk(join(src, "shared"))) add(f, join(t.home, "shared", relative(join(src, "shared"), f)));
  add(join(src, "stance.md"), join(t.home, "stance.md"));
  return files;
}

function rewrite(text, t) {
  return text.replaceAll(TOKEN + "/skills/", t.skills + "/").replaceAll(TOKEN + "/", t.home + "/").replaceAll(TOKEN, t.home);
}

const inside = (f, t) => [t.skills, t.home].some((root) => !relative(root, f).startsWith("..") && relative(root, f) !== "");

function owned(t) {
  const mpath = join(t.home, MANIFEST);
  if (!existsSync(mpath)) return [];
  try { return JSON.parse(readFileSync(mpath, "utf8")).files.filter((f) => inside(f, t)); }
  catch { fail(`${mpath} is unreadable. Delete it and the files construct installed next to it, then rerun.`); }
}

function remove(t) {
  const mpath = join(t.home, MANIFEST);
  if (!existsSync(mpath)) return [];
  const files = owned(t);
  for (const f of files) if (!dry) rmSync(f, { force: true });
  if (!dry) {
    rmSync(mpath, { force: true });
    for (const f of files) prune(dirname(f), [t.skills, t.home]);
  }
  return files;
}

function prune(dir, stop) {
  while (!stop.includes(dir) && existsSync(dir) && readdirSync(dir).length === 0) { rmdirSync(dir); dir = dirname(dir); }
}

function put(path, content) {
  if (dry) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function install(t) {
  const written = [];
  for (const { from, to } of plan(t)) {
    const text = readFileSync(from, "utf8");
    put(to, from.endsWith(".md") ? rewrite(text, t) : text);
    written.push(to);
  }
  if (t.policy === "codex") {
    for (const name of readdirSync(join(src, "skills"))) {
      const p = join(t.skills, name, "agents", "openai.yaml");
      put(p, "policy:\n  allow_implicit_invocation: false\n");
      written.push(p);
    }
    console.log("  codex: agents/openai.yaml sets allow_implicit_invocation: false; invoke with $name or /skills.");
  } else if (t.policy === "opencode") {
    console.log("  opencode: disable-model-invocation: true in each SKILL.md hides it from the model; invoke with @name.");
  } else {
    console.log("  custom: disable-model-invocation: true in each SKILL.md; this tool may need its own setting to stay user-invoked.");
  }
  put(join(t.home, MANIFEST), JSON.stringify({ files: written }, null, 2) + "\n");
  return written;
}

for (const t of targets) {
  const tag = dry ? " (dry run)" : "";
  if (has("--uninstall")) {
    if (!existsSync(join(t.home, MANIFEST))) { console.log(`${t.name}: no construct install at ${t.home}; pass the same flags you installed with`); continue; }
    const gone = remove(t);
    console.log(`${t.name}: removed ${gone.length} files${tag}`);
    continue;
  }
  console.log(`${t.name}:${tag}`);
  const mine = new Set(owned(t));
  const clashes = plan(t).map(({ to }) => to).filter((to) => existsSync(to) && !mine.has(to));
  if (clashes.length) fail(`  refusing to overwrite files construct did not install:\n  ${clashes.join("\n  ")}\n  Move them aside, or install somewhere else with --dir.`);
  remove(t);
  const files = install(t);
  console.log(`  ${files.length} files written`);
  console.log(`  skills: ${t.skills}`);
  console.log(`  shared pages and stance.md: ${t.home}`);
}
