/**
 * `OnboardingReader`/`OnboardingRepository` against `02` §3.3.11, `06` §3.20.1, §3.18.1, §3.7 and
 * `09` §3.7 (`M3-T1`).
 *
 * Four conditional writes live here — claim redemption, link redemption, link confirmation and
 * spending a button token — and every one of them is a single `UPDATE … WHERE` whose row count is
 * the answer. These tests pin the **refusals**, because that is where the behaviour is: the happy
 * path of each is one row changing, and the five different ways it can decline are five different
 * sentences a member reads.
 *
 * The single-use guarantee under genuine concurrency is `onboarding.concurrency.int.test.ts`, in
 * real worker threads. Sequential redemptions cannot show it: better-sqlite3 is synchronous, so a
 * loop here would pass whether or not the `UPDATE` were conditional.
 */
import { CLAIM_BURN_AFTER, expectWritten, type NotPromise } from '@comvivo/core';
import { sha256 } from '@comvivo/shared/crypto';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  conversationId,
  identityId,
  member,
  person,
  personId,
  T0,
  withRepos,
} from './testing/harness.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + ms);

/** `06` §3.20.1's typed form, hashed. The plaintext never reaches the repository. */
const digest = (code: string) => sha256(code);

type World = Parameters<Parameters<typeof withRepos>[0]>[0];

/** A host claim code valid for half an hour, as `06` §3.20.1's default TTL. */
function issue(world: World, code: string, overrides: Record<string, unknown> = {}) {
  return world.store.write((uow) =>
    expectWritten(
      world.repos.onboarding.createClaimCode(uow, {
        kind: 'host',
        codeHash: digest(code),
        expiresAt: at(30 * MINUTE),
        ...overrides,
      }),
      `the claim code ${code}`,
    ),
  );
}

function redeem(world: World, code: string, overrides: Record<string, unknown> = {}) {
  return world.store.write((uow) =>
    world.repos.onboarding.redeemClaimCode(uow, {
      codeHash: digest(code),
      channel: 'simulator',
      now: T0,
      usedInChat: 'chat-1',
      usedByPersonId: personId('cm'),
      ...overrides,
    }),
  );
}

/** A person every redemption can name, since `used_by_person_id` is a real id. */
function withClaimant<T>(fn: (world: World) => NotPromise<T>): T {
  return withRepos((world) => {
    world.store.write((uow) => {
      expectWritten(world.repos.persons.create(uow, person('cm')), 'the claimant');
    });
    return fn(world);
  });
}

describe('redeeming a claim code (06 §3.20.1, 01 §14 A27)', () => {
  it('spends it once and records who used it, where', () => {
    withClaimant((world) => {
      issue(world, 'VLG-AAAA-AAAA');
      const first = redeem(world, 'VLG-AAAA-AAAA');
      expect(first.kind).toBe('ok');
      if (first.kind !== 'ok') return;
      expect(first.code.usedAt?.epochMilliseconds).toBe(T0.epochMilliseconds);

      // Single use, and that is the whole of A27: a chat binds only by redeeming one of these, so
      // a second success would be a second chat bound to one group.
      expect(redeem(world, 'VLG-AAAA-AAAA').kind).toBe('already_used');
    });
  });

  it('redeems by the link token as well as by the typed code', () => {
    withClaimant((world) => {
      // `06` §3.20.1 issues two forms of one grant — `VLG-XXXX-XXXX` for somebody reading it
      // aloud, `c_<22 chars>` for a deep link — and "either redeems the code once".
      issue(world, 'VLG-BBBB-BBBB', { linkTokenHash: digest('c_deeplinktoken') });
      expect(redeem(world, 'c_deeplinktoken').kind).toBe('ok');
      // And the *other* form is spent too, because it was always one code.
      expect(redeem(world, 'VLG-BBBB-BBBB').kind).toBe('already_used');
    });
  });

  it('tells a mistyped code from an expired one from a burned one', () => {
    withClaimant((world) => {
      expect(redeem(world, 'VLG-NOPE-NOPE').kind).toBe('not_found');

      issue(world, 'VLG-CCCC-CCCC');
      // Right code, past its 30 minutes. Not a guess, so the copy asks for a fresh code rather
      // than warning about attempts.
      expect(redeem(world, 'VLG-CCCC-CCCC', { now: at(31 * MINUTE) }).kind).toBe('expired');

      issue(world, 'VLG-DDDD-DDDD');
      world.store.write((uow) => {
        for (let attempt = 0; attempt < CLAIM_BURN_AFTER; attempt += 1) {
          expectWritten(
            world.repos.onboarding.recordClaimFailure(uow, digest('VLG-DDDD-DDDD')),
            'a failure',
          );
        }
      });
      // Ten wrong guesses burn it (`09` §3.7). A separate answer from `not_found`, because the
      // person holding a burned code is usually the one it was sent to.
      expect(redeem(world, 'VLG-DDDD-DDDD').kind).toBe('burned');
    });
  });

  it('burns at the tenth failure and not the eleventh', () => {
    withClaimant((world) => {
      issue(world, 'VLG-EEEE-EEEE');
      const counts = world.store.write((uow) =>
        Array.from({ length: CLAIM_BURN_AFTER - 1 }, () =>
          expectWritten(
            world.repos.onboarding.recordClaimFailure(uow, digest('VLG-EEEE-EEEE')),
            'a failure',
          ),
        ),
      );
      expect(counts.at(-1)).toBe(CLAIM_BURN_AFTER - 1);
      // Nine failures: still spendable. The off-by-one here is the difference between a code that
      // refuses its rightful holder and one that gives a guesser an extra try.
      expect(redeem(world, 'VLG-EEEE-EEEE').kind).toBe('ok');
    });
  });

  it('refuses a code issued for another platform, and says which', () => {
    withClaimant((world) => {
      issue(world, 'VLG-FFFF-FFFF', { channel: 'telegram' });
      const refused = redeem(world, 'VLG-FFFF-FFFF', { channel: 'slack' });
      expect(refused).toEqual({ kind: 'wrong_channel', issuedFor: 'telegram' });
      // Enforced rather than merely reported: a Telegram-scoped code that bound a Slack chat
      // would be a binding nobody authorised.
      expect(
        world.repos.onboarding.claimCodeByHash(digest('VLG-FFFF-FFFF'))?.usedAt,
      ).toBeUndefined();
      // A channel-agnostic code (`village group claim` without `--channel`) still redeems
      // anywhere.
      issue(world, 'VLG-GGGG-GGGG');
      expect(redeem(world, 'VLG-GGGG-GGGG', { channel: 'slack' }).kind).toBe('ok');
    });
  });

  it('counts nothing against a digest no code has', () => {
    withClaimant((world) => {
      const counted = world.store.write((uow) =>
        world.repos.onboarding.recordClaimFailure(uow, digest('VLG-ZZZZ-ZZZZ')),
      );
      // `not_found`, not a thrown error: a mistyped code is the common case, and the attempt is
      // counted against the *chat* in `rate_limits` whatever this says.
      expect(counted.kind).toBe('not_found');
    });
  });
});

describe('cross-platform linking (06 §3.18.1)', () => {
  /** Two identities for one issuer plus a stranger's, which is the shape every link test needs. */
  function withIdentities<T>(fn: (world: World) => NotPromise<T>): T {
    return withRepos((world) => {
      world.store.write((uow) => {
        for (const tag of ['sr', 'rd'] as const) {
          expectWritten(world.repos.persons.create(uow, person(tag)), `person ${tag}`);
          expectWritten(world.repos.members.add(uow, member(tag, world.groupId)), `member ${tag}`);
          expectWritten(
            world.repos.identities.create(uow, {
              id: identityId(tag),
              channel: tag === 'sr' ? 'telegram' : 'discord',
              platformUserId: `u-${tag}`,
              personId: personId(tag),
              displayNameSnapshot: tag === 'sr' ? 'Ana' : 'Ana on Discord',
            }),
            `identity ${tag}`,
          );
        }
      });
      return fn(world);
    });
  }

  function issueLink(world: World, code: string) {
    return world.store.write((uow) =>
      expectWritten(
        world.repos.onboarding.createLinkCode(uow, {
          codeHash: digest(code),
          tokenHash: digest(`lnk_${code}`),
          issuerPersonId: personId('sr'),
          issuerChannelIdentityId: identityId('sr'),
          // Ten minutes (`06` §3.18.1), shorter than a claim code because a link is a live
          // handshake with somebody waiting on the other platform.
          expiresAt: at(10 * MINUTE),
        }),
        `the link code ${code}`,
      ),
    );
  }

  it('runs issue → redeem → confirm, and only the issuer’s confirmation completes it', () => {
    withIdentities((world) => {
      const issued = issueLink(world, 'K7QM-4ZTD');
      expect(issued.state).toBe('issued');

      const redeemed = world.store.write((uow) =>
        world.repos.onboarding.redeemLinkCode(uow, {
          codeHash: digest('K7QM-4ZTD'),
          now: at(MINUTE),
          byIdentityId: identityId('rd'),
        }),
      );
      expect(redeemed.kind).toBe('ok');
      if (redeemed.kind !== 'ok') return;
      expect(redeemed.code.state).toBe('redeemed');
      expect(redeemed.code.redeemedByIdentityId).toBe(identityId('rd'));

      const confirmed = world.store.write((uow) =>
        world.repos.onboarding.confirmLinkCode(uow, {
          id: issued.id,
          now: at(2 * MINUTE),
          redeemedByIdentityId: identityId('rd'),
        }),
      );
      expect(confirmed.kind).toBe('ok');
      if (confirmed.kind !== 'ok') return;
      expect(confirmed.code.state).toBe('confirmed');
    });
  });

  it('refuses a confirmation that names a different redeemer', () => {
    withIdentities((world) => {
      const issued = issueLink(world, 'M3PQ-7WXY');
      world.store.write((uow) =>
        world.repos.onboarding.redeemLinkCode(uow, {
          codeHash: digest('M3PQ-7WXY'),
          now: at(MINUTE),
          byIdentityId: identityId('rd'),
        }),
      );
      const wrong = world.store.write((uow) =>
        world.repos.onboarding.confirmLinkCode(uow, {
          id: issued.id,
          now: at(2 * MINUTE),
          redeemedByIdentityId: identityId('sr'),
        }),
      );
      // `06` §3.18.1 says the issuer confirms "that specific" redeemer, and this is that word:
      // the handle the prompt showed is the one they agreed to, so an approval cannot be inherited
      // by whoever redeemed next.
      expect(wrong).toEqual({
        kind: 'redeemer_changed',
        redeemedByIdentityId: identityId('rd'),
      });
      expect(world.repos.onboarding.linkCodeByHash(digest('M3PQ-7WXY'))?.state).toBe('redeemed');
    });
  });

  it('refuses a second redemption, and a redemption of a cancelled code', () => {
    withIdentities((world) => {
      issueLink(world, 'N2BC-5EFG');
      const redeem = (identity: 'sr' | 'rd') =>
        world.store.write((uow) =>
          world.repos.onboarding.redeemLinkCode(uow, {
            codeHash: digest('N2BC-5EFG'),
            now: at(MINUTE),
            byIdentityId: identityId(identity),
          }),
        );
      expect(redeem('rd').kind).toBe('ok');
      // Single use. Without `state = 'issued'` in the conditional `UPDATE`, this second redemption
      // would overwrite the first one's redeemer — so the issuer would be shown one handle, press
      // Confirm, and link the other.
      expect(redeem('rd')).toEqual({ kind: 'not_open', state: 'redeemed' });

      issueLink(world, 'P3CD-6FGH');
      world.store.write((uow) => world.repos.onboarding.cancelLinkCode(uow, digest('P3CD-6FGH')));
      expect(
        world.store.write((uow) =>
          world.repos.onboarding.redeemLinkCode(uow, {
            codeHash: digest('P3CD-6FGH'),
            now: at(MINUTE),
            byIdentityId: identityId('rd'),
          }),
        ),
      ).toEqual({ kind: 'not_open', state: 'cancelled' });
    });
  });

  it('refuses the issuer redeeming their own code', () => {
    withIdentities((world) => {
      issueLink(world, 'Q4RS-8TVW');
      const self = world.store.write((uow) =>
        world.repos.onboarding.redeemLinkCode(uow, {
          codeHash: digest('Q4RS-8TVW'),
          now: at(MINUTE),
          byIdentityId: identityId('sr'),
        }),
      );
      // The two identities already belong to one Person, so linking them changes nothing — and a
      // no-op that prints "Linked ✓" teaches a member that the flow worked.
      expect(self.kind).toBe('self');
    });
  });

  it('expires a code nobody confirmed within ten minutes', () => {
    withIdentities((world) => {
      issueLink(world, 'T5WX-9YZA');
      expect(
        world.store.write((uow) =>
          world.repos.onboarding.redeemLinkCode(uow, {
            codeHash: digest('T5WX-9YZA'),
            now: at(11 * MINUTE),
            byIdentityId: identityId('rd'),
          }),
        ).kind,
      ).toBe('expired');
    });
  });

  it('cancels a redeemed code without erasing who redeemed it', () => {
    withIdentities((world) => {
      issueLink(world, 'V6YZ-2BCD');
      world.store.write((uow) =>
        world.repos.onboarding.redeemLinkCode(uow, {
          codeHash: digest('V6YZ-2BCD'),
          now: at(MINUTE),
          byIdentityId: identityId('rd'),
        }),
      );
      const cancelled = world.store.write((uow) =>
        world.repos.onboarding.cancelLinkCode(uow, digest('V6YZ-2BCD')),
      );
      expect(cancelled).toEqual({ kind: 'ok', value: 'cancelled' });
      const row = world.repos.onboarding.linkCodeByHash(digest('V6YZ-2BCD'));
      expect(row?.state).toBe('cancelled');
      // The fact a host investigating a leaked code would ask for. `link_codes_redeemer_ck` was
      // written as an equality at first, which made this field impossible to keep — see `0005`.
      expect(row?.redeemedByIdentityId).toBe(identityId('rd'));

      // Idempotent: `06` §3.18.1 invalidates a code typed in a group, and two people pasting one
      // code into a chat is how that path arrives twice.
      expect(
        world.store.write((uow) => world.repos.onboarding.cancelLinkCode(uow, digest('V6YZ-2BCD'))),
      ).toEqual({ kind: 'ok', value: 'cancelled' });
    });
  });

  it('will not reopen a confirmed link', () => {
    withIdentities((world) => {
      const issued = issueLink(world, 'R4DE-7GHJ');
      world.store.write((uow) => {
        world.repos.onboarding.redeemLinkCode(uow, {
          codeHash: digest('R4DE-7GHJ'),
          now: at(MINUTE),
          byIdentityId: identityId('rd'),
        });
        world.repos.onboarding.confirmLinkCode(uow, {
          id: issued.id,
          now: at(2 * MINUTE),
          redeemedByIdentityId: identityId('rd'),
        });
      });
      // A `confirmed` code has already produced a link. Cancelling it here would say the link was
      // abandoned while `channel_identities` still carries it, and the row is `09`'s audit trail
      // for how that identity arrived.
      expect(
        world.store.write((uow) => world.repos.onboarding.cancelLinkCode(uow, digest('R4DE-7GHJ'))),
      ).toEqual({ kind: 'ok', value: 'confirmed' });
      expect(world.repos.onboarding.linkCodeByHash(digest('R4DE-7GHJ'))?.state).toBe('confirmed');
    });
  });

  it('lists a person’s active codes, so the three-at-once limit can be enforced', () => {
    withIdentities((world) => {
      issueLink(world, 'W7ZA-3CDE');
      issueLink(world, 'X8AB-4DEF');
      world.store.write((uow) => world.repos.onboarding.cancelLinkCode(uow, digest('X8AB-4DEF')));
      expect(
        world.repos.onboarding.activeLinkCodes(personId('sr'), at(MINUTE)).map((row) => row.state),
      ).toEqual(['issued']);
      // Expired codes are not active either, which is what stops a person who asked for three an
      // hour ago from being locked out of asking again.
      expect(world.repos.onboarding.activeLinkCodes(personId('sr'), at(11 * MINUTE))).toEqual([]);
    });
  });
});

describe('rate-limit windows (02 §3.3.11, 06 §3.20.1)', () => {
  /** `06` §3.20.1's per-chat claim limit: five failures an hour, then ignored for an hour. */
  const CLAIM_CHAT = { limit: 5, windowMs: HOUR, lockoutMs: HOUR } as const;

  it('allows the limit, locks on the next, and refuses without spending while locked', () => {
    withRepos((world) => {
      const scopeKey = 'claim.chat:simulator:chat-1';
      const verdicts = world.store.write((uow) =>
        Array.from({ length: 6 }, (_unused, index) =>
          world.repos.onboarding.spendAttempt(uow, {
            scopeKey,
            now: at(index * MINUTE),
            ...CLAIM_CHAT,
          }),
        ),
      );
      expect(verdicts.map((verdict) => verdict.allowed)).toEqual([
        true,
        true,
        true,
        true,
        true,
        false,
      ]);
      expect(verdicts.at(-1)?.lockedUntil?.epochMilliseconds).toBe(
        at(5 * MINUTE + HOUR).epochMilliseconds,
      );

      // A seventh attempt is refused **without** moving the counter, so hammering a locked scope
      // cannot extend its own lockout.
      const locked = world.store.write((uow) =>
        world.repos.onboarding.spendAttempt(uow, {
          scopeKey,
          now: at(6 * MINUTE),
          ...CLAIM_CHAT,
        }),
      );
      expect(locked.allowed).toBe(false);
      expect(locked.count).toBe(6);
      expect(locked.lockedUntil?.epochMilliseconds).toBe(at(5 * MINUTE + HOUR).epochMilliseconds);
    });
  });

  it('starts a fresh allowance once the lockout ends', () => {
    withRepos((world) => {
      const scopeKey = 'claim.chat:simulator:chat-2';
      world.store.write((uow) => {
        for (let index = 0; index < 6; index += 1) {
          world.repos.onboarding.spendAttempt(uow, { scopeKey, now: T0, ...CLAIM_CHAT });
        }
      });
      const after = world.store.write((uow) =>
        world.repos.onboarding.spendAttempt(uow, {
          scopeKey,
          now: at(HOUR + MINUTE),
          ...CLAIM_CHAT,
        }),
      );
      // `06` §3.20.1: "the bot ignores further attempts there for 1 h" — and what follows an hour
      // of being ignored is a fresh allowance, not the old count waiting to re-lock on sight.
      expect(after).toEqual({ allowed: true, count: 1 });
    });
  });

  it('previews the same verdict without spending', () => {
    withRepos((world) => {
      const scopeKey = 'link.fail:chid-1';
      world.store.write((uow) => {
        for (let index = 0; index < 5; index += 1) {
          world.repos.onboarding.spendAttempt(uow, { scopeKey, now: T0, ...CLAIM_CHAT });
        }
      });
      // Five spent of five: the dry run says the next one would be refused, and asking does not
      // consume it.
      expect(
        world.repos.onboarding.rateLimit({ scopeKey, now: T0, limit: 5, windowMs: HOUR }),
      ).toEqual({ allowed: false, count: 5 });
      expect(
        world.store.write((uow) =>
          world.repos.onboarding.spendAttempt(uow, { scopeKey, now: T0, ...CLAIM_CHAT }),
        ).count,
      ).toBe(6);
    });
  });

  it('treats an untouched scope as wide open', () => {
    withRepos((world) => {
      expect(
        world.repos.onboarding.rateLimit({
          scopeKey: 'claim.chat:simulator:never-seen',
          now: T0,
          limit: 5,
          windowMs: HOUR,
        }),
      ).toEqual({ allowed: true, count: 0 });
    });
  });
});

describe('adapter state (06 §4.2)', () => {
  it('round-trips a value, replaces it, and lets it expire', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        world.repos.onboarding.putChannelState(uow, {
          channel: 'telegram',
          key: 'update-offset',
          value: '4821',
        });
      });
      expect(world.repos.onboarding.channelState('telegram', 'update-offset', T0)).toBe('4821');

      world.store.write((uow) => {
        world.repos.onboarding.putChannelState(uow, {
          channel: 'telegram',
          key: 'update-offset',
          value: '4822',
          expiresAt: at(MINUTE),
        });
      });
      expect(world.repos.onboarding.channelState('telegram', 'update-offset', T0)).toBe('4822');
      // Past its TTL it reads as absent rather than being deleted on read: a read that wrote would
      // turn every adapter's cursor lookup into a write, on the ingestion hot path.
      expect(
        world.repos.onboarding.channelState('telegram', 'update-offset', at(2 * MINUTE)),
      ).toBeUndefined();
    });
  });

  it('keeps each channel’s keys apart, and deletes only the one asked for', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        for (const channel of ['telegram', 'discord'] as const) {
          world.repos.onboarding.putChannelState(uow, { channel, key: 'cursor', value: channel });
        }
        world.repos.onboarding.deleteChannelState(uow, 'telegram', 'cursor');
      });
      expect(world.repos.onboarding.channelState('telegram', 'cursor', T0)).toBeUndefined();
      expect(world.repos.onboarding.channelState('discord', 'cursor', T0)).toBe('discord');
    });
  });
});

describe('button tokens (06 §3.7)', () => {
  /** A conversation and a member, because a token names both. */
  function withButton<T>(fn: (world: World) => NotPromise<T>): T {
    return withRepos((world) => {
      world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('bt')), 'the presser');
        expectWritten(world.repos.members.add(uow, member('bt', world.groupId)), 'the member');
        expectWritten(
          world.repos.conversations.create(uow, {
            id: conversationId('btn'),
            groupId: world.groupId,
            channel: 'simulator',
            platformChatId: 'chat-buttons',
            kind: 'group',
            boundAt: T0,
          }),
          'the conversation',
        );
      });
      return fn(world);
    });
  }

  const mint = (world: World, token: string, overrides: Record<string, unknown> = {}) =>
    world.store.write((uow) =>
      expectWritten(
        world.repos.onboarding.createInteractionToken(uow, {
          tokenHash: digest(token),
          groupId: world.groupId,
          conversationId: conversationId('btn'),
          action: { kind: 'confirm', params: { what: 'the booking' } },
          allowedClickers: 'any_member',
          singleUse: true,
          expiresAt: at(7 * 24 * HOUR),
          ...overrides,
        }),
        `the token ${token}`,
      ),
    );

  const press = (world: World, token: string, now = T0) =>
    world.store.write((uow) =>
      world.repos.onboarding.spendInteractionToken(uow, {
        tokenHash: digest(token),
        now,
        byMemberId: member('bt', world.groupId).id,
      }),
    );

  it('spends a single-use token once and returns the action, not a decision', () => {
    withButton((world) => {
      mint(world, 'v1.aaaaaaaaaaaaaaaaaaaaaa');
      const pressed = press(world, 'v1.aaaaaaaaaaaaaaaaaaaaaa');
      expect(pressed.kind).toBe('ok');
      if (pressed.kind !== 'ok') return;
      expect(pressed.action).toEqual({ kind: 'confirm', params: { what: 'the booking' } });
      // Returned, never checked here: policy re-decides authority on every click (**I3**), because
      // a member whose role changed between the render and the press must be refused.
      expect(pressed.allowedClickers).toBe('any_member');
      expect(pressed.conversationId).toBe(conversationId('btn'));

      // Two members pressing one single-use button must produce one action.
      expect(press(world, 'v1.aaaaaaaaaaaaaaaaaaaaaa').kind).toBe('already_used');
    });
  });

  it('lets a reusable token be pressed again, recording the last press', () => {
    withButton((world) => {
      mint(world, 'v1.bbbbbbbbbbbbbbbbbbbbbb', { singleUse: false });
      expect(press(world, 'v1.bbbbbbbbbbbbbbbbbbbbbb').kind).toBe('ok');
      expect(press(world, 'v1.bbbbbbbbbbbbbbbbbbbbbb', at(MINUTE)).kind).toBe('ok');
      const row = world.db
        .prepare('SELECT used_at FROM interaction_tokens WHERE token_hash = ?')
        .get(Buffer.from(digest('v1.bbbbbbbbbbbbbbbbbbbbbb'))) as { used_at: number };
      expect(row.used_at).toBe(at(MINUTE).epochMilliseconds);
    });
  });

  it('refuses an unknown digest and an expired token', () => {
    withButton((world) => {
      expect(press(world, 'v1.cccccccccccccccccccccc').kind).toBe('not_found');
      mint(world, 'v1.dddddddddddddddddddddd', { expiresAt: at(MINUTE) });
      expect(press(world, 'v1.dddddddddddddddddddddd', at(2 * MINUTE)).kind).toBe('expired');
    });
  });

  it('narrows the clickers it was offered to, and still leaves the decision to policy', () => {
    withButton((world) => {
      const only = [member('bt', world.groupId).id];
      mint(world, 'v1.eeeeeeeeeeeeeeeeeeeeee', { allowedClickers: only });
      const pressed = press(world, 'v1.eeeeeeeeeeeeeeeeeeeeee');
      expect(pressed.kind).toBe('ok');
      if (pressed.kind !== 'ok') return;
      expect(pressed.allowedClickers).toEqual(only);
    });
  });
});
