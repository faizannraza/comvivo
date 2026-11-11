/**
 * The `VBK1` backup envelope (`08` §3.7.11; the inner archive is `02` §3.14's).
 *
 * ```
 * "VBK1" | u32 BE headerLen | header (canonical JSON, plaintext) | secretstream header | chunks
 * ```
 *
 * The header is **plaintext on purpose**: it holds the wrapped per-backup DEK in one slot per
 * unlock route, so a host restoring with a recovery key on a fresh machine can read which routes
 * exist before decrypting anything. Nothing in it is secret — every value is either public
 * metadata or an AEAD wrap whose key the reader must already have.
 *
 * ## The guarantee that shapes everything here
 *
 * `01` §14 A10: **a restore with the printed recovery key alone must work.** That is why the DEK is
 * wrapped three ways rather than once, and why `keyringSnapshot` travels inside the header: the
 * recovery key unwraps the DEK (body), and separately unwraps `RDK_g` from the snapshot, from which
 * `db_key`, `blob_kek_g` and `K_blobid` all derive. A backup that needed `keyring.json` to be
 * restorable would be a backup that dies with the host.
 *
 * ## The chunk-0 AD is the header's immutable core, not the whole header
 *
 * `08` §3.7.11 says `first-chunk AD = SHA-256(header bytes)` and, three lines later, that
 * `village backup rewrap` "rewrites only the header". **Both cannot hold**: a rewrap replaces the
 * slots — that is what it is for, after a recovery-key rotation — so an AD over the whole header
 * would make every rewrapped archive undecryptable. Found at `M1-T27`; both specs amended.
 *
 * So the AD is the SHA-256 of the canonical JSON of `{format, instanceId, createdAt, dataGen,
 * body}` — everything a rewrap must not touch. Nothing is lost by excluding the rest:
 *
 *  - every **slot** is an AES-256-GCM wrap of the DEK under a key the attacker does not have, so a
 *    slot swapped in from another archive yields a different DEK and the body then fails its own
 *    authentication;
 *  - every **`keyringSnapshot`** wrap is likewise authenticated, with `AAD.keyringSlot` binding the
 *    instance, the generation, the slot id and the kind — the same AAD `keyring.json` uses, which
 *    is what lets a restore reuse `openSlot` unchanged;
 *  - and the core still binds the body to *this* archive, so a body cannot be moved between two
 *    archives of the same instance.
 *
 * What an attacker can do is edit the plaintext `createdAt` of an archive they cannot decrypt, and
 * thereby make it fail to decrypt. That is not an attack; it is vandalism of a file they already
 * have write access to.
 */
import { BRAND, type CanonicalValue, canonicalJsonBytes, StorageError, z } from '@comvivo/shared';
import {
  BACKUP_FORMAT,
  HEADER_BYTES,
  MAGIC,
  type SecretStream,
  sha256,
} from '@comvivo/shared/crypto';
import { openFramed, sealFramed } from './stream-format.js';

/** `VBK1`. Four bytes, and frozen (`08` §3.7.11). */
export const BACKUP_MAGIC = MAGIC.backup;

/** The magic plus the `u32` big-endian header length. */
export const BACKUP_PREFIX_BYTES = 8;

/**
 * The most a header may occupy.
 *
 * A header is the slots plus a keyring snapshot: three wraps of 80 base64url characters each, and
 * one generation of two slots per rotation. Sixty-four kibibytes is room for roughly four hundred
 * generations, and a bound is what stops a corrupt `headerLen` from making the reader allocate
 * whatever a four-byte integer can say — which is 4 GiB.
 */
export const BACKUP_HEADER_MAX_BYTES = 64 * 1024;

/** A base64url-encoded value. `Buffer.from(s, 'base64url')` never throws, so this is the check. */
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'expected unpadded base64url');

/** `nonce ‖ ciphertext ‖ tag` for a 32-byte key: 60 bytes, exactly 80 base64url characters. */
const sealedDek = base64url.length(80, 'a wrapped 32-byte key is 80 base64url characters');

/** The DEK wrapped under `backup_kek` of a generation (`02` §3.6.1). */
const backupKekSlotSchema = z.object({
  kind: z.literal('backup-kek'),
  gen: z.number().int().positive(),
  sealed: sealedDek,
});

/** The DEK wrapped under the printed recovery key's slot key (`08` §3.7.6). */
const recoverySlotSchema = z.object({
  kind: z.literal('recovery'),
  /** Which recovery key this is, so a rotated key says so rather than failing silently. */
  rkId: z.string().regex(/^[a-z][a-z0-9]{0,15}$/, 'a slot id is 1–16 lowercase alphanumerics'),
  sealed: sealedDek,
});

/** The DEK wrapped under a scrypt-stretched passphrase. Optional (`backups.passphraseSlot`). */
const passphraseSlotSchema = z.object({
  kind: z.literal('passphrase'),
  kdf: z.object({
    alg: z.literal('scrypt'),
    N: z.number().int().positive(),
    r: z.number().int().positive(),
    p: z.number().int().positive(),
    salt: base64url,
  }),
  sealed: sealedDek,
});

export const BackupSlotSchema = z.discriminatedUnion('kind', [
  backupKekSlotSchema,
  recoverySlotSchema,
  passphraseSlotSchema,
]);

export type BackupSlot = z.infer<typeof BackupSlotSchema>;

/**
 * The keyring, as it travels inside a backup.
 *
 * Deliberately **not** the `Keyring` type: a keyring also holds `wrapCount` and a `current`
 * pointer, which are live host state rather than facts about this archive, and a passphrase slot,
 * which `08` §3.7.11 excludes ("RDK_g wrapped by MK and RK **only**") because a host's chosen
 * passphrase is not something a backup should carry off-site. The shape is the subset a restore
 * needs, and the wraps are byte-identical to the keyring's so `openSlot` reads them unchanged.
 */
export const KeyringSnapshotSchema = z.object({
  generations: z
    .array(
      z.object({
        gen: z.number().int().positive(),
        slots: z
          .array(
            z.object({
              id: z.string().regex(/^[a-z][a-z0-9]{0,15}$/),
              kind: z.enum(['master', 'recovery']),
              kdf: z.object({ alg: z.literal('hkdf-sha256'), info: z.string().min(1) }).optional(),
              wrap: z.object({ alg: z.literal('A256GCM'), sealed: sealedDek }),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  /**
   * The blob-id key, wrapped by `RDK_g` (`08` §3.7.11, SD-06, `02` D14).
   *
   * **Required**, and the acceptance criterion says so: without it a restore cannot recompute
   * `HMAC(K_blobid, groupId ‖ 0 ‖ sha256)`, so every blob address would change and every
   * attachment would be unreachable from its row.
   */
  static: z.object({
    blobId: z.object({
      gen: z.number().int().positive(),
      wrap: z.object({ alg: z.literal('A256GCM'), sealed: sealedDek }),
    }),
  }),
});

export type KeyringSnapshot = z.infer<typeof KeyringSnapshotSchema>;

/**
 * The parts of the header a rewrap must not touch, and which the body's AD covers.
 *
 * Separate from the rest of the schema so the AD computation cannot drift from the definition: it
 * is `canonicalJson` of exactly this object, built from the header's own fields.
 */
export const BackupCoreSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  instanceId: z.string().min(1),
  /** RFC 3339 with an offset, so two archives of one instance never share a core. */
  createdAt: z.string().min(1),
  /** The keyring generation the instance was writing under (`08` §3.7.7). */
  dataGen: z.number().int().positive(),
  body: z.object({ chunkSize: z.literal(65_536) }),
});

export type BackupCore = z.infer<typeof BackupCoreSchema>;

export const BackupHeaderSchema = BackupCoreSchema.extend({
  slots: z.array(BackupSlotSchema).min(1, 'an archive with no slots cannot be opened'),
  keyringSnapshot: KeyringSnapshotSchema,
});

export type BackupHeader = z.infer<typeof BackupHeaderSchema>;

/** `BACKUP_INTEGRITY`: the bytes are not a valid archive. Never "the key is wrong". */
function integrity(message: string, hint: string): StorageError {
  return new StorageError('BACKUP_INTEGRITY', message, { hint, category: 'io.failed' });
}

/**
 * The immutable core of a header, as canonical JSON bytes.
 *
 * Built by **naming each field** rather than by deleting `slots` and `keyringSnapshot`, so adding a
 * field to the header is a compile error here — the same reason `audit.ts`'s `hashedForm` is
 * written out field by field. A new field that quietly joined the AD would make every existing
 * archive undecryptable; one that quietly stayed out would be unbound, and a rewrap could change
 * it.
 */
export function backupCoreBytes(header: BackupCore): Buffer {
  const core: BackupCore = {
    format: header.format,
    instanceId: header.instanceId,
    createdAt: header.createdAt,
    dataGen: header.dataGen,
    body: { chunkSize: header.body.chunkSize },
  };
  return Buffer.from(canonicalJsonBytes(core));
}

/** The chunk-0 additional data: `SHA-256` of the immutable core (`08` §3.7.11 as amended). */
export function backupAdditionalData(header: BackupCore): Buffer {
  return sha256(backupCoreBytes(header));
}

/** Magic ‖ u32 BE length ‖ canonical JSON. Exported so a test can assert the layout. */
export function backupHead(header: BackupHeader): Buffer {
  // `as CanonicalValue` because `CanonicalValue`'s index signature cannot be satisfied by a precise
  // interface with an optional field — the same boundary cast `audit.ts`'s `hashedForm` makes, and
  // safe for the same reason: the value has been through `parse`, so it is JSON-shaped, and
  // `canonicalJson` refuses an `undefined` loudly with its path rather than hashing around it.
  const parsed = BackupHeaderSchema.parse(header) as unknown as CanonicalValue;
  const json = Buffer.from(canonicalJsonBytes(parsed));
  if (json.length > BACKUP_HEADER_MAX_BYTES) {
    throw new StorageError('BACKUP_INTEGRITY', 'that backup header is too large to write', {
      hint:
        `A header is capped at ${String(BACKUP_HEADER_MAX_BYTES)} bytes. A keyring with hundreds ` +
        `of generations needs \`${BRAND.cliName} keys purge-retired\` first.`,
      category: 'validation.failed',
      detail: { bytes: json.length },
    });
  }
  const prefix = Buffer.alloc(BACKUP_PREFIX_BYTES);
  prefix.write(BACKUP_MAGIC, 0, 'ascii');
  prefix.writeUInt32BE(json.length, 4);
  return Buffer.concat([prefix, json]);
}

export interface ReadBackupHead {
  readonly header: BackupHeader;
  /** How many bytes the prefix, the header and the secretstream header occupy together. */
  readonly consumed: number;
  readonly streamHeader: Uint8Array;
}

/**
 * Parse the head of an archive, or report that more bytes are needed.
 *
 * Returns `undefined` for "keep reading" and throws for "this is not an archive", which are
 * different answers and must not be confused: a short read during a copy is not corruption, and a
 * wrong magic is not a key problem. `M1-T25` found the same distinction mattering for blobs, where
 * a wrong magic, an unsupported version and a set reserved byte are three separate messages.
 */
export function readBackupHead(bytes: Uint8Array): ReadBackupHead | undefined {
  if (bytes.length < BACKUP_PREFIX_BYTES) return undefined;
  const prefix = Buffer.from(bytes.subarray(0, BACKUP_PREFIX_BYTES));
  const magic = prefix.subarray(0, 4).toString('ascii');
  if (magic !== BACKUP_MAGIC) {
    throw integrity(
      `that file does not start with ${BACKUP_MAGIC}`,
      `This is not a ${BRAND.displayName} backup. Check the path, or whether the file was ` +
        'truncated to zero by a failed copy.',
    );
  }
  const headerLen = prefix.readUInt32BE(4);
  if (headerLen === 0 || headerLen > BACKUP_HEADER_MAX_BYTES) {
    // Checked **before** allocating or slicing: a corrupt length is four bytes that can ask for
    // 4 GiB, and a reader that trusted it would be a denial of service against its own host.
    throw integrity(
      `that archive declares a ${String(headerLen)}-byte header`,
      `A header is 1 to ${String(BACKUP_HEADER_MAX_BYTES)} bytes. The file is damaged; restore another archive.`,
    );
  }
  const total = BACKUP_PREFIX_BYTES + headerLen + HEADER_BYTES;
  if (bytes.length < total) return undefined;

  const json = Buffer.from(bytes.subarray(BACKUP_PREFIX_BYTES, BACKUP_PREFIX_BYTES + headerLen));
  const parsed = BackupHeaderSchema.safeParse(parseJson(json));
  if (!parsed.success) {
    throw integrity(
      'that archive header is not a valid backup header',
      `The file is damaged or was written by a newer version. ${parsed.error.issues[0]?.message ?? ''}`.trim(),
    );
  }
  return {
    header: parsed.data,
    consumed: total,
    streamHeader: bytes.subarray(BACKUP_PREFIX_BYTES + headerLen, total),
  };
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw integrity(
      'that archive header is not JSON',
      'The file is damaged. Restore another archive, or check whether a text-mode copy corrupted it.',
    );
  }
}

export interface SealBackupOptions {
  readonly stream: SecretStream;
  /** The per-backup DEK. Random per archive, and wrapped into every slot of the header. */
  readonly dek: Uint8Array;
  readonly header: BackupHeader;
  readonly source: AsyncIterable<Uint8Array>;
  readonly write: (piece: Uint8Array) => void | Promise<void>;
  /** Fed every plaintext byte, so the caller gets the tar's digest without a second pass. */
  readonly hash?: { update(data: Uint8Array): void } | undefined;
}

/**
 * Seal a tar stream into a `VBK1` archive.
 *
 * No size limit, unlike a blob: a backup is as large as the database, and refusing to back up a
 * large instance is the opposite of what this is for. The streaming is what makes that safe — a
 * 5 GB archive costs 64 KiB of memory.
 */
export async function sealBackup(
  options: SealBackupOptions,
): Promise<{ readonly sizeBytes: number }> {
  return sealFramed({
    stream: options.stream,
    dek: options.dek,
    head: backupHead(options.header),
    additionalData: backupAdditionalData(options.header),
    source: options.source,
    write: options.write,
    hash: options.hash,
  });
}

export interface OpenBackupOptions {
  readonly stream: SecretStream;
  readonly dek: Uint8Array;
  /** The header read from the same file, so the AD is the one the writer used. */
  readonly header: BackupCore;
  readonly source: AsyncIterable<Uint8Array>;
}

/**
 * Open a `VBK1` archive, yielding plaintext chunks of the tar stream.
 *
 * The caller must treat the content as unconfirmed until the iterator **completes**: a missing
 * `TAG_FINAL` is only detectable at the end, which is the whole point of having one. `02` §3.14.4
 * step 3 is written that way — it streams into `data/.restore-<ts>/` and deletes the directory on
 * failure, rather than swapping anything in before the last chunk has authenticated.
 */
export async function* openBackup(options: OpenBackupOptions): AsyncGenerator<Uint8Array> {
  yield* openFramed({
    stream: options.stream,
    dek: options.dek,
    additionalData: backupAdditionalData(options.header),
    source: options.source,
    maxHeadBytes: BACKUP_PREFIX_BYTES + BACKUP_HEADER_MAX_BYTES,
    formatName: 'backup',
    readHead: (pending) => {
      const head = readBackupHead(pending);
      return head === undefined
        ? undefined
        : { consumed: head.consumed, streamHeader: head.streamHeader };
    },
    integrity,
  });
}

/**
 * Replace an archive's slots and keyring snapshot, keeping its body (`08` §3.7.11's `rewrap`).
 *
 * This is what makes a recovery-key rotation affordable: fourteen daily archives of a 5 GB instance
 * is 70 GB, and re-encrypting them would take hours and need 70 GB of free space. A rewrap writes a
 * few kilobytes per file.
 *
 * It refuses to change the core, and the refusal is the point — the body's AD covers the core, so a
 * rewrap that altered `createdAt` or `dataGen` would produce a file that reads as corrupt. Better a
 * loud error here than an archive that only fails when someone needs it.
 */
export function rewrapBackupHeader(
  previous: BackupHeader,
  next: Pick<BackupHeader, 'slots' | 'keyringSnapshot'>,
): BackupHeader {
  const rewrapped: BackupHeader = {
    format: previous.format,
    instanceId: previous.instanceId,
    createdAt: previous.createdAt,
    dataGen: previous.dataGen,
    body: previous.body,
    slots: next.slots,
    keyringSnapshot: next.keyringSnapshot,
  };
  const parsed = BackupHeaderSchema.parse(rewrapped);
  if (!backupCoreBytes(parsed).equals(backupCoreBytes(previous))) {
    // Unreachable through the fields above, which copy the core verbatim — and asserted anyway,
    // because the one way to break every archive on a host is to let a rewrap touch the AD.
    throw new StorageError('BACKUP_INTEGRITY', 'a rewrap may not change the header core', {
      hint: 'The body is bound to `{format, instanceId, createdAt, dataGen, body}`. Write a new archive instead.',
      category: 'bug',
    });
  }
  return parsed;
}
