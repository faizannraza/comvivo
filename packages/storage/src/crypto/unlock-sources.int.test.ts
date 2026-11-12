/**
 * `nodeUnlockIo` against the real environment and filesystem (`08` §3.7.3, §3.7.5).
 *
 * `unlock-sources.test.ts` injects a fake `UnlockIo` and proves the resolution *order*. It cannot
 * prove the real adapter works, and that is the half that has bitten this subsystem before:
 * `syncDirectory` opened a directory with `r+` and failed with `EISDIR` on Linux, which no
 * in-memory fake would ever notice. The real adapter was at 58% function coverage with every
 * ordering rule green.
 *
 * So this file exercises the four real syscall wrappers and then runs the whole §3.7.5 sequence
 * through them, with a master key written to an actual file.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@comvivo/shared';
import { zeroize } from '@comvivo/shared/crypto';
import { describe, expect, it } from 'vitest';
import { KeychainUnavailable, osKeychain } from './keychain.js';
import {
  disposeUnlock,
  isPassphraseRequired,
  MASTER_KEY_ENV,
  MASTER_KEY_FILE_ENV,
  nodeUnlockIo,
  resolveUnlock,
  UnlockError,
} from './unlock-sources.js';

/** 32 bytes with a recognisable pattern, so a truncation shows up as a wrong value. */
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
const KEY_B64URL = KEY.toString('base64url');

/** A temp directory, removed afterwards. Scope guard rather than hooks (`testing/keys-dir.ts`). */
async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${BRAND.slug}-unlock-`));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Set real environment variables for one test and restore exactly what was there.
 *
 * `vi.stubEnv` is not usable here: the thing under test *deletes* `process.env` entries (S9), and
 * the point is to watch a real delete happen.
 */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('nodeUnlockIo against the real environment', { tags: ['slow'] }, () => {
  it('reads a variable that is set', async () => {
    await withEnv({ [MASTER_KEY_ENV]: 'from-the-environment' }, () => {
      expect(nodeUnlockIo.env(MASTER_KEY_ENV)).toBe('from-the-environment');
      return Promise.resolve();
    });
  });

  it('returns undefined for a variable that is not set', () => {
    expect(nodeUnlockIo.env(`${BRAND.envPrefix}DEFINITELY_NOT_SET_12345`)).toBeUndefined();
  });

  it('really removes the variable, so a child process cannot inherit it', async () => {
    // S9. A fake can only show that `deleteEnv` was called; this shows the entry is gone from the
    // object a spawned process would be handed, which is the actual requirement.
    await withEnv({ [MASTER_KEY_ENV]: KEY_B64URL }, () => {
      nodeUnlockIo.deleteEnv(MASTER_KEY_ENV);
      expect(MASTER_KEY_ENV in process.env).toBe(false);
      expect(nodeUnlockIo.env(MASTER_KEY_ENV)).toBeUndefined();
      return Promise.resolve();
    });
  });

  it('tolerates deleting a variable that was never set', () => {
    expect(() => {
      nodeUnlockIo.deleteEnv(`${BRAND.envPrefix}NEVER_SET_98765`);
    }).not.toThrow();
  });

  it('reaches the real keychain, and says so when the binding is absent', async () => {
    // This used to assert `keychainGet()` **is** undefined, which is how a stub gets a passing
    // test: the default returned `Promise.resolve(undefined)` and never reached `keychain.ts`, so
    // a key written by `storeMasterKey` could never be read back. The test documented the gap.
    //
    // `@napi-rs/keyring` is deliberately not a declared dependency (`08` §3.7.3: keychain mode is
    // not for headless Linux, and every install would pay for a per-platform native addon), so on
    // this machine the correct answer is `KeychainUnavailable` with installation advice — not
    // silence. Either outcome is acceptable here, because a developer machine with the addon
    // present and an empty keychain legitimately answers `undefined`; what is **not** acceptable
    // is the old unconditional `undefined`, which the second half rules out.
    let caught: unknown;
    let value: string | undefined;
    try {
      value = await nodeUnlockIo.keychainGet();
    } catch (error) {
      caught = error;
    }

    if (caught !== undefined) {
      expect(caught).toBeInstanceOf(KeychainUnavailable);
      expect((caught as KeychainUnavailable).hint).toContain('@napi-rs/keyring');
      return;
    }
    expect(value).toBeUndefined();
  });

  it('is the real keychain and not a resolved undefined', async () => {
    // The assertion the old test could not make. `osKeychain` is given a loader that throws a
    // recognisable error; if `keychainGet` still short-circuited, this would resolve instead.
    const sentinel = new Error('the loader ran');
    await expect(osKeychain('service', () => Promise.reject(sentinel)).get()).rejects.toBe(
      sentinel,
    );
  });
});

describe('nodeUnlockIo against a real filesystem', { tags: ['slow'] }, () => {
  it('reads a file as UTF-8', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'master.key');
      await writeFile(path, `${KEY_B64URL}\n`);
      expect((await nodeUnlockIo.readFile(path)).trim()).toBe(KEY_B64URL);
    });
  });

  it('rejects for a file that is not there', async () => {
    await withDir(async (dir) => {
      await expect(nodeUnlockIo.readFile(join(dir, 'absent'))).rejects.toThrow();
    });
  });

  it('reports a real file as existing', async () => {
    await withDir(async (dir) => {
      const path = join(dir, 'master.key');
      await writeFile(path, KEY_B64URL);
      expect(await nodeUnlockIo.fileExists(path)).toBe(true);
    });
  });

  it('reports a missing file as absent', async () => {
    await withDir(async (dir) => {
      expect(await nodeUnlockIo.fileExists(join(dir, 'absent'))).toBe(false);
    });
  });

  it('raises rather than reporting a directory as an absent key file', async () => {
    // `readFile` on a directory raises `EISDIR`, and **only `ENOENT` means absent** (amended at
    // the M1 exit gate). This assertion used to expect `false`, with the reasoning that the
    // question is "is there a key file here I can read" — but the answer flows into a hint, and
    // the hint for absent says *"your key file is missing — restore it, or recover with your
    // recovery key"*. A host who follows that performs a recovery ceremony and rotates the master
    // key, when the fix was a path or a `chown`.
    await withDir(async (dir) => {
      await expect(nodeUnlockIo.fileExists(dir)).rejects.toMatchObject({ code: 'EISDIR' });
    });
  });

  it('raises for a key file it cannot read, so the host is told to fix the mode', async () => {
    // The support-call shape this is really about: after a `docker run -u` change or a wrong
    // `chown`, `keys/master.key` is right there and unreadable. Conflating that with "absent" —
    // which this interface used to do, deliberately — pointed the host at
    // `MASTER_KEY_NOT_FOUND`'s recovery advice for a file that was present, so an `EACCES` now
    // surfaces as `MASTER_KEY_UNREADABLE` through `resolveUnlock`. `auditPermissions` still
    // diagnoses mode problems in general; this is about the one decision that leads to a recovery.
    //
    // Skipped when the test runs as root, where mode bits do not deny the owner.
    if (process.getuid?.() === 0) return;
    await withDir(async (dir) => {
      const path = join(dir, 'master.key');
      await writeFile(path, KEY_B64URL);
      await chmod(path, 0o000);
      await expect(nodeUnlockIo.fileExists(path)).rejects.toMatchObject({ code: 'EACCES' });

      // And the whole sequence says so, with a hint that does not mention recovery.
      await expect(
        resolveUnlock({ keyfilePath: path, configured: 'keyfile', io: nodeUnlockIo }),
      ).rejects.toMatchObject({ code: 'MASTER_KEY_UNREADABLE' });
    });
  });
});

describe('the whole §3.7.5 sequence through the real adapter', { tags: ['slow'] }, () => {
  it('resolves a master key from a real mounted secret file', async () => {
    await withDir(async (dir) => {
      const secret = join(dir, 'mk');
      await writeFile(secret, KEY_B64URL);

      await withEnv({ [MASTER_KEY_FILE_ENV]: secret }, async () => {
        const outcome = await resolveUnlock({
          keyfilePath: join(dir, 'master.key'),
          io: nodeUnlockIo,
        });
        expect(isPassphraseRequired(outcome)).toBe(false);
        if (isPassphraseRequired(outcome)) return;
        expect(outcome.kind).toBe('file');
        expect(outcome.key.equals(KEY)).toBe(true);
        disposeUnlock(outcome);
      });
    });
  });

  it('resolves a master key from a real keyfile, and deletes nothing it did not read', async () => {
    await withDir(async (dir) => {
      const keyfilePath = join(dir, 'master.key');
      await writeFile(keyfilePath, `${KEY_B64URL}\n`, { mode: 0o600 });

      const outcome = await resolveUnlock({ keyfilePath, io: nodeUnlockIo });
      expect(isPassphraseRequired(outcome)).toBe(false);
      if (isPassphraseRequired(outcome)) return;
      expect(outcome.kind).toBe('keyfile');
      expect(outcome.detail).toBe(keyfilePath);
      expect(outcome.key.equals(KEY)).toBe(true);
      disposeUnlock(outcome);
    });
  });

  it('takes the real environment variable ahead of the real keyfile, and removes it', async () => {
    await withDir(async (dir) => {
      const keyfilePath = join(dir, 'master.key');
      await writeFile(keyfilePath, Buffer.alloc(32, 1).toString('base64url'));

      await withEnv({ [MASTER_KEY_ENV]: KEY_B64URL }, async () => {
        const outcome = await resolveUnlock({ keyfilePath, io: nodeUnlockIo });
        expect(isPassphraseRequired(outcome)).toBe(false);
        if (isPassphraseRequired(outcome)) return;
        expect(outcome.kind).toBe('env');
        expect(outcome.key.equals(KEY)).toBe(true);
        expect(outcome.warning).toContain(MASTER_KEY_ENV);
        expect(MASTER_KEY_ENV in process.env).toBe(false);
        disposeUnlock(outcome);
      });
    });
  });

  it('uses the real adapter by default, with no io passed at all', async () => {
    // `resolveUnlock` defaults `io` to `nodeUnlockIo`, and that default is what the server runs.
    // Every other test in both files passes an `io` explicitly, so without this one the default
    // could be changed to anything — a fake, or `undefined` — and the suite would stay green.
    await withDir(async (dir) => {
      const keyfilePath = join(dir, 'master.key');
      await writeFile(keyfilePath, KEY_B64URL, { mode: 0o600 });

      const outcome = await resolveUnlock({ keyfilePath });
      expect(isPassphraseRequired(outcome)).toBe(false);
      if (isPassphraseRequired(outcome)) return;
      expect(outcome.kind).toBe('keyfile');
      expect(outcome.key.equals(KEY)).toBe(true);
      disposeUnlock(outcome);
    });
  });

  it('names the real paths it looked at when nothing is there', async () => {
    await withDir(async (dir) => {
      const keyfilePath = join(dir, 'master.key');
      try {
        await resolveUnlock({ keyfilePath, io: nodeUnlockIo });
        expect.unreachable('there is no key anywhere');
      } catch (caught) {
        expect(caught).toBeInstanceOf(UnlockError);
        const error = caught as UnlockError;
        expect(error.code).toBe('MASTER_KEY_NOT_FOUND');
        expect(error.hint).toContain(keyfilePath);
        expect(error.hint).toContain(`${BRAND.cliName} init`);
      }
    });
  });

  it('refuses a real file whose contents are the wrong length', async () => {
    // The commonest real corruption: a truncated copy, or a shell that ate the last character.
    await withDir(async (dir) => {
      const keyfilePath = join(dir, 'master.key');
      await writeFile(keyfilePath, KEY_B64URL.slice(0, 20));

      await expect(resolveUnlock({ keyfilePath, io: nodeUnlockIo })).rejects.toThrow(
        /must be 32$|must be 32\b/,
      );
    });
  });

  it('zeroes the key when the caller disposes it', async () => {
    await withDir(async (dir) => {
      const keyfilePath = join(dir, 'master.key');
      await writeFile(keyfilePath, KEY_B64URL);

      const outcome = await resolveUnlock({ keyfilePath, io: nodeUnlockIo });
      if (isPassphraseRequired(outcome)) return;
      const borrowed = outcome.key;
      disposeUnlock(outcome);
      expect(borrowed.every((byte) => byte === 0)).toBe(true);
      zeroize(borrowed);
    });
  });
});
