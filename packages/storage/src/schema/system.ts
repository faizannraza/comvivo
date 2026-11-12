/**
 * Instance-wide bookkeeping: settings, metadata and deletion tombstones (`02` §3.3.8).
 *
 * Nothing in this file holds group content. All three tables are about the installation itself,
 * which is why none of them cascades from `groups` — and in the case of `deletions`, must not.
 */
import { AuditActorSchema, DeletionProgressSchema } from '@comvivo/core';
import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { instantMs, jsonOf, tid, updatedAt } from './_columns.js';

/**
 * Runtime settings persisted in the database (ADR-014; `01` §14 A14).
 *
 * The scope string is the whole design: `'_instance'`, a `grp_…`, `'member:<memberId>'` or
 * `'person:<personId>'`. One table with a scope beats four tables because every read is "the
 * effective value of key K for this member", which is a precedence walk over at most four rows of
 * one table — and because `09`'s settings registry can then validate and describe every setting in
 * one place regardless of where it applies.
 *
 * A14 draws the line this table must not cross: **host-only keys never live here.** The database
 * path, the keyfile location, the bind address and anything else needed to *open* the database
 * cannot be stored inside it, and `08`'s host-only config is where those live. The leading
 * underscore in `'_instance'` keeps that scope from ever colliding with a TypeID.
 */
export const settings = sqliteTable(
  'settings',
  {
    /** `'_instance'` | `grp_…` | `'member:<memberId>'` | `'person:<personId>'`. */
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    /** JSON, validated by `09`'s settings registry — never by this column. */
    value: text('value').notNull(),
    updatedAt: updatedAt(),
    updatedBy: text('updated_by'),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] })],
);

/**
 * Key/value metadata about the installation (`02` §3.3.8).
 *
 * Distinct from `settings` because nothing here is a user preference: `tzdata_version` drives
 * `02` §3.13.7's recomputation of every derived instant when the platform's timezone database
 * changes, `instance_salt_check` detects a keyfile paired with the wrong database, and
 * `created_by_version` tells the migration runner which build wrote this file.
 */
export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: updatedAt(),
});

/**
 * A content-free tombstone for a completed or in-flight deletion (`02` §3.3.8, D18).
 *
 * Two properties make this table what it is.
 *
 * **It survives what it describes.** `group_id` carries **no foreign key**, and the comment in
 * `02` §3.3.8 says why: the row outlives the group. A tombstone whose whole purpose is to record
 * that a group was deleted cannot cascade away when the group row goes.
 *
 * **It is the resume point.** `02` D18 rejects the one-giant-cascade design because a million-row
 * delete would block the event loop for seconds, so a purge runs as a resumable chunked job and
 * `progress` holds the step and cursor it resumes from (`02` §3.13.4, §3.13.5). After a crash
 * mid-purge, this column is the difference between finishing the deletion and a half-deleted group.
 *
 * `subject_ref` is an opaque id and `requested_by` is an `AuditActor`, so the row records *that* a
 * deletion happened and who asked, and never what was deleted.
 */
export const deletions = sqliteTable(
  'deletions',
  {
    id: tid('del')('id').primaryKey(),
    scope: text('scope', {
      enum: ['group', 'person', 'member_departure', 'memory', 'conversation'],
    }).notNull(),
    /** The deleted id, opaque. Not a foreign key: the subject is gone. */
    subjectRef: text('subject_ref').notNull(),
    /**
     * No foreign key: this row survives the group's deletion (`02` §3.3.8).
     *
     * `tid('grp')` all the same — identical DDL (`text`), and it gives the column the group-id type
     * and the read-time validation every other `group_id` has. Declared as plain `text` first,
     * which made `DeletionRecord.groupId` a `string` that had to be cast on the way out; a cast in
     * a mapper is the place a wrong id gets in (`M1-T26`).
     */
    groupId: tid('grp')('group_id'),
    requestedBy: jsonOf(AuditActorSchema, 'deletions.requested_by')('requested_by').notNull(),
    status: text('status', { enum: ['pending', 'running', 'completed'] }).notNull(),
    /** The step and cursor a crashed purge resumes from (`02` D18, §3.13.4). */
    progress: jsonOf(DeletionProgressSchema, 'deletions.progress')('progress').notNull(),
    requestedAt: instantMs('requested_at').notNull(),
    completedAt: instantMs('completed_at'),
  },
  (t) => [index('deletions_status_idx').on(t.status)],
);
