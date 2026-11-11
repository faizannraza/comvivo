/**
 * The blob store (`M1-T25`; `02` §3.11, §9.3; `08` §3.7.10).
 *
 * `02` §9.3 names three suites — `blob.tamper.test`, `blob.gc.test`, `blob.quota.test` — and the
 * acceptance criterion adds `sec.crypto.blob-id` and a crypto-shred test. All of them are here,
 * because they are about the same few decisions seen from different sides:
 *
 *  - the address is **keyed**, so filenames reveal nothing (`02` D14);
 *  - the file is written before the row, so a row never exists without its bytes;
 *  - an unreferenced blob gets a grace period, so an edit that re-attaches it does not lose it;
 *  - deleting the wrapped DEK is enough to make the bytes unreadable, which is what makes erasure
 *    work on a filesystem that does not really overwrite.
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expectWritten, type NotPromise } from '@comvivo/core';
import { BRAND, type GroupId, StorageError } from '@comvivo/shared';
import { AAD, blobAddress, sha256Hex, wrappersSecretStream } from '@comvivo/shared/crypto';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  conversationId,
  groupLabel,
  member,
  messageId,
  person,
  T0,
  withReposAsync,
} from '../repos/testing/harness.js';
import { blobPath } from './paths.js';
import { BlobStore } from './store.js';

const MIME = 'image/jpeg';
const KEK = Buffer.alloc(32, 1);
const BLOB_ID_KEY = Buffer.alloc(32, 2);

type World = Parameters<Parameters<typeof withReposAsync>[0]>[0];

interface Fixture {
  readonly world: World;
  readonly store: BlobStore;
  readonly dir: string;
  readonly write: <T>(fn: (uow: never) => NotPromise<T>) => T;
}

/** A store over a temporary directory, with the keys a test can vary. */
async function withStore(
  fn: (fixture: Fixture) => Promise<void>,
  options: {
    readonly blobIdKey?: Buffer | undefined;
    readonly generation?: number | undefined;
    readonly limits?: Parameters<typeof makeStore>[2] | undefined;
    readonly freeBytes?: (() => Promise<number>) | undefined;
  } = {},
): Promise<void> {
  await withReposAsync(async (world) => {
    const dir = await makeTempDir();
    const store = makeStore(world, dir, options.limits, {
      blobIdKey: options.blobIdKey ?? BLOB_ID_KEY,
      generation: options.generation ?? 1,
      freeBytes: options.freeBytes,
    });
    await fn({
      world,
      store,
      dir,
      write: ((inner: (uow: never) => unknown) =>
        world.store.write(inner as never)) as Fixture['write'],
    });
  });
}

function makeStore(
  world: World,
  dir: string,
  limits?: Partial<{
    maxBytes: number;
    groupQuotaBytes: number;
    minFreeBytes: number;
    gcGraceHours: number;
  }>,
  keys?: {
    blobIdKey: Buffer;
    generation: number;
    freeBytes?: (() => Promise<number>) | undefined;
  },
): BlobStore {
  return new BlobStore({
    db: world.drizzle,
    blobsDir: dir,
    stream: wrappersSecretStream,
    keys: () => ({
      blobKek: KEK,
      blobIdKey: keys?.blobIdKey ?? BLOB_ID_KEY,
      generation: keys?.generation ?? 1,
    }),
    logger: silent(),
    ...(limits === undefined ? {} : { limits }),
    ...(keys?.freeBytes === undefined ? {} : { freeBytes: keys.freeBytes }),
  });
}

function silent() {
  const noop = () => {};
  const logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    content: noop,
  };
  return { ...logger, child: () => logger } as never;
}

async function makeTempDir(): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  return mkdtemp(join(tmpdir(), `${BRAND.slug}-blobs-`));
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

async function drain(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const pieces: Uint8Array[] = [];
  for await (const piece of source) pieces.push(piece);
  return Buffer.concat(pieces);
}

function payload(size: number, seed = 1): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 17 + seed) % 251;
  return bytes;
}

async function put(fixture: Fixture, content: Buffer, mime = MIME) {
  return fixture.store.put({
    groupId: fixture.world.groupId,
    mime,
    source: once(content),
    write: fixture.write as never,
  });
}

describe('sec.crypto.blob-id (02 D14, 08 SD-06)', () => {
  it('gives the same plaintext the same address in one instance', async () => {
    await withStore(async (fixture) => {
      const content = payload(1_000);
      const first = await put(fixture, content);
      const second = await put(fixture, content);
      expect(second.deduped).toBe(true);
      expect(second.storageAddr).toBe(first.storageAddr);
      // Content-addressed: the same photo forwarded twice is stored once, which is the whole point
      // of hashing the plaintext rather than minting an id.
      expect(await readdir(join(fixture.dir, first.storageAddr.slice(0, 2)))).toHaveLength(1);
    });
  });

  it('gives different instances different addresses for the same plaintext', async () => {
    const content = payload(500);
    const addresses: string[] = [];
    for (const key of [Buffer.alloc(32, 3), Buffer.alloc(32, 4)]) {
      await withStore(
        async (fixture) => {
          addresses.push((await put(fixture, content)).storageAddr);
        },
        { blobIdKey: key },
      );
    }
    // `02` D14's reason, stated as a test: with a plain content hash as the filename, anybody who
    // could read `data/blobs/` — a backup on a NAS, a shared machine, a stolen disk — could check
    // whether a **particular** photograph they already hold is in a family's store, without
    // decrypting anything. A keyed address makes that impossible across instances.
    expect(addresses[0]).not.toBe(addresses[1]);
    expect(addresses[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives the address exactly as 02 §3.11 states', async () => {
    await withStore(async (fixture) => {
      const content = payload(64);
      const result = await put(fixture, content);
      // `HMAC(K_blobid, groupId ‖ 0x00 ‖ sha256_bytes)`, recomputed independently rather than by
      // calling the store's own helper — an oracle that shared the implementation would prove only
      // that it agreed with itself.
      const expected = blobAddress(
        BLOB_ID_KEY,
        Buffer.concat([
          Buffer.from(fixture.world.groupId, 'utf8'),
          Buffer.of(0),
          Buffer.from(sha256Hex(content), 'hex'),
        ]),
      );
      expect(result.storageAddr).toBe(expected);
      expect(result.sha256).toBe(sha256Hex(content));
    });
  });

  it('never writes the plaintext hash into the blobs directory', async () => {
    await withStore(async (fixture) => {
      const content = payload(2_000);
      const result = await put(fixture, content);
      const digest = result.sha256;
      // The acceptance criterion's "raw SHA-256 never stored" means **outside the encrypted
      // database**: the hash is a column in SQLCipher, which is fine, but it must not appear as a
      // filename or inside a blob file. Either would undo the keyed address completely — the
      // confirmation attack works just as well against a hash found in a file as one in a name.
      for (const path of await listFiles(fixture.dir)) {
        expect(path, 'the hash appears in a path').not.toContain(digest);
        const bytes = await readFile(path);
        expect(bytes.includes(Buffer.from(digest, 'hex')), 'the hash appears in a file').toBe(
          false,
        );
        expect(bytes.toString('latin1').includes(digest), 'the hex hash appears in a file').toBe(
          false,
        );
      }
    });
  });
});

describe('the write path (02 §3.11)', () => {
  it('stores the file, the row and nothing else', async () => {
    await withStore(async (fixture) => {
      const content = payload(70_000);
      const result = await put(fixture, content);
      expect(result.deduped).toBe(false);
      expect(result.sizeBytes).toBe(content.length);

      const row = fixture.store.stat(fixture.world.groupId, result.sha256);
      expect(row?.state).toBe('stored');
      expect(row?.mime).toBe(MIME);
      expect(row?.sizeBytes).toBe(content.length);
      expect(row?.kekVersion).toBe(1);
      expect(row?.unreferencedSince).toBeUndefined();

      const path = blobPath(fixture.dir, result.storageAddr);
      const info = await stat(path);
      expect(info.isFile()).toBe(true);
      // 0600: the host user and nobody else. `08` B8 does not trust other local users, and an
      // attachment is message content.
      expect(info.mode & 0o777).toBe(0o600);
      // No `.tmp` left behind.
      expect((await listFiles(fixture.dir)).filter((p) => p.endsWith('.part'))).toEqual([]);
      expect(await drain(fixture.store.open(fixture.world.groupId, result.sha256))).toEqual(
        content,
      );
    });
  });

  it('round-trips an empty blob and one spanning several chunks', async () => {
    await withStore(async (fixture) => {
      for (const size of [0, 1, 65_536, 200_000]) {
        const content = payload(size, size + 1);
        const result = await put(fixture, content);
        expect(
          await drain(fixture.store.open(fixture.world.groupId, result.sha256)),
          `${String(size)} bytes`,
        ).toEqual(content);
      }
    });
  });

  it('refuses a blob over the size limit and leaves nothing behind', async () => {
    await withStore(
      async (fixture) => {
        const content = payload(5_000);
        await expect(put(fixture, content)).rejects.toThrow(/over the/);
        // The `.tmp` file is unlinked on failure, which is what keeps a repeatedly-failing upload
        // from filling the disk with parts.
        expect(await listFiles(fixture.dir)).toEqual([]);
        expect(fixture.store.stat(fixture.world.groupId, sha256Hex(content))).toBeUndefined();
      },
      { limits: { maxBytes: 1_000 } },
    );
  });

  it('refuses a write when the group is over quota', async () => {
    await withStore(
      async (fixture) => {
        await put(fixture, payload(600));
        // The pre-check is on the **declared** size, which the platform supplies and which is
        // advisory — the real limit is enforced while streaming. It turns "far too big" into an
        // immediate refusal rather than a 50 MiB download that is then thrown away.
        await expect(
          fixture.store.put({
            groupId: fixture.world.groupId,
            mime: MIME,
            source: once(payload(600, 9)),
            write: fixture.write as never,
            declaredSize: 600,
          }),
        ).rejects.toThrow(StorageError);
        expect(fixture.store.usedBytes(fixture.world.groupId)).toBe(600);
      },
      { limits: { groupQuotaBytes: 1_000 } },
    );
  });

  it('refuses a write when the disk is nearly full', async () => {
    await withStore(
      async (fixture) => {
        // `02` §3.11's `BLOB_DISK_LOW`. Checked before anything is written, because the failure a
        // host cares about is "the database could not commit", and filling the disk with
        // attachments is how that happens.
        await expect(put(fixture, payload(10))).rejects.toThrow(/free disk space/);
        expect(await listFiles(fixture.dir)).toEqual([]);
      },
      { freeBytes: async () => 1_000, limits: { minFreeBytes: 1024 * 1024 } },
    );
  });

  it('serialises two concurrent puts of the same content', async () => {
    await withStore(async (fixture) => {
      const content = payload(40_000);
      // `02` §3.11's per-address mutex. Without it both see no row, both rename onto the same path
      // and both insert — one gets a constraint error *after* overwriting the other's file.
      const [first, second] = await Promise.all([put(fixture, content), put(fixture, content)]);
      expect([first.deduped, second.deduped].filter(Boolean)).toHaveLength(1);
      expect(first.storageAddr).toBe(second.storageAddr);
      expect(await drain(fixture.store.open(fixture.world.groupId, first.sha256))).toEqual(content);
      expect(await listFiles(fixture.dir)).toHaveLength(1);
    });
  });

  it('does not dedupe against a blob the sweep is deleting', async () => {
    await withStore(async (fixture) => {
      const content = payload(800);
      const first = await put(fixture, content);
      // The window `02` §3.11's GC step 3 opens: the row is `deleting`, the file is about to be
      // unlinked, and a `put` of the same content arrives. Deduping against it would hand the
      // caller a blob whose bytes are being deleted — a message with an attachment that empties
      // itself seconds later.
      fixture.world.db
        .prepare("UPDATE blobs SET state = 'deleting' WHERE sha256 = ?")
        .run(first.sha256);
      const again = await put(fixture, content);
      expect(again.deduped).toBe(false);
      // And the row is back to `stored`, with the file in place: re-putting is how a blob comes
      // back from the brink rather than being lost to a sweep that was already under way.
      expect(fixture.store.stat(fixture.world.groupId, first.sha256)?.state).toBe('stored');
      expect(await drain(fixture.store.open(fixture.world.groupId, first.sha256))).toEqual(content);
    });
  });

  it('keeps two groups` copies of the same bytes apart', async () => {
    await withStore(async (fixture) => {
      const content = payload(300);
      const mine = await put(fixture, content);
      const theirs = await fixture.store.put({
        groupId: fixture.world.otherGroupId,
        mime: MIME,
        source: once(content),
        write: fixture.write as never,
      });
      // I4: the address binds the **group**, so two groups holding the same photo hold two files.
      // Sharing one would mean a group's quota and its deletion affected another group's data, and
      // a purge of one would silently empty an attachment in the other.
      expect(theirs.deduped).toBe(false);
      expect(theirs.storageAddr).not.toBe(mine.storageAddr);
      expect(await listFiles(fixture.dir)).toHaveLength(2);
      expect(
        fixture.store.stat(fixture.world.groupId, content.length === 0 ? '' : mine.sha256),
      ).toBeDefined();
    });
  });
});

describe('blob.tamper.test (02 §9.3)', () => {
  it('refuses a file whose bytes were changed', async () => {
    await withStore(async (fixture) => {
      const content = payload(1_000);
      const result = await put(fixture, content);
      const path = blobPath(fixture.dir, result.storageAddr);
      const file = await readFile(path);
      file[file.length - 4] = (file[file.length - 4] ?? 0) ^ 0xff;
      await writeFile(path, file);
      await expect(
        drain(fixture.store.open(fixture.world.groupId, result.sha256)),
      ).rejects.toThrow();
    });
  });

  it('refuses a file swapped between two rows', async () => {
    await withStore(async (fixture) => {
      const mine = await put(fixture, payload(900, 1));
      const other = await put(fixture, payload(900, 2));
      const mineFile = await readFile(blobPath(fixture.dir, mine.storageAddr));
      // Put one group's blob at the other's address. The **wrapped DEK** is where the address
      // binding lives (`AAD.blobDek`), so the key for this row does not open that file — which is
      // the property `02` §3.11's "Binding" paragraph claims and the reason the body's own AD does
      // not need the address.
      await writeFile(blobPath(fixture.dir, other.storageAddr), mineFile);
      await expect(
        drain(fixture.store.open(fixture.world.groupId, other.sha256)),
      ).rejects.toThrow();
    });
  });

  it('refuses a file whose row was rewritten to claim a different hash', async () => {
    await withStore(async (fixture) => {
      const content = payload(1_200);
      const result = await put(fixture, content);
      // The row's `sha256` is changed to something else, keeping everything else — which is what
      // somebody with write access to the database would do. The **EOF hash check** is the only
      // thing that catches it: the file is internally consistent and its DEK unwraps.
      const forged = sha256Hex(payload(1_200, 99));
      fixture.world.db
        .prepare('UPDATE blobs SET sha256 = ? WHERE sha256 = ?')
        .run(forged, result.sha256);
      await expect(drain(fixture.store.open(fixture.world.groupId, forged))).rejects.toThrow(
        /does not hash to what its row says/,
      );
    });
  });

  it('reports a missing file rather than an empty attachment', async () => {
    await withStore(async (fixture) => {
      const result = await put(fixture, payload(100));
      const { unlink } = await import('node:fs/promises');
      await unlink(blobPath(fixture.dir, result.storageAddr));
      // `02` §3.11: external deletion "surfaces as `BLOB_MISSING_FILE` on read". A zero-length
      // stream would be worse than an error — the member would see an attachment that silently
      // contains nothing.
      await expect(drain(fixture.store.open(fixture.world.groupId, result.sha256))).rejects.toThrow(
        /not on disk/,
      );
      await expect(
        drain(fixture.store.open(fixture.world.groupId, sha256Hex(payload(7)))),
      ).rejects.toThrow(/no blob with that hash/);
    });
  });

  it('crypto-shreds a blob by deleting its wrapped DEK', async () => {
    await withStore(async (fixture) => {
      const content = payload(2_000);
      const result = await put(fixture, content);
      const path = blobPath(fixture.dir, result.storageAddr);
      expect(
        fixture.write(() =>
          fixture.store.shred(undefined as never, fixture.world.groupId, result.sha256),
        ),
      ).toBe(true);
      // The **file is still there** and is now unreadable: the only copy of its DEK was 48 bytes
      // in the database. That is what makes `08` §3.16.2's erasure work on storage that does not
      // really overwrite — an SSD's wear levelling, a snapshotting volume, a filesystem with
      // copy-on-write — where unlinking a file guarantees nothing.
      expect((await stat(path)).size).toBeGreaterThan(0);
      expect(fixture.store.stat(fixture.world.groupId, result.sha256)).toBeUndefined();
      await expect(drain(fixture.store.open(fixture.world.groupId, result.sha256))).rejects.toThrow(
        /no blob with that hash/,
      );
      expect(
        fixture.write(() =>
          fixture.store.shred(undefined as never, fixture.world.groupId, result.sha256),
        ),
      ).toBe(false);
    });
  });
});

describe('blob.gc.test (02 §3.11)', () => {
  /** A message with an attachment, so a blob has a reference to lose. */
  function attach(fixture: Fixture, sha256: string, tag: string): void {
    fixture.world.store.write((uow) => {
      expectWritten(fixture.world.repos.persons.create(uow, person(tag)), 'a person');
      expectWritten(
        fixture.world.repos.members.add(uow, member(tag, fixture.world.groupId)),
        'a member',
      );
      expectWritten(
        fixture.world.repos.conversations.create(uow, {
          id: conversationId(tag),
          groupId: fixture.world.groupId,
          channel: 'simulator',
          platformChatId: `chat-${tag}`,
          kind: 'group',
          boundAt: T0,
        }),
        'a conversation',
      );
      expectWritten(
        fixture.world.repos.messages.insert(
          uow,
          {
            id: messageId(tag),
            groupId: fixture.world.groupId,
            conversationId: conversationId(tag),
            kind: 'member',
            text: 'look at this',
            sentAt: T0,
            receivedAt: T0,
          },
          groupLabel(fixture.world.groupId),
        ),
        'a message',
      );
    });
    fixture.world.db
      .prepare(
        `INSERT INTO message_attachments (id, message_id, group_id, kind, mime, blob_sha256, status, platform_ref, created_at)
         VALUES (?, ?, ?, 'image', ?, ?, 'stored', '{}', 0)`,
      )
      .run(
        `att_01j${tag}${'0'.repeat(23 - tag.length)}`,
        messageId(tag),
        fixture.world.groupId,
        MIME,
        sha256,
      );
  }

  it('marks what nothing references, and unmarks it when it comes back', async () => {
    await withStore(async (fixture) => {
      const result = await put(fixture, payload(400));
      const now = Temporal.Instant.fromEpochMilliseconds(Date.now());

      // Nothing refers to it yet, so the first mark takes it.
      expect(fixture.write(() => fixture.store.mark(undefined as never, now)).marked).toBe(1);
      expect(
        fixture.store.stat(fixture.world.groupId, result.sha256)?.unreferencedSince,
      ).toBeDefined();

      attach(fixture, result.sha256, 'a1f');
      // A blob can become referenced again between sweeps — an edited message re-attaching the same
      // photo — and a mark that was never cleared would delete it 24 hours later while in use.
      const second = fixture.write(() => fixture.store.mark(undefined as never, now));
      expect(second.unmarked).toBe(1);
      expect(second.marked).toBe(0);
      expect(
        fixture.store.stat(fixture.world.groupId, result.sha256)?.unreferencedSince,
      ).toBeUndefined();
    });
  });

  it('waits out the grace period before deleting', async () => {
    await withStore(async (fixture) => {
      const result = await put(fixture, payload(400));
      const now = Temporal.Instant.fromEpochMilliseconds(Date.now());
      fixture.write(() => fixture.store.mark(undefined as never, now));

      // Nothing to sweep yet: the grace period is what gives an edit time to re-attach the blob.
      expect(fixture.store.sweepable(now, 10)).toEqual([]);
      // An hour later is still inside the 24-hour window. Asserted separately from the instant
      // above, because a cutoff of `now` rather than `now − grace` also returns nothing when the
      // mark is *exactly* `now` — the strict comparison hides it. An hour's distance is what makes
      // the subtraction load-bearing.
      expect(fixture.store.sweepable(now.add({ hours: 1 }), 10)).toEqual([]);
      expect(fixture.store.sweepable(now.add({ hours: 23 }), 10)).toEqual([]);
      const later = now.add({ hours: 25 });
      const doomed = fixture.store.sweepable(later, 10);
      expect(doomed.map((row) => row.sha256)).toEqual([result.sha256]);

      const row = doomed[0];
      if (row === undefined) throw new Error('fixture');
      expect(await fixture.store.sweep(row, fixture.write as never)).toBe(true);
      // Row and file both gone, in that order — `deleting` first, so a crash leaves garbage rather
      // than a `stored` row with no file, which would read as corruption.
      expect(fixture.store.stat(fixture.world.groupId, result.sha256)).toBeUndefined();
      expect(await listFiles(fixture.dir)).toEqual([]);
    });
  });

  it('declines to sweep a blob that was re-attached after it was listed', async () => {
    await withStore(async (fixture) => {
      const result = await put(fixture, payload(400));
      const now = Temporal.Instant.fromEpochMilliseconds(Date.now());
      fixture.write(() => fixture.store.mark(undefined as never, now));
      const doomed = fixture.store.sweepable(now.add({ hours: 25 }), 10);
      const row = doomed[0];
      if (row === undefined) throw new Error('fixture');

      // The race the grace period cannot close on its own: between listing and deleting, a message
      // edit re-attached the blob and the mark was cleared. `sweep` re-checks under the mutex, so
      // the bytes are not deleted out from under a live attachment.
      attach(fixture, result.sha256, 'b1f');
      fixture.write(() => fixture.store.mark(undefined as never, now));
      expect(await fixture.store.sweep(row, fixture.write as never)).toBe(false);
      expect(fixture.store.stat(fixture.world.groupId, result.sha256)?.state).toBe('stored');
      expect(await listFiles(fixture.dir)).toHaveLength(1);
    });
  });

  it('sweeps orphan files and abandoned parts', async () => {
    await withStore(async (fixture) => {
      const kept = await put(fixture, payload(200));
      const now = Temporal.Instant.fromEpochMilliseconds(Date.now());

      // An orphan: a crash between the rename and the row leaves a file at its final path with no
      // row. A `.part`: a crash before the rename.
      const orphanAddr = 'f'.repeat(64);
      const { mkdir, utimes } = await import('node:fs/promises');
      await mkdir(join(fixture.dir, 'ff', 'ff'), { recursive: true });
      const orphanPath = blobPath(fixture.dir, orphanAddr);
      await writeFile(orphanPath, 'nonsense');
      const partPath = join(fixture.dir, '.tmp', 'abc.part');
      await mkdir(join(fixture.dir, '.tmp'), { recursive: true });
      await writeFile(partPath, 'half a file');
      // Both aged past the grace period. A `put` in flight cannot have a file older than it has
      // been running, which is what makes the age check safe rather than racy.
      const old = new Date(Date.now() - 48 * 3_600_000);
      await utimes(orphanPath, old, old);
      await utimes(partPath, old, old);
      // **The kept blob is aged too.** Left young, the age check skips it before `hasRow` is ever
      // consulted — so the sweep would pass even if it deleted every file that had a row.
      // Measured: removing the `hasRow` guard changed no test until this line was added.
      await utimes(blobPath(fixture.dir, kept.storageAddr), old, old);

      const addresses = fixture.store.addresses();
      expect(await fixture.store.sweepOrphans(now, (addr) => addresses.has(addr))).toBe(2);
      expect(await listFiles(fixture.dir)).toEqual([blobPath(fixture.dir, kept.storageAddr)]);
    });
  });

  it('leaves a young orphan alone', async () => {
    await withStore(async (fixture) => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(fixture.dir, '.tmp'), { recursive: true });
      const partPath = join(fixture.dir, '.tmp', 'fresh.part');
      await writeFile(partPath, 'in flight');
      const now = Temporal.Instant.fromEpochMilliseconds(Date.now());
      // A `put` streaming a 50 MiB attachment has an open `.part` for as long as the download
      // takes. Sweeping it would abort a live upload — which is why the sweep is age-based rather
      // than "anything in `.tmp`".
      expect(await fixture.store.sweepOrphans(now, () => false)).toBe(0);
      expect(await listFiles(fixture.dir)).toEqual([partPath]);
    });
  });
});

describe('KEK rotation (02 §3.11)', () => {
  it('re-wraps a stale DEK without touching the file', async () => {
    await withStore(async (fixture) => {
      const content = payload(5_000);
      const result = await put(fixture, content);
      const path = blobPath(fixture.dir, result.storageAddr);
      const before = await readFile(path);

      // Generation 2, the same KEK material for the test's purposes: what is being asserted is
      // that the row moves and the file does not.
      const rotated = makeStore(fixture.world, fixture.dir, undefined, {
        blobIdKey: BLOB_ID_KEY,
        generation: 2,
      });
      expect(fixture.write(() => rotated.rewrap(undefined as never, 100))).toBe(1);
      expect(rotated.stat(fixture.world.groupId, result.sha256)?.kekVersion).toBe(2);
      // **The file is byte-identical.** That is the point of wrapping a per-blob DEK: a rotation
      // touches a few hundred bytes per blob rather than re-encrypting gigabytes, which is what
      // makes `village keys rotate-data` something a host will actually run on a Pi.
      expect(await readFile(path)).toEqual(before);
      expect(await drain(rotated.open(fixture.world.groupId, result.sha256))).toEqual(content);
      // Idempotent: a second pass finds nothing stale, so a chunked rotation terminates.
      expect(fixture.write(() => rotated.rewrap(undefined as never, 100))).toBe(0);
    });
  });

  it('binds the wrapped DEK to the generation that wrapped it', async () => {
    await withStore(async (fixture) => {
      const result = await put(fixture, payload(300));
      // `AAD.blobDek(addr, gen)` carries the generation, so a row claiming the wrong one fails to
      // unwrap — which is what stops a `kek_version` edit from making a rotated blob look current.
      fixture.world.db
        .prepare('UPDATE blobs SET kek_version = 7 WHERE sha256 = ?')
        .run(result.sha256);
      await expect(
        drain(fixture.store.open(fixture.world.groupId, result.sha256)),
      ).rejects.toThrow();
      expect(AAD.blobDek(result.storageAddr, 1)).not.toBe(AAD.blobDek(result.storageAddr, 7));
    });
  });
});

/** Every file under a blobs directory, recursively. */
async function listFiles(dir: string): Promise<readonly string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(path);
    }
  };
  await walk(dir);
  return out.toSorted();
}

/** Narrowed so a test can call a repository without a `GroupId` import. */
export type TestGroupId = GroupId;
