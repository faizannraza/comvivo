/**
 * The distribution-name policy (`12` §3.1, `13` §3.A.5).
 *
 * `deploy/names.json` is the single source of truth for every name this project publishes under:
 * the npm package and scope, the container images, the repository, the Home Assistant slug, the
 * Umbrel and CasaOS ids, the docs and release-manifest URLs.
 *
 * Two mechanisms keep it true:
 *
 *  - **`names:check`** fails when the manifest disagrees with `BRAND` (the constant the code
 *    actually reads), when a workspace package is named something the manifest does not describe,
 *    or when a legacy name survives anywhere in `deploy/**` or `.github/**`.
 *  - **`names:apply`** rewrites legacy names to current ones, idempotently.
 *
 * Why both, and why a `legacy` list rather than a cleverer codemod: `13` §3.A.6 requires that a
 * forced rename stays a one-command operation, and a weekly drill proves it. A codemod that
 * inferred our names by shape would also rewrite `ghcr.io/renovatebot/renovate`. An explicit list
 * of what we used to be called cannot do that.
 */
import { z } from 'zod';
import type { Brand } from '../../packages/shared/src/brand.js';

const nonEmpty = z.string().min(1);

export const namesSchema = z
  .object({
    productName: nonEmpty,
    org: nonEmpty,
    repo: z.string().regex(/^[^/]+\/[^/]+$/, 'must be owner/name'),
    npm: z
      .object({
        cli: nonEmpty,
        scope: z.string().regex(/^@[a-z0-9-]+$/),
        createPackage: nonEmpty,
      })
      .strict(),
    images: z.object({ main: nonEmpty, ha: nonEmpty, dockerHub: z.string().nullable() }).strict(),
    ha: z.object({ repo: nonEmpty, slug: nonEmpty, betaSlug: nonEmpty }).strict(),
    umbrel: z
      .object({
        communityStoreRepo: nonEmpty,
        storeId: nonEmpty,
        officialAppId: nonEmpty,
        port: z.number().int().positive(),
      })
      .strict(),
    casaos: z.object({ storeRepo: nonEmpty, appId: nonEmpty }).strict(),
    unraid: z.object({ templateRepo: nonEmpty }).strict(),
    docsUrl: z.url(),
    releaseManifestUrl: z.url(),
    legacy: z
      .object({
        names: z.array(nonEmpty),
        repos: z.array(nonEmpty),
        images: z.array(nonEmpty),
        scopes: z.array(nonEmpty),
      })
      .strict(),
  })
  // `$comment` keys carry the reasoning. Stripped before validation rather than allowed through,
  // so a typo in a real key is still caught by `.strict()`.
  .strict();

export type Names = z.output<typeof namesSchema>;

/** Drop `$comment` keys at any depth, so the manifest can explain itself and still be strict. */
export function stripComments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== '$comment')
      .map(([key, item]) => [key, stripComments(item)]),
  );
}

export interface Problem {
  readonly where: string;
  readonly detail: string;
  readonly fix: string;
}

/**
 * The manifest and `BRAND` must agree.
 *
 * They are two copies of the same decision — one read by the build and release machinery, one read
 * by the running product — and the failure mode when they drift is a release published under a
 * name the software does not answer to.
 */
export function crossCheckBrand(names: Names, brand: Brand): Problem[] {
  const problems: Problem[] = [];
  const expect = (where: string, manifest: string, constant: string, key: string): void => {
    if (manifest === constant) return;
    problems.push({
      where,
      detail: `names.json has ${JSON.stringify(manifest)}, BRAND.${key} has ${JSON.stringify(constant)}`,
      fix: 'Change both, or neither. They are one decision stored twice.',
    });
  };

  expect('productName', names.productName, brand.displayName, 'displayName');
  expect('npm.cli', names.npm.cli, brand.npmCliPackage, 'npmCliPackage');
  expect('npm.scope', names.npm.scope, brand.npmScope, 'npmScope');
  expect('repo', names.repo, `${brand.repo.owner}/${brand.repo.name}`, 'repo');
  expect('images.main', names.images.main, brand.containerImage, 'containerImage');
  expect('org', names.org, brand.repo.owner, 'repo.owner');

  if (names.npm.createPackage !== `create-${brand.slug}`) {
    problems.push({
      where: 'npm.createPackage',
      detail: `${names.npm.createPackage} is not create-${brand.slug}`,
      fix: `The scaffolder is named after the slug: create-${brand.slug}.`,
    });
  }
  if (names.images.ha !== `${brand.containerImage}-ha`) {
    problems.push({
      where: 'images.ha',
      detail: `${names.images.ha} is not ${brand.containerImage}-ha`,
      fix: 'The Home Assistant image is the main image with a `-ha` suffix.',
    });
  }

  return problems;
}

/** Workspace package names must be the CLI name or inside the scope. */
export function checkPackageNames(names: Names, packageNames: readonly string[]): Problem[] {
  return packageNames
    .filter((name) => name !== names.npm.cli && !name.startsWith(`${names.npm.scope}/`))
    .map((name) => ({
      where: name,
      detail: `is neither ${names.npm.cli} nor inside ${names.npm.scope}/`,
      fix: `Rename it to ${names.npm.scope}/<something>, or to ${names.npm.cli} if it is the CLI.`,
    }));
}

/** Every legacy string, longest first so a longer match is rewritten before a shorter prefix. */
export function legacyTerms(names: Names): string[] {
  return [
    ...names.legacy.images,
    ...names.legacy.repos,
    ...names.legacy.scopes,
    ...names.legacy.names,
  ].sort((a, b) => b.length - a.length);
}

/** What each legacy string becomes. */
export function replacements(names: Names): [string, string][] {
  const pairs: [string, string][] = [];
  for (const image of names.legacy.images) {
    pairs.push([image, image.endsWith('-ha') ? names.images.ha : names.images.main]);
  }
  for (const repo of names.legacy.repos) pairs.push([repo, names.repo]);
  for (const scope of names.legacy.scopes) pairs.push([scope, names.npm.scope]);
  for (const name of names.legacy.names) pairs.push([name, names.npm.cli]);
  // Longest first: `ghcr.io/x/village-ha` must be rewritten before `village`.
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

/**
 * Whole-word matching, so `village` does not match inside `villager` — and, more to the point, so
 * a legacy term is not rewritten inside an unrelated third-party identifier.
 */
function wordPattern(term: string): RegExp {
  const escaped = term.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'g');
}

export function findStaleReferences(path: string, source: string, names: Names): Problem[] {
  const problems: Problem[] = [];
  const pairs = replacements(names);
  source.split(/\r?\n/).forEach((line, index) => {
    for (const [from, to] of pairs) {
      if (!wordPattern(from).test(line)) continue;
      problems.push({
        where: `${path}:${String(index + 1)}`,
        detail: `uses the legacy name ${JSON.stringify(from)}`,
        fix: `Run \`pnpm names:apply\`, which rewrites it to ${JSON.stringify(to)}.`,
      });
      break; // One finding per line: the longest match is the informative one.
    }
  });
  return problems;
}

/** Rewrite legacy names to current ones. Idempotent: a second pass finds nothing left to change. */
export function applyTo(source: string, names: Names): string {
  let out = source;
  for (const [from, to] of replacements(names)) {
    out = out.replaceAll(wordPattern(from), to);
  }
  return out;
}

export function report(label: string, problems: readonly Problem[]): string {
  if (problems.length === 0) return '';
  const lines = [`names: ${String(problems.length)} ${label}.`, ''];
  for (const problem of problems) {
    lines.push(`  ${problem.where}`);
    lines.push(`    ${problem.detail}`);
    lines.push(`    fix: ${problem.fix}`);
    lines.push('');
  }
  return lines.join('\n');
}
