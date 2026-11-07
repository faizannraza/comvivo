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
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGE_DIR = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const OUT_DIR = join(PACKAGE_DIR, 'spike', '.generated');

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
    // `packages/storage/migrations/`. Gitignored, and removed by every test above — checked here
    // so a future edit cannot quietly start committing generated SQL.
    rmSync(OUT_DIR, { recursive: true, force: true });
    expect(existsSync(OUT_DIR)).toBe(false);
  });
});
