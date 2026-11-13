/**
 * Native subagent type specs derived from installed providers and user aliases.
 *
 * Pure and dependency-free: no `$` and no Node APIs. `the-codes/providers/aliases.ts`
 * cannot be imported here because it pulls in `node:fs`, `node:os`, and `node:path`
 * at module scope and lives outside `surfaces/mod/` (which `surfaces/mod/tsconfig.json`,
 * `scripts/build-plugin.mjs`, and Claude Code's mod loader — allowing only sibling
 * mod files — exclude); additionally `Alias.provider` there is a fixed union whereas
 * `agentTypes` is provider-agnostic and accepts `ModelConfig['aliases']` structurally.
 */

export const MAX_AGENT_TYPES = 24;
export const MAX_AGENT_NAME_LENGTH = 40;
export const HEADER_HINT = 'Prompt may start with header lines mode:, model:, effort:, cwd:.';
export const AGENT_DRIVER_PROMPT = 'Driven by agent-smith; no model runs here.';
export const DEFAULT_TOOL_PREFIX = 'mcp__plugin_agent-smith_agent-smith__';

export interface AgentTypeInput {
  providers: readonly { name: string; available: boolean; defaultModel?: string | null }[];
  aliases: Readonly<Record<string, { provider: string; model?: string; effort?: string }>>;
}

export interface AgentTypeSpec {
  name: string;
  description: string;
  defaults: { provider: string; model?: string; effort?: string };
}

export interface RegisteredAgentSpec {
  name: string;
  description: string;
  prompt: string;
  tools: string[];
  model: 'haiku';
  maxTurns: number;
}

/**
 * Sanitize a raw provider or alias name to `[a-z0-9-]` (at most 40 chars).
 * Returns `''` when no valid alphanumeric characters remain.
 */
export function sanitizeAgentName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_AGENT_NAME_LENGTH)
    .replace(/-+$/g, '');
}

function nonBlank(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function buildDefaults(
  provider: string,
  model?: string | null,
  effort?: string,
): { provider: string; model?: string; effort?: string } {
  const out: { provider: string; model?: string; effort?: string } = { provider };
  const cleanModel = nonBlank(model);
  if (cleanModel !== undefined) out.model = cleanModel;
  const cleanEffort = nonBlank(effort);
  if (cleanEffort !== undefined) out.effort = cleanEffort;
  return out;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function describeType(
  defaults: { provider: string; model?: string; effort?: string },
  isAlias: boolean,
): string {
  const parts = [singleLine(defaults.provider)];
  if (defaults.model !== undefined) parts.push(singleLine(defaults.model));
  if (defaults.effort !== undefined) parts.push(`effort ${singleLine(defaults.effort)}`);
  const suffix = isAlias ? ' (alias)' : '';
  return `External worker: ${parts.join(' · ')}${suffix}. ${HEADER_HINT}`;
}

/**
 * Build up to 24 native subagent type specs: aliases for available providers
 * first, then available providers in input order, deduplicated after sanitizing.
 */
export function agentTypes(input: AgentTypeInput): AgentTypeSpec[] {
  const availableProviders = new Set<string>();
  for (const p of input.providers) {
    if (p.available && p.name.trim().length > 0) availableProviders.add(p.name);
  }

  const out: AgentTypeSpec[] = [];
  const seen = new Set<string>();

  for (const [aliasName, alias] of Object.entries(input.aliases)) {
    if (out.length >= MAX_AGENT_TYPES) return out;
    if (!availableProviders.has(alias.provider)) continue;
    const name = sanitizeAgentName(aliasName);
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    const defaults = buildDefaults(alias.provider, alias.model, alias.effort);
    out.push({ name, description: describeType(defaults, true), defaults });
  }

  for (const p of input.providers) {
    if (out.length >= MAX_AGENT_TYPES) return out;
    if (!p.available || !availableProviders.has(p.name)) continue;
    const name = sanitizeAgentName(p.name);
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    const defaults = buildDefaults(p.name, p.defaultModel);
    out.push({ name, description: describeType(defaults, false), defaults });
  }

  return out;
}

/** Build the registration payload for `$.agent.register`. */
export function agentSpec(
  t: AgentTypeSpec,
  toolPrefix: string = DEFAULT_TOOL_PREFIX,
): RegisteredAgentSpec {
  return {
    name: t.name,
    description: t.description,
    prompt: AGENT_DRIVER_PROMPT,
    tools: [
      'SubagentHandback',
      `${toolPrefix}spawn_job`,
      `${toolPrefix}status`,
      `${toolPrefix}steer_job`,
      `${toolPrefix}resume_job`,
      `${toolPrefix}cancel`,
    ],
    model: 'haiku',
    maxTurns: 1000,
  };
}
