/**
 * The repository set, and where it is built (`02` §3.7.1).
 *
 * `ReadScope` and `UnitOfWork` carry every reader and writer, so `SqliteStore` has to hold them —
 * but `db/tx.ts` is the transaction primitive, and a primitive that imports every repository would
 * be the composition root as well. So this module owns construction and `tx.ts` imports only the
 * `Repositories` **type**: one direction of dependency, and the wiring is a function a test can
 * call with a bare database.
 *
 * Each class implements both halves of its aggregate — `SqliteGroupRepository` is the `GroupReader`
 * and the `GroupRepository` — because the two share prepared statements and a reader that could not
 * see a write made earlier in the same transaction would be a different kind of bug. The *types*
 * stay split, so a read transaction still cannot reach a writer.
 */
import type { IdGenerator } from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { Db } from '../db/drizzle.js';
import { LabelStore } from '../ifc/label-store.js';
import { SqliteContextReadModel } from '../readmodels/context.js';
import { EmbeddingSpaceManager } from '../search/embedding-spaces.js';
import { SqliteMemorySearch } from '../search/memory-search.js';
import { SqliteCalendarRepository } from './calendar.js';
import { SqliteConversationRepository } from './conversations.js';
import {
  SqliteDecisionRepository,
  SqlitePlanRepository,
  SqlitePollRepository,
  SqliteReminderRepository,
} from './coordination.js';
import { SqliteGroupRepository } from './groups.js';
import { SqliteListRepository } from './lists.js';
import { SqliteMemberRepository } from './members.js';
import { SqliteMemoryRepository } from './memory.js';
import { SqliteMessageRepository } from './messages.js';
import { SqliteChannelIdentityRepository, SqlitePersonRepository } from './persons.js';
import { SqliteSettingsRepository } from './settings.js';
import { SqliteTaskRepository } from './tasks.js';
import { SqliteMessageReaderUnfiltered } from './unfiltered/messages.js';

/**
 * Every repository, built once per connection.
 *
 * Once per **connection** rather than per transaction, because `02` §3.7.2 prepares statements per
 * repository instance and a per-transaction instance would re-prepare each one on every message.
 * The instances hold no transaction state — the `TxToken` parameter is what ties a call to a
 * transaction — so sharing them across transactions is safe by construction.
 */
export interface Repositories {
  readonly groups: SqliteGroupRepository;
  readonly persons: SqlitePersonRepository;
  readonly identities: SqliteChannelIdentityRepository;
  readonly members: SqliteMemberRepository;
  readonly conversations: SqliteConversationRepository;
  readonly messages: SqliteMessageRepository;
  readonly settings: SqliteSettingsRepository;
  /**
   * The label store, which is not a repository in `02` §3.7.1's sense.
   *
   * `UnitOfWork` names it `labelsW`, and it is here because the message repository interns through
   * it: `02` §3.2 makes it the only way a `label_id` comes into being, so it has to be the same
   * instance the rest of the system uses — its caches are per-instance, and a second one would
   * miss every entry the first filled.
   */
  readonly labels: LabelStore;
  /**
   * The unfiltered message reads (`02` §3.7.1, `01` §14 A11).
   *
   * Here and **not** on `ReadScope`: putting it there would hand an unfiltered reader to every
   * holder of a read transaction, which is the opposite of restricting it. `02` §3.7.1's
   * `ReadScope` list does not include one. The restricted callers — the tool executor, which has
   * already applied the requester's authority, and the retention sweep — receive this instance
   * directly at the composition root, so the dependency-cruiser rule still sees their import.
   */
  readonly messagesUnfiltered: SqliteMessageReaderUnfiltered;
  readonly memories: SqliteMemoryRepository;
  /**
   * Memory **search** (`02` §3.7.1's `MemorySearchPort`).
   *
   * Here and not on `ReadScope`, for the same reason as `messagesUnfiltered`: putting it there
   * would hand a memory search to every holder of a read transaction, and
   * `memory-search-restricted-callers` exists to stop exactly that. `02` §3.7.1's `ReadScope` lists
   * a `memories` *reader*, which is the repository above; `engine/context` and
   * `engine/readmodels` receive this instance directly at the composition root.
   */
  readonly memorySearch: SqliteMemorySearch;
  readonly calendar: SqliteCalendarRepository;
  readonly tasks: SqliteTaskRepository;
  readonly lists: SqliteListRepository;
  readonly polls: SqlitePollRepository;
  readonly plans: SqlitePlanRepository;
  readonly decisions: SqliteDecisionRepository;
  readonly reminders: SqliteReminderRepository;
  readonly embeddingSpaces: EmbeddingSpaceManager;
  /**
   * `02` §3.7.3's context read model.
   *
   * Built last and given the whole set, because it is a **façade**: every method delegates to the
   * repository that owns the aggregate. A read model with its own SQL would be a second place an
   * eligibility filter could be forgotten, and `labels.eligibility-equivalence.property` would
   * then be proving it about the wrong code.
   */
  readonly context: SqliteContextReadModel;
}

export interface RepositoriesOptions {
  readonly db: Db;
  /** Needed by `EmbeddingSpaceManager`, which mints an `emb_` id per space. */
  readonly ids: IdGenerator;
  /**
   * The same connection `db` wraps.
   *
   * `LabelStore` holds the raw handle rather than the Drizzle one: its canonical key is its own
   * format and it reads back nothing but integers, so none of the column mappers that make Drizzle
   * the validated boundary apply to it. Passed separately rather than unwrapped from `db`, because
   * reaching into Drizzle's internals for the connection it was built from is exactly the kind of
   * coupling that breaks on a minor upgrade.
   */
  readonly connection: Database.Database;
}

/**
 * Build the repository set.
 *
 * The order is the dependency order and is worth reading as such: `groups` first because `members`
 * needs its epoch bump, `labels` before `messages` because every message interns one.
 */
export function makeRepositories(options: RepositoriesOptions): Repositories {
  const { db, connection } = options;
  const groups = new SqliteGroupRepository(db);
  const labels = new LabelStore(connection);
  const spaces = new EmbeddingSpaceManager({ db, connection, ids: options.ids });
  // A **getter**, not a value. Reading the active space here made constructing the repository set
  // require a migrated database, and `SqliteStore` is built at boot around the migration rather
  // than after it — see the note on `MemoryRepositoryOptions.activeSpaceSlug`.
  const activeSpaceSlug = () => spaces.activeSpace()?.slug;
  const set = {
    groups,
    persons: new SqlitePersonRepository(db),
    identities: new SqliteChannelIdentityRepository(db),
    members: new SqliteMemberRepository(db, groups),
    conversations: new SqliteConversationRepository(db),
    messages: new SqliteMessageRepository(db, labels),
    settings: new SqliteSettingsRepository(db),
    labels,
    messagesUnfiltered: new SqliteMessageReaderUnfiltered(db),
    memories: new SqliteMemoryRepository({ db, connection, labels, activeSpaceSlug }),
    memorySearch: new SqliteMemorySearch({ db, connection, activeSpaceSlug }),
    calendar: new SqliteCalendarRepository(db, labels),
    tasks: new SqliteTaskRepository(db, labels),
    lists: new SqliteListRepository(db, labels),
    polls: new SqlitePollRepository(db, labels),
    plans: new SqlitePlanRepository(db, labels),
    decisions: new SqliteDecisionRepository(db, labels),
    reminders: new SqliteReminderRepository(db, labels),
    embeddingSpaces: spaces,
  };
  return { ...set, context: new SqliteContextReadModel(set) };
}

export { SqliteContextReadModel } from '../readmodels/context.js';
export { SqliteCalendarRepository } from './calendar.js';
export { SqliteConversationRepository } from './conversations.js';
export {
  SqliteDecisionRepository,
  SqlitePlanRepository,
  SqlitePollRepository,
  SqliteReminderRepository,
} from './coordination.js';
export { SqliteGroupRepository } from './groups.js';
export { after, midpoint, SqliteListRepository } from './lists.js';
export { SqliteMemberRepository } from './members.js';
export { SqliteMemoryRepository } from './memory.js';
export { dedupeKey, SqliteMessageRepository } from './messages.js';
export { SqliteChannelIdentityRepository, SqlitePersonRepository } from './persons.js';
export { SqliteSettingsRepository } from './settings.js';
export { SqliteTaskRepository } from './tasks.js';
export { SqliteMessageReaderUnfiltered } from './unfiltered/messages.js';
