/**
 * The `FORMAT` marker (`12` §4.5, `12` §3.8.1 step 2).
 *
 * The test that matters is the three-way distinction: fresh, occupied, present. Getting it wrong
 * in one direction means refusing to install; getting it wrong in the other means creating a fresh
 * install **over somebody's database**, which is the most destructive thing this product could do.
 * So "no marker, but there is data" has its own outcome and its own test.
 */
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type InstanceId, StorageError } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import {
  clearFormatTemp,
  DATA_DIR_FORMAT,
  DATA_DIR_FORMAT_VERSION,
  type DataDirFormat,
  newFormat,
  parseFormat,
  readFormat,
  recordBoot,
  recordCleanShutdown,
  shutDownCleanly,
  writeFormat,
} from './format.js';
import { createLayout, dataDirLayout, FILE_MODE } from './layout.js';
import { withDataDir } from './testing/data-dir.js';

const INSTANCE = 'inst_01jd8kqd7h3f9z2m4n6p8r0t2v' as InstanceId;
const NOW = new Date('2026-11-06T09:00:00.000Z');

function marker(overrides: Partial<DataDirFormat> = {}): DataDirFormat {
  return { ...newFormat({ instanceId: INSTANCE, createdBy: '0.1.0', now: NOW }), ...overrides };
}

describe('12 §3.8.1 step 2 — the three outcomes', { tags: ['slow'] }, () => {
  it('reports a directory with no marker and no data as fresh', async () => {
    await withDataDir(async (root) => {
      await createLayout(root);
      expect(await readFormat(root)).toEqual({ kind: 'fresh' });
    });
  });

  it('reports a directory with no layout at all as fresh', async () => {
    // The very first run: `dataDir` may not even exist yet, and that is the normal install path.
    await withDataDir(async (root) => {
      expect((await readFormat(join(root, 'not-created-yet'))).kind).toBe('fresh');
    });
  });

  it('reports a directory with data but no marker as occupied', async () => {
    // **The dangerous case.** Something is there and this build did not put it there, so the only
    // safe reading is "not mine". `12` §3.8.1 exits 65 on this rather than installing over it.
    await withDataDir(async (root) => {
      await createLayout(root);
      await writeFile(join(root, 'db', 'something.db'), 'someone else’s data');

      const state = await readFormat(root);
      expect(state.kind).toBe('occupied');
      if (state.kind !== 'occupied') return;
      expect(state.reason).toContain('no FORMAT marker');
      expect(state.reason).toContain(dataDirLayout(root).db);
    });
  });

  it('reports a marker it can read as present', async () => {
    await withDataDir(async (root) => {
      await createLayout(root);
      const written = marker();
      await writeFormat(root, written);

      const state = await readFormat(root);
      expect(state.kind).toBe('present');
      if (state.kind !== 'present') return;
      expect(state.format).toEqual(written);
    });
  });

  it('lets a caller define "has data" for itself', async () => {
    // A restore asks the question of the whole tree, not of `db/`. Injected rather than hard-coded
    // so the two callers can mean what they each need without a second copy of the logic.
    await withDataDir(async (root) => {
      await createLayout(root);
      expect((await readFormat(root, () => Promise.resolve(true))).kind).toBe('occupied');
      expect((await readFormat(root, () => Promise.resolve(false))).kind).toBe('fresh');
    });
  });
});

describe('writing it', { tags: ['slow'] }, () => {
  it('writes readable JSON at 0600', async () => {
    await withDataDir(async (root) => {
      await createLayout(root);
      await writeFormat(root, marker());

      const path = dataDirLayout(root).format;
      expect((await stat(path)).mode & 0o777).toBe(FILE_MODE);
      const text = await readFile(path, 'utf8');
      expect(text.startsWith('{\n  "format"')).toBe(true);
      expect(text.endsWith('}\n')).toBe(true);
    });
  });

  it('leaves no temp file behind', async () => {
    await withDataDir(async (root) => {
      await createLayout(root);
      await writeFormat(root, marker());
      await expect(stat(join(root, 'tmp', 'FORMAT.tmp'))).rejects.toThrow();
    });
  });

  it('writes through tmp/, so a rename is atomic', async () => {
    // Asserted by making `tmp/` unavailable: if the write went anywhere else, this would pass.
    await withDataDir(async (root) => {
      await createLayout(root);
      await rm(join(root, 'tmp'), { recursive: true });
      await writeFile(join(root, 'tmp'), 'a file where the directory should be');

      await expect(writeFormat(root, marker())).rejects.toThrow();
    });
  });

  it('removes a stale temp file and says whether there was one', async () => {
    await withDataDir(async (root) => {
      await createLayout(root);
      await writeFile(join(root, 'tmp', 'FORMAT.tmp'), 'half a marker');

      expect(await clearFormatTemp(root)).toBe(true);
      expect(await clearFormatTemp(root)).toBe(false);
    });
  });

  it('refuses to write a marker that is not valid', async () => {
    // The last line of defence before a file that would exit 65 on the next boot.
    await withDataDir(async (root) => {
      await createLayout(root);
      const broken = { ...marker(), instanceId: 'not-an-id' } as unknown as DataDirFormat;
      await expect(writeFormat(root, broken)).rejects.toThrow();
    });
  });
});

describe('reading a marker that is wrong', () => {
  it('reports a newer format version as an upgrade problem', async () => {
    // Different answer from "damaged": upgrade, versus restore. Telling a host the wrong one here
    // costs them the time they do not have.
    const text = JSON.stringify({ ...marker(), formatVersion: DATA_DIR_FORMAT_VERSION + 1 });
    try {
      parseFormat(text);
      expect.unreachable('a newer format must be refused');
    } catch (caught) {
      expect(caught).toBeInstanceOf(StorageError);
      const error = caught as StorageError;
      expect(error.storageCode).toBe('STORAGE_VERSION_UNSUPPORTED');
      expect(error.hint).toContain('Upgrade rather than downgrade');
    }
    await Promise.resolve();
  });

  it('checks the version before the schema, so a newer file is not called malformed', () => {
    // A newer build may well have added fields this schema refuses. Checking the version first is
    // what makes the message about the version rather than about the fields.
    const future = JSON.stringify({
      format: DATA_DIR_FORMAT,
      formatVersion: 99,
      somethingNewAndUnknown: true,
    });
    expect(() => parseFormat(future)).toThrow(/format version 99/);
  });

  it('reports invalid JSON as damage, naming the path', () => {
    try {
      parseFormat('{ not json', '/data/FORMAT');
      expect.unreachable('invalid JSON must be refused');
    } catch (caught) {
      const error = caught as StorageError;
      expect(error.storageCode).toBe('STORAGE_CORRUPT');
      expect(error.message).toContain('/data/FORMAT');
      expect(error.hint).toContain('restore it from a backup');
    }
  });

  it('reports a foreign marker as damage rather than guessing', () => {
    // Another application's directory, or a truncated file. Either way, not ours to write into.
    expect(() =>
      parseFormat(JSON.stringify({ format: 'something-else', formatVersion: 1 })),
    ).toThrow(StorageError);
  });

  it('refuses a marker with no instance id', () => {
    const { instanceId: _removed, ...rest } = marker();
    expect(() => parseFormat(JSON.stringify(rest))).toThrow(/not a valid marker/);
  });
});

describe('recording boots and shutdowns', { tags: ['slow'] }, () => {
  it('records a boot without rewriting the install identity', async () => {
    // `createdAt`, `createdBy` and `instanceId` are the identity of the install. A boot that
    // rewrote any of them would quietly make the directory look newly created.
    await withDataDir(async (root) => {
      await createLayout(root);
      const original = marker();
      await writeFormat(root, original);

      const after = await recordBoot(root, {
        version: '1.2.3',
        schemaHead: '0057_poll_quorum',
        at: '2026-11-06T09:00:05.000Z',
      });

      expect(after.instanceId).toBe(original.instanceId);
      expect(after.createdAt).toBe(original.createdAt);
      expect(after.createdBy).toBe(original.createdBy);
      expect(after.lastBoot).toEqual({
        version: '1.2.3',
        schemaHead: '0057_poll_quorum',
        at: '2026-11-06T09:00:05.000Z',
      });
    });
  });

  it('refuses to record a boot into a directory with no marker, and says it is a bug', async () => {
    await withDataDir(async (root) => {
      await createLayout(root);
      try {
        await recordBoot(root, { version: '1', schemaHead: '0001', at: NOW.toISOString() });
        expect.unreachable('there is no marker');
      } catch (caught) {
        const error = caught as StorageError;
        expect(error.code).toBe('bug');
        expect(error.hint).toContain('boot sequence writes FORMAT');
      }
    });
  });

  it('tells a clean shutdown from a crash', async () => {
    // What `12` §3.8.1 step 4 needs in order to decide whether to run `quick_check`. A crash is
    // the absence of a shutdown *after* the last boot, not the absence of one entirely.
    await withDataDir(async (root) => {
      await createLayout(root);
      await writeFormat(root, marker());

      const booted = await recordBoot(root, {
        version: '1.0.0',
        schemaHead: '0001',
        at: '2026-11-06T09:00:00.000Z',
      });
      expect(shutDownCleanly(booted)).toBe(false);

      await recordCleanShutdown(root, new Date('2026-11-06T10:00:00.000Z'));
      const state = await readFormat(root);
      expect(state.kind).toBe('present');
      if (state.kind !== 'present') return;
      expect(shutDownCleanly(state.format)).toBe(true);
    });
  });

  it('calls a shutdown older than the last boot a crash', async () => {
    // The case that actually happens: the process started, then died. The old shutdown timestamp
    // is still there from the run before, and reading it as "clean" would skip the integrity check
    // after exactly the kind of exit that needs one.
    const stale = marker({
      lastCleanShutdownAt: '2026-11-05T09:00:00.000Z',
      lastBoot: { version: '1.0.0', schemaHead: '0001', at: '2026-11-06T09:00:00.000Z' },
    });
    expect(shutDownCleanly(stale)).toBe(false);
  });

  it('treats a never-started install with a shutdown as clean', async () => {
    const odd = marker({ lastCleanShutdownAt: '2026-11-06T09:00:00.000Z' });
    expect(shutDownCleanly(odd)).toBe(true);
    await Promise.resolve();
  });

  it('does nothing when asked to record a shutdown with no marker', async () => {
    // Shutdown runs on every exit, including one that failed before the marker was written. It
    // must not turn a failed start into a second, more confusing error.
    await withDataDir(async (root) => {
      await createLayout(root);
      await expect(recordCleanShutdown(root, NOW)).resolves.toBeUndefined();
    });
  });
});

describe('a round trip through the filesystem', { tags: ['slow'] }, () => {
  it('reads back exactly what it wrote, including the optional fields', async () => {
    await withDataDir(async (root) => {
      await createLayout(root);
      const full = marker({
        lastBoot: { version: '1.2.3', schemaHead: '0057', at: '2026-11-06T09:00:05.000Z' },
        lastCleanShutdownAt: '2026-11-06T10:00:00.000Z',
      });
      await writeFormat(root, full);

      const state = await readFormat(root);
      expect(state.kind).toBe('present');
      if (state.kind !== 'present') return;
      expect(state.format).toEqual(full);
    });
  });

  it('survives being written many times, as a long-lived install would', async () => {
    await withDataDir(async (root) => {
      await createLayout(root);
      await writeFormat(root, marker());
      for (let boot = 1; boot <= 20; boot += 1) {
        await recordBoot(root, {
          version: `1.0.${String(boot)}`,
          schemaHead: '0001',
          at: new Date(NOW.getTime() + boot * 1000).toISOString(),
        });
      }
      const state = await readFormat(root);
      expect(state.kind).toBe('present');
      if (state.kind !== 'present') return;
      expect(state.format.lastBoot?.version).toBe('1.0.20');
      expect(state.format.createdAt).toBe(NOW.toISOString());
    });
  });
});
