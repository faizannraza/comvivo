/**
 * `BRAND` is the one place the product name lives, so these tests assert the *shape* and the
 * internal consistency of that contract rather than the current name. They must keep passing
 * after a rename, because the weekly rename drill runs them against a throwaway slug
 * (`docs/plan/13-docs-launch-community.md` §3.A.6).
 */
import { describe, expect, it } from 'vitest';
import { BRAND, envVar, legacyEnvVars } from './brand.js';

describe('BRAND', () => {
  it('has a slug that is safe in a URL, an npm name, a container tag and a file name', () => {
    expect(BRAND.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('uses the slug consistently across every derived name', () => {
    expect(BRAND.codename).toBe(BRAND.slug);
    expect(BRAND.cliName).toBe(BRAND.slug);
    expect(BRAND.npmCliPackage).toBe(BRAND.slug);
    expect(BRAND.npmScope).toBe(`@${BRAND.slug}`);
    expect(BRAND.configFileName).toBe(`${BRAND.slug}.yaml`);
    expect(BRAND.dataDirName).toBe(BRAND.slug);
    expect(BRAND.repo.name).toBe(BRAND.slug);
    expect(BRAND.containerImage.endsWith(`/${BRAND.slug}`)).toBe(true);
  });

  it('derives an environment prefix that is a legal shell identifier and ends in an underscore', () => {
    expect(BRAND.envPrefix).toMatch(/^[A-Z][A-Z0-9]*_$/);
    expect(envVar('DEBUG_CONTENT')).toBe(`${BRAND.envPrefix}DEBUG_CONTENT`);
  });

  it('names a bot persona a human can type, and aliases the router can match on a word boundary', () => {
    expect(BRAND.botDefaultName.length).toBeGreaterThan(0);
    expect(BRAND.botDefaultAliases.length).toBeGreaterThan(0);
    for (const alias of BRAND.botDefaultAliases) {
      // Aliases are matched case-insensitively on word boundaries, so a bare lowercase token keeps
      // the false-positive rate measurable (`M3-T22` requires it at or below 0.1%).
      expect(alias).toBe(alias.toLowerCase());
      expect(alias).toMatch(/^[a-z0-9]+$/);
    }
  });

  it('exposes only absolute https URLs, so nothing renders a broken or downgraded link', () => {
    for (const [key, url] of Object.entries(BRAND.urls)) {
      expect(url, key).toMatch(/^https:\/\//);
      expect(() => new URL(url)).not.toThrow();
    }
  });

  it('keeps the legacy names it promises to accept, and never lists the current ones', () => {
    // A rename must leave a migration path (`13` §3.A.6), but listing the *current* name as legacy
    // would make the deprecation warning fire on every correct config.
    expect(BRAND.legacy.envPrefixes).not.toContain(BRAND.envPrefix);
    expect(BRAND.legacy.configFileNames).not.toContain(BRAND.configFileName);
    for (const prefix of BRAND.legacy.envPrefixes) {
      expect(prefix).toMatch(/^[A-Z][A-Z0-9]*_$/);
    }
  });

  it('builds legacy variable names from every legacy prefix', () => {
    expect(legacyEnvVars('MASTER_KEY')).toEqual(
      BRAND.legacy.envPrefixes.map((p) => `${p}MASTER_KEY`),
    );
  });

  it('is deeply frozen in spirit: nothing derived from it is shared mutable state', () => {
    // `readonly` is compile-time only, so this guards the runtime contract the logger and the
    // config loader rely on: reading BRAND twice always gives the same values.
    const first = JSON.stringify(BRAND);
    envVar('ANYTHING');
    expect(JSON.stringify(BRAND)).toBe(first);
  });
});
