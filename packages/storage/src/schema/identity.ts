/**
 * The instance, the people in it, and their platform accounts (`02` §3.3.1).
 *
 * These three tables carry the identity chain the spine resolves on every inbound message
 * (`01` §241 step 3): a `ChannelIdentity` identifies a platform account, which maps to a `Person`,
 * which has a `Member` row per group. The split is what lets one human be known to Telegram and
 * Discord under different names and still be one person with one set of memories — and it is also
 * what makes erasure possible, because `persons` is the single row whose `erased_at` makes a human
 * unidentifiable without deleting the group's history.
 */

import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { bool, boolCheckSql, createdAt, instantMs, tid, tzText, updatedAt } from './_columns.js';

/**
 * The single row describing this installation (`02` §3.3.1).
 *
 * `singleton` with a `UNIQUE` index and a `CHECK (= 1)` is how a one-row table is expressed in
 * SQLite: the unique constraint allows one row with the value `1`, and the check forbids every
 * other value, so a second `INSERT` fails on the constraint rather than on application code that
 * might not run. `02` §3.8.1's boot sequence reads this row to decide whether the data directory
 * has been initialised.
 */
export const instance = sqliteTable(
  'instance',
  {
    id: tid('inst')('id').primaryKey(),
    singleton: integer('singleton').notNull().default(1).unique(),
    name: text('name').notNull(),
    // Declared before `persons` in `02` §3.3.1's order, so the reference is a forward one. The
    // `AnySQLiteColumn` annotation is what stops TypeScript inferring a circular type; drizzle
    // calls the thunk lazily, so there is no initialisation-order hazard at runtime.
    ownerPersonId: tid('prs')('owner_person_id').references((): AnySQLiteColumn => persons.id),
    createdAt: createdAt(),
  },
  (t) => [check('instance_singleton_ck', sql`${t.singleton} = 1`)],
);

/**
 * A human (`02` §3.3.1).
 *
 * `locale` and `timezone` are nullable and mean *inherit from the group* rather than *unknown*,
 * which is why neither has a default: `07` SC-2 requires a group to have both, and a person who
 * has never stated a preference should follow the group when it changes rather than being pinned
 * to whatever the group's value was on the day they joined.
 *
 * `display_name_source` records whether the name came from the platform or the person set it
 * themselves (`06`). Without it, a platform display-name refresh would silently overwrite a
 * nickname someone deliberately chose.
 *
 * `erased_at` is the right-to-be-forgotten marker (`02` §3.13.5): the row stays so that ids in
 * `audit_events`, `labels` and `reader_sets` keep resolving, with `display_name` set to
 * 'Former member' and the two preference columns nulled.
 */
export const persons = sqliteTable('persons', {
  id: tid('prs')('id').primaryKey(),
  displayName: text('display_name').notNull(),
  displayNameSource: text('display_name_source', { enum: ['platform', 'member'] })
    .notNull()
    .default('platform'),
  /** BCP 47. `NULL` inherits the group's. */
  locale: text('locale'),
  /** `NULL` inherits the group's. */
  timezone: tzText('timezone'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  erasedAt: instantMs('erased_at'),
});

/**
 * A platform account linked to a person (`02` §3.3.1).
 *
 * `channel_identities_platform_uq` is the index the ingestion fast path hits for every single
 * message (Q-ING-3), which is why it is a unique index on exactly `(channel, platform_user_id)`:
 * the lookup is the identity resolution, and the uniqueness is what guarantees one platform
 * account cannot resolve to two people.
 *
 * `platform_username` is deliberately not a phone number. `06` is explicit that a Signal identity
 * must never store one here — a phone number is the one platform handle that is also a direct
 * contact channel outside the product, and `08` keeps it out of the database entirely.
 *
 * `dm_reachable` and `dm_chat_id` record whether the bot may open a direct message with this
 * identity (`06` §3.18). Most platforms forbid a bot from initiating a DM until the user has
 * messaged it once, so "can we DM this person" is a fact we learn and must persist, not something
 * we can derive.
 */
export const channelIdentities = sqliteTable(
  'channel_identities',
  {
    id: tid('chid')('id').primaryKey(),
    /** `ChannelId` (`01` §1). Open-ended: `10` lets a plugin register a channel. */
    channel: text('channel').notNull(),
    platformUserId: text('platform_user_id').notNull(),
    personId: tid('prs')('person_id')
      .notNull()
      .references(() => persons.id),
    /** `06` `platformDisplayName`, as it was when last seen. */
    displayNameSnapshot: text('display_name_snapshot').notNull(),
    /** `06`; never a Signal phone number. */
    platformUsername: text('platform_username'),
    isBot: bool('is_bot').notNull().default(false),
    /** `06` §3.18: the bot is allowed to open a DM with this identity. */
    dmReachable: bool('dm_reachable').notNull().default(false),
    /** The platform DM chat with this identity, once known. */
    dmChatId: text('dm_chat_id'),
    verifiedAt: instantMs('verified_at'),
    lastSeenAt: instantMs('last_seen_at'),
    createdAt: createdAt(),
  },
  (t) => [
    // Q-ING-3: the identity lookup on every inbound message.
    uniqueIndex('channel_identities_platform_uq').on(t.channel, t.platformUserId),
    // Q-PRV-1: every identity of a person, for erasure (`02` §3.13.5 step 1).
    index('channel_identities_person_idx').on(t.personId),
    check('channel_identities_is_bot_ck', boolCheckSql(t.isBot)),
    check('channel_identities_dm_reachable_ck', boolCheckSql(t.dmReachable)),
  ],
);
