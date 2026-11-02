/**
 * The brand guard has to bite. These tests plant violations and assert each one is caught, and
 * plant the legitimate exceptions and assert each one is allowed. Without them the guard could
 * silently stop working and a rename would quietly stop being a one-command operation.
 *
 * The planted-violation fixtures the M0 exit gate asks for are these cases
 * (`docs/plan/14-milestones.md` M0-T5, and the gate's "guards bite" line).
 */
import { describe, expect, it } from 'vitest';
import { BRAND } from '../../packages/shared/src/brand.js';
import { findInSource } from './check.js';

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
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal placeholder
    const clean = 'export const a = 1;\nconst b = `${a}`;\n';
    expect(findInSource('x.ts', clean, NAME)).toEqual([]);
  });
});
