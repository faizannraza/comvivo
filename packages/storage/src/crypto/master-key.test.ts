/**
 * Reading the master key from `08` §3.7.3's five stores (`M3-T13`).
 *
 * Each mode protects against something different and **fails differently**, and the failure is the
 * part a host sees. So every case asserts the message or the hint as well as the outcome: a
 * resolver that reported a missing Docker secret as "the master key is not in the keychain" would
 * work exactly as well and send somebody to the wrong place.
 *
 * `08` §3.7.3 rule 1 — "the process reads the MK once, then deletes it from `process.env`" — is
 * asserted rather than described, because it is one line that a refactor removes
 * without a visible consequence.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND, envVar, StorageError } from '@comvivo/shared';
import { KEY_BYTES, randomBytes } from '@comvivo/shared/crypto';
import { describe, expect, it } from 'vitest';
import type { Keychain } from './keychain.js';
import { KeyPermissionError } from './keyring-store.js';
import { type MasterKeySource, readMasterKey } from './master-key.js';

const KEY = randomBytes(KEY_BYTES);
const ENCODED = KEY.toString('base64url');

async function withKeysDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${BRAND.slug}-mk-`));
  try {
    // 0700, which is what `08` §3.7.3 requires of the key directory — otherwise the audit refuses
    // every case for the directory rather than for the file under test.
    await chmod(dir, 0o700);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * A `MasterKeySource`, with `dir` required of the caller.
 *
 * No default, per `hygiene:check`'s temp-path rule and for the reason behind it: one shared
 * directory here would be state two cases could collide on, which surfaces as order dependence
 * under `--sequence.shuffle` rather than as a failure anybody can read. The cases that use a key
 * file pass their own directory; the ones that do not use an unusable placeholder, which is
 * honest — `env`, `file`, `keychain` and `passphrase` never touch it.
 */
function source(overrides: Partial<MasterKeySource> & { readonly dir: string }): MasterKeySource {
  return {
    store: 'keyfile',
    keyfilePath: 'master.key',
    keychainService: BRAND.slug,
    ...overrides,
  };
}

/** For a mode that never resolves a path. Deliberately not a real directory. */
const NO_DIR = { dir: '/nonexistent-by-design' } as const;

describe('keyfile mode (08 §3.7.3, the default)', () => {
  it('reads a 0600 key file', async () => {
    await withKeysDir(async (dir) => {
      const path = join(dir, 'master.key');
      await writeFile(path, `${ENCODED}\n`, { mode: 0o600 });
      const read = await readMasterKey({ source: source({ dir, keyfilePath: path }), env: {} });
      expect(read.equals(KEY)).toBe(true);
    });
  });

  it('refuses a group- or world-readable key file', async () => {
    await withKeysDir(async (dir) => {
      const path = join(dir, 'master.key');
      await writeFile(path, `${ENCODED}\n`, { mode: 0o644 });
      // Another local user can already read this key. Starting anyway would be pretending
      // otherwise, which is why `08` §3.7.3 refuses rather than warns.
      await expect(
        readMasterKey({ source: source({ dir, keyfilePath: path }), env: {} }),
      ).rejects.toBeInstanceOf(KeyPermissionError);
    });
  });

  it('proceeds with --insecure-permissions, ssh-style', async () => {
    await withKeysDir(async (dir) => {
      const path = join(dir, 'master.key');
      await writeFile(path, `${ENCODED}\n`, { mode: 0o644 });
      const read = await readMasterKey({
        source: source({ dir, keyfilePath: path }),
        env: {},
        insecurePermissions: true,
      });
      expect(read.equals(KEY)).toBe(true);
    });
  });

  it('says what to do when the file is gone, and does not pretend it can be recreated', async () => {
    await withKeysDir(async (dir) => {
      const caught = await readMasterKey({
        source: source({ dir, keyfilePath: join(dir, 'absent.key') }),
        env: {},
      }).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(StorageError);
      // The honest sentence. There is no way to regenerate a master key, so the hint names the
      // recovery key — which `08` §3.7.8 row 1 makes the only route back in.
      expect((caught as StorageError).hint).toContain('recovery key');
      expect((caught as StorageError).storageCode).toBe('STORAGE_KEY_MISSING');
    });
  });

  it('refuses a key that is not 32 bytes', async () => {
    await withKeysDir(async (dir) => {
      const path = join(dir, 'master.key');
      await writeFile(path, 'dG9vIHNob3J0\n', { mode: 0o600 });
      const caught = await readMasterKey({
        source: source({ dir, keyfilePath: path }),
        env: {},
      }).catch((error: unknown) => error);
      expect((caught as StorageError).storageCode).toBe('STORAGE_KEY_INVALID');
      // A truncated key is unrecoverable, and the message says the length it found — because the
      // most common cause is a copy that lost a character, and knowing it is 31 bytes is what
      // tells a host that is what happened.
      expect((caught as StorageError).message).toMatch(/is \d+ bytes, not 32/);
    });
  });

  it('accepts base64 as well as base64url', async () => {
    await withKeysDir(async (dir) => {
      const path = join(dir, 'master.key');
      // A host pasting from a password manager gets whichever spelling the manager produced.
      // Refusing one of two encodings of the same bytes would be a failure nobody could diagnose.
      await writeFile(path, `${KEY.toString('base64')}\n`, { mode: 0o600 });
      const read = await readMasterKey({ source: source({ dir, keyfilePath: path }), env: {} });
      expect(read.equals(KEY)).toBe(true);
    });
  });
});

describe('file mode (Docker secrets, systemd-creds)', () => {
  it('reads the path the file variable names', async () => {
    await withKeysDir(async (dir) => {
      const path = join(dir, 'secret');
      await writeFile(path, `${ENCODED}\n`);
      const read = await readMasterKey({
        source: source({ ...NO_DIR, store: 'file' }),
        env: { [envVar('MASTER_KEY_FILE')]: path },
      });
      expect(read.equals(KEY)).toBe(true);
    });
  });

  it('names the variable, and the two places a secret is usually mounted', async () => {
    const caught = await readMasterKey({
      source: source({ ...NO_DIR, store: 'file' }),
      env: {},
    }).catch((error: unknown) => error);
    expect((caught as StorageError).message).toContain(envVar('MASTER_KEY_FILE'));
    expect((caught as StorageError).hint).toContain('systemd-creds');
  });
});

describe('env mode (08 §3.7.3 rule 1)', () => {
  it('reads the variable and then clears it', async () => {
    const env: Record<string, string | undefined> = { [envVar('MASTER_KEY')]: ENCODED };
    const read = await readMasterKey({ source: source({ ...NO_DIR, store: 'env' }), env });
    expect(read.equals(KEY)).toBe(true);
    // The rule, asserted. It is one line that a refactor removes with no visible consequence —
    // and what it buys is that a child process spawned later, a crash dump and an accidental
    // `console.log(process.env)` no longer carry the key.
    //
    // `undefined`, not absent: `= undefined` rather than `delete` keeps the object's shape, and
    // the two are equivalent to every reader because both answer `undefined`. Asserting the
    // **value** rather than `in` is what makes this test independent of which one is used.
    expect(env[envVar('MASTER_KEY')]).toBeUndefined();
  });

  it('warns, in the hint, about what env mode does not protect', async () => {
    const caught = await readMasterKey({
      source: source({ ...NO_DIR, store: 'env' }),
      env: {},
    }).catch((error: unknown) => error);
    // `08` §3.7.3 calls this mode a last resort and says doctor warns. The hint is where a host
    // reading an error actually finds that out.
    expect((caught as StorageError).hint).toContain('docker inspect');
  });
});

describe('keychain mode', () => {
  it('reads the entry for the configured service', async () => {
    const keychain: Keychain = {
      get: () => Promise.resolve(ENCODED),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(true),
    };
    const read = await readMasterKey({
      source: source({ ...NO_DIR, store: 'keychain', keychainService: 'test-service' }),
      env: {},
      keychain,
    });
    expect(read.equals(KEY)).toBe(true);
  });

  it('names the service when the entry is absent or the keychain is locked', async () => {
    const keychain: Keychain = {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(false),
    };
    const caught = await readMasterKey({
      source: source({ ...NO_DIR, store: 'keychain', keychainService: 'test-service' }),
      env: {},
      keychain,
    }).catch((error: unknown) => error);
    // Two causes, one message, because a host cannot tell them apart either — and both have the
    // same first step.
    expect((caught as StorageError).message).toContain('test-service');
    expect((caught as StorageError).hint).toContain('locked');
  });
});

describe('passphrase mode', () => {
  it('derives the key from the passphrase and the keyring’s salt', async () => {
    const salt = randomBytes(16);
    const first = await readMasterKey({
      source: source({ ...NO_DIR, store: 'passphrase' }),
      env: {},
      passphrase: 'correct horse battery staple',
      passphraseSalt: salt,
    });
    const again = await readMasterKey({
      source: source({ ...NO_DIR, store: 'passphrase' }),
      env: {},
      passphrase: 'correct horse battery staple',
      passphraseSalt: salt,
    });
    expect(first.equals(again)).toBe(true);
    expect(first).toHaveLength(KEY_BYTES);
    // A different salt is a different key. The salt lives in the keyring's passphrase slot, which
    // is why a caller that has not loaded the keyring cannot derive it — see the next test.
    const elsewhere = await readMasterKey({
      source: source({ ...NO_DIR, store: 'passphrase' }),
      env: {},
      passphrase: 'correct horse battery staple',
      passphraseSalt: randomBytes(16),
    });
    expect(elsewhere.equals(first)).toBe(false);
  });

  it('refuses without a passphrase, and says why it cannot start unattended', async () => {
    const caught = await readMasterKey({
      source: source({ ...NO_DIR, store: 'passphrase' }),
      env: {},
      passphraseSalt: randomBytes(16),
    }).catch((error: unknown) => error);
    expect((caught as StorageError).hint).toContain(envVar('PASSPHRASE_FILE'));
    expect((caught as StorageError).hint).toContain('unattended');
  });

  it('refuses without the salt, and calls that a bug rather than a host problem', async () => {
    const caught = await readMasterKey({
      source: source({ ...NO_DIR, store: 'passphrase' }),
      env: {},
      passphrase: 'correct horse battery staple',
    }).catch((error: unknown) => error);
    // A random salt here would derive a different key every time and read to the host as a wrong
    // passphrase — which is the worst possible misdirection, so it is refused as a caller error.
    expect((caught as StorageError).message).toContain('passphrase slot');
  });
});
