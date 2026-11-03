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
  type CurrentBrand,
  findLeftovers,
  isAllowedLeftover,
  isHistory,
  isTextFile,
  type Leftover,
  rewriteContent,
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
  if (!isTextFile(path)) {
    skipped.push(path);
    continue;
  }
  if (isHistory(path)) continue;

  const source = readFileSync(`${ROOT}/${path}`, 'utf8');
  let next = rewriteContent(source, from, to);

  // Two files keep the outgoing names on purpose, so a host who installed the old build is not
  // stranded. Both additions happen after the rewrite, so the values added are the OLD ones.
  if (path === 'packages/shared/src/brand.ts') next = addLegacyBrand(next, from);
  if (path === 'deploy/names.json') {
    next = addLegacyNames(next, from, `${BRAND.repo.owner}/${BRAND.repo.name}`);
  }

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
    if (shouldSkip(path) || !isTextFile(path) || isAllowedLeftover(path)) continue;
    if (!existsSync(`${ROOT}/${path}`)) continue;
    leftovers.push(...findLeftovers(path, readFileSync(`${ROOT}/${path}`, 'utf8'), from.slug));
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
