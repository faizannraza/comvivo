/**
 * Environment names are **derived from the schema**, not maintained by hand (ADR-014). These tests
 * pin the two properties that makes worth having: the derivation is stable and natural to type, and
 * no two paths can collide on one variable name.
 */
import { describe, expect, it } from 'vitest';
import { BRAND } from '../brand.js';
import { collisions, configLeaves, envNameForPath, envNameIndex } from './paths.js';

describe('configLeaves', () => {
  it('enumerates the whole schema, not just the top level', () => {
    const paths = configLeaves().map((leaf) => leaf.path);
    expect(paths).toContain('dashboard.auth.magicLinkTtlMinutes');
    expect(paths).toContain('network.egress.allowPrivate');
    expect(paths).toContain('mcp.server.http.enabled');
  });

  it('records the type, so an environment string can be coerced correctly', () => {
    const byPath = new Map(configLeaves().map((leaf) => [leaf.path, leaf]));
    expect(byPath.get('dashboard.port')?.type).toBe('integer');
    expect(byPath.get('privacy.encryptAtRest')?.type).toBe('boolean');
    expect(byPath.get('network.egress.allowPrivate')?.type).toBe('array');
    expect(byPath.get('instance.name')?.type).toBe('string');
  });

  it('records enum values, so a bad value can be rejected with the options listed', () => {
    const magicLinks = configLeaves().find((leaf) => leaf.path === 'dashboard.auth.magicLinks');
    expect(magicLinks?.enumValues).toEqual(['auto', 'https', 'off']);
  });

  it('records nullability, so an empty variable can mean null where that is legal', () => {
    const publicUrl = configLeaves().find((leaf) => leaf.path === 'instance.publicUrl');
    expect(publicUrl?.nullable).toBe(true);
    expect(configLeaves().find((leaf) => leaf.path === 'dashboard.port')?.nullable).toBe(false);
  });

  it('records the schema default, which is what the generated reference publishes', () => {
    const port = configLeaves().find((leaf) => leaf.path === 'dashboard.port');
    expect(port?.default).toBe(7777);
  });

  it('is sorted, so generated output is deterministic', () => {
    const paths = configLeaves().map((leaf) => leaf.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });
});

describe('envNameForPath', () => {
  it.each([
    ['dashboard.port', 'DASHBOARD_PORT'],
    ['privacy.messageRetentionDays', 'PRIVACY_MESSAGE_RETENTION_DAYS'],
    ['dashboard.auth.magicLinks', 'DASHBOARD_AUTH_MAGIC_LINKS'],
    ['network.egress.allowHttpHosts', 'NETWORK_EGRESS_ALLOW_HTTP_HOSTS'],
    ['logging.debugContent', 'LOGGING_DEBUG_CONTENT'],
    ['mcp.server.http.enabled', 'MCP_SERVER_HTTP_ENABLED'],
  ])('maps %s to the natural variable name', (path, suffix) => {
    expect(envNameForPath(path)).toBe(BRAND.envPrefix + suffix);
  });

  it('takes the prefix from BRAND rather than a literal, so a rename moves it', () => {
    expect(envNameForPath('instance.name').startsWith(BRAND.envPrefix)).toBe(true);
  });
});

describe('collisions', () => {
  it('finds none — a collision would make an override apply to the wrong key silently', () => {
    // This is the reason the mapping is derived rather than hand-written: adding a key cannot
    // quietly shadow an existing override, because that becomes a test failure here.
    expect(collisions()).toEqual([]);
  });
});

describe('envNameIndex', () => {
  it('maps a variable name back to its leaf', () => {
    expect(envNameIndex().get(`${BRAND.envPrefix}DASHBOARD_PORT`)?.path).toBe('dashboard.port');
  });

  it('covers every leaf, so no key is unsettable from the environment', () => {
    expect(envNameIndex().size).toBe(configLeaves().length);
  });

  it('does not recognise a name that is not a config key', () => {
    expect(envNameIndex().get('ANTHROPIC_API_KEY')).toBeUndefined();
    expect(envNameIndex().get(`${BRAND.envPrefix}NOT_A_SETTING`)).toBeUndefined();
  });
});
