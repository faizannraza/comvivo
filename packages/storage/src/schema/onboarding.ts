/**
 * Channel onboarding and identity linking (`02` §3.3.11; `06` §3.20.1, §3.18.1, §3.7).
 *
 * ## Nothing here stores a secret
 *
 * Every code, token and session id in this file is a **`sha256` digest**, compared in constant
 * time on the normalised form. `02` §3.3.11 says so and `08` §3.7.13 enforces the comparison with
 * its own lint rule. The reason is specific rather than ceremonial: a claim code is 40 bits, which
 * is only safe because it is short-lived, single-use and attempt-limited — and a database file
 * that leaked the plaintext would hand somebody a live code, whereas a digest hands them nothing
 * before the TTL expires.
 *
 * `02` §3.3.11 also puts `sessions` and the dashboard's auth tables in `auth.ts`. They are not
 * here: `M3-T1`'s Files column names `onboarding.ts`, and dashboard auth arrives with the server
 * tasks that need it.
 *
 * ## Why the counters are in two places and that is not a duplication
 *
 * `06` §3.20.1 names two limits on claim redemption, and they count different things:
 *
 *  - **Per chat**, ≤ 5 failed attempts per hour, then the bot ignores that chat for an hour. The
 *    scope is a *chat*, which may have tried many codes, so it lives in `rate_limits` under
 *    `claim.chat:<channel>:<platformChatId>`.
 *  - **Per code**, 10 failed attempts burn it. The scope is a *code*, so it is a column on the
 *    code's own row.
 *
 * `02` §3.3.1 additionally sketches a `chat_bindings.claim_failures` JSON column for the first of
 * those. It is **not implemented**, and the deviation is in `STATUS.md` → Plan changes: §3.20.1
 * explicitly designates `rate_limits` for it ("Both counters live in 02 `rate_limits` … and the
 * code row's `failedAttempts`"), and two homes for one rate-limit counter is how a limit comes to
 * be enforced in one place and not the other.
 */
import { allowedClickersSchema, interactionActionSchema } from '@comvivo/core';
import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { bool, boolCheckSql, createdAt, instantMs, jsonOf, tid, updatedAt } from './_columns.js';
import { groups } from './groups.js';
import { channelIdentities, persons } from './identity.js';

/**
 * A single-use code that binds a platform chat to a group (`06` §3.20.1; `01` §14 **A27**).
 *
 * A27's binding rule has no other path: a chat binds **only** by redeeming one of these. That is
 * what makes "the bot was added to a chat" and "a group owns this chat" different facts, and it is
 * why an unclaimed chat persists nothing but its binding row.
 *
 * `kind` separates the instance's first claim — which makes the redeemer the **host** and is
 * `09` §3.9.4's — from a group admin adding a chat. Both redeem here; only one creates a host.
 *
 * Two hashes, because `06` §3.20.1 issues two forms of the same grant: a typed
 * `VLG-XXXX-XXXX` (40 bits, for somebody reading it aloud) and a 128-bit `c_<22 chars>` link
 * token that a deep link carries. Either redeems the code once.
 */
export const claimCodes = sqliteTable('claim_codes', {
  id: tid('clm')('id').primaryKey(),
  kind: text('kind', { enum: ['host', 'group'] }).notNull(),
  /** `sha256` of the normalised typed code. Never the code. */
  codeHash: blob('code_hash', { mode: 'buffer' }).notNull().unique(),
  /** `sha256` of the link token, when one was issued. */
  linkTokenHash: blob('link_token_hash', { mode: 'buffer' }),
  /** `NULL` makes the code channel-agnostic (`village group claim` without `--channel`). */
  channel: text('channel'),
  /** `NULL` creates a new group on redemption. */
  groupId: tid('grp')('group_id').references(() => groups.id, { onDelete: 'cascade' }),
  /** An archetype template, e.g. `family@1`. The picker lands at `M4-T1`. */
  template: text('template'),
  createdByPersonId: tid('prs')('created_by_person_id').references(() => persons.id),
  createdAt: createdAt(),
  expiresAt: instantMs('expires_at').notNull(),
  /** Burned after 10 (`09` §3.7). The per-**chat** window is in `rate_limits`; see the header. */
  failedAttempts: integer('failed_attempts').notNull().default(0),
  /**
   * Set on redemption, and **this column is the single-use guarantee**.
   *
   * The redeeming statement is a conditional `UPDATE … WHERE used_at IS NULL`, so two concurrent
   * redemptions of one code produce one winner and one zero-row update. Checking first and
   * writing after would leave a window where both reads see `NULL` — and the loser of that race
   * would bind a second chat to the group, which is the one thing A27 exists to prevent.
   */
  usedAt: instantMs('used_at'),
  usedInChat: text('used_in_chat'),
  usedByPersonId: tid('prs')('used_by_person_id'),
});

/**
 * A code that links one person's identity on a second platform (`06` §3.18.1).
 *
 * Four states rather than a boolean, because linking is a two-party handshake: `issued` by the
 * person who already has an account, `redeemed` when somebody enters it on the other platform,
 * `confirmed` when the issuer approves **that specific** redeemer, `cancelled` otherwise. Without
 * the `redeemed` → `confirmed` step, anyone who intercepted a 40-bit code would be linked to a
 * stranger's person, which is an identity takeover rather than an inconvenience.
 */
export const linkCodes = sqliteTable(
  'link_codes',
  {
    id: tid('lnk')('id').primaryKey(),
    codeHash: blob('code_hash', { mode: 'buffer' }).notNull().unique(),
    tokenHash: blob('token_hash', { mode: 'buffer' }).notNull().unique(),
    issuerPersonId: tid('prs')('issuer_person_id')
      .notNull()
      .references(() => persons.id),
    issuerChannelIdentityId: tid('chid')('issuer_channel_identity_id')
      .notNull()
      .references(() => channelIdentities.id, { onDelete: 'cascade' }),
    state: text('state', { enum: ['issued', 'redeemed', 'confirmed', 'cancelled'] }).notNull(),
    redeemedByIdentityId: tid('chid')('redeemed_by_identity_id'),
    createdAt: createdAt(),
    /** 10 minutes (`06` §3.20.1's format section). */
    expiresAt: instantMs('expires_at').notNull(),
  },
  (t) => [
    index('link_codes_issuer_idx').on(t.issuerPersonId, t.state),
    // A redeemer is recorded exactly when the state says there is one. A `confirmed` row with no
    // redeemer would be a link to nobody; a `redeemed` row without one cannot be confirmed.
    check(
      'link_codes_redeemer_ck',
      sql`(${t.state} IN ('redeemed', 'confirmed')) = (${t.redeemedByIdentityId} IS NOT NULL)`,
    ),
  ],
);

/*
 * `invite_codes` is **not** here, deliberately.
 *
 * `02` §3.3.11's code block includes it beside these tables and `09` §4.6 owns its semantics — but
 * `14` M3-T1's task title enumerates what this task creates ("Bindings, aliases, DM contexts,
 * claim/link codes, interaction tokens, channel state, rate limits") and a dashboard invitation is
 * not on it. `scripts/schema/checklist.ts` assigns it to **M9**, which is the milestone that
 * builds the dashboard that sends one. Creating it now would be a table nothing can use, and the
 * checklist's second direction — it fails on a deferred table that already exists — is what made
 * the over-reach visible.
 */

/**
 * What a button press means (`06` §3.7, CH-7).
 *
 * **This row is the only button payload on every platform.** No structured string ever goes into
 * `callback_data`, `custom_id` or `value` — the wire carries `v1.` plus 22 base64url characters
 * and nothing else. The reason is unforgeability: a payload like `cnf:abc:approve` is something a
 * member can read, guess at and send back, and `06` §3.7 is explicit that authority is the
 * clicker's and is re-checked on every click (invariant **I3**).
 *
 * `allowed_clickers` narrows who the button was *offered* to and is **not** the authorisation.
 * Policy re-checks on the press, because a member whose role changed between the render and the
 * press must be refused and only policy knows that.
 */
export const interactionTokens = sqliteTable(
  'interaction_tokens',
  {
    id: tid('itk')('id').primaryKey(),
    tokenHash: blob('token_hash', { mode: 'buffer' }).notNull().unique(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    conversationId: tid('cnv')('conversation_id').notNull(),
    outboxMessageId: tid('obx')('outbox_message_id'),
    action: jsonOf(interactionActionSchema, 'interaction_tokens.action')('action').notNull(),
    allowedClickers: jsonOf(
      allowedClickersSchema,
      'interaction_tokens.allowed_clickers',
    )('allowed_clickers').notNull(),
    singleUse: bool('single_use').notNull(),
    /** Default 7 days, set by the caller. */
    expiresAt: instantMs('expires_at').notNull(),
    usedAt: instantMs('used_at'),
    usedByMemberId: tid('mbr')('used_by_member_id'),
    createdByTurnId: tid('trn')('created_by_turn_id'),
  },
  (t) => [
    // The sweep's only question: which tokens have expired? Buttons accumulate fast — a digest
    // with six actions is six rows per group per day.
    index('interaction_tokens_expiry_idx').on(t.expiresAt),
    check('interaction_tokens_single_use_bool_ck', boolCheckSql(t.singleUse)),
    check('interaction_tokens_used_ck', sql`(${t.usedAt} IS NULL) = (${t.usedByMemberId} IS NULL)`),
  ],
);

/**
 * An adapter's durable key/value (`02` §3.3.11; `06` §4.2).
 *
 * Update-id rings, sync tokens, read cursors — the state that makes a restart continue rather
 * than replay. `value_json` is ≤ 64 KiB and **the adapter validates it**: this table is shared by
 * every channel and a schema here would be every adapter's state in one type.
 *
 * The expiry index is partial because most rows never expire: a sync token is kept until it is
 * replaced, and only the TTL'd entries need sweeping.
 */
export const channelState = sqliteTable(
  'channel_state',
  {
    channel: text('channel').notNull(),
    key: text('key').notNull(),
    value: text('value_json').notNull(),
    expiresAt: instantMs('expires_at'),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.channel, t.key] }),
    index('channel_state_expiry_idx').on(t.expiresAt).where(sql`${t.expiresAt} IS NOT NULL`),
    // `02` §3.3.9 caps this at 64 KiB, and the cap is enforced **here** rather than by a `jsonOf`
    // schema because the content is the adapter's own — a schema in this file would be every
    // adapter's state in one type, which is the thing `06` §4.2 keeps out of `02`. A `CHECK` is
    // the right shape for a limit whose only property is a size: it holds for an adapter this
    // build has never seen, and it holds against a write from an older version of one.
    check('channel_state_value_len_ck', sql`length(${t.value}) <= 65536`),
  ],
);

/**
 * Counters that must survive a restart (`02` §3.3.11; `06`'s claim and link limits, `09`).
 *
 * A fixed-window counter keyed by scope — `claim.chat:<channel>:<platformChatId>`,
 * `link_fail:<chid>`. In the database rather than in memory because the limit it enforces is a
 * **security** limit: a 40-bit claim code is only safe while attempts are capped, and a process
 * restart that reset the counter would turn "5 attempts per hour" into "5 attempts per restart".
 *
 * `locked_until` is the lockout rather than something derived from the window, so the two
 * decisions a caller makes — "is this locked?" and "has the window rolled?" — are each one column
 * read, and a lockout outlives its window without arithmetic.
 */
export const rateLimits = sqliteTable('rate_limits', {
  scopeKey: text('scope_key').primaryKey(),
  windowStart: instantMs('window_start').notNull(),
  count: integer('count').notNull(),
  lockedUntil: instantMs('locked_until'),
});
