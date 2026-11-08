/**
 * `MemoryContent` (`04` §3.2.2).
 *
 * Six kinds, and the tests that matter are the ones where the *typing* is the point: a profile
 * timezone that is a validated zone, a digest bullet that must cite something, a commitment that
 * must have a committer.
 */
import { describe, expect, it } from 'vitest';
import {
  MEMORY_CONTENT_MAX_BYTES,
  MemoryContentSchema,
  MULTI_VALUED_PROFILE_FIELDS,
  ProfileFieldSchema,
} from './kinds.js';

const MEMBER_ID = 'mbr_01jqw8z5h7e9r3t4y5v6k7p8q9';
const OTHER_MEMBER = 'mbr_01jqw8z5h7e9r3t4y5v6k7p8qa';
const MEMORY_ID = 'mem_01jqw8z5h7e9r3t4y5v6k7p8q9';
const TASK_ID = 'tsk_01jqw8z5h7e9r3t4y5v6k7p8q9';
const DECISION_ID = 'dec_01jqw8z5h7e9r3t4y5v6k7p8q9';

describe('the six kinds', () => {
  it('accepts a fact, including a negated one', () => {
    const value = {
      kind: 'fact' as const,
      attribute: 'wifi.network',
      value: 'Starlink-2G',
      polarity: 'affirm' as const,
    };
    expect(MemoryContentSchema.parse(value)).toEqual(value);
    // A negated fact is a fact about what is *not* so, which is not the same as having no fact.
    expect(MemoryContentSchema.safeParse({ ...value, polarity: 'negate' }).success).toBe(true);
  });

  it('accepts a preference held by the group', () => {
    const value = {
      kind: 'preference' as const,
      holder: { type: 'group' as const },
      stance: 'avoids' as const,
      object: 'meetings before 10am',
      strength: 'strong' as const,
      context: null,
    };
    expect(MemoryContentSchema.parse(value)).toEqual(value);
  });

  it('accepts a decision with its rationale and rejected alternatives', () => {
    const value = {
      kind: 'decision' as const,
      summary: 'Rent a van rather than two cars',
      rationale: 'One driver, and the dog fits',
      alternativesRejected: [{ option: 'Two cars', reason: 'Nobody wanted to convoy' }],
      decidedBy: { rule: 'consensus' as const, memberIds: [MEMBER_ID, OTHER_MEMBER] },
      decidedAt: '2026-11-06T19:04:00Z',
      scope: 'spring trip',
      revisitAt: null,
      decisionId: DECISION_ID,
    };
    expect(MemoryContentSchema.parse(value)).toEqual(value);
  });

  it('requires a commitment to have at least one committer', () => {
    const base = {
      kind: 'commitment' as const,
      what: 'pick up the kids',
      byWhen: null,
      toWhom: [],
      conditional: null,
      fulfillment: 'open' as const,
      taskId: TASK_ID,
    };
    // `toBeDefined()` was the whole assertion, which any successful parse satisfies — so nothing
    // checked that `who` survived or that the rest of the payload was not quietly reshaped. A zod
    // object strips unknown keys silently, which is exactly the kind of change this would have
    // missed. Found by the M1 independent review.
    expect(MemoryContentSchema.parse({ ...base, who: [MEMBER_ID] })).toEqual({
      ...base,
      who: [MEMBER_ID],
    });
    // A commitment nobody made is not a commitment — it is the thing proactivity would then chase.
    expect(MemoryContentSchema.safeParse({ ...base, who: [] }).success).toBe(false);
  });

  it('requires every digest bullet to cite at least one memory', () => {
    const digest = (refs: string[]) => ({
      kind: 'note' as const,
      noteType: 'member_digest' as const,
      title: 'This week',
      body: 'Three things happened.',
      derivedFrom: [MEMORY_ID],
      sections: [{ heading: 'Trip', bullets: [{ text: 'Van booked', refs }] }],
    });
    expect(MemoryContentSchema.parse(digest([MEMORY_ID]))).toEqual(digest([MEMORY_ID]));
    // An unattributed bullet in a digest is a claim with no provenance, which is what `00` §6.1's
    // provenance promise exists to prevent.
    expect(MemoryContentSchema.safeParse(digest([])).success).toBe(false);
  });

  it('accepts a note with no sections', () => {
    expect(
      MemoryContentSchema.safeParse({
        kind: 'note',
        noteType: 'general',
        title: null,
        body: 'The spare key is under the third pot.',
        derivedFrom: [],
        sections: null,
      }).success,
    ).toBe(true);
  });
});

describe('profile fields are typed, not stringly', () => {
  const profile = (value: unknown) => ({
    kind: 'profile' as const,
    memberId: MEMBER_ID,
    field: 'timezone' as const,
    value,
  });

  it('validates and canonicalises a timezone', () => {
    const parsed = MemoryContentSchema.parse(profile({ field: 'timezone', tz: 'asia/kathmandu' }));
    expect(parsed).toMatchObject({ value: { tz: 'Asia/Kathmandu' } });
  });

  it('refuses a timezone the platform does not know', () => {
    // The reason this field is typed: `07`'s scheduling reads it directly, so a bad zone here is a
    // reminder that never fires rather than a string that looks wrong in a UI.
    expect(
      MemoryContentSchema.safeParse(profile({ field: 'timezone', tz: 'Mars/Base' })).success,
    ).toBe(false);
  });

  it('allows a birthday with no year', () => {
    // Birthdays are routinely shared without one, and guessing is worse than not knowing.
    expect(
      MemoryContentSchema.safeParse({
        kind: 'profile',
        memberId: MEMBER_ID,
        field: 'birthday',
        value: { field: 'birthday', month: 3, day: 9, year: null },
      }).success,
    ).toBe(true);
  });

  it('refuses an impossible month', () => {
    expect(
      MemoryContentSchema.safeParse({
        kind: 'profile',
        memberId: MEMBER_ID,
        field: 'birthday',
        value: { field: 'birthday', month: 13, day: 9, year: null },
      }).success,
    ).toBe(false);
  });

  it('requires a relationship value to name a known relation kind', () => {
    const relationship = (relation: string) => ({
      kind: 'profile' as const,
      memberId: MEMBER_ID,
      field: 'relationship' as const,
      value: { field: 'relationship', to: { type: 'group' }, relation },
    });
    expect(MemoryContentSchema.safeParse(relationship('sibling')).success).toBe(true);
    expect(MemoryContentSchema.safeParse(relationship('acquaintance')).success).toBe(false);
  });

  it('does NOT check that the inner field matches the outer one — a known gap', () => {
    // Worth an explicit test because it is easy to assume otherwise. `field` and `value.field` are
    // two independent discriminators, so a `timezone` field carrying a `locale` payload parses.
    // zod cannot express the correlation without a refinement, and `04` §3.2.2 does not ask for
    // one; the repository checks the pairing (`M1-T18`). Asserting the current behaviour means
    // closing the gap later will fail here and be noticed, rather than silently making a comment
    // stale.
    expect(
      MemoryContentSchema.safeParse({
        kind: 'profile',
        memberId: MEMBER_ID,
        field: 'timezone',
        value: { field: 'locale', locale: 'en-GB' },
      }).success,
    ).toBe(true);
  });

  it('lists the multi-valued fields 04 §3.2.2 names', () => {
    // Someone has one timezone and possibly three allergies, so these accumulate while every
    // other field supersedes.
    expect([...MULTI_VALUED_PROFILE_FIELDS].sort()).toEqual([
      'allergy',
      'languages',
      'relationship',
      'schedule',
    ]);
    for (const field of MULTI_VALUED_PROFILE_FIELDS) {
      expect(ProfileFieldSchema.options).toContain(field);
    }
  });
});

describe('the 8 KiB column cap (02 §3.3.9)', () => {
  it('cannot be reached by a note body alone, because the field cap is lower', () => {
    // **Measured.** `body` is capped at 8 000 characters, and the whole serialised note is then
    // about 8 095 bytes — under the 8 KiB column cap. So the two bounds do not overlap for prose,
    // and the byte cap binds on the *reference arrays* instead. The same interaction as
    // `RICH_TEXT_MAX_NODES` and its byte cap: a field bound and a column bound can each be alive
    // for different inputs, and testing only the obvious one leaves the other unexercised.
    expect(MEMORY_CONTENT_MAX_BYTES).toBe(8192);
    expect(
      MemoryContentSchema.safeParse({
        kind: 'note',
        noteType: 'general',
        title: null,
        body: 'x'.repeat(8000),
        derivedFrom: [],
        sections: null,
      }).success,
    ).toBe(true);
  });

  it('rejects a consolidation that cites too many memories to fit', () => {
    // `derivedFrom` allows 500 memory ids and each is 30 characters, so a maximal consolidation is
    // ~16.5 KB of JSON. This is the input the column cap actually stops.
    const ids = Array.from(
      { length: 500 },
      (_, index) => `mem_01jqw8z5h7e9r3t4y5v6k7${String(index).padStart(2, '0')}`,
    );
    const outcome = MemoryContentSchema.safeParse({
      kind: 'note',
      noteType: 'group_story',
      title: 'The year so far',
      body: 'A summary.',
      derivedFrom: ids,
      sections: null,
    });
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.error.issues.some((issue) => issue.message.includes('8192-byte limit'))).toBe(
      true,
    );
  });
});

describe('the discriminator', () => {
  it('refuses an unknown kind', () => {
    expect(MemoryContentSchema.safeParse({ kind: 'rumour', text: 'x' }).success).toBe(false);
  });
});
