/**
 * `tsconfig.paths.json` must map **every** workspace subpath export, and the three things that
 * read it must stay in step.
 *
 * This is the one assertion that keeps the M0 `/dist/` bug from recurring in a new form.
 *
 * dependency-cruiser only sees the architecture because those `paths` mappings redirect every
 * `@comvivo/*` specifier to that package's `src/`. Without a mapping, the import resolves through
 * `node_modules` into `dist/` instead — and a rule anchored on a `src/` path then matches nothing,
 * reports no violations, and looks exactly like a rule that passed.
 *
 * The M0 independent review demonstrated the mechanism by deleting one mapping and watching the
 * resolved edge move from `packages/shared/src/testing/index.ts` to
 * `packages/shared/dist/testing/index.d.ts`. `memory-search-restricted-callers` — the rule that
 * protects invariant **I1** — is anchored on `^packages/core/src/ports/memory-search`, which a
 * `dist` path cannot match. `M1-T18` adds that port; if its mapping were forgotten, the rule would
 * silently stop protecting I1.
 *
 * `test/boundaries/plant.ts` cannot catch this: it generates its own paths map for the synthetic
 * tree rather than reading the real file.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

/** Strip `//` and `/* *\/` comments so a jsonc tsconfig can be parsed as JSON. */
function parseJsonc(source: string): unknown {
  const withoutBlocks = source.replaceAll(/\/\*[\s\S]*?\*\//g, '');
  const withoutLines = withoutBlocks.replaceAll(/(^|[^:"])\/\/.*$/gm, '$1');
  return JSON.parse(withoutLines.replaceAll(/,(\s*[}\]])/g, '$1'));
}

function workspaceManifests(): { path: string; name: string; exports: string[] }[] {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '*package.json'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\0')
    .filter((path) => path !== '' && path !== 'package.json' && !path.includes('node_modules/'));

  return files.flatMap((path) => {
    const manifest = JSON.parse(readFileSync(`${ROOT}/${path}`, 'utf8')) as {
      name?: unknown;
      exports?: unknown;
    };
    if (typeof manifest.name !== 'string') return [];
    const exportKeys =
      typeof manifest.exports === 'object' && manifest.exports !== null
        ? Object.keys(manifest.exports as Record<string, unknown>)
        : [];
    return [{ path, name: manifest.name, exports: exportKeys }];
  });
}

/** `@comvivo/shared` + `./testing` → `@comvivo/shared/testing`. */
function specifierFor(name: string, exportKey: string): string {
  if (exportKey === '.') return name;
  return `${name}/${exportKey.replace(/^\.\//, '')}`;
}

function pathsOf(file: string): Record<string, string[]> {
  const tsconfig = parseJsonc(readFileSync(`${ROOT}/${file}`, 'utf8')) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  return tsconfig.compilerOptions?.paths ?? {};
}

const allPaths = pathsOf('tsconfig.paths.json');

/** Only the workspace entries; the driver mapping is a third-party shim, checked separately. */
const mappings = Object.fromEntries(
  Object.entries(allPaths).filter(
    ([specifier]) => specifier.startsWith('@comvivo/') || specifier === 'comvivo',
  ),
);

const manifests = workspaceManifests();

describe('tsconfig.depcruise.json', () => {
  it('found the workspace manifests and the mappings', () => {
    // A guard against this whole suite passing vacuously because a glob matched nothing — the
    // failure mode it exists to prevent.
    expect(manifests.length).toBeGreaterThan(20);
    expect(Object.keys(mappings).length).toBeGreaterThan(20);
  });

  it('maps every subpath export of every workspace package', () => {
    const missing: string[] = [];
    for (const manifest of manifests) {
      // A package with no `exports` is not importable by specifier, so it needs no mapping. The
      // docs site is the case today: an Astro app, not a library.
      for (const key of manifest.exports) {
        const specifier = specifierFor(manifest.name, key);
        if (!(specifier in mappings)) missing.push(`${specifier}  (from ${manifest.path})`);
      }
    }
    expect(
      missing,
      'Every importable specifier needs a `paths` entry, or dependency-cruiser resolves it ' +
        'into `dist/` and any rule anchored on a `src/` path silently matches nothing.',
    ).toEqual([]);
  });

  it('maps every mapping to a path inside that package`s src', () => {
    const wrong: string[] = [];
    for (const [specifier, targets] of Object.entries(mappings)) {
      for (const target of targets) {
        if (!/^\.\/(packages|apps)\//.test(target) || !target.includes('/src/')) {
          wrong.push(`${specifier} -> ${target}`);
        }
      }
    }
    expect(
      wrong,
      'A mapping must point into the package source. Pointing at `dist/` would defeat the whole ' +
        'purpose of the file.',
    ).toEqual([]);
  });

  it('has no mapping into a directory that exists but lacks the file', () => {
    // Deliberately narrower than "the target must exist". Several mappings are ahead of the code
    // on purpose: `@comvivo/storage/testing` is declared in that package's `exports` and arrives
    // with `M1`, and nothing can import it before then, so a missing file is pending rather than
    // wrong.
    //
    // What is wrong is a mapping whose **directory** exists and whose file does not — that is a
    // file that was deleted or renamed, which is how `@comvivo/docs` came to point at
    // `apps/docs/src/index.ts` for a whole milestone after `M0-T18` turned that app into an Astro
    // site. Found by the M0 independent review.
    const stale = Object.entries(mappings).flatMap(([specifier, targets]) =>
      targets
        .filter((target) => {
          if (existsSync(`${ROOT}/${target}`)) return false;
          const directory = target.slice(0, target.lastIndexOf('/'));
          return existsSync(`${ROOT}/${directory}`);
        })
        .map((target) => `${specifier} -> ${target}`),
    );
    expect(stale).toEqual([]);
  });

  it('lists the mappings that are still ahead of the code', () => {
    // Not a failure — a visible inventory, so "pending" never quietly becomes "forgotten". Each
    // one is a subpath its package already declares in `exports` and whose milestone has not
    // landed.
    const pending = Object.entries(mappings)
      .flatMap(([specifier, targets]) =>
        targets.filter((target) => !existsSync(`${ROOT}/${target}`)).map(() => specifier),
      )
      .sort();
    expect(pending).toEqual([
      '@comvivo/channel-sdk/testing',
      '@comvivo/core/testing',
      '@comvivo/engine/testing',
      '@comvivo/evals/arbitraries',
      '@comvivo/models/testing',
      '@comvivo/storage/testing',
    ]);
  });

  it('has no mapping for a package that no longer exists', () => {
    const names = new Set(manifests.map((manifest) => manifest.name));
    const orphans = Object.keys(mappings).filter((specifier) => {
      const scoped = specifier.startsWith('@');
      const base = scoped
        ? specifier.split('/').slice(0, 2).join('/')
        : (specifier.split('/')[0] ?? specifier);
      return !names.has(base);
    });
    // A stale mapping is harmless but misleading, and it is how somebody concludes a package is
    // covered when it has been renamed.
    expect(orphans).toEqual([]);
  });
});

describe('the one mapping, read by three things', () => {
  /**
   * `tsconfig.paths.json` exists because the same map is needed by dependency-cruiser (so it sees
   * `src/` rather than `dist/`), by `tsc -p tsconfig.test.json` (so a test that imports a sibling
   * package types without a build having run), and by Vitest's `resolve.alias` (so a test *runs*
   * without one).
   *
   * Three copies would be three chances to disagree, and the failure is silent in all three
   * directions: dependency-cruiser reports success over an unresolved edge, `tsc` reports `any`,
   * and Vitest fails only on a machine with no `dist/` — which is a fresh checkout and CI, never
   * the machine you are working on. Measured in `M1-T2`: the first three cross-package imports in
   * this repository's history were mine, and all three went green locally and red in CI with
   * "Failed to resolve entry for package".
   */
  it('is extended by both the depcruise and the test tsconfig', () => {
    for (const file of ['tsconfig.depcruise.json', 'tsconfig.test.json']) {
      const tsconfig = parseJsonc(readFileSync(`${ROOT}/${file}`, 'utf8')) as {
        extends?: unknown;
      };
      const extendsList = Array.isArray(tsconfig.extends) ? tsconfig.extends : [tsconfig.extends];
      expect(extendsList, `${file} must extend tsconfig.paths.json`).toContain(
        './tsconfig.paths.json',
      );
      // And must not carry its own copy, which would replace the shared one wholesale.
      expect(
        Object.keys(pathsOf(file)),
        `${file} declares its own paths, which replaces the shared map rather than adding to it`,
      ).toEqual([]);
    }
  });

  it("covers every mapping in Vitest's resolve.alias", async () => {
    const { WORKSPACE_ALIASES } = (await import('../../vitest.shared.js')) as {
      WORKSPACE_ALIASES: Record<string, string>;
    };
    // The runtime alias covers the **source** mappings and deliberately not the type-only ones:
    // aliasing a `.d.ts` makes Vitest try to execute a declaration file.
    const runtimeMappings = Object.entries(allPaths)
      .filter(([, targets]) => targets[0]?.endsWith('.d.ts') !== true)
      .map(([specifier]) => specifier);
    expect(Object.keys(WORKSPACE_ALIASES).sort()).toEqual(runtimeMappings.sort());
    expect(Object.keys(WORKSPACE_ALIASES)).not.toContain('better-sqlite3-multiple-ciphers');
    for (const [specifier, target] of Object.entries(WORKSPACE_ALIASES)) {
      expect(target.startsWith(ROOT), `${specifier} -> ${target}`).toBe(true);
    }
  });

  it('is wired into the real vitest.config.ts, not just exported from the shared module', async () => {
    // The first version of the test above imported `WORKSPACE_ALIASES` from `vitest.shared.ts` and
    // passed with `vitest.config.ts`'s alias emptied — a guard that checked the ingredient and not
    // the dish. Proven by doing exactly that and watching it stay green.
    const [{ default: config }, { WORKSPACE_ALIASES }] = await Promise.all([
      import('../../vitest.config.js') as Promise<{
        default: { resolve?: { alias?: Record<string, string> } };
      }>,
      import('../../vitest.shared.js') as Promise<{ WORKSPACE_ALIASES: Record<string, string> }>,
    ]);
    expect(config.resolve?.alias).toEqual(WORKSPACE_ALIASES);
    expect(Object.keys(config.resolve?.alias ?? {}).length).toBeGreaterThan(20);
  });

  it('repeats the third-party driver mapping that `tsconfig.base.json` also needs', () => {
    // An `extends` array merges `compilerOptions` key by key, so the `paths` in
    // `tsconfig.paths.json` **replaces** the base's rather than adding to it. Leaving the driver
    // mapping out silently dropped its type declarations and every import became `TS7016`.
    // Duplication is the lesser evil here; a duplicate that drifts is not, hence this test.
    const base = pathsOf('tsconfig.base.json');
    const key = 'better-sqlite3-multiple-ciphers';
    expect(Object.keys(base)).toContain(key);
    expect(allPaths[key]).toEqual(base[key]);
  });
});
