/**
 * The `sodium-native` implementation of `SecretStream` (`02` D13).
 *
 * **Not shipped today.** `02` D13 makes `libsodium-wrappers` (WASM) the default and this the
 * fallback *only if* SP-2 measures under 40 MB/s on a Raspberry Pi 5 — which is owner ask **H-10**
 * and not yet measured. `sodium-native` is a devDependency, and `no-dev-dep-in-src` would refuse a
 * production module that imported it, so the import here is **dynamic**: nothing loads it unless
 * `create()` is called, which today only the contract suite does.
 *
 * Why write it now rather than when the measurement comes in: `02` D13 claims the switch is
 * "wire-identical" and `08` §3.7.1 says "fallback `sodium-native` behind the same interface". Both
 * claims are worth nothing until there is a second implementation and something that runs the same
 * tests against both. The alternative is discovering the adapter's API differences on the day a
 * Pi 5 benchmark comes in badly, under time pressure, with a decision already made.
 *
 * It earned its place immediately: `sodium-native`'s secretstream API is **not** a drop-in. It
 * takes caller-allocated output buffers and an explicit state buffer, where `libsodium-wrappers`
 * returns values and hides the state. Finding that out now cost twenty minutes; finding it out
 * later would have cost a decision.
 */
import type { ChunkTag, SecretStream, SecretStreamPull, SecretStreamPush } from './stream.js';
import { ABYTES, HEADER_BYTES, STREAM_KEY_BYTES, StreamOpenFailed } from './stream.js';

/** The slice of `sodium-native` this adapter needs, so the dynamic import stays typed. */
interface SodiumNative {
  readonly crypto_secretstream_xchacha20poly1305_STATEBYTES: number;
  readonly crypto_secretstream_xchacha20poly1305_KEYBYTES: number;
  readonly crypto_secretstream_xchacha20poly1305_HEADERBYTES: number;
  readonly crypto_secretstream_xchacha20poly1305_ABYTES: number;
  readonly crypto_secretstream_xchacha20poly1305_TAGBYTES: number;
  readonly crypto_secretstream_xchacha20poly1305_TAG_MESSAGE: number;
  readonly crypto_secretstream_xchacha20poly1305_TAG_FINAL: number;
  crypto_secretstream_xchacha20poly1305_keygen(key: Buffer): void;
  crypto_secretstream_xchacha20poly1305_init_push(state: Buffer, header: Buffer, key: Buffer): void;
  crypto_secretstream_xchacha20poly1305_init_pull(state: Buffer, header: Buffer, key: Buffer): void;
  crypto_secretstream_xchacha20poly1305_push(
    state: Buffer,
    ciphertext: Buffer,
    message: Buffer,
    additionalData: Buffer | null,
    tag: number,
  ): void;
  crypto_secretstream_xchacha20poly1305_pull(
    state: Buffer,
    message: Buffer,
    tag: Buffer,
    ciphertext: Buffer,
    additionalData: Buffer | null,
  ): void;
}

/** The three sizes that have to agree for a file written by one library to open with the other. */
export interface StreamSizes {
  readonly keyBytes: number;
  readonly headerBytes: number;
  readonly aBytes: number;
}

/**
 * Refuse to build the adapter if `sodium-native` disagrees about any size.
 *
 * Exported and pure so it can be tested with mismatched values. The alternative — an inline `if`
 * inside `createNativeSecretStream` — is a branch that can only fire if an upstream library
 * changes its constants, so it would sit permanently uncovered and permanently unproven. This is
 * the premise of the whole fallback, so it is worth being able to show that the check works.
 */
export function assertWireCompatible(sizes: StreamSizes): void {
  const mismatches: string[] = [];
  if (sizes.keyBytes !== STREAM_KEY_BYTES) {
    mismatches.push(`key ${String(sizes.keyBytes)} != ${String(STREAM_KEY_BYTES)}`);
  }
  if (sizes.headerBytes !== HEADER_BYTES) {
    mismatches.push(`header ${String(sizes.headerBytes)} != ${String(HEADER_BYTES)}`);
  }
  if (sizes.aBytes !== ABYTES) {
    mismatches.push(`per-chunk overhead ${String(sizes.aBytes)} != ${String(ABYTES)}`);
  }
  if (mismatches.length > 0) {
    throw new Error(
      `sodium-native disagrees with libsodium-wrappers about secretstream sizes (${mismatches.join(', ')}), ` +
        'so a file written by one would not open with the other. Do not switch implementations ' +
        '(02 D13).',
    );
  }
}

function assertKey(key: Uint8Array): void {
  if (key.length !== STREAM_KEY_BYTES) {
    throw new RangeError(
      `a secretstream key is ${String(STREAM_KEY_BYTES)} bytes, got ${String(key.length)}`,
    );
  }
}

/**
 * Build the adapter, loading `sodium-native` on the way.
 *
 * Asynchronous because the import is. `SecretStream.ready()` is then a no-op: unlike the WASM
 * build, there is no runtime to wait for once the addon is loaded.
 */
export async function createNativeSecretStream(): Promise<SecretStream> {
  // Constructed at run time so neither `tsc` nor dependency-cruiser sees a static edge to a
  // devDependency. When D13 flips, this becomes a normal import and `sodium-native` moves to
  // `dependencies` — one line in each place.
  const moduleName = 'sodium-native';
  const sodium = (await import(moduleName)) as unknown as SodiumNative;

  assertWireCompatible({
    keyBytes: sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES,
    headerBytes: sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES,
    aBytes: sodium.crypto_secretstream_xchacha20poly1305_ABYTES,
  });

  return {
    name: 'sodium-native',

    ready(): Promise<void> {
      // Nothing to wait for: the addon is loaded by the time this object exists.
      return Promise.resolve();
    },

    keygen(): Uint8Array {
      const key = Buffer.alloc(STREAM_KEY_BYTES);
      sodium.crypto_secretstream_xchacha20poly1305_keygen(key);
      return key;
    },

    initPush(key: Uint8Array): SecretStreamPush {
      assertKey(key);
      const state = Buffer.alloc(sodium.crypto_secretstream_xchacha20poly1305_STATEBYTES);
      const header = Buffer.alloc(HEADER_BYTES);
      sodium.crypto_secretstream_xchacha20poly1305_init_push(state, header, Buffer.from(key));
      return {
        header,
        push(chunk: Uint8Array, tag: ChunkTag, additionalData?: Uint8Array): Uint8Array {
          const ciphertext = Buffer.alloc(chunk.length + ABYTES);
          sodium.crypto_secretstream_xchacha20poly1305_push(
            state,
            ciphertext,
            Buffer.from(chunk),
            additionalData === undefined ? null : Buffer.from(additionalData),
            tag === 'final'
              ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
              : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
          );
          return ciphertext;
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
      const state = Buffer.alloc(sodium.crypto_secretstream_xchacha20poly1305_STATEBYTES);
      sodium.crypto_secretstream_xchacha20poly1305_init_pull(
        state,
        Buffer.from(header),
        Buffer.from(key),
      );
      return {
        pull(
          chunk: Uint8Array,
          additionalData?: Uint8Array,
        ): { readonly message: Uint8Array; readonly tag: ChunkTag } {
          if (chunk.length < ABYTES) {
            throw new StreamOpenFailed('a chunk is shorter than the per-chunk overhead');
          }
          const message = Buffer.alloc(chunk.length - ABYTES);
          const tag = Buffer.alloc(sodium.crypto_secretstream_xchacha20poly1305_TAGBYTES);
          try {
            sodium.crypto_secretstream_xchacha20poly1305_pull(
              state,
              message,
              tag,
              Buffer.from(chunk),
              additionalData === undefined ? null : Buffer.from(additionalData),
            );
          } catch (cause) {
            // The native binding throws where the WASM one sometimes returns `false`. Normalised
            // to one exception type here, so a caller handles authentication failure the same way
            // whichever implementation is active — which is the point of the interface.
            throw new StreamOpenFailed('a chunk failed to authenticate', { cause });
          }
          return {
            message,
            tag:
              tag[0] === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
                ? 'final'
                : 'message',
          };
        },
      };
    },
  };
}
