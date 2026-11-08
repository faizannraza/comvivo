/**
 * Atomic file replacement (`12` §4.5), against a real filesystem.
 *
 * Integration rather than unit, and deliberately: the whole value of this module is `rename(2)`'s
 * behaviour and `fsync`'s, and an in-memory fake would reproduce neither. The keyring store already
 * learned that the hard way — a directory opened `r+` fails with `EISDIR` on Linux, which no fake
 * would have caught.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFileAtomic } from './atomic.js';
import { FILE_MODE } from './layout.js';
import { withDataDir } from './testing/data-dir.js';

describe('writeFileAtomic', () => {
  it('replaces the file and leaves no temp behind', async () => {
    await withDataDir(async (root) => {
      const target = join(root, 'run', 'thing.json');
      await writeFileAtomic(target, 'first\n');
      expect(readFileSync(target, 'utf8')).toBe('first\n');
      await writeFileAtomic(target, 'second\n');
      expect(readFileSync(target, 'utf8')).toBe('second\n');

      // A temp file left behind would be harmless but is a sign the rename did not happen.
      expect(readdirSync(join(root, 'run'))).toEqual(['thing.json']);
    });
  });

  it('applies FILE_MODE, which survives the rename', async () => {
    await withDataDir(async (root) => {
      const target = join(root, 'run', 'thing.json');
      await writeFileAtomic(target, 'x\n');
      // `rename` preserves the inode, so the mode set on the temp file is the mode of the result —
      // which is why this does not need a `chmod` after the rename.
      expect(statSync(target).mode & 0o777).toBe(FILE_MODE);
    });
  });

  it('leaves the existing file untouched when the temp write fails', async () => {
    // The half of the guarantee that matters for the instance lock: a failed heartbeat must not
    // destroy the lock it was refreshing. With a plain `writeFile` over the live path, a failure
    // part-way through leaves truncated JSON — which `readLock` reports as **absent** and
    // `acquireLock` then replaces with no liveness check, so two processes both hold the lock.
    // That is the two-writer state C1 forbids. Found by the M1 independent review.
    await withDataDir(async (root) => {
      const target = join(root, 'run', 'thing.json');
      await writeFileAtomic(target, 'the original\n');

      // A *file* where the temp directory should be, so creating the temp file cannot succeed.
      const blocked = join(root, 'run', 'blocked');
      writeFileSync(blocked, 'not a directory');

      await expect(
        writeFileAtomic(target, 'the replacement\n', { tempPath: join(blocked, 'x.tmp') }),
      ).rejects.toThrow();

      // The original is intact, byte for byte — not truncated, not empty, not missing.
      expect(readFileSync(target, 'utf8')).toBe('the original\n');
    });
  });

  it('honours an explicit temp path, which FORMAT depends on', async () => {
    // `clearFormatTemp` removes a stale `tmp/FORMAT.tmp`, so it has to know where the temp file
    // goes. Asserted by making that directory unavailable: if the write went anywhere else this
    // would pass.
    await withDataDir(async (root) => {
      mkdirSync(join(root, 'run'), { recursive: true });
      const target = join(root, 'run', 'thing.json');
      writeFileSync(join(root, 'notadir'), 'a file where a directory should be');

      await expect(
        writeFileAtomic(target, 'x\n', { tempPath: join(root, 'notadir', 'x.tmp') }),
      ).rejects.toThrow();
    });
  });

  it('creates the target directory when it does not exist', async () => {
    await withDataDir(async (root) => {
      const target = join(root, 'deep', 'nested', 'thing.json');
      await writeFileAtomic(target, 'x\n');
      expect(readFileSync(target, 'utf8')).toBe('x\n');
    });
  });
});
