/**
 * The memory repository port (`02` §3.7.1, §3.3.4; semantics in `04`).
 *
 * `02` §3.7.1 gives this port as its worked example, and the four methods it lists are the four
 * here. What the example does not say, and what shapes every signature below, is that **content is
 * immutable** (`01` §5, enforced by `trg_memory_items_immutable`): there is no `update`. A
 * correction is `supersede`, which writes a new item and points the old one at it.
 *
 * ## The label may only narrow
 *
 * `03` D17 and `04` D2: `memory_items.label_id` "may only be re-pointed to a NARROWER label". So
 * `narrowLabel` is named for what it does rather than `setLabel`, and the repository refuses a
 * widening — a memory extracted from a private exchange cannot become group-readable by a later
 * write, which would be `I1` failing by accident rather than by attack.
 *
 * ## Retrieval state is never a parameter
 *
 * `02` §3.3.4 makes the column the repository's to maintain, derived by
 * `retrievalStateFor`. Accepting it would let a caller make a superseded item answer as current.
 */
import type { GroupId, MemoryId } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { EligibleLabelSet, Label } from '../../../ifc/eligible.js';
import type {
  MemoryItem,
  MemorySource,
  MemoryStatus,
  MemorySubject,
  NewMemoryItem,
  RetractReason,
} from '../../../memory/item.js';
import type { TxToken, WriteResult } from '../uow.js';

export interface MemoryReader {
  /** One item, by id, scoped to its group (`I4`). Unfiltered by label: see the note on `byId`. */
  byId(groupId: GroupId, id: MemoryId, eligible: EligibleLabelSet): MemoryItem | undefined;
  /**
   * Q-MEM-2: an item with this exact fingerprint, for `04` §3.3.11's duplicate check.
   *
   * Returns the item rather than a boolean, because the caller's next act is to *confirm* the
   * existing memory — bump `last_confirmed_at` — rather than to insert a second copy, and it needs
   * the row to do that.
   *
   * **Not label-filtered**, and that is deliberate: the duplicate check asks "does this group
   * already hold this fact", which is a question about the group's store and not about an
   * audience. Filtering it would let the same fact be extracted twice under two labels, which is
   * the duplication the fingerprint index exists to prevent. The caller never shows the result; it
   * only decides whether to write.
   */
  byFingerprint(groupId: GroupId, fingerprint: Uint8Array): MemoryItem | undefined;
  /** Q-MEM-1: the supersede chain from an item, newest first. */
  supersedeChain(groupId: GroupId, id: MemoryId, eligible: EligibleLabelSet): readonly MemoryItem[];
  /** The subjects of an item (`02` §3.3.4). */
  subjectsOf(groupId: GroupId, id: MemoryId): readonly MemorySubject[];
  /** The sources of an item (`04` R13). */
  sourcesOf(groupId: GroupId, id: MemoryId): readonly MemorySource[];
  /** Q-JOB-6: non-retracted items awaiting an embedding, oldest first. */
  embeddingBacklog(groupId: GroupId, limit: number): readonly MemoryItem[];
}

export interface MemoryRepository {
  /**
   * Insert an item, interning its label and writing its subjects and sources.
   *
   * `fingerprint` is supplied rather than derived here, because `04` §3.3.11 owns the derivation —
   * but it is a required parameter rather than part of `NewMemoryItem`, so the call site shows
   * that a fingerprint was computed and did not default to something.
   *
   * Returns `duplicate` with the existing id when Q-MEM-2's `(group, fingerprint)` already holds
   * one, which is `04`'s exact-duplicate case and is routine rather than an error.
   */
  insert(
    uow: TxToken,
    item: NewMemoryItem,
    label: Label,
    fingerprint: Uint8Array,
  ): WriteResult<MemoryItem>;
  /**
   * Move an item's status, maintaining the retrieval state and the vec row.
   *
   * `validTo` is here because a status change and a validity change arrive together in `04`'s
   * lifecycle: an item is activated *until* a date, or archived *because* a date passed. Two calls
   * would leave a window in which the retrieval state was derived from half the change.
   */
  setStatus(
    uow: TxToken,
    groupId: GroupId,
    id: MemoryId,
    expectVersion: number,
    status: MemoryStatus,
    options?: {
      readonly validTo?: Temporal.Instant | null | undefined;
      readonly archivedAt?: Temporal.Instant | null | undefined;
      readonly retractReason?: RetractReason | undefined;
    },
  ): WriteResult<MemoryItem>;
  /**
   * Replace an item with a new one, in one transaction.
   *
   * The old row becomes `superseded` with `superseded_by_id` set and the new row carries
   * `supersedes_id` — both, so the chain can be walked from either end. `02` §3.3.4 gives
   * `supersedes_id` a foreign key with `ON DELETE SET NULL` and `superseded_by_id` none, because
   * the forward pointer must survive the old row being purged.
   */
  supersede(
    uow: TxToken,
    groupId: GroupId,
    oldId: MemoryId,
    expectVersion: number,
    next: NewMemoryItem,
    label: Label,
    fingerprint: Uint8Array,
  ): WriteResult<MemoryItem>;
  /**
   * Narrow an item's label (`03` D17, `04` D2).
   *
   * Refuses a widening. The caller supplies the audience the new label must be contained in, so
   * the check is `core`'s own containment rather than a second implementation here — this
   * repository does not get to decide what "narrower" means.
   */
  narrowLabel(
    uow: TxToken,
    groupId: GroupId,
    id: MemoryId,
    expectVersion: number,
    label: Label,
  ): WriteResult<MemoryItem>;
  /** `04` R9: retract and record a content-free tombstone. */
  forget(
    uow: TxToken,
    groupId: GroupId,
    id: MemoryId,
    reason: RetractReason,
    at: Temporal.Instant,
  ): WriteResult<void>;
  /** Pin or unpin (Q-MEM-3: the group-layer core). */
  setPinned(
    uow: TxToken,
    groupId: GroupId,
    id: MemoryId,
    expectVersion: number,
    pinned: boolean,
  ): WriteResult<MemoryItem>;
  /** `04` R13: record that an item was retrieved, for the access stats. */
  recordRetrieval(uow: TxToken, rids: readonly number[], at: Temporal.Instant): void;
  /** Append sources to an existing item (`04` R13: append-only). */
  addSources(
    uow: TxToken,
    groupId: GroupId,
    id: MemoryId,
    sources: readonly Omit<MemorySource, 'addedAt'>[],
  ): WriteResult<MemoryItem>;
  /** Move an item's embedding state (the `embed.items` job, `02` §3.5). */
  setEmbeddingState(
    uow: TxToken,
    groupId: GroupId,
    id: MemoryId,
    state: MemoryItem['embeddingState'],
  ): WriteResult<MemoryItem>;
}
