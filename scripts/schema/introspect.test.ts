/**
 * The schema reference describes the database the migrations actually build.
 *
 * `docs/architecture/schema.md` is generated, and `pnpm run schema:check` proves the committed file
 * matches the generator. That is a weaker statement than it looks: it compares the generator with
 * itself, so a generator that reads half the schema produces a stale-free, confidently wrong
 * reference. Which is what happened — `getTableConfig().indexes` lists a declared
 * `index()`/`uniqueIndex()` and **not** a column's `.unique()`, so the reference reported 109
 * indexes where `0000_initial_schema.sql` creates 125, and the sixteen it dropped included the
 * uniqueness that enforces `I6` (`outbox_messages.idempotency_key`) and `I7`
 * (`turn_effects.idempotency_key`). Found by the M1 exit gate's reviewer by counting the SQL.
 *
 * So this suite compares the generator against the **migrations**: the one artefact that is neither
 * derived from the schema objects nor from the document. A future migration that creates an index
 * the schema does not declare, or a `.unique()` the generator learns to miss again, fails here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tables } from './introspect.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS = resolve(REPO_ROOT, 'packages/storage/migrations');

/**
 * Every index name the migrations leave behind, applied in order.
 *
 * `CREATE` adds and `DROP` removes, because a table rebuild drops and recreates: taking only the
 * `CREATE`s would count an index twice and read a rebuild as drift.
 */
function indexesAfterMigrations(): ReadonlySet<string> {
  const live = new Set<string>();
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .toSorted()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    for (const match of sql.matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([a-zA-Z0-9_]+)/gi,
    )) {
      if (match[1] !== undefined) live.add(match[1]);
    }
    for (const match of sql.matchAll(/DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?[`"]?([a-zA-Z0-9_]+)/gi)) {
      if (match[1] !== undefined) live.delete(match[1]);
    }
  }
  return live;
}

describe('the generated reference against the committed migrations', () => {
  const introspected = new Set(
    tables(REPO_ROOT).flatMap((table) => table.indexes.map((i) => i.name)),
  );
  const created = indexesAfterMigrations();

  it('finds indexes in both places at all, so neither side is vacuous', () => {
    // The guard on the guard: two empty sets are equal, and a regex that stopped matching would
    // make every assertion below pass. 125 is the count at `M1`; the assertion is a floor.
    expect(created.size).toBeGreaterThan(100);
    expect(introspected.size).toBeGreaterThan(100);
  });

  it('describes every index the migrations create', () => {
    const missing = [...created].filter((name) => !introspected.has(name)).toSorted();
    expect(missing).toEqual([]);
  });

  it('describes no index the migrations do not create', () => {
    const extra = [...introspected].filter((name) => !created.has(name)).toSorted();
    expect(extra).toEqual([]);
  });

  it('counts the sixteen column-level unique indexes as indexes', () => {
    // Named explicitly, not only covered by the set comparison: these are the ones that were
    // missing, and two of them are how `I6` and `I7` are enforced in SQL rather than in code.
    for (const name of [
      'outbox_messages_idempotency_key_unique',
      'turn_effects_idempotency_key_unique',
      'turn_traces_turn_id_unique',
      'instance_singleton_unique',
    ]) {
      expect(introspected, name).toContain(name);
    }
  });
});
