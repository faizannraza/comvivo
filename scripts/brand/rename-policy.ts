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
  // Changeset entries are a record of a release. `README.md` is not one — it explains how to
  // write a changeset and names the packages, so it must follow the rename.
  /^\.changeset\/(?!README\.md$)[^/]+\.md$/,
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

/**
 * Whether a file is binary, decided by **content** rather than by extension.
 *
 * An extension allowlist was the first attempt and it had the failure mode this project keeps
 * finding: `NOTICE` has no extension, so it was classified as binary, skipped by the rewrite —
 * **and skipped by the leftover report**, which used the same filter. The report then said "no
 * leftovers" about a file it had never looked at.
 *
 * A NUL byte in the first few kilobytes is the standard heuristic and the one `git` itself uses.
 * It cannot miss a text file, which is the direction that matters here: a false "binary" is a
 * silent gap, while a false "text" would at worst rewrite nothing in a file with no matches.
 */
export function isBinary(sample: Buffer | Uint8Array): boolean {
  const limit = Math.min(sample.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (sample[i] === 0) return true;
  }
  return false;
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

/**
 * Rewrite only the leading `# ` heading of a HISTORY file.
 *
 * HISTORY files are exempt from the rewrite because their **bodies** record what things used to be
 * called — striking that out would destroy the record. Their titles are not records: `STATUS.md`
 * opened with "STATUS — Village build tracker" for two days after the product stopped being called
 * Village, because the exemption was applied to the whole file. Found by the M0 independent review.
 *
 * Only the first line, and only if it is an ATX heading, so a changeset entry or an ADR whose first
 * line is prose is left completely alone.
 */
export function rewriteHistoryTitle(source: string, from: CurrentBrand, to: TargetBrand): string {
  const newline = source.indexOf('\n');
  const first = newline === -1 ? source : source.slice(0, newline);
  if (!/^#{1,6} /.test(first)) return source;
  const rewritten = rewriteContent(first, from, to);
  if (rewritten === first) return source;
  return newline === -1 ? rewritten : rewritten + source.slice(newline);
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
/** Vale's accepted-words list, wherever the vocabulary directory happens to be named. */
const VOCABULARY = /(^|\/)\.vale\/styles\/config\/vocabularies\/[^/]+\/accept\.txt$/;

export const LEFTOVER_ALLOWLIST: readonly RegExp[] = [
  ...HISTORY,
  ...FIXTURES,
  // `BRAND.legacy` and `names.json.legacy` keep the previous names on purpose, so a host who
  // installed the old build is not stranded (`13` §3.A.6, legacy compatibility).
  /^packages\/shared\/src\/brand\.ts$/,
  /^deploy\/names\.json$/,
  // Vale's vocabulary keeps the outgoing names on purpose too (`addLegacyVocabulary`), because the
  // history this repository deliberately does not rewrite goes on using them.
  VOCABULARY,
  // The rename tooling itself: these files describe the mechanism and name both sides of it.
  /^scripts\/brand\//,
  /^\.github\/workflows\/rename-drill\.yml$/,
  // The plan records that the project was renamed, in the amendment that did it.
  /^docs\/plan\/01-architecture\.md$/,
  /^docs\/plan\/13-docs-launch-community\.md$/,
  /^docs\/plan\/15-risks-and-open-questions\.md$/,
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

export function isVocabulary(path: string): boolean {
  return VOCABULARY.test(path);
}

/**
 * Keep the **outgoing** product name in Vale's accepted-words list.
 *
 * HISTORY files are deliberately not rewritten — an ADR that records the rename has to keep saying
 * what the product used to be called. Vale's vocabulary, though, *is* rewritten, so after a rename
 * the vocabulary accepts only the new name and every one of those historical mentions becomes a
 * spelling error. The weekly drill failed on exactly that: `docs/adr/README.md:32` — "Did you
 * really mean 'Comvivo'?" — one line, from a 147-file prose run, in a repository the rename had
 * otherwise got completely right.
 *
 * Same shape as `addLegacyBrand` and `addLegacyNames`: run **after** the rewrite, so the names
 * added are the old ones. An accepted word is also the one kind of entry that is safe to keep
 * forever: it widens what prose may say, never what it must.
 */
export function addLegacyVocabulary(source: string, from: CurrentBrand): string {
  const present = (word: string): boolean =>
    source.split(/\r?\n/).some((line) => line.trim() === word);
  const missing = [from.display, from.slug].filter((word) => !present(word));
  if (missing.length === 0) return source;
  const body = source.replace(/\n*$/, '\n');
  return `${body}
# Previous product names, added by \`pnpm brand:rename\`. History — ADRs, STATUS, changelogs,
# changeset entries — is deliberately never rewritten, so the old name stays in this
# repository's prose permanently and the spell checker has to keep accepting it.
${missing.join('\n')}
`;
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
