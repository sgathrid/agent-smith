// Optional user-defined model aliases. No built-in presets: everything comes from models.json.
// Files: <repo>/.agent-smith/models.json (project) and <home>/.agent-smith/models.json (user).
// A project alias replaces a user alias of the same name wholesale (no field merging).
import { readFileSync as nodeRead } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AliasProvider = 'agy' | 'codex' | 'opencode' | 'claude' | 'kimi';
export type AliasMode = 'implement' | 'review' | 'moderate' | 'verify';
export interface Alias { provider: AliasProvider; model?: string; effort?: string }
export type AliasScope = 'project' | 'user';
export interface ModelConfig {
  aliases: Record<string, Alias>;
  scopes: Record<string, AliasScope>;
  roleDefaults: Partial<Record<AliasMode, string>>;
  errors: string[];
}
export interface ModelRequest { provider?: string; model?: string; effort?: string; mode?: string }
export interface ResolvedRequest {
  provider?: string; model?: string; effort?: string;
  appliedAlias?: string;
  source: 'call' | 'alias' | 'roleDefault' | 'none';
  warnings: string[];
}
export interface ConfigFs { readFile(p: string): string | undefined }

const PROVIDERS = ['agy', 'codex', 'opencode', 'claude', 'kimi'];
const MODES = ['implement', 'review', 'moderate', 'verify'];
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

const defaultFs: ConfigFs = {
  readFile(p) {
    try { return nodeRead(p, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Parsed { aliases: Record<string, Alias>; roleDefaults: Record<string, string>; errors: string[] }

function parseFile(file: string, fs: ConfigFs): Parsed {
  const out: Parsed = { aliases: {}, roleDefaults: {}, errors: [] };
  let text: string | undefined;
  try { text = fs.readFile(file); } catch (e) { out.errors.push(`${file}: unreadable (${(e as Error).message})`); return out; }
  if (text === undefined) return out;
  let json: unknown;
  try { json = JSON.parse(text); } catch (e) { out.errors.push(`${file}: invalid JSON (${(e as Error).message})`); return out; }
  if (!isObj(json)) { out.errors.push(`${file}: expected a JSON object with "aliases" and/or "roleDefaults"`); return out; }
  if (json.aliases !== undefined) {
    if (!isObj(json.aliases)) out.errors.push(`${file}: "aliases" must be an object`);
    else for (const [name, raw] of Object.entries(json.aliases)) {
      if (!NAME_RE.test(name)) { out.errors.push(`${file}: alias name "${name}" must match ${NAME_RE}`); continue; }
      if (!isObj(raw) || typeof raw.provider !== 'string' || !PROVIDERS.includes(raw.provider)) {
        out.errors.push(`${file}: alias "${name}" needs provider one of ${PROVIDERS.join('|')}`); continue;
      }
      if ((raw.model !== undefined && typeof raw.model !== 'string') || (raw.effort !== undefined && typeof raw.effort !== 'string')) {
        out.errors.push(`${file}: alias "${name}" model/effort must be strings`); continue;
      }
      const a: Alias = { provider: raw.provider as AliasProvider };
      if (raw.model !== undefined) a.model = raw.model as string;
      if (raw.effort !== undefined) a.effort = raw.effort as string;
      out.aliases[name] = a;
    }
  }
  if (json.roleDefaults !== undefined) {
    if (!isObj(json.roleDefaults)) out.errors.push(`${file}: "roleDefaults" must be an object`);
    else for (const [mode, alias] of Object.entries(json.roleDefaults)) {
      if (!MODES.includes(mode)) { out.errors.push(`${file}: roleDefaults key "${mode}" must be one of ${MODES.join('|')}`); continue; }
      if (typeof alias !== 'string') { out.errors.push(`${file}: roleDefaults.${mode} must be an alias name`); continue; }
      out.roleDefaults[mode] = alias;
    }
  }
  return out;
}

export function loadModelConfig(opts: { repo: string; home?: string; fs?: ConfigFs }): ModelConfig {
  const fs = opts.fs ?? defaultFs;
  const home = opts.home ?? process.env.AGENT_SMITH_HOME ?? os.homedir();
  const user = parseFile(path.join(home, '.agent-smith', 'models.json'), fs);
  const project = parseFile(path.join(opts.repo, '.agent-smith', 'models.json'), fs);
  const cfg: ModelConfig = { aliases: {}, scopes: {}, roleDefaults: {}, errors: [...user.errors, ...project.errors] };
  for (const [n, a] of Object.entries(user.aliases)) { cfg.aliases[n] = a; cfg.scopes[n] = 'user'; }
  for (const [n, a] of Object.entries(project.aliases)) { cfg.aliases[n] = a; cfg.scopes[n] = 'project'; }
  // Project roleDefaults win per mode; a dangling project entry is dropped and the user one is not resurrected.
  const rd = { ...user.roleDefaults, ...project.roleDefaults };
  for (const [mode, alias] of Object.entries(rd)) {
    if (cfg.aliases[alias]) cfg.roleDefaults[mode as AliasMode] = alias;
    else cfg.errors.push(`roleDefaults.${mode} points at unknown alias "${alias}"; ignored`);
  }
  return cfg;
}

export function resolveRequest(req: ModelRequest, cfg: ModelConfig): ResolvedRequest {
  const warnings: string[] = [];
  const hasAlias = (n: string | undefined): n is string => !!n && Object.hasOwn(cfg.aliases, n);
  const expand = (name: string, source: 'alias' | 'roleDefault'): ResolvedRequest => {
    const a = cfg.aliases[name]!;
    if (req.provider && req.provider !== a.provider) {
      throw new Error(`Alias "${name}" belongs to provider "${a.provider}" but the call asked for provider "${req.provider}". ` +
        `Drop the provider argument (the alias supplies it), or pass a model id that is not an alias name.`);
    }
    const r: ResolvedRequest = { provider: a.provider, appliedAlias: name, source, warnings };
    const model = a.model; if (model !== undefined) r.model = model;
    const effort = req.effort ?? a.effort; if (effort !== undefined) r.effort = effort;
    return r;
  };
  if (hasAlias(req.model)) {
    if (req.model.includes('/') || /^(gpt|gemini|claude|o\d)/i.test(req.model)) {
      warnings.push(`Alias "${req.model}" looks like a real model id; the alias wins. Rename it in models.json to avoid ambiguity.`);
    }
    return expand(req.model, 'alias');
  }
  if (!req.provider && !req.model) {
    const def = req.mode ? cfg.roleDefaults[req.mode as AliasMode] : undefined;
    if (hasAlias(def)) return expand(def, 'roleDefault');
  }
  const r: ResolvedRequest = { source: req.provider || req.model || req.effort ? 'call' : 'none', warnings };
  if (req.provider !== undefined) r.provider = req.provider;
  if (req.model !== undefined) r.model = req.model;
  if (req.effort !== undefined) r.effort = req.effort;
  return r;
}

export function describeAliases(cfg: ModelConfig): {
  aliases: Array<{ name: string; provider: AliasProvider; model?: string; effort?: string; scope: AliasScope }>;
  roleDefaults: Partial<Record<AliasMode, string>>;
} {
  return {
    aliases: Object.entries(cfg.aliases).map(([name, a]) => ({ name, ...a, scope: cfg.scopes[name]! })),
    roleDefaults: { ...cfg.roleDefaults },
  };
}
