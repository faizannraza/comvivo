/**
 * `sec.callbacks.forged` — the forged-callback harness (`08` T-S06; `M3-T10`).
 *
 * `08`'s threat table names this one and names its test: **T-S06, "Forged `callback_data` /
 * `custom_id` / action values (client-controlled)"**, mitigated by "opaque server-side IDs; payload
 * bound to intended member and turn; presser authorization re-checked", with the harness owed by
 * `06`/`channel-sdk` and `05`.
 *
 * It is a harness rather than a test because two different things have to pass it: the SDK's own
 * `decideClick` now, and `M3-T24`'s engine resolver — which does the database lookup, the identity
 * resolution and the policy re-check — later. A security property proven against one implementation
 * and asserted about another is not proven.
 *
 * ## What it can and cannot establish
 *
 * It establishes that a press is decided by the **row**, not by the payload: a tampered token, a
 * never-minted one, a structured string and a token sharing a long prefix all answer the same way,
 * and a member outside `allowedClickers` is refused on a live one. It also establishes the thing
 * that is easy to get backwards — that an ineligible presser cannot tell a live button from a dead
 * one, because `06` §3.7 step 6 gives both the same sentence and the *order of the checks* is what
 * makes that true rather than the copy.
 *
 * It cannot establish constant-time comparison; that is `interactionTokenMatches`, which delegates
 * to `timingSafeEqual`, and a timing assertion in a test suite measures the runner.
 */
import type { Temporal } from 'temporal-polyfill';
import {
  type ClickDecision,
  decideClick,
  type InteractionTokenRecordLike,
} from '../interactions/resolve.js';
import { interactionTokenHash, mintInteractionToken } from '../interactions/token.js';
import { check, checkEqual } from './assert.js';

const CASE = 'sec.callbacks.forged';

/**
 * Anything that can answer "what does this press do".
 *
 * The port the harness runs against. `M3-T24`'s resolver implements it over `02`'s
 * `interaction_tokens`; {@link referenceClickResolver} implements it over a map, so the harness has
 * something to prove itself against from the day it is written.
 */
export interface ClickResolver {
  resolve(attempt: {
    readonly token: string;
    readonly clickerMemberId: string;
    readonly now: Temporal.Instant;
  }): Promise<ClickDecision>;
}

/** One minted token and the row behind it, as the harness needs to set a scenario up. */
export interface SeededToken {
  readonly token: string;
  readonly record: InteractionTokenRecordLike;
}

/**
 * Mint a token and build its row.
 *
 * The harness seeds through this rather than letting a caller hand-build a pair, because the thing
 * under test is that the row's `tokenHash` is the only link between the two: a seeder that stored
 * the token itself, or a digest of something else, would make every case below pass for the wrong
 * reason.
 */
export function seedToken(record: Omit<InteractionTokenRecordLike, 'tokenHash'>): SeededToken {
  const token = mintInteractionToken();
  return { token, record: { ...record, tokenHash: interactionTokenHash(token) } };
}

/**
 * A resolver over a map, with single use recorded.
 *
 * Looks up **by hash**, which is the shape `06` §3.7 requires of the real one ("the server stores
 * only `sha256(token)`") and the reason a forged payload simply finds nothing. Marks a single-use
 * row as used on a successful press, so the replay case has something to replay against.
 */
export function referenceClickResolver(seeded: readonly SeededToken[]): ClickResolver {
  const rows = new Map<string, InteractionTokenRecordLike>();
  for (const entry of seeded) rows.set(hex(entry.record.tokenHash), entry.record);
  return {
    resolve: (attempt) => {
      const key = hex(interactionTokenHash(attempt.token));
      const record = rows.get(key) ?? null;
      const decision = decideClick(record, attempt);
      if (decision.outcome === 'ok' && record !== null && record.singleUse) {
        rows.set(key, { ...record, usedAt: attempt.now, usedBy: attempt.clickerMemberId });
      }
      return Promise.resolve(decision);
    },
  };
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface ForgedCallbackFixtures {
  readonly now: Temporal.Instant;
  /** An instant already past, for the expired row. */
  readonly past: Temporal.Instant;
  /** The member the live token is for. */
  readonly eligible: string;
  /** A member of the same group who is not. */
  readonly other: string;
}

/**
 * Run the harness.
 *
 * `build` is given the rows to seed and returns a resolver over them, so the engine can wire its
 * own store in while the scenarios stay here. Throws a {@link ConformanceFailure} on the first
 * thing that is wrong, with the rule it broke.
 */
export async function forgedCallbackChecks(
  build: (seeded: readonly SeededToken[]) => ClickResolver | Promise<ClickResolver>,
  fixtures: ForgedCallbackFixtures,
): Promise<void> {
  const { now, past, eligible, other } = fixtures;
  const base = {
    action: { kind: 'confirm', params: { confirmationId: 'cnf_1', option: 'approve' } },
    allowedClickers: [eligible] as readonly string[],
    singleUse: true,
    expiresAt: now.add({ hours: 1 }),
    createdByTurnId: 'trn_1',
  };

  // Four rows, and `live` is deliberately **not** single-use. The first version made it so, and the
  // control press at the top consumed it — so the replay scenario later found it already spent and
  // reported "the first press of a single-use token was refused" against a correct resolver. A
  // harness whose own setup interferes with its scenarios is a harness that fails honest code.
  const live = seedToken({ ...base, singleUse: false });
  const single = seedToken(base);
  const open = seedToken({ ...base, allowedClickers: 'any_member', singleUse: false });
  const expired = seedToken({ ...base, expiresAt: past });
  const resolver = await build([live, single, open, expired]);
  const press = (token: string, clicker = eligible): Promise<ClickDecision> =>
    resolver.resolve({ token, clickerMemberId: clicker, now });

  // The control. Without it every refusal below could be a resolver that refuses everything.
  const genuine = await press(live.token);
  checkEqual(
    CASE,
    genuine.outcome,
    'ok',
    'a genuine token pressed by an eligible member was refused',
  );
  if (genuine.outcome === 'ok') {
    checkEqual(
      CASE,
      genuine.createdByTurnId,
      'trn_1',
      '`08` T-S06 binds the payload to the turn, and the decision did not carry it back',
    );
  }

  // Tampering. Every one of these is a string a member can send, and all four must be
  // indistinguishable from "no such token".
  const forgeries: readonly { readonly name: string; readonly token: string }[] = [
    { name: 'one character changed', token: flipLast(live.token) },
    { name: 'a token never minted', token: mintInteractionToken() },
    { name: 'a structured payload', token: 'cnf:cnf_1:approve' },
    { name: 'the right prefix, the wrong tail', token: `${live.token.slice(0, 20)}AAAAA` },
    { name: 'the whole hash as a token', token: hex(live.record.tokenHash).slice(0, 25) },
    { name: 'empty', token: '' },
  ];
  for (const forgery of forgeries) {
    const decision = await press(forgery.token);
    check(
      CASE,
      decision.outcome === 'unknown',
      `${forgery.name}: the decision was \`${decision.outcome}\` and must be \`unknown\`. ` +
        '`06` §3.7 makes the row the authority and the payload opaque, so a string that does not ' +
        'hash to a stored row cannot resolve to anything.',
    );
  }

  // Authorization, re-checked (`08` T-S06; `03` §3.3.12 rule 3: "clicks by non-eligible members are
  // ignored"). A member of the group who is not an approver must not be able to approve.
  const wrongMember = await press(live.token, other);
  checkEqual(
    CASE,
    wrongMember.outcome,
    'not_allowed',
    'a member outside `allowedClickers` was allowed to press. The press carries the presser, so ' +
      'this is the only check between "can see the button" and "can use it".',
  );
  const anyMember = await press(open.token, other);
  checkEqual(
    CASE,
    anyMember.outcome,
    'ok',
    '`allowedClickers: "any_member"` refused a member — the refusal is not supposed to be blanket',
  );

  // No oracle. An ineligible presser must not be able to tell a live token from a dead one, which
  // is why `06` §3.7 step 6 gives `unknown` and `expired` one sentence — and why the order of the
  // checks has to put expiry first, or the refusal itself leaks that something is pending.
  const expiredByOther = await press(expired.token, other);
  checkEqual(
    CASE,
    expiredByOther.outcome,
    'expired',
    'an expired token pressed by an ineligible member answered `not_allowed`, which tells them it ' +
      'is a real token they are not allowed to use — a confirmation that something is pending and ' +
      'who it is for. Check expiry before eligibility.',
  );

  // Replay. `03` §3.3.12 rule 3 makes a confirmation token single-use per option for `quorum: any`,
  // and a replayed press is the cheapest attack there is: the payload is already in the client.
  const first = await press(single.token);
  checkEqual(CASE, first.outcome, 'ok', 'the first press of a single-use token was refused');
  const replay = await press(single.token);
  check(
    CASE,
    replay.outcome === 'used' || replay.outcome === 'unknown',
    `a single-use token resolved twice (\`${replay.outcome}\`). The second press must not run the ` +
      'action, however the row records that it was spent.',
  );

  // And a reusable one is not accidentally single-use, so the check above is about `singleUse`
  // rather than about every token being consumed.
  checkEqual(
    CASE,
    (await press(live.token)).outcome,
    'ok',
    'a token with `singleUse: false` was consumed by its first press',
  );
}

/** The same token with its last character changed, which is the cheapest forgery there is. */
function flipLast(token: string): string {
  const last = token.slice(-1);
  return `${token.slice(0, -1)}${last === 'A' ? 'Q' : 'A'}`;
}
