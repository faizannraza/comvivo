/**
 * The keyring against a **real** filesystem (`08` §3.7.4, §3.7.5, `12` §3.7).
 *
 * `keyring-store.test.ts` proves the write *sequence* with a fake, which is the only way to reach
 * a crash between two syscalls. This file proves the sequence actually works: real `fsync` on a
 * file and on a directory, real `rename`, real mode bits, and a real unlock of a keyring that was
 * written and read back from disk.
 *
 * Both are needed, and the reason is M0's recurring lesson. A fake can be wrong in the same
 * direction as the code — `syncDirectory` opening a directory with `r+` fails with `EISDIR` on
 * Linux, and no in-memory fake would ever notice.
 */

import { randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { InstanceId } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { unlock } from './key-service.js';
import { currentGeneration, type Keyring, KeyringError } from './keyring.js';
import { KEY_FILE_MODE, KeyPermissionError, KeyringStore } from './keyring-store.js';
import { buildKeyring } from './testing/keyring-fixture.js';
import { withKeysDir } from './testing/keys-dir.js';

describe('a real write and read', { tags: ['slow'] }, () => {
  it('writes, fsyncs and reads back', async () => {
    await withKeysDir(async (keysDir) => {
      // The whole sequence against a real filesystem. `syncDirectory` is the step a fake cannot
      // check: opening a directory with `r+` raises `EISDIR` on Linux, and only a real call finds it.
      const store = new KeyringStore(keysDir);
      const { keyring } = buildKeyring();
      await store.write(keyring);
      expect(await store.read()).toEqual(keyring);
    });
  });

  it('creates the directory 0700 and the file 0600', async () => {
    await withKeysDir(async (keysDir) => {
      // `12` §3.7. Checked on the real filesystem because `writeFile`'s `mode` is masked by the
      // process umask, and the explicit `chmod` is what makes the result exact rather than
      // umask-dependent — which a fake would never show.
      const store = new KeyringStore(keysDir);
      await store.write(buildKeyring().keyring);

      expect((await stat(keysDir)).mode & 0o777).toBe(0o700);
      expect((await stat(store.path)).mode & 0o777).toBe(KEY_FILE_MODE);
    });
  });

  it('tightens an existing keyring that was left readable', async () => {
    await withKeysDir(async (keysDir) => {
      // `writeFile`'s `mode` applies only on creation, so an existing 0644 file keeps its mode. The
      // explicit `chmod` is what fixes it, and this is the test that would fail without it.
      const store = new KeyringStore(keysDir);
      await store.write(buildKeyring({ gen: 1 }).keyring);
      const { chmod } = await import('node:fs/promises');
      await chmod(store.path, 0o644);

      await store.write(buildKeyring({ gen: 2 }).keyring);
      expect((await stat(store.path)).mode & 0o777).toBe(KEY_FILE_MODE);
    });
  });

  it('keeps the previous keyring, readable and valid', async () => {
    await withKeysDir(async (keysDir) => {
      const store = new KeyringStore(keysDir);
      await store.write(buildKeyring({ gen: 1 }).keyring);
      await store.write(buildKeyring({ gen: 2 }).keyring);

      expect((await store.read()).current).toBe(2);
      expect((await store.readPrevious()).current).toBe(1);
    });
  });

  it('writes human-readable JSON, because a host may have to read it in an emergency', async () => {
    await withKeysDir(async (keysDir) => {
      // Two-space JSON with a trailing newline. Not cosmetic: the realistic recovery path involves
      // somebody opening this file in an editor at a bad moment, and a single-line blob helps nobody.
      const store = new KeyringStore(keysDir);
      await store.write(buildKeyring().keyring);
      const text = await readFile(store.path, 'utf8');
      expect(text.startsWith('{\n  "format"')).toBe(true);
      expect(text.endsWith('}\n')).toBe(true);
    });
  });

  it('leaves no temp file behind after a successful write', async () => {
    await withKeysDir(async (keysDir) => {
      const store = new KeyringStore(keysDir);
      await store.write(buildKeyring().keyring);
      await expect(stat(store.tempPath)).rejects.toThrow();
    });
  });

  it('survives many writes in a row, as a rotation sequence would', async () => {
    await withKeysDir(async (keysDir) => {
      const store = new KeyringStore(keysDir);
      for (let gen = 1; gen <= 10; gen += 1) {
        await store.write(buildKeyring({ gen }).keyring);
      }
      expect((await store.read()).current).toBe(10);
      expect((await store.readPrevious()).current).toBe(9);
    });
  });
});

describe('unlock end to end, from disk', { tags: ['slow'] }, () => {
  it('writes a keyring, reads it, and opens it with the master key', async () => {
    await withKeysDir(async (keysDir) => {
      // The `08` §3.7.5 happy path, with the keyring having made a real round trip through JSON and
      // the filesystem — which is where a base64url or an encoding mistake would show up.
      const store = new KeyringStore(keysDir);
      const fixture = buildKeyring();
      await store.write(fixture.keyring);

      const fromDisk = await store.read();
      const service = unlock({ keyring: fromDisk, slotKey: Buffer.from(fixture.masterKey) });
      expect(service.unlockRecord.slotKind).toBe('master');
      expect(service.useDatabaseKeyHex((hex) => hex)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('opens it with the recovery slot key when the master key is gone', async () => {
    await withKeysDir(async (keysDir) => {
      // `08` §3.7.8 row 1, end to end: the only thing the host has is the printed recovery key.
      const store = new KeyringStore(keysDir);
      const fixture = buildKeyring();
      await store.write(fixture.keyring);

      const service = unlock({
        keyring: await store.read(),
        slotKey: Buffer.from(fixture.recoverySlotKey),
      });
      expect(service.unlockRecord.slotKind).toBe('recovery');
    });
  });

  it('derives the same database key before and after the round trip', async () => {
    await withKeysDir(async (keysDir) => {
      // If base64url encoding or JSON escaping altered a single byte, the keyring would still parse
      // and the database would refuse to open with `STORAGE_KEY_INVALID` — a failure that looks like
      // a wrong key rather than a corrupted file.
      const fixture = buildKeyring();
      const before = unlock({
        keyring: fixture.keyring,
        slotKey: Buffer.from(fixture.masterKey),
      }).useDatabaseKeyHex((hex) => hex);

      const store = new KeyringStore(keysDir);
      await store.write(fixture.keyring);
      const after = unlock({
        keyring: await store.read(),
        slotKey: Buffer.from(fixture.masterKey),
      }).useDatabaseKeyHex((hex) => hex);

      expect(after).toBe(before);
    });
  });

  it('refuses a keyring a host edited by hand into invalidity', async () => {
    await withKeysDir(async (keysDir) => {
      // The realistic emergency: somebody opens `keyring.json`, changes something, and restarts.
      const store = new KeyringStore(keysDir);
      await store.write(buildKeyring().keyring);
      const text = await readFile(store.path, 'utf8');
      await writeFile(store.path, text.replace('"current": 1', '"current": 7'));

      await expect(store.read()).rejects.toThrow(KeyringError);
    });
  });

  it('refuses a truncated keyring rather than reporting a wrong key', async () => {
    await withKeysDir(async (keysDir) => {
      const store = new KeyringStore(keysDir);
      await store.write(buildKeyring().keyring);
      const text = await readFile(store.path, 'utf8');
      await writeFile(store.path, text.slice(0, Math.floor(text.length / 2)));

      await expect(store.read()).rejects.toThrow(/not valid JSON/);
    });
  });
});

describe('the permission audit against real modes', { tags: ['slow'] }, () => {
  it('refuses a world-readable key file', async () => {
    await withKeysDir(async (keysDir) => {
      // The real `stat`, so this covers the mode arithmetic as well as the policy.
      const store = new KeyringStore(keysDir);
      await store.write(buildKeyring().keyring);
      await writeFile(join(keysDir, 'master.key'), 'x', { mode: 0o644 });
      const { chmod } = await import('node:fs/promises');
      await chmod(join(keysDir, 'master.key'), 0o644);

      await expect(
        store.auditPermissions(['master.key', 'keyring.json'], { platform: 'linux' }),
      ).rejects.toThrow(KeyPermissionError);
    });
  });

  it('tightens a file that is private but not exactly 0600', async () => {
    await withKeysDir(async (keysDir) => {
      const store = new KeyringStore(keysDir);
      await store.write(buildKeyring().keyring);
      const keyPath = join(keysDir, 'master.key');
      await writeFile(keyPath, 'x');
      const { chmod } = await import('node:fs/promises');
      await chmod(keyPath, 0o700);

      const result = await store.auditPermissions(['master.key'], { platform: 'linux' });
      expect(result.refused).toEqual([]);
      expect(result.tightened).toEqual([keyPath]);
      expect((await stat(keyPath)).mode & 0o777).toBe(KEY_FILE_MODE);
    });
  });

  it('passes a correctly-permissioned directory', async () => {
    await withKeysDir(async (keysDir) => {
      const store = new KeyringStore(keysDir);
      await store.write(buildKeyring().keyring);
      const result = await store.auditPermissions(['keyring.json'], { platform: 'linux' });
      expect(result).toEqual({ refused: [], tightened: [] });
    });
  });

  it('ignores the files an install does not have', async () => {
    await withKeysDir(async (keysDir) => {
      // Most installs have no vault and no appliance secrets. A missing file is not a finding.
      const store = new KeyringStore(keysDir);
      await store.write(buildKeyring().keyring);
      const result = await store.auditPermissions(
        ['master.key', 'keyring.json', 'vault.enc', 'secrets.enc', 'control.token'],
        { platform: 'linux' },
      );
      expect(result).toEqual({ refused: [], tightened: [] });
    });
  });
});

describe('temp-file cleanup', { tags: ['slow'] }, () => {
  it('removes a stale temp file and reports that it did', async () => {
    await withKeysDir(async (keysDir) => {
      const store = new KeyringStore(keysDir);
      await store.write(buildKeyring().keyring);
      await writeFile(store.tempPath, 'leftover from an interrupted write');

      expect(await store.clearTemp()).toBe(true);
      await expect(stat(store.tempPath)).rejects.toThrow();
      expect(await store.clearTemp()).toBe(false);
    });
  });

  it('does not disturb the live keyring', async () => {
    await withKeysDir(async (keysDir) => {
      const store = new KeyringStore(keysDir);
      const { keyring } = buildKeyring();
      await store.write(keyring);
      await writeFile(store.tempPath, 'leftover');
      await store.clearTemp();
      expect(await store.read()).toEqual(keyring);
    });
  });
});

describe('the instance id binds each slot wrap (08 §3.7.2)', { tags: ['slow'] }, () => {
  it('opens a keyring that declares its own instance id', async () => {
    // The baseline, and the correction to what this block used to claim.
    //
    // It was titled "a keyring written on one instance does not open on another" and asserted that
    // `mine.masterKey` could not open `theirs.keyring`. That passed, but **for the wrong reason**:
    // every `buildKeyring()` mints a fresh random master key, so the two keys were simply
    // different. Found by the M1 independent review.
    //
    // Giving both fixtures the same master key showed the claim itself is false: `instanceId` is
    // part of the AAD *and* it is stored in the file, so a copied `keyring.json` carries it along
    // and opens exactly as it did on the original host. That is correct behaviour — copying the
    // whole file copies the declaration too — and the test was describing a protection the design
    // does not offer, under a name that would have reassured a reviewer.
    await withKeysDir(async (keysDir) => {
      const store = new KeyringStore(keysDir);
      const masterKey = randomBytes(32);
      const mine = buildKeyring({ masterKey });
      await store.write(mine.keyring);

      const theirs = buildKeyring({
        masterKey,
        instanceId: 'inst_01jd9zzzzzzzzzzzzzzzzzzzzz' as InstanceId,
      });

      expect(() =>
        unlock({ keyring: mine.keyring, slotKey: Buffer.from(masterKey) }).lock(),
      ).not.toThrow();
      // A whole-file copy still opens: the instance id travelled with it.
      expect(() =>
        unlock({ keyring: theirs.keyring, slotKey: Buffer.from(masterKey) }).lock(),
      ).not.toThrow();
    });
  });

  it('refuses a slot spliced in from a keyring with a different instance id', () => {
    // The property the AAD actually buys, which nothing tested. Take a *wrapped slot* from one
    // keyring and paste it into another: the unwrap is computed against the **host** keyring's
    // instance id, so the authenticator fails. Without the instance id in the AAD this splice
    // would succeed, and an attacker who could edit `keyring.json` could graft a slot they hold
    // the key for onto a keyring they do not.
    const masterKey = randomBytes(32);
    const mine = buildKeyring({ masterKey });
    const theirs = buildKeyring({
      masterKey,
      instanceId: 'inst_01jd9zzzzzzzzzzzzzzzzzzzzz' as InstanceId,
    });

    const donor = currentGeneration(mine.keyring).slots.find((slot) => slot.kind === 'master');
    expect(donor, 'the fixture has no master slot to splice').toBeDefined();

    const spliced: Keyring = {
      ...theirs.keyring,
      generations: theirs.keyring.generations.map((generation) =>
        generation.gen === theirs.keyring.current
          ? {
              ...generation,
              slots: generation.slots.map((slot) =>
                slot.kind === 'master' && donor !== undefined
                  ? { ...slot, wrap: donor.wrap }
                  : slot,
              ),
            }
          : generation,
      ),
    };

    // The donor wrap opens in its own keyring…
    expect(() =>
      unlock({ keyring: mine.keyring, slotKey: Buffer.from(masterKey) }).lock(),
    ).not.toThrow();
    // …and not in the other one, which is the whole point of the instance id being in the AAD.
    expect(() => unlock({ keyring: spliced, slotKey: Buffer.from(masterKey) })).toThrow(
      KeyringError,
    );
  });

  it('has a different slot count only when a passphrase was added', () => {
    // A small sanity check on the fixture itself, so a change there cannot make the tests above
    // vacuous by producing a keyring with no slots to try. No filesystem, so no temp directory.
    expect(currentGeneration(buildKeyring().keyring).slots).toHaveLength(2);
    expect(currentGeneration(buildKeyring({ withPassphrase: true }).keyring).slots).toHaveLength(3);
  });
});
