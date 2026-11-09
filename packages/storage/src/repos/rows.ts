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
  Group,
  Member,
  Message,
  Person,
  Setting,
} from '@comvivo/core';
import type {
  channelIdentities,
  conversations,
  groups,
  members,
  messages,
  persons,
  settings,
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
