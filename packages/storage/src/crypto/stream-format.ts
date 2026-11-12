/**
 * The framing both encrypted file formats share: `VBL1` blobs (`02` §3.11) and `VBK1` backups
 * (`08` §3.7.11).
 *
 * The two differ only in their **head** — a blob's is eight fixed bytes, a backup's is a magic, a
 * length and a canonical-JSON header of a few kilobytes — and in what their chunk-0 additional data
 * is. Everything after that is identical: a secretstream header, then 64 KiB plaintext chunks with
 * the last one carrying `TAG_FINAL`.
 *
 * Extracted at `M1-T27`, when the backup envelope needed the second copy. Not because duplication
 * is untidy: `M1-T25` shipped a format bug *caused* by a second implementation — `sealBuffer` tags
 * the last data chunk and a naive streaming writer appends an empty one, so the two produced
 * different bytes for the same content at exact multiples of 64 KiB while a comment claimed they
 * could not. A third implementation of the same framing is a third chance at that, and the two
 * subtleties below are exactly the kind that get re-derived differently:
 *
 *  - **One chunk of lookahead on write.** A full buffer is flushed only once more data has arrived
 *    to put in it, so the last *data* chunk is the one tagged `final` rather than a full `message`
 *    chunk followed by an empty `final`. That is what makes the streamed bytes identical to
 *    `sealBuffer`'s, and `02` §3.11 is amended to say so.
 *  - **One chunk held back on read.** A tail shorter than a whole chunk may be the final chunk or
 *    may be a partial read, and the two are indistinguishable until the source ends. Decrypting
 *    early would reject a perfectly good file that arrived in small reads.
 *
 * ## The pending bytes live in one fixed buffer
 *
 * The obvious read accumulator is `pending = concat(pending, piece)`, and it is **quadratic in the
 * number of reads**: every piece recopies everything already waiting, so a 1 MiB file arriving a
 * byte at a time is 34 GiB of `memcpy` and 3.6 seconds. CI found that as a 6-second unit test on
 * the Node 24 leg, two seconds inside a 5-second timeout — luck rather than a gate, which is why
 * `blob-format.test.ts` now has a budget assertion the quadratic version was re-run against.
 *
 * So the pending bytes live in one buffer of fixed capacity with a start and an end index:
 * appending copies the piece alone, taking a chunk advances `start`, and the buffer compacts in
 * place only when `end` reaches the capacity. Every byte is copied once on the way in, plus at
 * most one chunk per capacity-worth of input — linear, with no allocation per chunk. Copying on
 * the way in rather than holding the caller's piece is also what makes the contract safe for a
 * source that recycles one buffer across reads, which the write side already was.
 */
import type { StorageError } from '@comvivo/shared';
import { ABYTES, CHUNK_BYTES, type SecretStream } from '@comvivo/shared/crypto';

/** One ciphertext chunk on the wire: 64 KiB of plaintext plus the 17-byte tag. */
export const FRAMED_CHUNK_BYTES = CHUNK_BYTES + ABYTES;

export interface SealFramedOptions {
  readonly stream: SecretStream;
  readonly dek: Uint8Array;
  /** The format's own head, written before the secretstream header. */
  readonly head: Uint8Array;
  /** The chunk-0 additional data. Only chunk 0 carries it; the chaining carries it from there. */
  readonly additionalData: Uint8Array;
  readonly source: AsyncIterable<Uint8Array>;
  /** An upper bound on the plaintext, so a huge input is abandoned early. */
  readonly limit?: { readonly maxBytes: number; readonly error: () => StorageError } | undefined;
  /** Called with each piece of the file, in order, starting with the head. */
  readonly write: (piece: Uint8Array) => void | Promise<void>;
  /** Fed every plaintext byte, for a caller that needs a digest without a second pass. */
  readonly hash?: { update(data: Uint8Array): void } | undefined;
}

/**
 * Seal a stream, writing the head, the secretstream header and the chunks through `write`.
 *
 * The plaintext is **never** buffered whole: a 50 MiB attachment costs 64 KiB of memory, and a
 * 5 GB database backup costs the same. That is the difference between working and not working on a
 * Pi with 1 GiB.
 */
export async function sealFramed(
  options: SealFramedOptions,
): Promise<{ readonly sizeBytes: number }> {
  await options.stream.ready();
  const push = options.stream.initPush(options.dek);
  await options.write(Buffer.concat([Buffer.from(options.head), Buffer.from(push.header)]));

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
      first ? options.additionalData : undefined,
    );
    first = false;
    filled = 0;
    await options.write(sealed);
  };

  for await (const piece of options.source) {
    total += piece.length;
    if (options.limit !== undefined && total > options.limit.maxBytes) throw options.limit.error();
    options.hash?.update(piece);
    let offset = 0;
    while (offset < piece.length) {
      // The lookahead: flush only when the buffer is full *and* there is more to put in it.
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

/** What a format's head parser returns once it has enough bytes. */
export interface FramedHead {
  /** How many bytes the head and the secretstream header occupy together. */
  readonly consumed: number;
  /** The secretstream header, for `initPull`. */
  readonly streamHeader: Uint8Array;
}

export interface OpenFramedOptions {
  readonly stream: SecretStream;
  readonly dek: Uint8Array;
  readonly additionalData: Uint8Array;
  /** The file's bytes, in order. Chunk-sized pieces are not required. */
  readonly source: AsyncIterable<Uint8Array>;
  /**
   * Validate the format's head. Returns `undefined` when more bytes are needed.
   *
   * A callback rather than a byte count, because a head that is not validated is a head that is
   * not bound: `readBlobHead` names a wrong magic, an unsupported version and a set reserved byte
   * as three different failures, and `02` §3.11's "header tampering fails the chunk-0 AD" was
   * wrong about all three.
   */
  readonly readHead: (pending: Uint8Array) => FramedHead | undefined;
  /** The most the head may occupy, which sizes the read buffer. */
  readonly maxHeadBytes: number;
  /**
   * What to call this format in an error — `blob`, `backup`.
   *
   * Carried rather than left generic, because `M1-T25`'s finding was precisely that a message
   * naming the cause beats one that does not: "the file is shorter than a **blob** header" tells a
   * host which of `data/blobs` and `data/backups` to look in, and "shorter than its header" does
   * not. A generic framing must not cost the diagnostics the formats had.
   */
  readonly formatName: string;
  /** The error a truncated or over-long file raises — `BLOB_INTEGRITY` or `BACKUP_INTEGRITY`. */
  readonly integrity: (message: string, hint: string) => StorageError;
}

/** Open a framed file, yielding plaintext chunks. */
export async function* openFramed(options: OpenFramedOptions): AsyncGenerator<Uint8Array> {
  await options.stream.ready();
  const framer = new StreamFramer(options);
  for await (const piece of options.source) {
    for (const message of framer.accept(piece)) yield message;
  }
  for (const message of framer.finish()) yield message;
}

/**
 * The framing half of `openFramed`, a class because the loop was doing three things at once.
 *
 * Reading a framed file is: find the head, then cut the rest into chunk-sized pieces, then handle
 * whatever is left when the source ends. Those three are easy to read separately and were not
 * together — Biome's complexity score was right, and the hard part is the one this makes visible.
 */
class StreamFramer {
  readonly #options: OpenFramedOptions;
  #pull: ReturnType<SecretStream['initPull']> | undefined;
  readonly #capacity: number;
  readonly #pending: Buffer;
  #start = 0;
  #end = 0;
  #first = true;
  #sawFinal = false;

  constructor(options: OpenFramedOptions) {
    this.#options = options;
    // The most that can be pending: the head, plus the chunk held back, plus one being filled.
    this.#capacity = options.maxHeadBytes + 2 * FRAMED_CHUNK_BYTES;
    this.#pending = Buffer.allocUnsafe(this.#capacity);
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
      throw this.#options.integrity(
        `the file is shorter than a ${this.#options.formatName} header`,
        'It was truncated during a copy.',
      );
    }
    // Possibly an empty-plaintext chunk, which is still `ABYTES` long — that is what an empty file
    // looks like, and it still has to authenticate.
    if (this.#end > this.#start) yield this.#take(this.#end - this.#start);
    if (!this.#sawFinal) {
      throw this.#options.integrity(
        `that ${this.#options.formatName} file ends without a final chunk`,
        'The file was truncated. Restore it from a backup, or fetch it again.',
      );
    }
  }

  /** Copy as much of `piece` from `offset` as fits, compacting first if it must. */
  #append(piece: Uint8Array, offset: number): number {
    if (this.#end === this.#capacity) {
      this.#pending.copyWithin(0, this.#start, this.#end);
      this.#end -= this.#start;
      this.#start = 0;
    }
    const take = Math.min(this.#capacity - this.#end, piece.length - offset);
    this.#pending.set(piece.subarray(offset, offset + take), this.#end);
    this.#end += take;
    return take;
  }

  /** Read the head once it has arrived, then yield every chunk that is certainly complete. */
  *#drain(): Generator<Uint8Array> {
    if (this.#pull === undefined) {
      const head = this.#options.readHead(this.#pending.subarray(this.#start, this.#end));
      if (head === undefined) return;
      this.#pull = this.#options.stream.initPull(head.streamHeader, this.#options.dek);
      this.#start += head.consumed;
    }
    while (this.#end - this.#start > FRAMED_CHUNK_BYTES) {
      yield this.#take(FRAMED_CHUNK_BYTES);
    }
  }

  #take(length: number): Uint8Array {
    if (this.#sawFinal) {
      throw this.#options.integrity(
        'there are bytes after the final chunk',
        'Something appended to the file. Restore it from a backup rather than trusting the prefix.',
      );
    }
    if (this.#pull === undefined) {
      throw this.#options.integrity(
        `the file is shorter than a ${this.#options.formatName} header`,
        'It was truncated during a copy.',
      );
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
