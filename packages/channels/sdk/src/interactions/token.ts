/**
 * The interaction token (`06` §3.7 CH-7; `M3-T6`).
 *
 * One opaque string is the **only** button payload on every platform. Not `cnf:42:approve`, not
 * `poll:7:2` — nothing structured, ever, in `callback_data`, `custom_id`, `value` or `action_id`.
 * That rule is the whole point of the module, and it is a security rule rather than a tidiness
 * one: a structured payload is attacker-authored input that arrives already shaped like a command,
 * so a click on a message somebody else can see becomes a way to name an action and its arguments.
 * An opaque token names nothing. It is a lookup key into a row the server wrote, and the row
 * carries who may click, how often, and until when.
 *
 * ## The format, and why each part of it
 *
 * `v1.` + base64url of **16 CSPRNG bytes** = 22 characters = **25 ASCII bytes** total.
 *
 * - **16 bytes (128 bits)** is the floor `08` §3.7.12 uses for anything long-lived, and a button
 *   lives for 7 days by default. At 25 bytes there is room for it inside Telegram's 64-byte
 *   `callback_data`, which is the tightest limit any platform imposes.
 * - **base64url**, not hex, because hex would need 32 characters for the same entropy and because
 *   `+` and `/` need escaping wherever a token ends up in a URL.
 * - **The `v1.` prefix** is a format bump. The server stores only `sha256(token)`, so a new format
 *   does not need a migration: old tokens keep resolving until they expire and new ones are minted
 *   under the new prefix.
 *
 * ## Where it does *not* fit
 *
 * A Telegram **deep-link start payload** allows only `A-Z a-z 0-9 _ -`
 * ([deep linking](https://core.telegram.org/bots/features#deep-linking), re-verified 2026-11-15),
 * and `.` is not in that set. `06` §3.7 claimed the token fits there; it does not, and the claim is
 * corrected in the same commit as this file. Nothing needs it to: a deep link in this product
 * carries **context**, never an action — `lnk_<22 base64url>` for identity linking (§3.18.1) and
 * `onb_<groupHandle>` for DM onboarding (§3.19), both already inside the start-payload charset. The
 * buttons that carry tokens live *inside* the chat the deep link opens.
 *
 * ## The asymmetry between inbound and outbound validation
 *
 * `ActionButtonSchema.token` (outbound) requires this exact pattern.
 * `InboundInteractionSchema`'s button token does **not** — it accepts any non-empty string.
 *
 * That is deliberate and the reverse would be a bug. Outbound, Village is the only producer, so a
 * token that does not match is a defect in Village and the schema is the place to catch it: it is
 * what makes "no structured strings ever" structural rather than a convention. Inbound, the string
 * comes from whoever pressed whatever; a malformed one is simply *unknown*, and `06` §3.7 step 6
 * says an unknown token gets "This button has expired". If the envelope schema rejected it, the
 * event would be dropped at the boundary and the member would get silence instead of an answer.
 */
import { randomToken, secureEqualDigest, sha256 } from '@comvivo/shared/crypto';
import type { Temporal } from 'temporal-polyfill';
import type { ButtonLimits } from '../contract.js';

/** The only format this version mints. The dot is the separator; the prefix is fixed-length. */
export const INTERACTION_TOKEN_VERSION = 'v1';

/** 128 bits — `08` §3.7.12's floor for a secret that outlives a request. */
export const INTERACTION_TOKEN_ENTROPY_BYTES = 16;

/** `v1.` + 22 base64url characters. ASCII throughout, so bytes and characters agree. */
export const INTERACTION_TOKEN_BYTES = 25;

/**
 * The shape, exactly as `06` §3.7 publishes it.
 *
 * Deliberately **not** narrowed to the 16 characters base64url can actually produce in the final
 * position (16 bytes is 128 bits, and 22 base64url characters hold 132). A stricter regex would
 * reject a string `06` §3.7 calls a valid token, and it would buy nothing: the gate that decides
 * whether a token is real is the `sha256` lookup against `interaction_tokens`, not its spelling.
 */
export const INTERACTION_TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]{22}$/;

/**
 * A fresh token.
 *
 * The randomness comes from `@comvivo/shared/crypto`, **not** from the `Rng` on `AdapterContext`.
 * That looks like a purity violation and is the opposite: `08` §3.7.1 draws the line explicitly —
 * `Rng` is a *seedable* PRNG so that fairness decisions can be replayed, and seeding the source of
 * a button token would make every token in a replayed group predictable. `random.ts` is the one
 * audited import site for things that must be unguessable, which is what a token is.
 *
 * Minting lives in this package rather than in the engine because the format is a **wire** fact:
 * it is sized by `ButtonLimits.tokenMaxBytes`, which is a capability, and `06` §4.1 owns it.
 */
export function mintInteractionToken(): string {
  return `${INTERACTION_TOKEN_VERSION}.${randomToken(INTERACTION_TOKEN_ENTROPY_BYTES)}`;
}

/** True for a string shaped like a token this version mints. A cheap gate, not a decision. */
export function isInteractionToken(value: string): boolean {
  return INTERACTION_TOKEN_PATTERN.test(value);
}

/**
 * What the server stores (`06` §3.7's `InteractionTokenRecord.tokenHash`).
 *
 * The token itself is never persisted. A dump of `interaction_tokens` therefore cannot be replayed
 * into clicks, which matters because the rows outlive the message by up to 7 days and a backup
 * outlives them both.
 */
export function interactionTokenHash(token: string): Uint8Array {
  return sha256(token);
}

/**
 * Whether a presented token matches a stored hash, in constant time (`03` §3.3.12 rule 3).
 *
 * Constant time is not theatre here. A confirmation token is a **capability**: holding it is what
 * lets a click approve a guardian request. A comparison that returns early on the first differing
 * byte leaks the prefix of a live token to anyone who can click a button and time the reply, and a
 * button is clickable by everyone who can see the message.
 */
export function interactionTokenMatches(presented: string, storedHash: Uint8Array): boolean {
  return secureEqualDigest(presented, storedHash);
}

/**
 * Whether a platform's `callback_data` budget holds a token.
 *
 * Exported for an adapter's boot-time assertion and for the profile test that proves the claim in
 * `06` §3.7 — "it fits Telegram `callback_data` (≤64 bytes), Discord `custom_id` (≤100), Slack
 * `value` (≤2000) and `action_id` (≤255)" — against the capability numbers rather than against the
 * sentence. A profile whose `tokenMaxBytes` drops below 25 is a platform this scheme cannot target,
 * and that is a fact worth failing a build over rather than discovering in a `400`.
 */
export function tokenFitsButtonLimits(limits: ButtonLimits): boolean {
  return limits.tokenMaxBytes >= INTERACTION_TOKEN_BYTES;
}

/** `06` §3.7: "The default token TTL is 7 days, or the poll/plan deadline + 1 day." */
export const DEFAULT_INTERACTION_TOKEN_TTL_DAYS = 7;

/**
 * The default `expiresAt` for a token minted now.
 *
 * A producer with a deadline of its own sets a shorter one: `07`'s choice tokens use 24 h and a
 * `confirm` token expires with its `ConfirmationRequest` (`03` §3.3.12 rule 5). This is the
 * fallback for a button with nothing to expire alongside — and it is a bound, not a policy, which
 * is why it is 7 days and not 7 years: a button nobody pressed in a week is a button whose context
 * has moved on, and the row it pins is a row the retention sweep should be free to drop.
 */
export function defaultInteractionTokenExpiry(now: Temporal.Instant): Temporal.Instant {
  return now.add({ hours: DEFAULT_INTERACTION_TOKEN_TTL_DAYS * 24 });
}
