/**
 * The passphrase slot's KDF (`08` §3.7.1, `02` §3.6.1).
 *
 * scrypt with N=2^17, r=8, p=1. One place in the product uses this: the **optional** passphrase
 * slot on the keyring, which wraps the root data key alongside the master key and the printed
 * recovery key. Nothing else derives a key from anything a human chose, which is why this is a
 * small file.
 *
 * The parameters matter more than they look:
 *
 *  - **N=2^17** (131,072) with r=8 needs 128 · N · r = **128 MiB** of memory and takes on the
 *    order of a second on a Pi 5. That is deliberately slow and deliberately memory-hard: the
 *    threat is an attacker with the keyring file and a GPU, and memory-hardness is what makes a
 *    GPU no better than a CPU.
 *  - **`maxmem` must be raised.** Node defaults to 32 MiB and throws above it, so the default
 *    parameters do not work with the default limit — a trap that would surface as a crash the
 *    first time a host set a passphrase, not in any test that used smaller parameters.
 *  - **The parameters are stored with the slot**, not assumed. `08` §3.7.2's slot carries
 *    `kdf: { alg: 'scrypt', N, r, p, salt }`, so raising them later still unlocks an old keyring,
 *    and Argon2id can be added as a second `alg` when Node's binding is old enough to rely on
 *    (`crypto.argon2` arrived in 24.7.0, above our 24.11 floor but not worth the risk yet).
 */
import { scrypt as nodeScrypt, scryptSync } from 'node:crypto';
import { promisify } from 'node:util';
import { KEY_BYTES } from './hkdf.js';
import { randomBytes } from './random.js';

/**
 * `promisify` cannot express `scrypt`'s options overload, so the signature is named here.
 *
 * Node's `scrypt` has two shapes — `(password, salt, keylen, cb)` and
 * `(password, salt, keylen, options, cb)` — and `promisify`'s type picks the first, so passing
 * options is a type error even though it is the only form this product uses. Writing the type out
 * is better than casting at the call site: the cast would hide a genuine argument mistake.
 */
const scryptAsync = promisify(nodeScrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** `08` §3.7.1's parameters. Stored with every slot so a change stays backwards-compatible. */
export const SCRYPT_PARAMS = Object.freeze({
  /** 2^17. */
  N: 131_072,
  r: 8,
  p: 1,
} as const);

/** 128 · N · r = 128 MiB for the parameters above; `08` §3.7.1 allows 256 MiB of headroom. */
export const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/** A salt for a new slot. 16 bytes is the usual floor and plenty for a per-slot value. */
export const SALT_BYTES = 16;

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** A fresh salt for a new passphrase slot. */
export function newScryptSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

function assertParams(params: ScryptParams): void {
  const { N, r, p } = params;
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0) {
    throw new RangeError(`scrypt N must be a power of two greater than 1, got ${String(N)}`);
  }
  if (!Number.isInteger(r) || r < 1 || !Number.isInteger(p) || p < 1) {
    throw new RangeError('scrypt r and p must be positive integers');
  }
  const needed = 128 * N * r;
  if (needed > SCRYPT_MAXMEM) {
    // Node would throw its own error here, but a long way from the parameters that caused it.
    throw new RangeError(
      `scrypt with N=${String(N)}, r=${String(r)} needs ${String(Math.round(needed / 1024 / 1024))} MiB, ` +
        `above the ${String(SCRYPT_MAXMEM / 1024 / 1024)} MiB limit in 08 §3.7.1`,
    );
  }
}

/**
 * Derive a key from a passphrase.
 *
 * Asynchronous by default: this takes about a second and runs on the libuv threadpool, so a
 * synchronous version would stall every other request on the server for that second. The
 * synchronous one exists for the CLI, where there is nothing else to stall.
 */
export async function scryptKey(
  passphrase: string,
  salt: Uint8Array,
  params: ScryptParams = SCRYPT_PARAMS,
  length = KEY_BYTES,
): Promise<Buffer> {
  assertParams(params);
  if (passphrase === '') {
    // An empty passphrase would derive a perfectly good key from nothing, so the slot would look
    // protected and would not be. `08` §3.7.6's ceremony copy asks for a real one.
    throw new RangeError('a passphrase slot needs a non-empty passphrase');
  }
  return scryptAsync(passphrase, Buffer.from(salt), length, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** The synchronous form, for the CLI's unlock path where blocking is correct. */
export function scryptKeySync(
  passphrase: string,
  salt: Uint8Array,
  params: ScryptParams = SCRYPT_PARAMS,
  length = KEY_BYTES,
): Buffer {
  assertParams(params);
  if (passphrase === '') {
    throw new RangeError('a passphrase slot needs a non-empty passphrase');
  }
  return scryptSync(passphrase, Buffer.from(salt), length, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
}
