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
import { chmod, lstat, readdir } from 'node:fs/promises';
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
  if ((options.platform ?? process.platform) === 'win32') {
    return { refused: [], tightened: [], allowed: [], skipped: true };
  }

  const policy = policyFor(root, options);
  const refused: PermissionFinding[] = [];
  const tightened: string[] = [];
  const allowed: PermissionFinding[] = [];

  for (const path of await auditPaths(root)) {
    const stats = await modeOf(path);
    if (stats === undefined) continue;

    const verdict = classify(path, stats, policy);
    switch (verdict.kind) {
      case 'refuse':
        refused.push({ path, mode: stats.mode, reason: verdict.reason });
        break;
      case 'allow':
        allowed.push({ path, mode: stats.mode, reason: verdict.reason });
        break;
      case 'tighten':
        if (await applyTightening(path, stats, verdict.force, policy.shouldTighten)) {
          tightened.push(path);
        }
        break;
      // `ok` is named rather than left to a `default`, so adding a verdict to the union is a lint
      // error here rather than a path that silently does nothing. With every case listed,
      // `switch-exhaustiveness-check` is itself the `never` check `CLAUDE.md` §2 asks for — and it
      // refuses a `default` on an exhaustive switch, because one would hide the next addition.
      case 'ok':
        break;
    }
  }

  return { refused, tightened, allowed, skipped: false };
}

/** What the audit is comparing each path against, resolved once. */
interface AuditPolicy {
  /** `12` §3.7: the three paths a writable bit is never acceptable on. */
  readonly noWriteByOthers: readonly string[];
  /** `keys/` and every file in it: readable by others is a refusal unless the flag is set. */
  readonly keyMaterial: readonly string[];
  readonly expectedUid: number | undefined;
  readonly allowInsecureReads: boolean;
  readonly shouldTighten: boolean;
}

function policyFor(root: string, options: AuditOptions): AuditPolicy {
  const layout = dataDirLayout(root);
  return {
    noWriteByOthers: [root, layout.keys, layout.masterKey],
    keyMaterial: [layout.keys, ...KEY_FILES.map((name) => join(layout.keys, name))],
    expectedUid: options.expectedUid ?? currentUid(),
    allowInsecureReads: options.allowInsecureReads === true,
    shouldTighten: options.tighten !== false,
  };
}

/** What should happen to one path. */
type Verdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'refuse'; readonly reason: PermissionFinding['reason'] }
  | { readonly kind: 'allow'; readonly reason: PermissionFinding['reason'] }
  /** `force` tightens whatever the mode is; otherwise only a mode that is not already exact. */
  | { readonly kind: 'tighten'; readonly force: boolean };

/**
 * Decide one path's verdict.
 *
 * Split out of `auditPermissions` because that function scored 37 against biome's cognitive-
 * complexity limit of 20 — the same signal that split `rotateData` in `M1-T6`, and the same
 * conclusion: a loop that both classifies and acts is one where the `12` §3.7 policy is hard to
 * read off the code. The policy is four ordered rules, so it is now four ordered rules, and
 * `auditPermissions` is a loop that applies whatever this returns.
 *
 * The order matters and is `12` §3.7's own:
 *
 *  1. **Owner mismatch** first, because a path owned by another user makes every mode reading moot
 *     — they can change it.
 *  2. **Writable key material**, which is never waivable: "another user may replace my master key"
 *     is not a privacy judgement a host gets to make.
 *  3. **Readable key material**, which is — `08` §3.7.3's ssh-style escape hatch.
 *  4. Everything else is tightened and warned about, because a product that refused to start over
 *     a 0755 `models/` would be a product nobody finishes installing.
 */
function classify(path: string, stats: PathStats, policy: AuditPolicy): Verdict {
  if (policy.expectedUid !== undefined && stats.uid !== policy.expectedUid) {
    return { kind: 'refuse', reason: 'owner' };
  }

  if (isGroupOrWorldWritable(stats.mode) && policy.noWriteByOthers.includes(path)) {
    return { kind: 'refuse', reason: 'writable' };
  }

  if (policy.keyMaterial.includes(path)) {
    if (isGroupOrWorldWritable(stats.mode)) return { kind: 'refuse', reason: 'writable' };
    if (isGroupOrWorldReadable(stats.mode)) {
      return policy.allowInsecureReads
        ? { kind: 'allow', reason: 'readable' }
        : { kind: 'refuse', reason: 'readable' };
    }
    // Private but not exactly 0600/0700 — tighten silently, since nothing is exposed.
    return { kind: 'tighten', force: false };
  }

  // Not key material: anything another user can reach is corrected and warned about.
  return isGroupOrWorldAccessible(stats.mode)
    ? { kind: 'tighten', force: true }
    : { kind: 'tighten', force: false };
}

/** Apply a tightening verdict. Returns whether the path's mode needed changing. */
async function applyTightening(
  path: string,
  stats: PathStats,
  force: boolean,
  shouldTighten: boolean,
): Promise<boolean> {
  const target = stats.isDirectory ? DIR_MODE : FILE_MODE;
  if (!force && stats.mode === target) return false;
  if (shouldTighten) await chmod(path, target);
  return true;
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

/**
 * The top level of the data directory, plus `keys/` and `db/`. See the note on `auditPermissions`.
 *
 * `db/` was missing, and it is the one directory whose **contents** are the data: a
 * world-readable `comvivo.db` is the whole store, and a world-readable `-wal` is every recent
 * write. The walk covered the top level, so `db/` itself was checked and the three files inside it
 * were not — boot reported clean over a readable database. Found by the M1 independent review.
 */
async function auditPaths(root: string): Promise<readonly string[]> {
  const layout = dataDirLayout(root);
  const paths = [root];
  for (const name of await listDirectory(root)) paths.push(join(root, name));
  for (const name of await listDirectory(layout.keys)) paths.push(join(layout.keys, name));
  for (const name of await listDirectory(layout.db)) paths.push(join(layout.db, name));
  return paths;
}

/**
 * The database file and its WAL sidecars, whichever of them exist.
 *
 * `-wal` and `-shm` appear when a connection opens in WAL mode and vanish when the last one
 * closes, so this is a snapshot rather than a fixed list.
 */
export function databaseFilePaths(root: string): readonly string[] {
  const { dbFile } = dataDirLayout(root);
  return [dbFile, `${dbFile}-wal`, `${dbFile}-shm`];
}

/**
 * Put the database file and its sidecars at {@link FILE_MODE}.
 *
 * SQLite creates all three itself, with `0644 & ~umask` — so on a default-umask host the store was
 * world-readable the moment it was created, and `12` §3.7's `0600` was a line in a spec with no
 * code behind it. `grep chmod` across `db/` found nothing. Found by the M1 independent review.
 *
 * Called after every open rather than only at creation, because the `-wal` and `-shm` files are
 * recreated each time a connection opens and get the same default mode again.
 */
export async function secureDatabaseFiles(root: string): Promise<readonly string[]> {
  const secured: string[] = [];
  for (const path of databaseFilePaths(root)) {
    try {
      await chmod(path, FILE_MODE);
      secured.push(path);
    } catch {
      // Not there — the sidecars only exist while a connection is open, and on a fresh install the
      // database itself does not exist until the first write. A missing file is not a failure to
      // secure; an unreadable one shows up in `auditPermissions`, which is the check with teeth.
    }
  }
  return secured;
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

function currentUid(): number | undefined {
  // Absent on Windows, which is already handled, and absent in some sandboxes.
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/*
 * `takeOwnership(path, uid, gid)` was here: a three-line `chown` wrapper, exported on the public
 * barrel, with **no caller and no test** — so a privileged filesystem operation had never once
 * executed. Deleted 2026-11-07 (M1 independent review), rather than given a test, because it is
 * the wrong layer twice over:
 *
 *  - `12` §3.8's root-start mode does this in the **shell entrypoint**, with
 *    `find /data -xdev \( ! -user $PUID -o ! -group $PGID \) -exec chown $PUID:$PGID {} +`, and
 *    then `exec setpriv` to drop privileges. By the time Node runs, the process is uid 1000
 *    (`USER 1000:1000`) and has no `CAP_CHOWN` — so this function would have failed with `EPERM`
 *    wherever it was called from.
 *  - Its own docstring said the server "never changes ownership of anything, because a server that
 *    could would be a server that can be tricked into doing it". That argument is right, and it is
 *    an argument for the function not existing.
 *
 * An exported privileged operation that cannot work where it lives is worse than an absent one:
 * somebody finds it, calls it, and gets a confusing `EPERM` instead of the entrypoint fix.
 */
