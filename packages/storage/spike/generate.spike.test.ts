/**
 * `02` §3.6.3 step 6, last item: does `drizzle-kit generate` actually emit a partial index, an
 * expression index and a CHECK constraint?
 *
 * All three are **correctness** features in `02` §3.3, not optimisations — a partial unique index
 * is how "one primary conversation per group" is enforced. If the generator silently dropped one,
 * the migration would apply cleanly and the constraint simply would not exist, which is the worst
 * available outcome: every test that inserts *valid* data would still pass, and the first sign of
 * trouble would be two primary conversations in a real group.
 *
 * So this shells out to the real generator and reads the SQL it wrote, rather than asserting
 * anything about Drizzle's in-memory model. `M1-T11` does the same for the real schema.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGE_DIR = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const OUT_DIR = join(PACKAGE_DIR, 'spike', '.generated');
const REPO_ROOT = join(PACKAGE_DIR, '../..');
const MIGRATIONS_DIR = join(PACKAGE_DIR, 'migrations');

/**
 * Run the generator and return the SQL it wrote.
 *
 * `node_modules/.bin/drizzle-kit` directly rather than through pnpm: pnpm's own binary is a shim
 * that `execFileSync` cannot exec (`spawnSync pnpm ENOEXEC`), which cost time twice during M0.
 */
function generate(): string {
  rmSync(OUT_DIR, { recursive: true, force: true });
  execFileSync(
    join(PACKAGE_DIR, 'node_modules', '.bin', 'drizzle-kit'),
    ['generate', '--config', 'spike/drizzle.spike.config.ts'],
    { cwd: PACKAGE_DIR, encoding: 'utf8', stdio: 'pipe' },
  );
  const files = readdirSync(OUT_DIR).filter((name) => name.endsWith('.sql'));
  expect(files, 'drizzle-kit wrote no .sql file').toHaveLength(1);
  return readFileSync(join(OUT_DIR, files[0] ?? ''), 'utf8');
}

describe('drizzle-kit generate', { tags: ['slow'] }, () => {
  it('emits a CHECK constraint inside the CREATE TABLE', () => {
    try {
      const sqlText = generate();
      expect(sqlText).toContain('CONSTRAINT "spike_groups_name_not_blank" CHECK(');
      expect(sqlText).toContain('length(trim(');
    } finally {
      rmSync(OUT_DIR, { recursive: true, force: true });
    }
  });

  it('emits a partial unique index with its WHERE clause', () => {
    // The WHERE clause is the whole point. Without it the index is a *total* unique constraint,
    // which would forbid two archived groups from ever sharing a name — a bug that only appears
    // the second time somebody archives and recreates a group.
    try {
      const sqlText = generate();
      expect(sqlText).toMatch(
        /CREATE UNIQUE INDEX `spike_groups_live_name_idx` ON `spike_groups` \(`name`\) WHERE/,
      );
      expect(sqlText).toContain('archived_at');
    } finally {
      rmSync(OUT_DIR, { recursive: true, force: true });
    }
  });

  it('emits an expression index rather than a plain column index', () => {
    try {
      const sqlText = generate();
      expect(sqlText).toContain(
        'CREATE INDEX `spike_groups_name_lower_idx` ON `spike_groups` (lower(',
      );
    } finally {
      rmSync(OUT_DIR, { recursive: true, force: true });
    }
  });

  it('writes nothing into the repository', () => {
    // The generated migration is an assertion, not an artefact: the real ones live in
    // `packages/storage/migrations/`.
    //
    // This used to `rmSync(OUT_DIR)` and then assert the directory was absent, which cannot fail
    // unless `rmSync` is broken — and worse, if an earlier test had leaked files it erased the
    // evidence and passed. Found by the M1 independent review.
    //
    // Two real checks instead: git ignores the output path, so a file appearing there could never
    // be committed; and `migrations/` holds exactly the committed migrations, so the generator
    // cannot have written into it.
    const ignored = (path: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '-q', path], { cwd: REPO_ROOT, stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    };
    // A **file inside** the directory, not the bare directory name: `.gitignore`'s rule is
    // `packages/*/spike/.generated/` with a trailing slash, which matches the contents. That is the
    // thing that matters anyway — a generated `.sql` can never be committed.
    const generated = `${relative(REPO_ROOT, OUT_DIR)}/0000_anything.sql`;
    expect(ignored(generated), `${generated} is not gitignored`).toBe(true);
    // Non-vacuity for the ignore check: a path that is **not** ignored must report so, otherwise a
    // `check-ignore` that always succeeded would make the assertion above meaningless.
    expect(ignored('packages/storage/src/db/open.ts')).toBe(false);

    // And the real migrations directory is untouched: exactly the files git tracks, no extras.
    const tracked = execFileSync('git', ['ls-files', 'packages/storage/migrations'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.endsWith('.sql'))
      .map((line) => line.replace('packages/storage/migrations/', ''))
      .toSorted();
    const onDisk = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .toSorted();
    expect(onDisk).toEqual(tracked);
    expect(onDisk.length).toBeGreaterThan(1);
  });
});
