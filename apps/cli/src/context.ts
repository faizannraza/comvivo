/**
 * What a command needs to know before it runs (`09` §3.11.2; `M3-T13`).
 *
 * Three questions, each with an answer the spec fixes:
 *
 *  - **Where is the install?** `-C/--dir`, then `COMVIVO_DIR`, then an upward search from the
 *    working directory for `comvivo.yaml`, then `./comvivo/comvivo.yaml`.
 *  - **Where is the data?** `--data-dir`, then `COMVIVO_DATA_DIR`, then `instance.dataDir` from the
 *    configuration file, relative to the install folder.
 *  - **May this run prompt?** `output.ts`'s `canPrompt`, from four conditions.
 *
 * ## Why the upward search stops where it does
 *
 * It walks to the filesystem root and no further, and it reads **only** the file name — never the
 * file. A host who runs `comvivo status` three directories inside their install expects it to
 * work; a host who runs it in `/tmp` expects to be told there is no install, not to have the
 * command find somebody else's. Stopping at the root rather than at a home directory is the
 * behaviour `09` §3.11.2 describes, and the limit is the one `git` uses for the same reason.
 *
 * The configuration file is **not parsed here**. `09` §3.11.2 needs only `instance.dataDir`, and a
 * command that fails on an unrelated configuration error before it has even decided where to look
 * would make `comvivo doctor` — the command whose job is to explain a bad configuration — the
 * hardest one to run. So this reads one key with a narrow parse and leaves validation to the
 * commands that need the whole of it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { BRAND, envVar } from '@comvivo/shared';
import { parse as parseYaml } from 'yaml';
import { copy } from './copy.js';
import { CLI_EXIT, CliError } from './exit-codes.js';

/** The global options every command shares (`09` §3.11.2). */
export interface GlobalOptions {
  readonly dir?: string | undefined;
  readonly dataDir?: string | undefined;
  readonly json?: boolean | undefined;
  readonly nonInteractive?: boolean | undefined;
  readonly yes?: boolean | undefined;
}

/** The environment, injected so a test needs no `process`. */
export interface Environment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly isTty: boolean;
}

export interface CliContext {
  /** The install folder: the directory holding `comvivo.yaml`. */
  readonly dir: string;
  /** Absolute path to the data directory. */
  readonly dataDir: string;
  /** Absolute path to the configuration file, whether or not it exists. */
  readonly configPath: string;
  readonly configExists: boolean;
  readonly json: boolean;
  readonly nonInteractive: boolean;
  readonly yes: boolean;
  readonly isTty: boolean;
  readonly ci: boolean;
}

/** `09` §3.11.2's fallback when no folder was given and none was found. */
const NESTED = BRAND.slug;

/**
 * Find the install folder, or throw with the one thing a host can do about it.
 *
 * Returns the folder, not the file: every other path in `09` §3.11.2 is relative to the folder.
 */
export function findInstallDir(options: GlobalOptions, environment: Environment): string {
  const named = options.dir ?? environment.env[envVar('DIR')];
  if (named !== undefined && named !== '') return resolve(environment.cwd, named);

  // Upward from the working directory. `09` §3.11.2's search, and it checks the **name** only:
  // reading the file here would turn an unrelated syntax error into "no install found".
  let at = resolve(environment.cwd);
  for (;;) {
    if (existsSync(resolve(at, BRAND.configFileName))) return at;
    const up = dirname(at);
    if (up === at) break;
    at = up;
  }

  // Then `./comvivo/comvivo.yaml`, which is where `comvivo init` puts a fresh install by default.
  const nested = resolve(environment.cwd, NESTED);
  if (existsSync(resolve(nested, BRAND.configFileName))) return nested;

  throw new CliError(CLI_EXIT.config, 'NO_INSTALL', copy('error.noInstall'), {
    hint: copy('error.noInstall.hint', { dirVar: envVar('DIR') }),
  });
}

/**
 * `instance.dataDir` from the configuration file, or `undefined`.
 *
 * A **narrow** read: the file is parsed, one key is taken, and nothing else is validated. A
 * malformed file gives `undefined` rather than throwing, because the command that explains a
 * malformed file (`doctor`) has to be able to start — and because the data directory is also
 * settable by flag and by environment variable, so a bad file need not stop a command that was
 * told where to look.
 */
function dataDirFromConfig(configPath: string): string | undefined {
  try {
    const parsed = parseYaml(readFileSync(configPath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const instance = (parsed as { instance?: unknown }).instance;
    if (typeof instance !== 'object' || instance === null) return undefined;
    const dataDir = (instance as { dataDir?: unknown }).dataDir;
    return typeof dataDir === 'string' && dataDir !== '' ? dataDir : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve everything a command needs, in `09` §3.11.2's precedence order. */
export function resolveContext(options: GlobalOptions, environment: Environment): CliContext {
  const dir = findInstallDir(options, environment);
  const configPath = resolve(dir, BRAND.configFileName);
  const configExists = existsSync(configPath);

  const named = options.dataDir ?? environment.env[envVar('DATA_DIR')];
  const fromConfig = configExists ? dataDirFromConfig(configPath) : undefined;
  // `--data-dir`, then the environment, then the file, then the default. Resolved against the
  // **install folder** rather than the working directory, because `09` §3.11.2 says
  // `instance.dataDir` is relative to the folder — and a relative path that moved with the shell
  // would make `comvivo backup` write somewhere different depending on where it was run.
  const candidate = named !== undefined && named !== '' ? named : (fromConfig ?? 'data');
  const dataDir = isAbsolute(candidate) ? candidate : resolve(dir, candidate);

  const json = options.json === true;
  return {
    dir,
    dataDir,
    configPath,
    configExists,
    json,
    nonInteractive: options.nonInteractive === true,
    yes: options.yes === true,
    isTty: environment.isTty,
    // `CI=true` exactly, per `09` §3.11.2. Not "any truthy value": `CI=false` is set by at least
    // one provider to mean *not* CI, and treating it as CI would silence prompts on a developer's
    // machine for a reason nobody could find.
    ci: environment.env['CI'] === 'true',
  };
}
