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

  it('loads no native addon when the keychain is not configured', async () => {
    // The reason `keychainGet` has a do-nothing default: `08` §3.7.3 says keychain mode is not for
    // headless Linux, and merely importing a Secret Service client can block. A host that did not
    // ask for it must not pay for it.
    expect(await nodeUnlockIo.keychainGet()).toBeUndefined();
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

  it('reports a directory as not a usable key file', async () => {
    // `readFile` on a directory raises `EISDIR`, so this answers false. That is the right answer
    // for the question being asked — "is there a key file here I can read" — and the
    // misconfiguration (a directory where the keyfile should be) still ends in
    // `MASTER_KEY_NOT_FOUND` with the path named, rather than in an unhandled EISDIR at boot.
    await withDir(async (dir) => {
      expect(await nodeUnlockIo.fileExists(dir)).toBe(false);
    });
  });

  it('reports an unreadable file as absent, which the final hint accounts for', async () => {
    // A deliberate conflation, documented here because it is a support-call shape: a key file the
    // service user cannot read is indistinguishable from a missing one through this interface. The
    // `MASTER_KEY_NOT_FOUND` hint therefore names the path and says "missing — restore it", and
    // `KeyringStore.auditPermissions` is what actually diagnoses a permission problem.
    //
    // Skipped when the test runs as root, where mode bits do not deny the owner.
    if (process.getuid?.() === 0) return;
    await withDir(async (dir) => {
      const path = join(dir, 'master.key');
      await writeFile(path, KEY_B64URL);
      await chmod(path, 0o000);
      expect(await nodeUnlockIo.fileExists(path)).toBe(false);
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
