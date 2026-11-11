/**
 * Secret resolution (`08` §3.10). The `_FILE` form is how Docker secrets, Kubernetes projected
 * volumes and systemd's `LoadCredentialEncrypted=` all deliver a value, and it keeps the secret out
 * of `docker inspect` and any process listing.
 */
import { describe, expect, it } from 'vitest';
import { BRAND } from '../brand.js';
import {
  CHILD_ENV_ALLOWLIST,
  childEnv,
  isSecretEnvName,
  isSecretName,
  loadSecrets,
  resolveSecret,
  resolveSecrets,
  SECRET_NAMES,
  type SecretIo,
  scrubSecretsFromEnv,
} from './secrets.js';

const files = (contents: Record<string, string>): SecretIo => ({
  readFile(path) {
    const value = contents[path];
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  },
});

describe('resolveSecret', () => {
  it('reads a direct environment variable', () => {
    const result = resolveSecret('ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: 'sk-1' }, files({}));
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value).toEqual({ name: 'ANTHROPIC_API_KEY', value: 'sk-1', source: 'env' });
  });

  it('reads the _FILE form', () => {
    const result = resolveSecret(
      'ANTHROPIC_API_KEY',
      { ANTHROPIC_API_KEY_FILE: '/run/secrets/anthropic' },
      files({ '/run/secrets/anthropic': 'sk-2' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value?.value).toBe('sk-2');
      expect(result.value?.source).toBe('file');
      expect(result.value?.path).toBe('/run/secrets/anthropic');
    }
  });

  it('trims the trailing newline that `echo secret > file` adds', () => {
    // Without this the value carries a newline, the provider returns 401, and the cause is
    // genuinely hard to see.
    const result = resolveSecret(
      'ANTHROPIC_API_KEY',
      { ANTHROPIC_API_KEY_FILE: '/f' },
      files({ '/f': 'sk-3\n' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.value).toBe('sk-3');
  });

  it('lets a direct variable override a mounted file, for a one-off local run', () => {
    const result = resolveSecret(
      'ANTHROPIC_API_KEY',
      { ANTHROPIC_API_KEY: 'from-env', ANTHROPIC_API_KEY_FILE: '/f' },
      files({ '/f': 'from-file' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value?.value).toBe('from-env');
  });

  it('treats an empty environment variable as absent, not as an empty secret', () => {
    const result = resolveSecret('ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: '' }, files({}));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeUndefined();
  });

  it('returns nothing when neither form is set', () => {
    const result = resolveSecret('ANTHROPIC_API_KEY', {}, files({}));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeUndefined();
  });

  it('errors when _FILE points at something unreadable', () => {
    // A miss would be wrong here: the host clearly meant to supply it, and continuing silently
    // surfaces later as a confusing authentication failure instead of a clear startup message.
    const result = resolveSecret(
      'ANTHROPIC_API_KEY',
      { ANTHROPIC_API_KEY_FILE: '/missing' },
      files({}),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('config.secret_missing');
      expect(result.error.message).toContain('/missing');
    }
  });

  it('errors when _FILE points at an empty file', () => {
    const result = resolveSecret(
      'ANTHROPIC_API_KEY',
      { ANTHROPIC_API_KEY_FILE: '/f' },
      files({ '/f': '\n' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('empty file');
  });

  it('never puts the secret value in the error', () => {
    const result = resolveSecret(
      'ANTHROPIC_API_KEY',
      { ANTHROPIC_API_KEY_FILE: '/f' },
      files({ '/f': '  ' }),
    );
    if (!result.ok) {
      expect(JSON.stringify(result.error.detail)).not.toContain('  ');
      expect(result.error.detail).toEqual({ name: 'ANTHROPIC_API_KEY' });
    }
  });
});

describe('resolveSecrets', () => {
  it('collects everything present and ignores what is absent', () => {
    // Which secrets are *required* depends on the configuration — a host running only Telegram
    // needs no Discord token — so that check belongs to `doctor`, not here.
    const result = resolveSecrets({ ANTHROPIC_API_KEY: 'a', TELEGRAM_BOT_TOKEN: 'b' }, files({}));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect([...result.value.keys()].sort()).toEqual(['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN']);
    }
  });

  it('reports every broken _FILE, not just the first', () => {
    const result = resolveSecrets(
      { ANTHROPIC_API_KEY_FILE: '/a', OPENAI_API_KEY_FILE: '/b' },
      files({}),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toHaveLength(2);
  });
});

describe('the secret list', () => {
  it('covers every provider and platform in 08 §3.10', () => {
    for (const name of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'TELEGRAM_BOT_TOKEN',
      'DISCORD_BOT_TOKEN',
      'SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'MATRIX_ACCESS_TOKEN',
    ]) {
      expect(SECRET_NAMES).toContain(name);
    }
  });

  it("leaves platform tokens unprefixed, matching each platform's own documentation", () => {
    // A host copying from Telegram's docs should not have to learn our convention.
    expect(SECRET_NAMES).toContain('TELEGRAM_BOT_TOKEN');
    expect(SECRET_NAMES).not.toContain(`${BRAND.envPrefix}TELEGRAM_BOT_TOKEN`);
  });

  it('prefixes our own variables through BRAND, so a rename moves them in one edit', () => {
    expect(SECRET_NAMES).toContain(`${BRAND.envPrefix}MASTER_KEY`);
    expect(SECRET_NAMES).toContain(`${BRAND.envPrefix}PASSPHRASE`);
    expect(SECRET_NAMES).toContain(`${BRAND.envPrefix}IMAP_PASSWORD`);
  });

  it('recognises both a secret and its _FILE pointer', () => {
    expect(isSecretName('ANTHROPIC_API_KEY')).toBe(true);
    expect(isSecretName('ANTHROPIC_API_KEY_FILE')).toBe(true);
    expect(isSecretName(`${BRAND.envPrefix}LOGGING_LEVEL`)).toBe(false);
  });
});

describe('scrubbing the environment (08 §3.10)', () => {
  it('removes every secret and every `_FILE` pointer', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'sk-ant-1',
      TELEGRAM_BOT_TOKEN_FILE: '/run/secrets/telegram',
      [`${BRAND.envPrefix}MASTER_KEY`]: 'bWs',
      [`${BRAND.envPrefix}PLUGIN_WEATHER_API_KEY`]: 'plugin-secret',
      [`${BRAND.envPrefix}MCP_CLIENT_HOMEASSISTANT_TOKEN_FILE`]: '/run/secrets/ha',
      PATH: '/usr/bin',
      TZ: 'Europe/Lisbon',
      [`${BRAND.envPrefix}DATA_DIR`]: '/var/lib/x',
    };
    const removed = scrubSecretsFromEnv(env);
    // The two extension shapes matter as much as the fixed list: a plugin secret that stays in
    // `process.env` is one every child process inherits.
    expect(removed).toEqual([
      'ANTHROPIC_API_KEY',
      `${BRAND.envPrefix}MASTER_KEY`,
      `${BRAND.envPrefix}MCP_CLIENT_HOMEASSISTANT_TOKEN_FILE`,
      `${BRAND.envPrefix}PLUGIN_WEATHER_API_KEY`,
      'TELEGRAM_BOT_TOKEN_FILE',
    ]);
    // Everything that is not a secret survives, including our own non-secret variables.
    expect(Object.keys(env).toSorted()).toEqual(
      [`${BRAND.envPrefix}DATA_DIR`, 'PATH', 'TZ'].toSorted(),
    );
  });

  it('recognises a secret by name, by pointer and by extension shape', () => {
    expect(isSecretEnvName('OPENAI_API_KEY')).toBe(true);
    expect(isSecretEnvName('OPENAI_API_KEY_FILE')).toBe(true);
    expect(isSecretEnvName(`${BRAND.envPrefix}PLUGIN_CHORES_WEBHOOK`)).toBe(true);
    expect(isSecretEnvName(`${BRAND.envPrefix}MCP_CLIENT_X_TOKEN`)).toBe(true);
    // Not secrets: a path, a log level, and a name that merely looks adjacent.
    expect(isSecretEnvName(`${BRAND.envPrefix}DATA_DIR`)).toBe(false);
    expect(isSecretEnvName('PATH')).toBe(false);
    expect(isSecretEnvName('PLUGIN_SOMETHING')).toBe(false);
  });
});

describe('the child-process environment (08 §3.10)', () => {
  it('passes four names and nothing else', () => {
    const child = childEnv({
      PATH: '/usr/bin',
      TZ: 'UTC',
      LANG: 'en_GB.UTF-8',
      NODE_ENV: 'production',
      ANTHROPIC_API_KEY: 'sk-ant-1',
      HOME: `/home/${BRAND.slug}`,
      SSH_AUTH_SOCK: 'a-socket-path',
    });
    // `{...process.env, ...extra}` is the shape this function exists to prevent: the allowlist is
    // what a child gets, and the parent environment is an input rather than the default.
    expect(child).toEqual({
      PATH: '/usr/bin',
      TZ: 'UTC',
      LANG: 'en_GB.UTF-8',
      NODE_ENV: 'production',
    });
    expect(CHILD_ENV_ALLOWLIST).toEqual(['PATH', 'TZ', 'LANG', 'NODE_ENV']);
  });

  it('adds only what the caller declares', () => {
    // A plugin receives its own declared secrets and no others (`10` §3.4.3).
    const child = childEnv(
      { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-1' },
      {
        [`${BRAND.envPrefix}PLUGIN_WEATHER_API_KEY`]: 'only-this-one',
      },
    );
    expect(child).toEqual({
      PATH: '/usr/bin',
      [`${BRAND.envPrefix}PLUGIN_WEATHER_API_KEY`]: 'only-this-one',
    });
  });

  it('omits an allowlisted name the parent does not have', () => {
    expect(childEnv({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' });
    expect(childEnv({})).toEqual({});
  });
});

describe('loadSecrets (08 §3.10, §3.7.13)', () => {
  it('hands back SecretStrings and scrubs the environment', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'sk-ant-live',
      TELEGRAM_BOT_TOKEN_FILE: '/run/secrets/telegram',
      PATH: '/usr/bin',
    };
    const loaded = loadSecrets(env, files({ '/run/secrets/telegram': '123456:abcdef\n' }));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect([...loaded.value.secrets.keys()].toSorted()).toEqual([
      'ANTHROPIC_API_KEY',
      'TELEGRAM_BOT_TOKEN',
    ]);
    // A `SecretString`, so `console.log` cannot print it and `.expose()` is the greppable audit
    // trail (`08` §3.7.13).
    expect(String(loaded.value.secrets.get('ANTHROPIC_API_KEY'))).toBe('[redacted]');
    expect(loaded.value.secrets.get('ANTHROPIC_API_KEY')?.expose()).toBe('sk-ant-live');
    expect(loaded.value.secrets.get('TELEGRAM_BOT_TOKEN')?.expose()).toBe('123456:abcdef');
    // The source, for `doctor`'s D-10 check: a master key from env rather than `_FILE` is a warn.
    expect(loaded.value.sources.get('TELEGRAM_BOT_TOKEN')).toBe('file');
    expect(loaded.value.sources.get('ANTHROPIC_API_KEY')).toBe('env');
    // And the environment no longer holds either.
    expect(loaded.value.scrubbed).toEqual(['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN_FILE']);
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['TELEGRAM_BOT_TOKEN_FILE']).toBeUndefined();
    // The **key** is gone, not set to `undefined`: measured on Node 26.13.0, assigning `undefined`
    // to a `process.env` key stores the string `"undefined"`, so a scrubber that assigned would
    // leave the variable in place with a value that merely looks like an absence.
    expect(Object.hasOwn(env, 'ANTHROPIC_API_KEY')).toBe(false);
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('reports the problems and scrubs nothing when a `_FILE` cannot be read', () => {
    const env: Record<string, string | undefined> = {
      ANTHROPIC_API_KEY: 'sk-ant-live',
      OPENAI_API_KEY_FILE: '/run/secrets/missing',
    };
    const loaded = loadSecrets(env, files({}));
    expect(loaded.ok).toBe(false);
    // Deliberate: a startup that is going to fail should leave the environment as the host left
    // it, so a diagnostic run in the same shell still sees what they configured.
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-live');
  });
});
