/**
 * What a command is handed instead of reaching for the process (`M3-T13`).
 *
 * Every side effect a command needs — the context, the printer, the environment, reading a secret
 * from the terminal, confirming something destructive, storing a key, running `08` §3.7.6's
 * ceremony — arrives through this one object. The reason is testability of the paths that matter:
 * `keys rotate-recovery` must be exercisable without a TTY, and `keys purge-retired`'s
 * confirmation must be assertable without a human to answer it.
 *
 * It also makes one rule structural. `ceremony` is **the only** member that receives a recovery
 * key, so `08` SD-04 — "printed once, never stored on the host" — is a property of one function
 * rather than of eight commands remembering.
 */

import type { MasterKeyStore } from '@comvivo/storage/crypto';
import type { CliContext } from './context.js';
import type { CliExitCode } from './exit-codes.js';
import type { Printer } from './output.js';

export interface CommandDeps {
  /** The resolved context. A function, because `--dir` is parsed before any command runs. */
  context(): CliContext;
  printer(): Printer;
  /** `process.env`, or a test's copy. Mutated by `env`-store key reads (`08` §3.7.3 rule 1). */
  readonly env: Record<string, string | undefined>;
  /** `output.ts`'s four-condition answer, resolved once per run. */
  canPrompt(): boolean;
  /** Which of `08` §3.7.3's five stores this install uses, for `keys status`. */
  keyStore(context: CliContext): MasterKeyStore;
  /**
   * Read one secret line without echoing it.
   *
   * Used for a typed recovery key. Never a flag value (`09` §3.11.2: shell history), and never
   * logged. Returns the raw line; the caller trims.
   */
  readSecretLine(): Promise<string>;
  /** A new passphrase, asked for twice. `add-passphrase`'s input. */
  readNewPassphrase(): Promise<string>;
  /**
   * Confirm something destructive, or throw `CLI_EXIT.cancelled`.
   *
   * **Reads `--yes` itself** rather than taking it as a parameter, and that is a measured fix
   * rather than a tidy-up. `--yes` is a *global* option (`09` §3.11.2), and commander binds a
   * duplicated option name to the **parent** — so a subcommand that declared its own `--yes` and
   * read `options.yes` got `undefined` even when the flag was passed after the subcommand name.
   * `comvivo keys rotate-master --yes` would have prompted anyway, and refused in CI. Reading the
   * global in one place means no command can get it wrong.
   *
   * `09` §3.11.2 is explicit that `--yes` covers the *default* confirmations and that a
   * destructive operation still needs its own explicit flag — which is why `purge-retired` has
   * `--blobs-rewrapped` as well.
   */
  confirm(question: string, consequence: string): Promise<void>;
  /**
   * `08` §3.7.6's recovery-key ceremony: print the key, have the host confirm they wrote it down.
   *
   * Returns `false` if they did not, which aborts the rotation — a `rotate-recovery` that replaced
   * the slot after the host closed the terminal would have destroyed the old key and given them
   * nothing. The optional path is `--recovery-key-out`.
   *
   * **The only member that sees a recovery key.** See this module's header.
   */
  ceremony(printed: string, outFile?: string): Promise<boolean>;
  /** Write the new master key to whichever store this install uses (`08` §3.7.3). */
  storeMasterKey(context: CliContext, key: Buffer): Promise<void>;
  /** Set the process exit code without throwing, for a command whose *answer* is a failure. */
  setExitCode(code: CliExitCode): void;
}
