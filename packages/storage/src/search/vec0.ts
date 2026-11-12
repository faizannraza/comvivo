/**
 * The vec0 per-space factory (`02` §3.5).
 *
 * One vec0 virtual table per `(provider, model, dims)`, created **at runtime** rather than by a
 * drizzle migration, because the embedding model is configuration (`embeddings.model`) and a
 * migration cannot know it. `M1-T18`'s `EmbeddingSpaceManager` owns the lifecycle — create,
 * backfill, activate, retire; this module owns the SQL, so the DDL is testable without a manager
 * and identical wherever it is issued.
 *
 * ## Why a table per space rather than a column per model
 *
 * Changing the embedding model is then a backfill into a new table followed by one `UPDATE` of
 * `embedding_spaces.status`, with the old space still answering queries throughout. The
 * alternative — re-embedding in place — makes search either wrong or unavailable for the duration,
 * and `04` §3.8.6's build → ready → active → retired states exist to describe exactly this.
 *
 * ## Why the metadata columns are what they are
 *
 * sqlite-vec resolves metadata predicates into a bitmap **before** computing distances (verified
 * in `vec0Filter_knn_chunks_iter`, `02` §3.2.6 R5). So every filter that can be pushed down must
 * be a metadata column, or the engine ranks rows it is about to discard:
 *
 *  - `group_id` is the **partition key**, which is I4 isolation and the largest single win;
 *  - `label_id` carries eligibility, so `02` §3.2's eligible-set filter is part of the scan;
 *  - `state` mirrors `memory_items.retrieval_state` (`04` R5), so superseded and archived items
 *    are excluded without a join;
 *  - `valid_to_ms` bounds world-time validity, and uses a **sentinel** rather than `NULL` because
 *    `NULL` is not filterable in a vec0 metadata comparison.
 *
 * ## Three measured constraints (`02` §3.5, from `M1-T2`)
 *
 * They shape the repository rather than this SQL, and are repeated here because they are easy to
 * rediscover painfully: a KNN query may only `ORDER BY distance`; `trusted_schema` must stay
 * **ON**, or vec0 DML inside a trigger is refused at *run* time while the DDL is accepted — so the
 * delete trigger below would look installed and throw on the first retraction; and every integer
 * must bind as a `BigInt`.
 *
 * That last one is **broader than `02` §3.5 states**, measured at `M1-T13`. The spec says a
 * *rowid* must bind as a SQLite integer. In fact every `INTEGER` **metadata** column must as well:
 * better-sqlite3 binds a plain JavaScript `number` as a float, and vec0 rejects
 * `label_id`, `state` and `valid_to_ms` with `Expected integer for INTEGER metadata column
 * label_id, received FLOAT` — a different error from the rowid's, so a repository that fixed only
 * the rowid would hit it on the next column. `M1-T18`'s insert path binds all four as `BigInt`.
 */
import { StorageError } from '@comvivo/shared';

/**
 * `02` §3.5: the open-ended sentinel for `valid_to_ms`.
 *
 * Equal to `MAX_EPOCH_MS` in `_columns.ts` — Temporal's own upper bound — so "no end" sorts after
 * every real instant and `valid_to_ms > :nowMs` is true for it. `NULL` cannot be used: a vec0
 * metadata comparison against `NULL` is not a filter.
 */
export const VALID_TO_OPEN_ENDED = 8_640_000_000_000_000;

/** `02` §3.5: 256 keeps a partition's preallocation at ~384 KB instead of 1.5 MB. */
export const VEC0_CHUNK_SIZE = 256;

/** `02` §3.5: the cap that protects latency. `04` asks for ≤ 64. */
export const VEC0_MAX_K = 200;

/** The slug shape `02` §3.3.4 requires of `embedding_spaces.table_name`. */
export const VEC0_SLUG_PATTERN = /^[a-z0-9_]{1,40}$/;

/** A vec0 space: the slug that names its table and the dimension count of its vectors. */
export interface Vec0Space {
  /** `[a-z0-9_]{1,40}`, derived from provider, model and dims by `M1-T18`. */
  readonly slug: string;
  readonly dims: number;
}

/** The table name for a space, as stored in `embedding_spaces.table_name`. */
export function vec0TableName(slug: string): string {
  return `vec_memory_${slug}`;
}

/**
 * Validate a space before its slug reaches a `CREATE VIRTUAL TABLE`.
 *
 * The slug is interpolated into DDL — it cannot be bound as a parameter, because SQLite has no
 * parameter for an identifier — so it is the one value here that must be checked rather than
 * trusted. It is derived from configuration (`embeddings.model`), which a host edits.
 *
 * `chunk_size` must be divisible by 8 (`02` §3.5) and `dims` has to be a positive integer; both
 * are asserted so a misconfigured model fails at space creation with an explanation rather than
 * inside sqlite-vec.
 */
export function assertValidSpace(space: Vec0Space): void {
  if (!VEC0_SLUG_PATTERN.test(space.slug)) {
    throw new StorageError(
      'STORAGE_CONSTRAINT',
      `an embedding space slug must match ${String(VEC0_SLUG_PATTERN)}`,
      {
        hint:
          'The slug names a SQL table and is built from the embedding provider and model, so it ' +
          'must be lower-case letters, digits and underscores. Check `embeddings.model`.',
        category: 'bug',
        detail: { slug: space.slug },
      },
    );
  }
  if (!Number.isInteger(space.dims) || space.dims <= 0 || space.dims > 4096) {
    throw new StorageError(
      'STORAGE_CONSTRAINT',
      'an embedding space needs a positive integer dimension count of at most 4096',
      {
        hint: 'Check the configured embedding model: its dimension count is what this comes from.',
        category: 'bug',
        detail: { dims: space.dims },
      },
    );
  }
}

/**
 * `CREATE VIRTUAL TABLE` for one space (`02` §3.5).
 *
 * `embedding FLOAT[d]` holds unit-normalised vectors, so the default L2 metric gives the same
 * ordering as cosine — which is why `02` §3.5 can expose `similarity = 1 − d²/2` without a second
 * index.
 */
export function createVec0TableSql(space: Vec0Space): string {
  assertValidSpace(space);
  return `CREATE VIRTUAL TABLE ${vec0TableName(space.slug)} USING vec0(
  rid INTEGER PRIMARY KEY,
  group_id TEXT PARTITION KEY,
  embedding FLOAT[${String(space.dims)}],
  label_id INTEGER,
  kind TEXT,
  state INTEGER,
  valid_to_ms INTEGER,
  chunk_size=${String(VEC0_CHUNK_SIZE)}
)`;
}

/**
 * The two triggers that keep a space from serving a stale vector (`02` §3.5).
 *
 * Both **delete** rather than update, which avoids depending on vec0's `UPDATE` semantics (U3) —
 * and the update trigger's job is therefore to *invalidate*, not to maintain. `02` §3.5 gives the
 * repository the three steps that follow: read the embedding, update the base row (the trigger
 * fires), re-insert with the saved vector and the new metadata. That costs a lookup, not a
 * re-embed, and if the lookup finds nothing the repository sets `embedding_state='pending'`.
 *
 * A retracted memory simply stays out, because the re-insert is conditional and the trigger has
 * already removed it.
 *
 * `NEW.valid_to IS NOT OLD.valid_to` uses the null-safe comparison: `<>` would yield `NULL` when
 * a validity window is opened or closed, and a `WHEN` clause evaluating to `NULL` does not fire —
 * so the stale vector would keep its old `valid_to_ms`.
 */
export function createVec0TriggersSql(space: Vec0Space): readonly string[] {
  assertValidSpace(space);
  const table = vec0TableName(space.slug);
  return [
    `CREATE TRIGGER trg_memory_items_vec_${space.slug}_ad AFTER DELETE ON memory_items
BEGIN DELETE FROM ${table} WHERE rid = OLD.rid; END`,
    `CREATE TRIGGER trg_memory_items_vec_${space.slug}_au AFTER UPDATE OF status, label_id, valid_to, retrieval_state ON memory_items
WHEN NEW.status = 'retracted' OR NEW.label_id <> OLD.label_id OR NEW.valid_to IS NOT OLD.valid_to
     OR NEW.retrieval_state <> OLD.retrieval_state
BEGIN DELETE FROM ${table} WHERE rid = OLD.rid; END`,
  ];
}

/** Everything needed to bring one space into existence, in order. */
export function createVec0SpaceSql(space: Vec0Space): readonly string[] {
  return [createVec0TableSql(space), ...createVec0TriggersSql(space)];
}

/** Drop a space and its triggers, for `04` §3.8.6's `retired` transition. */
export function dropVec0SpaceSql(space: Vec0Space): readonly string[] {
  assertValidSpace(space);
  return [
    `DROP TRIGGER IF EXISTS trg_memory_items_vec_${space.slug}_au`,
    `DROP TRIGGER IF EXISTS trg_memory_items_vec_${space.slug}_ad`,
    `DROP TABLE IF EXISTS ${vec0TableName(space.slug)}`,
  ];
}
