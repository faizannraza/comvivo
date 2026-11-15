/**
 * Reading the master key from whichever of `08` §3.7.3's five stores the host chose (`M3-T13`).
 *
 * One resolver, because the server's boot path and every `comvivo keys` command need the same
 * answer and would otherwise each implement `08` §3.7.3's table. The modes are not interchangeable
 * — each protects against something different and fails differently — so the thing that must not
 * drift is which failure a host is told about.
 *
 * | Mode | Where | The failure a host actually hits |
 * |---|---|---|
 * | `keyfile` | `security.keys.keyfilePath`, 0600 | the file is group- or world-readable |
 * | `keychain` | `@napi-rs/keyring`, host-installed | the module is not installed, or D-Bus is absent |
 * | `file` | `COMVIVO_MASTER_KEY_FILE` | the secret was not mounted |
 * | `env` | `COMVIVO_MASTER_KEY` (base64url) | the variable is not set, or is not 32 bytes |
 * | `passphrase` | scrypt over a supplied passphrase | no passphrase, and no TTY to ask on |
 *
 * ## Three rules from `08` §3.7.3, and which of them this module can keep
 *
 * 1. **"The process reads the MK once, then deletes it from `process.env`."** Kept here, for `env`
 *    mode, by `delete`ing the variable after reading it. Best effort and documented as such: V8
 *    has already copied the value into a JS string that cannot be zeroed, and `/proc/self/environ`
 *    on Linux still shows the original block. What it does buy is that a child process spawned
 *    later, a crash dump, and an accidental `console.log(process.env)` no longer carry it.
 * 2. **"Child processes never inherit it."** Not this module's — a spawn site decides its own
 *    `env` — but rule 1 is what makes the default `{ ...process.env }` safe, which is why both
 *    rules are in the same sentence of the spec.
 * 3. **"Keyfile mode bits are checked at boot… unless `--insecure-permissions`."** Kept, through
 *    `auditKeyPermissions`. The override is a parameter rather than a global, so a caller that
 *    wants it has to say so at the call site.
 */
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { BRAND, envVar, StorageError } from '@comvivo/shared';
import { KEY_BYTES, scryptKey } from '@comvivo/shared/crypto';
import { type Keychain, osKeychain } from './keychain.js';
import { auditKeyPermissions, KeyPermissionError } from './keyring-store.js';

/** `08` §3.7.3's five modes, as `security.keys.store` spells them. */
export const MASTER_KEY_STORES = ['keyfile', 'keychain', 'file', 'env', 'passphrase'] as const;

export type MasterKeyStore = (typeof MASTER_KEY_STORES)[number];

export interface MasterKeySource {
  readonly store: MasterKeyStore;
  /** `security.keys.keyfilePath`, relative to the install folder or absolute. */
  readonly keyfilePath: string;
  /** `security.keys.keychainService`. */
  readonly keychainService: string;
  /** The install folder a relative `keyfilePath` is resolved against. */
  readonly dir: string;
}

export interface ReadMasterKeyOptions {
  readonly source: MasterKeySource;
  /** `process.env`, injected so a test needs no global mutation. */
  readonly env: Record<string, string | undefined>;
  /**
   * The passphrase, for `passphrase` mode.
   *
   * Supplied by the caller rather than prompted for here: `09` §3.11.2 forbids a secret as a flag
   * *value* and allows a hidden prompt, `--*-file` or stdin — all three of which are the CLI's to
   * offer, and none of which belong in a storage module.
   */
  readonly passphrase?: string | undefined;
  /** The scrypt salt for `passphrase` mode, from the keyring's passphrase slot. */
  readonly passphraseSalt?: Uint8Array | undefined;
  /** `08` §3.7.3's ssh-style override for keyfile mode bits. */
  readonly insecurePermissions?: boolean | undefined;
  /** Injected for tests; the real OS keychain otherwise. */
  readonly keychain?: Keychain | undefined;
}

/** `08` §3.7.3: the key is 32 bytes, base64url when it travels as text. */
function decodeKey(text: string, where: string): Buffer {
  const trimmed = text.trim();
  // base64url **and** base64: a host pasting from a password manager gets whichever the manager
  // produced, and refusing one of the two spellings for a value that decodes to the same bytes
  // would be a failure nobody could diagnose from the message.
  const decoded = Buffer.from(trimmed.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (decoded.length !== KEY_BYTES) {
    throw new StorageError(
      'STORAGE_KEY_INVALID',
      `the master key in ${where} is ${String(decoded.length)} bytes, not ${String(KEY_BYTES)}`,
      {
        hint:
          `${BRAND.displayName}'s master key is ${String(KEY_BYTES)} random bytes, base64url. ` +
          'A truncated or re-encoded value cannot be recovered from — restore from a backup with ' +
          `\`${BRAND.cliName} restore\` and the recovery key.`,
      },
    );
  }
  return decoded;
}

function missing(where: string, hint: string): StorageError {
  return new StorageError('STORAGE_KEY_MISSING', `the master key is not in ${where}`, { hint });
}

/**
 * Read the master key (`08` §3.7.3).
 *
 * Returns a `Buffer` the caller owns and should zero when it is done — `withZeroed` in
 * `key-service.ts` is the helper for that. Not zeroed here, because the one thing this function
 * cannot know is when the caller has finished deriving from it.
 */
export async function readMasterKey(options: ReadMasterKeyOptions): Promise<Buffer> {
  // One function per store, dispatched by a total `Record`. A single `switch` with the five bodies
  // inline was the first version and `noExcessiveCognitiveComplexity` was right about it at 30:
  // each arm has its own `try`, its own two failure messages and its own nesting, and reading any
  // one of them meant holding the other four. A total mapping also makes a sixth store a compile
  // error here rather than a silent fall-through.
  return await READERS[options.source.store](options);
}

type StoreReader = (options: ReadMasterKeyOptions) => Promise<Buffer>;

const READERS: Readonly<Record<MasterKeyStore, StoreReader>> = {
  keyfile: fromKeyfile,
  keychain: fromKeychain,
  file: fromSecretFile,
  env: fromEnvironment,
  passphrase: fromPassphrase,
};

/** `08` §3.7.3's default: `data/keys/master.key`, 0600, beside a 0700 directory. */
async function fromKeyfile(options: ReadMasterKeyOptions): Promise<Buffer> {
  const { source } = options;
  const path = isAbsolute(source.keyfilePath)
    ? source.keyfilePath
    : resolve(source.dir, source.keyfilePath);
  // Mode bits **before** the read, so a world-readable key is reported as the problem it is rather
  // than used and complained about afterwards. `auditKeyPermissions` throws `KeyPermissionError`
  // itself unless `allowInsecure` is set, which is `08` §3.7.3's ssh-style override — and it audits
  // the **directory** as well, because a readable `keys/` leaks which unlock modes are in use.
  await auditKeyPermissions(
    dirname(path),
    [basename(path)],
    undefined,
    options.insecurePermissions === true ? { allowInsecure: true } : {},
  );
  try {
    return decodeKey(await readFile(path, 'utf8'), path);
  } catch (cause) {
    if (cause instanceof StorageError || cause instanceof KeyPermissionError) throw cause;
    throw missing(
      path,
      `Run \`${BRAND.cliName} doctor\` to check the key directory. If the file is gone, ` +
        `restore from a backup with \`${BRAND.cliName} restore\` and the recovery key — ` +
        'there is no other way back in.',
    );
  }
}

/** The OS keychain (`@napi-rs/keyring`, host-installed). */
async function fromKeychain(options: ReadMasterKeyOptions): Promise<Buffer> {
  // `KeychainUnavailable` from `osKeychain` already carries `08` §3.7.3's advice, including that
  // keyfile mode is the right answer on a headless Linux host. Not re-wrapped.
  const keychain = options.keychain ?? osKeychain(options.source.keychainService);
  const stored = await keychain.get();
  if (stored === undefined) {
    throw missing(
      `the OS keychain (service ${options.source.keychainService})`,
      'The entry is absent or the keychain is locked. Unlock it and try again, or switch to ' +
        `keyfile mode. \`${BRAND.cliName} doctor\` reports which store is configured.`,
    );
  }
  return decodeKey(stored, 'the OS keychain');
}

/** A mounted secret: a Docker secret, or systemd-creds' decrypted credential. */
async function fromSecretFile(options: ReadMasterKeyOptions): Promise<Buffer> {
  const variable = envVar('MASTER_KEY_FILE');
  const path = options.env[variable];
  if (path === undefined || path === '') {
    throw missing(
      variable,
      `Point ${variable} at the mounted secret — a Docker secret, or systemd-creds' ` +
        `\`%d/${BRAND.slug}_mk\`.`,
    );
  }
  try {
    return decodeKey(await readFile(path, 'utf8'), path);
  } catch (cause) {
    if (cause instanceof StorageError) throw cause;
    throw missing(path, `${variable} points at ${path}, which could not be read.`);
  }
}

/** `COMVIVO_MASTER_KEY`, base64url. `08` §3.7.3 calls this a last resort and doctor warns. */
function fromEnvironment(options: ReadMasterKeyOptions): Promise<Buffer> {
  const variable = envVar('MASTER_KEY');
  const value = options.env[variable];
  if (value === undefined || value === '') {
    throw missing(
      variable,
      `Set ${variable} to the base64url master key. ${BRAND.displayName} prefers a file or the ` +
        'keychain: an environment variable is visible in `docker inspect` and in ' +
        '`/proc/*/environ`, and `doctor` warns about it.',
    );
  }
  const key = decodeKey(value, variable);
  // `08` §3.7.3 rule 1, and the module header says what it does and does not buy.
  //
  // `= undefined` rather than `delete`: the lint rule against a dynamic delete is right that it
  // deoptimises the object's shape, and the two are equivalent here — every reader of this record
  // checks for `undefined`, which an unset key and a deleted key both give.
  options.env[variable] = undefined;
  return Promise.resolve(key);
}

/** scrypt over a passphrase and the keyring's salt. No key at rest (`08` §3.7.3). */
async function fromPassphrase(options: ReadMasterKeyOptions): Promise<Buffer> {
  if (options.passphrase === undefined || options.passphrase === '') {
    throw missing(
      'the passphrase prompt',
      `Set ${envVar('PASSPHRASE_FILE')} to a file holding it, or run in a terminal where ` +
        `${BRAND.displayName} can ask. Passphrase mode keeps no key at rest, which is why it ` +
        'cannot start unattended.',
    );
  }
  if (options.passphraseSalt === undefined) {
    // The salt lives in the keyring's passphrase slot (`08` §3.7.4), so a caller that has not
    // loaded the keyring cannot derive the key. A random salt here would produce a different key
    // every time and read to the host as a wrong passphrase, which is the worst misdirection
    // available — so it is refused as a caller error.
    throw new StorageError(
      'STORAGE_KEY_MISSING',
      'passphrase mode needs the keyring’s passphrase slot, which was not supplied',
      {
        hint: `Run \`${BRAND.cliName} keys status\` to check that a passphrase slot exists.`,
        category: 'bug',
      },
    );
  }
  return await scryptKey(options.passphrase, options.passphraseSalt);
}
