import { describe, expect, it } from 'vitest';
import {
  findExoticResolutions,
  findExoticSpecifiers,
  type Problem,
  report,
} from './lockfile-policy.js';

const manifest = (deps: Record<string, string>, field = 'dependencies'): string =>
  JSON.stringify({ name: '@comvivo/thing', version: '0.0.0', [field]: deps }, null, 2);

describe('exotic dependency specifiers', () => {
  it('blocks a synthetic git+ dependency', () => {
    // The acceptance criterion for `sec.supply.policy`. A `git+` URL resolves to whatever the ref
    // holds at install time, which can differ between a maintainer's machine and CI, and which no
    // vulnerability scanner will ever see.
    const problems = findExoticSpecifiers(
      'packages/engine/package.json',
      manifest({ 'some-lib': 'git+https://github.com/someone/some-lib.git#main' }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]?.detail).toContain('dependencies.some-lib');
    expect(problems[0]?.detail).toContain('install time');
    expect(problems[0]?.fix).toContain('registry');
  });

  it.each([
    ['git+ssh', 'git+ssh://git@github.com/a/b.git'],
    ['bare git', 'git://github.com/a/b.git'],
    ['github shorthand', 'github:someone/some-lib'],
    ['gitlab shorthand', 'gitlab:someone/some-lib'],
    ['bitbucket shorthand', 'bitbucket:someone/some-lib'],
    ['https tarball', 'https://example.com/some-lib-1.0.0.tgz'],
    ['http tarball', 'http://example.com/some-lib-1.0.0.tgz'],
    ['file path', 'file:../some-lib'],
    ['link path', 'link:../some-lib'],
  ])('blocks a %s specifier', (_label, specifier) => {
    expect(
      findExoticSpecifiers('p/package.json', manifest({ 'some-lib': specifier })),
    ).toHaveLength(1);
  });

  it.each(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])(
    'checks %s',
    (field) => {
      const problems = findExoticSpecifiers(
        'p/package.json',
        manifest({ 'some-lib': 'github:someone/some-lib' }, field),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]?.detail).toContain(`${field}.some-lib`);
    },
  );

  it('allows the specifiers this monorepo is built on', () => {
    // The other half of the rule. A check that also refused `workspace:` would be unusable here,
    // and an unusable check gets removed rather than fixed.
    const problems = findExoticSpecifiers(
      'packages/engine/package.json',
      manifest({
        '@comvivo/shared': 'workspace:*',
        '@comvivo/core': 'workspace:^',
        zod: 'catalog:',
        pino: '^10.4.0',
        typescript: '6.0.3',
        'some-alias': 'npm:real-package@^2.0.0',
        'any-version': '*',
        'range-version': '>=1.2.3 <2',
      }),
    );
    expect(problems).toEqual([]);
  });

  it('reports every problem in a manifest, not just the first', () => {
    const problems = findExoticSpecifiers(
      'p/package.json',
      manifest({
        a: 'git+https://github.com/x/a.git',
        b: 'https://example.com/b.tgz',
        c: '^1.0.0',
        d: 'file:../d',
      }),
    );
    expect(problems).toHaveLength(3);
    expect(problems.map((p) => p.detail.split(' ')[0])).toEqual([
      'dependencies.a',
      'dependencies.b',
      'dependencies.d',
    ]);
  });

  it('says so clearly when a manifest does not parse', () => {
    // Silence here would mean the manifest was skipped — the one outcome that must not look like
    // a pass.
    const problems = findExoticSpecifiers('p/package.json', '{ not json');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.detail).toContain('not valid JSON');
    expect(problems[0]?.fix).toContain('nothing below was checked');
  });

  it('ignores a non-string specifier rather than crashing', () => {
    expect(findExoticSpecifiers('p/package.json', '{"dependencies":{"a":null}}')).toEqual([]);
  });

  it('finds nothing in a manifest with no dependency blocks', () => {
    expect(findExoticSpecifiers('p/package.json', '{"name":"x","version":"0.0.0"}')).toEqual([]);
  });
});

describe('exotic lockfile resolutions', () => {
  it('blocks a tarball resolution', () => {
    const lock = [
      'packages:',
      '  some-lib@1.0.0:',
      '    resolution: {tarball: https://example.com/some-lib-1.0.0.tgz}',
    ].join('\n');
    const problems = findExoticResolutions('pnpm-lock.yaml', lock);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.file).toBe('pnpm-lock.yaml:3');
    expect(problems[0]?.detail).toContain('a tarball resolution');
  });

  it('blocks a git resolution', () => {
    const lock = [
      'packages:',
      '  some-lib@1.0.0:',
      '    resolution: {commit: abc123, repo: https://github.com/x/y.git, type: git}',
    ].join('\n');
    expect(findExoticResolutions('pnpm-lock.yaml', lock)).toHaveLength(1);
  });

  it('explains that one here means a direct dependency asked for it', () => {
    // pnpm `blockExoticSubdeps: true` already refuses these transitively, so the message should
    // point at our own manifests rather than sending somebody hunting through the dependency tree.
    const lock = '    resolution: {tarball: https://example.com/x.tgz}';
    expect(findExoticResolutions('pnpm-lock.yaml', lock)[0]?.fix).toContain('blockExoticSubdeps');
  });

  it('leaves ordinary registry resolutions alone', () => {
    const lock = [
      'packages:',
      '  pino@10.4.0:',
      '    resolution: {integrity: sha512-AbCdEf0123456789+/aBcDeF9876543210abcdefABCDEF==}',
      '  zod@4.6.7:',
      '    resolution: {integrity: sha512-ZyXwVu9876543210+/aBcDeF9876543210abcdefABCDEF==}',
    ].join('\n');
    expect(findExoticResolutions('pnpm-lock.yaml', lock)).toEqual([]);
  });
});

describe('the report', () => {
  const problem: Problem = {
    file: 'packages/engine/package.json',
    detail: 'dependencies.some-lib = "git+https://…" — a git URL resolves at install time',
    fix: 'Publish it to the registry.',
  };

  it('prints the file, the detail, the fix and the reason', () => {
    const message = report([problem]);
    expect(message).toContain('packages/engine/package.json');
    expect(message).toContain('fix:');
    // The reason is what stops the next person re-adding it.
    expect(message).toContain('immutable');
    expect(message).toContain('08 §3.15');
  });

  it('is empty when there is nothing to say', () => {
    expect(report([])).toBe('');
  });
});
