/**
 * Lists and list items (`02` §3.3.5; semantics in `07`).
 */
import type {
  GroupId,
  LabelId,
  ListId,
  ListItemId,
  MemberId,
  MessageId,
  PlanId,
} from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';

/** `02` §3.3.5's `lists.kind`. `07` renders a grocery list differently from a packing list. */
export const LIST_KINDS = ['grocery', 'packing', 'to_buy', 'generic'] as const;
export type ListKind = (typeof LIST_KINDS)[number];

/** `02` §3.3.5's `list_items.added_via` (`07`: how it got on the list). */
export const ADDED_VIA = ['explicit', 'auto_capture', 'button'] as const;
export type AddedVia = (typeof ADDED_VIA)[number];

/** A list (`02` §3.3.5). */
export interface List {
  readonly id: ListId;
  readonly groupId: GroupId;
  readonly name: string;
  readonly kind: ListKind;
  /**
   * The list `07` adds to when nobody named one.
   *
   * At most one per `(group, kind)` — `lists_default_kind_uq` — so "add milk" has exactly one
   * answer. A group with two default grocery lists would have to ask every time, which is the
   * friction the default exists to remove.
   */
  readonly isDefault: boolean;
  readonly categoriesEnabled: boolean;
  readonly planId: PlanId | undefined;
  readonly labelId: LabelId;
  readonly createdByMemberId: MemberId | undefined;
  readonly archivedAt: Temporal.Instant | undefined;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

export interface NewList {
  readonly id: ListId;
  readonly groupId: GroupId;
  readonly name: string;
  readonly kind?: ListKind | undefined;
  readonly isDefault?: boolean | undefined;
  readonly categoriesEnabled?: boolean | undefined;
  readonly planId?: PlanId | undefined;
  readonly createdByMemberId?: MemberId | undefined;
}

/**
 * One item on a list (`02` §3.3.5).
 *
 * `position` is **text**, not a number: `07` reorders by inserting between neighbours, and a
 * fractional-index string lets "move this above that" be one row update instead of renumbering
 * everything after it. `normalizedKey` is what `list_items_key_idx` dedupes on, so "2 pints milk"
 * and "milk" collapse.
 */
export interface ListItem {
  readonly rid: number;
  readonly id: ListItemId;
  readonly listId: ListId;
  readonly groupId: GroupId;
  readonly text: string;
  readonly normalizedKey: string;
  readonly quantity: string | undefined;
  readonly category: string | undefined;
  readonly note: string | undefined;
  readonly checked: boolean;
  readonly checkedByMemberId: MemberId | undefined;
  readonly checkedAt: Temporal.Instant | undefined;
  readonly addedByMemberId: MemberId | undefined;
  readonly addedVia: AddedVia;
  readonly sourceMessageId: MessageId | undefined;
  readonly position: string;
  readonly labelId: LabelId;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

export interface NewListItem {
  readonly id: ListItemId;
  readonly listId: ListId;
  readonly groupId: GroupId;
  readonly text: string;
  /** `07` normalises; the repository stores. Supplied so one normaliser serves the dedupe and the UI. */
  readonly normalizedKey: string;
  readonly quantity?: string | undefined;
  readonly category?: string | undefined;
  readonly note?: string | undefined;
  readonly addedByMemberId?: MemberId | undefined;
  readonly addedVia?: AddedVia | undefined;
  readonly sourceMessageId?: MessageId | undefined;
  /** Omitted appends to the end; the repository picks the next position. */
  readonly position?: string | undefined;
}
