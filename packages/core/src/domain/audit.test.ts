/**
 * `AuditActorSchema` (`02` §3.3.6's inline shape).
 *
 * The three arms exist because `08`'s audit story needs to distinguish a person acting inside the
 * group's governance, the product acting on its own, and whoever runs the server acting from
 * outside it. A union that collapsed any two would make the audit log less readable in exactly the
 * case a reader most needs it.
 */
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTOR_MAX_BYTES, AuditActorSchema } from './audit.js';

const MEMBER_ID = 'mbr_01jqw8z5h7e9r3t4y5v6k7p8q9';

describe('the three arms', () => {
  it('accepts an attributable member action', () => {
    expect(AuditActorSchema.parse({ kind: 'member', memberId: MEMBER_ID })).toEqual({
      kind: 'member',
      memberId: MEMBER_ID,
    });
  });

  it('accepts a system action, which carries no id', () => {
    expect(AuditActorSchema.parse({ kind: 'system' })).toEqual({ kind: 'system' });
  });

  it('accepts a host action', () => {
    expect(AuditActorSchema.parse({ kind: 'host' })).toEqual({ kind: 'host' });
  });
});

describe('what it refuses', () => {
  it('refuses a member actor with no id', () => {
    // The `member` arm is the only attributable one, so an id is what makes it that.
    expect(AuditActorSchema.safeParse({ kind: 'member' }).success).toBe(false);
  });

  it('refuses a member actor carrying a person id', () => {
    // An audit row records who acted *in a group*, and that is a member, not a person.
    const personId = 'prs_01jqw8z5h7e9r3t4y5v6k7p8q9';
    expect(AuditActorSchema.safeParse({ kind: 'member', memberId: personId }).success).toBe(false);
  });

  it.each([{ kind: 'anonymous' }, { kind: 'plugin' }, {}, null, 'system'])(
    'refuses %o',
    (value) => {
      expect(AuditActorSchema.safeParse(value).success).toBe(false);
    },
  );

  it('drops a stray id on a system actor rather than keeping it', () => {
    // `02` §3.13.5 step 8 keeps audit rows through an erasure because their ids carry no personal
    // data once `persons` is erased. A `system` row that smuggled a member id would break that.
    const parsed = AuditActorSchema.parse({ kind: 'system', memberId: MEMBER_ID });
    expect(parsed).toEqual({ kind: 'system' });
  });
});

describe('the 4 KiB cap (02 §3.3.9)', () => {
  it('is declared', () => {
    expect(AUDIT_ACTOR_MAX_BYTES).toBe(4096);
  });
});
