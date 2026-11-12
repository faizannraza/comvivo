/**
 * The two message-content JSON shapes `02` §3.3.3 stores (`06` §8, §3.8).
 *
 * Both are owned by `06` and both are columns, which is why they live in `core`: `packages/storage`
 * may depend on `core` but never on a channel package (`01` §4 as amended by A11).
 */
import { capped, z } from '@comvivo/shared';
import type { ChannelId } from './channel.js';
import { channelIdSchema } from './channel.js';

// --- ForwardInfo ---------------------------------------------------------------------------------

/**
 * Where a forwarded message came from (`06` §1351).
 *
 * Both fields are optional because platforms differ in what they disclose: Telegram gives the
 * original sender's name unless they have forward privacy on, Discord's message snapshots give the
 * original timestamp, and Signal gives neither. A present-but-empty `forwarded` object is still
 * meaningful — it is how ingestion records "this is a forward, origin unknown", which is what sets
 * `messages.untrusted` (`06` §139, step 2.4 of the spine).
 *
 * `originalSentAt` is kept as the ISO string the platform sent rather than an instant, because a
 * platform may give a date with no time, or a time with no zone, and normalising would invent
 * precision. It is display provenance, never something scheduling reads.
 */
export interface ForwardInfo {
  fromName?: string | undefined;
  originalSentAt?: string | undefined;
}

/** `02` §3.3.9: `messages.forwarded` is capped at 1 KiB. */
export const FORWARD_INFO_MAX_BYTES = 1024;

export const ForwardInfoSchema = capped(
  z.object({
    fromName: z.string().max(256).optional(),
    originalSentAt: z.string().max(64).optional(),
  }),
  FORWARD_INFO_MAX_BYTES,
  'forward info',
);

// --- AttachmentRef -------------------------------------------------------------------------------

/**
 * An opaque, adapter-specific handle for fetching an attachment later (`06` §1327, §3.8).
 *
 * `data` is `Record<string, unknown>` by design, not by omission. `06` §408 lists what each
 * platform puts there — a Telegram `file_id`, Discord's `{channelId, messageId, attachmentId,
 * url}`, Slack's `url_private_download`, Matrix's `mxc` plus an `EncryptedFile`, a Signal
 * attachment `id` — and says each adapter zod-validates its own shape. A union of five adapter
 * shapes here would have to change every time a plugin adds a channel (`10` §3), and would put
 * `core` in the business of knowing how Matrix encrypts a file.
 *
 * What this schema *does* guarantee is the part the storage layer and the `attachment.fetch` job
 * depend on: there is a `channel`, so the job knows which adapter to hand the ref back to, and the
 * payload is JSON of bounded size. The adapter re-validates `data` when it receives it
 * (`06` §3.8), which is the boundary that can actually judge it.
 *
 * Matrix's variant contains a decryption key, which is why `02` §3.3.3 notes this column is
 * encrypted with the database: the keyfile (`08` §3.7) is what protects it at rest.
 */
export interface AttachmentRef {
  channel: ChannelId;
  data: Readonly<Record<string, unknown>>;
}

/** `02` §3.3.9: `message_attachments.platform_ref` is capped at 2 KiB. */
export const ATTACHMENT_REF_MAX_BYTES = 2 * 1024;

export const AttachmentRefSchema = capped(
  z.object({ channel: channelIdSchema, data: z.record(z.string(), z.unknown()) }),
  ATTACHMENT_REF_MAX_BYTES,
  'attachment ref',
);
