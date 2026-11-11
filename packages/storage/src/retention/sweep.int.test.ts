/**
 * `retention.cascade` (`M1-T26` AC; `02` §9.3, §3.13.1, §3.13.2).
 *
 * The acceptance criterion is precise and every clause is a different mechanism:
 *
 * > after a sweep, there are no FTS rows, attachments or blob references for swept messages,
 * > `memory_sources.message_id` is NULL, and `source_ref` is kept.
 *
 *  - **No FTS rows** — a trigger (`trg_messages_fts_ad`). If the sweep deleted through a path the
 *    trigger does not see, the text stays searchable with the row gone.
 *  - **No attachments** — a foreign key cascade.
 *  - **No blob references** — a consequence of the above, and the thing that lets `02` §3.11's GC
 *    collect the file. Nothing deletes the blob row itself here, which is correct: the file is
 *    content-addressed and may be referenced by another group.
 *  - **`memory_sources.message_id` is NULL and `source_ref` is kept** — `ON DELETE SET NULL` on one
 *    column of a two-column record. This is the clause that matters most: a memory's provenance
 *    outlives the message it came from, so "where did this come from?" still answers *something*
 *    after retention, which is what makes a memory auditable at all.
 *
 * None of those four is implemented in TypeScript. They are the schema, and this suite is how we
 * know the schema says what §3.13.2 claims — a test that asserted the sweep *called* the right
 * delete would pass against a schema with the cascades missing.
 */
import { expectWritten } from '@comvivo/core';
import { defaultConfig } from '@comvivo/shared';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  auditId,
  conversationId,
  fingerprintFor,
  groupLabel,
  jobId,
  memoryId,
  memoryItem,
  messageId,
  silentLogger,
  T0,
  turnId,
  withReposAsync,
  type World,
} from '../repos/testing/harness.js';
import { RetentionSweep } from './sweep.js';
import { retentionWindowsFrom } from './windows.js';

const WINDOWS = retentionWindowsFrom(defaultConfig());

/** A day before `T0`, so a stamped `retention_until` is already in the past. */
const EXPIRED = T0.subtract({ hours: 24 });
/** A day after, so the same sweep must leave it alone. */
const LIVE = T0.add({ hours: 24 });

const BLOB_SHA = 'a'.repeat(64);

function sweepOf(world: World): RetentionSweep {
  return new RetentionSweep({
    store: world.store,
    db: world.drizzle,
    connection: world.db,
    logger: silentLogger,
    // Three rather than a thousand, so the chunked loop actually loops: a limit above the fixture's
    // size makes every sweep a single chunk, and the `setImmediate` between chunks — the whole
    // reason this is async — is never exercised.
    chunkRows: 3,
  });
}

/**
 * Seed one conversation with an expired message, a live message, an attachment and a memory.
 *
 * The attachment and the blob row are written with raw SQL, which the harness otherwise avoids:
 * `message_attachments` and `blobs` have no repository until `M3`'s ingestion path builds one, and
 * a fixture that cannot represent an attachment cannot test the cascade that is the point here.
 */
function seed(world: World): { readonly convId: ReturnType<typeof conversationId> } {
  const convId = conversationId('swp1');
  world.store.write((uow) => {
    expectWritten(
      world.repos.conversations.create(uow, {
        id: convId,
        groupId: world.groupId,
        channel: 'simulator',
        platformChatId: 'chat-sweep',
        kind: 'group',
        boundAt: T0,
      }),
      'the conversation',
    );
    for (const [tag, until] of [
      ['swpx', EXPIRED],
      ['swpy', LIVE],
    ] as const) {
      expectWritten(
        world.repos.messages.insert(
          uow,
          {
            id: messageId(tag),
            groupId: world.groupId,
            conversationId: convId,
            kind: 'member',
            // Distinct words, so an FTS assertion can tell the two apart.
            text: tag === 'swpx' ? 'quarterly aubergine report' : 'weekly rhubarb update',
            sentAt: T0,
            receivedAt: T0,
            retentionUntil: until,
          },
          groupLabel(world.groupId),
        ),
        `message ${tag}`,
      );
    }

    world.drizzle.run(
      sql`INSERT INTO blobs (group_id, sha256, size_bytes, mime, storage_addr, wrapped_dek,
                             wrap_nonce, kek_version, state, created_at)
          VALUES (${world.groupId}, ${BLOB_SHA}, 11, 'text/plain', ${'b'.repeat(64)},
                  ${Buffer.alloc(48, 9)}, ${Buffer.alloc(24, 3)}, 1, 'stored',
                  ${T0.epochMilliseconds})`,
    );
    world.drizzle.run(
      sql`INSERT INTO message_attachments
            (id, message_id, group_id, kind, platform_ref, mime, size_bytes, blob_sha256,
             status, label_id, created_at)
          SELECT 'att_01jswp10000000000000000000', ${messageId('swpx')}, ${world.groupId},
                 'document', 'platform:att:1', 'text/plain', 11, ${BLOB_SHA}, 'stored', label_id,
                 ${T0.epochMilliseconds}
            FROM messages WHERE id = ${messageId('swpx')}`,
    );

    expectWritten(
      world.repos.memories.insert(
        uow,
        memoryItem('swpm', world.groupId, { statement: 'the report is quarterly' }),
        groupLabel(world.groupId),
        fingerprintFor('swpm'),
      ),
      'the memory',
    );
    expectWritten(
      world.repos.memories.addSources(uow, world.groupId, memoryId('swpm'), [
        {
          // `ref` is the stable copy that survives the message (`02` §3.3.4): the column is
          // `source_ref`, and it is what the memory's provenance still answers with once the
          // message it names has expired.
          ref: `msg:${messageId('swpx')}`,
          messageId: messageId('swpx'),
          windowKey: 'w1',
          span: undefined,
        },
      ]),
      'the memory source',
    );
  });
  return { convId };
}

function ftsMatches(world: World, term: string): number {
  const rows = world.drizzle.all<{ n: number }>(
    sql`SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ${term}`,
  );
  return rows[0]?.n ?? 0;
}

function countOf(world: World, table: string): number {
  const rows = world.drizzle.all<{ n: number }>(
    sql`SELECT count(*) AS n FROM ${sql.identifier(table)}`,
  );
  return rows[0]?.n ?? 0;
}

describe('retention.cascade (02 §9.3)', () => {
  it('removes the expired message, its FTS row, its attachment and nothing else', async () => {
    await withReposAsync(async (world) => {
      seed(world);
      // The premise: both messages are indexed and the attachment exists. Without this the
      // assertions below would pass against a fixture that never wrote anything.
      expect(ftsMatches(world, 'aubergine')).toBe(1);
      expect(ftsMatches(world, 'rhubarb')).toBe(1);
      expect(countOf(world, 'message_attachments')).toBe(1);

      const result = await sweepOf(world).run(T0, WINDOWS);

      expect(result.deleted['messages']).toBe(1);
      expect(ftsMatches(world, 'aubergine')).toBe(0);
      // The live message survives, which is what makes the deletion a *retention* sweep rather
      // than a truncation.
      expect(ftsMatches(world, 'rhubarb')).toBe(1);
      expect(countOf(world, 'message_attachments')).toBe(0);
    });
  });

  it('keeps the blob row and leaves it unreferenced for §3.11 GC to collect', async () => {
    await withReposAsync(async (world) => {
      seed(world);
      await sweepOf(world).run(T0, WINDOWS);

      // The row stays: a blob is content-addressed and another group may hold the same bytes, so
      // deleting it here would be `02` §3.11's GC decision taken in the wrong place.
      expect(countOf(world, 'blobs')).toBe(1);
      const refs = world.drizzle.all<{ n: number }>(
        sql`SELECT count(*) AS n FROM message_attachments WHERE blob_sha256 = ${BLOB_SHA}`,
      );
      expect(refs[0]?.n).toBe(0);
    });
  });

  it('nulls `memory_sources.message_id` and keeps `source_ref`', async () => {
    await withReposAsync(async (world) => {
      seed(world);
      await sweepOf(world).run(T0, WINDOWS);

      const sources = world.repos.memories.sourcesOf(world.groupId, memoryId('swpm'));
      expect(sources).toHaveLength(1);
      // This is the clause of the AC that is most easily lost: a cascade instead of a `SET NULL`
      // would take the row, and the memory would then have no provenance at all rather than a
      // provenance whose message has expired.
      expect(sources[0]?.messageId).toBeUndefined();
      expect(sources[0]?.ref).toBe(`msg:${messageId('swpx')}`);
      // And the memory itself is untouched: retention takes messages, never memories (`02`
      // §3.13.1 — memories "persist", deleted only by user, policy or erasure). Asserted as a row
      // count rather than through `byId`, because the question here is whether the row exists and
      // not whether some audience may read it — an eligibility filter would add a second reason
      // for this to fail.
      expect(countOf(world, 'memory_items')).toBe(1);
    });
  });

  it('sweeps in chunks, which is what keeps the write lock short', async () => {
    await withReposAsync(async (world) => {
      const convId = conversationId('swp2');
      world.store.write((uow) => {
        expectWritten(
          world.repos.conversations.create(uow, {
            id: convId,
            groupId: world.groupId,
            channel: 'simulator',
            platformChatId: 'chat-chunk',
            kind: 'group',
            boundAt: T0,
          }),
          'the conversation',
        );
        for (let index = 1; index <= 7; index += 1) {
          expectWritten(
            world.repos.messages.insert(
              uow,
              {
                id: messageId(`chk${index}`),
                groupId: world.groupId,
                conversationId: convId,
                kind: 'member',
                text: `chunk ${String(index)}`,
                sentAt: T0,
                receivedAt: T0,
                retentionUntil: EXPIRED,
              },
              groupLabel(world.groupId),
            ),
            `message ${String(index)}`,
          );
        }
      });

      const result = await sweepOf(world).run(T0, WINDOWS);
      // Seven rows at three per chunk is three chunks: 3, 3, 1, then a fourth that finds nothing.
      // The count is what the loop *returned*, so a sweep that stopped after one chunk — the
      // obvious bug, since the first chunk is a full one — would report 3 here.
      expect(result.deleted['messages']).toBe(7);
      expect(countOf(world, 'messages')).toBe(0);
    });
  });

  it('warns that messages are expiring unextracted, and deletes them anyway', async () => {
    const lines: { event: string; count: number | undefined }[] = [];
    await withReposAsync(async (world) => {
      seed(world);
      const sweep = new RetentionSweep({
        store: world.store,
        db: world.drizzle,
        connection: world.db,
        logger: {
          ...silentLogger,
          warn: (event: string, fields?: { count?: number }) => {
            lines.push({ event, count: fields?.count });
          },
        },
        chunkRows: 3,
      });
      const result = await sweep.run(T0, WINDOWS);

      // `02` §3.13.2: retention wins over memory, so the warning is a notice and not a veto.
      expect(lines).toEqual([{ event: 'retention.unextracted', count: 1 }]);
      expect(result.unextracted).toBe(1);
      expect(result.deleted['messages']).toBe(1);
    });
  });

  it('is silent when extraction has read everything', async () => {
    const warnings: string[] = [];
    await withReposAsync(async (world) => {
      const { convId } = seed(world);
      // Extraction's cursor past the expiring message's rid: nothing is lost by deleting it, so
      // there is nothing to warn about. Without this case the warning could be unconditional and
      // the test above would still pass.
      world.drizzle.run(
        sql`INSERT INTO extraction_cursors (conversation_id, last_rid, extractor_version, updated_at)
            VALUES (${convId}, (SELECT max(rid) FROM messages), 'v1', ${T0.epochMilliseconds})`,
      );
      const sweep = new RetentionSweep({
        store: world.store,
        db: world.drizzle,
        connection: world.db,
        logger: {
          ...silentLogger,
          warn: (event: string) => {
            warnings.push(event);
          },
        },
        chunkRows: 3,
      });
      const result = await sweep.run(T0, WINDOWS);
      expect(warnings).toEqual([]);
      expect(result.unextracted).toBe(0);
    });
  });
});

describe('the other sweepable tables (02 §3.13.1)', () => {
  it('leaves a live turn alone however old it is, and takes a terminal one', async () => {
    await withReposAsync(async (world) => {
      const convId = conversationId('swp3');
      const old = T0.subtract({ hours: 24 * 400 });
      world.store.write((uow) => {
        expectWritten(
          world.repos.conversations.create(uow, {
            id: convId,
            groupId: world.groupId,
            channel: 'simulator',
            platformChatId: 'chat-turns',
            kind: 'group',
            boundAt: T0,
          }),
          'the conversation',
        );
        // A turn's audience is a reader set, so one has to exist: interning a label is how a reader
        // set comes into being (`02` §3.2), and it is the only way to get an id the FK accepts.
        world.repos.labels.intern(uow, groupLabel(world.groupId));
        for (const [tag, status] of [
          ['trnx', 'completed'],
          ['trny', 'running'],
        ] as const) {
          const id = turnId(tag);
          world.drizzle.run(
            sql`INSERT INTO turns (id, group_id, conversation_id, kind, trigger_message_ids,
                                   audience_reader_set_id, status, boot_id, root_turn_id,
                                   restarts, recovery_done, started_at, deadline_at, completed_at)
                VALUES (${id}, ${world.groupId}, ${convId}, 'reply', '[]',
                        (SELECT reader_set_id FROM labels WHERE group_id = ${world.groupId} LIMIT 1),
                        ${status}, 'boot-1',
                        ${id}, 0, 0, ${old.epochMilliseconds},
                        ${old.add({ seconds: 180 }).epochMilliseconds},
                        ${status === 'completed' ? old.epochMilliseconds : null})`,
          );
        }
      });

      const result = await sweepOf(world).run(T0, WINDOWS);
      expect(result.deleted['turns']).toBe(1);
      const left = world.drizzle.all<{ status: string }>(sql`SELECT status FROM turns`);
      // A `running` turn 400 days old means recovery is broken. Deleting it would delete the
      // evidence, which is the opposite of what a host needs.
      expect(left.map((row) => row.status)).toEqual(['running']);
    });
  });

  it('honours the two job windows separately', async () => {
    await withReposAsync(async (world) => {
      const insert = (tag: string, status: string, finishedDaysAgo: number) => {
        const at = T0.subtract({ hours: 24 * finishedDaysAgo });
        world.drizzle.run(
          sql`INSERT INTO jobs (id, kind, partition_key, serial, payload, status, priority, run_at,
                                attempts, max_attempts, created_at, finished_at)
              VALUES (${jobId(tag)}, 'retention.sweep', '_instance', 0, '{}', ${status}, 0,
                      ${at.epochMilliseconds}, 1, 8, ${at.epochMilliseconds},
                      ${at.epochMilliseconds})`,
        );
      };
      // `jobs.retainSucceededDays` is 7 and `retainDeadDays` is 30, so a 10-day-old dead job must
      // survive a sweep that takes a 10-day-old succeeded one. A single window would take both.
      insert('jsk', 'succeeded', 10);
      insert('jdd', 'dead', 10);
      insert('jyn', 'succeeded', 2);

      const result = await sweepOf(world).run(T0, WINDOWS);
      expect(result.deleted['jobs']).toBe(1);
      const left = world.drizzle.all<{ status: string }>(sql`SELECT status FROM jobs ORDER BY id`);
      expect(left.map((row) => row.status).toSorted()).toEqual(['dead', 'succeeded']);
    });
  });

  it('does not touch the audit chain unless a host set a ceiling', async () => {
    await withReposAsync(async (world) => {
      world.store.write((uow) => {
        for (let index = 1; index <= 3; index += 1) {
          expectWritten(
            world.repos.audit.append(uow, {
              id: auditId(`ad${String(index)}`),
              groupId: world.groupId,
              actor: { kind: 'system' },
              action: 'test.event',
              decision: {
                outcome: 'allow',
                reason: null,
                capability: null,
                constitutionVersionId: null,
              },
              details: {},
              at: T0.subtract({ hours: 24 * 400 }),
            }),
            `audit ${String(index)}`,
          );
        }
      });

      // The default is `null` — forever (`02` §3.13.1). Four hundred days old and three rows stay.
      const result = await sweepOf(world).run(T0, WINDOWS);
      expect(result.deleted['audit_events']).toBeUndefined();
      expect(countOf(world, 'audit_events')).toBe(3);
    });
  });
});
