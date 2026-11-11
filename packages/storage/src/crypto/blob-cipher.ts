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

/** `02` §3.11's prefix: magic(4) ‖ version(1) ‖ reserved(3). */
export const BLOB_PREFIX_BYTES = 8;

/** The whole fixed head of the file: the prefix plus the secretstream header. */
export const BLOB_HEAD_BYTES = BLOB_PREFIX_BYTES + HEADER_BYTES;

/** `02` §3.11's `format version = 1`. */
export const BLOB_FORMAT_VERSION = 1;

/** One ciphertext chunk on the wire: 64 KiB of plaintext plus the 17-byte tag. */
export const BLOB_CHUNK_BYTES = CHUNK_BYTES + ABYTES;

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
  await options.stream.ready();
  const push = options.stream.initPush(options.dek);
  await options.write(Buffer.concat([blobPrefix(), Buffer.from(push.header)]));

  // One reusable buffer. Allocating per chunk would make a 50 MiB upload 800 allocations of 64 KiB,
  // which on a Pi is enough garbage to matter.
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let filled = 0;
  let total = 0;
  let first = true;

  const flush = async (tag: 'message' | 'final'): Promise<void> => {
    const sealed = push.push(
      buffer.subarray(0, filled),
      tag,
      // Only the first chunk carries the AD; the chaining carries it from there, so a later chunk
      // cannot be moved to the front without failing.
      first ? options.additionalData : undefined,
    );
    first = false;
    filled = 0;
    await options.write(sealed);
  };

  for await (const piece of options.source) {
    total += piece.length;
    if (total > options.maxBytes) {
      throw new StorageError(
        'BLOB_TOO_LARGE',
        `that attachment is over the ${String(options.maxBytes)}-byte limit`,
        {
          hint: 'Raise `blobs.maxBytes` if the host wants larger attachments, or ask the sender for a smaller file.',
          category: 'validation.failed',
        },
      );
    }
    options.hash.update(piece);
    let offset = 0;
    while (offset < piece.length) {
      // **One chunk is held back.** A full buffer is flushed only once more data has arrived to put
      // in it, so the last data chunk is the one that carries `TAG_FINAL` — rather than a full
      // `message` chunk followed by an empty `final` one.
      //
      // `02` §3.11's write path says "push(remaining **or empty**, TAG_FINAL)", which is the
      // obvious streaming form and produces that extra 17-byte chunk whenever the plaintext is an
      // exact multiple of 64 KiB. It is also **not what `shared`'s `sealBuffer` produces** — it
      // knows the whole plaintext and tags the last data chunk — so the two code paths disagreed
      // on the wire format for exactly-aligned content, while `sealBuffer`'s own comment claimed
      // they could not. One chunk of lookahead costs 64 KiB and makes that claim true, which is
      // worth more than literal fidelity to a parenthetical: a file format that differs between
      // two paths in the same codebase surfaces later as "backups one version wrote, another
      // cannot read". `02` §3.11 amended.
      if (filled === CHUNK_BYTES) await flush('message');
      const take = Math.min(CHUNK_BYTES - filled, piece.length - offset);
      buffer.set(piece.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
    }
  }
  // Always a final chunk, even for empty input: `TAG_FINAL` is what makes truncation detectable,
  // so a file without one is not valid.
  await flush('final');
  return { sizeBytes: total };
}

export interface OpenBlobOptions {
  readonly stream: SecretStream;
  readonly dek: Uint8Array;
  readonly additionalData: Uint8Array;
  /** The file's bytes, in order. Chunk-sized pieces are not required. */
  readonly source: AsyncIterable<Uint8Array>;
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
  await options.stream.ready();
  const framer = new BlobFramer(options);
  for await (const piece of options.source) {
    for (const message of framer.accept(piece)) yield message;
  }
  for (const message of framer.finish()) yield message;
}

/**
 * The framing half of `openBlob`, extracted because the loop was doing three things at once.
 *
 * Reading a `VBL1` file is: find the head, then cut the rest into chunk-sized pieces, then handle
 * whatever is left when the source ends. Those three are easy to read separately and were not
 * together — Biome's complexity score was right, and the hard part is the one this makes visible.
 *
 * **A chunk is only complete when a whole `BLOB_CHUNK_BYTES` has arrived.** A shorter tail may be
 * the final chunk or may be a partial read, and the two are indistinguishable until the source
 * ends — a filesystem returns whatever it likes. Decrypting early would reject a perfectly good
 * file that arrived in small reads, which is why the loop holds one chunk back.
 *
 * ## Why the pending bytes live in one fixed buffer
 *
 * The obvious accumulator is `pending = concat(pending, piece)`, and it is **quadratic in the
 * number of reads**: every piece recopies everything already waiting, so a file arriving in
 * one-byte reads copies about `bytes × chunk / 2`. A 1 MiB blob read a byte at a time is 34 GiB of
 * `memcpy` and takes half a minute; CI found this as a 6-second unit test on the slower of the two
 * Node legs, which is the only reason it was not shipped. A blob source is not always a 64 KiB
 * file read — `02` §3.11's fetch path hands over whatever the network produced — so the shape of
 * the reads is not ours to assume.
 *
 * So the pending bytes live in **one buffer of a fixed capacity**, with a start and an end index:
 * appending is a copy of the piece alone, taking a chunk advances `start`, and the buffer is
 * compacted in place only when `end` reaches the capacity. Every byte is copied exactly once on
 * the way in, plus at most one chunk per capacity-worth of input for the compaction — linear, with
 * no allocation per chunk. The capacity is two chunks plus a head, which is the most that can be
 * waiting: the drain loop holds one chunk back, and `#append` never takes more than fits.
 *
 * Copying on the way in rather than holding the caller's piece is also what makes the contract
 * safe. `sealBlob` copies each piece into its chunk buffer immediately, so a source that reuses
 * one buffer across reads works there; a framer that kept references would work with
 * `fs.createReadStream` and corrupt data for a source that recycles its buffer, and that
 * asymmetry between the two halves of one file format is exactly the kind of trap that is found
 * years later.
 */
class BlobFramer {
  readonly #options: OpenBlobOptions;
  #pull: ReturnType<SecretStream['initPull']> | undefined;
  /** The most that can be pending: the head, plus the chunk held back, plus one being filled. */
  static readonly #CAPACITY = BLOB_HEAD_BYTES + 2 * BLOB_CHUNK_BYTES;
  readonly #pending = Buffer.allocUnsafe(BlobFramer.#CAPACITY);
  #start = 0;
  #end = 0;
  #first = true;
  #sawFinal = false;

  constructor(options: OpenBlobOptions) {
    this.#options = options;
  }

  /** Take a piece of the file, yielding whatever complete chunks it completed. */
  *accept(piece: Uint8Array): Generator<Uint8Array> {
    let offset = 0;
    do {
      offset += this.#append(piece, offset);
      yield* this.#drain();
      // `#append` always takes at least one byte — `#drain` leaves at most one chunk pending and
      // the capacity is two — so this terminates. A `do` rather than a `while`, because an empty
      // piece must still get a chance to complete the head: a source may legitimately yield one.
    } while (offset < piece.length);
  }

  /** The source has ended: the remainder is the last chunk, and there must have been one. */
  *finish(): Generator<Uint8Array> {
    if (this.#pull === undefined) {
      throw integrity('the file is shorter than a blob header', 'It was truncated during a copy.');
    }
    // Possibly an empty-plaintext chunk, which is still `ABYTES` long — that is what an empty blob
    // looks like, and it still has to authenticate.
    if (this.#end > this.#start) yield this.#take(this.#end - this.#start);
    if (!this.#sawFinal) {
      throw new StorageError('BLOB_INTEGRITY', 'that blob file ends without a final chunk', {
        hint: 'The file was truncated. Restore it from a backup, or delete the row so the attachment is re-fetched.',
        category: 'io.failed',
      });
    }
  }

  /** Copy as much of `piece` from `offset` as fits, compacting first if it must. Returns how much. */
  #append(piece: Uint8Array, offset: number): number {
    if (this.#end === BlobFramer.#CAPACITY) {
      this.#pending.copyWithin(0, this.#start, this.#end);
      this.#end -= this.#start;
      this.#start = 0;
    }
    const take = Math.min(BlobFramer.#CAPACITY - this.#end, piece.length - offset);
    this.#pending.set(piece.subarray(offset, offset + take), this.#end);
    this.#end += take;
    return take;
  }

  /** Read the head once it has arrived, then yield every chunk that is certainly complete. */
  *#drain(): Generator<Uint8Array> {
    if (this.#pull === undefined) {
      if (this.#end - this.#start < BLOB_HEAD_BYTES) return;
      this.#pull = this.#options.stream.initPull(
        readBlobHead(this.#pending.subarray(this.#start, this.#start + BLOB_HEAD_BYTES)),
        this.#options.dek,
      );
      this.#start += BLOB_HEAD_BYTES;
    }
    while (this.#end - this.#start > BLOB_CHUNK_BYTES) {
      yield this.#take(BLOB_CHUNK_BYTES);
    }
  }

  #take(length: number): Uint8Array {
    if (this.#sawFinal) throw integrity('there are bytes after the final chunk', AFTER_FINAL_HINT);
    if (this.#pull === undefined) {
      throw integrity('the file is shorter than a blob header', 'It was truncated during a copy.');
    }
    const { message, tag } = this.#pull.pull(
      this.#pending.subarray(this.#start, this.#start + length),
      this.#first ? this.#options.additionalData : undefined,
    );
    this.#first = false;
    this.#start += length;
    if (tag === 'final') this.#sawFinal = true;
    return message;
  }
}

const AFTER_FINAL_HINT =
  'Something appended to the file. Restore it from a backup rather than trusting the prefix.';

function integrity(message: string, hint: string): StorageError {
  return new StorageError('BLOB_INTEGRITY', message, { hint, category: 'io.failed' });
}

/** Re-exported so a caller need not reach into `shared` for the chunk arithmetic. */
export { ABYTES, CHUNK_BYTES, HEADER_BYTES, StreamOpenFailed, StreamTruncated };
