/**
 * The zod boundary helpers (`01` §11.2). What matters: a boundary failure is a `Result`, the error
 * text is something a host can act on, and the rejected value never leaks into the error — because
 * at most boundaries that value is message content, which `01` §11.7 forbids above debug level.
 */
import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors.js';
import { capped, describeIssues, formatIssues, parse, parseOrThrow, z } from './zod.js';

const person = z.object({ name: z.string().min(1), age: z.number().int().positive() });

describe('parse', () => {
  it('returns the parsed value on success', () => {
    const result = parse(person, { name: 'Ada', age: 36 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ name: 'Ada', age: 36 });
  });

  it('returns a ValidationError rather than throwing', () => {
    const result = parse(person, { name: '', age: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
  });

  it('reports every problem, not just the first', () => {
    const result = parse(person, { name: '', age: -1 });
    if (!result.ok) expect(result.error.issues).toHaveLength(2);
  });

  it('does NOT put the rejected value in the error', () => {
    // The value at most boundaries is message content. `01` §11.7 forbids it above debug level, and
    // an error object travels straight into logs — so the paths and messages have to be enough.
    const secret = { name: '', age: 1, note: 'the recital is a surprise' };
    const result = parse(person.strict(), secret);
    if (!result.ok) {
      const serialised = JSON.stringify({
        message: result.error.message,
        issues: result.error.issues,
        detail: result.error.detail,
      });
      expect(serialised).not.toContain('surprise');
    }
  });

  it('has a user message that does not leak internals', () => {
    const result = parse(person, {});
    if (!result.ok)
      expect(result.error.userMessage).toBe('That did not look like something I understand.');
  });
});

describe('formatIssues and describeIssues', () => {
  it('gives a dotted path per issue', () => {
    const outcome = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } });
    expect(outcome.success).toBe(false);
    if (!outcome.success) expect(formatIssues(outcome.error)[0]?.path).toBe('a.b');
  });

  it('labels a whole-value problem as (root) rather than an empty string', () => {
    const outcome = z.string().safeParse(42);
    if (!outcome.success) expect(formatIssues(outcome.error)[0]?.path).toBe('(root)');
  });

  it('describes problems as indented lines a host can read', () => {
    const outcome = person.safeParse({ name: '', age: 'x' });
    if (!outcome.success) {
      const text = describeIssues(outcome.error, 'the configuration file');
      expect(text).toContain('2 problems in the configuration file');
      expect(text).toMatch(/\n {2}name: /);
    }
  });

  it('says "problem" for one and "problems" for several', () => {
    const one = z.object({ a: z.string() }).safeParse({ a: 1 });
    if (!one.success) expect(describeIssues(one.error)).toContain('1 problem in');
  });
});

describe('parseOrThrow', () => {
  it('returns the value when valid', () => {
    expect(parseOrThrow(person, { name: 'Ada', age: 36 }).name).toBe('Ada');
  });

  it('throws a ValidationError naming the subject, for values we built ourselves', () => {
    expect(() => parseOrThrow(person, {}, 'a row from the members table')).toThrow(
      /a row from the members table/,
    );
  });
});

describe('capped (02 §3.3.9 JSON column size limits)', () => {
  it('accepts a value within the limit', () => {
    const schema = capped(z.object({ a: z.string() }), 1024, 'thing');
    expect(schema.parse({ a: 'hello' })).toEqual({ a: 'hello' });
  });

  it('rejects a value over the limit, naming the subject and both numbers', () => {
    const schema = capped(z.object({ a: z.string() }), 64, 'rich text');
    const outcome = schema.safeParse({ a: 'x'.repeat(200) });
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    const [issue] = outcome.error.issues;
    expect(issue?.message).toContain('rich text');
    expect(issue?.message).toContain('64-byte limit');
    expect(issue?.code).toBe('too_big');
  });

  it('measures the serialised form, not the string inside it', () => {
    // The bound has to be on `JSON.stringify(value)` because that is exactly what `jsonOf` hands
    // the driver. A 60-character string is within a 64-byte budget on its own and over it once the
    // surrounding `{"a":"…"}` is counted, which is the case a naive `value.a.length` check misses.
    const schema = capped(z.object({ a: z.string() }), 64, 'thing');
    expect(schema.safeParse({ a: 'x'.repeat(50) }).success).toBe(true);
    expect(schema.safeParse({ a: 'x'.repeat(60) }).success).toBe(false);
  });

  it('counts UTF-8 bytes rather than characters', () => {
    // **Why the cap cannot be a SQLite `CHECK (length(col) <= n)`.** SQLite's `length()` counts
    // characters for text, so a column of emoji would be allowed four times past its byte budget.
    // `'🎉'` is one `JSON.stringify` character-pair and four UTF-8 bytes.
    const schema = capped(z.array(z.string()), 32, 'thing');
    // `["🎉","🎉","🎉","🎉"]` is 4 × 4 bytes of emoji plus 15 bytes of punctuation = 31.
    expect(schema.safeParse(['🎉', '🎉', '🎉', '🎉']).success).toBe(true);
    expect(schema.safeParse(['🎉', '🎉', '🎉', '🎉', '🎉']).success).toBe(false);
  });

  it('is exact at the boundary, inclusive', () => {
    // `{"a":"xxx"}` is 11 bytes.
    const schema = capped(z.object({ a: z.string() }), 11, 'thing');
    expect(schema.safeParse({ a: 'xxx' }).success).toBe(true);
    expect(schema.safeParse({ a: 'xxxx' }).success).toBe(false);
  });

  it('applies the cap after the schema, so a malformed value reports its own problem', () => {
    const schema = capped(z.object({ a: z.string() }), 8, 'thing');
    const outcome = schema.safeParse({ a: 42 });
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    // Not "over the 8-byte limit": the value never parsed, so the cap never ran.
    expect(outcome.error.issues.map((issue) => issue.code)).toEqual(['invalid_type']);
  });

  it('keeps the schema type, so a capped object schema is still composable', () => {
    // The reason `capped` returns `S` and not a widened `ZodType`.
    const base = capped(z.object({ a: z.string() }), 1024, 'thing');
    const extended = base.extend({ b: z.number() });
    expect(extended.parse({ a: 'x', b: 1 })).toEqual({ a: 'x', b: 1 });
  });

  it('runs on the way back out as well, which is what catches a row from an older build', () => {
    // `jsonOf` validates both directions, so a row written when the cap was larger is caught as a
    // damaged row rather than read back into a context window it no longer fits.
    const schema = capped(z.object({ a: z.string() }), 16, 'thing');
    const fromDisk: unknown = JSON.parse(JSON.stringify({ a: 'x'.repeat(100) }));
    expect(schema.safeParse(fromDisk).success).toBe(false);
  });
});
