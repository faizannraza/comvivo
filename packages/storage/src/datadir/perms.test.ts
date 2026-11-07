/**
 * The permission audit (`12` §3.7, `08` §3.7.3).
 *
 * Against a **real** filesystem, because the whole subject is mode bits and ownership. A fake would
 * be asserting that the audit reads a number this test also wrote — the interesting part is the
 * arithmetic over real `lstat` output, and the keyring store already found one bug (`EISDIR` on a
 * directory opened `r+`) that only a real syscall could surface.
 *
 * The four outcomes `12` §3.7 specifies all have tests, and so does the **asymmetry** between
 * them: readable key material is overridable with an explicit flag, writable key material never
 * is. That is the design decision most worth protecting, because the obvious "simplification" is
 * to let one flag cover both.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StorageError } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { createLayout, DIR_MODE, FILE_MODE } from './layout.js';
import {
  assertPermissionsUsable,
  auditPermissions,
  isGroupOrWorldAccessible,
  isGroupOrWorldReadable,
  isGroupOrWorldWritable,
} from './perms.js';
import { withDataDir } from './testing/data-dir.js';

/** A data directory with the layout and a key file, ready to have its modes broken. */
async function installed(root: string): Promise<string> {
  await createLayout(root);
  const keyPath = join(root, 'keys', 'master.key');
  await writeFile(keyPath, 'not a real key', { mode: FILE_MODE });
  await chmod(keyPath, FILE_MODE);
  return keyPath;
}

const linux = { platform: 'linux' } as const;

describe('the mode predicates', () => {
  it('reads the group and other bits, and only those', () => {
    expect(isGroupOrWorldReadable(0o600)).toBe(false);
    expect(isGroupOrWorldReadable(0o640)).toBe(true);
    expect(isGroupOrWorldReadable(0o604)).toBe(true);
    expect(isGroupOrWorldReadable(0o700)).toBe(false);

    expect(isGroupOrWorldWritable(0o600)).toBe(false);
    expect(isGroupOrWorldWritable(0o620)).toBe(true);
    expect(isGroupOrWorldWritable(0o602)).toBe(true);
    // Executable-only for others is neither readable nor writable, and the audit treats it as
    // "accessible" rather than as either — a distinction a single boolean would lose.
    expect(isGroupOrWorldReadable(0o611)).toBe(false);
    expect(isGroupOrWorldWritable(0o611)).toBe(false);
    expect(isGroupOrWorldAccessible(0o611)).toBe(true);
  });
});

describe('refusals (12 §3.7)', { tags: ['slow'] }, () => {
  it('refuses a world-readable key file', async () => {
    await withDataDir(async (root) => {
      const keyPath = await installed(root);
      await chmod(keyPath, 0o644);

      const audit = await auditPermissions(root, linux);
      expect(audit.refused.map((finding) => finding.path)).toEqual([keyPath]);
      expect(audit.refused[0]?.reason).toBe('readable');
      expect(() => assertPermissionsUsable(audit, root)).toThrow(StorageError);
    });
  });

  it('refuses a group-readable keys/ directory', async () => {
    // Even with every file inside at 0600: a readable `keys/` leaks the **names**, which on many
    // systems is enough to know which unlock modes are in use.
    await withDataDir(async (root) => {
      await installed(root);
      await chmod(join(root, 'keys'), 0o750);

      const audit = await auditPermissions(root, linux);
      expect(audit.refused.map((finding) => finding.path)).toContain(join(root, 'keys'));
    });
  });

  it('refuses a world-writable data directory', async () => {
    await withDataDir(async (root) => {
      await installed(root);
      await chmod(root, 0o777);

      const audit = await auditPermissions(root, linux);
      const finding = audit.refused.find((candidate) => candidate.path === root);
      expect(finding?.reason).toBe('writable');
    });
  });

  it('refuses an owner mismatch with a chown hint', async () => {
    // The uid is passed in rather than faked by changing ownership, which needs root. The
    // arithmetic is the same and the hint is the part a host reads.
    await withDataDir(async (root) => {
      await installed(root);
      const audit = await auditPermissions(root, { ...linux, expectedUid: 999_999 });

      expect(audit.refused.length).toBeGreaterThan(0);
      expect(audit.refused.every((finding) => finding.reason === 'owner')).toBe(true);
      try {
        assertPermissionsUsable(audit, root);
        expect.unreachable('an owner mismatch must refuse');
      } catch (caught) {
        const error = caught as StorageError;
        expect(error.code).toBe('config.insecure_permissions');
        expect(error.hint).toContain('chown');
        expect(error.hint).toContain(root);
      }
    });
  });

  it('reports every finding at once, so a host runs doctor once', async () => {
    await withDataDir(async (root) => {
      const keyPath = await installed(root);
      await writeFile(join(root, 'keys', 'keyring.json'), '{}', { mode: 0o644 });
      await chmod(join(root, 'keys', 'keyring.json'), 0o644);
      await chmod(keyPath, 0o644);

      const audit = await auditPermissions(root, linux);
      expect(audit.refused.length).toBe(2);
      try {
        assertPermissionsUsable(audit, root);
        expect.unreachable('two findings must refuse');
      } catch (caught) {
        const error = caught as StorageError;
        expect(error.message).toContain('master.key');
        expect(error.message).toContain('keyring.json');
        expect(error.detail).toMatchObject({ refused: 2 });
      }
    });
  });
});

describe('the readable/writable asymmetry (08 §3.7.3)', { tags: ['slow'] }, () => {
  it('lets --insecure-permissions through a readable key file, and says it did', async () => {
    // The ssh-style judgement `08` §3.7.3 allows: a host may decide the other users on their box
    // are trusted to read. Recorded in `allowed` rather than silently dropped, so `doctor` can
    // keep saying it.
    await withDataDir(async (root) => {
      const keyPath = await installed(root);
      await chmod(keyPath, 0o644);

      const audit = await auditPermissions(root, { ...linux, allowInsecureReads: true });
      expect(audit.refused).toEqual([]);
      expect(audit.allowed.map((finding) => finding.path)).toEqual([keyPath]);
      expect(() => assertPermissionsUsable(audit, root)).not.toThrow();
    });
  });

  it('still refuses a writable key file with the flag set', async () => {
    // **The asymmetry, and the test that protects it.** "Other users may read my key" is a privacy
    // judgement a host can make. "Other users may replace my key" is not a privacy judgement — it
    // is somebody else choosing the encryption key — so no flag waives it.
    await withDataDir(async (root) => {
      const keyPath = await installed(root);
      await chmod(keyPath, 0o666);

      const audit = await auditPermissions(root, { ...linux, allowInsecureReads: true });
      expect(audit.allowed).toEqual([]);
      expect(audit.refused.map((finding) => finding.reason)).toContain('writable');

      try {
        assertPermissionsUsable(audit, root);
        expect.unreachable('a writable key file is never acceptable');
      } catch (caught) {
        expect((caught as StorageError).hint).toContain('not overridable');
      }
    });
  });

  it('still refuses a writable data directory with the flag set', async () => {
    await withDataDir(async (root) => {
      await installed(root);
      await chmod(root, 0o707);

      const audit = await auditPermissions(root, { ...linux, allowInsecureReads: true });
      expect(audit.refused.some((finding) => finding.path === root)).toBe(true);
    });
  });
});

describe('auto-tightening (12 §3.7)', { tags: ['slow'] }, () => {
  it('tightens a readable path that is not key material, and warns', async () => {
    // The difference between a product that installs and one that greets a new host with a wall of
    // `chmod` commands. The key material is the part worth stopping for; the rest is fixable.
    await withDataDir(async (root) => {
      await installed(root);
      await chmod(join(root, 'blobs'), 0o755);

      const audit = await auditPermissions(root, linux);
      expect(audit.refused).toEqual([]);
      expect(audit.tightened).toContain(join(root, 'blobs'));

      const { stat } = await import('node:fs/promises');
      expect((await stat(join(root, 'blobs'))).mode & 0o777).toBe(DIR_MODE);
    });
  });

  it('tightens key material that is private but not exactly 0600', async () => {
    // Nothing is exposed, so there is nothing to warn about loudly — but leaving it would mean the
    // audit reported a difference it declined to fix, every boot, forever.
    await withDataDir(async (root) => {
      const keyPath = await installed(root);
      await chmod(keyPath, 0o700);

      const audit = await auditPermissions(root, linux);
      expect(audit.refused).toEqual([]);
      expect(audit.tightened).toContain(keyPath);

      const { stat } = await import('node:fs/promises');
      expect((await stat(keyPath)).mode & 0o777).toBe(FILE_MODE);
    });
  });

  it('changes nothing in a dry run, which is what doctor needs', async () => {
    await withDataDir(async (root) => {
      await installed(root);
      await chmod(join(root, 'blobs'), 0o755);

      const audit = await auditPermissions(root, { ...linux, tighten: false });
      expect(audit.tightened).toContain(join(root, 'blobs'));

      const { stat } = await import('node:fs/promises');
      expect((await stat(join(root, 'blobs'))).mode & 0o777).toBe(0o755);
    });
  });

  it('passes a correctly-permissioned install silently', async () => {
    await withDataDir(async (root) => {
      await installed(root);
      const audit = await auditPermissions(root, linux);
      expect(audit).toEqual({ refused: [], tightened: [], allowed: [], skipped: false });
      expect(() => assertPermissionsUsable(audit, root)).not.toThrow();
    });
  });
});

describe('what it does not look at', { tags: ['slow'] }, () => {
  it('ignores key files an install does not have', async () => {
    // Most installs have no vault and no appliance secrets. A missing file is not a finding.
    await withDataDir(async (root) => {
      await installed(root);
      const audit = await auditPermissions(root, linux);
      expect(audit.refused).toEqual([]);
    });
  });

  it('does not walk into blobs/, which would be thousands of stats per boot', async () => {
    // The directory modes already protect the contents three times over: a 0600 blob inside a 0700
    // directory inside a 0700 data directory. `doctor --deep` is where an exhaustive walk belongs.
    await withDataDir(async (root) => {
      await installed(root);
      await mkdir(join(root, 'blobs', 'ab'), { recursive: true });
      const blobPath = join(root, 'blobs', 'ab', 'cdef');
      await writeFile(blobPath, 'x');
      await chmod(blobPath, 0o666);

      const audit = await auditPermissions(root, linux);
      expect(audit.refused).toEqual([]);
      expect(audit.tightened).not.toContain(blobPath);
    });
  });

  it('skips the whole audit on Windows, where the bits are synthesised', async () => {
    // `08` §3.7.3. A POSIX mode on Windows would refuse every install.
    await withDataDir(async (root) => {
      const keyPath = await installed(root);
      await chmod(keyPath, 0o666);

      const audit = await auditPermissions(root, { platform: 'win32' });
      expect(audit).toEqual({ refused: [], tightened: [], allowed: [], skipped: true });
    });
  });

  it('is silent when there is nothing there at all', async () => {
    // `doctor` runs before `init`, on a data directory that does not exist yet.
    await withDataDir(async (root) => {
      const audit = await auditPermissions(join(root, 'nothing-here'), linux);
      expect(audit.refused).toEqual([]);
      expect(audit.skipped).toBe(false);
    });
  });
});
