/**
 * The CLI's skeleton: exit codes, the two output shapes, and the global options (`M3-T13`).
 *
 * `09` §3.11.2's exit-code table is a **contract with scripts**, so it is tested as a table rather
 * than one code at a time: a wrapper script reads the number and nothing else, and the two ways to
 * get it wrong both cost somebody an afternoon — a configuration problem reported as a crash gets
 * retried in a loop, and a held lock reported as a configuration problem sends an operator looking
 * for a setting that is fine.
 *
 * Every test runs `run()` in-process against string streams. That is why `run` returns a code
 * instead of calling `process.exit`: the alternative is spawning a subprocess per case, which is
 * slow enough that the table would get trimmed.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { BRAND, envVar } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { copy } from './copy.js';
import { CLI_EXIT, CLI_EXIT_MEANINGS, type CliExitCode } from './exit-codes.js';
import { type RunOptions, run } from './main.js';

/** A capturing pair of streams, so stdout and stderr can be told apart. */
function streams(): {
  readonly streams: RunOptions['streams'];
  out(): string;
  err(): string;
} {
  const captured = { out: '', err: '' };
  return {
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
    out: () => captured.out,
    err: () => captured.err,
  };
}

/**
 * A working directory with no install above it, for the upward search.
 *
 * A fresh one **per invocation**, which is `hygiene:check`'s temp-path rule and its
 * `no-module-level-mutable-state` rule together: a cached handle at module scope is shared state
 * between tests, and a fixed path is shared state between runs. One `mkdtemp` per call costs
 * nothing at this scale.
 *
 * One caveat worth stating: a directory under the system temp root still has that root above it,
 * so a stray `comvivo.yaml` *there* would be found — the search walks to the filesystem root by
 * design. Nothing this suite writes creates one, and the cases that care about finding an install
 * pass `--dir`.
 */
async function invoke(
  argv: readonly string[],
  overrides: Partial<RunOptions> = {},
): Promise<{ code: CliExitCode; out: string; err: string }> {
  const captured = streams();
  const code = await run({
    argv,
    environment: {
      env: { CI: 'true' },
      cwd: await mkdtemp(join(tmpdir(), `${BRAND.slug}-cwd-`)),
      isTty: false,
    },
    streams: captured.streams,
    // Empty by default: a command that prompted without a test saying so would otherwise read
    // whatever the test runner's stdin happened to be.
    input: Readable.from([]),
    version: '1.2.3',
    colour: false,
    unicode: true,
    ...overrides,
  });
  return { code, out: captured.out(), err: captured.err() };
}

/** An install folder with a `comvivo.yaml` and nothing else. */
async function withInstall<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${BRAND.slug}-cli-`));
  try {
    await writeFile(join(dir, BRAND.configFileName), 'instance:\n  dataDir: data\n');
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('the exit-code table (09 §3.11.2)', () => {
  it('names every code the spec lists, and only those', () => {
    // Pinned as a set, because a code added without a meaning is a number a host cannot look up,
    // and a meaning without a code is documentation for something that cannot happen.
    expect(Object.values(CLI_EXIT).toSorted((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 130,
    ]);
    expect(
      Object.keys(CLI_EXIT_MEANINGS)
        .map(Number)
        .toSorted((a, b) => a - b),
    ).toEqual(Object.values(CLI_EXIT).toSorted((a, b) => a - b));
  });

  it('prints the table under `exit-codes`, which is what makes the spec’s help real', () => {
    // `09` §3.11.2 says the codes are "documented in `comvivo help exit-codes`". A table in a spec
    // that the binary cannot print is not documentation a host can reach.
    return invoke(['exit-codes']).then(({ code, out }) => {
      expect(code).toBe(CLI_EXIT.ok);
      for (const [number, meaning] of Object.entries(CLI_EXIT_MEANINGS)) {
        expect(out).toContain(number);
        expect(out).toContain(meaning);
      }
    });
  });

  it('exits 2 on an unknown flag and 2 on an unknown command', async () => {
    // commander's own parse failures. Routed through `exitOverride` so they land in `09`
    // §3.11.2's table rather than in commander's default of 1.
    expect((await invoke(['--nope'])).code).toBe(CLI_EXIT.usage);
    expect((await invoke(['nope'])).code).toBe(CLI_EXIT.usage);
  });

  it('exits 0 on --help and on --version, which are successes', async () => {
    const help = await invoke(['--help']);
    expect(help.code).toBe(CLI_EXIT.ok);
    expect(help.out).toContain(BRAND.cliName);
    const version = await invoke(['--version']);
    expect(version.code).toBe(CLI_EXIT.ok);
    expect(version.out.trim()).toBe('1.2.3');
  });

  it('exits 3 when there is no install, naming what to do', async () => {
    const { code, err } = await invoke(['keys', 'status']);
    expect(code).toBe(CLI_EXIT.config);
    // The error and its hint go to **stderr**: a failure is not the command's answer.
    expect(err).toContain(copy('error.noInstall'));
    expect(err).toContain(`${BRAND.cliName} init`);
  });

  it('exits 3 when there is an install but no keyring', async () => {
    await withInstall(async (dir) => {
      const { code, err } = await invoke(['--dir', dir, 'keys', 'status']);
      // A different sentence from "no install": `comvivo init` is the answer to one and
      // `comvivo restore` to the other, and conflating them sends a host down the wrong path.
      expect(code).toBe(CLI_EXIT.config);
      expect(err).toContain('There is no keyring at');
    });
  });
});

describe('the two output shapes (09 §3.11.2)', () => {
  it('puts human output on stdout and nothing else there', async () => {
    const { out, err } = await invoke(['version']);
    expect(out).toContain(copy('version.line', { version: '1.2.3' }));
    // Nothing on stderr for a command that succeeded: a script that treats stderr as a failure
    // signal — and plenty do — must not see one.
    expect(err).toBe('');
  });

  it('prints exactly one JSON document under --json, and no prose', async () => {
    const { out } = await invoke(['version', '--json']);
    // One `JSON.parse` over the **whole** of stdout. That is the property `--json` promises, and
    // a progressive printer would break it on the one path that printed twice.
    const parsed = JSON.parse(out) as { ok: boolean; data: { version: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.version).toBe('1.2.3');
    expect(out.trimEnd().split('\n')).toHaveLength(1);
  });

  it('puts a failure in the envelope under --json rather than on stderr', async () => {
    const { code, out, err } = await invoke(['keys', 'status', '--json']);
    expect(code).toBe(CLI_EXIT.config);
    const parsed = JSON.parse(out) as { ok: boolean; error: { code: string; hint: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('NO_INSTALL');
    expect(parsed.error.hint).toContain(`${BRAND.cliName} init`);
    // And nothing human on stderr, which would otherwise be the half of the output a `2>&1`
    // pipeline could not parse.
    expect(err).toBe('');
  });
});

describe('the global options (09 §3.11.2)', () => {
  it('takes the install folder from --dir, then from the environment', async () => {
    await withInstall(async (dir) => {
      // `--dir` wins.
      const flagged = await invoke(['--dir', dir, 'keys', 'status']);
      expect(flagged.err).toContain(join(dir, 'data', 'keys'));
      // Then `COMVIVO_DIR`.
      const fromEnv = await invoke(['keys', 'status'], {
        environment: {
          env: { CI: 'true', [envVar('DIR')]: dir },
          cwd: await mkdtemp(join(tmpdir(), `${BRAND.slug}-cwd-`)),
          isTty: false,
        },
      });
      expect(fromEnv.err).toContain(join(dir, 'data', 'keys'));
    });
  });

  it('reads instance.dataDir from the configuration file, relative to the folder', async () => {
    await withInstall(async (dir) => {
      await writeFile(join(dir, BRAND.configFileName), 'instance:\n  dataDir: ./elsewhere\n');
      const { err } = await invoke(['--dir', dir, 'keys', 'status']);
      // Relative to the **install folder**, not the working directory. A path that moved with the
      // shell would make `comvivo backup` write somewhere different depending on where it ran.
      expect(err).toContain(join(dir, 'elsewhere', 'keys'));
    });
  });

  it('prefers --data-dir over the configuration file', async () => {
    await withInstall(async (dir) => {
      // A directory of its own, per `hygiene:check`'s temp-path rule: a fixed `/tmp/explicit`
      // would be shared state between runs, which surfaces as order dependence under
      // `--sequence.shuffle`.
      const elsewhere = await mkdtemp(join(tmpdir(), `${BRAND.slug}-data-`));
      try {
        const { err } = await invoke(['--dir', dir, '--data-dir', elsewhere, 'keys', 'status']);
        expect(err).toContain(join(elsewhere, 'keys'));
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    });
  });

  it('survives a configuration file it cannot parse', async () => {
    await withInstall(async (dir) => {
      // `doctor` is the command that explains a broken configuration, so no command may fail to
      // *start* because of one. The data directory falls back to the default.
      await writeFile(join(dir, BRAND.configFileName), 'instance: [this is not: valid\n');
      const { code, err } = await invoke(['--dir', dir, 'keys', 'status']);
      expect(code).toBe(CLI_EXIT.config);
      expect(err).toContain(join(dir, 'data', 'keys'));
    });
  });
});
