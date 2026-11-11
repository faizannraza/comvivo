/**
 * The manifest's pure parts (`M1-T27`; `02` §3.14.3).
 *
 * Three functions, and each exists because of a failure mode the roundtrip cannot show: an index
 * line that is malformed rather than absent, a row-count comparison where a table exists on only
 * one side, and an archive whose name must not carry an instance's whole id.
 */
import { BACKUP_ENTRY } from '@comvivo/shared/crypto';
import { describe, expect, it } from 'vitest';
import { archiveName } from './create.js';
import {
  BLOB_INDEX_ENTRY,
  encodeBlobIndex,
  MANIFEST_DB_PATH,
  parseBlobIndex,
  tableCountDifferences,
} from './manifest.js';

const LINE = {
  addr: 'a'.repeat(64),
  sizeEnc: 128,
  groupId: 'grp_01jbkm0000000000000000000000',
  sha256: 'b'.repeat(64),
};

describe('the blob index (02 §3.14.3)', () => {
  it('round trips, one object per line with a trailing newline', () => {
    const text = encodeBlobIndex([LINE, { ...LINE, addr: 'c'.repeat(64) }]);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n').filter((row) => row !== '')).toHaveLength(2);
    expect(parseBlobIndex(text)).toEqual([LINE, { ...LINE, addr: 'c'.repeat(64) }]);
  });

  it('is empty for an archive with no blobs, and parses back to nothing', () => {
    // A newline and nothing else, which is what `join` on an empty array plus the terminator gives.
    // The parser has to read that as zero entries rather than as one blank one.
    expect(parseBlobIndex(encodeBlobIndex([]))).toEqual([]);
    expect(parseBlobIndex('')).toEqual([]);
    expect(parseBlobIndex('\n\n  \n')).toEqual([]);
  });

  it('names the line number when one is malformed', () => {
    const text = `${JSON.stringify(LINE)}\n${JSON.stringify({ ...LINE, addr: 'short' })}\n`;
    // The number is the point: an index of ten thousand blobs whose failure says only "invalid"
    // is an index nobody can repair, and the line number is also what distinguishes a *truncated*
    // file — the common corruption — from a wrong one.
    expect(() => parseBlobIndex(text)).toThrow(new RegExp(`${BLOB_INDEX_ENTRY} line 2`));
  });

  it('refuses a line that is not JSON at all', () => {
    expect(() => parseBlobIndex('{not json\n')).toThrow();
  });
});

describe('tableCountDifferences', () => {
  it('finds nothing when the two agree', () => {
    expect(tableCountDifferences({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it('reports a table that exists on only one side as a shortfall', () => {
    // Not as an absence: a table in the archive and not in the restore is exactly the silently
    // partial restore this check exists for, and dropping it from the comparison would hide it.
    expect(tableCountDifferences({ messages: 500 }, {})).toEqual([
      { table: 'messages', expected: 500, actual: 0 },
    ]);
    expect(tableCountDifferences({}, { messages: 3 })).toEqual([
      { table: 'messages', expected: 0, actual: 3 },
    ]);
  });

  it('sorts by table name, so two runs report the same list', () => {
    const differences = tableCountDifferences({ z: 1, a: 1 }, { z: 2, a: 2 });
    expect(differences.map((d) => d.table)).toEqual(['a', 'z']);
  });
});

describe('archiveName (02 §3.14.1, 08 §3.7.11)', () => {
  it('carries six characters of the instance id and a compact timestamp', () => {
    // `08` §3.7.11: "filenames carry no sensitive metadata". A full id in a filename copied to
    // cloud storage identifies the instance across every archive it ever wrote; six characters of
    // a TypeID suffix tells two instances' archives apart in one directory and is not a
    // fingerprint.
    expect(archiveName('inst_01jbkm0000000000000000000000', '2026-11-11T12:34:56Z')).toBe(
      'village-01jbkm-20261111T123456Z.vbak',
    );
  });

  it('drops sub-second precision, which a filename has no use for', () => {
    expect(archiveName('inst_01jbkm0000000000000000000000', '2026-11-11T12:34:56.789Z')).toBe(
      'village-01jbkm-20261111T123456Z.vbak',
    );
  });

  it('handles an id with no prefix separator', () => {
    // Not reachable from `instanceId`, which is always a TypeID — and asserted anyway, because the
    // alternative is a `split('_')[1]` that is `undefined` and a filename reading `village-undefi`.
    expect(archiveName('bare', '2026-11-11T12:34:56Z')).toBe('village-bare-20261111T123456Z.vbak');
  });
});

describe('the frozen entry paths', () => {
  it('comes from the frozen separators rather than from `BRAND`', () => {
    // A path **inside a container format**: the file in `data/db` follows `BRAND.slug`, while an
    // archive written last year must still restore. The literal itself is pinned in
    // `shared/src/crypto/labels.test.ts`, which is the file the brand guard exempts — a test that
    // spelled it here would be a brand literal in a package that must not hold one, and a test
    // that derived it from `BRAND` would assert the opposite of what it is for.
    expect(MANIFEST_DB_PATH).toBe(BACKUP_ENTRY.db);
    expect(MANIFEST_DB_PATH.startsWith('db/')).toBe(true);
  });
});
