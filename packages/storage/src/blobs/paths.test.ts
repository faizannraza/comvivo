/**
 * Where a blob lives on disk (`M1-T25`; `02` §3.11).
 *
 * The fan-out is a performance decision and the validation is a security one, and only the second
 * is worth a test of its own: an address reaches `join`, so an address that could contain `..`
 * would be a path traversal out of the data directory — reachable by anything that can write to
 * the `storage_addr` column, which is the database an attacker with filesystem access already has.
 */
import { join } from 'node:path';
import { StorageError } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { assertAddress, blobDir, blobPath, blobTmpDir, isBlobFile } from './paths.js';

const ADDR = '0123456789abcdef'.repeat(4);

describe('blobPath (02 §3.11)', () => {
  it('fans out two levels, by the first four hex characters', () => {
    expect(blobPath('/data/blobs', ADDR)).toBe(join('/data/blobs', '01', '23', `${ADDR}.vblob`));
    expect(blobDir('/data/blobs', ADDR)).toBe(join('/data/blobs', '01', '23'));
    expect(blobTmpDir('/data/blobs')).toBe(join('/data/blobs', '.tmp'));
    // Two levels, not one: a flat directory with a million attachments is slow to list on every
    // filesystem and pathological on some — and a host *will* list it, because that is the first
    // thing anyone does when a disk fills up.
  });

  it('refuses an address that is not 64 lowercase hex characters', () => {
    for (const bad of [
      '../../etc/passwd',
      `../${ADDR.slice(3)}`,
      ADDR.toUpperCase(),
      ADDR.slice(0, 63),
      `${ADDR}0`,
      '',
      `${ADDR.slice(0, 60)}/../x`,
    ]) {
      // Rejected rather than sanitised: an address is 64 hex characters by construction, so one
      // that is not has come from somewhere it should not have, and silently cleaning it up would
      // turn a tampered column into a successful write to a path nobody chose.
      expect(() => blobPath('/data/blobs', bad), JSON.stringify(bad)).toThrow(StorageError);
      expect(() => blobDir('/data/blobs', bad), JSON.stringify(bad)).toThrow(/not a blob address/);
      expect(() => assertAddress(bad), JSON.stringify(bad)).toThrow(StorageError);
    }
    expect(() => assertAddress(ADDR)).not.toThrow();
  });

  it('recognises a finished blob body and nothing else', () => {
    // The orphan sweep uses this to tell a finished file from a `.part` and from whatever else a
    // host has left in the directory — and it must not treat a stray file as an orphan blob and
    // delete it, which is why the name has to parse as an address.
    expect(isBlobFile(`${ADDR}.vblob`)).toBe(true);
    expect(isBlobFile(`${ADDR}.part`)).toBe(false);
    expect(isBlobFile('notes.vblob')).toBe(false);
    expect(isBlobFile(`${ADDR.toUpperCase()}.vblob`)).toBe(false);
    expect(isBlobFile(ADDR)).toBe(false);
  });
});
