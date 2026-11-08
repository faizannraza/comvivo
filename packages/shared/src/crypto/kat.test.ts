/**
 * `sec.crypto.kat` — known-answer tests (`08` §3.7.1, `02` M1-T4).
 *
 * The vectors here come from the standards themselves, not from running our own code and recording
 * what it did. That distinction is the whole point of a KAT: a test that captures current
 * behaviour proves the code is *consistent*, and a test against RFC 5869's published output proves
 * it is *correct*. The first kind would happily lock in a wrong implementation forever.
 *
 * What is pinned, and why each one is worth pinning:
 *
 *  - **HKDF-SHA256**, RFC 5869 test cases 1, 2 and 3. Every key in `02` §3.6.1's tree comes out of
 *    this, so an argument-order mistake here would silently give the whole product different keys
 *    than the specification describes — and nothing else would notice.
 *  - **The domain separators**, as exact strings. These are frozen wire constants: change one and
 *    every existing host's database is unopenable. See `labels.ts`.
 *  - **secretstream interoperability**, both directions, between `libsodium-wrappers` and
 *    `sodium-native`. `02` D13 claims the fallback switch is "wire-identical" and that claim is
 *    worth nothing untested.
 *  - **AES-256-GCM's tag length and nonce size**, because truncating either is a real temptation
 *    and a real weakening.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { SECRETSTREAM_VECTOR, vectorChunk, vectorHeader, vectorKey } from '../testing/index.js';
import { hkdfSha256, KEY_BYTES } from './hkdf.js';
import { sha256Hex } from './hmac.js';
import { AAD } from './labels.js';
import {
  ABYTES,
  HEADER_BYTES,
  openBuffer,
  STREAM_KEY_BYTES,
  sealBuffer,
  wrappersSecretStream,
} from './stream.js';
import { NONCE_BYTES, TAG_BYTES, unwrap, wrap } from './wrap.js';

const hex = (value: Uint8Array): string => Buffer.from(value).toString('hex');
const fromHex = (value: string): Buffer => Buffer.from(value, 'hex');

/** A repeating byte pattern, as RFC 5869's test cases specify them. */
const repeated = (byte: number, length: number): Buffer => Buffer.alloc(length, byte);

/** An ascending byte run, for RFC 5869 test case 2. */
const ascending = (start: number, length: number): Buffer =>
  Buffer.from(Array.from({ length }, (_, index) => (start + index) & 0xff));

describe('HKDF-SHA256 known answers (RFC 5869)', () => {
  it('matches test case 1', () => {
    // RFC 5869 §A.1. 22-byte IKM, 13-byte salt, 10-byte info, 42 bytes of output.
    const okm = hkdfSha256(
      repeated(0x0b, 22),
      fromHex('000102030405060708090a0b0c'),
      fromHex('f0f1f2f3f4f5f6f7f8f9'),
      42,
    );
    expect(hex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('matches test case 2, which is longer than one hash block', () => {
    // RFC 5869 §A.2: 80-byte inputs and 82 bytes of output, so the expand step runs three times.
    // The multi-block case is where an off-by-one in a hand-rolled HKDF would show up, and it is
    // worth pinning even though Node implements this for us: the arguments are ours.
    const okm = hkdfSha256(ascending(0x00, 80), ascending(0x60, 80), ascending(0xb0, 80), 82);
    expect(hex(okm)).toBe(
      'b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87',
    );
  });

  it('matches test case 3, with an empty salt and empty info', () => {
    // RFC 5869 §A.3. Worth having because an empty salt is *valid* HKDF, and `derivePurposeKey`
    // refuses it on purpose — this is the vector proving the primitive still behaves correctly
    // underneath that policy.
    const okm = hkdfSha256(repeated(0x0b, 22), Buffer.alloc(0), Buffer.alloc(0), 42);
    expect(hex(okm)).toBe(
      '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
    );
  });

  it('produces 32 bytes by default, which is every key in `02` §3.6.1', () => {
    expect(hkdfSha256(repeated(0x0b, 22), 'salt', 'info')).toHaveLength(KEY_BYTES);
  });
});

describe('SHA-256 known answers (FIPS 180-4)', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ])('hashes %j correctly', (input, expected) => {
    // The two FIPS 180-4 examples plus the empty string. These are here because `sha256` is what
    // stores every token digest and builds the audit chain, so a wrong digest function would make
    // every session invalid and every chain unverifiable at once.
    expect(sha256Hex(input)).toBe(expected);
  });
});

/**
 * The domain separators are pinned in `labels.test.ts`, not here.
 *
 * They need the same brand-guard exemption the constants themselves do — a test asserting
 * `comvivo/v1/db` is a test with a hard-coded product name in it — and keeping that exemption to
 * one named pair of files is worth more than keeping all the KATs in one place. That file also
 * carries the structural check that `labels.ts` imports nothing, which is what actually protects
 * against the dangerous refactor.
 */

describe('AES-256-GCM parameters', () => {
  it('uses a 96-bit nonce and a full 128-bit tag', () => {
    // Truncating the tag is a real temptation — it saves 4 bytes per wrapped key — and a real
    // weakening of authentication. Pinned so the saving has to be argued for explicitly.
    expect(NONCE_BYTES).toBe(12);
    expect(TAG_BYTES).toBe(16);
  });

  it('produces nonce ‖ ciphertext ‖ tag, at the documented length', () => {
    const key = repeated(0x2a, 32);
    const sealed = wrap(key, repeated(0x11, 32), AAD.vaultEntry('kat'));
    expect(sealed).toHaveLength(NONCE_BYTES + 32 + TAG_BYTES);
    expect(unwrap(key, sealed, AAD.vaultEntry('kat'))).toEqual(repeated(0x11, 32));
  });

  it('never produces the same nonce twice', () => {
    // The random-nonce bound `08` §3.7.1 accepts rests on the nonce actually being random. A
    // constant or counter-from-zero nonce would pass every round-trip test above.
    const key = repeated(0x2a, 32);
    const nonces = new Set(
      Array.from({ length: 500 }, () =>
        wrap(key, repeated(0x11, 16), AAD.vaultEntry('kat'))
          .subarray(0, NONCE_BYTES)
          .toString('hex'),
      ),
    );
    expect(nonces.size).toBe(500);
  });
});

describe('secretstream sizes', () => {
  beforeAll(async () => {
    await wrappersSecretStream.ready();
  });

  it('matches `08` §3.7.10’s documented sizes', () => {
    expect(STREAM_KEY_BYTES).toBe(32);
    expect(HEADER_BYTES).toBe(24);
    // 16-byte Poly1305 tag plus the 1-byte chunk tag.
    expect(ABYTES).toBe(17);
  });

  it('produces a header and per-chunk overhead of exactly those sizes', () => {
    const key = wrappersSecretStream.keygen();
    const push = wrappersSecretStream.initPush(key);
    expect(push.header).toHaveLength(HEADER_BYTES);
    expect(push.push(new Uint8Array(64), 'final')).toHaveLength(64 + ABYTES);
  });

  /**
   * A known-answer vector for the secretstream construction itself.
   *
   * `M1-T4`'s acceptance criterion is "`sec.crypto.kat` (RFC 5869, **libsodium vectors**)", and the
   * libsodium half was missing: this block asserted three constants and then round-tripped a value
   * through the same implementation, which is a consistency check rather than a known answer. An
   * implementation that got the nonce schedule, the subkey derivation or the Poly1305 tag wrong in
   * the *same* way on both sides would have passed. Found by the M1 independent review.
   *
   * A **pull** vector rather than a push one, because that is the direction that can be fixed:
   * `crypto_secretstream_xchacha20poly1305_init_push` generates its header randomly and libsodium
   * exposes no way to supply one, so there is no deterministic push to pin. Pinning the pull side
   * constrains everything that matters — the header-to-subkey derivation, the sequential nonce
   * schedule, the per-chunk tag byte and the Poly1305 authenticator — because all of them have to
   * be reproduced exactly to recover the plaintext.
   *
   * Generated once against `libsodium-wrappers` and frozen. It is a vector in the useful sense: if
   * libsodium's construction changes, or if `02` D13 swaps the implementation and the replacement
   * disagrees about any of those details, this fails rather than quietly producing a format that
   * cannot open an existing `.vbak`.
   */
  it('opens a frozen libsodium secretstream vector', () => {
    const pull = wrappersSecretStream.initPull(vectorHeader(), vectorKey());
    for (const [index, chunk] of SECRETSTREAM_VECTOR.chunks.entries()) {
      const opened = pull.pull(vectorChunk(index));
      expect(Buffer.from(opened.message).toString('utf8')).toBe(chunk.plain);
      // The tag is carried inside the authenticated chunk, so recovering it is part of the claim:
      // `final` is what tells a reader the stream ended rather than was truncated.
      expect(opened.tag).toBe(chunk.tag);
    }
  });

  it('refuses the vector under a different key', () => {
    // Non-vacuity in the direction that matters: the test above would pass against an
    // implementation that ignored the key entirely and returned the plaintext from somewhere else.
    const wrong = Buffer.alloc(32, 0x43);
    const pull = wrappersSecretStream.initPull(vectorHeader(), wrong);
    expect(() => pull.pull(vectorChunk(0))).toThrow();
  });

  it('refuses the vector under a different header', () => {
    // The header is not a nonce the reader can choose: it seeds the subkey, so a changed header
    // produces a different keystream and the Poly1305 tag fails.
    const header = Buffer.from(vectorHeader());
    header[0] = (header[0] ?? 0) ^ 0x01;
    const pull = wrappersSecretStream.initPull(header, vectorKey());
    expect(() => pull.pull(vectorChunk(0))).toThrow();
  });

  it('refuses the chunks out of order, because the nonce schedule is sequential', () => {
    // This is what makes truncation and reordering detectable at all (`08` §3.7.10). A stream
    // whose chunks were independently decryptable would let an attacker drop or swap messages.
    const pull = wrappersSecretStream.initPull(vectorHeader(), vectorKey());
    expect(() => pull.pull(vectorChunk(1))).toThrow();
  });

  it('refuses a single flipped bit in the ciphertext', () => {
    const pull = wrappersSecretStream.initPull(vectorHeader(), vectorKey());
    const tampered = Buffer.from(vectorChunk(0));
    tampered[5] = (tampered[5] ?? 0) ^ 0x01;
    expect(() => pull.pull(tampered)).toThrow();
  });

  /**
   * Interoperability with `sodium-native` is **not** tested here.
   *
   * It lives in `stream.contract.test.ts`, which runs the whole `SecretStream` contract against
   * both implementations and then seals with one and opens with the other in both directions.
   * That is a stronger check than a pair of assertions in this file would be, and it goes through
   * the interface the product actually uses rather than around it.
   *
   * It is also the only place that can: `sodium-native` ships no type declarations, so a direct
   * import here is a `TS7016`. The contract test reaches it through
   * `createNativeSecretStream`, which declares the slice of the API it needs.
   */
});

describe('sealing and opening a buffer', () => {
  beforeAll(async () => {
    await wrappersSecretStream.ready();
  });

  it('round-trips through the convenience helpers', async () => {
    const key = wrappersSecretStream.keygen();
    const plaintext = Buffer.from('a canary that must survive the round trip');
    const opened = await openBuffer(
      wrappersSecretStream,
      key,
      await sealBuffer(wrappersSecretStream, key, plaintext),
    );
    expect(Buffer.from(opened).equals(plaintext)).toBe(true);
  });
});
