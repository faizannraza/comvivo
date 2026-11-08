/**
 * A frozen known-answer vector for the XChaCha20-Poly1305 secretstream (`08` §3.7.10).
 *
 * Shared between `crypto/kat.test.ts`, which asserts `libsodium-wrappers` reproduces it, and
 * `crypto/stream.contract.test.ts`, which asserts `sodium-native` reproduces the **same bytes**.
 * That pair is what makes `02` D13's implementation switch safe: two implementations agreeing with
 * each other could both be wrong in the same way, and only fixed bytes rule that out.
 *
 * ## Why a pull vector
 *
 * `crypto_secretstream_xchacha20poly1305_init_push` generates its header randomly and libsodium
 * exposes no way to supply one, so there is no deterministic push to pin. Pinning the pull side
 * constrains everything that matters anyway — the header-to-subkey derivation, the sequential
 * nonce schedule, the per-chunk tag byte and the Poly1305 authenticator — because all of them
 * must be reproduced exactly for the plaintext to come back.
 *
 * Generated once against `libsodium-wrappers` and frozen. Regenerating it to make a test pass
 * would defeat the point: a change here means the wire format moved, and every `.vbak` archive
 * and encrypted blob already written uses the old one.
 */

/** One chunk of the vector: its ciphertext, the plaintext it must yield, and its tag. */
export interface SecretStreamVectorChunk {
  readonly cipherHex: string;
  readonly plain: string;
  readonly tag: 'message' | 'final';
}

export interface SecretStreamVector {
  /** 32 bytes of `0x42`, written out so the vector is self-describing. */
  readonly keyHex: string;
  readonly headerHex: string;
  readonly chunks: readonly SecretStreamVectorChunk[];
}

export const SECRETSTREAM_VECTOR: SecretStreamVector = {
  keyHex: '42'.repeat(32),
  headerHex: 'f5b8a87fe608f7f3a2048287cd0832c18c0e61bdc893a037',
  chunks: [
    {
      cipherHex:
        '9d54b28fe5b8e702845df1973c6b7ec4738a4ab31d4c382ead2e0efe36861e7475b274bc81b5649401bcfe',
      // Deliberately brand-free. `brand:check` forbids a brand literal under `packages/**` so a
      // rename stays one command — and here that is not merely a style rule: the plaintext is
      // bound into the frozen ciphertext, so a value derived from `BRAND` would make the vector
      // unopenable the moment the product were renamed. Same category as `VRK1`.
      plain: 'secretstream kat chunk one',
      tag: 'message',
    },
    {
      cipherHex: 'e7c54f6dbade0ecfedc36b8320b0ab300d40002538e81912765550320c3e39f30ccb6cad',
      plain: 'and the final chunk',
      tag: 'final',
    },
  ],
};

/** The vector's key as bytes. */
export function vectorKey(): Uint8Array {
  return Uint8Array.from(Buffer.from(SECRETSTREAM_VECTOR.keyHex, 'hex'));
}

/** The vector's header as bytes. */
export function vectorHeader(): Uint8Array {
  return Uint8Array.from(Buffer.from(SECRETSTREAM_VECTOR.headerHex, 'hex'));
}

/** One chunk's ciphertext as bytes. */
export function vectorChunk(index: number): Uint8Array {
  const chunk = SECRETSTREAM_VECTOR.chunks[index];
  if (chunk === undefined) throw new Error(`no vector chunk at ${String(index)}`);
  return Uint8Array.from(Buffer.from(chunk.cipherHex, 'hex'));
}
