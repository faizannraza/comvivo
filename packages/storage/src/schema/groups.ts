/**
 * Groups, their members, guardianship and bound conversations (`02` §3.3.1).
 *
 * This is where the product's central claim becomes a schema: the agent belongs to a *group*, so
 * the group — not a user — owns the constitution, the timezone, the locale and the conversation
 * history. `members` is the join that gives a person a role inside one group, and every row in
 * every other table that carries content hangs off `group_id` with `ON DELETE CASCADE`, which is
 * what makes invariant **I4** (group isolation) a property of the database and not of a query that
 * might forget a `WHERE`.
 */
import { ARCHETYPES } from '@comvivo/core';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  bool,
  boolCheckSql,
  createdAt,
  instantMs,
  tid,
  tzText,
  updatedAt,
  version,
} from './_columns.js';
import { persons } from './identity.js';

/**
 * A group (`02` §3.3.1).
 *
 * `timezone` and `locale` are `NOT NULL` here while the same columns on `persons` are nullable, and
 * the asymmetry is `07` SC-2: scheduling needs *some* zone to resolve "Tuesday at 7" into an
 * instant, and a group is the last place that can supply one. A person may decline to say.
 *
 * `membership_epoch` increments whenever membership changes. `02` §3.13.6 and `03`'s eligibility
 * rules use it so that a `kind='group'` reader set means "whoever is in the group *now*" without
 * rewriting reader sets when someone leaves — a left member drops out of every group audience by
 * the epoch alone.
 *
 * `status='deleting'` is `02` D18's first move in a group purge: it stops access immediately, in
 * one small transaction, before the resumable chunked job starts deleting anything.
 */
export const groups = sqliteTable(
  'groups',
  {
    id: tid('grp')('id').primaryKey(),
    name: text('name').notNull(),
    /** The constitution template this group started from (`00` §5). Amendments do not change it. */
    archetype: text('archetype', { enum: ARCHETYPES }).notNull(),
    /**
     * The constitution in force (`03`). **Deliberately without a foreign key.**
     *
     * Nullable only for the span of the group-creation transaction, which has to insert the group
     * before the constitution version that references it — and that ordering is the whole reason
     * the column exists rather than the group being derived from its versions.
     *
     * `02` §3.3.1 writes this with `.references((): AnySQLiteColumn => constitutionVersions.id)`,
     * which is cycle-free in a single-file listing and is not here: `governance.ts` must import
     * this module for `constitution_versions.group_id`, so declaring the reverse reference makes
     * `groups.ts → governance.ts → groups.ts`. Dependency-cruiser refuses it, and is right to —
     * `CLAUDE.md` §2 says to fix the design rather than weaken the rule, and the design point is
     * that the identity layer must not depend on governance.
     *
     * What is lost is small and what remains covers it: `constitution_versions.group_id` cascades,
     * so a purged group takes its versions with it, and the pointer is set in the same transaction
     * that creates the version it names (`M1-T20`'s governance repository owns that write). The
     * data model's reference genuinely is cyclic; only one of the two directions can be an ORM
     * foreign key in a layered module structure, and the cascading one is the one that matters.
     */
    constitutionVersionId: tid('cnst')('constitution_version_id'),
    /** `since_join` keeps a new member out of history they were never part of. */
    historyVisibility: text('history_visibility', { enum: ['since_join', 'all'] })
      .notNull()
      .default('since_join'),
    /** `07` SC-2: scheduling needs a zone, and the group is the last place that can supply one. */
    timezone: tzText('timezone').notNull(),
    locale: text('locale').notNull().default('en'),
    /** `07` SC-2. The conversation with `conversations.primary = 1`; see `conversations` below. */
    primaryConversationId: tid('cnv')('primary_conversation_id'),
    /** ISO weekday 1–7 (`07`): which day the group's week starts on. */
    weekStart: integer('week_start').notNull().default(1),
    status: text('status', { enum: ['active', 'archived', 'deleting'] })
      .notNull()
      .default('active'),
    /** `02` §3.13.6: bumped on every membership change, so group audiences need no rewrite. */
    membershipEpoch: integer('membership_epoch').notNull().default(0),
    /** `10` `groupExtensionsVersion`: the cache key for this group's tool catalog. */
    extensionsVersion: integer('extensions_version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    index('groups_status_idx').on(t.status),
    check('groups_week_start_ck', sql`${t.weekStart} BETWEEN 1 AND 7`),
  ],
);

/**
 * A person's membership of one group (`02` §3.3.1).
 *
 * `members_ageband_ck` is the one constraint in this file worth reading twice:
 * `(role = 'child') = (age_band <> 'adult')`. It makes the child role and a non-adult age band
 * imply each other in *both* directions, so neither "a child with `age_band='adult'`" nor "a
 * teen with `role='member'`" can exist. `03`'s guardian approval keys off the role while its
 * content rules key off the age band, and letting those two disagree would mean a minor could be
 * handled as an adult by one half of the policy engine and as a child by the other.
 *
 * `handle` is `05` S4's stable per-group short name (`m3`). It exists so the model can be given a
 * short, non-identifying token for a member in a prompt, and `members_group_handle_uq` plus the
 * never-reuse rule is what keeps a handle from ever pointing at two different people.
 */
export const members = sqliteTable(
  'members',
  {
    id: tid('mbr')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    personId: tid('prs')('person_id')
      .notNull()
      .references(() => persons.id),
    /** `03` `RoleId`. */
    role: text('role', { enum: ['admin', 'member', 'child', 'guest'] }).notNull(),
    /** `03`: a `child` role implies a non-adult band, and the reverse (see the check below). */
    ageBand: text('age_band', { enum: ['adult', 'teen', 'child'] })
      .notNull()
      .default('adult'),
    /** `05` S4: stable and unique per group, e.g. `m3`; never reused. */
    handle: text('handle').notNull(),
    status: text('status', { enum: ['invited', 'active', 'left'] }).notNull(),
    /** `03` §Consent. `unknown` until the member has seen the consent notice. */
    consent: text('consent', { enum: ['unknown', 'informed', 'memory_on', 'memory_off'] })
      .notNull()
      .default('unknown'),
    nickname: text('nickname'),
    joinedAt: instantMs('joined_at').notNull(),
    leftAt: instantMs('left_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    // Q-ING-4: one membership per person per group.
    uniqueIndex('members_group_person_uq').on(t.groupId, t.personId),
    uniqueIndex('members_group_handle_uq').on(t.groupId, t.handle),
    check('members_ageband_ck', sql`(${t.role} = 'child') = (${t.ageBand} <> 'adult')`),
    // Q-PRV-1: every membership of a person, for erasure.
    index('members_person_idx').on(t.personId),
    // Q-CTX-9: the group snapshot that context assembly builds on every turn.
    index('members_group_status_idx').on(t.groupId, t.status),
  ],
);

/**
 * Who may approve on a minor's behalf (`03` §3.1.1 `GuardianRelation`).
 *
 * `created_by_member_id` is recorded alongside the pair because adding a guardian is itself a
 * governance act: `03` requires an admin to establish the relation, and an audit reader needs to
 * know who claimed guardianship, not only that someone did.
 *
 * The primary key is `(ward, guardian)` rather than a surrogate id, so the same guardianship
 * cannot be recorded twice — and `guardian_relations_guardian_idx` answers the other direction,
 * "whose guardian is this member", which `03` asks on every confirmation a minor triggers.
 */
export const guardianRelations = sqliteTable(
  'guardian_relations',
  {
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    wardMemberId: tid('mbr')('ward_member_id')
      .notNull()
      .references(() => members.id),
    guardianMemberId: tid('mbr')('guardian_member_id')
      .notNull()
      .references(() => members.id),
    createdByMemberId: tid('mbr')('created_by_member_id')
      .notNull()
      .references(() => members.id),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.wardMemberId, t.guardianMemberId] }),
    index('guardian_relations_guardian_idx').on(t.guardianMemberId),
  ],
);

/**
 * A bound chat (`02` §3.3.1; `06` §3.20, `01` §14 A27).
 *
 * A row exists only once a chat has been *claimed* by a group. An unclaimed chat the bot was added
 * to persists nothing but its `chat_bindings` row (A27), which is what stops the product from
 * accumulating conversations and persons for every group someone adds it to by accident.
 *
 * Three constraints encode `03` §3.4.4's rules about audience:
 *
 *  - `conversations_dm_ck` makes `kind='dm'` and a non-null `member_id` imply each other, so a DM
 *    always has an owner and a group chat never does;
 *  - `conversations_primary_ck` forbids a DM from being the primary conversation, because `01`
 *    §14 A7 defines primary as *the conversation whose membership is the whole group*;
 *  - `conversations_one_primary_uq` is a **partial** unique index — unique on `group_id` only over
 *    rows where `primary = 1` — which is how SQLite expresses "at most one primary per group"
 *    without forbidding many non-primary conversations.
 *
 * `conversations_platform_uq` includes `group_id` because `01` §14 A27 maps one platform DM chat
 * to one DM conversation **per group**: a person in three groups has three DM conversations in the
 * same platform chat, with the active one tracked in `dm_contexts` (`M3-T1`).
 */
export const conversations = sqliteTable(
  'conversations',
  {
    id: tid('cnv')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    /** `ChannelId`, including `web`, `simulator` and `mcp` (`10`). */
    channel: text('channel').notNull(),
    platformChatId: text('platform_chat_id').notNull(),
    kind: text('kind', { enum: ['group', 'dm'] }).notNull(),
    /** The DM's owner. Non-null exactly when `kind = 'dm'`. */
    memberId: tid('mbr')('member_id').references(() => members.id),
    /** `03` §3.4.4: this conversation's membership is the whole group (`01` §14 A7). */
    primary: bool('primary').notNull().default(false),
    title: text('title'),
    boundAt: instantMs('bound_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Q-ING-2: the conversation lookup on every inbound message.
    uniqueIndex('conversations_platform_uq').on(t.channel, t.platformChatId, t.groupId),
    uniqueIndex('conversations_one_primary_uq').on(t.groupId).where(sql`${t.primary} = 1`),
    index('conversations_group_idx').on(t.groupId, t.kind),
    check('conversations_dm_ck', sql`(${t.kind} = 'dm') = (${t.memberId} IS NOT NULL)`),
    check('conversations_primary_ck', sql`${t.primary} = 0 OR ${t.kind} = 'group'`),
    check('conversations_primary_bool_ck', boolCheckSql(t.primary)),
  ],
);
