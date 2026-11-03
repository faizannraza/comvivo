import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateChooserConfig, validateIssueForm } from './issue-forms.js';

const DIR = new URL('../../.github/ISSUE_TEMPLATE/', import.meta.url);

const valid = (body: string): string =>
  ['name: Something', 'description: A description.', 'body:', body].join('\n');

describe('the committed forms', () => {
  const files = readdirSync(DIR).filter((name) => name.endsWith('.yml'));

  it('has the five forms `13` §3.F.2 lists, plus the chooser config', () => {
    expect(files.toSorted()).toEqual([
      'bug.yml',
      'channel-request.yml',
      'config.yml',
      'docs.yml',
      'feature.yml',
      'install.yml',
    ]);
  });

  it.each(['bug.yml', 'install.yml', 'feature.yml', 'docs.yml', 'channel-request.yml'])(
    '%s is valid',
    (name) => {
      const problems = validateIssueForm(name, readFileSync(new URL(name, DIR), 'utf8'));
      expect(problems.map((problem) => problem.detail)).toEqual([]);
    },
  );

  it('config.yml is a valid chooser config with blank issues disabled', () => {
    const source = readFileSync(new URL('config.yml', DIR), 'utf8');
    expect(validateChooserConfig('config.yml', source)).toEqual([]);
    expect(source).toContain('blank_issues_enabled: false');
  });

  it('points at private vulnerability reporting from the chooser', () => {
    // The one link that matters most: somebody with a vulnerability should never reach a public
    // issue form.
    const source = readFileSync(new URL('config.yml', DIR), 'utf8');
    expect(source).toContain('/security/advisories/new');
  });

  it('warns about pasting real chat content on the bug form', () => {
    const source = readFileSync(new URL('bug.yml', DIR), 'utf8');
    expect(source).toContain('Never paste real chat content');
    // And makes it a required confirmation rather than only advice.
    expect(source).toContain('no real messages');
  });
});

describe('validateIssueForm', () => {
  it('accepts a minimal valid form', () => {
    expect(
      validateIssueForm('x.yml', valid('  - type: markdown\n    attributes:\n      value: hi')),
    ).toEqual([]);
  });

  it.each([
    ['no name', 'description: d\nbody:\n  - type: markdown\n    attributes:\n      value: v\n'],
    ['no description', 'name: n\nbody:\n  - type: markdown\n    attributes:\n      value: v\n'],
    ['no body', 'name: n\ndescription: d\n'],
    ['an empty body', 'name: n\ndescription: d\nbody: []\n'],
    ['a body that is not a list', 'name: n\ndescription: d\nbody: nope\n'],
  ])('rejects %s', (_label, source) => {
    expect(validateIssueForm('x.yml', source).length).toBeGreaterThan(0);
  });

  it('rejects an unknown top-level key, because GitHub ignores the whole form', () => {
    const problems = validateIssueForm(
      'x.yml',
      'name: n\ndescription: d\nlabls: [bug]\nbody:\n  - type: markdown\n    attributes:\n      value: v\n',
    );
    expect(problems[0]?.detail).toContain('labls');
    expect(problems[0]?.detail).toContain('ignores the whole form');
  });

  it.each([
    ['markdown with no value', '  - type: markdown\n    attributes: {}'],
    ['input with no label', '  - type: input\n    attributes: {}'],
    ['textarea with no label', '  - type: textarea\n    attributes: {}'],
    ['dropdown with no options', '  - type: dropdown\n    attributes:\n      label: x'],
    ['checkboxes with no options', '  - type: checkboxes\n    attributes:\n      label: x'],
    [
      'dropdown with empty options',
      '  - type: dropdown\n    attributes:\n      label: x\n      options: []',
    ],
  ])('rejects %s', (_label, body) => {
    expect(validateIssueForm('x.yml', valid(body)).length).toBeGreaterThan(0);
  });

  it('rejects an item with no type', () => {
    const problems = validateIssueForm('x.yml', valid('  - attributes:\n      label: x'));
    expect(problems[0]?.detail).toContain('no `type`');
  });

  it('rejects an unknown type and lists the allowed ones', () => {
    const problems = validateIssueForm('x.yml', valid('  - type: freetext\n    attributes: {}'));
    expect(problems[0]?.detail).toContain('unknown type');
    expect(problems[0]?.detail).toContain('checkboxes');
  });

  it('rejects an unknown attribute, which GitHub also silently drops', () => {
    const problems = validateIssueForm(
      'x.yml',
      valid('  - type: input\n    attributes:\n      label: x\n      requried: true'),
    );
    expect(problems[0]?.detail).toContain('unknown attribute `requried`');
  });

  it('rejects a duplicate id', () => {
    const problems = validateIssueForm(
      'x.yml',
      valid(
        '  - type: input\n    id: version\n    attributes:\n      label: a\n' +
          '  - type: input\n    id: version\n    attributes:\n      label: b',
      ),
    );
    expect(problems[0]?.detail).toContain('reuses the id `version`');
  });

  it('rejects an id with invalid characters', () => {
    const problems = validateIssueForm(
      'x.yml',
      valid('  - type: input\n    id: "my id!"\n    attributes:\n      label: a'),
    );
    expect(problems[0]?.detail).toContain('invalid id');
  });

  it('rejects validations on a markdown item, which cannot take them', () => {
    const problems = validateIssueForm(
      'x.yml',
      valid(
        '  - type: markdown\n    validations:\n      required: true\n    attributes:\n      value: v',
      ),
    );
    expect(problems.some((problem) => problem.detail.includes('cannot take'))).toBe(true);
  });

  it('allows validations on an input', () => {
    expect(
      validateIssueForm(
        'x.yml',
        valid(
          '  - type: input\n    attributes:\n      label: a\n    validations:\n      required: true',
        ),
      ),
    ).toEqual([]);
  });

  it('rejects a checkboxes option with no label', () => {
    const problems = validateIssueForm(
      'x.yml',
      valid(
        '  - type: checkboxes\n    attributes:\n      label: a\n      options:\n        - required: true',
      ),
    );
    expect(problems[0]?.detail).toContain('needs a `label`');
  });

  it('reports invalid YAML rather than throwing', () => {
    const problems = validateIssueForm('x.yml', 'name: [unclosed\n');
    expect(problems).toHaveLength(1);
    expect(problems[0]?.detail).toContain('not valid YAML');
  });

  it('reports every problem, not just the first', () => {
    const problems = validateIssueForm(
      'x.yml',
      'name: n\nbody:\n  - type: dropdown\n    attributes:\n      label: x\n',
    );
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe('validateChooserConfig', () => {
  it('accepts a valid config', () => {
    const source = [
      'blank_issues_enabled: false',
      'contact_links:',
      '  - name: Ask',
      '    url: https://example.com/q',
      '    about: Questions go here.',
    ].join('\n');
    expect(validateChooserConfig('config.yml', source)).toEqual([]);
  });

  it('requires blank_issues_enabled to be a boolean', () => {
    const problems = validateChooserConfig('config.yml', 'blank_issues_enabled: "false"\n');
    expect(problems[0]?.detail).toContain('must be true or false');
  });

  it('rejects an unknown key', () => {
    const problems = validateChooserConfig(
      'config.yml',
      'blank_issues_enabled: false\ncontact_link: []\n',
    );
    expect(problems[0]?.detail).toContain('contact_link');
  });

  it.each([
    ['no name', '  - url: https://x.test\n    about: a'],
    ['no url', '  - name: n\n    about: a'],
    ['no about', '  - name: n\n    url: https://x.test'],
  ])('rejects a contact link with %s', (_label, link) => {
    const source = `blank_issues_enabled: false\ncontact_links:\n${link}\n`;
    expect(validateChooserConfig('config.yml', source).length).toBeGreaterThan(0);
  });

  it('requires https on a contact link', () => {
    const source =
      'blank_issues_enabled: false\ncontact_links:\n  - name: n\n    url: http://x.test\n    about: a\n';
    expect(validateChooserConfig('config.yml', source)[0]?.detail).toContain('https');
  });
});
