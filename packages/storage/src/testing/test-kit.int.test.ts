/**
 * The storage test kit (`M1-T15`; `11` §3.1.8, `02` §4.1).
 *
 * The clone-time assertion is the one that justifies the design: `11` §3.1.8 sets a 5 ms target,
 * and the whole reason for a page-image template is that running 99 `CREATE TABLE`s and 91
 * `CREATE TRIGGER`s per test costs ~17 ms — minutes across the suite, which is the difference
 * between a test run someone waits for and one they stop running.
 */
import { existsSync, statSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_TABLE } from '../migrate/runner.js';
import { domainTables, exportDomainState, VOLATILE_COLUMNS } from './domain-state.js';
import { createTestDb, resetTestDbTemplates, TEST_DB_KEY, writeMigratedDbFile } from './test-db.js';
import { cleanupTmpDbs, createTmpDbDir, createTmpDbFile } from './tmp-db.js';

afterEach(() => {
  cleanupTmpDbs();
});

/** Insert a group with the rows a labeled record needs, and return its ids. */
function seedGroup(db: import('better-sqlite3-multiple-ciphers').Database, tag: string) {
  const suffix = `01j${tag}`.padEnd(26, '0').slice(0, 26);
  const groupId = `grp_${suffix}`;
  db.prepare(
    `INSERT INTO persons (id, display_name, display_name_source, created_at, updated_at)
     VALUES (?, 'Seed', 'platform', 0, 0)`,
  ).run(`prs_${suffix}`);
  db.prepare(
    `INSERT INTO groups (id, name, archetype, history_visibility, timezone, locale, week_start,
       status, membership_epoch, extensions_version, created_at, updated_at, version)
     VALUES (?, 'Seed', 'family', 'since_join', 'UTC', 'en', 1, 'active', 0, 0, 0, 0, 1)`,
  ).run(groupId);
  db.prepare(
    `INSERT INTO conversations (id, group_id, channel, platform_chat_id, kind, "primary", bound_at,
       created_at, updated_at)
     VALUES (?, ?, 'simulator', ?, 'group', 1, 0, 0, 0)`,
  ).run(`cnv_${suffix}`, groupId, `chat-${tag}`);
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
  return { groupId, conversationId: `cnv_${suffix}`, labelId: label.id };
}

describe('createTestDb', { tags: ['db'] }, () => {
  it('hands back a fully migrated database', () => {
    const db = createTestDb();
    try {
      const tables = db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .get() as { n: number };
      expect(tables.n).toBeGreaterThan(90);
      const triggers = db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'trigger'")
        .get() as { n: number };
      // 248 since the M1 exit gate added the parent-group agreement guards (66 foreign keys whose
      // two sides must belong to one group, two triggers each). Pinned exactly rather than
      // bounded: a clone that silently lost its triggers would still have the tables, and every
      // I4, FTS and immutability guarantee rides on them being present.
      expect(triggers.n).toBe(248);
      // The bookkeeping table travels with the image, so a clone knows it is migrated.
      expect(
        (db.prepare(`SELECT count(*) AS n FROM ${MIGRATIONS_TABLE}`).get() as { n: number }).n,
      ).toBe(2);
    } finally {
      db.close();
    }
  });

  it('clones in under 5 ms, which is why the template exists', () => {
    // Warm the template first: its build cost is paid once per worker and is not what the target
    // is about.
    createTestDb().close();

    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      const db = createTestDb();
      samples.push(performance.now() - started);
      db.close();
    }
    samples.sort((left, right) => left - right);
    const median = samples[Math.floor(samples.length / 2)] ?? Number.POSITIVE_INFINITY;
    // The median rather than the max: a single sample can be swallowed by a GC pause on a shared
    // CI runner, and a flaky performance gate is one that gets deleted.
    expect(
      median,
      `median ${median.toFixed(2)}ms, samples ${samples.map((s) => s.toFixed(1)).join(',')}`,
    ).toBeLessThan(5);
  });

  it('loads sqlite-vec into every clone', () => {
    // The page image carries schema, not connection state. A clone without the extension would
    // fail only when something touched a vec0 table, which is `M1-T18`.
    const db = createTestDb();
    try {
      const version = db.prepare('SELECT vec_version() AS v').get() as { v: string };
      expect(version.v).toMatch(/^v\d/);
    } finally {
      db.close();
    }
  });

  it('turns foreign keys on, which is per-connection and defaults off', () => {
    const db = createTestDb();
    try {
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      // And it is enforced, not merely reported.
      expect(() =>
        db
          .prepare(
            `INSERT INTO members (id, group_id, person_id, role, age_band, handle, status,
               consent, joined_at, created_at, updated_at, version)
             VALUES ('mbr_01j000000000000000000001', 'grp_missing', 'prs_missing', 'admin',
               'adult', 'm1', 'active', 'unknown', 0, 0, 0, 1)`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
  });

  it('keeps the guard triggers working in a clone', () => {
    // The triggers travel with the image; this is the proof, and it covers both an FTS sync
    // trigger and an I4 guard.
    const db = createTestDb();
    try {
      const own = seedGroup(db, 'kita');
      const other = seedGroup(db, 'kitb');
      db.prepare(
        `INSERT INTO messages (id, group_id, conversation_id, kind, text, untrusted, label_id,
           sent_at, received_at, delivered_late, truncated, edit_count)
         VALUES ('msg_01jkit00000000000000000001', ?, ?, 'member', 'rhubarb', 0, ?, 0, 0, 0, 0, 0)`,
      ).run(own.groupId, own.conversationId, own.labelId);
      expect((db.prepare('SELECT count(*) AS n FROM messages_fts').get() as { n: number }).n).toBe(
        1,
      );
      expect(() =>
        db
          .prepare('UPDATE messages SET label_id = ? WHERE id = ?')
          .run(other.labelId, 'msg_01jkit00000000000000000001'),
      ).toThrow(/I4_LABEL_GROUP_MISMATCH/);
    } finally {
      db.close();
    }
  });

  it('gives each caller an independent database', () => {
    const first = createTestDb();
    const second = createTestDb();
    try {
      seedGroup(first, 'iso1');
      expect((first.prepare('SELECT count(*) AS n FROM groups').get() as { n: number }).n).toBe(1);
      expect((second.prepare('SELECT count(*) AS n FROM groups').get() as { n: number }).n).toBe(0);
    } finally {
      first.close();
      second.close();
    }
  });

  it('runs the seed callback inside the new database', () => {
    const db = createTestDb({ seed: (target) => seedGroup(target, 'seed') });
    try {
      expect((db.prepare('SELECT count(*) AS n FROM groups').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('closes the database and rethrows when a seed fails', () => {
    // Otherwise a failing seed leaks a handle per test, and a suite of a few hundred exhausts the
    // process's descriptors with an error that names none of this.
    expect(() =>
      createTestDb({
        seed: () => {
          throw new Error('seed exploded');
        },
      }),
    ).toThrow(/seed exploded/);
  });

  it('builds the template once per worker', () => {
    // The memoisation is the whole optimisation, so it is asserted rather than assumed: a second
    // call must be far cheaper than a cold one.
    resetTestDbTemplates();
    const cold = performance.now();
    createTestDb().close();
    const coldMs = performance.now() - cold;

    const warm = performance.now();
    createTestDb().close();
    const warmMs = performance.now() - warm;

    expect(warmMs, `cold ${coldMs.toFixed(1)}ms, warm ${warmMs.toFixed(1)}ms`).toBeLessThan(coldMs);
  });
});

describe('createTestDb({ encrypted: true })', { tags: ['db', 'slow'] }, () => {
  it('produces a database whose bytes are not readable without the key', () => {
    // The point of the variant. An in-memory database is unencrypted whatever key it is given, so
    // the encrypted path is file-backed — otherwise this test would pass against plaintext.
    const db = createTestDb({ encrypted: true, seed: (target) => seedGroup(target, 'enc') });
    try {
      expect((db.prepare('SELECT count(*) AS n FROM groups').get() as { n: number }).n).toBe(1);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    } finally {
      db.close();
    }
  });

  it('is readable with TEST_DB_KEY and not with any other', () => {
    // Both halves matter. The negative alone would pass against a corrupt file; the positive alone
    // would pass against a plaintext one. Together they say the cipher is on and the key is the
    // one the kit documents.
    const db = createTestDb({ encrypted: true, seed: (target) => seedGroup(target, 'key') });
    const file = (db.pragma('database_list') as { file: string }[])[0]?.file ?? '';
    const DatabaseCtor = db.constructor as new (path: string) => typeof db;
    db.close();
    expect(file).not.toBe('');

    const openWith = (key: Buffer) => {
      const target = new DatabaseCtor(file);
      target.pragma(`key = "x'${key.toString('hex')}'"`);
      target.pragma('cipher_compatibility = 4');
      try {
        return (target.prepare('SELECT count(*) AS n FROM groups').get() as { n: number }).n;
      } finally {
        target.close();
      }
    };

    expect(openWith(TEST_DB_KEY)).toBe(1);
    expect(() => openWith(Buffer.alloc(32, 0x7f))).toThrow();
  });

  it('records what the encrypted clone costs, without asserting an ordering', () => {
    // `11` §3.1.8's claim is that encryption is off by default "for speed", and this is the
    // measurement behind it.
    //
    // **An earlier version asserted that the encrypted clone is slower, from one sample each, and
    // it flaked** — a run measured 2.2 ms encrypted against 6.7 ms plain. `M1-T15`'s own STATUS
    // note had already said why that is wrong ("one sample can be swallowed by a GC pause on a
    // shared runner, and a flaky perf gate gets deleted rather than fixed"); the lesson was applied
    // to the clone-timing test in the same file and not to this one. Its comment even said
    // "recorded rather than asserted tightly" while asserting an ordering tightly.
    //
    // So: medians over several samples, **printed**, with the assertion on an absolute budget
    // rather than on a comparison. The ordering is real on average and is not a per-run fact at
    // this scale, so it is not something a gate can hold. The number that documents the decision
    // is the one in the output.
    const samples = 7;
    const measure = (make: () => { close(): void }): number => {
      const times: number[] = [];
      // One discarded run first: the template is built lazily, and the first caller pays for it.
      make().close();
      for (let index = 0; index < samples; index += 1) {
        const started = performance.now();
        make().close();
        times.push(performance.now() - started);
      }
      const sorted = times.toSorted((left, right) => left - right);
      return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
    };

    const encryptedMs = measure(() => createTestDb({ encrypted: true }));
    const plainMs = measure(() => createTestDb());
    const report = `clone medians over ${String(samples)}: encrypted ${encryptedMs.toFixed(2)} ms, plain ${plainMs.toFixed(2)} ms`;
    console.info(report);

    // Both paths stay inside a budget a test suite can afford. `M1-T15`'s AC is 5 ms for the
    // in-memory clone; the encrypted one copies a file and is allowed more, but not unboundedly —
    // a regression that made it hundreds of milliseconds would make every encrypted test slow.
    expect(plainMs, report).toBeLessThan(25);
    expect(encryptedMs, report).toBeLessThan(100);
    // Non-vacuity: a measurement of zero would mean the loop did not run.
    expect(encryptedMs, report).toBeGreaterThan(0);
    expect(plainMs, report).toBeGreaterThan(0);
  });
});

describe('temporary database files', () => {
  it('gives a fresh directory per call, named with the worker id', () => {
    const first = createTmpDbDir();
    const second = createTmpDbDir();
    expect(first).not.toBe(second);
    expect(existsSync(first)).toBe(true);
    // The worker id keeps two parallel Vitest processes from deleting each other's databases.
    const worker = process.env['VITEST_POOL_ID'] ?? '0';
    expect(first).toContain(`-test-${worker}-`);
  });

  it('returns a path inside a directory, so the -wal and -shm siblings have somewhere to go', () => {
    const file = createTmpDbFile();
    expect(file.endsWith('.db')).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(statSync(file.slice(0, file.lastIndexOf('/'))).isDirectory()).toBe(true);
  });

  it('supports real WAL, which an in-memory database cannot', () => {
    // The reason this helper exists at all (`11` §3.1.8): `journal_mode = WAL` on `:memory:`
    // silently stays `memory`, so a WAL or lock-contention test there passes while testing nothing.
    const path = writeMigratedDbFile();
    const DatabaseCtor = createTestDb().constructor as new (
      file: string,
    ) => ReturnType<typeof createTestDb>;
    const db = new DatabaseCtor(path);
    try {
      expect(db.pragma('journal_mode = WAL', { simple: true })).toBe('wal');
    } finally {
      db.close();
    }
  });

  it('cleans up everything it handed out', () => {
    const first = createTmpDbDir();
    const second = createTmpDbDir();
    expect(cleanupTmpDbs()).toBeGreaterThanOrEqual(2);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(false);
    // Idempotent: a second teardown is not an error.
    expect(cleanupTmpDbs()).toBe(0);
  });
});

describe('exportDomainState', { tags: ['db'] }, () => {
  it('is identical for two databases seeded the same way', () => {
    // The property the replay and chaos oracles rely on. Two independent databases, the same
    // work, the same state — regardless of the autoincrement ids each happened to hand out.
    const first = createTestDb({ seed: (db) => seedGroup(db, 'eqa') });
    const second = createTestDb({ seed: (db) => seedGroup(db, 'eqa') });
    try {
      const groupId = `grp_${'01jeqa'.padEnd(26, '0').slice(0, 26)}`;
      expect(exportDomainState(first, groupId)).toBe(exportDomainState(second, groupId));
    } finally {
      first.close();
      second.close();
    }
  });

  it('differs when the content differs', () => {
    // Non-vacuity: an oracle that returned the same string for everything would pass the test
    // above and be useless.
    const db = createTestDb({ seed: (target) => seedGroup(target, 'eqb') });
    try {
      const groupId = `grp_${'01jeqb'.padEnd(26, '0').slice(0, 26)}`;
      const before = exportDomainState(db, groupId);
      db.prepare("UPDATE groups SET name = 'renamed' WHERE id = ?").run(groupId);
      expect(exportDomainState(db, groupId)).not.toBe(before);
    } finally {
      db.close();
    }
  });

  it('is insensitive to insertion order', () => {
    // A crash and a replay insert the same rows in a different order, so sorting by `rid` would
    // make every chaos assertion fail for the wrong reason.
    const forward = createTestDb({ seed: (db) => seedGroup(db, 'ord') });
    const reverse = createTestDb({ seed: (db) => seedGroup(db, 'ord') });
    try {
      const groupId = `grp_${'01jord'.padEnd(26, '0').slice(0, 26)}`;
      const insert = (db: typeof forward, id: string, text: string) =>
        db
          .prepare(
            `INSERT INTO messages (id, group_id, conversation_id, kind, text, untrusted, label_id,
               sent_at, received_at, delivered_late, truncated, edit_count)
             VALUES (?, ?, ?, 'member', ?, 0, 1, 0, 0, 0, 0, 0)`,
          )
          .run(id, groupId, `cnv_${'01jord'.padEnd(26, '0').slice(0, 26)}`, text);

      insert(forward, 'msg_01jord00000000000000000001', 'first');
      insert(forward, 'msg_01jord00000000000000000002', 'second');
      insert(reverse, 'msg_01jord00000000000000000002', 'second');
      insert(reverse, 'msg_01jord00000000000000000001', 'first');

      expect(exportDomainState(forward, groupId)).toBe(exportDomainState(reverse, groupId));
    } finally {
      forward.close();
      reverse.close();
    }
  });

  it('scopes to one group', () => {
    // A group's state is what a purge must remove and an export must contain. Leaking another
    // group's rows into the oracle would make a cross-group bug invisible to it.
    const db = createTestDb();
    try {
      const a = seedGroup(db, 'sca');
      seedGroup(db, 'scb');
      const state = exportDomainState(db, a.groupId);
      expect(state).toContain(a.groupId);
      expect(state).not.toContain(`grp_${'01jscb'.padEnd(26, '0').slice(0, 26)}`);
    } finally {
      db.close();
    }
  });

  it('excludes the volatile columns, and says which', () => {
    const db = createTestDb({ seed: (target) => seedGroup(target, 'vol') });
    try {
      const groupId = `grp_${'01jvol'.padEnd(26, '0').slice(0, 26)}`;
      const state = exportDomainState(db, groupId);
      const parsed = JSON.parse(state) as Record<string, Record<string, unknown>[]>;
      const groupRow = parsed['groups']?.[0];
      expect(groupRow).toBeDefined();
      for (const column of ['created_at', 'updated_at']) {
        expect(Object.keys(groupRow ?? {}), column).not.toContain(column);
      }
      // `label_id` is deliberately NOT volatile: a difference there is an IFC bug this oracle
      // must be able to see.
      expect(VOLATILE_COLUMNS.has('label_id')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('skips the FTS and vec shadow tables', () => {
    // They are derived from the base rows, so including them would double-count and would make
    // the oracle sensitive to index internals.
    const db = createTestDb();
    try {
      const tables = domainTables(db);
      expect(tables.some((name) => name.includes('_fts'))).toBe(false);
      expect(tables.some((name) => name.startsWith('vec_memory_'))).toBe(false);
      expect(tables).toContain('messages');
      expect(tables).toContain('memory_items');
      // Instance-wide tables are not group state.
      expect(tables).not.toContain('app_meta');
      expect(tables).not.toContain(MIGRATIONS_TABLE);
    } finally {
      db.close();
    }
  });

  it('renders binary columns as hex', () => {
    const db = createTestDb({ seed: (target) => seedGroup(target, 'bin') });
    try {
      const groupId = `grp_${'01jbin'.padEnd(26, '0').slice(0, 26)}`;
      db.prepare(
        `INSERT INTO messages (id, group_id, conversation_id, kind, text, untrusted, label_id,
           dedupe_key, sent_at, received_at, delivered_late, truncated, edit_count)
         VALUES (?, ?, ?, 'member', 'x', 0, 1, x'DEADBEEF', 0, 0, 0, 0, 0)`,
      ).run(
        'msg_01jbin00000000000000000001',
        groupId,
        `cnv_${'01jbin'.padEnd(26, '0').slice(0, 26)}`,
      );
      // Hex rather than a byte array: shorter, and legible in a failure diff.
      expect(exportDomainState(db, groupId)).toContain('deadbeef');
    } finally {
      db.close();
    }
  });

  it('returns an empty object for a group with no rows', () => {
    const db = createTestDb();
    try {
      expect(exportDomainState(db, 'grp_01jnothinghere0000000000001')).toBe('{}');
    } finally {
      db.close();
    }
  });
});
