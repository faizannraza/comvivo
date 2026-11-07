/**
 * The cryptographic domain separators, pinned as exact bytes.
 *
 * **Why this file is exempt from the brand guard.** It asserts literals like `comvivo/v1/db`, and
 * the guard's whole job is to refuse hard-coded product names. Here the hard-coding is the point:
 * these strings go into every HKDF `info` and every AEAD AAD, so a rename must **not** change
 * them. There is no migration for a changed domain separator — a host's database stops opening,
 * their blobs stop decrypting and their backups stop restoring, all at once and silently.
 *
 * So `crypto/labels.ts` and this file are the only two paths in `EXCLUDED_FILES` that are there
 * for a correctness reason rather than a convenience, and the pair is deliberately narrow: the
 * constants, and the test that freezes them.
 *
 * The test that actually protects against the dangerous change is the **structural** one at the
 * bottom. Comparing `keyInfo('db')` to `'comvivo/v1/db'` passes whether or not the implementation
 * reads `BRAND`, because `BRAND.slug` is `comvivo` today. Asserting that the source file contains
 * no reference to `BRAND` is what catches the tidy-up *before* a rename makes it catastrophic.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AAD,
  DOMAIN_SEPARATOR_PARTS,
  KEY_PURPOSE,
  KEYRING_FORMAT,
  keyInfo,
  MAGIC,
  tokenMacPurpose,
} from './labels.js';

const LABELS_SOURCE = new URL('labels.ts', import.meta.url).pathname;

describe('HKDF info strings (02 §3.6.1)', () => {
  it.each([
    ['db', 'comvivo/v1/db'],
    ['blob-kek', 'comvivo/v1/blob-kek'],
    ['backup-kek', 'comvivo/v1/backup-kek'],
    ['vault', 'comvivo/v1/vault'],
    ['rk-slot', 'comvivo/v1/rk-slot'],
    ['field', 'comvivo/v1/field'],
    ['fts-token', 'comvivo/v1/fts-token'],
  ])('derives %s as %s', (purpose, expected) => {
    expect(keyInfo(purpose)).toBe(expected);
  });

  it('covers every purpose in the registry', () => {
    // So a purpose added to `KEY_PURPOSE` without a pinned string here is a failing test rather
    // than an unpinned wire constant.
    const pinned = new Set([
      'db',
      'blob-kek',
      'backup-kek',
      'vault',
      'rk-slot',
      'field',
      'fts-token',
    ]);
    for (const purpose of Object.values(KEY_PURPOSE)) {
      expect(pinned.has(purpose), `${purpose} has no pinned info string`).toBe(true);
    }
    expect(Object.values(KEY_PURPOSE)).toHaveLength(pinned.size);
  });

  it('puts the token-MAC epoch in the label, so bumping it logs everybody out', () => {
    expect(keyInfo(tokenMacPurpose(0))).toBe('comvivo/v1/token-mac/epoch=0');
    expect(keyInfo(tokenMacPurpose(42))).toBe('comvivo/v1/token-mac/epoch=42');
  });

  it('refuses an epoch that is not a non-negative integer', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => tokenMacPurpose(bad)).toThrow(RangeError);
    }
  });
});

describe('AEAD additional data (08 §3.7.4, §3.7.10)', () => {
  it('binds a blob body to its address and mime type', () => {
    expect(AAD.blobBody('abc123', 'image/jpeg')).toBe('comvivo/blob/v1|abc123|image/jpeg');
  });

  it('binds a blob DEK to its address and KEK generation', () => {
    expect(AAD.blobDek('abc123', 2)).toBe('comvivo/blob-dek/v1|abc123|gen=2');
  });

  it('binds a keyring slot to the instance, generation, slot and kind', () => {
    // `08` §3.7.4 verbatim. All four, so a slot cannot be swapped between generations *or between
    // instances*, and a master slot cannot be presented as a recovery slot.
    expect(AAD.keyringSlot('ins_01jd8', 2, 'rk1', 'recovery')).toBe(
      'comvivo-keyring/1|ins_01jd8|gen=2|slot=rk1|kind=recovery',
    );
  });

  it('binds a vault entry to its path', () => {
    expect(AAD.vaultEntry('anthropic.apiKey')).toBe('comvivo/vault/v1|anthropic.apiKey');
  });

  it('gives the keyring file the same format identifier the AAD uses', () => {
    // One constant for both, because `08` §3.7.4 uses the same string for the file's `format`
    // field and the AAD prefix — and a mismatch would make a keyring written by one version
    // unreadable by another.
    expect(KEYRING_FORMAT).toBe('comvivo-keyring/1');
    expect(AAD.keyringSlot('i', 1, 's', 'k').startsWith(`${KEYRING_FORMAT}|`)).toBe(true);
  });

  it('separates the four AAD families, so a ciphertext cannot move between them', () => {
    const all = [
      AAD.blobBody('x', 'text/plain'),
      AAD.blobDek('x', 1),
      AAD.keyringSlot('i', 1, 's', 'k'),
      AAD.vaultEntry('x'),
    ];
    expect(new Set(all).size).toBe(4);
  });
});

describe('file magics (08 §3.7.10, §3.7.11)', () => {
  it('are four ASCII bytes each', () => {
    expect(MAGIC.blob).toBe('VBL1');
    expect(MAGIC.backup).toBe('VBK1');
    expect(Buffer.byteLength(MAGIC.blob, 'utf8')).toBe(4);
    expect(Buffer.byteLength(MAGIC.backup, 'utf8')).toBe(4);
  });

  it('keep the V prefix, which is codename-derived and deliberately not renamed', () => {
    // `VBL1` and `VBK1` date from when the product was called Village. A magic number's only
    // requirements are uniqueness and stability, and the letter `V` threatens neither — while
    // changing it would make every existing `.vbak` archive unopenable. The same reasoning as the
    // domain separators, recorded in STATUS → Plan changes (2026-11-04).
    expect(MAGIC.blob.startsWith('V')).toBe(true);
    expect(MAGIC.backup.startsWith('V')).toBe(true);
  });
});

describe('the separators are literals, not derived from BRAND', () => {
  /**
   * The test that actually matters.
   *
   * Every assertion above would pass if `labels.ts` were rewritten to interpolate `BRAND.slug` —
   * because `BRAND.slug` is `comvivo` today. The damage only appears at the *next* rename, by
   * which time the change is in a release and every host's data is unopenable.
   *
   * So this reads the source. It is the one place in the codebase where a structural assertion
   * about a file's text is the right tool: the property is "this module has no dependency on the
   * brand", and no runtime check can see that.
   */
  const source = readFileSync(LABELS_SOURCE, 'utf8');

  /**
   * The source with comments removed.
   *
   * Needed because `labels.ts`'s header *explains* why `BRAND` must not be used, so a naive search
   * for the word finds the warning rather than a violation — which is how the first version of the
   * test below failed on the very comment that makes the file safe.
   */
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');

  it('imports nothing at all', () => {
    // Stronger than "does not import BRAND", and easier to keep true: a module of frozen constants
    // needs no dependencies, so any import at all is the smell. And it is airtight — `BRAND`
    // cannot be referenced without importing it.
    const imports = code.match(/^import\s.+$/gm) ?? [];
    expect(imports, 'labels.ts must stay dependency-free').toEqual([]);
  });

  it('does not mention BRAND in code', () => {
    expect(code).not.toMatch(/\bBRAND\b/);
    // Non-vacuous: the comment stripping must not have eaten the whole file.
    expect(code).toContain('export function keyInfo');
  });

  it('still explains in its comments why BRAND is not used', () => {
    // The inverse assertion, so somebody deleting the warning as redundant has to argue with a
    // test. The comment is the only thing standing between a future reader and a tidy-up that
    // destroys every host's data.
    expect(source).toMatch(/\bBRAND\b/);
    expect(source).toMatch(/data loss/i);
  });

  it('declares the domain as a bare string literal', () => {
    expect(source).toMatch(/const DOMAIN = 'comvivo';/);
  });

  it('exposes the parts it was built from, frozen', () => {
    expect(DOMAIN_SEPARATOR_PARTS).toEqual({ domain: 'comvivo', version: 'v1' });
    expect(Object.isFrozen(DOMAIN_SEPARATOR_PARTS)).toBe(true);
  });

  it('carries a version, which is the only way a future change is possible', () => {
    // `v1` is the escape hatch: a second version can be derived alongside the first, so a key tree
    // change becomes a migration rather than data loss.
    expect(DOMAIN_SEPARATOR_PARTS.version).toBe('v1');
    for (const info of Object.values(KEY_PURPOSE).map((purpose) => keyInfo(purpose))) {
      expect(info).toContain('/v1/');
    }
  });
});
