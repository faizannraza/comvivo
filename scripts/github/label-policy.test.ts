import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Label, parseLabels, planSync } from './label-policy.js';

const FILE = new URL('../../.github/labels.yml', import.meta.url);

describe('parseLabels', () => {
  const labels = parseLabels(readFileSync(FILE, 'utf8'));

  it('reads the committed label file', () => {
    expect(labels.length).toBeGreaterThan(40);
  });

  it('gives every label a description', () => {
    // A label with no description is a label people guess at, and two people guess differently.
    for (const label of labels) {
      expect(label.description.length, label.name).toBeGreaterThan(3);
    }
  });

  it('uses six-digit uppercase hex colours', () => {
    for (const label of labels) {
      expect(label.color, label.name).toMatch(/^[0-9A-F]{6}$/);
    }
  });

  it('has no duplicate names', () => {
    const names = labels.map((label) => label.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('covers every group `13` §3.F.2 lists', () => {
    const names = new Set(labels.map((label) => label.name));
    for (const required of [
      'bug',
      'feature',
      'docs',
      'question',
      'chore',
      'core',
      'policy',
      'ifc',
      'channel:telegram',
      'channel:signal',
      'p0',
      'p3',
      'needs-triage',
      'needs-info',
      'accepted',
      'blocked',
      'good first issue',
      'help wanted',
      'size:S',
      'privacy',
      'security',
      'rfc',
      'duplicate',
      'wontfix',
    ]) {
      expect(names.has(required), `missing label: ${required}`).toBe(true);
    }
  });

  it('includes the labels other parts of the tooling depend on', () => {
    const names = new Set(labels.map((label) => label.name));
    // `no-changeset` is the waiver in `scripts/release/changeset-policy.ts`; `needs-arm64-check`
    // is added by Renovate to native-dependency pull requests. A label a tool applies but the
    // repository does not have is created silently by GitHub with a random colour.
    expect(names.has('no-changeset')).toBe(true);
    expect(names.has('needs-arm64-check')).toBe(true);
  });

  it.each([
    ['a label with no name', 'kind:\n  - color: FFFFFF\n    description: x\n'],
    ['a bad colour', 'kind:\n  - name: a\n    color: nothex\n    description: x\n'],
    ['a short colour', 'kind:\n  - name: a\n    color: FFF\n    description: x\n'],
    ['no description', 'kind:\n  - name: a\n    color: FFFFFF\n'],
    [
      'a duplicate name',
      'a:\n  - {name: x, color: FFFFFF, description: d}\nb:\n  - {name: x, color: FFFFFF, description: d}\n',
    ],
    ['a group that is not a list', 'kind: not-a-list\n'],
  ])('rejects %s', (_label, source) => {
    expect(() => parseLabels(source)).toThrow();
  });
});

describe('planSync', () => {
  const wanted: Label[] = [
    { name: 'bug', color: '455A64', description: 'Something is wrong' },
    { name: 'docs', color: '455A64', description: 'Documentation' },
  ];

  it('creates what is missing', () => {
    const plan = planSync(wanted, []);
    expect(plan.create.map((label) => label.name)).toEqual(['bug', 'docs']);
    expect(plan.update).toEqual([]);
    expect(plan.unchanged).toBe(0);
  });

  it('updates a drifted colour or description', () => {
    const plan = planSync(wanted, [
      { name: 'bug', color: 'FF0000', description: 'Something is wrong' },
      { name: 'docs', color: '455A64', description: 'Old description' },
    ]);
    expect(plan.update.map((label) => label.name)).toEqual(['bug', 'docs']);
    expect(plan.create).toEqual([]);
  });

  it('compares colours case-insensitively, because the API returns lower case', () => {
    const plan = planSync(wanted, [
      { name: 'bug', color: '455a64', description: 'Something is wrong' },
      { name: 'docs', color: '455a64', description: 'Documentation' },
    ]);
    expect(plan.unchanged).toBe(2);
    expect(plan.update).toEqual([]);
  });

  it('reports an extra label without deleting it', () => {
    // The behaviour that matters. A label applied to a hundred old issues is somebody's triage
    // work; a sync that removes it because it is not in a file is a sync that eats data.
    const plan = planSync(wanted, [
      ...wanted,
      { name: 'someone-elses-label', color: 'ABCDEF', description: 'in use on 100 issues' },
    ]);
    expect(plan.extra).toEqual(['someone-elses-label']);
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    // There is no `delete` field at all — the plan cannot express it.
    expect(Object.keys(plan).toSorted()).toEqual(['create', 'extra', 'unchanged', 'update']);
  });

  it('is a no-op when everything matches', () => {
    const plan = planSync(wanted, [...wanted]);
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.extra).toEqual([]);
    expect(plan.unchanged).toBe(2);
  });

  it('treats a missing description on the remote as a drift to fix', () => {
    const plan = planSync(wanted, [
      { name: 'bug', color: '455A64', description: '' },
      { name: 'docs', color: '455A64', description: 'Documentation' },
    ]);
    expect(plan.update.map((label) => label.name)).toEqual(['bug']);
  });
});
