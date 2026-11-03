/**
 * The configuration loader.
 *
 * ADR-014 and `01` §10. Reads `comvivo.yaml`, then `.env`, then the real environment, merges them
 * with the database's runtime settings in ADR-014's precedence order, and validates the result
 * against the schema.
 *
 * Three decisions worth stating:
 *
 *  - **Filesystem access is injected.** `ConfigIo` keeps the loader testable without touching a
 *    disk, which is why the precedence and `.env`-permission rules can be unit-tested exhaustively
 *    rather than hopefully.
 *  - **Every problem is reported, not just the first.** A host fixing a broken file wants the whole
 *    list; one problem per restart is a miserable way to spend five minutes, and `00` §3.7 promises
 *    the first useful answer inside five minutes.
 *  - **Nothing is logged from here.** The logger arrives in `M0-T8` and the loader runs before it,
 *    so warnings are returned as values. That also keeps `shared/config` free of a logging
 *    dependency it would otherwise acquire for one line.
 *
 * `M9` generates the full configuration reference from the schema. `M1-T31` completes secret
 * handling (scrubbing `process.env` after load, the child-process allowlist).
 */
import { parse as parseYaml } from 'yaml';
import { BRAND } from '../brand.js';
import { ConfigError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import { parse as parseWithSchema } from '../zod.js';
import { parseDotenv } from './dotenv.js';
import { type ConfigLeaf, envNameIndex } from './paths.js';
import { mergeByPrecedence, type Settings, type Source, unflatten } from './precedence.js';
import { type Config, configSchema } from './schema.js';
import { isSecretName } from './secrets.js';

/** Filesystem access, injected. */
export interface ConfigIo {
  readFile(path: string): string;
  /** POSIX mode bits (e.g. `0o600`), or `undefined` when the path does not exist. */
  fileMode(path: string): number | undefined;
}

export interface ConfigWarning {
  readonly code: 'legacy_config_name' | 'legacy_env_prefix' | 'malformed_env_line' | 'unknown_env';
  readonly message: string;
}

export interface LoadOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly io: ConfigIo;
  /** Runtime settings from the database. Host-only keys here are ignored (A14). */
  readonly db?: Settings;
  /** An explicit path, from the CLI's `--config`. Overrides the search. */
  readonly configPath?: string;
}

export interface LoadedConfig {
  readonly config: Config;
  readonly origin: ReadonlyMap<string, Source>;
  readonly warnings: readonly ConfigWarning[];
  /** Host-only paths the database tried to set. A security event, not a nuisance (`08` §5). */
  readonly rejectedHostOnlyFromDb: readonly string[];
  /** The file that was read, if any. */
  readonly configFile: string | undefined;
  readonly envFile: string | undefined;
}

/** Coerce one environment string to the type its schema leaf expects. */
export function coerceEnvValue(leaf: ConfigLeaf, raw: string): Result<unknown, string> {
  const text = raw.trim();
  if (leaf.nullable && (text === '' || text.toLowerCase() === 'null')) return ok(null);

  switch (leaf.type) {
    case 'boolean': {
      if (['1', 'true', 'yes', 'on'].includes(text.toLowerCase())) return ok(true);
      if (['0', 'false', 'no', 'off'].includes(text.toLowerCase())) return ok(false);
      return err(
        `expected a boolean (1/0, true/false, yes/no, on/off), got ${JSON.stringify(raw)}`,
      );
    }
    case 'integer':
    case 'number': {
      const n = Number(text);
      if (!Number.isFinite(n)) return err(`expected a number, got ${JSON.stringify(raw)}`);
      if (leaf.type === 'integer' && !Number.isInteger(n)) {
        return err(`expected a whole number, got ${JSON.stringify(raw)}`);
      }
      return ok(n);
    }
    case 'array': {
      // Comma-separated, so a host can write a list without learning JSON. An empty string clears
      // the list, which is how a YAML default gets removed from the environment.
      if (text === '') return ok([]);
      return ok(
        text
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== ''),
      );
    }
    case 'string':
      return ok(text);
    case 'union':
    case 'unknown': {
      // A union could be anything, so accept JSON and fall back to the raw string.
      try {
        return ok(JSON.parse(text));
      } catch {
        return ok(text);
      }
    }
  }
}

/** Candidate config file paths, current name first, then the legacy names `BRAND` still honours. */
function configCandidates(cwd: string, explicit: string | undefined): string[] {
  if (explicit !== undefined) return [explicit];
  return [
    `${cwd}/${BRAND.configFileName}`,
    ...BRAND.legacy.configFileNames.map((name) => `${cwd}/${name}`),
  ];
}

interface Stage {
  readonly warnings: ConfigWarning[];
  readonly problems: ConfigError[];
}

/** Read `comvivo.yaml`, or a legacy name, into a settings object. */
function readConfigFile(
  options: LoadOptions,
  stage: Stage,
): { settings: Settings; configFile: string | undefined } {
  const candidates = configCandidates(options.cwd, options.configPath);
  for (const candidate of candidates) {
    if (options.io.fileMode(candidate) === undefined) continue;

    if (candidate !== candidates[0]) {
      stage.warnings.push({
        code: 'legacy_config_name',
        message:
          `Loaded ${candidate}, which is a legacy name. Rename it to ${BRAND.configFileName}; ` +
          'the old name stops being accepted in 1.1.',
      });
    }

    try {
      // `merge: false` and the core schema: YAML anchors and merge keys are a way to smuggle
      // structure past a reviewer's eye, and nothing in this file format needs them.
      const parsed: unknown = parseYaml(options.io.readFile(candidate), {
        merge: false,
        schema: 'core',
      });
      if (parsed === null || parsed === undefined) return { settings: {}, configFile: candidate };
      if (typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { settings: parsed as Settings, configFile: candidate };
      }
      stage.problems.push(
        new ConfigError(`${candidate} must contain a mapping at the top level`, {
          path: '(root)',
          userMessage: 'The configuration file is not shaped like settings.',
        }),
      );
    } catch (cause) {
      stage.problems.push(
        new ConfigError(`${candidate} is not valid YAML`, {
          path: '(root)',
          userMessage: 'I could not read the configuration file.',
          cause,
        }),
      );
    }
    return { settings: {}, configFile: candidate };
  }
  return { settings: {}, configFile: undefined };
}

/**
 * Read `.env`, refusing it if other users can read it.
 *
 * `08` §3.10: loaded only at mode 0600 or tighter. Refusing is the right call — it holds API keys
 * and bot tokens, and a group-readable one on a shared box is a credential leak nobody would
 * notice. A host with an unusual setup can override with `<PREFIX>INSECURE_PERMISSIONS=1`, and
 * `doctor` keeps complaining about it.
 */
function readEnvFile(
  options: LoadOptions,
  stage: Stage,
): { fileEnv: Record<string, string>; envFile: string | undefined } {
  const path = `${options.cwd}/.env`;
  const mode = options.io.fileMode(path);
  if (mode === undefined) return { fileEnv: {}, envFile: undefined };

  const readableByOthers = (mode & 0o077) !== 0;
  const overridden = options.env[`${BRAND.envPrefix}INSECURE_PERMISSIONS`] === '1';
  if (readableByOthers && !overridden) {
    const octal = (mode & 0o777).toString(8).padStart(3, '0');
    stage.problems.push(
      new ConfigError(
        `${path} is readable by other users (mode ${octal}). Run: chmod 600 ${path}`,
        {
          code: 'config.insecure_permissions',
          path: '.env',
          userMessage: 'My secrets file is readable by other users, so I did not load it.',
        },
      ),
    );
    return { fileEnv: {}, envFile: undefined };
  }

  try {
    const parsed = parseDotenv(options.io.readFile(path));
    for (const { line, text } of parsed.malformedLines) {
      stage.warnings.push({
        code: 'malformed_env_line',
        message: `${path}:${String(line)} is not a KEY=value assignment and was skipped: ${text}`,
      });
    }
    return {
      fileEnv: Object.fromEntries(parsed.entries.map((entry) => [entry.key, entry.value])),
      envFile: path,
    };
  } catch (cause) {
    stage.problems.push(new ConfigError(`${path} could not be read`, { path: '.env', cause }));
    return { fileEnv: {}, envFile: undefined };
  }
}

/** Resolve one legacy-prefixed variable to its current name, or report that there is no such key. */
function legacyOverride(name: string): { renamed: string; leaf: ConfigLeaf } | undefined {
  const legacy = BRAND.legacy.envPrefixes.find((prefix) => name.startsWith(prefix));
  if (legacy === undefined) return undefined;
  const renamed = BRAND.envPrefix + name.slice(legacy.length);
  const leaf = envNameIndex().get(renamed);
  return leaf === undefined ? undefined : { renamed, leaf };
}

/** Turn environment variables into coerced settings, keyed by dotted path. */
function collectEnvOverrides(
  env: Readonly<Record<string, string | undefined>>,
  stage: Stage,
): Map<string, unknown> {
  const index = envNameIndex();
  const settings = new Map<string, unknown>();

  const apply = (leaf: ConfigLeaf, name: string, raw: string): void => {
    const coerced = coerceEnvValue(leaf, raw);
    if (coerced.ok) settings.set(leaf.path, coerced.value);
    else {
      stage.problems.push(
        new ConfigError(`${name}: ${coerced.error}`, {
          path: leaf.path,
          userMessage: `The setting ${leaf.path} was not something I could read.`,
        }),
      );
    }
  };

  for (const [name, raw] of Object.entries(env)) {
    if (raw === undefined) continue;

    const leaf = index.get(name);
    if (leaf !== undefined) {
      apply(leaf, name, raw);
      continue;
    }

    // A legacy prefix is accepted with a deprecation warning (`13` §3.A.6), so a host who tried an
    // earlier build is never stranded by the rename.
    const legacy = legacyOverride(name);
    if (legacy !== undefined) {
      stage.warnings.push({
        code: 'legacy_env_prefix',
        message: `${name} is a legacy name; use ${legacy.renamed}. The old prefix stops working in 1.1.`,
      });
      apply(legacy.leaf, name, raw);
    }
    // Anything else is simply not ours. The environment is full of other people's variables.
  }

  return settings;
}

/**
 * Secrets must never travel through the settings object.
 *
 * A secret inside `Config` would reach traces, exports and the dashboard, which `08` §3.10 (S2)
 * forbids outright. This asserts the two name spaces cannot overlap, so the invariant is checked
 * rather than assumed.
 */
function assertSecretsAreNotSettings(
  env: Readonly<Record<string, string | undefined>>,
  stage: Stage,
): void {
  const index = envNameIndex();
  for (const name of Object.keys(env)) {
    if (isSecretName(name) && index.has(name)) {
      stage.problems.push(
        new ConfigError(
          `${name} is both a secret and a configuration key, which must never overlap`,
          { path: name },
        ),
      );
    }
  }
}

export function loadConfig(options: LoadOptions): Result<LoadedConfig, ConfigError[]> {
  const stage: Stage = { warnings: [], problems: [] };

  const { settings: yaml, configFile } = readConfigFile(options, stage);
  const { fileEnv, envFile } = readEnvFile(options, stage);

  // The real environment beats `.env`, which is what `COMVIVO_LOGGING_LEVEL=debug comvivo start`
  // expects to do.
  const effectiveEnv: Record<string, string | undefined> = { ...fileEnv, ...options.env };
  const envSettings = collectEnvOverrides(effectiveEnv, stage);
  assertSecretsAreNotSettings(effectiveEnv, stage);

  const merged = mergeByPrecedence({
    yaml,
    ...(options.db === undefined ? {} : { db: options.db }),
    // Env overrides arrive keyed by dotted path, so nest them before merging rather than relying on
    // flatten/unflatten to round-trip a dotted key by coincidence.
    env: unflatten(envSettings),
  });

  const validated = parseWithSchema(configSchema, merged.settings);
  if (!validated.ok) {
    for (const issue of validated.error.issues) {
      stage.problems.push(
        new ConfigError(`${issue.path}: ${issue.message}`, {
          path: issue.path,
          userMessage: 'One of my settings was not valid, so I did not start.',
        }),
      );
    }
  }

  if (stage.problems.length > 0) return err(stage.problems);
  if (!validated.ok) return err([new ConfigError('configuration is invalid')]);

  return ok({
    config: validated.value,
    origin: merged.origin,
    warnings: stage.warnings,
    rejectedHostOnlyFromDb: merged.rejectedHostOnlyFromDb,
    configFile,
    envFile,
  });
}
