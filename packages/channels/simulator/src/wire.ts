/**
 * The simulator's wire format (`06` §3.21.7; `M3-T11`).
 *
 * A platform delivers one stream of updates, and this is that stream for a platform that does not
 * exist. Two decisions shape it.
 *
 * **It is not `InboundEnvelope`.** snake_case keys, a nested `chat`, a separate `entities` array,
 * times as strings. If the simulator spoke envelopes its adapter's ingest path would be a copy and
 * every scenario in `11` would be exercising the fixture loader rather than a translation. The
 * translation has to be real work for a run against `sim:telegram` to mean what `11` §3.2.6 says it
 * means — "a test sees exactly what a Telegram user would see".
 *
 * **It is the conformance kit's vocabulary.** `06` §3.25's cases construct payloads literally —
 * `{type:'message', update_id, chat:{id,kind}, from:{id,name}, message_id, at, text}` — and look
 * for platform calls by name (`sendMessage`, `ackUpdate`, `setTyping`, `ackCallback`). That makes
 * the shapes below part of the kit's contract rather than one fake's private business, and the
 * simulator adopts them deliberately: it is the second adapter to run the kit (`M3-T9`'s reference
 * adapter was the first), its platform is not a real one, so there is nothing to translate *from*
 * and every divergence would be a translation layer written for no reason. Noted in `06` §3.25 at
 * `M3-T11`, because a real platform's fake will have to translate and should know that in advance.
 *
 * Everything here is validated by zod on the way in (`CLAUDE.md` §2: every boundary). The boundary
 * is real even though both sides are ours: `control.replay` reads updates back from a recording
 * written by an older build, which is exactly the case a type cannot check.
 */
import { z } from 'zod';

/** A chat, as the platform describes one. */
export const SimChatSchema = z.strictObject({
  id: z.string().min(1).max(128),
  kind: z.enum(['group', 'dm']),
  title: z.string().max(256).optional(),
  thread: z.string().max(128).optional(),
});
export type SimChat = z.infer<typeof SimChatSchema>;

/**
 * Who sent something.
 *
 * `anonymous` and `channel` are the two cases `06` §3.3 maps to a `senderKind` other than `user`
 * and that a naive fake leaves out — an admin posting as the group, and a linked channel's
 * automatic forward. They are here because `08` PSC-9's S4 bot gate reads `senderKind`, so a
 * simulator that could not produce them would make that gate untestable.
 */
export const SimSenderSchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  username: z.string().max(128).optional(),
  is_bot: z.boolean().optional(),
  anonymous: z.boolean().optional(),
  channel: z.boolean().optional(),
});
export type SimSender = z.infer<typeof SimSenderSchema>;

export const SimFileSchema = z.strictObject({
  file_id: z.string().min(1).max(256),
  kind: z.enum(['image', 'voice', 'audio', 'video', 'file', 'sticker', 'location', 'contact']),
  bytes: z.int().min(0),
  mime: z.string().max(128).optional(),
  name: z.string().max(256).optional(),
  voice: z.boolean().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  contact_name: z.string().max(256).optional(),
});
export type SimFile = z.infer<typeof SimFileSchema>;

const base = { update_id: z.int().min(0) };

export const SimUpdateSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...base,
    type: z.literal('message'),
    chat: SimChatSchema,
    from: SimSenderSchema,
    message_id: z.string().min(1).max(128),
    at: z.string().min(1),
    text: z.string().optional(),
    entities: z
      .array(
        z.strictObject({
          type: z.enum(['bot_mention', 'command']),
          value: z.string().max(256),
          /**
           * How the command arrived, for a `command` entity.
           *
           * `06` §3.10 has two kinds — a registered slash command and a typed one — and the
           * envelope keeps them apart because the reply differs: a slash command can be answered
           * ephemerally and a typed one cannot. Carried on the entity rather than derived from
           * `capabilities.commands`, so one fixture corpus is valid for every profile and a
           * scenario can exercise both paths on a platform that has both.
           */
          source: z.enum(['slash', 'text']).optional(),
        }),
      )
      .optional(),
    reply_to: z
      .strictObject({
        message_id: z.string().min(1).max(128),
        from_is_bot: z.boolean().optional(),
      })
      .optional(),
    forward_from: z.string().max(256).optional(),
    forward_at: z.string().optional(),
    quoted_external: z.boolean().optional(),
    link_previews: z
      .array(
        z.strictObject({
          url: z.string().max(2048),
          title: z.string().max(512).optional(),
          description: z.string().max(2048).optional(),
        }),
      )
      .optional(),
    files: z.array(SimFileSchema).optional(),
    locale: z.string().max(32).optional(),
    timezone: z.string().max(64).optional(),
    late: z.boolean().optional(),
    truncated: z.boolean().optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal('callback'),
    chat: SimChatSchema,
    from: SimSenderSchema,
    callback_id: z.string().min(1).max(128),
    on_message_id: z.string().min(1).max(128),
    data: z.string().max(256),
    at: z.string().min(1),
  }),
  z.strictObject({
    ...base,
    type: z.literal('reaction'),
    chat: SimChatSchema,
    from: SimSenderSchema,
    on_message_id: z.string().min(1).max(128),
    emoji: z.string().min(1).max(64),
    removed: z.boolean().optional(),
    at: z.string().min(1),
  }),
  z.strictObject({
    ...base,
    type: z.literal('poll_vote'),
    chat: SimChatSchema,
    from: SimSenderSchema,
    poll_id: z.string().min(1).max(128),
    option_ids: z.array(z.int().min(0)),
    at: z.string().min(1),
  }),
  z.strictObject({
    ...base,
    type: z.literal('edit'),
    chat: SimChatSchema,
    message_id: z.string().min(1).max(128),
    text: z.string(),
    at: z.string().min(1),
  }),
  z.strictObject({
    ...base,
    type: z.literal('delete'),
    chat: SimChatSchema,
    message_ids: z.array(z.string().min(1).max(128)).min(1),
    at: z.string().min(1),
  }),
  z.strictObject({
    ...base,
    type: z.literal('membership'),
    chat: SimChatSchema,
    status: z.enum(['added', 'removed', 'banned', 'promoted', 'demoted', 'restricted']),
    by: z.string().max(128).optional(),
    start_payload: z.string().max(256).optional(),
    at: z.string().min(1),
  }),
  z.strictObject({
    ...base,
    type: z.literal('member'),
    chat: SimChatSchema,
    platform_user_id: z.string().min(1).max(128),
    name: z.string().max(256).optional(),
    joined: z.boolean(),
    at: z.string().min(1),
  }),
  z.strictObject({
    ...base,
    type: z.literal('user_updated'),
    platform_user_id: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    username: z.string().max(128).optional(),
    at: z.string().min(1),
  }),
  z.strictObject({
    ...base,
    type: z.literal('chat_updated'),
    chat: SimChatSchema,
    is_forum: z.boolean().optional(),
    encrypted: z.boolean().optional(),
    ext_shared: z.boolean().optional(),
    at: z.string().min(1),
  }),
  z.strictObject({
    ...base,
    type: z.literal('poll_updated'),
    chat: SimChatSchema,
    poll_id: z.string().min(1).max(128),
    on_message_id: z.string().min(1).max(128),
    counts: z.array(z.int().min(0)),
    total_voters: z.int().min(0),
    closed: z.boolean(),
    at: z.string().min(1),
  }),
  z.strictObject({
    ...base,
    type: z.literal('read_marker'),
    chat: SimChatSchema,
    platform_user_id: z.string().min(1).max(128),
    up_to_message_id: z.string().min(1).max(128),
    at: z.string().min(1),
  }),
  z.strictObject({
    ...base,
    type: z.literal('dm_blocked'),
    platform_user_id: z.string().min(1).max(128),
    blocked: z.boolean(),
    at: z.string().min(1),
  }),
]);
export type SimUpdate = z.infer<typeof SimUpdateSchema>;
export type SimUpdateType = SimUpdate['type'];

/**
 * The platform calls an adapter makes, by the name the conformance kit looks for.
 *
 * A closed list rather than free strings, because `06` §3.25's cases filter `outbound()` by
 * `call.method` — so a typo in a name is a case that silently observes nothing and passes. The kit
 * cannot check the spelling for an adapter; a union here can.
 */
export const SIM_CALLS = [
  'sendMessage',
  'editMessage',
  'deleteMessage',
  'react',
  'unreact',
  'createPoll',
  'closePoll',
  'setTyping',
  'getFile',
  'listMembers',
  'probe',
  'openDm',
  'leave',
  'verifyDelivery',
  'answerInteraction',
  'describeSelf',
  'describeUser',
  'ackUpdate',
  'ackCallback',
] as const;
export type SimCall = (typeof SIM_CALLS)[number];

/**
 * A record/replay line (`06` §3.21.7's "JSONL of inbound and outbound events").
 *
 * Inbound carries the update as the platform produced it; outbound carries the call the adapter
 * made. Both are needed for a regression scenario to be a regression scenario: replaying only the
 * inbound half reproduces the stimulus, and the outbound half is what a diff is taken against.
 */
export const SimRecordLineSchema = z.discriminatedUnion('dir', [
  z.strictObject({
    dir: z.literal('in'),
    seq: z.int().min(0),
    atMs: z.int(),
    update: SimUpdateSchema,
  }),
  z.strictObject({
    dir: z.literal('out'),
    seq: z.int().min(0),
    atMs: z.int(),
    method: z.enum(SIM_CALLS),
    args: z.unknown(),
    failed: z.string().max(64).optional(),
  }),
]);
export type SimRecordLine = z.infer<typeof SimRecordLineSchema>;
