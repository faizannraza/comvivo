/**
 * Global test environment. Deterministic by construction.
 *
 * `docs/plan/11-quality-evals-observability.md` §3.1.1 and §3.1.3 are the specification.
 * The full network guard and the `console.error` failure rule land in **M0-T3**; what is here is
 * the part M0-T1 needs so the pinned environment is never accidentally inherited from a developer's
 * shell.
 */
import { afterAll, beforeAll } from 'vitest';

const PINNED = {
  TZ: 'UTC',
  LANG: 'C.UTF-8',
  COMVIVO_TEST_MODE: '1',
} as const;

let restore: [string, string | undefined][] = [];

beforeAll(() => {
  restore = Object.entries(PINNED).map(([key, value]) => {
    const previous = process.env[key];
    process.env[key] = value;
    return [key, previous] as [string, string | undefined];
  });
});

afterAll(() => {
  for (const [key, previous] of restore) {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  restore = [];
});
