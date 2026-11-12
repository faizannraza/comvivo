/**
 * Streaming AEAD: libsodium's `crypto_secretstream_xchacha20poly1305` behind one interface
 * (`08` §3.7.10, §3.7.11; `02` D13).
 *
 * This is what encrypts blob bodies and backup archives — the two things in this product that can
 * be gigabytes and must never be held in memory whole. secretstream rather than AES-GCM per chunk
 * because it solves the three problems a naive chunked scheme gets wrong:
 *
 *  - **Reorder.** Chunks are chained, so chunk 7 cannot be decrypted in position 3.
 *  - **Truncation.** The last chunk carries `TAG_FINAL`, so a file cut short fails to open rather
 *    than opening with its ending missing — which for a backup is the difference between "restore
 *    failed" and "restored, silently incomplete".
 *  - **Nonce management.** The library owns it. A per-chunk random nonce under one key is exactly
 *    the construction `08` §3.7.1's wrap-count arithmetic exists to avoid.
 *
 * `02` D13 makes `libsodium-wrappers` (WASM) the default and `sodium-native` the fallback if SP-2
 * measures under 40 MB/s on a Pi 5, and claims the switch is **wire-identical**. That claim is the
 * reason for the `SecretStream` interface here and for the cross-decryption tests: a fallback
 * nobody has decrypted across is a fallback nobody can take.
 */
import sodium from 'libsodium-wrappers';

/** `08` §3.7.10: 64 KiB chunks. */
export const CHUNK_BYTES = 64 * 1024;

/** Per-chunk overhead: 16-byte Poly1305 tag plus the 1-byte chunk tag. */
export const ABYTES = 17;

/** The stream header that goes at the front of a `VBL1` or `VBK1` body. */
export const HEADER_BYTES = 24;

/** A secretstream key. */
export const STREAM_KEY_BYTES = 32;

export type ChunkTag = 'message' | 'final';

/** A sealing stream: one `header`, then a `push` per chunk, the last one `final`. */
export interface SecretStreamPush {
  readonly header: Uint8Array;
  push(chunk: Uint8Array, tag: ChunkTag, additionalData?: Uint8Array): Uint8Array;
}

/** An opening stream: constructed from the header, then a `pull` per chunk. */
export interface SecretStreamPull {
  pull(
    chunk: Uint8Array,
    additionalData?: Uint8Array,
  ): { readonly message: Uint8Array; readonly tag: ChunkTag };
}

/**
 * The implementation boundary `02` D13 switches.
 *
 * Both implementations produce the same wire format; what differs is throughput and whether a
 * native binary is involved.
 */
export interface SecretStream {
  readonly name: 'libsodium-wrappers' | 'sodium-native';
  ready(): Promise<void>;
  keygen(): Uint8Array;
  initPush(key: Uint8Array): SecretStreamPush;
  initPull(header: Uint8Array, key: Uint8Array): SecretStreamPull;
}

/** Raised when a chunk fails to authenticate: tampered, reordered, or the wrong key. */
export class StreamOpenFailed extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StreamOpenFailed';
  }
}

/** Raised when a stream ended without a `final` chunk — a truncated file. */
export class StreamTruncated extends Error {
  constructor(message = 'the stream ended without a final chunk, so it is truncated') {
    super(message);
    this.name = 'StreamTruncated';
  }
}

function assertKey(key: Uint8Array): void {
  if (key.length !== STREAM_KEY_BYTES) {
    throw new RangeError(
      `a secretstream key is ${String(STREAM_KEY_BYTES)} bytes, got ${String(key.length)}`,
    );
  }
}

/** The default implementation (`02` D13): WASM, no native build, works on every target. */
export const wrappersSecretStream: SecretStream = {
  name: 'libsodium-wrappers',

  async ready(): Promise<void> {
    await sodium.ready;
  },

  keygen(): Uint8Array {
    return sodium.crypto_secretstream_xchacha20poly1305_keygen();
  },

  initPush(key: Uint8Array): SecretStreamPush {
    assertKey(key);
    const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
    return {
      header,
      push(chunk, tag, additionalData) {
        return sodium.crypto_secretstream_xchacha20poly1305_push(
          state,
          chunk,
          additionalData ?? null,
          tag === 'final'
            ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
            : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
        );
      },
    };
  },

  initPull(header: Uint8Array, key: Uint8Array): SecretStreamPull {
    assertKey(key);
    if (header.length !== HEADER_BYTES) {
      throw new RangeError(
        `a secretstream header is ${String(HEADER_BYTES)} bytes, got ${String(header.length)}`,
      );
    }
    const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
    return {
      pull(chunk, additionalData) {
        let result: { message: Uint8Array; tag: number } | false;
        try {
          result = sodium.crypto_secretstream_xchacha20poly1305_pull(
            state,
            chunk,
            additionalData ?? null,
          );
        } catch (cause) {
          throw new StreamOpenFailed('a chunk failed to authenticate', { cause });
        }
        if (result === false) {
          // libsodium-wrappers signals an authentication failure by returning `false` for some
          // inputs and throwing for others. Both mean the same thing and both must be the same
          // exception here, or a caller would handle one and not the other.
          throw new StreamOpenFailed('a chunk failed to authenticate');
        }
        return {
          message: result.message,
          tag:
            result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
              ? 'final'
              : 'message',
        };
      },
    };
  },
};

/**
 * Seal a whole buffer, for the places small enough to hold in memory (a keyring snapshot, a test).
 *
 * Returns `header ‖ chunks`. The streaming paths in `M1-T25` and `M1-T27` do this a chunk at a
 * time over a `Transform`; this is the convenience form, and it uses the same code underneath so
 * the two cannot produce different bytes.
 */
export async function sealBuffer(
  stream: SecretStream,
  key: Uint8Array,
  plaintext: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  await stream.ready();
  const push = stream.initPush(key);
  const parts: Uint8Array[] = [push.header];
  // An empty plaintext still gets one `final` chunk, so the stream is well-formed and the
  // truncation check has something to find.
  const chunkCount = Math.max(1, Math.ceil(plaintext.length / CHUNK_BYTES));
  for (let index = 0; index < chunkCount; index += 1) {
    const slice = plaintext.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
    const isLast = index === chunkCount - 1;
    // The additional data binds only the first chunk (`08` §3.7.10), because the chaining then
    // carries it: a later chunk cannot be moved to the front without failing.
    parts.push(
      push.push(slice, isLast ? 'final' : 'message', index === 0 ? additionalData : undefined),
    );
  }
  return concat(parts);
}

/**
 * Open what `sealBuffer` produced.
 *
 * Throws `StreamTruncated` if the bytes run out before a `final` chunk, which is the check that
 * makes a half-copied backup fail loudly instead of restoring a partial database.
 */
export async function openBuffer(
  stream: SecretStream,
  key: Uint8Array,
  sealed: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  await stream.ready();
  if (sealed.length < HEADER_BYTES + ABYTES) {
    throw new StreamTruncated('the sealed value is shorter than a header plus one chunk');
  }
  const pull = stream.initPull(sealed.subarray(0, HEADER_BYTES), key);

  const parts: Uint8Array[] = [];
  let offset = HEADER_BYTES;
  let sawFinal = false;
  let index = 0;
  while (offset < sealed.length) {
    const end = Math.min(offset + CHUNK_BYTES + ABYTES, sealed.length);
    const { message, tag } = pull.pull(
      sealed.subarray(offset, end),
      index === 0 ? additionalData : undefined,
    );
    parts.push(message);
    offset = end;
    index += 1;
    if (tag === 'final') {
      sawFinal = true;
      break;
    }
  }
  if (!sawFinal) throw new StreamTruncated();
  return concat(parts);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
