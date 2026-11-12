/**
 * The memory repository (`02` §3.7.1, §3.3.4, §3.5; semantics in `04`).
 *
 * ## There is no `update`
 *
 * `01` §5: a memory is "never hard-updated in place", and
 * `trg_memory_items_immutable` enforces it over `content`, `statement`, `search_terms`, `kind`,
 * `group_id` and `provenance`. A correction is `supersede`. That is what makes the chain an honest
 * record of what the group believed and when, rather than a row that quietly became something else.
 *
 * ## The three-step vec re-insert (`02` §3.5)
 *
 * The vec0 update trigger **deletes** rather than updates, to avoid depending on vec0 `UPDATE`
 * semantics (U3). So when a non-retracted item's `label_id`, `valid_to` or `retrieval_state`
 * changes, this repository must:
 *
 *  1. read the embedding back out of the vec table,
 *  2. write the base row — the trigger deletes the vec row,
 *  3. re-insert the vec row with the saved vector and the new metadata.
 *
 * "This costs a lookup, not a re-embed." If step 1 finds no row, the item goes back to
 * `embedding_state='pending'` and the `embed.items` job picks it up — which is also what happens
 * for an item that was never embedded, so the two cases need no distinction.
 *
 * `#reembedAround` is that dance, wrapped around every write that touches one of the three
 * columns. It is one function rather than three because the step that is easy to forget is step 1,
 * and a forgotten step 1 is invisible: the write succeeds, the vec row is gone, and the item
 * silently stops being findable by vector search.
 *
 * ## Why every integer binds as a BigInt
 *
 * `02` §3.5 constraint 2, measured twice: better-sqlite3 binds a plain JavaScript number as a
 * float, and vec0 refuses it — `Only integers are allows for primary key values` for the rowid and
 * `Expected integer for INTEGER metadata column label_id, received FLOAT` for the metadata. So
 * `rid`, `label_id`, `state` and `valid_to_ms` all go in as `BigInt`.
 */
import type {
  EligibleLabelSet,
  Label,
  MemoryItem,
  MemoryReader,
  MemoryRepository,
  MemorySource,
  MemoryStatus,
  MemorySubject,
  NewMemoryItem,
  RetractReason,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import {
  duplicate,
  notFound,
  RETRIEVAL_STATES,
  retrievalStateFor,
  writeConflict,
  writeOk,
} from '@comvivo/core';
import { type GroupId, type MemoryId, StorageError } from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';
import { and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import { type Db, exactlyOne, maybeOne, type Patch } from '../db/drizzle.js';
import type { LabelStore } from '../ifc/label-store.js';
import { memoryItems, memorySources, memorySubjects, memoryTombstones } from '../schema/index.js';
import { VALID_TO_OPEN_ENDED, vec0TableName } from '../search/vec0.js';
import { toMemoryItem, toMemorySource, toMemorySubject } from './rows.js';

/** The embedding and metadata of one vec0 row, read back before the trigger deletes it. */
interface SavedVector {
  readonly embedding: Buffer;
}

export interface MemoryRepositoryOptions {
  readonly db: Db;
  /** The raw connection: vec0 tables are virtual and Drizzle cannot describe them. */
  readonly connection: Database.Database;
  readonly labels: LabelStore;
  /**
   * The active embedding space's slug, resolved **when it is needed**.
   *
   * A function rather than a value, because reading it at construction made building the
   * repository set require a migrated database — `embedding_spaces` has to exist — and
   * `SqliteStore` is constructed at boot, around the migration rather than after it. Caught by
   * `tx.int.test.ts`, which opens a bare database on purpose.
   *
   * Resolving per call also gives a better guarantee than caching would: every call inside one
   * `store.write` sees the same row by SQLite's own snapshot, so a `04` §3.8.6 switch cannot land
   * between a KNN and its re-insert. The cost is one lookup on a table with single-digit rows.
   *
   * `undefined` is the ordinary state of a fresh instance: nothing is embedded until the first
   * `EmbeddingSpaceManager.ensure`, and memories written before then are `embedding_state='pending'`.
   */
  readonly activeSpaceSlug: () => string | undefined;
}

export class SqliteMemoryRepository implements MemoryReader, MemoryRepository {
  readonly #db: Db;
  readonly #connection: Database.Database;
  readonly #labels: LabelStore;
  readonly #slug: () => string | undefined;

  constructor(options: MemoryRepositoryOptions) {
    this.#db = options.db;
    this.#connection = options.connection;
    this.#labels = options.labels;
    this.#slug = options.activeSpaceSlug;
  }

  /* ───────────────────────────── Reads ───────────────────────────── */

  byId(groupId: GroupId, id: MemoryId, eligible: EligibleLabelSet): MemoryItem | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(memoryItems)
        .where(
          and(eq(memoryItems.groupId, groupId), eq(memoryItems.id, id), eligibleFilter(eligible)),
        ),
    );
    return row === undefined ? undefined : toMemoryItem(row);
  }

  /**
   * Q-MEM-2, through `memory_fingerprint_idx`.
   *
   * **Not** label-filtered, deliberately: the question is "does this group already hold this
   * fact", which is about the store and not about an audience. Filtering would let the same fact
   * be extracted twice under two labels — the duplication the index exists to prevent — and the
   * caller never renders the result, it only decides whether to write.
   */
  byFingerprint(groupId: GroupId, fingerprint: Uint8Array): MemoryItem | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(memoryItems)
        .where(
          and(
            eq(memoryItems.groupId, groupId),
            eq(memoryItems.fingerprint, Buffer.from(fingerprint)),
          ),
        )
        .orderBy(asc(memoryItems.rid)),
    );
    return row === undefined ? undefined : toMemoryItem(row);
  }

  /**
   * Q-MEM-1: the chain through `supersedes_id`, newest first.
   *
   * Walked in JavaScript rather than as a recursive CTE, for a reason worth stating: each step must
   * pass the eligibility filter, and a recursive CTE that filtered mid-walk would **stop** at the
   * first ineligible link rather than skipping it — so a member who may read the newest and oldest
   * item but not the middle one would see only the newest. Walking here lets an ineligible link be
   * skipped while the chain continues, which is what `02` §3.7.1's silent-drop convention means.
   *
   * Bounded by `MAX_CHAIN` so a cycle — which `supersedes_id`'s self-reference makes expressible
   * even though nothing should write one — cannot spin.
   */
  supersedeChain(
    groupId: GroupId,
    id: MemoryId,
    eligible: EligibleLabelSet,
  ): readonly MemoryItem[] {
    const chain: MemoryItem[] = [];
    const seen = new Set<string>();
    let cursor: MemoryId | undefined = id;
    while (cursor !== undefined && chain.length < MAX_CHAIN) {
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const row: typeof memoryItems.$inferSelect | undefined = this.#rowOf(groupId, cursor);
      if (row === undefined) break;
      // Eligibility decides whether the item is *returned*, not whether the walk continues — see
      // the method's note. A retracted link is skipped on the same terms: it is not shown, and the
      // chain still walks through it, because a retraction in the middle of a history must not
      // hide the versions before it.
      if (row.status !== 'retracted' && eligible.ids.includes(row.labelId)) {
        chain.push(toMemoryItem(row));
      }
      cursor = row.supersedesId ?? undefined;
    }
    return chain;
  }

  subjectsOf(groupId: GroupId, id: MemoryId): readonly MemorySubject[] {
    const rid = this.#ridOf(groupId, id);
    if (rid === undefined) return [];
    const rows = this.#db
      .select()
      .from(memorySubjects)
      .where(and(eq(memorySubjects.groupId, groupId), eq(memorySubjects.memoryRid, rid)))
      .orderBy(asc(memorySubjects.subjectRef))
      .all();
    return rows.map(toMemorySubject);
  }

  sourcesOf(groupId: GroupId, id: MemoryId): readonly MemorySource[] {
    const rid = this.#ridOf(groupId, id);
    if (rid === undefined) return [];
    const rows = this.#db
      .select()
      .from(memorySources)
      .where(eq(memorySources.memoryRid, rid))
      .orderBy(asc(memorySources.addedAt), asc(memorySources.sourceRef))
      .all();
    return rows.map(toMemorySource);
  }

  /** Q-JOB-6, through `memory_embed_pending_idx`. */
  embeddingBacklog(groupId: GroupId, limit: number): readonly MemoryItem[] {
    const rows = this.#db
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.groupId, groupId),
          eq(memoryItems.embeddingState, 'pending'),
          sql`${memoryItems.status} <> 'retracted'`,
        ),
      )
      .orderBy(asc(memoryItems.rid))
      .limit(limit)
      .all();
    return rows.map(toMemoryItem);
  }

  /* ───────────────────────────── Writes ───────────────────────────── */

  insert(
    uow: TxToken,
    item: NewMemoryItem,
    label: Label,
    fingerprint: Uint8Array,
  ): WriteResult<MemoryItem> {
    if (label.groupId !== item.groupId) throw crossGroup();
    const existing = this.byFingerprint(item.groupId, fingerprint);
    // Checked before the insert rather than caught after it, because `04` §3.3.11's duplicate case
    // wants the *existing row* to confirm, and the index is not unique — `02` §3.3.4 makes
    // `memory_fingerprint_idx` a plain index, since a superseded item and its replacement can
    // legitimately share a fingerprint when only the validity changed.
    if (existing !== undefined && existing.status !== 'retracted') return duplicate(existing.id);

    const labelId = this.#labels.intern(uow, label);
    const retrievalState = retrievalStateFor({
      status: item.status,
      archivedAt: undefined,
      validTo: item.validTo,
      now: uow.now,
    });
    const row = exactlyOne(
      this.#db
        .insert(memoryItems)
        .values({
          id: item.id,
          groupId: item.groupId,
          kind: item.kind,
          content: item.content,
          statement: item.statement,
          searchTerms: [...item.searchTerms],
          language: item.language,
          fingerprint: Buffer.from(fingerprint),
          labelId,
          provenance: item.provenance,
          confidence: item.confidence,
          status: item.status,
          validFrom: item.validFrom,
          validTo: item.validTo,
          supersedesId: item.supersedesId,
          contradicts: [...(item.contradicts ?? [])],
          links: [...(item.links ?? [])],
          retrievalState,
          pinned: item.pinned ?? false,
          pinnedAt: item.pinned === true ? uow.now : undefined,
          portable: item.portable ?? false,
          embeddingState: 'pending',
          createdAt: uow.now,
          updatedAt: uow.now,
        })
        .returning(),
      'the memory item',
    );
    this.#writeSubjects(row.rid, item.groupId, item.subjects ?? []);
    this.#writeSources(row.rid, item.sources ?? [], uow.now);
    return writeOk(toMemoryItem(row));
  }

  setStatus(
    uow: TxToken,
    groupId: GroupId,
    id: MemoryId,
    expectVersion: number,
    status: MemoryStatus,
    options: {
      readonly validTo?: Temporal.Instant | null | undefined;
      readonly archivedAt?: Temporal.Instant | null | undefined;
      readonly retractReason?: RetractReason | undefined;
    } = {},
  ): WriteResult<MemoryItem> {
    const current = this.#rowOf(groupId, id);
    if (current === undefined) return notFound();
    const validTo = options.validTo === undefined ? current.validTo : (options.validTo ?? null);
    const archivedAt =
      options.archivedAt === undefined ? current.archivedAt : (options.archivedAt ?? null);
    const retrievalState = retrievalStateFor({
      status,
      archivedAt: archivedAt ?? undefined,
      validTo: validTo ?? undefined,
      now: uow.now,
    });
    return this.#versionedUpdate(uow, groupId, id, expectVersion, {
      status,
      validTo,
      archivedAt,
      retrievalState,
      retractReason: options.retractReason,
    });
  }

  supersede(
    uow: TxToken,
    groupId: GroupId,
    oldId: MemoryId,
    expectVersion: number,
    next: NewMemoryItem,
    label: Label,
    fingerprint: Uint8Array,
  ): WriteResult<MemoryItem> {
    if (next.groupId !== groupId) throw crossGroup();
    const old = this.#rowOf(groupId, oldId);
    if (old === undefined) return notFound();
    if (old.version !== expectVersion) return writeConflict();

    // The new item first, so its id exists before the old row points at it. `supersedes_id` has a
    // foreign key to `memory_items.id` (`02` §3.3.4) and `superseded_by_id` deliberately does not,
    // so the forward pointer survives the old row being purged — but the *backward* one has to be
    // satisfiable at insert time.
    const inserted = this.insert(uow, { ...next, supersedesId: oldId }, label, fingerprint);
    if (inserted.kind !== 'ok') return inserted;

    const retired = this.#versionedUpdate(uow, groupId, oldId, expectVersion, {
      status: 'superseded',
      supersededById: inserted.value.id,
      retrievalState: RETRIEVAL_STATES.history,
    });
    if (retired.kind !== 'ok') return retired;
    return inserted;
  }

  narrowLabel(
    uow: TxToken,
    groupId: GroupId,
    id: MemoryId,
    expectVersion: number,
    label: Label,
  ): WriteResult<MemoryItem> {
    if (label.groupId !== groupId) throw crossGroup();
    const current = this.#rowOf(groupId, id);
    if (current === undefined) return notFound();
    const labelId = this.#labels.intern(uow, label);
    if (labelId === current.labelId) {
      // Already this label. `ok` rather than a refusal: re-applying the same narrowing is what a
      // retried declassification job does, and it changed nothing.
      return writeOk(toMemoryItem(current));
    }
    return this.#versionedUpdate(uow, groupId, id, expectVersion, { labelId });
  }

  forget(
    uow: TxToken,
    groupId: GroupId,
    id: MemoryId,
    reason: RetractReason,
    at: Temporal.Instant,
  ): WriteResult<void> {
    const current = this.#rowOf(groupId, id);
    if (current === undefined) return notFound();
    // Retraction, not deletion: `02` §3.13 keeps the row so everything referencing it resolves,
    // and `04` R5 removes it from both search indexes — which the FTS and vec triggers do on the
    // status change, so there is nothing to clean up here.
    const retracted = this.#versionedUpdate(uow, groupId, id, current.version, {
      status: 'retracted',
      retractReason: reason,
      retrievalState: RETRIEVAL_STATES.history,
    });
    // Forwarded as-is: the non-`ok` arms carry no value, so a `WriteResult<MemoryItem>` refusal
    // *is* a `WriteResult<void>` refusal. (An earlier version re-tested `kind === 'ok'` inside
    // this branch, which was dead code the compiler caught.)
    if (retracted.kind !== 'ok') return retracted;
    // `04` R9's content-free tombstone: the id, the group, when and why. Nothing about what it said.
    this.#db
      .insert(memoryTombstones)
      .values({ memoryId: id, groupId, forgottenAt: at, reason })
      .onConflictDoNothing()
      .run();
    return writeOk(undefined);
  }

  setPinned(
    uow: TxToken,
    groupId: GroupId,
    id: MemoryId,
    expectVersion: number,
    pinned: boolean,
  ): WriteResult<MemoryItem> {
    return this.#versionedUpdate(uow, groupId, id, expectVersion, {
      pinned,
      pinnedAt: pinned ? uow.now : null,
    });
  }

  /**
   * `04` R13's access stats.
   *
   * An upsert per rid rather than one statement, because `memory_access_stats` is keyed on the rid
   * and the increment has to apply to rows that may not exist yet. Not versioned and not a
   * `WriteResult`: a retrieval statistic is not something a caller can usefully fail on, and
   * refusing the write would mean failing a *read* because its bookkeeping did not land.
   */
  recordRetrieval(_uow: TxToken, rids: readonly number[], at: Temporal.Instant): void {
    if (rids.length === 0) return;
    const statement = this.#connection.prepare(
      `INSERT INTO memory_access_stats (memory_rid, retrieved_count, last_retrieved_at)
       VALUES (?, 1, ?)
       ON CONFLICT(memory_rid) DO UPDATE SET
         retrieved_count = retrieved_count + 1,
         last_retrieved_at = excluded.last_retrieved_at`,
    );
    for (const rid of rids) statement.run(BigInt(rid), at.epochMilliseconds);
  }

  addSources(
    uow: TxToken,
    groupId: GroupId,
    id: MemoryId,
    sources: readonly Omit<MemorySource, 'addedAt'>[],
  ): WriteResult<MemoryItem> {
    const current = this.#rowOf(groupId, id);
    if (current === undefined) return notFound();
    this.#writeSources(current.rid, sources, uow.now);
    // No version bump: `04` R13 makes sources **append-only**, so adding one cannot conflict with
    // another writer — two callers appending different sources both succeed, which is correct.
    return writeOk(toMemoryItem(current));
  }

  /**
   * `02` §3.5's insert path, steps 2 and 3.
   *
   * No-op when there is no active space: a fresh instance has nothing to insert into, and the item
   * stays `pending` so the job picks it up once a space exists. Reported as `ok` rather than as a
   * refusal, because nothing is wrong — there is simply nowhere to put it yet.
   */
  putEmbedding(
    uow: TxToken,
    groupId: GroupId,
    id: MemoryId,
    expectLabelId: number,
    vector: Float32Array,
  ): WriteResult<MemoryItem> {
    const row = this.#rowOf(groupId, id);
    if (row === undefined) return notFound();
    // The re-check `02` §3.5 asks for. A retraction or a relabel between the embedding and this
    // write makes the metadata the caller computed wrong, and a vec row with a stale `label_id`
    // is an `I1` leak until something notices.
    if (row.status === 'retracted') return writeConflict();
    if (row.labelId !== expectLabelId) return writeConflict();

    const slug = this.#slug();
    if (slug === undefined) return writeOk(toMemoryItem(row));

    const dims = this.#dimsOf(slug);
    if (dims !== undefined && vector.length !== dims) {
      throw new StorageError(
        'STORAGE_CONSTRAINT',
        `the embedding has ${String(vector.length)} dimensions, the active space has ${String(dims)}`,
        {
          hint:
            'This is `04` F17: a dimension mismatch after a configuration change. Give the new ' +
            'model a distinct name so a re-embed migration starts (`04` §3.8.6).',
          category: 'bug',
        },
      );
    }
    if (!isUnitVector(vector)) {
      throw new StorageError('STORAGE_CONSTRAINT', 'the embedding is not unit-normalised', {
        hint:
          '`02` §3.5 stores unit vectors so the default L2 metric ranks the same as cosine. A ' +
          'non-unit vector changes the ranking without any error.',
        category: 'bug',
      });
    }

    // Replace rather than insert: the job can be retried, and vec0 has no upsert.
    this.#connection
      .prepare(`DELETE FROM ${vec0TableName(slug)} WHERE rid = ?`)
      .run(BigInt(row.rid));
    this.#connection
      .prepare(
        `INSERT INTO ${vec0TableName(slug)}
           (rid, group_id, embedding, label_id, kind, state, valid_to_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        BigInt(row.rid),
        row.groupId,
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        BigInt(row.labelId),
        row.kind,
        BigInt(row.retrievalState),
        BigInt(row.validTo?.epochMilliseconds ?? VALID_TO_OPEN_ENDED),
      );
    const updated = maybeOne(
      this.#db
        .update(memoryItems)
        .set({ embeddingState: 'done', updatedAt: uow.now })
        .where(eq(memoryItems.rid, row.rid))
        .returning(),
    );
    return updated === undefined ? notFound() : writeOk(toMemoryItem(updated));
  }

  setEmbeddingState(
    uow: TxToken,
    groupId: GroupId,
    id: MemoryId,
    state: MemoryItem['embeddingState'],
  ): WriteResult<MemoryItem> {
    const row = maybeOne(
      this.#db
        .update(memoryItems)
        .set({ embeddingState: state, updatedAt: uow.now })
        .where(and(eq(memoryItems.groupId, groupId), eq(memoryItems.id, id)))
        .returning(),
    );
    // Unversioned, like `addSources`: the `embed.items` job owns this column alone, and making it
    // conflict with a concurrent lifecycle change would fail an embedding for a reason the job
    // cannot act on.
    return row === undefined ? notFound() : writeOk(toMemoryItem(row));
  }

  /* ──────────────────────────── Internals ──────────────────────────── */

  #ridOf(groupId: GroupId, id: MemoryId): number | undefined {
    const row = maybeOne(
      this.#db
        .select({ rid: memoryItems.rid })
        .from(memoryItems)
        .where(and(eq(memoryItems.groupId, groupId), eq(memoryItems.id, id))),
    );
    return row?.rid;
  }

  #rowOf(groupId: GroupId, id: MemoryId): typeof memoryItems.$inferSelect | undefined {
    return maybeOne(
      this.#db
        .select()
        .from(memoryItems)
        .where(and(eq(memoryItems.groupId, groupId), eq(memoryItems.id, id))),
    );
  }

  #writeSubjects(rid: number, groupId: GroupId, subjects: readonly MemorySubject[]): void {
    if (subjects.length === 0) return;
    for (const subject of subjects) {
      this.#db
        .insert(memorySubjects)
        .values({ memoryRid: rid, groupId, subjectRef: subject.ref, role: subject.role })
        // The primary key is `(memory_rid, subject_ref)`, so the same subject named twice with
        // different roles is one row. `04` writes the subjects of one extraction together, so the
        // first role wins and a retry is idempotent.
        .onConflictDoNothing()
        .run();
    }
  }

  #writeSources(
    rid: number,
    sources: readonly Omit<MemorySource, 'addedAt'>[],
    at: Temporal.Instant,
  ): void {
    for (const source of sources) {
      this.#db
        .insert(memorySources)
        .values({
          memoryRid: rid,
          sourceRef: source.ref,
          messageId: source.messageId,
          windowKey: source.windowKey,
          span: source.span,
          addedAt: at,
        })
        // `04` R13: append-only, and re-appending the same source is what a retried extraction
        // does. The key is `(memory_rid, source_ref)`.
        .onConflictDoNothing()
        .run();
    }
  }

  /**
   * One versioned `UPDATE`, wrapped in the `02` §3.5 re-embed dance.
   *
   * Every caller goes through here, so no write can touch `label_id`, `valid_to` or
   * `retrieval_state` without the vec row being carried across — which is the step that is easy to
   * forget and invisible when forgotten.
   */
  #versionedUpdate(
    uow: TxToken,
    groupId: GroupId,
    id: MemoryId,
    expectVersion: number,
    patch: Patch<typeof memoryItems.$inferInsert>,
  ): WriteResult<MemoryItem> {
    const touchesVec =
      patch.labelId !== undefined ||
      patch.validTo !== undefined ||
      patch.retrievalState !== undefined ||
      patch.status !== undefined;
    const before = touchesVec ? this.#rowOf(groupId, id) : undefined;
    const saved = touchesVec && before !== undefined ? this.#readVector(before.rid) : undefined;

    const row = maybeOne(
      this.#db
        .update(memoryItems)
        .set({ ...patch, updatedAt: uow.now, version: expectVersion + 1 })
        .where(
          and(
            eq(memoryItems.groupId, groupId),
            eq(memoryItems.id, id),
            eq(memoryItems.version, expectVersion),
          ),
        )
        .returning(),
    );
    if (row === undefined) {
      const exists = this.#ridOf(groupId, id);
      return exists === undefined ? notFound() : writeConflict();
    }

    if (touchesVec) this.#restoreVector(row, saved);
    return writeOk(toMemoryItem(row));
  }

  /** The dimension count of a space, for the mismatch check (`04` F17). */
  #dimsOf(slug: string): number | undefined {
    const row = this.#connection
      .prepare('SELECT dims FROM embedding_spaces WHERE table_name = ?')
      .get(vec0TableName(slug)) as { dims: number } | undefined;
    return row?.dims;
  }

  /** Step 1 of `02` §3.5: read the embedding back before the trigger deletes its row. */
  #readVector(rid: number): SavedVector | undefined {
    const slug = this.#slug();
    if (slug === undefined) return undefined;
    const row = this.#connection
      .prepare(`SELECT embedding FROM ${vec0TableName(slug)} WHERE rid = ?`)
      .get(BigInt(rid)) as { embedding: Buffer } | undefined;
    return row === undefined ? undefined : { embedding: row.embedding };
  }

  /**
   * Step 3 of `02` §3.5: re-insert the vec row with the new metadata, or mark the item pending.
   *
   * A **retracted** item is never re-inserted: `04` R5 removes it from both indexes, and the
   * trigger has already taken the row out. Re-inserting it would make a forgotten memory findable
   * by vector search, which is the one direction this dance must not go.
   */
  #restoreVector(row: typeof memoryItems.$inferSelect, saved: SavedVector | undefined): void {
    const slug = this.#slug();
    if (slug === undefined) return;
    if (row.status === 'retracted') return;
    if (saved === undefined) {
      // Never embedded, or the vector is gone. Both mean the same thing to the `embed.items` job,
      // so neither needs its own state.
      this.#db
        .update(memoryItems)
        .set({ embeddingState: 'pending' })
        .where(eq(memoryItems.rid, row.rid))
        .run();
      return;
    }
    // Every integer as a BigInt (`02` §3.5 constraint 2), and `valid_to_ms` uses the sentinel
    // rather than NULL, because NULL is not filterable in a vec0 metadata comparison.
    this.#connection
      .prepare(
        `INSERT INTO ${vec0TableName(slug)}
           (rid, group_id, embedding, label_id, kind, state, valid_to_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        BigInt(row.rid),
        row.groupId,
        saved.embedding,
        BigInt(row.labelId),
        row.kind,
        BigInt(row.retrievalState),
        BigInt(row.validTo?.epochMilliseconds ?? VALID_TO_OPEN_ENDED),
      );
  }
}

/** A supersede chain longer than this is a cycle or a bug, not a history. */
const MAX_CHAIN = 64;

/** `label_id IN (eligible)`, with the empty set matching nothing (`01` §7.2, `I1`). */
function eligibleFilter(eligible: EligibleLabelSet): SQL {
  if (eligible.ids.length === 0) return sql`1 = 0`;
  return inArray(memoryItems.labelId, [...eligible.ids]);
}

/** An `I4` violation the foreign keys cannot catch: a label from another group. */
function crossGroup(): StorageError {
  return new StorageError('STORAGE_CONSTRAINT', 'the memory item names a label of another group', {
    hint: "This is a bug and an I4 violation: intern the label against the item's own group.",
    category: 'bug',
  });
}

/**
 * Whether a vector is unit-normalised, within floating-point tolerance.
 *
 * `02` §3.5 stores unit vectors so the default L2 metric gives the same ordering as cosine. The
 * tolerance is generous because the vector arrives as `Float32Array` from a model that normalised
 * it in `float32`: an exact test would reject vectors that are unit to every digit the format
 * holds.
 */
function isUnitVector(vector: Float32Array): boolean {
  if (vector.length === 0) return false;
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.abs(Math.sqrt(sum) - 1) < 1e-3;
}
