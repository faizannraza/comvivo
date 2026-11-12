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
  computeEligible,
  type EligibleLabelSet,
  expectWritten,
  type Label,
  type NewGroup,
  type NewMember,
  type NewMemoryItem,
  type NewPerson,
  type NotPromise,
} from '@comvivo/core';
import {
  type AuditId,
  type CalendarSubscriptionId,
  type ChannelIdentityId,
  type ConfirmationId,
  type ConsentEventId,
  type ConstitutionVersionId,
  type ConstraintId,
  type ConversationId,
  type DecisionId,
  type DeletionId,
  type EntityId,
  type EventId,
  type GroupId,
  type JobId,
  type JobScheduleId,
  type LabelId,
  type LedgerEntryId,
  type ListId,
  type ListItemId,
  type Logger,
  type MemberId,
  type MemoryId,
  type MessageId,
  type OutboxId,
  type PersonId,
  type PlanId,
  type PlanStepId,
  type PollId,
  type ProposalId,
  type ReminderFiringId,
  type ReminderId,
  type StandingApprovalId,
  SystemClock,
  type TaskId,
  type TurnEffectId,
  type TurnId,
  type TurnTraceId,
  TypeIdGenerator,
  type UsageId,
  UTC,
} from '@comvivo/shared';
import { sha256 } from '@comvivo/shared/crypto';
import { SeededRng } from '@comvivo/shared/testing';
import type Database from 'better-sqlite3-multiple-ciphers';
import { Temporal } from 'temporal-polyfill';
import { type Db, makeDb } from '../../db/drizzle.js';
import { SqliteStore } from '../../db/tx.js';
import { withMigratedDb, withMigratedDbAsync } from '../../schema/testing/migrated-db.js';
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

/**
 * The same silent logger, for a test that constructs something needing one.
 *
 * Exported as an alias rather than renamed, so the `withRepos` body below reads the way it did.
 */
export const silentLogger: Logger = silent;

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
export function withRepos<T>(fn: (world: World) => NotPromise<T>): T {
  return withMigratedDb((db) => {
    const drizzle = makeDb(db);
    const clock = new SystemClock();
    const ids = new TypeIdGenerator(clock);
    // A **seeded** rng, so the outbox's equal-jitter backoff is a number a test can assert.
    const rng = new SeededRng(7);
    const store = new SqliteStore({ db, clock, logger: silent, ids, rng });
    const repos = makeRepositories({ db: drizzle, connection: db, ids, rng, clock });
    const primary = groupId('rep1');
    const other = groupId('rep2');
    store.write((uow) => {
      expectWritten(repos.groups.create(uow, group(primary, 'Primary')), 'the primary group');
      expectWritten(repos.groups.create(uow, group(other, 'Other')), 'the other group');
    });
    return fn({ db, drizzle, store, repos, groupId: primary, otherGroupId: other });
  });
}

/**
 * An eligible set over the labels this world has interned, built by the real `computeEligible`.
 *
 * **Nine test files had their own copy of this**, each returning
 * `{ groupId, ids, audienceKey: 'g|s:', epoch: '0:0' } as unknown as never` — a hand-forged shape
 * with the brand cast off, in four different signatures. Two things are wrong with that, and the
 * second is the one that matters: a forged set cannot disagree with the real one, so every "the
 * read applies the eligible set" assertion in those files was checked against a value the product
 * never produces, and a change to `computeEligible`'s output would leave all nine compiling and
 * green. Found by the M1 exit gate's reviewer. `repos/messages.contract.test.ts` already did it
 * this way; this is that helper, moved to where the others can use it.
 *
 * `group` defaults to the primary one and is a parameter because an `I4` test needs a *real* set
 * for the other group: a set for group A can only hold A's labels (`computeEligible` throws
 * otherwise), which is the containment the forged helpers silently sidestepped.
 *
 * `canRead: () => true` stands in for `StubInformationFlow`'s answer about a group-readable label
 * (`M1-T16`), which is what every one of those fixtures interns. The **real** flow checks live in
 * `eligibility-equivalence.prop.int.test.ts`, which compares `computeEligible` against the SQL
 * filter over generated label sets — a property, not a fixture, which is the right shape for that
 * question.
 */
export function eligibleAll(world: World, group: GroupId = world.groupId): EligibleLabelSet {
  const snapshot = world.repos.groups.snapshot(group);
  if (snapshot === undefined) throw new Error(`fixture: no group ${group}`);
  const labels = world.repos.labels.groupLabels(group);
  // **"All of nothing" is refused.** `02` §3.7.1's labeled reads return early for an empty set, so
  // an accidentally empty "everything" set makes every negative assertion pass without the
  // predicate under test ever running. That is not hypothetical: it happened in
  // `tasks.contract.test.ts`, where the cross-group test interned a label in the *other* group
  // only, and the M1 exit gate's reviewer proved the read was answering `1 = 0` rather than
  // `group_id = ?`. `eligibleNone` is how a test asks for an empty set on purpose.
  if (labels.size === 0) {
    throw new Error(
      `fixture: group ${group} has no interned labels, so "every label" is the empty set — ` +
        'intern one, or use `eligibleNone` if that is what the test means',
    );
  }
  return computeEligible(labels, { kind: 'group', groupId: group }, snapshot, {
    canRead: () => true,
  });
}

/**
 * An eligible set admitting exactly `ids`, and nothing else this group has.
 *
 * The whole label map goes in, with a `canRead` that admits the chosen rows: `computeEligible`
 * derives its `epoch` from the **maximum candidate** id rather than the eligible ones, so filtering
 * the map first would produce a set with a real brand and an epoch no real caller could get.
 * Identity comparison on the `Label` values is sound because they come from the same map.
 */
export function eligibleOnly(
  world: World,
  ids: readonly LabelId[],
  group: GroupId = world.groupId,
): EligibleLabelSet {
  const snapshot = world.repos.groups.snapshot(group);
  if (snapshot === undefined) throw new Error(`fixture: no group ${group}`);
  const labels = world.repos.labels.groupLabels(group);
  const keep = new Set(ids);
  // Every id must belong to this group, for the reason `eligibleAll` refuses an empty set: an id
  // from another group — or a typo — silently drops out, the set collapses, and the read returns
  // nothing for a reason that has nothing to do with what is being tested.
  const unknown = [...keep].filter((id) => !labels.has(id));
  if (keep.size === 0 || unknown.length > 0) {
    throw new Error(
      keep.size === 0
        ? 'fixture: `eligibleOnly` with no ids is `eligibleNone` — say so'
        : `fixture: label id(s) ${unknown.join(', ')} are not interned in group ${group}`,
    );
  }
  const idByLabel = new Map<Label, LabelId>();
  for (const [id, label] of labels) idByLabel.set(label, id);
  return computeEligible(labels, { kind: 'group', groupId: group }, snapshot, {
    canRead: (label) => {
      const id = idByLabel.get(label);
      return id !== undefined && keep.has(id);
    },
  });
}

/**
 * A **non-empty** eligible set that does not admit `labelId`.
 *
 * `02` §3.7.1's labeled reads return early for an empty set, so a test that only passes
 * `eligibleNone` never reaches the `label_id IN (…)` predicate at all — the filter could be missing
 * entirely and the test would still pass. Found in `traces.contract.test.ts` by deleting the filter
 * and watching the suite stay green.
 *
 * It **throws** rather than inventing a non-existent id when the group has nothing else to be
 * eligible for. The forged version it replaces fell back to `[999_999]`, which is a set no
 * `computeEligible` can return; a fixture with one label is a fixture that cannot express this
 * question, and saying so is more useful than a set that only looks like one.
 */
export function eligibleExcluding(world: World, labelId: LabelId): EligibleLabelSet {
  const keep = [...world.repos.labels.groupLabels(world.groupId).keys()].filter(
    (id) => id !== labelId,
  );
  if (keep.length === 0) {
    throw new Error(
      'fixture: this group has only the excluded label, so a non-empty excluding set does not ' +
        'exist — intern a second label first',
    );
  }
  return eligibleOnly(world, keep);
}

/** An eligible set that admits nothing — the case a wrong `IN ()` turns into "everything". */
export function eligibleNone(world: World, group: GroupId = world.groupId): EligibleLabelSet {
  const snapshot = world.repos.groups.snapshot(group);
  if (snapshot === undefined) throw new Error(`fixture: no group ${group}`);
  return computeEligible(
    world.repos.labels.groupLabels(group),
    { kind: 'group', groupId: group },
    snapshot,
    { canRead: () => false },
  );
}

/**
 * The same world, for a test that must `await`.
 *
 * **Not a widened `withRepos`.** `withRepos` closes the database when its callback returns, so an
 * `async` callback leaves the body running against a closed connection — `TypeError: The database
 * connection is not open`, from three frames inside drizzle. That is the same trap `02` §3.7.2
 * guards `store.write` against, and the guard is a type error for the same reason: one function
 * accepting either shape would accept the mistake it exists to prevent. Found by the worker-loop
 * tests, which cannot be synchronous.
 */
export async function withReposAsync<T>(fn: (world: World) => Promise<T>): Promise<T> {
  return withMigratedDbAsync(async (db) => {
    const drizzle = makeDb(db);
    const clock = new SystemClock();
    const ids = new TypeIdGenerator(clock);
    const rng = new SeededRng(7);
    const store = new SqliteStore({ db, clock, logger: silent, ids, rng });
    const repos = makeRepositories({ db: drizzle, connection: db, ids, rng, clock });
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

export function eventId(tag: string): EventId {
  return `evt_${suffix(tag)}` as EventId;
}

export function subscriptionId(tag: string): CalendarSubscriptionId {
  return `csub_${suffix(tag)}` as CalendarSubscriptionId;
}

export function listId(tag: string): ListId {
  return `lst_${suffix(tag)}` as ListId;
}

export function listItemId(tag: string): ListItemId {
  return `lsti_${suffix(tag)}` as ListItemId;
}

export function constitutionId(tag: string): ConstitutionVersionId {
  return `cnst_${suffix(tag)}` as ConstitutionVersionId;
}

export function proposalId(tag: string): ProposalId {
  return `prp_${suffix(tag)}` as ProposalId;
}

export function constraintId(tag: string): ConstraintId {
  return `cst_${suffix(tag)}` as ConstraintId;
}

export function confirmationId(tag: string): ConfirmationId {
  return `cnf_${suffix(tag)}` as ConfirmationId;
}

export function standingApprovalId(tag: string): StandingApprovalId {
  return `sap_${suffix(tag)}` as StandingApprovalId;
}

export function consentEventId(tag: string): ConsentEventId {
  return `cev_${suffix(tag)}` as ConsentEventId;
}

export function pollId(tag: string): PollId {
  return `pol_${suffix(tag)}` as PollId;
}

export function planId(tag: string): PlanId {
  return `pln_${suffix(tag)}` as PlanId;
}

export function planStepId(tag: string): PlanStepId {
  return `plns_${suffix(tag)}` as PlanStepId;
}

export function decisionId(tag: string): DecisionId {
  return `dec_${suffix(tag)}` as DecisionId;
}

export function reminderId(tag: string): ReminderId {
  return `rem_${suffix(tag)}` as ReminderId;
}

export function firingId(tag: string): ReminderFiringId {
  return `rfr_${suffix(tag)}` as ReminderFiringId;
}

export function taskId(tag: string): TaskId {
  return `tsk_${suffix(tag)}` as TaskId;
}

export function ledgerEntryId(tag: string): LedgerEntryId {
  return `lde_${suffix(tag)}` as LedgerEntryId;
}

export function turnId(tag: string): TurnId {
  return `trn_${suffix(tag)}` as TurnId;
}

export function effectId(tag: string): TurnEffectId {
  return `tfx_${suffix(tag)}` as TurnEffectId;
}

export function traceId(tag: string): TurnTraceId {
  return `trc_${suffix(tag)}` as TurnTraceId;
}

export function auditId(tag: string): AuditId {
  return `aud_${suffix(tag)}` as AuditId;
}

export function usageId(tag: string): UsageId {
  return `use_${suffix(tag)}` as UsageId;
}

export function jobId(tag: string): JobId {
  return `job_${suffix(tag)}` as JobId;
}

export function scheduleId(tag: string): JobScheduleId {
  return `jsch_${suffix(tag)}` as JobScheduleId;
}

export function deletionId(tag: string): DeletionId {
  return `del_${suffix(tag)}` as DeletionId;
}

export function outboxId(tag: string): OutboxId {
  return `obx_${suffix(tag)}` as OutboxId;
}
