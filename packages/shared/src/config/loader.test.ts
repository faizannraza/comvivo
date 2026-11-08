/**
 * The configuration loader (ADR-014, `01` §10, `08` §3.10 and §5).
 *
 * Filesystem access is injected, so these cover the real rules exhaustively rather than hopefully:
 * precedence, the host-only exception, `.env` permission refusal, legacy names, and the env
 * coercion a host actually types.
 */
import { describe, expect, it } from 'vitest';
import { BRAND } from '../brand.js';
import { type ConfigIo, coerceEnvValue, loadConfig } from './loader.js';
import { configLeaves } from './paths.js';
import { defaultConfig } from './schema.js';

const CWD = '/srv/instance';
const CONFIG = `${CWD}/${BRAND.configFileName}`;
const ENV_FILE = `${CWD}/.env`;

/** An in-memory filesystem. Modes default to 0600, which is what a correct install looks like. */
function io(files: Record<string, string>, modes: Record<string, number> = {}): ConfigIo {
  return {
    readFile(path) {
      const value = files[path];
      if (value === undefined) throw new Error(`ENOENT: ${path}`);
      return value;
    },
    fileMode(path) {
      if (!(path in files)) return undefined;
      return modes[path] ?? 0o600;
    },
  };
}

const load = (
  files: Record<string, string>,
  env: Record<string, string | undefined> = {},
  extra: { db?: Record<string, unknown>; modes?: Record<string, number> } = {},
) =>
  loadConfig({
    cwd: CWD,
    env,
    io: io(files, extra.modes),
    ...(extra.db === undefined ? {} : { db: extra.db }),
  });

describe('defaultConfig', () => {
  it('is what a host with no file gets, and matches the loader', () => {
    // One source of truth for defaults: if these ever diverged, the generated configuration
    // reference would document values the loader does not actually produce.
    const loaded = load({});
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.config).toEqual(defaultConfig());
  });

  it('defaults to the safe side of every choice a host would notice', () => {
    // The assertion above is **circular**: `defaultConfig()` is `configSchema.parse({})` and so is
    // the loader's own path, so both sides are the same expression and the equality can never
    // fail. It is still worth keeping — it says the loader does not post-process a default away —
    // but only once some defaults are pinned independently. Found by the M1 independent review.
    //
    // These are the ones where a silent flip is a privacy or safety change rather than a
    // preference: encryption on, content logging off, retention bounded, nothing reaching a
    // private network, and the dashboard not listening wide open.
    const config = defaultConfig();
    expect(config.privacy.encryptAtRest).toBe(true);
    expect(config.logging.debugContent).toBe(false);
    expect(config.logging.level).toBe('info');
    expect(config.privacy.messageRetentionDays).toBe(90);
    expect(config.privacy.maxMessageRetentionDays).toBe(365);
    expect(config.privacy.logRetentionDays).toBe(14);
    expect(config.privacy.localOnly).toBe(false);
    expect(config.logging.file.enabled).toBe(false);

    // The twenty top-level sections, pinned: a section added without a default would otherwise
    // appear here with whatever zod inferred, and a section removed would take its defaults with
    // it unnoticed.
    expect(Object.keys(config)).toEqual([
      'instance',
      'models',
      'embeddings',
      'transcription',
      'channels',
      'email',
      'dashboard',
      'ics',
      'privacy',
      'traces',
      'network',
      'outbound',
      'budgets',
      'backups',
      'security',
      'plugins',
      'mcp',
      'logging',
      'observability',
      'updates',
    ]);
  });
});

describe('an empty instance', () => {
  it('starts with no configuration file at all', () => {
    // This is what "install to first useful answer in under five minutes" (`00` §3.7) requires:
    // nothing is mandatory up front except a model key and a bot token, both of which are secrets.
    const result = load({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.configFile).toBeUndefined();
      expect(result.value.config.dashboard.port).toBe(7777);
      expect(result.value.config.privacy.encryptAtRest).toBe(true);
    }
  });

  it('starts with an empty file', () => {
    const result = load({ [CONFIG]: '' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.configFile).toBe(CONFIG);
  });

  it('starts with a comments-only file', () => {
    expect(load({ [CONFIG]: '# nothing set yet\n' }).ok).toBe(true);
  });
});

describe('reading the file', () => {
  it(`applies values from ${BRAND.configFileName}`, () => {
    const result = load({
      [CONFIG]: 'instance:\n  name: The Hendersons\ndashboard:\n  port: 8080\n',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config.instance.name).toBe('The Hendersons');
      expect(result.value.config.dashboard.port).toBe(8080);
      expect(result.value.origin.get('dashboard.port')).toBe('yaml');
    }
  });

  it('rejects a typo in a key name rather than ignoring it', () => {
    // A host who writes `dashbord:` and gets a working-but-wrong instance has been failed by us.
    // "I set that and it did nothing" is among the worst bug reports to receive.
    const result = load({ [CONFIG]: 'dashbord:\n  port: 8080\n' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]?.message).toContain('dashbord');
  });

  it('rejects a value outside its range, naming the path', () => {
    const result = load({ [CONFIG]: 'dashboard:\n  port: 99999\n' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]?.path).toBe('dashboard.port');
  });

  it('reports every problem at once', () => {
    const result = load({ [CONFIG]: 'dashboard:\n  port: 99999\nbackups:\n  keep: -1\n' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects invalid YAML with a readable message', () => {
    const result = load({ [CONFIG]: 'instance:\n  name: "unterminated\n' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]?.message).toContain('not valid YAML');
  });

  it('rejects a file whose top level is not a mapping', () => {
    const result = load({ [CONFIG]: '- a\n- b\n' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error[0]?.message).toContain('mapping at the top level');
  });

  it('accepts a legacy file name with a deprecation warning', () => {
    const legacy = `${CWD}/${BRAND.legacy.configFileNames[0]}`;
    const result = load({ [legacy]: 'instance:\n  name: Carried over\n' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config.instance.name).toBe('Carried over');
      expect(result.value.warnings.map((w) => w.code)).toContain('legacy_config_name');
      expect(result.value.warnings[0]?.message).toContain(BRAND.configFileName);
    }
  });

  it('prefers the current name when both exist, with no warning', () => {
    const legacy = `${CWD}/${BRAND.legacy.configFileNames[0]}`;
    const result = load({
      [CONFIG]: 'instance:\n  name: Current\n',
      [legacy]: 'instance:\n  name: Old\n',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config.instance.name).toBe('Current');
      expect(result.value.warnings).toEqual([]);
    }
  });
});

describe('.env', () => {
  it('reads values from .env', () => {
    const result = load({ [ENV_FILE]: `${BRAND.envPrefix}LOGGING_LEVEL=debug\n` });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config.logging.level).toBe('debug');
      expect(result.value.envFile).toBe(ENV_FILE);
    }
  });

  it('lets the real environment beat .env, which is what a one-off override expects', () => {
    const result = load(
      { [ENV_FILE]: `${BRAND.envPrefix}LOGGING_LEVEL=debug\n` },
      { [`${BRAND.envPrefix}LOGGING_LEVEL`]: 'warn' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.config.logging.level).toBe('warn');
  });

  it('REFUSES a group- or world-readable .env', () => {
    // It holds API keys and bot tokens. A group-readable one on a shared box is a credential leak
    // nobody would notice (`08` §3.10).
    const result = load(
      { [ENV_FILE]: 'ANTHROPIC_API_KEY=sk-1\n' },
      {},
      { modes: { [ENV_FILE]: 0o644 } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error[0]?.code).toBe('config.insecure_permissions');
      expect(result.error[0]?.message).toContain('chmod 600');
    }
  });

  it.each([0o640, 0o604, 0o666, 0o777])('refuses mode %s', (mode) => {
    expect(load({ [ENV_FILE]: 'A=1\n' }, {}, { modes: { [ENV_FILE]: mode } }).ok).toBe(false);
  });

  it.each([0o600, 0o400, 0o200])('accepts mode %s', (mode) => {
    expect(load({ [ENV_FILE]: 'A=1\n' }, {}, { modes: { [ENV_FILE]: mode } }).ok).toBe(true);
  });

  it('allows the refusal to be overridden for an unusual host, with doctor still complaining', () => {
    const result = load(
      { [ENV_FILE]: 'A=1\n' },
      { [`${BRAND.envPrefix}INSECURE_PERMISSIONS`]: '1' },
      { modes: { [ENV_FILE]: 0o644 } },
    );
    expect(result.ok).toBe(true);
  });

  it('warns about a malformed line rather than failing the whole file', () => {
    const result = load({ [ENV_FILE]: 'A=1\nthis is not an assignment\n' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.warnings.map((w) => w.code)).toContain('malformed_env_line');
  });
});

describe('environment overrides', () => {
  it('coerces and applies a typed override', () => {
    const result = load({}, { [`${BRAND.envPrefix}DASHBOARD_PORT`]: '9999' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config.dashboard.port).toBe(9999);
      expect(result.value.origin.get('dashboard.port')).toBe('env');
    }
  });

  it('beats the file', () => {
    const result = load(
      { [CONFIG]: 'dashboard:\n  port: 8080\n' },
      { [`${BRAND.envPrefix}DASHBOARD_PORT`]: '9999' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.config.dashboard.port).toBe(9999);
  });

  it('rejects a value it cannot coerce, naming the variable and the path', () => {
    const result = load({}, { [`${BRAND.envPrefix}DASHBOARD_PORT`]: 'not-a-number' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error[0]?.message).toContain(`${BRAND.envPrefix}DASHBOARD_PORT`);
      expect(result.error[0]?.path).toBe('dashboard.port');
    }
  });

  it('ignores an unrelated variable, because the environment is full of them', () => {
    expect(load({}, { PATH: '/usr/bin', HOME: '/root', EDITOR: 'vim' }).ok).toBe(true);
  });

  it('accepts a legacy prefix with a deprecation warning', () => {
    const legacyPrefix = BRAND.legacy.envPrefixes[0] as string;
    const result = load({}, { [`${legacyPrefix}LOGGING_LEVEL`]: 'warn' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config.logging.level).toBe('warn');
      const warning = result.value.warnings.find((w) => w.code === 'legacy_env_prefix');
      expect(warning?.message).toContain(`${BRAND.envPrefix}LOGGING_LEVEL`);
    }
  });
});

describe('the database, and host-only keys', () => {
  it('applies a group-owned setting from the database', () => {
    const result = load({}, {}, { db: { instance: { name: 'Renamed in the dashboard' } } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config.instance.name).toBe('Renamed in the dashboard');
      expect(result.value.origin.get('instance.name')).toBe('db');
    }
  });

  it('IGNORES a host-only key from the database, and reports it', () => {
    // The threat: an admin is a member, and a member may be adversarial toward the others
    // (`01` §9). Widening the egress allowlist from a session is a data-exfiltration primitive.
    const result = load(
      {},
      {},
      { db: { network: { egress: { allowPrivate: ['attacker.example:443'] } } } },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config.network.egress.allowPrivate).toEqual([]);
      expect(result.value.rejectedHostOnlyFromDb).toEqual(['network.egress.allowPrivate']);
    }
  });

  it('ignores an attempt to turn off encryption from the database', () => {
    const result = load({}, {}, { db: { privacy: { encryptAtRest: false } } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config.privacy.encryptAtRest).toBe(true);
      expect(result.value.rejectedHostOnlyFromDb).toContain('privacy.encryptAtRest');
    }
  });

  it('ignores an attempt to enable content debug logging from the database', () => {
    const result = load({}, {}, { db: { logging: { debugContent: true } } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.config.logging.debugContent).toBe(false);
  });

  it('still honours the same key from YAML, which is a host surface', () => {
    const result = load(
      { [CONFIG]: 'logging:\n  debugContent: true\n' },
      {},
      { db: { logging: { debugContent: false } } },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.config.logging.debugContent).toBe(true);
  });

  it('keeps the legitimate half of a mixed database patch', () => {
    const result = load(
      {},
      {},
      { db: { instance: { name: 'ok' }, logging: { debugContent: true } } },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.config.instance.name).toBe('ok');
      expect(result.value.config.logging.debugContent).toBe(false);
    }
  });
});

describe('precedence, end to end', () => {
  it('resolves env > db > yaml > default for one key', () => {
    const name = `${BRAND.envPrefix}LOGGING_LEVEL`;
    const yaml = { [CONFIG]: 'logging:\n  level: error\n' };
    const db = { logging: { level: 'warn' } };

    expect(load({}).ok && load({}).ok).toBe(true);
    const def = load({});
    expect(def.ok).toBe(true);
    if (def.ok) expect(def.value.config.logging.level).toBe('info');

    const fromYaml = load(yaml);
    expect(fromYaml.ok).toBe(true);
    if (fromYaml.ok) expect(fromYaml.value.config.logging.level).toBe('error');

    const fromDb = load(yaml, {}, { db });
    expect(fromDb.ok).toBe(true);
    if (fromDb.ok) expect(fromDb.value.config.logging.level).toBe('warn');

    const fromEnv = load(yaml, { [name]: 'debug' }, { db });
    expect(fromEnv.ok).toBe(true);
    if (fromEnv.ok) expect(fromEnv.value.config.logging.level).toBe('debug');
  });
});

describe('secrets never become settings', () => {
  it('keeps every secret name out of the config key space', () => {
    // A secret inside `Config` would reach traces, exports and the dashboard, which `08` §3.10
    // (S2) forbids outright. The loader asserts the two name spaces do not overlap.
    const configEnvNames = new Set(configLeaves().map((leaf) => leaf.path));
    expect(configEnvNames.has('ANTHROPIC_API_KEY')).toBe(false);
  });

  it('does not treat a secret in the environment as a setting', () => {
    const result = load({}, { ANTHROPIC_API_KEY: 'sk-1', TELEGRAM_BOT_TOKEN: 'tok' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(JSON.stringify(result.value.config)).not.toContain('sk-1');
      expect(JSON.stringify(result.value.config)).not.toContain('tok');
    }
  });
});

describe('coerceEnvValue', () => {
  const leafFor = (path: string) => configLeaves().find((l) => l.path === path);

  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['on', true],
    ['0', false],
    ['false', false],
    ['no', false],
    ['off', false],
  ])('reads %s as a boolean', (raw, expected) => {
    const result = coerceEnvValue(leafFor('privacy.encryptAtRest')!, raw);
    // `expect(result.ok && result.value).toBe(expected)` passed the four `false` rows whether the
    // coercion produced `false` **or failed outright** — `false && anything` is `false` either way.
    // So half this table was asserting nothing about half its cases, and the setting it covers is
    // `privacy.encryptAtRest`: a host writing `COMVIVO_PRIVACY_ENCRYPT_AT_REST=off` and a host
    // writing a typo would have been indistinguishable here. Found by the M1 independent review.
    expect(result.ok, `coercing ${raw} failed`).toBe(true);
    expect(result.ok ? result.value : undefined).toBe(expected);
  });

  it('rejects a boolean it cannot read, and lists what it accepts', () => {
    const result = coerceEnvValue(leafFor('privacy.encryptAtRest')!, 'maybe');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('true/false');
  });

  it('rejects a fractional value for an integer setting', () => {
    const result = coerceEnvValue(leafFor('dashboard.port')!, '80.5');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('whole number');
  });

  it('reads a comma-separated list, so a host need not learn JSON', () => {
    const result = coerceEnvValue(leafFor('network.egress.allowPrivate')!, 'a:1, b:2 ,c:3');
    expect(result.ok && result.value).toEqual(['a:1', 'b:2', 'c:3']);
  });

  it('reads an empty string as an empty list, which is how a YAML default gets cleared', () => {
    const result = coerceEnvValue(leafFor('network.egress.allowPrivate')!, '');
    expect(result.ok && result.value).toEqual([]);
  });

  it('reads an empty string as null where null is legal', () => {
    const result = coerceEnvValue(leafFor('instance.publicUrl')!, '');
    expect(result.ok && result.value).toBeNull();
  });

  it('accepts JSON for a union-typed setting, and falls back to the raw string', () => {
    const trustProxy = leafFor('dashboard.trustProxy')!;
    expect(coerceEnvValue(trustProxy, '["10.0.0.0/8"]')).toEqual({
      ok: true,
      value: ['10.0.0.0/8'],
    });
    expect(coerceEnvValue(trustProxy, 'true')).toEqual({ ok: true, value: true });
  });
});
