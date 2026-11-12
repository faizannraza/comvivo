/**
 * The list repository (`02` §3.7.1, §3.3.5; semantics in `07`).
 *
 * ## `position` is text, and that is what makes reordering cheap
 *
 * `02` §3.3.5 makes `list_items.position` a `text` column, so `07` reorders by inserting a
 * **fractional index** between two neighbours: "move this above that" is one row update instead of
 * renumbering everything after it. `midpoint` below is that arithmetic, and `appendAfter` is the
 * common case.
 *
 * ## The default list is what makes "add milk" work
 *
 * `lists_default_kind_uq` allows at most one default per `(group, kind)`, so "add milk" has exactly
 * one answer. A group with two default grocery lists would have to be asked every time, which is
 * the friction the default exists to remove — so `setDefault` demotes the incumbent first, in the
 * same transaction, for the same reason `setPrimary` does on conversations.
 */
import type {
  EligibleLabelSet,
  Label,
  List,
  ListItem,
  ListReader,
  ListRepository,
  NewList,
  NewListItem,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import { duplicate, notFound, writeConflict, writeOk } from '@comvivo/core';
import {
  type GroupId,
  type ListId,
  type ListItemId,
  type MemberId,
  StorageError,
} from '@comvivo/shared';
import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import { type Db, exactlyOne, maybeOne, type Patch } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import type { LabelStore } from '../ifc/label-store.js';
import { listItems, lists } from '../schema/index.js';
import { toList, toListItem } from './rows.js';

/**
 * The alphabet a fractional index is written in.
 *
 * Base-62, ordered so a plain string comparison is the sort order — which is the whole point: the
 * database sorts with `ORDER BY position` and knows nothing about the scheme.
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * The position of the first item on an empty list.
 *
 * **Derived from `midpoint`** rather than written out, so there is one source of truth: a literal
 * here that disagreed with the arithmetic would put the first item somewhere inserts do not expect,
 * and the symptom is a list whose first "move to top" lands below it. `midpoint` is a function
 * declaration, so it is hoisted and this is safe at module scope.
 */
export const FIRST_POSITION = midpoint(undefined, undefined);

/**
 * The next position **after** `last`, for an append.
 *
 * Deliberately not `midpoint(last, undefined)`, and the difference is not cosmetic: midpoint
 * against an open upper end converges on the largest digit, so each append halves the remaining
 * gap and the string grows a character every few items. Measured at `M1-T19`: 400 appends produced
 * a 66-character position and tripped `midpoint`'s own subdivision bound — on a plain shopping
 * list, doing nothing unusual.
 *
 * Incrementing instead grows one character per 31 appends at each level, because there is nothing
 * after the last item to stay below. Subdivision is for inserting *between* two items, which is
 * the case that genuinely needs it.
 */
export function after(last: string): string {
  // The last character that can be incremented, with everything after it dropped — there is
  // nothing above `last`, so a shorter string is safe as long as it is greater.
  for (let index = last.length - 1; index >= 0; index -= 1) {
    const digit = DIGITS.indexOf(last[index] ?? '0');
    if (digit < DIGITS.length - 1) {
      return last.slice(0, index) + (DIGITS[digit + 1] ?? '0');
    }
  }
  // Every digit is the largest one, so extend: `'zz'` → `'zz' + mid`, which is greater than `'zz'`
  // because it is longer with the same prefix.
  return last + FIRST_POSITION;
}

/**
 * A position strictly between `left` and `right`, as a string that sorts between them.
 *
 * `undefined` for either end means "no neighbour on that side". The algorithm walks both strings
 * digit by digit and, at the first place they differ by more than one, picks the midpoint —
 * otherwise it extends, which is why the strings grow slowly rather than all at once.
 *
 * Exported because `07`'s reorder needs the same arithmetic and a second implementation would
 * eventually disagree about the ordering of a list somebody is looking at.
 */
export function midpoint(left: string | undefined, right: string | undefined): string {
  const lower = left ?? '';
  const upper = right;
  let prefix = '';
  let index = 0;
  for (;;) {
    const lowDigit = index < lower.length ? DIGITS.indexOf(lower[index] ?? '0') : -1;
    const highDigit =
      upper !== undefined && index < upper.length
        ? DIGITS.indexOf(upper[index] ?? '0')
        : DIGITS.length;
    if (highDigit - lowDigit > 1) {
      // Room between them: take the midpoint and stop.
      const mid = Math.floor((lowDigit + highDigit) / 2);
      // `?? '0'` only satisfies `noUncheckedIndexedAccess`: `mid` is between two indices
      // that are both in range, so the lookup cannot miss.
      return prefix + (DIGITS[mid] ?? '0');
    }
    // No room at this place, so keep the lower digit and look one place deeper. `lowDigit` of -1
    // means `lower` ran out, and the digit to carry is the smallest one.
    prefix += DIGITS[Math.max(lowDigit, 0)] ?? '0';
    index += 1;
    if (index > 64) {
      // A list reordered pathologically many times in the same gap. Bounded rather than
      // unbounded, because an unbounded loop here would hang a turn.
      //
      // 64 characters is about 2^64 subdivisions of one gap, so reaching it means something is
      // wrong rather than that somebody reordered a list a lot. An earlier version reached it by
      // **appending** 400 items, which is why `after` exists.
      throw new StorageError('STORAGE_IO', 'a list position could not be subdivided further', {
        hint: 'This list has been reordered in one gap thousands of times; recompact its positions.',
        category: 'bug',
      });
    }
  }
}

export class SqliteListRepository implements ListReader, ListRepository {
  readonly #db: Db;
  readonly #labels: LabelStore;

  constructor(db: Db, labels: LabelStore) {
    this.#db = db;
    this.#labels = labels;
  }

  byId(groupId: GroupId, id: ListId, eligible: EligibleLabelSet): List | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(lists)
        .where(and(eq(lists.groupId, groupId), eq(lists.id, id), listEligible(eligible))),
    );
    return row === undefined ? undefined : toList(row);
  }

  /** Through `lists_default_kind_uq`: the list `07` adds to when nobody named one. */
  defaultFor(groupId: GroupId, kind: List['kind'], eligible: EligibleLabelSet): List | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(lists)
        .where(
          and(
            eq(lists.groupId, groupId),
            eq(lists.kind, kind),
            eq(lists.isDefault, true),
            isNull(lists.archivedAt),
            listEligible(eligible),
          ),
        ),
    );
    return row === undefined ? undefined : toList(row);
  }

  active(groupId: GroupId, eligible: EligibleLabelSet): readonly List[] {
    if (eligible.ids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(lists)
      .where(and(eq(lists.groupId, groupId), isNull(lists.archivedAt), listEligible(eligible)))
      .orderBy(desc(lists.isDefault), asc(lists.name))
      .all();
    return rows.map(toList);
  }

  /**
   * Q-COO-3, through `list_items_list_idx` on `(list_id, checked, position)`.
   *
   * **Unchecked first, then by position**, which is the index's own order — so the common render
   * needs no sort. `includeChecked` defaults to false because a grocery list in a shop shows what
   * is left, and the checked items are history until somebody asks.
   */
  itemsOf(query: {
    readonly groupId: GroupId;
    readonly listId: ListId;
    readonly includeChecked?: boolean | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly ListItem[] {
    if (query.eligible.ids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(listItems)
      .where(
        and(
          eq(listItems.groupId, query.groupId),
          eq(listItems.listId, query.listId),
          ...(query.includeChecked === true ? [] : [eq(listItems.checked, false)]),
          itemEligible(query.eligible),
        ),
      )
      .orderBy(asc(listItems.checked), asc(listItems.position))
      .limit(query.limit)
      .all();
    return rows.map(toListItem);
  }

  /**
   * An existing item with the same normalised key, through `list_items_key_idx`.
   *
   * **Not label-filtered**: this asks "is this already on the list", which is a question about the
   * list rather than about an audience. Filtering it would let "milk" be added twice under two
   * labels, which is the duplication `07`'s add path uses this to prevent — and the caller never
   * renders the result, it only decides whether to add or to bump the quantity.
   *
   * Unchecked items only. A checked "milk" is last week's shopping, and refusing to add milk
   * because it was bought once would be the wrong answer.
   */
  itemByKey(groupId: GroupId, listId: ListId, normalizedKey: string): ListItem | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(listItems)
        .where(
          and(
            eq(listItems.groupId, groupId),
            eq(listItems.listId, listId),
            eq(listItems.normalizedKey, normalizedKey),
            eq(listItems.checked, false),
          ),
        )
        .orderBy(asc(listItems.position)),
    );
    return row === undefined ? undefined : toListItem(row);
  }

  create(uow: TxToken, list: NewList, label: Label): WriteResult<List> {
    if (label.groupId !== list.groupId) throw crossGroup('list');
    const labelId = this.#labels.intern(uow, label);
    const wantsDefault = list.isDefault ?? false;
    // Demote first, then insert: `lists_default_kind_uq` is a partial unique index evaluated per
    // statement, so the other order fails on the second row.
    if (wantsDefault) this.#demoteDefault(uow, list.groupId, list.kind ?? 'generic');
    try {
      const row = exactlyOne(
        this.#db
          .insert(lists)
          .values({
            id: list.id,
            groupId: list.groupId,
            name: list.name,
            kind: list.kind ?? 'generic',
            isDefault: wantsDefault,
            categoriesEnabled: list.categoriesEnabled ?? true,
            planId: list.planId,
            labelId,
            createdByMemberId: list.createdByMemberId,
            createdAt: uow.now,
            updatedAt: uow.now,
          })
          .returning(),
        'the list',
      );
      return writeOk(toList(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // `lists_group_name_uq` is on `(group, lower(name))`, so a second "Groceries" collides —
      // which is the routine case when two members create the same list at once.
      const existing = maybeOne(
        this.#db
          .select({ id: lists.id })
          .from(lists)
          .where(
            and(eq(lists.groupId, list.groupId), sql`lower(${lists.name}) = lower(${list.name})`),
          ),
      );
      return duplicate(existing?.id ?? list.id);
    }
  }

  addItem(uow: TxToken, item: NewListItem, label: Label): WriteResult<ListItem> {
    if (label.groupId !== item.groupId) throw crossGroup('list item');
    // The list has to be in this group, or a caller could add to another group's list by id.
    const list = maybeOne(
      this.#db
        .select({ id: lists.id })
        .from(lists)
        .where(and(eq(lists.groupId, item.groupId), eq(lists.id, item.listId))),
    );
    if (list === undefined) return notFound();

    const labelId = this.#labels.intern(uow, label);
    const position = item.position ?? this.#appendPosition(item.listId);
    try {
      const row = exactlyOne(
        this.#db
          .insert(listItems)
          .values({
            id: item.id,
            listId: item.listId,
            groupId: item.groupId,
            text: item.text,
            normalizedKey: item.normalizedKey,
            quantity: item.quantity,
            category: item.category,
            note: item.note,
            addedByMemberId: item.addedByMemberId,
            addedVia: item.addedVia ?? 'explicit',
            sourceMessageId: item.sourceMessageId,
            position,
            labelId,
            createdAt: uow.now,
            updatedAt: uow.now,
          })
          .returning(),
        'the list item',
      );
      return writeOk(toListItem(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return duplicate(item.id);
    }
  }

  setChecked(
    uow: TxToken,
    groupId: GroupId,
    id: ListItemId,
    expectVersion: number,
    checked: {
      readonly checked: boolean;
      readonly memberId: MemberId;
      readonly at: Temporal.Instant;
    },
  ): WriteResult<ListItem> {
    // Unchecking clears **both** the member and the time: a stale `checkedBy` on an unchecked item
    // would attribute a check that was undone, and `07` renders "checked by Ana" from it.
    return this.#versionedItemUpdate(uow, groupId, id, expectVersion, {
      checked: checked.checked,
      checkedByMemberId: checked.checked ? checked.memberId : null,
      checkedAt: checked.checked ? checked.at : null,
    });
  }

  moveItem(
    uow: TxToken,
    groupId: GroupId,
    id: ListItemId,
    expectVersion: number,
    position: string,
  ): WriteResult<ListItem> {
    return this.#versionedItemUpdate(uow, groupId, id, expectVersion, { position });
  }

  /**
   * Remove an item.
   *
   * A real delete, unlike a message or a memory: a list item is a working note rather than a
   * record of what was said, so `02` §3.13's "keep the row" reasoning does not apply — and a
   * shopping list that accumulated tombstones would grow without bound.
   */
  removeItem(_uow: TxToken, groupId: GroupId, id: ListItemId): WriteResult<void> {
    const removed = this.#db
      .delete(listItems)
      .where(and(eq(listItems.groupId, groupId), eq(listItems.id, id)))
      .returning({ id: listItems.id })
      .all();
    return removed.length === 0 ? notFound() : writeOk(undefined);
  }

  archive(
    uow: TxToken,
    groupId: GroupId,
    id: ListId,
    expectVersion: number,
    at: Temporal.Instant,
  ): WriteResult<List> {
    // An archived list cannot stay the default: "add milk" would resolve to a list nobody sees.
    return this.#versionedListUpdate(uow, groupId, id, expectVersion, {
      archivedAt: at,
      isDefault: false,
    });
  }

  /**
   * Make this the default for its kind, demoting the incumbent.
   *
   * Not on the port yet — `07` owns when a list becomes the default, and this is the storage
   * primitive it will call. Exposed because `create` needs it and a caller that set `is_default`
   * through `create` on an existing list could not otherwise move it.
   */
  setDefault(uow: TxToken, groupId: GroupId, id: ListId, expectVersion: number): WriteResult<List> {
    const current = maybeOne(
      this.#db
        .select()
        .from(lists)
        .where(and(eq(lists.groupId, groupId), eq(lists.id, id))),
    );
    if (current === undefined) return notFound();
    if (current.archivedAt !== null) {
      throw new StorageError('STORAGE_CONSTRAINT', 'an archived list cannot be the default', {
        hint: 'Unarchive it first: a default nobody sees makes "add milk" resolve to nothing.',
        category: 'bug',
      });
    }
    this.#demoteDefault(uow, groupId, current.kind);
    return this.#versionedListUpdate(uow, groupId, id, expectVersion, { isDefault: true });
  }

  #demoteDefault(uow: TxToken, groupId: GroupId, kind: List['kind']): void {
    this.#db
      .update(lists)
      .set({ isDefault: false, updatedAt: uow.now })
      .where(and(eq(lists.groupId, groupId), eq(lists.kind, kind), eq(lists.isDefault, true)))
      .run();
  }

  /** The position after the last item, so an add appends. */
  #appendPosition(listId: ListId): string {
    const last = maybeOne(
      this.#db
        .select({ position: listItems.position })
        .from(listItems)
        .where(eq(listItems.listId, listId))
        .orderBy(desc(listItems.position)),
    );
    return last === undefined ? FIRST_POSITION : after(last.position);
  }

  #versionedListUpdate(
    uow: TxToken,
    groupId: GroupId,
    id: ListId,
    expectVersion: number,
    patch: Patch<typeof lists.$inferInsert>,
  ): WriteResult<List> {
    const row = maybeOne(
      this.#db
        .update(lists)
        .set({ ...patch, updatedAt: uow.now, version: expectVersion + 1 })
        .where(and(eq(lists.groupId, groupId), eq(lists.id, id), eq(lists.version, expectVersion)))
        .returning(),
    );
    if (row !== undefined) return writeOk(toList(row));
    const exists = maybeOne(
      this.#db
        .select({ id: lists.id })
        .from(lists)
        .where(and(eq(lists.groupId, groupId), eq(lists.id, id))),
    );
    return exists === undefined ? notFound() : writeConflict();
  }

  #versionedItemUpdate(
    uow: TxToken,
    groupId: GroupId,
    id: ListItemId,
    expectVersion: number,
    patch: Patch<typeof listItems.$inferInsert>,
  ): WriteResult<ListItem> {
    const row = maybeOne(
      this.#db
        .update(listItems)
        .set({ ...patch, updatedAt: uow.now, version: expectVersion + 1 })
        .where(
          and(
            eq(listItems.groupId, groupId),
            eq(listItems.id, id),
            eq(listItems.version, expectVersion),
          ),
        )
        .returning(),
    );
    if (row !== undefined) return writeOk(toListItem(row));
    const exists = maybeOne(
      this.#db
        .select({ id: listItems.id })
        .from(listItems)
        .where(and(eq(listItems.groupId, groupId), eq(listItems.id, id))),
    );
    return exists === undefined ? notFound() : writeConflict();
  }
}

function listEligible(eligible: EligibleLabelSet): SQL {
  if (eligible.ids.length === 0) return sql`1 = 0`;
  return inArray(lists.labelId, [...eligible.ids]);
}

function itemEligible(eligible: EligibleLabelSet): SQL {
  if (eligible.ids.length === 0) return sql`1 = 0`;
  return inArray(listItems.labelId, [...eligible.ids]);
}

function crossGroup(what: string): StorageError {
  return new StorageError('STORAGE_CONSTRAINT', `the ${what} names a label of another group`, {
    hint: `This is a bug and an I4 violation: intern the label against the ${what}'s own group.`,
    category: 'bug',
  });
}
