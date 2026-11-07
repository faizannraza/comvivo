/**
 * An in-memory database with every migration applied, for the guard and search suites.
 *
 * `M1-T15`'s `createTestDb` supersedes this with template cloning (≤ 5 ms per clone) and an
 * encrypted variant. This is the narrower thing `M1-T13` needs: a real SQLite with sqlite-vec
 * loaded and the committed migration SQL applied, so the triggers under test are **the ones that
 * ship** rather than a copy rendered by the test.
 *
 * `trusted_schema = ON` is not incidental. `02` §3.5 measured that with it `OFF`, vec0 DML inside
 * a trigger is refused at *run* time while the DDL is accepted — so a vec space's delete trigger
 * would look installed and throw on the first retraction. FTS5 is unaffected, which is why one
 * global switch has two different answers and why this helper sets it before loading the
 * extension.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

/** The committed migrations, in order. */
export const MIGRATION_FILES = ['0000_initial_schema.sql', '0001_search_and_guards.sql'] as const;

/** drizzle's statement separator, which the real runner (`M1-T14`) also splits on. */
const BREAKPOINT = '--> statement-breakpoint';

/** Read one committed migration's SQL. */
export function migrationSql(file: (typeof MIGRATION_FILES)[number]): string {
  return readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
}

/** Apply the committed migrations to `db`, returning how many statements ran. */
export function applyMigrations(db: Database.Database): number {
  let applied = 0;
  for (const file of MIGRATION_FILES) {
    for (const raw of migrationSql(file).split(BREAKPOINT)) {
      const statement = raw.trim();
      if (statement === '') continue;
      db.exec(statement);
      applied += 1;
    }
  }
  return applied;
}

/** Open a migrated in-memory database and hand it to `fn`, closing it afterwards. */
export function withMigratedDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(':memory:');
  try {
    // Before `sqliteVec.load`, and before any trigger that touches a vec table runs.
    db.pragma('trusted_schema = ON');
    sqliteVec.load(db);
    db.pragma('foreign_keys = ON');
    applyMigrations(db);
    return fn(db);
  } finally {
    db.close();
  }
}

/** A group with everything a labeled row needs to exist. */
export interface SeededGroup {
  readonly groupId: string;
  readonly personId: string;
  readonly memberId: string;
  readonly conversationId: string;
  readonly readerSetId: number;
  /** A label belonging to this group — the only one a row in it may carry (I4). */
  readonly labelId: number;
}

/** A 26-character Crockford base32 suffix built from `tag`, so ids are readable in a failure. */
function suffix(tag: string): string {
  return `01j${tag}`.padEnd(26, '0').slice(0, 26);
}

/**
 * Insert one group plus the rows a labeled record needs, and return their ids.
 *
 * Two of these give the I4 suite what it needs: a matching label and a foreign one.
 */
export function seedGroup(db: Database.Database, tag: string): SeededGroup {
  const groupId = `grp_${suffix(tag)}`;
  const personId = `prs_${suffix(tag)}`;
  const memberId = `mbr_${suffix(tag)}`;
  const conversationId = `cnv_${suffix(tag)}`;

  db.prepare(
    `INSERT INTO persons (id, display_name, display_name_source, created_at, updated_at)
     VALUES (?, 'Seed', 'platform', 0, 0)`,
  ).run(personId);
  db.prepare(
    `INSERT INTO groups (id, name, archetype, history_visibility, timezone, locale, week_start,
       status, membership_epoch, extensions_version, created_at, updated_at, version)
     VALUES (?, 'Seed', 'family', 'since_join', 'UTC', 'en', 1, 'active', 0, 0, 0, 0, 1)`,
  ).run(groupId);
  db.prepare(
    `INSERT INTO members (id, group_id, person_id, role, age_band, handle, status, consent,
       joined_at, created_at, updated_at, version)
     VALUES (?, ?, ?, 'admin', 'adult', 'm1', 'active', 'informed', 0, 0, 0, 1)`,
  ).run(memberId, groupId, personId);
  db.prepare(
    `INSERT INTO conversations (id, group_id, channel, platform_chat_id, kind, "primary", bound_at,
       created_at, updated_at)
     VALUES (?, ?, 'simulator', ?, 'group', 1, 0, 0, 0)`,
  ).run(conversationId, groupId, `chat-${tag}`);

  // `RETURNING id` rather than `lastInsertRowid`, because both of these are `INTEGER PRIMARY KEY
  // AUTOINCREMENT` and the interned id is the value every labeled row will carry.
  const readerSet = db
    .prepare(
      `INSERT INTO reader_sets (group_id, kind, canonical_key, member_count, created_at)
         VALUES (?, 'group', ?, 0, 0) RETURNING id`,
    )
    .get(groupId, `g:${tag}`) as { id: number };
  const label = db
    .prepare(
      `INSERT INTO labels (group_id, reader_set_id, owner_member_id, co_owner_member_ids,
         sensitivity, influence, untrusted, canonical_key, created_at)
       VALUES (?, ?, NULL, '[]', 'normal', 'none', 0, ?, 0) RETURNING id`,
    )
    .get(groupId, readerSet.id, `l:${tag}`) as { id: number };

  return {
    groupId,
    personId,
    memberId,
    conversationId,
    readerSetId: readerSet.id,
    labelId: label.id,
  };
}
