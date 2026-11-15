/**
 * The `comvivo` program (`09` §3.11.1–§3.11.3; `M3-T13`).
 *
 * commander builds the tree, this module owns the three things that must be the same for every
 * command, and `bin/comvivo.mjs` is the shim that gets here.
 *
 *  1. **The global options**, so `--json`, `--non-interactive`, `-C/--dir` and `--data-dir` mean
 *     the same thing everywhere and a command never parses them itself.
 *  2. **The error → exit-code mapping**, in one place. `09` §3.11.2's table is a contract with
 *     scripts, and a code assigned at each `throw` would drift the moment two commands disagreed
 *     about what a held lock is.
 *  3. **The dependency object**, so a command touches the process through `deps` and a test can
 *     run a whole command against strings.
 *
 * ## Why `run` returns a code rather than exiting
 *
 * `process.exit` truncates pending writes — a `--json` document on a pipe can be cut in half —
 * and it makes every command untestable in-process. So `run` returns the code and the shim exits
 * with it, after the streams have drained.
 */

import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Command, InvalidArgumentError } from '@commander-js/extra-typings';
import { BRAND, StorageError } from '@comvivo/shared';
import { KeyPermissionError, storeMasterKey } from '@comvivo/storage/crypto';
import { keysCommand } from './commands/keys/index.js';
import { versionCommand } from './commands/version.js';
import { type CliContext, type Environment, resolveContext } from './context.js';
import { copy } from './copy.js';
import type { CommandDeps } from './deps.js';
import { CLI_EXIT, CLI_EXIT_MEANINGS, CliError, type CliExitCode } from './exit-codes.js';
import { keySourceFor } from './keys/open.js';
import { canPrompt, Printer, type Streams } from './output.js';

/** What `run` is given, so nothing in this package reads a global. */
export interface RunOptions {
  readonly argv: readonly string[];
  readonly environment: Environment;
  readonly streams: Streams;
  /** The package version, from the shim, which read it from `package.json`. */
  readonly version: string;
  /** `picocolors`' answer, passed in because it reads `NO_COLOR`/`FORCE_COLOR` from the env. */
  readonly colour: boolean;
  /** Whether the terminal can show the Unicode symbol set (`09` §3.11.1). */
  readonly unicode: boolean;
  /** For tests: answer confirmations and secret prompts without a terminal. */
  readonly answers?: {
    readonly confirm?: boolean;
    readonly secretLine?: string;
    readonly newPassphrase?: string;
    readonly ceremonyConfirmed?: boolean;
  };
}

/**
 * Build the program and run it, returning `09` §3.11.2's exit code.
 *
 * Never throws for a command's own failure: the mapping below is the whole point. It can still
 * throw for a bug in this function, which the shim turns into code 1.
 */
export async function run(options: RunOptions): Promise<CliExitCode> {
  const printed = { code: CLI_EXIT.ok as CliExitCode };
  let printer: Printer | undefined;
  let context: CliContext | undefined;

  const program = new Command()
    .name(BRAND.cliName)
    .description(copy('program.description'))
    .version(options.version, '-v, --version', copy('option.version'))
    // commander exits the process itself by default, on `--help` and on a parse error. Both are
    // routed back here so `run` stays the only place that decides a code, and so a `--help` on a
    // machine with no install does not fail for want of a `comvivo.yaml`.
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        options.streams.out.write(text);
      },
      writeErr: (text) => {
        options.streams.err.write(text);
      },
    })
    .option('-C, --dir <path>', copy('option.dir', { configFile: BRAND.configFileName }))
    .option('--data-dir <path>', copy('option.dataDir'))
    .option('--json', copy('option.json'))
    .option('--non-interactive', copy('option.nonInteractive'))
    .option('--yes', copy('option.yes'))
    .showHelpAfterError();

  /** Resolved lazily: `--help` and `version` work with no install, every other command needs one. */
  const contextOnce = (): CliContext => {
    context ??= resolveContext(program.opts(), options.environment);
    return context;
  };
  const printerOnce = (): Printer => {
    printer ??= new Printer({
      streams: options.streams,
      json: program.opts().json === true,
      // `--json` is machine output; colour codes in it would be in the strings.
      colour: options.colour && program.opts().json !== true,
      unicode: options.unicode,
    });
    return printer;
  };

  const deps: CommandDeps = {
    context: contextOnce,
    printer: printerOnce,
    env: options.environment.env,
    canPrompt: () =>
      canPrompt({
        isTty: options.environment.isTty,
        nonInteractive: program.opts().nonInteractive === true,
        ci: options.environment.env['CI'] === 'true',
        json: program.opts().json === true,
      }),
    keyStore: (where) => keySourceFor(where).store,
    readSecretLine: async () => {
      if (options.answers?.secretLine !== undefined) return options.answers.secretLine;
      return await readLine(copy('prompt.recoveryKey'), options.streams);
    },
    readNewPassphrase: async () => {
      if (options.answers?.newPassphrase !== undefined) return options.answers.newPassphrase;
      if (!deps.canPrompt()) {
        // Checked **before** reading, because `readLine` on a non-TTY stdin never returns: in CI
        // `comvivo keys add-passphrase` would hang until the job timed out, which is a failure
        // that looks like an infrastructure problem and takes an afternoon to attribute.
        // `09` §3.11.2 wants exit 3 and the flag to pass — and there is no flag, because a
        // passphrase is a secret and `09` §3.11.2 keeps those out of flag values.
        throw new CliError(
          CLI_EXIT.config,
          'MISSING_INPUT',
          copy('error.missingInput', { what: 'A passphrase' }),
          { hint: copy('error.passphrase.interactive') },
        );
      }
      const first = await readLine(copy('prompt.newPassphrase'), options.streams);
      const again = await readLine(copy('prompt.again'), options.streams);
      if (first !== again || first === '') {
        throw new CliError(
          CLI_EXIT.config,
          'PASSPHRASE_MISMATCH',
          copy(first === '' ? 'error.passphraseEmpty' : 'error.passphraseMismatch'),
          { hint: copy('error.passphrase.retry') },
        );
      }
      return first;
    },
    confirm: async (question, consequence) => {
      // The **global** `--yes`. See `CommandDeps.confirm` for why it is read here and not passed.
      if (program.opts().yes === true) return;
      if (options.answers?.confirm !== undefined) {
        if (options.answers.confirm) return;
        throw cancelled();
      }
      if (!deps.canPrompt()) {
        // `09` §3.11.2: a missing required input in a non-interactive run is exit 3, and the
        // message names the flag. A confirmation is a required input.
        throw new CliError(CLI_EXIT.config, 'MISSING_INPUT', question, {
          hint: copy('error.confirmNonInteractive.hint', { consequence }),
        });
      }
      options.streams.err.write(`${question}\n  ${consequence}\n`);
      const answer = (await readLine(copy('prompt.typeYes'), options.streams)).trim();
      if (answer !== 'yes') throw cancelled();
    },
    ceremony: async (key, outFile) => {
      // `08` §3.7.6. The key goes to **stderr**, not stdout: it is not the command's answer, it is
      // something the host must copy down — and stdout may be a pipe into a log.
      options.streams.err.write(`\n${copy('ceremony.writeDown')}\n\n  ${key}\n\n`);
      if (outFile !== undefined && outFile !== '') {
        // 0600, because the whole point of the recovery key is that it survives the loss of
        // everything on this host — so a copy left here must at least not be world-readable.
        await writeFile(outFile, `${key}\n`, { mode: 0o600 });
        options.streams.err.write(`${copy('ceremony.written', { path: outFile })}\n`);
      }
      if (options.answers?.ceremonyConfirmed !== undefined)
        return options.answers.ceremonyConfirmed;
      if (!deps.canPrompt()) {
        // Refused rather than assumed. A `rotate-recovery` in a script would replace the only
        // off-host way in and print the new key to a log nobody reads — so the non-interactive
        // route is `--recovery-key-out`, which at least puts it in a file the host chose.
        if (outFile !== undefined && outFile !== '') return true;
        throw new CliError(CLI_EXIT.config, 'MISSING_INPUT', copy('ceremony.nonInteractive'), {
          hint: copy('ceremony.nonInteractive.hint'),
        });
      }
      const answer = (await readLine(copy('prompt.typeWritten'), options.streams)).trim();
      return answer === 'written';
    },
    storeMasterKey: async (where, key) => {
      const source = keySourceFor(where);
      if (source.store === 'keychain') {
        await storeMasterKey(key, undefined);
        return;
      }
      if (source.store !== 'keyfile') {
        // `file`, `env` and `passphrase` are read-only to this process: the secret is mounted,
        // exported or typed by whoever runs the host. Refusing is the honest answer — writing a
        // keyfile for a host configured for `env` would create a second, unexpected copy of the
        // key, which is the opposite of what those modes are for.
        throw new CliError(
          CLI_EXIT.config,
          'KEY_STORE_READ_ONLY',
          copy('error.keyStoreReadOnly', { store: source.store }),
          { hint: copy('error.keyStoreReadOnly.hint', { store: source.store }) },
        );
      }
      const path = resolveKeyfile(source.keyfilePath, where.dir);
      await writeFile(path, `${key.toString('base64url')}\n`, { mode: 0o600 });
      key.fill(0);
    },
    setExitCode: (code) => {
      printed.code = code;
    },
  };

  program.addCommand(versionCommand(deps, options.version));
  program.addCommand(keysCommand(deps));
  program.addCommand(exitCodesCommand(deps));

  try {
    await program.parseAsync([...options.argv], { from: 'user' });
    return printed.code;
  } catch (cause) {
    return report(cause, printerOnce, options.streams);
  }
}

/** `comvivo help exit-codes` (`09` §3.11.2: "documented in `comvivo help exit-codes`"). */
function exitCodesCommand(deps: CommandDeps): Command {
  return new Command('help-exit-codes')
    .alias('exit-codes')
    .description(copy('exitCodes.description'))
    .helpGroup('Advanced')
    .action(() => {
      const printer = deps.printer();
      printer.envelope({ ok: true, data: CLI_EXIT_MEANINGS });
      for (const [code, meaning] of Object.entries(CLI_EXIT_MEANINGS)) {
        printer.line(`${code.padStart(3)}  ${meaning}`);
      }
    });
}

function cancelled(): CliError {
  // `09` §3.11.2's wording, because "nothing was changed" is the fact the host needs and the one
  // a bare "cancelled" leaves them guessing about.
  return new CliError(CLI_EXIT.cancelled, 'CANCELLED', copy('error.cancelled'));
}

/**
 * Turn whatever was thrown into `09` §3.11.2's exit code, having printed it.
 *
 * The order is the specificity order: our own errors first, then the two library errors that have
 * a code of their own, then commander's, then the catch-all. Written as a sequence of `instanceof`
 * rather than a `switch` on a discriminant because three of these classes are other packages' and
 * have no shared shape — and a `default` that guessed would be how a configuration problem comes
 * to be reported as a bug.
 */
function report(cause: unknown, printerOnce: () => Printer, streams: Streams): CliExitCode {
  if (cause instanceof CliError) {
    printerOnce().error({
      code: cause.code,
      message: cause.message,
      ...(cause.hint === undefined ? {} : { hint: cause.hint }),
    });
    return cause.exitCode;
  }
  if (cause instanceof KeyPermissionError) {
    // `08` §3.7.3: group- or world-readable key material. Exit 7, and the message already names
    // every offending path and its mode.
    printerOnce().error({
      code: 'KEY_PERMISSIONS',
      message: cause.message,
      hint: copy('error.keyPermissions.hint'),
    });
    return CLI_EXIT.permission;
  }
  if (cause instanceof StorageError) {
    printerOnce().error({
      code: cause.storageCode,
      message: cause.message,
      ...(cause.hint === undefined ? {} : { hint: cause.hint }),
    });
    // A storage error that reached here is about the data or the key, not about this program.
    return cause.storageCode.startsWith('STORAGE_KEY_') ? CLI_EXIT.integrity : CLI_EXIT.unexpected;
  }
  if (isCommanderExit(cause)) {
    // `--help` and `--version` throw `commander.helpDisplayed` / `.version` after writing their
    // output, which is a success. A parse failure is `09` §3.11.2's exit 2.
    return cause.exitCode === 0 ? CLI_EXIT.ok : CLI_EXIT.usage;
  }
  if (cause instanceof InvalidArgumentError) {
    printerOnce().error({ code: 'USAGE', message: cause.message });
    return CLI_EXIT.usage;
  }
  // Unexpected. `09` §3.11.2 asks for the log path, which is the only useful thing to say about a
  // failure nobody anticipated.
  streams.err.write(
    `${cause instanceof Error ? cause.message : String(cause)}\n  ${copy('error.unexpected.hint')}\n`,
  );
  return CLI_EXIT.unexpected;
}

/** commander's `CommanderError`, by shape: it is not exported from `extra-typings`. */
function isCommanderExit(cause: unknown): cause is { exitCode: number; code: string } {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'exitCode' in cause &&
    typeof cause.exitCode === 'number' &&
    'code' in cause &&
    typeof cause.code === 'string' &&
    cause.code.startsWith('commander.')
  );
}

/** One line from stdin, prompted on stderr. */
async function readLine(prompt: string, streams: Streams): Promise<string> {
  streams.err.write(prompt);
  const reader = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of reader) return line;
    return '';
  } finally {
    reader.close();
  }
}

function resolveKeyfile(keyfilePath: string, dir: string): string {
  return keyfilePath.startsWith('/') ? keyfilePath : `${dir}/${keyfilePath.replace(/^\.\//, '')}`;
}
