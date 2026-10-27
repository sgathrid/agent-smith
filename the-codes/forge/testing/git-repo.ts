/**
 * git-repo.ts — test helper: initialise a git repo with committed files.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** `git init` in `dir`, write `files` (path relative to dir → contents), commit them as "init". */
export function initGitRepo(dir: string, files: Record<string, string>): void {
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  g('add', '.');
  g('commit', '-qm', 'init');
}
