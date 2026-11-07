/**
 * Write a `tsconfig` whose `paths` map resolves `@comvivo/*` to **source** (`tsconfig.paths.json`).
 *
 * ## Why a test needs this at all
 *
 * `vitest.shared.ts` builds its `resolve.alias` from `tsconfig.paths.json`, so anything running
 * *inside* a vitest worker already resolves workspace imports to `src/`. A **child context** does
 * not: a `node:worker_threads` worker, or a CLI this repository shells out to, resolves
 * `@comvivo/shared` through the package `exports` map and lands in `dist/`.
 *
 * That is green on a developer's machine, where `dist/` exists from the last build, and red on
 * every clean runner. `pnpm verify` cannot catch it either, because `typecheck` builds before
 * `test` — so CI's dist-free jobs are the real gate. Two tests have now been bitten by it:
 *
 *  - `db/worker-connection.int.test.ts` (`M1-T8`), which hands this to `tsx` through
 *    `TSX_TSCONFIG_PATH`;
 *  - `schema/ddl.int.test.ts` (`M1-T11`), which writes it as a plain `tsconfig.json` beside the
 *    generated drizzle-kit config, because drizzle-kit's own `resolveTsPaths` looks for one there.
 *
 * ## Why `.d.ts` targets are filtered out
 *
 * A type-only entry in the paths map has no runtime module behind it, so pointing a loader at one
 * makes it try to *execute* a declaration file. That was the first failure of the `M1-T8` fix: the
 * map redirects `better-sqlite3-multiple-ciphers` to the declaration file it ships but hides behind
 * its `exports`, and `tsx` then threw `ReferenceError: Database is not defined` — the same trap
 * `vitest.shared.ts` records hitting and filters for. This applies the identical filter to the
 * identical source of truth, rather than hand-writing a second map that could drift from the one
 * `tsc`, dependency-cruiser and Vitest all read.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonc } from './jsonc.js';

interface PathsFile {
  readonly compilerOptions: { readonly paths: Record<string, readonly string[]> };
}

/**
 * The workspace paths map, with every target made absolute and type-only entries dropped.
 *
 * @param repoRoot the repository root, which every target is relative to
 */
export function sourcePaths(repoRoot: string): Record<string, string[]> {
  const source = parseJsonc(
    readFileSync(join(repoRoot, 'tsconfig.paths.json'), 'utf8'),
  ) as PathsFile;

  const paths: Record<string, string[]> = {};
  for (const [specifier, targets] of Object.entries(source.compilerOptions.paths)) {
    const target = targets[0];
    if (target === undefined || target.endsWith('.d.ts')) continue;
    paths[specifier] = [join(repoRoot, target)];
  }
  return paths;
}

/**
 * Write the map as a tsconfig into `directory` and return its path.
 *
 * @param fileName `tsconfig.json` when a tool discovers it by convention (drizzle-kit), or a
 *   distinct name when it is passed explicitly (`TSX_TSCONFIG_PATH`).
 */
export function writeSourcePathsTsconfig(
  directory: string,
  repoRoot: string,
  fileName = 'tsconfig.json',
): string {
  const path = join(directory, fileName);
  writeFileSync(
    path,
    `${JSON.stringify({ compilerOptions: { paths: sourcePaths(repoRoot) } }, null, 2)}\n`,
  );
  return path;
}
