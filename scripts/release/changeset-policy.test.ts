import { describe, expect, it } from 'vitest';
import { decide, explain, isShippedPath, shouldFail, WAIVER_LABEL } from './changeset-policy.js';

describe('isShippedPath', () => {
  it.each([
    'apps/cli/src/commands/start.ts',
    'apps/server/src/http/routes.ts',
    'apps/dashboard/src/routes/memory.tsx',
    'packages/engine/src/turn/engine.ts',
    'packages/core/src/ifc/join.ts',
    'packages/channels/telegram/src/ingest.ts',
    'deploy/docker/Dockerfile',
    'deploy/compose.yaml',
  ])('ships: %s', (path) => {
    expect(isShippedPath(path)).toBe(true);
  });

  it.each([
    // Tests of every tier.
    'packages/engine/src/turn/engine.test.ts',
    'packages/storage/src/db.int.test.ts',
    'packages/models/src/anthropic.contract.test.ts',
    'packages/core/src/ifc/join.prop.test.ts',
    'packages/evals/scenarios/family-week.scenario.ts',
    'packages/core/src/bench/join.bench.ts',
    // Fixtures, snapshots and test doubles.
    'packages/engine/src/__fixtures__/turn.json',
    'packages/channels/telegram/src/__snapshots__/render.telegram.html',
    'packages/shared/src/testing/virtual-clock.ts',
    // Prose.
    'packages/engine/README.md',
    'apps/docs/src/content/guides/install.mdx',
    // Not in a shipped tree at all.
    '.github/workflows/ci.yml',
    'docs/plan/STATUS.md',
    'scripts/hygiene/check.ts',
    'tools/changelog/index.mjs',
    'package.json',
    'pnpm-workspace.yaml',
  ])('does not ship: %s', (path) => {
    expect(isShippedPath(path)).toBe(false);
  });

  it('excludes the whole evals package', () => {
    // `@comvivo/evals` is the harness. It gates releases but is not in one.
    expect(isShippedPath('packages/evals/src/suites/redteam/injection.ts')).toBe(false);
  });

  it('excludes the docs site, which has its own release path', () => {
    expect(isShippedPath('apps/docs/astro.config.mjs')).toBe(false);
  });
});

describe('decide', () => {
  const shipped = ['packages/engine/src/turn/engine.ts'];

  it('requires a changeset when a shipped file changed', () => {
    const decision = decide({ changedFiles: shipped, changesets: [], labels: [] });
    expect(decision.required).toBe(true);
    expect(decision.satisfied).toBe(false);
    expect(shouldFail(decision)).toBe(true);
  });

  it('is satisfied when a changeset exists', () => {
    const decision = decide({
      changedFiles: shipped,
      changesets: ['brave-lions-sing.md'],
      labels: [],
    });
    expect(shouldFail(decision)).toBe(false);
  });

  it('is not required when nothing shipped changed', () => {
    const decision = decide({
      changedFiles: ['.github/workflows/ci.yml', 'docs/plan/STATUS.md'],
      changesets: [],
      labels: [],
    });
    expect(decision.required).toBe(false);
    expect(shouldFail(decision)).toBe(false);
  });

  it('is waived by the label, case-insensitively', () => {
    for (const label of [WAIVER_LABEL, 'No-Changeset', 'NO-CHANGESET']) {
      const decision = decide({ changedFiles: shipped, changesets: [], labels: [label] });
      expect(decision.waived, label).toBe(true);
      expect(shouldFail(decision), label).toBe(false);
    }
  });

  it('is not waived by some other label', () => {
    const decision = decide({
      changedFiles: shipped,
      changesets: [],
      labels: ['enhancement', 'dependencies'],
    });
    expect(decision.waived).toBe(false);
    expect(shouldFail(decision)).toBe(true);
  });

  it('records which files triggered the requirement', () => {
    const decision = decide({
      changedFiles: [
        'packages/engine/src/turn/engine.ts',
        'packages/engine/src/turn/engine.test.ts',
        'docs/plan/STATUS.md',
      ],
      changesets: [],
      labels: [],
    });
    // Only the shipped one. Listing the test file would send the author looking for a release note
    // about a test.
    expect(decision.reasons).toEqual(['packages/engine/src/turn/engine.ts']);
  });
});

describe('explain', () => {
  it('lists the files, says how to fix it, and names the waiver', () => {
    const message = explain(
      decide({
        changedFiles: ['packages/engine/src/turn/engine.ts'],
        changesets: [],
        labels: [],
      }),
    );
    expect(message).toContain('packages/engine/src/turn/engine.ts');
    expect(message).toContain('pnpm changeset');
    expect(message).toContain('breaking:');
    expect(message).toContain(WAIVER_LABEL);
    // The reason the waiver is a label rather than a flag.
    expect(message).toContain('in the record');
  });

  it('truncates a long list rather than printing a hundred paths', () => {
    const files = Array.from({ length: 30 }, (_, i) => `packages/engine/src/f${String(i)}.ts`);
    const message = explain(decide({ changedFiles: files, changesets: [], labels: [] }));
    expect(message).toContain('…and 20 more');
  });

  it('says plainly when it is satisfied, waived, or not required', () => {
    const shipped = ['packages/engine/src/turn/engine.ts'];
    expect(explain(decide({ changedFiles: shipped, changesets: ['a.md'], labels: [] }))).toContain(
      'present',
    );
    expect(
      explain(decide({ changedFiles: shipped, changesets: [], labels: [WAIVER_LABEL] })),
    ).toContain('waived');
    expect(explain(decide({ changedFiles: [], changesets: [], labels: [] }))).toContain(
      'not required',
    );
  });
});
