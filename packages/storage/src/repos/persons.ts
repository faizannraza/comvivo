/**
 * The person and channel-identity repositories (`02` §3.7.1, §3.3.1).
 *
 * These two sit together because every inbound message touches both: Q-ING-3 resolves an identity
 * by `(channel, platformUserId)` and that row names the person. Keeping them in one module keeps
 * the two prepared statements the ingestion path leans on in one place.
 *
 * **`persons` has no `group_id`**, which makes it the one aggregate here whose reads are not
 * group-scoped — a person exists across groups by design (`02` §3.3.1). That is not an `I4` hole:
 * `I4` governs group *content*, and a person's display name is what every group they are in
 * already sees. What `I4` does forbid is learning *which other groups* someone is in, so
 * `byPersonAcrossGroups` lives on the member reader with the erasure callers, and nothing here
 * exposes a person's group list.
 */
import type {
  ChannelId,
  ChannelIdentity,
  ChannelIdentityReader,
  ChannelIdentityRepository,
  NewChannelIdentity,
  NewPerson,
  Person,
  PersonReader,
  PersonRepository,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import { duplicate, FORMER_MEMBER_NAME, notFound, writeOk } from '@comvivo/core';
import type { ChannelIdentityId, GroupId, PersonId } from '@comvivo/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import { type Db, exactlyOne, maybeOne } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import { channelIdentities, members, persons } from '../schema/index.js';
import { toChannelIdentity, toPerson } from './rows.js';

export class SqlitePersonRepository implements PersonReader, PersonRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  byId(id: PersonId): Person | undefined {
    const row = maybeOne(this.#db.select().from(persons).where(eq(persons.id, id)));
    return row === undefined ? undefined : toPerson(row);
  }

  /**
   * Q-PRV-1: the persons reachable through one group.
   *
   * A join through `members` rather than two queries, because the caller — erasure, or a departure
   * sweep — wants the set and not the memberships, and the join is covered by
   * `members_group_status_idx` on the driving side.
   *
   * Includes members who have **left**: `02` §3.13's departure path has to find the person whose
   * membership ended, and filtering to `active` here would make the one caller that matters find
   * nobody.
   */
  byGroup(groupId: GroupId): readonly Person[] {
    const rows = this.#db
      .select({ person: persons })
      .from(members)
      .innerJoin(persons, eq(persons.id, members.personId))
      .where(eq(members.groupId, groupId))
      .orderBy(asc(persons.id))
      .all();
    return rows.map((row) => toPerson(row.person));
  }

  create(uow: TxToken, person: NewPerson): WriteResult<Person> {
    try {
      const row = exactlyOne(
        this.#db
          .insert(persons)
          .values({
            id: person.id,
            displayName: person.displayName,
            displayNameSource: person.displayNameSource ?? 'platform',
            locale: person.locale,
            timezone: person.timezone,
            createdAt: uow.now,
            updatedAt: uow.now,
          })
          .returning(),
        'the person',
      );
      return writeOk(toPerson(row));
    } catch (error) {
      if (isUniqueViolation(error)) return duplicate(person.id);
      throw error;
    }
  }

  /**
   * Rename, recording where the name came from.
   *
   * **Refuses to overwrite a `member`-sourced name with a `platform`-sourced one.** `06` lets a
   * platform rename update a name the platform supplied and never one the member chose, and the
   * check belongs here rather than at the call site: ingestion renames on every message whose
   * `displayNameSnapshot` moved, so a caller that forgot the rule would undo a member's choice on
   * their next message. Returns `ok` with the row unchanged, because nothing is wrong — the rename
   * simply does not apply.
   */
  rename(
    uow: TxToken,
    id: PersonId,
    displayName: string,
    source: Person['displayNameSource'],
  ): WriteResult<Person> {
    const current = maybeOne(
      this.#db
        .select({ source: persons.displayNameSource })
        .from(persons)
        .where(eq(persons.id, id)),
    );
    if (current === undefined) return notFound();
    if (source === 'platform' && current.source === 'member') {
      const unchanged = this.byId(id);
      return unchanged === undefined ? notFound() : writeOk(unchanged);
    }
    const row = maybeOne(
      this.#db
        .update(persons)
        .set({ displayName, displayNameSource: source, updatedAt: uow.now })
        .where(eq(persons.id, id))
        .returning(),
    );
    return row === undefined ? notFound() : writeOk(toPerson(row));
  }

  /**
   * Set or clear the person's own locale and timezone.
   *
   * `null` clears and `undefined` leaves alone — the one place in these repositories where the two
   * mean different things, because `02` §3.3.1 gives `NULL` the meaning "inherit group". A single
   * optional field could not express "stop overriding the group", which is a thing a member does.
   */
  setPreferences(
    uow: TxToken,
    id: PersonId,
    preferences: {
      readonly locale?: string | null | undefined;
      readonly timezone?: Person['timezone'] | null | undefined;
    },
  ): WriteResult<Person> {
    const row = maybeOne(
      this.#db
        .update(persons)
        .set({
          locale: preferences.locale,
          timezone: preferences.timezone,
          updatedAt: uow.now,
        })
        .where(eq(persons.id, id))
        .returning(),
    );
    return row === undefined ? notFound() : writeOk(toPerson(row));
  }

  /**
   * `08`'s erasure: replace the name, clear the preferences, stamp `erased_at`.
   *
   * The row stays (`02` §3.13 chooses referential integrity over deleting history), and the
   * preferences go because a timezone is itself identifying — it narrows someone to a region.
   * Idempotent: erasing twice writes the same values, which matters because erasure is a job and a
   * job can be retried.
   */
  erase(uow: TxToken, id: PersonId, at: Temporal.Instant): WriteResult<Person> {
    const row = maybeOne(
      this.#db
        .update(persons)
        .set({
          displayName: FORMER_MEMBER_NAME,
          displayNameSource: 'platform',
          locale: null,
          timezone: null,
          erasedAt: at,
          updatedAt: uow.now,
        })
        .where(eq(persons.id, id))
        .returning(),
    );
    return row === undefined ? notFound() : writeOk(toPerson(row));
  }
}

export class SqliteChannelIdentityRepository
  implements ChannelIdentityReader, ChannelIdentityRepository
{
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Q-ING-3, through `channel_identities_platform_uq`. The first lookup on every message. */
  byPlatform(channel: ChannelId, platformUserId: string): ChannelIdentity | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(channelIdentities)
        .where(
          and(
            eq(channelIdentities.channel, channel),
            eq(channelIdentities.platformUserId, platformUserId),
          ),
        ),
    );
    return row === undefined ? undefined : toChannelIdentity(row);
  }

  byId(id: ChannelIdentityId): ChannelIdentity | undefined {
    const row = maybeOne(
      this.#db.select().from(channelIdentities).where(eq(channelIdentities.id, id)),
    );
    return row === undefined ? undefined : toChannelIdentity(row);
  }

  /** Q-PRV-1, through `channel_identities_person_idx`. */
  byPerson(personId: PersonId): readonly ChannelIdentity[] {
    const rows = this.#db
      .select()
      .from(channelIdentities)
      .where(eq(channelIdentities.personId, personId))
      .orderBy(asc(channelIdentities.id))
      .all();
    return rows.map(toChannelIdentity);
  }

  /**
   * Record a platform account.
   *
   * Returns `duplicate` with the **existing row's** id rather than the one the caller proposed, so
   * `06`'s identity linking can look at who already holds the account — which may be a different
   * person, and is a conflict for `06` to resolve rather than for a repository to overwrite.
   */
  create(uow: TxToken, identity: NewChannelIdentity): WriteResult<ChannelIdentity> {
    try {
      const row = exactlyOne(
        this.#db
          .insert(channelIdentities)
          .values({
            id: identity.id,
            channel: identity.channel,
            platformUserId: identity.platformUserId,
            personId: identity.personId,
            displayNameSnapshot: identity.displayNameSnapshot,
            platformUsername: identity.platformUsername,
            isBot: identity.isBot ?? false,
            dmReachable: identity.dmReachable ?? false,
            dmChatId: identity.dmChatId,
            verifiedAt: identity.verifiedAt,
            lastSeenAt: identity.lastSeenAt,
            createdAt: uow.now,
          })
          .returning(),
        'the channel identity',
      );
      return writeOk(toChannelIdentity(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = this.byPlatform(identity.channel, identity.platformUserId);
      // The unique index is on `(channel, platformUserId)`; a collision on the primary key means
      // the caller reused an id, and then the id it proposed *is* the existing one.
      return duplicate(existing?.id ?? identity.id);
    }
  }

  /** The fields `06` refreshes from an inbound event, in one statement. */
  touch(
    _uow: TxToken,
    id: ChannelIdentityId,
    seen: {
      readonly displayNameSnapshot?: string | undefined;
      readonly platformUsername?: string | undefined;
      readonly dmReachable?: boolean | undefined;
      readonly dmChatId?: string | undefined;
      readonly lastSeenAt: Temporal.Instant;
    },
  ): WriteResult<ChannelIdentity> {
    const row = maybeOne(
      this.#db
        .update(channelIdentities)
        .set({
          displayNameSnapshot: seen.displayNameSnapshot,
          platformUsername: seen.platformUsername,
          dmReachable: seen.dmReachable,
          dmChatId: seen.dmChatId,
          lastSeenAt: seen.lastSeenAt,
        })
        .where(eq(channelIdentities.id, id))
        .returning(),
    );
    // `uow` is the token that proves a transaction is open (`02` §3.7.1); `lastSeenAt` comes from
    // the event rather than from the clock, because an identity last seen *when the message was
    // sent* is the useful fact, and a backfilled message would otherwise claim present contact.
    return row === undefined ? notFound() : writeOk(toChannelIdentity(row));
  }

  /** `08` erasure: an erased person keeps no platform accounts. Returns how many went. */
  deleteForPerson(_uow: TxToken, personId: PersonId): number {
    const removed = this.#db
      .delete(channelIdentities)
      .where(eq(channelIdentities.personId, personId))
      .returning({ id: channelIdentities.id })
      .all();
    return removed.length;
  }
}
