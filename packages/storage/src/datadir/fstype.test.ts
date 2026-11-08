/**
 * The filesystem check (`12` §3.7).
 *
 * The probe is injected, because the whole point is to behave correctly on filesystems this
 * machine does not have. A test that could only check the verdict for the filesystem it happens to
 * be running on would verify nothing about NFS — which is the case that matters, and the case that
 * corrupts databases.
 *
 * `12` §3.7's rule is **warn at boot, error in doctor** — never refuse. A host who has deliberately
 * put their data on a NAS should be told clearly and often; a product that refused to start would
 * send them to an issue tracker instead of to a local disk.
 */
import { describe, expect, it } from 'vitest';
import { checkFilesystem, type FsProbe, MAGIC_TYPES, nodeFsProbe } from './fstype.js';

/** A probe that states a filesystem rather than needing one. */
function probe(
  options: {
    readonly type?: string;
    readonly magic?: number;
    readonly mountPoint?: string;
    readonly markersAt?: Readonly<Record<string, readonly string[]>>;
    /**
     * Defaults to `linux`, because the `statfs` number means a Linux magic there and a darwin type
     * index on macOS, and most cases here are stated as magics from `linux/magic.h`.
     */
    readonly platform?: string;
  } = {},
): FsProbe {
  return {
    platform: options.platform ?? 'linux',
    magic: () => Promise.resolve(options.magic),
    mounts: () =>
      Promise.resolve(
        options.type === undefined
          ? []
          : [{ mountPoint: options.mountPoint ?? '/', type: options.type }],
      ),
    entries: (path: string) => Promise.resolve(options.markersAt?.[path] ?? []),
  };
}

describe('unsafe filesystems (12 §3.7)', () => {
  it.each(['nfs', 'nfs4', 'cifs', 'smb2', 'smbfs', '9p', 'fuse.sshfs'])(
    'calls %s unsafe, because SQLite locking is not reliable there',
    async (type) => {
      const check = await checkFilesystem('/data', probe({ type }));
      expect(check.verdict).toBe('unsafe');
      expect(check.type).toBe(type);
      expect(check.reason).toContain('file locking');
    },
  );

  it('explains the consequence, not only the cause', async () => {
    // The sentence a host acts on. "Locking is unreliable" means nothing; "two processes can both
    // believe they hold the write lock, and the result is a corrupted database rather than an
    // error" is what makes somebody move their data directory.
    const check = await checkFilesystem('/data', probe({ type: 'nfs4' }));
    expect(check.reason).toContain('corrupted');
    expect(check.reason).toContain('local disk');
  });
});

describe('filesystems that only warn', () => {
  it('warns about fuse.virtiofs rather than refusing, because Docker Desktop uses it', async () => {
    // `12` §3.7 names this one explicitly. It is how Docker Desktop shares files on macOS and
    // Windows, and it works — so treating it as unsafe would make the product look broken on the
    // two platforms most new hosts try first.
    const check = await checkFilesystem('/data', probe({ type: 'fuse.virtiofs' }));
    expect(check.verdict).toBe('warn');
    expect(check.reason).toContain('generally works');
  });

  it('warns about an overlay filesystem', async () => {
    const check = await checkFilesystem('/data', probe({ type: 'overlay' }));
    expect(check.verdict).toBe('warn');
  });

  it('warns about a FUSE filesystem it has never heard of', async () => {
    // Unknown FUSE: works often enough not to call unsafe, unusual enough to mention.
    const check = await checkFilesystem('/data', probe({ type: 'fuse.somethingnew' }));
    expect(check.verdict).toBe('warn');
  });
});

describe('ordinary filesystems', () => {
  it.each(['ext4', 'xfs', 'btrfs', 'zfs', 'apfs', 'tmpfs'])('is happy with %s', async (type) => {
    const check = await checkFilesystem('/data', probe({ type }));
    expect(check.verdict).toBe('ok');
    expect(check.reason).toBe('');
  });

  it('warns rather than passing when it cannot tell at all', async () => {
    // This test used to assert `verdict === 'ok'` for an undetermined filesystem, which is the
    // same defect as the 9p magic bug wearing different clothes: not knowing, reported as fine.
    // On darwin there is no `/proc/mounts` and only two `statfs` indices are measured, so an SMB
    // or NFS data directory — the case `12` §3.7 exists for — came back clean. Found by the M1
    // independent review.
    //
    // `12` §3.7's rule is warn at boot and error in `doctor`, never refuse, so an undetermined
    // type belongs on the warning side of that line and not the passing side.
    const check = await checkFilesystem('/data', probe());
    expect(check.type).toBeUndefined();
    expect(check.verdict).toBe('unknown');
    expect(check.reason).toContain('could not be determined');
    // Says what to do about it, like every other reason here.
    expect(check.reason).toContain('local disk');
  });
});

describe('resolving the type', () => {
  it('prefers the mount table, which can tell two FUSE filesystems apart', async () => {
    // The reason both sources exist. The FUSE magic number is one value for every FUSE filesystem,
    // so `fuse.sshfs` (unsafe) and `fuse.virtiofs` (fine) are indistinguishable by magic alone —
    // and `12` §3.7 gives them opposite verdicts.
    const sshfs = await checkFilesystem('/data', probe({ type: 'fuse.sshfs', magic: 0x65735546 }));
    const virtiofs = await checkFilesystem(
      '/data',
      probe({ type: 'fuse.virtiofs', magic: 0x65735546 }),
    );

    expect(sshfs.verdict).toBe('unsafe');
    expect(virtiofs.verdict).toBe('warn');
    expect(sshfs.magic).toBe(virtiofs.magic);
  });

  it('falls back to the magic number where there is no mount table', async () => {
    // macOS has no `/proc/mounts`, and neither does a minimal container.
    const check = await checkFilesystem('/data', probe({ magic: 0x6969 }));
    expect(check.type).toBe('nfs');
    expect(check.verdict).toBe('unsafe');
  });

  it('reports the magic in hex even when it recognises nothing', async () => {
    // So a host on an exotic filesystem can report a number somebody can look up, rather than
    // "unknown".
    const check = await checkFilesystem('/data', probe({ magic: 0x1234_5678 }));
    expect(check.magic).toBe('0x12345678');
    expect(check.type).toBeUndefined();
  });

  it('picks the most specific mount for a nested path', async () => {
    // A data directory inside a mount inside `/`. The longest matching mount point wins, which is
    // the only reading that can ever be right.
    const nested: FsProbe = {
      platform: 'linux',
      magic: () => Promise.resolve(undefined),
      mounts: () =>
        Promise.resolve([
          { mountPoint: '/mnt/nas', type: 'nfs4' },
          { mountPoint: '/', type: 'ext4' },
        ]),
      entries: () => Promise.resolve([]),
    };
    expect((await checkFilesystem('/mnt/nas/app-data', nested)).type).toBe('nfs4');
    expect((await checkFilesystem('/var/lib/x', nested)).type).toBe('ext4');
  });

  it('does not match a mount point that is only a string prefix', async () => {
    // `/mnt/nasty` is not inside `/mnt/nas`. A naive `startsWith` would say it was, and would then
    // report an ext4 directory as unsafe.
    const nested: FsProbe = {
      platform: 'linux',
      magic: () => Promise.resolve(undefined),
      mounts: () =>
        Promise.resolve([
          { mountPoint: '/mnt/nas', type: 'nfs4' },
          { mountPoint: '/', type: 'ext4' },
        ]),
      entries: () => Promise.resolve([]),
    };
    expect((await checkFilesystem('/mnt/nasty/data', nested)).type).toBe('ext4');
  });
});

describe('sync-folder markers (12 §3.7)', () => {
  it('calls a directory inside a sync folder unsafe', async () => {
    const check = await checkFilesystem(
      '/home/me/Dropbox/app-data',
      probe({ type: 'ext4', markersAt: { '/home/me/Dropbox/app-data': ['.dropbox'] } }),
    );
    expect(check.verdict).toBe('unsafe');
    expect(check.syncMarkers).toEqual(['/home/me/Dropbox/app-data/.dropbox']);
    expect(check.reason).toContain('sync folder');
  });

  it('finds a marker in a parent, which is where Syncthing puts it', async () => {
    // `.stfolder` sits at the **root** of the synced tree, so a data directory three levels down
    // has no marker of its own. Walking up is the only way to find the case that happens: somebody
    // putting `./data` inside their synced folder.
    const check = await checkFilesystem(
      '/home/me/sync/apps/app-data/data',
      probe({ type: 'ext4', markersAt: { '/home/me/sync': ['.stfolder'] } }),
    );
    expect(check.verdict).toBe('unsafe');
    expect(check.syncMarkers).toEqual(['/home/me/sync/.stfolder']);
  });

  it('explains that a sync client replicates a half-written WAL', async () => {
    // The specific mechanism, because "do not put it in Dropbox" without a reason reads as
    // superstition and gets ignored.
    const check = await checkFilesystem(
      '/d',
      probe({ type: 'ext4', markersAt: { '/d': ['.stfolder'] } }),
    );
    expect(check.reason).toContain('write-ahead log');
    expect(check.reason).toContain('backup');
  });

  it('finds no markers in an ordinary directory', async () => {
    const check = await checkFilesystem('/var/lib/app-data', probe({ type: 'ext4' }));
    expect(check.syncMarkers).toEqual([]);
    expect(check.verdict).toBe('ok');
  });

  it('terminates at the filesystem root rather than looping', async () => {
    // The walk goes up until `dirname` stops changing. Asserted because an off-by-one here is an
    // infinite loop at boot, which is the worst possible place for one.
    const check = await checkFilesystem('/', probe({ type: 'ext4' }));
    expect(check.verdict).toBe('ok');
  });
});

describe('every magic number resolves (12 §3.7)', () => {
  // The table exists for exactly one situation: no readable mount table, so the magic number is
  // the only evidence. These cases therefore give the probe a magic and **no** mount entry, which
  // is what makes them able to fail — a test that also supplied the type would be answered by
  // `typeFromMounts` and would never touch the table.
  //
  // This is the test that was missing. `MAGIC_TYPES` was keyed by `'0x…'` strings and looked up
  // with `toString(16)`, which emits no leading zero, so the `9p` entry spelled `'0x01021997'` was
  // unreachable — an `UNSAFE_TYPES` filesystem with broken SQLite locking reported `ok`. Every
  // other entry happened to be spelled without a leading zero and worked, which is why fifteen
  // entries and one bug looked identical from the outside.
  it.each(Object.entries(MAGIC_TYPES).map(([magic, name]) => ({ magic: Number(magic), name })))(
    'reads magic $magic as $name',
    async ({ magic, name }) => {
      const check = await checkFilesystem('/data', probe({ magic }));
      expect(check.type).toBe(name);
    },
  );

  it('covers every entry, so the loop above cannot be emptied', () => {
    // `it.each([])` runs no cases and passes, so a table that lost its entries would look green.
    expect(Object.keys(MAGIC_TYPES)).toHaveLength(15);
  });

  it('calls a 9p mount unsafe from its magic alone', async () => {
    // The regression, pinned on its own: 9p is WSL2's `/mnt/c` and QEMU virtfs, neither of which
    // has a mount table a container can read, and both of which lose writes under SQLite locking.
    const check = await checkFilesystem('/data', probe({ magic: 0x01021997 }));
    expect(check.type).toBe('9p');
    expect(check.verdict).toBe('unsafe');
    expect(check.reason).toContain('9p');
  });
});

describe('the real probe', { tags: ['slow'] }, () => {
  it('answers for the directory this test is running in', async () => {
    // Not an assertion about *which* filesystem — that varies by machine and by CI runner. What is
    // asserted is that the real probe runs without throwing and produces a verdict, because the
    // injected-probe tests above cannot show that `statfs` and `/proc/mounts` are read correctly.
    const check = await checkFilesystem(process.cwd(), nodeFsProbe);
    expect(['ok', 'warn', 'unsafe']).toContain(check.verdict);
    expect(check.path).toBe(process.cwd());
    // A checkout is on a real local filesystem on every machine this runs on, so a `magic` is
    // always available even where there is no mount table.
    expect(check.magic).toBeDefined();
  });

  it('never throws, whatever it is pointed at', async () => {
    // Advice must not be able to stop a boot. A path that does not exist is the easy case; the
    // reason this matters is a kernel that refuses `statfs` on some mount.
    //
    // `unknown` rather than `ok`: `statfs` fails on a path that is not there, so the honest answer
    // is that the filesystem could not be determined. The assertion here is about **not
    // throwing**, so it names the whole union rather than one member — the previous version
    // asserted `ok`, which tied this test to the bug in `verdictFor` rather than to its own
    // subject.
    const check = await checkFilesystem('/definitely/not/a/path/at/all', nodeFsProbe);
    expect(['ok', 'warn', 'unsafe', 'unknown']).toContain(check.verdict);

    // The verdict for a path that does not exist is **platform-dependent**, and asserting one
    // value was wrong: `/proc/mounts` matches by path prefix rather than by existence, so on Linux
    // the root mount still answers and the type is determined. Only where there is no readable
    // mount table does `statfs` failing leave nothing to go on. Found by CI — this assertion
    // passed on darwin and failed on the Node-floor job, which is exactly the kind of claim a
    // single-platform measurement produces.
    if (process.platform === 'linux') {
      expect(check.type).toBeTypeOf('string');
      expect(check.verdict).not.toBe('unknown');
    } else if (process.platform === 'darwin') {
      expect(check.verdict).toBe('unknown');
    }
  });

  it('determines the type of a local checkout on this platform', async () => {
    // `M1-T7`'s acceptance criterion is "FS-type check on Linux **and macOS**", and on darwin it
    // could not work at all: `MAGIC_TYPES` holds Linux `linux/magic.h` constants and macOS's
    // `f_type` is a small type index, so nothing ever matched and every verdict came from the
    // sync-marker check alone. Measured here instead of assumed: a repository checkout is on a
    // local filesystem on every machine this suite runs on, so the type must resolve to a name.
    const check = await checkFilesystem(process.cwd(), nodeFsProbe);
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      // Some other Unix: neither table applies and `unknown` is the correct, documented answer.
      expect(check.verdict).toBe('unknown');
      return;
    }
    expect(
      check.type,
      `no filesystem name for ${check.magic ?? 'an unreadable statfs'}`,
    ).toBeTypeOf('string');
    expect(check.verdict).not.toBe('unknown');
  });
});
