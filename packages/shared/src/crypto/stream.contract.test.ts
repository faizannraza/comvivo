/**
 * The `SecretStream` contract, run against **both** implementations (`02` D13, `08` §3.7.1).
 *
 * `02` D13 says `sodium-native` "replaces it only if the M1 spike (SP-2) measures < 40 MB/s" and
 * that the two are "wire-identical"; `08` §3.7.1 says the fallback sits "behind the same
 * interface". Three claims, none of which a single-implementation test can check.
 *
 * So every case below runs twice, once per implementation, and then a third block seals with one
 * and opens with the other — in both directions. That is what makes the fallback a decision
 * somebody can take on the day a Pi benchmark comes in, rather than a sentence in a document.
 *
 * A contract test rather than a unit test because that is exactly what it is: one interface, two
 * implementations, one set of expectations. It runs in the `forks` pool, which is what a native
 * addon wants.
 */
import { describe, expect, it } from 'vitest';
import { AAD } from './labels.js';
import { randomBytes } from './random.js';
import {
  ABYTES,
  CHUNK_BYTES,
  HEADER_BYTES,
  openBuffer,
  type SecretStream,
  STREAM_KEY_BYTES,
  StreamOpenFailed,
  StreamTruncated,
  sealBuffer,
  wrappersSecretStream,
} from './stream.js';
import { assertWireCompatible, createNativeSecretStream } from './stream-native.js';

/**
 * Both implementations, as `const` promises resolved once and shared.
 *
 * Not a module-level `let` assigned in `beforeAll`: `scripts/hygiene`'s
 * `no-module-level-mutable-state` refuses that, and its reason applies here — a file that depends
 * on a `beforeAll` having run passes in declaration order and fails under shuffle. A `const`
 * promise is initialised once, cannot be reassigned, and every test awaits it.
 */
const wrappers: Promise<SecretStream> = wrappersSecretStream
  .ready()
  .then(() => wrappersSecretStream);

const nativeStream: Promise<SecretStream> = createNativeSecretStream().then(async (stream) => {
  await stream.ready();
  return stream;
});

/** Both implementations, named, so a failure says which one broke. */
const implementations: readonly (readonly [string, Promise<SecretStream>])[] = [
  ['libsodium-wrappers', wrappers],
  ['sodium-native', nativeStream],
];

describe.each(implementations)('%s satisfies the SecretStream contract', (name, pending) => {
  const get = async (): Promise<SecretStream> => pending;

  it('names itself, so the active implementation is visible in a log', async () => {
    expect((await get()).name).toBe(name);
  });

  it('generates a 256-bit key', async () => {
    const stream = await get();
    expect(stream.keygen()).toHaveLength(STREAM_KEY_BYTES);
    // Two keys in a row must differ, or the "keygen" is a constant.
    expect(Buffer.from(stream.keygen()).equals(Buffer.from(stream.keygen()))).toBe(false);
  });

  it('produces a 24-byte header', async () => {
    const stream = await get();
    expect(stream.initPush(stream.keygen()).header).toHaveLength(HEADER_BYTES);
  });

  it('adds exactly ABYTES per chunk', async () => {
    const stream = await get();
    const push = stream.initPush(stream.keygen());
    expect(push.push(new Uint8Array(100), 'final')).toHaveLength(100 + ABYTES);
  });

  it('round-trips a small payload', async () => {
    const stream = await get();
    const key = stream.keygen();
    const plaintext = Buffer.from('the recital is next Friday at 6');
    const opened = await openBuffer(stream, key, await sealBuffer(stream, key, plaintext));
    expect(Buffer.from(opened).equals(plaintext)).toBe(true);
  });

  it('round-trips an empty payload', async () => {
    const stream = await get();
    const key = stream.keygen();
    expect(
      await openBuffer(stream, key, await sealBuffer(stream, key, new Uint8Array(0))),
    ).toHaveLength(0);
  });

  it('round-trips several chunks', async () => {
    const stream = await get();
    const key = stream.keygen();
    const plaintext = randomBytes(CHUNK_BYTES * 2 + 777);
    const opened = await openBuffer(stream, key, await sealBuffer(stream, key, plaintext));
    expect(Buffer.from(opened).equals(plaintext)).toBe(true);
  });

  it('refuses the wrong key', async () => {
    const stream = await get();
    const sealed = await sealBuffer(stream, stream.keygen(), Buffer.from('secret'));
    await expect(openBuffer(stream, stream.keygen(), sealed)).rejects.toThrow(StreamOpenFailed);
  });

  it('detects a flipped bit', async () => {
    const stream = await get();
    const key = stream.keygen();
    const sealed = Buffer.from(await sealBuffer(stream, key, randomBytes(200)));
    sealed[100] = (sealed[100] ?? 0) ^ 0x01;
    await expect(openBuffer(stream, key, sealed)).rejects.toThrow(StreamOpenFailed);
  });

  it('detects a stream that ends without a final chunk', async () => {
    const stream = await get();
    const key = stream.keygen();
    const sealed = await sealBuffer(stream, key, randomBytes(CHUNK_BYTES * 2));
    const firstChunkOnly = sealed.subarray(0, HEADER_BYTES + CHUNK_BYTES + ABYTES);
    await expect(openBuffer(stream, key, firstChunkOnly)).rejects.toThrow(StreamTruncated);
  });

  it('binds the first chunk to its additional data', async () => {
    const stream = await get();
    const key = stream.keygen();
    const ad = (addr: string): Uint8Array =>
      new TextEncoder().encode(AAD.blobBody(addr, 'image/jpeg'));
    const sealed = await sealBuffer(stream, key, Buffer.from('photo'), ad('aaa'));
    await expect(openBuffer(stream, key, sealed, ad('bbb'))).rejects.toThrow(StreamOpenFailed);
    expect(Buffer.from(await openBuffer(stream, key, sealed, ad('aaa'))).toString()).toBe('photo');
  });

  it('refuses a key of the wrong size', async () => {
    const stream = await get();
    expect(() => stream.initPush(new Uint8Array(16))).toThrow(RangeError);
  });

  it('refuses a header of the wrong size', async () => {
    const stream = await get();
    expect(() => stream.initPull(new Uint8Array(10), stream.keygen())).toThrow(RangeError);
  });

  it('reports a final tag on the last chunk and a message tag before it', async () => {
    const stream = await get();
    const key = stream.keygen();
    const push = stream.initPush(key);
    const first = push.push(Buffer.from('one'), 'message');
    const last = push.push(Buffer.from('two'), 'final');

    const pull = stream.initPull(push.header, key);
    expect(pull.pull(first).tag).toBe('message');
    expect(pull.pull(last).tag).toBe('final');
  });

  it('detects a REORDERED chunk, which a per-chunk AEAD would not', async () => {
    // `02` M1-T4's acceptance criterion names reorder alongside tamper and truncation, and it is
    // the one a naive chunked scheme gets wrong: AES-GCM per chunk under one key authenticates
    // each chunk individually, so chunk 3 pasted into position 2 decrypts perfectly and the file
    // silently reads back with its contents shuffled. For a restored database that is corruption
    // that passes every integrity check we have.
    //
    // secretstream chains the state, so position is part of what is authenticated.
    const stream = await get();
    const key = stream.keygen();
    const push = stream.initPush(key);
    const first = push.push(Buffer.from('aaaa'), 'message');
    const second = push.push(Buffer.from('bbbb'), 'message');
    push.push(Buffer.from('cccc'), 'final');

    // In order: fine.
    const inOrder = stream.initPull(push.header, key);
    expect(Buffer.from(inOrder.pull(first).message).toString()).toBe('aaaa');
    expect(Buffer.from(inOrder.pull(second).message).toString()).toBe('bbbb');

    // Second chunk presented first: refused.
    const swapped = stream.initPull(push.header, key);
    expect(() => swapped.pull(second)).toThrow(StreamOpenFailed);
  });

  it('detects a REPLAYED chunk', async () => {
    // The same chunk twice is the other half of ordering: without chaining, a duplicated chunk
    // would decrypt to duplicated content.
    const stream = await get();
    const key = stream.keygen();
    const push = stream.initPush(key);
    const first = push.push(Buffer.from('aaaa'), 'message');
    push.push(Buffer.from('bbbb'), 'final');

    const pull = stream.initPull(push.header, key);
    expect(Buffer.from(pull.pull(first).message).toString()).toBe('aaaa');
    expect(() => pull.pull(first)).toThrow(StreamOpenFailed);
  });

  it('refuses a chunk shorter than the per-chunk overhead', async () => {
    const stream = await get();
    const key = stream.keygen();
    const push = stream.initPush(key);
    push.push(Buffer.from('x'), 'final');
    const pull = stream.initPull(push.header, key);
    expect(() => pull.pull(new Uint8Array(3))).toThrow(StreamOpenFailed);
  });
});

describe('the two implementations are wire-identical (02 D13)', () => {
  const PLAINTEXT = Buffer.from('Sam has a doctor appointment on Thursday, keep it private');

  it('sodium-native opens what libsodium-wrappers sealed', async () => {
    // The direction an existing host depends on: their blobs and backups were written by the WASM
    // default, and switching to the native fallback must not strand them.
    const key = wrappersSecretStream.keygen();
    const sealed = await sealBuffer(wrappersSecretStream, key, PLAINTEXT);
    const opened = await openBuffer(await nativeStream, key, sealed);
    expect(Buffer.from(opened).equals(PLAINTEXT)).toBe(true);
  });

  it('libsodium-wrappers opens what sodium-native sealed', async () => {
    // And the reverse — a host who moves back, or who restores onto a laptop a backup taken on a
    // Pi running the fallback.
    const key = (await nativeStream).keygen();
    const sealed = await sealBuffer(await nativeStream, key, PLAINTEXT);
    const opened = await openBuffer(wrappersSecretStream, key, sealed);
    expect(Buffer.from(opened).equals(PLAINTEXT)).toBe(true);
  });

  it('agrees across a multi-chunk stream, where the chunk chaining matters', async () => {
    const key = wrappersSecretStream.keygen();
    const plaintext = randomBytes(CHUNK_BYTES * 3 + 11);
    const sealed = await sealBuffer(wrappersSecretStream, key, plaintext);
    expect(Buffer.from(await openBuffer(await nativeStream, key, sealed)).equals(plaintext)).toBe(
      true,
    );
  });

  it('agrees about additional data', async () => {
    const key = (await nativeStream).keygen();
    const ad = new TextEncoder().encode(AAD.blobBody('addr', 'image/png'));
    const sealed = await sealBuffer(await nativeStream, key, PLAINTEXT, ad);
    expect(
      Buffer.from(await openBuffer(wrappersSecretStream, key, sealed, ad)).equals(PLAINTEXT),
    ).toBe(true);
    await expect(openBuffer(wrappersSecretStream, key, sealed)).rejects.toThrow(StreamOpenFailed);
  });

  it('produces byte-identical ciphertext from the same key and header', async () => {
    // The strongest form. The header carries a random nonce, so the only way to compare bytes is
    // to drive one implementation's push state from the other's header — which is not possible
    // through the interface. Instead: seal with one, and have the other open the exact bytes. A
    // successful pull proves both sides agree on the key schedule, the chunk framing and the tag,
    // which is what "wire-identical" means operationally.
    const key = wrappersSecretStream.keygen();
    const push = wrappersSecretStream.initPush(key);
    const chunk = push.push(PLAINTEXT, 'final');

    const pull = (await nativeStream).initPull(push.header, key);
    const { message, tag } = pull.pull(chunk);
    expect(Buffer.from(message).equals(PLAINTEXT)).toBe(true);
    expect(tag).toBe('final');
  });

  it('agrees about the sizes, which is the premise of the whole fallback', async () => {
    // `createNativeSecretStream` refuses to build if these disagree, so reaching this assertion at
    // all is part of the evidence. Stated explicitly so the reason is readable here too.
    const stream = await nativeStream;
    expect(stream.keygen()).toHaveLength(STREAM_KEY_BYTES);
    expect(stream.initPush(stream.keygen()).header).toHaveLength(HEADER_BYTES);
  });
});

describe('assertWireCompatible', () => {
  /**
   * The guard that refuses to build the native adapter if the two libraries disagree about any
   * size — the premise of the entire fallback.
   *
   * Tested directly rather than left as an inline `if`, because that branch can only fire if an
   * upstream library changes its constants: it would sit permanently uncovered, and "the check
   * exists" would be an assertion about the source rather than about behaviour.
   */
  const correct = { keyBytes: STREAM_KEY_BYTES, headerBytes: HEADER_BYTES, aBytes: ABYTES };

  it('accepts the sizes both libraries actually report', () => {
    expect(() => assertWireCompatible(correct)).not.toThrow();
  });

  it.each([
    ['key', { ...correct, keyBytes: 16 }, /key 16 != 32/],
    ['header', { ...correct, headerBytes: 32 }, /header 32 != 24/],
    ['per-chunk overhead', { ...correct, aBytes: 16 }, /per-chunk overhead 16 != 17/],
  ])('refuses a mismatched %s, naming both values', (_label, sizes, pattern) => {
    expect(() => assertWireCompatible(sizes)).toThrow(pattern);
  });

  it('reports every mismatch at once, rather than only the first', () => {
    // So a reviewer sees the whole picture in one message instead of fixing one and rerunning.
    try {
      assertWireCompatible({ keyBytes: 16, headerBytes: 32, aBytes: 16 });
      expect.unreachable('three mismatches should be refused');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('key 16');
      expect(message).toContain('header 32');
      expect(message).toContain('per-chunk overhead 16');
    }
  });

  it('says not to switch implementations, which is the actionable part', () => {
    expect(() => assertWireCompatible({ ...correct, keyBytes: 1 })).toThrow(/02 D13/);
  });
});
