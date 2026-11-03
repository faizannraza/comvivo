/**
 * The zod boundary helpers (`01` §11.2). What matters: a boundary failure is a `Result`, the error
 * text is something a host can act on, and the rejected value never leaks into the error — because
 * at most boundaries that value is message content, which `01` §11.7 forbids above debug level.
 */
import { describe, expect, it } from 'vitest';
import { ValidationError } from './errors.js';
import { brandedId, describeIssues, formatIssues, parse, parseOrThrow, z } from './zod.js';

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

describe('brandedId', () => {
  const groupId = brandedId('grp', 'GroupId');

  it('accepts a well-formed TypeID', () => {
    expect(groupId.safeParse('grp_01j8kqd7h3f9z2m4n6p8r0t2vw').success).toBe(true);
  });

  it.each([
    ['the wrong prefix', 'mbr_01j8kqd7h3f9z2m4n6p8r0t2vw'],
    ['no prefix', '01j8kqd7h3f9z2m4n6p8r0t2vw'],
    ['too short', 'grp_01j8kqd7h3f9z2m4n6p8r0t2v'],
    ['too long', 'grp_01j8kqd7h3f9z2m4n6p8r0t2vwx'],
    ['uppercase', 'grp_01J8KQD7H3F9Z2M4N6P8R0T2VW'],
    ['excluded base32 letters (i, l, o, u)', 'grp_01j8kqd7h3f9z2m4n6p8r0tiou'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(groupId.safeParse(value).success).toBe(false);
  });

  it('explains the expected shape, naming the entity', () => {
    const outcome = groupId.safeParse('nope');
    if (!outcome.success) {
      expect(outcome.error.issues[0]?.message).toContain('GroupId');
      expect(outcome.error.issues[0]?.message).toContain('grp_');
    }
  });

  it('keeps two entity ids mutually unassignable at compile time', () => {
    // The runtime value is just a string; the brand is what stops a MemberId reaching a parameter
    // that wants a GroupId. Operating on the wrong group IS invariant I4 failing, so this is the
    // bug class the brand exists to prevent.
    const memberId = brandedId('mbr', 'MemberId');
    const g = groupId.parse('grp_01j8kqd7h3f9z2m4n6p8r0t2vw');
    const m = memberId.parse('mbr_01j8kqd7h3f9z2m4n6p8r0t2vw');
    // @ts-expect-error a MemberId must not be assignable to a GroupId
    const wrong: typeof g = m;
    expect(typeof wrong).toBe('string');
  });
});
