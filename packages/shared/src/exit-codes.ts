/**
 * Process exit codes (`12` §4.2).
 *
 * An orchestrator reads the exit code and nothing else. systemd decides whether to restart from
 * `RestartPreventExitStatus`, Docker from its restart policy, and a host reading
 * `docker compose ps` sees a number. So the code is the only part of a fatal error that is
 * guaranteed to reach whoever has to act on it, and getting it wrong has a specific cost: a
 * configuration problem returned as a crash gets restarted in a loop, and a transient lock
 * returned as a configuration problem stops the service until somebody notices.
 *
 * `12` §4.2's table, verbatim:
 *
 * | code | meaning | orchestrator |
 * |---|---|---|
 * | 0 | clean shutdown | — |
 * | 1 | crash (bug) | restart |
 * | 65 | data error | restart → recovery mode |
 * | 75 | temporary | restart with backoff |
 * | 78 | configuration | systemd: no restart; Docker: backoff |
 * | 130 | forced shutdown (second signal) | — |
 *
 * ## Why this lives here rather than in the CLI
 *
 * The classification is a property of the **error**, not of the command that happened to catch it:
 * a held lock is temporary whether the server, `comvivo doctor` or a migration found it. Putting
 * the table next to the error codes means there is one answer, and `exitCodeFor` is exhaustive
 * over `StorageErrorCode`, so a new error code cannot be added without someone deciding what an
 * orchestrator should do about it.
 */
import { StorageError, type StorageErrorCode } from './errors.js';

/** `12` §4.2's codes, named. */
export const EXIT_CODES = {
  /** A clean shutdown. */
  ok: 0,
  /**
   * A bug.
   *
   * Also the answer for every error that should never have reached the top of the process: an
   * invariant trigger firing, a transaction misuse, a repository writing something its own CHECK
   * refuses. Those are not configuration and not data corruption — they are this program being
   * wrong, and a restart is the right response because the next request may well succeed.
   */
  bug: 1,
  /** The data on disk is not what this binary can work with. Boot into recovery mode. */
  data: 65,
  /** Nothing is wrong except the timing. Restart with backoff. */
  temporary: 75,
  /** A human has to change something before another start can work. */
  configuration: 78,
  /** A second signal arrived while draining. */
  forced: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * What an orchestrator should be told, if this error reached the top of the process.
 *
 * Note the conditional: most of these codes describe something a caller handles and continues
 * from — a blob over its size limit is a reply to a member, not a reason to stop. Reaching here
 * means nothing handled it, which is `EXIT_CODES.bug` by definition. Only the errors that can
 * legitimately end a boot get a code of their own.
 */
export function exitCodeFor(error: unknown): ExitCode {
  if (!(error instanceof StorageError)) return EXIT_CODES.bug;
  return exitCodeForStorageCode(error.storageCode);
}

/**
 * The table itself, total over every `StorageErrorCode`.
 *
 * A `Record`, not a `switch`. `errors.ts` reached the same conclusion for the same type and wrote
 * the reason down (`STATUS.md`, 2026-11-06): a `switch` with a `default` is a list that silently
 * stops matching the type it switches on. A **total** record is better still — TypeScript requires
 * every key, so adding a code to `StorageErrorCode` is a compile error here until someone decides
 * what an orchestrator should do about it, with no `default` to forget and nothing unreachable.
 *
 * The switch version of this was the repository's first exhaustive switch over a closed union, and
 * it could not be written: `switch-exhaustiveness-check` is configured with
 * `allowDefaultCaseForExhaustiveSwitch: false` so the `default` was refused, and moving
 * `assertNever` after the switch was refused in turn by `allowUnreachableCode: false`. The
 * convention in `assert-never.ts` had never been lintable; that comment now says so.
 */
const EXIT_CODE_BY_STORAGE_CODE: Readonly<Record<StorageErrorCode, ExitCode>> = {
  // A human has to act: a missing or wrong key, an extension that will not load, a data directory
  // from a future version. Restarting changes none of them, which is why systemd is told not to.
  STORAGE_KEY_MISSING: EXIT_CODES.configuration,
  STORAGE_KEY_INVALID: EXIT_CODES.configuration,
  STORAGE_EXTENSION_LOAD_FAILED: EXIT_CODES.configuration,
  STORAGE_VERSION_UNSUPPORTED: EXIT_CODES.configuration,
  SCHEMA_TOO_NEW: EXIT_CODES.configuration,
  BACKUP_KEY_MISMATCH: EXIT_CODES.configuration,

  // Nothing is wrong but the moment. `12` §3.7's second process exits 75 and the orchestrator backs
  // off, which is what lets a restarting container wait out the old one's lock instead of fighting
  // it.
  STORAGE_LOCKED: EXIT_CODES.temporary,
  STORAGE_BUSY: EXIT_CODES.temporary,
  STORAGE_DISK_SPACE_LOW: EXIT_CODES.temporary,
  BLOB_DISK_LOW: EXIT_CODES.temporary,
  RESTORE_SERVER_RUNNING: EXIT_CODES.temporary,

  // The bytes on disk disagree with what they should be. Boot into recovery mode rather than
  // retrying the same read, and tell the host which backup to reach for.
  STORAGE_CORRUPT: EXIT_CODES.data,
  STORAGE_IO: EXIT_CODES.data,
  MIGRATION_FAILED: EXIT_CODES.data,
  MIGRATION_CHECKSUM_MISMATCH: EXIT_CODES.data,
  MIGRATION_FK_VIOLATION: EXIT_CODES.data,
  BLOB_INTEGRITY: EXIT_CODES.data,
  BLOB_MISSING_FILE: EXIT_CODES.data,
  BACKUP_INTEGRITY: EXIT_CODES.data,

  // Everything else is handled by its caller in normal operation — a blob over its size limit is a
  // reply to a member, not a reason to stop. Arriving at the top of the process means nothing
  // handled it, so it is this program being wrong.
  STORAGE_TX_ASYNC_CALLBACK: EXIT_CODES.bug,
  STORAGE_WRITE_IN_READ: EXIT_CODES.bug,
  STORAGE_JSON_INVALID: EXIT_CODES.bug,
  STORAGE_ID_INVALID: EXIT_CODES.bug,
  STORAGE_CONSTRAINT: EXIT_CODES.bug,
  I4_LABEL_GROUP_MISMATCH: EXIT_CODES.bug,
  I4_GROUP_IMMUTABLE: EXIT_CODES.bug,
  MEMORY_CONTENT_IMMUTABLE: EXIT_CODES.bug,
  AUDIT_APPEND_ONLY: EXIT_CODES.bug,
  CONSTITUTION_VERSION_IMMUTABLE: EXIT_CODES.bug,
  LABEL_IMMUTABLE: EXIT_CODES.bug,
  READER_SET_IMMUTABLE: EXIT_CODES.bug,
  JOB_PAYLOAD_INVALID: EXIT_CODES.bug,
  JOB_LEASE_LOST: EXIT_CODES.bug,
  SCHEDULE_NO_NEXT: EXIT_CODES.bug,
  BLOB_TOO_LARGE: EXIT_CODES.bug,
  BLOB_QUOTA_EXCEEDED: EXIT_CODES.bug,
  EXPORT_SCOPE_DENIED: EXIT_CODES.bug,
  // The sweep aborts and retries tomorrow; nothing was deleted, so the instance keeps running.
  AUDIT_REANCHOR_FAILED: EXIT_CODES.bug,
};

/** What an orchestrator should be told about one storage error code. */
export function exitCodeForStorageCode(code: StorageErrorCode): ExitCode {
  return EXIT_CODE_BY_STORAGE_CODE[code];
}
