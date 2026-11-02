/**
 * Brand guard: fail the build if the product name is hard-coded anywhere but `BRAND`.
 *
 * `docs/plan/13-docs-launch-community.md` §3.A.6 is the specification. The point is not tidiness —
 * it is that a rename must stay a one-command operation, because the name has already changed twice
 * (`docs/adr/ADR-024-product-name.md`). Every literal that escapes `BRAND` is a surface the codemod
 * cannot see.
 *
 * This walks the TypeScript AST rather than grepping, so it looks only at string and template
 * literals and can therefore exempt module specifiers (the npm scope legitimately contains the
 * name) without exempting whole files.
 *
 * Usage: `pnpm brand:check` (part of `pnpm verify`), or `--json` for machine-readable output.
 */
import { globSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { argv, exit, stdout } from 'node:process';
import ts from 'typescript';
import { BRAND } from '../../packages/shared/src/brand.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

/** Paths the guard does not read at all. */
const EXCLUDED_FILES = [
  /^packages\/shared\/src\/brand\.ts$/,
  /^apps\/docs\/src\/content\//,
  /\/__fixtures__\//,
  /\/__snapshots__\//,
  /\.snap$/,
  /^packages\/api-client\/src\/generated\//,
  /\/dist\//,
  /\/node_modules\//,
];

const SOURCE_GLOBS = ['packages/**/*.ts', 'packages/**/*.tsx', 'apps/**/*.ts', 'apps/**/*.tsx'];

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

/** True when this literal is a module specifier, where the npm scope legitimately appears. */
function isModuleSpecifier(node: ts.Node): boolean {
  const parent: ts.Node | undefined = node.parent;
  if (parent === undefined) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
    return parent.moduleSpecifier === node;
  }
  if (ts.isExternalModuleReference(parent) || ts.isImportTypeNode(parent)) return true;
  if (ts.isCallExpression(parent)) {
    // `import('@scope/pkg')` and `require('@scope/pkg')`
    const callee = parent.expression;
    const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
    const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
    return (isImport || isRequire) && parent.arguments[0] === node;
  }
  return false;
}

/** Literal nodes whose text the guard inspects. */
function literalText(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    return node.text;
  }
  return undefined;
}

export function findInSource(relPath: string, source: string, needle: string): Finding[] {
  const sf = ts.createSourceFile(relPath, source, ts.ScriptTarget.ESNext, true);
  const lowered = needle.toLowerCase();
  const found: Finding[] = [];

  const visit = (node: ts.Node): void => {
    const text = literalText(node);
    if (text?.toLowerCase().includes(lowered) === true && !isModuleSpecifier(node)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push({
        file: relPath,
        line: line + 1,
        column: character + 1,
        text: text.length > 120 ? `${text.slice(0, 117)}…` : text,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

async function main(): Promise<void> {
  const asJson = argv.includes('--json');
  const files = SOURCE_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: ROOT }))
    .map((f) => f.split('\\').join('/'))
    .filter((f) => !EXCLUDED_FILES.some((re) => re.test(f)))
    .sort();

  const findings = files.flatMap((f) =>
    findInSource(f, readFileSync(`${ROOT}/${f}`, 'utf8'), BRAND.codename),
  );

  if (asJson) {
    stdout.write(
      `${JSON.stringify({ codename: BRAND.codename, scanned: files.length, findings }, null, 2)}\n`,
    );
  } else if (findings.length === 0) {
    stdout.write(
      `brand: clean — scanned ${files.length} files for the literal "${BRAND.codename}".\n`,
    );
  } else {
    stdout.write(
      `brand: ${findings.length} hard-coded brand literal(s) found. ` +
        `Import BRAND from '@comvivo/shared' instead, so a rename stays one command.\n\n`,
    );
    for (const f of findings) {
      stdout.write(`  ${f.file}:${f.line}:${f.column}  "${f.text}"\n`);
    }
    stdout.write(`\nGuard specified in docs/plan/13-docs-launch-community.md §3.A.6.\n`);
  }
  exit(findings.length === 0 ? 0 : 1);
}

if (relative(ROOT, argv[1] ?? '').replace(/\\/g, '/') === 'scripts/brand/check.ts') {
  await main();
}
