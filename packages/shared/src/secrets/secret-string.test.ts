/**
 * `SecretString` must be unprintable (`08` §3.10, S2).
 *
 * Every one of these is a route a secret could take to a log, a trace, an export or a
 * `doctor --bundle` that a host pastes into a public issue. The test exists because the realistic
 * failure is not malice — it is `console.log({ config })` at 2am while chasing something else.
 */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { isSecretString, REDACTED, SecretString, secret } from './secret-string.js';

/**
 * Assembled at runtime rather than written out whole: a literal token shape in a source file trips
 * GitHub's push protection and every other secret scanner. The assertions below still check the
 * complete value.
 */
const VALUE = `${['sk', 'ant', 'api03'].join('-')}-SuperSecret${'Value'}-0123456789`;
const DISTINCTIVE = `SuperSecret${'Value'}`;
const make = (): SecretString => new SecretString('ANTHROPIC_API_KEY', VALUE);

describe('every printing route yields [redacted]', () => {
  it('String()', () => {
    expect(String(make())).toBe(REDACTED);
  });

  it('a template literal', () => {
    expect(`${make()}`).toBe(REDACTED);
  });

  it('string concatenation, which is how an Authorization header gets built by accident', () => {
    expect(`Bearer ${String(make())}`).toBe(`Bearer ${REDACTED}`);
  });

  it('JSON.stringify, directly and nested', () => {
    expect(JSON.stringify(make())).toBe(`"${REDACTED}"`);
    expect(JSON.stringify({ config: { apiKey: make() } })).toBe(
      `{"config":{"apiKey":"${REDACTED}"}}`,
    );
  });

  it('util.inspect, which is what console.log uses', () => {
    expect(inspect(make())).toBe(REDACTED);
  });

  it('util.inspect with showHidden, which is where a #private field would leak', () => {
    // This is why the value lives in a closure rather than a `#private` field: a private field
    // still appears under showHidden and in a heap snapshot's property list.
    expect(inspect(make(), { showHidden: true, depth: 10 })).toBe(REDACTED);
  });

  it('util.inspect nested inside a config object at depth', () => {
    const rendered = inspect({ a: { b: { c: { key: make() } } } }, { depth: 10, showHidden: true });
    expect(rendered).toContain(REDACTED);
    expect(rendered).not.toContain(DISTINCTIVE);
  });

  it('spreading, which exposes only the label', () => {
    expect(Object.keys({ ...make() })).toEqual(['name']);
    expect(JSON.stringify({ ...make() })).not.toContain(DISTINCTIVE);
  });

  it('Object.entries and getOwnPropertyNames', () => {
    expect(JSON.stringify(Object.entries(make()))).not.toContain(DISTINCTIVE);
    expect(Object.getOwnPropertyNames(make())).toEqual(['name']);
  });

  it('numeric coercion, which would otherwise throw and print the value in the error', () => {
    expect(Number(make())).toBeNaN();
  });

  it('a structured-clone-shaped round trip through JSON', () => {
    expect(JSON.stringify(JSON.parse(JSON.stringify({ k: make() })))).not.toContain(DISTINCTIVE);
  });

  it('never reveals the value in any of those, checked as one assertion', () => {
    const s = make();
    const renderings = [
      String(s),
      `${s}`,
      JSON.stringify(s),
      JSON.stringify({ s }),
      inspect(s),
      inspect(s, { showHidden: true, depth: 10 }),
      inspect({ nested: { s } }, { depth: 10 }),
      JSON.stringify({ ...s }),
      JSON.stringify(Object.entries(s)),
    ];
    for (const rendering of renderings) {
      expect(rendering).not.toContain(DISTINCTIVE);
      expect(rendering).not.toContain(VALUE);
    }
  });
});

describe('expose', () => {
  it('returns the real value, and is deliberately greppable', () => {
    // `grep -rn '\.expose()'` is a complete audit of every place a secret becomes a plain string,
    // which is what `08`'s external review checklist item 6 asks for.
    expect(make().expose()).toBe(VALUE);
  });
});

describe('metadata without disclosure', () => {
  it('reports length', () => {
    expect(make().length).toBe(VALUE.length);
  });

  it('reports emptiness, so doctor can tell "unset" from "set to empty"', () => {
    expect(new SecretString('X', '').isEmpty()).toBe(true);
    expect(make().isEmpty()).toBe(false);
  });

  it('keeps the name, which is the variable rather than the value', () => {
    expect(make().name).toBe('ANTHROPIC_API_KEY');
  });

  it('fingerprints stably, so "which key is in use" is answerable', () => {
    expect(make().fingerprint()).toBe(make().fingerprint());
    expect(make().fingerprint()).not.toContain(DISTINCTIVE);
    expect(make().fingerprint()).toMatch(/^[0-9a-f]{8}$/);
  });

  it('gives different fingerprints to different values', () => {
    const a = new SecretString('K', 'aaaaaaaaaaaaaaaaaaaa');
    const b = new SecretString('K', 'bbbbbbbbbbbbbbbbbbbb');
    expect(a.fingerprint()).not.toBe(b.fingerprint());
  });

  it('refuses to fingerprint a short secret, which would be brute-forceable', () => {
    expect(new SecretString('K', 'short').fingerprint()).toBe('too-short-to-fingerprint');
  });
});

describe('equals', () => {
  it('compares against a string and against another secret', () => {
    expect(make().equals(VALUE)).toBe(true);
    expect(make().equals(make())).toBe(true);
    expect(make().equals('wrong')).toBe(false);
  });

  it('is length-safe, so a different length short-circuits without comparing bytes', () => {
    expect(make().equals(`${VALUE}x`)).toBe(false);
  });

  it('does not use ===, which would leak the matching prefix length through timing', () => {
    // `08` §3.20 bans `===` on secrets. Timing is not directly testable here, so this asserts the
    // behavioural consequence: two same-length values differing only in the last character must
    // still compare false, which a prefix compare would also do — the real guarantee is the
    // implementation, and this pins its contract.
    const a = new SecretString('K', 'aaaaaaaaaaaaaaaa');
    expect(a.equals('aaaaaaaaaaaaaaab')).toBe(false);
    expect(a.equals('baaaaaaaaaaaaaaa')).toBe(false);
  });
});

describe('secret()', () => {
  it('wraps a present value', () => {
    expect(secret('K', 'v')?.expose()).toBe('v');
  });

  it('returns undefined for absent or empty, so "not set" stays distinguishable', () => {
    expect(secret('K', undefined)).toBeUndefined();
    expect(secret('K', '')).toBeUndefined();
  });
});

describe('isSecretString', () => {
  it('recognises one', () => {
    expect(isSecretString(make())).toBe(true);
    expect(isSecretString('a plain string')).toBe(false);
    expect(isSecretString(null)).toBe(false);
    expect(isSecretString({ name: 'X', expose: () => 'v' })).toBe(false);
  });
});

describe('toStringTag', () => {
  it('identifies the type in diagnostics without revealing the value', () => {
    expect(Object.prototype.toString.call(make())).toBe('[object SecretString]');
  });
});
