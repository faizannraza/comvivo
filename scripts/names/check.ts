/**
 * `pnpm names:check` — the distribution names agree with each other (`12` §3.1).
 *
 * The policy, and why the legacy list is explicit rather than inferred, is in `./names-policy.ts`.
 */
import { execFileSync } from 'node:child_process';
import { exit, stdout } from 'node:process';
import { BRAND } from '../../packages/shared/src/brand.js';
import { readListed } from '../support/read-listed.js';
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

/** The manifest is this check's input, so an unreadable one is a failure, not a skipped file. */
function readManifest(path: string): string {
  const read = readListed(path);
  if (read.kind === 'text') return read.text;
  stdout.write(
    `names: ${path} could not be read (${read.kind === 'missing' ? 'ENOENT' : read.reason}).\n`,
  );
  exit(1);
}

function listFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path !== '');
}

const parsed = namesSchema.safeParse(
  stripComments(JSON.parse(readManifest(`${ROOT}/deploy/names.json`))),
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
    const read = readListed(`${ROOT}/${path}`);
    if (read.kind === 'missing') return [];
    if (read.kind === 'failed') {
      // Not swallowed: a workspace manifest this check cannot read is a package whose name it did
      // not check, and the summary below would still have counted it.
      problems.push({
        where: path,
        detail: `could not be read (${read.reason})`,
        fix: 'Make the file readable, or remove it from the workspace.',
      });
      return [];
    }
    try {
      const manifest = JSON.parse(read.text) as { name?: unknown };
      return typeof manifest.name === 'string' ? [manifest.name] : [];
    } catch {
      problems.push({
        where: path,
        detail: 'is not valid JSON, so its package name could not be checked',
        fix: 'Fix the manifest.',
      });
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
// Counted, not assumed: the summary below used to print `scanned.length` — every file the listing
// produced — while a read failure was swallowed, so a file it could not open was reported as one
// in which no legacy name survives. `readListed` separates the `git ls-files` race (benign) from
// a file that is there and unreadable (a gap). Found by the M1 exit gate's reviewer.
let checked = 0;
for (const path of scanned) {
  const read = readListed(`${ROOT}/${path}`);
  if (read.kind === 'missing') continue;
  if (read.kind === 'failed') {
    problems.push({
      where: path,
      detail: `could not be read (${read.reason}), so a legacy name here would not be found`,
      fix: 'Make the file readable, or remove it from the tree.',
    });
    continue;
  }
  checked += 1;
  problems.push(...findStaleReferences(path, read.text, names));
}

if (problems.length > 0) {
  stdout.write(report('name problem(s)', problems));
  exit(1);
}

stdout.write(
  `names: ${names.productName} — manifest agrees with BRAND, ` +
    `${String(packageNames.length)} package names are in ${names.npm.scope}/ or are ${names.npm.cli}, ` +
    `and no legacy name survives in ${String(checked)} scanned files.\n`,
);
