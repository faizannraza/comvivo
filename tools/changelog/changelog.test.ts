import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the formatter is `.mjs` because Changesets loads it directly at run time,
// so it has no declaration file. The shapes are asserted below rather than by the compiler.
import * as changelog from './index.mjs';

const {
  getDependencyReleaseLine,
  getReleaseLine,
  groupEntries,
  headingFor,
  OTHER,
  parseSummary,
  renderSections,
  TYPE_ORDER,
  TYPES,
} = changelog as {
  getDependencyReleaseLine: (
    c: unknown,
    deps: { name: string; newVersion: string }[],
    o: unknown,
  ) => Promise<string>;
  getReleaseLine: (
    c: { summary: string; commit?: string },
    t: string,
    o?: { repo?: string },
  ) => Promise<string>;
  groupEntries: (e: { type: string; text: string }[]) => {
    type: string;
    heading: string;
    entries: { type: string; text: string }[];
  }[];
  headingFor: (t: string) => string;
  OTHER: { type: string; heading: string };
  parseSummary: (s: unknown) => { type: string; text: string };
  renderSections: (s: { heading: string; entries: { text: string }[] }[]) => string;
  TYPE_ORDER: string[];
  TYPES: { type: string; heading: string }[];
};

describe('parseSummary', () => {
  it.each([
    ['breaking: the config key moved', 'breaking', 'the config key moved'],
    ['security: patched uuid', 'security', 'patched uuid'],
    ['upgrade: run `comvivo migrate`', 'upgrade', 'run `comvivo migrate`'],
    ['feat: reminders can repeat', 'feat', 'reminders can repeat'],
    ['fix: the morning brief fired twice', 'fix', 'the morning brief fired twice'],
    ['perf: context builds in half the time', 'perf', 'context builds in half the time'],
    ['docs: added a Raspberry Pi guide', 'docs', 'added a Raspberry Pi guide'],
  ])('reads %s', (summary, type, text) => {
    expect(parseSummary(summary)).toEqual({ type, text });
  });

  it('tolerates spacing around the colon', () => {
    expect(parseSummary('  fix :  spacing  ')).toEqual({ type: 'fix', text: 'spacing' });
  });

  it('keeps an unrecognised prefix as part of the text', () => {
    // Swallowing the first word because it happened to end in a colon would mangle a release note,
    // and the author would not find out until a host read it.
    expect(parseSummary('note: this is not a type')).toEqual({
      type: OTHER.type,
      text: 'note: this is not a type',
    });
    expect(parseSummary('Telegram: replies are threaded now')).toEqual({
      type: OTHER.type,
      text: 'Telegram: replies are threaded now',
    });
  });

  it('handles a summary with no type at all', () => {
    expect(parseSummary('just a sentence')).toEqual({ type: OTHER.type, text: 'just a sentence' });
  });

  it('handles an empty or missing summary without throwing', () => {
    expect(parseSummary('')).toEqual({ type: OTHER.type, text: '' });
    expect(parseSummary(undefined)).toEqual({ type: OTHER.type, text: '' });
  });

  it('keeps the body of a multi-line summary', () => {
    const parsed = parseSummary('feat: reminders can repeat\n\nWeekly and monthly, per member.');
    expect(parsed.type).toBe('feat');
    expect(parsed.text).toContain('Weekly and monthly');
  });
});

describe('grouping', () => {
  it('orders sections so the costly news comes first', () => {
    // Somebody skimming a release note stops at the first section that does not concern them, so
    // breaking changes, security fixes and required upgrade steps have to be above the features.
    expect(TYPE_ORDER.slice(0, 3)).toEqual(['breaking', 'security', 'upgrade']);
  });

  it('groups entries into sections in that order, whatever order they arrive in', () => {
    const sections = groupEntries([
      { type: 'docs', text: 'd' },
      { type: 'breaking', text: 'b' },
      { type: 'fix', text: 'f' },
      { type: 'security', text: 's' },
      { type: 'feat', text: 'n' },
    ]);
    expect(sections.map((section) => section.type)).toEqual([
      'breaking',
      'security',
      'feat',
      'fix',
      'docs',
    ]);
  });

  it('drops empty sections rather than printing bare headings', () => {
    const sections = groupEntries([{ type: 'fix', text: 'one' }]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.heading).toBe('Fixed');
  });

  it('keeps several entries of one type together, in arrival order', () => {
    const sections = groupEntries([
      { type: 'fix', text: 'first' },
      { type: 'feat', text: 'new' },
      { type: 'fix', text: 'second' },
    ]);
    const fixes = sections.find((section) => section.type === 'fix');
    expect(fixes?.entries.map((entry) => entry.text)).toEqual(['first', 'second']);
  });

  it('puts an unknown type under Other rather than dropping it', () => {
    const sections = groupEntries([{ type: 'wat', text: 'something' }]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.heading).toBe('Other changes');
  });

  it('gives every declared type a heading', () => {
    for (const { type, heading } of TYPES) {
      expect(headingFor(type)).toBe(heading);
      expect(heading.length).toBeGreaterThan(2);
    }
  });

  it('renders sections as Markdown headings with bullets', () => {
    const markdown = renderSections(
      groupEntries([
        { type: 'breaking', text: 'the config key moved' },
        { type: 'fix', text: 'the brief fired twice' },
      ]),
    );
    expect(markdown).toContain('### Breaking changes');
    expect(markdown).toContain('- the config key moved');
    expect(markdown).toContain('### Fixed');
    expect(markdown.indexOf('### Breaking changes')).toBeLessThan(markdown.indexOf('### Fixed'));
  });
});

describe('getReleaseLine', () => {
  it('labels the line with the heading so grouping survives into CHANGELOG.md', async () => {
    const line = await getReleaseLine({ summary: 'fix: the brief fired twice' }, 'patch', {
      repo: 'faizannraza/comvivo',
    });
    expect(line).toContain('**Fixed:** the brief fired twice');
  });

  it('links the commit Changesets recorded', async () => {
    const line = await getReleaseLine(
      { summary: 'feat: reminders repeat', commit: 'abc1234def5678' },
      'minor',
      { repo: 'faizannraza/comvivo' },
    );
    expect(line).toContain('[`abc1234`]');
    expect(line).toContain('https://github.com/faizannraza/comvivo/commit/abc1234def5678');
  });

  it('still works with no repo and no commit, because it makes no network call', async () => {
    // `@changesets/changelog-github` resolves pull requests through the API and fails without a
    // token. A formatter that cannot run on a contributor's laptop gets replaced by hand-editing.
    const line = await getReleaseLine({ summary: 'fix: something' }, 'patch', {});
    expect(line).toContain('**Fixed:** something');
    expect(line).not.toContain('undefined');
  });

  it('shows a short commit without a link when the repo is unknown', async () => {
    const line = await getReleaseLine({ summary: 'fix: x', commit: 'abc1234def' }, 'patch', {});
    expect(line).toContain('(`abc1234`)');
  });

  it('adds no label for an untyped summary', async () => {
    const line = await getReleaseLine({ summary: 'just a sentence' }, 'patch', {});
    expect(line).toContain('- just a sentence');
    expect(line).not.toContain('**');
  });

  it('indents the body of a multi-line summary', async () => {
    const line = await getReleaseLine(
      { summary: 'feat: reminders repeat\n\nWeekly and monthly, per member.' },
      'minor',
      {},
    );
    expect(line).toContain('**New:** reminders repeat');
    expect(line).toContain('  Weekly and monthly, per member.');
  });

  it('puts the commit link at the end of the entry, not inside a sentence', async () => {
    // The link used to go on the first line, and a summary wrapped at 100 columns put it in the
    // middle of a sentence: "A `.env` line with the `=` ([`dc92996`](…)) missing had its whole
    // text echoed". Found the first time `changeset version` ever ran against a real changeset —
    // these tests called `getReleaseLine` directly with one-line summaries and never saw it.
    const line = await getReleaseLine(
      {
        summary:
          'security: a malformed line in your configuration file no longer\nprints the key it contains.',
        commit: 'abc1234def',
      },
      'patch',
      { repo: 'faizannraza/comvivo' },
    );
    expect(line.trimEnd().endsWith('/commit/abc1234def))')).toBe(true);
    expect(line).toContain('no longer\n  prints the key it contains.');
    // The first line must be clean, which is the actual regression.
    const firstLine = line.trim().split('\n')[0] ?? '';
    expect(firstLine).not.toContain('abc1234');
  });

  it('puts the link on the last non-empty line, not after trailing blank lines', async () => {
    const line = await getReleaseLine(
      { summary: 'fix: something\n\nmore detail\n\n', commit: 'abc1234def' },
      'patch',
      {},
    );
    expect(line.trimEnd().endsWith('more detail (`abc1234`)')).toBe(true);
  });
});

describe('getDependencyReleaseLine', () => {
  it('says nothing about internal workspace bumps', async () => {
    // Every `@comvivo/*` package except the SDKs is private and bundled into the server, so
    // "Updated dependencies: @comvivo/storage@0.0.1" is noise in the one document a host reads
    // before upgrading.
    const line = await getDependencyReleaseLine(
      [],
      [
        { name: '@comvivo/storage', newVersion: '0.1.0' },
        { name: '@comvivo/shared', newVersion: '0.1.0' },
      ],
      {},
    );
    expect(line).toBe('');
  });

  it('reports a real external dependency bump', async () => {
    const line = await getDependencyReleaseLine([], [{ name: 'pino', newVersion: '10.5.0' }], {});
    expect(line).toContain('pino@10.5.0');
  });

  it('reports only the external ones from a mixed list', async () => {
    const line = await getDependencyReleaseLine(
      [],
      [
        { name: '@comvivo/core', newVersion: '0.1.0' },
        { name: 'zod', newVersion: '4.7.0' },
      ],
      {},
    );
    expect(line).toContain('zod@4.7.0');
    expect(line).not.toContain('@comvivo/core');
  });
});

describe('the Changesets config points at this file', () => {
  /**
   * The defect this exists for: `.changeset/config.json` said
   * `"./tools/changelog/index.mjs"`, and Changesets resolves the `changelog` option **relative to
   * `.changeset/`** — so it looked for `.changeset/tools/changelog/index.mjs` and
   * `changeset version` died with `ERR_MODULE_NOT_FOUND`.
   *
   * It stayed invisible for all of M0 because the version path only runs when a changeset is
   * pending, and the first changeset in the repository's history was written at the M0 exit gate.
   * The formatter's 28 unit tests all imported this module **directly**, so they proved the
   * functions work and said nothing about whether Changesets could find them.
   */
  const ROOT = resolve(import.meta.dirname, '..', '..');

  const changelogOption = (): string => {
    const config = JSON.parse(readFileSync(`${ROOT}/.changeset/config.json`, 'utf8')) as {
      changelog: [string, unknown] | string;
    };
    return Array.isArray(config.changelog) ? config.changelog[0] : config.changelog;
  };

  it('resolves to a file that exists, from the directory Changesets resolves it from', () => {
    const option = changelogOption();
    expect(option.endsWith('.mjs'), `unexpected changelog option: ${option}`).toBe(true);
    expect(existsSync(resolve(ROOT, '.changeset', option))).toBe(true);
  });

  it('is this very file, so these tests are testing what Changesets will load', () => {
    expect(resolve(ROOT, '.changeset', changelogOption())).toBe(
      resolve(import.meta.dirname, 'index.mjs'),
    );
  });

  it('would not resolve from the repository root, which is the trap', () => {
    // Asserting the shape of the fix rather than only its effect: a future edit back to
    // `./tools/changelog/index.mjs` resolves fine from the root and fails where it counts.
    expect(changelogOption().startsWith('../')).toBe(true);
  });

  it('exports both hooks Changesets calls', async () => {
    const loaded = (await import(resolve(ROOT, '.changeset', changelogOption()))) as Record<
      string,
      unknown
    >;
    expect(typeof loaded['getReleaseLine']).toBe('function');
    expect(typeof loaded['getDependencyReleaseLine']).toBe('function');
  });
});
