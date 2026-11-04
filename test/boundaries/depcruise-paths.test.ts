/**
 * `tsconfig.depcruise.json` must map **every** workspace subpath export.
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

const mappings = (() => {
  const tsconfig = parseJsonc(readFileSync(`${ROOT}/tsconfig.depcruise.json`, 'utf8')) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  return tsconfig.compilerOptions?.paths ?? {};
})();

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
        if (!/^packages\/|^apps\//.test(target) || !target.includes('/src/')) {
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
