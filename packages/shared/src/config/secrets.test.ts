/**
 * Secret resolution (`08` §3.10). The `_FILE` form is how Docker secrets, Kubernetes projected
 * volumes and systemd's `LoadCredentialEncrypted=` all deliver a value, and it keeps the secret out
 * of `docker inspect` and any process listing.
 */
import { describe, expect, it } from 'vitest';
import { BRAND } from '../brand.js';
import {
  isSecretName,
  resolveSecret,
  resolveSecrets,
  SECRET_NAMES,
  type SecretIo,
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
    if (result.ok) expect(result.value?.value).toBe('sk-3');
  });

  it('lets a direct variable override a mounted file, for a one-off local run', () => {
    const result = resolveSecret(
      'ANTHROPIC_API_KEY',
      { ANTHROPIC_API_KEY: 'from-env', ANTHROPIC_API_KEY_FILE: '/f' },
      files({ '/f': 'from-file' }),
    );
    if (result.ok) expect(result.value?.value).toBe('from-env');
  });

  it('treats an empty environment variable as absent, not as an empty secret', () => {
    const result = resolveSecret('ANTHROPIC_API_KEY', { ANTHROPIC_API_KEY: '' }, files({}));
    if (result.ok) expect(result.value).toBeUndefined();
  });

  it('returns nothing when neither form is set', () => {
    const result = resolveSecret('ANTHROPIC_API_KEY', {}, files({}));
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
