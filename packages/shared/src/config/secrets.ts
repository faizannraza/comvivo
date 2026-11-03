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
 * `M0-T6` resolves secrets. `M1-T31` completes the module: scrubbing values out of `process.env`
 * after load, the child-process environment allowlist, and the `SecretString` wrapper that makes a
 * secret unprintable (`M0-T8`).
 */
import { BRAND } from '../brand.js';
import { ConfigError } from '../errors.js';
import { err, ok, type Result } from '../result.js';

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
  BRAND.envPrefix + 'IMAP_PASSWORD',
  BRAND.envPrefix + 'MASTER_KEY',
  BRAND.envPrefix + 'PASSPHRASE',
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
