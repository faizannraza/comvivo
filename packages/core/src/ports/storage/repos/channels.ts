/**
 * The channel-binding and onboarding ports (`02` §3.3.1, §3.3.11; `06` §3.20, `01` §14 **A27**).
 *
 * Two repositories, split the way the data is: `ChatBindingRepository` answers "what is this chat
 * and does a group own it?" on every single inbound message, and `OnboardingRepository` handles
 * the rare, security-sensitive writes — redeeming a claim code, linking an identity, spending a
 * button token.
 *
 * ## The three methods that are not CRUD methods
 *
 * `redeemClaimCode`, `redeemLinkCode` and `spendInteractionToken` are **conditional writes**, and
 * that is the whole of A27's single-use guarantee. `06` §3.20.1 makes a claim code 40 bits, which
 * is only safe because it is short-lived, single-use and attempt-limited — so "check then write"
 * is not an implementation detail here: two redemptions whose reads both saw `used_at IS NULL`
 * would bind two chats to one group, and the second is a chat whose members nobody invited.
 *
 * So each is one `UPDATE … WHERE <every precondition>`, and the row count is the answer. The
 * preconditions live in the statement rather than in the caller because a precondition a caller
 * checks is a precondition a second caller can forget.
 *
 * ## Why each result is a union and not a boolean
 *
 * A member who typed a code has to be told *which* thing went wrong, and the answers are
 * different sentences — "no such code", "that code has expired", "that code was already used",
 * "that code has been disabled after too many wrong guesses", "that code is for Telegram". A
 * boolean would collapse five messages into "no", and the one a member most needs (a 30-minute
 * TTL elapsed; ask for a fresh code) is the one that reads as a typo.
 *
 * Each union's arms are **diagnosed after** the conditional write fails, by reading the row the
 * write did not touch. That ordering matters: the write is what makes the operation safe, and the
 * read is only what makes the error message useful. Doing it the other way round — read, decide,
 * then write — is the race.
 *
 * There is deliberately **no `lost_race` arm**. `02` D10 opens every write with `BEGIN IMMEDIATE`
 * and `C1` keeps one writer, so a concurrent redemption serialises behind this one and its
 * conditional `UPDATE` then matches zero rows with `used_at` already set — it is reported as
 * `already_used`, which is what happened. An arm no execution can reach would read as proof the
 * implementation handles a case it never sees.
 */

import type {
  ChannelIdentityId,
  ChatBindingId,
  ClaimCodeId,
  ConversationId,
  GroupId,
  InteractionTokenId,
  LinkCodeId,
  MemberId,
  OutboxId,
  PersonId,
  TurnId,
} from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type {
  AllowedClickers,
  ChannelId,
  ChatProbe,
  InteractionAction,
} from '../../../domain/channel.js';
import type { TxToken, WriteResult } from '../uow.js';

/** An instant, as every other port in this directory spells it. */
type Instant = Temporal.Instant;

// --- Chat bindings ------------------------------------------------------------------------------

export type ChatBindingStatus = 'unclaimed' | 'bound' | 'detached';

/**
 * What the product knows about a platform chat.
 *
 * `groupId` is absent while `unclaimed`, and that absence is the A27 guarantee rather than a
 * missing field: a group id on an unclaimed chat would say which group somebody tried to add the
 * bot for, which is exactly the fact an unclaimed chat must not persist.
 */
export interface ChatBinding {
  readonly id: ChatBindingId;
  readonly channel: ChannelId;
  readonly platformChatId: string;
  readonly status: ChatBindingStatus;
  readonly groupId?: GroupId;
  readonly conversationId?: ConversationId;
  readonly firstSeenAt: Instant;
  readonly unclaimedNoticeAt?: Instant;
  readonly leaveAt?: Instant;
  readonly detachedAt?: Instant;
  readonly lastProbe?: ChatProbe;
}

export interface NewChatBinding {
  readonly channel: ChannelId;
  readonly platformChatId: string;
  readonly firstSeenAt: Instant;
  /** One hour after first contact (`06` §3.20.1's `unclaimed.leaveAfter`). */
  readonly leaveAt?: Instant;
}

/**
 * Reads on the ingestion hot path (`02` §3.3.9 Q-ING-2).
 *
 * Every inbound message asks `byPlatformChat` before anything else, so it is one index hit on
 * `chat_bindings_platform_uq` and returns the whole row — a second query for the group would
 * double the cost of the one lookup that happens most.
 */
export interface ChatBindingReader {
  byPlatformChat(channel: ChannelId, platformChatId: string): ChatBinding | undefined;
  /**
   * Which conversation an **old** platform chat id now means (`06` §3.21.1).
   *
   * Telegram migrates a group to a supergroup and the id changes underneath us. Messages already
   * sent carry the old one, so a lookup that missed has to ask this before concluding the chat is
   * unknown.
   */
  conversationByAlias(channel: ChannelId, oldPlatformChatId: string): ConversationId | undefined;
  /** Unclaimed chats whose leave time has passed, for the sweep (`06` §3.20.1). */
  dueToLeave(now: Instant, limit: number): readonly ChatBinding[];
  /** The active group for a platform DM, or `undefined` when nobody has chosen (`03` E20). */
  activeDmGroup(channel: ChannelId, platformChatId: string): GroupId | undefined;
}

export interface ChatBindingRepository {
  /**
   * Record a chat the bot has just seen, or return the row that already exists.
   *
   * Idempotent because the first thing that happens in a new chat is often several messages at
   * once: a member adds the bot and three people say hello. A second insert must not fail the
   * turn that triggered it.
   */
  seen(uow: TxToken, binding: NewChatBinding): WriteResult<ChatBinding>;
  /** Mark the one unclaimed notice as posted, so it is never posted twice (`06` §3.20.1). */
  noticePosted(uow: TxToken, id: ChatBindingId, at: Instant): WriteResult<void>;
  /** Bind a chat to a group. Called only from inside `redeemClaimCode`'s transaction. */
  bind(
    uow: TxToken,
    id: ChatBindingId,
    to: { readonly groupId: GroupId; readonly conversationId: ConversationId },
  ): WriteResult<ChatBinding>;
  /** The bot was removed. Resumable for 30 days (`06` §3.20.2), so the row survives. */
  detach(uow: TxToken, id: ChatBindingId, at: Instant): WriteResult<ChatBinding>;
  recordProbe(uow: TxToken, id: ChatBindingId, probe: ChatProbe): WriteResult<void>;
  /**
   * A chat changed its platform id (`06` §3.21.1).
   *
   * **One transaction**, because `M3-T1`'s AC requires it: the alias is written, the conversation
   * and the binding are re-pointed, and the queued outbox rows are woken together. A crash
   * between them would leave messages aimed at an id the platform no longer accepts — they would
   * fail, retry, and fail again until somebody looked.
   *
   * `outboxRetargeted` counts rows whose **next attempt was brought forward to now**. An outbox
   * row addresses its destination through `conversation_id` and carries no platform chat id of
   * its own, so re-pointing the conversation is what re-targets it; what the wake adds is that a
   * row sitting on a backoff from a failure against the old id goes out at once instead of in
   * minutes. Rows already leased by a dispatcher are left alone — see the implementation.
   */
  migrateChat(
    uow: TxToken,
    move: {
      readonly channel: ChannelId;
      readonly fromPlatformChatId: string;
      readonly toPlatformChatId: string;
    },
  ): WriteResult<{ readonly conversationId: ConversationId; readonly outboxRetargeted: number }>;
  /** Set or clear which group a platform DM is about (`06` §3.4). */
  setDmContext(
    uow: TxToken,
    context: {
      readonly channel: ChannelId;
      readonly platformChatId: string;
      readonly personId: PersonId;
      readonly activeGroupId?: GroupId;
      readonly setAt: Instant;
    },
  ): WriteResult<void>;
}

// --- Onboarding ---------------------------------------------------------------------------------

export type ClaimCodeKind = 'host' | 'group';

export interface NewClaimCode {
  readonly kind: ClaimCodeKind;
  /** `sha256` of the normalised typed code. The code itself is never stored. */
  readonly codeHash: Uint8Array;
  readonly linkTokenHash?: Uint8Array;
  readonly channel?: ChannelId;
  readonly groupId?: GroupId;
  readonly template?: string;
  readonly createdByPersonId?: PersonId;
  readonly expiresAt: Instant;
}

export interface ClaimCode extends NewClaimCode {
  readonly id: ClaimCodeId;
  readonly failedAttempts: number;
  readonly usedAt?: Instant;
}

/**
 * The outcome of trying to redeem a claim code (`06` §3.20.1; `09` §3.9.1's
 * `'invalid' | 'burned' | 'already_claimed'`).
 *
 * Six arms, because `06` §3.20.1 states six redemption rules and a member needs to be told which
 * one stopped them:
 *
 *  - `ok` — spent. The caller binds the chat inside the same transaction.
 *  - `not_found` — no such code. The only arm that counts against the chat's attempt window,
 *    because it is the only one that is a guess.
 *  - `expired` — right code, past its 30 minutes. Not a guess; ask for a fresh one.
 *  - `already_used` — right code, already spent. Single use is the point (A27).
 *  - `burned` — ten wrong guesses against this code disabled it (`09` §3.7 `claim.redeem`). A
 *    separate arm from `not_found` because the member holding a burned code is usually the person
 *    who was *sent* it, and "ask your host for a new one" is the useful sentence.
 *  - `wrong_channel` — the code was issued for one platform and typed on another. Enforced here
 *    rather than by the caller: a code scoped to Telegram that bound a Slack chat would be a
 *    binding nobody authorised, which is the failure A27 exists to prevent.
 *
 * Two rules are **not** here, because this repository cannot see what they need: "the chat is a
 * group and is `unclaimed`" is `ChatBindingReader`'s, and "that group's home platform is the
 * same" needs `groups`. The onboarding service checks both before calling (`M3-T10`).
 */
export type ClaimRedemption =
  | { readonly kind: 'ok'; readonly code: ClaimCode }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'already_used' }
  | { readonly kind: 'burned' }
  | { readonly kind: 'wrong_channel'; readonly issuedFor: ChannelId };

/** A fixed-window counter that survives a restart (`02` §3.3.11). */
export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly count: number;
  readonly lockedUntil?: Instant;
}

/**
 * Ten wrong guesses burn a claim code (`06` §3.20.1, `09` §3.7 `claim.redeem`).
 *
 * Exported because two places have to agree on it: `redeemClaimCode`'s `WHERE` clause, which is
 * what makes a burned code unspendable, and the copy that tells a member what happened. A literal
 * in each is how a code comes to be refused at eleven and described as "ten".
 */
export const CLAIM_BURN_AFTER = 10;

// --- Link codes ---------------------------------------------------------------------------------

/**
 * The four states of a cross-platform link (`06` §3.18.1).
 *
 * Four rather than a boolean, because linking is a two-party handshake. `issued` by the person who
 * already has an account, `redeemed` when somebody enters the code on the other platform,
 * `confirmed` when the **issuer** approves that specific redeemer, `cancelled` otherwise. Without
 * the `redeemed` → `confirmed` step, anyone who intercepted a 40-bit code would be linked to a
 * stranger's person — an identity takeover rather than an inconvenience.
 */
export type LinkCodeState = 'issued' | 'redeemed' | 'confirmed' | 'cancelled';

export interface NewLinkCode {
  readonly codeHash: Uint8Array;
  readonly tokenHash: Uint8Array;
  readonly issuerPersonId: PersonId;
  readonly issuerChannelIdentityId: ChannelIdentityId;
  /** Ten minutes (`06` §3.18.1). */
  readonly expiresAt: Instant;
}

export interface LinkCode extends NewLinkCode {
  readonly id: LinkCodeId;
  readonly state: LinkCodeState;
  readonly redeemedByIdentityId?: ChannelIdentityId;
  readonly createdAt: Instant;
}

/** `redeemLinkCode`'s outcome. Same construction and the same reasons as `ClaimRedemption`. */
export type LinkRedemption =
  | { readonly kind: 'ok'; readonly code: LinkCode }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'expired' }
  /** Already `redeemed`, `confirmed` or `cancelled`: the handshake has moved on. */
  | { readonly kind: 'not_open'; readonly state: LinkCodeState }
  /**
   * The issuer typed their own code on the second platform.
   *
   * Refused rather than ignored, because the two identities would already be the same Person and
   * a "link" that changes nothing still prints "Linked ✓" — which teaches a member that the flow
   * worked when it did not.
   */
  | { readonly kind: 'self' };

/** `confirmLinkCode`'s outcome: the issuer approving one specific redeemer. */
export type LinkConfirmation =
  | { readonly kind: 'ok'; readonly code: LinkCode }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'not_redeemed'; readonly state: LinkCodeState }
  /**
   * The code was redeemed by a **different** identity than the one being confirmed.
   *
   * `06` §3.18.1 says the issuer confirms "that specific" redeemer, and this arm is that word: a
   * second redemption racing the confirmation must not inherit the issuer's approval of the
   * first, because the handle the issuer read in the prompt is the one they agreed to.
   */
  | { readonly kind: 'redeemer_changed'; readonly redeemedByIdentityId?: ChannelIdentityId };

// --- Onboarding reads and writes ----------------------------------------------------------------

export interface OnboardingReader {
  /**
   * A claim code by **either** of its hashes (`06` §3.20.1).
   *
   * One method rather than two, because `06` §3.20.1 issues two forms of one grant — a typed
   * `VLG-XXXX-XXXX` and a `c_<22 chars>` link token — and "either redeems the code once". A
   * caller that had to know which form it held would be the place the two could diverge.
   */
  claimCodeByHash(codeHash: Uint8Array): ClaimCode | undefined;
  linkCodeByHash(codeHash: Uint8Array): LinkCode | undefined;
  /** Active (`issued` or `redeemed`, unexpired) codes a person holds. `06` §3.18.1 allows 3. */
  activeLinkCodes(personId: PersonId, now: Instant): readonly LinkCode[];
  /**
   * What `spendAttempt` **would** answer, without spending an attempt.
   *
   * Takes the same `limit` and `windowMs` it would, deliberately. An earlier signature took only
   * the key and the clock, which meant `allowed` could only mean "not locked out" — a field whose
   * name promises the whole verdict and delivers one term of it. The caller that knows the limit
   * is the caller that will spend, so asking for it costs nothing and makes the dry run a dry run.
   */
  rateLimit(scope: {
    readonly scopeKey: string;
    readonly now: Instant;
    readonly limit: number;
    readonly windowMs: number;
  }): RateLimitVerdict;
  channelState(channel: ChannelId, key: string, now: Instant): string | undefined;
}

export interface OnboardingRepository {
  createClaimCode(uow: TxToken, code: NewClaimCode): WriteResult<ClaimCode>;
  /**
   * Spend a claim code, or say why not.
   *
   * A **single conditional `UPDATE … WHERE used_at IS NULL AND …`**. See this file's header: the
   * read-then-write version binds two chats to one group under concurrency, and `M3-T1`'s AC
   * requires single use "under concurrency" rather than in the happy path.
   */
  redeemClaimCode(
    uow: TxToken,
    redemption: {
      readonly codeHash: Uint8Array;
      readonly channel: ChannelId;
      readonly now: Instant;
      readonly usedInChat: string;
      readonly usedByPersonId: PersonId;
    },
  ): ClaimRedemption;
  /**
   * Count a failed attempt against a code, and return the new total.
   *
   * Returns `not_found` for a hash no code has, which is the common case on a mistyped code and
   * is not an error: there is nothing to count against.
   */
  recordClaimFailure(uow: TxToken, codeHash: Uint8Array): WriteResult<number>;
  createLinkCode(uow: TxToken, code: NewLinkCode): WriteResult<LinkCode>;
  /** `issued` → `redeemed`, conditionally, naming the redeemer (`06` §3.18.1). */
  redeemLinkCode(
    uow: TxToken,
    use: {
      readonly codeHash: Uint8Array;
      readonly now: Instant;
      readonly byIdentityId: ChannelIdentityId;
    },
  ): LinkRedemption;
  /** `redeemed` → `confirmed`, and only for the redeemer the issuer was shown. */
  confirmLinkCode(
    uow: TxToken,
    confirmation: {
      readonly id: LinkCodeId;
      readonly now: Instant;
      readonly redeemedByIdentityId: ChannelIdentityId;
    },
  ): LinkConfirmation;
  /**
   * Invalidate a code that is still open.
   *
   * `06` §3.18.1 needs this on a path that is not a user action: a code typed **in a group** is
   * rejected *and invalidated*, because it has been read by everyone in that chat. Idempotent —
   * a code that is already `confirmed` or `cancelled` is left as it is.
   */
  cancelLinkCode(uow: TxToken, codeHash: Uint8Array): WriteResult<LinkCodeState>;
  /**
   * Spend one attempt against a windowed scope, and say whether it was allowed.
   *
   * The counter is in the database rather than in memory because the limit it enforces is a
   * **security** limit: a process restart that reset it would turn "5 attempts per hour" into
   * "5 attempts per restart".
   */
  spendAttempt(
    uow: TxToken,
    scope: {
      readonly scopeKey: string;
      readonly now: Instant;
      readonly limit: number;
      readonly windowMs: number;
      readonly lockoutMs: number;
    },
  ): RateLimitVerdict;
  putChannelState(
    uow: TxToken,
    entry: {
      readonly channel: ChannelId;
      readonly key: string;
      readonly value: string;
      readonly expiresAt?: Instant;
    },
  ): WriteResult<void>;
  deleteChannelState(uow: TxToken, channel: ChannelId, key: string): WriteResult<void>;
  /** Mint a button token (`06` §3.7). Only the digest is stored. */
  createInteractionToken(
    uow: TxToken,
    token: {
      readonly tokenHash: Uint8Array;
      readonly groupId: GroupId;
      readonly conversationId: ConversationId;
      readonly outboxMessageId?: OutboxId;
      readonly action: InteractionAction;
      readonly allowedClickers: AllowedClickers;
      readonly singleUse: boolean;
      readonly expiresAt: Instant;
      readonly createdByTurnId?: TurnId;
    },
  ): WriteResult<{ readonly id: InteractionTokenId }>;
  /**
   * Spend a button token, conditionally.
   *
   * Same shape and same reason as `redeemClaimCode`: two members pressing one single-use button
   * at the same moment must produce one action. `allowedClickers` is **returned rather than
   * checked** here, because policy decides authority on every click (invariant **I3**) and a
   * member whose role changed between the render and the press must be refused — which only
   * policy knows.
   *
   * A token with `singleUse` false is spendable repeatedly until it expires; each press updates
   * `used_at` and `used_by_member_id`, so the row records the last press rather than the first.
   */
  spendInteractionToken(
    uow: TxToken,
    use: { readonly tokenHash: Uint8Array; readonly now: Instant; readonly byMemberId: MemberId },
  ):
    | {
        readonly kind: 'ok';
        readonly groupId: GroupId;
        readonly conversationId: ConversationId;
        readonly action: InteractionAction;
        readonly allowedClickers: AllowedClickers;
      }
    /**
     * No such digest.
     *
     * The dispatcher maps this and `expired` to one sentence, and maps an action kind its registry
     * does not know onto the same one: `06` §3.7 asks for an unknown kind to be treated as expired
     * rather than as an error, because that is what a token minted by a previous version looks
     * like. That mapping is the dispatcher's — this repository only knows whether a row exists.
     */
    | { readonly kind: 'not_found' }
    | { readonly kind: 'expired' }
    | { readonly kind: 'already_used' };
}
