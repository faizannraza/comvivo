/**
 * The storage package's dependency pins, asserted (`02` M1-T1, D8, D13, D15, D16).
 *
 * `02` M1-T1 says "pin deps exactly" and names seven versions. That is not a style preference: a
 * SQLite build, a loadable extension, a crypto library and a date polyfill are the four places
 * where a silent patch bump can change the **bytes in a host's database** or the bytes of a
 * backup. A caret range here would mean two installs of the same commit could write files the
 * other cannot read.
 *
 * Caret ranges are also exactly what a well-meaning `pnpm up` produces, which is why this is a
 * test rather than a comment. Renovate opens a PR per pin instead (grouped, three-day minimum
 * release age, no auto-merge), so an upgrade arrives as a reviewed diff with the spike suite
 * re-run.
 */
import { readFileSync } from 'node:fs';
import { BRAND } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const REPO = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');

interface PackageJson {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(`${REPO}/packages/storage/package.json`, 'utf8'),
) as PackageJson;

const workspace = parse(readFileSync(`${REPO}/pnpm-workspace.yaml`, 'utf8')) as {
  catalog: Record<string, string>;
};

/** The versions `02` M1-T1 names, re-verified against the registry on 2026-11-03. */
const REQUIRED_PINS: Readonly<Record<string, string>> = {
  'better-sqlite3-multiple-ciphers': '13.0.3',
  'sqlite-vec': '0.1.9',
  'drizzle-orm': '0.45.4',
  'drizzle-kit': '0.31.11',
  'libsodium-wrappers': '0.8.4',
  'temporal-polyfill': '1.0.6',
};

describe('the storage dependency pins', () => {
  it.each(Object.entries(REQUIRED_PINS))('pins %s to exactly %s', (name, version) => {
    expect(workspace.catalog[name]).toBe(version);
  });

  it.each(Object.keys(REQUIRED_PINS))('gives %s no range operator at all', (name) => {
    // `^`, `~`, `>=`, `*`, `x` and `||` all reintroduce the drift this pin exists to prevent.
    expect(workspace.catalog[name]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('declares every runtime dependency through the catalog, the workspace, or the one alias', () => {
    // A literal version here would be a second source of truth for the same decision, and the
    // failure mode is that one of them gets bumped. The single exception is the `better-sqlite3`
    // alias, which pnpm's catalog protocol cannot express — asserted against the catalog in its
    // own test below, so the two still cannot drift.
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (name === 'better-sqlite3') continue;
      expect(range, `${name} is pinned in package.json instead of the catalog`).toMatch(
        /^(catalog:|workspace:)/,
      );
    }
    for (const [name, range] of Object.entries(manifest.devDependencies ?? {})) {
      expect(range, `${name} is pinned in package.json instead of the catalog`).toMatch(
        /^(catalog:|workspace:)/,
      );
    }
  });

  it('depends on nothing but core, shared and the named third parties (01 §4, A11)', () => {
    // The import boundary is dependency-cruiser's `storage-only-core-shared`; this is the
    // manifest, which is the other half. A workspace dependency that depcruise has no rule for is
    // a boundary nobody is watching.
    // Built from `BRAND` rather than written out: the brand guard refuses a hard-coded scope, and
    // it is right to — a literal here is one more surface a rename has to find.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      [
        `${BRAND.npmScope}/core`,
        `${BRAND.npmScope}/shared`,
        'better-sqlite3',
        'better-sqlite3-multiple-ciphers',
        'drizzle-orm',
        'libsodium-wrappers',
        'sqlite-vec',
        'tar-stream',
        'temporal-polyfill',
      ].sort(),
    );
  });

  it('keeps its devDependencies to the build tooling and the test harness', () => {
    // `yaml` is here because this file parses `pnpm-workspace.yaml` to read the catalog. Declared
    // rather than relied on transitively: Biome's `noUndeclaredDependencies` refuses an undeclared
    // import, which is how a package ends up depending on something it never asked for.
    expect(Object.keys(manifest.devDependencies ?? {}).sort()).toEqual([
      'drizzle-kit',
      'vitest',
      'yaml',
    ]);
  });

  it('aliases better-sqlite3 to the fork, at exactly the catalog version', () => {
    // Measured in `M1-T2`: `drizzle-orm/better-sqlite3/driver.js` does a top-level
    // `import 'better-sqlite3'`, so Drizzle cannot load at all against the multiple-ciphers fork
    // without this alias — "Cannot find package 'better-sqlite3'". `02` §3.6.3 step 6 anticipated
    // a *type* problem and permitted a cast; the real problem was module resolution, and with the
    // alias in place no cast is needed either.
    //
    // The version is derived from the catalog rather than compared to a literal, so the alias and
    // the real dependency cannot drift apart into two different copies of SQLite in one process —
    // which would be very hard to notice and very bad.
    const expected = `npm:better-sqlite3-multiple-ciphers@${String(
      workspace.catalog['better-sqlite3-multiple-ciphers'],
    )}`;
    expect(manifest.dependencies?.['better-sqlite3']).toBe(expected);
  });

  it('keeps drizzle-kit out of the runtime, because it is build tooling', () => {
    // It would also ship esbuild to every host. `no-dev-dep-in-src` enforces the import side; this
    // enforces the manifest side.
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('drizzle-kit');
    expect(Object.keys(manifest.devDependencies ?? {})).toContain('drizzle-kit');
  });

  it('runs its tests through the repository harness, not a bare vitest', () => {
    // A bare `vitest run` in a package directory finds no root config, so it runs **without**
    // `TZ=UTC`, without `COMVIVO_TEST_MODE` and without the network guard — measured during M1-T1:
    // `pnpm -F @comvivo/shared test` reported 573 tests with 6 failures and real network access,
    // while the same suite through the root config reported 595 passing. A per-package command
    // that is weaker than CI while printing the same kind of output is the M0 lesson repeated.
    expect(manifest.scripts?.['test']).toBe('pnpm -w exec vitest run packages/storage');
  });
});

describe('the drizzle-kit configuration', () => {
  const config = readFileSync(`${REPO}/packages/storage/drizzle.config.ts`, 'utf8');

  it.each([
    ["dialect: 'sqlite'", "dialect: 'sqlite'"],
    ["schema: './src/schema/index.ts'", "schema: './src/schema/index.ts'"],
    ["out: './migrations'", "out: './migrations'"],
  ])('sets %s, as `02` §3.1 specifies', (_label, fragment) => {
    expect(config).toContain(fragment);
  });

  it('refuses to drop a column without being asked', () => {
    // `strict: true`. drizzle-kit's interactive prompts cannot run in CI, and a migration that
    // silently renames a column has moved a family's data.
    expect(config).toContain('strict: true');
  });
});
