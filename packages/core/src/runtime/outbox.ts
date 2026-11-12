/**
 * The outbound payload and the outbox row (`02` §3.3.7, §3.9; `06` §8).
 */
import type {
  ConversationId,
  GroupId,
  LabelId,
  OutboxId,
  ReaderSetId,
  TurnId,
  z,
} from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { ErrorInfo } from '../domain/error-info.js';
import { jsonObjectShape, storageContract } from '../domain/storage-contract.js';
import type { OutboxParts } from './turns.js';

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

/** `02` §3.3.9 pins the shape; `M3`'s channel SDK owns what is inside it. */
type OutboundPayload = z.infer<typeof OutboundPayloadSchema>;

/* ──────────────────────── The outbox aggregate (`02` §3.3.7, §3.9) ──────────────────────── */

/** `02` §3.3.7's `outbox_messages.message_class` (`01` §14 A24). */
export const MESSAGE_CLASSES = ['reply', 'requested', 'digest', 'proactive', 'system'] as const;
export type MessageClass = (typeof MESSAGE_CLASSES)[number];

export const SEND_PRIORITIES = ['interactive', 'scheduled', 'background'] as const;
export type SendPriority = (typeof SEND_PRIORITIES)[number];

/** What to do when a send is late: `must_deliver` never expires, `best_effort` is dropped. */
export const EXPIRY_CLASSES = ['must_deliver', 'timely', 'best_effort'] as const;
export type ExpiryClass = (typeof EXPIRY_CLASSES)[number];

/** `02` §3.9's state machine. `sending` is `06`'s `in_flight`. */
export const OUTBOX_STATUSES = [
  'pending',
  'sending',
  'sent',
  'dead',
  'cancelled',
  'expired',
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

/**
 * One queued outbound message (`02` §3.3.7, §3.9).
 *
 * The state machine and the dispatcher are `M1-T22`'s; this is the row and the **enqueue** half,
 * which `02` §3.8 needs here: `TurnJournal.recover` inserts the recovery summary, acks the effects
 * and marks the turn `recovered` in one transaction, and splitting that would let recovery
 * acknowledge effects that nobody will ever be told about.
 *
 * `guardRef` is `NOT NULL` with a length check, which is invariant **I5** at the column: there is
 * no way to represent a send that was never guarded.
 */
export interface OutboxMessage {
  readonly id: OutboxId;
  readonly groupId: GroupId | undefined;
  readonly conversationId: ConversationId;
  readonly turnId: TurnId | undefined;
  /** Monotonic per conversation: the FIFO order sends must respect. */
  readonly seq: number;
  /** I6 for sends: `'<turnId>:<index>'` | `'<turnId>:ph'` | `'rem:<id>:<occurrenceKey>'` | … */
  readonly idempotencyKey: string;
  readonly messageClass: MessageClass;
  readonly priority: SendPriority;
  readonly expiryClass: ExpiryClass;
  readonly payload: OutboundPayload;
  readonly parts: OutboxParts;
  /** sha256 of the normalised rendered text: Q-OBX-3's near-duplicate suppression. */
  readonly contentHash: Uint8Array;
  readonly audienceReaderSetId: ReaderSetId;
  readonly labelId: LabelId | undefined;
  /** I5: the id of the `DisclosureGuard` pass record in the trace (`05`'s `guardRecordId`). */
  readonly guardRef: string;
  /** `03` §3.4.7's send-time re-check: the labels the rendered text drew on. */
  readonly manifestLabelIds: readonly LabelId[];
  readonly status: OutboxStatus;
  /** `06`'s `possibleDuplicate`: the send timed out and delivery is unknown. */
  readonly maybeSent: boolean;
  readonly inFlightSince: Temporal.Instant | undefined;
  readonly attempts: number;
  readonly nextAttemptAt: Temporal.Instant;
  readonly leaseUntil: Temporal.Instant | undefined;
  readonly platformMessageId: string | undefined;
  readonly lastError: ErrorInfo | undefined;
  readonly createdAt: Temporal.Instant;
  readonly sentAt: Temporal.Instant | undefined;
}

/**
 * What a caller supplies to enqueue a send.
 *
 * `seq` is absent: `02` §3.9 computes it as `coalesce(max(seq), 0) + 1` per conversation **inside**
 * the write transaction, which is the only place it can be computed without two concurrent turns
 * claiming the same position in a FIFO.
 */
export interface NewOutboxMessage {
  readonly id: OutboxId;
  readonly groupId?: GroupId | undefined;
  readonly conversationId: ConversationId;
  readonly turnId?: TurnId | undefined;
  readonly idempotencyKey: string;
  readonly messageClass: MessageClass;
  readonly priority?: SendPriority | undefined;
  readonly expiryClass?: ExpiryClass | undefined;
  readonly payload: OutboundPayload;
  readonly contentHash: Uint8Array;
  readonly audienceReaderSetId: ReaderSetId;
  readonly labelId?: LabelId | undefined;
  readonly guardRef: string;
  readonly manifestLabelIds: readonly LabelId[];
  readonly nextAttemptAt: Temporal.Instant;
}
