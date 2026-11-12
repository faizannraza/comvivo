/**
 * The data-directory marker's frozen constants (`12` §4.5).
 *
 * Mirrors `shared/src/crypto/labels.test.ts`, because the hazard is identical. `marker.ts` is one
 * of only two files exempt from `scripts/brand/check.ts`, and the exemption is a correctness
 * requirement: `12` §3.8.1 step 2 exits 65 on a directory that holds data but no recognisable
 * `FORMAT` marker, so deriving `DATA_DIR_FORMAT` from `BRAND` would make every existing install
 * refuse to start at the next rename.
 *
 * The important tests here are the **structural** ones. Every value assertion below would still
 * pass if the file were rewritten to interpolate `BRAND.slug` — because `BRAND.slug` *is*
 * `comvivo` today — and the damage would appear only at the next rename, in a shipped release. So
 * what is actually asserted is that the file imports nothing and never mentions `BRAND`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DATA_DIR_FORMAT, DATA_DIR_FORMAT_VERSION } from './marker.js';

const MARKER_SOURCE = new URL('marker.ts', import.meta.url).pathname;

describe('the frozen constants', () => {
  it('is the exact string every data directory carries', () => {
    expect(DATA_DIR_FORMAT).toBe('comvivo-data-dir');
  });

  it('is version 1, which 12 §4.7 publishes as dataDirFormat', () => {
    expect(DATA_DIR_FORMAT_VERSION).toBe(1);
  });
});

describe('the file stays frozen', () => {
  const source = readFileSync(MARKER_SOURCE, 'utf8');

  /**
   * The source with comments removed.
   *
   * Needed because the header *explains* why `BRAND` must not be used, so a naive search for the
   * word finds the warning rather than a violation — the mistake `labels.test.ts` records making.
   */
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');

  it('imports nothing at all', () => {
    // Stronger than "does not import BRAND", and easier to keep true: a module of two frozen
    // constants needs no dependencies, so any import at all is the smell. It is also airtight —
    // `BRAND` cannot be referenced without importing it.
    expect(code.match(/^import\s.+$/gm) ?? [], 'marker.ts must stay dependency-free').toEqual([]);
  });

  it('does not mention BRAND in code', () => {
    expect(code).not.toMatch(/\bBRAND\b/);
    // Non-vacuous: the comment stripping must not have eaten the whole file.
    expect(code).toContain('export const DATA_DIR_FORMAT');
  });

  it('still carries the warning that explains why', () => {
    // An inverse assertion, so deleting the explanation as redundant argues with a test. The next
    // person to read this file is the one deciding whether to "tidy" the literal into `BRAND`.
    expect(source).toContain('Do not derive these from `BRAND`');
    expect(source).toContain('exits');
    expect(source).toContain('65');
  });

  it('is exempt from the brand guard, and narrowly', () => {
    // The exemption is a hazard in itself: it is a hole in the guard, so it must cover this file
    // and its test and nothing else. Asserted against the guard's own source.
    const guard = readFileSync(
      new URL('../../../../scripts/brand/check.ts', import.meta.url).pathname,
      'utf8',
    );
    expect(guard).toContain('datadir\\/marker\\.(ts|test\\.ts)');
    // Exactly two exemptions of this kind, both for frozen wire constants. A third should be a
    // deliberate decision, not something that accumulates.
    const frozenExemptions = guard.match(/\(ts\|test\\\.ts\)/g) ?? [];
    expect(frozenExemptions).toHaveLength(2);
  });
});
