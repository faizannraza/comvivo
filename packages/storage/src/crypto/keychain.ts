/**
 * The OS keychain, behind a lazy optional import (`08` §3.7.3).
 *
 * `@napi-rs/keyring` is an **optional** dependency and is loaded only when keychain mode is
 * actually configured. Three reasons, and the third is the one that matters:
 *
 *  - it is a native addon with a per-platform binary, so requiring it would make every install
 *    download one whether or not the host uses it;
 *  - on headless Linux it needs D-Bus and an unlocked Secret Service, which a server does not
 *    have, and merely importing a Secret Service client can block;
 *  - `08` §3.7.3 is explicit that keychain mode is "not for headless Linux", so a product that
 *    loaded it eagerly would be slower and more fragile for the majority of installs in order to
 *    serve a minority better.
 *
 * **Not installed today.** Keychain mode is reachable only when a host configures it, so the
 * dependency is declared `optional` and absent from a default `pnpm install`. The import is
 * therefore both lazy *and* allowed to fail, and the failure is a clear message rather than a
 * stack trace: `08` §3.7.3's table promises desktop users this mode, and the honest version of
 * "not available" names what to install.
 */
import { BRAND } from '@comvivo/shared';
import { zeroize } from '@comvivo/shared/crypto';

/**
 * The default service name the entry is stored under.
 *
 * A **default**, not a constant: `08` §3.7.3's config block exposes
 * `security.keys.keychainService`, and `config/schema.ts` defaults it to the same value. That
 * indirection is what makes a product rename survivable here — the keychain entry keeps the name
 * it was created under, so a host who upgrades across a rename points the new build at the old
 * entry instead of losing the master key. Unlike the HKDF and AAD labels in
 * `shared/crypto/labels.ts`, this string is a lookup key the host can see and change, so it is
 * derived from `BRAND` and overridable rather than frozen.
 */
export const DEFAULT_KEYCHAIN_SERVICE = BRAND.slug;

/** The account within the service. Never renamed: there is one master key per service. */
export const KEYCHAIN_ACCOUNT = 'master-key';

/** The slice of `@napi-rs/keyring` this adapter uses. */
interface KeyringEntry {
  getPassword(): string;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

interface NapiKeyring {
  readonly Entry: new (service: string, account: string) => KeyringEntry;
}

/**
 * How the adapter obtains the library.
 *
 * Injected for the same reason `KeyringIo` and `UnlockIo` are: the real one cannot run in a test.
 * `@napi-rs/keyring` is a native addon that talks to the login keyring, so a test that used it
 * would prompt on macOS, fail on headless Linux, and leave a real credential behind on whichever
 * machine it did pass. Injecting the loader is what makes the two things worth asserting testable
 * — that the **configured** service name reaches the library, and that a missing library produces
 * advice instead of a stack trace.
 */
export type KeyringLoader = () => Promise<NapiKeyring>;

export class KeychainUnavailable extends Error {
  readonly hint: string;

  constructor(message: string, hint: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'KeychainUnavailable';
    this.hint = hint;
  }
}

/**
 * Load `@napi-rs/keyring`, or explain why not.
 *
 * The specifier is built at run time so neither `tsc` nor dependency-cruiser sees a static edge to
 * a package that is not installed — the same arrangement `shared/crypto/stream-native.ts` uses for
 * `sodium-native`, and for the same reason.
 */
export async function loadKeyring(): Promise<NapiKeyring> {
  const moduleName = '@napi-rs/keyring';
  try {
    return (await import(moduleName)) as NapiKeyring;
  } catch (cause) {
    throw new KeychainUnavailable(
      'keychain mode needs @napi-rs/keyring, which is not installed',
      'Install it with `pnpm add -w @napi-rs/keyring`, or switch to the default keyfile mode: ' +
        `\`${BRAND.cliName} keys rotate-master --key-store keyfile\`. On a headless Linux host ` +
        'keyfile mode is the right answer anyway — the OS keychain needs D-Bus and an unlocked ' +
        'session.',
      { cause },
    );
  }
}

/** The keychain operations the unlock path and `comvivo keys` need. */
export interface Keychain {
  get(): Promise<string | undefined>;
  set(value: string): Promise<void>;
  delete(): Promise<boolean>;
}

/**
 * The real OS keychain, for one service name.
 *
 * A factory rather than a singleton so the configured `keychainService` reaches it. Every call
 * loads the module on demand rather than caching it, because the cost is a single resolved
 * `import` after the first time and the alternative — module-level state holding a native handle —
 * is the thing that makes a process impossible to test and awkward to shut down.
 */
export function osKeychain(
  service: string = DEFAULT_KEYCHAIN_SERVICE,
  load: KeyringLoader = loadKeyring,
): Keychain {
  return {
    async get(): Promise<string | undefined> {
      const { Entry } = await load();
      try {
        return new Entry(service, KEYCHAIN_ACCOUNT).getPassword();
      } catch {
        // The library throws for "no such entry" as well as for "the keyring is locked", and the
        // two are indistinguishable through its API. `undefined` lets `resolveUnlock` produce the
        // right message for both: keychain mode is configured and the keychain gave us nothing.
        return undefined;
      }
    },

    async set(value: string): Promise<void> {
      const { Entry } = await load();
      new Entry(service, KEYCHAIN_ACCOUNT).setPassword(value);
    },

    async delete(): Promise<boolean> {
      const { Entry } = await load();
      try {
        return new Entry(service, KEYCHAIN_ACCOUNT).deletePassword();
      } catch {
        return false;
      }
    },
  };
}

/**
 * Store a master key in the keychain, then zero the caller’s buffer.
 *
 * The encoding is base64url, matching `08` §3.7.3's `env` row, so a key can be moved between
 * unlock modes by copying the same text. Zeroing here rather than leaving it to the caller because
 * this is the last function that needs the bytes.
 */
export async function storeMasterKey(
  key: Buffer,
  keychain: Keychain = osKeychain(),
): Promise<void> {
  const encoded = key.toString('base64url');
  try {
    await keychain.set(encoded);
  } finally {
    zeroize(key);
  }
}
