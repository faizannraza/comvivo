/**
 * Where a blob lives on disk (`02` §3.11).
 *
 * `data/blobs/<addr[0:2]>/<addr[2:4]>/<addr>.vblob`, and the two levels of fan-out are the point:
 * a flat directory with a million attachments in it is slow to list on every filesystem and
 * pathological on some, and a host *will* list it — that is the first thing anyone does when a
 * disk fills up.
 *
 * The address is a **keyed** HMAC, not the plaintext hash (`02` D14, `08` SD-06). So the filenames
 * tell a reader nothing: somebody holding a photograph cannot confirm whether it is in a family's
 * store without the blob-id key, which is the whole reason the address is keyed.
 */
import { join } from 'node:path';
import { StorageError } from '@comvivo/shared';

/** The extension `02` §3.11 gives a blob body. */
export const BLOB_EXTENSION = '.vblob';

/** Where a part-written blob goes before it is renamed into place. */
export const BLOB_TMP_DIR = '.tmp';

/** The suffix of a part-written file, so orphan GC can tell one from a finished blob. */
export const BLOB_TMP_EXTENSION = '.part';

/** `02` §3.11's address: 32 bytes of HMAC as lowercase hex. */
const ADDRESS_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The absolute path of a blob.
 *
 * The address is **validated** rather than trusted, because it reaches `join` — and an address
 * read from a column that had been tampered with could otherwise contain `..` and send a write
 * outside the data directory. Cheap, and the one place every path is built.
 */
export function blobPath(blobsDir: string, addr: string): string {
  assertAddress(addr);
  return join(blobsDir, addr.slice(0, 2), addr.slice(2, 4), `${addr}${BLOB_EXTENSION}`);
}

/** The directory `blobPath` needs to exist. */
export function blobDir(blobsDir: string, addr: string): string {
  assertAddress(addr);
  return join(blobsDir, addr.slice(0, 2), addr.slice(2, 4));
}

export function blobTmpDir(blobsDir: string): string {
  return join(blobsDir, BLOB_TMP_DIR);
}

export function assertAddress(addr: string): void {
  if (!ADDRESS_PATTERN.test(addr)) {
    throw new StorageError('STORAGE_CONSTRAINT', 'that is not a blob address', {
      hint: 'An address is 64 lowercase hex characters. This one reached a filesystem path, so it is rejected rather than joined.',
      category: 'bug',
    });
  }
}

/** Whether a filename is a finished blob body, for the orphan sweep. */
export function isBlobFile(name: string): boolean {
  return (
    name.endsWith(BLOB_EXTENSION) && ADDRESS_PATTERN.test(name.slice(0, -BLOB_EXTENSION.length))
  );
}
