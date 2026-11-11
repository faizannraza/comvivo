/**
 * The blob store port (`02` §3.7.1, §3.11; `01` §5).
 *
 * Three methods, and the narrowness is the point: `02` §4.1's consumers are the
 * `attachment.fetch` job, the `media.*` jobs and the export — none of which has any business
 * marking, sweeping or re-wrapping. Those are the store's own maintenance, reached by the
 * `blob.gc` and `blob.rewrap` jobs through the concrete class at the composition root.
 *
 * **Not on `UnitOfWork`**, and `01` §14 A25 is why: `put` streams an attachment from the network
 * to disk, which takes as long as the platform takes, and a transaction held open across it would
 * hold SQLite's write lock for the duration. On a Pi that stalls every message in every group. So
 * the store takes the caller's transaction runner and opens a short transaction per database step.
 */
import type { GroupId } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { TxToken } from './uow.js';

/** What `stat` reports about a stored blob. */
export interface BlobInfo {
  readonly groupId: GroupId;
  /** Hex sha256 of the **plaintext**, which is how a caller names a blob. */
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly mime: string;
  /** The keyed address, which is also the filename (`02` D14). Opaque to callers. */
  readonly storageAddr: string;
  readonly kekVersion: number;
  readonly state: 'stored' | 'deleting';
  readonly createdAt: Temporal.Instant;
  readonly unreferencedSince: Temporal.Instant | undefined;
}

export interface BlobPutResult {
  readonly sha256: string;
  readonly storageAddr: string;
  readonly sizeBytes: number;
  /** True when this group already held the content, so nothing new was written. */
  readonly deduped: boolean;
}

export interface BlobPutArgs {
  readonly groupId: GroupId;
  readonly mime: string;
  readonly source: AsyncIterable<Uint8Array>;
  /**
   * The caller's transaction runner.
   *
   * Passed in rather than held, because the store must **not** hold a transaction across the
   * stream — see the module note. Each database step opens its own.
   */
  readonly write: <T>(fn: (uow: TxToken) => T) => T;
  /** What the platform said the size is, for the quota pre-check. Advisory: platforms lie. */
  readonly declaredSize?: number | undefined;
}

export interface BlobStorePort {
  /** Store an attachment. **Never call inside a transaction** (`01` §14 A25). */
  put(args: BlobPutArgs): Promise<BlobPutResult>;
  /**
   * Stream a blob's plaintext.
   *
   * The content is **unconfirmed until the iterator completes** (`02` §3.11): the hash check is
   * the last thing to happen, so a consumer that acts on the first chunk is acting on bytes whose
   * binding to the row has not been confirmed. A `media.*` job must therefore buffer or re-read,
   * not pipe straight to a model.
   */
  open(groupId: GroupId, sha256: string): AsyncGenerator<Uint8Array>;
  stat(groupId: GroupId, sha256: string): BlobInfo | undefined;
  /** What a group is using, for the quota check and `09`'s storage panel. */
  usedBytes(groupId: GroupId): number;
}
