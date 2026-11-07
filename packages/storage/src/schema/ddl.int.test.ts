/**
 * The generated DDL, reviewed against `02` §3.3 and executed by SQLite (`M1-T11`).
 *
 * `M1-T11`'s acceptance criterion is "`drizzle-kit generate` output reviewed; CHECK, partial and
 * expression indexes present in the SQL". A one-time reading of the SQL cannot be that review,
 * because the thing being asserted is a property of a *generator* against a *schema*, and both
 * change. So this suite does the review the way it has to be done to stay true:
 *
 *  1. it runs the real `drizzle-kit generate` against `src/schema/index.ts`;
 *  2. it **executes** the result in SQLite with `foreign_keys = ON`, which is the only authority on
 *     whether the DDL is valid — and it found something a reading would not have: drizzle emits
 *     table-qualified column names inside `CHECK(…)` and inside a partial index's `WHERE`, and
 *     those are legal in both positions;
 *  3. it asks SQLite, through `PRAGMA index_list` and `PRAGMA index_info`, which indexes are
 *     partial and which are expression indexes, rather than pattern-matching the SQL text.
 *
 * The third point matters more than it looks. A regex over generated SQL is the kind of guard that
 * passes after the thing it guards has stopped working; `index_list.partial` and the `NULL` column
 * name that `index_info` reports for an expression are SQLite's own answers. The expression check
 * carries a **positive control** — a `lower(…)` index created inside the test — so that the
 * detection cannot quietly start returning nothing.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '@comvivo/shared';
import Database from 'better-sqlite3-multiple-ciphers';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { writeSourcePathsTsconfig } from '../../../../scripts/support/paths-tsconfig.js';
import * as schema from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, '../..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '../..');

/**
 * The generated SQL, produced once.
 *
 * Memoised in a `const` object rather than a module-level `let`, which
 * `scripts/hygiene/check.ts` refuses. Only the text is cached: a database is a handle, and each
 * test opening its own in-memory copy from this text costs about a millisecond.
 */
const generated: { sql?: string } = {};

/**
 * Run `drizzle-kit generate` into a throwaway directory and return the migration it wrote.
 *
 * Two things here are load-bearing, and neither is obvious.
 *
 * **The generated `tsconfig.json`.** drizzle-kit loads the schema in a *child process*, which
 * resolves `@comvivo/core` through the package `exports` map and lands in `dist/`. Vitest's
 * `resolve.alias` does not reach a child, so without this the suite is green on a machine that has
 * built and red on every clean runner — the same trap `M1-T8`'s worker hit, in the one place the
 * alias cannot reach. drizzle-kit's `resolveTsPaths` discovers a `tsconfig.json` beside its config,
 * so writing the workspace paths map there points it at source. Measured both ways: with the file,
 * generation succeeds from a `dist`-free tree; without it, it fails.
 *
 * **The output is checked, not the exit code.** Measured on drizzle-kit 0.31.11: when it cannot
 * load the schema it prints `Error: Cannot find module …`, writes nothing, and **exits 0**. A
 * caller that trusts the exit status therefore concludes a migration was generated when none was.
 * So the assertion is on the file appearing, and drizzle-kit's own output is folded into the
 * failure message — otherwise this reports "expected 0 to be 1" and says nothing about why.
 * `M1-T14`'s `db:generate` has to make the same check.
 */
async function generateDdl(): Promise<string> {
  const out = await mkdtemp(join(tmpdir(), `${BRAND.slug}-ddl-`));
  try {
    writeSourcePathsTsconfig(out, REPO_ROOT);
    const configPath = join(out, 'drizzle.review.config.ts');
    // A config of its own, so this never writes into the repository's `migrations/` directory —
    // that is `M1-T13`'s artifact, generated once the search and guard tables exist.
    await writeFile(
      configPath,
      [
        "import { defineConfig } from 'drizzle-kit';",
        'export default defineConfig({',
        "  dialect: 'sqlite',",
        `  schema: ${JSON.stringify(join(HERE, 'index.ts'))},`,
        `  out: ${JSON.stringify(out)},`,
        '  strict: true,',
        "  casing: 'snake_case',",
        '});',
        '',
      ].join('\n'),
      'utf8',
    );
    const output = execFileSync(
      join(PACKAGE_ROOT, 'node_modules/.bin/drizzle-kit'),
      ['generate', `--config=${configPath}`],
      // `cwd` is the temp directory so `resolveTsPaths` finds the tsconfig written above.
      { cwd: out, stdio: 'pipe', encoding: 'utf8' },
    );
    const migrations = readdirSync(out).filter((name) => name.endsWith('.sql'));
    expect(
      migrations,
      `drizzle-kit wrote no migration and still exited 0. Its output was:\n${output}`,
    ).toHaveLength(1);
    return await readFile(join(out, migrations[0] ?? ''), 'utf8');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

/** Apply the DDL to a fresh in-memory database and hand it to `fn`. */
function withSchemaDb<T>(sql: string, fn: (db: Database.Database) => T): T {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed !== '') db.exec(trimmed);
    }
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Every table the schema barrel exports, as drizzle sees it.
 *
 * The values are widened to `unknown` before filtering because the barrel exports column helpers
 * alongside tables, and `Array.prototype.filter`'s predicate has to narrow *to a subtype of the
 * element type* — which `SQLiteTable<TableConfig>` is not, relative to a union of nineteen
 * fully-specified table types.
 */
const exported: unknown[] = Object.values(schema);
const tables = exported.filter((value): value is SQLiteTable => is(value, SQLiteTable));

/**
 * Every `bool()` column in the schema (`02` §3.1).
 *
 * `label` is precomputed rather than interpolated in the test title as `$table.$column`, which is
 * what this suite did first: vitest reads a `$` path with a dot as a *nested* property access, so
 * all seven cases were named "guards undefined" and a failure could not say which column had lost
 * its CHECK. A test whose failure does not name the subject is most of the way to a useless test.
 */
const boolColumns = tables.flatMap((table) =>
  Object.values(getTableColumns(table))
    .filter((column) => column.columnType === 'SQLiteBoolean')
    .map((column) => ({
      table: getTableName(table),
      column: column.name,
      label: `${getTableName(table)}.${column.name}`,
    })),
);

interface IndexRow {
  readonly name: string;
  readonly partial: number;
}
interface IndexColumn {
  readonly name: string | null;
}

/** The names of every partial and every expression index SQLite reports. */
function classifyIndexes(db: Database.Database): { partial: string[]; expression: string[] } {
  const partial: string[] = [];
  const expression: string[] = [];
  const tableNames = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tableNames) {
    for (const index of db.pragma(`index_list(${JSON.stringify(name)})`) as IndexRow[]) {
      if (index.partial === 1) partial.push(index.name);
      const columns = db.pragma(`index_info(${JSON.stringify(index.name)})`) as IndexColumn[];
      // SQLite reports a `NULL` column name for the expression terms of an expression index.
      if (columns.some((column) => column.name === null)) expression.push(index.name);
    }
  }
  return { partial: partial.sort(), expression: expression.sort() };
}

beforeAll(async () => {
  generated.sql = await generateDdl();
}, 120_000);

/** The generated SQL, after `beforeAll`. */
function ddl(): string {
  const { sql } = generated;
  if (sql === undefined) throw new Error('the DDL was not generated');
  return sql;
}

describe('the generated DDL is valid SQLite', () => {
  it('applies in full with foreign keys on', () => {
    withSchemaDb(ddl(), (db) => {
      const applied = db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .get() as { n: number };
      expect(applied.n).toBe(tables.length);
      // Empty, but it proves every `REFERENCES` resolved to a real table and column: SQLite only
      // reports violations for parents it can find, and a missing parent table is a DDL error above.
      expect(db.pragma('foreign_key_check')).toEqual([]);
    });
  });

  it('generates every table the schema exports, dropping none', () => {
    // The canonical inventory is pinned in `tables.test.ts`; duplicating it here would be two
    // lists to update and one to forget. What only this suite can show is that `drizzle-kit`
    // carried every exported table into the SQL.
    const generatedNames = withSchemaDb(ddl(), (db) =>
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
    expect(generatedNames).toEqual(tables.map((table) => getTableName(table)).sort());
  });
});

describe('CHECK constraints', () => {
  it.each(boolColumns)(
    'guards $label against a value that is neither 0 nor 1',
    ({ table, column }) => {
      // **Why every `bool` column needs this.** `_columns.ts` measured that drizzle's
      // `{ mode: 'boolean' }` maps `1` to `true` and *everything else* to `false`, so a `2` in a
      // consent or `untrusted` column reads back as a confident `false` rather than as nonsense.
      // The CHECK is the only layer that can stop the value existing, and deriving this list from
      // the schema is what makes a new `bool` column without a CHECK fail here.
      const definition = withSchemaDb(ddl(), (db) => {
        const row = db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table) as { sql: string };
        return row.sql;
      });
      expect(definition).toContain(`"${column}" IN (0, 1)`);
    },
  );

  it('rejects a boolean column value of 2 at the database, not at the mapper', () => {
    withSchemaDb(ddl(), (db) => {
      db.exec(
        'INSERT INTO persons (id, display_name, display_name_source, created_at, updated_at) ' +
          "VALUES ('prs_01jtest0000000000000000010', 'A', 'platform', 0, 0)",
      );
      const insert = db.prepare(
        'INSERT INTO channel_identities ' +
          '(id, channel, platform_user_id, person_id, display_name_snapshot, is_bot, dm_reachable, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, 0, 0)',
      );
      expect(() =>
        insert.run(
          'chid_01jtest0000000000000000100',
          'telegram',
          'u1',
          'prs_01jtest0000000000000000010',
          'A',
          2,
        ),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        insert.run(
          'chid_01jtest0000000000000000200',
          'telegram',
          'u2',
          'prs_01jtest0000000000000000010',
          'A',
          1,
        ),
      ).not.toThrow();
    });
  });

  it('declares the named constraints 02 §3.3 specifies', () => {
    const sql = ddl();
    for (const name of [
      'instance_singleton_ck',
      'members_ageband_ck',
      'conversations_dm_ck',
      'conversations_primary_ck',
    ]) {
      expect(sql, `${name} is in 02 §3.3`).toContain(name);
    }
  });

  it('makes the child role and a non-adult age band imply each other in both directions', () => {
    // `members_ageband_ck` is a biconditional, and the two halves fail differently: a child with
    // `age_band='adult'` would let 03's content rules treat a minor as an adult, and a teen with
    // `role='member'` would skip guardian approval. One constraint has to forbid both.
    withSchemaDb(ddl(), (db) => {
      db.exec(
        'INSERT INTO persons (id, display_name, display_name_source, created_at, updated_at) ' +
          "VALUES ('prs_01jtest0000000000000000010', 'A', 'platform', 0, 0)",
      );
      db.exec(
        'INSERT INTO groups (id, name, archetype, history_visibility, timezone, locale, week_start, status, ' +
          'membership_epoch, extensions_version, created_at, updated_at, version) ' +
          "VALUES ('grp_01jtest0000000000000000010', 'G', 'family', 'since_join', 'UTC', 'en', 1, 'active', 0, 0, 0, 0, 1)",
      );
      const insert = db.prepare(
        'INSERT INTO members (id, group_id, person_id, role, age_band, handle, status, consent, ' +
          'joined_at, created_at, updated_at, version) ' +
          "VALUES (?, 'grp_01jtest0000000000000000010', 'prs_01jtest0000000000000000010', ?, ?, ?, 'active', 'unknown', 0, 0, 0, 1)",
      );
      expect(() => insert.run('mbr_01jtest0000000000000000100', 'child', 'adult', 'm1')).toThrow(
        /CHECK constraint failed/,
      );
      expect(() => insert.run('mbr_01jtest0000000000000000200', 'member', 'teen', 'm2')).toThrow(
        /CHECK constraint failed/,
      );
      expect(() =>
        insert.run('mbr_01jtest0000000000000000300', 'child', 'teen', 'm3'),
      ).not.toThrow();
    });
  });
});

describe('the committed base migration matches the schema', () => {
  it('is byte-identical to a fresh `drizzle-kit generate`', () => {
    // The drift guard `0001_search_and_guards.sql` has had since `M1-T13` (`guards.int.test.ts`
    // byte-compares it against its generator) and `0000_initial_schema.sql` had not.
    //
    // Everything else in this file reads either `src/schema/*.ts` or this freshly generated DDL,
    // and `migrations.int.test.ts` applies the *committed* SQL to both sides of its
    // fresh-equals-migrated comparison — so a column type, CHECK, default or nullability edited in
    // `src/schema/` without running `pnpm db:generate` shipped a stale 1400-line base migration
    // with the entire suite green. Hosts run the migration; the tests ran the schema. Found by the
    // M1 independent review.
    //
    // A byte comparison rather than a schema comparison, and it is exact today: the committed file
    // is what this same generator produces. That is only true while nobody hand-edits it, which is
    // the rule this makes enforceable — `02` §3.12.1 is forward-only, so a correction is a new
    // migration, never an edit to this one.
    const committed = readFileSync(
      new URL('../../migrations/0000_initial_schema.sql', import.meta.url),
      'utf8',
    );
    expect(
      ddl(),
      'the committed base migration no longer matches `src/schema/*.ts`. Run `pnpm db:generate`. ' +
        'If the diff is a change to an already-released migration, add a new migration instead: ' +
        'migrations are forward-only (`02` §3.12.1).',
    ).toBe(committed);
  });
});

describe('partial and expression indexes', () => {
  it('creates exactly the partial indexes 02 §3.3 asks for', () => {
    const { partial } = withSchemaDb(ddl(), classifyIndexes);
    expect(partial).toEqual([
      'attachments_blob_idx',
      'blobs_unref_idx',
      'confirmations_pending_idx',
      'constraints_active_idx',
      'conversations_one_primary_uq',
      'decisions_memory_uq',
      'declassifications_action_idx',
      'embedding_spaces_one_active_uq',
      'events_group_recurring_idx',
      'events_subscription_src_rec_uq',
      'events_subscription_src_uq',
      'job_schedules_due_idx',
      'jobs_debounce_uq',
      'jobs_idempotency_uq',
      'jobs_leased_partition_idx',
      'jobs_leased_until_idx',
      'jobs_queued_due_idx',
      'jobs_terminal_finished_idx',
      'lists_default_kind_uq',
      'lists_group_name_uq',
      'memory_embed_pending_idx',
      'memory_pinned_idx',
      'memory_sources_message_idx',
      'memory_supersedes_idx',
      'messages_client_id_uq',
      'messages_conv_platform_uq',
      'messages_dedupe_uq',
      'messages_retention_idx',
      'outbox_class_idx',
      'outbox_conv_seq_idx',
      'outbox_dispatch_idx',
      'outbox_recent_sent_idx',
      'outbox_sending_idx',
      'polls_open_deadline_idx',
      'proposals_diff_idx',
      'proposals_open_idx',
      'reminders_about_idx',
      'reminders_due_idx',
      'standing_approvals_ward_idx',
      'task_swaps_open_idx',
      'tasks_open_due_idx',
      'tasks_rotation_occurrence_uq',
      'turn_effects_intent_idx',
      'turn_effects_unacked_idx',
      'turns_running_idx',
      'turns_timeout_idx',
    ]);
  });

  it('creates exactly one expression index, and detects one when there is', () => {
    // `02`'s only expression index is `lists_group_name_uq` — unique on `(group_id, lower(name))`
    // among live lists — and `M1-T12` is where it arrives. `M1-T11` asserted the empty set
    // precisely so that this moment would fail and force a look at the generated SQL, which is
    // how the `coalesce` defect below was found.
    //
    // The positive control stays: without it, a detection that silently stopped working would
    // report "no expression indexes" forever and pass.
    const { after, before } = withSchemaDb(ddl(), (db) => {
      const before = classifyIndexes(db).expression;
      db.exec('CREATE UNIQUE INDEX probe_expr_uq ON labels (group_id, lower(canonical_key))');
      return { before, after: classifyIndexes(db).expression };
    });
    expect(before).toEqual(['lists_group_name_uq']);
    expect(after).toEqual(['lists_group_name_uq', 'probe_expr_uq']);
  });

  it('renders the expression index with lower() in the generated SQL', () => {
    // The part `PRAGMA index_info` cannot show: that `drizzle-kit` emitted the function call
    // rather than treating `lower(name)` as a column name. It gets this right for a
    // single-argument call and **wrong** for a multi-argument one — see the note on
    // `events_subscription_src_uq` in `calendar.ts`.
    expect(ddl()).toContain('lower("name")');
  });

  it('emits no mangled function call in any index column list', () => {
    // The regression guard for the defect `events_subscription_src_uq` hit: drizzle-kit split
    // `coalesce("x", '')` on its comma and wrapped the fragments as identifiers, producing
    // ``(`a`,`coalesce("x"`,` '')`)`` — which SQLite rejects with `no such column`. Any backtick
    // immediately followed by a function-call fragment is that bug.
    expect(ddl()).not.toMatch(/`[a-z_]+\("/i);
  });

  it('enforces one primary conversation per group through the partial unique index', () => {
    withSchemaDb(ddl(), (db) => {
      db.exec(
        'INSERT INTO groups (id, name, archetype, history_visibility, timezone, locale, week_start, status, ' +
          'membership_epoch, extensions_version, created_at, updated_at, version) ' +
          "VALUES ('grp_01jtest0000000000000000010', 'G', 'family', 'since_join', 'UTC', 'en', 1, 'active', 0, 0, 0, 0, 1)",
      );
      const insert = db.prepare(
        'INSERT INTO conversations (id, group_id, channel, platform_chat_id, kind, "primary", bound_at, created_at, updated_at) ' +
          "VALUES (?, 'grp_01jtest0000000000000000010', 'telegram', ?, 'group', ?, 0, 0, 0)",
      );
      insert.run('cnv_01jtest0000000000000000010', 'c1', 1);
      // A second *primary* collides…
      expect(() => insert.run('cnv_01jtest0000000000000000020', 'c2', 1)).toThrow(
        /UNIQUE constraint failed/,
      );
      // …while any number of non-primary conversations do not, which is what "partial" buys.
      expect(() => insert.run('cnv_01jtest0000000000000000030', 'c3', 0)).not.toThrow();
      expect(() => insert.run('cnv_01jtest0000000000000000040', 'c4', 0)).not.toThrow();
    });
  });

  it('keeps a DM out of the primary slot and requires a DM to have an owner', () => {
    withSchemaDb(ddl(), (db) => {
      db.exec(
        'INSERT INTO groups (id, name, archetype, history_visibility, timezone, locale, week_start, status, ' +
          'membership_epoch, extensions_version, created_at, updated_at, version) ' +
          "VALUES ('grp_01jtest0000000000000000010', 'G', 'family', 'since_join', 'UTC', 'en', 1, 'active', 0, 0, 0, 0, 1)",
      );
      const insert = db.prepare(
        'INSERT INTO conversations (id, group_id, channel, platform_chat_id, kind, member_id, "primary", bound_at, created_at, updated_at) ' +
          "VALUES (?, 'grp_01jtest0000000000000000010', 'telegram', ?, ?, ?, ?, 0, 0, 0)",
      );
      // A DM with no owner, and a group chat with one, are both refused by `conversations_dm_ck`.
      expect(() => insert.run('cnv_01jtest0000000000000000010', 'c1', 'dm', null, 0)).toThrow(
        /CHECK constraint failed/,
      );
      // A primary DM is refused by `conversations_primary_ck` (01 §14 A7).
      expect(() => insert.run('cnv_01jtest0000000000000000020', 'c2', 'dm', null, 1)).toThrow(
        /CHECK constraint failed/,
      );
    });
  });
});

describe('the index set as a whole', () => {
  /**
   * The prefix each table's index names may use.
   *
   * `02` §3.3.10 justifies every index by name and `M1-T19` asserts on `EXPLAIN QUERY PLAN`
   * output, so a name has to say which table it belongs to. Most are the table's own name; the
   * exceptions here are `02`'s own abbreviations, and listing them explicitly is the point — the
   * first version of this test derived the prefix mechanically (table name minus a trailing `s`),
   * which silently accepted every `memory_*` index on `memory_items` and would have accepted a
   * name that pointed at the wrong table just as happily.
   */
  const PREFIXES: Readonly<Record<string, readonly string[]>> = {
    audit_events: ['audit_'],
    confirmation_requests: ['confirmations_'],
    constraint_records: ['constraints_'],
    ledger_entries: ['ledger_'],
    memory_entity_aliases: ['memory_aliases_'],
    memory_items: ['memory_'],
    message_attachments: ['attachments_'],
    outbox_messages: ['outbox_'],
    usage_records: ['usage_'],
  };

  it('names every index after its table or a declared abbreviation of it', () => {
    const offenders = withSchemaDb(ddl(), (db) =>
      (
        db
          .prepare(
            "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
          )
          .all() as { name: string; tbl_name: string }[]
      ).filter((row) => {
        const allowed = PREFIXES[row.tbl_name] ?? [`${row.tbl_name}_`];
        return !allowed.some((prefix) => row.name.startsWith(prefix));
      }),
    );
    expect(offenders.map((row) => `${row.tbl_name}: ${row.name}`)).toEqual([]);
  });

  it('rejects a name that points at the wrong table', () => {
    // The positive control. Without it, a `PREFIXES` entry loose enough to match anything would
    // make the test above pass for every possible name.
    const allowed = PREFIXES['memory_items'] ?? [];
    expect(allowed.some((prefix) => 'messages_conv_rid_idx'.startsWith(prefix))).toBe(false);
  });
});
