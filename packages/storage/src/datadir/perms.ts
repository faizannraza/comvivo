/**
 * The boot and `doctor` permission audit (`12` §3.7, `08` §3.7.3).
 *
 * `12` §3.7 specifies four outcomes, and the differences between them are the whole design — a
 * single "are the permissions ok" boolean would be either too strict to install or too lax to
 * trust:
 *
 * | Finding | Outcome |
 * |---|---|
 * | group- or world-**writable** `dataDir`, `keys/` or `master.key` | **refuse** (78) |
 * | group- or world-**readable** `keys/` or a key file | **refuse** (78), unless `--insecure-permissions` |
 * | any other group- or world-readable path | **auto-tighten** and warn |
 * | owner mismatch | **refuse** (78), with a `chown` hint |
 *
 * Writable is always a refusal and is **not** overridable, while readable is overridable with an
 * explicit flag. That asymmetry is deliberate: a host can reasonably decide that other users on
 * their box are trusted to *read* (the ssh-style judgement `08` §3.7.3 allows), but nobody can
 * reasonably decide that another user may *replace* their master key — that is not a privacy
 * trade-off, it is someone else choosing the encryption key.
 *
 * Auto-tightening the rest rather than refusing is the difference between a product that installs
 * and one that greets a new host with a wall of `chmod` commands. The key material is the part
 * worth stopping for.
 *
 * Skipped on Windows, where POSIX mode bits are synthesised and would refuse every install
 * (`08` §3.7.3).
 */
import { chmod, chown, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { StorageError } from '@comvivo/shared';
import { DIR_MODE, dataDirLayout, FILE_MODE, KEY_FILES } from './layout.js';

/** What the audit concluded about one path. */
export interface PermissionFinding {
  readonly path: string;
  /** The mode bits as found, masked to the permission bits. */
  readonly mode: number;
  readonly reason: 'writable' | 'readable' | 'owner';
}

export interface PermissionAudit {
  /** Findings that stop the boot. */
  readonly refused: readonly PermissionFinding[];
  /** Paths whose mode was corrected, with a warning. */
  readonly tightened: readonly string[];
  /** Key material that is readable by others and was allowed through by the flag. */
  readonly allowed: readonly PermissionFinding[];
  /** True when the platform has no meaningful POSIX modes and the audit was skipped. */
  readonly skipped: boolean;
}

export interface AuditOptions {
  /** Defaults to `process.platform`; a test forces the other branch. */
  readonly platform?: string;
  /** `08` §3.7.3's ssh-style escape hatch. Covers **readable** findings only, never writable. */
  readonly allowInsecureReads?: boolean;
  /** The uid the data directory should belong to. Defaults to this process's. */
  readonly expectedUid?: number;
  /** Set false in a dry run, so `doctor` can report without changing anything. */
  readonly tighten?: boolean;
}

/** `true` when any group or other bit allows reading. */
export function isGroupOrWorldReadable(mode: number): boolean {
  return (mode & 0o044) !== 0;
}

/** `true` when any group or other bit allows writing. */
export function isGroupOrWorldWritable(mode: number): boolean {
  return (mode & 0o022) !== 0;
}

/** `true` when any group or other bit is set at all. */
export function isGroupOrWorldAccessible(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

/**
 * Audit a data directory's permissions.
 *
 * Walks the top level plus `keys/`, not the whole tree. A recursive walk over `blobs/` would be
 * thousands of `stat` calls at every boot, and the directory modes already make its contents
 * unreachable to other users — a 0600 blob inside a 0700 directory inside a 0700 data directory is
 * protected three times over. `doctor --deep` is where an exhaustive walk belongs.
 */
export async function auditPermissions(
  root: string,
  options: AuditOptions = {},
): Promise<PermissionAudit> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    return { refused: [], tightened: [], allowed: [], skipped: true };
  }

  const layout = dataDirLayout(root);
  const refused: PermissionFinding[] = [];
  const tightened: string[] = [];
  const allowed: PermissionFinding[] = [];
  const shouldTighten = options.tighten !== false;

  // `12` §3.7: these three are the ones a writable bit is never acceptable on.
  const noWriteByOthers = [root, layout.keys, layout.masterKey];
  // Key material: readable by others is a refusal unless the flag is set.
  const keyMaterial = [layout.keys, ...KEY_FILES.map((name) => join(layout.keys, name))];

  const expectedUid = options.expectedUid ?? currentUid();

  for (const path of await auditPaths(root)) {
    const stats = await modeOf(path);
    if (stats === undefined) continue;

    if (expectedUid !== undefined && stats.uid !== expectedUid) {
      refused.push({ path, mode: stats.mode, reason: 'owner' });
      continue;
    }

    if (isGroupOrWorldWritable(stats.mode) && noWriteByOthers.includes(path)) {
      refused.push({ path, mode: stats.mode, reason: 'writable' });
      continue;
    }

    if (keyMaterial.includes(path)) {
      if (isGroupOrWorldReadable(stats.mode) || isGroupOrWorldWritable(stats.mode)) {
        const finding: PermissionFinding = {
          path,
          mode: stats.mode,
          reason: isGroupOrWorldWritable(stats.mode) ? 'writable' : 'readable',
        };
        // Writable is never waived, whatever the flag says. The flag is a privacy judgement, and
        // "another user may replace my master key" is not a privacy judgement.
        if (finding.reason === 'writable' || options.allowInsecureReads !== true) {
          refused.push(finding);
        } else {
          allowed.push(finding);
        }
        continue;
      }
      // Private but not exactly 0600/0700 — tighten silently, since nothing is exposed.
      if (await tightenIfNeeded(path, stats, shouldTighten)) tightened.push(path);
      continue;
    }

    if (isGroupOrWorldAccessible(stats.mode)) {
      if (shouldTighten) {
        await chmod(path, stats.isDirectory ? DIR_MODE : FILE_MODE);
      }
      tightened.push(path);
      continue;
    }

    if (await tightenIfNeeded(path, stats, shouldTighten)) tightened.push(path);
  }

  return { refused, tightened, allowed, skipped: false };
}

/**
 * Throw if the audit found anything that stops the boot (`12` §3.7, exit 78).
 *
 * Separate from `auditPermissions` so `doctor` can report every finding at once instead of the
 * first — a host with three wrong modes should be told three times, not made to run the command
 * three times.
 */
export function assertPermissionsUsable(audit: PermissionAudit, root: string): void {
  if (audit.refused.length === 0) return;

  const described = audit.refused
    .map(
      (finding) =>
        `${finding.path} is ${finding.mode.toString(8).padStart(4, '0')} (${finding.reason})`,
    )
    .join(', ');

  const owner = audit.refused.some((finding) => finding.reason === 'owner');
  const writable = audit.refused.some((finding) => finding.reason === 'writable');

  throw new StorageError(
    'STORAGE_IO',
    `the data directory's permissions are not safe to start with: ${described}`,
    {
      category: 'config.insecure_permissions',
      hint: owner
        ? `The data directory belongs to another user. Run \`chown -R $(id -u):$(id -g) ${root}\`, ` +
          'or run the service as the user that owns it.'
        : writable
          ? `Another user can write to your key material. Run \`chmod 700 ${root}\` and ` +
            `\`chmod 600 ${root}/keys/*\`. This one is not overridable: a writable key file means ` +
            'somebody else can choose the key your data is encrypted with.'
          : `Run \`chmod 700 ${root}/keys\` and \`chmod 600 ${root}/keys/*\`, or start with ` +
            '`--insecure-permissions` if you have decided the other users on this host are ' +
            'trusted to read (ssh-style).',
      detail: { refused: audit.refused.length },
    },
  );
}

/** The top level of the data directory, plus `keys/`. See the note on `auditPermissions`. */
async function auditPaths(root: string): Promise<readonly string[]> {
  const layout = dataDirLayout(root);
  const paths = [root];
  for (const name of await listDirectory(root)) paths.push(join(root, name));
  for (const name of await listDirectory(layout.keys)) paths.push(join(layout.keys, name));
  return paths;
}

async function listDirectory(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path);
  } catch {
    // A directory that is not there is not a finding: most installs have no `keys/vault.enc` and
    // a fresh one has no `keys/` at all until `init` runs.
    return [];
  }
}

interface PathStats {
  readonly mode: number;
  readonly uid: number;
  readonly isDirectory: boolean;
}

async function modeOf(path: string): Promise<PathStats | undefined> {
  try {
    // `lstat`, not `stat`: a symlink's own permissions are what another user can change, and
    // following it would audit the target's mode while leaving the link itself unchecked.
    const stats = await lstat(path);
    return { mode: stats.mode & 0o777, uid: stats.uid, isDirectory: stats.isDirectory() };
  } catch {
    return undefined;
  }
}

async function tightenIfNeeded(
  path: string,
  stats: PathStats,
  shouldTighten: boolean,
): Promise<boolean> {
  const target = stats.isDirectory ? DIR_MODE : FILE_MODE;
  if (stats.mode === target) return false;
  if (shouldTighten) await chmod(path, target);
  return true;
}

function currentUid(): number | undefined {
  // Absent on Windows, which is already handled, and absent in some sandboxes.
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * Take ownership of a path, for an installer running as root that has just created the directory.
 *
 * Exported for `12`'s installers rather than used at boot: the server never changes ownership of
 * anything, because a server that could would be a server that can be tricked into doing it.
 */
export async function takeOwnership(path: string, uid: number, gid: number): Promise<void> {
  await chown(path, uid, gid);
}
