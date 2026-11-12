/**
 * The two rules the governance aggregates carry as functions (`02` §3.3.6; `03`).
 *
 * Both exist because their halves are easy to check separately and forget to combine, so each test
 * here pins a *combination* rather than a single condition.
 */
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { constraintInForce, quorumSatisfied } from './aggregates.js';

const compare = Temporal.Instant.compare;
const at = (iso: string) => Temporal.Instant.from(iso);
const NOW = at('2026-11-11T12:00:00Z');

const MEMBER_A = 'mbr_01jqw8z5h7e9r3t4y5v6k7p8q9' as never;
const MEMBER_B = 'mbr_01jqw8z5h7e9r3t4y5v6k7p8qa' as never;

describe('constraintInForce (03 §3.5)', () => {
  const window = {
    status: 'active' as const,
    validFrom: at('2026-11-01T00:00:00Z'),
    validTo: at('2026-12-01T00:00:00Z'),
  };

  it('needs the status and the window to agree', () => {
    expect(constraintInForce(window, NOW, compare)).toBe(true);
    // `suspended` inside its window is the half that is easiest to miss: the row looks live, and a
    // scheduler reading only the dates would keep obeying a constraint the member paused.
    expect(constraintInForce({ ...window, status: 'suspended' }, NOW, compare)).toBe(false);
    expect(constraintInForce({ ...window, status: 'pending_owner' }, NOW, compare)).toBe(false);
    expect(constraintInForce({ ...window, status: 'revoked' }, NOW, compare)).toBe(false);
  });

  it('treats an open-ended constraint as in force', () => {
    // Most constraints have no end date — "cannot do Tuesdays" is not a booking. Requiring one
    // would make the common case the excluded case.
    expect(constraintInForce({ ...window, validTo: undefined }, NOW, compare)).toBe(true);
  });

  it('is inclusive at both edges', () => {
    // A constraint that starts at noon applies at noon, and one that ends at noon still applies
    // then: an exclusive edge would leave a one-instant gap that a scheduler could book into.
    expect(constraintInForce({ ...window, validFrom: NOW }, NOW, compare)).toBe(true);
    expect(constraintInForce({ ...window, validTo: NOW }, NOW, compare)).toBe(true);
    expect(
      constraintInForce({ ...window, validFrom: at('2026-11-11T12:00:00.001Z') }, NOW, compare),
    ).toBe(false);
    expect(
      constraintInForce({ ...window, validTo: at('2026-11-11T11:59:59.999Z') }, NOW, compare),
    ).toBe(false);
  });
});

describe('quorumSatisfied (03 §3.3.12)', () => {
  it('is satisfied by one approval when the quorum is `any`', () => {
    const request = { quorum: 'any' as const, eligibleMemberIds: [MEMBER_A, MEMBER_B] };
    expect(quorumSatisfied(request, [])).toBe(false);
    expect(quorumSatisfied(request, [MEMBER_A])).toBe(true);
  });

  it('needs every eligible member when the quorum is `all`', () => {
    const request = { quorum: 'all' as const, eligibleMemberIds: [MEMBER_A, MEMBER_B] };
    expect(quorumSatisfied(request, [MEMBER_A])).toBe(false);
    expect(quorumSatisfied(request, [MEMBER_A, MEMBER_B])).toBe(true);
    // Duplicates do not make a quorum: two taps from one guardian are one approval.
    expect(quorumSatisfied(request, [MEMBER_A, MEMBER_A])).toBe(false);
    // An approval from somebody not eligible does not count towards it either.
    expect(quorumSatisfied({ ...request, eligibleMemberIds: [MEMBER_A] }, [MEMBER_B])).toBe(false);
  });

  it('is never satisfied by an empty electorate under `all`', () => {
    // `every` over an empty array is vacuously true, which would turn "everyone must agree" into
    // "nobody needs to" — the strictest quorum becoming the weakest. The length check is what
    // stops a request that named no deciders from authorising itself.
    expect(quorumSatisfied({ quorum: 'all', eligibleMemberIds: [] }, [])).toBe(false);
    expect(quorumSatisfied({ quorum: 'all', eligibleMemberIds: [] }, [MEMBER_A])).toBe(false);
  });
});
