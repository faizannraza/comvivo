/**
 * Building a `VBK1` header for a test (`M1-T27`).
 *
 * The real builder is `08`'s, and it lives with the key tree: only a `KeyService` holds the
 * `backup_kek`, only the recovery ceremony holds the printed key, and only the CLI prompts for a
 * passphrase. `M1-T27` builds the envelope and the pipeline; wiring them to those three is the
 * composition root's job at `M8-T25`.
 *
 * What this helper does is build the same header from **plain keys**, with the real `wrap` and the
 * real `AAD`. That is the honest substitute: a fixture that faked the wraps could not show that
 * three unrelated keys each recover one DEK, which is the whole point of the slot structure and the
 * whole of `01` §14 A10's guarantee.
 */
import { AAD, BACKUP_FORMAT, keyInfo, wrap } from '@comvivo/shared/crypto';
import type { BackupHeader, BackupSlot, KeyringSnapshot } from '../../crypto/backup-envelope.js';

export type { BackupHeader } from '../../crypto/backup-envelope.js';

/** Re-exported so a test does not have to reach past `crypto/` for the frozen literal. */
export const BACKUP_FORMAT_LITERAL = BACKUP_FORMAT;

/** The keys a host holds, in the four roles a backup header needs. */
export interface HeaderKeys {
  /** `RDK_g`: what `db_key`, `blob_kek_g` and `K_blobid` all derive from. */
  readonly rootDataKey: Buffer;
  /** Stands in for `backup_kek` — `02` §3.6.1 derives it from `RDK_g`, and a test need not. */
  readonly masterSlotKey: Buffer;
  /** `08` §3.7.6's recovery slot key, from the printed `VRK1-…` string. */
  readonly recoverySlotKey: Buffer;
  /** The scrypt-stretched passphrase. */
  readonly passphraseSlotKey: Buffer;
  readonly blobIdKey: Buffer;
}

/** The salt a passphrase slot declares. Fixed, so a failure is reproducible. */
const PASSPHRASE_SALT = Buffer.alloc(16, 0x7f).toString('base64url');

/** The three slots, each wrapping the **same** DEK under a different key (`08` §3.7.11). */
export function backupSlotsFor(options: {
  readonly instanceId: string;
  readonly createdAt: string;
  readonly dek: Uint8Array;
  readonly keys: HeaderKeys;
}): BackupSlot[] {
  const { instanceId, createdAt, dek, keys } = options;
  const aad = (kind: string, ref: string) => AAD.backupDek(instanceId, createdAt, kind, ref);
  return [
    {
      kind: 'backup-kek',
      gen: 1,
      sealed: wrap(keys.masterSlotKey, dek, aad('backup-kek', '1')).toString('base64url'),
    },
    {
      kind: 'recovery',
      rkId: 'rk1',
      sealed: wrap(keys.recoverySlotKey, dek, aad('recovery', 'rk1')).toString('base64url'),
    },
    {
      kind: 'passphrase',
      kdf: { alg: 'scrypt', N: 131_072, r: 8, p: 1, salt: PASSPHRASE_SALT },
      sealed: wrap(keys.passphraseSlotKey, dek, aad('passphrase', PASSPHRASE_SALT)).toString(
        'base64url',
      ),
    },
  ];
}

/**
 * The keyring snapshot: `RDK_g` wrapped by the master and recovery keys, plus the blob-id key.
 *
 * The wraps use `AAD.keyringSlot` — byte-identical to `keyring.json`'s, which is what lets a
 * restore reuse `openSlot` unchanged and what makes a snapshot a *copy* of the keyring rather than
 * a second format saying the same thing.
 */
export function keyringSnapshotFor(options: {
  readonly instanceId: string;
  readonly keys: HeaderKeys;
}): KeyringSnapshot {
  const { instanceId, keys } = options;
  const sealedBy = (slotKey: Buffer, id: string, kind: 'master' | 'recovery' | 'passphrase') => ({
    alg: 'A256GCM' as const,
    sealed: wrap(slotKey, keys.rootDataKey, AAD.keyringSlot(instanceId, 1, id, kind)).toString(
      'base64url',
    ),
  });
  return {
    generations: [
      {
        gen: 1,
        slots: [
          { id: 'mk1', kind: 'master', wrap: sealedBy(keys.masterSlotKey, 'mk1', 'master') },
          {
            id: 'rk1',
            kind: 'recovery',
            kdf: { alg: 'hkdf-sha256', info: keyInfo('recovery-slot') },
            wrap: sealedBy(keys.recoverySlotKey, 'rk1', 'recovery'),
          },
          // The passphrase slot, which `08` §3.7.11 excluded and `08` §3.7.4's own keyring has had
          // all along. Without it a passphrase opens the body and not the database, which is a
          // feature that does not work.
          {
            id: 'pp1',
            kind: 'passphrase',
            kdf: { alg: 'scrypt', N: 131_072, r: 8, p: 1, salt: PASSPHRASE_SALT },
            wrap: sealedBy(keys.passphraseSlotKey, 'pp1', 'passphrase'),
          },
        ],
      },
    ],
    static: {
      blobId: {
        gen: 1,
        // Wrapped by `RDK_g` itself, as `keyring.json` does — so a restore that recovers the root
        // key recovers the blob-id key with it, and every blob address stays stable (SD-06, D14).
        wrap: {
          alg: 'A256GCM',
          sealed: wrap(
            keys.rootDataKey,
            keys.blobIdKey,
            AAD.keyringSlot(instanceId, 1, 'blobid', 'master'),
          ).toString('base64url'),
        },
      },
    },
  };
}

/** A whole header, for a test that does not care about the parts. */
export function headerFor(options: {
  readonly instanceId: string;
  readonly createdAt: string;
  readonly dek: Uint8Array;
  readonly keys: HeaderKeys;
}): BackupHeader {
  return {
    format: BACKUP_FORMAT,
    instanceId: options.instanceId,
    createdAt: options.createdAt,
    dataGen: 1,
    body: { chunkSize: 65_536 },
    slots: backupSlotsFor(options),
    keyringSnapshot: keyringSnapshotFor(options),
  };
}
