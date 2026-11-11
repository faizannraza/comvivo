/**
 * The result shape, its schema, and the two facts every result carries (`11` §4.5, §3.9.1).
 *
 * The machine and the commit are not decoration. A benchmark number without them is a point on a
 * chart that nobody can attribute: "this got slower" and "this ran on the other runner" look
 * identical, and so do "the code regressed" and "the comparison is against a laptop".
 *
 * The **commit** is resolved by `scripts/bench/run.ts` rather than here, because reading it means
 * spawning git and `08` PSC-8 does not allow this package to spawn anything. What this module
 * guarantees is that a result without one does not parse.
 */
import { describe, expect, it } from 'vitest';
import {
  type BenchEnv,
  type BenchResult,
  BenchResultSchema,
  budgetShare,
  budgetVerdict,
  currentEnv,
  largerIsBetter,
} from './bench-result.js';

const ENV: BenchEnv = {
  runner: 'ubuntu-24.04',
  arch: 'x64',
  cpu: 'AMD EPYC 7763',
  node: 'v26.13.0',
  profile: 'reference',
};

const RESULT: BenchResult = {
  id: 'B1',
  name: 'ingestion',
  unit: 'ms',
  value: 12.5,
  env: ENV,
  gitSha: '0123456789abcdef',
};

describe('the schema (11 §4.5)', () => {
  it('accepts a result and refuses an unknown field', () => {
    expect(BenchResultSchema.safeParse(RESULT).success).toBe(true);
    // Strict: a field this version does not know is a field the comparison would silently ignore,
    // and a dashboard that quietly drops a metric is worse than one that fails.
    expect(BenchResultSchema.safeParse({ ...RESULT, mystery: 1 }).success).toBe(false);
  });

  it('refuses an id that is neither a B-number nor a micro name', () => {
    for (const id of ['B0', 'B7', 'b1', 'micro:', 'micro:Caps', 'ingestion', '']) {
      expect(BenchResultSchema.safeParse({ ...RESULT, id }).success, id).toBe(false);
    }
    for (const id of ['B1', 'B6', 'micro:queue.enqueue', 'micro:ifc/can-read']) {
      expect(BenchResultSchema.safeParse({ ...RESULT, id }).success, id).toBe(true);
    }
  });

  it('refuses a unit nothing has a budget in, and a negative value', () => {
    expect(BenchResultSchema.safeParse({ ...RESULT, unit: 'ns' }).success).toBe(false);
    expect(BenchResultSchema.safeParse({ ...RESULT, value: -1 }).success).toBe(false);
    expect(
      BenchResultSchema.safeParse({ ...RESULT, value: Number.POSITIVE_INFINITY }).success,
    ).toBe(false);
  });

  it('refuses a result with no commit, or a truncated one', () => {
    const { gitSha: _dropped, ...withoutSha } = RESULT;
    expect(BenchResultSchema.safeParse(withoutSha).success).toBe(false);
    expect(BenchResultSchema.safeParse({ ...RESULT, gitSha: '0123' }).success).toBe(false);
  });

  it('refuses an architecture the budget table has no column for', () => {
    expect(
      BenchResultSchema.safeParse({ ...RESULT, env: { ...ENV, arch: 'riscv64' } }).success,
    ).toBe(false);
  });
});

describe('the budget verdict (11 §3.9.3)', () => {
  it('reads a latency budget as a ceiling and a throughput budget as a floor', () => {
    expect(budgetVerdict({ ...RESULT, value: 2.4, budget: 5 })).toBe('pass');
    expect(budgetVerdict({ ...RESULT, value: 5, budget: 5 })).toBe('pass');
    expect(budgetVerdict({ ...RESULT, value: 16.8, budget: 15 })).toBe('miss');
    // `ops/s` is the one unit where bigger is better, and `11` §3.9.1's `B4` is stated that way.
    // A pass-through would have the gate congratulate a throughput collapse.
    expect(largerIsBetter('ops/s')).toBe(true);
    expect(largerIsBetter('ms')).toBe(false);
    const throughput = { ...RESULT, unit: 'ops/s' as const, budget: 500 };
    expect(budgetVerdict({ ...throughput, value: 2_386 })).toBe('pass');
    expect(budgetVerdict({ ...throughput, value: 480 })).toBe('miss');
  });

  it('has no verdict for a row with no budget, which is what a trend row is', () => {
    expect(budgetVerdict(RESULT)).toBe('none');
    expect(budgetShare(RESULT)).toBeUndefined();
  });

  it('reports the share of the budget used, so smaller is always more headroom', () => {
    // The column `02` §3.16.4 publishes: 0.812 ms against 3 ms is 27% of the budget.
    expect(budgetShare({ ...RESULT, value: 0.812, budget: 3 })).toBe(27);
    expect(budgetShare({ ...RESULT, value: 16.843, budget: 15 })).toBe(112);
    // Inverted for throughput: 2,386 ops/s against a 500 ops/s floor uses 21% of the budget, the
    // same direction as a latency row rather than the reciprocal reading.
    expect(budgetShare({ ...RESULT, unit: 'ops/s', value: 2_386, budget: 500 })).toBe(21);
  });

  it('survives a zero measurement without dividing by it', () => {
    // A throughput of zero is what `runner.ts` reports for an iteration faster than the clock, and
    // a share of `Infinity` would print as `Infinity%` rather than failing the gate.
    expect(budgetShare({ ...RESULT, unit: 'ops/s', value: 0, budget: 500 })).toBeGreaterThan(0);
    expect(budgetVerdict({ ...RESULT, unit: 'ops/s', value: 0, budget: 500 })).toBe('miss');
  });

  it('refuses a budget of zero or less, which would make every row pass', () => {
    expect(BenchResultSchema.safeParse({ ...RESULT, budget: 15 }).success).toBe(true);
    expect(BenchResultSchema.safeParse({ ...RESULT, budget: 0 }).success).toBe(false);
    expect(BenchResultSchema.safeParse({ ...RESULT, budget: -1 }).success).toBe(false);
  });
});

describe('currentEnv', () => {
  it('reads the machine, and matches its own schema', () => {
    const env = currentEnv();
    const parsed = BenchResultSchema.safeParse({ ...RESULT, env });
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      [],
    );
  });

  it('prefers the runner name, then the OS label, then the hostname', () => {
    const sources = { arch: 'x64', cpu: 'test', node: 'v26', hostname: 'laptop' };
    expect(
      currentEnv(undefined, {
        ...sources,
        env: { RUNNER_NAME: 'gh-runner-7', RUNNER_OS: 'Linux' },
      }).runner,
      // The specific machine first: two runners with the same label produce different numbers, and
      // that difference is the first thing to check when a chart jumps.
    ).toBe('gh-runner-7');
    expect(currentEnv(undefined, { ...sources, env: { RUNNER_OS: 'Linux' } }).runner).toBe('Linux');
    expect(currentEnv(undefined, { ...sources, env: {} }).runner).toBe('laptop');
  });

  it('calls CI `reference` and a laptop `dev`', () => {
    const sources = { arch: 'arm64', cpu: 'test', node: 'v26', hostname: 'laptop' };
    // Not guessed from the hardware: a laptop matching a runner's CPU would otherwise have its
    // numbers filed as reference measurements, which `11` §3.9.3 reads as hard budgets.
    expect(currentEnv(undefined, { ...sources, env: { CI: 'true' } }).profile).toBe('reference');
    expect(currentEnv(undefined, { ...sources, env: { CI: '1' } }).profile).toBe('reference');
    expect(currentEnv(undefined, { ...sources, env: {} }).profile).toBe('dev');
    // An explicit profile always wins — `pnpm bench --profile pi` on the Pi itself.
    expect(currentEnv('pi', { ...sources, env: { CI: 'true' } }).profile).toBe('pi');
  });

  it('refuses an architecture with no budget column', () => {
    expect(() => currentEnv(undefined, { arch: 'riscv64', env: {} })).toThrow(/x64 and arm64/);
  });
});
