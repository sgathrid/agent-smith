/**
 * __tests__/spec.test.ts — the YAML subset parser and the spec mapping.
 *
 * THE PROPERTY UNDER TEST THROUGHOUT: THIS PARSER REFUSES RATHER THAN GUESSES.
 *
 * A spec that silently loses a field is the worst failure available here. If
 * `dependOn:` (one missing 's') parsed as "no dependencies", the stage would run
 * CONCURRENTLY with the stage that was supposed to produce its input and then
 * read a file that does not exist yet — silently, concurrently, wrong. So every
 * unsupported construct throws with its line number, and every unknown key
 * throws with the list of valid ones.
 *
 * The last two tests in this file are the reason the file exists: they parse the
 * REAL pipeline.example.yaml, so the example cannot rot without a test failing.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PipelineSpecError } from '../../pipeline/pipeline.ts';
import { validateSpec } from '../../pipeline/pipeline.ts';

import {
  loadSpec,
  parseDuration,
  parseScalar,
  parseYaml,
  specFrom,
  SpecParseError,
} from '../spec.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE = path.resolve(HERE, '../pipeline.example.yaml');

function tree(yaml: string): ReturnType<typeof parseYaml> {
  return parseYaml(yaml);
}

/* -------------------------------------------------------------------------- */
/* Scalars                                                                     */
/* -------------------------------------------------------------------------- */

test('numbers become numbers, so a timeout is comparable', () => {
  // If 600000 stayed the string "600000" every later arithmetic comparison
  // against a real number would be wrong in a way that only shows up at runtime.
  const t = tree('timeoutMs: 600000\nratio: 1.5');
  assert.equal(t.get('timeoutMs'), 600000);
  assert.equal(t.get('ratio'), 1.5);
});

test('booleans become booleans, so false is not truthy', () => {
  const t = tree('background: false\npinned: true');
  assert.equal(t.get('background'), false);
  assert.equal(t.get('pinned'), true);
});

test('a # preceded by whitespace IS a comment, as in real YAML', () => {
  // Matched against the YAML spec rather than against intuition: in a plain
  // scalar, a `#` preceded by whitespace starts a comment. So `a #3` truncates
  // to `a` and keeping the fragment requires QUOTES. The test exists because
  // this is the surprising half — `#` inside a word (see the next test) is
  // content, and both behaviours have to be right for prompts to survive.
  const t = tree('prompt: fix the bug #3 in CI');
  assert.equal(t.get('prompt'), 'fix the bug');
  assert.equal(tree('prompt: "fix the bug #3 in CI"').get('prompt'), 'fix the bug #3 in CI');
});

test('a # inside a word is content, not a comment', () => {
  // `C#` and `issue#42` must survive verbatim.
  assert.equal(parseScalar('the C# compiler', 1), 'the C# compiler');
  assert.equal(parseScalar('see issue#42', 1), 'see issue#42');
});

test('a comment after whitespace IS stripped', () => {
  const t = tree('model: sonnet  # the alias, not a pin');
  assert.equal(t.get('model'), 'sonnet');
});

test('quoted scalars keep their quotes, colons and hashes', () => {
  assert.equal(parseScalar('"a: b # c"', 1), 'a: b # c');
  assert.equal(parseScalar("'it''s'", 1), "it's");
  assert.equal(parseScalar('"line\\nbreak"', 1), 'line\nbreak');
});

test('a colon inside a scalar is not a key separator', () => {
  // Model ids and URLs contain colons. `https://x` must not become a key.
  const t = tree('endpoint: https://example.com:8080/x');
  assert.equal(t.get('endpoint'), 'https://example.com:8080/x');
});

test('flow sequences parse, for dependsOn', () => {
  assert.deepEqual(parseScalar('[a, b, c]', 1), ['a', 'b', 'c']);
  assert.deepEqual(parseScalar('[]', 1), []);
});

test('an unparseable construct throws with its line number', () => {
  // Anchors are the classic silent-corruption path: `&base` would parse as a
  // model name string and be used as one.
  for (const bad of ['x: &anchor', 'x: *alias', 'x: !!str 5', 'x: {a: b}', 'x: <<merge']) {
    assert.throws(
      () => tree(bad),
      (err: unknown) => err instanceof SpecParseError && typeof err.line === 'number',
      `expected '${bad}' to be rejected`,
    );
  }
});

test('a multi-document file is rejected, not half-read', () => {
  assert.throws(() => tree('name: a\n---\nname: b'), SpecParseError);
});

/* -------------------------------------------------------------------------- */
/* Structure                                                                   */
/* -------------------------------------------------------------------------- */

test('nested mappings and lists of mappings parse', () => {
  const t = tree(`
name: demo
stages:
  - name: implement
    provider: agy
    prompt: do it
  - name: review
    provider: codex
    dependsOn: [implement]
`);
  const stages = t.get('stages');
  assert.ok(Array.isArray(stages));
  assert.equal(stages.length, 2);
  assert.equal((stages[0] as unknown as Map<string, unknown>).get('name'), 'implement');
  assert.equal((stages[1] as unknown as Map<string, unknown>).get('provider'), 'codex');
});

test('a literal block scalar keeps newlines', () => {
  const t = tree(`
prompt: |
  line one
  line two
after: yes
`);
  assert.equal(t.get('prompt'), 'line one\nline two\n');
  // The block ends at the dedent; `after` must be a sibling, not part of it.
  assert.equal(t.get('after'), 'yes');
});

test('a block scalar keeps a # that lexing would have eaten', () => {
  // The one case where lex() must NOT be the source: a prompt containing '#' on
  // its own line. This is why readLiteralBlock indexes the ORIGINAL source.
  const t = tree(`
prompt: |
  step one
  # a heading inside the prompt
  step two
`);
  assert.match(String(t.get('prompt')), /# a heading inside the prompt/);
});

test('`|-` strips the trailing newline so blocks can be concatenated', () => {
  const t = tree(`
prompt: |-
  only line
`);
  assert.equal(t.get('prompt'), 'only line');
});

test('`>` folds a block into one paragraph', () => {
  const t = tree(`
prompt: >
  a long single
  paragraph prompt
`);
  // Folded, so the source line break became a space. The one trailing newline is
  // YAML's clip chomping, not a paragraph break.
  assert.equal(t.get('prompt'), 'a long single paragraph prompt\n');
});

test('a blank line inside a `>` block is a paragraph break, not a space', () => {
  const t = tree(`
prompt: >
  first paragraph line

  second paragraph line
`);
  assert.equal(t.get('prompt'), 'first paragraph line\nsecond paragraph line\n');
});

/* -------------------------------------------------------------------------- */
/* Durations                                                                   */
/* -------------------------------------------------------------------------- */

test('durations parse, and a zero duration is refused', () => {
  assert.equal(parseDuration('45m'), 45 * 60 * 1000);
  assert.equal(parseDuration('90s'), 90 * 1000);
  assert.equal(parseDuration('1h'), 3600 * 1000);
  assert.equal(parseDuration('1h30m'), 90 * 60 * 1000);
  // 0 would mean "no timeout" to the pipeline, which silently removes a
  // wall-clock budget — the opposite of what the author wrote.
  assert.throws(() => parseDuration('0s'));
  assert.throws(() => parseDuration('soon'));
});

/* -------------------------------------------------------------------------- */
/* Spec mapping — the enforcement point                                        */
/* -------------------------------------------------------------------------- */

test('an unknown stage key is refused, not ignored', () => {
  // `dependOn` (missing 's') is the exact typo that would otherwise produce a
  // stage with no dependencies, running concurrently with the stage meant to
  // feed it. The error must name the valid keys.
  assert.throws(
    () => specFrom(tree('name: p\nstages:\n  - name: review\n    provider: codex\n    dependOn: [implement]\n')),
    (err: unknown) =>
      err instanceof PipelineSpecError && /unknown key 'dependOn'/.test((err as Error).message),
  );
});

test('an unknown top-level key is refused', () => {
  assert.throws(
    () => specFrom(tree('name: p\nstagez: []\nstages:\n  - name: a\n    provider: agy')),
    PipelineSpecError,
  );
});

test('provider-native xhigh and max effort values are accepted, unknown values refused', () => {
  const high = specFrom(tree('name: p\nstages:\n  - name: a\n    provider: codex\n    effort: xhigh'));
  const max = specFrom(tree('name: p\nstages:\n  - name: a\n    provider: codex\n    effort: max'));
  assert.equal(high.stages[0]?.effort, 'xhigh');
  assert.equal(max.stages[0]?.effort, 'max');
  assert.throws(
    () =>
      specFrom(
        tree('name: p\nstages:\n  - name: a\n    provider: agy\n    effort: maximum'),
      ),
    (err: unknown) => /effort must be low\|medium\|high\|xhigh\|max/.test((err as Error).message),
  );
});

test('worker identity, conversation, and executable checks survive YAML mapping', () => {
  const spec = specFrom(tree(`
name: follow-up
stages:
  - name: implement
    agentName: Luna
    workerId: worker-123
    conversation: conv-456
    provider: codex
    effort: xhigh
    checks:
      - name: unit
        command: npm test
        cwd: ./web
        timeoutMs: 90000
        blocking: false
`));
  const stage = spec.stages[0]!;
  assert.equal(stage.agentName, 'Luna');
  assert.equal(stage.workerId, 'worker-123');
  assert.equal(stage.conversation, 'conv-456');
  assert.deepEqual(stage.checks, [{ name: 'unit', command: 'npm test', cwd: './web', timeoutMs: 90000, blocking: false }]);
});

test('malformed executable checks fail closed', () => {
  for (const yaml of [
    'checks: true',
    'checks:\n      - name: tests\n        command: npm test\n        timeoutMs: 0',
    'checks:\n      - name: tests\n        command: npm test\n        unexpected: true',
  ]) {
    assert.throws(() => specFrom(tree(`name: p\nstages:\n  - name: a\n    provider: agy\n    ${yaml.replaceAll('\n', '\n    ')}`)), PipelineSpecError);
  }
});

test('a stage with no provider is refused', () => {
  assert.throws(
    () => specFrom(tree('name: p\nstages:\n  - name: a')),
    (err: unknown) => /needs a provider/.test((err as Error).message),
  );
});

test('a spec with no stages is refused', () => {
  assert.throws(() => specFrom(tree('name: p\nstages: []')), PipelineSpecError);
});

test('stage timeout accepts a duration string', () => {
  const spec = specFrom(
    tree('name: p\nstages:\n  - name: a\n    provider: agy\n    timeout: 30m'),
  );
  assert.equal(spec.stages[0]?.timeoutMs, 30 * 60 * 1000);
});

test('ambiguous and nonpositive numeric budgets are rejected', () => {
  for (const yaml of [
    'timeoutMs: 0',
    'timeoutMs: -5',
    'timeoutMs: 1000\ntimeout: 1s',
  ]) {
    assert.throws(() => specFrom(tree(`name: p\nstages:\n  - name: a\n    provider: agy\n    ${yaml.replaceAll('\n', '\n    ')}`)), PipelineSpecError);
  }
  for (const value of ['0', '-1', '1.5']) {
    assert.throws(() => specFrom(tree(`name: p\nconcurrency: ${value}\nstages:\n  - name: a\n    provider: agy`)), PipelineSpecError);
  }
});

/* -------------------------------------------------------------------------- */
/* The real example file                                                       */
/* -------------------------------------------------------------------------- */

test('the shipped example parses and validates', () => {
  const spec = loadSpec(EXAMPLE);
  assert.equal(spec.name, 'dashboard-rework');
  assert.equal(spec.stages.length, 6);
  // validateSpec is pipeline/'s own check (duplicates, unknown deps, cycles).
  // Running it here means the example cannot drift into a spec the DAG rejects.
  validateSpec(spec);
});

test('the example is the mixed-provider path the architecture describes', () => {
  const spec = loadSpec(EXAMPLE);
  const byName = new Map(spec.stages.map((s) => [s.name, s]));

  // implement → agy (Google)
  assert.equal(byName.get('implement')?.provider, 'agy');
  // review → codex (OpenAI), depends on implement.
  assert.equal(byName.get('review')?.provider, 'codex');
  assert.deepEqual(byName.get('review')?.dependsOn, ['implement']);
  // moderate → claude (Anthropic), pinned.
  assert.equal(byName.get('moderate')?.provider, 'claude');
  assert.equal(byName.get('moderate')?.routingPinned, true);

  // fix → continues the implementer; its provider is inherited, not repeated.
  assert.equal(byName.get('fix')?.continues, 'implement');
  assert.equal(byName.get('fix')?.provider, 'agy');

  // The concurrency claim: two stages depend only on `fix`, never on each
  // other, so the DAG can run them at the same time.
  const acceptance = byName.get('acceptance');
  const security = byName.get('security');
  assert.deepEqual(acceptance?.dependsOn, ['fix']);
  assert.deepEqual(security?.dependsOn, ['fix']);
  assert.equal(acceptance?.dependsOn?.includes('security'), false);
  assert.equal(security?.dependsOn?.includes('acceptance'), false);
});

test('the example stages declare different model families', () => {
  // The whole point of a `moderate` stage. Asserted here rather than trusted to
  // the example's comments, so editing a provider in the yaml without noticing
  // the family change fails a test.
  const spec = loadSpec(EXAMPLE);
  const providers = new Set(spec.stages.map((s) => s.provider));
  assert.ok(providers.has('agy') && providers.has('codex') && providers.has('claude'));
  assert.ok(providers.size >= 3, 'the example must exercise at least three workers');
});

test('continues is a stage key; provider is inherited when omitted and required otherwise', () => {
  const yaml = (fix: string): ReturnType<typeof specFrom> => specFrom(tree(
    `name: p\nstages:\n  - name: build\n    provider: agy\n  - name: fix\n    dependsOn: [build]\n${fix}`));
  const inherited = yaml('    continues: build');
  assert.deepEqual([inherited.stages[1]?.continues, inherited.stages[1]?.provider], ['build', 'agy']);
  validateSpec(inherited);
  assert.throws(() => yaml('    prompt: x'), /stage 'fix' needs a provider/);
  assert.throws(() => validateSpec(yaml('    provider: codex\n    continues: build')), /cannot move between providers/);
  assert.throws(() => yaml('    continues: ""'), /continues must be nonempty/);
});
