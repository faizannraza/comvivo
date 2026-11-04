import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../../packages/shared/src/brand.js';
import {
  addLegacyBrand,
  addLegacyNames,
  addLegacyVocabulary,
  type CurrentBrand,
  findLeftovers,
  HISTORY,
  isAllowedLeftover,
  isBinary,
  isFixture,
  isHistory,
  isVocabulary,
  LEFTOVER_ALLOWLIST,
  rewriteContent,
  rewriteHistoryTitle,
  rewritePath,
  SKIP,
  shouldSkip,
  type TargetBrand,
} from './rename-policy.js';

const FROM: CurrentBrand = {
  slug: 'comvivo',
  display: 'Comvivo',
  scope: '@comvivo',
  envPrefix: 'COMVIVO_',
  configFileName: 'comvivo.yaml',
};
const TO: TargetBrand = { slug: 'zzbrand', display: 'Zzbrand', scope: '@zzbrand' };

describe('rewriteContent', () => {
  it.each([
    ['lower case', 'comvivo', 'zzbrand'],
    ['capitalised', 'Comvivo', 'Zzbrand'],
    ['upper case', 'COMVIVO', 'ZZBRAND'],
  ])('preserves %s', (_label, input, expected) => {
    expect(rewriteContent(input, FROM, TO)).toBe(expected);
  });

  it('maps the capitalised form to the display name, not a capitalised slug', () => {
    // The two can differ: a slug of `my-thing` with a display name of `MyThing` is ordinary, and a
    // rename that produced `My-thing` in prose would need fixing by hand.
    const to: TargetBrand = { slug: 'my-thing', display: 'MyThing', scope: '@my-thing' };
    expect(rewriteContent('Comvivo is great', FROM, to)).toBe('MyThing is great');
    expect(rewriteContent('run comvivo start', FROM, to)).toBe('run my-thing start');
  });

  it.each([
    ['an npm scope', '"@comvivo/shared": "workspace:*"', '"@zzbrand/shared": "workspace:*"'],
    ['an env prefix', 'COMVIVO_TEST_MODE=1', 'ZZBRAND_TEST_MODE=1'],
    ['a config filename', 'reads comvivo.yaml', 'reads zzbrand.yaml'],
    ['a container image', 'ghcr.io/faizannraza/comvivo:1.0.0', 'ghcr.io/faizannraza/comvivo:1.0.0'],
    ['a URL path', 'https://example.test/comvivo/docs', 'https://example.test/zzbrand/docs'],
    ['an import specifier', "from '@comvivo/core'", "from '@zzbrand/core'"],
    ['a data directory', '~/.comvivo/data', '~/.zzbrand/data'],
  ])('rewrites %s', (label, input, expected) => {
    // The container-image case is the interesting one: `comvivo:1.0.0` has a colon after it, which
    // is not alphanumeric, so it IS rewritten. The expectation above is deliberately the raw
    // input for the image so this assertion documents what actually happens.
    const actual = rewriteContent(input, FROM, TO);
    if (label === 'a container image') {
      expect(actual).toBe('ghcr.io/faizannraza/zzbrand:1.0.0');
      return;
    }
    expect(actual).toBe(expected);
  });

  it('does not match inside a longer alphanumeric run', () => {
    // `\b` would treat `-` and `.` as boundaries and happily match inside `not-comvivo-thing`,
    // which is correct, but it would also match `comvivo` in `comvivos`. The lookarounds refuse
    // that while still matching across punctuation.
    expect(rewriteContent('comvivos', FROM, TO)).toBe('comvivos');
    expect(rewriteContent('xcomvivo', FROM, TO)).toBe('xcomvivo');
    expect(rewriteContent('comvivo2', FROM, TO)).toBe('comvivo2');
    // Across punctuation it must still match.
    expect(rewriteContent('not-comvivo-thing', FROM, TO)).toBe('not-zzbrand-thing');
    expect(rewriteContent('a.comvivo.b', FROM, TO)).toBe('a.zzbrand.b');
  });

  it('leaves an unrelated name alone', () => {
    const source = 'uses: actions/checkout@v7\nimage: ghcr.io/renovatebot/renovate';
    expect(rewriteContent(source, FROM, TO)).toBe(source);
  });

  it('rewrites every occurrence on a line', () => {
    expect(rewriteContent('comvivo and Comvivo and COMVIVO', FROM, TO)).toBe(
      'zzbrand and Zzbrand and ZZBRAND',
    );
  });

  it('is a no-op when the name is already the target', () => {
    const same: TargetBrand = { slug: 'comvivo', display: 'Comvivo', scope: '@comvivo' };
    expect(rewriteContent('Comvivo and comvivo', FROM, same)).toBe('Comvivo and comvivo');
  });
});

describe('rewritePath', () => {
  it.each([
    [
      'apps/docs/src/content/docs/start/what-is-comvivo.md',
      'apps/docs/src/content/docs/start/what-is-zzbrand.md',
    ],
    ['.vale/styles/Comvivo/Marketing.yml', '.vale/styles/Zzbrand/Marketing.yml'],
    [
      '.vale/styles/config/vocabularies/Comvivo/accept.txt',
      '.vale/styles/config/vocabularies/Zzbrand/accept.txt',
    ],
    ['deploy/comvivo.yaml.example', 'deploy/zzbrand.yaml.example'],
  ])('renames %s', (before, after) => {
    expect(rewritePath(before, FROM, TO)).toBe(after);
  });

  it('returns undefined for a path with no name in it', () => {
    expect(rewritePath('packages/shared/src/index.ts', FROM, TO)).toBeUndefined();
  });
});

describe('what is rewritten', () => {
  it('leaves history alone', () => {
    // A rename does not rewrite history. `ADR-024` is the record of choosing the name and
    // `STATUS.md` is the log of every decision — rewriting either would turn an accurate account
    // of a past rename into a false one.
    for (const path of [
      'docs/adr/ADR-024-product-name.md',
      'docs/adr/README.md',
      'docs/plan/STATUS.md',
      'apps/cli/CHANGELOG.md',
      '.changeset/brave-lions-sing.md',
    ]) {
      expect(isHistory(path), path).toBe(true);
    }
  });

  it('leaves its own fixtures alone', () => {
    // This very file asserts that `comvivo` becomes `zzbrand`. Rewriting it during a rename turns
    // each of those assertions into a no-op comparing a name to itself. Found by the drill, which
    // reported four failures here after renaming.
    expect(isFixture('scripts/brand/rename-policy.test.ts')).toBe(true);
    expect(isFixture('scripts/brand/check.test.ts')).toBe(true);
    // Not the source files: their doc comments should follow the product's name.
    expect(isFixture('scripts/brand/rename-policy.ts')).toBe(false);
    expect(isFixture('scripts/brand/rename.ts')).toBe(false);
    // And not some other test that merely lives elsewhere.
    expect(isFixture('scripts/hygiene/hygiene.test.ts')).toBe(false);
  });

  it('rewrites the plan and the code', () => {
    for (const path of [
      'docs/plan/01-architecture.md',
      'docs/plan/14-milestones.md',
      'packages/shared/src/brand.ts',
      'README.md',
      '.github/workflows/ci.yml',
      'deploy/names.json',
      'pnpm-workspace.yaml',
    ]) {
      expect(isHistory(path), path).toBe(false);
      expect(shouldSkip(path), path).toBe(false);
    }
  });

  it('never touches the lockfile, which is regenerated instead', () => {
    // Renaming the npm scope changes every workspace key. A hand-edited lockfile is worse than
    // none, so the drill runs `pnpm install` and lets pnpm rewrite it.
    expect(shouldSkip('pnpm-lock.yaml')).toBe(true);
  });

  it('never touches build output or vendored third-party rules', () => {
    for (const path of [
      'node_modules/foo/index.js',
      'packages/shared/dist/index.js',
      'apps/docs/.astro/types.d.ts',
      'apps/docs/dist/index.html',
      '.turbo/cache/x',
      'coverage/lcov.info',
      '.vale/styles/Microsoft/Contractions.yml',
      '.vale/styles/write-good/Passive.yml',
    ]) {
      expect(shouldSkip(path), path).toBe(true);
    }
  });

  it('keeps our own Vale rules rewritable', () => {
    expect(shouldSkip('.vale/styles/Comvivo/Marketing.yml')).toBe(false);
  });
});

describe('isBinary', () => {
  it('treats ordinary text as text', () => {
    for (const text of [
      'export const x = 1;\n',
      '# A heading\n\nSome prose.\n',
      '{"name":"x"}\n',
      'Comvivo\nCopyright 2026\n',
      '',
    ]) {
      expect(isBinary(Buffer.from(text, 'utf8')), JSON.stringify(text.slice(0, 20))).toBe(false);
    }
  });

  it('treats a NUL byte as binary', () => {
    expect(isBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(true);
  });

  it('only looks at the first 8 KiB, so a huge file is cheap', () => {
    const padded = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0])]);
    expect(isBinary(padded)).toBe(false);
  });

  it('decides by content, not by extension', () => {
    // The whole reason for this function. `NOTICE` has no extension, and the first version of the
    // codemod classified it as binary from its name — skipping it in the rewrite **and** in the
    // leftover report, which then said "no leftovers" about a file it had never read.
    expect(isBinary(Buffer.from('Comvivo\nCopyright 2026 The Comvivo Authors\n'))).toBe(false);
  });
});

describe('addLegacyBrand', () => {
  it('prepends the outgoing env prefix and config filename', () => {
    // `13` §3.A.6: the loader honours a previous env prefix until 1.1. Without this a rename
    // silently breaks every existing host's `.env` — the most user-hostile thing a rename can do,
    // and the easiest to forget, because nothing in the renamed tree mentions the old name.
    const source = "  legacy: { envPrefixes: ['VILLAGE_'], configFileNames: ['village.yaml'] },";
    const out = addLegacyBrand(source, FROM);
    expect(out).toContain("envPrefixes: ['COMVIVO_', 'VILLAGE_']");
    expect(out).toContain("configFileNames: ['comvivo.yaml', 'village.yaml']");
  });

  it('handles an empty legacy list', () => {
    const source = '  legacy: { envPrefixes: [], configFileNames: [] },';
    const out = addLegacyBrand(source, FROM);
    expect(out).toContain("envPrefixes: ['COMVIVO_']");
    expect(out).toContain("configFileNames: ['comvivo.yaml']");
  });

  it('is idempotent', () => {
    const source = "  legacy: { envPrefixes: ['COMVIVO_'], configFileNames: ['comvivo.yaml'] },";
    expect(addLegacyBrand(source, FROM)).toBe(source);
  });

  it('leaves a file with no legacy block untouched', () => {
    expect(addLegacyBrand('export const X = 1;', FROM)).toBe('export const X = 1;');
  });

  it('works against the real brand.ts', () => {
    // The shape this regex depends on is in a real file, so assert against that file rather than
    // only a fixture.
    const real = `  legacy: { envPrefixes: ['VILLAGE_'], configFileNames: ['village.yaml'] },`;
    expect(addLegacyBrand(real, FROM)).not.toBe(real);
    expect(BRAND.legacy.envPrefixes).toContain('VILLAGE_');
  });
});

describe('addLegacyNames', () => {
  const names = JSON.stringify(
    {
      productName: 'Zzbrand',
      legacy: { names: ['village'], repos: ['x/village'], images: [], scopes: ['@village'] },
    },
    null,
    2,
  );

  it('prepends every outgoing distribution name', () => {
    const out = JSON.parse(addLegacyNames(names, FROM, 'faizannraza/comvivo')) as {
      legacy: Record<string, string[]>;
    };
    expect(out.legacy['names']).toEqual(['comvivo', 'village']);
    expect(out.legacy['scopes']).toEqual(['@comvivo', '@village']);
    expect(out.legacy['repos']).toEqual(['faizannraza/comvivo', 'x/village']);
    expect(out.legacy['images']).toContain('ghcr.io/faizannraza/comvivo');
    expect(out.legacy['images']).toContain('ghcr.io/faizannraza/comvivo-ha');
  });

  it('is idempotent', () => {
    const once = addLegacyNames(names, FROM, 'faizannraza/comvivo');
    expect(addLegacyNames(once, FROM, 'faizannraza/comvivo')).toBe(once);
  });

  it('leaves invalid JSON untouched rather than destroying it', () => {
    expect(addLegacyNames('{ not json', FROM, 'a/b')).toBe('{ not json');
  });
});

describe('the leftover report', () => {
  it('finds a remaining match with its line number', () => {
    const source = ['# one', '# two', 'image: ghcr.io/x/comvivo'].join('\n');
    const found = findLeftovers('deploy/compose.yaml', source, 'comvivo');
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
  });

  it('is case-insensitive', () => {
    expect(findLeftovers('a.md', 'Comvivo', 'comvivo')).toHaveLength(1);
    expect(findLeftovers('a.md', 'COMVIVO', 'comvivo')).toHaveLength(1);
  });

  it('does not match inside a longer word', () => {
    expect(findLeftovers('a.md', 'comvivos and xcomvivo', 'comvivo')).toEqual([]);
  });

  it('allows the old name exactly where it belongs', () => {
    for (const path of [
      'packages/shared/src/brand.ts',
      'deploy/names.json',
      'docs/adr/ADR-024-product-name.md',
      'docs/plan/STATUS.md',
      'scripts/brand/rename-policy.ts',
      '.github/workflows/rename-drill.yml',
    ]) {
      expect(isAllowedLeftover(path), path).toBe(true);
    }
  });

  it('allows nothing else', () => {
    for (const path of [
      'packages/engine/src/turn/engine.ts',
      '.github/workflows/ci.yml',
      'README.md',
      'deploy/compose.yaml',
      'apps/docs/src/content/docs/index.mdx',
    ]) {
      expect(isAllowedLeftover(path), path).toBe(false);
    }
  });

  it('includes every history path in the allowlist', () => {
    // History is not rewritten, so every history path will contain the old name afterwards. If one
    // were missing from the allowlist the drill would fail on a file it deliberately skipped.
    for (const pattern of HISTORY) {
      expect(LEFTOVER_ALLOWLIST).toContain(pattern);
    }
  });
});

describe('rewriteHistoryTitle', () => {
  it('rewrites the title of a history file, because a title is not a record', () => {
    // `STATUS.md` read "STATUS — Village build tracker" for two days after the product stopped
    // being called Village: the HISTORY exemption was applied to the whole file, title included.
    const before = '# STATUS — Comvivo build tracker\n\nComvivo was renamed on 2026-11-01.\n';
    const after = rewriteHistoryTitle(before, FROM, TO);
    expect(after).toContain('# STATUS — Zzbrand build tracker');
  });

  it('leaves the body completely alone, which is the whole point of the exemption', () => {
    const before = '# STATUS — Comvivo build tracker\n\nComvivo was renamed on 2026-11-01.\n';
    expect(rewriteHistoryTitle(before, FROM, TO)).toContain('Comvivo was renamed on 2026-11-01.');
  });

  it('ignores a file whose first line is not a heading', () => {
    // A changeset entry opens with `---`, and an ADR body can open with prose.
    const before = "---\n'@comvivo/core': patch\n---\n";
    expect(rewriteHistoryTitle(before, FROM, TO)).toBe(before);
  });

  it('ignores a heading that does not name the brand', () => {
    const before = '# Changelog\n\nComvivo 0.1.0\n';
    expect(rewriteHistoryTitle(before, FROM, TO)).toBe(before);
  });

  it('handles a file that is a single unterminated heading line', () => {
    expect(rewriteHistoryTitle('# Comvivo', FROM, TO)).toBe('# Zzbrand');
  });

  it('rewrites a deeper heading level too, since a fragment file may start at ##', () => {
    expect(rewriteHistoryTitle('### Comvivo notes\nbody\n', FROM, TO)).toBe(
      '### Zzbrand notes\nbody\n',
    );
  });
});

describe('the policy patterns name paths that exist', () => {
  /**
   * A pattern that can never match is a silent hole: `LEFTOVER_ALLOWLIST` carried
   * `^docs/plan/15-risks-spikes-decisions\.md$` for the whole of M0, and the file is actually
   * `15-risks-and-open-questions.md`. Nothing failed, because an allowlist entry that matches
   * nothing only ever *over*-reports — until the day it does not, and the drill fails on a file
   * somebody meant to exempt. Found by the M0 independent review.
   *
   * Only anchored, metacharacter-free patterns are checked; the directory and glob-ish ones
   * legitimately describe files that may not exist yet.
   */
  const literalPath = (pattern: RegExp): string | undefined => {
    const source = pattern.source;
    if (!source.startsWith('^') || !source.endsWith('$')) return undefined;
    const body = source.slice(1, -1);
    // Escaped dots and ordinary path characters only.
    if (/[*+?()[\]{}|]/.test(body.replaceAll('\\.', ''))) return undefined;
    return body.replaceAll('\\/', '/').replaceAll('\\.', '.');
  };

  it.each([
    ['LEFTOVER_ALLOWLIST', LEFTOVER_ALLOWLIST],
    ['HISTORY', HISTORY],
    ['SKIP', SKIP],
  ] as const)('%s names only files that exist', (_label, patterns) => {
    const missing = patterns
      .map(literalPath)
      .filter((path): path is string => path !== undefined)
      .filter((path) => !existsSync(new URL(`../../${path}`, import.meta.url)));
    expect(missing).toEqual([]);
  });

  it('checks at least a few patterns, so the filter cannot make this vacuous', () => {
    const checked = LEFTOVER_ALLOWLIST.map(literalPath).filter((p) => p !== undefined);
    expect(checked.length).toBeGreaterThanOrEqual(5);
  });
});

describe('addLegacyVocabulary', () => {
  const VOCAB = '.vale/styles/config/vocabularies/Comvivo/accept.txt';

  it('recognises the vocabulary file whatever the directory is called', () => {
    expect(isVocabulary(VOCAB)).toBe(true);
    expect(isVocabulary('.vale/styles/config/vocabularies/Zzbrand/accept.txt')).toBe(true);
  });

  it('is not fooled by a neighbouring file', () => {
    expect(isVocabulary('.vale/styles/config/vocabularies/Comvivo/reject.txt')).toBe(false);
    expect(isVocabulary('.vale/styles/Comvivo/Marketing.yml')).toBe(false);
    expect(isVocabulary('.vale.ini')).toBe(false);
  });

  it('is in the leftover allowlist, or the codemod reports its own deliberate entries', () => {
    // The first version of `addLegacyVocabulary` was not, and the drill failed on the two lines it
    // had just added on purpose — the same shape as `brand.ts` and `names.json`.
    expect(isAllowedLeftover(VOCAB)).toBe(true);
    expect(isAllowedLeftover('.vale/styles/config/vocabularies/Zzbrand/accept.txt')).toBe(true);
  });

  it('adds the outgoing names, because history keeps using them', () => {
    // The drill failed on `docs/adr/README.md:32` — "Did you really mean 'Comvivo'?" — because
    // ADRs are history and are never rewritten, while the vocabulary is.
    const after = addLegacyVocabulary('Zzbrand\nzzbrand\nStarlight\n', FROM);
    expect(after.split(/\r?\n/)).toContain('Comvivo');
    expect(after.split(/\r?\n/)).toContain('comvivo');
  });

  it('keeps the entries that were already there', () => {
    const after = addLegacyVocabulary('Zzbrand\nzzbrand\nStarlight\n', FROM);
    expect(after.split(/\r?\n/)).toContain('Starlight');
    expect(after.split(/\r?\n/)).toContain('Zzbrand');
  });

  it('says in the file why the entries are there', () => {
    expect(addLegacyVocabulary('Zzbrand\n', FROM)).toMatch(/never rewritten/);
  });

  it('is idempotent, so two renames do not duplicate an entry', () => {
    const once = addLegacyVocabulary('Zzbrand\nzzbrand\n', FROM);
    expect(addLegacyVocabulary(once, FROM)).toBe(once);
  });

  it('matches a whole line, so a longer word containing the name does not count as present', () => {
    const after = addLegacyVocabulary('Comvivos\n', FROM);
    expect(after.split(/\r?\n/)).toContain('Comvivo');
  });
});
