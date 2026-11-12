/**
 * The backup manifest (`02` §3.14.3).
 *
 * One JSON file inside the archive, read by `restoreBackup` **before** anything is swapped in. It
 * is not metadata for a human — it is the set of facts a restore checks the extracted database
 * against, and each field earns its place by being something that can go wrong between writing an
 * archive and reading it years later:
 *
 *  - **`db.sha256`** catches a body that decrypted and is still not the file that was written — a
 *    truncated tar entry, a filesystem that lied about a write.
 *  - **`db.quickCheck`** records that the snapshot was sound *when taken*. A corrupt page that
 *    predates the backup would otherwise be faithfully preserved and restored.
 *  - **`tables`** is row counts per table, and it is the check that catches a *silently partial*
 *    restore: a tar that unpacked most of a 5 GB file, or a `VACUUM INTO` that ran out of disk.
 *    A hash would catch that too — but the counts also say *what* is missing, which is the
 *    difference between "restore failed" and "you have lost your messages but not your calendar".
 *  - **`schema.lastMigrationId`** against the binary's own migrations is what turns "this archive
 *    is from a newer version" into `SCHEMA_TOO_NEW` and a clear instruction, rather than a
 *    migration runner meeting a table it does not know.
 *  - **`app.sqlite3mc` and `app.sqliteVec`** are the native versions. A format change in either
 *    makes an archive unreadable in a way nothing else here would explain.
 *  - **`tzdataVersion`** is `02` §3.13.7's: restoring onto a host with different tzdata means every
 *    local-time field needs recomputing, and the archive is the only place the old version is
 *    recorded.
 *
 * `blobs.mode` distinguishes the two shapes `02` §3.14.1 produces: `shared` (the default — blob
 * files live in `backups/blobstore/` and are shared between archives, because they are immutable
 * and content-addressed) and `embedded` (`--portable`, one file to copy off-site).
 */
import { z } from '@comvivo/shared';
import { BACKUP_ENTRY, BACKUP_MANIFEST_FORMAT } from '@comvivo/shared/crypto';

/**
 * `02` §3.14.3's `format` literal, re-exported from the frozen set.
 *
 * It lived here as a literal and was still spelling the pre-`ADR-024` codename at `M1`'s exit
 * gate. Both halves of that are now fixed in one place: `shared/src/crypto/labels.ts` holds every
 * string whose change makes an existing archive unopenable, it is the file the brand guard
 * exempts and the rename codemod skips, and `labels.test.ts` pins the bytes.
 */
export { BACKUP_MANIFEST_FORMAT } from '@comvivo/shared/crypto';

/**
 * The three entry paths inside the archive, from `shared/src/crypto/labels.ts`.
 *
 * Frozen there rather than spelled here: `db/comvivo.db` is a path **inside a container format**,
 * so deriving it from `BRAND` would make every existing archive unreadable at the next rename —
 * which is the bar that file's exemption from the brand guard is set at.
 */
export const MANIFEST_DB_PATH = BACKUP_ENTRY.db;
export const MANIFEST_ENTRY = BACKUP_ENTRY.manifest;
export const BLOB_INDEX_ENTRY = BACKUP_ENTRY.blobIndex;

export const BackupManifestSchema = z.object({
  format: z.literal(BACKUP_MANIFEST_FORMAT),
  formatVersion: z.literal(1),
  createdAt: z.string().min(1),
  instanceId: z.string().min(1),
  app: z.object({
    version: z.string().min(1),
    node: z.string().min(1),
    sqlite: z.string().min(1),
    sqlite3mc: z.string().min(1),
    sqliteVec: z.string().min(1),
  }),
  schema: z.object({
    lastMigrationId: z.string().min(1),
    migrationCount: z.number().int().nonnegative(),
  }),
  db: z.object({
    path: z.literal(MANIFEST_DB_PATH),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().length(64),
    encrypted: z.boolean(),
    quickCheck: z.literal('ok'),
  }),
  /** Row counts per table. The check that catches a silently partial restore. */
  tables: z.record(z.string(), z.number().int().nonnegative()),
  /**
   * Tables whose `count(*)` the backing build refused, so the restore does not compare them.
   *
   * Optional, because an archive written before `M1`'s exit gate has no such field and must still
   * restore: absent reads as "nothing was skipped", which is what those archives meant.
   */
  tablesSkipped: z.array(z.string()).optional(),
  embeddingSpaces: z.array(
    z.object({
      id: z.string().min(1),
      model: z.string().min(1),
      dims: z.number().int().positive(),
      status: z.string().min(1),
    }),
  ),
  blobs: z.object({
    mode: z.enum(['shared', 'embedded']),
    count: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    index: z.literal(BLOB_INDEX_ENTRY),
  }),
  tzdataVersion: z.string().min(1),
});

export type BackupManifest = z.infer<typeof BackupManifestSchema>;

/** One line of `blobs.jsonl` (`02` §3.14.3). */
export const BlobIndexLineSchema = z.object({
  /** The content address — the file's name in `blobstore/`, without the extension. */
  addr: z.string().length(64),
  /** The **encrypted** size on disk, which is what a restore can check without a key. */
  sizeEnc: z.number().int().nonnegative(),
  groupId: z.string().min(1),
  /** The plaintext digest, from the `blobs` row. Never a filename (`M1-T25`). */
  sha256: z.string().length(64),
});

export type BlobIndexLine = z.infer<typeof BlobIndexLineSchema>;

/** Serialise the index, one object per line with a trailing newline. */
export function encodeBlobIndex(lines: readonly BlobIndexLine[]): string {
  return `${lines.map((line) => JSON.stringify(BlobIndexLineSchema.parse(line))).join('\n')}\n`;
}

/**
 * Parse `blobs.jsonl`.
 *
 * Blank lines are skipped and a malformed one throws with its **number**, because an index of ten
 * thousand blobs whose failure says only "invalid JSON" is an index nobody can repair. The line
 * number is also the only thing that distinguishes a truncated file — the common corruption — from
 * a wrong one.
 */
export function parseBlobIndex(text: string): readonly BlobIndexLine[] {
  const lines: BlobIndexLine[] = [];
  const rows = text.split('\n');
  for (const [index, row] of rows.entries()) {
    if (row.trim() === '') continue;
    const parsed = BlobIndexLineSchema.safeParse(JSON.parse(row));
    if (!parsed.success) {
      throw new Error(
        `${BLOB_INDEX_ENTRY} line ${String(index + 1)}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
    lines.push(parsed.data);
  }
  return lines;
}

/**
 * Compare two sets of row counts, returning the tables that differ.
 *
 * Reported as a list of differences rather than a boolean, for the reason in the header: a restore
 * that says "17 tables differ" is a restore nobody can act on, and the first difference is rarely
 * the informative one. Tables absent from one side count as zero, so a table that exists only in
 * the archive shows as a shortfall rather than vanishing from the comparison.
 */
export function tableCountDifferences(
  expected: Readonly<Record<string, number>>,
  actual: Readonly<Record<string, number>>,
  /**
   * Tables either side could not count, which are **not** differences.
   *
   * A `count(*)` some `vec0` builds refuse is skipped at backup time; if the restoring build
   * answers it, the union of the two key sets turned that into `expected 0 ≠ actual N` and the
   * archive was refused as corrupt. Found by the M1 exit gate's reviewer.
   */
  skipped: readonly string[] = [],
): readonly { readonly table: string; readonly expected: number; readonly actual: number }[] {
  const ignore = new Set(skipped);
  const names = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].toSorted();
  const differences: { table: string; expected: number; actual: number }[] = [];
  for (const table of names) {
    if (ignore.has(table)) continue;
    const left = expected[table] ?? 0;
    const right = actual[table] ?? 0;
    if (left !== right) differences.push({ table, expected: left, actual: right });
  }
  return differences;
}
