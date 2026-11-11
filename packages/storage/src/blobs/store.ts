/**
 * The blob store (`02` §3.11; `08` §3.7.10).
 *
 * ## `put` is async and never inside a transaction
 *
 * `02` §3.11 says so at the signature, and `01` §14 A25 says why: an attachment arrives over the
 * network and is streamed to disk, which takes as long as the platform takes. A transaction held
 * open across that would hold SQLite's write lock for the duration — on a Pi, where the write lock
 * is the one resource everything waits on, a single large upload would stall every message in
 * every group.
 *
 * So the ordering is `02` §3.11's, and the failure modes are chosen rather than inherited:
 *
 *  - A crash before the rename leaves a `.tmp` file, swept after 24 h.
 *  - A crash between the rename and the row leaves an **orphan file** at its final path with no
 *    row. Harmless: the next `put` of the same content overwrites it, and orphan GC removes it.
 *  - A row therefore never exists without its file — except after somebody deletes a file from
 *    outside, which surfaces as `BLOB_MISSING_FILE` on read rather than as a silent empty
 *    attachment.
 *
 * The reverse ordering — row first, then file — would produce the one state the product cannot
 * represent: a message with an attachment whose bytes are not there.
 *
 * ## The per-address mutex
 *
 * `02` §3.11 puts steps 5–7 under an in-process mutex keyed by the address, and the GC sweep takes
 * the same one. Without it, two concurrent `put`s of the *same* content both see no row, both
 * rename onto the same path and both insert — one gets a constraint error after having already
 * overwritten the other's file. A single-process product (`01` §8) makes an in-process mutex
 * sufficient; a second writer process would need the database for this, which is why `02` §3.7.2
 * has one write connection.
 */

import { createReadStream } from 'node:fs';
import { mkdir, open as openFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlobStorePort, TxToken } from '@comvivo/core';
import { type GroupId, type Logger, StorageError } from '@comvivo/shared';
import {
  AAD,
  blobAddress,
  // `randomBytes` from here rather than `node:crypto`: `01` §4's
  // `crypto-only-in-shared-crypto-and-storage-crypto` rule confines the primitive to the two
  // places audited for it, and a per-blob DEK is exactly the kind of value that should come from
  // there. The rule caught the direct import rather than being weakened for it (`CLAUDE.md` §2).
  randomBytes,
  type SecretStream,
  sha256Stream,
  unwrap,
  wrap,
} from '@comvivo/shared/crypto';
import { and, asc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import { blobPrefix, openBlob, sealBlob } from '../crypto/blob-cipher.js';
import { syncDirectory } from '../datadir/atomic.js';
import { DIR_MODE, FILE_MODE } from '../datadir/layout.js';
import type { Db } from '../db/drizzle.js';
import { maybeOne } from '../db/drizzle.js';
import { blobs, messageAttachments } from '../schema/index.js';
import {
  assertAddress,
  BLOB_TMP_EXTENSION,
  blobDir,
  blobPath,
  blobTmpDir,
  isBlobFile,
} from './paths.js';

/** `02` §3.11's limits. */
export interface BlobLimits {
  readonly maxBytes: number;
  readonly groupQuotaBytes: number;
  /** 0 means unlimited (`02` §3.11). */
  readonly instanceQuotaBytes: number;
  readonly minFreeBytes: number;
  /** How long an unreferenced blob survives before the sweep takes it. */
  readonly gcGraceHours: number;
}

export const BLOB_LIMITS: BlobLimits = {
  maxBytes: 52_428_800,
  groupQuotaBytes: 2 * 1024 * 1024 * 1024,
  instanceQuotaBytes: 0,
  minFreeBytes: 1024 * 1024 * 1024,
  gcGraceHours: 24,
};

export interface BlobRow {
  readonly groupId: GroupId;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mime: string;
  readonly storageAddr: string;
  readonly kekVersion: number;
  readonly state: 'stored' | 'deleting';
  readonly createdAt: Temporal.Instant;
  readonly unreferencedSince: Temporal.Instant | undefined;
}

export interface PutResult {
  readonly sha256: string;
  readonly storageAddr: string;
  readonly sizeBytes: number;
  /** True when the content was already stored for this group, so nothing new was written. */
  readonly deduped: boolean;
}

/** What the store needs from the key service, named narrowly (`01` §4). */
export interface BlobKeys {
  readonly blobKek: Uint8Array;
  readonly blobIdKey: Uint8Array;
  readonly generation: number;
}

export interface BlobStoreOptions {
  readonly db: Db;
  readonly blobsDir: string;
  readonly stream: SecretStream;
  /** Read per call rather than captured, so a `rotate-data` mid-run is picked up. */
  readonly keys: () => BlobKeys;
  readonly logger: Logger;
  readonly limits?: Partial<BlobLimits> | undefined;
  /** Free space on the blobs filesystem, injected so a test can simulate a full disk. */
  readonly freeBytes?: (() => Promise<number>) | undefined;
}

export class BlobStore implements BlobStorePort {
  readonly #options: BlobStoreOptions;
  readonly #limits: BlobLimits;
  /** `02` §3.11's per-address mutex: a promise chain per address, deleted when it drains. */
  readonly #locks = new Map<string, Promise<void>>();

  constructor(options: BlobStoreOptions) {
    this.#options = options;
    this.#limits = { ...BLOB_LIMITS, ...options.limits };
  }

  /* ───────────────────────────── Reads ───────────────────────────── */

  stat(groupId: GroupId, sha256: string): BlobRow | undefined {
    const row = maybeOne(
      this.#options.db
        .select()
        .from(blobs)
        .where(and(eq(blobs.groupId, groupId), eq(blobs.sha256, sha256))),
    );
    return row === undefined ? undefined : toBlobRow(row);
  }

  /** What a group is using, for the quota check and for the dashboard. */
  usedBytes(groupId: GroupId): number {
    const row = maybeOne(
      this.#options.db
        .select({ total: sql<number>`coalesce(sum(${blobs.sizeBytes}), 0)` })
        .from(blobs)
        .where(eq(blobs.groupId, groupId)),
    );
    return row?.total ?? 0;
  }

  /**
   * Stream a blob's plaintext, verifying it at EOF.
   *
   * `02` §3.11: "Consumers must treat the content as unconfirmed until the stream closes
   * successfully." That is not a nicety — the hash check is the last thing to happen, so a consumer
   * that acted on the first chunk acted on bytes whose row binding had not been confirmed.
   */
  async *open(groupId: GroupId, sha256: string): AsyncGenerator<Uint8Array> {
    const row = this.stat(groupId, sha256);
    if (row === undefined) {
      throw new StorageError('BLOB_MISSING_FILE', 'there is no blob with that hash', {
        hint: 'The attachment row points at a blob this group does not have. `village doctor --check blobs` lists them.',
        category: 'io.failed',
      });
    }
    const path = blobPath(this.#options.blobsDir, row.storageAddr);
    const dek = this.#unwrapDek(row);
    const hash = sha256Stream();
    try {
      for await (const piece of openBlob({
        stream: this.#options.stream,
        dek,
        // The same AD the seal used: the 8-byte prefix. See `put` for why it is not the address.
        additionalData: blobPrefix(),
        source: createReadStream(path),
      })) {
        hash.update(piece);
        yield piece;
      }
    } catch (error) {
      if (isMissingFile(error)) throw missingFile(row.storageAddr);
      throw error;
    } finally {
      dek.fill(0);
    }
    const digest = hash.digest().toString('hex');
    if (digest !== row.sha256) {
      // The last line of defence, and the only one that catches a file whose **row** was rewritten
      // wholesale: a consistent file under a consistent DEK, wrapped under a consistent address,
      // whose contents are simply not what the row says they are.
      throw new StorageError('BLOB_INTEGRITY', 'that blob does not hash to what its row says', {
        hint: 'The file and the row disagree. Restore from a backup; the attachment cannot be trusted.',
        category: 'io.failed',
      });
    }
  }

  /* ───────────────────────────── Writing ───────────────────────────── */

  /**
   * `02` §3.11's write path, step by step. **Never call inside a transaction.**
   *
   * `write` is the caller's transaction runner — `store.write` — because steps 1, 5 and 7 are
   * database work and steps 2–4 and 6 are not. Taking it as a function is what keeps the long
   * streaming part outside any transaction while the short database parts are each in one.
   */
  async put(options: {
    readonly groupId: GroupId;
    readonly mime: string;
    readonly source: AsyncIterable<Uint8Array>;
    /** The caller's transaction runner. Each step that needs one opens its own. */
    readonly write: <T>(fn: (uow: TxToken) => T) => T;
    /** What the platform said the size is, for the quota pre-check. */
    readonly declaredSize?: number | undefined;
  }): Promise<PutResult> {
    // ── 1. Quota and disk, before anything is written. A pre-check on the declared size is
    // advisory — platforms lie, and the real limit is enforced while streaming — but it turns the
    // common "this is far too big" case into an immediate refusal rather than a 50 MiB download.
    const used = options.write(() => this.usedBytes(options.groupId));
    const declared = options.declaredSize ?? 0;
    if (used + declared > this.#limits.groupQuotaBytes) {
      throw new StorageError('BLOB_QUOTA_EXCEEDED', 'that group has used its attachment quota', {
        hint: `The group holds ${String(used)} of ${String(this.#limits.groupQuotaBytes)} bytes. Delete some attachments or raise \`blobs.groupQuotaBytes\`.`,
        category: 'validation.failed',
      });
    }
    await this.#assertDiskSpace();

    // ── 2. A fresh DEK and a temporary file.
    const keys = this.#options.keys();
    const dek = randomBytes(32);
    const tmpDir = blobTmpDir(this.#options.blobsDir);
    await mkdir(tmpDir, { recursive: true, mode: DIR_MODE });
    const tmpPath = join(tmpDir, `${randomBytes(16).toString('hex')}${BLOB_TMP_EXTENSION}`);
    const hash = sha256Stream();

    let sizeBytes = 0;
    let sha256: string;
    let storageAddr: string;
    const handle = await openFile(tmpPath, 'wx', FILE_MODE);
    try {
      // ── 3–4. Stream, hash, and compute the address at EOF.
      //
      // **The chunk-0 AD is the 8-byte prefix**, which is `02` §3.11's answer and the only one
      // that works. `08` §3.7.10 asks for `AAD.blobBody(addr, mime)`, and a content-addressed
      // store **cannot compute it**: `addr = HMAC(K_blobid, groupId ‖ 0 ‖ sha256)` depends on the
      // plaintext hash, which is only known at EOF, while a secretstream's additional data has to
      // be supplied with the *first* push. The alternatives are both refused by `02` §3.11 —
      // buffering the whole plaintext to hash it first (a 50 MiB attachment in memory on a Pi) or
      // a second pass over a network stream that cannot be rewound.
      //
      // So the address binding lives where it can: the **wrapped DEK's** AAD is
      // `AAD.blobDek(addr, gen)`, so a file swapped between rows fails to unwrap, and the store
      // checks `sha256(plaintext) === row.sha256` at EOF. That is exactly what `02` §3.11's
      // "Binding" paragraph says, and `08` §3.7.10 is amended to match.
      const sealed = await sealBlob({
        stream: this.#options.stream,
        dek,
        additionalData: blobPrefix(),
        source: options.source,
        maxBytes: this.#limits.maxBytes,
        write: async (piece) => {
          await handle.write(piece);
        },
        hash,
      });
      sizeBytes = sealed.sizeBytes;
      sha256 = hash.digest().toString('hex');
      storageAddr = this.#addressFor(keys, options.groupId, sha256);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(tmpPath).catch(() => undefined);
      dek.fill(0);
      throw error;
    }
    await handle.close();

    return this.#withLock(storageAddr, async () => {
      try {
        // ── 5. Dedupe. Only against `stored` rows, so a `put` cannot attach to a blob the sweep
        // is deleting (`02` §3.11 step 3 of GC).
        const existing = options.write(() => this.stat(options.groupId, sha256));
        if (existing !== undefined && existing.state === 'stored') {
          await unlink(tmpPath).catch(() => undefined);
          return {
            sha256,
            storageAddr: existing.storageAddr,
            sizeBytes: existing.sizeBytes,
            deduped: true,
          };
        }
        // ── 6. Rename into place and fsync the directory, so the file survives a power cut.
        const finalPath = blobPath(this.#options.blobsDir, storageAddr);
        await mkdir(blobDir(this.#options.blobsDir, storageAddr), {
          recursive: true,
          mode: DIR_MODE,
        });
        await rename(tmpPath, finalPath);
        await syncDirectory(blobDir(this.#options.blobsDir, storageAddr));

        // ── 7. The row, with the DEK wrapped under the blob KEK and bound to the address.
        const nonceAndSealed = wrap(keys.blobKek, dek, AAD.blobDek(storageAddr, keys.generation));
        options.write((uow) => {
          this.#options.db
            .insert(blobs)
            .values({
              groupId: options.groupId,
              sha256,
              sizeBytes,
              mime: options.mime,
              storageAddr,
              wrappedDek: nonceAndSealed.subarray(WRAP_NONCE_BYTES),
              wrapNonce: nonceAndSealed.subarray(0, WRAP_NONCE_BYTES),
              kekVersion: keys.generation,
              state: 'stored',
              createdAt: uow.now,
            })
            .onConflictDoUpdate({
              target: [blobs.groupId, blobs.sha256],
              // A `deleting` row being re-put: the file is back, so the row returns to `stored` and
              // the mark is cleared. Re-inserting would collide with the primary key, and deleting
              // first would open a window where the row is gone and the file is not.
              set: {
                state: 'stored',
                unreferencedSince: null,
                sizeBytes,
                mime: options.mime,
                storageAddr,
                wrappedDek: nonceAndSealed.subarray(WRAP_NONCE_BYTES),
                wrapNonce: nonceAndSealed.subarray(0, WRAP_NONCE_BYTES),
                kekVersion: keys.generation,
              },
            })
            .run();
        });
        return { sha256, storageAddr, sizeBytes, deduped: false };
      } finally {
        dek.fill(0);
      }
    });
  }

  /* ───────────────────────────── Garbage collection ───────────────────────────── */

  /**
   * `blob.gc` steps 1 and 2: mark what nothing references, unmark what is referenced again.
   *
   * Both directions in one pass, because a blob can become referenced again between sweeps — an
   * edited message re-attaching the same photo — and a mark that was never cleared would delete it
   * 24 hours later while it was in use.
   */
  mark(
    _uow: TxToken,
    now: Temporal.Instant,
  ): { readonly marked: number; readonly unmarked: number } {
    const referenced = sql`EXISTS (SELECT 1 FROM ${messageAttachments} a
      WHERE a.group_id = ${blobs.groupId} AND a.blob_sha256 = ${blobs.sha256})`;
    const marked = this.#options.db
      .update(blobs)
      .set({ unreferencedSince: now })
      .where(and(isNull(blobs.unreferencedSince), sql`NOT ${referenced}`))
      .returning({ sha256: blobs.sha256 })
      .all();
    const unmarked = this.#options.db
      .update(blobs)
      .set({ unreferencedSince: null })
      .where(and(isNotNull(blobs.unreferencedSince), referenced))
      .returning({ sha256: blobs.sha256 })
      .all();
    return { marked: marked.length, unmarked: unmarked.length };
  }

  /** `blob.gc` step 3: the rows marked long enough ago. */
  sweepable(now: Temporal.Instant, limit: number): readonly BlobRow[] {
    const cutoff = now.subtract({ hours: this.#limits.gcGraceHours });
    return this.#options.db
      .select()
      .from(blobs)
      .where(and(isNotNull(blobs.unreferencedSince), lt(blobs.unreferencedSince, cutoff)))
      .orderBy(asc(blobs.unreferencedSince))
      .limit(limit)
      .all()
      .map(toBlobRow);
  }

  /**
   * `blob.gc` step 3: delete one blob — row to `deleting`, unlink, then remove the row.
   *
   * Three steps rather than one, and in that order, because the file and the row cannot be removed
   * atomically. `deleting` first means a crash leaves a row nothing will dedupe against and a file
   * the next sweep removes; the reverse would leave a `stored` row with no file, which reads as
   * corruption rather than as garbage.
   */
  async sweep(row: BlobRow, write: <T>(fn: (uow: TxToken) => T) => T): Promise<boolean> {
    return this.#withLock(row.storageAddr, async () => {
      const claimed = write(() =>
        maybeOne(
          this.#options.db
            .update(blobs)
            .set({ state: 'deleting' })
            .where(
              and(
                eq(blobs.groupId, row.groupId),
                eq(blobs.sha256, row.sha256),
                // Still unreferenced: a `put` or an edit between `sweepable` and here re-attached
                // it, and deleting the bytes out from under a live attachment is the one outcome
                // the grace period exists to prevent.
                isNotNull(blobs.unreferencedSince),
              ),
            )
            .returning({ sha256: blobs.sha256 }),
        ),
      );
      if (claimed === undefined) return false;
      await unlink(blobPath(this.#options.blobsDir, row.storageAddr)).catch((error: unknown) => {
        // A file already gone is the state the sweep wants; anything else is a real failure and
        // must not leave the row behind claiming the blob is still there.
        if (!isMissingFile(error)) throw error;
      });
      write(() => {
        this.#options.db
          .delete(blobs)
          .where(and(eq(blobs.groupId, row.groupId), eq(blobs.sha256, row.sha256)))
          .run();
      });
      return true;
    });
  }

  /**
   * `blob.gc` step 4: files with no row, and abandoned `.tmp` parts.
   *
   * Both are crash residue — a `.tmp` from a crash before the rename, an orphan from a crash
   * between the rename and the row — and both are safe to remove once they are older than the
   * grace period, because a `put` in flight cannot have a file older than it has been running.
   */
  async sweepOrphans(now: Temporal.Instant, hasRow: (addr: string) => boolean): Promise<number> {
    const cutoff = now.subtract({ hours: this.#limits.gcGraceHours }).epochMilliseconds;
    let removed = 0;
    for (const path of await this.#listFiles()) {
      const info = await stat(path).catch(() => undefined);
      if (info === undefined || info.mtimeMs >= cutoff) continue;
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (name.endsWith(BLOB_TMP_EXTENSION)) {
        await unlink(path).catch(() => undefined);
        removed += 1;
        continue;
      }
      if (!isBlobFile(name)) continue;
      const addr = name.slice(0, 64);
      if (hasRow(addr)) continue;
      await unlink(path).catch(() => undefined);
      removed += 1;
    }
    return removed;
  }

  /** Every address that has a row, for `sweepOrphans`. */
  addresses(): ReadonlySet<string> {
    return new Set(
      this.#options.db
        .select({ addr: blobs.storageAddr })
        .from(blobs)
        .all()
        .map((row) => row.addr),
    );
  }

  /**
   * `blob.rewrap` (`02` §3.11): re-wrap stale DEKs under the current generation's KEK.
   *
   * The **files are not rewritten** — that is the whole point of wrapping a per-blob DEK. A
   * rotation touches a few hundred bytes per blob rather than re-encrypting gigabytes, which is
   * what makes `village keys rotate-data` something a host will actually run.
   */
  rewrap(_uow: TxToken, limit: number): number {
    const keys = this.#options.keys();
    const stale = this.#options.db
      .select()
      .from(blobs)
      .where(sql`${blobs.kekVersion} <> ${keys.generation}`)
      .limit(limit)
      .all();
    for (const row of stale) {
      const dek = this.#unwrapDek(toBlobRow(row));
      try {
        const sealed = wrap(keys.blobKek, dek, AAD.blobDek(row.storageAddr, keys.generation));
        this.#options.db
          .update(blobs)
          .set({
            wrappedDek: sealed.subarray(WRAP_NONCE_BYTES),
            wrapNonce: sealed.subarray(0, WRAP_NONCE_BYTES),
            kekVersion: keys.generation,
          })
          .where(and(eq(blobs.groupId, row.groupId), eq(blobs.sha256, row.sha256)))
          .run();
      } finally {
        dek.fill(0);
      }
    }
    return stale.length;
  }

  /**
   * Crypto-shred one blob: delete the wrapped DEK and the row, leaving the file unreadable.
   *
   * `08` §3.16.2's erasure path uses this. The file may survive on a filesystem that does not
   * really overwrite — an SSD, a snapshotting volume — and the DEK is the answer to that: without
   * it the bytes are indistinguishable from noise, so deleting 48 bytes from an encrypted database
   * is stronger than unlinking a file.
   */
  shred(_uow: TxToken, groupId: GroupId, sha256: string): boolean {
    const removed = maybeOne(
      this.#options.db
        .delete(blobs)
        .where(and(eq(blobs.groupId, groupId), eq(blobs.sha256, sha256)))
        .returning({ addr: blobs.storageAddr }),
    );
    return removed !== undefined;
  }

  /* ───────────────────────────── Internals ───────────────────────────── */

  /** `02` §3.11's address: `HMAC(K_blobid, groupId ‖ 0x00 ‖ sha256_bytes)`. */
  #addressFor(keys: BlobKeys, groupId: GroupId, sha256Hex: string): string {
    const addr = blobAddress(
      keys.blobIdKey,
      Buffer.concat([Buffer.from(groupId, 'utf8'), Buffer.of(0), Buffer.from(sha256Hex, 'hex')]),
    );
    assertAddress(addr);
    return addr;
  }

  #unwrapDek(row: BlobRow): Buffer {
    const stored = maybeOne(
      this.#options.db
        .select({ wrappedDek: blobs.wrappedDek, wrapNonce: blobs.wrapNonce })
        .from(blobs)
        .where(and(eq(blobs.groupId, row.groupId), eq(blobs.sha256, row.sha256))),
    );
    if (stored === undefined) throw missingFile(row.storageAddr);
    const keys = this.#options.keys();
    return unwrap(
      keys.blobKek,
      Buffer.concat([stored.wrapNonce, stored.wrappedDek]),
      AAD.blobDek(row.storageAddr, row.kekVersion),
    );
  }

  async #assertDiskSpace(): Promise<void> {
    const free = await this.#options.freeBytes?.();
    if (free === undefined) return;
    if (free < this.#limits.minFreeBytes) {
      throw new StorageError(
        'BLOB_DISK_LOW',
        'there is not enough free disk space for attachments',
        {
          hint: `Free space is ${String(free)} bytes and \`blobs.minFreeBytes\` is ${String(this.#limits.minFreeBytes)}. Free space or lower the threshold.`,
          category: 'io.failed',
        },
      );
    }
  }

  /** Every file under the blobs directory, two levels deep plus `.tmp`. */
  async #listFiles(): Promise<readonly string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < 2) await walk(path, depth + 1);
          continue;
        }
        out.push(path);
      }
    };
    await walk(this.#options.blobsDir, 0);
    return out;
  }

  /**
   * `02` §3.11's per-address mutex, as a promise chain.
   *
   * Each caller waits on whatever was in the map and puts its own completion there, so the
   * operations on one address serialise in arrival order. The entry is deleted only when the
   * waiter that put it there is still the one in the map — otherwise somebody has queued behind us
   * and owns it now. Without that check a long-running instance would accumulate one resolved
   * promise per attachment it had ever seen, which on a busy family group is thousands a month.
   */
  async #withLock<T>(addr: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(addr);
    let release = (): void => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(addr, mine);
    // `catch` rather than `await`: a failure in the previous holder is its caller's problem, and
    // propagating it here would fail an unrelated operation on the same address.
    if (previous !== undefined) await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.#locks.get(addr) === mine) this.#locks.delete(addr);
    }
  }
}

/** AES-256-GCM's nonce, which `wrap` prepends to its output (`08` §3.7.2). */
const WRAP_NONCE_BYTES = 12;

function toBlobRow(row: typeof blobs.$inferSelect): BlobRow {
  return {
    groupId: row.groupId,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    mime: row.mime,
    storageAddr: row.storageAddr,
    kekVersion: row.kekVersion,
    state: row.state,
    createdAt: row.createdAt,
    unreferencedSince: row.unreferencedSince ?? undefined,
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

function missingFile(addr: string): StorageError {
  return new StorageError('BLOB_MISSING_FILE', 'that blob file is not on disk', {
    hint: `The row for ${addr.slice(0, 12)}… has no file. Restore from a backup, or delete the attachment so it is re-fetched.`,
    category: 'io.failed',
  });
}
