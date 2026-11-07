/**
 * Every source file is tracked by git (`M1-T14`).
 *
 * This exists because of a specific failure, and the failure is one `pnpm verify` **structurally
 * cannot** catch. `.gitignore` carried a bare `data/`, which matches a directory of that name at
 * any depth — so `packages/storage/src/migrate/data/index.ts`, the data-migration registry `02`
 * §3.12.1 asks for, was never committed. Every local check passed, because every local check reads
 * the working tree, where the file was present. CI checks out only what is tracked, and six jobs
 * failed on a module that does not exist.
 *
 * It is the third blind spot of this shape the project has found, after "`typecheck` builds before
 * `test`, so a `dist/` resolution bug cannot fail `verify`" and "a child process does not inherit
 * Vitest's aliases". The pattern is the same each time: the gate measures the developer's machine
 * rather than the artefact.
 *
 * `git status --ignored` is the cheap approximation of "what would a fresh clone have".
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

/**
 * Paths that are legitimately ignored even though they sit under a source tree.
 *
 * Deliberately short. Anything added here is a claim that a file is *not* source, and the cost of
 * being wrong is the failure above.
 */
const LEGITIMATELY_IGNORED = [
  /(^|\/)__pycache__\//,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)\.turbo\//,
  // `02` §3.6.3's throwaway spike migration, and `pnpm db:migrate`'s scratch database.
  /^packages\/[^/]+\/spike\/\.generated\//,
  /^packages\/storage\/\.dev\//,
  // Astro's build cache.
  /^apps\/docs\/\.astro\//,
];

/** Trees whose contents must all be tracked. */
const SOURCE_TREES = [
  'packages',
  'apps',
  'scripts',
  'test',
  'tools',
  'fixtures',
  'docs',
  'migrations',
];

/** Files git is ignoring under a source tree. */
function ignoredUnderSources(): readonly string[] {
  const output = execFileSync(
    'git',
    ['status', '--porcelain', '--ignored=matching', '--', ...SOURCE_TREES],
    { cwd: ROOT, encoding: 'utf8' },
  );
  return output
    .split('\n')
    .filter((line) => line.startsWith('!! '))
    .map((line) => line.slice(3).trim())
    .filter((path) => !LEGITIMATELY_IGNORED.some((pattern) => pattern.test(path)));
}

describe('nothing under a source tree is git-ignored', () => {
  it('finds no ignored source file', () => {
    expect(ignoredUnderSources()).toEqual([]);
  });

  it('would notice an ignored file, which is what makes the check above worth having', () => {
    // Non-vacuity. `git check-ignore` answers the same question the status walk does, so a rule
    // that stopped matching would fail here rather than make the assertion above pass silently.
    const ignored = (path: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '-q', path], { cwd: ROOT, stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    };
    // A real ignore rule still works…
    expect(ignored('packages/storage/dist/index.js')).toBe(true);
    // …and the one that caused the failure no longer swallows a source path.
    expect(ignored('packages/storage/src/migrate/data/index.ts')).toBe(false);
    // A tracked file is never reported.
    expect(ignored('packages/storage/src/migrate/source.ts')).toBe(false);
  });

  it('keeps the data-directory rule anchored to the repository root', () => {
    // The specific regression: a bare `data/` matches at any depth. `12` §3.7's data directory is
    // at the root, so the rule belongs there and nowhere else.
    // The working tree, not `HEAD`: reading the committed version would fail for anyone who has
    // the fix in hand but not yet committed it, which is a confusing way for a guard to behave.
    const gitignore = readFileSync(`${ROOT}/.gitignore`, 'utf8');
    const lines = gitignore.split('\n').map((line) => line.trim());
    expect(lines, 'an unanchored data/ rule swallows source directories').not.toContain('data/');
  });
});
