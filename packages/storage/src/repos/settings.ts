/**
 * The settings repository (ADR-014, `02` §3.3.8, `01` §14 A14).
 *
 * `(scope, key) → JSON`, with the registry in `09` owning what a key means. This module moves
 * strings and enforces one rule: **a host-only key never lands in the database** (A14). A value
 * stored here is readable by anyone who can read the database file, which includes a backup
 * restored onto another machine — so a passphrase or a platform token in this table would survive
 * every boundary `08` draws around secrets.
 *
 * The rule is enforced on the **write**, not only on the read, and that direction matters: a
 * forbidden key that was already written would be filtered on read and still sit in the file, in
 * every backup taken since. Refusing the write is what keeps the file clean.
 */
import type {
  Setting,
  SettingScope,
  SettingsReader,
  SettingsRepository,
  TxToken,
} from '@comvivo/core';
import { unpersistableSettingReason } from '@comvivo/core';
import { StorageError } from '@comvivo/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { type Db, exactlyOne, maybeOne } from '../db/drizzle.js';
import { settings } from '../schema/index.js';
import { toSetting } from './rows.js';

export class SqliteSettingsRepository implements SettingsReader, SettingsRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get(scope: SettingScope, key: string): string | undefined {
    const row = maybeOne(
      this.#db
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.scope, scope), eq(settings.key, key))),
    );
    return row?.value;
  }

  byScope(scope: SettingScope): readonly Setting[] {
    const rows = this.#db
      .select()
      .from(settings)
      .where(eq(settings.scope, scope))
      .orderBy(asc(settings.key))
      .all();
    return rows.map(toSetting);
  }

  /**
   * The first scope in the chain that has a value.
   *
   * One statement with `IN`, then a lookup, rather than one query per scope: a chain is three or
   * four scopes and a settings screen resolves dozens of keys, so the round trips add up. The
   * chain's **order** decides the answer, and `IN` does not preserve it — hence the map.
   */
  resolve(scopes: readonly SettingScope[], key: string): Setting | undefined {
    if (scopes.length === 0) return undefined;
    const rows = this.#db
      .select()
      .from(settings)
      .where(and(inArray(settings.scope, [...scopes]), eq(settings.key, key)))
      .all();
    if (rows.length === 0) return undefined;
    const byScope = new Map(rows.map((row) => [row.scope, row]));
    for (const scope of scopes) {
      const row = byScope.get(scope);
      if (row !== undefined) return toSetting(row);
    }
    return undefined;
  }

  /**
   * Upsert, refusing a host-only key (A14).
   *
   * Throws rather than returning a `WriteResult`: a caller cannot usefully branch on "you tried to
   * store a credential", and the loud failure is the point. `config.host_only_rejected` is the log
   * event for the *read* side of the same rule, which exists because an older database may already
   * hold such a row.
   */
  set(uow: TxToken, scope: SettingScope, key: string, value: string, updatedBy?: string): Setting {
    const refusal = unpersistableSettingReason(key);
    if (refusal !== undefined) {
      throw new StorageError('STORAGE_CONSTRAINT', `refused to store ${key}: ${refusal}`, {
        hint:
          "Host-only keys live in the environment and in `08`'s keyfile layout, never in the " +
          'database — a value here is in every backup of it (A14).',
        category: 'bug',
      });
    }
    const row = exactlyOne(
      this.#db
        .insert(settings)
        .values({
          scope,
          key,
          value,
          updatedAt: uow.now,
          ...(updatedBy === undefined ? {} : { updatedBy }),
        })
        .onConflictDoUpdate({
          target: [settings.scope, settings.key],
          set: {
            value,
            updatedAt: uow.now,
            // `null` rather than omitted: an update with no `updatedBy` means nobody is named, and
            // leaving the previous one would attribute this change to whoever made the last.
            updatedBy: updatedBy ?? null,
          },
        })
        .returning(),
      'the setting',
    );
    return toSetting(row);
  }

  unset(_uow: TxToken, scope: SettingScope, key: string): boolean {
    const removed = this.#db
      .delete(settings)
      .where(and(eq(settings.scope, scope), eq(settings.key, key)))
      .returning({ key: settings.key })
      .all();
    return removed.length > 0;
  }

  clearScope(_uow: TxToken, scope: SettingScope): number {
    const removed = this.#db
      .delete(settings)
      .where(eq(settings.scope, scope))
      .returning({ key: settings.key })
      .all();
    return removed.length;
  }
}
