/**
 * Global test environment. Deterministic by construction, and offline by force.
 *
 * Specification: `docs/plan/11-quality-evals-observability.md` §3.1.1 and §3.1.3.
 *
 * The environment is pinned at **module scope**, not inside `beforeAll`. That matters: Node caches
 * the timezone the first time a `Date` is formatted, so assigning `process.env.TZ` from a hook runs
 * too late and the suite silently keeps the host's timezone. The harness test asserts the real
 * behaviour (`new Date(...).getHours()`), not just the variable, so this cannot regress unnoticed.
 */
import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import { installNetworkGuard } from './scripts/harness/network-guard.js';

// --- Environment, pinned before anything can read it -------------------------------------------
process.env['TZ'] = 'UTC';
process.env['LANG'] = 'C.UTF-8';
process.env['COMVIVO_TEST_MODE'] = '1';

// --- Offline, unless this is a live-eval workflow ----------------------------------------------
const networkAllowed = process.env['COMVIVO_ALLOW_NETWORK'] === '1';
const restoreNetwork = networkAllowed ? (): void => {} : installNetworkGuard();

afterAll(() => {
  restoreNetwork();
});

// --- An unexpected console.error is a failure, not scrollback ----------------------------------
// It usually means a swallowed rejection or a misconfigured logger, both of which `01` §11.6 and
// §11.7 forbid.
const realConsoleError = console.error;
let consoleErrors: string[] = [];

beforeAll(() => {
  console.error = (...args: unknown[]): void => {
    consoleErrors.push(args.map((arg) => String(arg)).join(' '));
  };
});

afterEach(() => {
  const seen = consoleErrors;
  consoleErrors = [];
  expect(
    seen,
    'console.error was called during this test. Handle the error, assert on it, or stub the ' +
      'console deliberately (01 §11.6: no silent catches).',
  ).toEqual([]);
});

afterAll(() => {
  console.error = realConsoleError;
});
