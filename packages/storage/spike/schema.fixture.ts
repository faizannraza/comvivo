/**
 * A throwaway schema whose only job is to make `drizzle-kit generate` prove what it emits.
 *
 * `02` §3.3 depends on three things drizzle-kit has to get right, and all three are **correctness**
 * features rather than optimisations:
 *
 *  - a **partial unique index**, which is how "one primary conversation per group" and "one live
 *    group per name" are enforced;
 *  - an **expression index**, for case-insensitive and derived lookups;
 *  - a **CHECK constraint**, which is the last line of defence on a value zod should already have
 *    rejected.
 *
 * If the generator silently dropped any of them, the migration would apply cleanly and the
 * constraint would simply not exist — the worst possible outcome, because every test that inserts
 * valid data would still pass. `M1-T11` asserts the same things about the real schema; this
 * establishes that the tool can express them at all.
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const spikeGroups = sqliteTable(
  'spike_groups',
  {
    rid: integer('rid').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    name: text('name').notNull(),
    archivedAt: integer('archived_at'),
  },
  (t) => [
    uniqueIndex('spike_groups_live_name_idx').on(t.name).where(sql`${t.archivedAt} is null`),
    index('spike_groups_name_lower_idx').on(sql`lower(${t.name})`),
    check('spike_groups_name_not_blank', sql`length(trim(${t.name})) > 0`),
  ],
);
