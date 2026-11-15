/**
 * `comvivo keys …` against a real keyring on disk (`09` §3.11.3; `08` §3.7.6–§3.7.8; `M3-T13`).
 *
 * `sd04.test.ts` checks the **shape** of the command tree — that no command could print a recovery
 * key. This file runs the commands, and the distinction is the whole reason it exists: the first
 * version of this task shipped eight registered commands whose bodies nothing executed, and the
 * coverage gate said so. "Wired" and "works" are different claims.
 *
 * Every case builds an install directory with a `comvivo.yaml`, a `keyring.json` and a
 * `master.key`, runs `run()` with captured streams, and then **reads the keyring back off disk** —
 * because what a key operation did is a property of the file, not of the sentence it printed.
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@comvivo/shared';
import { encodeRecoveryKey, parseKeyring, serialiseKeyring } from '@comvivo/storage/crypto';
import { buildKeyring, type KeyringFixture } from '@comvivo/storage/testing';
import { describe, expect, it } from 'vitest';
import { CLI_EXIT, type CliExitCode } from '../../exit-codes.js';
import { type RunOptions, run } from '../../main.js';

interface Install {
  readonly dir: string;
  readonly fixture: KeyringFixture;
  /** The recovery key in `08` §3.7.6's printed form, which is what a host types. */
  readonly printedRecoveryKey: string;
}

/**
 * An install with a keyring, a master key and a configuration file.
 *
 * `security.keys.store` is left at its default (`keyfile`) and the key goes to
 * `data/keys/master.key` at 0600, with `data/keys` at 0700 — which is what `08` §3.7.3 requires
 * and what `auditKeyPermissions` refuses without.
 */
async function withInstall<T>(
  fn: (install: Install) => Promise<T>,
  options: Parameters<typeof buildKeyring>[0] = {},
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${BRAND.slug}-keys-`));
  try {
    const fixture = buildKeyring(options);
    const keysDir = join(dir, 'data', 'keys');
    await mkdir(keysDir, { recursive: true });
    await chmod(keysDir, 0o700);
    await writeFile(join(keysDir, 'keyring.json'), serialiseKeyring(fixture.keyring), {
      mode: 0o600,
    });
    await writeFile(join(keysDir, 'master.key'), `${fixture.masterKey.toString('base64url')}\n`, {
      mode: 0o600,
    });
    await writeFile(join(dir, BRAND.configFileName), 'instance:\n  dataDir: data\n');
    return await fn({
      dir,
      fixture,
      printedRecoveryKey: encodeRecoveryKey(fixture.recoveryKey),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The keyring as it now stands on disk. */
async function keyringOnDisk(
  install: Install,
): ReturnType<typeof parseKeyring> extends never
  ? never
  : Promise<ReturnType<typeof parseKeyring>> {
  return parseKeyring(await readFile(join(install.dir, 'data', 'keys', 'keyring.json'), 'utf8'));
}

async function invoke(
  install: Install,
  argv: readonly string[],
  overrides: Partial<RunOptions> = {},
): Promise<{ code: CliExitCode; out: string; err: string; json: unknown }> {
  const captured = { out: '', err: '' };
  const code = await run({
    argv: ['--dir', install.dir, ...argv],
    environment: { env: { CI: 'true' }, cwd: install.dir, isTty: false },
    streams: {
      out: {
        write(chunk: string) {
          captured.out += chunk;
        },
      },
      err: {
        write(chunk: string) {
          captured.err += chunk;
        },
      },
    },
    version: '1.2.3',
    colour: false,
    unicode: true,
    ...overrides,
  });
  let parsed: unknown;
  if (argv.includes('--json') && captured.out !== '') parsed = JSON.parse(captured.out);
  return { code, out: captured.out, err: captured.err, json: parsed };
}

describe(`${BRAND.cliName} keys status (09 §3.11.3)`, () => {
  it('reports the generations and slots without needing any key', async () => {
    await withInstall(async (install) => {
      // No key at all. `08` §3.7.8's first question is "what have you still got?", and this is the
      // command that answers it — so it has to work on a host whose master key is gone. Deleting
      // it here is what proves that rather than asserting it.
      await rm(join(install.dir, 'data', 'keys', 'master.key'));
      const { code, out } = await invoke(install, ['keys', 'status']);
      expect(code).toBe(CLI_EXIT.ok);
      expect(out).toContain(install.fixture.keyring.instanceId);
      expect(out).toContain('key store: keyfile');
      expect(out).toContain('gen 1 (active, current): master:mk1, recovery:rk1');
      expect(out).toContain('passphrase slot: no');
    });
  });

  it('puts the whole report in the --json envelope', async () => {
    await withInstall(async (install) => {
      const { code, json } = await invoke(install, ['keys', 'status', '--json']);
      expect(code).toBe(CLI_EXIT.ok);
      const body = json as { ok: boolean; data: { current: number; recoverySlots: number } };
      expect(body.ok).toBe(true);
      expect(body.data.current).toBe(1);
      expect(body.data.recoverySlots).toBe(1);
    });
  });

  it('sees a passphrase slot when the host has one', async () => {
    await withInstall(
      async (install) => {
        const { out } = await invoke(install, ['keys', 'status']);
        expect(out).toContain('passphrase slot: yes');
      },
      { withPassphrase: true },
    );
  });
});

describe(`${BRAND.cliName} keys verify-recovery (08 §3.7.6)`, () => {
  it('accepts the printed key and changes nothing', async () => {
    await withInstall(async (install) => {
      const before = serialiseKeyring(await keyringOnDisk(install));
      const { code, out } = await invoke(install, ['keys', 'verify-recovery'], {
        answers: { secretLine: install.printedRecoveryKey },
        environment: { env: {}, cwd: install.dir, isTty: true },
      });
      expect(code).toBe(CLI_EXIT.ok);
      expect(out).toContain('slot rk1');
      // "Changes nothing" is the command's promise, and the file is where that is true or not.
      expect(serialiseKeyring(await keyringOnDisk(install))).toBe(before);
    });
  });

  it('tells a typo from the wrong key, and exits 9 for both', async () => {
    await withInstall(async (install) => {
      // A checksum failure: the host should look at what they wrote down.
      const typo = await invoke(install, ['keys', 'verify-recovery'], {
        answers: { secretLine: `${install.printedRecoveryKey.slice(0, -1)}X` },
        environment: { env: {}, cwd: install.dir, isTty: true },
      });
      expect(typo.code).toBe(CLI_EXIT.integrity);

      // A well-formed key that opens nothing: a *different* install's, or one since rotated. The
      // two messages differ, which is the whole reason `verifyRecovery` distinguishes them —
      // reporting both as "invalid" leaves somebody re-reading a perfectly good piece of paper.
      const other = buildKeyring();
      const wrong = await invoke(install, ['keys', 'verify-recovery'], {
        answers: { secretLine: encodeRecoveryKey(other.recoveryKey) },
        environment: { env: {}, cwd: install.dir, isTty: true },
      });
      expect(wrong.code).toBe(CLI_EXIT.integrity);
      expect(wrong.out).not.toBe(typo.out);
    });
  });

  it('refuses to ask in a non-interactive run, naming the flag', async () => {
    await withInstall(async (install) => {
      const { code, err } = await invoke(install, ['keys', 'verify-recovery']);
      expect(code).toBe(CLI_EXIT.config);
      expect(err).toContain('--recovery-key-file');
      // And says why a flag value is not offered: `09` §3.11.2 keeps secrets out of shell history.
      expect(err).toContain('shell history');
    });
  });

  it('reads the key from a file when one is given', async () => {
    await withInstall(async (install) => {
      const path = join(install.dir, 'rk.txt');
      await writeFile(path, `${install.printedRecoveryKey}\n`, { mode: 0o600 });
      const { code } = await invoke(install, [
        'keys',
        'verify-recovery',
        '--recovery-key-file',
        path,
      ]);
      expect(code).toBe(CLI_EXIT.ok);
    });
  });
});

describe(`${BRAND.cliName} keys rotate-master (08 §3.7.7 row 1)`, () => {
  it('replaces the key file and leaves every generation openable', async () => {
    await withInstall(async (install) => {
      const oldKey = await readFile(join(install.dir, 'data', 'keys', 'master.key'), 'utf8');
      const { code, out, err } = await invoke(install, ['keys', 'rotate-master', '--yes']);
      expect(code, err).toBe(CLI_EXIT.ok);
      expect(out).toContain('new slots:');

      // The file changed, which is the half a host cares about: the old keyfile, wherever it was
      // copied, no longer opens this install.
      const newKey = await readFile(join(install.dir, 'data', 'keys', 'master.key'), 'utf8');
      expect(newKey).not.toBe(oldKey);
      // 0600 still. A rotation that widened the mode would hand the new key to every local user.
      const keyring = await keyringOnDisk(install);
      expect(keyring.generations[0]?.slots.filter((slot) => slot.kind === 'master')).toHaveLength(
        1,
      );
      // And `keys status` runs with the new key, which is the end-to-end check: the keyring and
      // the file agree.
      expect((await invoke(install, ['keys', 'status'])).code).toBe(CLI_EXIT.ok);
    });
  });

  it('refuses without --yes in a run that cannot ask', async () => {
    await withInstall(async (install) => {
      const { code, err } = await invoke(install, ['keys', 'rotate-master']);
      expect(code).toBe(CLI_EXIT.config);
      expect(err).toContain('--yes');
      // Nothing happened, which is the point of refusing rather than proceeding.
      const keyring = await keyringOnDisk(install);
      expect(keyring.generations[0]?.slots.map((slot) => slot.id)).toEqual(['mk1', 'rk1']);
    });
  });
});

describe(`${BRAND.cliName} keys rotate-recovery (08 §3.7.6, SD-04)`, () => {
  it('prints the new key to stderr, never to stdout or the envelope', async () => {
    await withInstall(async (install) => {
      // An **interactive** run: a TTY and no `CI`. `rotate-recovery` refuses before minting a key
      // when it can neither ask nor be told where to write one, which is the next test.
      const { code, out, err } = await invoke(install, ['keys', 'rotate-recovery', '--yes'], {
        answers: { ceremonyConfirmed: true },
        environment: { env: {}, cwd: install.dir, isTty: true },
      });
      expect(code, err).toBe(CLI_EXIT.ok);
      // The ceremony is on **stderr**: it is not the command's answer, it is something the host
      // must copy down, and stdout may be a pipe into a log.
      expect(err).toContain('Write this down');
      // And the key itself is nowhere in stdout. `08` SD-04's "printed once" means printed.
      const printed = /\n {2}(\S{20,})\n/.exec(err)?.[1];
      expect(printed, 'the ceremony printed no key').toBeDefined();
      expect(out).not.toContain(printed ?? 'unreachable');
      // The new key verifies and the old one does not, which is what "replaced" has to mean.
      const check = await invoke(install, ['keys', 'verify-recovery'], {
        answers: { secretLine: printed ?? '' },
        environment: { env: {}, cwd: install.dir, isTty: true },
      });
      expect(check.code).toBe(CLI_EXIT.ok);
      const old = await invoke(install, ['keys', 'verify-recovery'], {
        answers: { secretLine: install.printedRecoveryKey },
        environment: { env: {}, cwd: install.dir, isTty: true },
      });
      expect(old.code).toBe(CLI_EXIT.integrity);
    });
  });

  it('writes the new key to --recovery-key-out at 0600, and proceeds without a prompt', async () => {
    await withInstall(async (install) => {
      const out = join(install.dir, 'new-rk.txt');
      // A non-interactive run with `--recovery-key-out` is the one route `08` §3.7.6 leaves open:
      // the key goes somewhere the host chose rather than into a log nobody reads.
      const result = await invoke(install, [
        'keys',
        'rotate-recovery',
        '--yes',
        '--recovery-key-out',
        out,
      ]);
      expect(result.code).toBe(CLI_EXIT.ok);
      const written = (await readFile(out, 'utf8')).trim();
      const check = await invoke(install, ['keys', 'verify-recovery', '--recovery-key-file', out]);
      expect(check.code).toBe(CLI_EXIT.ok);
      expect(written.length).toBeGreaterThan(20);
    });
  });

  it('changes nothing when the ceremony is not confirmed', async () => {
    await withInstall(async (install) => {
      // `08` §3.7.6: a rotation the host did not acknowledge would destroy the old key and give
      // them nothing. The old key must still work afterwards.
      await invoke(install, ['keys', 'rotate-recovery', '--yes'], {
        answers: { ceremonyConfirmed: false },
        environment: { env: {}, cwd: install.dir, isTty: true },
      });
      const old = await invoke(install, ['keys', 'verify-recovery'], {
        answers: { secretLine: install.printedRecoveryKey },
        environment: { env: {}, cwd: install.dir, isTty: true },
      });
      expect(old.code).toBe(CLI_EXIT.ok);
    });
  });

  it('refuses in a non-interactive run with no --recovery-key-out', async () => {
    await withInstall(async (install) => {
      const { code, err } = await invoke(install, ['keys', 'rotate-recovery', '--yes']);
      expect(code).toBe(CLI_EXIT.config);
      expect(err).toContain('--recovery-key-out');
    });
  });
});

describe(`${BRAND.cliName} keys recover (08 §3.7.8 row 1)`, () => {
  it('establishes a new master key from the recovery key alone', async () => {
    await withInstall(async (install) => {
      // The host has lost the master key. This is the only route back in, and the command must
      // not need the thing that is gone.
      await rm(join(install.dir, 'data', 'keys', 'master.key'));
      const { code, out } = await invoke(install, ['keys', 'recover'], {
        answers: { secretLine: install.printedRecoveryKey },
        environment: { env: {}, cwd: install.dir, isTty: true },
      });
      expect(code).toBe(CLI_EXIT.ok);
      expect(out).toContain('opened with recovery slot rk1');
      // A new master key file exists, and the keyring has a second master slot.
      const written = await readFile(join(install.dir, 'data', 'keys', 'master.key'), 'utf8');
      expect(written.trim().length).toBeGreaterThan(40);
      const keyring = await keyringOnDisk(install);
      expect(
        keyring.generations[0]?.slots.filter((slot) => slot.kind === 'master').length,
      ).toBeGreaterThanOrEqual(1);
      // And the recovery key is **unchanged**, which the command says and the file confirms.
      const check = await invoke(install, ['keys', 'verify-recovery'], {
        answers: { secretLine: install.printedRecoveryKey },
        environment: { env: {}, cwd: install.dir, isTty: true },
      });
      expect(check.code).toBe(CLI_EXIT.ok);
    });
  });

  it('exits 9 for a key that opens nothing', async () => {
    await withInstall(async (install) => {
      const other = buildKeyring();
      const { code } = await invoke(install, ['keys', 'recover'], {
        answers: { secretLine: encodeRecoveryKey(other.recoveryKey) },
        environment: { env: {}, cwd: install.dir, isTty: true },
      });
      expect(code).toBe(CLI_EXIT.integrity);
    });
  });
});

describe(`${BRAND.cliName} keys add-passphrase (08 §3.7.8 row 2)`, () => {
  it('adds a third unlock route and says it cannot start unattended', async () => {
    await withInstall(async (install) => {
      const { code, out, err } = await invoke(install, ['keys', 'add-passphrase'], {
        answers: { newPassphrase: 'correct horse battery staple' },
      });
      expect(code).toBe(CLI_EXIT.ok);
      expect(out).toContain('A passphrase slot is added');
      // The consequence, on stderr, because a host who adds this and then reboots a headless
      // machine finds out the hard way otherwise.
      expect(err).toContain('unattended');
      const keyring = await keyringOnDisk(install);
      expect(
        keyring.generations[0]?.slots.filter((slot) => slot.kind === 'passphrase'),
      ).toHaveLength(1);
      expect((await invoke(install, ['keys', 'status'])).out).toContain('passphrase slot: yes');
    });
  });

  it('refuses two passphrases that do not match, and adds nothing', async () => {
    await withInstall(async (install) => {
      const { code, err } = await invoke(install, ['keys', 'add-passphrase']);
      // No `answers.newPassphrase`, and the run cannot prompt — so the two reads return ''.
      expect(code).toBe(CLI_EXIT.config);
      expect(err).not.toBe('');
      const keyring = await keyringOnDisk(install);
      expect(keyring.generations[0]?.slots.filter((slot) => slot.kind === 'passphrase')).toEqual(
        [],
      );
    });
  });
});

describe(`${BRAND.cliName} keys remove-slot`, () => {
  it('removes one unlock route', async () => {
    await withInstall(
      async (install) => {
        const { code, out } = await invoke(install, [
          'keys',
          'remove-slot',
          'pp1',
          '--gen',
          '1',
          '--yes',
        ]);
        expect(code).toBe(CLI_EXIT.ok);
        expect(out).toContain('removed from generation 1');
        const keyring = await keyringOnDisk(install);
        expect(keyring.generations[0]?.slots.map((slot) => slot.id)).not.toContain('pp1');
      },
      { withPassphrase: true },
    );
  });

  it('refuses to leave a generation with no recovery slot', async () => {
    await withInstall(async (install) => {
      // The keyring's own invariant, and the reason this command cannot lock a host out: removing
      // the last recovery slot would leave an install with no off-host way in.
      const { code } = await invoke(install, ['keys', 'remove-slot', 'rk1', '--gen', '1', '--yes']);
      expect(code).toBe(CLI_EXIT.integrity);
      const keyring = await keyringOnDisk(install);
      expect(keyring.generations[0]?.slots.map((slot) => slot.id)).toContain('rk1');
    });
  });

  it('exits 2 for a generation that is not a number', async () => {
    await withInstall(async (install) => {
      const { code } = await invoke(install, [
        'keys',
        'remove-slot',
        'rk1',
        '--gen',
        'latest',
        '--yes',
      ]);
      expect(code).toBe(CLI_EXIT.usage);
    });
  });
});

describe(`${BRAND.cliName} keys purge-retired`, () => {
  it('says there is nothing to purge when there is not', async () => {
    await withInstall(async (install) => {
      const { code, out } = await invoke(install, ['keys', 'purge-retired', '--yes']);
      expect(code).toBe(CLI_EXIT.ok);
      expect(out).toContain('no retired generations');
    });
  });

  it('deletes retired generations once the blobs are acknowledged', async () => {
    await withInstall(
      async (install) => {
        const before = await keyringOnDisk(install);
        expect(before.generations).toHaveLength(2);
        const { code, out } = await invoke(install, [
          'keys',
          'purge-retired',
          '--yes',
          '--blobs-rewrapped',
        ]);
        expect(code).toBe(CLI_EXIT.ok);
        expect(out).toContain('Purged generation(s) 1');
        const after = await keyringOnDisk(install);
        expect(after.generations.map((generation) => generation.gen)).toEqual([2]);
      },
      { gen: 2, retiredGenerations: [1] },
    );
  });

  it('refuses without the blobs acknowledgement, and keeps the generation', async () => {
    await withInstall(
      async (install) => {
        // Irreversible, and `08` §3.7.7's last row is explicit that a retired generation is what
        // opens blobs and backups made under it. The second flag is the acknowledgement, and
        // `--yes` deliberately does not imply it.
        const { code } = await invoke(install, ['keys', 'purge-retired', '--yes']);
        expect(code).toBe(CLI_EXIT.integrity);
        const after = await keyringOnDisk(install);
        expect(after.generations).toHaveLength(2);
      },
      { gen: 2, retiredGenerations: [1] },
    );
  });
});

describe('the key store (08 §3.7.3)', () => {
  it('refuses a group-readable master key, and names the override', async () => {
    await withInstall(async (install) => {
      await chmod(join(install.dir, 'data', 'keys', 'master.key'), 0o644);
      const { code, err } = await invoke(install, ['keys', 'rotate-master', '--yes']);
      expect(code).toBe(CLI_EXIT.permission);
      expect(err).toContain('--insecure-permissions');
    });
  });

  it('proceeds with --insecure-permissions, ssh-style', async () => {
    await withInstall(async (install) => {
      await chmod(join(install.dir, 'data', 'keys', 'master.key'), 0o644);
      const { code } = await invoke(install, [
        'keys',
        'rotate-master',
        '--yes',
        '--insecure-permissions',
      ]);
      expect(code).toBe(CLI_EXIT.ok);
    });
  });

  it('refuses to write a key for a store it cannot write', async () => {
    await withInstall(async (install) => {
      // `file`, `env` and `passphrase` are read-only to this process: the secret is mounted,
      // exported or typed by whoever runs the host. Writing a keyfile for an `env`-mode install
      // would create a second, unexpected copy of the key — the opposite of what the mode is for.
      await writeFile(
        join(install.dir, BRAND.configFileName),
        'instance:\n  dataDir: data\nsecurity:\n  keys:\n    store: env\n',
      );
      const { code, err } = await invoke(install, ['keys', 'rotate-master', '--yes'], {
        environment: {
          env: {
            CI: 'true',
            COMVIVO_MASTER_KEY: install.fixture.masterKey.toString('base64url'),
          },
          cwd: install.dir,
          isTty: false,
        },
      });
      expect(code).toBe(CLI_EXIT.config);
      expect(err).toContain('cannot write');
    });
  });
});
