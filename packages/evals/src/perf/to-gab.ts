/**
 * `BenchResult[]` → github-action-benchmark's `customSmallerIsBetter` JSON (`11` §3.9.2).
 *
 * ## The one thing the format cannot express
 *
 * `customSmallerIsBetter` means exactly what it says: every entry is better when the number is
 * lower, and the alert fires when it rises. `11` §3.9.1's `B4` is **jobs per second**, where lower
 * is worse — so a straight pass-through would have the dashboard congratulate a throughput
 * collapse and alert on an improvement.
 *
 * So a throughput result is **inverted**: `ops/s` becomes `ms/op`, which is the same measurement
 * with the better direction the format needs. It is lossless (`ops/s = 1000 / (ms/op)`) and it is
 * named in the entry, so nobody reading the dashboard has to guess. The alternative — a second
 * `customBiggerIsBetter` dashboard — splits one suite across two pages and two alert thresholds
 * for the sake of one row.
 *
 * Specification: `docs/plan/11-quality-evals-observability.md` §3.9.2, §4.5.
 */
import type { BenchResult } from './bench-result.js';

/** One entry of github-action-benchmark's `customSmallerIsBetter` array. */
export interface GabEntry {
  readonly name: string;
  readonly unit: string;
  readonly value: number;
  readonly range?: string;
  readonly extra?: string;
}

/**
 * Convert one result.
 *
 * The name carries the id, because a dashboard is a list of names and `B2` is how the budget
 * table refers to it. The `extra` line carries the machine and the commit: github-action-benchmark
 * shows it on hover, and it is the difference between "this got slower" and "this ran on the other
 * runner".
 */
export function toGabEntry(result: BenchResult): GabEntry {
  const inverted = result.unit === 'ops/s';
  const value = inverted ? invert(result.value) : result.value;
  return {
    name: `${result.id} ${result.name}`,
    unit: inverted ? 'ms/op' : result.unit,
    value: round(value),
    ...(result.range === undefined ? {} : { range: result.range }),
    extra: [
      `${result.env.profile} on ${result.env.runner} (${result.env.arch}, ${result.env.cpu})`,
      `node ${result.env.node}`,
      result.gitSha.slice(0, 12),
      ...(inverted ? [`inverted from ${String(round(result.value))} ops/s`] : []),
    ].join(' · '),
  };
}

export function toGab(results: readonly BenchResult[]): readonly GabEntry[] {
  return results.map(toGabEntry);
}

/** `ops/s` → `ms/op`. Zero throughput is reported as the largest finite figure, not as infinity. */
function invert(opsPerSecond: number): number {
  // A benchmark that completed zero operations per second did something wrong, and the dashboard
  // should show a spike rather than a gap: `Infinity` is not valid JSON and `null` would be read
  // as a missing measurement.
  return opsPerSecond <= 0 ? Number.MAX_SAFE_INTEGER : 1000 / opsPerSecond;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
