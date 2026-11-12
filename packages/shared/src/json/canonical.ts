/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * One serialisation per value, so a hash over JSON means something. Three places depend on it, and
 * each would fail silently without it:
 *
 *  - **The audit hash chain** (`02` §3.8). Each group has its own chain over canonical JSON, and
 *    `comvivo doctor --check audit` recomputes it. If the serialisation varied by key order, every
 *    verification would fail and the tamper signal would be worthless.
 *  - **`exportDomainState`** (`02` §4.1), which is how a test asserts that a backup restored the
 *    same state. Two structurally identical states have to hash identically or the assertion is
 *    about `JSON.stringify`'s insertion order, not about the data.
 *  - **Idempotency keys** (`02` §3.3.9, `turn_effects.idempotency_key`), which is invariant **I6
 *    (exactly-once intent)**. A key derived from a differently-ordered object is a different key,
 *    and the effect runs twice.
 *
 * The rules, from the RFC:
 *
 *  - object keys sorted by their **UTF-16 code units**, not by code point and not by locale;
 *  - numbers in ECMAScript `Number::toString` form, with `-0` serialised as `0`;
 *  - strings with the shortest escapes, and `\uXXXX` only where required;
 *  - no whitespace anywhere;
 *  - `NaN`, `Infinity`, `undefined`, functions and `bigint` are **refused**, not coerced.
 */
import { BugError } from '../errors.js';

/** A value this module will serialise. Everything else is a programming error. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

/**
 * The two-character escapes RFC 8785 §3.2.2.2 requires, in preference to `\uXXXX`.
 *
 * `/` is **not** escaped: the RFC escapes only what JSON requires, and a forward slash does not
 * require it. `JSON.stringify` agrees, which is why the string path below can lean on it.
 */
const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\f': '\\f',
  '\r': '\\r',
  '"': '\\"',
  '\\': '\\\\',
};

/**
 * Serialise a string per RFC 8785 §3.2.2.2.
 *
 * Written out rather than delegated to `JSON.stringify` because the two differ on **lone
 * surrogates**: `JSON.stringify` emits `\udXXX` escapes for them (since ES2019's well-formed
 * stringify), while the RFC treats the input as a sequence of UTF-16 code units and escapes only
 * control characters, `"` and `\`. Lone surrogates reach this product for real — a truncated
 * message from a platform that cut a string mid-emoji — and a canonicalizer that disagrees with
 * itself about them would produce two hashes for one value.
 */
function canonicalString(value: string): string {
  let out = '"';
  for (const char of splitCodeUnits(value)) {
    const short = SHORT_ESCAPES[char];
    if (short !== undefined) {
      out += short;
      continue;
    }
    const code = char.charCodeAt(0);
    // Everything below U+0020 that has no short escape is `\u00xx`. Everything else is literal,
    // including U+007F and the lone surrogates.
    out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : char;
  }
  return `${out}"`;
}

/** The string as UTF-16 code units, so a lone surrogate is one element rather than a replacement. */
function splitCodeUnits(value: string): string[] {
  const units: string[] = new Array<string>(value.length);
  for (let i = 0; i < value.length; i += 1) units[i] = value.charAt(i);
  return units;
}

/**
 * Serialise a number per RFC 8785 §3.2.2.3.
 *
 * The RFC's number format **is** ECMAScript's `Number::toString`, which is what `JSON.stringify`
 * produces — so delegating is the correct implementation rather than a shortcut, and it inherits
 * the platform's correctly-rounded shortest representation instead of reimplementing Ryū.
 *
 * Two deviations the RFC calls out and the platform does not:
 *
 *  - `-0` serialises as `0`. ECMAScript distinguishes them; the RFC does not, because JSON has one
 *    zero. Without this, `{ "x": -0 }` and `{ "x": 0 }` would hash differently, and the sign of a
 *    zero is never something a family's data depends on.
 *  - `NaN` and `±Infinity` are refused. `JSON.stringify` turns them into `null`, which would make
 *    a corrupt value silently canonical.
 */
function canonicalNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    // The path matters as much as the value. A caller canonicalising an audit row or a memory
    // envelope gets one `NaN` out of a hundred fields, and "cannot represent NaN" with no location
    // sends them reading the whole object. The bigint, undefined and function branches all name
    // their path; this one did not, which surfaced the moment the test covering it stopped being
    // satisfied by its own harness error (M1 independent review).
    throw new BugError(
      `canonical JSON cannot represent ${String(value)} at ${path}: RFC 8785 has no NaN or ` +
        'Infinity, and JSON.stringify would silently turn it into null',
    );
  }
  if (value === 0) return '0';
  return JSON.stringify(value);
}

/**
 * Sort keys by UTF-16 code unit, as RFC 8785 §3.2.3 requires.
 *
 * `Array.prototype.sort` with no comparator does exactly this. `localeCompare` would not, and is
 * the obvious wrong choice: it orders "ä" next to "a" in German and after "z" in Swedish, so the
 * hash of a family's data would depend on the host's locale.
 */
function sortedKeys(record: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(record).sort();
}

function canonicalize(value: unknown, path: string): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return canonicalNumber(value, path);
    case 'string':
      return canonicalString(value);
    case 'object':
      break;
    // Listed rather than defaulted, so a future JavaScript primitive is a compile error here
    // instead of a silent fall-through into "cannot represent". `JSON.stringify` drops the first
    // three of these from objects and throws on `bigint`; neither is acceptable when the output is
    // being hashed as evidence.
    case 'bigint':
      throw new BugError(
        `canonical JSON cannot represent a bigint at ${path}. ` +
          'Serialise it as a string, decide the encoding once, and write it down.',
      );
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new BugError(
        `canonical JSON cannot represent ${typeof value} at ${path}. ` +
          'Omit the key or give it an explicit null.',
      );
  }

  if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    return `[${items.map((item, index) => canonicalize(item, `${path}[${String(index)}]`)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = sortedKeys(record).map((key) => {
    const child = record[key];
    if (child === undefined) {
      // `JSON.stringify` drops these, which would make `{ a: undefined }` and `{}` hash the same.
      // Two objects that a developer wrote differently should not become one value silently.
      throw new BugError(
        `canonical JSON cannot represent undefined at ${path}.${key}. ` +
          'Omit the key or give it an explicit null — JSON.stringify would drop it and the two ' +
          'objects would hash identically.',
      );
    }
    return `${canonicalString(key)}:${canonicalize(child, `${path}.${key}`)}`;
  });
  return `{${entries.join(',')}}`;
}

/**
 * The RFC 8785 canonical form of `value`.
 *
 * Throws `BugError` on anything JSON cannot represent, rather than coercing. This is called where
 * the output is hashed and the hash is evidence, so a quietly-altered value is worse than a crash.
 */
export function canonicalJson(value: CanonicalValue): string {
  return canonicalize(value, '$');
}

/**
 * The UTF-8 bytes of the canonical form.
 *
 * RFC 8785 §3.3: the canonical form is UTF-8, and it is bytes that get hashed. Offered here so no
 * caller has to remember the encoding — getting it wrong produces a chain that verifies on one
 * platform and not another.
 */
export function canonicalJsonBytes(value: CanonicalValue): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
