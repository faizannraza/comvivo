/**
 * Typed errors.
 *
 * `01` §11.6: *"No silent catches. Every caught error is handled, mapped to a typed error, or
 * rethrown with context."* This module is the vocabulary for doing that.
 *
 * Three ideas are worth stating, because they shape everything else:
 *
 *  1. **A thrown error is a fault, not an answer.** Expected failures are `Result` values
 *     (`result.ts`). What lands here is a disk that will not write, a provider that is down, a
 *     configuration file that cannot be parsed, or a broken invariant.
 *  2. **Every error carries a stable `code`.** Logs, the `doctor` command, the dashboard's fix-it
 *     messages and the exit-code contract all key off it, so it must survive a reworded message.
 *  3. **`userMessage` is separate from `message`.** The first is product copy a non-technical
 *     member may read in a chat; the second is for a host reading logs. Collapsing them produces
 *     either stack traces in a family group chat or useless "something went wrong" in a log.
 */

/** Stable, machine-readable error codes. Add to the union; never renumber or reuse. */
export type ErrorCode =
  /** A broken invariant. Always our bug, never the user's input. */
  | 'bug'
  /** Configuration is missing, malformed, or contradicts itself. */
  | 'config.invalid'
  /** A required secret is absent or unreadable. */
  | 'config.secret_missing'
  /** A file's permissions are too open to be trusted with a secret. */
  | 'config.insecure_permissions'
  /** Input failed its schema at a boundary. */
  | 'validation.failed'
  /** The filesystem, the network or a subprocess failed. */
  | 'io.failed'
  /** An operation ran out of time. */
  | 'timeout';

export interface ErrorContext {
  /** Copy safe to show a non-technical person. Omit when there is nothing useful to say. */
  readonly userMessage?: string;
  /**
   * Structured detail for logs. Must contain **no** message or memory content and no secrets
   * (`01` §11.7); the logger's field allowlist is the backstop, not the excuse.
   */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
  readonly cause?: unknown;
}

/**
 * Base class for every error this project throws deliberately.
 *
 * Deliberately **not** brand-named: a class name that contains the product name would have to be
 * rewritten by the rename codemod and would show up as a hard-coded literal in every test that
 * names it. The brand lives in `BRAND` and nowhere else (`13` §3.A.6).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly userMessage: string | undefined;
  readonly detail: Readonly<Record<string, string | number | boolean>> | undefined;

  constructor(code: ErrorCode, message: string, context: ErrorContext = {}) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.code = code;
    this.userMessage = context.userMessage;
    this.detail = context.detail;
    // Without this, `instanceof` fails for subclasses when the output targets older runtimes.
    this.name = new.target.name;
  }
}

/**
 * A broken invariant. If a user can trigger this, the bug is that it is reachable — so the message
 * is for us, and `userMessage` deliberately stays generic.
 */
export class BugError extends AppError {
  constructor(message: string, context: ErrorContext = {}) {
    super('bug', message, {
      // Not "nothing was changed": a broken invariant can be noticed *after* a partial effect, and
      // this is the base copy for every one of them. Claiming more than is known is exactly the
      // habit this product is supposed to be the opposite of.
      ...context,
      // After the spread, and with an explicit `undefined` check: `{ ...context }` placed last
      // would let a caller passing `userMessage: undefined` wipe the default, leaving a broken
      // invariant with no copy at all.
      userMessage:
        context.userMessage ??
        "Something went wrong on my side — I've stopped here rather than guess.",
    });
  }
}

/** Configuration is unusable. Thrown at startup, before anything else can go wrong. */
export class ConfigError extends AppError {
  /** The dotted config path at fault, e.g. `dashboard.port`. */
  readonly path: string | undefined;

  constructor(
    message: string,
    options: ErrorContext & { readonly code?: ErrorCode; readonly path?: string } = {},
  ) {
    super(options.code ?? 'config.invalid', message, options);
    this.path = options.path;
  }
}

/** A boundary rejected its input. Carries the per-field problems so a fix-it message can list them. */
export class ValidationError extends AppError {
  readonly issues: readonly { readonly path: string; readonly message: string }[];

  constructor(
    message: string,
    issues: readonly { readonly path: string; readonly message: string }[],
    context: ErrorContext = {},
  ) {
    super('validation.failed', message, context);
    this.issues = issues;
  }
}

/** The filesystem, the network or a subprocess failed. */
export class IoError extends AppError {
  constructor(message: string, context: ErrorContext = {}) {
    super('io.failed', message, context);
  }
}

/** An operation exceeded its deadline. */
export class TimeoutError extends AppError {
  readonly afterMs: number;

  constructor(message: string, afterMs: number, context: ErrorContext = {}) {
    // `detail` is merged rather than spread over, so a caller passing their own `detail` does not
    // silently lose `afterMs` — which is the one fact a timeout error exists to carry.
    super('timeout', message, {
      ...context,
      detail: { afterMs, ...(context.detail ?? {}) },
    });
    this.afterMs = afterMs;
  }
}

/**
 * The storage subsystem's own codes (`02` §4.3).
 *
 * Here rather than in `packages/storage` because `02` §4.3 puts them in `@comvivo/shared/errors`,
 * and because the consumers are everywhere: the CLI maps them to exit codes, the HTTP layer maps
 * them to statuses, and `doctor` explains them. A code is a **contract**, so it belongs at the
 * bottom of the dependency graph with the rest of the contracts; the SQLite *mapping* onto these
 * codes is `storage/src/db/errors.ts` and stays there (`M1-T8`).
 */
export type StorageErrorCode =
  | 'STORAGE_KEY_MISSING'
  | 'STORAGE_KEY_INVALID'
  | 'STORAGE_EXTENSION_LOAD_FAILED'
  | 'STORAGE_VERSION_UNSUPPORTED'
  | 'STORAGE_LOCKED'
  | 'STORAGE_BUSY'
  | 'STORAGE_CORRUPT'
  | 'STORAGE_DISK_SPACE_LOW'
  | 'STORAGE_IO'
  | 'STORAGE_TX_ASYNC_CALLBACK'
  | 'STORAGE_TX_FOREIGN'
  | 'STORAGE_WRITE_IN_READ'
  | 'STORAGE_JSON_INVALID'
  | 'STORAGE_ID_INVALID'
  | 'STORAGE_CONSTRAINT'
  | 'I4_LABEL_GROUP_MISMATCH'
  | 'I4_GROUP_IMMUTABLE'
  | 'MEMORY_CONTENT_IMMUTABLE'
  | 'AUDIT_APPEND_ONLY'
  | 'CONSTITUTION_VERSION_IMMUTABLE'
  | 'LABEL_IMMUTABLE'
  | 'READER_SET_IMMUTABLE'
  | 'SCHEMA_TOO_NEW'
  | 'MIGRATION_FAILED'
  | 'MIGRATION_CHECKSUM_MISMATCH'
  | 'MIGRATION_FK_VIOLATION'
  | 'JOB_PAYLOAD_INVALID'
  | 'JOB_LEASE_LOST'
  | 'SCHEDULE_NO_NEXT'
  | 'BLOB_TOO_LARGE'
  | 'BLOB_QUOTA_EXCEEDED'
  | 'BLOB_DISK_LOW'
  | 'BLOB_INTEGRITY'
  | 'BLOB_MISSING_FILE'
  | 'BACKUP_INTEGRITY'
  | 'BACKUP_KEY_MISMATCH'
  | 'RESTORE_SERVER_RUNNING'
  | 'EXPORT_SCOPE_DENIED'
  /** `08` §3.16.2's re-anchor could not be written, so nothing was deleted (`M1-T26`). */
  | 'AUDIT_REANCHOR_FAILED';

/** Every `StorageErrorCode`, for exhaustiveness checks and for tests that enumerate them. */
export const STORAGE_ERROR_CODES: readonly StorageErrorCode[] = [
  'STORAGE_KEY_MISSING',
  'STORAGE_KEY_INVALID',
  'STORAGE_EXTENSION_LOAD_FAILED',
  'STORAGE_VERSION_UNSUPPORTED',
  'STORAGE_LOCKED',
  'STORAGE_BUSY',
  'STORAGE_CORRUPT',
  'STORAGE_DISK_SPACE_LOW',
  'STORAGE_IO',
  'STORAGE_TX_ASYNC_CALLBACK',
  'STORAGE_TX_FOREIGN',
  'STORAGE_WRITE_IN_READ',
  'STORAGE_JSON_INVALID',
  'STORAGE_ID_INVALID',
  'STORAGE_CONSTRAINT',
  'I4_LABEL_GROUP_MISMATCH',
  'I4_GROUP_IMMUTABLE',
  'MEMORY_CONTENT_IMMUTABLE',
  'AUDIT_APPEND_ONLY',
  'CONSTITUTION_VERSION_IMMUTABLE',
  'LABEL_IMMUTABLE',
  'READER_SET_IMMUTABLE',
  'SCHEMA_TOO_NEW',
  'MIGRATION_FAILED',
  'MIGRATION_CHECKSUM_MISMATCH',
  'MIGRATION_FK_VIOLATION',
  'JOB_PAYLOAD_INVALID',
  'JOB_LEASE_LOST',
  'SCHEDULE_NO_NEXT',
  'BLOB_TOO_LARGE',
  'BLOB_QUOTA_EXCEEDED',
  'BLOB_DISK_LOW',
  'BLOB_INTEGRITY',
  'BLOB_MISSING_FILE',
  'BACKUP_INTEGRITY',
  'BACKUP_KEY_MISMATCH',
  'RESTORE_SERVER_RUNNING',
  'EXPORT_SCOPE_DENIED',
  'AUDIT_REANCHOR_FAILED',
];

/**
 * A storage failure, carrying both the coarse category and `02` §4.3's specific code.
 *
 * Two codes rather than one, and the split is deliberate. `AppError.code` is what a generic
 * handler branches on — "is this our bug, bad config, or the disk?" — and stays a small closed
 * set so a `switch` over it is tractable. `storageCode` is what a host sees, what `doctor`
 * explains and what the CLI maps to an exit code, and there are thirty-odd of them. Collapsing
 * them into one union would either make every `switch` unmaintainable or throw away the specific
 * code, and the specific code is the one that tells somebody what to do next.
 */
export class StorageError extends AppError {
  readonly storageCode: StorageErrorCode;
  /** What a host should do about it. Shown by `doctor`, so it names commands, not functions. */
  readonly hint: string | undefined;

  constructor(
    storageCode: StorageErrorCode,
    message: string,
    options: ErrorContext & { readonly hint?: string; readonly category?: ErrorCode } = {},
  ) {
    const { hint, category, ...context } = options;
    // `detail` is merged rather than replaced, so a caller's own detail does not lose the code —
    // which is the one field a log line needs to be actionable.
    super(category ?? 'io.failed', message, {
      ...context,
      detail: { storageCode, ...(context.detail ?? {}) },
    });
    this.storageCode = storageCode;
    this.hint = hint;
  }
}

/**
 * Turn an unknown caught value into a typed error, preserving the original as `cause`.
 *
 * Use this at the edge of a `try`, so the ban on silent catches has a one-line answer and a
 * `catch (e)` never loses the stack it came from.
 */
export function toAppError(caught: unknown, context?: string): AppError {
  if (caught instanceof AppError) return caught;
  const prefix = context === undefined ? '' : `${context}: `;
  if (caught instanceof Error) {
    return new IoError(`${prefix}${caught.message}`, { cause: caught });
  }
  return new IoError(`${prefix}${String(caught)}`, { cause: caught });
}

/** Is this an error we raised deliberately, as opposed to one that escaped a library? */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
