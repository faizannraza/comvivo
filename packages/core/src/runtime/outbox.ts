/**
 * The outbound payload (`02` §3.3.7; `06` §8).
 */
import { jsonObjectShape, storageContract } from '../domain/storage-contract.js';

/**
 * `outbox_messages.payload` — a **storage contract**.
 *
 * `06` §1395's `OutboundMessage` is fully specified, but its closure is not: it carries
 * `ResolvedMention`, `ActionRow`, `OutboundAttachment` and `SentPart`, all of which are the
 * channel SDK's to define in `M3`. Transcribing the outer object while leaving four member types
 * undefined would produce a schema that validates less than this one honestly claims to.
 *
 * Pinned and enforced now: a JSON object capped at 64 KiB (`02` §3.3.9). The two fields the
 * storage layer itself depends on — `message_class` and the idempotency key — are **columns**, not
 * payload fields, precisely so the outbox state machine never has to parse this blob to do its
 * job (`02` §3.9).
 */
export const OutboundPayloadSchema = storageContract(
  'OutboundPayloadSchema',
  jsonObjectShape,
  'outbound payload',
);
