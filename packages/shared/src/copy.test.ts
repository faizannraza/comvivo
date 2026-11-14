/**
 * The copy helpers (`CLAUDE.md` §2, §8).
 *
 * Tested because the thing they replace — `(s)` — never failed a test either, and the point of
 * replacing it is that a host reads these lines and believes them.
 */
import { describe, expect, it } from 'vitest';
import { listOf, noun, plural } from './copy.js';

describe('plural', () => {
  it('agrees at one and at everything else, including zero', () => {
    // Zero is plural in English — "0 routes" — which is the case `(s)` got right by accident and a
    // naive `count > 1` would get wrong.
    expect(plural(0, 'route')).toBe('0 routes');
    expect(plural(1, 'route')).toBe('1 route');
    expect(plural(2, 'route')).toBe('2 routes');
  });

  it('takes an irregular plural, because not every noun takes an s', () => {
    expect(plural(1, 'identity', 'identities')).toBe('1 identity');
    expect(plural(3, 'identity', 'identities')).toBe('3 identities');
  });
});

describe('noun', () => {
  it('agrees without printing the count', () => {
    expect(noun(1, 'check')).toBe('check');
    expect(noun(2, 'check')).toBe('checks');
  });
});

describe('listOf', () => {
  it('reads aloud at one, two and three', () => {
    expect(listOf([])).toBe('');
    expect(listOf(['a'])).toBe('a');
    expect(listOf(['a', 'b'])).toBe('a and b');
    expect(listOf(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
