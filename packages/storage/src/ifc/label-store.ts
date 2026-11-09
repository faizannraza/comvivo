/**
 * Interning labels and reader sets (`02` §3.2 D4).
 *
 * A label is a value, not an entity: two data labelled "readable by Ana and Ben, personal, not
 * untrusted" carry the *same* label. So the table holds one row per distinct value per group,
 * found by `canonical_key` and created on first use — which is what makes `label_id` a 4-byte
 * integer on every labeled row instead of a 30-character TypeID, and therefore what makes the
 * eligibility filter's index fit in the page cache.
 *
 * ## Why the caches are filled in `afterCommit` and nowhere else
 *
 * `02` §3.2 is explicit, and the reason is worth keeping in front of a reader: "A rolled-back
 * insert would otherwise leave a cached id that `AUTOINCREMENT` never reissues; the rule still
 * protects the cache if that assumption ever breaks." Two failure modes, one rule. If SQLite never
 * reissues the id, a cache filled inside the transaction maps a canonical key to an id that no row
 * has — and the next `intern` of that value returns it, so a labeled row gets a `label_id` with no
 * `labels` row behind it. The I4 trigger would then refuse the write, which is the *good* outcome;
 * the bad one is a read, where `label_id IN (eligible)` silently matches nothing.
 *
 * ## Why the canonical key hashes its lists
 *
 * `reader_sets.canonical_key` is `('g' | 'm:' + hex(sha256(…)))` rather than the member ids
 * themselves, because an explicit audience may name every member of a large group and the column
 * is in a unique index. `@comvivo/core`'s `audienceKey` is the *unhashed* form — it is only ever an
 * in-memory `Map` key, where length costs nothing and legibility in a debug dump is worth
 * something. Two encodings on purpose, each shaped by where it is used.
 */
import type { Audience, Label, TxToken } from '@comvivo/core';
import {
  type GroupId,
  internedId,
  type LabelId,
  type MemberId,
  type ReaderSetId,
  StorageError,
} from '@comvivo/shared';
import { sha256Hex } from '@comvivo/shared/crypto';
import type Database from 'better-sqlite3-multiple-ciphers';

/** `02` §3.2's warning threshold for `storage.labels.count`. */
export const LABEL_COUNT_WARN = 2_000;

/**
 * `02` §3.2: above this many labels in a group, the B-tree path switches to a `TEMP` table.
 *
 * Exported because `M1-T17`'s labeled reads choose the strategy, not this module — it is recorded
 * here beside the count it is compared against.
 */
export const LABEL_COUNT_TEMP_TABLE = 4_096;

/**
 * The canonical key for an audience (`02` §3.2).
 *
 * `'g'` for the group audience, `'m:' + hex(sha256(sorted ids))` for an explicit one, then
 * `'|s:' + hex(sha256(sorted seat ids))` — and `'|s:'` with nothing after it when there are no
 * seats, which is the spec's own spelling. Sorted and de-duplicated first, so two audiences that
 * mean the same thing key the same and the unique index does its job.
 */
export function readerSetCanonicalKey(audience: Audience): string {
  const seats = [...new Set(audience.seats ?? [])].toSorted();
  const seatPart = `|s:${seats.length === 0 ? '' : sha256Hex(seats.join(','))}`;
  if (audience.kind === 'group') return `g${seatPart}`;
  const members = [...new Set(audience.memberIds)].toSorted();
  return `m:${sha256Hex(members.join(','))}${seatPart}`;
}

/**
 * The canonical key for a label (`02` §3.2).
 *
 * `${readerSetId}|${owner}|${sortedCoOwners}|${sensitivity}|${influence}|${untrusted}`, where
 * `owner` is core's `'group'` sentinel verbatim for a group-owned label — the *column* is NULL in
 * that case (`labels.owner_member_id` is nullable and `intern` maps between the two), but the key
 * is built from the core value, so no part of it is ever empty by accident.
 *
 * Not hashed: every part is a short fixed-width token except the co-owner list, which A5 caps at
 * 64 — so the key is bounded without hashing, and a readable key is worth having in a unique-index
 * violation's error message.
 *
 * **This is a stored format.** It lands in `labels.canonical_key` under a unique index, so changing
 * the spelling re-interns every label in an existing database: old rows keep their old keys, the
 * new key misses them, and one value ends up with two ids — the I1 hole the interning property
 * tests for. A change here needs a migration that rewrites the column. `pins the stored shape of a
 * canonical key` holds the format to that bargain.
 */
export function labelCanonicalKey(readerSetId: ReaderSetId, label: Label): string {
  const coOwners = [...new Set(label.coOwners)].toSorted().join(',');
  return [
    String(readerSetId),
    label.owner,
    coOwners,
    label.sensitivity,
    label.influence,
    label.untrusted ? '1' : '0',
  ].join('|');
}

/** What `intern` put in the caches, once the transaction committed. */
interface PendingIntern {
  readonly labelId: LabelId;
  readonly key: string;
  readonly label: Label;
}

/**
 * Get-or-create for labels and their reader sets, inside the caller's write transaction.
 *
 * One instance per database connection. The caches are per-instance and per-group-keyed, so a
 * second connection (a worker) has its own and cannot see uncommitted work — which is correct:
 * `02` D22's workers are read-only and never intern.
 */
export class LabelStore {
  readonly #db: Database.Database;
  /** `canonical_key` → id, per group. The group is in the key, because ids are not global. */
  readonly #idByKey = new Map<string, LabelId>();
  /** id → the label it stands for, for the eligibility map `M1-T17` builds. */
  readonly #labelById = new Map<LabelId, Label>();
  readonly #readerSetIdByKey = new Map<string, ReaderSetId>();

  constructor(db: Database.Database) {
    this.#db = db;
  }

  /**
   * The id for `label`, creating the row and its reader set if this value is new.
   *
   * @param _uow the write transaction this must happen inside. Taken as a token rather than used:
   * `02` §3.7.1 makes `SqliteStore.write` the only way into a transaction, and a repository that
   * opened its own would commit around part of a logical change.
   */
  intern(_uow: TxToken, label: Label): LabelId {
    const readerSetId = this.#internReaderSet(label.groupId, label.readers);
    const key = labelCanonicalKey(readerSetId, label);
    const cacheKey = `${label.groupId}|${key}`;

    const cached = this.#idByKey.get(cacheKey);
    if (cached !== undefined) return cached;

    const found = this.#db
      .prepare('SELECT id FROM labels WHERE group_id = ? AND canonical_key = ?')
      .get(label.groupId, key) as { id: number } | undefined;
    if (found !== undefined) {
      // Already committed by someone, so caching it now is safe — there is no insert to roll back.
      const labelId = internedId(found.id, 'labels');
      this.#remember({ labelId, key: cacheKey, label });
      return labelId;
    }

    const inserted = this.#db
      .prepare(
        `INSERT INTO labels (group_id, reader_set_id, owner_member_id, co_owner_member_ids,
           sensitivity, influence, untrusted, canonical_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        label.groupId,
        readerSetId,
        label.owner === 'group' ? null : label.owner,
        JSON.stringify([...new Set(label.coOwners)].toSorted()),
        label.sensitivity,
        label.influence,
        label.untrusted ? 1 : 0,
        key,
        0,
      ) as { id: number } | undefined;
    if (inserted === undefined) {
      throw new StorageError('STORAGE_IO', 'interning a label returned no id', {
        hint: 'This is a bug: `INSERT … RETURNING id` always yields a row when it succeeds.',
        category: 'bug',
      });
    }

    const labelId = internedId(inserted.id, 'labels');
    // **Only** in `afterCommit`. See the header: a rolled-back insert must not leave a cached id.
    _uow.afterCommit(() => {
      this.#remember({ labelId, key: cacheKey, label });
    });
    return labelId;
  }

  /** How many labels this group has, for `storage.labels.count` and the strategy switch. */
  countFor(groupId: GroupId): number {
    const row = this.#db
      .prepare('SELECT count(*) AS n FROM labels WHERE group_id = ?')
      .get(groupId) as { n: number };
    return row.n;
  }

  /** The label behind an id, if this connection has interned or loaded it. */
  cached(id: LabelId): Label | undefined {
    return this.#labelById.get(id);
  }

  /** Cache sizes, so a test can assert that a rollback left nothing behind. */
  get cacheSize(): { readonly labels: number; readonly readerSets: number } {
    return { labels: this.#idByKey.size, readerSets: this.#readerSetIdByKey.size };
  }

  #remember(pending: PendingIntern): void {
    this.#idByKey.set(pending.key, pending.labelId);
    this.#labelById.set(pending.labelId, pending.label);
  }

  /**
   * Get-or-create the reader set, with its members and seats.
   *
   * Not cached on the way in for the same reason labels are not: the insert may roll back. Unlike
   * a label it has no `afterCommit` of its own — the enclosing `intern` call registers one hook
   * covering both, because they succeed or fail together.
   */
  #internReaderSet(groupId: GroupId, audience: Audience): ReaderSetId {
    const key = readerSetCanonicalKey(audience);
    const cacheKey = `${groupId}|${key}`;
    const cached = this.#readerSetIdByKey.get(cacheKey);
    if (cached !== undefined) return cached;

    const found = this.#db
      .prepare('SELECT id FROM reader_sets WHERE group_id = ? AND canonical_key = ?')
      .get(groupId, key) as { id: number } | undefined;
    if (found !== undefined) {
      const readerSetId = internedId(found.id, 'reader_sets');
      this.#readerSetIdByKey.set(cacheKey, readerSetId);
      return readerSetId;
    }

    const members: readonly MemberId[] =
      audience.kind === 'members' ? [...new Set(audience.memberIds)].toSorted() : [];
    const inserted = this.#db
      .prepare(
        `INSERT INTO reader_sets (group_id, kind, canonical_key, member_count, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(groupId, audience.kind, key, members.length, 0) as { id: number } | undefined;
    if (inserted === undefined) {
      throw new StorageError('STORAGE_IO', 'interning a reader set returned no id', {
        hint: 'This is a bug: `INSERT … RETURNING id` always yields a row when it succeeds.',
        category: 'bug',
      });
    }

    const readerSetId = internedId(inserted.id, 'reader_sets');

    const memberStatement = this.#db.prepare(
      'INSERT INTO reader_set_members (reader_set_id, member_id) VALUES (?, ?)',
    );
    for (const member of members) memberStatement.run(readerSetId, member);

    const seats = [...new Set(audience.seats ?? [])].toSorted();
    const seatStatement = this.#db.prepare(
      'INSERT INTO reader_set_seats (reader_set_id, conversation_id) VALUES (?, ?)',
    );
    for (const seat of seats) seatStatement.run(readerSetId, seat);

    return readerSetId;
  }

  /** Drop the caches. For a test, and for `maintenance.labels_gc`, which deletes rows. */
  forget(): void {
    this.#idByKey.clear();
    this.#labelById.clear();
    this.#readerSetIdByKey.clear();
  }
}
