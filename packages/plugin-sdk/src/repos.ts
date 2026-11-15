/**
 * `ScopedRepositories` — the stable domain surface a tool gets (`10` §3.2.4).
 *
 * Every method here maps to exactly one `ActionRequest.kind` owned by `03`/`07`, and that is the
 * point: a plugin never touches a table. A read returns only rows whose label the invocation's
 * audience may see, filtered below the plugin rather than by it; a write goes through
 * `PolicyEngine.authorize` with the **requester's** authority, so a plugin cannot do for somebody
 * what that person could not do themselves (invariant I3, requester authority).
 *
 * `M5-T9` implements this in `engine/src/tools-executor/scoped-repos/`. This module is the contract
 * both sides compile against.
 *
 * ## Why the views are projections and not the aggregates
 *
 * `@comvivo/core` already has `Event`, `Task`, `List` and the rest, and handing one to a plugin
 * would be shorter to write. It would also hand over `labelId`, `rid`, `version`,
 * `tzdataVersion`, `occurrenceKey` and `contentHash` — storage mechanics that mean nothing outside
 * the repository, that a plugin would come to depend on, and that we could then never change
 * without breaking published plugins.
 *
 * The field types are spelled out rather than written as `Event['title']`. An indexed access would
 * keep the two in lockstep, but it also puts `Event` — a type this package deliberately does not
 * export — into the published `.d.ts`, where a plugin author's editor sends them chasing a name
 * they cannot import. The mapping lives in `M5-T9`'s facade, which is where a domain change should
 * surface as a type error.
 *
 * Every view carries `label` and `provenance` so a plugin can propagate them on a derived write
 * instead of inventing a label — which would be a write-down (I2) waiting to happen.
 */
import type {
  EventPatch,
  EventStatus,
  Label,
  ListKind,
  Location,
  MemberRole,
  MemoryKind,
  ReminderAnchor,
  ReminderDelivery,
  ReminderKind,
  ReminderSchedule,
  ReminderStatus,
  SubjectRef,
  TaskKind,
  TaskStatus,
} from '@comvivo/core';
import type {
  EventId,
  ListId,
  ListItemId,
  MemberId,
  MemoryId,
  ProposalId,
  ReminderId,
  TaskId,
  TimeZoneId,
} from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { PluginPermissions, RepoEntity, RepoGrant } from './permissions.js';

/**
 * How a row came to exist.
 *
 * Trust is **not** here: that is `label.untrusted`, and duplicating it would create two answers to
 * one question. This says *who or what* produced the row, which is what a plugin needs in order to
 * leave other people's data alone — an importer that overwrites a row a member typed by hand is the
 * single most common way a calendar sync loses a group's trust.
 */
export interface ViewProvenance {
  readonly origin: 'member' | 'system' | 'import' | 'plugin';
  /** The provider id, for `import` and `plugin`; `undefined` otherwise. */
  readonly providerId: string | undefined;
  readonly createdByMemberId: MemberId | undefined;
  readonly createdAt: Temporal.Instant;
}

/**
 * How a plugin names a record in **its own** external system (`10` §3.2.4, §3.11).
 *
 * Only the external identity, because the host scopes every `*BySource` call to the calling
 * provider. A `SourceRef` that carried its own provider or feed id would let one plugin upsert over
 * another's rows, and the host would have to refuse it anyway — so the narrower type says the true
 * thing instead of saying a wider thing and then rejecting most of it. (`10` §3.11's ICS mapping
 * keeps its richer internal shape; the two are not the same type. Logged as a plan change.)
 */
export interface SourceRef {
  /** The external system's stable id for the record — an ICS `UID`, an API's row id. */
  readonly uid: string;
  /** For one occurrence of a recurring record (an ICS `RECURRENCE-ID`). */
  readonly recurrenceId?: string;
}

/**
 * The result of a write (`10` §3.2.4).
 *
 * Four arms, because a write can fail in four different ways that a plugin must handle differently:
 * `denied` is final and carries copy the plugin should pass on verbatim; `needs_confirmation` means
 * somebody is being asked right now and the answer will arrive as a separate turn;
 * `contested` means the group disagrees and a proposal is open. A boolean would collapse all four
 * into "it didn't work".
 *
 * Distinct from `@comvivo/core`'s storage-level `WriteResult` (`ports/storage/uow.ts`), which is
 * about rows and conflicts. This one is about *authority*. Import both and alias one.
 */
export type WriteResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'denied'; readonly userMessage: string }
  | {
      readonly kind: 'needs_confirmation';
      readonly from: 'requester' | 'owner' | 'admin' | 'guardian';
    }
  | { readonly kind: 'contested'; readonly proposalId: ProposalId };

export function isWriteOk<T>(result: WriteResult<T>): result is { kind: 'ok'; value: T } {
  return result.kind === 'ok';
}

/* ─────────────────────────────────────── Calendar ─────────────────────────────────────── */

export interface EventView {
  readonly id: EventId;
  readonly title: string;
  readonly notes: string | undefined;
  readonly location: Location | undefined;
  readonly allDay: boolean;
  readonly timeZone: TimeZoneId;
  /** The wall time a member named, e.g. `2026-11-10T18:00`. Authoritative over `startAt`. */
  readonly startLocal: string;
  readonly endLocal: string | undefined;
  readonly startAt: Temporal.Instant;
  readonly endAt: Temporal.Instant | undefined;
  readonly rrule: string | undefined;
  readonly status: EventStatus;
  readonly busy: boolean;
  readonly label: Label;
  readonly provenance: ViewProvenance;
}

export interface EventDraft {
  readonly title: string;
  /** Wall-clock (`2026-11-10T18:00`), in `timeZone`. Never an instant: a group moves, a dinner does not. */
  readonly startLocal: string;
  readonly endLocal?: string;
  /** Defaults to the group's zone. */
  readonly timeZone?: TimeZoneId;
  readonly allDay?: boolean;
  readonly location?: Location;
  readonly notes?: string;
  readonly url?: string;
  readonly rrule?: string;
  readonly busy?: boolean;
  /** Clamped by the host to `join(requested, inputProvenanceLabels, { untrusted: true })`. */
  readonly label?: Label;
}

export interface CalendarQuery {
  /** Wall-clock or ISO instant; inclusive. */
  readonly from: string;
  readonly to: string;
  readonly text?: string;
  readonly limit?: number;
}

export interface CalendarReader {
  list(query: CalendarQuery): Promise<readonly EventView[]>;
  get(id: EventId): Promise<EventView | null>;
}

export interface CalendarWriter {
  create(draft: EventDraft): Promise<WriteResult<EventView>>;
  update(id: EventId, patch: EventPatch): Promise<WriteResult<EventView>>;
  /** Idempotent import: creates or updates the row this provider owns for `source`. */
  upsertBySource(source: SourceRef, draft: EventDraft): Promise<WriteResult<EventView>>;
  cancelBySource(source: SourceRef): Promise<WriteResult<void>>;
}

/* ───────────────────────────────────────── Lists ──────────────────────────────────────── */

export interface ListItemView {
  readonly id: ListItemId;
  readonly listId: ListId;
  readonly text: string;
  readonly quantity: string | undefined;
  readonly category: string | undefined;
  readonly checked: boolean;
  readonly label: Label;
  readonly provenance: ViewProvenance;
}

export interface ListView {
  readonly id: ListId;
  readonly name: string;
  readonly kind: ListKind;
  readonly isDefault: boolean;
  readonly items: readonly ListItemView[];
  readonly label: Label;
  readonly provenance: ViewProvenance;
}

export interface ListReader {
  /** By name (case- and accent-insensitive) or by id. `null` rather than a guess. */
  find(nameOrId: string): Promise<ListView | null>;
  all(): Promise<readonly ListView[]>;
}

export interface ListWriter {
  addItems(listId: ListId, items: readonly string[]): Promise<WriteResult<readonly ListItemView[]>>;
  setChecked(itemId: ListItemId, checked: boolean): Promise<WriteResult<void>>;
}

/* ───────────────────────────────────────── Tasks ──────────────────────────────────────── */

export interface TaskView {
  readonly id: TaskId;
  readonly title: string;
  readonly kind: TaskKind;
  readonly assigneeMemberId: MemberId | undefined;
  readonly status: TaskStatus;
  readonly dueAt: Temporal.Instant | undefined;
  readonly dueLocal: string | undefined;
  readonly effortPoints: number;
  readonly label: Label;
  readonly provenance: ViewProvenance;
}

export interface TaskQuery {
  readonly status?: readonly TaskStatus[];
  readonly assigneeMemberId?: MemberId;
  readonly dueBefore?: Temporal.Instant;
  readonly limit?: number;
}

export interface TaskDraft {
  readonly title: string;
  readonly notes?: string;
  readonly kind?: TaskKind;
  readonly assigneeMemberId?: MemberId;
  readonly dueLocal?: string;
  readonly dueTimeZone?: TimeZoneId;
  readonly effortPoints?: number;
  readonly label?: Label;
}

export interface TaskReader {
  list(query: TaskQuery): Promise<readonly TaskView[]>;
}

export interface TaskWriter {
  create(draft: TaskDraft): Promise<WriteResult<TaskView>>;
  complete(id: TaskId): Promise<WriteResult<void>>;
}

/* ─────────────────────────────────────── Reminders ────────────────────────────────────── */

export interface ReminderView {
  readonly id: ReminderId;
  readonly text: string | undefined;
  readonly kind: ReminderKind;
  readonly nextFireAt: Temporal.Instant | undefined;
  readonly status: ReminderStatus;
  readonly label: Label;
  readonly provenance: ViewProvenance;
}

export interface ReminderDraft {
  readonly text: string;
  /**
   * Who it fires to, named by role rather than by conversation.
   *
   * `10` §3.2.4 gives `ctx.audience` a size and no member list, deliberately — a plugin does not
   * get the roster. So a draft names `'requester'` (a DM to whoever asked) or `'group'` (the
   * conversation this turn is in), and the host resolves it; an explicit member list stays
   * possible for the plugin that legitimately holds ids from a read. Logged as a plan change:
   * §3.2.4's shape would have required a `conversationId` a plugin has no way to obtain.
   */
  readonly to: 'requester' | 'group' | readonly MemberId[];
  readonly schedule: ReminderSchedule;
  /** `fixed_zone` fires at the same instant for everyone; `member_local` at the same wall time. */
  readonly anchor?: ReminderAnchor;
  readonly delivery?: ReminderDelivery;
  readonly label?: Label;
}

export interface ReminderWriter {
  create(draft: ReminderDraft): Promise<WriteResult<ReminderView>>;
}

/* ──────────────────────────────────── Memory, members ─────────────────────────────────── */

/**
 * One memory, rendered.
 *
 * `text` rather than `04`'s discriminated `MemoryContent`: a plugin that switched on the content
 * kind would be coupled to `04`'s extraction schema, and `04` changes that schema as the extractor
 * improves. The rendering is the host's, under the same IFC filter as the row.
 */
export interface MemoryView {
  readonly id: MemoryId;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly subjectRef: SubjectRef | undefined;
  readonly recordedAt: Temporal.Instant;
  readonly label: Label;
  readonly provenance: ViewProvenance;
}

export interface MemoryQuery {
  readonly text: string;
  readonly kinds?: readonly MemoryKind[];
  readonly limit?: number;
}

export interface MemoryReader {
  /** Delegates to `04`'s IFC-filtered query service, bound to the invocation's audience. */
  search(query: MemoryQuery): Promise<readonly MemoryView[]>;
}

export interface MemberSummary {
  readonly memberId: MemberId;
  readonly displayName: string;
  readonly role: MemberRole;
}

export interface MemberReader {
  directory(): Promise<readonly MemberSummary[]>;
}

/* ──────────────────────────────── The facade, per permission ─────────────────────────── */

/** The facade for entity `E` at access level `A`. `'write'` adds the writer half to the reader. */
export type RepoFacade<E extends RepoEntity, A> = E extends 'calendar'
  ? A extends 'write'
    ? CalendarReader & CalendarWriter
    : CalendarReader
  : E extends 'lists'
    ? A extends 'write'
      ? ListReader & ListWriter
      : ListReader
    : E extends 'tasks'
      ? A extends 'write'
        ? TaskReader & TaskWriter
        : TaskReader
      : E extends 'reminders'
        ? ReminderWriter
        : E extends 'memory'
          ? MemoryReader
          : E extends 'members'
            ? MemberReader
            : never;

/**
 * The repositories a plugin declared, and only those.
 *
 * A mapped type with `as`-clause key removal rather than a fixed object with optional members:
 * optional members would still *exist* at type level, so `ctx.repos.calendar?.list(…)` would
 * compile for a plugin that never asked for the calendar and fail at runtime. Removing the key
 * makes it a compile error, which is `10` §3.2.2's "undeclared capabilities are absent at type
 * level" taken literally.
 */
export type ScopedRepositories<P extends PluginPermissions> = {
  readonly [E in RepoEntity as [RepoGrant<P, E>] extends [never] ? never : E]: RepoFacade<
    E,
    RepoGrant<P, E>
  >;
};
