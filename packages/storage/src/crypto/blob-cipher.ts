/**
 * The `VBL1` blob file format (`08` §3.7.10; `02` §3.11).
 *
 * ## What binds a file to its row
 *
 * A blob file cannot carry its own plaintext hash in the authenticated data, and `02` §3.11 says
 * why: the hash is only known at EOF, and a secretstream must be pushed in order. So the binding
 * is three separate things, each covering what the others cannot:
 *
 *  - **The chunk-0 AD is the 8-byte prefix**, as `02` §3.11 specifies. `08` §3.7.10 asks instead
 *    for `AAD.blobBody(addr, mime)`, and a content-addressed store **cannot compute it**:
 *    `addr = HMAC(K_blobid, groupId ‖ 0 ‖ sha256)` depends on the plaintext hash, which is only
 *    known at EOF, while a secretstream's additional data must be supplied with the *first* push.
 *    Buffering a 50 MiB attachment to hash it first, or taking a second pass over a network
 *    stream, are the two ways out and `02` §3.11 refuses both. `08` §3.7.10 is amended to match.
 *  - **The wrapped DEK's AAD** is `AAD.blobDek(addr, generation)`, so a file swapped between rows
 *    fails to unwrap — the address binding lives here, where it *can*.
 *  - **The EOF hash check**, in the store: `sha256(plaintext) === row.sha256`. The last line of
 *    defence, and the only one that catches a file whose row was rewritten wholesale.
 *
 * `02` §3.11 also said "header tampering fails the chunk-0 AD", which is not how it works either:
 * the prefix is checked *explicitly* on open — a clear `BLOB_INTEGRITY` naming the cause rather
 * than a generic authentication failure — and the secretstream header is bound by construction,
 * because `initPull` takes it and every chunk then fails if it moved. The three reserved bytes are
 * checked too, which a test found: with the prefix as the AD they are authenticated, but reading
 * has to *enforce* that they are zero or "reserved" means nothing and a v2 field would be silently
 * misread by a v1 reader.
 *
 * ## Why the prefix is 8 bytes and not 4
 *
 * `08` §3.7.10 writes the file as magic ‖ header; `02` §3.11 inserts a version byte and three
 * reserved bytes. `02`'s version wins, because a format with no version field cannot be changed
 * without a heuristic — and `12`'s upgrade story needs to be able to say "this is a v1 blob".
 */

import { StorageError } from '@comvivo/shared';
import {
  ABYTES,
  CHUNK_BYTES,
  HEADER_BYTES,
  MAGIC,
  type SecretStream,
  StreamOpenFailed,
  StreamTruncated,
} from '@comvivo/shared/crypto';
import { FRAMED_CHUNK_BYTES, openFramed, sealFramed } from './stream-format.js';

/** `02` §3.11's prefix: magic(4) ‖ version(1) ‖ reserved(3). */
export const BLOB_PREFIX_BYTES = 8;

/** The whole fixed head of the file: the prefix plus the secretstream header. */
export const BLOB_HEAD_BYTES = BLOB_PREFIX_BYTES + HEADER_BYTES;

/** `02` §3.11's `format version = 1`. */
export const BLOB_FORMAT_VERSION = 1;

/**
 * One ciphertext chunk on the wire: 64 KiB of plaintext plus the 17-byte tag.
 *
 * Re-exported from `stream-format.ts` rather than recomputed, so the two formats cannot drift on
 * the one number the framing depends on.
 */
export const BLOB_CHUNK_BYTES = FRAMED_CHUNK_BYTES;

/** Build the 8-byte prefix. Exported so a test can assert the layout byte by byte. */
export function blobPrefix(): Buffer {
  const prefix = Buffer.alloc(BLOB_PREFIX_BYTES);
  prefix.write(MAGIC.blob, 0, 'ascii');
  prefix[4] = BLOB_FORMAT_VERSION;
  // Bytes 5–7 stay zero. Reserved rather than omitted so the head is 8-byte aligned and a future
  // field does not move the secretstream header.
  return prefix;
}

/**
 * Validate the prefix and return the secretstream header.
 *
 * Explicit rather than authenticated, and deliberately: a wrong magic means "this is not a blob
 * file" and a wrong version means "this host is too old to read it", and both deserve a message
 * that says so. An AD check would collapse them into "authentication failed".
 */
export function readBlobHead(bytes: Uint8Array): Uint8Array {
  if (bytes.length < BLOB_HEAD_BYTES) {
    throw integrity('the file is shorter than a blob header', 'It was truncated during a copy.');
  }
  const magic = Buffer.from(bytes.subarray(0, 4)).toString('ascii');
  if (magic !== MAGIC.blob) {
    throw integrity(
      `that file does not start with ${MAGIC.blob}`,
      'The file at this address is not a blob. Check whether something else wrote to `data/blobs`.',
    );
  }
  const version = bytes[4];
  if (version !== BLOB_FORMAT_VERSION) {
    throw integrity(
      `blob format version ${String(version)} is not supported`,
      `This build reads version ${String(BLOB_FORMAT_VERSION)}. Upgrade before reading this blob.`,
    );
  }
  // The reserved bytes are **checked**, not ignored, and the test that flips one is how that was
  // found: with `AAD.blobBody` as the chunk-0 AD rather than `02` §3.11's 8-byte prefix, nothing
  // else covers them, so an ignored reserved byte would be three bytes of unauthenticated,
  // unexamined space inside an encrypted file.
  //
  // It is also the right forward-compatibility behaviour: a v2 that gives one of these a meaning
  // must be refused by a v1 reader rather than silently misread. "Reserved" only means something
  // if reading enforces it.
  if (bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) {
    throw integrity(
      'that blob file sets a reserved header byte',
      `Version ${String(BLOB_FORMAT_VERSION)} requires bytes 5-7 to be zero. A newer build may have written this file.`,
    );
  }
  return bytes.subarray(BLOB_PREFIX_BYTES, BLOB_HEAD_BYTES);
}

export interface SealBlobOptions {
  readonly stream: SecretStream;
  readonly dek: Uint8Array;
  /** `AAD.blobBody(addr, mime)` — the chunk-0 additional data (`08` §3.7.10). */
  readonly additionalData: Uint8Array;
  readonly source: AsyncIterable<Uint8Array>;
  /** `blobs.maxBytes`. Enforced while streaming, so a huge upload is abandoned early. */
  readonly maxBytes: number;
  /** Called with each piece of the file, in order, starting with the head. */
  readonly write: (piece: Uint8Array) => void | Promise<void>;
  /** Fed every plaintext byte, so the store gets its `sha256` without a second pass. */
  readonly hash: { update(data: Uint8Array): void };
}

/**
 * Seal a stream into `VBL1`, writing through `write` and hashing as it goes.
 *
 * The plaintext is **never** buffered whole: `02` §3.11's write path accumulates a 64 KiB chunk,
 * pushes it and writes it. A 50 MiB attachment therefore costs 64 KiB of memory rather than 50 MiB,
 * which is the difference between working and not working on a Pi with 1 GiB.
 *
 * Returns the plaintext size. The caller owns the hash, because it also needs it for the address.
 */
export async function sealBlob(options: SealBlobOptions): Promise<{ readonly sizeBytes: number }> {
  return sealFramed({
    stream: options.stream,
    dek: options.dek,
    head: blobPrefix(),
    additionalData: options.additionalData,
    source: options.source,
    limit: {
      maxBytes: options.maxBytes,
      error: () =>
        new StorageError(
          'BLOB_TOO_LARGE',
          `that attachment is over the ${String(options.maxBytes)}-byte limit`,
          {
            hint: 'Raise `blobs.maxBytes` if the host wants larger attachments, or ask the sender for a smaller file.',
            category: 'validation.failed',
          },
        ),
    },
    write: options.write,
    hash: options.hash,
  });
}

export interface OpenBlobOptions {
  readonly stream: SecretStream;
  readonly dek: Uint8Array;
  readonly additionalData: Uint8Array;
  /** The file's bytes, in order. Chunk-sized pieces are not required. */
  readonly source: AsyncIterable<Uint8Array>;
  /** Passed through to `openFramed`; see `OpenFramedOptions.onBytesCopied`. */
  readonly onBytesCopied?: (bytes: number) => void;
}

/**
 * Open a `VBL1` file, yielding plaintext chunks.
 *
 * Throws `BLOB_INTEGRITY` on a bad tag or a missing `TAG_FINAL`. The caller must treat the content
 * as unconfirmed until the iterator **completes**, which `02` §3.11 states and which this cannot
 * enforce — a consumer that acts on the first chunk is acting on unauthenticated data for every
 * chunk after it.
 */
export async function* openBlob(options: OpenBlobOptions): AsyncGenerator<Uint8Array> {
  yield* openFramed({
    stream: options.stream,
    dek: options.dek,
    additionalData: options.additionalData,
    source: options.source,
    ...(options.onBytesCopied === undefined ? {} : { onBytesCopied: options.onBytesCopied }),
    maxHeadBytes: BLOB_HEAD_BYTES,
    formatName: 'blob',
    // The head is fixed-length, so "enough bytes" is a length check — but it still goes through
    // `readBlobHead`, which names a wrong magic, an unsupported version and a set reserved byte as
    // three different failures rather than collapsing them into an authentication error.
    readHead: (pending) =>
      pending.length < BLOB_HEAD_BYTES
        ? undefined
        : { consumed: BLOB_HEAD_BYTES, streamHeader: readBlobHead(pending) },
    integrity,
  });
}

function integrity(message: string, hint: string): StorageError {
  return new StorageError('BLOB_INTEGRITY', message, { hint, category: 'io.failed' });
}

/** Re-exported so a caller need not reach into `shared` for the chunk arithmetic. */
export { ABYTES, CHUNK_BYTES, HEADER_BYTES, StreamOpenFailed, StreamTruncated };
