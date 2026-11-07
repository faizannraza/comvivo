/**
 * Plant boundary violations in a synthetic package tree and run the **real** dependency-cruiser
 * configuration over them.
 *
 * Why a synthetic tree rather than files under `test/fixtures/`: almost every rule in
 * `.dependency-cruiser.cjs` is keyed on the *importing* module's path (`from: '^packages/core/'`
 * and so on), so a fixture that lives in `test/` can never match one. The alternatives were to
 * plant files into the real packages during the test run — which mutates the working tree and
 * races with parallel test files — or to build a throwaway tree whose paths look like the real
 * ones. This is the second.
 *
 * `node_modules` is symlinked rather than copied, so npm dependency types resolve exactly as they
 * do in the repository. That is what lets the `no-dev-dep-in-src` fixture work at all.
 *
 * Specified by `M0-T4`: "Each rule has a planted-violation fixture that makes `pnpm verify` fail."
 */
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REPO = resolve(new URL('../../', import.meta.url).pathname);

/** A file to write into the synthetic tree, as a repo-relative path plus its source. */
export interface PlantedFile {
  /** e.g. `packages/core/src/violation.ts` */
  readonly path: string;
  /** Module specifiers this file imports. Each becomes a side-effect import. */
  readonly imports: readonly string[];
  /**
   * Specifiers imported as **types only**, which dependency-cruiser classifies as `type-only`.
   *
   * Needed to prove the two A11 edges the other way round: `engine` → `plugin-sdk` and
   * `plugin-sdk` → `channels/sdk` are allowed as types and forbidden as values, so a rule that
   * fired on both would be indistinguishable from one that fired on neither.
   */
  readonly typeImports?: readonly string[];
}

export interface CruiseResult {
  /** Names of every rule that reported at least one violation. */
  readonly violatedRules: ReadonlySet<string>;
  /** Every violation, so a test can assert on the exact edge. */
  readonly violations: readonly { rule: string; from: string; to: string }[];
  readonly modulesCruised: number;
}

/** Packages the synthetic tree contains, mirroring the real workspace layout. */
const PACKAGE_DIRS = [
  'packages/shared',
  'packages/core',
  'packages/storage',
  'packages/models',
  'packages/engine',
  'packages/tools',
  'packages/channels/sdk',
  'packages/channels/telegram',
  'packages/channels/discord',
  'packages/channels/simulator',
  'packages/plugin-sdk',
  'packages/plugin-host',
  'packages/mcp',
  'packages/mcp-bridge',
  'packages/api-client',
  'packages/evals',
  'apps/server',
  'apps/cli',
  'apps/dashboard',
  'apps/docs',
] as const;

/** `packages/channels/telegram` → `@comvivo/channel-telegram`, matching the real names. */
function packageNameFor(dir: string): string {
  if (dir.startsWith('packages/channels/')) {
    const leaf = dir.slice('packages/channels/'.length);
    return `@comvivo/channel-${leaf}`;
  }
  if (dir === 'apps/cli') return 'comvivo';
  const leaf = dir.slice(dir.lastIndexOf('/') + 1);
  return `@comvivo/${leaf}`;
}

function write(root: string, relPath: string, contents: string): Promise<void> {
  mkdirSync(join(root, dirname(relPath)), { recursive: true });
  return writeFile(join(root, relPath), contents, 'utf8');
}

/**
 * Build the tree, run the repository's dependency-cruiser config over it, and report which rules
 * fired. The caller gets the temp directory cleaned up either way.
 */
export async function cruisePlanted(planted: readonly PlantedFile[]): Promise<CruiseResult> {
  const root = await mkdtemp(join(tmpdir(), 'comvivo-boundaries-'));
  try {
    // Resolution must behave exactly as it does in the repo, including npm dependency types.
    await symlink(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');

    const paths: Record<string, string[]> = {};
    await Promise.all(
      PACKAGE_DIRS.map(async (dir) => {
        const name = packageNameFor(dir);
        paths[name] = [`${dir}/src/index.ts`];
        paths[`${name}/testing`] = [`${dir}/src/testing/index.ts`];
        await write(
          root,
          `${dir}/package.json`,
          `${JSON.stringify(
            {
              name,
              version: '0.0.0',
              private: true,
              type: 'module',
              exports: { '.': './dist/index.js', './testing': './dist/testing/index.js' },
              // `vitest` is declared as a devDependency in every real package (so Biome's
              // noUndeclaredDependencies rule can stay on), which is what makes it classify as
              // `npm-dev` here. Without this the `no-dev-dep-in-src` fixture cannot fire, because
              // depcruise would see an undeclared dependency instead of a dev one.
              devDependencies: { vitest: '*' },
            },
            null,
            2,
          )}\n`,
        );
        // An empty, legitimate index so the clean tree really is clean.
        await write(root, `${dir}/src/index.ts`, 'export const ok = true;\n');
        await write(root, `${dir}/src/testing/index.ts`, 'export const double = true;\n');
      }),
    );

    // The port whose callers are restricted. It exists here so the rule has something to point at;
    // in the repository it arrives with `M1-T18`.
    await write(
      root,
      'packages/core/src/ports/memory-search.ts',
      'export interface MemorySearchPort { search(q: string): readonly string[] }\n',
    );
    paths['@comvivo/core/ports/memory-search'] = ['packages/core/src/ports/memory-search.ts'];

    // The unfiltered reads, same arrangement: present so the rule has an edge to match, and
    // arriving in the repository with `M1-T17`. `02` §3.7.1 asks for a dependency-cruiser rule on
    // a *method name*, which a module graph cannot see — so the reads that skip the eligible-label
    // filter live in their own module and the restriction is on the import.
    await write(
      root,
      'packages/core/src/ports/storage/unfiltered.ts',
      'export interface UnfilteredReads { listMessagesUnfiltered(): readonly string[] }\n',
    );
    paths['@comvivo/core/ports/storage/unfiltered'] = [
      'packages/core/src/ports/storage/unfiltered.ts',
    ];

    await Promise.all(
      planted.map((file) =>
        write(
          root,
          file.path,
          `${[
            ...file.imports.map((spec) => `import '${spec}';`),
            ...(file.typeImports ?? []).map(
              (spec, index) => `import type { Thing as T${String(index)} } from '${spec}';`,
            ),
            ...(file.typeImports ?? []).map(
              (_spec, index) => `export type Alias${String(index)} = T${String(index)};`,
            ),
          ].join('\n')}\nexport const planted = true;\n`,
        ),
      ),
    );

    await write(
      root,
      'tsconfig.base.json',
      `${JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2024',
            module: 'nodenext',
            moduleResolution: 'nodenext',
            strict: true,
            noEmit: true,
            types: [],
          },
        },
        null,
        2,
      )}\n`,
    );
    await write(
      root,
      'tsconfig.depcruise.json',
      `${JSON.stringify(
        {
          extends: './tsconfig.base.json',
          compilerOptions: { baseUrl: '.', paths },
          include: ['packages/**/*.ts', 'apps/**/*.ts'],
        },
        null,
        2,
      )}\n`,
    );

    // The real config, unmodified. If this file and the repository's rules ever diverge, these
    // tests stop meaning anything — so it is read, not reimplemented.
    const config = await import('node:fs/promises').then((fs) =>
      fs.readFile(join(REPO, '.dependency-cruiser.cjs'), 'utf8'),
    );
    await write(root, '.dependency-cruiser.cjs', config);

    const bin = join(REPO, 'node_modules', '.bin', 'depcruise');
    let stdout = '';
    try {
      const out = await execFileAsync(
        bin,
        ['packages', 'apps', '--config', '.dependency-cruiser.cjs', '--output-type', 'json'],
        { cwd: root, maxBuffer: 64 * 1024 * 1024 },
      );
      stdout = out.stdout;
    } catch (error) {
      // depcruise exits non-zero when it finds violations, which is the normal case here.
      const withStdout = error as { stdout?: string };
      if (typeof withStdout.stdout !== 'string' || withStdout.stdout === '') throw error;
      stdout = withStdout.stdout;
    }

    const parsed = JSON.parse(stdout) as {
      summary: {
        violations: { rule: { name: string }; from: string; to: string }[];
        totalCruised: number;
      };
    };
    const violations = parsed.summary.violations.map((v) => ({
      rule: v.rule.name,
      from: v.from,
      to: v.to,
    }));
    return {
      violatedRules: new Set(violations.map((v) => v.rule)),
      violations,
      modulesCruised: parsed.summary.totalCruised,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
