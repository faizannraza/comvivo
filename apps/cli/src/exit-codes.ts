/**
 * The CLI's exit codes (`09` §3.11.2).
 *
 * A different table from `12` §4.2's, which `@comvivo/shared`'s `exit-codes.ts` owns, and the
 * difference is deliberate rather than an oversight. `12` §4.2 is the **server process**'s
 * contract with an orchestrator — systemd reads `RestartPreventExitStatus`, Docker reads its
 * restart policy — and it uses sysexits numbers (65, 75, 78). This table is a **command**'s
 * contract with a person at a terminal and with a shell script, and it uses small numbers because
 * `09` §3.11.2 documents them in `comvivo help exit-codes` for people to read.
 *
 * `09` §3.11.2 states the one place they collide and which way it goes: `12` §4.2 "does not use 64
 * because CLI usage errors exit 2 here". So `comvivo start` in the foreground *becomes* the server
 * and exits with `12` §4.2's codes; every other command exits with these.
 *
 * ## Why this is a table and not a number per `throw`
 *
 * The code is the only part of a failure a script can read. A wrong one has a specific cost in
 * each direction: a configuration problem reported as a crash gets retried by a wrapper script
 * until somebody looks at the logs, and a held lock reported as a configuration problem makes an
 * operator go looking for a setting that is fine. So the mapping lives in one place, `CliError`
 * carries it, and `main.ts` is the only `process.exitCode` assignment in the package.
 */

/** `09` §3.11.2's table, named. */
export const CLI_EXIT = {
  ok: 0,
  /** A bug. Prints the `requestId` and the log path, because nothing else will explain it. */
  unexpected: 1,
  /** An unknown command or flag. commander's own parse failures land here. */
  usage: 2,
  /**
   * Invalid config, **or** a required input missing in non-interactive mode.
   *
   * One code for two situations because the fix is the same shape: something the run needed was
   * not supplied. `09` §3.11.2 requires the message to *name the flag to pass*, which is what
   * makes the two distinguishable to the person reading it.
   */
  config: 3,
  /** `doctor` found failures, or warnings with `--strict`. */
  checkFailed: 4,
  /** The server is not running or cannot be reached. */
  serverUnreachable: 5,
  /** Already running, lock held, or the port is in use. */
  alreadyRunning: 6,
  /** A permission or file-mode problem — `08` §3.7.3's keyfile modes live here. */
  permission: 7,
  /** An external dependency is unavailable: Docker, the network, a provider, a chat platform. */
  dependency: 8,
  /** Data integrity: a failed DB check, an unverifiable backup, the wrong key. */
  integrity: 9,
  /** Version skew, or a migration has to run first. */
  versionSkew: 10,
  /** Ctrl+C, or Esc in a prompt. `09` §3.11.2's `cancel()` path. */
  cancelled: 130,
} as const;

export type CliExitCode = (typeof CLI_EXIT)[keyof typeof CLI_EXIT];

/** Every code with its one-line meaning, for `comvivo help exit-codes` and for the table test. */
export const CLI_EXIT_MEANINGS: Readonly<Record<CliExitCode, string>> = {
  0: 'OK',
  1: 'Unexpected failure (a bug); prints the request id and the log path',
  2: 'Usage error (unknown command or flag)',
  3: 'Invalid config, or a required input missing in non-interactive mode',
  4: 'doctor found failures (or warnings with --strict)',
  5: 'The server is not running, or cannot be reached',
  6: 'Already running, a lock is held, or the port is in use',
  7: 'A permission or file-mode problem',
  8: 'An external dependency is unavailable (Docker, network, AI provider, chat platform)',
  9: 'A data-integrity problem (a database check failed, or a backup cannot be verified)',
  10: 'Version skew, or a migration is needed first',
  130: 'Cancelled by the user',
};

/**
 * A failure with an exit code and, where one exists, the next thing to do.
 *
 * `hint` is required for every code a host can act on, which is every code except `unexpected` —
 * `CLAUDE.md` §8 asks for "clear fix-it messages for every error", and an error class that made
 * the hint optional would make the hint the thing that gets left out. `unexpected` is the
 * exception because the honest hint is the log path, which `main.ts` adds.
 */
export class CliError extends Error {
  readonly exitCode: CliExitCode;
  readonly hint: string | undefined;
  /** A short, token-shaped code for `--json`'s `error.code`. Never prose. */
  readonly code: string;

  constructor(
    exitCode: CliExitCode,
    code: string,
    message: string,
    options: { readonly hint?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
    this.hint = options.hint;
  }
}

/** `09` §3.11.2's "missing required input in non-interactive mode", naming the flag to pass. */
export function missingInput(flag: string, what: string): CliError {
  return new CliError(
    CLI_EXIT.config,
    'MISSING_INPUT',
    `${what} is required and this run cannot prompt for it.`,
    { hint: `Pass ${flag}, or run without --non-interactive in a terminal.` },
  );
}
