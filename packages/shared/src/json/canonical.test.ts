/**
 * RFC 8785 JCS.
 *
 * Three things in this product hash JSON: the audit hash chain (`02` §3.8), `exportDomainState`
 * (`02` §4.1) and idempotency keys (`02` §3.3.9, invariant **I6**). All three fail *silently* if
 * the serialisation is not canonical — the chain stops verifying, the backup assertion compares
 * insertion order, and an effect runs twice.
 *
 * **On test vectors.** RFC 8785's Appendix B is a 100-million-line file of IEEE-754 bit patterns
 * paired with their ES6 serialisation, hosted outside this repository. Downloading it is not
 * something `pnpm verify` should do, so the substitution is stated rather than glossed:
 *
 *  - the worked example in **§3.2.3** is here verbatim, numbers and all;
 *  - number serialisation is cross-checked against **`JSON.stringify`**, which is the normative
 *    reference §3.2.2.3 points at — so for the number path this is the Appendix B oracle itself,
 *    sampled by a property test over random doubles including denormals and extremes rather than
 *    over a fixed list;
 *  - the three documented deviations from `JSON.stringify` (`-0`, non-finite values, lone
 *    surrogates) each get their own test, because those are precisely where delegation stops.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BugError } from '../errors.js';
import { fcConfig } from '../testing/fc-config.js';
import { type CanonicalValue, canonicalJson, canonicalJsonBytes } from './canonical.js';

const DEL = String.fromCharCode(0x7f);
const NUL = String.fromCharCode(0x00);
const UNIT_SEPARATOR = String.fromCharCode(0x1f);
const LONE_HIGH_SURROGATE = String.fromCharCode(0xd8_3c);

describe('RFC 8785 §3.2.3, the worked example', () => {
  it('serialises the numbers exactly as the RFC prints them', () => {
    // The precision loss below IS the test. RFC 8785 §3.2.3 feeds in `333333333.33333329` and
    // expects `333333333.3333333` out, demonstrating that the canonical form is the shortest
    // representation that round-trips to the same double. Writing the already-rounded literal
    // would assert nothing at all.
    const input = {
      // biome-ignore lint/correctness/noPrecisionLoss: it is the RFC's own input; see above.
      numbers: [333_333_333.333_333_29, 1e30, 4.5, 2e-3, 0.000_000_000_000_000_000_000_000_001],
    };
    expect(canonicalJson(input)).toBe('{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}');
  });

  it('sorts the top-level keys, which the RFC input deliberately gives out of order', () => {
    const input = {
      numbers: [1],
      string: 'x',
      literals: [null, true, false],
    };
    expect(canonicalJson(input)).toBe('{"literals":[null,true,false],"numbers":[1],"string":"x"}');
  });
});

describe('key ordering', () => {
  it('sorts by UTF-16 code unit, not by locale', () => {
    // The obvious wrong choice is `localeCompare`, which puts "ä" next to "a" in German and after
    // "z" in Swedish — so the hash of a family's data would depend on the host's locale.
    expect(canonicalJson({ z: 1, ä: 2, a: 3 })).toBe('{"a":3,"z":1,"ä":2}');
  });

  it('puts an uppercase key before a lowercase one', () => {
    // Code-unit order, so every uppercase letter precedes every lowercase one. A case-insensitive
    // sort would be the other obvious wrong choice.
    expect(canonicalJson({ b: 1, A: 2 })).toBe('{"A":2,"b":1}');
  });

  it('is insensitive to the order the keys were written in', () => {
    expect(canonicalJson({ a: 1, b: 2, c: 3 })).toBe(canonicalJson({ c: 3, b: 2, a: 1 }));
  });

  it('sorts nested objects too', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('leaves array order alone, because an array is ordered data', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});

describe('numbers', () => {
  it.each([
    [0, '0'],
    [-0, '0'],
    [1, '1'],
    [-1, '-1'],
    [4.5, '4.5'],
    [0.002, '0.002'],
    [1e30, '1e+30'],
    [1e21, '1e+21'],
    [1e-7, '1e-7'],
    [1e-6, '0.000001'],
    [5e-324, '5e-324'],
    [1.797_693_134_862_315_7e308, '1.7976931348623157e+308'],
    [9_007_199_254_740_992, '9007199254740992'],
  ])('serialises %p as %s', (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  it('serialises negative zero as 0, which matters inside a structure', () => {
    // RFC 8785 §3.2.2.3. JSON has one zero; ECMAScript has two. Without this, `{ "x": -0 }` and
    // `{ "x": 0 }` would hash differently, and the sign of a zero is never something a family's
    // data depends on.
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson({ x: -0 })).toBe(canonicalJson({ x: 0 }));
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses %p rather than turning it into null',
    (value) => {
      // `JSON.stringify` emits `null` here, which would make a corrupt value silently canonical
      // and give it a perfectly valid hash.
      expect(() => canonicalJson(value)).toThrow(BugError);
      expect(JSON.stringify(value)).toBe('null');
    },
  );

  it('agrees with JSON.stringify for every finite double', { tags: ['prop'] }, () => {
    // The Appendix B oracle, sampled. `fc.double` covers denormals, extremes and the awkward
    // boundaries around 1e21 where the format switches to exponential.
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (value) => {
        const expected = Object.is(value, -0) ? '0' : JSON.stringify(value);
        expect(canonicalJson(value)).toBe(expected);
      }),
      fcConfig(),
    );
  });
});

describe('strings', () => {
  it.each([
    ['', '""'],
    ['plain', '"plain"'],
    ['a"b', '"a\\"b"'],
    ['a\\b', '"a\\\\b"'],
    ['a\nb', '"a\\nb"'],
    ['a\tb', '"a\\tb"'],
    ['a\rb', '"a\\rb"'],
    ['a\bb', '"a\\bb"'],
    ['a\fb', '"a\\fb"'],
  ])('serialises %j as %s', (value, expected) => {
    expect(canonicalJson(value)).toBe(expected);
  });

  it('escapes the control characters that have no short form', () => {
    expect(canonicalJson(NUL)).toBe('"\\u0000"');
    expect(canonicalJson(UNIT_SEPARATOR)).toBe('"\\u001f"');
  });

  it('does not escape a forward slash', () => {
    // RFC 8785 escapes only what JSON requires. Some serialisers escape `/` for HTML-embedding
    // reasons; doing so here would produce a different hash for the same value.
    expect(canonicalJson('a/b')).toBe('"a/b"');
  });

  it('leaves U+007F literal, because the rule is "below U+0020"', () => {
    expect(canonicalJson(DEL)).toBe(`"${DEL}"`);
  });

  it('leaves non-ASCII literal rather than escaping it', () => {
    // §3.3: the output is UTF-8. Escaping would still be valid JSON and a different byte string.
    expect(canonicalJson('€ £ 日本語 🎉')).toBe('"€ £ 日本語 🎉"');
  });

  it('keeps a surrogate pair as one character', () => {
    expect(canonicalJson('🎉')).toBe('"🎉"');
    expect(canonicalJsonBytes('🎉')).toEqual(new TextEncoder().encode('"🎉"'));
  });

  it('passes a lone surrogate through, where JSON.stringify escapes it', () => {
    // The one place this implementation must not delegate. RFC 8785 treats the input as UTF-16
    // code units and escapes only control characters, `"` and `\`; ES2019's well-formed
    // `JSON.stringify` emits `\udXXX`. Lone surrogates reach this product for real — a platform
    // that truncated a message mid-emoji — and a canonicalizer that disagreed with itself about
    // them would produce two hashes for one value.
    expect(JSON.stringify(LONE_HIGH_SURROGATE)).toBe('"\\ud83c"');
    expect(canonicalJson(LONE_HIGH_SURROGATE)).toBe(`"${LONE_HIGH_SURROGATE}"`);
  });

  it('escapes a control character inside a key as well as a value', () => {
    expect(canonicalJson({ '\n': 1 })).toBe('{"\\n":1}');
  });
});

describe('what it refuses', () => {
  it('refuses undefined inside an object rather than dropping the key', () => {
    // `JSON.stringify({ a: undefined })` is `{}`, so `{ a: undefined }` and `{}` would hash
    // identically. Two objects a developer wrote differently should not become one value silently.
    expect(() => canonicalJson({ a: undefined } as unknown as CanonicalValue)).toThrow(
      /Omit the key or give it an explicit null/,
    );
    expect(JSON.stringify({ a: undefined })).toBe('{}');
  });

  it('refuses a bigint, and says to decide the encoding once', () => {
    expect(() => canonicalJson(1n as unknown as CanonicalValue)).toThrow(
      /Serialise it as a string/,
    );
  });

  it('refuses a function and a symbol', () => {
    expect(() => canonicalJson((() => 1) as unknown as CanonicalValue)).toThrow(BugError);
    expect(() => canonicalJson(Symbol('x') as unknown as CanonicalValue)).toThrow(BugError);
  });

  it('names what it found, so a deep bad value is findable', () => {
    // The sentinel, not `expect.unreachable` inside the `try`: that throws **into this same
    // `catch`**, and its own message said "Infinity should be refused", which satisfied
    // `toContain('Infinity')`. So the test passed whether or not `canonicalJson` refused anything.
    // Found by the M1 independent review. The rule that now keeps this from coming back is
    // `scripts/hygiene/unreachable-policy.ts`.
    let caught: unknown;
    try {
      canonicalJson({ a: { b: Number.POSITIVE_INFINITY } } as CanonicalValue);
    } catch (error) {
      caught = error;
    }
    expect(caught, 'Infinity must be refused').toBeInstanceOf(BugError);
    expect((caught as Error).message).toContain('Infinity');
    expect((caught as Error).message).toContain('$.a.b');
  });

  it('names the path for an undefined, which has no value to print', () => {
    try {
      canonicalJson({ a: { b: undefined } } as unknown as CanonicalValue);
      expect.unreachable('undefined should be refused');
    } catch (error) {
      expect((error as Error).message).toContain('$.a.b');
    }
  });
});

describe('structure', () => {
  it('emits no whitespace anywhere', () => {
    const value = { a: [1, 2, { b: 'c' }], d: null };
    expect(canonicalJson(value)).toBe('{"a":[1,2,{"b":"c"}],"d":null}');
  });

  it('handles an empty object and an empty array', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });

  it('is idempotent: canonicalising the parsed output reproduces it', { tags: ['prop'] }, () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }) as fc.Arbitrary<CanonicalValue>, (value) => {
        const once = canonicalJson(value);
        const twice = canonicalJson(JSON.parse(once) as CanonicalValue);
        expect(twice).toBe(once);
      }),
      fcConfig(),
    );
  });

  it('is stable under key permutation', { tags: ['prop'] }, () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.jsonValue({ maxDepth: 2 }) as fc.Arbitrary<CanonicalValue>, {
          maxKeys: 8,
        }),
        (record) => {
          const shuffled = Object.fromEntries(Object.entries(record).reverse()) as Record<
            string,
            CanonicalValue
          >;
          expect(canonicalJson(shuffled)).toBe(canonicalJson(record));
        },
      ),
      fcConfig(),
    );
  });

  it('produces output that is always valid JSON', { tags: ['prop'] }, () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }) as fc.Arbitrary<CanonicalValue>, (value) => {
        expect(() => JSON.parse(canonicalJson(value))).not.toThrow();
      }),
      fcConfig(),
    );
  });
});

describe('canonicalJsonBytes', () => {
  it('is the UTF-8 encoding of the canonical form', () => {
    // §3.3: it is bytes that get hashed, and a caller who encoded as UTF-16 would produce a chain
    // that verifies on one platform and not another.
    const value = { note: '€' };
    expect(canonicalJsonBytes(value)).toEqual(new TextEncoder().encode(canonicalJson(value)));
  });

  it('is multi-byte for non-ASCII, which is what makes the encoding matter', () => {
    expect(canonicalJsonBytes('€').length).toBeGreaterThan(canonicalJson('€').length);
  });
});
