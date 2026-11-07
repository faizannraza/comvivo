/**
 * The unlock-source order (`08` §3.7.5) and the master-key hygiene rules (`08` §3.7.3).
 *
 * The **order** is the security-relevant part, and the reason is specific: a host who sets
 * `COMVIVO_MASTER_KEY_FILE` must not have it silently ignored in favour of a stale `master.key`
 * left on the disk. That would mean the key they rotated *away from* is the one still in use — a
 * rotation that reported success and changed nothing.
 */
import { BRAND } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { isZeroed } from './key-service.js';
import {
  decodeMasterKey,
  disposeUnlock,
  isPassphraseRequired,
  MASTER_KEY_ENV,
  MASTER_KEY_FILE_ENV,
  PASSPHRASE_FILE_ENV,
  readPassphraseFile,
  resolveUnlock,
  UnlockError,
  type UnlockIo,
} from './unlock-sources.js';

const KEYFILE = '/data/keys/master.key';

/** A 32-byte key, as each encoding. */
const KEY = Buffer.alloc(32, 0x5a);
const KEY_B64URL = KEY.toString('base64url');
const KEY_HEX = KEY.toString('hex');

interface FakeWorld {
  readonly env?: Record<string, string>;
  readonly files?: Record<string, string>;
  readonly keychain?: string;
}

/** A fake world, recording which variables were deleted. */
function fakeIo(world: FakeWorld): UnlockIo & { readonly deleted: string[] } {
  const env = { ...world.env };
  const files = { ...world.files };
  const deleted: string[] = [];
  return {
    deleted,
    env(name) {
      return env[name];
    },
    deleteEnv(name) {
      deleted.push(name);
      delete env[name];
    },
    readFile(path) {
      const contents = files[path];
      return contents === undefined
        ? Promise.reject(new Error(`ENOENT ${path}`))
        : Promise.resolve(contents);
    },
    fileExists(path) {
      return Promise.resolve(files[path] !== undefined);
    },
    keychainGet() {
      return Promise.resolve(world.keychain);
    },
  };
}

describe('decodeMasterKey', () => {
  it.each([
    ['base64url', KEY_B64URL],
    ['base64', KEY.toString('base64')],
    ['hex', KEY_HEX],
    ['base64url with a trailing newline', `${KEY_B64URL}\n`],
    ['hex with surrounding whitespace', `  ${KEY_HEX}  `],
  ])('accepts a 256-bit key as %s', (_label, text) => {
    // Generous on encoding, strict on length. The alternative is a host who pasted hex being told
    // "malformed" with no idea which encoding was wanted, mid-outage.
    expect(decodeMasterKey(text).equals(KEY)).toBe(true);
  });

  it('refuses an empty value, naming the likely cause', () => {
    // An empty key file almost always means a secret was not mounted.
    try {
      decodeMasterKey('   ');
      expect.unreachable('an empty key should be refused');
    } catch (error) {
      expect((error as UnlockError).code).toBe('MASTER_KEY_MALFORMED');
      expect((error as UnlockError).hint).toContain('not mounted');
    }
  });

  it('refuses a key of the wrong length and reports the length, not the key', () => {
    // The input is a key. Echoing it would put it in a log, which is the thing `08` §3.10 forbids.
    const short = Buffer.alloc(16, 0xaa).toString('base64url');
    try {
      decodeMasterKey(short);
      expect.unreachable('a 16-byte key should be refused');
    } catch (error) {
      const failure = error as UnlockError;
      expect(failure.message).toContain('16 bytes');
      expect(failure.message).not.toContain(short);
      expect(failure.hint).toContain('43 base64url characters');
    }
  });

  it('refuses a 64-character string that is not hex', () => {
    // `08` §3.7.9 validates hex before interpolation; this is the same discipline one layer up. A
    // string of 64 `z`s decodes as base64 to the wrong length, and that is what refuses it.
    expect(() => decodeMasterKey('z'.repeat(64))).toThrow(UnlockError);
  });
});

describe('the resolution order (08 §3.7.5)', () => {
  it(`prefers ${MASTER_KEY_FILE_ENV} over everything else`, async () => {
    // The case that matters most. A host who mounted a secret has said which key to use; falling
    // back to a stale `master.key` would mean a rotation that changed nothing.
    const io = fakeIo({
      env: { [MASTER_KEY_FILE_ENV]: '/run/secrets/mk', [MASTER_KEY_ENV]: 'ignored' },
      files: { '/run/secrets/mk': KEY_B64URL, [KEYFILE]: 'also-ignored' },
      keychain: 'also-ignored-too',
    });
    const outcome = await resolveUnlock({ keyfilePath: KEYFILE, io });
    expect(isPassphraseRequired(outcome)).toBe(false);
    if (isPassphraseRequired(outcome)) return;
    expect(outcome.kind).toBe('file');
    expect(outcome.key.equals(KEY)).toBe(true);
  });

  it(`prefers ${MASTER_KEY_ENV} over the keyfile`, async () => {
    const io = fakeIo({
      env: { [MASTER_KEY_ENV]: KEY_B64URL },
      files: { [KEYFILE]: 'ignored' },
    });
    const outcome = await resolveUnlock({ keyfilePath: KEYFILE, io });
    if (isPassphraseRequired(outcome)) {
      expect.unreachable('a key was available');
    }
    expect(outcome.kind).toBe('env');
  });

  it('uses the keyfile when no environment variable is set', async () => {
    const io = fakeIo({ files: { [KEYFILE]: KEY_HEX } });
    const outcome = await resolveUnlock({ keyfilePath: KEYFILE, io });
    if (isPassphraseRequired(outcome)) {
      expect.unreachable('a keyfile was available');
    }
    expect(outcome.kind).toBe('keyfile');
    expect(outcome.detail).toBe(KEYFILE);
  });

  it('refuses rather than falling back when the named key file is unreadable', async () => {
    // The variable is set, so this is not a fallback situation. Quietly using a different key
    // would be the worst available behaviour: the instance opens, with the key the host thought
    // they had retired.
    const io = fakeIo({ env: { [MASTER_KEY_FILE_ENV]: '/run/secrets/missing' } });
    try {
      await resolveUnlock({ keyfilePath: KEYFILE, io });
      expect.unreachable('an unreadable named key file should be refused');
    } catch (error) {
      expect((error as UnlockError).code).toBe('MASTER_KEY_UNREADABLE');
      expect((error as UnlockError).hint).toContain('will not quietly use a different key');
    }
  });

  it('reads the keychain only when keychain mode is configured', async () => {
    // Probing it unasked would hang or warn on every headless Linux host, which `08` §3.7.3 says
    // is the majority of installs.
    const withKeychain = fakeIo({ keychain: KEY_B64URL, files: { [KEYFILE]: KEY_HEX } });
    const unconfigured = await resolveUnlock({ keyfilePath: KEYFILE, io: withKeychain });
    if (isPassphraseRequired(unconfigured)) {
      expect.unreachable('a keyfile was available');
    }
    expect(unconfigured.kind).toBe('keyfile');

    const configured = await resolveUnlock({
      keyfilePath: KEYFILE,
      configured: 'keychain',
      io: fakeIo({ keychain: KEY_B64URL }),
    });
    if (isPassphraseRequired(configured)) {
      expect.unreachable('the keychain had a key');
    }
    expect(configured.kind).toBe('keychain');
  });

  it('explains what to do when keychain mode is configured but empty', async () => {
    // The headless-Linux case, and the hint has to name the way out rather than just the problem.
    try {
      await resolveUnlock({ keyfilePath: KEYFILE, configured: 'keychain', io: fakeIo({}) });
      expect.unreachable('an empty keychain should be refused');
    } catch (error) {
      expect((error as UnlockError).code).toBe('MASTER_KEY_NOT_FOUND');
      expect((error as UnlockError).hint).toContain('headless Linux');
      expect((error as UnlockError).hint).toContain('--key-store keyfile');
    }
  });

  it('reports that a passphrase is needed rather than prompting', async () => {
    // A prompt needs a TTY, and this runs in the server, the CLI and tests. The caller decides how
    // to ask.
    const outcome = await resolveUnlock({
      keyfilePath: KEYFILE,
      configured: 'passphrase',
      io: fakeIo({}),
    });
    expect(isPassphraseRequired(outcome)).toBe(true);
    expect(outcome.kind).toBe('passphrase');
  });

  it('ignores the keyfile in passphrase mode, where there is no key at rest', async () => {
    // `08` §3.7.3's passphrase row: "no MK slot". A leftover `master.key` must not quietly
    // reinstate one, because the host chose a mode whose point is that the disk holds no key.
    const io = fakeIo({ files: { [KEYFILE]: KEY_HEX } });
    const outcome = await resolveUnlock({ keyfilePath: KEYFILE, configured: 'passphrase', io });
    expect(isPassphraseRequired(outcome)).toBe(true);
  });

  it('uses the passphrase file when one is pointed at', async () => {
    const io = fakeIo({ env: { [PASSPHRASE_FILE_ENV]: '/run/secrets/pp' } });
    const outcome = await resolveUnlock({ keyfilePath: KEYFILE, io });
    expect(isPassphraseRequired(outcome)).toBe(true);
    expect(outcome.detail).toBe('/run/secrets/pp');
  });

  it('lists every source it tried when it finds nothing', async () => {
    // A host reading this needs to know where to look, and whether this is a new install or a
    // broken one.
    try {
      await resolveUnlock({ keyfilePath: KEYFILE, io: fakeIo({}) });
      expect.unreachable('no source should mean no unlock');
    } catch (error) {
      const failure = error as UnlockError;
      expect(failure.code).toBe('MASTER_KEY_NOT_FOUND');
      expect(failure.hint).toContain(MASTER_KEY_FILE_ENV);
      expect(failure.hint).toContain(MASTER_KEY_ENV);
      expect(failure.hint).toContain(KEYFILE);
      expect(failure.hint).toContain(`${BRAND.cliName} keys recover`);
    }
  });

  it('treats an empty variable as unset, not as an empty key', async () => {
    // An unset variable and `COMVIVO_MASTER_KEY=` look the same in a compose file, and the second
    // is always a mistake. Falling through to the keyfile is more useful than refusing.
    const io = fakeIo({
      env: { [MASTER_KEY_ENV]: '', [MASTER_KEY_FILE_ENV]: '' },
      files: { [KEYFILE]: KEY_HEX },
    });
    const outcome = await resolveUnlock({ keyfilePath: KEYFILE, io });
    if (isPassphraseRequired(outcome)) {
      expect.unreachable('the keyfile should have been used');
    }
    expect(outcome.kind).toBe('keyfile');
  });
});

describe('master-key hygiene (08 §3.7.3)', () => {
  it(`deletes ${MASTER_KEY_ENV} from the environment after reading it`, async () => {
    // S9: a child process gets a copy of `process.env` at spawn time, and `/proc/<pid>/environ`
    // carries it for the life of the process. Reading once and deleting is what implements both.
    const io = fakeIo({ env: { [MASTER_KEY_ENV]: KEY_B64URL } });
    await resolveUnlock({ keyfilePath: KEYFILE, io });
    expect(io.deleted).toContain(MASTER_KEY_ENV);
  });

  it('deletes the key-file *path* too, so a child cannot be told where the key is', async () => {
    // The path is not secret, but S9 says children get nothing. Leaving it is a free hint.
    const io = fakeIo({
      env: { [MASTER_KEY_FILE_ENV]: '/run/secrets/mk' },
      files: { '/run/secrets/mk': KEY_B64URL },
    });
    await resolveUnlock({ keyfilePath: KEYFILE, io });
    expect(io.deleted).toContain(MASTER_KEY_FILE_ENV);
  });

  it('warns about env mode, because doctor has to say something', async () => {
    // `08` §3.7.3's table marks `env` a last resort. The warning is produced here because the only
    // moment anybody knows which source was used is the moment it is used.
    const io = fakeIo({ env: { [MASTER_KEY_ENV]: KEY_B64URL } });
    const outcome = await resolveUnlock({ keyfilePath: KEYFILE, io });
    if (isPassphraseRequired(outcome)) {
      expect.unreachable('a key was available');
    }
    expect(outcome.warning).toBeDefined();
    expect(outcome.warning).toContain('docker inspect');
    expect(outcome.warning).toContain(MASTER_KEY_FILE_ENV);
  });

  it('does not warn about the modes `08` §3.7.3 recommends', async () => {
    // A warning on every install teaches hosts to ignore warnings.
    for (const world of [
      { files: { [KEYFILE]: KEY_HEX } },
      { env: { [MASTER_KEY_FILE_ENV]: '/s/mk' }, files: { '/s/mk': KEY_HEX } },
    ]) {
      const outcome = await resolveUnlock({ keyfilePath: KEYFILE, io: fakeIo(world) });
      if (isPassphraseRequired(outcome)) continue;
      expect(outcome.warning).toBeUndefined();
    }
  });

  it('never puts the key in the detail field, which is logged', async () => {
    // `08` §3.7.5 step 5 logs `keys.unlocked {source, gen}` and says "no key material". `detail`
    // is what goes in that line.
    for (const world of [
      { env: { [MASTER_KEY_ENV]: KEY_B64URL } },
      { files: { [KEYFILE]: KEY_HEX } },
      { env: { [MASTER_KEY_FILE_ENV]: '/s/mk' }, files: { '/s/mk': KEY_HEX } },
    ]) {
      const outcome = await resolveUnlock({ keyfilePath: KEYFILE, io: fakeIo(world) });
      if (isPassphraseRequired(outcome)) continue;
      expect(outcome.detail).not.toContain(KEY_B64URL);
      expect(outcome.detail).not.toContain(KEY_HEX);
    }
  });

  it('zeroes the key on dispose', async () => {
    const io = fakeIo({ files: { [KEYFILE]: KEY_HEX } });
    const outcome = await resolveUnlock({ keyfilePath: KEYFILE, io });
    if (isPassphraseRequired(outcome)) {
      expect.unreachable('a key was available');
    }
    expect(isZeroed(outcome.key)).toBe(false);
    disposeUnlock(outcome);
    expect(isZeroed(outcome.key)).toBe(true);
  });

  it('disposes a passphrase outcome without complaint', async () => {
    const outcome = await resolveUnlock({
      keyfilePath: KEYFILE,
      configured: 'passphrase',
      io: fakeIo({}),
    });
    expect(() => disposeUnlock(outcome)).not.toThrow();
  });
});

describe('readPassphraseFile', () => {
  it('reads it and strips the trailing newline every editor adds', async () => {
    const io = fakeIo({ files: { '/s/pp': 'correct horse battery staple\n' } });
    expect(await readPassphraseFile('/s/pp', io)).toBe('correct horse battery staple');
  });

  it('strips a CRLF too, for a file written on Windows', async () => {
    const io = fakeIo({ files: { '/s/pp': 'passphrase\r\n' } });
    expect(await readPassphraseFile('/s/pp', io)).toBe('passphrase');
  });

  it('keeps internal whitespace, because a passphrase may contain it', async () => {
    // Trimming the whole string would silently change a passphrase that legitimately starts or
    // ends with a space, and the host would be locked out with no explanation.
    const io = fakeIo({ files: { '/s/pp': 'two  spaces inside\n' } });
    expect(await readPassphraseFile('/s/pp', io)).toBe('two  spaces inside');
  });

  it('refuses an empty file', async () => {
    const io = fakeIo({ files: { '/s/pp': '\n' } });
    await expect(readPassphraseFile('/s/pp', io)).rejects.toThrow(/empty/);
  });

  it('refuses a file it cannot read', async () => {
    await expect(readPassphraseFile('/s/missing', fakeIo({}))).rejects.toThrow(/could not be read/);
  });
});
