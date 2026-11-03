/**
 * `pnpm names:check` — the distribution names agree with each other (`12` §3.1).
 *
 * The policy, and why the legacy list is explicit rather than inferred, is in `./names-policy.ts`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { exit, stdout } from 'node:process';
import { BRAND } from '../../packages/shared/src/brand.js';
import {
  checkPackageNames,
  crossCheckBrand,
  findStaleReferences,
  namesSchema,
  type Problem,
  report,
  stripComments,
} from './names-policy.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

function listFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path !== '');
}

const parsed = namesSchema.safeParse(
  stripComments(JSON.parse(readFileSync(`${ROOT}/deploy/names.json`, 'utf8'))),
);
if (!parsed.success) {
  stdout.write('names: deploy/names.json is not valid.\n\n');
  for (const issue of parsed.error.issues) {
    stdout.write(`  ${issue.path.join('.') || '(root)'}: ${issue.message}\n`);
  }
  exit(1);
}
const names = parsed.data;

const files = listFiles();
const problems: Problem[] = [...crossCheckBrand(names, BRAND)];

// Workspace package names.
const packageNames = files
  .filter((path) => path.endsWith('package.json') && path !== 'package.json')
  .flatMap((path) => {
    try {
      const manifest = JSON.parse(readFileSync(`${ROOT}/${path}`, 'utf8')) as { name?: unknown };
      return typeof manifest.name === 'string' ? [manifest.name] : [];
    } catch {
      return [];
    }
  });
problems.push(...checkPackageNames(names, packageNames));

/**
 * Where a legacy name must not survive.
 *
 * `docs/` is excluded because the plan documents the rename and quotes the old name throughout —
 * `01` §14 A2, ADR-024 and the STATUS decisions log all have to say what the project used to be
 * called. `naming/` is gitignored and never listed.
 */
/**
 * The manifest is excluded from its own scan: it **declares** the legacy names, so scanning it
 * finds every one of them. Obvious once stated, and found on the first run.
 */
const MANIFEST = 'deploy/names.json';

const SCANNED = [/^deploy\//, /^\.github\//, /package\.json$/, /^pnpm-workspace\.yaml$/];
const scanned = files.filter(
  (path) =>
    SCANNED.some((pattern) => pattern.test(path)) && !path.startsWith('docs/') && path !== MANIFEST,
);
for (const path of scanned) {
  try {
    problems.push(...findStaleReferences(path, readFileSync(`${ROOT}/${path}`, 'utf8'), names));
  } catch {
    // Deleted between listing and reading.
  }
}

if (problems.length > 0) {
  stdout.write(report('name problem(s)', problems));
  exit(1);
}

stdout.write(
  `names: ${names.productName} — manifest agrees with BRAND, ` +
    `${String(packageNames.length)} package names are in ${names.npm.scope}/ or are ${names.npm.cli}, ` +
    `and no legacy name survives in ${String(scanned.length)} scanned files.\n`,
);
