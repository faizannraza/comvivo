/**
 * Invariant I6 — exactly-once intent — as a database constraint (`01` §1, `02` §3.3).
 *
 * I6 says a tool effect and an outbound message are each applied once, however many times a turn
 * is retried or a process restarts. Everything above the database cooperates with that, but the
 * thing that makes it *true* is one unique index per table: `turn_effects.idempotency_key` and
 * `outbox_messages.idempotency_key`. A retry that recomputes the same key gets a constraint
 * failure instead of a second charge, a second reminder, a second message.
 *
 * Those two indexes had no test. `ddl.int.test.ts` pins the **partial** indexes exactly, and both
 * of these are total, so neither appeared in that list; `tables.test.ts` captures `config.checks`
 * and `config.indexes` and not `.unique()`. Deleting `.unique()` from both columns in
 * `schema/runtime.ts` therefore left the whole suite green while I6 was gone. Found by the M1
 * independent review.
 *
 * Two halves, because the index can fail in two ways:
 *
 *  1. **It is not there.** Pinned structurally, as the full list of 40 unique index names, so
 *     dropping any `.unique()` anywhere in the schema fails here and not only for these two.
 *  2. **It is there and does not bite.** Proven behaviourally, by inserting the same key twice.
 *     A unique index on the wrong column, or on a nullable column where every row is distinct,
 *     passes half 1 and protects nothing.
 */
import type Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { seedGroup, withMigratedDb } from './testing/migrated-db.js';

/** Every named unique index in the live schema. */
function uniqueIndexes(db: Database.Database): string[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql LIKE 'CREATE UNIQUE%'")
    .all() as { name: string }[];
  return tables.map((row) => row.name).sort();
}

/** A turn, which `turn_effects` needs by foreign key. */
function seedTurn(db: Database.Database, seeded: ReturnType<typeof seedGroup>, id: string): string {
  db.prepare(
    `INSERT INTO turns (id, group_id, conversation_id, kind, trigger_message_ids,
       audience_reader_set_id, status, boot_id, root_turn_id, started_at, deadline_at)
     VALUES (?, ?, ?, 'reply', '[]', ?, 'running', 'boot', ?, 0, 1000)`,
  ).run(id, seeded.groupId, seeded.conversationId, seeded.readerSetId, id);
  return id;
}

describe('I6 is a unique index, not a convention', () => {
  it('declares exactly these 40 unique indexes', () => {
    // The whole list rather than the two this file is named for: a unique index is the only thing
    // standing behind every "exactly one of these" rule in `02` §3.3 — one primary conversation
    // per group, one active embedding space, one audit row per sequence number — and all 40 were
    // unpinned for the same reason.
    const names = withMigratedDb(uniqueIndexes);
    expect(names).toEqual([
      'audit_chain_seq_uq',
      'blobs_storage_addr_unique',
      'channel_identities_platform_uq',
      'constitution_versions_group_version_uq',
      'conversations_one_primary_uq',
      'conversations_platform_uq',
      'decisions_id_unique',
      'decisions_memory_uq',
      'embedding_spaces_one_active_uq',
      'embedding_spaces_table_name_unique',
      'events_ics_uid_unique',
      'events_id_unique',
      'events_subscription_src_rec_uq',
      'events_subscription_src_uq',
      'ics_feed_tokens_token_hash_unique',
      'instance_singleton_unique',
      'job_schedules_owner_uq',
      'jobs_debounce_uq',
      'jobs_idempotency_uq',
      'labels_group_key_uq',
      'list_items_id_unique',
      'lists_default_kind_uq',
      'lists_group_name_uq',
      'members_group_handle_uq',
      'members_group_person_uq',
      'memory_items_id_unique',
      'messages_client_id_uq',
      'messages_conv_platform_uq',
      'messages_dedupe_uq',
      'messages_id_unique',
      'outbox_messages_idempotency_key_unique',
      'plans_id_unique',
      'polls_id_unique',
      'reader_sets_group_key_uq',
      'reminder_firings_occurrence_uq',
      'tasks_id_unique',
      'tasks_rotation_occurrence_uq',
      'turn_effects_idempotency_key_unique',
      'turn_effects_turn_seq_uq',
      'turn_traces_turn_id_unique',
    ]);
  });

  it('refuses a second turn effect with the same idempotency key', () => {
    withMigratedDb((db) => {
      const seeded = seedGroup(db, 'i6a');
      const turn = seedTurn(db, seeded, 'trn_01ji6a0000000000000000000');
      const insert = db.prepare(
        `INSERT INTO turn_effects (id, turn_id, root_turn_id, group_id, seq, tool_name,
           idempotency_key, status, summary_key, summary_params, entity_refs, label_id)
         VALUES (?, ?, ?, ?, ?, 'send_message', ?, 'committed', 'k', '{}', '[]', ?)`,
      );
      const run = (id: string, seq: number, key: string): void => {
        insert.run(id, turn, turn, seeded.groupId, seq, key, seeded.labelId);
      };

      run('tef_01ji6a0000000000000000001', 1, 'once');
      // A different `seq`, so the composite `turn_effects_turn_seq_uq` is not what refuses it —
      // otherwise this test would pass with the idempotency index deleted.
      expect(() => {
        run('tef_01ji6a0000000000000000002', 2, 'once');
      }).toThrow(/UNIQUE constraint failed: turn_effects\.idempotency_key/);

      // And the retry really is the only thing refused: a fresh key is accepted.
      expect(() => {
        run('tef_01ji6a0000000000000000003', 3, 'twice');
      }).not.toThrow();
      expect((db.prepare('SELECT count(*) AS n FROM turn_effects').get() as { n: number }).n).toBe(
        2,
      );
    });
  });

  it('refuses a second outbox message with the same idempotency key', () => {
    withMigratedDb((db) => {
      const seeded = seedGroup(db, 'i6b');
      const insert = db.prepare(
        `INSERT INTO outbox_messages (id, group_id, conversation_id, seq, idempotency_key,
           message_class, payload, parts_json, content_hash, audience_reader_set_id, label_id,
           guard_ref, manifest_label_ids, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'reply', '{}', '[]', X'00', ?, ?, 'g', '[]', 0, 0)`,
      );
      const run = (id: string, seq: number, key: string): void => {
        insert.run(
          id,
          seeded.groupId,
          seeded.conversationId,
          seq,
          key,
          seeded.readerSetId,
          seeded.labelId,
        );
      };

      run('obm_01ji6b0000000000000000001', 1, 'once');
      expect(() => {
        run('obm_01ji6b0000000000000000002', 2, 'once');
      }).toThrow(/UNIQUE constraint failed: outbox_messages\.idempotency_key/);
      expect(() => {
        run('obm_01ji6b0000000000000000003', 3, 'twice');
      }).not.toThrow();
    });
  });
});
