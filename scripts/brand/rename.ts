/**
 * `pnpm brand:rename --to <slug> --display "<Name>" [--scope @<slug>] [--dry-run]`
 *
 * Rewrite every surface the brand guard cannot cover (`13` §3.A.6). The policy, and why history is
 * left alone, is in `./rename-policy.ts`.
 *
 * Exits non-zero if the leftover report is not empty, so the weekly drill fails loudly rather than
 * producing a tree that merely builds.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit, stdout } from 'node:process';
import { BRAND } from '../../packages/shared/src/brand.js';
import {
  addLegacyBrand,
  addLegacyNames,
  addLegacyVocabulary,
  type CurrentBrand,
  findLeftovers,
  isAllowedLeftover,
  isBinary,
  isFixture,
  isHistory,
  isVocabulary,
  type Leftover,
  rewriteContent,
  rewriteHistoryTitle,
  rewritePath,
  shouldSkip,
  type TargetBrand,
} from './rename-policy.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

const dryRun = argv.includes('--dry-run');
const toSlug = flag('to');
const toDisplay = flag('display');

if (toSlug === undefined || toDisplay === undefined) {
  stdout.write(
    'usage: brand:rename --to <slug> --display "<Name>" [--scope @<slug>] [--dry-run]\n\n' +
      '  --to       the new slug, lower case, e.g. zzbrand\n' +
      '  --display  the new human-facing name, e.g. Zzbrand\n' +
      '  --scope    the new npm scope; defaults to @<slug>\n' +
      '  --dry-run  report what would change and write nothing\n',
  );
  exit(1);
}
if (!/^[a-z][a-z0-9-]*$/.test(toSlug)) {
  stdout.write(`brand:rename: ${toSlug} is not a valid slug (lower case, digits and hyphens).\n`);
  exit(1);
}

const from: CurrentBrand = {
  slug: BRAND.slug,
  display: BRAND.displayName,
  scope: BRAND.npmScope,
  envPrefix: BRAND.envPrefix,
  configFileName: BRAND.configFileName,
};
const to: TargetBrand = {
  slug: toSlug,
  display: toDisplay,
  scope: flag('scope') ?? `@${toSlug}`,
};

if (from.slug === to.slug) {
  stdout.write(`brand:rename: already called ${from.slug}; nothing to do.\n`);
  exit(0);
}

const tracked = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: ROOT, encoding: 'utf8' },
)
  .split('\0')
  .filter((path) => path !== '');

const rewritten: string[] = [];
const moved: [string, string][] = [];
const skipped: string[] = [];

// --- Content -----------------------------------------------------------------------------------
for (const path of tracked) {
  if (shouldSkip(path) || !existsSync(`${ROOT}/${path}`)) continue;
  const bytes = readFileSync(`${ROOT}/${path}`);
  if (isBinary(bytes)) {
    skipped.push(path);
    continue;
  }
  if (isFixture(path)) continue;
  if (isHistory(path)) {
    // The body is a record and stays verbatim; the title is not. See `rewriteHistoryTitle`.
    const titled = rewriteHistoryTitle(bytes.toString('utf8'), from, to);
    if (titled !== bytes.toString('utf8')) {
      rewritten.push(path);
      if (!dryRun) writeFileSync(`${ROOT}/${path}`, titled);
    }
    continue;
  }

  const source = bytes.toString('utf8');
  let next = rewriteContent(source, from, to);

  // Two files keep the outgoing names on purpose, so a host who installed the old build is not
  // stranded. Both additions happen after the rewrite, so the values added are the OLD ones.
  if (path === 'packages/shared/src/brand.ts') next = addLegacyBrand(next, from);
  if (path === 'deploy/names.json') {
    next = addLegacyNames(next, from, `${BRAND.repo.owner}/${BRAND.repo.name}`);
  }
  if (isVocabulary(path)) next = addLegacyVocabulary(next, from);

  if (next === source) continue;
  rewritten.push(path);
  if (!dryRun) writeFileSync(`${ROOT}/${path}`, next);
}

// --- Paths -------------------------------------------------------------------------------------
// After content, so a file is read at its old path and moved once. Deepest first, so renaming a
// directory does not invalidate the paths of files inside it.
const byDepth = [...tracked].sort((a, b) => b.split('/').length - a.split('/').length);
for (const path of byDepth) {
  if (shouldSkip(path)) continue;
  const next = rewritePath(path, from, to);
  if (next === undefined || !existsSync(`${ROOT}/${path}`)) continue;
  moved.push([path, next]);
  if (!dryRun) {
    mkdirSync(dirname(`${ROOT}/${next}`), { recursive: true });
    renameSync(`${ROOT}/${path}`, `${ROOT}/${next}`);
    // Tidy a directory the move emptied, so the tree has no `Comvivo/` shell left behind.
    try {
      rmdirSync(dirname(`${ROOT}/${path}`));
    } catch {
      // Not empty, or the same directory. Either is fine.
    }
  }
}

// --- Formatting --------------------------------------------------------------------------------
// A codemod that produces unformatted output is a codemod whose output fails CI. Found by the
// drill: appending to `BRAND.legacy` pushed that line past the print width, and `biome ci`
// rejected both `brand.ts` and `deploy/names.json`.
//
// `format` rather than `check --write`: formatting is mechanical, while lint autofixes can change
// what code means, and a rename has no business doing that.
if (!dryRun) {
  // The binary directly, not `pnpm exec`: `pnpm` is a shim that `execFileSync` cannot exec
  // (`spawnSync pnpm ENOEXEC`), and going through it would also trigger pnpm's install check for
  // no reason. Found by the drill.
  const biome = `${ROOT}/node_modules/.bin/biome`;
  if (!existsSync(biome)) {
    stdout.write(
      'brand:rename: Biome is not installed, so the output is unformatted.\n\n' +
        '  Run `pnpm install` and then `pnpm exec biome format --write .`\n\n' +
        'On a fresh checkout the rename has to come after the install, which is the order\n' +
        '`rename-drill.yml` uses. Unformatted output fails `biome ci` in `pnpm verify`.\n',
    );
    exit(1);
  }
  try {
    execFileSync(biome, ['format', '--write', '.'], { cwd: ROOT, stdio: 'pipe' });
  } catch (error) {
    const failure = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
    stdout.write(
      'brand:rename: the formatter failed.\n\n' +
        `  exit: ${String(failure.status ?? '?')}\n` +
        `${failure.stdout?.toString() ?? ''}${failure.stderr?.toString() ?? ''}\n`,
    );
    exit(1);
  }
}

// --- Leftovers ---------------------------------------------------------------------------------
const leftovers: Leftover[] = [];
if (!dryRun) {
  const after = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\0')
    .filter((path) => path !== '');

  for (const path of after) {
    if (shouldSkip(path) || isAllowedLeftover(path)) continue;
    if (!existsSync(`${ROOT}/${path}`)) continue;
    const bytes = readFileSync(`${ROOT}/${path}`);
    if (isBinary(bytes)) continue;
    leftovers.push(...findLeftovers(path, bytes.toString('utf8'), from.slug));
  }
}

// --- Report ------------------------------------------------------------------------------------
const verb = dryRun ? 'would rewrite' : 'rewrote';
stdout.write(
  `brand:rename: ${from.display} → ${to.display} (${from.slug} → ${to.slug}, ${from.scope} → ${to.scope})\n\n` +
    `  ${verb} ${String(rewritten.length)} file(s)\n` +
    `  ${dryRun ? 'would move' : 'moved'} ${String(moved.length)} path(s)\n` +
    `  skipped ${String(skipped.length)} non-text file(s)\n\n`,
);

for (const [before, after] of moved) stdout.write(`  ${before}\n    → ${after}\n`);
if (moved.length > 0) stdout.write('\n');

if (leftovers.length > 0) {
  stdout.write(
    `brand:rename: ${String(leftovers.length)} leftover match(es) outside the allowlist.\n\n`,
  );
  for (const leftover of leftovers.slice(0, 40)) {
    stdout.write(`  ${leftover.file}:${String(leftover.line)}\n    ${leftover.text}\n`);
  }
  if (leftovers.length > 40) {
    stdout.write(`  …and ${String(leftovers.length - 40)} more\n`);
  }
  stdout.write(
    '\nEach of these is a surface the codemod does not know about. Add it to `rename-policy.ts`,\n' +
      'or to `LEFTOVER_ALLOWLIST` if the old name belongs there — and say why.\n',
  );
  exit(1);
}

if (!dryRun) {
  stdout.write('brand:rename: no leftover matches outside the allowlist.\n');
  stdout.write(
    '\nNext: `pnpm install` (the lockfile is regenerated, not rewritten), then `pnpm verify`\n' +
      'and `pnpm --filter docs build`. That is what the weekly drill runs.\n',
  );
}
