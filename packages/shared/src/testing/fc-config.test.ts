/**
 * `fcConfig()` (`11` §3.1.6). The point of every one of these is replay: a property test you
 * cannot reproduce is a property test you cannot fix.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_NUM_RUNS, fcConfig, fcNumRuns } from './fc-config.js';

describe('defaults', () => {
  it('runs the documented default number of cases', () => {
    expect(fcConfig({ env: {} }).numRuns).toBe(DEFAULT_NUM_RUNS);
    expect(DEFAULT_NUM_RUNS).toBe(100);
  });

  it('shrinks by default, because an unshrunk counterexample is not actionable', () => {
    // fast-check's `endOnFailure: true` means "stop at the first failure **without shrinking**".
    // This defaulted to `true` until the M1 exit gate, so every failure was a raw random
    // counterexample and `FC_PATH` — which replays the *shrunk* path — had nothing to replay.
    expect(fcConfig({ env: {} }).endOnFailure).toBe(false);
  });

  it('is verbose, so the failing seed is actually printed', () => {
    expect(fcConfig({ env: {} }).verbose).toBe(true);
  });

  it('sets no seed or path when the environment is clean', () => {
    const params = fcConfig({ env: {} });
    expect('seed' in params).toBe(false);
    expect('path' in params).toBe(false);
  });
});

describe('FC_NUM_RUNS', () => {
  it('raises the run count, which is how nightly reaches 20,000', () => {
    expect(fcConfig({ env: { FC_NUM_RUNS: '20000' } }).numRuns).toBe(20_000);
  });

  it('beats a per-suite override, so CI can raise every suite at once', () => {
    expect(fcConfig({ numRuns: 500, env: { FC_NUM_RUNS: '20000' } }).numRuns).toBe(20_000);
  });

  it('honours a per-suite override when the environment is silent', () => {
    // `core/ifc`, `core/policy` and fairness use 500 on a pull request (`11` §3.1.6).
    expect(fcConfig({ numRuns: 500, env: {} }).numRuns).toBe(500);
  });

  it.each(['', '0', '-5', 'lots', '1.5'])('ignores the nonsensical value %s', (raw) => {
    expect(fcConfig({ env: { FC_NUM_RUNS: raw } }).numRuns).toBe(DEFAULT_NUM_RUNS);
  });
});

describe('FC_END_ON_FAILURE', () => {
  it('is off by default, so a failure is shrunk before it is reported', () => {
    expect(fcConfig({ env: {} }).endOnFailure).toBe(false);
  });

  it.each(['1', 'true', 'yes', 'YES', ' true '])('turns off shrinking for %s', (raw) => {
    expect(fcConfig({ env: { FC_END_ON_FAILURE: raw } }).endOnFailure).toBe(true);
  });

  it.each(['0', 'false', 'no', 'NO', ' false '])('keeps shrinking on for %s', (raw) => {
    expect(fcConfig({ env: { FC_END_ON_FAILURE: raw } }).endOnFailure).toBe(false);
  });

  it('beats a call site either way, so one environment variable settles a whole run', () => {
    expect(fcConfig({ endOnFailure: false, env: { FC_END_ON_FAILURE: '1' } }).endOnFailure).toBe(
      true,
    );
    expect(fcConfig({ endOnFailure: true, env: { FC_END_ON_FAILURE: '0' } }).endOnFailure).toBe(
      false,
    );
  });

  it.each(['', 'maybe', '2', 'on'])('leaves the default alone for %s', (raw) => {
    // Only the recognised spellings mean anything: a typo must not silently disable shrinking on
    // a run that asked for it, nor enable it on one that did not.
    expect(fcConfig({ env: { FC_END_ON_FAILURE: raw } }).endOnFailure).toBe(false);
  });

  it('honours a call site that wants the fast loop when the environment is silent', () => {
    expect(fcConfig({ endOnFailure: true, env: {} }).endOnFailure).toBe(true);
  });
});

describe('FC_SEED', () => {
  it('replays a specific seed', () => {
    expect(fcConfig({ env: { FC_SEED: '123456' } }).seed).toBe(123_456);
  });

  it('accepts a negative seed, which fast-check reports', () => {
    expect(fcConfig({ env: { FC_SEED: '-42' } }).seed).toBe(-42);
  });

  it('accepts zero rather than treating it as absent', () => {
    expect(fcConfig({ env: { FC_SEED: '0' } }).seed).toBe(0);
  });

  it.each(['', 'abc', '1.5'])('ignores the invalid seed %s', (raw) => {
    expect('seed' in fcConfig({ env: { FC_SEED: raw } })).toBe(false);
  });
});

describe('FC_PATH', () => {
  it('replays the shrink path, skipping the shrink', () => {
    expect(fcConfig({ env: { FC_PATH: '12:3:0' } }).path).toBe('12:3:0');
  });

  it('ignores an empty path', () => {
    expect('path' in fcConfig({ env: { FC_PATH: '   ' } })).toBe(false);
  });

  it('works together with a seed, which is how a counterexample is pinned exactly', () => {
    const params = fcConfig({ env: { FC_SEED: '-7', FC_PATH: '4:1' } });
    expect(params.seed).toBe(-7);
    expect(params.path).toBe('4:1');
  });
});

describe('endOnFailure', () => {
  it('can be turned off, which nightly does to gather more counterexamples', () => {
    expect(fcConfig({ endOnFailure: false, env: {} }).endOnFailure).toBe(false);
  });
});

describe('fcNumRuns', () => {
  it('reads the environment, falling back to the given default', () => {
    expect(fcNumRuns(500, {})).toBe(500);
    expect(fcNumRuns(500, { FC_NUM_RUNS: '20000' })).toBe(20_000);
    expect(fcNumRuns(undefined, {})).toBe(DEFAULT_NUM_RUNS);
  });
});
