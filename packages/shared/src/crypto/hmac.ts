/**
 * SHA-256 and HMAC-SHA256 (`08` §3.7.1).
 *
 * Four uses in the product, and the distinction between them is the whole reason this file is not
 * just `createHash`:
 *
 *  - **Token digests at rest.** A session or MCP token is 256 bits of CSPRNG output, so a plain
 *    SHA-256 is the right thing to store: there is no password to grind, and a slow hash would
 *    cost a request's latency for nothing (`08` §3.7.1, "high-entropy secrets need no slow hash").
 *  - **The audit hash chain** (`02` §3.8), over RFC 8785 canonical JSON.
 *  - **Blob addresses** — `HMAC-SHA256(K_blobid, plaintext)`, `08` SD-06. Keyed on purpose: a
 *    plain hash would let anyone holding a candidate file confirm its presence in a host's store.
 *  - **Magic-link and CSRF MACs** (`08` §3.7.12).
 *
 * Reaching for the wrong one is the realistic mistake, so the names say which is which.
 */
import { createHash, createHmac } from 'node:crypto';

/** SHA-256 of `data`. For token digests and the audit chain, never for a passphrase. */
export function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

/**
 * An incremental SHA-256, for content that is never held whole.
 *
 * `02` §3.11's blob write path and `02` §3.14's backup both hash while streaming, because the
 * alternative is buffering a 50 MiB attachment to hash it — which on a Pi with 1 GiB is the
 * difference between working and not. A narrow interface rather than the `Hash` object, so a
 * caller cannot reach `copy()` or `digest()` twice and get a surprise: `digest` finalises, and
 * node's `Hash` throws on a second call.
 */
export interface IncrementalHash {
  update(data: Uint8Array): void;
  /** Finalises. Calling it twice throws, which is node's behaviour and not worth hiding. */
  digest(): Buffer;
}

export function sha256Stream(): IncrementalHash {
  const hash = createHash('sha256');
  return {
    update(data) {
      hash.update(data);
    },
    digest() {
      return hash.digest();
    },
  };
}

/** SHA-256 as lowercase hex, which is what `02`'s `sha256` columns hold. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** HMAC-SHA256 under `key`. For blob addresses, magic links and CSRF tokens. */
export function hmacSha256(key: Uint8Array, data: Uint8Array | string): Buffer {
  if (key.length === 0) {
    // An empty HMAC key is legal and useless: it turns a keyed hash into a public one, so a blob
    // address would stop being unguessable and a CSRF token would stop being a secret. This is the
    // shape an uninitialised or already-zeroed key buffer has.
    throw new RangeError('HMAC needs a non-empty key; an empty one makes the output public');
  }
  return createHmac('sha256', key).update(data).digest();
}

/** HMAC-SHA256 as base64url, which is what `08` §3.7.12's tokens carry. */
export function hmacSha256Base64Url(key: Uint8Array, data: Uint8Array | string): string {
  return hmacSha256(key, data).toString('base64url');
}

/**
 * A keyed blob address (`08` SD-06, `02` D14).
 *
 * Keyed rather than a plain content hash, and the reason is specific: a plain SHA-256 address
 * would let anyone who can read the filenames in `data/blobs/` confirm whether a *particular*
 * file — a photograph they already hold — is in a family's store, without decrypting anything.
 * With `K_blobid` they cannot.
 *
 * `K_blobid` is static across key generations (`02` D14) precisely so that addresses survive a
 * `rotate-data`, and it is in the `VBK1` keyring snapshot so they survive a restore.
 */
export function blobAddress(blobIdKey: Uint8Array, plaintext: Uint8Array): string {
  return hmacSha256(blobIdKey, plaintext).toString('hex');
}
