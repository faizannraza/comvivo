/**
 * Deciding a button press (`06` §3.7 step 4; `03` §3.3.12 rule 3; `08` T-S06; `M3-T10`).
 *
 * `08`'s threat model names this one: **T-S06, forged `callback_data`**. The payload is
 * client-controlled — a member can send any string a button could have carried, and on every
 * platform the press arrives as that string with the presser's identity attached. The mitigation
 * `08` lists is three things, and this is where the second and third live: "opaque server-side IDs;
 * payload **bound to intended member and turn**; presser authorization **re-checked**".
 *
 * A pure function over the row, so the same rules run in the engine's resolver (`M3-T24`) and in
 * the kit's `sec.callbacks.forged` harness. The alternative — the checks written inline in whatever
 * handles a click — is how one of them comes to be missing on one path.
 *
 * ## The order is a security decision, not a style one
 *
 * Expiry is checked **before** eligibility, and that is deliberate. A member who is not an allowed
 * clicker and presses an expired button learns only "this expired"; if eligibility came first they
 * would learn "this is a real, live token I am not allowed to use", which is a confirmation that
 * something is pending and who it is for. `06` §3.7 step 6 gives `unknown` and `expired` the same
 * member-facing sentence for the same reason.
 *
 * ## Why the hash is re-checked here
 *
 * The row was found *by* the hash, so comparing again looks redundant. It is the one check that
 * costs nothing and catches a whole class of lookup bug: a query that matched on a prefix, an index
 * on the wrong column, a cache keyed by the token's first bytes. `03` §3.3.12 rule 3 asks for the
 * comparison to be constant-time, and doing it where the decision is made means there is one place
 * to audit rather than one per caller.
 */
import type { Temporal } from 'temporal-polyfill';
import { interactionTokenMatches, isInteractionToken } from './token.js';

/**
 * The `InteractionToken` row, as `06` §3.7 defines it.
 *
 * Structurally typed rather than imported from `02`: the ids are branded types in `@comvivo/core`
 * and this package may not reach the storage layer (`01` §4). What the decision needs is the shape,
 * and the engine passes its own row straight in.
 */
export interface InteractionTokenRecordLike {
  readonly tokenHash: Uint8Array;
  readonly action: { readonly kind: string; readonly params: unknown };
  /** `06` §3.7: checked again by policy (**I3**). */
  readonly allowedClickers: 'any_member' | readonly string[];
  readonly singleUse: boolean;
  readonly expiresAt: Temporal.Instant;
  readonly usedAt?: Temporal.Instant | undefined;
  readonly usedBy?: string | undefined;
  /** `08` T-S06's "bound to … turn". Carried so a handler can refuse a click from another turn. */
  readonly createdByTurnId?: string | undefined;
}

/** What a press is. */
export interface ClickAttempt {
  readonly token: string;
  /** The **resolved** member behind the press, not a platform user id (`03` §3.3.12 rule 3). */
  readonly clickerMemberId: string;
  readonly now: Temporal.Instant;
}

export type ClickDecision =
  | {
      readonly outcome: 'ok';
      readonly action: { readonly kind: string; readonly params: unknown };
      readonly createdByTurnId: string | undefined;
    }
  /** No such token, or one whose bytes do not match the row. `06` §3.7 step 6: "expired". */
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'expired' }
  /** A replay of a single-use token. Also "expired" to the member (`03` rule 3: ignored). */
  | { readonly outcome: 'used'; readonly usedBy: string | undefined }
  /** `06` §3.7 step 5: a denial, by toast or ephemeral, **never** posted publicly. */
  | { readonly outcome: 'not_allowed' };

/**
 * Decide one press against one row.
 *
 * `record` is `null` when the lookup found nothing, which is the common case for a forged payload
 * and the reason the parameter is nullable rather than the caller branching: the answer for "no
 * row" and for "a row whose hash does not match" must be the same, and a caller that returned
 * early would have to remember that.
 */
export function decideClick(
  record: InteractionTokenRecordLike | null,
  attempt: ClickAttempt,
): ClickDecision {
  // The shape gate first, and only because it is free: a string that is not a token cannot match
  // any hash, so this is an early exit rather than a check. It must never be the *only* thing
  // standing between a payload and an action — `06` §3.7's whole point is that the token is opaque
  // and the row is the authority.
  if (!isInteractionToken(attempt.token)) return { outcome: 'unknown' };
  if (record === null) return { outcome: 'unknown' };
  if (!interactionTokenMatches(attempt.token, record.tokenHash)) return { outcome: 'unknown' };

  // Expiry before eligibility; see the module header. An ineligible member pressing a live button
  // must not be able to tell it apart from a dead one.
  if (compare(record.expiresAt, attempt.now) <= 0) return { outcome: 'expired' };
  if (record.singleUse && record.usedAt !== undefined) {
    return { outcome: 'used', usedBy: record.usedBy };
  }
  if (!isAllowed(record.allowedClickers, attempt.clickerMemberId))
    return { outcome: 'not_allowed' };
  return { outcome: 'ok', action: record.action, createdByTurnId: record.createdByTurnId };
}

/**
 * Whether this member may press.
 *
 * `'any_member'` means any member **of the group the row names** — the row carries `groupId`, and
 * the engine's lookup is scoped to it, so group isolation (**I4**) is upstream of this function and
 * not something it can check. Worth stating because `'any_member'` reads like "anyone".
 */
export function isAllowed(
  allowedClickers: 'any_member' | readonly string[],
  memberId: string,
): boolean {
  return allowedClickers === 'any_member' || allowedClickers.includes(memberId);
}

/** `Temporal.Instant.compare` without importing the namespace at runtime. */
function compare(a: Temporal.Instant, b: Temporal.Instant): number {
  if (a.epochNanoseconds < b.epochNanoseconds) return -1;
  return a.epochNanoseconds > b.epochNanoseconds ? 1 : 0;
}

/**
 * Which decisions a member is told about, and how (`06` §3.7 steps 5 and 6).
 *
 * Three of the five outcomes collapse to one sentence, which is the point: `unknown`, `expired` and
 * `used` are indistinguishable to the presser, so a forged payload, a stale button and a replay all
 * answer "This button has expired". `not_allowed` is the only one that says something else, and
 * `06` §3.7 step 5 requires it to go by toast or ephemeral — "Only Alice can confirm this" posted
 * publicly tells a whole group who is waiting on whom.
 *
 * The copy itself is `05`'s (`CLAUDE.md` §2); this is the *routing*, which is `06`'s.
 */
export function clickReply(decision: ClickDecision): {
  readonly copyKey: 'interaction.expired' | 'interaction.not_allowed' | null;
  readonly delivery: 'toast_or_ephemeral' | null;
} {
  switch (decision.outcome) {
    case 'ok':
      return { copyKey: null, delivery: null };
    case 'unknown':
    case 'expired':
    case 'used':
      return { copyKey: 'interaction.expired', delivery: 'toast_or_ephemeral' };
    case 'not_allowed':
      return { copyKey: 'interaction.not_allowed', delivery: 'toast_or_ephemeral' };
  }
}
