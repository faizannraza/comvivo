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
 *  - **`FC_END_ON_FAILURE`** — `1`, `true` or `yes` stops a run at the first counterexample
 *    **without shrinking**, which is fast-check's own `endOnFailure` and is useful for a tight
 *    local loop. **Off by default**, so a failure shrinks to a minimal counterexample.
 *
 *    That default was `true` until the M1 exit gate, when a reviewer read fast-check's own
 *    documentation: "it makes the run stop at the first encountered failure *without shrinking*".
 *    So every local and pull-request failure was a raw random counterexample, and `FC_PATH` above
 *    — which replays the *shrunk* path — had nothing to replay. The comment that used to be here
 *    described `endOnFailure: false` as "keeps the run going to gather more shapes", which
 *    fast-check does not do: `fc.assert` reports exactly one counterexample either way. One
 *    failure per *file* per night comes from the per-file sharding in
 *    `nightly-deterministic.yml`, not from this flag.
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
   * Stop at the first counterexample **without shrinking**. Off by default, so failures shrink.
   *
   * fast-check's own semantics, not "stop after the first failure": `fc.assert` reports one
   * counterexample whichever way this is set. What it buys is speed, at the cost of a minimal
   * example — which is the one thing a failing property needs to be actionable.
   */
  readonly endOnFailure?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * `1`/`true`/`yes` → `true`, `0`/`false`/`no` → `false`, anything else leaves the caller's choice.
 *
 * Both directions, because the default moved: a nightly run wants shrinking (the default now) and
 * someone bisecting locally may want to turn it off. An unrecognised value changes nothing rather
 * than guessing, so a typo cannot silently disable shrinking on a run that asked for it.
 */
function boolish(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(value)) return true;
  if (['0', 'false', 'no'].includes(value)) return false;
  return undefined;
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
    endOnFailure: boolish(env['FC_END_ON_FAILURE']) ?? options.endOnFailure ?? false,
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
