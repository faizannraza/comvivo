/**
 * The membership domain rules (`02` §3.3.1).
 *
 * These are pure functions in `core`, so they are tested here rather than through storage. The two
 * that carry the most weight are `ageBandMatchesRole` — a constraint `03`'s policy engine reads
 * from two directions — and `conversationShapeError`, which turns two CHECK constraints into
 * sentences before a write reaches them.
 */

import type { GroupId, MemberId, PersonId, TimeZoneId } from '@comvivo/shared';
import { UTC } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import {
  AGE_BANDS,
  ageBandMatchesRole,
  CONSENTS,
  conversationShapeError,
  defaultAgeBand,
  MEMBER_ROLES,
  newChannelIdentitySchema,
  newGroupSchema,
  newPersonSchema,
  resolveLocale,
  resolveTimeZone,
} from './membership.js';

const GROUP = 'grp_01jmem00000000000000000001' as GroupId;
const MEMBER = 'mbr_01jmem00000000000000000001' as MemberId;
const PERSON = 'prs_01jmem00000000000000000001' as PersonId;
const WARSAW = 'Europe/Warsaw' as TimeZoneId;

describe('ageBandMatchesRole (members_ageband_ck)', () => {
  it('ties the child role and a non-adult band together in both directions', () => {
    // `(role = 'child') = (ageBand <> 'adult')` reads oddly until said aloud: the child **role**
    // and a non-adult **age band** imply each other. `03`'s guardian approval keys off the role
    // while its content rules key off the band, so letting them disagree would mean a minor
    // handled as an adult by one half of the policy engine and as a child by the other.
    expect(ageBandMatchesRole('child', 'child')).toBe(true);
    expect(ageBandMatchesRole('child', 'teen')).toBe(true);
    expect(ageBandMatchesRole('child', 'adult')).toBe(false);
    expect(ageBandMatchesRole('member', 'adult')).toBe(true);
    expect(ageBandMatchesRole('admin', 'adult')).toBe(true);
    expect(ageBandMatchesRole('guest', 'adult')).toBe(true);
    // An adult guest cannot borrow a teen's protections.
    expect(ageBandMatchesRole('guest', 'teen')).toBe(false);
    expect(ageBandMatchesRole('member', 'child')).toBe(false);
  });

  it('agrees with `defaultAgeBand` for every role', () => {
    // The default must always satisfy the constraint, or a caller that supplied no band would
    // write a row the CHECK refuses — which is the one case the default exists to prevent.
    for (const role of MEMBER_ROLES) {
      expect(ageBandMatchesRole(role, defaultAgeBand(role)), role).toBe(true);
    }
  });

  it('defaults a child to the most protective band', () => {
    // `child`, not `teen`: `03`'s protections are strongest for the youngest band, and the safe
    // direction for a missing answer is the more protective one.
    expect(defaultAgeBand('child')).toBe('child');
    expect(defaultAgeBand('member')).toBe('adult');
  });

  it('covers every declared band, so a new one cannot be added unnoticed', () => {
    // A non-vacuity check on the enum rather than on the function: if `AGE_BANDS` grew a value,
    // the pairs above would no longer be exhaustive and this count would say so.
    expect([...AGE_BANDS]).toEqual(['adult', 'teen', 'child']);
    expect([...MEMBER_ROLES]).toEqual(['admin', 'member', 'child', 'guest']);
  });
});

describe('consent', () => {
  it('defaults to a value that is not permission', () => {
    // `unknown` first, and `04` treats anything short of `memory_on` as "do not extract" — so the
    // absence of an answer never reads as yes.
    expect(CONSENTS[0]).toBe('unknown');
    expect([...CONSENTS]).toEqual(['unknown', 'informed', 'memory_on', 'memory_off']);
  });
});

describe('conversationShapeError (02 §3.3.1)', () => {
  it('requires a DM to name its member', () => {
    expect(conversationShapeError({ kind: 'dm' })).toBe('dm_needs_member');
    expect(conversationShapeError({ kind: 'dm', memberId: MEMBER })).toBeUndefined();
  });

  it('forbids a group conversation from naming one', () => {
    expect(conversationShapeError({ kind: 'group', memberId: MEMBER })).toBe('group_has_no_member');
    expect(conversationShapeError({ kind: 'group' })).toBeUndefined();
  });

  it('forbids a primary DM', () => {
    expect(conversationShapeError({ kind: 'dm', memberId: MEMBER, primary: true })).toBe(
      'primary_must_be_group',
    );
    expect(conversationShapeError({ kind: 'group', primary: true })).toBeUndefined();
  });

  it('returns the rule name rather than a boolean', () => {
    // So a caller can say *which* rule it broke without re-deriving it — the difference between
    // "that conversation is invalid" and "a DM conversation must name the member whose DM it is".
    expect(conversationShapeError({ kind: 'dm', primary: true })).toBe('dm_needs_member');
  });
});

describe('inheritance (02 §3.3.1, 07 SC-2)', () => {
  it("prefers the person's own zone and falls back to the group's", () => {
    expect(resolveTimeZone({ timezone: WARSAW }, { timezone: UTC })).toBe(WARSAW);
    // `undefined` on a person is spelled "inherit group" by `02` §3.3.1, so the fallback lives in
    // the data rather than in a default each caller would have to remember — and a reminder fired
    // in the wrong zone is the symptom of getting it wrong.
    expect(resolveTimeZone({ timezone: undefined }, { timezone: UTC })).toBe(UTC);
  });

  it('does the same for locale', () => {
    expect(resolveLocale({ locale: 'pl' }, { locale: 'en' })).toBe('pl');
    expect(resolveLocale({ locale: undefined }, { locale: 'en' })).toBe('en');
  });
});

describe('boundary schemas', () => {
  it('accepts a minimal group and fills nothing in', () => {
    const parsed = newGroupSchema.parse({
      id: GROUP,
      name: 'Nowak family',
      archetype: 'family',
      timezone: 'UTC',
    });
    expect(parsed.name).toBe('Nowak family');
    // The schema validates; it does not default. The *repository* applies `02` §3.3.1's defaults,
    // so there is one place they live rather than two that have to agree.
    expect(parsed.locale).toBeUndefined();
    expect(parsed.status).toBeUndefined();
  });

  it('normalises a timezone rather than only checking it', () => {
    const parsed = newGroupSchema.parse({
      id: GROUP,
      name: 'g',
      archetype: 'family',
      timezone: 'europe/warsaw',
    });
    // `timeZoneIdSchema` transforms, which is the only way `europe/warsaw` and `Europe/Warsaw`
    // cannot both end up in the database.
    expect(parsed.timezone).toBe('Europe/Warsaw');
  });

  it('refuses an archetype outside the closed set', () => {
    const result = newGroupSchema.safeParse({
      id: GROUP,
      name: 'g',
      archetype: 'startup',
      timezone: 'UTC',
    });
    // A value outside `ARCHETYPES` is a missing `03` template, not an extension point.
    expect(result.success).toBe(false);
  });

  it('refuses a malformed id, an empty name and a bad week start', () => {
    const base = { id: GROUP, name: 'g', archetype: 'family' as const, timezone: 'UTC' };
    expect(newGroupSchema.safeParse({ ...base, id: 'nope' }).success).toBe(false);
    expect(newGroupSchema.safeParse({ ...base, name: '' }).success).toBe(false);
    expect(newGroupSchema.safeParse({ ...base, weekStart: 0 }).success).toBe(false);
    expect(newGroupSchema.safeParse({ ...base, weekStart: 8 }).success).toBe(false);
    expect(newGroupSchema.safeParse({ ...base, weekStart: 1 }).success).toBe(true);
  });

  it('validates a person and a channel identity', () => {
    expect(newPersonSchema.safeParse({ id: PERSON, displayName: 'Ana' }).success).toBe(true);
    expect(newPersonSchema.safeParse({ id: PERSON, displayName: '' }).success).toBe(false);

    const identity = {
      id: 'chid_01jmem00000000000000000001',
      channel: 'telegram',
      platformUserId: 'u-1',
      personId: PERSON,
      displayNameSnapshot: 'Ana',
    };
    expect(newChannelIdentitySchema.safeParse(identity).success).toBe(true);
    // An instant at this boundary is an ISO string, parsed into a `Temporal.Instant`.
    const seen = newChannelIdentitySchema.parse({
      ...identity,
      lastSeenAt: '2026-11-08T12:00:00Z',
    });
    expect(seen.lastSeenAt?.epochMilliseconds).toBe(Date.UTC(2026, 10, 8, 12, 0, 0));
    expect(
      newChannelIdentitySchema.safeParse({ ...identity, lastSeenAt: 'tomorrow' }).success,
    ).toBe(false);
  });
});
