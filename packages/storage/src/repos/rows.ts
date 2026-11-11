/**
 * Row → domain mappers (`02` §3.7.1: "Reads return domain objects").
 *
 * Every mapper here does exactly one thing beyond renaming: it turns SQL's `NULL` into
 * `undefined`. That conversion is worth a module of its own because it is the one place the two
 * models disagree, and getting it wrong in either direction is quiet.
 *
 * **Why `undefined` and not `null`.** A domain object is read by `core`, where `exactOptionalPropertyTypes`
 * is on and `undefined` is the language's own absence. Carrying `null` through would mean every
 * consumer writing `value !== null && value !== undefined`, and the first one to write only half of
 * that check gets a bug that typechecks. `null` stays on the SQL side of this file and nowhere else.
 *
 * **What these mappers deliberately do not do.** No validation. The column types in
 * `schema/_columns.ts` already parsed every TypeID, every instant and every JSON column on the way
 * out of SQLite, and re-checking here would be checking Drizzle against itself — the pattern
 * `02` §3.12.1's `checksumOf` finding named as a test that proves nothing. If a value is wrong, it
 * is wrong because a column mapper let it through, and that is where the guard belongs.
 */
import type {
  ChannelIdentity,
  Conversation,
  Event,
  EventAttendee,
  Group,
  LedgerEntry,
  List,
  ListItem,
  Member,
  MemoryItem,
  MemorySource,
  MemorySubject,
  Message,
  Person,
  RetrievalState,
  Setting,
  Task,
} from '@comvivo/core';
import type {
  channelIdentities,
  conversations,
  eventAttendees,
  events,
  groups,
  ledgerEntries,
  listItems,
  lists,
  members,
  memoryItems,
  memorySources,
  memorySubjects,
  messages,
  persons,
  settings,
  tasks,
} from '../schema/index.js';

/** `null` → `undefined`, the only transformation these mappers perform. */
function opt<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

export function toGroup(row: typeof groups.$inferSelect): Group {
  return {
    id: row.id,
    name: row.name,
    archetype: row.archetype,
    constitutionVersionId: opt(row.constitutionVersionId),
    historyVisibility: row.historyVisibility,
    timezone: row.timezone,
    locale: row.locale,
    primaryConversationId: opt(row.primaryConversationId),
    weekStart: row.weekStart,
    status: row.status,
    membershipEpoch: row.membershipEpoch,
    extensionsVersion: row.extensionsVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export function toPerson(row: typeof persons.$inferSelect): Person {
  return {
    id: row.id,
    displayName: row.displayName,
    displayNameSource: row.displayNameSource,
    locale: opt(row.locale),
    timezone: opt(row.timezone),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    erasedAt: opt(row.erasedAt),
  };
}

export function toChannelIdentity(row: typeof channelIdentities.$inferSelect): ChannelIdentity {
  return {
    id: row.id,
    channel: row.channel,
    platformUserId: row.platformUserId,
    personId: row.personId,
    displayNameSnapshot: row.displayNameSnapshot,
    platformUsername: opt(row.platformUsername),
    isBot: row.isBot,
    dmReachable: row.dmReachable,
    dmChatId: opt(row.dmChatId),
    verifiedAt: opt(row.verifiedAt),
    lastSeenAt: opt(row.lastSeenAt),
    createdAt: row.createdAt,
  };
}

export function toMember(row: typeof members.$inferSelect): Member {
  return {
    id: row.id,
    groupId: row.groupId,
    personId: row.personId,
    role: row.role,
    ageBand: row.ageBand,
    handle: row.handle,
    status: row.status,
    consent: row.consent,
    nickname: opt(row.nickname),
    joinedAt: row.joinedAt,
    leftAt: opt(row.leftAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export function toConversation(row: typeof conversations.$inferSelect): Conversation {
  return {
    id: row.id,
    groupId: row.groupId,
    channel: row.channel,
    platformChatId: row.platformChatId,
    kind: row.kind,
    memberId: opt(row.memberId),
    primary: row.primary,
    title: opt(row.title),
    boundAt: row.boundAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * `messages` → `Message`.
 *
 * `labelId` is asserted non-null rather than `opt`'d: the column is `NOT NULL` in `02` §3.3.3, and
 * a `Message` with no label could not be filtered by eligibility at all — so the one place that
 * would be a real defect is the one place a silent `undefined` must not be produced.
 */
export function toMessage(row: typeof messages.$inferSelect): Message {
  return {
    rid: row.rid,
    id: row.id,
    groupId: row.groupId,
    conversationId: row.conversationId,
    kind: row.kind,
    senderMemberId: opt(row.senderMemberId),
    senderIdentityId: opt(row.senderIdentityId),
    platformMessageId: opt(row.platformMessageId),
    platformThreadId: opt(row.platformThreadId),
    text: row.text,
    richText: opt(row.richText),
    replyToMessageId: opt(row.replyToMessageId),
    derivedFromMessageId: opt(row.derivedFromMessageId),
    forwarded: opt(row.forwarded),
    untrusted: row.untrusted,
    labelId: row.labelId,
    sentAt: row.sentAt,
    receivedAt: row.receivedAt,
    deliveredLate: row.deliveredLate,
    truncated: row.truncated,
    editedAt: opt(row.editedAt),
    editCount: row.editCount,
    deletedAt: opt(row.deletedAt),
    redactedAt: opt(row.redactedAt),
    turnId: opt(row.turnId),
    clientMessageId: opt(row.clientMessageId),
    retentionUntil: opt(row.retentionUntil),
  };
}

export function toSetting(row: typeof settings.$inferSelect): Setting {
  return {
    scope: row.scope,
    key: row.key,
    value: row.value,
    updatedAt: row.updatedAt,
    updatedBy: opt(row.updatedBy),
  };
}

/**
 * `memory_items` → `MemoryItem`.
 *
 * `retrievalState` is cast rather than validated, and that is the one place here worth a note: the
 * column has `CHECK (retrieval_state BETWEEN 0 AND 3)` (`02` §3.3.4), so the database is what
 * guarantees the value is in the union — re-checking would be checking SQLite against itself, the
 * pattern this module's header rules out.
 */
export function toMemoryItem(row: typeof memoryItems.$inferSelect): MemoryItem {
  return {
    rid: row.rid,
    id: row.id,
    groupId: row.groupId,
    kind: row.kind,
    content: row.content,
    statement: row.statement,
    searchTerms: row.searchTerms,
    language: row.language,
    fingerprint: row.fingerprint,
    labelId: row.labelId,
    provenance: row.provenance,
    confidence: row.confidence,
    status: row.status,
    validFrom: row.validFrom,
    validTo: opt(row.validTo),
    supersedesId: opt(row.supersedesId),
    supersededById: opt(row.supersededById),
    contradicts: row.contradicts,
    links: row.links,
    retrievalState: row.retrievalState as RetrievalState,
    pinned: row.pinned,
    pinnedAt: opt(row.pinnedAt),
    archivedAt: opt(row.archivedAt),
    lastConfirmedAt: opt(row.lastConfirmedAt),
    retractReason: opt(row.retractReason),
    portable: row.portable,
    embeddingState: row.embeddingState,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export function toMemorySubject(row: typeof memorySubjects.$inferSelect): MemorySubject {
  return { ref: row.subjectRef, role: row.role };
}

export function toMemorySource(row: typeof memorySources.$inferSelect): MemorySource {
  return {
    ref: row.sourceRef,
    messageId: opt(row.messageId),
    windowKey: opt(row.windowKey),
    span: opt(row.span),
    addedAt: row.addedAt,
  };
}

/* --- Coordination (`02` §3.3.5; `M1-T19`) ----------------------------------------------------- */

export function toEvent(row: typeof events.$inferSelect): Event {
  return {
    rid: row.rid,
    id: row.id,
    groupId: row.groupId,
    seriesId: row.seriesId,
    splitFromEventId: opt(row.splitFromEventId),
    title: row.title,
    notes: opt(row.notes),
    url: opt(row.url),
    location: opt(row.location),
    allDay: row.allDay,
    tz: row.tz,
    startLocal: row.startLocal,
    endLocal: opt(row.endLocal),
    startAt: row.startAt,
    endAt: opt(row.endAt),
    rrule: opt(row.rrule),
    rruleInvalid: row.rruleInvalid,
    rdates: row.rdates,
    exdates: row.exdates,
    recurrenceUntilAt: opt(row.recurrenceUntilAt),
    status: row.status,
    busy: row.busy,
    attendeesMode: row.attendeesMode,
    // `lead_times` is `jsonOf(… .nullable())`, so the column holds a JSON `null` as a *value* —
    // which `opt` would leave as `null`. Normalised here like every other absence.
    leadTimes: row.leadTimes ?? undefined,
    source: row.source,
    subscriptionId: opt(row.subscriptionId),
    sourceUid: opt(row.sourceUid),
    sourceRecurrenceId: opt(row.sourceRecurrenceId),
    contentHash: opt(row.contentHash),
    planId: opt(row.planId),
    labelId: row.labelId,
    createdByMemberId: opt(row.createdByMemberId),
    updatedByMemberId: opt(row.updatedByMemberId),
    icsUid: row.icsUid,
    icsSequence: row.icsSequence,
    tzdataVersion: row.tzdataVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export function toEventAttendee(row: typeof eventAttendees.$inferSelect): EventAttendee {
  return {
    eventId: row.eventId,
    memberId: row.memberId,
    // The column is `rsvp`; the domain field is `response`, which reads better at a call site
    // (`attendee.response === 'accepted'`). The rename lives here and nowhere else.
    response: row.rsvp,
    respondedAt: opt(row.respondedAt),
  };
}

export function toTask(row: typeof tasks.$inferSelect): Task {
  return {
    rid: row.rid,
    id: row.id,
    groupId: row.groupId,
    kind: row.kind,
    title: row.title,
    notes: opt(row.notes),
    category: opt(row.category),
    assigneeMemberId: opt(row.assigneeMemberId),
    assignmentState: row.assignmentState,
    requestedByMemberId: opt(row.requestedByMemberId),
    effortPoints: row.effortPoints,
    due: row.due,
    dueAt: opt(row.dueAt),
    dueTz: opt(row.dueTz),
    dueLocal: opt(row.dueLocal),
    recurrence: opt(row.recurrence),
    rotationId: opt(row.rotationId),
    occurrenceKey: opt(row.occurrenceKey),
    proofPolicy: row.proofPolicy,
    status: row.status,
    completedAt: opt(row.completedAt),
    completedByMemberId: opt(row.completedByMemberId),
    verifiedByMemberId: opt(row.verifiedByMemberId),
    nudgeCount: row.nudgeCount,
    planId: opt(row.planId),
    planStepId: opt(row.planStepId),
    labelId: row.labelId,
    sourceRef: opt(row.sourceRef),
    createdByMemberId: opt(row.createdByMemberId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export function toLedgerEntry(row: typeof ledgerEntries.$inferSelect): LedgerEntry {
  return {
    id: row.id,
    groupId: row.groupId,
    memberId: row.memberId,
    kind: row.kind,
    category: opt(row.category),
    points: row.points,
    taskId: opt(row.taskId),
    rotationId: opt(row.rotationId),
    sourceRef: opt(row.sourceRef),
    reversesId: opt(row.reversesId),
    labelId: row.labelId,
    at: row.at,
  };
}

export function toList(row: typeof lists.$inferSelect): List {
  return {
    id: row.id,
    groupId: row.groupId,
    name: row.name,
    kind: row.kind,
    isDefault: row.isDefault,
    categoriesEnabled: row.categoriesEnabled,
    planId: opt(row.planId),
    labelId: row.labelId,
    createdByMemberId: opt(row.createdByMemberId),
    archivedAt: opt(row.archivedAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export function toListItem(row: typeof listItems.$inferSelect): ListItem {
  return {
    rid: row.rid,
    id: row.id,
    listId: row.listId,
    groupId: row.groupId,
    text: row.text,
    normalizedKey: row.normalizedKey,
    quantity: opt(row.quantity),
    category: opt(row.category),
    note: opt(row.note),
    checked: row.checked,
    checkedByMemberId: opt(row.checkedByMemberId),
    checkedAt: opt(row.checkedAt),
    addedByMemberId: opt(row.addedByMemberId),
    addedVia: row.addedVia,
    sourceMessageId: opt(row.sourceMessageId),
    position: row.position,
    labelId: row.labelId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

// The mappers for polls, plans, decisions and reminders are **not here yet**. They
// arrive with their repositories (`M1-T19` continues), because a mapper with no caller is code the
// per-file coverage thresholds correctly refuse — the same judgement that deleted three uncalled
// helpers at `M1-T17`. The row shapes are mechanical; what they cost to re-derive is less than
// what an unused export costs to carry.
