/**
 * Every Vitest project that should have files has them (`11` §3.1.1).
 *
 * `vitest.config.ts` sets `passWithNoTests: true` globally, and it has to: the contract, scenario
 * and dashboard layers are populated by later milestones, and an empty project must not fail the
 * run before its milestone lands. The cost is that a **typo in an include pattern** is
 * indistinguishable from a layer that has not arrived yet — `packages/**​/src/**​/*.int.test.ts`
 * written with one star too few would run zero of the integration tests, every I4 trigger guard
 * among them, and report green.
 *
 * `vitest.shared.ts` warns about exactly this failure mode for `defineWorkspace` ("a repo can look
 * configured and run nothing") and nothing pinned a file count. Found by the M1 independent
 * review.
 *
 * The expected-empty list is the forcing function: when a layer fills, this test fails until
 * somebody moves its name, which is the moment to check that the new project is actually running.
 */
import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';
import { COMMON_EXCLUDE } from '../../vitest.shared.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');

/** Projects that are legitimately empty until their milestone lands, with the task that fills them. */
const EXPECTED_EMPTY: Readonly<Record<string, string>> = {
  scenario: 'M3-T48 writes the first eval scenario',
  dashboard: 'M9-T1 creates the first dashboard component',
};

interface ProjectShape {
  readonly test?: {
    readonly name?: string;
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
  };
}

/** Each project's name and the files its include patterns actually match. */
function projectFiles(): { name: string; include: readonly string[]; files: string[] }[] {
  const projects = (config as { test?: { projects?: ProjectShape[] } }).test?.projects ?? [];
  return projects.map((project) => {
    const include = project.test?.include ?? [];
    const exclude = project.test?.exclude ?? COMMON_EXCLUDE;
    const files = globSync([...include], { cwd: ROOT, exclude: [...exclude] });
    return { name: project.test?.name ?? '(unnamed)', include, files: files.toSorted() };
  });
}

describe('the project list is wired to real files', () => {
  it('found the projects at all', () => {
    // Non-vacuity: `it.each` over an empty list runs no cases and passes, and reading the config
    // through a changed export shape would produce exactly that.
    const names = projectFiles().map((project) => project.name);
    expect(names).toEqual(['unit', 'integration', 'contract', 'scenario', 'dashboard']);
  });

  it.each(projectFiles())('$name matches $files.length files', ({ name, include, files }) => {
    const reason = EXPECTED_EMPTY[name];
    if (reason !== undefined) {
      expect(
        files,
        `${name} is listed as expected-empty (${reason}). It has files now, so remove it from ` +
          'EXPECTED_EMPTY — and check the project is in the run rather than passing vacuously.',
      ).toEqual([]);
      return;
    }
    expect(
      files.length,
      `${name} matched no files. Its include patterns are ${JSON.stringify(include)}, and ` +
        '`passWithNoTests: true` means the run would be green with the whole layer missing.',
    ).toBeGreaterThan(0);
  });

  it('every project declares an include, so none falls back to the default', () => {
    for (const { name, include } of projectFiles()) {
      expect(include.length, `${name} has no include patterns`).toBeGreaterThan(0);
    }
  });
});
