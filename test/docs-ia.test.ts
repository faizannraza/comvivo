/**
 * The documentation site matches the information architecture in `13` §3.C.3.
 *
 * This test exists because the production build cannot show it. Every page is `draft: true`, and
 * Starlight excludes drafts from a production build — so `pnpm --filter docs build` reports "2
 * pages built" whether there are 104 draft pages or none. A green build is therefore no evidence
 * that the IA exists, which is exactly the shape of failure this project keeps finding: a check
 * that reports success while verifying nothing.
 *
 * Reading the page list out of `13` rather than from a fixture is the point. If somebody adds a
 * page to the plan, this fails until the page exists; if somebody deletes a page from the site,
 * this fails until the plan agrees. The two cannot drift.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const ROOT = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const DOCS = `${ROOT}/apps/docs/src/content/docs`;

interface Page {
  readonly path: string;
  readonly title: string;
}

/** Parse the `13` §3.C.3 tables. The plan is the source of truth, so it is read, not copied. */
function informationArchitecture(): Page[] {
  const spec = readFileSync(`${ROOT}/docs/plan/13-docs-launch-community.md`, 'utf8');
  const start = spec.indexOf('#### 3.C.3');
  const end = spec.indexOf('#### 3.C.4');
  expect(start, 'could not find `13` §3.C.3').toBeGreaterThan(-1);
  expect(end, 'could not find `13` §3.C.4').toBeGreaterThan(start);

  const pages: Page[] = [];
  for (const line of spec.slice(start, end).split('\n')) {
    const row = /^\|\s*`?(\/[^`|]*)`?\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (row === null) continue;
    const [, path = '', title = ''] = row;
    if (path.trim() === '/Path') continue;
    pages.push({ path: path.trim(), title: title.trim() });
  }
  return pages;
}

/** `/start/quickstart/` → `start/quickstart.md`; `/` → `index.mdx`. */
function fileFor(path: string): string {
  if (path === '/') return `${DOCS}/index.mdx`;
  return `${DOCS}/${path.replace(/^\/|\/$/g, '')}.md`;
}

const pages = informationArchitecture();

describe('the information architecture', () => {
  it('has the page count `13` §3.C.3 declares', () => {
    // A guard against the parser silently matching nothing — the failure mode that would make
    // every assertion below vacuous.
    expect(pages.length).toBeGreaterThan(100);
  });

  it('has no legacy codename in a page path', () => {
    // Content was already checked; **paths** were not, and two shipped with the old codename —
    // `/start/what-is-village/` and `/members/talking-to-village/` — straight out of the plan's own
    // IA table. A page path is a URL somebody bookmarks, so it is the most expensive place for a
    // rename to be missed and the quietest.
    for (const { path } of pages) {
      expect(/village/i.test(path), `${path} carries the old codename`).toBe(false);
    }
  });

  it('has no duplicate paths', () => {
    const paths = pages.map((page) => page.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it.each(pages.map((page) => [page.path, page.title] as const))(
    'has a page for %s',
    (path, _title) => {
      expect(existsSync(fileFor(path)), `missing: ${fileFor(path).replace(ROOT, '')}`).toBe(true);
    },
  );
});

describe('the docs site stays out of the code graph', () => {
  // `docs-site-imports-nothing-internal` in `.dependency-cruiser.cjs` covers the TypeScript and
  // JavaScript files. This covers what dependency-cruiser does not parse — `.mdx` and `.astro` —
  // where an import statement is just as real.
  //
  // Worth knowing: a first attempt excluded all of `apps/docs` from the cruise to silence the
  // devDependency errors its build config legitimately produces, and that silently disabled the
  // depcruise rule. `test/boundaries/fixtures.int.test.ts` caught it, because the rule has a
  // planted fixture. The exclusion is now narrowed to the three build-machinery files.
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', 'apps/docs'],
    { cwd: ROOT, encoding: 'utf8' },
  )
    .split('\0')
    .filter((path) => path !== '' && /\.(ts|tsx|mjs|js|astro|mdx)$/.test(path))
    // `--cached` lists what the index holds, which can include a file deleted but not yet staged.
    .filter((path) => existsSync(`${ROOT}/${path}`));

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(2);
  });

  it('imports no @comvivo package', () => {
    for (const file of files) {
      const source = readFileSync(`${ROOT}/${file}`, 'utf8');
      expect(
        /@comvivo\//.test(source),
        `${file} imports a @comvivo package; the docs site consumes this repository's prose, not its code`,
      ).toBe(false);
    }
  });
});

describe('every page', () => {
  const files = pages.map((page) => ({ ...page, file: fileFor(page.path) }));

  it('has frontmatter with a title and a description', () => {
    for (const { path, file } of files) {
      const source = readFileSync(file, 'utf8');
      const match = /^---\n([\s\S]*?)\n---/.exec(source);
      expect(match, `${path} has no frontmatter`).not.toBeNull();
      const frontmatter = parseYaml(match?.[1] ?? '') as Record<string, unknown>;
      expect(typeof frontmatter['title'], `${path} has no title`).toBe('string');
      expect(typeof frontmatter['description'], `${path} has no description`).toBe('string');
      // "A 1–2 line description" — long enough to say what the page is for, short enough to be a
      // meta description rather than the page itself.
      const description = String(frontmatter['description']);
      expect(description.length, `${path}: description too short`).toBeGreaterThan(20);
      expect(description.length, `${path}: description too long`).toBeLessThanOrEqual(300);
    }
  });

  it('is a draft, except the splash', () => {
    for (const { path, file } of files) {
      const frontmatter = parseYaml(
        /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'))?.[1] ?? '',
      ) as Record<string, unknown>;
      if (path === '/') {
        expect(frontmatter['draft'], 'the splash must not be a draft').not.toBe(true);
      } else {
        // Every other page is unwritten. A reader arriving from a search engine must not be
        // handed instructions that do not work yet.
        expect(frontmatter['draft'], `${path} should be draft: true`).toBe(true);
      }
    }
  });

  it('carries no stale codename', () => {
    for (const { path, file } of files) {
      const source = readFileSync(file, 'utf8');
      expect(/\bvillage\b/i.test(source), `${path} mentions the old codename`).toBe(false);
    }
  });

  it('says plainly that it is a placeholder', () => {
    for (const { path, file } of files) {
      if (path === '/') continue;
      expect(readFileSync(file, 'utf8'), path).toContain('Not written yet');
    }
  });
});
