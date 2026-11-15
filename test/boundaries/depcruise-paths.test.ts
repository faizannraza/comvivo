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
import { parseJsonc } from '../../scripts/support/jsonc.js';
import { runtimePathsEntries } from '../../scripts/support/paths-tsconfig.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

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
    // on purpose: `@comvivo/core/testing` is declared in that package's `exports` and arrives with
    // `M5`, and nothing can import it before then, so a missing file is pending rather than
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
    // `@comvivo/models/testing` came off this list at `M2-T6`, when `FakeProviderServer` moved
    // there from `evals/src/chaos` — the inventory shrinking is the point of keeping it.
    expect(pending).toEqual([
      '@comvivo/channel-sdk/testing',
      '@comvivo/core/testing',
      '@comvivo/engine/testing',
      '@comvivo/evals/arbitraries',
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

describe('the one mapping, read by four things', () => {
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
   *
   * **The fourth reader is a worker thread**, added in `M1-T8`. A `Worker` gets a fresh module
   * graph with none of Vitest's `resolve.alias`, so a worker that imports TypeScript resolves
   * `@comvivo/*` by node resolution and lands in `dist/` — present on a machine that has built,
   * absent in CI. Same symptom, same silence, in the one place the alias cannot reach;
   * `storage/src/db/worker-connection.int.test.ts` derives a filtered tsconfig for it.
   *
   * There is deliberately **no test here** asserting that workers do that. One was written and
   * deleted: it grepped the test sources for `TSX_TSCONFIG_PATH`, and it passed with the value
   * replaced by `'nope'` — because the string was still in the file. A guard that survives the bug
   * it exists to catch is worse than none. The protection that actually works is already in place:
   * CI's `unit`, `integration` and `node24` jobs run the suite **without a prior build**, and they
   * are what caught this. Note that `pnpm verify` structurally cannot — `typecheck` runs `tsc -b`
   * and creates every `dist/` before `test` runs, so local verify is weaker than CI in exactly this
   * dimension. To reproduce a fresh checkout: remove every `dist/` and run `vitest` on its own.
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

  it('orders the aliases longest-specifier-first, or a subpath resolves to nothing', async () => {
    /**
     * Vite's string aliases match by **prefix**, not exactly, and the first match wins.
     *
     * So with `@comvivo/shared` ahead of `@comvivo/shared/crypto`, the subpath import was
     * rewritten to `…/shared/src/index.ts/crypto` and died with "Cannot find package". Found the
     * moment `packages/storage` first imported `@comvivo/shared/crypto` — the first subpath import
     * between workspace packages here, so nothing had exercised alias precedence before.
     *
     * Asserted on the **order** rather than on one pair, because the hazard is structural: any
     * future `@comvivo/x` plus `@comvivo/x/y` has it.
     */
    const { WORKSPACE_ALIASES } = (await import('../../vitest.shared.js')) as {
      WORKSPACE_ALIASES: Record<string, string>;
    };
    const keys = Object.keys(WORKSPACE_ALIASES);
    for (const [index, key] of keys.entries()) {
      for (const later of keys.slice(index + 1)) {
        expect(
          later.startsWith(`${key}/`),
          `"${key}" is ordered before "${later}", which it shadows by prefix`,
        ).toBe(false);
      }
    }
  });

  it('resolves every subpath alias to its own module, not under its parent', async () => {
    const { WORKSPACE_ALIASES } = (await import('../../vitest.shared.js')) as {
      WORKSPACE_ALIASES: Record<string, string>;
    };
    // Non-vacuous: there has to be at least one parent/subpath pair for this to mean anything.
    const subpaths = Object.keys(WORKSPACE_ALIASES).filter((key) =>
      Object.keys(WORKSPACE_ALIASES).some((other) => other !== key && key.startsWith(`${other}/`)),
    );
    expect(subpaths.length).toBeGreaterThan(0);
    for (const subpath of subpaths) {
      const parent = Object.keys(WORKSPACE_ALIASES).find(
        (other) => other !== subpath && subpath.startsWith(`${other}/`),
      );
      expect(parent).toBeDefined();
      if (parent === undefined) continue;
      const parentTarget = WORKSPACE_ALIASES[parent] ?? '';
      expect(
        WORKSPACE_ALIASES[subpath]?.startsWith(parentTarget),
        `${subpath} resolves under ${parent}'s target, which is the prefix-shadowing bug`,
      ).toBe(false);
    }
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

describe('tsconfig.runtime.json', () => {
  it('is the paths map with type-only targets removed, and is not stale', () => {
    // The guard that makes one committed derived file safe. `tsconfig.paths.json` must point the
    // SQLite driver at the `index.d.ts` it hides behind its `exports`, or `tsc` cannot find its
    // types — and a *runtime* loader reading the same map executes that declaration file
    // (`ReferenceError: Database is not defined`). That bit five separate consumers before the
    // derived file existed, the last of them `pnpm db:migrate`, which is a documented command.
    //
    // Regenerate with `pnpm tsx scripts/support/write-runtime-tsconfig.ts`.
    const committed = parseJsonc(readFileSync(`${ROOT}/tsconfig.runtime.json`, 'utf8')) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    expect(committed.compilerOptions.paths).toEqual(runtimePathsEntries(ROOT));
  });

  it('contains no .d.ts target, which is the whole point', () => {
    const committed = parseJsonc(readFileSync(`${ROOT}/tsconfig.runtime.json`, 'utf8')) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    const offenders = Object.entries(committed.compilerOptions.paths).filter(([, targets]) =>
      targets.some((target) => target.endsWith('.d.ts')),
    );
    expect(offenders).toEqual([]);
  });

  it('is what every tsx invocation in a manifest loads', () => {
    // The gap that made the trap recur. The *content* of the derived file is guarded by the two
    // tests above; nothing checked that the commands actually **use** it, so a script could lose
    // its `--tsconfig` flag and only the person who ran that one command would find out. It
    // happened again at the M1 exit gate: `bench:storage` lost the flag and died with
    // `ReferenceError: Database is not defined` — the sixth time, and the second after the derived
    // file was supposed to have ended it.
    //
    // A blanket rule rather than a list of the scripts that import the driver: the flag is
    // harmless for a script that does not (the map differs by one type-only entry), and a rule
    // with no exceptions is one nobody has to maintain.
    const manifests = ['package.json', ...workspaceManifests().map((m) => m.path)];
    const offenders: string[] = [];
    for (const manifest of manifests) {
      const scripts = (
        JSON.parse(readFileSync(`${ROOT}/${manifest}`, 'utf8')) as {
          scripts?: Record<string, string>;
        }
      ).scripts;
      for (const [name, command] of Object.entries(scripts ?? {})) {
        // `tsx` as a word, so `vitest` or a path containing it does not match.
        for (const match of command.matchAll(/(?:^|\s)tsx(\s+\S+)/g)) {
          if (!(match[1] ?? '').trim().startsWith('--tsconfig')) {
            offenders.push(`${manifest} → ${name}: ${command}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('finds tsx invocations at all, so the rule above is not vacuous', () => {
    const scripts = (
      JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8')) as {
        scripts?: Record<string, string>;
      }
    ).scripts;
    const withTsx = Object.values(scripts ?? {}).filter((command) => /(?:^|\s)tsx\s/.test(command));
    expect(withTsx.length).toBeGreaterThan(5);
  });

  it('still drops exactly one entry, so the filter is doing something', () => {
    // Non-vacuity: if `tsconfig.paths.json` ever stops needing a `.d.ts` entry, this fails and the
    // derived file plus its script can be deleted rather than kept out of habit.
    const full = parseJsonc(readFileSync(`${ROOT}/tsconfig.paths.json`, 'utf8')) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    const filtered = runtimePathsEntries(ROOT);
    expect(Object.keys(full.compilerOptions.paths).length - Object.keys(filtered).length).toBe(1);
  });
});
