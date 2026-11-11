/**
 * Secret resolution.
 *
 * `08` §3.10: every secret arrives from the environment, or from a file named by `<NAME>_FILE`.
 * Secrets are **never** stored in `comvivo.yaml`, never in the database, never in an export, and
 * never in a trace.
 *
 * `_FILE` is not a convenience. It is how Docker secrets, Kubernetes projected volumes and
 * systemd's `LoadCredentialEncrypted=` all deliver a value, and it keeps the secret out of
 * `docker inspect` and out of any process listing — which a plain environment variable cannot.
 * `08` §5's table recommends preferring it for exactly that reason.
 *
 * `M0-T6` resolved secrets; `M1-T31` completed the module with the three things §3.10 asks for
 * beyond resolution — scrubbing the values out of `process.env` after load, the child-process
 * environment allowlist, and handing every value back as a `SecretString` so it cannot be printed
 * by accident (§3.7.13).
 */
import { BRAND } from '../brand.js';
import { ConfigError } from '../errors.js';
import { err, ok, type Result } from '../result.js';
import { SecretString } from '../secrets/secret-string.js';

/**
 * Every secret this project accepts, from `08` §3.10.
 *
 * Platform tokens are deliberately **not** prefixed: `TELEGRAM_BOT_TOKEN` is what Telegram's own
 * documentation calls it, and a host copying from those docs should not have to learn our
 * convention. Our own variables take `BRAND.envPrefix`, so a rename moves them in one edit.
 */
export const SECRET_NAMES: readonly string[] = [
  // Model providers
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  // Chat platforms
  'TELEGRAM_BOT_TOKEN',
  'DISCORD_BOT_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'MATRIX_ACCESS_TOKEN',
  // Ours
  `${BRAND.envPrefix}IMAP_PASSWORD`,
  `${BRAND.envPrefix}MASTER_KEY`,
  `${BRAND.envPrefix}PASSPHRASE`,
  // The bearer token for `/metrics` (`11` §3.10.3). A scrape is an activity profile of a
  // household, so the endpoint answers loopback or this token and 404s everything else — which
  // means in Docker, where Prometheus is outside the container, the token is the only way in.
  `${BRAND.envPrefix}METRICS_TOKEN`,
];

export type SecretName = (typeof SECRET_NAMES)[number];

/** Where a secret came from, so `doctor` can tell a host what it is actually using. */
export type SecretSource = 'env' | 'file';

export interface ResolvedSecret {
  readonly name: string;
  readonly value: string;
  readonly source: SecretSource;
  /** Set when the value came from a file, for the permission check in `doctor`. */
  readonly path?: string;
}

/** Filesystem access, injected so the resolver is testable without touching a disk. */
export interface SecretIo {
  readFile(path: string): string;
}

/**
 * Resolve one secret.
 *
 * Direct environment wins over `_FILE`, which lets a developer override a mounted secret for one
 * run without editing the mount. A `_FILE` that cannot be read is an **error**, not a miss: the
 * host clearly meant to supply it, and silently continuing without it would surface later as a
 * confusing authentication failure instead of a clear startup message.
 *
 * Trailing whitespace is trimmed, because `echo secret > file` adds a newline and the resulting
 * 401 is otherwise genuinely hard to diagnose.
 */
export function resolveSecret(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  io: SecretIo,
): Result<ResolvedSecret | undefined, ConfigError> {
  const direct = env[name];
  if (direct !== undefined && direct !== '') {
    return ok({ name, value: direct, source: 'env' });
  }

  const filePath = env[`${name}_FILE`];
  if (filePath === undefined || filePath === '') return ok(undefined);

  try {
    const raw = io.readFile(filePath);
    const value = raw.replace(/\r?\n$/, '').trim();
    if (value === '') {
      return err(
        new ConfigError(`${name}_FILE points at an empty file: ${filePath}`, {
          code: 'config.secret_missing',
          path: `${name}_FILE`,
          userMessage: `The file for ${name} is empty.`,
          detail: { name },
        }),
      );
    }
    return ok({ name, value, source: 'file', path: filePath });
  } catch (cause) {
    return err(
      new ConfigError(`${name}_FILE could not be read: ${filePath}`, {
        code: 'config.secret_missing',
        path: `${name}_FILE`,
        userMessage: `I could not read the file holding ${name}.`,
        detail: { name },
        cause,
      }),
    );
  }
}

/**
 * Resolve every known secret. Missing ones are simply absent — which secrets are *required* depends
 * on the configuration (a host with only Telegram enabled needs no Discord token), so that check
 * belongs to `doctor` and to each subsystem's startup, not here.
 */
export function resolveSecrets(
  env: Readonly<Record<string, string | undefined>>,
  io: SecretIo,
  names: readonly string[] = SECRET_NAMES,
): Result<Map<string, ResolvedSecret>, ConfigError[]> {
  const found = new Map<string, ResolvedSecret>();
  const problems: ConfigError[] = [];
  for (const name of names) {
    const outcome = resolveSecret(name, env, io);
    if (!outcome.ok) problems.push(outcome.error);
    else if (outcome.value !== undefined) found.set(name, outcome.value);
  }
  return problems.length === 0 ? ok(found) : err(problems);
}

/** Is this environment variable name a secret, or a secret's `_FILE` pointer? */
export function isSecretName(name: string): boolean {
  return SECRET_NAMES.includes(name) || SECRET_NAMES.some((s) => name === `${s}_FILE`);
}

/* --- M1-T31: scrubbing, child environments and extension secrets ----------------------------- */

/**
 * The extension-secret name shapes (`08` §3.10, `10` §3.3.2, §3.9.1).
 *
 * A plugin's and an MCP client's secrets are host-entered and vault-stored, but env (or `_FILE`)
 * takes precedence — so these names reach `process.env` and have to be scrubbed from it like every
 * other secret. They cannot be listed, because the id is the plugin's, so they are patterns.
 */
const EXTENSION_SECRET_PATTERNS: readonly RegExp[] = [
  new RegExp(`^${BRAND.envPrefix}PLUGIN_[A-Z0-9_]+$`),
  new RegExp(`^${BRAND.envPrefix}MCP_CLIENT_[A-Z0-9_]+$`),
];

/**
 * Environment variables a child process may see (`08` §3.10).
 *
 * Four names, and that is the whole list: `PATH` because a child has to find its interpreter, `TZ`
 * and `LANG` because a child that formats a date or sorts a list must agree with the parent, and
 * `NODE_ENV` because the runtime reads it. Everything else — including every secret the parent
 * holds — is withheld and passed deliberately or not at all.
 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  'PATH',
  'TZ',
  'LANG',
  'NODE_ENV',
]);

/**
 * Is this name a secret, a secret's `_FILE` pointer, or an extension secret?
 *
 * Used by the scrubber, so a name it does not recognise is a secret that stays in `process.env`
 * for the lifetime of the process — which is the thing §3.10 is trying to prevent.
 */
export function isSecretEnvName(name: string): boolean {
  if (isSecretName(name)) return true;
  const base = name.endsWith('_FILE') ? name.slice(0, -'_FILE'.length) : name;
  return EXTENSION_SECRET_PATTERNS.some((pattern) => pattern.test(base));
}

/**
 * Remove every secret from an environment object, in place, and report what was removed.
 *
 * `08` §3.10: "The parent's secrets are removed from `process.env` after load." The reason is
 * narrow and worth stating: it does not protect against an attacker who can read this process's
 * memory, and it is not a substitute for the vault. What it does is make the two accidents that
 * actually happen impossible — a child process inheriting the parent's keys because somebody
 * passed `process.env` with a spread, and a crash dump or a diagnostic that prints the environment.
 *
 * Called **after** `resolveSecrets`, with the resolved values held as `SecretString`s, which is why
 * this is a separate function rather than something the resolver does: a resolver that destroyed
 * its own input would be impossible to call twice, and the config loader reads the environment
 * more than once (`precedence.ts`).
 */
export function scrubSecretsFromEnv(env: Record<string, string | undefined>): readonly string[] {
  const removed: string[] = [];
  for (const name of Object.keys(env)) {
    if (!isSecretEnvName(name)) continue;
    // `_FILE` pointers go too. The path is not a secret, but it is a map to one, and a child that
    // can read the file does not need the variable to have been passed to it.
    //
    // `Reflect.deleteProperty` rather than `delete env[name]` (the lint rule
    // `no-dynamic-delete`) — and emphatically not `env[name] = undefined`: measured on Node
    // 26.13.0, assigning `undefined` to a `process.env` key stores the **string** `"undefined"`,
    // so the variable survives with a value that looks like an absence.
    Reflect.deleteProperty(env, name);
    removed.push(name);
  }
  return removed.toSorted();
}

/**
 * The environment to give a child process (`08` §3.10).
 *
 * Built from the allowlist plus whatever the caller passes **explicitly**, so a plugin receives
 * only its declared secrets (`10` §3.4.3) and a transcription subprocess receives none. The parent
 * environment is an *input* here rather than the default: `{...process.env, ...extra}` is the shape
 * this function exists to prevent anybody writing.
 */
export function childEnv(
  parent: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const child: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = parent[name];
    if (value !== undefined) child[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) child[name] = value;
  return child;
}

/**
 * Resolve every secret and hand back `SecretString`s, scrubbing the environment behind them.
 *
 * The one function a composition root should call: `08` §3.7.13 wants secrets travelling as
 * `SecretString` and §3.10 wants them out of `process.env`, and doing one without the other leaves
 * the plain value in the place most likely to be printed. The `env` object is **mutated** — that is
 * the point — so a caller that wants to keep it must copy it first.
 */
export function loadSecrets(
  env: Record<string, string | undefined>,
  io: SecretIo,
  names: readonly string[] = SECRET_NAMES,
): Result<
  {
    readonly secrets: Map<string, SecretString>;
    readonly sources: Map<string, SecretSource>;
    readonly scrubbed: readonly string[];
  },
  ConfigError[]
> {
  const resolved = resolveSecrets(env, io, names);
  if (!resolved.ok) return resolved;
  const secrets = new Map<string, SecretString>();
  const sources = new Map<string, SecretSource>();
  for (const [name, found] of resolved.value) {
    secrets.set(name, new SecretString(name, found.value));
    sources.set(name, found.source);
  }
  return ok({ secrets, sources, scrubbed: scrubSecretsFromEnv(env) });
}
