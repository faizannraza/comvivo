/**
 * The data directory's shape and modes (`12` §3.7).
 *
 * The modes are the part worth testing, and they can only be tested against a real filesystem.
 * `mkdir`'s `mode` applies **only when it creates the directory**, so an existing path keeps
 * whatever mode it already had — which is why `createLayout` chmods as well as mkdirs, and why
 * "is idempotent, and tightens a directory that was left open" is the test that holds that
 * behaviour in place. An in-memory fake would not notice either way.
 *
 * This file briefly carried a child-process test claiming the umask was the hazard. It was not:
 * measured on Node 26, `mkdir(path, { mode: 0o700 })` yields 0700 under `umask 022` and under
 * `umask 077`, because a umask can only **clear** bits and 0700 has no group or other bits to
 * clear. The test passed whether or not the `chmod` was there, which makes it worse than no test.
 * See STATUS → Plan changes.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BRAND } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import {
  createLayout,
  DATA_DIRS,
  DIR_MODE,
  dataDirLayout,
  FILE_MODE,
  KEY_FILES,
  keyFilePaths,
  OPTIONAL_DIRS,
} from './layout.js';
import { withDataDir } from './testing/data-dir.js';

describe('the layout is a pure function of the root', () => {
  it('resolves every path 12 §3.7 names', () => {
    const layout = dataDirLayout('/data');
    expect(layout.root).toBe('/data');
    expect(layout.format).toBe('/data/FORMAT');
    expect(layout.db).toBe('/data/db');
    expect(layout.keys).toBe('/data/keys');
    expect(layout.masterKey).toBe('/data/keys/master.key');
    expect(layout.keyring).toBe('/data/keys/keyring.json');
    expect(layout.run).toBe('/data/run');
    expect(layout.tmp).toBe('/data/tmp');
  });

  it('names the database and the lock after the brand, never a literal', () => {
    // `STATUS.md`, 2026-11-03: a brand-named **file in a host's data directory** turns a rename
    // into a migration, so both are derived. The brand guard would also refuse the literal.
    const layout = dataDirLayout('/data');
    expect(layout.dbFile).toBe(`/data/db/${BRAND.slug}.db`);
    expect(layout.lock).toBe(`/data/run/${BRAND.slug}.lock`);
  });

  it('puts tmp inside the data directory, which atomic renames depend on', () => {
    // `rename(2)` is atomic only within a filesystem. A `tmp/` under the system temp directory
    // would silently become a copy, and every "atomic" write in this product would stop being one.
    const layout = dataDirLayout('/data');
    expect(layout.tmp.startsWith('/data/')).toBe(true);
  });

  it('does no I/O, so doctor and the installers can name paths that do not exist', () => {
    const layout = dataDirLayout('/definitely/not/a/real/path');
    expect(layout.db).toBe('/definitely/not/a/real/path/db');
  });

  it('lists the key files the audit covers', () => {
    expect(KEY_FILES).toContain('master.key');
    expect(KEY_FILES).toContain('keyring.json');
    expect(KEY_FILES).toContain('keyring.json.prev');
    expect(keyFilePaths('/data')).toContain('/data/keys/master.key');
    expect(keyFilePaths('/data')).toHaveLength(KEY_FILES.length);
  });

  it('lists parents before their children, which createLayout relies on', () => {
    // `createLayout` deliberately does not use `recursive: true`, so a child must never be created
    // before its parent. Asserted on the order itself rather than on the effect.
    const seen = new Set<string>();
    for (const name of DATA_DIRS) {
      const slash = name.lastIndexOf('/');
      if (slash > 0) expect(seen).toContain(name.slice(0, slash));
      seen.add(name);
    }
  });
});

describe('creating the layout', { tags: ['slow'] }, () => {
  it('creates every required directory at 0700', async () => {
    await withDataDir(async (root) => {
      await createLayout(root);
      for (const name of DATA_DIRS) {
        if (OPTIONAL_DIRS.includes(name)) continue;
        const stats = await stat(join(root, name));
        expect(stats.isDirectory(), `${name} should be a directory`).toBe(true);
        expect(stats.mode & 0o777, `${name} should be 0700`).toBe(DIR_MODE);
      }
    });
  });

  it('leaves logs/ out unless it is asked for', async () => {
    // `12` §3.7: `logs/` exists only with `logging.file.enabled`. An empty `logs/` in every install
    // is a directory a host reasonably assumes is being written to.
    await withDataDir(async (root) => {
      await createLayout(root);
      await expect(stat(join(root, 'logs'))).rejects.toThrow();

      await createLayout(root, { includeOptional: ['logs'] });
      expect((await stat(join(root, 'logs'))).isDirectory()).toBe(true);
    });
  });

  it('is idempotent, and tightens a directory that was left open', async () => {
    // **The reason `createLayout` chmods at all.** `mkdir`'s `mode` applies only on creation, so an
    // existing 0755 directory keeps 0755 however many times the layout is recreated — and boot
    // recreates it every time. Without the chmod, `12` §3.7's audit would warn forever about
    // directories the creator kept handing back unchanged.
    //
    // Verified non-vacuous by deleting the `chmod` from `createLayout`: this is the test that
    // fails.
    await withDataDir(async (root) => {
      await createLayout(root);
      const { chmod } = await import('node:fs/promises');
      await chmod(join(root, 'keys'), 0o755);

      const created = await createLayout(root);
      expect(created).toEqual([]);
      expect((await stat(join(root, 'keys'))).mode & 0o777).toBe(DIR_MODE);
    });
  });

  it('reports which directories it actually created', async () => {
    await withDataDir(async (root) => {
      const first = await createLayout(root);
      expect(first.length).toBeGreaterThan(0);
      expect(first).toContain(join(root, 'keys'));
      expect(await createLayout(root)).toEqual([]);
    });
  });

  it('names the path when something in the way is a file, not a directory', async () => {
    // The reason `recursive: true` is not used: it would succeed silently here and the failure
    // would surface much later as a confusing write error deep in the blob store.
    await withDataDir(async (root) => {
      await mkdir(join(root, 'db'), { recursive: true });
      await writeFile(join(root, 'blobs'), 'not a directory');

      await expect(createLayout(root)).rejects.toThrow(/blobs exists and is not a directory/);
    });
  });

  it('uses the same modes the audit expects', () => {
    // One source of truth: if these two ever disagreed, boot would create directories that boot
    // then warned about.
    expect(DIR_MODE).toBe(0o700);
    expect(FILE_MODE).toBe(0o600);
  });
});
