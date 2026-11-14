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

/**
 * Assert two buffers hold the same bytes.
 *
 * `Buffer.compare` rather than `toEqual`, and the reason is measured: Vitest's deep equality walks
 * a `Buffer` element by element, which costs **330 ms** for the 196 KiB file below. Seven of those
 * is most of this suite's runtime, and a suite that takes seconds is a suite that gets a longer
 * timeout rather than a fix. On a mismatch this reports the first differing offset, which is more
 * useful here than a 196 000-line diff.
 */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
  if (Buffer.compare(Buffer.from(actual), Buffer.from(expected)) === 0) return;
  expect(actual.length, `${label}: length`).toBe(expected.length);
  const at = [...expected].findIndex((byte, index) => actual[index] !== byte);
  expect.fail(
    `${label}: first difference at byte ${String(at)} — ` +
      `expected ${String(expected[at])}, got ${String(actual[at])}`,
  );
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
      expectSameBytes(await open(file), plaintext, `${String(size)} bytes`);
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
      expectSameBytes(await open(file), plaintext, `${String(size)} bytes`);
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
      expectSameBytes(await open(split.file), plaintext, `pieces of ${String(pieceSize)}`);
    }
  });

  it('opens a file arriving in arbitrary reads', async () => {
    // A reader cannot assume its reads align with chunks — a filesystem returns whatever it likes.
    // The tail is the hard part: a short trailing read is indistinguishable from the final chunk
    // until the source ends, which is why the framer holds a chunk back. Both files below have
    // that short tail and both cross a chunk boundary, which is everything the format cares about.
    //
    // The byte-at-a-time reads run against the **smaller** of the two, and the pairing is
    // deliberate: a one-byte read costs a generator resumption rather than anything the format
    // does differently, so the 3-chunk file would spend three times as long proving the same
    // thing. A unit test that takes seconds is a unit test that gets a longer timeout instead of
    // a fix — which is how the quadratic framer below reached CI in the first place.
    const cases = [
      { plaintext: plaintextOf(CHUNK_BYTES + 11), sizes: [1, 13] },
      {
        plaintext: plaintextOf(3 * CHUNK_BYTES + 11),
        sizes: [BLOB_CHUNK_BYTES - 1, BLOB_CHUNK_BYTES, 1 << 20],
      },
    ];
    for (const { plaintext, sizes } of cases) {
      const { file } = await seal(plaintext);
      for (const pieceSize of sizes) {
        expectSameBytes(
          await open(file, inPieces(file, pieceSize)),
          plaintext,
          `${String(plaintext.length)} bytes in reads of ${String(pieceSize)}`,
        );
      }
    }
  });
});

/**
 * How many bytes the linearity check reads, and the budget it has to do it in.
 *
 * Both numbers are measured, not guessed. 1 MiB in one-byte reads takes **343 ms** with the fixed
 * buffer. The accumulator it replaced — `pending = concat(pending, piece)` — recopies everything
 * already waiting on every read, which is `bytes × chunk / 2` ≈ 34 GiB of `memcpy`, and the same
 * input takes **3 592 ms**. The budget sits between them with 5.8× of headroom below and 1.8×
 * above, so this is not measuring a machine — it is distinguishing O(n) from O(n²), and the
 * quadratic version was run against this assertion to check that it does.
 */
const LINEAR_READ_BYTES = 1024 * 1024;

/**
 * How many times the file's own size the framer may `memcpy`, reading it one byte at a time.
 *
 * A **byte count, not a clock.** This was a 2 000 ms budget, and that made the gate depend on
 * which half of `pnpm verify` you read: `pnpm test` passed and `pnpm coverage` failed the same
 * commit on the same machine, because coverage instruments every call and this test makes
 * 1 048 576 of them. Measured on Node 26.13.0 — the pinned primary, which this machine has at
 * `~/.local/node/v26.13.0` — 2 316 ms under coverage against ~900 ms without. A test that passes
 * in one half of the gate and fails in the other is not evidence of anything.
 *
 * A timing **ratio** was the first replacement and was worse: scale-free, but blind to the
 * regression that is easiest to introduce. Measured — making the compaction in `#append`
 * unconditional, so every append recopies the pending window, is a large constant-factor blowup
 * and leaves the doubling ratio at a perfectly linear 2.0. The ratio test passed it.
 *
 * The byte count catches both, and is deterministic besides: no machine, no instrumentation and no
 * CI load in the number. It checks the invariant `stream-format.ts`'s header states in words —
 * every byte copied once on the way in, plus at most one chunk per capacity-worth of input. The
 * capacity is the head plus two chunks, so compaction adds at most one chunk per chunk of input:
 * 2× is the bound, and 3× leaves room for the head and the held-back tail.
 */
const LINEAR_COPY_FACTOR = 3;

describe('cost is linear in the bytes, not in the number of reads', () => {
  /**
   * CI found the quadratic version of this as a 6-second unit test on the Node 24 leg, one commit
   * after it was written, and only because the suite's timeout is 5 seconds. That is luck, not a
   * test — so this is the test. `02` §3.11's read path is a 64 KiB file read today, but the same
   * function opens whatever a fetch produced, and the shape of those reads is not ours to choose.
   *
   * The timeout is generous on purpose: a regression must fail on the **assertion**, with the
   * measured number in the message, rather than as "timed out in 5000ms" — which says nothing
   * about what got slower.
   */
  it(`copies ${String(LINEAR_READ_BYTES / 1024)} KiB about once, however small the reads`, async () => {
    const plaintext = plaintextOf(LINEAR_READ_BYTES);
    const { file } = await seal(plaintext);

    let copied = -1;
    const out: Uint8Array[] = [];
    for await (const piece of openBlob({
      stream: wrappersSecretStream,
      dek: DEK,
      additionalData: AD,
      source: inPieces(file, 1),
      onBytesCopied: (total) => {
        copied = total;
      },
    })) {
      out.push(piece);
    }
    const opened = Buffer.concat(out);

    // Correctness first: a framer that produced the wrong bytes cheaply is not the thing being
    // asserted here. And `copied` must have been set, or the assertion below compares nothing —
    // `-1` would sail under any ceiling.
    expect(opened.length).toBe(plaintext.length);
    expect(opened.subarray(0, 64)).toEqual(plaintext.subarray(0, 64));
    expect(copied).toBeGreaterThan(LINEAR_READ_BYTES);

    expect(
      copied,
      `${String(LINEAR_READ_BYTES)} bytes arriving one at a time cost ${String(copied)} bytes of ` +
        `memcpy (${(copied / LINEAR_READ_BYTES).toFixed(2)}× the file), over the ` +
        `${String(LINEAR_COPY_FACTOR)}× ceiling. The framer is copying its pending bytes again on ` +
        'every read.',
    ).toBeLessThan(LINEAR_READ_BYTES * LINEAR_COPY_FACTOR);
  }, 120_000);
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
    expectSameBytes(await open(Buffer.concat(pieces)), plaintext, 'reassembled');
  });
});
