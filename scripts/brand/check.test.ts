/**
 * The brand guard has to bite. These tests plant violations and assert each one is caught, and
 * plant the legitimate exceptions and assert each one is allowed. Without them the guard could
 * silently stop working and a rename would quietly stop being a one-command operation.
 *
 * The planted-violation fixtures the M0 exit gate asks for are these cases
 * (`docs/plan/14-milestones.md` M0-T5, and the gate's "guards bite" line).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BRAND } from '../../packages/shared/src/brand.js';
import { findInSource, scan } from './check.js';

const NAME = BRAND.codename;

describe('brand guard', () => {
  it('catches a hard-coded name in a plain string', () => {
    const found = findInSource('x.ts', `export const n = '${NAME}';`, NAME);
    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe(NAME);
  });

  it('catches it inside a longer string, case-insensitively', () => {
    const upper = NAME[0]?.toUpperCase() + NAME.slice(1);
    const found = findInSource('x.ts', `const msg = 'Welcome to ${upper}!';`, NAME);
    expect(found).toHaveLength(1);
  });

  it('catches it in every part of a template literal', () => {
    // A template literal is three node kinds — head, middle and tail — and the guard has to look
    // at all three, or a name in the middle of an interpolated string would slip through.
    const source = `const a = \`pre ${NAME} \${x} mid ${NAME} post\`;`;
    const found = findInSource('x.ts', source, NAME);
    expect(found.length).toBeGreaterThanOrEqual(2);
  });

  it('reports a usable location', () => {
    const found = findInSource('pkg/y.ts', `\n\nconst n = '${NAME}';\n`, NAME);
    expect(found[0]).toMatchObject({ file: 'pkg/y.ts', line: 3 });
    expect(found[0]?.column).toBeGreaterThan(0);
  });

  it('allows the npm scope in a static import specifier', () => {
    expect(findInSource('x.ts', `import { a } from '${BRAND.npmScope}/core';`, NAME)).toEqual([]);
  });

  it('allows it in an export-from specifier', () => {
    expect(findInSource('x.ts', `export { a } from '${BRAND.npmScope}/shared';`, NAME)).toEqual([]);
  });

  it('allows it in a dynamic import and in require', () => {
    expect(findInSource('x.ts', `await import('${BRAND.npmScope}/evals');`, NAME)).toEqual([]);
    expect(findInSource('x.ts', `const m = require('${BRAND.npmScope}/evals');`, NAME)).toEqual([]);
  });

  it('still catches the scope when it is used as data rather than imported', () => {
    // This is the case that matters: a package name assembled into a message or a manifest is a
    // surface the codemod cannot see.
    const found = findInSource('x.ts', `const pkg = '${BRAND.npmScope}/core';`, NAME);
    expect(found).toHaveLength(1);
  });

  it('ignores identifiers, comments and type names that merely contain the word', () => {
    const src = [
      `// ${NAME} is fine in a comment`,
      `/** ${NAME} is fine in a docblock */`,
      `interface ${NAME}Config { a: string }`,
      `const ${NAME}Thing = 1;`,
      `export type { ${NAME}Config };`,
    ].join('\n');
    expect(findInSource('x.ts', src, NAME)).toEqual([]);
  });

  it('finds nothing in a clean file', () => {
    // This string IS the source under test, so the placeholder must stay literal.
    const clean = 'export const a = 1;\nconst b = `${a}`;\n';
    expect(findInSource('x.ts', clean, NAME)).toEqual([]);
  });
});

describe('the scan over a real tree (M0-T12 AC)', () => {
  // The criterion is "fails on a planted codename literal under `packages/**` or `apps/**`", and
  // it had been verified once by hand at the exit gate: every test above exercises `findInSource`,
  // and nothing ran the globbing, the exclusion list or the file reading. Those are exactly where
  // a guard goes quietly blind — a glob that stops matching reports a clean tree, which looks
  // identical to a clean tree. Found by the M0 independent review.
  //
  // A synthetic tree, and a codename that is **not** the real one, so the planted literal cannot
  // be mistaken for a real violation by `brand:check` itself or by any secret scanner.
  const CODENAME = 'oldname';
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tree(files: Readonly<Record<string, string>>): string {
    const root = mkdtempSync(join(tmpdir(), 'brand-scan-'));
    dirs.push(root);
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    return root;
  }

  it('finds a planted literal under packages/ and under apps/', () => {
    const root = tree({
      'packages/core/src/a.ts': `export const name = '${CODENAME}';\n`,
      'apps/server/src/b.tsx': `export const other = \`${CODENAME}-server\`;\n`,
    });
    const { files, findings } = scan(root, CODENAME);
    expect(files).toEqual(['apps/server/src/b.tsx', 'packages/core/src/a.ts']);
    expect(findings.map((finding) => finding.file).toSorted()).toEqual([
      'apps/server/src/b.tsx',
      'packages/core/src/a.ts',
    ]);
    // The reported position is usable: a host reads `file:line:column` and opens it.
    expect(findings.every((finding) => finding.line > 0 && finding.column > 0)).toBe(true);
  });

  it('reports a clean tree as clean, and really did read the files', () => {
    const root = tree({
      'packages/core/src/a.ts': "export const name = 'comvivo';\n",
      'apps/server/src/b.ts': 'export const x = 1;\n',
    });
    const { files, findings } = scan(root, CODENAME);
    expect(findings).toEqual([]);
    // Non-vacuity: "no findings" over zero files is not evidence of anything.
    expect(files).toHaveLength(2);
  });

  it('honours every exclusion, so none of them silently matches everything', () => {
    // Each of these carries the planted literal and must be skipped for its own reason. A broken
    // exclusion regex would show up as a finding here rather than as a quietly narrowed scan.
    const root = tree({
      'packages/core/src/kept.ts': `export const a = '${CODENAME}';\n`,
      'packages/core/src/__snapshots__/x.ts': `export const b = '${CODENAME}';\n`,
      'packages/core/src/x.snap': `export const c = '${CODENAME}';\n`,
      'packages/api-client/src/generated/x.ts': `export const d = '${CODENAME}';\n`,
      'packages/core/dist/x.ts': `export const e = '${CODENAME}';\n`,
      'packages/core/node_modules/dep/x.ts': `export const f = '${CODENAME}';\n`,
    });
    const { findings } = scan(root, CODENAME);
    expect(findings.map((finding) => finding.file)).toEqual(['packages/core/src/kept.ts']);
  });

  it('scans nothing outside packages/ and apps/', () => {
    // The documented boundary (`13` §3.A.6), asserted rather than assumed: `scripts/`, `test/` and
    // Markdown are **not** covered, which is why `CLAUDE.md`'s stale references survived until the
    // M1 review read them by hand.
    const root = tree({
      'scripts/x.ts': `export const a = '${CODENAME}';\n`,
      'test/y.ts': `export const b = '${CODENAME}';\n`,
      'docs/z.md': `the ${CODENAME} docs\n`,
    });
    const { files, findings } = scan(root, CODENAME);
    expect(files).toEqual([]);
    expect(findings).toEqual([]);
  });

  it('leaves a module specifier alone, which is the one legitimate use', () => {
    const root = tree({
      'packages/core/src/a.ts': `import { x } from '@${CODENAME}/shared';\nexport const y = x;\n`,
    });
    expect(scan(root, CODENAME).findings).toEqual([]);
  });
});
