/**
 * `readListed` — the one place three scanners decide what a read failure means.
 *
 * Tested here rather than through each caller because this is the decision: `ENOENT` is the
 * `git ls-files` race and is nothing, everything else is a file that exists and was not checked.
 * The three callers (`names/check.ts`, `hygiene/check.ts`, `security/literal-secrets.ts`) each
 * turn `failed` into a finding, and the secret scanner's half is asserted in
 * `scripts/security/literal-secrets.test.ts`.
 *
 * `scripts/**` is outside the coverage thresholds (`vitest.shared.ts`), so without this file the
 * three new branches had nothing proving them — which the M1 exit gate's reviewer pointed out
 * about a commit whose whole subject was code that answers without looking.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../../packages/shared/src/brand.js';
import { readListed } from './read-listed.js';

/**
 * One fixture directory for the file, and deliberately not cleaned up.
 *
 * It holds two empty directories and a nine-byte file in the OS temp area, and leaving it means a
 * failed run can be looked at. An `afterAll` that deleted it was the first version, and an empty
 * hook with a comment is worse than no hook.
 */
const root = mkdtempSync(join(tmpdir(), `${BRAND.slug}-read-listed-`));

describe('readListed', () => {
  it('reads a file', () => {
    const path = join(root, 'plain.txt');
    writeFileSync(path, 'contents\n');
    expect(readListed(path)).toEqual({ kind: 'text', text: 'contents\n' });
  });

  it('calls an absent path missing, which is the `git ls-files` race and not a problem', () => {
    expect(readListed(join(root, 'nope', 'gone.txt'))).toEqual({ kind: 'missing' });
  });

  it('calls a directory failed, because it is there and was not checked', () => {
    // The case the old `catch {}` swallowed under the comment "deleted between listing and
    // reading". A directory where a file was expected is not a race; it is a tree the scanner
    // skipped while reporting itself clean.
    const path = join(root, 'a-directory');
    mkdirSync(path, { recursive: true });
    const result = readListed(path);
    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' ? result.reason : '').toBe('EISDIR');
  });

  it('names the error code, so a finding says which kind of unreadable it was', () => {
    // `EISDIR` and `EACCES` need different fixes, and a finding that says only "could not be read"
    // makes the reader go and run `cat` themselves.
    const path = join(root, 'another-directory');
    mkdirSync(path, { recursive: true });
    const result = readListed(path);
    expect(result.kind === 'failed' ? result.reason : '').toMatch(/^E[A-Z]+$/);
  });
});
