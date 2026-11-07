/**
 * `@comvivo/storage/crypto` — key **policy**, over the primitives in `@comvivo/shared/crypto`.
 *
 * The split is the one `08` PSC-8 allows and `08` §3.7.1 implies:
 *
 *  - `shared/crypto` holds the **primitives**: the CSPRNG, HKDF, AES-256-GCM wrapping, HMAC,
 *    constant-time comparison, scrypt, secretstream, zeroing, and the frozen domain separators.
 *    Nothing there knows what a keyring is.
 *  - this directory holds the **policy**: what the key tree looks like, which slots exist, what
 *    order unlock sources are tried in, how the keyring file is written safely, and when a key is
 *    zeroed.
 *
 * Why the primitives are not here too: `shared` is the bottom of the dependency graph, and
 * `08` §3.7.12's token formats and the magic-link MAC are needed by `apps/server` and `apps/cli`.
 * Those must not import `storage` to get an HMAC. (`02` M1-T4's file list said
 * `storage/src/crypto`; the deviation is logged in STATUS → Plan changes.)
 *
 * Arriving later, on top of this: the blob cipher (`M1-T25`) and the `VBK1` envelope (`M1-T27`).
 * The `comvivo keys` command surface itself is `09` §3.11.3, wired in `M3-T13` — `key-ops.ts` is
 * the library it calls, so the dangerous operations are testable without a terminal.
 */

export {
  addPassphrase,
  type GenerationStatusReport,
  type KeyStatus,
  type PurgeRetiredResult,
  purgeRetired,
  RECOVERY_NUDGE_DAYS,
  type RecoverResult,
  ROTATION_PHASES,
  type RotateDataPorts,
  type RotateDataResult,
  type RotateMasterResult,
  type RotateRecoveryResult,
  type RotateSessionsResult,
  type RotationJournal,
  type RotationPhase,
  recover,
  removeKeySlot,
  rotateData,
  rotateMaster,
  rotateRecovery,
  rotateSessions,
  type SessionEpochStore,
  status,
  type VerifyRecoveryResult,
  verifyRecovery,
  WRAP_COUNT_ADVISORY,
} from './key-ops.js';
export {
  isZeroed,
  KeyService,
  type KeyServiceOptions,
  newBlobIdKey,
  newRootDataKey,
  type PurposeKey,
  passphraseSlotKey,
  type UnlockRecord,
  unlock,
  withZeroed,
} from './key-service.js';
export {
  DEFAULT_KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
  type Keychain,
  KeychainUnavailable,
  type KeyringLoader,
  loadKeyring,
  osKeychain,
  storeMasterKey,
} from './keychain.js';
export {
  currentGeneration,
  GENERATION_STATUSES,
  type GenerationStatus,
  generationFor,
  type Keyring,
  KeyringError,
  type KeyringErrorCode,
  type KeyringGeneration,
  type KeyringSlot,
  keyringSchema,
  nextSlotId,
  openSlot,
  parseKeyring,
  putSlot,
  removeSlot,
  SLOT_KINDS,
  type SlotKind,
  type StoredWrap,
  sealSlot,
  serialiseKeyring,
} from './keyring.js';
export {
  auditKeyPermissions,
  isGroupOrWorldReadable,
  isGroupOrWorldWritable,
  KEY_DIR_MODE,
  KEY_FILE_MODE,
  KEYRING_FILENAME,
  KEYRING_PREVIOUS_FILENAME,
  KEYRING_TEMP_FILENAME,
  KeyPermissionError,
  type KeyringIo,
  KeyringStore,
  nodeKeyringIo,
  type PermissionFinding,
} from './keyring-store.js';
export {
  BODY_CHARS,
  CHECKSUM_BITS,
  CHECKSUM_CHARS,
  decodeRecoveryKey,
  encodeRecoveryKey,
  GROUP_COUNT,
  GROUP_SIZE,
  newRecoveryKey,
  normaliseRecoveryKey,
  PAYLOAD_CHARS,
  RECOVERY_KEY_PREFIX,
  RETYPE_GROUPS,
  type RecoveryKeyError,
  type RecoveryKeyErrorCode,
  type RecoveryKeyResult,
  recoveryKeyChecksum,
  recoveryKeyGroups,
  recoverySlotKey,
  retypedGroupMatches,
} from './recovery-key.js';
export {
  decodeMasterKey,
  disposeUnlock,
  isPassphraseRequired,
  MASTER_KEY_ENV,
  MASTER_KEY_FILE_ENV,
  nodeUnlockIo,
  PASSPHRASE_FILE_ENV,
  type PassphraseRequired,
  type ResolvedUnlock,
  type ResolveOptions,
  readPassphraseFile,
  resolveUnlock,
  UNLOCK_SOURCES,
  UnlockError,
  type UnlockErrorCode,
  type UnlockIo,
  type UnlockOutcome,
  type UnlockSourceKind,
} from './unlock-sources.js';
