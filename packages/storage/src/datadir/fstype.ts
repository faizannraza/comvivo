/**
 * Is this data directory on a filesystem SQLite can be trusted on? (`12` §3.7)
 *
 * SQLite's WAL mode depends on two things a network filesystem usually does not provide: working
 * `fcntl` advisory locks, and shared memory via `mmap` on the `-shm` file. On NFS, SMB and 9p the
 * locks are either emulated or silently ignored, so two processes can both believe they hold a
 * write lock. The result is not a clear error — it is a corrupted database, discovered later.
 *
 * So `12` §3.7 asks for a **boot warning and a doctor error**, not a refusal. That split is the
 * right one: a host who has deliberately put their data on a NAS should be told clearly and often,
 * but having the product refuse to start would send them to an issue tracker rather than to a
 * local disk. `fuse.virtiofs` only warns, because that is Docker Desktop's normal file sharing on
 * macOS and Windows and it does work.
 *
 * There is no `statfs` in Node's standard library. `node:fs.statfs` reports a numeric `type` and
 * nothing else, so the type is resolved two ways and both are needed:
 *
 *  - **`statfs().type`**, a magic number, which is exact where it is known. `/proc/mounts` does
 *    not exist on macOS, and a container may not have it either.
 *  - **the mount table**, which gives the name (`nfs4`, `fuse.virtiofs`) that a magic number
 *    cannot — the FUSE magic is one number for every FUSE filesystem, so `fuse.sshfs` and
 *    `fuse.virtiofs` are indistinguishable by magic alone, and `12` §3.7 treats them differently.
 *
 * Sync-folder markers are checked here too, for the same reason and with the same answer: a
 * Dropbox or Syncthing folder will happily replicate a half-written WAL to another machine.
 */
import { readdir, readFile, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** How much a filesystem is to be trusted with a SQLite database. */
/**
 * `ok` and `warn` and `unsafe` are `12` §3.7's three. `unknown` is a fourth, because the check had
 * no way to say "I could not tell".
 *
 * `verdictFor` returned `ok` for an undetermined type, which is the same defect as the 9p magic
 * bug in a different place: not knowing, reported as fine. On darwin there is no `/proc/mounts`
 * and only two `statfs` indices are measured, so an SMB or NFS data directory — exactly the case
 * `12` §3.7 exists for — came back `ok`. It warns now.
 */
export type FsVerdict = 'ok' | 'warn' | 'unsafe' | 'unknown';

export interface FsCheck {
  readonly path: string;
  /** The resolved filesystem name, when one could be determined. */
  readonly type: string | undefined;
  /** The `statfs` magic number, for diagnostics when the name could not be found. */
  readonly magic: string | undefined;
  readonly verdict: FsVerdict;
  /** Why, in one sentence a host can act on. Empty for `ok`. */
  readonly reason: string;
  /** Sync-folder markers found at or above the data directory. */
  readonly syncMarkers: readonly string[];
}

/**
 * `12` §3.7's unsafe list. Matched as a prefix, so `nfs4` matches `nfs`.
 *
 * `fuse.` is deliberately **not** here as a blanket entry: the FUSE magic number covers every FUSE
 * filesystem, including `fuse.virtiofs`, which is how Docker Desktop shares files and does work.
 * Only named FUSE types that are known to be networked are unsafe.
 */
const UNSAFE_TYPES = [
  'nfs',
  'cifs',
  'smb',
  'smb2',
  'smbfs',
  '9p',
  'fuse.sshfs',
  'fuse.s3fs',
] as const;

/** Types that work but are worth a word, per `12` §3.7. */
const WARN_TYPES = ['fuse.virtiofs', 'fuse.grpcfuse', 'osxfuse', 'macfuse', 'overlay'] as const;

/**
 * `statfs` magic numbers, for the hosts where the mount table is unavailable.
 *
 * Hexadecimal literals because that is how every reference lists them, and because the decimal
 * forms are unrecognisable. Taken from the Linux `statfs(2)` manual page and `linux/magic.h`.
 *
 * **Keyed by number, not by string.** It was a `Record<string, string>` of `'0x…'` keys, looked up
 * with `` `0x${magic.toString(16)}` `` — and `toString(16)` emits no leading zero, so the `9p`
 * entry written `'0x01021997'` could never be found while `'0x1021994'` beside it could. 9p is in
 * {@link UNSAFE_TYPES} and has broken SQLite locking, so on a host where `/proc/mounts` is
 * unreadable — the one case this table exists for — a WSL2 `/mnt/c` or QEMU virtfs data directory
 * was reported `ok`. Found by the M1 independent review.
 *
 * A numeric key cannot drift from the value it is compared against, which is why the fix is the
 * key type rather than the missing digit: deleting one zero would have left the next entry one
 * typo away from the same silent hole.
 */
export const MAGIC_TYPES: Readonly<Record<number, string>> = {
  26985: 'nfs',
  4283649346: 'cifs',
  4266872130: 'smb2',
  20859: 'smbfs',
  16914839: '9p',
  1702057286: 'fuse',
  2035054128: 'overlay',
  61267: 'ext4',
  1481003842: 'xfs',
  2435016766: 'btrfs',
  801189825: 'zfs',
  16914836: 'tmpfs',
  19780: 'vfat',
  18475: 'hfsplus',
  1095784531: 'apfs',
};

/**
 * macOS `statfs` type indices.
 *
 * `MAGIC_TYPES` above is a table of Linux `linux/magic.h` constants, and applying it on darwin is a
 * category error: macOS's `f_type` is a small **filesystem type index**, not a magic number.
 * Measured on darwin 23.6: `/`, `/Users`, `/private/tmp` and `/System/Volumes/Data` all report
 * `26`, and `/dev` reports `19`. Every Linux magic in the table above is greater than `0x100`, so
 * no darwin index can collide with one — the Linux table was safe on darwin and simply never
 * matched, which is why the gap looked like a working check.
 *
 * Only the two values measured on this hardware are listed. Anything else on darwin resolves to
 * `undefined` and therefore to the `unknown` verdict, which warns — the safe direction, and
 * strictly better than the `ok` it used to produce. Adding `smbfs` or `nfs` here needs a machine
 * with such a mount to measure on; guessing the index would be the kind of unverified table entry
 * that produced the 9p bug.
 */
const DARWIN_FS_TYPES: Readonly<Record<number, string>> = {
  19: 'devfs',
  26: 'apfs',
};

/**
 * The filesystem name for a `statfs` type value on this platform, if one is known.
 *
 * Platform-aware because the number means different things: a Linux magic from `linux/magic.h`, or
 * a darwin type index. Reading one table on the other platform cannot be right even when it
 * happens to be harmless.
 */
export function typeFromMagic(magic: number | undefined, platform: string): string | undefined {
  if (magic === undefined) return undefined;
  if (platform === 'darwin') return DARWIN_FS_TYPES[magic];
  if (platform === 'linux') return MAGIC_TYPES[magic];
  // Some other Unix. Neither table applies, so say nothing rather than guess.
  return undefined;
}

/** Markers that mean a sync client owns this directory (`12` §3.7). */
const SYNC_MARKERS = [
  '.stfolder',
  '.dropbox',
  '.dropbox.cache',
  '.icloud',
  '.sync',
  '.syncthing',
] as const;

/** How the check reads the world. Injected so a test can state a filesystem rather than need one. */
export interface FsProbe {
  /** The `statfs` magic for a path, or `undefined` when it cannot be read. */
  magic(path: string): Promise<number | undefined>;
  /** The mount table, longest mount point first. Empty where there is none. */
  mounts(): Promise<readonly { readonly mountPoint: string; readonly type: string }[]>;
  /** Names present in a directory. Empty when it does not exist. */
  entries(path: string): Promise<readonly string[]>;
  /**
   * `process.platform`, because the `statfs` number means a different thing on each.
   *
   * Part of the probe rather than read directly, for the same reason the clock is: `12` §3.7's
   * whole point is to behave correctly on filesystems and platforms this machine does not have,
   * and a test that could only exercise its own platform would verify nothing about the other.
   */
  readonly platform: string;
}

export const nodeFsProbe: FsProbe = {
  platform: process.platform,

  async magic(path: string): Promise<number | undefined> {
    try {
      // `StatsFs.type` is already a `number` — `statfs(path, { bigint: true })` is the variant that
      // returns `bigint`, and this is not it.
      return (await statfs(path)).type;
    } catch {
      return undefined;
    }
  },

  async mounts(): Promise<readonly { readonly mountPoint: string; readonly type: string }[]> {
    // `/proc/mounts` on Linux. macOS has no equivalent text file, and shelling out to `mount(8)`
    // from a server process is not an option: `08` PSC-8 restricts `child_process` to the plugin
    // sandbox and transcription, and widening that for a diagnostic would be exactly the kind of
    // rule-weakening `CLAUDE.md` §2 forbids.
    //
    // This comment used to claim "`statfs` plus the APFS/HFS magics cover the local cases there,
    // and a macOS host on a network share still gets the FUSE or SMB magic". **Both halves were
    // false** — `MAGIC_TYPES` is a table of Linux constants and macOS's `f_type` is a small type
    // index, so nothing in it could ever match on darwin. Measured and corrected: `DARWIN_FS_TYPES`
    // covers the local cases that were measurable on real hardware, and anything else on darwin
    // now resolves to the `unknown` verdict and warns, rather than being reported as fine.
    let text: string;
    try {
      text = await readFile('/proc/mounts', 'utf8');
    } catch {
      return [];
    }
    const rows: { mountPoint: string; type: string }[] = [];
    for (const line of text.split('\n')) {
      // `device mountpoint type options dump pass`
      const fields = line.split(' ');
      const mountPoint = fields[1];
      const type = fields[2];
      if (mountPoint === undefined || type === undefined) continue;
      // Mount points are escaped octal-style in `/proc/mounts`; spaces are the only one that
      // matters for a data directory path.
      rows.push({ mountPoint: mountPoint.replaceAll('\\040', ' '), type });
    }
    // Longest first, so the most specific mount wins for a nested path.
    return rows.sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  },

  async entries(path: string): Promise<readonly string[]> {
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  },
};

/**
 * Check the filesystem under a path.
 *
 * Never throws. A failed probe yields `ok` with no type, deliberately: this is advice, and a host
 * whose kernel does not expose `statfs` should not be blocked from starting by a diagnostic.
 */
export async function checkFilesystem(
  path: string,
  probe: FsProbe = nodeFsProbe,
): Promise<FsCheck> {
  const absolute = resolve(path);
  const magic = await probe.magic(absolute);
  const magicHex = magic === undefined ? undefined : `0x${magic.toString(16)}`;
  const named = await typeFromMounts(absolute, probe);
  // The mount table wins when it has an answer: it distinguishes `fuse.virtiofs` from
  // `fuse.sshfs`, which share one magic number and have opposite verdicts.
  const type = named ?? typeFromMagic(magic, probe.platform);
  const syncMarkers = await findSyncMarkers(absolute, probe);

  const verdict = verdictFor(type, syncMarkers.length > 0);
  return {
    path: absolute,
    type,
    magic: magicHex,
    verdict,
    reason: reasonFor(type, verdict, syncMarkers),
    syncMarkers,
  };
}

function verdictFor(type: string | undefined, hasSyncMarker: boolean): FsVerdict {
  if (type !== undefined && UNSAFE_TYPES.some((unsafe) => type.startsWith(unsafe))) {
    return 'unsafe';
  }
  // Before the `unknown` branch: a sync marker is evidence on its own, and it is the one finding
  // that does not need the filesystem type to be conclusive.
  if (hasSyncMarker) return 'unsafe';
  if (type !== undefined && WARN_TYPES.some((warn) => type.startsWith(warn))) return 'warn';
  // An unknown FUSE filesystem: works often enough not to call unsafe, unusual enough to mention.
  if (type === 'fuse' || type?.startsWith('fuse.') === true) return 'warn';
  // Not "fine" — "could not tell". `12` §3.7's rule is warn at boot and error in `doctor`, never
  // refuse, so an undetermined type belongs on the warning side of that line.
  if (type === undefined) return 'unknown';
  return 'ok';
}

function reasonFor(
  type: string | undefined,
  verdict: FsVerdict,
  syncMarkers: readonly string[],
): string {
  if (verdict === 'ok') return '';
  if (syncMarkers.length > 0 && verdict === 'unsafe') {
    return (
      `this directory is inside a sync folder (${syncMarkers.join(', ')}). A sync client will ` +
      'replicate a half-written write-ahead log to another machine, which corrupts the database ' +
      'on both. Move the data directory outside the synced folder and back it up with ' +
      '`backup` instead.'
    );
  }
  if (verdict === 'unknown') {
    return (
      'the filesystem type could not be determined, so SQLite’s locking requirements could not ' +
      'be checked. On Linux this means `/proc/mounts` was unreadable; on macOS only local ' +
      'filesystems are recognised. If this directory is on a network share — NFS, SMB, or a ' +
      'mounted cloud drive — move it to a local disk: those emulate file locking and corrupt a ' +
      'database rather than returning an error. `doctor` reports this in full.'
    );
  }
  const name = type ?? 'this filesystem';
  if (verdict === 'unsafe') {
    return (
      `${name} does not provide the file locking SQLite needs. Locks are emulated or ignored, so ` +
      'two processes can both believe they hold the write lock — the result is a corrupted ' +
      'database rather than an error. Move the data directory to a local disk.'
    );
  }
  return (
    `${name} is a shared or layered filesystem. It generally works, but it is slower and its ` +
    'locking is not the kernel’s own, so a local disk is better for anything long-lived.'
  );
}

async function typeFromMounts(path: string, probe: FsProbe): Promise<string | undefined> {
  // `probe.mounts()` is sorted longest mount point first, so the first containing mount is the
  // most specific one — which is what matters when `/` and `/mnt/nas` both contain the path.
  for (const mount of await probe.mounts()) {
    const contains =
      path === mount.mountPoint ||
      mount.mountPoint === '/' ||
      path.startsWith(`${mount.mountPoint}/`);
    if (contains) return mount.type;
  }
  return undefined;
}

/**
 * Look for sync markers at the path and in every parent.
 *
 * Parents matter: Syncthing's `.stfolder` sits at the *root* of the synced tree, so a data
 * directory three levels down inside it has no marker of its own. Walking up is the only way to
 * find the case that actually happens — somebody putting `./data` inside their Dropbox.
 */
async function findSyncMarkers(path: string, probe: FsProbe): Promise<readonly string[]> {
  const found: string[] = [];
  let current = path;
  for (;;) {
    const entries = new Set(await probe.entries(current));
    for (const marker of SYNC_MARKERS) {
      if (entries.has(marker)) found.push(join(current, marker));
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return found;
}
