/**
 * `Result` is how every expected failure travels (ADR-010). These tests pin the two properties the
 * rest of the codebase depends on: a failure never silently becomes a success, and `all` reports
 * *every* problem rather than only the first.
 */
import { describe, expect, it } from 'vitest';
import { all, andThen, err, isErr, isOk, map, mapErr, ok, unwrapOr } from './result.js';

describe('ok and err', () => {
  it('narrows to the value', () => {
    const result = ok(7);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
    if (result.ok) expect(result.value).toBe(7);
  });

  it('narrows to the error', () => {
    const result = err('nope');
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error).toBe('nope');
  });

  it('carries falsy values without confusing them for failure', () => {
    // `ok(undefined)` and `ok(0)` are successes. A truthiness-based Result would get this wrong,
    // and `undefined` is a perfectly ordinary success for a lookup that found nothing.
    expect(isOk(ok(undefined))).toBe(true);
    expect(isOk(ok(0))).toBe(true);
    expect(isOk(ok(false))).toBe(true);
  });
});

describe('map and mapErr', () => {
  it('maps a success', () => {
    expect(map(ok(2), (n) => n * 3)).toEqual(ok(6));
  });

  it('leaves a failure alone, and does not call the function', () => {
    let called = false;
    const result = map(err<string>('boom'), () => {
      called = true;
      return 1;
    });
    expect(result).toEqual(err('boom'));
    expect(called).toBe(false);
  });

  it('adds context to an error as it travels up', () => {
    expect(mapErr(err('disk full'), (e) => `while writing the outbox: ${e}`)).toEqual(
      err('while writing the outbox: disk full'),
    );
  });

  it('leaves a success alone when mapping the error', () => {
    expect(mapErr(ok(1), () => 'unused')).toEqual(ok(1));
  });
});

describe('andThen', () => {
  it('chains fallible steps', () => {
    const half = (n: number) => (n % 2 === 0 ? ok(n / 2) : err('odd'));
    expect(andThen(ok(8), half)).toEqual(ok(4));
    expect(andThen(ok(7), half)).toEqual(err('odd'));
  });

  it('short-circuits on the first failure', () => {
    let called = false;
    andThen(err('first'), () => {
      called = true;
      return ok(1);
    });
    expect(called).toBe(false);
  });
});

describe('unwrapOr', () => {
  it('returns the value or the fallback', () => {
    expect(unwrapOr(ok(5), 0)).toBe(5);
    expect(unwrapOr(err('x'), 0)).toBe(0);
  });
});

describe('all', () => {
  it('collects every value when nothing failed', () => {
    expect(all([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));
  });

  it('collects EVERY error, not just the first', () => {
    // This is the whole reason `all` exists. A host fixing a broken config wants the full list;
    // one problem per restart is a miserable way to spend the five minutes `00` §3.7 promises.
    expect(all([ok(1), err('a'), ok(2), err('b')])).toEqual(err(['a', 'b']));
  });

  it('treats an empty list as success', () => {
    expect(all([])).toEqual(ok([]));
  });
});
