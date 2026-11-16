/**
 * Deciding a button press (`06` §3.7 step 4; `03` §3.3.12 rule 3; `08` T-S06; `M3-T10`).
 *
 * The `sec.callbacks.forged` harness in `testing/callbacks.ts` covers the scenarios an adapter or
 * the engine has to survive. This file covers the two things the harness cannot see, because they
 * are about the shape of the function rather than about an outcome:
 *
 * - **The order of the checks**, which is a security decision. Expiry before eligibility, because
 *   an ineligible presser who learns "not allowed" has learned that something real is pending and
 *   who it is for.
 * - **What a member is told**, which collapses three outcomes into one sentence on purpose.
 */
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { clickReply, decideClick, type InteractionTokenRecordLike, isAllowed } from './resolve.js';
import { interactionTokenHash, mintInteractionToken } from './token.js';

const NOW = Temporal.Instant.from('2026-11-15T12:00:00Z');
const ANA = 'mbr_ana';
const SAM = 'mbr_sam';

function row(
  token: string,
  over: Partial<InteractionTokenRecordLike> = {},
): InteractionTokenRecordLike {
  return {
    tokenHash: interactionTokenHash(token),
    action: { kind: 'confirm', params: { confirmationId: 'cnf_1', option: 'approve' } },
    allowedClickers: [ANA],
    singleUse: true,
    expiresAt: NOW.add({ hours: 1 }),
    ...over,
  };
}

const press = (token: string, clicker = ANA) =>
  ({ token, clickerMemberId: clicker, now: NOW }) as const;

describe('a genuine press', () => {
  it('resolves to the action, with the turn it was created for', () => {
    // `08` T-S06 binds the payload "to intended member and turn". The turn comes back so a handler
    // can refuse a press from a turn that has since been superseded.
    const token = mintInteractionToken();
    const decision = decideClick(row(token, { createdByTurnId: 'trn_7' }), press(token));
    expect(decision).toEqual({
      outcome: 'ok',
      action: { kind: 'confirm', params: { confirmationId: 'cnf_1', option: 'approve' } },
      createdByTurnId: 'trn_7',
    });
  });
});

describe('the payload is never the authority (08 T-S06)', () => {
  it('answers `unknown` for anything that does not hash to the row', () => {
    const token = mintInteractionToken();
    const record = row(token);
    for (const forged of [
      `${token.slice(0, -1)}${token.endsWith('A') ? 'Q' : 'A'}`,
      mintInteractionToken(),
      'cnf:cnf_1:approve',
      `${token.slice(0, 20)}AAAAA`,
      '',
      ' ',
      `${token} `,
    ]) {
      expect(decideClick(record, press(forged)).outcome, JSON.stringify(forged)).toBe('unknown');
    }
  });

  it('answers `unknown` when the lookup found nothing', () => {
    // The same answer as a mismatched hash, deliberately: a caller that branched on "no row" would
    // have to remember they are the same, and a member must not be able to tell them apart.
    expect(decideClick(null, press(mintInteractionToken())).outcome).toBe('unknown');
  });

  it('re-checks the hash even though the row was found by it', () => {
    // The cheap check that catches a whole class of lookup bug: a query matching on a prefix, an
    // index on the wrong column, a cache keyed by the token's first bytes.
    const token = mintInteractionToken();
    const wrongRow = row(mintInteractionToken());
    expect(decideClick(wrongRow, press(token)).outcome).toBe('unknown');
  });
});

describe('the order of the checks', () => {
  it('reports `expired` to an ineligible presser, not `not_allowed`', () => {
    // The oracle this closes: if eligibility came first, a member who is not an approver could
    // press a dead button and learn from the refusal that it had been a live one — a confirmation
    // that something is pending, and who it is for.
    const token = mintInteractionToken();
    const expired = row(token, { expiresAt: NOW.subtract({ minutes: 1 }) });
    expect(decideClick(expired, press(token, SAM)).outcome).toBe('expired');
  });

  it('reports `expired` rather than `used` for a spent token that also expired', () => {
    const token = mintInteractionToken();
    const both = row(token, { expiresAt: NOW.subtract({ minutes: 1 }), usedAt: NOW });
    expect(decideClick(both, press(token)).outcome).toBe('expired');
  });

  it('treats the expiry instant itself as expired', () => {
    // `expiresAt` is when it stops working, not the last moment it works. A button that fired on
    // the tick of its own deadline would make every TTL in `03` §3.3.12 rule 5 off by one.
    const token = mintInteractionToken();
    expect(decideClick(row(token, { expiresAt: NOW }), press(token)).outcome).toBe('expired');
    expect(
      decideClick(row(token, { expiresAt: NOW.add({ nanoseconds: 1 }) }), press(token)).outcome,
    ).toBe('ok');
  });
});

describe('single use (03 §3.3.12 rule 3)', () => {
  it('refuses a replay, and says who spent it', () => {
    // A replayed press is the cheapest attack there is: the payload is already in the client.
    const token = mintInteractionToken();
    const spent = row(token, { usedAt: NOW.subtract({ minutes: 5 }), usedBy: ANA });
    expect(decideClick(spent, press(token))).toEqual({ outcome: 'used', usedBy: ANA });
  });

  it('does not consume a token that is not single-use', () => {
    const token = mintInteractionToken();
    const reusable = row(token, { singleUse: false, usedAt: NOW.subtract({ minutes: 5 }) });
    expect(decideClick(reusable, press(token)).outcome).toBe('ok');
  });
});

describe('authorization, re-checked', () => {
  it('refuses a member outside `allowedClickers`', () => {
    // The press carries the presser, so this is the only check between "can see the button" and
    // "can use it" — and everyone in the chat can see it.
    const token = mintInteractionToken();
    expect(decideClick(row(token), press(token, SAM)).outcome).toBe('not_allowed');
  });

  it('allows anybody when the row says `any_member`', () => {
    const token = mintInteractionToken();
    expect(
      decideClick(row(token, { allowedClickers: 'any_member' }), press(token, SAM)).outcome,
    ).toBe('ok');
  });

  it('refuses everybody on an empty list, rather than treating it as "anyone"', () => {
    // An empty `eligible` array is a `ConfirmationSpec` with no approvers, which is a bug upstream
    // — and the safe reading of it is nobody, not everybody.
    const token = mintInteractionToken();
    expect(decideClick(row(token, { allowedClickers: [] }), press(token)).outcome).toBe(
      'not_allowed',
    );
    expect(isAllowed([], ANA)).toBe(false);
    expect(isAllowed('any_member', ANA)).toBe(true);
  });
});

describe('what the member is told (06 §3.7 steps 5 and 6)', () => {
  it('gives one sentence to the three outcomes a presser must not distinguish', () => {
    // A forged payload, a stale button and a replay all answer "This button has expired". That is
    // not laziness: three different sentences would be three different pieces of information about
    // a token the presser is not entitled to know anything about.
    for (const outcome of ['unknown', 'expired', 'used'] as const) {
      expect(clickReply({ outcome, usedBy: undefined } as never).copyKey).toBe(
        'interaction.expired',
      );
    }
  });

  it('sends a denial by toast or ephemeral, never publicly', () => {
    // "Only Alice can confirm this" posted to a group tells everyone who is waiting on whom.
    const reply = clickReply({ outcome: 'not_allowed' });
    expect(reply.copyKey).toBe('interaction.not_allowed');
    expect(reply.delivery).toBe('toast_or_ephemeral');
  });

  it('says nothing for a press that worked', () => {
    expect(
      clickReply({
        outcome: 'ok',
        action: { kind: 'confirm', params: {} },
        createdByTurnId: undefined,
      }),
    ).toEqual({ copyKey: null, delivery: null });
  });
});
