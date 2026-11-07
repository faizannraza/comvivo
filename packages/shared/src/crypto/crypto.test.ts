/**
 * The crypto spine's behaviour (`08` §3.7, `02` §3.6.1).
 *
 * The known answers are in `kat.test.ts`; this file is about the properties that make the
 * primitives safe to build on — domain separation that actually separates, AAD that actually
 * binds, tamper detection that actually detects, and arguments that fail loudly when they are the
 * shape of a bug.
 */
import { describe, expect, it } from 'vitest';
import { secureEqual, secureEqualDigest } from './equal.js';
import { derivePurposeKey, hkdfSha256, KEY_BYTES } from './hkdf.js';
import { blobAddress, hmacSha256, hmacSha256Base64Url, sha256, sha256Hex } from './hmac.js';
import { AAD, KEY_PURPOSE, tokenMacPurpose } from './labels.js';
import { isZeroed, withZeroed, withZeroedAsync, zeroize, zeroizeAll } from './memory.js';
import { randomBytes } from './random.js';
import { newScryptSalt, SALT_BYTES, SCRYPT_PARAMS, scryptKey, scryptKeySync } from './scrypt.js';
import {
  ABYTES,
  CHUNK_BYTES,
  HEADER_BYTES,
  openBuffer,
  StreamOpenFailed,
  StreamTruncated,
  sealBuffer,
  wrappersSecretStream,
} from './stream.js';
import { NONCE_BYTES, sealedLength, TAG_BYTES, UnwrapFailed, unwrap, wrap } from './wrap.js';

const INSTANCE = 'inst_01jd8kqd7h3f9z2m4n6p8r0t2v';
const rdk = (): Buffer => Buffer.alloc(32, 0x5a);

describe('derivePurposeKey', () => {
  it('derives 32 bytes', () => {
    expect(derivePurposeKey(rdk(), INSTANCE, KEY_PURPOSE.db)).toHaveLength(KEY_BYTES);
  });

  it('is deterministic for the same root key, instance and purpose', () => {
    // It has to be: the database key is re-derived on every open, and a non-deterministic
    // derivation would mean a host could open their database once and never again.
    expect(derivePurposeKey(rdk(), INSTANCE, 'db')).toEqual(
      derivePurposeKey(rdk(), INSTANCE, 'db'),
    );
  });

  it('gives every purpose a different key', () => {
    // The whole point of the tree. If `db` and `blob-kek` collided, the database key would decrypt
    // blobs — so one leaked key would be every key.
    const keys = Object.values(KEY_PURPOSE).map((purpose) =>
      derivePurposeKey(rdk(), INSTANCE, purpose).toString('hex'),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('separates purposes that share a prefix', () => {
    // The specific failure a naive `sha256(rdk + purpose)` construction would have: `blob` and
    // `blob-kek` are prefix-related. HKDF's `info` parameter does not care, and this is the test
    // that says so.
    const a = derivePurposeKey(rdk(), INSTANCE, 'blob');
    const b = derivePurposeKey(rdk(), INSTANCE, 'blob-kek');
    expect(a.equals(b)).toBe(false);
  });

  it('gives every token-MAC epoch a different key', () => {
    // `08` §3.7.12: bumping the epoch is how "log everybody out" is implemented, and it only works
    // if the new epoch's key cannot validate the old epoch's tokens.
    const keys = [0, 1, 2, 99].map((epoch) =>
      derivePurposeKey(rdk(), INSTANCE, tokenMacPurpose(epoch)).toString('hex'),
    );
    expect(new Set(keys).size).toBe(4);
  });

  it('gives two instances different keys even from the same root key', () => {
    // `instanceId` is the HKDF salt. This matters on the restore path, where a backup from one
    // instance is opened on another: without per-instance separation, two hosts who somehow shared
    // a root key would share every derived key.
    const a = derivePurposeKey(rdk(), 'inst_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'db');
    const b = derivePurposeKey(rdk(), 'inst_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'db');
    expect(a.equals(b)).toBe(false);
  });

  it('gives two root keys different purpose keys', () => {
    const a = derivePurposeKey(Buffer.alloc(32, 1), INSTANCE, 'db');
    const b = derivePurposeKey(Buffer.alloc(32, 2), INSTANCE, 'db');
    expect(a.equals(b)).toBe(false);
  });

  it('refuses an empty instanceId, which would remove the per-instance salt silently', () => {
    expect(() => derivePurposeKey(rdk(), '', 'db')).toThrow(/non-empty instanceId/);
  });

  it('refuses an empty purpose', () => {
    expect(() => derivePurposeKey(rdk(), INSTANCE, '')).toThrow(/non-empty purpose/);
  });

  it('refuses an empty root key, which is what a zeroed buffer looks like', () => {
    // A key buffer that has already been zeroed, or never filled, is the realistic cause. Failing
    // here turns "every key is the same key" into a crash.
    expect(() => hkdfSha256(new Uint8Array(0), INSTANCE, 'info')).toThrow(/non-empty input key/);
  });

  it('refuses an output length HKDF-SHA256 cannot produce', () => {
    expect(() => hkdfSha256(rdk(), INSTANCE, 'info', 0)).toThrow(RangeError);
    expect(() => hkdfSha256(rdk(), INSTANCE, 'info', 255 * 32 + 1)).toThrow(RangeError);
  });
});

describe('wrap and unwrap', () => {
  const key = (): Buffer => Buffer.alloc(32, 0x2a);
  const aad = AAD.blobDek('abc123', 1);

  it('round-trips', () => {
    const plaintext = randomBytes(32);
    expect(unwrap(key(), wrap(key(), plaintext, aad), aad)).toEqual(plaintext);
  });

  it('round-trips an empty plaintext', () => {
    expect(unwrap(key(), wrap(key(), new Uint8Array(0), aad), aad)).toHaveLength(0);
  });

  it('round-trips something larger than one block', () => {
    const plaintext = randomBytes(10_000);
    expect(unwrap(key(), wrap(key(), plaintext, aad), aad)).toEqual(plaintext);
  });

  it('reports the sealed length without unwrapping', () => {
    expect(wrap(key(), randomBytes(48), aad)).toHaveLength(sealedLength(48));
    expect(sealedLength(48)).toBe(NONCE_BYTES + 48 + TAG_BYTES);
  });

  it('refuses the wrong key', () => {
    const sealed = wrap(key(), randomBytes(32), aad);
    expect(() => unwrap(Buffer.alloc(32, 0x2b), sealed, aad)).toThrow(UnwrapFailed);
  });

  it('refuses a different AAD, which is what stops a wrapped key moving between rows', () => {
    // The attack this prevents: somebody with write access to the database swaps blob A's wrapped
    // DEK for blob B's. Without AAD it decrypts perfectly and they read B.
    const sealed = wrap(key(), randomBytes(32), AAD.blobDek('aaa', 1));
    expect(() => unwrap(key(), sealed, AAD.blobDek('bbb', 1))).toThrow(UnwrapFailed);
  });

  it('refuses a different KEK generation', () => {
    const sealed = wrap(key(), randomBytes(32), AAD.blobDek('aaa', 1));
    expect(() => unwrap(key(), sealed, AAD.blobDek('aaa', 2))).toThrow(UnwrapFailed);
  });

  it('detects a flipped bit anywhere in the sealed value', () => {
    const sealed = wrap(key(), randomBytes(32), aad);
    for (const index of [0, 5, NONCE_BYTES, NONCE_BYTES + 10, sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      expect(() => unwrap(key(), tampered, aad), `byte ${String(index)}`).toThrow(UnwrapFailed);
    }
  });

  it('detects truncation', () => {
    const sealed = wrap(key(), randomBytes(32), aad);
    expect(() => unwrap(key(), sealed.subarray(0, sealed.length - 1), aad)).toThrow(UnwrapFailed);
  });

  it('reports every failure the same way, so there is no oracle', () => {
    // A caller that could distinguish "wrong key" from "wrong AAD" could use the difference to
    // probe. No legitimate caller needs to know, so all of them get one message.
    const sealed = wrap(key(), randomBytes(32), aad);
    const messages = new Set<string>();
    for (const attempt of [
      () => unwrap(Buffer.alloc(32, 0x2b), sealed, aad),
      () => unwrap(key(), sealed, AAD.blobDek('other', 1)),
      () => unwrap(key(), Buffer.concat([sealed, Buffer.of(0)]), aad),
      () => unwrap(key(), sealed.subarray(0, 20), aad),
    ]) {
      try {
        attempt();
        expect.unreachable('should have refused');
      } catch (error) {
        expect(error).toBeInstanceOf(UnwrapFailed);
        messages.add((error as Error).message);
      }
    }
    // Two messages: one for "too short to try" and one for everything else. Neither says which key
    // or which context was wrong.
    expect(messages.size).toBeLessThanOrEqual(2);
    for (const message of messages) {
      expect(message).not.toMatch(/key is wrong|aad|context mismatch/i);
    }
  });

  it('refuses an empty AAD, because it would make a wrapped key portable', () => {
    expect(() => wrap(key(), randomBytes(32), '')).toThrow(/additional data/);
    expect(() => unwrap(key(), wrap(key(), randomBytes(32), aad), '')).toThrow(/additional data/);
  });

  it('refuses a key that is not 256 bits', () => {
    for (const size of [16, 24, 31, 33]) {
      expect(() => wrap(Buffer.alloc(size), randomBytes(32), aad), String(size)).toThrow(
        RangeError,
      );
    }
  });

  it('produces a different ciphertext every time for the same plaintext', () => {
    // The random nonce. Identical ciphertexts would leak that two rows hold the same key.
    const plaintext = randomBytes(32);
    const seen = new Set(
      Array.from({ length: 20 }, () => wrap(key(), plaintext, aad).toString('hex')),
    );
    expect(seen.size).toBe(20);
  });
});

describe('sha256 and hmac', () => {
  it('returns 32 bytes', () => {
    expect(sha256('x')).toHaveLength(32);
    expect(hmacSha256(Buffer.alloc(32, 1), 'x')).toHaveLength(32);
  });

  it('hex and buffer forms agree', () => {
    expect(sha256Hex('hello')).toBe(sha256('hello').toString('hex'));
  });

  it('keys the HMAC, so a different key gives a different tag', () => {
    const a = hmacSha256(Buffer.alloc(32, 1), 'message');
    const b = hmacSha256(Buffer.alloc(32, 2), 'message');
    expect(a.equals(b)).toBe(false);
  });

  it('refuses an empty HMAC key, which would make the output public', () => {
    // The realistic cause is a zeroed or uninitialised key buffer, and the consequence is that a
    // blob address stops being unguessable and a CSRF token stops being a secret.
    expect(() => hmacSha256(new Uint8Array(0), 'x')).toThrow(/non-empty key/);
  });

  it('produces base64url with no padding, for tokens that go in URLs', () => {
    const tag = hmacSha256Base64Url(Buffer.alloc(32, 1), 'message');
    expect(tag).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(tag)).toBe(tag);
  });
});

describe('blobAddress', () => {
  const blobIdKey = (): Buffer => Buffer.alloc(32, 0x7c);

  it('is deterministic, which is what makes deduplication work', () => {
    const content = Buffer.from('a photograph');
    expect(blobAddress(blobIdKey(), content)).toBe(blobAddress(blobIdKey(), content));
  });

  it('differs for different content', () => {
    expect(blobAddress(blobIdKey(), Buffer.from('a'))).not.toBe(
      blobAddress(blobIdKey(), Buffer.from('b')),
    );
  });

  it('differs between instances, so a file cannot be confirmed across hosts', () => {
    // `08` SD-06's reason for keying this: a plain content hash would let anyone holding a
    // candidate file confirm its presence in a family's store by reading filenames. The keyed
    // address makes that impossible without `K_blobid`.
    const content = Buffer.from('a photograph');
    expect(blobAddress(Buffer.alloc(32, 1), content)).not.toBe(
      blobAddress(Buffer.alloc(32, 2), content),
    );
  });

  it('is lowercase hex, which is what the filename and the column hold', () => {
    expect(blobAddress(blobIdKey(), Buffer.from('x'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('secureEqual', () => {
  it('is true for equal values and false for different ones', () => {
    expect(secureEqual('token-value', 'token-value')).toBe(true);
    expect(secureEqual('token-value', 'token-valuf')).toBe(false);
  });

  it('compares different lengths without throwing', () => {
    // `timingSafeEqual` throws on a length mismatch, and that throw is itself a timing side
    // channel leaking the length of the secret. Hashing first makes the comparison total.
    expect(secureEqual('short', 'a much longer candidate')).toBe(false);
    expect(secureEqual('', 'x')).toBe(false);
    expect(secureEqual('', '')).toBe(true);
  });

  it('works on bytes as well as strings', () => {
    expect(secureEqual(Buffer.of(1, 2, 3), Buffer.of(1, 2, 3))).toBe(true);
    expect(secureEqual(Buffer.of(1, 2, 3), Buffer.of(1, 2, 4))).toBe(false);
  });

  it('treats a token as bytes, not as text', () => {
    // Two strings that normalise to the same text are different tokens. Normalising here would
    // mean a token could be presented in a form that is not the one that was issued.
    expect(secureEqual('café', 'café')).toBe(false);
  });
});

describe('secureEqualDigest', () => {
  it('matches a presented secret against its stored digest', () => {
    const token = 'vs1_abcdefghijklmnopqrstuvwxyz';
    expect(secureEqualDigest(token, sha256(token))).toBe(true);
    expect(secureEqualDigest('vs1_wrong', sha256(token))).toBe(false);
  });

  it('refuses a stored value that is not a 32-byte digest', () => {
    // The realistic cause is a column mix-up — comparing against the raw token, or against a
    // base64 string — and silently returning `false` would look like a wrong password.
    expect(() => secureEqualDigest('x', Buffer.alloc(16))).toThrow(/column mix-up/);
    expect(() => secureEqualDigest('x', Buffer.alloc(64))).toThrow(RangeError);
  });
});

describe('zeroing', () => {
  it('overwrites a buffer', () => {
    const key = Buffer.alloc(32, 0xff);
    zeroize(key);
    expect(isZeroed(key)).toBe(true);
  });

  it('zeroes several buffers, skipping the ones that are not there', () => {
    const a = Buffer.alloc(8, 1);
    const b = Buffer.alloc(8, 2);
    zeroizeAll(a, undefined, b);
    expect(isZeroed(a)).toBe(true);
    expect(isZeroed(b)).toBe(true);
  });

  it('isZeroed is false while a single byte survives', () => {
    const key = Buffer.alloc(32, 0);
    key[17] = 1;
    expect(isZeroed(key)).toBe(false);
  });

  it('withZeroed zeroes after a successful call', () => {
    const key = Buffer.alloc(32, 0xaa);
    const result = withZeroed(key, (k) => k.length);
    expect(result).toBe(32);
    expect(isZeroed(key)).toBe(true);
  });

  it('withZeroed zeroes even when the body throws', () => {
    // The case that matters. Without the scope guard, every call site needs its own `finally`, and
    // the one that forgets is the one that throws — which is exactly when a live key is most
    // likely to be left in a buffer that outlives the request.
    const key = Buffer.alloc(32, 0xaa);
    expect(() =>
      withZeroed(key, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(isZeroed(key)).toBe(true);
  });

  it('withZeroedAsync zeroes after resolution', async () => {
    const key = Buffer.alloc(32, 0xaa);
    await withZeroedAsync(key, async (k) => {
      await Promise.resolve();
      return k.length;
    });
    expect(isZeroed(key)).toBe(true);
  });

  it('withZeroedAsync zeroes after rejection', async () => {
    const key = Buffer.alloc(32, 0xaa);
    await expect(
      withZeroedAsync(key, async () => {
        await Promise.resolve();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(isZeroed(key)).toBe(true);
  });
});

describe('scrypt', () => {
  /**
   * These run with **reduced parameters**, and that is a deliberate, stated substitution.
   *
   * `08` §3.7.1's N=2^17 takes about a second and 128 MiB per call. Twelve of those in a unit
   * suite is twelve seconds and a memory spike on every contributor's laptop and in CI, for no
   * additional confidence: what these tests check is the *plumbing* — determinism, salt
   * separation, parameter validation — which is parameter-independent. The real parameters are
   * asserted as constants, and `M1-T5`'s keyring tests exercise them once for real.
   */
  const FAST = { N: 1_024, r: 8, p: 1 } as const;
  const salt = (): Buffer => Buffer.alloc(SALT_BYTES, 0x33);

  it('pins `08` §3.7.1’s parameters as constants', () => {
    expect(SCRYPT_PARAMS.N).toBe(131_072);
    expect(SCRYPT_PARAMS.r).toBe(8);
    expect(SCRYPT_PARAMS.p).toBe(1);
    // 128 · N · r = 128 MiB, so the limit has to be above it. Node's own default is 32 MiB, which
    // means the specified parameters do not work without raising it — a trap that would surface
    // the first time a host set a passphrase.
    expect(128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r).toBeLessThanOrEqual(256 * 1024 * 1024);
  });

  it('derives 32 bytes', async () => {
    expect(await scryptKey('correct horse battery staple', salt(), FAST)).toHaveLength(KEY_BYTES);
  });

  it('is deterministic for the same passphrase, salt and parameters', async () => {
    const a = await scryptKey('passphrase', salt(), FAST);
    const b = await scryptKey('passphrase', salt(), FAST);
    expect(a.equals(b)).toBe(true);
  });

  it('agrees with the synchronous form', async () => {
    const asyncKey = await scryptKey('passphrase', salt(), FAST);
    const syncKey = scryptKeySync('passphrase', salt(), FAST);
    expect(asyncKey.equals(syncKey)).toBe(true);
  });

  it('gives a different key for a different passphrase', async () => {
    const a = await scryptKey('passphrase', salt(), FAST);
    const b = await scryptKey('passphrasf', salt(), FAST);
    expect(a.equals(b)).toBe(false);
  });

  it('gives a different key for a different salt', async () => {
    const a = await scryptKey('passphrase', Buffer.alloc(SALT_BYTES, 1), FAST);
    const b = await scryptKey('passphrase', Buffer.alloc(SALT_BYTES, 2), FAST);
    expect(a.equals(b)).toBe(false);
  });

  it('gives a different key for different parameters', async () => {
    // Which is why `08` §3.7.2 stores them with the slot: raising N later must still unlock an old
    // keyring, and it only can if the old parameters are recorded.
    const a = await scryptKey('passphrase', salt(), { N: 1_024, r: 8, p: 1 });
    const b = await scryptKey('passphrase', salt(), { N: 2_048, r: 8, p: 1 });
    expect(a.equals(b)).toBe(false);
  });

  it('produces a fresh random salt each time', () => {
    const salts = new Set(Array.from({ length: 100 }, () => newScryptSalt().toString('hex')));
    expect(salts.size).toBe(100);
    expect(newScryptSalt()).toHaveLength(SALT_BYTES);
  });

  it('refuses an empty passphrase', async () => {
    // An empty passphrase derives a perfectly good key from nothing, so the slot would look
    // protected and would not be.
    await expect(scryptKey('', salt(), FAST)).rejects.toThrow(/non-empty passphrase/);
    expect(() => scryptKeySync('', salt(), FAST)).toThrow(/non-empty passphrase/);
  });

  it('refuses an N that is not a power of two', async () => {
    await expect(scryptKey('x', salt(), { N: 1_000, r: 8, p: 1 })).rejects.toThrow(/power of two/);
  });

  it('refuses parameters that would exceed the memory limit, naming the figure', async () => {
    // Node would throw its own error, a long way from the parameters that caused it.
    await expect(scryptKey('x', salt(), { N: 2 ** 22, r: 8, p: 1 })).rejects.toThrow(
      /above the 256 MiB limit/,
    );
  });

  it('refuses a non-positive r or p', async () => {
    await expect(scryptKey('x', salt(), { N: 1_024, r: 0, p: 1 })).rejects.toThrow(RangeError);
    await expect(scryptKey('x', salt(), { N: 1_024, r: 8, p: 0 })).rejects.toThrow(RangeError);
  });
});

describe('secretstream', () => {
  const stream = wrappersSecretStream;
  const key = async (): Promise<Uint8Array> => {
    await stream.ready();
    return stream.keygen();
  };

  it('round-trips a small payload', async () => {
    const k = await key();
    const plaintext = Buffer.from('the rent is due on the first');
    expect(
      Buffer.from(await openBuffer(stream, k, await sealBuffer(stream, k, plaintext))),
    ).toEqual(plaintext);
  });

  it('round-trips an empty payload, with a well-formed single final chunk', async () => {
    const k = await key();
    const sealed = await sealBuffer(stream, k, new Uint8Array(0));
    expect(await openBuffer(stream, k, sealed)).toHaveLength(0);
  });

  it('round-trips something spanning several chunks', async () => {
    const k = await key();
    const plaintext = randomBytes(CHUNK_BYTES * 2 + 1_234);
    const opened = await openBuffer(stream, k, await sealBuffer(stream, k, plaintext));
    expect(Buffer.from(opened).equals(plaintext)).toBe(true);
  });

  it('round-trips exactly one chunk, the off-by-one boundary', async () => {
    const k = await key();
    const plaintext = randomBytes(CHUNK_BYTES);
    const opened = await openBuffer(stream, k, await sealBuffer(stream, k, plaintext));
    expect(Buffer.from(opened).equals(plaintext)).toBe(true);
  });

  it('refuses the wrong key', async () => {
    const sealed = await sealBuffer(stream, await key(), Buffer.from('secret'));
    await expect(openBuffer(stream, await key(), sealed)).rejects.toThrow(StreamOpenFailed);
  });

  it('detects a flipped bit in the body', async () => {
    const k = await key();
    const sealed = Buffer.from(await sealBuffer(stream, k, randomBytes(100)));
    sealed[50] = (sealed[50] ?? 0) ^ 0x01;
    await expect(openBuffer(stream, k, sealed)).rejects.toThrow(StreamOpenFailed);
  });

  it('detects a tampered header', async () => {
    const k = await key();
    const sealed = Buffer.from(await sealBuffer(stream, k, randomBytes(100)));
    sealed[3] = (sealed[3] ?? 0) ^ 0x01;
    await expect(openBuffer(stream, k, sealed)).rejects.toThrow();
  });

  it('detects truncation at a chunk boundary, which for a backup is what matters', async () => {
    // A half-copied backup must fail to restore, not restore silently incomplete. The `TAG_FINAL`
    // on the last chunk is what makes that possible: here the bytes stop after a complete
    // `message` chunk, every chunk present authenticates fine, and the stream is still refused
    // **because the final chunk never arrived**.
    const k = await key();
    const sealed = await sealBuffer(stream, k, randomBytes(CHUNK_BYTES * 2));
    const wholeFirstChunk = sealed.subarray(0, HEADER_BYTES + CHUNK_BYTES + ABYTES);
    await expect(openBuffer(stream, k, wholeFirstChunk)).rejects.toThrow(StreamTruncated);
  });

  it('detects truncation mid-chunk as an authentication failure', async () => {
    // The other half of the same story, and a different exception on purpose. A file cut inside a
    // chunk fails to authenticate; a file cut cleanly between chunks authenticates every chunk it
    // has and is missing its ending. Both refuse, and a host needs to be told different things:
    // one is "this copy is damaged", the other is "this copy is incomplete".
    const k = await key();
    const sealed = await sealBuffer(stream, k, randomBytes(CHUNK_BYTES * 2));
    await expect(openBuffer(stream, k, sealed.subarray(0, sealed.length - 40))).rejects.toThrow(
      StreamOpenFailed,
    );
  });

  it('refuses something shorter than a header plus one chunk', async () => {
    const k = await key();
    await expect(openBuffer(stream, k, new Uint8Array(10))).rejects.toThrow(StreamTruncated);
  });

  it('binds the first chunk to its additional data', async () => {
    // `08` §3.7.10: the first chunk's AD is `comvivo/blob/v1|<addr>|<mime>`, so a blob body cannot
    // be moved to another address or relabelled with another mime type.
    const k = await key();
    const ad = (addr: string): Uint8Array =>
      new TextEncoder().encode(AAD.blobBody(addr, 'image/jpeg'));
    const sealed = await sealBuffer(stream, k, Buffer.from('photo bytes'), ad('aaa'));
    await expect(openBuffer(stream, k, sealed, ad('bbb'))).rejects.toThrow(StreamOpenFailed);
    expect(Buffer.from(await openBuffer(stream, k, sealed, ad('aaa'))).toString()).toBe(
      'photo bytes',
    );
  });

  it('refuses a key that is not 256 bits', async () => {
    await stream.ready();
    expect(() => stream.initPush(new Uint8Array(16))).toThrow(RangeError);
  });

  it('refuses a header that is not 24 bytes', async () => {
    const k = await key();
    expect(() => stream.initPull(new Uint8Array(10), k)).toThrow(RangeError);
  });

  it('produces different ciphertext for the same plaintext, because the header is fresh', async () => {
    const k = await key();
    const plaintext = Buffer.from('same');
    const a = Buffer.from(await sealBuffer(stream, k, plaintext)).toString('hex');
    const b = Buffer.from(await sealBuffer(stream, k, plaintext)).toString('hex');
    expect(a).not.toBe(b);
  });

  it('names itself, so the fallback switch is visible in a log', () => {
    expect(stream.name).toBe('libsodium-wrappers');
  });
});
