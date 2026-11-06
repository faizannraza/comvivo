/**
 * `sec.keys.*` — the keyring store, including crash-resume via fault injection
 * (`M1-T5` AC, `08` §3.7.4, `12` §3.7).
 *
 * The question every test here answers is: **after this failure, can the host still open their
 * data?** A keyring write that loses the old file before the new one lands is not a bug that
 * degrades a feature; it is a bug that ends the instance. So the write sequence is tested by
 * failing at each of its five steps and checking what is on disk afterwards.
 *
 * The fault injector is in `testing/fake-io.ts`, and it exists because these states are not
 * reachable through a real filesystem on purpose.
 */
import { BRAND } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { type Keyring, KeyringError, parseKeyring, serialiseKeyring } from './keyring.js';
import {
  isGroupOrWorldReadable,
  isGroupOrWorldWritable,
  KEY_DIR_MODE,
  KEY_FILE_MODE,
  KeyPermissionError,
  KeyringStore,
} from './keyring-store.js';
import { FakeKeyringIo, type FaultPoint, InjectedFault } from './testing/fake-io.js';
import { buildKeyring } from './testing/keyring-fixture.js';

const KEYS_DIR = '/data/keys';

function store(io: FakeKeyringIo): KeyringStore {
  return new KeyringStore(KEYS_DIR, io);
}

/** What is on disk, as parsed keyrings, so a test asserts on meaning rather than on bytes. */
function onDisk(io: FakeKeyringIo): {
  live: Keyring | undefined;
  previous: Keyring | undefined;
  temp: string | undefined;
} {
  const read = (name: string): Keyring | undefined => {
    const entry = io.files.get(`${KEYS_DIR}/${name}`);
    return entry === undefined ? undefined : parseKeyring(entry.contents);
  };
  return {
    live: read('keyring.json'),
    previous: read('keyring.json.prev'),
    temp: io.files.get(`${KEYS_DIR}/keyring.json.tmp`)?.contents,
  };
}

describe('writing a keyring', () => {
  it('writes it where a reader will find it', async () => {
    const io = new FakeKeyringIo();
    const { keyring } = buildKeyring();
    await store(io).write(keyring);
    expect(onDisk(io).live).toEqual(keyring);
  });

  it('follows `08` §3.7.4’s sequence: temp, fsync, rename, fsync the directory', async () => {
    // Asserted as an ordered sequence rather than as a set of calls, because the order *is* the
    // durability guarantee. An fsync after the rename, or a rename before the fsync, both produce
    // a correctly-named keyring whose bytes may not have reached the device.
    const io = new FakeKeyringIo();
    const { keyring } = buildKeyring();
    await store(io).write(keyring);

    const relevant = io.calls.filter(
      (call) =>
        call.startsWith('writeFile') ||
        call.startsWith('syncFile') ||
        call.startsWith('rename') ||
        call.startsWith('syncDirectory'),
    );
    expect(relevant).toEqual([
      `writeFile ${KEYS_DIR}/keyring.json.tmp`,
      `syncFile ${KEYS_DIR}/keyring.json.tmp`,
      `rename ${KEYS_DIR}/keyring.json.tmp -> ${KEYS_DIR}/keyring.json`,
      `syncDirectory ${KEYS_DIR}`,
    ]);
  });

  it('preserves the old keyring as `.prev` before replacing it', async () => {
    const io = new FakeKeyringIo();
    const first = buildKeyring({ gen: 1 }).keyring;
    const second = buildKeyring({ gen: 2 }).keyring;
    const subject = store(io);
    await subject.write(first);
    await subject.write(second);

    const state = onDisk(io);
    expect(state.live?.current).toBe(2);
    expect(state.previous?.current).toBe(1);
  });

  it('moves the old file aside before the new one lands, never the other way round', async () => {
    // The ordering that matters: there must be no moment with neither a keyring nor a previous
    // keyring on disk. Renaming the temp file into place first and then copying would leave that
    // window.
    const io = new FakeKeyringIo();
    const subject = store(io);
    await subject.write(buildKeyring({ gen: 1 }).keyring);
    io.calls.length = 0;
    await subject.write(buildKeyring({ gen: 2 }).keyring);

    const renames = io.calls.filter((call) => call.startsWith('rename'));
    expect(renames).toEqual([
      `rename ${KEYS_DIR}/keyring.json -> ${KEYS_DIR}/keyring.json.prev`,
      `rename ${KEYS_DIR}/keyring.json.tmp -> ${KEYS_DIR}/keyring.json`,
    ]);
  });

  it('creates the key directory with 0700 and the file with 0600', async () => {
    // `12` §3.7. A keyring written 0644 is a keyring every local user can copy, and the window
    // between creation and a later `chmod` is exactly when a host is least watching.
    const io = new FakeKeyringIo();
    await store(io).write(buildKeyring().keyring);
    expect(io.directories.get(KEYS_DIR)).toBe(KEY_DIR_MODE);
    expect(io.files.get(`${KEYS_DIR}/keyring.json`)?.mode).toBe(KEY_FILE_MODE);
  });

  it('validates before touching the disk, because the old file is about to be replaced', async () => {
    // A keyring assembled in memory can break the schema's cross-field rules. The only safe moment
    // to find out is before the previous file has been moved — after that, a refusal has eaten the
    // one copy that worked.
    const io = new FakeKeyringIo();
    const subject = store(io);
    const good = buildKeyring({ gen: 1 }).keyring;
    await subject.write(good);
    io.calls.length = 0;

    const broken: Keyring = { ...good, current: 99 };
    await expect(subject.write(broken)).rejects.toThrow(KeyringError);

    // Nothing was written, nothing was renamed, and the good keyring is still live.
    expect(io.calls.filter((call) => call.startsWith('rename'))).toEqual([]);
    expect(onDisk(io).live).toEqual(good);
  });
});

describe('crash-resume: a fault at each step of the write', () => {
  /**
   * Each case fails one step and then asks the only question that matters: **is there still a
   * keyring the host can open?**
   *
   * `expectLive` says which generation should be readable at `keyring.json` afterwards, or `prev`
   * when the live file is gone and `.prev` is the survivor — which is `08` §3.7.4's whole reason
   * for keeping it.
   */
  const cases: readonly {
    readonly point: FaultPoint;
    readonly expect: 'old-still-live' | 'old-in-prev';
    readonly why: string;
  }[] = [
    {
      point: 'writeFile',
      expect: 'old-still-live',
      why: 'nothing had been touched yet',
    },
    {
      point: 'syncFile',
      expect: 'old-still-live',
      why: 'only the temp file existed, and it is not the live keyring',
    },
    {
      point: 'renameToPrevious',
      expect: 'old-still-live',
      why: 'the old file had not moved, so it is still exactly where a reader looks',
    },
    {
      point: 'renameTempIntoPlace',
      expect: 'old-in-prev',
      why: 'the old file had already moved to `.prev`, which is why `.prev` exists',
    },
    {
      point: 'syncDirectory',
      expect: 'old-in-prev',
      why: 'the new keyring is in place; only its durability is in question',
    },
  ];

  it.each(cases)(
    'a fault at $point leaves the host able to open their data ($why)',
    async ({ point, expect: expectation }) => {
      const io = new FakeKeyringIo();
      const subject = store(io);
      const old = buildKeyring({ gen: 1 }).keyring;
      await subject.write(old);

      io.armFault(point);
      const next = buildKeyring({ gen: 2 }).keyring;
      const outcome = await subject.write(next).then(
        () => 'resolved' as const,
        (error: unknown) => error,
      );

      if (point === 'syncDirectory') {
        // The rename succeeded, so this is a durability question rather than a correctness one: the
        // new keyring IS in place. The write still reports the failure, because a caller that was
        // told "rotated" must not believe it survived a power cut.
        expect(outcome).toBeInstanceOf(InjectedFault);
        expect(onDisk(io).live?.current).toBe(2);
        expect(onDisk(io).previous?.current).toBe(1);
        return;
      }

      expect(outcome).toBeInstanceOf(InjectedFault);
      const state = onDisk(io);
      if (expectation === 'old-still-live') {
        expect(state.live?.current, point).toBe(1);
      } else {
        // The live file is gone and `.prev` is the survivor. A host recovers by moving it back,
        // which is what the `KEYRING_MISSING` hint tells them to do.
        expect(state.live, point).toBeUndefined();
        expect(state.previous?.current, point).toBe(1);
      }
    },
  );

  it('never leaves both the live keyring and `.prev` missing', async () => {
    // The one outcome that would be unrecoverable. Checked across every fault point in one test,
    // because it is the invariant rather than a per-step expectation.
    const points: readonly FaultPoint[] = [
      'writeFile',
      'syncFile',
      'renameToPrevious',
      'renameTempIntoPlace',
      'syncDirectory',
    ];
    for (const point of points) {
      const io = new FakeKeyringIo();
      const subject = store(io);
      await subject.write(buildKeyring({ gen: 1 }).keyring);
      io.armFault(point);
      await subject.write(buildKeyring({ gen: 2 }).keyring).catch(() => undefined);

      const state = onDisk(io);
      expect(
        state.live !== undefined || state.previous !== undefined,
        `a fault at ${point} left no openable keyring at all`,
      ).toBe(true);
    }
  });

  it('recovers on the next attempt after any fault', async () => {
    // A one-shot fault, then a clean write. This is what "crash-resume" means operationally: the
    // host restarts, the rotation is retried, and it works.
    const points: readonly FaultPoint[] = [
      'writeFile',
      'syncFile',
      'renameToPrevious',
      'renameTempIntoPlace',
      'syncDirectory',
    ];
    for (const point of points) {
      const io = new FakeKeyringIo();
      const subject = store(io);
      await subject.write(buildKeyring({ gen: 1 }).keyring);
      io.armFault(point);
      await subject.write(buildKeyring({ gen: 2 }).keyring).catch(() => undefined);

      // The fault is spent; retry.
      const retried = buildKeyring({ gen: 3 }).keyring;
      await subject.write(retried);
      expect(onDisk(io).live?.current, `after a fault at ${point}`).toBe(3);
    }
  });

  it('leaves a stale temp file that `clearTemp` removes at boot', async () => {
    // Harmless — the atomic rename means it was never live — but a host reading the directory
    // during an emergency should not find a file whose provenance nobody knows.
    const io = new FakeKeyringIo();
    const subject = store(io);
    await subject.write(buildKeyring({ gen: 1 }).keyring);
    io.armFault('renameToPrevious');
    await subject.write(buildKeyring({ gen: 2 }).keyring).catch(() => undefined);

    expect(onDisk(io).temp).toBeDefined();
    expect(await subject.clearTemp()).toBe(true);
    expect(onDisk(io).temp).toBeUndefined();
    // And it is a no-op when there is nothing to clear.
    expect(await subject.clearTemp()).toBe(false);
  });
});

describe('reading a keyring', () => {
  it('reads what was written', async () => {
    const io = new FakeKeyringIo();
    const { keyring } = buildKeyring();
    const subject = store(io);
    await subject.write(keyring);
    expect(await subject.read()).toEqual(keyring);
  });

  it('reports a missing keyring with a hint that distinguishes new from broken', async () => {
    // "Run `comvivo init`" and "your key directory is gone" need different reactions, and a host
    // who reads the wrong one either wipes a working install or waits for a fix that is not coming.
    const io = new FakeKeyringIo();
    try {
      await store(io).read();
      expect.unreachable('a missing keyring should be refused');
    } catch (error) {
      expect((error as KeyringError).code).toBe('KEYRING_MISSING');
      expect((error as KeyringError).hint).toContain(`${BRAND.cliName} init`);
      expect((error as KeyringError).hint).toContain('permissions');
    }
  });

  it('reads `.prev` for the recovery path', async () => {
    const io = new FakeKeyringIo();
    const subject = store(io);
    await subject.write(buildKeyring({ gen: 1 }).keyring);
    await subject.write(buildKeyring({ gen: 2 }).keyring);
    expect((await subject.readPrevious()).current).toBe(1);
  });

  it('says plainly that there may legitimately be no `.prev`', async () => {
    // It is kept only until the next successful boot, so "absent" is a normal state and the hint
    // must not imply something is wrong.
    const io = new FakeKeyringIo();
    const subject = store(io);
    await subject.write(buildKeyring().keyring);
    try {
      await subject.readPrevious();
      expect.unreachable('there is no previous keyring');
    } catch (error) {
      expect((error as KeyringError).hint).toContain('legitimately be none');
    }
  });

  it('refuses a truncated keyring rather than reporting a wrong key', async () => {
    // The failure mode this guards: a half-written file that parses loosely would look openable,
    // and the host would be told the key is wrong — sending them after a key problem they do not
    // have, during an outage.
    const io = new FakeKeyringIo();
    const { keyring } = buildKeyring();
    const text = serialiseKeyring(keyring);
    io.seed(`${KEYS_DIR}/keyring.json`, text.slice(0, Math.floor(text.length / 2)));
    await expect(store(io).read()).rejects.toThrow(KeyringError);
  });

  it('reports whether a keyring exists without reading it', async () => {
    const io = new FakeKeyringIo();
    const subject = store(io);
    expect(await subject.exists()).toBe(false);
    await subject.write(buildKeyring().keyring);
    expect(await subject.exists()).toBe(true);
  });
});

describe('permission bits', () => {
  it.each([
    [0o600, false],
    [0o700, false],
    [0o640, true],
    [0o604, true],
    [0o644, true],
    [0o660, true],
  ])('mode %s group-or-world readable: %s', (mode, expected) => {
    expect(isGroupOrWorldReadable(mode)).toBe(expected);
  });

  it.each([
    [0o600, false],
    [0o620, true],
    [0o602, true],
    [0o666, true],
  ])('mode %s group-or-world writable: %s', (mode, expected) => {
    expect(isGroupOrWorldWritable(mode)).toBe(expected);
  });
});

describe('the key permission audit (08 §3.7.3)', () => {
  const linux = { platform: 'linux' } as const;

  it('refuses to start when a key file is readable by other users', async () => {
    // Another local user can already read the key. Starting anyway would be pretending otherwise,
    // and `08` §3.7.3 is explicit: refuse with exit 78.
    const io = new FakeKeyringIo();
    io.seedDirectory(KEYS_DIR, 0o700);
    io.seed(`${KEYS_DIR}/master.key`, 'x', 0o644);
    await expect(store(io).auditPermissions(['master.key'], linux)).rejects.toThrow(
      KeyPermissionError,
    );
  });

  it('refuses when the keys directory itself is readable', async () => {
    // A readable `keys/` leaks the *names* of the key files, which on most systems says which
    // unlock modes are in use.
    const io = new FakeKeyringIo();
    io.seedDirectory(KEYS_DIR, 0o755);
    await expect(store(io).auditPermissions([], linux)).rejects.toThrow(KeyPermissionError);
  });

  it('names every offending path and its mode, so one run fixes everything', async () => {
    const io = new FakeKeyringIo();
    io.seedDirectory(KEYS_DIR, 0o750);
    io.seed(`${KEYS_DIR}/master.key`, 'x', 0o640);
    io.seed(`${KEYS_DIR}/keyring.json`, 'x', 0o644);
    try {
      await store(io).auditPermissions(['master.key', 'keyring.json'], linux);
      expect.unreachable('readable key material should be refused');
    } catch (error) {
      const failure = error as KeyPermissionError;
      expect(failure.findings).toHaveLength(3);
      expect(failure.message).toContain('master.key');
      expect(failure.message).toContain('keyring.json');
      expect(failure.message).toContain('0640');
      expect(failure.hint).toContain('chmod 600');
      expect(failure.hint).toContain('--insecure-permissions');
    }
  });

  it('allows it through with --insecure-permissions, ssh-style', async () => {
    // `08` §3.7.3 offers the escape hatch deliberately: a host who has decided their machine is
    // safe should not be locked out of their own data by a mode bit.
    const io = new FakeKeyringIo();
    io.seedDirectory(KEYS_DIR, 0o700);
    io.seed(`${KEYS_DIR}/master.key`, 'x', 0o644);
    const result = await store(io).auditPermissions(['master.key'], {
      ...linux,
      allowInsecure: true,
    });
    expect(result.refused).toHaveLength(1);
  });

  it('tightens a file that is private but not exactly 0600, and says so', async () => {
    // A stray execute bit: nobody else can read it, the host did not choose it, and there is one
    // right answer. `12` §3.7 says fix it and warn rather than refuse.
    const io = new FakeKeyringIo();
    io.seedDirectory(KEYS_DIR, 0o700);
    io.seed(`${KEYS_DIR}/master.key`, 'x', 0o700);
    const result = await store(io).auditPermissions(['master.key'], linux);
    expect(result.refused).toEqual([]);
    expect(result.tightened).toEqual([`${KEYS_DIR}/master.key`]);
    expect(io.files.get(`${KEYS_DIR}/master.key`)?.mode).toBe(KEY_FILE_MODE);
  });

  it('leaves an already-correct file alone', async () => {
    const io = new FakeKeyringIo();
    io.seedDirectory(KEYS_DIR, 0o700);
    io.seed(`${KEYS_DIR}/master.key`, 'x', 0o600);
    const result = await store(io).auditPermissions(['master.key'], linux);
    expect(result).toEqual({ refused: [], tightened: [] });
    expect(io.calls.filter((call) => call.startsWith('chmod'))).toEqual([]);
  });

  it('ignores files that are not there', async () => {
    // The audit runs over every file `12` §3.7 lists, and most installs have only some of them —
    // no vault, no appliance secrets. A missing file is not a finding.
    const io = new FakeKeyringIo();
    io.seedDirectory(KEYS_DIR, 0o700);
    const result = await store(io).auditPermissions(
      ['master.key', 'keyring.json', 'vault.enc', 'secrets.enc', 'control.token'],
      linux,
    );
    expect(result).toEqual({ refused: [], tightened: [] });
  });

  it('skips the check on Windows, where these bits do not mean what they say', async () => {
    // `08` §3.7.3. A POSIX mode on Windows is synthesised and would refuse every install.
    const io = new FakeKeyringIo();
    io.seedDirectory(KEYS_DIR, 0o777);
    io.seed(`${KEYS_DIR}/master.key`, 'x', 0o666);
    const result = await store(io).auditPermissions(['master.key'], { platform: 'win32' });
    expect(result).toEqual({ refused: [], tightened: [] });
  });

  it('falls back to the real platform when none is given', async () => {
    // The default every caller actually uses — `comvivo doctor` does not pass a platform. Covered
    // because the parameter exists only so a test can force the *other* branch, and a default
    // nothing exercises is how the audit could silently become a no-op everywhere.
    const io = new FakeKeyringIo();
    io.seedDirectory(KEYS_DIR, 0o700);
    io.seed(`${KEYS_DIR}/master.key`, 'x', 0o666);

    const audit = store(io).auditPermissions(['master.key']);

    if (process.platform === 'win32') {
      expect(await audit).toEqual({ refused: [], tightened: [] });
    } else {
      await expect(audit).rejects.toThrow(KeyPermissionError);
    }
  });
});

describe('store paths', () => {
  it('names the three files `08` §3.7.4 uses', () => {
    const subject = store(new FakeKeyringIo());
    expect(subject.path).toBe(`${KEYS_DIR}/keyring.json`);
    expect(subject.previousPath).toBe(`${KEYS_DIR}/keyring.json.prev`);
    expect(subject.tempPath).toBe(`${KEYS_DIR}/keyring.json.tmp`);
  });

  it('exposes the directory and its parent, for the `M1-T7` data-dir audit', () => {
    const subject = store(new FakeKeyringIo());
    expect(subject.directory).toBe(KEYS_DIR);
    expect(subject.parentDirectory).toBe('/data');
  });

  it('keeps the temp file in the same directory, so the rename stays atomic', () => {
    // A `rename` across filesystems is a copy and is not atomic. Putting the temp file in the
    // system temp directory would be the obvious tidy choice and would quietly remove the entire
    // durability guarantee.
    const subject = store(new FakeKeyringIo());
    expect(subject.tempPath.startsWith(`${KEYS_DIR}/`)).toBe(true);
  });
});
