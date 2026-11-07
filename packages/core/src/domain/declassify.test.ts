/**
 * `DeclassApproverSchema` (`03` §1743, `02` §3.3.2).
 *
 * The union's two arms record two different facts, and the test that matters is that they stay
 * distinguishable: an empty member list means "nobody approved this", while `'policy:GS'` means
 * "the group approved this class of flow in advance". Invariant **I2** asks for a *recorded*
 * declassification, so collapsing those would make an unapproved flow look authorised.
 */
import { describe, expect, it } from 'vitest';
import {
  DECLASS_APPROVERS_MAX,
  DeclassApproverSchema,
  POLICY_GROUP_STANDARD,
} from './declassify.js';

const SUFFIX = '01jqw8z5h7e9r3t4y5v6k7p8q9';
const memberId = (index: number) => `mbr_${SUFFIX.slice(0, 24)}${String(index).padStart(2, '0')}`;

describe('individual approvers', () => {
  it('accepts a list of member ids', () => {
    const approvers = [memberId(1), memberId(2)];
    expect(DeclassApproverSchema.parse(approvers)).toEqual(approvers);
  });

  it('accepts an empty list, which means nobody approved', () => {
    // Kept distinct from `'policy:GS'` on purpose; `03` §3.4.2 treats them differently.
    expect(DeclassApproverSchema.parse([])).toEqual([]);
  });

  it('accepts the maximum, one owner plus 64 co-owners', () => {
    const approvers = Array.from({ length: DECLASS_APPROVERS_MAX }, (_, i) => memberId(i));
    expect(DeclassApproverSchema.parse(approvers)).toHaveLength(DECLASS_APPROVERS_MAX);
  });

  it('refuses one more than the maximum', () => {
    const approvers = Array.from({ length: DECLASS_APPROVERS_MAX + 1 }, (_, i) => memberId(i));
    expect(DeclassApproverSchema.safeParse(approvers).success).toBe(false);
  });

  it('refuses a non-member id in the list', () => {
    expect(DeclassApproverSchema.safeParse([`prs_${SUFFIX}`]).success).toBe(false);
  });
});

describe('the group standard', () => {
  it('accepts the literal sentinel', () => {
    expect(DeclassApproverSchema.parse(POLICY_GROUP_STANDARD)).toBe('policy:GS');
  });

  it('refuses any other string', () => {
    for (const value of ['policy:gs', 'policy', 'GS', 'policy:XX', '']) {
      expect(DeclassApproverSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('refuses the sentinel inside the member list', () => {
    // The sentinel is an alternative to a member list, never a member of one: a mixed value would
    // mean "these members approved, and also the group standard did", which `03` does not define.
    expect(DeclassApproverSchema.safeParse([POLICY_GROUP_STANDARD]).success).toBe(false);
  });
});
