/**
 * `comvivo`
 *
 * The `comvivo` command: init wizard, start, doctor, backup, restore, export, migrate, eval and
 * keys. `bin/comvivo.mjs` is the entry point a host runs; this is the package's module surface,
 * for `apps/server` and for the docs-as-tests harness.
 *
 * `M3-T13` added the skeleton — the program, the global options, the exit-code mapping, the copy
 * catalog and `comvivo keys` — and the rest of `09` §3.11.3's commands arrive with their own
 * tasks.
 */

export { keysCommand } from './commands/keys/index.js';
export { versionCommand } from './commands/version.js';
export {
  type CliContext,
  type Environment,
  findInstallDir,
  type GlobalOptions,
  resolveContext,
} from './context.js';
export { type CopyKey, copy, copyKeys } from './copy.js';
export type { CommandDeps } from './deps.js';
export {
  CLI_EXIT,
  CLI_EXIT_MEANINGS,
  CliError,
  type CliExitCode,
  missingInput,
} from './exit-codes.js';
export {
  KEYS_SUBDIR,
  keySourceFor,
  type OpenedKeyring,
  openKeyring,
  openMasterKey,
  readPassphrase,
  readRecoveryKey,
} from './keys/open.js';
export { type RunOptions, run } from './main.js';
export {
  canPrompt,
  type JsonEnvelope,
  Printer,
  type PrinterOptions,
  type Streams,
  versionSkewWarning,
} from './output.js';
