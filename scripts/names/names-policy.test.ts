import { describe, expect, it } from 'vitest';
import type { Brand } from '../../packages/shared/src/brand.js';
import { BRAND } from '../../packages/shared/src/brand.js';
import {
  applyTo,
  checkPackageNames,
  crossCheckBrand,
  findStaleReferences,
  legacyTerms,
  type Names,
  namesSchema,
  replacements,
  report,
  stripComments,
} from './names-policy.js';

/** A valid manifest, used as the base for planted mismatches. */
const NAMES: Names = {
  productName: 'Comvivo',
  org: 'faizannraza',
  repo: 'faizannraza/comvivo',
  npm: { cli: 'comvivo', scope: '@comvivo', createPackage: 'create-comvivo' },
  images: {
    main: 'ghcr.io/faizannraza/comvivo',
    ha: 'ghcr.io/faizannraza/comvivo-ha',
    dockerHub: null,
  },
  ha: { repo: 'faizannraza/comvivo-home-assistant', slug: 'comvivo', betaSlug: 'comvivo_beta' },
  umbrel: {
    communityStoreRepo: 'faizannraza/comvivo-umbrel-store',
    storeId: 'comvivo',
    officialAppId: 'comvivo',
    port: 7777,
  },
  casaos: { storeRepo: 'faizannraza/comvivo-casaos-store', appId: 'io.github.faizannraza.comvivo' },
  unraid: { templateRepo: 'faizannraza/unraid-templates' },
  docsUrl: 'https://faizannraza.github.io/comvivo',
  releaseManifestUrl: 'https://faizannraza.github.io/comvivo/release-manifest.json',
  legacy: {
    names: ['village'],
    repos: ['faizannraza/village'],
    images: ['ghcr.io/faizannraza/village', 'ghcr.io/faizannraza/village-ha'],
    scopes: ['@village'],
  },
};

describe('the schema', () => {
  it('accepts the real manifest', () => {
    expect(namesSchema.safeParse(NAMES).success).toBe(true);
  });

  it('strips $comment at any depth, so the manifest can explain itself and stay strict', () => {
    const withComments = {
      ...NAMES,
      $comment: ['why this file exists'],
      npm: { ...NAMES.npm, $comment: 'the scope' },
    };
    const stripped = stripComments(withComments);
    expect(namesSchema.safeParse(stripped).success).toBe(true);
    expect(JSON.stringify(stripped)).not.toContain('$comment');
  });

  it('still rejects an unknown key, which is the point of stripping only $comment', () => {
    const parsed = namesSchema.safeParse(stripComments({ ...NAMES, npmm: {} }));
    expect(parsed.success).toBe(false);
  });

  it.each([
    ['a missing section', (n: Names) => ({ ...n, images: undefined })],
    ['an unscoped scope', (n: Names) => ({ ...n, npm: { ...n.npm, scope: 'comvivo' } })],
    ['a repo that is not owner/name', (n: Names) => ({ ...n, repo: 'comvivo' })],
    ['an empty product name', (n: Names) => ({ ...n, productName: '' })],
    ['a non-URL docsUrl', (n: Names) => ({ ...n, docsUrl: 'faizannraza.github.io' })],
    ['a zero port', (n: Names) => ({ ...n, umbrel: { ...n.umbrel, port: 0 } })],
  ])('rejects %s', (_label, mutate) => {
    expect(namesSchema.safeParse(mutate(NAMES)).success).toBe(false);
  });
});

describe('crossCheckBrand', () => {
  it('passes on the real manifest and the real BRAND', () => {
    // The check that matters: the committed manifest and the constant the product reads agree.
    expect(crossCheckBrand(NAMES, BRAND)).toEqual([]);
  });

  it.each([
    ['productName', (b: Brand) => ({ ...b, displayName: 'Something Else' })],
    ['npm.cli', (b: Brand) => ({ ...b, npmCliPackage: 'something-else' })],
    ['npm.scope', (b: Brand) => ({ ...b, npmScope: '@something' as const })],
    ['repo', (b: Brand) => ({ ...b, repo: { owner: 'someone', name: 'else' } })],
    ['images.main', (b: Brand) => ({ ...b, containerImage: 'ghcr.io/someone/else' })],
  ])('catches a planted mismatch in %s', (where, mutate) => {
    const problems = crossCheckBrand(NAMES, mutate(BRAND));
    expect(problems.map((problem) => problem.where)).toContain(where);
    expect(problems[0]?.fix).toContain('one decision stored twice');
  });

  it('catches a createPackage that is not create-<slug>', () => {
    const problems = crossCheckBrand(
      { ...NAMES, npm: { ...NAMES.npm, createPackage: 'create-something' } },
      BRAND,
    );
    expect(problems.map((problem) => problem.where)).toContain('npm.createPackage');
  });

  it('catches an HA image that is not the main image plus -ha', () => {
    const problems = crossCheckBrand(
      { ...NAMES, images: { ...NAMES.images, ha: 'ghcr.io/faizannraza/comvivo-homeassistant' } },
      BRAND,
    );
    expect(problems.map((problem) => problem.where)).toContain('images.ha');
  });
});

describe('checkPackageNames', () => {
  it('accepts the CLI name and anything in the scope', () => {
    expect(
      checkPackageNames(NAMES, ['comvivo', '@comvivo/server', '@comvivo/channels-telegram']),
    ).toEqual([]);
  });

  it('rejects a package outside the scope', () => {
    const problems = checkPackageNames(NAMES, ['@village/server', 'some-other-thing']);
    expect(problems).toHaveLength(2);
    expect(problems[0]?.fix).toContain('@comvivo/');
  });
});

describe('findStaleReferences', () => {
  it('finds a legacy image, repo, scope and bare name', () => {
    for (const term of legacyTerms(NAMES)) {
      const problems = findStaleReferences('deploy/compose.yaml', `image: ${term}`, NAMES);
      expect(problems.length, term).toBe(1);
      expect(problems[0]?.detail, term).toContain(term);
    }
  });

  it('reports the line number and how to fix it', () => {
    const source = ['# one', '# two', 'image: ghcr.io/faizannraza/village:1.0.0'].join('\n');
    const problems = findStaleReferences('deploy/compose.yaml', source, NAMES);
    expect(problems[0]?.where).toBe('deploy/compose.yaml:3');
    expect(problems[0]?.fix).toContain('pnpm names:apply');
    expect(problems[0]?.fix).toContain('ghcr.io/faizannraza/comvivo');
  });

  it('reports the longest match per line, not each nested one', () => {
    // `ghcr.io/faizannraza/village-ha` contains `village`. One finding, naming the useful one.
    const problems = findStaleReferences(
      'deploy/x.yaml',
      'image: ghcr.io/faizannraza/village-ha',
      NAMES,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.detail).toContain('village-ha');
  });

  it('does not match inside a longer word', () => {
    // The word boundary is what keeps a legacy term from being rewritten inside an unrelated
    // identifier. Without it, `names:apply` would edit third-party references.
    for (const line of [
      'const villager = 1;',
      'uses: ghcr.io/renovatebot/renovate@sha256:abc',
      'villages_total',
      'my-village-thing',
    ]) {
      expect(findStaleReferences('deploy/x.ts', line, NAMES), line).toEqual([]);
    }
  });

  it('finds nothing in a clean file', () => {
    expect(
      findStaleReferences('deploy/compose.yaml', 'image: ghcr.io/faizannraza/comvivo:1.0.0', NAMES),
    ).toEqual([]);
  });
});

describe('applyTo', () => {
  it('rewrites every legacy term to its current value', () => {
    const before = [
      'image: ghcr.io/faizannraza/village:1.0.0',
      'ha_image: ghcr.io/faizannraza/village-ha:1.0.0',
      'repo: faizannraza/village',
      'dep: "@village/server"',
      'cli: village',
    ].join('\n');
    const after = applyTo(before, NAMES);
    expect(after).toContain('ghcr.io/faizannraza/comvivo:1.0.0');
    expect(after).toContain('ghcr.io/faizannraza/comvivo-ha:1.0.0');
    expect(after).toContain('faizannraza/comvivo');
    expect(after).toContain('"@comvivo/server"');
    expect(after).toContain('cli: comvivo');
    expect(after).not.toContain('village');
  });

  it('is idempotent', () => {
    // The acceptance criterion. Idempotent by construction — a current name is not a legacy name —
    // and asserted, because "by construction" is how the dependency-cruiser config was wrong.
    const before = 'image: ghcr.io/faizannraza/village-ha\nrepo: faizannraza/village';
    const once = applyTo(before, NAMES);
    const twice = applyTo(once, NAMES);
    expect(twice).toBe(once);
    const thrice = applyTo(twice, NAMES);
    expect(thrice).toBe(once);
  });

  it('rewrites the longest term first, so a nested name is not half-rewritten', () => {
    // Applying `village` → `comvivo` before `ghcr.io/.../village-ha` would leave
    // `ghcr.io/faizannraza/comvivo-ha` by luck here, but `-ha` could just as easily have been a
    // different image. The ordering makes it deliberate rather than lucky.
    const pairs = replacements(NAMES);
    const lengths = pairs.map(([from]) => from.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  it('leaves a third-party reference alone', () => {
    const before = [
      'uses: ghcr.io/renovatebot/renovate@sha256:bf344aa3',
      'uses: actions/checkout@3d3c42e5',
      'const villager = true;',
    ].join('\n');
    expect(applyTo(before, NAMES)).toBe(before);
  });

  it('changes nothing in an already-current file', () => {
    const before = 'image: ghcr.io/faizannraza/comvivo:1.0.0\ndep: "@comvivo/server"';
    expect(applyTo(before, NAMES)).toBe(before);
  });
});

describe('report', () => {
  it('prints where, what and the fix', () => {
    const message = report('name problem(s)', [
      { where: 'deploy/compose.yaml:3', detail: 'uses "village"', fix: 'Run `pnpm names:apply`.' },
    ]);
    expect(message).toContain('deploy/compose.yaml:3');
    expect(message).toContain('uses "village"');
    expect(message).toContain('fix:');
  });

  it('is empty when there is nothing to report', () => {
    expect(report('name problem(s)', [])).toBe('');
  });
});
