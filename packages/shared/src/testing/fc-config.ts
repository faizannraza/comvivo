/**
 * `fcConfig()` — fast-check parameters, with replay built in.
 *
 * `11` §3.1.6. Three environment variables, and each exists for a reason that bites in practice:
 *
 *  - **`FC_SEED`** — CI logs the seed of every property run. When one fails, pasting the seed back
 *    reproduces it exactly. Without this, "it failed once in CI" is unactionable.
 *  - **`FC_PATH`** — fast-check's shrink path. With the seed it replays the *minimal* counterexample
 *    directly, skipping the shrink.
 *  - **`FC_NUM_RUNS`** — 100 by default; `core/ifc`, `core/policy` and fairness run **500 on a pull
 *    request** and **20,000 nightly**. The nightly run is where a one-in-ten-thousand labelling bug
 *    actually surfaces, and it is also why the default has to stay low enough that a PR is fast.
 *
 * fast-check is imported **as a type only**, so this module adds no runtime dependency to
 * `@comvivo/shared` — which matters because `shared` sits at the bottom of the dependency graph and
 * is installed by every consumer of the product, not only by its tests.
 */
import type fc from 'fast-check';

/** What `11` §3.1.6 calls the default; raised per-suite for the mandatory property areas. */
export const DEFAULT_NUM_RUNS = 100;

export interface FcConfigOptions {
  /** Override the run count. `FC_NUM_RUNS` still wins, so CI can raise every suite at once. */
  readonly numRuns?: number;
  /** Fail as soon as a counterexample is found. On by default; nightly turns it off to gather more. */
  readonly endOnFailure?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function anyInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) ? value : undefined;
}

/**
 * Parameters for `fc.assert`.
 *
 * Always pass this rather than a bare object, or the suite loses replay — and a property test you
 * cannot replay is a property test you cannot fix.
 */
export function fcConfig(options: FcConfigOptions = {}): fc.Parameters<unknown> {
  const env = options.env ?? process.env;

  const numRuns = positiveInt(env['FC_NUM_RUNS']) ?? options.numRuns ?? DEFAULT_NUM_RUNS;
  const seed = anyInt(env['FC_SEED']);
  const path = env['FC_PATH'];

  return {
    numRuns,
    endOnFailure: options.endOnFailure ?? true,
    // The seed is reported on failure so it can be pasted straight back in.
    verbose: true,
    ...(seed === undefined ? {} : { seed }),
    ...(path === undefined || path.trim() === '' ? {} : { path }),
  };
}

/** The run count only, for a suite that builds its own parameters. */
export function fcNumRuns(fallback = DEFAULT_NUM_RUNS, env = process.env): number {
  return positiveInt(env['FC_NUM_RUNS']) ?? fallback;
}
