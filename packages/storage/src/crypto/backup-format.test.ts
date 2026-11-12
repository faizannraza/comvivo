/**
 * The `VBK1` envelope (`M1-T27`; `08` §3.7.11, `02` §3.14.2, `02` §9.3's `backup.tamper`).
 *
 * `M1-T27`'s acceptance criterion names five things, and each has a case here: seal and open with
 * the master key *and* with the recovery key, an optional passphrase slot, a header tamper that
 * fails, and `rewrapHeader`. The sixth — restore with the recovery key **alone**, `01` §14 A10 —
 * is what the slot structure exists for and is asserted directly: a reader given only the printed
 * key and the file opens the body and recovers `RDK_g` from the header's keyring snapshot.
 *
 * `02` §9.3's `backup.tamper` asks for a flipped byte "in each region (header, chunk 0, middle,
 * last)" plus truncation. The regions are not interchangeable and the suite says which mechanism
 * catches each: the magic and the declared length by explicit checks, the header JSON by the
 * chunk-0 additional data, a chunk by its own tag, and a missing end by `TAG_FINAL`.
 */
import {
  AAD,
  BACKUP_FORMAT,
  keyInfo,
  randomBytes,
  sha256,
  unwrap,
  wrap,
  wrappersSecretStream,
} from '@comvivo/shared/crypto';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_HEADER_MAX_BYTES,
  BACKUP_MAGIC,
  BACKUP_PREFIX_BYTES,
  type BackupHeader,
  backupAdditionalData,
  backupCoreBytes,
  backupHead,
  openBackup,
  readBackupHead,
  rewrapBackupHeader,
  sealBackup,
} from './backup-envelope.js';

const INSTANCE = 'inst_01jbkp0000000000000000000000';
const CREATED = '2026-11-11T12:00:00Z';

/** A 32-byte key that is readable in a failure message. */
function keyOf(fill: number): Buffer {
  return Buffer.alloc(32, fill);
}

/**
 * A header whose three slots wrap the same DEK under three different keys.
 *
 * Built with the real `wrap`, not with placeholder bytes: the point of the slots is that three
 * unrelated keys each recover one DEK, and a fixture that faked the wraps could not show it.
 */
function headerFor(dek: Uint8Array, keys: { mk: Buffer; rk: Buffer; pp: Buffer }): BackupHeader {
  const core = {
    format: BACKUP_FORMAT,
    instanceId: INSTANCE,
    createdAt: CREATED,
    dataGen: 1,
    body: { chunkSize: 65_536 },
  } as const;
  const salt = Buffer.alloc(16, 9).toString('base64url');
  const dekAad = (kind: string, ref: string) => AAD.backupDek(INSTANCE, CREATED, kind, ref);
  return {
    ...core,
    slots: [
      {
        kind: 'backup-kek',
        gen: 1,
        sealed: wrap(keys.mk, dek, dekAad('backup-kek', '1')).toString('base64url'),
      },
      {
        kind: 'recovery',
        rkId: 'rk1',
        sealed: wrap(keys.rk, dek, dekAad('recovery', 'rk1')).toString('base64url'),
      },
      {
        kind: 'passphrase',
        kdf: { alg: 'scrypt', N: 131_072, r: 8, p: 1, salt },
        sealed: wrap(keys.pp, dek, dekAad('passphrase', salt)).toString('base64url'),
      },
    ],
    keyringSnapshot: {
      generations: [
        {
          gen: 1,
          slots: [
            {
              id: 'mk1',
              kind: 'master',
              wrap: {
                alg: 'A256GCM',
                sealed: wrap(
                  keys.mk,
                  keyOf(0x5a),
                  AAD.keyringSlot(INSTANCE, 1, 'mk1', 'master'),
                ).toString('base64url'),
              },
            },
            {
              id: 'rk1',
              kind: 'recovery',
              kdf: { alg: 'hkdf-sha256', info: keyInfo('recovery-slot') },
              wrap: {
                alg: 'A256GCM',
                sealed: wrap(
                  keys.rk,
                  keyOf(0x5a),
                  AAD.keyringSlot(INSTANCE, 1, 'rk1', 'recovery'),
                ).toString('base64url'),
              },
            },
          ],
        },
      ],
      static: {
        blobId: {
          gen: 1,
          wrap: {
            alg: 'A256GCM',
            sealed: wrap(
              keyOf(0x5a),
              keyOf(0xb1),
              AAD.keyringSlot(INSTANCE, 1, 'blobid', 'master'),
            ).toString('base64url'),
          },
        },
      },
    },
  };
}

/** A tar-shaped payload. Not zeros: a framing bug would be invisible against a uniform buffer. */
function payloadOf(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = (index * 37 + 11) % 251;
  return bytes;
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes;
}

async function* inPieces(bytes: Uint8Array, pieceSize: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += pieceSize) {
    yield bytes.subarray(offset, offset + pieceSize);
  }
}

interface Sealed {
  readonly file: Buffer;
  readonly header: BackupHeader;
  readonly dek: Buffer;
  readonly keys: { mk: Buffer; rk: Buffer; pp: Buffer };
}

async function seal(payload: Uint8Array): Promise<Sealed> {
  await wrappersSecretStream.ready();
  const dek = Buffer.from(wrappersSecretStream.keygen());
  const keys = { mk: keyOf(0x11), rk: keyOf(0x22), pp: keyOf(0x33) };
  const header = headerFor(dek, keys);
  const pieces: Uint8Array[] = [];
  await sealBackup({
    stream: wrappersSecretStream,
    dek,
    header,
    source: once(payload),
    write: (piece) => {
      pieces.push(Buffer.from(piece));
    },
  });
  return { file: Buffer.concat(pieces), header, dek, keys };
}

async function open(
  file: Uint8Array,
  dek: Uint8Array,
  header = readBackupHead(file)?.header,
): Promise<Buffer> {
  if (header === undefined) throw new Error('the fixture produced an unreadable head');
  const out: Uint8Array[] = [];
  for await (const piece of openBackup({
    stream: wrappersSecretStream,
    dek,
    header,
    source: once(file),
  })) {
    out.push(piece);
  }
  return Buffer.concat(out);
}

/** Compare by bytes: Vitest's deep equality walks a Buffer element by element (`M1-T25`). */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
  if (Buffer.compare(Buffer.from(actual), Buffer.from(expected)) === 0) return;
  expect(actual.length, `${label}: length`).toBe(expected.length);
  const at = [...expected].findIndex((byte, index) => actual[index] !== byte);
  expect.fail(`${label}: first difference at byte ${String(at)}`);
}

/** Unwrap the DEK from a slot the way a restore would. */
function dekFromSlot(
  header: BackupHeader,
  kind: BackupHeader['slots'][number]['kind'],
  key: Buffer,
): Buffer {
  const slot = header.slots.find((candidate) => candidate.kind === kind);
  if (slot === undefined) throw new Error(`no ${kind} slot`);
  const ref =
    slot.kind === 'backup-kek'
      ? String(slot.gen)
      : slot.kind === 'recovery'
        ? slot.rkId
        : slot.kdf.salt;
  const aad = AAD.backupDek(header.instanceId, header.createdAt, kind, ref);
  // `unwrap` through the same primitive the keyring uses, so the AAD discipline is the same one.
  return unwrap(key, Buffer.from(slot.sealed, 'base64url'), aad);
}

/**
 * A head with a stand-in secretstream header appended.
 *
 * `readBackupHead` answers `undefined` — "keep reading" — until the prefix, the JSON **and** the
 * 24-byte secretstream header have all arrived, which is correct: a short read during a copy is
 * not corruption. It also means a test that hands it a bare `backupHead(...)` gets `undefined`
 * rather than the refusal it is checking for, and passes against a reader that validates nothing.
 * Two of the cases below were written that way before this helper existed.
 */
function completeHead(bytes: Buffer): Buffer {
  return Buffer.concat([bytes, Buffer.alloc(24, 0xa5)]);
}

describe('the VBK1 head (08 §3.7.11)', () => {
  it('is magic, a big-endian length and canonical JSON', async () => {
    const { file, header } = await seal(payloadOf(10));
    expect(file.subarray(0, 4).toString('ascii')).toBe(BACKUP_MAGIC);
    const declared = file.readUInt32BE(4);
    const json = file
      .subarray(BACKUP_PREFIX_BYTES, BACKUP_PREFIX_BYTES + declared)
      .toString('utf8');
    expect(JSON.parse(json)).toEqual(header);
    // Canonical, so two writers of the same header produce the same bytes — which is what makes
    // the chunk-0 AD reproducible at all.
    expect(json).toBe(backupHead(header).subarray(BACKUP_PREFIX_BYTES).toString('utf8'));
  });

  it('refuses a file that is not an archive, and asks for more when it is short', () => {
    const good = completeHead(
      backupHead(headerFor(keyOf(1), { mk: keyOf(1), rk: keyOf(2), pp: keyOf(3) })),
    );
    // A short read during a copy is not corruption: `undefined` means keep reading, and the two
    // answers must not be confused.
    expect(readBackupHead(good.subarray(0, 4))).toBeUndefined();
    expect(readBackupHead(good.subarray(0, good.length - 1))).toBeUndefined();
    expect(readBackupHead(good)).toBeDefined();

    const wrongMagic = Buffer.from(good);
    wrongMagic.write('XXXX', 0, 'ascii');
    expect(() => readBackupHead(wrongMagic)).toThrow(/does not start with VBK1/);
  });

  it('refuses a declared header length it will not allocate for', () => {
    const good = completeHead(
      backupHead(headerFor(keyOf(1), { mk: keyOf(1), rk: keyOf(2), pp: keyOf(3) })),
    );
    const huge = Buffer.from(good);
    huge.writeUInt32BE(0xffff_ffff, 4);
    // Checked **before** slicing. Four corrupt bytes can ask for 4 GiB, and a reader that trusted
    // them would be a denial of service against its own host.
    expect(() => readBackupHead(huge)).toThrow(/declares a 4294967295-byte header/);

    const zero = Buffer.from(good);
    zero.writeUInt32BE(0, 4);
    expect(() => readBackupHead(zero)).toThrow(/declares a 0-byte header/);
    expect(BACKUP_HEADER_MAX_BYTES).toBe(65_536);
  });

  it('refuses a header that is not JSON, and one that is the wrong shape', () => {
    const header = headerFor(keyOf(1), { mk: keyOf(1), rk: keyOf(2), pp: keyOf(3) });
    const good = completeHead(backupHead(header));
    const broken = Buffer.from(good);
    broken.write('{{{{', BACKUP_PREFIX_BYTES, 'ascii');
    expect(() => readBackupHead(broken)).toThrow(/not JSON/);

    // A header that *is* JSON and is the wrong shape: no slots at all, which is an archive nobody
    // can open. The 24 trailing bytes stand in for the secretstream header — without them
    // `readBackupHead` answers "keep reading" rather than parsing, and this case would pass
    // against a reader that never validated anything. That is how the first version of it did.
    const json = Buffer.from(JSON.stringify({ ...header, slots: [] }));
    const prefix = Buffer.alloc(BACKUP_PREFIX_BYTES);
    prefix.write(BACKUP_MAGIC, 0, 'ascii');
    prefix.writeUInt32BE(json.length, 4);
    const emptied = completeHead(Buffer.concat([prefix, json]));
    expect(() => readBackupHead(emptied)).toThrow(/not a valid backup header/);
    // One byte short of the secretstream header is "keep reading", not a refusal.
    expect(readBackupHead(emptied.subarray(0, emptied.length - 1))).toBeUndefined();
  });
});

describe('backup.roundtrip — the envelope half (02 §9.3)', () => {
  const sizes = [0, 1, 65_535, 65_536, 65_537, 3 * 65_536];
  for (const size of sizes) {
    it(`seals and opens ${String(size)} bytes`, async () => {
      const payload = payloadOf(size);
      const { file, dek } = await seal(payload);
      expectSameBytes(await open(file, dek), payload, `${String(size)} bytes`);
    });
  }

  it('opens from an arbitrary read pattern, including one byte at a time', async () => {
    const payload = payloadOf(65_536 + 11);
    const { file, dek, header } = await seal(payload);
    for (const pieceSize of [1, 13, 1 << 20]) {
      const out: Uint8Array[] = [];
      for await (const piece of openBackup({
        stream: wrappersSecretStream,
        dek,
        header,
        source: inPieces(file, pieceSize),
      })) {
        out.push(piece);
      }
      expectSameBytes(Buffer.concat(out), payload, `reads of ${String(pieceSize)}`);
    }
  });
});

describe('the three unlock routes (01 §14 A10)', () => {
  it('recovers the same DEK from the master, recovery and passphrase slots', async () => {
    const { header, dek, keys } = await seal(payloadOf(100));
    // One DEK, three keys, three slots. The guarantee A10 makes is that the *recovery* one is
    // enough on its own, and the only way to show that is to use it on its own.
    expectSameBytes(dekFromSlot(header, 'backup-kek', keys.mk), dek, 'master slot');
    expectSameBytes(dekFromSlot(header, 'recovery', keys.rk), dek, 'recovery slot');
    expectSameBytes(dekFromSlot(header, 'passphrase', keys.pp), dek, 'passphrase slot');
  });

  it('opens the body with nothing but the printed recovery key and the file', async () => {
    const payload = payloadOf(70_000);
    const { file, keys } = await seal(payload);
    // Deliberately **no** reference to the sealing DEK or to the master key: this is the fresh-host
    // restore, where `keyring.json` does not exist and the only input is a printed string.
    const head = readBackupHead(file);
    expect(head).toBeDefined();
    const recovered = dekFromSlot(head!.header, 'recovery', keys.rk);
    expectSameBytes(await open(file, recovered), payload, 'recovery-key-only restore');
  });

  it('recovers the root data key, and through it the blob-id key, from the snapshot', async () => {
    const { file, keys } = await seal(payloadOf(10));
    const header = readBackupHead(file)?.header;
    expect(header).toBeDefined();
    // The recovery slot of the snapshot, with the keyring's own AAD — the same bytes and the same
    // binding as `keyring.json`, which is what lets a restore reuse `openSlot` unchanged.
    const generation = header!.keyringSnapshot.generations[0]!;
    const slot = generation.slots.find((candidate) => candidate.kind === 'recovery')!;
    const rootDataKey = unwrap(
      keys.rk,
      Buffer.from(slot.wrap.sealed, 'base64url'),
      AAD.keyringSlot(INSTANCE, generation.gen, slot.id, slot.kind),
    );
    // And `static.blobId` is wrapped by that root key. Without it a restore could not recompute
    // `HMAC(K_blobid, …)`, so every blob address would change and every attachment would be
    // unreachable from its row — which is why `08` §3.7.11 makes it required.
    const blobIdKey = unwrap(
      rootDataKey,
      Buffer.from(header!.keyringSnapshot.static.blobId.wrap.sealed, 'base64url'),
      AAD.keyringSlot(INSTANCE, header!.keyringSnapshot.static.blobId.gen, 'blobid', 'master'),
    );
    expect(blobIdKey).toHaveLength(32);
    expectSameBytes(blobIdKey, keyOf(0xb1), 'the blob-id key');
  });

  it('refuses a slot opened with the wrong key', async () => {
    const { header } = await seal(payloadOf(10));
    expect(() => dekFromSlot(header, 'recovery', keyOf(0x99))).toThrow();
  });
});

describe('backup.tamper (02 §9.3)', () => {
  it('refuses a flipped byte in every region, and names the mechanism', async () => {
    const payload = payloadOf(2 * 65_536 + 5);
    const { file, dek, header } = await seal(payload);
    const headLen = BACKUP_PREFIX_BYTES + file.readUInt32BE(4);

    // Each region is caught by a different mechanism, and the suite is only meaningful if each is
    // exercised separately: the magic by an explicit check, the header JSON by the chunk-0
    // additional data, the secretstream header by `initPull`, and a chunk by its own tag.
    const regions = {
      magic: 1,
      'declared length': 6,
      'header json': BACKUP_PREFIX_BYTES + 3,
      'secretstream header': headLen + 3,
      'chunk 0': headLen + 24 + 10,
      'middle chunk': headLen + 24 + 65_553 + 10,
      'last chunk': file.length - 3,
    };
    for (const [region, offset] of Object.entries(regions)) {
      const damaged = Buffer.from(file);
      damaged[offset] = (damaged[offset] ?? 0) ^ 0xff;
      // The header read may throw, or the body may fail: both are refusals, and which one it is
      // depends on the region — the point is that no edit is accepted.
      await expect(
        (async () => {
          const head = readBackupHead(damaged);
          return open(damaged, dek, head?.header);
        })(),
        region,
      ).rejects.toThrow();
    }
    // And the untouched file still opens, so the loop above is not passing because of the fixture.
    expectSameBytes(await open(file, dek, header), payload, 'untouched');
  });

  it('detects a header edit through the chunk-0 additional data, not just the parse', async () => {
    const payload = payloadOf(100);
    const { file, dek, header } = await seal(payload);
    // A **valid** header with a different `createdAt`: it parses, and the body still refuses it,
    // because the AD is the SHA-256 of the immutable core. This is the case a parse check alone
    // would miss, and the reason the core is bound at all.
    const moved = backupHead({ ...header, createdAt: '2020-01-01T00:00:00Z' });
    const spliced = Buffer.concat([
      moved,
      file.subarray(BACKUP_PREFIX_BYTES + file.readUInt32BE(4)),
    ]);
    await expect(open(spliced, dek)).rejects.toThrow();
  });

  it('detects truncation, which is what TAG_FINAL is for', async () => {
    const payload = payloadOf(2 * 65_536);
    const { file, dek, header } = await seal(payload);
    const headLen = BACKUP_PREFIX_BYTES + file.readUInt32BE(4) + 24;

    // Cut at a chunk boundary, so every byte present is authentic and the only thing wrong is that
    // the stream never ended. Nothing but the final tag catches this.
    await expect(open(file.subarray(0, headLen + 65_553), dek, header)).rejects.toThrow(
      /without a final chunk/,
    );
    await expect(open(file.subarray(0, 6), dek, header)).rejects.toThrow(
      /shorter than a backup header/,
    );
    // And appending is refused too: a prefix that authenticates is not a file that does.
    await expect(open(Buffer.concat([file, Buffer.alloc(32, 7)]), dek, header)).rejects.toThrow(
      /after the final chunk/,
    );
  });
});

describe('rewrapBackupHeader (08 §3.7.11)', () => {
  it('replaces the slots and leaves the body openable', async () => {
    const payload = payloadOf(70_000);
    const { file, dek, header } = await seal(payload);
    const rotated = keyOf(0x44);
    const dekAad = (kind: string, ref: string) =>
      AAD.backupDek(header.instanceId, header.createdAt, kind, ref);

    // A recovery-key rotation: a new `rk2` slot replaces `rk1`, and the archive's 5 GB body is not
    // touched. That affordability is the whole reason a rewrap exists — fourteen daily archives of
    // a large instance would otherwise be hours of re-encryption and 70 GB of free space.
    const next = rewrapBackupHeader(header, {
      slots: [
        header.slots[0]!,
        {
          kind: 'recovery',
          rkId: 'rk2',
          sealed: wrap(rotated, dek, dekAad('recovery', 'rk2')).toString('base64url'),
        },
      ],
      keyringSnapshot: header.keyringSnapshot,
    });
    const rewritten = Buffer.concat([
      backupHead(next),
      file.subarray(BACKUP_PREFIX_BYTES + file.readUInt32BE(4)),
    ]);

    // The body opens with the DEK recovered through the **new** slot, which is the claim.
    const recovered = dekFromSlot(readBackupHead(rewritten)!.header, 'recovery', rotated);
    expectSameBytes(await open(rewritten, recovered), payload, 'after the rewrap');
    // And the old key no longer opens anything, which is what a rotation is for.
    expect(() => dekFromSlot(readBackupHead(rewritten)!.header, 'recovery', keyOf(0x22))).toThrow();
  });

  it('keeps the core byte-identical, so the body stays bound', async () => {
    const { header } = await seal(payloadOf(10));
    const next = rewrapBackupHeader(header, {
      slots: [header.slots[1]!],
      keyringSnapshot: header.keyringSnapshot,
    });
    // The body's AD is the SHA-256 of the core, so a rewrap that changed any of `{format,
    // instanceId, createdAt, dataGen, body}` would produce a file that reads as corrupt — and
    // would only fail when somebody needed it.
    expectSameBytes(backupCoreBytes(next), backupCoreBytes(header), 'the core');
    expectSameBytes(backupAdditionalData(next), backupAdditionalData(header), 'the AD');
    expect(backupAdditionalData(header)).toHaveLength(32);
    expectSameBytes(backupAdditionalData(header), sha256(backupCoreBytes(header)), 'sha256(core)');
  });

  it('refuses a rewrap with no slots at all', async () => {
    const { header } = await seal(payloadOf(10));
    // An archive with no slots is an archive nobody can open. `removeSlot` refuses the last
    // recovery slot of a keyring for the same reason (`M1-T5`): a command that destroys a host's
    // data while reporting success is the most expensive kind of helpful.
    expect(() =>
      rewrapBackupHeader(header, { slots: [], keyringSnapshot: header.keyringSnapshot }),
    ).toThrow(/cannot be opened/);
  });
});

describe('the header size bound', () => {
  it('refuses to write a header larger than a reader will accept', async () => {
    const { header } = await seal(payloadOf(10));
    // A keyring with hundreds of generations. The write-side bound and the read-side bound are the
    // same number on purpose: a writer that could produce a file no reader accepts would create
    // archives that are silently useless.
    const generation = header.keyringSnapshot.generations[0]!;
    const many = Array.from({ length: 2000 }, (_, index) => ({
      ...generation,
      gen: index + 1,
    }));
    expect(() =>
      backupHead({
        ...header,
        keyringSnapshot: { ...header.keyringSnapshot, generations: many },
      }),
    ).toThrow(/too large to write/);
  });

  it('accepts a realistic keyring with room to spare', async () => {
    const { header } = await seal(payloadOf(10));
    const generation = header.keyringSnapshot.generations[0]!;
    // Twenty generations is two decades of annual rotation, and the AC for `purge-retired` keeps
    // it below that in practice.
    const twenty = Array.from({ length: 20 }, (_, index) => ({ ...generation, gen: index + 1 }));
    const head = backupHead({
      ...header,
      keyringSnapshot: { ...header.keyringSnapshot, generations: twenty },
    });
    expect(head.length).toBeLessThan(BACKUP_HEADER_MAX_BYTES / 2);
    expect(randomBytes(1)).toHaveLength(1);
  });
});
