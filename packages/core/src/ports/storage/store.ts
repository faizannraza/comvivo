/**
 * The `Store` port: the only way into a transaction (`02` §3.7.1, D10; `01` §1).
 *
 * ## Why transactions are synchronous
 *
 * better-sqlite3 is a **synchronous** driver. Its `db.transaction(fn)` wraps `fn` in
 * `BEGIN`/`COMMIT` and commits the moment `fn` returns — so an `async fn` returns a *promise*
 * immediately, the transaction commits around nothing, and the actual work then runs outside it
 * with no isolation and no rollback. Nothing throws. The data is simply wrong, intermittently,
 * under concurrency.
 *
 * That is why `01` §1 makes it a spine rule and `CLAUDE.md` §2 repeats it: **transactions never
 * span an `await`.** This file is where the rule becomes a type error rather than a convention.
 *
 * ## Four guards, because one is not enough
 *
 * `02` §3.7.2 lists them, and they fail in different directions:
 *
 *  1. **`NotPromise<T>`** turns an `async` callback into a compile error. Static, free, and the
 *     one that catches the mistake while it is being written.
 *  2. **A lint rule** (`eslint.config.ts`) rejects `async` callbacks to `write`/`read`/
 *     `transaction` syntactically — it catches the case where the return type is widened or the
 *     callback is written somewhere the type cannot reach it.
 *  3. **`no-floating-promises`** catches a promise *created* inside a callback and not awaited,
 *     which `NotPromise` cannot see because the callback still returns something synchronous.
 *  4. **A runtime check** in `SqliteStore` throws `STORAGE_TX_ASYNC_CALLBACK`. Defence in depth,
 *     for the untyped caller — a plugin, a REPL, a `JSON`-driven path.
 *
 * Any one of them can be defeated. A promise that reaches SQLite cannot be.
 *
 * ## `TxToken`
 *
 * Repository methods take the `UnitOfWork` as their first argument, so "this call needs a
 * transaction" is visible in the signature rather than being an unwritten rule about call order.
 * The alternative — repositories holding a connection and starting their own transactions — is how
 * a single logical change ends up as four commits, three of which can be interrupted.
 */
import type { GroupId, LabelId } from '@comvivo/shared';
import type { Label } from '../../ifc/eligible.js';
import type { JobQueueTx } from './jobs.js';
import type { AuditLog, AuditReader } from './repos/audit.js';
import type { DeletionPrimitives } from './repos/deletions.js';
import type {
  CalendarReader,
  CalendarRepository,
  DecisionReader,
  DecisionRepository,
  ListReader,
  ListRepository,
  PlanReader,
  PlanRepository,
  PollReader,
  PollRepository,
  ReminderReader,
  ReminderRepository,
  TaskReader,
  TaskRepository,
} from './repos/coordination.js';
import type { GovernanceReader, GovernanceRepository } from './repos/governance.js';
import type {
  ChannelIdentityReader,
  ChannelIdentityRepository,
  ConversationReader,
  ConversationRepository,
  GroupReader,
  GroupRepository,
  MemberReader,
  MemberRepository,
  PersonReader,
  PersonRepository,
} from './repos/membership.js';
import type { MemoryReader, MemoryRepository } from './repos/memory.js';
import type { MessageReader, MessageRepository } from './repos/messages.js';
import type { OutboxRepository } from './repos/outbox.js';
import type { SettingsReader, SettingsRepository } from './repos/settings.js';
import type {
  TraceReader,
  TraceRepository,
  TurnJournal,
  TurnJournalReader,
} from './repos/turns.js';
import type { UsageReader, UsageRepository } from './repos/usage.js';
import type { NotPromise, TxClock, TxMeta, TxToken } from './uow.js';

/**
 * A consistent read scope: `BEGIN DEFERRED` … `COMMIT`.
 *
 * Readers are added by the milestone that creates each aggregate (`M1-T12` onward), so the only
 * member today is the clock.
 *
 * **`now` is here rather than only on `UnitOfWork`**, which is a small refinement of `02` §3.7.1's
 * shape and is logged as one. A read transaction needs a transaction-stable clock reading for
 * exactly the reason a write does: a context build reads a dozen tables, and if it asks what time
 * it is twice it must get the same answer, or an "upcoming event" can be inside the window for one
 * query and outside it for the next. `UnitOfWork extends ReadScope`, so nothing is lost.
 *
 * It also removes an empty object type, which is worth stating because both linters refused every
 * spelling of one — an empty interface, `{}`, and `Readonly<Record<never, never>>` all resolve to
 * `{}` and accept **any** non-nullish value, `0` and `''` included. They were right: a `ReadScope`
 * parameter that accepts a number is not a type. Giving the interface the member it should have had
 * was the fix; suppressing the rule would have kept the hole.
 */
export interface ReadScope extends TxClock {
  /* --- Readers, added by the milestone that creates each aggregate (`M1-T17` onward) --------- */

  readonly groups: GroupReader;
  readonly persons: PersonReader;
  readonly identities: ChannelIdentityReader;
  readonly members: MemberReader;
  readonly conversations: ConversationReader;
  readonly messages: MessageReader;
  readonly settings: SettingsReader;
  readonly memories: MemoryReader;
  readonly calendar: CalendarReader;
  readonly reminders: ReminderReader;
  readonly tasks: TaskReader;
  readonly lists: ListReader;
  readonly polls: PollReader;
  readonly plans: PlanReader;
  readonly decisions: DecisionReader;
  /**
   * `02` §3.7.1 lists `constitution` and `proposals` separately; this is both.
   *
   * One reader, because the two share `constraint_records` and `confirmation_requests` and `03`
   * reads them together — a proposal to amend the constitution is evaluated under the constitution
   * in force. Splitting the type would not split the queries, and `M1-T20` built one repository.
   */
  readonly governance: GovernanceReader;
  readonly turns: TurnJournalReader;
  readonly traces: TraceReader;
  readonly audit: AuditReader;
  readonly usage: UsageReader;
  /**
   * `02` §3.7.1's `labels`. Reading labels back is Q-IFC-2, which `computeEligible` needs.
   *
   * There is deliberately **no `outbox` reader here**, and `02` §3.7.1's list does not have one:
   * the queue is the dispatcher's, not a reader every holder of a read transaction should have, and
   * `OutboxRepository` already carries the reads its own state machine needs. Adding one would also
   * collide with the writer's name on `UnitOfWork` — the same clash `UsageReader.byId` resolved.
   */
  readonly labels: LabelLookup;
}

/**
 * A unit of work: `BEGIN IMMEDIATE` … `COMMIT`, plus the writes.
 *
 * `IMMEDIATE` rather than `DEFERRED` for writes, per `02` D10. A deferred transaction takes its
 * write lock on the first write, which means a transaction that reads and then writes can fail to
 * *upgrade* its lock and get `SQLITE_BUSY` — against a CLI command or a backup holding a read.
 * Taking the write lock up front turns that into waiting instead of failing.
 */
export interface UnitOfWork extends ReadScope, TxToken {
  /* --- Writers. `02` §3.7.1 suffixes them `W` where a reader has the same name ---------------- */

  readonly groupsW: GroupRepository;
  readonly personsW: PersonRepository;
  readonly identitiesW: ChannelIdentityRepository;
  readonly membersW: MemberRepository;
  readonly conversationsW: ConversationRepository;
  readonly messagesW: MessageRepository;
  readonly settingsW: SettingsRepository;
  readonly memoriesW: MemoryRepository;
  readonly calendarW: CalendarRepository;
  readonly remindersW: ReminderRepository;
  readonly tasksW: TaskRepository;
  readonly listsW: ListRepository;
  readonly pollsW: PollRepository;
  readonly plansW: PlanRepository;
  readonly decisionsW: DecisionRepository;
  readonly governanceW: GovernanceRepository;
  /** `02` §3.7.1's `journal`: the turn journal's writes (§3.8). */
  readonly journal: TurnJournal;
  readonly tracesW: TraceRepository;
  /** `02` §3.7.1's `auditW`. In the transaction, so a rolled-back effect takes its audit row. */
  readonly auditW: AuditLog;
  readonly usageW: UsageRepository;
  /** `02` §3.7.1's `outbox`: enqueued in the transaction that decided to send (§3.9). */
  readonly outbox: OutboxRepository;
  /**
   * `02` §3.7.1's `jobs`: the in-transaction half of the queue (§3.10.2).
   *
   * Here and not on the worker loop's `JobQueue`, because enqueuing belongs to the transaction
   * that decided to enqueue — a job scheduled by work that then rolled back must not exist — and
   * `completeIn` is how a handler's final write and its own completion commit together.
   */
  readonly jobs: JobQueueTx;
  /**
   * The label store (`02` §3.2, §3.7.1's `labelsW`).
   *
   * Not a repository in the `WriteResult` sense: interning cannot conflict, cannot be a duplicate
   * (that *is* its job) and cannot be not-found, so it returns an id directly. `02` §3.7.1 lists it
   * on the unit of work beside the repositories, and the type is structural so `core` does not
   * depend on the storage implementation — it names only what it calls.
   */
  readonly labelsW: LabelInterner;
  /**
   * `02` §3.7.1's `deletions: DeletionPrimitives`.
   *
   * On the unit of work beside the repositories rather than among them, because every method spans
   * aggregates: deleting a memory touches its subjects, sources, FTS rows and a decision's
   * back-reference. A repository that owns one aggregate cannot hold that without reaching into
   * another's tables.
   */
  readonly deletions: DeletionPrimitives;
}

/**
 * What `UnitOfWork.labelsW` must provide (`02` §3.2).
 *
 * A one-method interface rather than a dependency on `@comvivo/storage`'s `LabelStore`, for the
 * same reason `computeEligible` takes a `ReadEligibility` rather than the whole `InformationFlow`:
 * `core` is the inner layer and must name what it needs, not import what provides it.
 */
export interface LabelInterner {
  intern(uow: TxToken, label: Label): LabelId;
}

/**
 * What `ReadScope.labels` must provide (`02` §3.3.10 Q-IFC-2).
 *
 * One method, for the same reason as `LabelInterner`: `core` names what it calls. `computeEligible`
 * takes a `ReadonlyMap<LabelId, Label>` and this is where that map comes from — `M1-T19` found
 * that the function had no input producer at all until `LabelStore.groupLabels` was added.
 */
export interface LabelLookup {
  groupLabels(groupId: GroupId): ReadonlyMap<LabelId, Label>;
}

/**
 * The only way into a transaction (`02` §3.7.1).
 *
 * `01` §1 and `CLAUDE.md` §2: nothing outside the one implementing module may call the driver's
 * own `transaction()`. That is enforced by a lint rule rather than left to review, because the
 * failure is silent — a raw `db.transaction()` with an `async` callback commits around nothing.
 */
export interface Store {
  /**
   * `BEGIN IMMEDIATE` … `COMMIT`. `fn` **must** be synchronous.
   *
   * Nested calls become savepoints, so a helper that opens a transaction composes inside a larger
   * one instead of either failing or silently committing early.
   */
  write<T>(fn: (uow: UnitOfWork) => NotPromise<T>, meta?: TxMeta): T;

  /**
   * `BEGIN DEFERRED` … `COMMIT`, for multi-statement reads that must agree with each other.
   *
   * Needed because a context build reads a dozen tables, and without a snapshot a message could
   * appear in one query and not the next — producing a reply that cites something it then claims
   * does not exist.
   */
  read<T>(fn: (scope: ReadScope) => NotPromise<T>, meta?: TxMeta): T;
}
