/**
 * cli/spec.ts — map a parsed YAML tree (see yaml.ts) onto a pipeline spec.
 *
 * yaml.ts parses only the subset of YAML that specs use and refuses the rest;
 * this module validates the tree's keys and values and fails loudly on
 * anything it does not know, rather than dropping a field.
 */

import { readFileSync } from 'node:fs';

import { inheritContinuedProviders, PipelineSpecError } from '../pipeline/pipeline.ts';
import { EFFORTS } from '../pipeline/types.ts';
import type { Effort, PipelineSpec, Stage, StageCheck, StageRole } from '../pipeline/types.ts';
import { parseYaml, SpecParseError } from './yaml.ts';
import type { Scalar } from './yaml.ts';

/* -------------------------------------------------------------------------- */
/* Spec mapping                                                                */
/* -------------------------------------------------------------------------- */

const KNOWN_STAGE_KEYS = new Set([
  'name',
  'agentName',
  'workerId',
  'conversation',
  'continues',
  'provider',
  'model',
  'effort',
  'dependsOn',
  'role',
  'prompt',
  'context',
  'title',
  'workDir',
  'resultPath',
  'consumes',
  'timeoutMs',
  'timeout',
  'routingPinned',
  'checks',
]);

const KNOWN_SPEC_KEYS = new Set(['name', 'stages', 'concurrency', 'workDir']);

/**
 * A stage `timeout` as a DURATION STRING, e.g. `45m`, `90s`, `1h30m`.
 *
 * Needed because the CLI's own flag is `--timeout 60m` (the brief's example), so
 * a spec author will reach for the same syntax. Returns ms, or throws — never 0,
 * because a 0 timeout means "no timeout" to the pipeline and silently removing a
 * wall-clock budget is the opposite of the intent.
 */
export function parseDuration(raw: string): number {
  const t = raw.trim();
  const re = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/;
  const m = re.exec(t);
  if (m === null || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) {
    throw new Error(`'${raw}' is not a duration. Use e.g. 45m, 90s, 1h30m.`);
  }
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3] ?? 0);
  const ms = (h * 3600 + min * 60 + s) * 1000;
  if (ms <= 0) throw new Error(`'${raw}' is not a positive duration`);
  return ms;
}

function asString(v: Scalar, key: string, no: number): string | undefined {
  if (v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  throw new SpecParseError(`'${key}' must be a string`, no);
}

function asStringArray(v: Scalar, key: string, no: number): string[] | undefined {
  if (v === null) return undefined;
  if (!Array.isArray(v)) throw new SpecParseError(`'${key}' must be a list`, no);
  return v.map((item) => {
    if (typeof item !== 'string') {
      throw new SpecParseError(`'${key}' must be a list of stage names`, no);
    }
    return item;
  });
}

function checksFromYaml(value: Scalar | undefined, stage: string, index: number): StageCheck[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new PipelineSpecError(`stage '${stage}': checks must be a list`);
  return value.map((entry, checkIndex) => {
    if (!(entry instanceof Map)) throw new PipelineSpecError(`stage '${stage}': checks[${checkIndex}] must be a mapping`);
    const allowed = new Set(['name', 'command', 'cwd', 'timeoutMs', 'blocking']);
    for (const key of entry.keys()) {
      if (!allowed.has(key)) throw new PipelineSpecError(`stage '${stage}': checks[${checkIndex}] has unknown key '${key}'`);
    }
    const name = asString(entry.get('name') ?? null, `checks[${checkIndex}].name`, index);
    const command = asString(entry.get('command') ?? null, `checks[${checkIndex}].command`, index);
    if (name === undefined || name.trim() === '' || command === undefined || command.trim() === '') {
      throw new PipelineSpecError(`stage '${stage}': checks[${checkIndex}] needs nonempty name and command`);
    }
    const cwd = asString(entry.get('cwd') ?? null, `checks[${checkIndex}].cwd`, index);
    const timeoutMs = entry.get('timeoutMs');
    if (timeoutMs !== undefined && timeoutMs !== null && (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
      throw new PipelineSpecError(`stage '${stage}': checks[${checkIndex}].timeoutMs must be a positive integer`);
    }
    const blocking = entry.get('blocking');
    if (blocking !== undefined && blocking !== null && typeof blocking !== 'boolean') {
      throw new PipelineSpecError(`stage '${stage}': checks[${checkIndex}].blocking must be true or false`);
    }
    return {
      name,
      command,
      ...(cwd === undefined ? {} : { cwd }),
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
      ...(typeof blocking === 'boolean' ? { blocking } : {}),
    };
  });
}

/**
 * Validate and map a stage. UNKNOWN KEYS THROW.
 *
 * This is the enforcement point for the claim the parser makes. A typo like
 * `dependOn:` (missing the 's') would otherwise produce a stage with no
 * dependencies — which RUNS CONCURRENTLY WITH THE STAGE THAT WAS SUPPOSED TO
 * PRODUCE ITS INPUT, and then reads a file that does not exist yet. That is a
 * silent, concurrent, wrong result, so it must not be a default.
 */
export function stageFrom(node: Scalar, index: number): Omit<Stage, 'provider'> & { provider?: string } {
  if (!(node instanceof Map)) {
    throw new PipelineSpecError(`stages[${index}] must be a mapping`);
  }
  for (const key of node.keys()) {
    if (!KNOWN_STAGE_KEYS.has(key)) {
      throw new PipelineSpecError(
        `stages[${index}] has unknown key '${key}'. Known keys: ` +
          `${[...KNOWN_STAGE_KEYS].sort().join(', ')}. ` +
          'A silently-ignored key here becomes a stage that runs with the wrong ' +
          'dependencies, which is worse than refusing to start.',
      );
    }
  }

  const name = asString(node.get('name') ?? null, 'name', index);
  if (name === undefined || name === '') {
    throw new PipelineSpecError(`stages[${index}] needs a name`);
  }
  const provider = asString(node.get('provider') ?? null, 'provider', index);
  const continues = asString(node.get('continues') ?? null, 'continues', index);
  // A continuing stage may omit provider; specFrom fills it in from its target.
  if ((provider === undefined || provider === '') && continues === undefined) {
    throw new PipelineSpecError(`stage '${name}' needs a provider`);
  }

  const stage: Record<string, unknown> = { name, ...(provider === undefined ? {} : { provider }) };

  for (const key of ['agentName', 'workerId', 'conversation', 'continues'] as const) {
    const value = asString(node.get(key) ?? null, key, index);
    if (value !== undefined) {
      if (value.trim() === '') throw new PipelineSpecError(`stage '${name}': ${key} must be nonempty`);
      stage[key] = value;
    }
  }

  const model = asString(node.get('model') ?? null, 'model', index);
  if (model !== undefined) stage['model'] = model;

  const effortRaw = asString(node.get('effort') ?? null, 'effort', index);
  if (effortRaw !== undefined) {
    if (!(EFFORTS as readonly string[]).includes(effortRaw)) {
      throw new PipelineSpecError(
        `stage '${name}': effort must be ${EFFORTS.join('|')}, got '${effortRaw}'.`,
      );
    }
    stage['effort'] = effortRaw as Effort;
  }

  const dependsOn = asStringArray(node.get('dependsOn') ?? null, 'dependsOn', index);
  if (dependsOn !== undefined) stage['dependsOn'] = dependsOn;

  const role = asString(node.get('role') ?? null, 'role', index);
  if (role !== undefined) stage['role'] = role as StageRole;

  const prompt = asString(node.get('prompt') ?? null, 'prompt', index);
  if (prompt !== undefined) stage['prompt'] = prompt;

  const context = asString(node.get('context') ?? null, 'context', index);
  if (context !== undefined) stage['context'] = context;

  const title = asString(node.get('title') ?? null, 'title', index);
  if (title !== undefined) stage['title'] = title;

  const workDir = asString(node.get('workDir') ?? null, 'workDir', index);
  if (workDir !== undefined) stage['workDir'] = workDir;

  const resultPath = asString(node.get('resultPath') ?? null, 'resultPath', index);
  if (resultPath !== undefined) stage['resultPath'] = resultPath;

  const timeoutMs = node.get('timeoutMs');
  if (timeoutMs !== null && timeoutMs !== undefined) {
    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new PipelineSpecError(`stage '${name}': timeoutMs must be a positive integer number of milliseconds`);
    }
    stage['timeoutMs'] = timeoutMs;
  }
  const timeout = asString(node.get('timeout') ?? null, 'timeout', index);
  if (timeout !== undefined) {
    if (timeoutMs !== null && timeoutMs !== undefined) {
      throw new PipelineSpecError(`stage '${name}': set only one of timeout and timeoutMs`);
    }
    try {
      stage['timeoutMs'] = parseDuration(timeout);
    } catch (err) {
      throw new PipelineSpecError(
        `stage '${name}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const pinned = node.get('routingPinned');
  if (pinned !== null && pinned !== undefined) {
    if (typeof pinned !== 'boolean') {
      throw new PipelineSpecError(`stage '${name}': routingPinned must be true or false`);
    }
    stage['routingPinned'] = pinned;
  }

  const checks = checksFromYaml(node.get('checks'), name, index);
  if (checks !== undefined) stage['checks'] = checks;

  const consumes = node.get('consumes');
  if (consumes !== null && consumes !== undefined) {
    if (!Array.isArray(consumes)) {
      throw new PipelineSpecError(`stage '${name}': consumes must be a list`);
    }
    stage['consumes'] = consumes.map((entry, i) => {
      if (!(entry instanceof Map)) {
        throw new PipelineSpecError(`stage '${name}': consumes[${i}] must be a mapping`);
      }
      const s = asString(entry.get('stage') ?? null, 'consumes[].stage', index);
      const p = asString(entry.get('path') ?? null, 'consumes[].path', index);
      if (s === undefined || p === undefined) {
        throw new PipelineSpecError(
          `stage '${name}': consumes[${i}] needs both 'stage' and 'path'`,
        );
      }
      const label = asString(entry.get('label') ?? null, 'consumes[].label', index);
      return { stage: s, path: p, ...(label === undefined ? {} : { label }) };
    });
  }

  return stage as unknown as Omit<Stage, 'provider'> & { provider?: string };
}

/**
 * Map a parsed tree onto a `PipelineSpec`.
 *
 * Separated from parsing so the error messages here talk about PIPELINE concepts
 * ("stage 'review' depends on 'implement'") rather than about YAML.
 */
export function specFrom(tree: Map<string, Scalar>): PipelineSpec {
  for (const key of tree.keys()) {
    if (!KNOWN_SPEC_KEYS.has(key)) {
      throw new PipelineSpecError(
        `unknown top-level key '${key}'. Known keys: ${[...KNOWN_SPEC_KEYS].sort().join(', ')}.`,
      );
    }
  }
  const name = asString(tree.get('name') ?? null, 'name', 0);
  if (name === undefined || name === '') {
    throw new PipelineSpecError("a pipeline spec needs a 'name'");
  }
  const stagesNode = tree.get('stages') ?? null;
  if (!Array.isArray(stagesNode)) {
    throw new PipelineSpecError("a pipeline spec needs a 'stages' list");
  }
  if (stagesNode.length === 0) {
    throw new PipelineSpecError('a pipeline spec needs at least one stage');
  }
  const stages = inheritContinuedProviders(stagesNode.map((node, i) => stageFrom(node, i)));

  const spec: Record<string, unknown> = { name, stages };
  const concurrency = tree.get('concurrency') ?? null;
  if (concurrency !== null) {
    if (typeof concurrency !== 'number' || !Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new PipelineSpecError('concurrency must be a positive integer');
    }
    spec['concurrency'] = concurrency;
  }
  const workDir = asString(tree.get('workDir') ?? null, 'workDir', 0);
  if (workDir !== undefined) spec['workDir'] = workDir;
  return spec as unknown as PipelineSpec;
}

/** Read and parse a spec file. */
export function loadSpec(path: string): PipelineSpec {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (err) {
    throw new PipelineSpecError(
      `cannot read '${path}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return specFrom(parseYaml(source));
}
