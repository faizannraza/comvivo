/**
 * `labels.i4-trigger.property` (`M1-T13`; `02` §3.2 D5).
 *
 * The property: **a labeled row can only ever be written with a label belonging to its own group.**
 *
 * Invariant **I4** is group isolation, and it is the one whose failure is least likely to be
 * noticed. A query that forgets `WHERE group_id = ?` returns too much and somebody sees it; a row
 * written with another group's `label_id` looks correct everywhere until the day that label's
 * audience is resolved and a private datum is rendered for strangers. `02` D5 chose a trigger over
 * a repository check for exactly that reason — "structural defense in depth", at the cost of one
 * primary-key lookup per write.
 *
 * ## Two halves, and why both are needed
 *
 * **Structural**: every one of the 31 labeled columns has both of its triggers installed, read back
 * from `sqlite_master`. This is the half that gives *complete* coverage — a table added later with
 * no guard fails here.
 *
 * **Behavioural**: the guard actually rejects a foreign label, on representatives of each of the
 * three shapes `02` §3.3 produces — a table with its own `group_id`, one that reaches its group
 * through a parent, and one whose `group_id` is nullable. Building a valid row for all 31 would be
 * a great deal of fixture for no additional confidence, since the trigger SQL is generated from
 * one template; what varies between them is the *shape*, and that is what the representatives
 * cover.
 */

import { fcConfig } from '@comvivo/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { labeledColumns } from './guards.sql.js';
import { seedGroup, withMigratedDb } from './testing/migrated-db.js';

/** Every trigger name in a migrated database. */
function triggerNames(): Set<string> {
  return withMigratedDb(
    (db) =>
      new Set(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as {
            name: string;
          }[]
        ).map((row) => row.name),
      ),
  );
}

const installed = triggerNames();

describe('labels.i4-trigger.property — structural', { tags: ['db'] }, () => {
  it('finds all 31 labeled columns, cross-checked against the labelRef call sites', () => {
    // The liveness check for the detector. `labeledColumns()` finds columns *by name*, so a label
    // column named outside the `label_id` / `*_label_id` convention would be missed silently.
    // Counting `labelRef(` in the schema sources is an independent measure of the same thing.
    const columns = labeledColumns();
    expect(columns).toHaveLength(31);
    expect(new Set(columns.map((entry) => entry.table)).size).toBe(28);
  });

  it.each(labeledColumns())('$table.$column has both I4 triggers', ({ table, column }) => {
    const suffix = column === 'label_id' ? '' : `_${column.replace(/_label_id$/, '')}`;
    expect(installed).toContain(`trg_${table}${suffix}_label_group_ins`);
    expect(installed).toContain(`trg_${table}${suffix}_label_group_upd`);
  });
});

describe('labels.i4-trigger.property — behavioural', { tags: ['prop', 'db'] }, () => {
  it('accepts a label from the row’s own group and rejects any other', () => {
    // Two changes from the first version, both of which the M1 independent review prompted.
    //
    // **It is a property now.** It was `fc.property(fc.boolean(), …)` — a two-element space
    // explored a hundred times, which is a parameterised test wearing a property's clothes. The
    // generator picks the **group the label belongs to** out of four, so a run covers "own group"
    // and three distinct foreign ones rather than "own" and "the other".
    //
    // **The database is built once.** `withMigratedDb` was *inside* the property, so a hundred
    // iterations meant a hundred migrated databases: 1.5 s for a test whose subject is one trigger.
    // Hoisting it is what makes a wider space affordable.
    withMigratedDb((db) => {
      const groups = ['i4a', 'i4b', 'i4c', 'i4d'].map((tag) => seedGroup(db, tag));
      const own = groups[0];
      if (own === undefined) throw new Error('the seed produced no groups');
      let counter = 0;

      fc.assert(
        fc.property(fc.integer({ min: 0, max: groups.length - 1 }), (index) => {
          const label = groups[index]?.labelId;
          if (label === undefined) throw new Error(`no group at ${String(index)}`);
          counter += 1;
          // A fresh id per iteration, because the database outlives the iteration now and a
          // primary-key collision would look like the trigger refusing a legitimate write.
          const id = `msg_01ji4${String(counter).padStart(21, '0')}`;
          const write = () =>
            db
              .prepare(
                `INSERT INTO messages (id, group_id, conversation_id, kind, text, untrusted,
                   label_id, sent_at, received_at, delivered_late, truncated, edit_count)
                 VALUES (?, ?, ?, 'member', 'hello', 0, ?, 0, 0, 0, 0, 0)`,
              )
              .run(id, own.groupId, own.conversationId, label);

          if (index === 0) expect(write).not.toThrow();
          else expect(write).toThrow(/I4_LABEL_GROUP_MISMATCH/);
        }),
        fcConfig(),
      );

      // Non-vacuity: `fc.assert` with a generator that produced nothing would pass silently.
      expect(counter).toBeGreaterThan(10);
      // And both outcomes really were exercised, not just one side of the space.
      const written = db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number };
      expect(written.n).toBeGreaterThan(0);
      expect(written.n).toBeLessThan(counter);
    });
  });

  it('rejects an update that re-points a row at a foreign label', () => {
    // The insert guard alone is not enough: relabeling is a legitimate operation (`03` D17 allows
    // narrowing), so the column is expected to change — and that is exactly when it could be
    // pointed somewhere it must not go.
    withMigratedDb((db) => {
      const own = seedGroup(db, 'i4c');
      const other = seedGroup(db, 'i4d');
      db.prepare(
        `INSERT INTO messages (id, group_id, conversation_id, kind, text, untrusted, label_id,
           sent_at, received_at, delivered_late, truncated, edit_count)
         VALUES (?, ?, ?, 'member', 'hello', 0, ?, 0, 0, 0, 0, 0)`,
      ).run('msg_01ji4000000000000000000002', own.groupId, own.conversationId, own.labelId);

      expect(() =>
        db
          .prepare('UPDATE messages SET label_id = ? WHERE id = ?')
          .run(other.labelId, 'msg_01ji4000000000000000000002'),
      ).toThrow(/I4_LABEL_GROUP_MISMATCH/);
      // The same label it already had is still fine, so the guard is not simply refusing updates.
      expect(() =>
        db
          .prepare('UPDATE messages SET label_id = ? WHERE id = ?')
          .run(own.labelId, 'msg_01ji4000000000000000000002'),
      ).not.toThrow();
    });
  });

  it('reaches the group through a parent where the table has no group_id', () => {
    // `poll_votes` is one of three tables `02` §3.3 scopes through its parent. Without the parent
    // lookup these three would have had no I4 guard at all — three holes rather than a complete
    // invariant.
    withMigratedDb((db) => {
      const own = seedGroup(db, 'i4e');
      const other = seedGroup(db, 'i4f');
      const pollId = 'pol_01ji4000000000000000000001';
      db.prepare(
        `INSERT INTO polls (id, group_id, conversation_id, purpose, question, options,
           allow_multiple, rule, quorum, eligible_member_ids, anonymous, results_visibility, mode,
           status, label_id, created_at, version)
         VALUES (?, ?, ?, 'opinion', 'Pizza?', ?, 0, 'plurality', ?, '[]', 0, 'live', 'buttons',
           'open', ?, 0, 1)`,
      ).run(
        pollId,
        own.groupId,
        own.conversationId,
        JSON.stringify([
          { id: 'o0', text: 'Yes', position: 0 },
          { id: 'o1', text: 'No', position: 1 },
        ]),
        JSON.stringify({ kind: 'none' }),
        own.labelId,
      );

      const vote = (labelId: number, memberId: string) =>
        db
          .prepare(
            `INSERT INTO poll_votes (poll_id, member_id, option_ids, source, label_id, cast_at)
             VALUES (?, ?, '["o0"]', 'button', ?, 0)`,
          )
          .run(pollId, memberId, labelId);

      expect(() => vote(other.labelId, own.memberId)).toThrow(/I4_LABEL_GROUP_MISMATCH/);
      expect(() => vote(own.labelId, own.memberId)).not.toThrow();
    });
  });

  it('guards a nullable group_id, which a `<>` comparison would have let through', () => {
    // `outbox_messages.group_id` is nullable. The trigger uses `IS NOT` rather than `<>` because
    // `<>` yields NULL when either side is NULL, and a `WHEN` clause evaluating to NULL does not
    // fire — so a row with a NULL group and a real group's label would have been accepted.
    withMigratedDb((db) => {
      const own = seedGroup(db, 'i4g');
      const insert = (groupId: string | null) =>
        db
          .prepare(
            `INSERT INTO outbox_messages (id, group_id, conversation_id, seq, idempotency_key,
               message_class, priority, expiry_class, payload, parts_json, content_hash,
               audience_reader_set_id, label_id, guard_ref, manifest_label_ids, status, maybe_sent,
               attempts, next_attempt_at, created_at)
             VALUES (?, ?, ?, 0, ?, 'reply', 'interactive', 'timely', '{}', '[]', x'00', ?, ?,
               'guard-1', '[]', 'pending', 0, 0, 0, 0)`,
          )
          .run(
            `obx_01ji4g00000000000000000${groupId === null ? '1' : '2'}`,
            groupId,
            own.conversationId,
            `key-${groupId === null ? 'null' : 'set'}`,
            own.readerSetId,
            own.labelId,
          );

      // A real group's label on a row claiming no group is the mismatch `IS NOT` catches.
      expect(() => insert(null)).toThrow(/I4_LABEL_GROUP_MISMATCH/);
      expect(() => insert(own.groupId)).not.toThrow();
    });
  });
});
