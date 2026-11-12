/**
 * `BRAND` is the one place the product name lives, so these tests assert the *shape* and the
 * internal consistency of that contract rather than the current name. They must keep passing
 * after a rename, because the weekly rename drill runs them against a throwaway slug
 * (`docs/plan/13-docs-launch-community.md` §3.A.6).
 */
import { describe, expect, it } from 'vitest';
import { BRAND, envVar, legacyEnvVars } from './brand.js';

/**
 * Every field `13` §4.1 requires, so a rename cannot quietly drop one. Listed literally rather
 * than derived from the object, because deriving it from `BRAND` would make the test vacuous.
 */
const REQUIRED_FIELDS = [
  'codename',
  'displayName',
  'slug',
  'cliName',
  'npmCliPackage',
  'npmScope',
  'envPrefix',
  'configFileName',
  'dataDirName',
  'containerImage',
  'botDefaultName',
  'botDefaultAliases',
  'repo',
  'urls',
  'emails',
  'legacy',
] as const;

const REQUIRED_URLS = ['site', 'docs', 'demo', 'community', 'security', 'releaseManifest'] as const;

describe('BRAND satisfies the 13 §4.1 contract', () => {
  it.each(REQUIRED_FIELDS)('has %s', (field) => {
    expect(BRAND).toHaveProperty(field);
    expect(BRAND[field], `${field} is empty`).toBeTruthy();
  });

  it.each(REQUIRED_URLS)('has urls.%s', (key) => {
    expect(BRAND.urls).toHaveProperty(key);
  });

  it('has no field the contract does not name, so nothing creeps in unreviewed', () => {
    expect(Object.keys(BRAND).sort()).toEqual([...REQUIRED_FIELDS].sort());
  });

  it('names both halves of the repository, which is what moves when the org is created', () => {
    expect(BRAND.repo.owner).toBeTruthy();
    expect(BRAND.repo.name).toBeTruthy();
  });

  it('gives a contactable address for security and conduct', () => {
    for (const [role, address] of Object.entries(BRAND.emails)) {
      expect(address, `${role} address is not an address`).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    }
  });
});

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

  it('is deeply frozen, so nothing derived from it is shared mutable state', () => {
    // `readonly` is compile-time only, and every module in the product reads this one object by
    // reference: a single write anywhere would move the metric prefix, the env prefix and the data
    // directory for everyone at once.
    //
    // The previous version of this test called `envVar('ANYTHING')` and compared `JSON.stringify`
    // before and after. `envVar` is string concatenation and could not have mutated anything, so
    // the test passed while `BRAND` was in fact a plain mutable object. Found by the M1
    // independent review.
    //
    // Walked rather than enumerated: a nested field added later is frozen by `deepFreeze` and
    // checked here without anyone remembering to add a line.
    const unfrozen = (value: unknown, path = 'BRAND'): string[] => {
      if (value === null || typeof value !== 'object') return [];
      return [
        ...(Object.isFrozen(value) ? [] : [path]),
        ...Object.entries(value).flatMap(([key, child]) => unfrozen(child, `${path}.${key}`)),
      ];
    };
    expect(unfrozen(BRAND)).toEqual([]);

    // ESM is always strict mode, so a write to a frozen property throws rather than being ignored.
    // The replacement value is derived from the current one rather than written out: `brand:check`
    // forbids a brand literal under `packages/**`, which is the rule that keeps a rename to one
    // command, and this file is the last place that should break it.
    const slug = BRAND.slug;
    expect(() => {
      (BRAND as { slug: string }).slug = `${slug}-mutated`;
    }).toThrow(TypeError);
    expect(() => {
      (BRAND.botDefaultAliases as string[]).push(`${slug}-mutated`);
    }).toThrow(TypeError);
    expect(BRAND.slug).toBe(slug);
    expect(BRAND.botDefaultAliases).toHaveLength(1);
  });
});
