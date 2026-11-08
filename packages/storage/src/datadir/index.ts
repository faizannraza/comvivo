/**
 * `@comvivo/storage/datadir` — the data directory, before the database opens.
 *
 * Everything here runs in `12` §3.8.1's step 1 and 2, which is the part of boot that happens with
 * no database and no key tree: work out whether this directory is an install, make sure nobody
 * else is writing to it, and refuse to continue if its permissions cannot be trusted with a
 * master key.
 *
 * The order those three happen in is the order of the risk. Permissions first, because reading a
 * key file out of a world-readable directory has already leaked it. Then the lock, because two
 * writers is the failure that corrupts rather than complains. Then the marker, which is the one
 * that decides between "fresh install" and "do not touch this, it is somebody's data".
 *
 * `12` §3.8.1's remaining steps — opening the database, migrations, the pre-migration backup —
 * belong to `M1-T8` and later, and they all start from the state this module establishes.
 */

export {
  clearFormatTemp,
  type DataDirFormat,
  type FormatState,
  formatSchema,
  type LastBoot,
  newFormat,
  parseFormat,
  readFormat,
  recordBoot,
  recordCleanShutdown,
  shutDownCleanly,
  writeFormat,
} from './format.js';
export {
  checkFilesystem,
  type FsCheck,
  type FsProbe,
  type FsVerdict,
  nodeFsProbe,
} from './fstype.js';
export {
  createLayout,
  DATA_DIRS,
  type DataDirLayout,
  type DataDirName,
  DIR_MODE,
  dataDirLayout,
  FILE_MODE,
  KEY_FILES,
  keyFilePaths,
  OPTIONAL_DIRS,
} from './layout.js';
export {
  type AcquireResult,
  acquireLock,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  heartbeat,
  isStale,
  type LockEnvironment,
  type LockFile,
  type LockHolder,
  lockedError,
  lockPath,
  lockSchema,
  nodeLockEnvironment,
  readLockHolder,
  releaseLock,
} from './lock.js';
export { DATA_DIR_FORMAT, DATA_DIR_FORMAT_VERSION } from './marker.js';
export {
  type AuditOptions,
  assertPermissionsUsable,
  auditPermissions,
  databaseFilePaths,
  isGroupOrWorldAccessible,
  isGroupOrWorldReadable,
  isGroupOrWorldWritable,
  type PermissionAudit,
  type PermissionFinding,
  secureDatabaseFiles,
  takeOwnership,
} from './perms.js';
