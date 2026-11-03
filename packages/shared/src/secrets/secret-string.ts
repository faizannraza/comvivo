/**
 * `SecretString` — a value that cannot be printed by accident.
 *
 * `08` §3.10 (S2): secrets never reach the database, YAML, traces, exports or logs. Redaction in
 * the logger is one layer; this is the layer underneath, and it is the one that holds when somebody
 * writes `console.log({ config })` while debugging at 2am.
 *
 * Every route a string can take to a log or a trace is closed:
 *
 *   `String(secret)`            → `[redacted]`   (`toString`)
 *   `` `${secret}` ``           → `[redacted]`   (`Symbol.toPrimitive`)
 *   `JSON.stringify({secret})`  → `"[redacted]"` (`toJSON`)
 *   `console.log(secret)`       → `[redacted]`   (Node's inspect hook)
 *   `util.inspect(secret)`      → `[redacted]`   (same hook)
 *   `{...secret}` / `Object.keys` → nothing       (the value is in a closure, not a property)
 *
 * Reading the real value requires calling `.expose()`, which is deliberately ugly and greppable:
 * `grep -rn '\.expose()'` is a complete audit of every place a secret becomes a plain string, and
 * `08`'s pre-1.0 external review checklist (item 6) asks for exactly that list.
 *
 * `Symbol.for('nodejs.util.inspect.custom')` is used rather than importing `node:util`, so this
 * module stays free of `node:*` and can be used by anything, including the browser demo.
 */

/** What every printing route yields. Chosen to be obvious in a log, and to never look like a value. */
export const REDACTED = '[redacted]' as const;

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export class SecretString {
  /** A label for diagnostics: which secret this is, never what it contains. */
  readonly name: string;

  /**
   * The value lives in a closure rather than a field — even a `#private` one — because a private
   * field still shows up under `util.inspect(obj, { showHidden: true })` and in a heap snapshot's
   * property list. A closure does not.
   */
  readonly #read: () => string;

  constructor(name: string, value: string) {
    this.name = name;
    const captured = value;
    this.#read = () => captured;
  }

  /**
   * The real value. Call only at the moment of use — building an `Authorization` header, opening a
   * database — and never assign the result to anything longer-lived than that expression.
   */
  expose(): string {
    return this.#read();
  }

  /** Length without revealing content, for a "key looks too short" diagnostic. */
  get length(): number {
    return this.#read().length;
  }

  /** Is it empty? Lets `doctor` distinguish "not set" from "set to an empty string". */
  isEmpty(): boolean {
    return this.#read().length === 0;
  }

  /**
   * Constant-time comparison against another secret.
   *
   * `===` on secrets is a lint ban in `08` §3.20 for a reason: a short-circuiting compare leaks the
   * length of the matching prefix through timing, which is enough to recover a token one character
   * at a time. Lengths are allowed to leak (they are not secret, and hiding them would require
   * padding every comparison).
   */
  equals(other: SecretString | string): boolean {
    const mine = this.#read();
    const theirs = typeof other === 'string' ? other : other.expose();
    if (mine.length !== theirs.length) return false;
    let diff = 0;
    for (let i = 0; i < mine.length; i += 1) {
      diff |= mine.charCodeAt(i) ^ theirs.charCodeAt(i);
    }
    return diff === 0;
  }

  /**
   * A stable, non-reversible fingerprint, for logging *which* key is in use without logging it.
   *
   * FNV-1a, not a cryptographic hash: this is a diagnostic aid, not an authenticator, and saying so
   * here stops someone later treating it as one. Short secrets are not fingerprinted at all,
   * because a fingerprint over a tiny space is brute-forceable.
   */
  fingerprint(): string {
    const value = this.#read();
    if (value.length < 16) return 'too-short-to-fingerprint';
    let hash = 0x811c_9dc5;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 0x0100_0193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /** `console.log` and `util.inspect`. */
  [INSPECT](): string {
    return REDACTED;
  }

  /** String and number coercion, including template literals. */
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return 'SecretString';
  }
}

/** Wrap a value, or return `undefined` when it is absent or empty. */
export function secret(name: string, value: string | undefined): SecretString | undefined {
  if (value === undefined || value === '') return undefined;
  return new SecretString(name, value);
}

export function isSecretString(value: unknown): value is SecretString {
  return value instanceof SecretString;
}
