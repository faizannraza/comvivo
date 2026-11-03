/**
 * The rename codemod's policy (`13` §3.A.6).
 *
 * `BRAND` is the only place *runtime* code holds the product name, and `scripts/brand/check.ts`
 * keeps it that way for TypeScript literals. Everything else — package names, import specifiers,
 * tsconfig references, workflows, Dockerfiles, manifests, docs prose, Vale vocabularies, and file
 * and directory **names** — is a surface no constant can cover. This is what rewrites those.
 *
 * It exists because the name has already changed twice (`docs/adr/ADR-024-product-name.md`), and a
 * trademark letter would change it again on somebody else's schedule. A rename that takes an
 * afternoon of grepping is a rename that leaves something behind in a URL or an env var.
 *
 * The weekly drill (`.github/workflows/rename-drill.yml`) renames to `zzbrand` in a scratch
 * checkout and runs the full verify. That is the only way to know this still works: a codemod is
 * exactly the kind of tool that rots silently as the tree grows new surfaces.
 */

export interface CurrentBrand {
  readonly slug: string;
  readonly display: string;
  readonly scope: string;
  readonly envPrefix: string;
  readonly configFileName: string;
}

export interface TargetBrand {
  readonly slug: string;
  readonly display: string;
  readonly scope: string;
}

/**
 * Files whose content is **not** rewritten, because they are a record of what the name used to be.
 *
 * A rename does not rewrite history. `ADR-024` is the decision record for choosing the name;
 * `STATUS.md` is the log of every decision and plan change. Rewriting either would turn an
 * accurate account of a past rename into a false one, and the leftover report would then be empty
 * for the wrong reason.
 */
/**
 * Files whose content names **both sides** of a rename as test data.
 *
 * `rename-policy.test.ts` asserts that `comvivo` becomes `zzbrand`. Rewriting it during a rename
 * turns every one of those assertions into a no-op comparing a name to itself — the test then
 * passes while testing nothing, or fails confusingly, which is what the drill found.
 *
 * Exempting it is correct rather than a workaround: the functions under test take an arbitrary
 * source and target, so `comvivo → zzbrand` remains a valid case no matter what the product ends
 * up being called. The data is not a reference to the current brand; it is a pair of example
 * strings.
 */
export const FIXTURES: readonly RegExp[] = [/^scripts\/brand\/[^/]+\.test\.ts$/];

export function isFixture(path: string): boolean {
  return FIXTURES.some((pattern) => pattern.test(path));
}

export const HISTORY: readonly RegExp[] = [
  /^docs\/adr\//,
  /^docs\/plan\/STATUS\.md$/,
  /(^|\/)CHANGELOG\.md$/,
  /^\.changeset\/[^/]+\.md$/,
];

/**
 * Paths the codemod never touches at all.
 *
 * The lockfile is **regenerated**, not rewritten: renaming the npm scope changes every workspace
 * key, and a hand-edited lockfile is worse than none. The drill runs `pnpm install` first for
 * exactly this reason.
 */
export const SKIP: readonly RegExp[] = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)\.astro\//,
  /(^|\/)\.turbo\//,
  /(^|\/)coverage\//,
  /(^|\/)reports\//,
  /^pnpm-lock\.yaml$/,
  // Vendored third-party Vale rules. Ours live in `.vale/styles/<Display>/`.
  /^\.vale\/styles\/(Microsoft|write-good)\//,
];

/** Extensions the codemod will read as text. Anything else is left alone. */
const TEXT = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'mjs',
  'cjs',
  'jsx',
  'json',
  'jsonc',
  'json5',
  'yaml',
  'yml',
  'toml',
  'ini',
  'md',
  'mdx',
  'txt',
  'html',
  'css',
  'scss',
  'svg',
  'sh',
  'bash',
  'py',
  'sql',
  'env',
  'example',
  'astro',
  'vue',
  'dockerfile',
  'editorconfig',
  'gitattributes',
  'gitignore',
  'npmrc',
  'node-version',
]);

export function isTextFile(path: string): boolean {
  const base = path.split('/').pop() ?? '';
  if (base.toLowerCase() === 'dockerfile' || base.toLowerCase().startsWith('dockerfile.')) {
    return true;
  }
  if (base.startsWith('.') && !base.slice(1).includes('.')) {
    // `.gitignore`, `.npmrc`, `.node-version`, `.editorconfig`.
    return TEXT.has(base.slice(1).toLowerCase());
  }
  const ext = base.includes('.') ? (base.split('.').pop() ?? '') : '';
  return TEXT.has(ext.toLowerCase());
}

export function shouldSkip(path: string): boolean {
  return SKIP.some((pattern) => pattern.test(path));
}

export function isHistory(path: string): boolean {
  return HISTORY.some((pattern) => pattern.test(path));
}

/**
 * Replace the slug while preserving the case of each match.
 *
 * `Comvivo` → `Zzbrand`, `comvivo` → `zzbrand`, `COMVIVO` → `ZZBRAND`. The capitalised form maps
 * to the **display name**, not to a capitalised slug, because the two can differ: a slug of
 * `my-thing` with a display name of `MyThing` is perfectly ordinary, and a rename that produced
 * `My-thing` in prose would be a rename somebody has to go and fix by hand.
 *
 * `(?<![A-Za-z0-9])`/`(?![A-Za-z0-9])` rather than `\b`: a `-` or `.` **is** a word boundary, so
 * `\b` would happily match the `comvivo` inside `not-comvivo-thing`, while these refuse to match
 * inside a longer alphanumeric run such as `comvivos` or `xcomvivo`.
 */
export function rewriteContent(source: string, from: CurrentBrand, to: TargetBrand): string {
  const escaped = from.slug.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi');
  return source.replaceAll(pattern, (match) => {
    if (match === match.toLowerCase()) return to.slug;
    if (match === match.toUpperCase()) return to.slug.toUpperCase();
    // Capitalised, or anything mixed: the display name is the human-facing form.
    return to.display;
  });
}

/** The new path for a file whose name or directory contains the slug, or `undefined` if unchanged. */
export function rewritePath(path: string, from: CurrentBrand, to: TargetBrand): string | undefined {
  const rewritten = rewriteContent(path, from, to);
  return rewritten === path ? undefined : rewritten;
}

export interface Leftover {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Where the old name may legitimately survive a rename.
 *
 * Everything else in the leftover report is a surface the codemod missed, which is the one output
 * of this tool that matters: a green drill with a non-empty report is a rename that looked like it
 * worked.
 */
export const LEFTOVER_ALLOWLIST: readonly RegExp[] = [
  ...HISTORY,
  ...FIXTURES,
  // `BRAND.legacy` and `names.json.legacy` keep the previous names on purpose, so a host who
  // installed the old build is not stranded (`13` §3.A.6, legacy compatibility).
  /^packages\/shared\/src\/brand\.ts$/,
  /^deploy\/names\.json$/,
  // The rename tooling itself: these files describe the mechanism and name both sides of it.
  /^scripts\/brand\//,
  /^\.github\/workflows\/rename-drill\.yml$/,
  // The plan records that the project was renamed, in the amendment that did it.
  /^docs\/plan\/01-architecture\.md$/,
  /^docs\/plan\/13-docs-launch-community\.md$/,
  /^docs\/plan\/15-risks-spikes-decisions\.md$/,
];

export function isAllowedLeftover(path: string): boolean {
  return LEFTOVER_ALLOWLIST.some((pattern) => pattern.test(path));
}

/** Remaining case-insensitive matches of the old slug, for the report. */
export function findLeftovers(path: string, source: string, slug: string): Leftover[] {
  const escaped = slug.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i');
  const found: Leftover[] = [];
  source.split(/\r?\n/).forEach((line, index) => {
    if (pattern.test(line)) {
      found.push({ file: path, line: index + 1, text: line.trim().slice(0, 120) });
    }
  });
  return found;
}

/**
 * Add the outgoing names to `BRAND.legacy`, so the config loader keeps accepting them.
 *
 * `13` §3.A.6: the loader honours a previous env prefix and config filename with a deprecation
 * warning until 1.1. Without this step a rename silently breaks every existing host's `.env` — the
 * single most user-hostile thing a rename can do, and the easiest to forget, because nothing in
 * the renamed tree refers to the old name any more.
 */
export function addLegacyBrand(source: string, from: CurrentBrand): string {
  const prefixes = /legacy:\s*\{\s*envPrefixes:\s*\[([^\]]*)\]/;
  const files = /configFileNames:\s*\[([^\]]*)\]/;

  let out = source;
  const prefixMatch = prefixes.exec(out);
  if (prefixMatch !== null && !prefixMatch[1]?.includes(`'${from.envPrefix}'`)) {
    const existing = (prefixMatch[1] ?? '').trim();
    const list = existing === '' ? `'${from.envPrefix}'` : `'${from.envPrefix}', ${existing}`;
    out = out.replace(prefixes, (whole) => whole.replace(/\[[^\]]*\]/, `[${list}]`));
  }

  const fileMatch = files.exec(out);
  if (fileMatch !== null && !fileMatch[1]?.includes(`'${from.configFileName}'`)) {
    const existing = (fileMatch[1] ?? '').trim();
    const list =
      existing === '' ? `'${from.configFileName}'` : `'${from.configFileName}', ${existing}`;
    out = out.replace(files, (whole) => whole.replace(/\[[^\]]*\]/, `[${list}]`));
  }

  return out;
}

/** Add the outgoing names to `deploy/names.json`'s `legacy` block. */
export function addLegacyNames(source: string, from: CurrentBrand, repo: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(source) as Record<string, unknown>;
  } catch {
    return source;
  }
  const legacy = parsed['legacy'];
  if (typeof legacy !== 'object' || legacy === null) return source;

  const block = legacy as Record<string, unknown>;
  const push = (key: string, value: string): void => {
    const list = block[key];
    if (!Array.isArray(list)) return;
    if (!list.includes(value)) block[key] = [value, ...list];
  };
  push('names', from.slug);
  push('scopes', from.scope);
  push('repos', repo);
  push('images', `ghcr.io/${repo.split('/')[0] ?? ''}/${from.slug}`);
  push('images', `ghcr.io/${repo.split('/')[0] ?? ''}/${from.slug}-ha`);

  return `${JSON.stringify(parsed, null, 2)}\n`;
}
