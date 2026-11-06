/**
 * `@comvivo/storage/db` — opening the database, and nothing else yet.
 *
 * `M1-T8`'s scope is the connection: how it is opened, with which pragmas, under which key, and
 * what its failures mean. The schema (`M1-T9`), migrations (`M1-T10`) and the repositories
 * (`M1-T11` onward) sit on top of it.
 *
 * Two things in here are easy to mistake for configuration and are not:
 *
 *  - `DEFAULT_CACHE_SIZE_KIB` is 192 MiB because the spike measured a **100× difference** on
 *    vector search between that and 8 MiB. Lowering it is a correctness change, not a memory
 *    saving.
 *  - `onCreated` exists because `auto_vacuum` can only be set **before** `journal_mode = WAL`, and
 *    the pragma fails silently otherwise. Measured; see `OpenOptions.onCreated`.
 *
 * `SqliteStore` (`M1-T9`) is the **only** thing here that may open a transaction, and a lint rule
 * enforces it: a raw `db.transaction()` loses the `IMMEDIATE` lock, the synchronous-callback guard,
 * `afterCommit` ordering and the slow-transaction log, and none of those absences raise an error.
 */

export {
  constraintNameOf,
  isSqliteError,
  isUniqueViolation,
  type MapOptions,
  mapSqliteError,
  raisedCodeOf,
  type SqliteError,
  storageCodeFor,
} from './errors.js';
export {
  AUTO_VACUUM_INCREMENTAL,
  assertAutoVacuum,
  type DatabaseState,
  freePages,
  type InitResult,
  incrementalVacuum,
  initDatabase,
  probeDatabase,
} from './init.js';
export {
  assertVersions,
  type Cipher,
  type ConnectionRole,
  compareVersions,
  DEFAULT_BUSY_TIMEOUT_MS,
  DEFAULT_CACHE_SIZE_KIB,
  MIN_SQLITE_VERSION,
  MIN_VEC_VERSION,
  type OpenDatabase,
  type OpenOptions,
  openDatabase,
  pragmaValue,
  RUNTIME_PRAGMAS,
} from './open.js';
export {
  DEFAULT_SLOW_TX_MS,
  isThenable,
  SqliteStore,
  type SqliteStoreOptions,
} from './tx.js';
export {
  openWorkerConnection,
  receiveHandshake,
  sendDatabaseKey,
  sendNoDatabaseKey,
  type WorkerHandshake,
  type WorkerKeyMessage,
  type WorkerNoKeyMessage,
} from './worker-connection.js';
