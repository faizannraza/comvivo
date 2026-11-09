/**
 * `EmbeddingSpaceManager` (`02` §3.5, `04` §3.8.6).
 *
 * One vec0 table per `(provider, model, dims)`. This runs **at runtime, not as a migration**, and
 * `02` §3.5 gives the reason in one clause: "the model is configuration (`embeddings.model`)". A
 * drizzle migration is a fixed artefact shipped with a release; which embedding space a host needs
 * depends on a value they can edit, so the table has to be created when the configuration is read.
 *
 * ## The lifecycle is `04` §3.8.6's, and the states are not interchangeable
 *
 * `building → ready → active → retired`, with `failed` off `building`. Each transition means
 * something a retrieval path depends on:
 *
 *  - **`building`**: the table exists and is being backfilled. Retrieval still uses the *old*
 *    space, and new items are dual-written — so a half-built space must never be chosen for a
 *    query, which is why `activeSpace` filters on `active` alone and not on "exists".
 *  - **`ready`**: coverage is 100%, so the switch is safe but has not happened.
 *  - **`active`**: exactly one, enforced by `embedding_spaces_one_active_uq` — a *partial* unique
 *    index on `status WHERE status = 'active'`, so promoting a second space fails at the
 *    constraint. `activate` therefore retires the incumbent first, in the same transaction.
 *  - **`retired`**: `04` §3.8.6 drops the table after seven days. Dropping it here rather than on
 *    retirement is deliberate in the spec: a switch that turns out to be wrong can be reversed
 *    while the old vectors still exist.
 *
 * ## The slug is the one value that cannot be bound
 *
 * It is interpolated into `CREATE VIRTUAL TABLE`, because SQLite has no parameter for an
 * identifier — so `assertValidSpace` checks it rather than trusting it, and it comes from
 * configuration a host edits. `slugFor` derives it from the provider and model so a host never
 * writes one by hand.
 */

import type { TxToken } from '@comvivo/core';
import { type EmbeddingSpaceId, type IdGenerator, StorageError } from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';
import { and, eq, ne } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import type { Db } from '../db/drizzle.js';
import { maybeOne } from '../db/drizzle.js';
import { embeddingSpaces } from '../schema/index.js';
import {
  assertValidSpace,
  createVec0SpaceSql,
  dropVec0SpaceSql,
  type Vec0Space,
  vec0TableName,
} from './vec0.js';

/** One row of `embedding_spaces` (`02` §3.3.4). */
export interface EmbeddingSpace {
  readonly id: EmbeddingSpaceId;
  readonly provider: string;
  readonly model: string;
  readonly dims: number;
  readonly tableName: string;
  readonly slug: string;
  readonly status: 'building' | 'ready' | 'active' | 'retired' | 'failed';
  readonly backfillCursorRid: number;
  readonly createdAt: Temporal.Instant;
  readonly activatedAt: Temporal.Instant | undefined;
  readonly retiredAt: Temporal.Instant | undefined;
}

/**
 * The slug for a provider and model.
 *
 * Lower-cased, with every character outside `[a-z0-9]` folded to `_` and runs collapsed, then
 * truncated to the 40 characters `02` §3.3.4 allows. Collapsing runs matters: `bge-m3` and `bge/m3`
 * would otherwise produce different slugs for the same model, and a host who changed the spelling
 * of their configuration would trigger a full re-embed of 50 000 items for nothing.
 *
 * The dimension count is **not** in the slug. `02` §3.5 keys a space on
 * `(provider, model, dims)`, but a model has one dimension count — a change in `dims` for the same
 * model name means the model itself changed, and `ensure` refuses that rather than silently
 * creating a second table for the same name.
 */
export function slugFor(provider: string, model: string): string {
  const raw = `${provider}_${model}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
  const slug = raw.slice(0, 40).replaceAll(/_+$/g, '');
  if (slug === '') {
    throw new StorageError(
      'STORAGE_CONSTRAINT',
      `an embedding model name must contain at least one letter or digit: ${JSON.stringify(model)}`,
      {
        hint: 'Check `embeddings.model` and `embeddings.provider`: the slug names a SQL table.',
        category: 'bug',
      },
    );
  }
  return slug;
}

export interface EmbeddingSpaceManagerOptions {
  readonly db: Db;
  /** The raw connection: a vec0 table is virtual and Drizzle cannot describe or create one. */
  readonly connection: Database.Database;
  readonly ids: IdGenerator;
}

export class EmbeddingSpaceManager {
  readonly #db: Db;
  readonly #connection: Database.Database;
  readonly #ids: IdGenerator;

  constructor(options: EmbeddingSpaceManagerOptions) {
    this.#db = options.db;
    this.#connection = options.connection;
    this.#ids = options.ids;
  }

  /** The one space queries may use, or `undefined` on a fresh instance. */
  activeSpace(): EmbeddingSpace | undefined {
    const row = maybeOne(
      this.#db.select().from(embeddingSpaces).where(eq(embeddingSpaces.status, 'active')),
    );
    return row === undefined ? undefined : toSpace(row);
  }

  byModel(provider: string, model: string): EmbeddingSpace | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(embeddingSpaces)
        .where(and(eq(embeddingSpaces.provider, provider), eq(embeddingSpaces.model, model))),
    );
    return row === undefined ? undefined : toSpace(row);
  }

  list(): readonly EmbeddingSpace[] {
    return this.#db.select().from(embeddingSpaces).all().map(toSpace);
  }

  /**
   * Create the space for a model if it does not exist, returning it either way.
   *
   * **Idempotent**, because the caller is configuration loading and that happens on every boot.
   * The first call on a fresh instance creates the table and makes the space `active` directly —
   * there is nothing to backfill, so `building` would be a state with no work in it. A *second*
   * model arriving later goes in as `building`, which is `04` §3.8.6's migration.
   *
   * Refuses a dimension change for a model name it already knows. That is `04` F17 — "writes into
   * a mismatched space are refused" — and the refusal belongs here rather than at the write,
   * because the symptom at the write is a vec0 error about a vector length, which says nothing
   * about the configuration that caused it.
   */
  ensure(
    uow: TxToken,
    descriptor: { provider: string; model: string; dims: number },
  ): EmbeddingSpace {
    const existing = this.byModel(descriptor.provider, descriptor.model);
    if (existing !== undefined) {
      if (existing.dims !== descriptor.dims) {
        throw new StorageError(
          'STORAGE_CONSTRAINT',
          `embedding model ${descriptor.model} is recorded with ${String(existing.dims)} dimensions, not ${String(descriptor.dims)}`,
          {
            hint:
              'A model has one dimension count, so this means the model itself changed. Give the ' +
              'new one a distinct name in `embeddings.model`, which starts a re-embed migration ' +
              '(`04` §3.8.6) instead of corrupting the existing space.',
            category: 'bug',
          },
        );
      }
      return existing;
    }

    const space: Vec0Space = {
      slug: slugFor(descriptor.provider, descriptor.model),
      dims: descriptor.dims,
    };
    assertValidSpace(space);
    const incumbent = this.activeSpace();
    // A fresh instance has nothing to backfill, so the first space is `active` immediately. A
    // later one starts `building`: `04` §3.8.6 keeps retrieval on the old space until coverage is
    // complete, and a space that went straight to `active` with no vectors would answer every
    // query with nothing.
    const status = incumbent === undefined ? 'active' : 'building';

    for (const statement of createVec0SpaceSql(space)) this.#connection.exec(statement);

    const row = this.#db
      .insert(embeddingSpaces)
      .values({
        id: this.#ids.next('emb'),
        provider: descriptor.provider,
        model: descriptor.model,
        dims: descriptor.dims,
        tableName: vec0TableName(space.slug),
        status,
        createdAt: uow.now,
        activatedAt: status === 'active' ? uow.now : undefined,
      })
      .returning()
      .get();
    return toSpace(row);
  }

  /**
   * Promote a `ready` space, retiring the incumbent in the same transaction.
   *
   * Retire first, then promote: `embedding_spaces_one_active_uq` is a partial unique index
   * evaluated per statement, so the other order fails on the second row. `04` §3.8.6 calls this
   * "an atomic switch … (one txn) + eligible-set/vec cache reset"; the cache reset is the caller's,
   * because the caches live in `engine`.
   *
   * Refuses a space that is not `ready`. `building` means coverage is incomplete, and promoting it
   * would make every memory not yet backfilled invisible to vector search — silently, since an
   * empty KNN result is indistinguishable from "nothing similar".
   */
  activate(uow: TxToken, id: EmbeddingSpaceId): EmbeddingSpace {
    const row = maybeOne(this.#db.select().from(embeddingSpaces).where(eq(embeddingSpaces.id, id)));
    if (row === undefined) {
      throw new StorageError('STORAGE_CONSTRAINT', `no embedding space ${id}`, {
        hint: 'This is a bug: activate the space `ensure` returned.',
        category: 'bug',
      });
    }
    if (row.status !== 'ready' && row.status !== 'active') {
      throw new StorageError(
        'STORAGE_CONSTRAINT',
        `embedding space ${id} is ${row.status}, not ready`,
        {
          hint:
            'A space is promotable only at 100% coverage (`04` §3.8.6). Promoting a `building` ' +
            'space would hide every memory it has not backfilled from vector search.',
          category: 'bug',
        },
      );
    }
    if (row.status === 'active') return toSpace(row);

    this.#db
      .update(embeddingSpaces)
      .set({ status: 'retired', retiredAt: uow.now })
      .where(and(eq(embeddingSpaces.status, 'active'), ne(embeddingSpaces.id, id)))
      .run();
    const promoted = this.#db
      .update(embeddingSpaces)
      .set({ status: 'active', activatedAt: uow.now })
      .where(eq(embeddingSpaces.id, id))
      .returning()
      .get();
    return toSpace(promoted);
  }

  /** Record how far a backfill has got (`04` §3.8.6's resumable cursor). */
  setBackfillCursor(_uow: TxToken, id: EmbeddingSpaceId, rid: number): void {
    this.#db
      .update(embeddingSpaces)
      .set({ backfillCursorRid: rid })
      .where(eq(embeddingSpaces.id, id))
      .run();
  }

  /** Mark a space `ready` (coverage complete) or `failed` (`04` §3.8.6). */
  setStatus(_uow: TxToken, id: EmbeddingSpaceId, status: 'ready' | 'failed'): EmbeddingSpace {
    const row = this.#db
      .update(embeddingSpaces)
      .set({ status })
      .where(eq(embeddingSpaces.id, id))
      .returning()
      .get();
    return toSpace(row);
  }

  /**
   * Drop a retired space's table (`04` §3.8.6, after seven days).
   *
   * Refuses anything but `retired`, which is the whole safety of the seven-day delay: a switch
   * that turns out to be wrong is reversible only while the old vectors still exist.
   */
  drop(_uow: TxToken, id: EmbeddingSpaceId): void {
    const row = maybeOne(this.#db.select().from(embeddingSpaces).where(eq(embeddingSpaces.id, id)));
    if (row === undefined) return;
    if (row.status !== 'retired') {
      throw new StorageError(
        'STORAGE_CONSTRAINT',
        `embedding space ${id} is ${row.status}, so its table may not be dropped`,
        {
          hint:
            'Only a retired space is droppable. The delay before dropping is what makes a wrong ' +
            'switch reversible (`04` §3.8.6).',
          category: 'bug',
        },
      );
    }
    const slug = row.tableName.replace(/^vec_memory_/, '');
    for (const statement of dropVec0SpaceSql({ slug, dims: row.dims })) {
      this.#connection.exec(statement);
    }
    this.#db.delete(embeddingSpaces).where(eq(embeddingSpaces.id, id)).run();
  }
}

function toSpace(row: typeof embeddingSpaces.$inferSelect): EmbeddingSpace {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    dims: row.dims,
    tableName: row.tableName,
    slug: row.tableName.replace(/^vec_memory_/, ''),
    status: row.status,
    backfillCursorRid: row.backfillCursorRid,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt ?? undefined,
    retiredAt: row.retiredAt ?? undefined,
  };
}
