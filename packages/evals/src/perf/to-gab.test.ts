/**
 * The github-action-benchmark converter (`11` §3.9.2).
 *
 * The assertion that matters is the inversion: `customSmallerIsBetter` cannot host a
 * bigger-is-better metric, and `11` §3.9.1's `B4` is jobs per second. A pass-through would have
 * the dashboard congratulate a throughput collapse.
 */
import { describe, expect, it } from 'vitest';
import type { BenchResult } from './bench-result.js';
import { toGab, toGabEntry } from './to-gab.js';

const BASE: BenchResult = {
  id: 'B2',
  name: 'context build at 50k memories',
  unit: 'ms',
  value: 128.4,
  p50: 96.2,
  p95: 128.4,
  p99: 190.5,
  range: 'p50 96.2 / p99 190.5 ms',
  env: {
    runner: 'ubuntu-24.04',
    arch: 'x64',
    cpu: 'AMD EPYC 7763',
    node: 'v26.13.0',
    profile: 'reference',
  },
  gitSha: '0123456789abcdef0123456789abcdef01234567',
};

describe('a latency result', () => {
  it('passes the number through, with the id in the name', () => {
    const entry = toGabEntry(BASE);
    // The id is in the name because a dashboard is a list of names, and `B2` is how `11` §3.9.1's
    // budget table refers to it.
    expect(entry).toEqual({
      name: 'B2 context build at 50k memories',
      unit: 'ms',
      value: 128.4,
      range: 'p50 96.2 / p99 190.5 ms',
      extra: expect.stringContaining('reference on ubuntu-24.04 (x64, AMD EPYC 7763)'),
    });
    // The commit is there, abbreviated, because "this got slower" and "this ran on another
    // runner" are the two readings of the same jump.
    expect(entry.extra).toContain('012345678');
    expect(entry.extra).toContain('node v26.13.0');
  });

  it('omits the range when there is none rather than writing an empty one', () => {
    const { range: _dropped, ...withoutRange } = BASE;
    expect(Object.hasOwn(toGabEntry(withoutRange), 'range')).toBe(false);
  });
});

describe('a throughput result', () => {
  const throughput: BenchResult = {
    ...BASE,
    id: 'B4',
    name: 'job throughput',
    unit: 'ops/s',
    value: 2000,
  };

  it('is inverted to ms/op, because the format is smaller-is-better', () => {
    const entry = toGabEntry(throughput);
    expect(entry.unit).toBe('ms/op');
    // 2,000 ops/s is 0.5 ms/op. Lossless, and the inversion is named in `extra` so nobody reading
    // the dashboard has to work out why the unit changed.
    expect(entry.value).toBe(0.5);
    expect(entry.extra).toContain('inverted from 2000 ops/s');
  });

  it('turns a collapse into a spike rather than a gap', () => {
    // Zero throughput means the benchmark did nothing, and `Infinity` is not valid JSON while
    // `null` would read as a missing measurement — either would make the dashboard go quiet at
    // exactly the moment it should shout.
    const entry = toGabEntry({ ...throughput, value: 0 });
    expect(entry.value).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isFinite(entry.value)).toBe(true);
  });

  it('keeps the direction consistent across a suite', () => {
    const entries = toGab([BASE, throughput]);
    // Both entries are now smaller-is-better, which is the one property the output format has.
    expect(entries.map((entry) => entry.unit)).toEqual(['ms', 'ms/op']);
    expect(entries).toHaveLength(2);
  });
});
