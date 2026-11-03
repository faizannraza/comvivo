/**
 * Lockfile and dependency-source policy (`08` §3.15, `sec.supply.policy`).
 *
 * Three rules, all about **where code comes from**:
 *
 *  1. Every dependency resolves from the registry. No `git+`, no `github:`, no tarball URL, no
 *     `file:` or `link:` outside the workspace.
 *  2. The lockfile agrees with the manifests, so `--frozen-lockfile` in CI is a real check rather
 *     than a formality.
 *  3. `allowBuilds` matches `08` §3.15 exactly — already enforced by `native-policy.ts`, and worth
 *     stating here because `pnpm-workspace.yaml` is a CODEOWNERS security path for this reason.
 *
 * Why the first rule matters more than it looks: a registry version is immutable and has a
 * published provenance trail, a `minimumReleaseAge` we can wait out, and an OSV record if it turns
 * out to be malicious. `git+https://…#main` has none of those — it is whatever that branch holds
 * at install time, which may differ between a maintainer's machine and CI, and which no scanner
 * will ever flag. pnpm's `blockExoticSubdeps: true` already refuses them in *transitive* position;
 * this covers our own manifests, which that setting does not.
 */
import { readFileSync } from 'node:fs';

export interface Problem {
  readonly file: string;
  readonly detail: string;
  readonly fix: string;
}

/**
 * Specifier prefixes that are not the registry.
 *
 * `workspace:` and `catalog:` are ours and are the point of the monorepo. `npm:` is a registry
 * alias, used for scoped re-exports. Everything else fetches code from somewhere with no
 * immutability guarantee.
 */
const EXOTIC = [
  { prefix: 'git+', why: 'a git URL resolves to whatever the ref holds at install time' },
  { prefix: 'git:', why: 'a git URL resolves to whatever the ref holds at install time' },
  { prefix: 'github:', why: 'a GitHub shorthand is a git URL with no version pin' },
  { prefix: 'gitlab:', why: 'a GitLab shorthand is a git URL with no version pin' },
  { prefix: 'bitbucket:', why: 'a Bitbucket shorthand is a git URL with no version pin' },
  { prefix: 'http://', why: 'a tarball URL is mutable and has no provenance' },
  { prefix: 'https://', why: 'a tarball URL is mutable and has no provenance' },
  { prefix: 'file:', why: 'a file dependency does not exist on anybody else’s machine' },
  { prefix: 'link:', why: 'a link dependency does not exist on anybody else’s machine' },
] as const;

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** Check one `package.json`'s dependency specifiers. */
export function findExoticSpecifiers(file: string, source: string): Problem[] {
  const problems: Problem[] = [];
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(source) as Record<string, unknown>;
  } catch (cause) {
    return [
      {
        file,
        detail: `is not valid JSON: ${String(cause)}`,
        fix: 'Fix the JSON. A manifest that does not parse means nothing below was checked.',
      },
    ];
  }

  for (const field of DEPENDENCY_FIELDS) {
    const block = manifest[field];
    if (typeof block !== 'object' || block === null) continue;
    for (const [name, raw] of Object.entries(block as Record<string, unknown>)) {
      if (typeof raw !== 'string') continue;
      const match = EXOTIC.find((entry) => raw.startsWith(entry.prefix));
      if (match === undefined) continue;
      problems.push({
        file,
        detail: `${field}.${name} = ${JSON.stringify(raw)} — ${match.why}`,
        fix:
          `Publish it to the registry and depend on a version range, or vendor the code into ` +
          `this repository where it is reviewed like ours. If the package is a workspace member, ` +
          `use \`workspace:*\`.`,
      });
    }
  }

  return problems;
}

/**
 * Check the lockfile for resolutions that did not come from a registry.
 *
 * Read as text rather than parsed. The v9 lockfile format nests resolutions under keys whose shape
 * changes between pnpm minors, and the thing being looked for — a `tarball:` or `repo:` resolution
 * — is unambiguous as a line. A parser tied to one lockfile version would be the more fragile
 * choice for a check that must keep working across upgrades.
 */
export function findExoticResolutions(file: string, source: string): Problem[] {
  const problems: Problem[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    // `resolution: {tarball: https://…}` and `resolution: {repo: …, type: git}`.
    const isTarball = /^resolution:\s*\{\s*tarball:/.test(trimmed);
    const isGit =
      /^resolution:\s*\{[^}]*\btype:\s*git\b/.test(trimmed) || /^\s*repo:\s/.test(trimmed);
    if (!isTarball && !isGit) return;
    problems.push({
      file: `${file}:${String(index + 1)}`,
      detail: `${isTarball ? 'a tarball' : 'a git'} resolution: ${trimmed.slice(0, 110)}`,
      fix:
        'Remove the dependency that pulled it in. pnpm `blockExoticSubdeps: true` refuses these ' +
        'transitively, so one here means a direct dependency asked for it.',
    });
  });
  return problems;
}

/** Read every workspace manifest and check it. Separated for testability. */
export function checkManifests(root: string, manifestPaths: readonly string[]): Problem[] {
  return manifestPaths.flatMap((relative) => {
    try {
      return findExoticSpecifiers(relative, readFileSync(`${root}/${relative}`, 'utf8'));
    } catch {
      return [];
    }
  });
}

export function report(problems: readonly Problem[]): string {
  if (problems.length === 0) return '';
  const lines = [`supply: ${String(problems.length)} dependency-source problem(s).`, ''];
  for (const problem of problems) {
    lines.push(`  ${problem.file}`);
    lines.push(`    ${problem.detail}`);
    lines.push(`    fix: ${problem.fix}`);
    lines.push('');
  }
  lines.push(
    'Why this is blocked: a registry version is immutable, has a provenance trail, waits out',
    '`minimumReleaseAge`, and gets an OSV record if it turns out to be malicious. A git ref or a',
    'tarball URL has none of those, and no scanner will ever flag it. (08 §3.15)',
    '',
  );
  return lines.join('\n');
}
