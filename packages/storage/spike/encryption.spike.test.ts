/**
 * SP-1 and SP-3: does the encrypted-SQLite stack actually work, and is a `VACUUM INTO` snapshot
 * encrypted? (`02` §3.6.3 steps 1–3, 7; criteria U1, U2, U4.)
 *
 * The one that matters most is **U2**. If WAL frames hold plaintext, then every promise this
 * product makes about a family's messages being safe on their own machine is false while the
 * process is running, and `02`'s decision matrix says *block* and fall back to D9. So the canary
 * test greps the raw bytes of the database, `-wal` and `-shm` for the plaintext in three
 * encodings, rather than asking SQLite whether it encrypted anything.
 *
 * Every test owns its directory via `withSpikeDir`. No module-level state.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import {
  DB_FILENAME,
  openSpikeDatabase,
  rowid,
  SpikeKeyInvalid,
  vec,
  withSpikeDir,
} from './open.js';

/**
 * `02` §3.6.3 step 3's canary, assembled from `BRAND` rather than written out.
 *
 * The brand guard refuses a hard-coded name anywhere but `brand.ts`, and it is right to even here:
 * a canary with the product's name baked in is one more string a rename has to find, and this one
 * is compared against raw disk bytes — so a stale copy would make the leak test search for the
 * wrong word and pass.
 */
const CANARY = `${BRAND.displayName.toUpperCase()}-CANARY-7f3a`;

/** Every byte of every file SQLite wrote, so a leak cannot hide in the one we forgot. */
function allBytes(dir: string): { file: string; bytes: Buffer }[] {
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isFile())
    .map((name) => ({ file: name, bytes: readFileSync(join(dir, name)) }));
}

/**
 * The canary in three encodings.
 *
 * A leak does not have to be ASCII: SQLite stores TEXT as UTF-8, FTS5 tokenises to lowercase, and
 * a UTF-16 copy could come from anywhere in the stack.
 */
const canaryForms = (): { label: string; bytes: Buffer }[] => [
  { label: 'utf8', bytes: Buffer.from(CANARY, 'utf8') },
  { label: 'utf8 lowercase', bytes: Buffer.from(CANARY.toLowerCase(), 'utf8') },
  { label: 'utf16le', bytes: Buffer.from(CANARY, 'utf16le') },
];

describe('the stack loads and reports its versions', { tags: ['db', 'slow'] }, () => {
  it('reports sqlite and sqlite-vec versions that meet `02` §3.6.2 assertVersions', () => {
    withSpikeDir((dir) => {
      const db = openSpikeDatabase({ path: join(dir, DB_FILENAME), key: randomBytes(32) });
      try {
        const sqlite = db.prepare('select sqlite_version() as v').get() as { v: string };
        const vecVersion = db.prepare('select vec_version() as v').get() as { v: string };
        const [major = 0, minor = 0] = sqlite.v.split('.').map(Number);
        expect(major * 1000 + minor).toBeGreaterThanOrEqual(3045);
        expect(vecVersion.v).toMatch(/^v0\.1\.\d+$/);
      } finally {
        db.close();
      }
    });
  });

  it('applies every `02` §3.6.2 pragma, each asserted by reading it back', () => {
    withSpikeDir((dir) => {
      const db = openSpikeDatabase({ path: join(dir, DB_FILENAME), key: randomBytes(32) });
      try {
        const one = (pragma: string): unknown => (db.pragma(pragma) as unknown[])[0];
        expect(one('journal_mode')).toMatchObject({ journal_mode: 'wal' });
        expect(one('synchronous')).toMatchObject({ synchronous: 1 });
        expect(one('foreign_keys')).toMatchObject({ foreign_keys: 1 });
        expect(one('secure_delete')).toMatchObject({ secure_delete: 1 });
        expect(one('cell_size_check')).toMatchObject({ cell_size_check: 1 });
        expect(one('wal_autocheckpoint')).toMatchObject({ wal_autocheckpoint: 1000 });
        expect(one('journal_size_limit')).toMatchObject({ journal_size_limit: 67_108_864 });
        // A non-zero `mmap_size` would read ciphertext pages straight past the codec.
        expect(one('mmap_size')).toMatchObject({ mmap_size: 0 });
      } finally {
        db.close();
      }
    });
  });
});

describe('U4 — a raw hex key skips the KDF', { tags: ['db', 'slow'] }, () => {
  it('opens 100 times with a p50 under 20 ms, which is what proves PBKDF2 is not running', () => {
    // `02` §3.6.3 step 2. A p50 materially above 20 ms means SQLCipher is deriving a key from a
    // passphrase — 256,000 PBKDF2 iterations — on every open, which it must not be: the key tree
    // in `08` §3.7 already did the derivation once, and paying it per connection would make the
    // worker pool and every CLI command slow for no security at all.
    withSpikeDir((dir) => {
      const key = randomBytes(32);
      const path = join(dir, DB_FILENAME);
      const durations: number[] = [];
      for (let i = 0; i < 100; i += 1) {
        const started = process.hrtime.bigint();
        const db = openSpikeDatabase({ path, key });
        db.close();
        durations.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      durations.sort((a, b) => a - b);
      const p50 = durations[Math.floor(durations.length / 2)] ?? Number.POSITIVE_INFINITY;
      expect(p50, `p50 open was ${p50.toFixed(2)} ms`).toBeLessThan(20);
    });
  });

  it('refuses the wrong key, and says so rather than returning nothing', () => {
    withSpikeDir((dir) => {
      const path = join(dir, DB_FILENAME);
      const db = openSpikeDatabase({ path, key: randomBytes(32) });
      db.exec('create table t (id integer primary key, s text)');
      db.prepare('insert into t (s) values (?)').run(CANARY);
      db.close();

      expect(() => openSpikeDatabase({ path, key: randomBytes(32) })).toThrow(SpikeKeyInvalid);
    });
  });

  it('refuses no key at all', () => {
    withSpikeDir((dir) => {
      const path = join(dir, DB_FILENAME);
      const db = openSpikeDatabase({ path, key: randomBytes(32) });
      db.exec('create table t (id integer primary key)');
      db.close();
      expect(() => openSpikeDatabase({ path, key: null })).toThrow(SpikeKeyInvalid);
    });
  });

  it('reopens with the right key and finds the row', () => {
    withSpikeDir((dir) => {
      const path = join(dir, DB_FILENAME);
      const key = randomBytes(32);
      const first = openSpikeDatabase({ path, key });
      first.exec('create table t (id integer primary key, s text)');
      first.prepare('insert into t (s) values (?)').run(CANARY);
      first.close();

      const second = openSpikeDatabase({ path, key });
      try {
        expect(second.prepare('select s from t').get()).toEqual({ s: CANARY });
      } finally {
        second.close();
      }
    });
  });
});

describe('U2 — nothing readable reaches the disk', { tags: ['db', 'slow'] }, () => {
  /** Write `count` canaries into a normal table, both FTS tokenizers and vec0. */
  const writeCanaries = (dir: string, count: number): void => {
    const db = openSpikeDatabase({ path: join(dir, DB_FILENAME), key: randomBytes(32) });
    try {
      db.exec('create table t (id integer primary key, s text)');
      db.exec("create virtual table fts_u using fts5(body, tokenize='unicode61')");
      db.exec("create virtual table fts_t using fts5(body, tokenize='trigram')");
      db.exec('create virtual table v using vec0(embedding float[4], note text)');

      const insertRow = db.prepare('insert into t (s) values (?)');
      const insertU = db.prepare('insert into fts_u(body) values (?)');
      const insertT = db.prepare('insert into fts_t(body) values (?)');
      const insertV = db.prepare('insert into v(rowid, embedding, note) values (?, ?, ?)');
      db.transaction(() => {
        for (let i = 0; i < count; i += 1) {
          insertRow.run(`${CANARY} ${String(i)}`);
          insertU.run(`${CANARY} ${String(i)}`);
          insertT.run(`${CANARY} ${String(i)}`);
          insertV.run(rowid(i + 1), vec([i, 0, 0, 1]), CANARY);
        }
      })();
    } finally {
      db.close();
    }
  };

  it('keeps 10k canaries out of the database, the WAL and the shm', () => {
    withSpikeDir((dir) => {
      writeCanaries(dir, 10_000);
      const files = allBytes(dir);
      // Non-vacuous: if SQLite wrote only one file, the WAL assertion below proves nothing.
      expect(files.map((f) => f.file)).toContain(DB_FILENAME);
      for (const { file, bytes } of files) {
        for (const form of canaryForms()) {
          expect(bytes.includes(form.bytes), `${file} contains the canary (${form.label})`).toBe(
            false,
          );
        }
      }
    });
  });

  it('keeps them out of the WAL while the connection is open, which is the real window', () => {
    // The previous test closes the database first, and closing checkpoints the WAL. A leak that
    // existed only between COMMIT and checkpoint would pass it — and that window is most of the
    // time the product is running.
    withSpikeDir((dir) => {
      const db = openSpikeDatabase({ path: join(dir, DB_FILENAME), key: randomBytes(32) });
      try {
        db.exec('create table t (id integer primary key, s text)');
        const insert = db.prepare('insert into t (s) values (?)');
        db.transaction(() => {
          for (let i = 0; i < 2000; i += 1) insert.run(`${CANARY} ${String(i)}`);
        })();
        const wal = allBytes(dir).find((f) => f.file.endsWith('-wal'));
        expect(wal, 'no -wal file existed, so this test proved nothing').toBeDefined();
        expect((wal?.bytes.length ?? 0) > 0).toBe(true);
        for (const form of canaryForms()) {
          expect(
            wal?.bytes.includes(form.bytes),
            `the WAL contains the canary (${form.label})`,
          ).toBe(false);
        }
      } finally {
        db.close();
      }
    });
  });

  it('does not start with the plaintext SQLite header', () => {
    withSpikeDir((dir) => {
      writeCanaries(dir, 10);
      const header = allBytes(dir)
        .find((f) => f.file === DB_FILENAME)
        ?.bytes.subarray(0, 16);
      expect(header?.toString('latin1')).not.toBe('SQLite format 3\0');
    });
  });

  it('is unreadable by the sqlite3 CLI, which is the demo a host can run themselves', () => {
    withSpikeDir((dir) => {
      writeCanaries(dir, 10);
      const probe = spawnSync('sqlite3', [join(dir, DB_FILENAME), 'select count(*) from t;'], {
        encoding: 'utf8',
      });
      if (probe.error !== undefined) {
        // No `sqlite3` on this machine. Say so rather than passing quietly.
        expect(probe.error.message).toContain('ENOENT');
        return;
      }
      expect(probe.status, 'the plain sqlite3 CLI opened an encrypted database').not.toBe(0);
      expect(`${probe.stderr}${probe.stdout}`).toMatch(/not a database|encrypted/i);
    });
  });
});

describe('U1 / SP-3 — is a VACUUM INTO snapshot encrypted?', { tags: ['db', 'slow'] }, () => {
  const snapshotInto = (dir: string, key: Buffer): string => {
    const snapshot = join(dir, 'snap.db');
    const db = openSpikeDatabase({ path: join(dir, DB_FILENAME), key });
    try {
      db.exec('create table t (id integer primary key, s text)');
      db.prepare('insert into t (s) values (?)').run(CANARY);
      db.prepare('VACUUM INTO ?').run(snapshot);
    } finally {
      db.close();
    }
    return snapshot;
  };

  it('produces an encrypted snapshot, so `VACUUM INTO` is usable for backups', () => {
    withSpikeDir((dir) => {
      const bytes = readFileSync(snapshotInto(dir, randomBytes(32)));
      // Non-vacuous: an empty or missing snapshot would satisfy every assertion below. The next
      // test goes further and reads the row back out of it.
      expect(bytes.length).toBeGreaterThan(4096);
      expect(bytes.subarray(0, 16).toString('latin1')).not.toBe('SQLite format 3\0');
      expect(
        bytes.includes(Buffer.from(CANARY, 'utf8')),
        'VACUUM INTO produced a PLAINTEXT snapshot: SP-3 fails, and `01` §14 A8 requires the ' +
          'online backup API instead. Update docs/architecture/storage-spike.md and M1-T27 before ' +
          'changing this assertion.',
      ).toBe(false);
    });
  });

  it('opens the snapshot with the same key and not without one', () => {
    withSpikeDir((dir) => {
      const key = randomBytes(32);
      const snapshot = snapshotInto(dir, key);

      const same = openSpikeDatabase({ path: snapshot, key, fileMustExist: true });
      try {
        expect(same.prepare('select s from t').get()).toEqual({ s: CANARY });
      } finally {
        same.close();
      }
      expect(() => openSpikeDatabase({ path: snapshot, key: null, fileMustExist: true })).toThrow(
        SpikeKeyInvalid,
      );
    });
  });
});
