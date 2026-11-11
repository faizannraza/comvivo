/**
 * `BenchResult` — what every benchmark emits (`11` §4.5).
 *
 * A result is written to a JSON file, read by a workflow on another machine, and compared against
 * a result produced weeks earlier. That makes it a **boundary**, so it has a zod schema (`01` §11
 * item 2) and the schema is strict: a field this version does not know is a field the comparison
 * would silently ignore, and a benchmark dashboard that quietly drops a metric is worse than one
 * that fails.
 *
 * ## No I/O beyond reading this machine's own description
 *
 * The commit a result belongs to is **passed in**, not discovered here. The first version shelled
 * out to `git rev-parse HEAD`, which `.dependency-cruiser.cjs` refused on the spot:
 * `08` PSC-8 restricts `node:child_process` to the plugin sandbox and the transcription worker,
 * and a benchmark library is neither. Widening that rule for a convenience would be exactly the
 * trade `CLAUDE.md` §2 forbids — "never weaken a rule to make an import work; fix the design" — so
 * `scripts/bench/run.ts` resolves the commit and every caller threads it through. The library now
 * spawns nothing, which also keeps it usable anywhere the harness might later run.
 *
 * Specification: `docs/plan/11-quality-evals-observability.md` §3.9, §4.5.
 */

import { arch, cpus, hostname } from 'node:os';
import { env, version } from 'node:process';
import { z } from '@comvivo/shared';

/** `B1`–`B6` are `11` §3.9.1's macro benchmarks; `micro:…` is everything on the µ row. */
export const BenchIdSchema = z
  .string()
  .regex(/^(B[1-6]|micro:[a-z0-9][a-z0-9.\-_/]*)$/, 'a bench id is B1–B6 or micro:<name>');

/** The budgets in `11` §3.9.1 are stated per profile, so a result that forgot its profile is noise. */
export const BenchProfileSchema = z.enum(['reference', 'pi', 'dev']);
export type BenchProfile = z.infer<typeof BenchProfileSchema>;

export const BenchEnvSchema = z.strictObject({
  /** The machine: a runner label in CI, the hostname elsewhere. */
  runner: z.string().min(1),
  arch: z.enum(['x64', 'arm64']),
  cpu: z.string().min(1),
  node: z.string().min(1),
  profile: BenchProfileSchema,
});
export type BenchEnv = z.infer<typeof BenchEnvSchema>;

export const BenchResultSchema = z.strictObject({
  id: BenchIdSchema,
  name: z.string().min(1),
  unit: z.enum(['ms', 'MB', 'ops/s', 's']),
  /**
   * The number a budget is compared against — the p95 for a latency benchmark, because that is how
   * `01` §11.10 states every one of them.
   */
  value: z.number().nonnegative(),
  p50: z.number().nonnegative().optional(),
  p95: z.number().nonnegative().optional(),
  p99: z.number().nonnegative().optional(),
  /** Human-readable spread, for the dashboard. */
  range: z.string().optional(),
  env: BenchEnvSchema,
  gitSha: z.string().min(7),
  /** How many repetitions the median was taken over (`11` §3.9.2: five). */
  repetitions: z.int().positive().optional(),
  iterations: z.int().positive().optional(),
});
export type BenchResult = z.infer<typeof BenchResultSchema>;

/**
 * Where the facts about this machine come from.
 *
 * Parameters rather than direct reads, for one reason: the refusal below and the runner-name
 * precedence are both rules worth a test, and neither is testable against a real machine — this
 * one is an arm64 laptop, and the interesting cases are a CI runner and an unsupported
 * architecture. Each defaults to the real thing, so a caller never has to pass any of it.
 */
export interface EnvSources {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly arch?: string;
  readonly cpu?: string;
  readonly node?: string;
  readonly hostname?: string;
}

/**
 * The machine this process is on.
 *
 * `arch` is a closed union because the budgets are: `11` §3.9.1 states a reference-runner figure
 * and a Pi 5 figure, and there is no third column. A result from an architecture nobody has a
 * budget for would be a number with nothing to compare it to, so it is refused here rather than
 * stored and puzzled over later.
 */
export function currentEnv(profile?: BenchProfile, sources: EnvSources = {}): BenchEnv {
  const environment = sources.env ?? env;
  const current = sources.arch ?? arch();
  if (current !== 'x64' && current !== 'arm64') {
    throw new RangeError(
      `11 §3.9.1 has budgets for x64 and arm64, not ${current}. ` +
        'Add a column to the table before benchmarking here.',
    );
  }
  return {
    // `RUNNER_NAME` first because it is the specific machine, `RUNNER_OS` as the label a workflow
    // is written against, and the hostname when neither is set.
    runner:
      environment['RUNNER_NAME'] ?? environment['RUNNER_OS'] ?? sources.hostname ?? hostname(),
    arch: current,
    cpu: sources.cpu ?? cpus()[0]?.model ?? 'unknown',
    node: sources.node ?? version,
    profile: profile ?? defaultProfile(environment),
  };
}

/**
 * `reference` in CI, `dev` on a laptop.
 *
 * Deliberately not guessed from the hardware: a laptop that happened to match a runner's CPU would
 * otherwise have its numbers filed as reference measurements, and `11` §3.9.3's release gate reads
 * those as hard budgets.
 */
function defaultProfile(environment: Readonly<Record<string, string | undefined>>): BenchProfile {
  return environment['CI'] === 'true' || environment['CI'] === '1' ? 'reference' : 'dev';
}
