/**
 * What an export contains, file by file (`02` §3.15).
 *
 * One entry per output file. Each names the table, how to order it, and the mapper that turns a row
 * into a **domain object** — because `02` §3.15 is explicit that records are domain objects
 * (camelCase, ISO-8601 instants, labels rendered) and not raw rows. An export that leaked column
 * names would make the schema an implementation detail that nobody can change.
 *
 * ## Why this reads tables rather than repositories
 *
 * `02` §3.15 says "every labeled table is read through the same `label_id IN eligible` predicate",
 * and that is the design rather than a shortcut. Fourteen repository methods would be fourteen
 * places the predicate could be forgotten, and `export.member-scope.property` would then be
 * proving the filter about whichever of them the test happened to exercise. One generic reader with
 * one predicate is a single thing to get right and a single thing to falsify — and the mappers in
 * `repos/rows.ts` are the same ones every repository uses, so the records are the same objects a
 * reader would get.
 *
 * ## The two scopes
 *
 * A **group** export runs with audience `{kind:'group'}`, so it holds only what every current
 * member may read — which is why an admin cannot use it to export someone's private data
 * (`01` §9). A **member** export runs with `{kind:'members', memberIds:[m]}` and adds the `me/`
 * section. Both compute their `EligibleLabelSet` through `core`'s `computeEligible`, so the export
 * and the context builder answer the same question with the same code.
 */
import type { EligibleLabelSet, Label } from '@comvivo/core';
import type { GroupId, LabelId, MemberId } from '@comvivo/shared';
import { and, asc, eq, getTableColumns, gt, inArray, ne, or, type SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Db } from '../db/drizzle.js';
import {
  toAuditEvent,
  toChannelIdentity,
  toConsentEvent,
  toConstitutionVersion,
  toConversation,
  toDecision,
  toEvent,
  toGroup,
  toList,
  toListItem,
  toMember,
  toMemoryItem,
  toMessage,
  toPerson,
  toPlan,
  toPlanStep,
  toPoll,
  toProposal,
  toReminder,
  toTask,
} from '../repos/rows.js';
import { decisions } from '../schema/decisions.js';
import {
  consentEvents,
  constitutionVersions,
  privateConstraintPolicies,
  proposals,
} from '../schema/governance.js';
import { conversations, groups, members } from '../schema/groups.js';
import { channelIdentities, persons } from '../schema/identity.js';
import { events, reminders } from '../schema/index.js';
import { listItems, lists } from '../schema/lists.js';
import { memoryItems } from '../schema/memory.js';
import { messages } from '../schema/messages.js';
import { planSteps, plans } from '../schema/plans.js';
import { polls } from '../schema/polls.js';
import { auditEvents } from '../schema/runtime.js';
import { tasks } from '../schema/tasks.js';

/** How many rows one read takes. `02` §3.15: "chunks of 1,000". */
export const EXPORT_CHUNK_ROWS = 1_000;

/** What a source needs to render one record. */
export interface ExportContext {
  readonly groupId: GroupId;
  /** Resolve a `label_id` to the label an export renders. */
  readonly labelOf: (id: LabelId) => Label | undefined;
}

export interface ExportSource {
  /** The file name inside the container, exactly as `02` §3.15 lists it. */
  readonly file: string;
  /** The record's `$type`. Stable, because `02` §3.15 designs the format for a later re-import. */
  readonly type: string;
  /** The drizzle table, so the read is typed and the column objects come from it. */
  readonly table: SQLiteTable;
  /**
   * Whether the table carries a `label_id` the eligibility filter applies to.
   *
   * `false` is **not** "exempt from filtering" — it means the table has no per-row audience, so its
   * own scoping is the group (or, for `me/`, the person). Every such source below says in a comment
   * why its rows are safe to export at that scope, because "it has no label" is a statement about
   * the schema and not an argument about privacy.
   */
  readonly labeled: boolean;
  /**
   * The ordering key. `rid` where there is one, so a chunked read is stable.
   *
   * `seq` is for the audit chain alone: within one group the chain key is constant (it *is* the
   * group id), so `seq` is dense and unique there — and it is the order the chain's hashes link
   * in. An audit log exported out of that order cannot be verified by the consumer.
   */
  readonly orderBy: 'rid' | 'id' | 'seq';
  /** Row → domain object. The same mappers every repository uses. */
  readonly map: (row: Record<string, unknown>) => unknown;
  /**
   * How a `me/` source is filtered: which column, and **which subject id it holds**.
   *
   * Two facts, not one. The first version of this was a single `scopeColumn` and the value was
   * inferred from its name — `'id'` meant the person, `'memberId'` the member, and anything else
   * fell through to the group id. `me/identities.jsonl` is scoped on `person_id`, which fell
   * through: the read compared a person column against a *group* id and exported nothing, with no
   * error, and `format.contract.int.test.ts` caught it on its first run. Saying both makes that
   * unrepresentable, which is the only reason this is a nested object rather than a string.
   */
  readonly subjectScope?:
    | {
        readonly column: 'personId' | 'memberId';
        readonly subject: 'person' | 'member';
      }
    | undefined;
  /**
   * One left join whose columns are merged into the row.
   *
   * Exactly one, and only for columns a record needs *rendered* rather than as an id — the
   * member's display name is the whole of it today (`02` §3.15's record list for `members.jsonl`
   * names `displayName`, which lives on `persons`). A record of opaque ids is a record a person
   * cannot read, and an export nobody can read is not an export.
   *
   * It is a left join because the membership is the row being exported: a person row that is
   * missing is a broken foreign key, and dropping the membership would hide it.
   */
  readonly join?:
    | {
        readonly table: SQLiteTable;
        readonly on: SQL;
        /** Extra keys merged into the selected row, by the name the mapper expects. */
        readonly columns: Readonly<Record<string, SQLiteColumn>>;
      }
    | undefined;
  /**
   * An extra predicate that applies **only to a member's own export**.
   *
   * For a table with no `label_id`, `labeled: false` says the rows have no per-row audience — and
   * for most of them that is the end of it, because the group is the audience (the membership
   * list, the constitution). For two it is not, and this is how they say so.
   *
   * It exists because of what the M1 exit gate's reviewer found: `conversations.jsonl` was
   * group-scoped in a *member* export, so a member running `export.self` received every other
   * member's DM row — its `kind`, its `member_id`, its platform and its platform chat id. The
   * comment above that source claimed "the member scope's filter below narrows" it; no such filter
   * existed. A claim in a comment that the code does not make is the shape this project keeps
   * finding, and the answer is a predicate rather than a better sentence.
   *
   * Called with the table's columns and the member being exported; return `undefined` for "no
   * extra restriction".
   */
  readonly memberOnly?:
    | ((
        columns: Readonly<Record<string, SQLiteColumn | undefined>>,
        scope: { readonly memberId: MemberId; readonly eligible: EligibleLabelSet },
      ) => SQL | undefined)
    | undefined;
}

/**
 * A cast, in one place, with the reason — and with the reason the *first* version gave, which was
 * wrong.
 *
 * It said: "the shapes are the same — the same columns from the same table". They are not. The
 * mappers in `repos/rows.ts` take **drizzle's inferred row**, which is camelCase and carries mapped
 * values (`Temporal.Instant`, not epoch milliseconds; `labelId`, not `label_id`). A raw
 * `SELECT *` returns snake_case keys and raw integers, so every mapped field came out `undefined`
 * and the export wrote records that were almost entirely empty — while a test asserting on ids and
 * labels **passed**, because ids happen to be snake-case-free.
 *
 * So the reads go through drizzle, which is also what keeps the generic predicate honest: one
 * query builder, one `inArray(labelId, …)`, and the column objects come from the table rather than
 * from a string. The cast that remains is only from drizzle's per-table inferred row to the
 * mapper's parameter, which really is the same shape — the table object is where both come from.
 */
function mapper<T>(fn: (row: never) => T): (row: Record<string, unknown>) => T {
  return (row) => fn(row as never);
}

/** The group-scoped files of `02` §3.15, in the order the manifest lists them. */
export const GROUP_SOURCES: readonly ExportSource[] = [
  {
    file: 'members.jsonl',
    type: 'member',
    table: members,
    // No label: a membership is who is in the group, and every member can see the roster. `02`
    // §3.15's own record list for this file is id, display name, role, status and dates — no
    // content, and nothing one member may know that another may not.
    labeled: false,
    orderBy: 'id',
    // `displayName` comes from `persons`, which is why this is the one source with a join, and the
    // record is `toMember`'s plus that one field. Without it `members.jsonl` is a list of `mbr_…`
    // ids, and every other file in the archive refers to members by exactly those ids — so this
    // field is what makes the whole export legible.
    join: {
      table: persons,
      on: eq(members.personId, persons.id),
      columns: { displayName: persons.displayName },
    },
    // No `??` fallback, deliberately. `members.person_id` has no `ON DELETE CASCADE` and
    // `02` §3.13.5's erasure clears a person's fields rather than deleting the row, so a missing
    // person is a broken foreign key and nothing else. If one ever occurs, the left join keeps the
    // membership and this field arrives as `null` — which `MemberRecordSchema` refuses, because
    // `02` §3.15 lists `displayName` in the record. A loud parse failure beats a quietly nameless
    // member, and smoothing it to `undefined` would have produced exactly that.
    map: (row) => ({ ...toMember(row as never), displayName: row['displayName'] }),
  },
  {
    file: 'conversations.jsonl',
    type: 'conversation',
    table: conversations,
    // No label on the row. A conversation is a channel binding — its *messages* carry labels, and
    // those are filtered. A group export lists them without their contents.
    labeled: false,
    // **And a member's own export lists only theirs.** `member_id` is non-null exactly when
    // `kind = 'dm'` (`02` §3.3.1), so this is "every shared conversation, plus my own DM" — the
    // filter the comment here used to claim without one existing.
    memberOnly: (columns, scope) => {
      const kind = columns['kind'];
      const member = columns['memberId'];
      if (kind === undefined || member === undefined) return undefined;
      return or(ne(kind, 'dm'), eq(member, scope.memberId));
    },
    orderBy: 'id',
    map: mapper(toConversation),
  },
  {
    file: 'messages.jsonl',
    type: 'message',
    table: messages,
    labeled: true,
    orderBy: 'rid',
    map: mapper(toMessage),
  },
  {
    file: 'memories.jsonl',
    type: 'memory',
    table: memoryItems,
    labeled: true,
    orderBy: 'rid',
    map: mapper(toMemoryItem),
  },
  {
    file: 'events.jsonl',
    type: 'event',
    table: events,
    labeled: true,
    orderBy: 'rid',
    map: mapper(toEvent),
  },
  {
    file: 'reminders.jsonl',
    type: 'reminder',
    table: reminders,
    labeled: true,
    orderBy: 'id',
    map: mapper(toReminder),
  },
  {
    file: 'tasks.jsonl',
    type: 'task',
    table: tasks,
    labeled: true,
    orderBy: 'rid',
    map: mapper(toTask),
  },
  {
    file: 'lists.jsonl',
    type: 'list',
    table: lists,
    labeled: true,
    orderBy: 'id',
    map: mapper(toList),
  },
  {
    file: 'list_items.jsonl',
    type: 'list_item',
    table: listItems,
    labeled: true,
    orderBy: 'id',
    map: mapper(toListItem),
  },
  {
    file: 'polls.jsonl',
    type: 'poll',
    table: polls,
    labeled: true,
    orderBy: 'id',
    map: mapper(toPoll),
  },
  {
    file: 'plans.jsonl',
    type: 'plan',
    table: plans,
    labeled: true,
    orderBy: 'id',
    map: mapper(toPlan),
  },
  {
    file: 'plan_steps.jsonl',
    type: 'plan_step',
    table: planSteps,
    // **No label of its own**, and the first version of this claimed one — which the reader of the
    // day answered with *no such column: label_id* on the first run, and which `readChunk`'s guard
    // now refuses by name. A step's audience is its plan's: `02` §3.3.5
    // nests steps under the plan, so a step a member cannot see is one whose *plan* they cannot
    // see. `plans.jsonl` above carries that filter.
    labeled: false,
    // **Closed at the M1 exit gate**, rather than left to `M7` as the comment here used to say.
    // "Exported with no plan to attach it to" undersold it: a step carries its own text, so a
    // member's export contained the steps of plans they cannot read. The step's audience is its
    // plan's, which is a subquery away — and a documented leak is still a leak.
    memberOnly: (columns, scope) => {
      const planId = columns['planId'];
      if (planId === undefined) return undefined;
      if (scope.eligible.ids.length === 0) return sql`1 = 0`;
      return sql`${planId} IN (SELECT id FROM ${plans} WHERE ${plans.labelId} IN ${scope.eligible.ids})`;
    },
    orderBy: 'id',
    map: mapper(toPlanStep),
  },
  {
    file: 'decisions.jsonl',
    type: 'decision',
    table: decisions,
    labeled: true,
    orderBy: 'id',
    map: mapper(toDecision),
  },
  {
    file: 'constitution_versions.jsonl',
    type: 'constitution_version',
    table: constitutionVersions,
    // No label: the constitution is the group's rules, published to every member by definition —
    // `03` §3.2 has the bot quote it on request.
    labeled: false,
    orderBy: 'id',
    map: mapper(toConstitutionVersion),
  },
  {
    file: 'proposals.jsonl',
    type: 'proposal',
    table: proposals,
    labeled: true,
    orderBy: 'id',
    map: mapper(toProposal),
  },
];

/**
 * The `me/` section of a member export (`02` §3.15).
 *
 * Filtered by **person** or **member**, not by label: these are the rows that are *about* the
 * requester, and the whole point of the section is that a member can get what the group export
 * cannot show them. A group export never includes it.
 */
export const ME_SOURCES: readonly ExportSource[] = [
  {
    file: 'me/identities.jsonl',
    type: 'channel_identity',
    table: channelIdentities,
    // No label: an identity is the person's own platform account. `02` §3.15 puts it in `me/`
    // precisely because it is theirs — a group export never contains it.
    labeled: false,
    orderBy: 'id',
    map: mapper(toChannelIdentity),
    subjectScope: { column: 'personId', subject: 'person' },
  },
  {
    file: 'me/consent_events.jsonl',
    type: 'consent_event',
    table: consentEvents,
    labeled: false,
    orderBy: 'id',
    map: mapper(toConsentEvent),
    subjectScope: { column: 'memberId', subject: 'member' },
  },
];

/**
 * `audit_events.jsonl` — group scope, and only when the caller says so (`02` §3.15).
 *
 * Separate from `GROUP_SOURCES` because it is the one file `02` §3.15 gates on a capability
 * (`audit.read`), and the capability system does not exist until `M5`. Rather than ship a check
 * that is not one, the decision is the caller's: `includeAudit` is explicit, defaults to `false`,
 * and the manifest records which way it went. `M9`'s CLI and dashboard are where the capability is
 * resolved, because that is where the requester is known.
 *
 * Unlabeled: an audit event is the instance's record of an action, not a datum with an audience.
 * That is also why it cannot be in the group export by default — "every current member may read
 * it" is not true of an admin's actions.
 */
export const AUDIT_SOURCE: ExportSource = {
  file: 'audit_events.jsonl',
  type: 'audit_event',
  table: auditEvents,
  labeled: false,
  orderBy: 'seq',
  map: mapper(toAuditEvent),
};

/** `group.json`, which is one object rather than a line-per-record file. */
export const GROUP_PROFILE_FILE = 'group.json';

/**
 * The group profile, with the constitution in force.
 *
 * `02` §3.15: "group profile + current constitution YAML/charter". Both, in one object, because
 * the constitution is the group's rules and a profile without them is a name and a timezone —
 * while `constitution_versions.jsonl` is the history, which answers a different question.
 *
 * **Through `groups.constitution_version_id`, not the highest version number.** The two can
 * differ, and `SqliteGovernanceRepository.currentConstitution` says why: the pointer is what `03`
 * evaluates against, so an interrupted adoption leaves a higher version the group has *not*
 * adopted. An export that published that version would be publishing rules nobody agreed to.
 *
 * A group with no constitution yet (every group before `M3` adopts one) gets no `constitution`
 * field at all rather than `null`, so the absence reads as an absence.
 */
export function readGroupProfile(db: Db, groupId: GroupId): unknown {
  const row = db.select().from(groups).where(eq(groups.id, groupId)).get();
  if (row === undefined) return undefined;
  const versionId = row.constitutionVersionId;
  const current =
    versionId === null
      ? undefined
      : db
          .select()
          .from(constitutionVersions)
          .where(
            and(eq(constitutionVersions.groupId, groupId), eq(constitutionVersions.id, versionId)),
          )
          .get();
  return {
    ...toGroup(row),
    ...(current === undefined ? {} : { constitution: toConstitutionVersion(current) }),
  };
}

/** `me/person.json` (`02` §3.15): the requester's own person record, as one object. */
export const ME_PERSON_FILE = 'me/person.json';

/**
 * The person a member export is for.
 *
 * One object rather than a one-line `.jsonl`, because `02` §3.15 names the file `person.json` and
 * because a person is exactly one row — the same reason `group.json` is not a source. The generic
 * reader would have worked, and the first version used it; the file name is the published contract
 * and two conventions for "one object" is one too many.
 */
export function readPerson(db: Db, personId: string): unknown {
  const row = db
    .select()
    .from(persons)
    .where(eq(persons.id, personId as never))
    .get();
  return row === undefined ? undefined : toPerson(row);
}

/** `me/private_constraint_policy.json` (`02` §3.15), which is one object or nothing at all. */
export const ME_POLICY_FILE = 'me/private_constraint_policy.json';

/**
 * What the member allows to be derived from their data (`03` §3.5.3).
 *
 * Read directly rather than through a source entry because it is one row keyed by the member and
 * one object in the archive, like `group.json`. The column is a validated
 * `PrivateConstraintPolicySchema`, so the value is the domain object already — there is no mapper
 * to go through and nothing to reshape.
 */
export function readPrivatePolicy(db: Db, memberId: MemberId): unknown {
  const row = db
    .select()
    .from(privateConstraintPolicies)
    .where(eq(privateConstraintPolicies.memberId, memberId))
    .get();
  if (row === undefined) return undefined;
  return {
    memberId: row.memberId,
    groupId: row.groupId,
    policy: row.policy,
    labelId: row.labelId,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

/**
 * One chunk of a source, filtered as its scope requires.
 *
 * The `labelId IN (…)` predicate is here and nowhere else, which is what makes
 * `export.member-scope.property` a statement about the export rather than about one table's
 * reader. An eligible set that is **empty** becomes a predicate that matches nothing, spelled
 * explicitly — because SQLite rejects an empty `IN ()` list and because a filter that silently
 * became "no filter" is the failure `M1-T21` found in three labeled reads.
 */
/**
 * What a chunk read is scoped to: the group, the requester's eligible labels, and the two subject
 * ids a `me/` source narrows by.
 *
 * Named rather than inline because three functions now take it.
 */
interface ChunkScope {
  readonly groupId: GroupId;
  readonly eligible: EligibleLabelSet;
  readonly personId?: string | undefined;
  readonly memberId?: MemberId | undefined;
}

/**
 * The columns `readChunk` needs by name, or a failure that names the source and the column.
 *
 * Split out of `readChunk` for its cognitive complexity: four decisions in one function, each
 * about a different thing (does the source resolve, what is the subject, what filters the rows,
 * how is the row shaped), is exactly the shape the `noExcessiveCognitiveComplexity` budget is
 * there to break up.
 */
function chunkColumns(
  source: ExportSource,
  columns: Record<string, SQLiteColumn | undefined>,
): { readonly scoped: SQLiteColumn; readonly order: SQLiteColumn } {
  const scoped = columns[source.subjectScope?.column ?? 'groupId'];
  const order = columns[source.orderBy];
  if (scoped === undefined || order === undefined) {
    // Unreachable for every source above, and asserted because of what the alternative says.
    // Measured with this guard disabled (`sources.int.test.ts`): the `undefined` column reaches
    // drizzle, which emits `WHERE = ?`, and SQLite answers `near "=": syntax error` from inside
    // the query builder — naming neither the file being exported nor the column that is missing.
    throw new Error(
      `export source ${source.type} names a column its table does not have ` +
        `(${source.subjectScope?.column ?? 'groupId'}, ${source.orderBy})`,
    );
  }
  return { scoped, order };
}

/**
 * The value the scoping column must equal.
 *
 * An absent subject becomes an id no row can carry, rather than no predicate: a `me/` source read
 * without a subject must match **nothing**. `sources.int.test.ts` holds both halves.
 */
function subjectValue(source: ExportSource, scope: ChunkScope): string {
  if (source.subjectScope === undefined) return scope.groupId;
  return source.subjectScope.subject === 'person' ? (scope.personId ?? '') : (scope.memberId ?? '');
}

/** Every predicate a chunk read applies: the subject, the member filter, the labels, the cursor. */
function chunkWhere(
  source: ExportSource,
  columns: Record<string, SQLiteColumn | undefined>,
  scope: ChunkScope,
  resolved: { readonly scoped: SQLiteColumn; readonly order: SQLiteColumn },
  after: string | number | undefined,
): readonly SQL[] {
  const where: SQL[] = [eq(resolved.scoped, subjectValue(source, scope))];

  // A member's own export, where a table with no label may still hold other members' rows.
  if (source.memberOnly !== undefined && scope.memberId !== undefined) {
    const extra = source.memberOnly(columns, {
      memberId: scope.memberId,
      eligible: scope.eligible,
    });
    if (extra !== undefined) where.push(extra);
  }

  if (source.labeled) {
    const label = columns['labelId'];
    if (label === undefined) {
      // Before the empty-set branch below, deliberately: without this the failure depends on the
      // data — an empty eligible set takes `1 = 0` and writes an empty file with no error at all,
      // and only a non-empty one reaches `inArray` and fails. Both measured in
      // `sources.int.test.ts`.
      throw new Error(`export source ${source.type} is marked labeled and has no labelId column`);
    }
    where.push(
      scope.eligible.ids.length === 0 ? sql`1 = 0` : inArray(label, [...scope.eligible.ids]),
    );
  }
  if (after !== undefined) where.push(gt(resolved.order, after));
  return where;
}

export function readChunk(
  db: Db,
  source: ExportSource,
  scope: ChunkScope,
  after: string | number | undefined,
  limit: number,
): readonly Record<string, unknown>[] {
  const columns = getTableColumns(source.table) as Record<string, SQLiteColumn | undefined>;
  const resolved = chunkColumns(source, columns);

  // `$dynamic()` so the optional join is one expression rather than two query builders. The
  // selection is explicit because a join without one returns `{members: {...}, persons: {...}}`,
  // and the mappers take a flat row.
  const selected = { ...columns, ...(source.join?.columns ?? {}) } as Record<string, SQLiteColumn>;
  const base = db.select(selected).from(source.table).$dynamic();
  const joined =
    source.join === undefined ? base : base.leftJoin(source.join.table, source.join.on);
  return joined
    .where(and(...chunkWhere(source, columns, scope, resolved, after)))
    .orderBy(asc(resolved.order))
    .limit(limit)
    .all();
}
