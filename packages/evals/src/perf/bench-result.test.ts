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
import { type BenchEnv, type BenchResult, BenchResultSchema, currentEnv } from './bench-result.js';

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
