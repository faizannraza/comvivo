/**
 * The blob index (`02` §3.3.8, §3.11; `08` §3.7.10).
 *
 * Attachment bytes live in files under the data directory, not in the database. This table is the
 * index, and every column in it exists to make one of three things possible.
 *
 * **Deduplication.** The primary key is `(group_id, sha256)` — the hash of the *plaintext*, scoped
 * to the group. Scoped, not global, because a global hash index would let one group learn that
 * another group holds the same file, which is invariant **I4** failing through a side channel.
 *
 * **Crypto-shredding.** Each blob has its own data key, stored here wrapped by the keyring's KEK
 * (`08` §3.7.10). Deleting `wrapped_dek` makes the file on disk permanently unreadable, which is
 * what lets a deletion complete in a transaction while the bytes are unlinked afterwards — and
 * what makes an erasure effective even against a backup of the file that has already been taken.
 *
 * **Garbage collection.** `storage_addr` is a keyed HMAC of the content rather than the hash
 * itself, so a file name on disk reveals nothing about what it contains and is not comparable
 * across instances (`sec.crypto.blob-id`, `M1-T25`). `unreferenced_since` is set when the last
 * referring row goes away, and `blobs_unref_idx` is the partial index the GC sweep walks (Q-BLOB-2)
 * — partial, so the index holds only the blobs that are candidates rather than every blob.
 */
import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { createdAt, instantMs, tid } from './_columns.js';
import { groups } from './groups.js';

export const blobs = sqliteTable(
  'blobs',
  {
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    /** Hex sha256 of the **plaintext**. Scoped to the group, never a global index (I4). */
    sha256: text('sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    mime: text('mime').notNull(),
    /** Hex keyed-HMAC address; also the file name on disk (`08` §3.7.10). */
    storageAddr: text('storage_addr').notNull().unique(),
    /** `08` `dekWrapped`: 32-byte DEK + 16-byte GCM tag. Deleting it crypto-shreds the blob. */
    wrappedDek: blob('wrapped_dek', { mode: 'buffer' }).notNull(),
    /** 12 bytes (AES-256-GCM). */
    wrapNonce: blob('wrap_nonce', { mode: 'buffer' }).notNull(),
    /** `08` `kekGen`: which keyring generation wrapped this DEK, so rotation can find stale rows. */
    kekVersion: integer('kek_version').notNull(),
    state: text('state', { enum: ['stored', 'deleting'] })
      .notNull()
      .default('stored'),
    createdAt: createdAt(),
    /** Set when the last referring row goes away; `NULL` while referenced. */
    unreferencedSince: instantMs('unreferenced_since'),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.sha256] }),
    // Q-BLOB-2: the GC sweep. Partial, so only candidates are indexed.
    index('blobs_unref_idx').on(t.unreferencedSince).where(sql`${t.unreferencedSince} IS NOT NULL`),
    check('blobs_size_ck', sql`${t.sizeBytes} >= 0`),
  ],
);
