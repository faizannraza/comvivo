/**
 * Claim codes, link codes, button tokens, adapter state and rate-limit windows
 * (`02` §3.3.11; `06` §3.20.1, §3.18.1, §3.7, §4.2; `09` §3.7).
 *
 * ## Every write here is conditional, and that is the design
 *
 * Four methods spend something single-use — `redeemClaimCode`, `redeemLinkCode`,
 * `confirmLinkCode`, `spendInteractionToken` — and each is a `SELECT` for the **message** followed
 * by an `UPDATE … WHERE` that repeats **every** precondition. The repetition is not redundancy:
 *
 *  - the `UPDATE`'s `WHERE` is what makes the operation correct, and it holds whether or not the
 *    `SELECT` above it ran, saw a stale row, or was reordered by a later edit;
 *  - the `SELECT` is what makes the *error* useful, because a member who typed a code needs to be
 *    told which of five things happened and SQLite's row count cannot say.
 *
 * Collapsing them — checking in TypeScript and writing unconditionally — is the race that binds
 * two chats to one group. Collapsing the other way, dropping the `SELECT`, costs the member the
 * difference between "that code expired, ask for a new one" and "no".
 *
 * `02` D10 opens every write with `BEGIN IMMEDIATE` and `C1` keeps one writer, so a competing
 * redemption serialises behind this one rather than interleaving with it. The conditional `UPDATE`
 * is therefore belt and braces today — and it is the braces that hold if the transaction mode ever
 * changes, which is why it is not simplified away.
 *
 * ## Nothing here reads a secret
 *
 * Every lookup is by `sha256` digest. The plaintext code never reaches this module, so there is
 * nothing in these statements that a database file could leak. `08` §3.7.13's lint rule enforces
 * the constant-time comparison at the boundary that still holds plaintext.
 */
import type {
  AllowedClickers,
  ChannelId,
  ClaimCode,
  ClaimRedemption,
  InteractionAction,
  LinkCode,
  LinkCodeState,
  LinkConfirmation,
  LinkRedemption,
  NewClaimCode,
  NewLinkCode,
  OnboardingReader,
  OnboardingRepository,
  RateLimitVerdict,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import { CLAIM_BURN_AFTER, duplicate, notFound, writeOk } from '@comvivo/core';
import type {
  ChannelIdentityId,
  ConversationId,
  GroupId,
  IdGenerator,
  InteractionTokenId,
  LinkCodeId,
  MemberId,
  OutboxId,
  PersonId,
  TurnId,
} from '@comvivo/shared';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import { type Db, maybeOne } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import {
  channelState,
  claimCodes,
  interactionTokens,
  linkCodes,
  rateLimits,
} from '../schema/index.js';

type Instant = Temporal.Instant;

/** `a` is at or after `b`. */
function atOrAfter(a: Instant, b: Instant): boolean {
  return Temporal.Instant.compare(a, b) >= 0;
}

function toClaimCode(row: typeof claimCodes.$inferSelect): ClaimCode {
  return {
    id: row.id,
    kind: row.kind,
    codeHash: row.codeHash,
    ...(row.linkTokenHash === null ? {} : { linkTokenHash: row.linkTokenHash }),
    ...(row.channel === null ? {} : { channel: row.channel }),
    ...(row.groupId === null ? {} : { groupId: row.groupId }),
    ...(row.template === null ? {} : { template: row.template }),
    ...(row.createdByPersonId === null ? {} : { createdByPersonId: row.createdByPersonId }),
    expiresAt: row.expiresAt,
    failedAttempts: row.failedAttempts,
    ...(row.usedAt === null ? {} : { usedAt: row.usedAt }),
  };
}

function toLinkCode(row: typeof linkCodes.$inferSelect): LinkCode {
  return {
    id: row.id,
    codeHash: row.codeHash,
    tokenHash: row.tokenHash,
    issuerPersonId: row.issuerPersonId,
    issuerChannelIdentityId: row.issuerChannelIdentityId,
    state: row.state,
    ...(row.redeemedByIdentityId === null
      ? {}
      : { redeemedByIdentityId: row.redeemedByIdentityId }),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/** The states a link code can still move out of (`06` §3.18.1). */
const OPEN_LINK_STATES = ['issued', 'redeemed'] as const;

export class SqliteOnboardingRepository implements OnboardingReader, OnboardingRepository {
  readonly #db: Db;
  readonly #ids: IdGenerator;

  constructor(db: Db, ids: IdGenerator) {
    this.#db = db;
    this.#ids = ids;
  }

  // --- Claim codes ------------------------------------------------------------------------------

  claimCodeByHash(codeHash: Uint8Array): ClaimCode | undefined {
    const row = this.#claimRow(codeHash);
    return row === undefined ? undefined : toClaimCode(row);
  }

  createClaimCode(uow: TxToken, code: NewClaimCode): WriteResult<ClaimCode> {
    const row = {
      id: this.#ids.next('clm'),
      kind: code.kind,
      codeHash: Buffer.from(code.codeHash),
      linkTokenHash: code.linkTokenHash === undefined ? null : Buffer.from(code.linkTokenHash),
      channel: code.channel ?? null,
      groupId: code.groupId ?? null,
      template: code.template ?? null,
      createdByPersonId: code.createdByPersonId ?? null,
      createdAt: uow.now,
      expiresAt: code.expiresAt,
      failedAttempts: 0,
      usedAt: null,
      usedInChat: null,
      usedByPersonId: null,
    };
    try {
      this.#db.insert(claimCodes).values(row).run();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Two codes with one digest is a generator that repeated itself, which `09` §3.9.1 must see
      // rather than overwrite: issuing the second would silently invalidate the first, and the
      // host who is reading the first one aloud would be told it is wrong.
      const existing = this.claimCodeByHash(code.codeHash);
      return duplicate(existing?.id ?? 'unknown');
    }
    return writeOk(toClaimCode(row));
  }

  redeemClaimCode(
    _uow: TxToken,
    redemption: {
      readonly codeHash: Uint8Array;
      readonly channel: ChannelId;
      readonly now: Instant;
      readonly usedInChat: string;
      readonly usedByPersonId: PersonId;
    },
  ): ClaimRedemption {
    // **The write comes first, and nothing is read before it.** An earlier version checked the
    // five preconditions in TypeScript and then ran the same conditions again in the `WHERE`,
    // which looks careful and is not: under `BEGIN IMMEDIATE` the pre-read already sees the
    // winner's committed row, so the pre-read produced every refusal and the `WHERE` decided
    // nothing. Deleting `used_at IS NULL` from it left the concurrency test green — measured, not
    // reasoned about — which is a conditional write that had stopped being one.
    //
    // So the statement below is the only thing that decides, and `#claimTarget` is why it can
    // still be addressed by digest: `code_hash` and `link_token_hash` are separately unique, so an
    // `OR` over both could in principle match a different row in each column and spend **two**
    // codes. The subquery takes one.
    const won = maybeOne(
      this.#db
        .update(claimCodes)
        .set({
          usedAt: redemption.now,
          usedInChat: redemption.usedInChat,
          usedByPersonId: redemption.usedByPersonId,
        })
        .where(
          and(
            inArray(claimCodes.id, this.#claimTarget(redemption.codeHash)),
            sql`${claimCodes.usedAt} IS NULL`,
            sql`${claimCodes.expiresAt} > ${redemption.now.epochMilliseconds}`,
            sql`${claimCodes.failedAttempts} < ${CLAIM_BURN_AFTER}`,
            sql`(${claimCodes.channel} IS NULL OR ${claimCodes.channel} = ${redemption.channel})`,
          ),
        )
        .returning(),
    );
    if (won !== undefined) return { kind: 'ok', code: toClaimCode(won) };

    // Only now, and only to choose a sentence. This read cannot change the outcome — the code is
    // already either spent by us or not spent by us — so it is on the refusal path alone, which is
    // also the rare one.
    const found = this.#claimRow(redemption.codeHash);
    if (found === undefined) return { kind: 'not_found' };
    // The order is what a member most needs to hear. A code that is both spent and expired was
    // *used* — that is the fact — and "ask whoever used it" is a different next step from "ask for
    // a fresh code".
    if (found.usedAt !== null) return { kind: 'already_used' };
    if (found.failedAttempts >= CLAIM_BURN_AFTER) return { kind: 'burned' };
    if (atOrAfter(redemption.now, found.expiresAt)) return { kind: 'expired' };
    if (found.channel !== null && found.channel !== redemption.channel) {
      return { kind: 'wrong_channel', issuedFor: found.channel };
    }
    // Every term of the `WHERE` is accounted for above, so reaching here means the row became
    // spendable again between the two statements. `already_used` is the only answer that cannot
    // bind a second chat, which is the property worth preserving when the explanation runs out.
    return { kind: 'already_used' };
  }

  recordClaimFailure(_uow: TxToken, codeHash: Uint8Array): WriteResult<number> {
    const row = maybeOne(
      this.#db
        .update(claimCodes)
        .set({ failedAttempts: sql`${claimCodes.failedAttempts} + 1` })
        .where(inArray(claimCodes.id, this.#claimTarget(codeHash)))
        .returning({ failedAttempts: claimCodes.failedAttempts }),
    );
    // A mistyped code usually matches nothing, and that is not an error: there is no row to count
    // against. The **chat's** window in `rate_limits` is what catches a guesser, and the caller
    // spends that attempt whatever this returns.
    return row === undefined ? notFound() : writeOk(row.failedAttempts);
  }

  // --- Link codes -------------------------------------------------------------------------------

  linkCodeByHash(codeHash: Uint8Array): LinkCode | undefined {
    const row = this.#linkRow(codeHash);
    return row === undefined ? undefined : toLinkCode(row);
  }

  activeLinkCodes(personId: PersonId, now: Instant): readonly LinkCode[] {
    return this.#db
      .select()
      .from(linkCodes)
      .where(
        and(
          eq(linkCodes.issuerPersonId, personId),
          inArray(linkCodes.state, [...OPEN_LINK_STATES]),
          sql`${linkCodes.expiresAt} > ${now.epochMilliseconds}`,
        ),
      )
      .all()
      .map(toLinkCode);
  }

  createLinkCode(uow: TxToken, code: NewLinkCode): WriteResult<LinkCode> {
    const row = {
      id: this.#ids.next('lnk'),
      codeHash: Buffer.from(code.codeHash),
      tokenHash: Buffer.from(code.tokenHash),
      issuerPersonId: code.issuerPersonId,
      issuerChannelIdentityId: code.issuerChannelIdentityId,
      state: 'issued' as const,
      redeemedByIdentityId: null,
      createdAt: uow.now,
      expiresAt: code.expiresAt,
    };
    try {
      this.#db.insert(linkCodes).values(row).run();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = this.linkCodeByHash(code.codeHash);
      return duplicate(existing?.id ?? 'unknown');
    }
    return writeOk(toLinkCode(row));
  }

  redeemLinkCode(
    _uow: TxToken,
    use: {
      readonly codeHash: Uint8Array;
      readonly now: Instant;
      readonly byIdentityId: ChannelIdentityId;
    },
  ): LinkRedemption {
    // Write first, diagnose after — the construction this module's header describes and the one a
    // planted break can see. **Including the self-redemption rule**, which looks like a policy
    // check and is not: if it were a TypeScript `if` above the statement, the statement would
    // accept a self-redemption and only the check would refuse it. Deleting the check would then
    // link an identity to the Person that already owns it, and nothing in the SQL would object.
    const won = maybeOne(
      this.#db
        .update(linkCodes)
        .set({ state: 'redeemed', redeemedByIdentityId: use.byIdentityId })
        .where(
          and(
            inArray(linkCodes.id, this.#linkTarget(use.codeHash)),
            eq(linkCodes.state, 'issued'),
            sql`${linkCodes.expiresAt} > ${use.now.epochMilliseconds}`,
            sql`${linkCodes.issuerChannelIdentityId} <> ${use.byIdentityId}`,
          ),
        )
        .returning(),
    );
    if (won !== undefined) return { kind: 'ok', code: toLinkCode(won) };

    const found = this.#linkRow(use.codeHash);
    if (found === undefined) return { kind: 'not_found' };
    if (found.state !== 'issued') return { kind: 'not_open', state: found.state };
    if (atOrAfter(use.now, found.expiresAt)) return { kind: 'expired' };
    // The issuer typed their own code on platform B. Refused rather than linked, because the two
    // identities already belong to one Person and a no-op that prints "Linked ✓" teaches a member
    // that the flow worked.
    if (found.issuerChannelIdentityId === use.byIdentityId) return { kind: 'self' };
    return { kind: 'not_open', state: 'redeemed' };
  }

  confirmLinkCode(
    _uow: TxToken,
    confirmation: {
      readonly id: LinkCodeId;
      readonly now: Instant;
      readonly redeemedByIdentityId: ChannelIdentityId;
    },
  ): LinkConfirmation {
    // `redeemed_by_identity_id` is in the `WHERE`, and that clause is `06` §3.18.1's word
    // "specific": the issuer approved the handle the prompt showed them, so a redemption that
    // replaced it must not inherit that approval. In the statement rather than above it, because
    // a check above it is a check the statement does not make.
    const won = maybeOne(
      this.#db
        .update(linkCodes)
        .set({ state: 'confirmed' })
        .where(
          and(
            eq(linkCodes.id, confirmation.id),
            eq(linkCodes.state, 'redeemed'),
            eq(linkCodes.redeemedByIdentityId, confirmation.redeemedByIdentityId),
            sql`${linkCodes.expiresAt} > ${confirmation.now.epochMilliseconds}`,
          ),
        )
        .returning(),
    );
    if (won !== undefined) return { kind: 'ok', code: toLinkCode(won) };

    const found = maybeOne(
      this.#db.select().from(linkCodes).where(eq(linkCodes.id, confirmation.id)),
    );
    if (found === undefined) return { kind: 'not_found' };
    if (found.state !== 'redeemed') return { kind: 'not_redeemed', state: found.state };
    if (atOrAfter(confirmation.now, found.expiresAt)) return { kind: 'expired' };
    if (found.redeemedByIdentityId !== confirmation.redeemedByIdentityId) {
      return {
        kind: 'redeemer_changed',
        ...(found.redeemedByIdentityId === null
          ? {}
          : { redeemedByIdentityId: found.redeemedByIdentityId }),
      };
    }
    return { kind: 'not_redeemed', state: found.state };
  }

  cancelLinkCode(_uow: TxToken, codeHash: Uint8Array): WriteResult<LinkCodeState> {
    // `state IN ('issued', 'redeemed')` is what stops this from reopening a `confirmed` link, and
    // it is in the statement for the usual reason. `redeemed_by_identity_id` is **kept**:
    // `link_codes_redeemer_ck` allows a `cancelled` row to have one precisely so that cancelling
    // a redeemed code does not erase who redeemed it — see the constraint's comment in
    // `schema/onboarding.ts`.
    const won = maybeOne(
      this.#db
        .update(linkCodes)
        .set({ state: 'cancelled' })
        .where(
          and(
            inArray(linkCodes.id, this.#linkTarget(codeHash)),
            inArray(linkCodes.state, [...OPEN_LINK_STATES]),
          ),
        )
        .returning({ state: linkCodes.state }),
    );
    if (won !== undefined) return writeOk(won.state);

    // Idempotent: the caller's path here is `06` §3.18.1's "a code typed in a group is rejected
    // and invalidated", which arrives twice for one code when two people paste it into a chat.
    const found = this.#linkRow(codeHash);
    return found === undefined ? notFound() : writeOk(found.state);
  }

  // --- Rate limits ------------------------------------------------------------------------------

  rateLimit(scope: {
    readonly scopeKey: string;
    readonly now: Instant;
    readonly limit: number;
    readonly windowMs: number;
  }): RateLimitVerdict {
    const row = maybeOne(
      this.#db.select().from(rateLimits).where(eq(rateLimits.scopeKey, scope.scopeKey)),
    );
    const state = windowState(row, scope.now, scope.windowMs);
    if (state.kind === 'locked') return state.verdict;
    return { allowed: state.count < scope.limit, count: state.count };
  }

  spendAttempt(
    _uow: TxToken,
    scope: {
      readonly scopeKey: string;
      readonly now: Instant;
      readonly limit: number;
      readonly windowMs: number;
      readonly lockoutMs: number;
    },
  ): RateLimitVerdict {
    const row = maybeOne(
      this.#db.select().from(rateLimits).where(eq(rateLimits.scopeKey, scope.scopeKey)),
    );
    const state = windowState(row, scope.now, scope.windowMs);
    // A locked scope is refused **without** spending, so a client hammering it cannot extend its
    // own lockout indefinitely by keeping the counter moving.
    if (state.kind === 'locked') return state.verdict;

    const count = state.count + 1;
    const over = count > scope.limit;
    // `null` rather than left alone, because a scope whose lockout has just been released starts
    // a fresh window (see `windowState`) and a stale `locked_until` in the row would be read as a
    // lockout the next time somebody asked.
    const lockedUntil = over ? scope.now.add({ milliseconds: scope.lockoutMs }) : null;
    this.#db
      .insert(rateLimits)
      .values({
        scopeKey: scope.scopeKey,
        windowStart: state.windowStart ?? scope.now,
        count,
        lockedUntil,
      })
      .onConflictDoUpdate({
        target: rateLimits.scopeKey,
        set: { windowStart: state.windowStart ?? scope.now, count, lockedUntil },
      })
      .run();
    return {
      allowed: !over,
      count,
      ...(lockedUntil === null ? {} : { lockedUntil }),
    };
  }

  // --- Adapter state ----------------------------------------------------------------------------

  channelState(channel: ChannelId, key: string, now: Instant): string | undefined {
    const row = maybeOne(
      this.#db
        .select({ value: channelState.value })
        .from(channelState)
        .where(
          and(
            eq(channelState.channel, channel),
            eq(channelState.key, key),
            sql`(${channelState.expiresAt} IS NULL OR ${channelState.expiresAt} > ${now.epochMilliseconds})`,
          ),
        ),
    );
    // An expired entry reads as absent rather than being deleted here. The sweep removes it
    // (`channel_state_expiry_idx`), and a read that wrote would turn every adapter's cursor lookup
    // into a write — on the ingestion hot path, inside somebody else's transaction.
    return row?.value;
  }

  putChannelState(
    uow: TxToken,
    entry: {
      readonly channel: ChannelId;
      readonly key: string;
      readonly value: string;
      readonly expiresAt?: Instant;
    },
  ): WriteResult<void> {
    const row = {
      channel: entry.channel,
      key: entry.key,
      value: entry.value,
      expiresAt: entry.expiresAt ?? null,
      updatedAt: uow.now,
    };
    this.#db
      .insert(channelState)
      .values(row)
      .onConflictDoUpdate({
        target: [channelState.channel, channelState.key],
        set: { value: row.value, expiresAt: row.expiresAt, updatedAt: row.updatedAt },
      })
      .run();
    return writeOk(undefined);
  }

  deleteChannelState(_uow: TxToken, channel: ChannelId, key: string): WriteResult<void> {
    this.#db
      .delete(channelState)
      .where(and(eq(channelState.channel, channel), eq(channelState.key, key)))
      .run();
    return writeOk(undefined);
  }

  // --- Interaction tokens -----------------------------------------------------------------------

  createInteractionToken(
    _uow: TxToken,
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
  ): WriteResult<{ readonly id: InteractionTokenId }> {
    const id = this.#ids.next('itk');
    try {
      this.#db
        .insert(interactionTokens)
        .values({
          id,
          tokenHash: Buffer.from(token.tokenHash),
          groupId: token.groupId,
          conversationId: token.conversationId,
          outboxMessageId: token.outboxMessageId ?? null,
          action: token.action,
          allowedClickers:
            token.allowedClickers === 'any_member' ? 'any_member' : [...token.allowedClickers],
          singleUse: token.singleUse,
          expiresAt: token.expiresAt,
          usedAt: null,
          usedByMemberId: null,
          createdByTurnId: token.createdByTurnId ?? null,
        })
        .run();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // 128 bits of randomness collided, or the caller minted the same token twice. Either way the
      // existing row's action is the one the rendered button carries.
      const existing = maybeOne(
        this.#db
          .select({ id: interactionTokens.id })
          .from(interactionTokens)
          .where(eq(interactionTokens.tokenHash, Buffer.from(token.tokenHash))),
      );
      return duplicate(existing?.id ?? 'unknown');
    }
    return writeOk({ id });
  }

  spendInteractionToken(
    _uow: TxToken,
    use: { readonly tokenHash: Uint8Array; readonly now: Instant; readonly byMemberId: MemberId },
  ):
    | {
        readonly kind: 'ok';
        readonly groupId: GroupId;
        readonly conversationId: ConversationId;
        readonly action: InteractionAction;
        readonly allowedClickers: AllowedClickers;
      }
    | { readonly kind: 'not_found' }
    | { readonly kind: 'expired' }
    | { readonly kind: 'already_used' } {
    const digest = Buffer.from(use.tokenHash);
    // One statement, addressed by the unique `token_hash`, carrying both preconditions. `single_use
    // = 0 OR used_at IS NULL` is what makes a single-use button single-use; with the check in
    // TypeScript instead, two members pressing at the same moment would both get `ok`.
    const won = maybeOne(
      this.#db
        .update(interactionTokens)
        .set({ usedAt: use.now, usedByMemberId: use.byMemberId })
        .where(
          and(
            eq(interactionTokens.tokenHash, digest),
            sql`${interactionTokens.expiresAt} > ${use.now.epochMilliseconds}`,
            // A reusable button records its **last** press; only a single-use one is spent.
            sql`(${interactionTokens.singleUse} = 0 OR ${interactionTokens.usedAt} IS NULL)`,
          ),
        )
        .returning(),
    );
    if (won !== undefined) {
      return {
        kind: 'ok',
        groupId: won.groupId,
        conversationId: won.conversationId,
        action: won.action,
        allowedClickers: won.allowedClickers,
      };
    }

    const found = maybeOne(
      this.#db
        .select({ expiresAt: interactionTokens.expiresAt })
        .from(interactionTokens)
        .where(eq(interactionTokens.tokenHash, digest)),
    );
    if (found === undefined) return { kind: 'not_found' };
    if (atOrAfter(use.now, found.expiresAt)) return { kind: 'expired' };
    return { kind: 'already_used' };
  }

  // --- Shared lookups ---------------------------------------------------------------------------

  /**
   * The one code a digest names, as a subquery (`06` §3.20.1's "either redeems the code once").
   *
   * `LIMIT 1` is load-bearing rather than defensive. `code_hash` and `link_token_hash` are each
   * unique, so a single value can match at most one row *per column* — but that is two rows, and
   * an `UPDATE … WHERE code_hash = h OR link_token_hash = h` would spend both. A 256-bit digest
   * equal to one code's typed hash and another's token hash is not going to happen; neither is a
   * 40-bit code collision, and `code_hash` is unique anyway.
   */
  #claimTarget(codeHash: Uint8Array) {
    const digest = Buffer.from(codeHash);
    return this.#db
      .select({ id: claimCodes.id })
      .from(claimCodes)
      .where(or(eq(claimCodes.codeHash, digest), eq(claimCodes.linkTokenHash, digest)))
      .limit(1);
  }

  #claimRow(codeHash: Uint8Array): typeof claimCodes.$inferSelect | undefined {
    const digest = Buffer.from(codeHash);
    return maybeOne(
      this.#db
        .select()
        .from(claimCodes)
        .where(or(eq(claimCodes.codeHash, digest), eq(claimCodes.linkTokenHash, digest))),
    );
  }

  /** The one link code a digest names, as a subquery. Same reasoning as `#claimTarget`. */
  #linkTarget(codeHash: Uint8Array) {
    const digest = Buffer.from(codeHash);
    return this.#db
      .select({ id: linkCodes.id })
      .from(linkCodes)
      .where(or(eq(linkCodes.codeHash, digest), eq(linkCodes.tokenHash, digest)))
      .limit(1);
  }

  #linkRow(codeHash: Uint8Array): typeof linkCodes.$inferSelect | undefined {
    const digest = Buffer.from(codeHash);
    return maybeOne(
      this.#db
        .select()
        .from(linkCodes)
        .where(or(eq(linkCodes.codeHash, digest), eq(linkCodes.tokenHash, digest))),
    );
  }
}

/**
 * Where a fixed window stands right now (`02` §3.3.11).
 *
 * Shared by the dry run and the spend so the two cannot disagree — a reader that answered a
 * different question from the writer would make `rateLimit` a prediction rather than a preview.
 *
 * **An expired lockout rolls the window.** `06` §3.20.1 reads "after that the bot ignores further
 * attempts there for 1 h", and what follows an hour of being ignored is a fresh allowance. Keeping
 * the old count would re-lock on the first attempt after release whenever the lockout is shorter
 * than the window — which is a lockout that never ends, reached by a configuration rather than by
 * a decision.
 */
function windowState(
  row: typeof rateLimits.$inferSelect | undefined,
  now: Instant,
  windowMs: number,
):
  | { readonly kind: 'locked'; readonly verdict: RateLimitVerdict }
  | { readonly kind: 'open'; readonly count: number; readonly windowStart: Instant | undefined } {
  if (row === undefined) return { kind: 'open', count: 0, windowStart: undefined };
  if (row.lockedUntil !== null && !atOrAfter(now, row.lockedUntil)) {
    return {
      kind: 'locked',
      verdict: { allowed: false, count: row.count, lockedUntil: row.lockedUntil },
    };
  }
  const lockReleased = row.lockedUntil !== null;
  const elapsed = now.epochMilliseconds - row.windowStart.epochMilliseconds;
  if (lockReleased || elapsed >= windowMs) {
    return { kind: 'open', count: 0, windowStart: undefined };
  }
  return { kind: 'open', count: row.count, windowStart: row.windowStart };
}
