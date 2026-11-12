/**
 * The OS keychain adapter (`08` §3.7.3).
 *
 * The library itself is never loaded here. `@napi-rs/keyring` is a native addon that talks to the
 * real login keyring, so a test that used it would prompt on macOS, fail on a headless Linux
 * runner, and leave an actual credential behind wherever it did pass. The loader is injected, so
 * what these tests cover is the part that is this project's: that the **configured** service name
 * reaches the library, that the master key is encoded the way `08` §3.7.3's `env` row says, that
 * the caller's buffer is always zeroed, and that a missing optional dependency produces advice.
 */
import { BRAND } from '@comvivo/shared';
import { isZeroed } from '@comvivo/shared/crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
  type Keychain,
  KeychainUnavailable,
  type KeyringLoader,
  loadKeyring,
  osKeychain,
  storeMasterKey,
} from './keychain.js';

/** A record of every `Entry` the adapter constructed, so the names can be asserted. */
interface Constructed {
  readonly service: string;
  readonly account: string;
}

interface FakeKeyringOptions {
  /** The value already in the keychain, if any. */
  readonly stored?: string;
  /** Throw from every entry method, as a locked keyring does. */
  readonly throws?: boolean;
}

function fakeLoader(options: FakeKeyringOptions = {}): {
  load: KeyringLoader;
  constructed: Constructed[];
  readonly value: () => string | undefined;
} {
  const constructed: Constructed[] = [];
  let stored = options.stored;

  class Entry {
    constructor(service: string, account: string) {
      constructed.push({ service, account });
    }

    getPassword(): string {
      if (options.throws === true) throw new Error('the keyring is locked');
      if (stored === undefined) throw new Error('no such entry');
      return stored;
    }

    setPassword(password: string): void {
      if (options.throws === true) throw new Error('the keyring is locked');
      stored = password;
    }

    deletePassword(): boolean {
      if (options.throws === true) throw new Error('the keyring is locked');
      const had = stored !== undefined;
      stored = undefined;
      return had;
    }
  }

  return {
    load: () => Promise.resolve({ Entry }),
    constructed,
    value: () => stored,
  };
}

describe('the service and account names', () => {
  it('defaults the service to the brand slug, so a rename is one command', () => {
    // Not a frozen wire constant: `08` §3.7.3's config block exposes `keychainService` and
    // `config/schema.ts` defaults it to the same value. Unlike the HKDF and AAD labels, this is a
    // lookup key a host can see and change, so it is derived rather than written out.
    expect(DEFAULT_KEYCHAIN_SERVICE).toBe(BRAND.slug);
  });

  it('keeps one account name, because there is one master key per service', () => {
    expect(KEYCHAIN_ACCOUNT).toBe('master-key');
  });

  it('passes the configured service name through to the library', async () => {
    // The behaviour the config key exists for: a host who upgraded across a rename points the new
    // build at the entry the old one created, instead of losing the master key.
    const fake = fakeLoader({ stored: 'stored-key' });
    await osKeychain('legacy-name', fake.load).get();
    expect(fake.constructed).toEqual([{ service: 'legacy-name', account: KEYCHAIN_ACCOUNT }]);
  });

  it('uses the default service name when none is configured', async () => {
    const fake = fakeLoader({ stored: 'stored-key' });
    await osKeychain(undefined, fake.load).get();
    expect(fake.constructed[0]?.service).toBe(DEFAULT_KEYCHAIN_SERVICE);
  });

  it('constructs a fresh entry per call rather than holding a native handle', async () => {
    // Module-level state holding a native handle is what makes a process awkward to shut down.
    const fake = fakeLoader({ stored: 'stored-key' });
    const keychain = osKeychain('svc', fake.load);
    await keychain.get();
    await keychain.get();
    expect(fake.constructed).toHaveLength(2);
  });
});

describe('reading and writing', () => {
  it('returns the stored value', async () => {
    const fake = fakeLoader({ stored: 'abc' });
    expect(await osKeychain('svc', fake.load).get()).toBe('abc');
  });

  it('returns undefined for an absent entry rather than throwing', async () => {
    // The library throws for "no such entry" as well as for "the keyring is locked", and the two
    // are indistinguishable through its API, so `resolveUnlock` must get one answer for both.
    const fake = fakeLoader();
    expect(await osKeychain('svc', fake.load).get()).toBeUndefined();
  });

  it('returns undefined for a locked keyring, which reads the same from here', async () => {
    const fake = fakeLoader({ stored: 'abc', throws: true });
    expect(await osKeychain('svc', fake.load).get()).toBeUndefined();
  });

  it('writes a value that reads back', async () => {
    const fake = fakeLoader();
    const keychain = osKeychain('svc', fake.load);
    await keychain.set('written');
    expect(await keychain.get()).toBe('written');
  });

  it('lets a write failure surface, unlike a read', async () => {
    // A failed read has a correct fallback — try the next unlock source. A failed *write* means
    // the host believes a key is stored when it is not, which is how a master key gets lost.
    const fake = fakeLoader({ throws: true });
    await expect(osKeychain('svc', fake.load).set('x')).rejects.toThrow('the keyring is locked');
  });

  it('reports whether a delete removed anything', async () => {
    const fake = fakeLoader({ stored: 'abc' });
    const keychain = osKeychain('svc', fake.load);
    expect(await keychain.delete()).toBe(true);
    expect(await keychain.delete()).toBe(false);
  });

  it('reports false when the keyring cannot be reached', async () => {
    const fake = fakeLoader({ stored: 'abc', throws: true });
    expect(await osKeychain('svc', fake.load).delete()).toBe(false);
  });
});

describe('storeMasterKey', () => {
  it('stores base64url, matching the env row so a key can move between modes', async () => {
    // `08` §3.7.3: the `env` row is base64url, and a host moving from `COMVIVO_MASTER_KEY` to
    // keychain mode should be able to copy the same text.
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    let seen: string | undefined;
    const keychain: Keychain = {
      get: () => Promise.resolve(undefined),
      set: (value) => {
        seen = value;
        return Promise.resolve();
      },
      delete: () => Promise.resolve(false),
    };

    await storeMasterKey(key, keychain);
    expect(seen).toBe(Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64url'));
  });

  it('zeroes the caller’s buffer', async () => {
    const key = Buffer.alloc(32, 7);
    const keychain: Keychain = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(false),
    };

    await storeMasterKey(key, keychain);
    expect(isZeroed(key)).toBe(true);
  });

  it('zeroes the buffer even when the keychain refuses', async () => {
    // The case a `finally` exists for. A locked keyring is the likely failure, and leaving 32
    // bytes of master key in a live buffer afterwards is the one outcome that must not happen.
    const key = Buffer.alloc(32, 9);
    const keychain: Keychain = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.reject(new Error('the keyring is locked')),
      delete: () => Promise.resolve(false),
    };

    await expect(storeMasterKey(key, keychain)).rejects.toThrow('the keyring is locked');
    expect(isZeroed(key)).toBe(true);
  });
});

describe('the optional dependency', () => {
  it('explains what to install, and offers keyfile mode instead', async () => {
    // `@napi-rs/keyring` is declared in no manifest here — see `keychain.ts` for why an optional
    // dependency and an optional peer were both measured and rejected (pnpm installs them, which
    // would put a real OS keyring behind the test suite). This asserts the failure is advice
    // rather than a module-resolution stack trace, and it is also the guard on that absence: add
    // the package to a manifest and this test goes red instead of the comment going stale.
    try {
      await loadKeyring();
      expect.unreachable('@napi-rs/keyring is deliberately not installed');
    } catch (caught) {
      expect(caught).toBeInstanceOf(KeychainUnavailable);
      const error = caught as KeychainUnavailable;
      expect(error.message).toContain('@napi-rs/keyring');
      // With the version range: a host who installs "whatever is newest" is one major release
      // away from a native addon this adapter was never written against.
      expect(error.hint).toContain('pnpm add -w @napi-rs/keyring@^2.1.2');
      expect(error.hint).toContain(`${BRAND.cliName} keys rotate-master --key-store keyfile`);
      expect(error.hint).toContain('headless Linux');
      expect(error.cause).toBeDefined();
    }
  });

  it('surfaces that failure through every operation, not only the first', async () => {
    const keychain = osKeychain();
    await expect(keychain.set('x')).rejects.toThrow(KeychainUnavailable);
    await expect(keychain.delete()).rejects.toThrow(KeychainUnavailable);
    // `get` is the one that swallows errors from the *entry*; a missing library is different, and
    // must not be reported as "the keychain is empty" — that would silently fall through to the
    // next unlock source and unlock with a key the host did not choose.
    await expect(keychain.get()).rejects.toThrow(KeychainUnavailable);
  });
});
