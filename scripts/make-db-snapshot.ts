#!/usr/bin/env tsx
/**
 * Produce a released database snapshot for the upgrade tests (`02` §3.12.6, `11` §3.1.8).
 *
 * The snapshot is the only thing that can prove an upgrade works. `migrations.fresh-equals-migrated`
 * compares two *fresh* databases, so it cannot see a migration that is correct on an empty schema
 * and wrong on one holding rows — which is the migration that breaks a real host. One snapshot per
 * release, migrated to HEAD by `migrations.int.test.ts`, is what closes that gap.
 *
 * ## Usage
 *
 *   pnpm tsx scripts/make-db-snapshot.ts --version v0.1.0
 *   pnpm tsx scripts/make-db-snapshot.ts --version v0.1.0 --out fixtures/db-snapshots
 *
 * `M14-T4` calls this from the release workflow. It is runnable by hand so the first release does
 * not debug the script and the release together.
 *
 * The seed profile itself lives in
 * `packages/storage/src/migrate/testing/release-seed.ts`, because it is knowledge about that
 * schema and because the seeder needs that package's dependencies.
 *
 * ## Why unencrypted and deterministic
 *
 * Unencrypted because the fixture is committed and read by tests on machines with no keyfile, and
 * because `08`'s key derivation would make the bytes differ per machine. Deterministic because a
 * snapshot that changes on every run produces a diff on every release and nobody reads it after
 * the second time — the seed uses fixed ids and a fixed clock.
 *
 * The data is **synthetic**: `11` §3.1.8 says so, and it has to be, since a snapshot is a
 * committed artefact. There is no path by which a real group's content reaches this file.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { writeSourcePathsTsconfig } from './support/paths-tsconfig.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = 'fixtures/db-snapshots';

interface Args {
  readonly version: string;
  readonly out: string;
}

function parseArgs(argv: readonly string[]): Args {
  const version = flagValue(argv, '--version');
  if (version === undefined || !/^v\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('--version is required and must look like v0.1.0');
  }
  return { version, out: flagValue(argv, '--out') ?? DEFAULT_OUT };
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  const work = mkdtempSync(join(tmpdir(), 'comvivo-snapshot-'));
  try {
    const dbPath = join(work, 'snapshot.sqlite');
    // A child process, because applying the migrations needs the storage package's own loader
    // setup and this script must stay runnable from the repo root.
    // `TSX_TSCONFIG_PATH` is required, not defensive: the workspace `paths` map redirects
    // `better-sqlite3-multiple-ciphers` to the declaration file it hides behind its `exports`, and
    // tsx would *execute* the `.d.ts` (`ReferenceError: Database is not defined`). The filtered
    // map drops `.d.ts` targets. Fourth place this has bitten; see `scripts/support/`.
    execFileSync(
      join(REPO_ROOT, 'node_modules/.bin/tsx'),
      [
        join(REPO_ROOT, 'packages/storage/src/migrate/testing/seed-snapshot.mjs'),
        dbPath,
        args.version,
      ],
      {
        cwd: join(REPO_ROOT, 'packages/storage'),
        stdio: 'inherit',
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: writeSourcePathsTsconfig(work, REPO_ROOT, 'tsconfig.child.json'),
        },
      },
    );

    const outDir = resolve(REPO_ROOT, args.out);
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${args.version}.sqlite.gz`);
    // Level 9. Measured: `gzipSync` writes a zero mtime into the gzip header and is byte-identical
    // across calls for identical input, so no option is needed to make the fixture reproducible —
    // which matters because it is committed and would otherwise produce a diff on every release.
    writeFileSync(outPath, gzipSync(readFileSync(dbPath), { level: 9 }));
    process.stdout.write(`wrote ${outPath}\n`);
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
