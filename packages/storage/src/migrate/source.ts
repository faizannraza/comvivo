/**
 * `MigrationSource` — reading migrations off disk in either drizzle-kit layout (`02` §3.12.1).
 *
 * Two layouts exist because `02` D16 pins drizzle-kit **0.31.11** for 1.0 and re-evaluates v1 at
 * M14. 0.31 writes flat `NNNN_name.sql` files indexed by `meta/_journal.json`; v1 writes a folder
 * per migration and has no journal. Reading both now means that upgrade is a decision rather than
 * a rewrite — and, more immediately, that the runner is not coupled to a generator version.
 *
 * ## The journal is an index, not the inventory
 *
 * In the flat layout the journal gives the **order**, which matters because `0010` sorts before
 * `0002` under some collations and because drizzle records a `when` timestamp that is the real
 * authoring order. But a `.sql` file that is not in the journal would then be silently skipped —
 * and that is a migration a developer wrote, committed, and never ran. So `list()` cross-checks
 * the two directions and raises `MIGRATION_FAILED` rather than quietly applying a subset.
 *
 * I hit exactly that while building `M1-T13`: `0001_search_and_guards.sql` was created with
 * `touch` instead of `drizzle-kit generate --custom`, so the file existed and the journal did not
 * mention it. Everything passed, because nothing yet read the journal.
 *
 * ## Checksums
 *
 * sha256 of the file's text with newlines normalised, because `migrations.lock.json` is compared
 * across platforms and a Windows checkout would otherwise produce a different digest for a byte
 * identical migration. The checksum covers the **raw file**, not the split statements, so a
 * whitespace-only edit after release still fails the lock — which is the point: `02` §3.12.1 says
 * generated SQL is never edited after release, and "never" includes reformatting.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StorageError } from '@comvivo/shared';
import { sha256Hex } from '@comvivo/shared/crypto';
import type { DataMigration } from './data/index.js';
import { dataMigrationFor } from './data/index.js';

/** drizzle's statement separator. */
export const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/** One migration, ready to apply. */
export interface Migration {
  /** The drizzle folder or file name, e.g. `0000_initial_schema`. */
  readonly id: string;
  /** Statements in order, already split on the breakpoint and trimmed of empties. */
  readonly sql: readonly string[];
  /** sha256 of the raw file, newline-normalised. */
  readonly checksum: string;
  /** The data migration with the same id, if one is registered (`02` §3.12.1). */
  readonly dataMigration?: DataMigration;
}

/** Where the runner gets its migrations. */
export interface MigrationSource {
  list(): readonly Migration[];
}

/** Which layout a directory is in. */
export type MigrationLayout = 'journal' | 'folder';

interface JournalEntry {
  readonly idx: number;
  readonly when: number;
  readonly tag: string;
}

/**
 * sha256 of `text`, with newlines normalised so the digest is platform-stable.
 *
 * Hashed through `@comvivo/shared`'s `sha256Hex` rather than `node:crypto` directly: `01` §4's
 * dependency rules confine `node:crypto` to `shared/crypto` and `storage/crypto`, and
 * dependency-cruiser enforces it. The rule is right — one place owns the primitives, so an
 * algorithm change or a FIPS constraint is one edit — and `CLAUDE.md` §2 says to fix the design
 * rather than widen the rule.
 */
export function checksumOf(text: string): string {
  return sha256Hex(text.replaceAll('\r\n', '\n'));
}

/** Split a migration file into statements, dropping blanks and comment-only fragments. */
export function splitStatements(sql: string): readonly string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((part) => part.trim())
    .filter((part) => part !== '' && !isCommentOnly(part));
}

/**
 * Whether a fragment is only comments.
 *
 * The generated guard migration starts with a banner, and `drizzle-kit generate --custom` leaves
 * comment-only stubs. Passing one to `exec` is harmless but it would be counted as an applied
 * statement, which makes the runner's own numbers wrong.
 */
function isCommentOnly(fragment: string): boolean {
  return fragment.split('\n').every((line) => line.trim() === '' || line.trim().startsWith('--'));
}

function readJournal(directory: string): readonly JournalEntry[] | undefined {
  const path = join(directory, 'meta', '_journal.json');
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { entries?: readonly JournalEntry[] };
  return parsed.entries ?? [];
}

/** Detect the layout: a `meta/_journal.json` means the 0.31 flat layout. */
export function detectLayout(directory: string): MigrationLayout {
  return readJournal(directory) === undefined ? 'folder' : 'journal';
}

/** The `.sql` files directly in `directory`, by name. */
function flatSqlFiles(directory: string): readonly string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function loadMigration(id: string, files: readonly string[]): Migration {
  // A folder-layout migration may hold more than one `.sql` file; concatenating them in name
  // order keeps the checksum covering everything that will run.
  const text = files.map((file) => readFileSync(file, 'utf8')).join(`\n${STATEMENT_BREAKPOINT}\n`);
  const dataMigration = dataMigrationFor(id);
  return {
    id,
    sql: splitStatements(text),
    checksum: checksumOf(text),
    ...(dataMigration === undefined ? {} : { dataMigration }),
  };
}

function listJournal(directory: string): readonly Migration[] {
  const entries = [...(readJournal(directory) ?? [])].sort(
    (left, right) => left.idx - right.idx || left.when - right.when,
  );
  const onDisk = new Set(flatSqlFiles(directory).map((name) => name.replace(/\.sql$/, '')));

  const missingFile = entries.filter((entry) => !onDisk.has(entry.tag)).map((entry) => entry.tag);
  if (missingFile.length > 0) {
    throw new StorageError(
      'MIGRATION_FAILED',
      `the migration journal names ${String(missingFile.length)} file(s) that do not exist`,
      {
        hint:
          'A migration was deleted but its journal entry was not, so the runner cannot apply it. ' +
          'Restore the file, or remove the entry from `meta/_journal.json` if it was never ' +
          'released.',
        detail: { missing: missingFile.join(', ') },
      },
    );
  }

  const tagged = new Set(entries.map((entry) => entry.tag));
  const unlisted = [...onDisk].filter((id) => !tagged.has(id)).sort();
  if (unlisted.length > 0) {
    throw new StorageError(
      'MIGRATION_FAILED',
      `${String(unlisted.length)} migration file(s) are not in the journal and would be skipped`,
      {
        hint:
          'Create migrations with `drizzle-kit generate` (or `--custom`), which writes the ' +
          'journal entry too. A file the journal does not list is never applied.',
        detail: { unlisted: unlisted.join(', ') },
      },
    );
  }

  return entries.map((entry) => loadMigration(entry.tag, [join(directory, `${entry.tag}.sql`)]));
}

function listFolders(directory: string): readonly Migration[] {
  const ids = readdirSync(directory)
    .filter((name) => name !== 'meta' && statSync(join(directory, name)).isDirectory())
    .sort();
  return ids.map((id) => {
    const inner = join(directory, id);
    const files = readdirSync(inner)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => join(inner, name));
    if (files.length === 0) {
      throw new StorageError('MIGRATION_FAILED', `migration ${id} contains no .sql file`, {
        hint: 'Each migration folder must hold at least one `.sql` file.',
        detail: { id },
      });
    }
    return loadMigration(id, files);
  });
}

/**
 * Read the migrations in `directory`, in the order they must be applied.
 *
 * @param directory a `migrations/` directory in either layout
 */
export function fileMigrationSource(directory: string): MigrationSource {
  return {
    list(): readonly Migration[] {
      if (!existsSync(directory)) {
        throw new StorageError('MIGRATION_FAILED', 'the migrations directory does not exist', {
          hint: 'This is a bug or a broken install: the migrations ship with the application.',
          detail: { directory },
        });
      }
      return detectLayout(directory) === 'journal'
        ? listJournal(directory)
        : listFolders(directory);
    },
  };
}

/** A source over an explicit list, for tests and for the snapshot-upgrade loop. */
export function staticMigrationSource(migrations: readonly Migration[]): MigrationSource {
  return { list: () => migrations };
}
