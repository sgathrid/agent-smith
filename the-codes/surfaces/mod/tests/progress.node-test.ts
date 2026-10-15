/** progress.ts: one classifier for every provider's tool calls, and the honesty rules of the digest. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProgressTracker, classify, progressLines, progressPhrase, unwrapShell } from '../hooks/progress.ts';
import { fitBandColumns, paneColumns } from '../hooks/format.ts';

const J = (v: Record<string, unknown>) => JSON.stringify(v);

test('classify understands agy, claude, opencode and codex tool calls', () => {
  const cases: Array<[string, string | null, string, string]> = [
    ['view_file', J({ AbsolutePath: '/w/src/config.py' }), 'read', 'reading config.py'],
    ['replace_file_content', J({ TargetFile: '/w/src/config.py' }), 'edit', 'editing config.py'],
    ['grep_search', J({ Query: 'load_config' }), 'search', 'searching load_config'],
    ['run_command', J({ CommandLine: 'git grep -n "refine_config" tests/' }), 'search', 'git grep'],
    ['run_command', J({ CommandLine: 'uv run pytest tests/ -q 2>&1 | tail -20' }), 'test', 'running tests'],
    ['run_command', J({ CommandLine: '! grep -rn foo .' }), 'search', 'searching'],
    ['Read', J({ file_path: '/w/README.md' }), 'read', 'reading README.md'],
    ['Edit', J({ file_path: '/w/a.ts', old_string: 'x', new_string: 'y' }), 'edit', 'editing a.ts'],
    ['Bash', J({ command: 'npm test' }), 'test', 'running tests'],
    ['Grep', J({ pattern: 'TODO' }), 'search', 'searching TODO'],
    ['read', J({ filePath: '/w/b.go' }), 'read', 'reading b.go'],
    ['bash', J({ command: 'go test ./...' }), 'test', 'running tests'],
    [`/bin/zsh -lc 'cat README.md'`, null, 'read', 'cat README.md'],
    [`/bin/zsh -lc "rg -n 'Forge' docs"`, null, 'search', 'searching'],
    [`bash -lc 'cargo test -p core'`, null, 'test', 'running tests'],
    ['file_change', J({ changes: [{ path: '/w/src/lib.rs', kind: 'update' }] }), 'edit', 'editing lib.rs'],
    ['manage_task', J({ Action: 'update' }), 'other', 'task update'],
  ];
  for (const [tool, input, kind, label] of cases) {
    const c = classify(tool, input);
    assert.deepEqual([c.kind, c.label], [kind, label], `${tool} ${input ?? ''}`);
  }
  assert.equal(unwrapShell(`/bin/zsh -lc 'ls -la'`), 'ls -la');
});

test('a truncated input still yields its path, and nothing throws on garbage', () => {
  const truncated = '{"file_path":"/w/.agent-smith/result.md","content":"# Review\\n\\nA very long bo';
  assert.deepEqual(classify('Write', truncated), { kind: 'edit', label: 'editing result.md', path: '/w/.agent-smith/result.md' });
  assert.equal(classify('view_file', '{not json').kind, 'read');
  assert.equal(classify('', null).kind, 'other');
});

function run(t: ProgressTracker, step: number, tool: string, input: unknown, status = 'done'): void {
  const raw = typeof input === 'string' ? input : J(input as Record<string, unknown>);
  t.start(step, tool, raw);
  t.end(step, tool, raw, status);
}

test('the digest never claims a green test run, and a failure only on an explicit error', () => {
  const t = new ProgressTracker();
  run(t, 1, 'run_command', { CommandLine: 'pytest -q' }, 'done');
  let d = t.digest();
  assert.equal(d.testRuns, 1); assert.equal(d.lastTestFailed, false);
  assert.equal(progressPhrase(d, 'running tests').includes('✓'), false);
  assert.match(progressPhrase(d, 'reading x.py'), /ran tests ×1/);
  run(t, 2, 'Bash', { command: 'npm test' }, 'error');
  d = t.digest();
  assert.equal(d.lastTestFailed, true);
  assert.match(progressPhrase(d, 'reading x.py'), /last test run failed/);
});

test('edits are counted only when an edit tool shows them, and never printed as zero', () => {
  const t = new ProgressTracker();
  run(t, 1, `/bin/zsh -lc "printf ok > out.txt"`, null);
  run(t, 2, 'view_file', { AbsolutePath: '/w/a.py' });
  const d = t.digest('/w');
  assert.equal(d.editedCount, 0);
  const phrase = progressPhrase(d, 'reading a.py');
  assert.equal(/0 files? edited/.test(phrase), false);
  assert.equal(progressLines(d, 2).some((l) => l.startsWith('Edited')), false);
});

test('the phase comes from a window of calls, edited paths are relative and disambiguated', () => {
  const t = new ProgressTracker();
  assert.equal(t.digest().phase, 'starting');
  run(t, 1, 'view_file', { AbsolutePath: '/w/crate-a/src/impute.rs' });
  assert.equal(t.digest().phase, 'exploring');
  run(t, 2, 'replace_file_content', { TargetFile: '/w/crate-a/src/impute.rs' });
  run(t, 3, 'replace_file_content', { TargetFile: '/w/crate-b/src/impute.rs' });
  run(t, 4, 'view_file', { AbsolutePath: '/w/notes.md' });
  const d = t.digest('/w');
  assert.equal(d.phase, 'editing', 'one read after an edit does not flip back to exploring');
  assert.deepEqual(d.edited, ['crate-a/src/impute.rs', 'crate-b/src/impute.rs']);
  assert.ok(progressLines(d, 4).includes('Edited: crate-a/src/impute.rs, crate-b/src/impute.rs'));
});

test('the same call four times in a row is called out as repeating', () => {
  const t = new ProgressTracker();
  for (let i = 0; i < 3; i += 1) run(t, i, 'run_command', { CommandLine: 'git grep -n load_config' });
  assert.equal(t.digest().repeat, null);
  run(t, 3, 'run_command', { CommandLine: 'git grep -n load_config' });
  assert.match(progressPhrase(t.digest(), 'git grep'), /^repeating git grep ×4/);
});

test('the band phrase leads with what is happening, then edits, tests and reads', () => {
  const t = new ProgressTracker();
  for (let i = 0; i < 5; i += 1) run(t, i, 'view_file', { AbsolutePath: `/w/f${i}.py` });
  assert.equal(progressPhrase(t.digest(), 'reading f4.py'), 'reading f4.py · 5 files read');
  assert.equal(progressPhrase(t.digest(), 'ls tests/'), 'exploring · 5 files read', 'a raw command is replaced by the phase');
  run(t, 9, 'write_to_file', { TargetFile: '/w/new.py' });
  assert.equal(progressPhrase(t.digest(), 'editing new.py'), 'editing new.py · 1 file edited');
});

test('the band label column shrinks to the names on screen and the detail takes the room', () => {
  const base = paneColumns(117);
  const fit = fitBandColumns(117, 9);
  assert.equal(fit.label, 12);
  assert.ok(fit.detail > base.detail);
  assert.ok(fit.label + fit.detail + 10 <= 117);
  assert.deepEqual(fitBandColumns(117, 200).label, base.label);
});

test('git global options and lowercase env prefixes do not hide the subcommand', () => {
  assert.deepEqual([classify('run_command', J({ CommandLine: 'git -C pkg grep -n load_config' })).kind, classify('run_command', J({ CommandLine: 'git -C pkg grep -n x' })).label], ['search', 'git grep']);
  assert.equal(classify('Bash', J({ command: 'node_env=test pytest -q' })).kind, 'test');
  assert.equal(classify('Bash', J({ command: 'FOO=1 rg needle' })).kind, 'search');
});

test('an edit whose file is not named still counts as an edit', () => {
  const t = new ProgressTracker();
  run(t, 1, 'file_change', { items: [{ file: '/w/a.rs' }] });
  const d = t.digest('/w');
  assert.equal(d.editedCount, 1);
  assert.deepEqual(d.edited, []);
  assert.match(progressPhrase(d, 'editing files'), /1 file edited/);
  assert.ok(progressLines(d, 1).includes('Edited: 1 file'));
});

test('shell setup steps do not stand in for the command', () => {
  assert.deepEqual([classify('run_command', J({ CommandLine: 'unset VIRTUAL_ENV; uv run pytest -q' })).kind, classify('run_command', J({ CommandLine: 'unset VIRTUAL_ENV; uv run pytest -q' })).label], ['test', 'running tests']);
  assert.equal(classify('run_command', J({ CommandLine: 'unset VIRTUAL_ENV; uv run ruff check .' })).label, 'uv run');
  assert.equal(classify('Bash', J({ command: 'cd pkg && rg needle' })).kind, 'search');
  assert.equal(classify('Bash', J({ command: 'export A=1 && cat README.md' })).kind, 'read');
});
