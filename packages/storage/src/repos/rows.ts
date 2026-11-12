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
  AuditEvent,
  ChannelIdentity,
  ConfirmationRequest,
  ConsentEvent,
  ConstitutionVersion,
  ConstraintRecord,
  Conversation,
  Decision,
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
  OutboxMessage,
  Person,
  Plan,
  PlanStep,
  Poll,
  Proposal,
  ProposalVote,
  Reminder,
  ReminderFiring,
  RetrievalState,
  Setting,
  StandingApproval,
  Task,
  Turn,
  TurnEffect,
  TurnTrace,
  UsageDailyRow,
  UsageRecord,
} from '@comvivo/core';
import { internedId } from '@comvivo/shared';
import type {
  auditEvents,
  channelIdentities,
  confirmationRequests,
  consentEvents,
  constitutionVersions,
  constraintRecords,
  conversations,
  decisions,
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
  outboxMessages,
  persons,
  planSteps,
  plans,
  polls,
  proposals,
  proposalVotes,
  reminderFirings,
  reminders,
  settings,
  standingApprovals,
  tasks,
  turnEffects,
  turns,
  turnTraces,
  usageDaily,
  usageRecords,
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

export function toPoll(row: typeof polls.$inferSelect): Poll {
  return {
    rid: row.rid,
    id: row.id,
    groupId: row.groupId,
    conversationId: row.conversationId,
    purpose: row.purpose,
    proposalId: opt(row.proposalId),
    question: row.question,
    options: row.options,
    allowMultiple: row.allowMultiple,
    rule: row.rule,
    quorum: row.quorum,
    eligibleMemberIds: row.eligibleMemberIds,
    anonymous: row.anonymous,
    resultsVisibility: row.resultsVisibility,
    mode: row.mode,
    deadlineAt: opt(row.deadlineAt),
    status: row.status,
    outcome: opt(row.outcome),
    platformPollRef: opt(row.platformPollRef),
    decisionId: opt(row.decisionId),
    planStepId: opt(row.planStepId),
    labelId: row.labelId,
    createdByMemberId: opt(row.createdByMemberId),
    createdAt: row.createdAt,
    closedAt: opt(row.closedAt),
    version: row.version,
  };
}

export function toPlan(row: typeof plans.$inferSelect): Plan {
  return {
    rid: row.rid,
    id: row.id,
    groupId: row.groupId,
    kind: row.kind,
    title: row.title,
    description: opt(row.description),
    ownerMemberIds: row.ownerMemberIds,
    status: row.status,
    secrecy: opt(row.secrecy),
    tz: opt(row.tz),
    startsOn: opt(row.startsOn),
    endsOn: opt(row.endsOn),
    budgetNotes: row.budgetNotes,
    assumptions: row.assumptions,
    labelId: row.labelId,
    createdByMemberId: opt(row.createdByMemberId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export function toPlanStep(row: typeof planSteps.$inferSelect): PlanStep {
  return {
    id: row.id,
    planId: row.planId,
    groupId: row.groupId,
    position: row.position,
    title: row.title,
    ownerMemberIds: row.ownerMemberIds,
    status: row.status,
    confirmState: row.confirmState,
    due: opt(row.due),
    dueAt: opt(row.dueAt),
    dependsOn: row.dependsOn,
    links: row.links,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export function toDecision(row: typeof decisions.$inferSelect): Decision {
  return {
    rid: row.rid,
    id: row.id,
    groupId: row.groupId,
    summary: row.summary,
    rationale: opt(row.rationale),
    topicTags: row.topicTags,
    decidedBy: row.decidedBy,
    alternativesRejected: row.alternativesRejected,
    sourceRefs: row.sourceRefs,
    origin: row.origin,
    status: row.status,
    supersedesId: opt(row.supersedesId),
    supersededById: opt(row.supersededById),
    labelId: row.labelId,
    memoryItemId: opt(row.memoryItemId),
    proposalId: opt(row.proposalId),
    decidedAt: row.decidedAt,
    decidedTz: row.decidedTz,
    createdAt: row.createdAt,
    version: row.version,
  };
}

export function toReminder(row: typeof reminders.$inferSelect): Reminder {
  return {
    id: row.id,
    groupId: row.groupId,
    kind: row.kind,
    text: opt(row.text),
    recipients: row.recipients,
    delivery: row.delivery,
    schedule: row.schedule,
    anchor: row.anchor,
    aboutRef: opt(row.aboutRef),
    // `NOT NULL`: a reminder's audience is frozen at creation, so there is no absence to
    // normalise. Narrowed through `internedId` rather than cast, like every other interned id out
    // of a column — `reader_sets.id` is `AUTOINCREMENT`, so a non-positive value means a corrupt
    // row (the `M1-T16` lesson about the branded `ReaderSetId`).
    audienceReaderSetId: internedId(row.audienceReaderSetId, 'reader_sets'),
    labelId: row.labelId,
    createdByMemberId: opt(row.createdByMemberId),
    nextFireAt: opt(row.nextFireAt),
    status: row.status,
    snoozedUntil: opt(row.snoozedUntil),
    staleAfter: opt(row.staleAfter),
    tzdataVersion: row.tzdataVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export function toReminderFiring(row: typeof reminderFirings.$inferSelect): ReminderFiring {
  return {
    id: row.id,
    reminderId: row.reminderId,
    groupId: row.groupId,
    occurrenceKey: row.occurrenceKey,
    scheduledFor: row.scheduledFor,
    firedAt: row.firedAt,
    outcome: row.outcome,
    outboxIds: row.outboxIds,
    ackedByMemberId: opt(row.ackedByMemberId),
    ackAt: opt(row.ackAt),
  };
}

/* --- Governance (`02` §3.3.6; `M1-T20`) ------------------------------------------------------- */

export function toConstitutionVersion(
  row: typeof constitutionVersions.$inferSelect,
): ConstitutionVersion {
  return {
    id: row.id,
    groupId: row.groupId,
    version: row.version,
    parentVersionId: opt(row.parentVersionId),
    yaml: row.yaml,
    yamlSha256: row.yamlSha256,
    charterText: row.charterText,
    compiled: row.compiled,
    compilerVersion: row.compilerVersion,
    adoptedVia: row.adoptedVia,
    adoptedBy: row.adoptedBy,
    proposalId: opt(row.proposalId),
    adoptedAt: row.adoptedAt,
  };
}

export function toProposal(row: typeof proposals.$inferSelect): Proposal {
  return {
    id: row.id,
    groupId: row.groupId,
    kind: row.kind,
    payload: row.payload,
    actionDigest: opt(row.actionDigest),
    rule: row.rule,
    electorate: row.electorate,
    status: row.status,
    proposerMemberId: row.proposerMemberId,
    ballotRefs: row.ballotRefs,
    supersededById: opt(row.supersededById),
    canonicalDiffHash: opt(row.canonicalDiffHash),
    deadlineAt: opt(row.deadlineAt),
    minOpenUntil: opt(row.minOpenUntil),
    openedAt: row.openedAt,
    closedAt: opt(row.closedAt),
    outcome: opt(row.outcome),
    labelId: row.labelId,
    version: row.version,
  };
}

export function toProposalVote(row: typeof proposalVotes.$inferSelect): ProposalVote {
  return {
    proposalId: row.proposalId,
    memberId: row.memberId,
    choice: row.choice,
    via: row.via,
    labelId: row.labelId,
    castAt: row.castAt,
  };
}

export function toConsentEvent(row: typeof consentEvents.$inferSelect): ConsentEvent {
  return {
    id: row.id,
    memberId: row.memberId,
    groupId: row.groupId,
    fromState: row.fromState,
    toState: row.toState,
    via: row.via,
    at: row.at,
  };
}

export function toConstraintRecord(row: typeof constraintRecords.$inferSelect): ConstraintRecord {
  return {
    id: row.id,
    groupId: row.groupId,
    kind: row.kind,
    catalogVersion: row.catalogVersion,
    value: row.value,
    subjectMemberId: row.subjectMemberId,
    ownerMemberIds: row.ownerMemberIds,
    attribution: row.attribution,
    reasonDisclosure: row.reasonDisclosure,
    scope: row.scope,
    validFrom: row.validFrom,
    validTo: opt(row.validTo),
    status: row.status,
    approvedBy: row.approvedBy,
    approvalMode: opt(row.approvalMode),
    labelId: row.labelId,
    sealedSourceRefs: row.sealedSourceRefs,
    sealedLabelId: row.sealedLabelId,
    supersedesId: opt(row.supersedesId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

export function toStandingApproval(row: typeof standingApprovals.$inferSelect): StandingApproval {
  return {
    id: row.id,
    groupId: row.groupId,
    guardianMemberId: row.guardianMemberId,
    wardMemberId: row.wardMemberId,
    actionPatterns: row.actionPatterns,
    expiresAt: row.expiresAt,
    revokedAt: opt(row.revokedAt),
    createdAt: row.createdAt,
  };
}

export function toConfirmationRequest(
  row: typeof confirmationRequests.$inferSelect,
): ConfirmationRequest {
  return {
    id: row.id,
    groupId: row.groupId,
    turnId: opt(row.turnId),
    conversationId: opt(row.conversationId),
    proposalId: opt(row.proposalId),
    capacity: row.capacity,
    requesterMemberId: row.requesterMemberId,
    eligibleMemberIds: row.eligibleMemberIds,
    quorum: row.quorum,
    reasons: row.reasons,
    actionDigest: row.actionDigest,
    toolName: opt(row.toolName),
    input: opt(row.input),
    actionRequest: opt(row.actionRequest),
    targetVersion: opt(row.targetVersion),
    summary: row.summary,
    summaryLabelId: row.summaryLabelId,
    delivery: row.delivery,
    options: row.options,
    nonce: row.nonce,
    promptOutboxIds: row.promptOutboxIds,
    responses: row.responses,
    status: row.status,
    expiresAt: row.expiresAt,
    onExpire: row.onExpire,
    decidedByMemberId: opt(row.decidedByMemberId),
    decidedAt: opt(row.decidedAt),
    labelId: row.labelId,
    createdAt: row.createdAt,
    version: row.version,
  };
}

/* ───────────────────────── Runtime (`M1-T21`, `02` §3.3.7) ───────────────────────── */

export function toTurn(row: typeof turns.$inferSelect): Turn {
  return {
    id: row.id,
    groupId: row.groupId,
    conversationId: row.conversationId,
    kind: row.kind,
    triggerMessageIds: row.triggerMessageIds,
    requesterMemberId: opt(row.requesterMemberId),
    audienceReaderSetId: internedId(row.audienceReaderSetId, 'reader_sets'),
    status: row.status,
    phase: opt(row.phase),
    phaseStep: opt(row.phaseStep),
    effort: opt(row.effort),
    bootId: row.bootId,
    rootTurnId: row.rootTurnId,
    parentTurnId: opt(row.parentTurnId),
    retryOfTurnId: opt(row.retryOfTurnId),
    restarts: row.restarts,
    recoveryDone: row.recoveryDone,
    startedAt: row.startedAt,
    deadlineAt: row.deadlineAt,
    timedOutAt: opt(row.timedOutAt),
    completedAt: opt(row.completedAt),
    failure: opt(row.failure),
  };
}

export function toTurnEffect(row: typeof turnEffects.$inferSelect): TurnEffect {
  return {
    id: row.id,
    turnId: row.turnId,
    rootTurnId: row.rootTurnId,
    groupId: row.groupId,
    seq: row.seq,
    toolName: row.toolName,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    resultCiphertext: opt(row.resultCiphertext),
    summaryKey: row.summaryKey,
    summaryParams: row.summaryParams,
    entityRefs: row.entityRefs,
    labelId: row.labelId,
    committedAt: opt(row.committedAt),
    ackOutboxId: opt(row.ackOutboxId),
  };
}

export function toTurnTrace(row: typeof turnTraces.$inferSelect): TurnTrace {
  return {
    id: row.id,
    turnId: row.turnId,
    groupId: row.groupId,
    conversationId: row.conversationId,
    labelId: row.labelId,
    trigger: row.trigger,
    disposition: row.disposition,
    contextManifest: row.contextManifest,
    modelCalls: row.modelCalls,
    toolCalls: row.toolCalls,
    policyDecisions: row.policyDecisions,
    guardResults: row.guardResults,
    costMicros: row.costMicros,
    latency: row.latency,
    replay: row.replay,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export function toAuditEvent(row: typeof auditEvents.$inferSelect): AuditEvent {
  return {
    id: row.id,
    chainKey: row.chainKey,
    seq: row.seq,
    groupId: opt(row.groupId),
    actor: row.actor,
    action: row.action,
    target: opt(row.target),
    decision: row.decision,
    details: row.details,
    prevHash: row.prevHash,
    hash: row.hash,
    at: row.at,
  };
}

export function toUsageRecord(row: typeof usageRecords.$inferSelect): UsageRecord {
  return {
    id: row.id,
    groupId: opt(row.groupId),
    turnId: opt(row.turnId),
    jobId: opt(row.jobId),
    route: row.route,
    provider: row.provider,
    model: row.model,
    servedModel: row.servedModel,
    purpose: row.purpose,
    via: row.via,
    effort: opt(row.effort),
    kind: row.kind,
    inputTokens: row.inputTokens,
    cachedReadTokens: row.cachedReadTokens,
    cacheWrite5mTokens: row.cacheWrite5mTokens,
    cacheWrite1hTokens: row.cacheWrite1hTokens,
    outputTokens: row.outputTokens,
    costMicros: row.costMicros,
    priceTableVersion: row.priceTableVersion,
    batch: row.batch,
    at: row.at,
  };
}

export function toUsageDailyRow(row: typeof usageDaily.$inferSelect): UsageDailyRow {
  return {
    groupKey: row.groupKey,
    dayLocal: row.dayLocal,
    route: row.route,
    calls: row.calls,
    costMicros: row.costMicros,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedReadTokens: row.cachedReadTokens,
  };
}

export function toOutboxMessage(row: typeof outboxMessages.$inferSelect): OutboxMessage {
  return {
    id: row.id,
    groupId: opt(row.groupId),
    conversationId: row.conversationId,
    turnId: opt(row.turnId),
    seq: row.seq,
    idempotencyKey: row.idempotencyKey,
    messageClass: row.messageClass,
    priority: row.priority,
    expiryClass: row.expiryClass,
    payload: row.payload,
    parts: row.parts,
    contentHash: row.contentHash,
    audienceReaderSetId: internedId(row.audienceReaderSetId, 'reader_sets'),
    labelId: opt(row.labelId),
    guardRef: row.guardRef,
    manifestLabelIds: row.manifestLabelIds.map((id) => internedId(id, 'labels')),
    status: row.status,
    maybeSent: row.maybeSent,
    inFlightSince: opt(row.inFlightSince),
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    leaseUntil: opt(row.leaseUntil),
    platformMessageId: opt(row.platformMessageId),
    lastError: opt(row.lastError),
    createdAt: row.createdAt,
    sentAt: opt(row.sentAt),
  };
}
