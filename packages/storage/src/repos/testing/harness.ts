/**
 * The fixture every repository contract test builds on.
 *
 * A **real migrated database** and a real `SqliteStore`, not a double. These tests exist to check
 * the conventions in `02` §3.7.1 against the thing that implements them, and the conventions are
 * mostly about what SQLite does: which unique index fires, whether a `RETURNING` clause yields a
 * row, whether a `CHECK` constraint refuses. A fake would answer those questions by restating this
 * code's assumptions — the failure mode `02` §3.12.1's `checksumOf` finding named, where a test
 * compared an implementation to itself.
 *
 * The harness deliberately builds its world **through the repositories**, not with raw `INSERT`s
 * like `seedGroup`. A fixture that writes rows directly can produce states the repositories cannot
 * — a member with no handle, a group whose epoch never moved — and then a test passes against data
 * the product could never reach.
 */
import {
  expectWritten,
  type Label,
  type NewGroup,
  type NewMember,
  type NewMemoryItem,
  type NewPerson,
} from '@comvivo/core';
import {
  type ChannelIdentityId,
  type ConversationId,
  type EntityId,
  type GroupId,
  type Logger,
  type MemberId,
  type MemoryId,
  type MessageId,
  type PersonId,
  SystemClock,
  TypeIdGenerator,
  UTC,
} from '@comvivo/shared';
import { sha256 } from '@comvivo/shared/crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import { Temporal } from 'temporal-polyfill';
import { type Db, makeDb } from '../../db/drizzle.js';
import { SqliteStore } from '../../db/tx.js';
import { withMigratedDb } from '../../schema/testing/migrated-db.js';
import { makeRepositories, type Repositories } from '../index.js';

/** A logger that records nothing: these tests assert on rows, not on lines. */
const silent = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  content: () => {},
  child: () => silent,
} as unknown as Logger;

/** A fixed instant, so a test that asserts on a timestamp has something to assert against. */
export const T0 = Temporal.Instant.from('2026-11-08T12:00:00Z');

export interface World {
  readonly db: Database.Database;
  readonly drizzle: Db;
  readonly store: SqliteStore;
  readonly repos: Repositories;
  /** A group, created through `GroupRepository.create`. */
  readonly groupId: GroupId;
  /** A second group, for every `I4` assertion. */
  readonly otherGroupId: GroupId;
}

/**
 * A migrated database with two groups in it.
 *
 * **Two** groups, always, because the convention that matters most here is `02` §3.7.1's "a read
 * that could cross a group is scoped on `groupId`". A single-group fixture lets a missing `WHERE
 * group_id = ?` pass every test in the file, which is how an `I4` hole survives a green suite.
 */
export function withRepos<T>(fn: (world: World) => T): T {
  return withMigratedDb((db) => {
    const drizzle = makeDb(db);
    const clock = new SystemClock();
    const ids = new TypeIdGenerator(clock);
    const store = new SqliteStore({ db, clock, logger: silent, ids });
    const repos = makeRepositories({ db: drizzle, connection: db, ids });
    const primary = groupId('rep1');
    const other = groupId('rep2');
    store.write((uow) => {
      expectWritten(repos.groups.create(uow, group(primary, 'Primary')), 'the primary group');
      expectWritten(repos.groups.create(uow, group(other, 'Other')), 'the other group');
    });
    return fn({ db, drizzle, store, repos, groupId: primary, otherGroupId: other });
  });
}

/** A `NewGroup` with the fields a test does not care about filled in. */
export function group(id: GroupId, name: string): NewGroup {
  return { id, name, archetype: 'family', timezone: UTC };
}

/** A `NewPerson`. `tag` makes the id readable in a failure message. */
export function person(tag: string, displayName = 'Ana'): NewPerson {
  return { id: personId(tag), displayName };
}

/** A `NewMember` for `groupId`, joined at `T0`. */
export function member(
  tag: string,
  groupId: GroupId,
  overrides: Partial<NewMember> = {},
): NewMember {
  return {
    id: memberId(tag),
    groupId,
    personId: personId(tag),
    role: 'member',
    status: 'active',
    joinedAt: T0,
    ...overrides,
  };
}

/**
 * A label readable by the whole group.
 *
 * The simplest label that is not degenerate: `kind: 'group'` means "everyone in the group", which
 * is what an ordinary message in a group chat carries.
 */
export function groupLabel(groupId: GroupId, overrides: Partial<Label> = {}): Label {
  return {
    groupId,
    readers: { kind: 'group', groupId },
    owner: 'group',
    coOwners: [],
    sensitivity: 'normal',
    influence: 'none',
    untrusted: false,
    ...overrides,
  };
}

/* --- Readable, valid ids. A TypeID suffix is 26 characters of Crockford base32. --------------- */

/**
 * A tag turned into a 26-character Crockford base32 suffix.
 *
 * **Right-padding with `'0'` collides** unless no tag ends in `'0'`, which is why that is checked
 * rather than assumed: `'g1'` and `'g10'` both pad to `01jg1000…`, so the perf test's hex counter
 * produced the same message id for index 1 and index 16 and failed with `duplicate` a sixteenth of
 * the way in. The rule is exact, not conservative — if neither tag ends in `'0'` and
 * `padded(a) === padded(b)`, then the shorter is a prefix of the longer and every character after
 * it is `'0'`, so the longer ends in `'0'`; contradiction. Hence the padding is injective.
 *
 * Crockford base32 also excludes `i`, `l`, `o` and `u`, and a tag containing one produces an id
 * that a *lookup* accepts (no validation on the way in) and a *write* rejects — so a fixture can
 * look fine until the test that matters.
 */
function suffix(tag: string): string {
  if (tag.length === 0 || tag.length > 23) {
    throw new Error(`fixture tag ${JSON.stringify(tag)} must be 1 to 23 characters`);
  }
  if (tag.endsWith('0')) {
    throw new Error(
      `fixture tag ${JSON.stringify(tag)} must not end in '0': right-padding with '0' would make ` +
        'it collide with the same tag plus zeros',
    );
  }
  if (/[ilou]/.test(tag)) {
    throw new Error(
      `fixture tag ${JSON.stringify(tag)} must not contain i, l, o or u — Crockford base32 ` +
        'excludes them, and the resulting id is accepted by a read and refused by a write',
    );
  }
  if (!/^[0-9a-z]+$/.test(tag)) {
    throw new Error(`fixture tag ${JSON.stringify(tag)} must be lowercase alphanumeric`);
  }
  return `01j${tag}`.padEnd(26, '0').slice(0, 26);
}

export function personId(tag: string): PersonId {
  return `prs_${suffix(tag)}` as PersonId;
}

export function memberId(tag: string): MemberId {
  return `mbr_${suffix(tag)}` as MemberId;
}

export function conversationId(tag: string): ConversationId {
  return `cnv_${suffix(tag)}` as ConversationId;
}

export function groupId(tag: string): GroupId {
  return `grp_${suffix(tag)}` as GroupId;
}

export function messageId(tag: string): MessageId {
  return `msg_${suffix(tag)}` as MessageId;
}

export function identityId(tag: string): ChannelIdentityId {
  return `chid_${suffix(tag)}` as ChannelIdentityId;
}

/**
 * A group id that no fixture creates.
 *
 * Built through `suffix` like every other id, which is the point: a hand-written literal was 24
 * characters rather than 26 and still made its test pass, because a *lookup* does not validate its
 * argument — so the test proved "a malformed id finds nothing" where it meant to prove "a valid id
 * for a group that does not exist finds nothing". Those are different claims and only one of them
 * is about the repository.
 */
export const ABSENT_GROUP = groupId('nxpe');

/* --- Memory fixtures (`M1-T18`) --------------------------------------------------------------- */

/**
 * A `NewMemoryItem` with every field the schema demands and nothing a test would have to repeat.
 *
 * `provenance` is a complete `MemoryProvenance`, not a partial one: the column is a
 * `jsonOf(MemoryProvenanceSchema)` and validates on the way in, so a fixture with a half-built
 * provenance fails at the write with a zod error rather than where the test is looking.
 */
export function memoryItem(
  tag: string,
  groupId: GroupId,
  overrides: Partial<NewMemoryItem> = {},
): NewMemoryItem {
  return {
    id: memoryId(tag),
    groupId,
    kind: 'fact',
    content: { kind: 'fact', attribute: 'school', value: `value-${tag}`, polarity: 'affirm' },
    statement: `a fact about ${tag}`,
    searchTerms: [tag],
    language: 'en',
    provenance: {
      source: 'extraction',
      sourceMessageIds: [],
      windowKey: null,
      extractor: null,
      assertion: 'explicit',
      assertedBy: 'system',
      rawConfidence: null,
      calibration: null,
      confirmedBy: [],
      derivedFrom: [],
      turnId: null,
    },
    confidence: 0.9,
    status: 'active',
    validFrom: T0,
    ...overrides,
  };
}

/**
 * A fingerprint for a fixture item.
 *
 * `04` §3.3.11 owns the real derivation; what matters to a test is that two items with different
 * tags get **different** fingerprints, or `insert` would report the second as a duplicate and the
 * test would fail for a reason that has nothing to do with what it is checking.
 */
export function fingerprintFor(tag: string): Uint8Array {
  return new Uint8Array(sha256(`fixture:${tag}`).subarray(0, 16));
}

export function memoryId(tag: string): MemoryId {
  return `mem_${suffix(tag)}` as MemoryId;
}

export function entityId(tag: string): EntityId {
  return `ent_${suffix(tag)}` as EntityId;
}
