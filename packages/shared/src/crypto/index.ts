/**
 * `@comvivo/shared/crypto` — the one directory that may import `node:crypto` or libsodium.
 *
 * `08` PSC-8 restricts those imports to this directory and `packages/storage/src/crypto`, enforced
 * by dependency-cruiser's `crypto-only-in-shared-crypto-and-storage-crypto` and proven by a planted
 * violation. The point is reviewability: "where does this product get its keys from, and what does
 * it do with them" has one answer, in one place, that a security reviewer can read end to end.
 *
 * What lives where:
 *
 * | Module | What |
 * |---|---|
 * | `random` | The CSPRNG. Bytes, ints, base64url tokens, Crockford typed codes |
 * | `labels` | Domain separators. **Frozen wire constants** — see the file |
 * | `hkdf` | The `02` §3.6.1 key tree |
 * | `wrap` | AES-256-GCM, for a key encrypting another key |
 * | `hmac` | SHA-256, HMAC-SHA256, keyed blob addresses |
 * | `equal` | Constant-time comparison |
 * | `scrypt` | The optional passphrase slot, and only that |
 * | `stream` | secretstream, for blob and backup bodies |
 * | `memory` | Zeroing, with an honest account of what it can promise |
 *
 * Not here: the keyring and `KeyService` (`M1-T5`), the recovery-key codec (`M1-T6`) and the blob
 * cipher (`M1-T25`). Those are *policy* over these primitives and live in
 * `packages/storage/src/crypto`, which is the other half of the PSC-8 allowance.
 */

export { secureEqual, secureEqualDigest } from './equal.js';
export { derivePurposeKey, hkdfSha256, KEY_BYTES } from './hkdf.js';
export {
  blobAddress,
  hmacSha256,
  hmacSha256Base64Url,
  type IncrementalHash,
  sha256,
  sha256Hex,
  sha256Stream,
} from './hmac.js';
export {
  AAD,
  BACKUP_ENTRY,
  BACKUP_FORMAT,
  BACKUP_MANIFEST_FORMAT,
  DOMAIN_SEPARATOR_PARTS,
  KEY_PURPOSE,
  KEYRING_FORMAT,
  type KeyPurpose,
  keyInfo,
  MAGIC,
  tokenMacPurpose,
} from './labels.js';
export { isZeroed, withZeroed, withZeroedAsync, zeroize, zeroizeAll } from './memory.js';
export {
  CROCKFORD_ALPHABET,
  fillRandom,
  randomBytes,
  randomInt,
  randomToken,
  randomTypedCode,
} from './random.js';
export {
  newScryptSalt,
  SALT_BYTES,
  SCRYPT_MAXMEM,
  SCRYPT_PARAMS,
  type ScryptParams,
  scryptKey,
  scryptKeySync,
} from './scrypt.js';
export {
  ABYTES,
  CHUNK_BYTES,
  type ChunkTag,
  HEADER_BYTES,
  openBuffer,
  type SecretStream,
  type SecretStreamPull,
  type SecretStreamPush,
  STREAM_KEY_BYTES,
  StreamOpenFailed,
  StreamTruncated,
  sealBuffer,
  wrappersSecretStream,
} from './stream.js';
export {
  NONCE_BYTES,
  sealedLength,
  TAG_BYTES,
  UnwrapFailed,
  unwrap,
  WRAP_KEY_BYTES,
  wrap,
} from './wrap.js';
