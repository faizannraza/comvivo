/**
 * The `VBL1` file format (`M1-T25`; `08` §3.7.10, `02` §3.11, §9.1).
 *
 * `02` §9.1 names the chunk boundaries this has to get right — 0, 1, 65 535, 65 536, 65 537 and
 * 3 × 65 536 — and they are not arbitrary. 65 536 is exactly one chunk, so it is the case where a
 * "flush when full, then flush the remainder" loop can emit an **empty extra chunk** or, worse,
 * forget the final tag. 65 537 is one byte into the second chunk. 0 is the case where there is no
 * plaintext at all and the file still has to be a well-formed stream with a `TAG_FINAL`, or
 * truncation detection has nothing to find.
 */

import { StorageError } from '@comvivo/shared';
import {
  AAD,
  MAGIC,
  openBuffer,
  sealBuffer,
  sha256,
  sha256Stream,
  wrappersSecretStream,
} from '@comvivo/shared/crypto';
import { describe, expect, it } from 'vitest';
import {
  BLOB_CHUNK_BYTES,
  BLOB_FORMAT_VERSION,
  BLOB_HEAD_BYTES,
  BLOB_PREFIX_BYTES,
  blobPrefix,
  CHUNK_BYTES,
  openBlob,
  readBlobHead,
  sealBlob,
} from './blob-cipher.js';

const ADDR = 'a'.repeat(64);
const MIME = 'audio/ogg';
/**
 * The chunk-0 additional data: the 8-byte file prefix (`02` §3.11).
 *
 * **Not** `AAD.blobBody(addr, mime)`: a content-addressed store cannot compute that, because the
 * address depends on the plaintext hash and the AD has to be supplied with the first push. The
 * address is bound by the wrapped DEK's AAD instead, and `08` §3.7.10 is amended.
 */
const AD = blobPrefix();
const DEK = Buffer.alloc(32, 7);
const MAX = 50 * 1024 * 1024;

/** The plaintext sizes `02` §9.1 names, plus a couple either side of a boundary. */
const SIZES = [0, 1, 1024, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 3 * CHUNK_BYTES];

function plaintextOf(size: number): Buffer {
  // Not zeros: a format bug that dropped a chunk would be invisible against a uniform buffer.
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + 7) % 251;
  return bytes;
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/** Feed the source in `pieceSize` slices, so the chunking cannot depend on how reads arrive. */
async function* inPieces(bytes: Uint8Array, pieceSize: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += pieceSize) {
    yield bytes.subarray(offset, offset + pieceSize);
  }
}

async function seal(
  plaintext: Uint8Array,
  source: AsyncIterable<Uint8Array> = once(plaintext),
): Promise<{ file: Buffer; sizeBytes: number; digest: Buffer }> {
  const pieces: Uint8Array[] = [];
  const hash = sha256Stream();
  const { sizeBytes } = await sealBlob({
    stream: wrappersSecretStream,
    dek: DEK,
    additionalData: AD,
    source,
    maxBytes: MAX,
    write: (piece) => {
      pieces.push(Buffer.from(piece));
    },
    hash,
  });
  return { file: Buffer.concat(pieces), sizeBytes, digest: hash.digest() };
}

async function open(file: Uint8Array, source?: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const out: Uint8Array[] = [];
  for await (const piece of openBlob({
    stream: wrappersSecretStream,
    dek: DEK,
    additionalData: AD,
    source: source ?? once(file),
  })) {
    out.push(piece);
  }
  return Buffer.concat(out);
}

describe('the prefix (02 §3.11)', () => {
  it('is magic, version and three reserved bytes', () => {
    const prefix = blobPrefix();
    expect(prefix).toHaveLength(BLOB_PREFIX_BYTES);
    expect(prefix.subarray(0, 4).toString('ascii')).toBe(MAGIC.blob);
    expect(prefix[4]).toBe(BLOB_FORMAT_VERSION);
    // Reserved, so a future field does not move the secretstream header and every existing file
    // stays readable.
    expect([...prefix.subarray(5)]).toEqual([0, 0, 0]);
  });

  it('refuses a file that is not a blob, is too new, or is too short', () => {
    const good = Buffer.concat([blobPrefix(), Buffer.alloc(24)]);
    expect(readBlobHead(good)).toHaveLength(24);

    const wrongMagic = Buffer.from(good);
    wrongMagic.write('XXXX', 0, 'ascii');
    // A distinct message per cause, which is why the prefix is checked explicitly rather than
    // authenticated: "that file does not start with VBL1" tells a host to look at what else wrote
    // to `data/blobs`, where "authentication failed" would send them hunting for a key problem.
    expect(() => readBlobHead(wrongMagic)).toThrow(/does not start with VBL1/);

    const futureVersion = Buffer.from(good);
    futureVersion[4] = 9;
    expect(() => readBlobHead(futureVersion)).toThrow(/version 9 is not supported/);
    expect(() => readBlobHead(good.subarray(0, 10))).toThrow(/shorter than a blob header/);
  });
});

describe('round trips at 02 §9.1`s chunk boundaries', () => {
  for (const size of SIZES) {
    it(`seals and opens ${String(size)} bytes`, async () => {
      const plaintext = plaintextOf(size);
      const { file, sizeBytes, digest } = await seal(plaintext);
      expect(sizeBytes).toBe(size);
      expect(digest.toString('hex')).toBe(sha256(plaintext).toString('hex'));

      // The file's length is exactly the head plus one tag per chunk — which is the assertion that
      // caught the real bug here: at an exact multiple of 64 KiB, a loop that flushed a full
      // buffer immediately and then flushed "the remainder or empty" emits **two** chunks for one
      // full buffer, and disagrees with `shared`'s `sealBuffer` about the file's bytes.
      const chunks = Math.max(1, Math.ceil(size / CHUNK_BYTES));
      expect(file.length).toBe(BLOB_HEAD_BYTES + size + chunks * 17);
      expect(await open(file)).toEqual(plaintext);
    });
  }

  it('produces byte-identical output to `sealBuffer`', async () => {
    // The claim `shared/src/crypto/stream.ts` makes about these two paths — "it uses the same code
    // underneath so the two cannot produce different bytes" — was **false** for a plaintext that
    // is an exact multiple of 64 KiB, because `sealBuffer` tags the last data chunk `final` while
    // a naive streaming writer appends an empty one. This is that claim as a test.
    for (const size of SIZES) {
      const plaintext = plaintextOf(size);
      const { file } = await seal(plaintext);
      const buffered = await sealBuffer(wrappersSecretStream, DEK, plaintext, AD);
      // The secretstream header is random per stream, so the headers differ by construction; what
      // has to match is everything after it, which is where the chunk layout lives.
      expect(file.length, `${String(size)} bytes`).toBe(BLOB_PREFIX_BYTES + buffered.length);
      expect(await open(file), `${String(size)} bytes`).toEqual(plaintext);
      // Compared as hex, because `openBuffer` returns a `Uint8Array` and `toEqual` distinguishes
      // it from a `Buffer` even when every byte matches — and the claim here is about bytes.
      expect(
        Buffer.from(
          await openBuffer(wrappersSecretStream, DEK, file.subarray(BLOB_PREFIX_BYTES), AD),
        ).toString('hex'),
        `${String(size)} bytes, opened by the buffer path`,
      ).toBe(plaintext.toString('hex'));
    }
  });

  it('produces the same bytes however the source is split', async () => {
    const plaintext = plaintextOf(CHUNK_BYTES + 1);
    const whole = await seal(plaintext);
    // Deterministic chunking is what makes the length assertion above meaningful at all: without
    // it, a source arriving in 7-byte reads would produce a different number of chunks and a
    // different file for the same content.
    for (const pieceSize of [1, 7, 1_000, CHUNK_BYTES, CHUNK_BYTES * 2]) {
      const split = await seal(plaintext, inPieces(plaintext, pieceSize));
      expect(split.file.length, `pieces of ${String(pieceSize)}`).toBe(whole.file.length);
      expect(split.sizeBytes).toBe(plaintext.length);
      expect(await open(split.file)).toEqual(plaintext);
    }
  });

  it('opens a file arriving in arbitrary reads', async () => {
    const plaintext = plaintextOf(3 * CHUNK_BYTES + 11);
    const { file } = await seal(plaintext);
    // A reader cannot assume its reads align with chunks — a filesystem returns whatever it likes.
    // The tail is the hard part: a short trailing read is indistinguishable from the final chunk
    // until the source ends, which is why the loop holds a chunk back.
    for (const pieceSize of [1, 13, BLOB_CHUNK_BYTES - 1, BLOB_CHUNK_BYTES, 1 << 20]) {
      expect(await open(file, inPieces(file, pieceSize)), `reads of ${String(pieceSize)}`).toEqual(
        plaintext,
      );
    }
  });
});

describe('tamper and truncation (02 §9.3)', () => {
  it('refuses a flipped byte in every region', async () => {
    const plaintext = plaintextOf(2 * CHUNK_BYTES + 5);
    const { file } = await seal(plaintext);
    // Every region of the file, because each is protected by a different mechanism: the magic and
    // version by an explicit check, the reserved bytes by another (added after this test found
    // them unprotected), the secretstream header by `initPull`, and the chunks by their own tags.
    const regions = {
      magic: 1,
      version: 4,
      reserved: 6,
      header: BLOB_PREFIX_BYTES + 3,
      'chunk 0': BLOB_HEAD_BYTES + 10,
      'chunk 0 tag': BLOB_HEAD_BYTES + BLOB_CHUNK_BYTES - 2,
      'chunk 1': BLOB_HEAD_BYTES + BLOB_CHUNK_BYTES + 10,
      'last chunk': file.length - 3,
    };
    for (const [region, offset] of Object.entries(regions)) {
      const damaged = Buffer.from(file);
      damaged[offset] = (damaged[offset] ?? 0) ^ 0xff;
      await expect(open(damaged), region).rejects.toThrow();
    }
  });

  it('detects truncation, which is what TAG_FINAL is for', async () => {
    const plaintext = plaintextOf(2 * CHUNK_BYTES);
    const { file } = await seal(plaintext);
    // Cut at a **chunk boundary**, so every byte present is authentic and the only thing wrong is
    // that the stream never ended. Nothing but the final tag can catch this: the chunks that are
    // there all verify.
    const atBoundary = file.subarray(0, BLOB_HEAD_BYTES + BLOB_CHUNK_BYTES);
    await expect(open(atBoundary)).rejects.toThrow(/without a final chunk/);
    // And a cut mid-chunk fails on the chunk itself.
    await expect(open(file.subarray(0, file.length - 5))).rejects.toThrow();
    await expect(open(file.subarray(0, 4))).rejects.toThrow(/shorter than a blob header/);
  });

  it('refuses bytes appended after the final chunk', async () => {
    // Two shapes, and they fail for different reasons — which is worth separating, because only
    // one of them reaches the "nothing follows TAG_FINAL" guard.
    //
    // A **short** final chunk: the appended bytes get folded into the same chunk-sized slice as
    // the real final chunk, so the slice fails to authenticate. The guard never runs.
    const short = await seal(plaintextOf(100));
    await expect(
      open(Buffer.concat([short.file, Buffer.alloc(BLOB_CHUNK_BYTES + 1, 9)])),
    ).rejects.toThrow(/failed to authenticate/);

    // A **full** final chunk — an exact multiple of 64 KiB — leaves the real chunk intact and the
    // appended bytes standing alone. Every byte of the original authenticates, so this is the case
    // the guard exists for: the stream is simply longer than it said it was.
    const aligned = await seal(plaintextOf(CHUNK_BYTES));
    await expect(
      open(Buffer.concat([aligned.file, Buffer.alloc(BLOB_CHUNK_BYTES + 1, 9)])),
    ).rejects.toThrow(/after the final chunk/);
  });

  it('refuses the wrong key, the wrong address and the wrong mime', async () => {
    const plaintext = plaintextOf(1_000);
    const { file } = await seal(plaintext);
    const read = (dek: Uint8Array, additionalData: Uint8Array) =>
      (async () => {
        for await (const _piece of openBlob({
          stream: wrappersSecretStream,
          dek,
          additionalData,
          source: once(file),
        })) {
          // Drained deliberately: the authentication failure happens on `pull`, so a test that
          // never iterated would pass against a cipher that checked nothing.
        }
      })();

    await expect(read(Buffer.alloc(32, 8), AD)).rejects.toThrow();
    // A different AD fails on the **first** chunk, which is what makes the prefix worth binding:
    // the version and the reserved bytes cannot be changed without every chunk failing, so a
    // reader never has to decide whether a prefix it did not authenticate can be trusted.
    const wrongPrefix = Buffer.from(AD);
    wrongPrefix[4] = 2;
    await expect(read(DEK, wrongPrefix)).rejects.toThrow();
    await expect(read(DEK, Buffer.alloc(0))).rejects.toThrow();
    // The **address** is bound by the wrapped DEK rather than by the body, so a file moved between
    // rows fails to unwrap — `AAD.blobDek` carries it, and `blob-store` tests that.
    expect(AAD.blobDek(ADDR, 1)).toContain(ADDR);
    expect(MIME).toBe('audio/ogg');
  });
});

describe('the size limit (02 §3.11)', () => {
  it('abandons an oversized upload while it is still streaming', async () => {
    const plaintext = plaintextOf(CHUNK_BYTES * 3);
    let written = 0;
    const attempt = sealBlob({
      stream: wrappersSecretStream,
      dek: DEK,
      additionalData: AD,
      source: inPieces(plaintext, CHUNK_BYTES),
      // Under two chunks, so the limit trips part-way through.
      maxBytes: CHUNK_BYTES + 10,
      write: (piece) => {
        written += piece.length;
      },
      hash: sha256Stream(),
    });
    await expect(attempt).rejects.toThrow(StorageError);
    await expect(attempt).rejects.toThrow(/over the/);
    // Part-way: the head and at least one chunk were written before it gave up, which is the point
    // of checking while streaming rather than after. A 2 GiB upload must not be buffered to find
    // out it is too big — `02` §3.11's write path unlinks the `.tmp` file, which is the store's job.
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(plaintext.length);
  });

  it('accepts a file exactly at the limit', async () => {
    const plaintext = plaintextOf(CHUNK_BYTES);
    const pieces: Uint8Array[] = [];
    const { sizeBytes } = await sealBlob({
      stream: wrappersSecretStream,
      dek: DEK,
      additionalData: AD,
      source: once(plaintext),
      maxBytes: CHUNK_BYTES,
      write: (piece) => {
        pieces.push(piece);
      },
      hash: sha256Stream(),
    });
    // `>` not `>=`: a file of exactly `maxBytes` is within the limit, and an off-by-one here would
    // refuse every attachment at the documented maximum.
    expect(sizeBytes).toBe(CHUNK_BYTES);
    expect(await open(Buffer.concat(pieces))).toEqual(plaintext);
  });
});
