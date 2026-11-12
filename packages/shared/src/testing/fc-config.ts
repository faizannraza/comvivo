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
 *  - **`FC_END_ON_FAILURE`** — `0`, `false` or `no` keeps the run going after the first
 *    counterexample. §3.1.6 asks the nightly run to do that, and until the nightly workflow
 *    existed there was no way to: `endOnFailure` was reachable only from a call site, so the
 *    documented behaviour was a sentence with nothing behind it. One failing shape per night costs
 *    a night per shape; the whole list costs one.
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
  /**
   * Fail as soon as a counterexample is found. On by default; the nightly run turns it off with
   * `FC_END_ON_FAILURE=0` to gather every shape in one pass.
   */
  readonly endOnFailure?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** `0`, `false` and `no` are false; anything else absent leaves the caller's choice alone. */
function falsey(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return ['0', 'false', 'no'].includes(raw.trim().toLowerCase()) ? false : undefined;
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
    endOnFailure: falsey(env['FC_END_ON_FAILURE']) ?? options.endOnFailure ?? true,
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

/**
 * A per-test timeout for a property suite, scaled to its run count.
 *
 * `11` §3.1.6 raises the mandatory suites to 20,000 runs nightly and the M1 exit gate runs the
 * queue suite that way by name — and a fixed `testTimeout` cannot survive that: at 11 ms per run
 * (measured, a model-based queue run against a real database) 20,000 runs take about four minutes
 * against a 30-second limit. The suite completed and was still reported as a failure, because
 * `fc.assert` is synchronous and Vitest can only notice the overrun afterwards. So the timeout is
 * derived from the same number that decides the work.
 *
 * `msPerRun` is a **measured** cost with margin, not a guess: measure the suite at its default
 * run count, divide, and round up. `minimumMs` keeps a small suite on the project's own timeout
 * rather than giving it a tighter one by accident.
 */
export function fcTimeoutMs(
  msPerRun: number,
  options: {
    readonly numRuns?: number;
    readonly minimumMs?: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): number {
  const runs = fcNumRuns(options.numRuns ?? DEFAULT_NUM_RUNS, options.env ?? process.env);
  return Math.max(options.minimumMs ?? 30_000, Math.ceil(runs * msPerRun));
}
