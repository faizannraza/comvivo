/**
 * `MemorySearchPort` over SQLite (`02` §3.4–§3.5, `04` §3.6.3).
 *
 * ## Storage filtering is for performance, not for correctness
 *
 * `02` §3.5 states it and it governs every method here: "Storage filtering exists for performance,
 * not for correctness." `04` §3.6.3 re-checks every hydrated item through core `canRead` and fails
 * closed on a mismatch. So the eligibility and state predicates below exist so that **unreadable
 * rows never take a top-k slot** — if they were only applied after ranking, a member's private
 * memory could crowd out the readable answers and the result would be a correct-but-empty block.
 *
 * ## Raw SQL here, Drizzle everywhere else
 *
 * The FTS and vec0 tables are **virtual**, and Drizzle cannot describe a virtual table — so there
 * is no schema object to query through and no column mapper to validate with. The hydration half
 * goes back through Drizzle, which is where the mappers matter: the ids, instants and JSON columns
 * of `memory_items` are all parsed on the way out.
 *
 * ## Every vec0 integer binds as a BigInt
 *
 * `02` §3.5 constraint 2, measured twice: better-sqlite3 binds a plain number as a float and vec0
 * refuses it for the rowid *and* for every `INTEGER` metadata column. The `IN` list is also padded
 * to a power of two with `0`, per `02` §3.5 — `0` is not a valid interned id (`AUTOINCREMENT`
 * starts at 1), so a pad value can never match a real row.
 */

// `EligibleLabelSet` and `MemoryItem` come from the package root, not the narrow entry point: the
// narrow one re-exports neither, because a barrel that forwarded them would be an unrestricted
// importer of the restricted module and every consumer of `@comvivo/core` would inherit the edge.
import { type EligibleLabelSet, type MemoryItem, subjectRefToColumn } from '@comvivo/core';
import type {
  AliasMatch,
  AliasQuery,
  EntityQuery,
  MemorySearchPort,
  RecentQuery,
  ScoredRef,
  SubjectQuery,
  TextQuery,
  VectorQuery,
} from '@comvivo/core/memory-search';
import type { MemoryId } from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';
import { and, asc, desc, eq, gte, inArray, lte, type SQL, sql } from 'drizzle-orm';
import { type Db, eqUnindexed, inArrayUnindexed } from '../db/drizzle.js';
import { toMemoryItem } from '../repos/rows.js';
import { memoryItems } from '../schema/index.js';
import { buildFtsQuery, buildTrigramQuery, MEMORY_BM25_WEIGHTS, scopeToken } from './fts-query.js';
import { VALID_TO_OPEN_ENDED, VEC0_MAX_K, vec0TableName } from './vec0.js';

export interface MemorySearchOptions {
  readonly db: Db;
  /** The raw connection: FTS5 and vec0 tables are virtual. */
  readonly connection: Database.Database;
  /**
   * The active space's slug, resolved **when it is needed**.
   *
   * A function rather than a value: see the note on `MemoryRepositoryOptions.activeSpaceSlug`.
   * Reading it at construction made building the repository set require a migrated database.
   */
  readonly activeSpaceSlug: () => string | undefined;
}

export class SqliteMemorySearch implements MemorySearchPort {
  readonly #db: Db;
  readonly #connection: Database.Database;
  readonly #slug: () => string | undefined;

  constructor(options: MemorySearchOptions) {
    this.#db = options.db;
    this.#connection = options.connection;
    this.#slug = options.activeSpaceSlug;
  }

  /**
   * Q-CTX-2: FTS over `statement` and `terms`, weighted `1.0, 0.8, 0.0`.
   *
   * `bm25` is **lower-is-better** (FTS5 negates the score), which is why it goes straight into
   * `distance` with no transformation: `04`'s fusion requires every channel to be smaller-is-closer
   * and a channel that inverted its own ranking would do so invisibly.
   *
   * In trigram mode the query runs against `memory_fts_tri`, which has **no `scope` column** — so
   * the group filter is the join on `memory_items.group_id` rather than a scope token (`02` §3.4).
   */
  text(query: TextQuery): readonly ScoredRef<MemoryId>[] {
    if (query.eligible.ids.length === 0) return [];
    const trigram = query.mode === 'trigram';
    const match = trigram
      ? buildTrigramQuery(query.query)
      : buildFtsQuery(query.query, {
          table: 'memory_fts',
          mode: 'any',
          scopeToken: scopeToken(query.groupId),
        });
    // `null` means nothing searchable survived — two spaces, or a one-character trigram query.
    // Returning `[]` rather than running an empty `MATCH`, which is a syntax error.
    if (match === null) return [];

    const table = trigram ? 'memory_fts_tri' : 'memory_fts';
    // `bm25()` takes the weights positionally, one per indexed column. `memory_fts_tri` has one.
    const score = trigram
      ? 'bm25(memory_fts_tri)'
      : `bm25(memory_fts, ${MEMORY_BM25_WEIGHTS.map((weight) => weight.toFixed(1)).join(', ')})`;
    const kinds = query.kinds ?? [];
    const rows = this.#connection
      .prepare(
        `SELECT m.id AS id, m.rid AS rid, ${score} AS distance
           FROM ${table} JOIN memory_items m ON m.rid = ${table}.rowid
          WHERE ${table} MATCH ?
            AND m.group_id = ?
            AND m.retrieval_state <= ?
            AND m.label_id IN (${placeholders(query.eligible.ids.length)})
            ${kinds.length === 0 ? '' : `AND m.kind IN (${placeholders(kinds.length)})`}
          ORDER BY distance
          LIMIT ?`,
      )
      .all(match, query.groupId, query.maxState, ...query.eligible.ids, ...kinds, query.limit) as {
      id: MemoryId;
      rid: number;
      distance: number;
    }[];
    return rows.map((row) => ({ ref: row.id, rid: row.rid, distance: row.distance }));
  }

  /**
   * Q-CTX-3: vec0 KNN.
   *
   * **`ORDER BY distance` and nothing else** — `02` §3.5 constraint 1, measured: any other
   * ordering is refused outright with "Only a single 'ORDER BY distance' clause is allowed on vec0
   * KNN queries". A caller that wants another order sorts afterwards.
   *
   * Returns `[]` when there is no active space, which is a fresh instance's ordinary state rather
   * than an error: the FTS and entity channels still answer, and `04` fuses what it gets.
   */
  vector(query: VectorQuery): readonly ScoredRef<MemoryId>[] {
    const slug = this.#slug();
    if (slug === undefined) return [];
    if (query.eligible.ids.length === 0) return [];
    const k = Math.min(query.k, VEC0_MAX_K);
    if (k <= 0) return [];

    // Padded to a power of two with `0` (`02` §3.5). `0` is not a valid interned id —
    // `AUTOINCREMENT` starts at 1 — so a pad can never match a real row.
    const padded = padToPowerOfTwo(query.eligible.ids);
    const kinds = query.kinds ?? [];
    const rows = this.#connection
      .prepare(
        `SELECT rid, distance
           FROM ${vec0TableName(slug)}
          WHERE embedding MATCH ? AND k = ?
            AND group_id = ?
            AND label_id IN (${placeholders(padded.length)})
            AND state <= ?
            ${query.validAt === null ? '' : 'AND valid_to_ms > ?'}
            ${kinds.length === 0 ? '' : `AND kind IN (${placeholders(kinds.length)})`}
          ORDER BY distance`,
      )
      .all(
        Buffer.from(query.vector.buffer, query.vector.byteOffset, query.vector.byteLength),
        BigInt(k),
        query.groupId,
        ...padded.map((id) => BigInt(id)),
        BigInt(query.maxState),
        ...(query.validAt === null ? [] : [BigInt(query.validAt.epochMilliseconds)]),
        ...kinds,
      ) as { rid: number; distance: number }[];
    if (rows.length === 0) return [];

    // A second statement hydrates the ids, re-applying the state and label filters — `02` §3.5:
    // "For safety it re-applies the state and label filters (a stale vec row can never leak)."
    // That is not belt-and-braces: the vec row's metadata is a *copy* maintained by a trigger and
    // a repository, so a bug in either would otherwise be a readable leak rather than a stale hit.
    const byRid = new Map(rows.map((row) => [row.rid, row.distance]));
    // Both hints, measured at `M1-T33`: given a 64-element rid list *and* an indexable group or
    // label term, SQLite drove this from `memory_fingerprint_idx (group_id=?)` and filtered the
    // group — 4.6 ms on `knn-50k` and 2.8 ms on `stress-50k-1m`, against **0.034 ms** when the rid
    // list drives. That was 18% of the KNN row's measured latency, hidden inside a 60 ms budget.
    // Both predicates are still evaluated, so `I4` and the staleness re-check are unchanged.
    const hydrated = this.#db
      .select({ id: memoryItems.id, rid: memoryItems.rid })
      .from(memoryItems)
      .where(
        and(
          inArray(memoryItems.rid, [...byRid.keys()]),
          eqUnindexed(memoryItems.groupId, query.groupId),
          lte(memoryItems.retrievalState, query.maxState),
          inArrayUnindexed(memoryItems.labelId, [...query.eligible.ids]),
        ),
      )
      .all();
    return hydrated
      .map((row) => ({ ref: row.id, rid: row.rid, distance: byRid.get(row.rid) ?? Number.NaN }))
      .toSorted((left, right) => left.distance - right.distance);
  }

  /**
   * `04` §3.6.3's entity channel.
   *
   * No score of its own — an entity either matches or it does not — so `distance` is `0` for every
   * hit and `04`'s fusion weights the channel rather than the rows within it. Ordered by
   * `valid_from DESC`, which `04` §3.6.3 specifies, so the `limit` keeps the most recent.
   */
  byEntities(query: EntityQuery): readonly ScoredRef<MemoryId>[] {
    if (query.eligible.ids.length === 0 || query.entityIds.length === 0) return [];
    const rows = this.#connection
      .prepare(
        `SELECT mi.id AS id, mi.rid AS rid
           FROM memory_item_entities e
           JOIN memory_items mi ON mi.rid = e.memory_rid
          WHERE e.entity_id IN (${placeholders(query.entityIds.length)})
            AND mi.group_id = ?
            AND mi.label_id IN (${placeholders(query.eligible.ids.length)})
            AND mi.retrieval_state <= ?
            AND mi.status <> 'retracted'
          ORDER BY mi.valid_from DESC
          LIMIT ?`,
      )
      .all(
        ...query.entityIds,
        query.groupId,
        ...query.eligible.ids,
        query.maxState,
        query.limit,
      ) as { id: MemoryId; rid: number }[];
    return rows.map((row) => ({ ref: row.id, rid: row.rid, distance: 0 }));
  }

  /**
   * Q-CTX-8: readable entity aliases by normalised form.
   *
   * The label filter is on `memory_entity_aliases.label_id` — the label of the item that
   * *introduced* the alias (`02` §3.3.4). That is the subtle part: an alias is a name someone used,
   * so knowing it is knowing something about the conversation it came from. Filtering on the entity
   * instead would leak a nickname learned in a private exchange to the whole group.
   */
  aliases(query: AliasQuery): readonly AliasMatch[] {
    if (query.eligible.ids.length === 0 || query.aliasNorms.length === 0) return [];
    const rows = this.#connection
      .prepare(
        `SELECT DISTINCT entity_id AS entityId, alias_norm AS aliasNorm
           FROM memory_entity_aliases
          WHERE group_id = ?
            AND alias_norm IN (${placeholders(query.aliasNorms.length)})
            AND label_id IN (${placeholders(query.eligible.ids.length)})`,
      )
      .all(query.groupId, ...query.aliasNorms, ...query.eligible.ids) as AliasMatch[];
    return rows;
  }

  /** Q-CTX-4: memories about a subject, through `memory_subjects_lookup_idx`. */
  bySubjects(query: SubjectQuery): readonly MemoryItem[] {
    if (query.eligible.ids.length === 0 || query.subjectRefs.length === 0) return [];
    const refs = query.subjectRefs.map(subjectRefToColumn);
    const rows = this.#connection
      .prepare(
        `SELECT mi.rid AS rid
           FROM memory_subjects s
           JOIN memory_items mi ON mi.rid = s.memory_rid
          WHERE s.group_id = ?
            AND s.subject_ref IN (${placeholders(refs.length)})
            AND mi.label_id IN (${placeholders(query.eligible.ids.length)})
            AND mi.retrieval_state <= ?
            AND mi.status <> 'retracted'
          ORDER BY mi.valid_from DESC
          LIMIT ?`,
      )
      .all(query.groupId, ...refs, ...query.eligible.ids, query.maxState, query.limit) as {
      rid: number;
    }[];
    return this.#hydrateRids(rows.map((row) => row.rid));
  }

  /** Q-CTX-5: recent memories, through `memory_group_status_updated_idx`. */
  recent(query: RecentQuery): readonly MemoryItem[] {
    if (query.eligible.ids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(memoryItems)
      .where(
        and(
          eq(memoryItems.groupId, query.groupId),
          lte(memoryItems.retrievalState, query.maxState),
          notRetracted(),
          inArray(memoryItems.labelId, [...query.eligible.ids]),
          ...(query.since === undefined ? [] : [gte(memoryItems.updatedAt, query.since)]),
        ),
      )
      .orderBy(desc(memoryItems.updatedAt), desc(memoryItems.rid))
      .limit(query.limit)
      .all();
    return rows.map(toMemoryItem);
  }

  /**
   * Load items by id, for a caller that already has them (`02` §3.3.9: a trace holds ids).
   *
   * **Both** eligibility terms are hinted away from the planner, each for a measurement taken at
   * `M1-T33` on a different fixture:
   *
   * - `eqUnindexed` on the group: with a 200-element id list and a plain `group_id = ?`, SQLite
   *   drove from the group index and filtered 30,000 rows — 17.0 ms p50 on `stress-50k-1m` against
   *   0.438 ms with the hint.
   * - `inArrayUnindexed` on the label: with *few* labels the eligibility list looks cheaper than
   *   the id list, so the planner drove from `memory_label_idx` instead — 13.1 ms on `knn-50k`
   *   (42 labels, 50k memories) and 0.415 ms on `release-small` (12 labels, 2k memories), against
   *   0.206 ms and 0.158 ms with the hint. The slow plan lands on **small** groups, which is the
   *   common case; `db/drizzle.ts` carries the numbers and `db/plan-hints.int.test.ts` pins the
   *   plan.
   *
   * Both comparisons are still evaluated, so `I4` is unchanged. `ORDER BY rid` is explicit because
   * the driving index decides the order of an unordered query, and a read the dashboard renders
   * should not reorder itself when a planner changes its mind: 200 rows through a temp b-tree cost
   * 0.009 ms, measured.
   */
  hydrate(ids: readonly MemoryId[], eligible: EligibleLabelSet): readonly MemoryItem[] {
    if (ids.length === 0 || eligible.ids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(memoryItems)
      .where(
        and(
          inArray(memoryItems.id, [...ids]),
          eqUnindexed(memoryItems.groupId, eligible.groupId),
          notRetracted(),
          inArrayUnindexed(memoryItems.labelId, [...eligible.ids]),
        ),
      )
      .orderBy(asc(memoryItems.rid))
      .all();
    return rows.map(toMemoryItem);
  }

  /**
   * Load items by rid, preserving the order the rids arrived in.
   *
   * The order matters because the caller's query already ranked them — by `valid_from DESC`, or by
   * distance — and `IN` does not preserve it. A re-sort here keeps the ranking the channel decided.
   */
  #hydrateRids(rids: readonly number[]): readonly MemoryItem[] {
    if (rids.length === 0) return [];
    const rows = this.#db
      .select()
      .from(memoryItems)
      .where(and(inArray(memoryItems.rid, [...rids]), notRetracted()))
      .all();
    const byRid = new Map(rows.map((row) => [row.rid, toMemoryItem(row)]));
    const ordered: MemoryItem[] = [];
    for (const rid of rids) {
      const item = byRid.get(rid);
      if (item !== undefined) ordered.push(item);
    }
    return ordered;
  }
}

/**
 * `status <> 'retracted'` — the predicate every base-table read needs (`04` R5, R9).
 *
 * `04` R5 says a retracted item is "**removed** from both indexes", which the FTS and vec0
 * triggers do. The base-table reads are not indexes and no trigger covers them: `recent`,
 * `bySubjects`, `byEntities` and `hydrate` query `memory_items` directly, filtering on
 * `retrieval_state <= :maxState`. Without this predicate a retracted item came back — measured at
 * `M1-T18`, which is a forgotten memory still answering questions and `04` R9's forget not
 * forgetting.
 *
 * A named helper rather than an inline comparison, so the five call sites cannot drift and a sixth
 * read has something obvious to copy.
 */
function notRetracted(): SQL {
  return sql`${memoryItems.status} <> 'retracted'`;
}

/** `?, ?, ?` for a bound list. */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/**
 * Pad an id list to a power of two with `0` (`02` §3.5).
 *
 * sqlite-vec builds a per-chunk bitmap from metadata constraints, and `02` §3.5's query shape pads
 * the `IN` list so the statement text is stable across call sites with different eligible-set
 * sizes — which is what lets the prepared statement be reused. `0` is safe as a pad because
 * `AUTOINCREMENT` starts at 1, so it can never match an interned label.
 */
export function padToPowerOfTwo(ids: readonly number[]): readonly number[] {
  if (ids.length === 0) return [];
  let size = 1;
  while (size < ids.length) size *= 2;
  return [...ids, ...Array.from({ length: size - ids.length }, () => 0)];
}

/** The open-ended sentinel `02` §3.5 uses because NULL is not filterable in a vec0 comparison. */
export { VALID_TO_OPEN_ENDED };
