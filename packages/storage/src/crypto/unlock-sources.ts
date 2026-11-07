/**
 * Where the master key comes from (`08` §3.7.3, §3.7.5).
 *
 * `08` §3.7.5 fixes the resolution order:
 *
 *   `COMVIVO_MASTER_KEY_FILE` → `COMVIVO_MASTER_KEY` → `keychain` → `keyfile` → `passphrase`
 *
 * The order is not arbitrary, and getting it wrong would be a security bug rather than an
 * inconvenience. The environment comes first because that is how a container or a systemd unit
 * injects a key deliberately, and a host who has set `COMVIVO_MASTER_KEY_FILE` must not have it
 * silently ignored in favour of a stale `master.key` left on the disk — that would mean the key
 * they rotated away from is still the one in use.
 *
 * Three rules from §3.7.3 that this module is responsible for:
 *
 *  - **The key is read once and then removed from `process.env`.** A key sitting in the environment
 *    is readable through `/proc/<pid>/environ` by the same user for the life of the process, and it
 *    ends up in `docker inspect` and in crash reports.
 *  - **Child processes never inherit it** (S9). Deleting it from `process.env` is what implements
 *    that, since a child gets a copy of whatever is there at spawn time.
 *  - **Buffers are zeroed** once the key has been used.
 *
 * `08` §3.7.3's table is explicit that `env` is a last resort and that doctor warns about it. That
 * warning is produced here, as part of the result, rather than left to a separate check: the only
 * moment anybody knows which source was used is the moment it is used.
 */
import { readFile } from 'node:fs/promises';
import { BRAND, envVar } from '@comvivo/shared';
import { zeroize } from '@comvivo/shared/crypto';

/** The modes `08` §3.7.3 defines. */
export const UNLOCK_SOURCES = ['file', 'env', 'keychain', 'keyfile', 'passphrase'] as const;
export type UnlockSourceKind = (typeof UNLOCK_SOURCES)[number];

/** A resolved master key, and where it came from. */
export interface ResolvedUnlock {
  readonly kind: UnlockSourceKind;
  /** 32 bytes. The caller owns it and must zero it (`withZeroed` is the easy way). */
  readonly key: Buffer;
  /** Where it was found, for the `keys.unlocked` log line. Never the key itself. */
  readonly detail: string;
  /** Advice for `comvivo doctor`, if this source is one §3.7.3 warns about. */
  readonly warning?: string;
}

/** A passphrase-only install has no key to resolve; the caller prompts instead. */
export interface PassphraseRequired {
  readonly kind: 'passphrase';
  readonly detail: string;
}

export type UnlockOutcome = ResolvedUnlock | PassphraseRequired;

export function isPassphraseRequired(outcome: UnlockOutcome): outcome is PassphraseRequired {
  return !('key' in outcome);
}

export type UnlockErrorCode =
  | 'MASTER_KEY_NOT_FOUND'
  | 'MASTER_KEY_MALFORMED'
  | 'MASTER_KEY_UNREADABLE';

export class UnlockError extends Error {
  readonly code: UnlockErrorCode;
  readonly hint: string;

  constructor(code: UnlockErrorCode, message: string, hint: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UnlockError';
    this.code = code;
    this.hint = hint;
  }
}

/** `08` §3.7.2: a 256-bit key. */
const MASTER_KEY_BYTES = 32;

/**
 * The environment variables §3.7.5 reads, in order.
 *
 * Built with `envVar` rather than written out, because the prefix is part of the product name and
 * `13` §3.A.6 requires a rename to be one command. The legacy spellings are *not* accepted here:
 * `config/schema.ts` takes `VILLAGE_*` with a deprecation warning for non-secret settings, but a
 * master key read from a stale variable name would silently unlock with the wrong provenance in
 * the `keys.unlocked` audit record. A host who renamed re-exports the variable.
 */
export const MASTER_KEY_FILE_ENV = envVar('MASTER_KEY_FILE');
export const MASTER_KEY_ENV = envVar('MASTER_KEY');
export const PASSPHRASE_FILE_ENV = envVar('PASSPHRASE_FILE');

/**
 * Decode a master key from text.
 *
 * base64url per `08` §3.7.3's `env` row, with plain base64 and hex also accepted. Being generous
 * here is deliberate: the alternative is a host who pasted a hex key being told "malformed" with
 * no idea which encoding was wanted, during an outage. The length check is what actually matters,
 * and it is strict.
 */
export function decodeMasterKey(text: string): Buffer {
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new UnlockError(
      'MASTER_KEY_MALFORMED',
      'the master key is empty',
      'An empty key file or variable usually means a secret was not mounted. Check the path and ' +
        'the mount before anything else.',
    );
  }

  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) candidates.push(Buffer.from(trimmed, 'hex'));
  candidates.push(Buffer.from(trimmed, 'base64url'), Buffer.from(trimmed, 'base64'));

  for (const candidate of candidates) {
    if (candidate.length === MASTER_KEY_BYTES) return candidate;
  }

  // Deliberately reports the decoded length, not the input. The input is a key.
  const best = Math.max(...candidates.map((candidate) => candidate.length));
  throw new UnlockError(
    'MASTER_KEY_MALFORMED',
    `the master key decodes to ${String(best)} bytes, and must be ${String(MASTER_KEY_BYTES)}`,
    'A 256-bit key is 43 base64url characters or 64 hex characters. A truncated value is the ' +
      'usual cause — check for a missing newline or a shell quoting problem.',
  );
}

/** How `resolveUnlock` reads the world. Injected so the order can be tested without a filesystem. */
export interface UnlockIo {
  env(name: string): string | undefined;
  deleteEnv(name: string): void;
  readFile(path: string): Promise<string>;
  fileExists(path: string): Promise<boolean>;
  /** The OS keychain, or `undefined` when it is unavailable (`08` §3.7.3). */
  keychainGet(): Promise<string | undefined>;
}

export const nodeUnlockIo: UnlockIo = {
  env(name) {
    return process.env[name];
  },
  deleteEnv(name) {
    // `08` §3.7.3: read once, then remove, so a child process cannot inherit it (S9) and
    // `/proc/<pid>/environ` stops carrying it.
    //
    // `no-dynamic-delete` exists because a computed `delete` on an ordinary object is usually a
    // sign of using one as a map. `process.env` *is* a map, the key is one of two named constants,
    // and removing the entry is the entire security requirement — there is no non-deleting way to
    // stop a child inheriting a variable.
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- see above; this is S9.
    delete process.env[name];
  },
  async readFile(path) {
    return readFile(path, 'utf8');
  },
  async fileExists(path) {
    try {
      await readFile(path);
      return true;
    } catch {
      return false;
    }
  },
  keychainGet() {
    // The real keychain lives in `keychain.ts` behind a lazy optional import; this default never
    // reaches for it, so a process that has not opted in does not load a native addon. Returning a
    // resolved promise rather than being `async` because there is nothing to await — an `async`
    // method with no `await` reads as though there might be.
    return Promise.resolve(undefined);
  },
};

export interface ResolveOptions {
  /** The configured mode, from `comvivo.yaml`. `08` §3.7.3's table. */
  readonly configured?: 'keyfile' | 'keychain' | 'passphrase';
  /** Where `master.key` lives, for `keyfile` mode. */
  readonly keyfilePath: string;
  readonly io?: UnlockIo;
}

/**
 * Resolve the master key in `08` §3.7.5's order.
 *
 * Returns `PassphraseRequired` rather than prompting: a prompt needs a TTY, and this function runs
 * in the server, the CLI and tests. The caller decides how to ask.
 */
export async function resolveUnlock(options: ResolveOptions): Promise<UnlockOutcome> {
  const io = options.io ?? nodeUnlockIo;

  // 1. `COMVIVO_MASTER_KEY_FILE` — Docker secrets, systemd-creds. First because it is the most
  //    deliberate: a host who mounted a secret has said which key to use.
  const filePath = io.env(MASTER_KEY_FILE_ENV);
  if (filePath !== undefined && filePath !== '') {
    let text: string;
    try {
      text = await io.readFile(filePath);
    } catch (cause) {
      throw new UnlockError(
        'MASTER_KEY_UNREADABLE',
        `${MASTER_KEY_FILE_ENV} points at ${filePath}, which could not be read`,
        `The variable is set, so this is not a fallback situation — ${BRAND.displayName} will not quietly use ` +
          'a different key. Fix the mount or unset the variable.',
        { cause },
      );
    }
    // The *path* is removed from the environment too. It is not secret, but leaving it tells a
    // child process where the key is, and S9 says children get nothing.
    io.deleteEnv(MASTER_KEY_FILE_ENV);
    return { kind: 'file', key: decodeMasterKey(text), detail: filePath };
  }

  // 2. `COMVIVO_MASTER_KEY` — last resort, and doctor warns.
  const inline = io.env(MASTER_KEY_ENV);
  if (inline !== undefined && inline !== '') {
    const key = decodeMasterKey(inline);
    io.deleteEnv(MASTER_KEY_ENV);
    return {
      kind: 'env',
      key,
      detail: MASTER_KEY_ENV,
      warning:
        `The master key came from ${MASTER_KEY_ENV}. Any process running as this user can read ` +
        'it from the environment, and it appears in `docker inspect` and in CI logs. ' +
        `${MASTER_KEY_FILE_ENV} with a mounted secret is better, and the default keyfile mode is ` +
        'better still.',
    };
  }

  // 3. The OS keychain, only when configured — it needs D-Bus and an unlocked session on Linux,
  //    so probing it unasked would hang or warn on every headless host.
  if (options.configured === 'keychain') {
    const fromKeychain = await io.keychainGet();
    if (fromKeychain !== undefined) {
      return { kind: 'keychain', key: decodeMasterKey(fromKeychain), detail: 'OS keychain' };
    }
    throw new UnlockError(
      'MASTER_KEY_NOT_FOUND',
      'keychain mode is configured but the OS keychain returned nothing',
      'On a desktop, unlock your login keyring and try again. On a headless Linux host, ' +
        `keychain mode cannot work — switch to keyfile mode with \`${BRAND.cliName} keys ` +
        'rotate-master --key-store keyfile`.',
    );
  }

  // 4. The keyfile. The default, and the reason `comvivo init` hits five minutes.
  if (options.configured !== 'passphrase' && (await io.fileExists(options.keyfilePath))) {
    const text = await io.readFile(options.keyfilePath);
    return { kind: 'keyfile', key: decodeMasterKey(text), detail: options.keyfilePath };
  }

  // 5. A passphrase. No key at rest, so nothing to resolve — the caller prompts.
  if (options.configured === 'passphrase' || io.env(PASSPHRASE_FILE_ENV) !== undefined) {
    return {
      kind: 'passphrase',
      detail: io.env(PASSPHRASE_FILE_ENV) ?? 'TTY prompt',
    };
  }

  throw new UnlockError(
    'MASTER_KEY_NOT_FOUND',
    'no master key was found in any unlock source',
    `Looked at ${MASTER_KEY_FILE_ENV}, ${MASTER_KEY_ENV}, and ${options.keyfilePath}. ` +
      `If this is a new install, run \`${BRAND.cliName} init\`. If it is not, your key file is missing — ` +
      `restore it, or recover with your recovery key: \`${BRAND.cliName} keys recover\`.`,
  );
}

/**
 * Read a passphrase from `COMVIVO_PASSPHRASE_FILE`.
 *
 * A file rather than a variable, and never a command-line flag: a flag value is visible in `ps` to
 * every user on the machine, which `08` §3.7.8 calls out for the recovery key too.
 */
export async function readPassphraseFile(
  path: string,
  io: UnlockIo = nodeUnlockIo,
): Promise<string> {
  let text: string;
  try {
    text = await io.readFile(path);
  } catch (cause) {
    throw new UnlockError(
      'MASTER_KEY_UNREADABLE',
      `the passphrase file ${path} could not be read`,
      'Check the path and that the service user can read it.',
      { cause },
    );
  }
  // One trailing newline is what every editor and `echo` adds, and a passphrase is unlikely to end
  // in whitespace deliberately. Stripping the whole end rather than one `\n` so CRLF works too.
  const passphrase = text.replace(/\r?\n$/, '');
  if (passphrase === '') {
    throw new UnlockError(
      'MASTER_KEY_MALFORMED',
      `the passphrase file ${path} is empty`,
      'An empty passphrase file usually means a secret was not mounted.',
    );
  }
  return passphrase;
}

/** Zero a resolved key once it has been used. */
export function disposeUnlock(outcome: UnlockOutcome): void {
  if (!isPassphraseRequired(outcome)) zeroize(outcome.key);
}
