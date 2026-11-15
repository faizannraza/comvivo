/**
 * Opening a keyring, and the keys that open it (`08` §3.7.3, §3.7.8; `M3-T13`).
 *
 * Every `comvivo keys` subcommand starts the same way — find the install, read
 * `data/keys/keyring.json`, and get hold of whichever key the operation needs — so that sequence
 * is here rather than eight times over.
 *
 * ## The three keys, and why a command asks for the narrowest one
 *
 * `08` §3.7.8's table is about which key you have left, and the commands mirror it:
 *
 *  - **nothing** — `keys status` reads the keyring and no key at all. That is what makes it the
 *    command a host runs when something is wrong: it cannot fail for want of a key.
 *  - **the master key** — `rotate-master`, `rotate-recovery`, `add-passphrase`, `remove-slot`,
 *    `purge-retired`. Read from `security.keys.store` through `readMasterKey`.
 *  - **the recovery key** — `verify-recovery` and `recover`, typed by the host. Never read from a
 *    file by default: `08` SD-04 keeps it off the host, so the only places it comes from are the
 *    terminal and an explicit `--recovery-key-file`.
 *
 * Asking for the narrowest one is not tidiness. A command that loaded the master key it did not
 * need would fail on a host whose master key is gone — which is exactly the host that needs
 * `keys status` to work.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BRAND, envVar } from '@comvivo/shared';
import {
  KEYRING_FILENAME,
  type Keyring,
  KeyringError,
  KeyringStore,
  type MasterKeySource,
  type MasterKeyStore,
  readMasterKey,
} from '@comvivo/storage/crypto';
import { parse as parseYaml } from 'yaml';
import type { CliContext } from '../context.js';
import { copy } from '../copy.js';
import { CLI_EXIT, CliError } from '../exit-codes.js';

/** Where the key files live, relative to the data directory (`08` §3.7.4). */
export const KEYS_SUBDIR = 'keys';

export interface OpenedKeyring {
  readonly store: KeyringStore;
  readonly keyring: Keyring;
  readonly keysDir: string;
}

/**
 * `security.keys` from the configuration file, with the schema's defaults.
 *
 * A narrow read for the same reason `context.ts` reads `instance.dataDir` narrowly: the command
 * that explains a broken configuration has to start. The defaults are `config/schema.ts`'s, and
 * they are repeated here rather than imported because importing the whole config schema would
 * mean parsing — and failing on — every unrelated key.
 */
export function keySourceFor(context: CliContext): MasterKeySource {
  const fallback: Omit<MasterKeySource, 'dir'> = {
    store: 'keyfile',
    keyfilePath: './data/keys/master.key',
    keychainService: BRAND.slug,
  };
  let configured: Omit<MasterKeySource, 'dir'> = fallback;
  if (context.configExists) {
    try {
      const parsed = parseYaml(configText(context.configPath)) as unknown;
      const keys = (parsed as { security?: { keys?: Record<string, unknown> } } | null)?.security
        ?.keys;
      if (keys !== undefined) {
        configured = {
          store: (typeof keys['store'] === 'string'
            ? keys['store']
            : fallback.store) as MasterKeyStore,
          keyfilePath:
            typeof keys['keyfilePath'] === 'string' ? keys['keyfilePath'] : fallback.keyfilePath,
          keychainService:
            typeof keys['keychainService'] === 'string'
              ? keys['keychainService']
              : fallback.keychainService,
        };
      }
    } catch {
      // Left at the defaults. `doctor` is the command that reports a malformed file, and it needs
      // to be able to start.
    }
  }
  return { ...configured, dir: context.dir };
}

/**
 * The configuration file's text, or `''` when it cannot be read.
 *
 * Synchronous, and that is a deliberate narrow exception: this runs once at command start, before
 * anything else happens, on one small file. Making it async would make `keySourceFor` async for no
 * benefit, since every caller awaits the keyring on the next line.
 */
function configText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Read the keyring, or say what to do about its absence.
 *
 * `08` §3.7.4 puts it at `data/keys/keyring.json`. A missing one means there is no install here
 * *yet* — which is a different sentence from a missing master key, and `comvivo init` is the
 * answer to one and `comvivo restore` to the other.
 */
export async function openKeyring(context: CliContext): Promise<OpenedKeyring> {
  const keysDir = resolve(context.dataDir, KEYS_SUBDIR);
  const store = new KeyringStore(keysDir);
  if (!(await store.exists())) {
    throw new CliError(
      CLI_EXIT.config,
      'NO_KEYRING',
      copy('error.noKeyring', { path: resolve(keysDir, KEYRING_FILENAME) }),
      { hint: copy('error.noKeyring.hint') },
    );
  }
  try {
    return { store, keyring: await store.read(), keysDir };
  } catch (cause) {
    if (cause instanceof KeyringError) {
      throw new CliError(CLI_EXIT.integrity, cause.code, cause.message, {
        hint: cause.hint,
        cause,
      });
    }
    throw cause;
  }
}

/** The master key, from whichever store the host configured (`08` §3.7.3). */
export async function openMasterKey(
  context: CliContext,
  options: {
    readonly env: Record<string, string | undefined>;
    readonly insecurePermissions?: boolean | undefined;
    readonly passphrase?: string | undefined;
    readonly passphraseSalt?: Uint8Array | undefined;
  },
): Promise<Buffer> {
  return await readMasterKey({
    source: keySourceFor(context),
    env: options.env,
    ...(options.insecurePermissions === undefined
      ? {}
      : { insecurePermissions: options.insecurePermissions }),
    ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
    ...(options.passphraseSalt === undefined ? {} : { passphraseSalt: options.passphraseSalt }),
  });
}

/**
 * The typed recovery key, from `--recovery-key-file` or from stdin.
 *
 * `09` §3.11.2 forbids a secret as a flag **value** — it would be in the shell history — so the
 * two routes are a file and stdin. There is deliberately no environment variable: the recovery
 * key is the one secret `08` SD-04 keeps off the host entirely, and an environment variable is a
 * place it would come to live.
 */
export async function readRecoveryKey(options: {
  readonly file?: string | undefined;
  readonly stdin: () => Promise<string>;
  readonly canPrompt: boolean;
}): Promise<string> {
  if (options.file !== undefined && options.file !== '') {
    try {
      return (await readFile(options.file, 'utf8')).trim();
    } catch (cause) {
      throw new CliError(
        CLI_EXIT.permission,
        'RECOVERY_KEY_FILE_UNREADABLE',
        copy('error.recoveryKeyFileUnreadable', { path: options.file }),
        { hint: copy('error.fileUnreadable.hint'), cause },
      );
    }
  }
  if (!options.canPrompt) {
    throw new CliError(CLI_EXIT.config, 'MISSING_INPUT', copy('error.recoveryKeyRequired'), {
      hint: copy('error.recoveryKeyRequired.hint'),
    });
  }
  const typed = (await options.stdin()).trim();
  if (typed === '') {
    throw new CliError(CLI_EXIT.config, 'MISSING_INPUT', copy('error.recoveryKeyEmpty'), {
      hint: copy('error.recoveryKeyEmpty.hint'),
    });
  }
  return typed;
}

/** `08` §3.7.3's passphrase file, for a host whose store is `passphrase`. */
export async function readPassphrase(
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const path = env[envVar('PASSPHRASE_FILE')];
  if (path === undefined || path === '') return undefined;
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch (cause) {
    throw new CliError(
      CLI_EXIT.permission,
      'PASSPHRASE_FILE_UNREADABLE',
      copy('error.passphraseFileUnreadable', { variable: envVar('PASSPHRASE_FILE'), path }),
      { hint: copy('error.fileUnreadable.hint'), cause },
    );
  }
}
