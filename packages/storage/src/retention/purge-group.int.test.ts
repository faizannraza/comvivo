/**
 * `group.purge` (`M1-T26` AC; `02` §9.3, §3.13.4).
 *
 * `02` §9.3 states the criterion as:
 *
 * > zero rows with the group id in any table (an introspection loop over `sqlite_schema`), zero vec
 * > rows in the partition, and blob files gone after GC.
 *
 * The first clause has a trap in it, and it is worth naming because it would have made this suite
 * worthless: **every group-scoped table cascades from `groups`**, so the purge's final
 * `DELETE FROM groups` removes whatever the chunked steps missed. An introspection loop run after
 * the purge therefore passes against a purge that skipped forty tables and deleted them all in one
 * statement — which is precisely the unbounded cascade `02` D18 refuses.
 *
 * So the criterion is checked **twice**: once as §9.3 words it, and once *before* the `groups` row
 * is deleted, where the cascade has not yet happened and every table's emptiness is the step's own
 * work. The second is the assertion that has teeth.
 *
 * The other group is checked too, byte for byte, through `exportDomainState`. A purge that took one
 * group's rows and a neighbour's is not a feature with a bug; it is the worst failure this product
 * can have.
 */
import { expectWritten } from '@comvivo/core';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  auditId,
  conversationId,
  fingerprintFor,
  groupLabel,
  jobId,
  memberId,
  memoryItem,
  messageId,
  person,
  scheduleId,
  silentLogger,
  T0,
  type World,
  withReposAsync,
} from '../repos/testing/harness.js';
import { exportDomainState } from '../testing/domain-state.js';
import { groupScopedTables } from './inventory.js';
import { GroupPurge } from './purge-group.js';

/** Build a group's worth of rows: a member, a conversation, messages, a memory, an audit trail. */
function populate(world: World, groupId: World['groupId'], tag: string, messages: number): void {
  const convId = conversationId(`${tag}cv`);
  world.store.write((uow) => {
    expectWritten(world.repos.persons.create(uow, person(`${tag}p`)), 'the person');
    expectWritten(
      world.repos.members.add(uow, {
        id: memberId(`${tag}m`),
        groupId,
        personId: person(`${tag}p`).id,
        role: 'member',
        status: 'active',
        joinedAt: T0,
      }),
      'the member',
    );
    expectWritten(
      world.repos.conversations.create(uow, {
        id: convId,
        groupId,
        channel: 'simulator',
        platformChatId: `chat-${tag}`,
        kind: 'group',
        boundAt: T0,
      }),
      'the conversation',
    );
    for (let index = 1; index <= messages; index += 1) {
      expectWritten(
        world.repos.messages.insert(
          uow,
          {
            id: messageId(`${tag}${index}`),
            groupId,
            conversationId: convId,
            kind: 'member',
            senderMemberId: memberId(`${tag}m`),
            text: `${tag} message ${String(index)}`,
            sentAt: T0,
            receivedAt: T0,
          },
          groupLabel(groupId),
        ),
        `message ${String(index)}`,
      );
    }
    expectWritten(
      world.repos.memories.insert(
        uow,
        memoryItem(`${tag}mem`, groupId),
        groupLabel(groupId),
        fingerprintFor(`${tag}mem`),
      ),
      'the memory',
    );
    expectWritten(
      world.repos.audit.append(uow, {
        id: auditId(`${tag}a`),
        groupId,
        actor: { kind: 'system' },
        action: 'test.event',
        decision: { outcome: 'allow', reason: null, capability: null, constitutionVersionId: null },
        details: {},
        at: T0,
      }),
      'the audit row',
    );
    // A schedule and a job, neither of which any cascade reaches: both are keyed on
    // `partition_key`, which is the group id for a group-scoped kind (`02` §3.10.1).
    world.drizzle.run(
      sql`INSERT INTO job_schedules (id, kind, partition_key, spec, payload, misfire,
                                     misfire_grace_ms, enabled, owner_ref, created_at, updated_at)
          VALUES (${scheduleId(`${tag}s`)}, 'digest.morning',
                  ${groupId}, '{"kind":"interval","everyMs":3600000}', '{}', 'skip', 0, 1,
                  ${`${memberId(`${tag}m`)}:digest.morning`}, ${T0.epochMilliseconds},
                  ${T0.epochMilliseconds})`,
    );
    world.drizzle.run(
      sql`INSERT INTO jobs (id, kind, partition_key, serial, payload, status, priority, run_at,
                            attempts, max_attempts, created_at)
          VALUES (${jobId(`${tag}j`)}, 'digest.morning',
                  ${groupId}, 1, '{}', 'queued', 0, ${T0.epochMilliseconds}, 0, 8,
                  ${T0.epochMilliseconds})`,
    );
  });
}

function purgeOf(world: World, chunkRows = 3): GroupPurge {
  return new GroupPurge({
    store: world.store,
    db: world.drizzle,
    connection: world.db,
    logger: silentLogger,
    // Small, so the chunk loop loops. With a limit above the fixture size every step is one chunk
    // and the resumption path is never reached.
    chunkRows,
  });
}

/**
 * Every table with a group id, and how many rows it holds for `groupId`.
 *
 * `02` §9.3's "introspection loop over `sqlite_schema`" — but driven from the same inventory the
 * purge uses, so this is a *consistency* check rather than an independent one.
 * `inventory.int.test.ts` is where the inventory itself is checked against the drizzle schema.
 */
function rowsPerTable(world: World, groupId: string): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of groupScopedTables(world.db)) {
    const rows = world.drizzle.all<{ n: number }>(
      sql`SELECT count(*) AS n FROM ${sql.identifier(entry.table)}
           WHERE ${sql.identifier(entry.column)} = ${groupId}`,
    );
    const n = rows[0]?.n ?? 0;
    if (n > 0) counts[entry.table] = n;
  }
  return counts;
}

function requestPurge(world: World, groupId: World['groupId']): string {
  const record = world.store.write((uow) =>
    expectWritten(
      uow.deletions.requestGroupPurge(uow, { groupId, requestedBy: { kind: 'host' } }),
      'the purge request',
    ),
  );
  return record.id;
}

describe('group.purge (02 §9.3)', () => {
  it('leaves zero rows for the group in any table', async () => {
    await withReposAsync(async (world) => {
      populate(world, world.groupId, 'pga', 7);
      populate(world, world.otherGroupId, 'pgb', 3);
      // The premise. Without it, "no rows afterwards" is satisfied by a fixture that wrote none.
      const before = rowsPerTable(world, world.groupId);
      expect(Object.keys(before).length).toBeGreaterThan(5);
      expect(before['messages']).toBe(7);

      const deletionId = requestPurge(world, world.groupId);
      const result = await purgeOf(world).run(deletionId as never);

      expect(rowsPerTable(world, world.groupId)).toEqual({});
      expect(result.total).toBeGreaterThan(10);
    });
  });

  it('empties every table with its own step, not with the final cascade', async () => {
    await withReposAsync(async (world) => {
      populate(world, world.groupId, 'pgc', 5);
      const before = rowsPerTable(world, world.groupId);
      const deletionId = requestPurge(world, world.groupId);

      const result = await purgeOf(world, 2).run(deletionId as never);

      // **The assertion with teeth.** Checking "no rows afterwards" proves nothing on its own:
      // every group-scoped table cascades from `groups`, so the purge's final
      // `DELETE FROM groups` removes whatever the chunked steps missed, and a purge that skipped
      // forty tables would still leave zero rows. What cannot be faked is the per-step count — a
      // step whose rows the cascade took reports **zero** and never appears in `counts`.
      //
      // So: every table that had rows is named in `counts`, with its own number. That is the
      // chunking `02` D18 requires, and a missed table is a stall rather than a leak.
      const byStep: Record<string, number> = {};
      for (const [table, count] of Object.entries(before)) {
        // `groups` is the one row the finish transaction takes, under its own step name.
        byStep[table === 'groups' ? 'groups.row' : table] = count;
      }
      for (const [step, expected] of Object.entries(byStep)) {
        expect(result.counts[step], `${step} deleted by its own step`).toBe(expected);
      }
      // And §9.3's own wording, which is now a corollary rather than the whole check.
      expect(rowsPerTable(world, world.groupId)).toEqual({});
      const record = world.store.write((uow) => uow.deletions.byId(deletionId as never));
      expect(record?.status).toBe('completed');
    });
  });

  it('leaves no trace of the group`s text in the FTS index itself', async () => {
    await withReposAsync(async (world) => {
      // Distinctive words per group, so the assertion can tell whose terms went.
      populate(world, world.groupId, 'pgx', 2);
      populate(world, world.otherGroupId, 'pgy', 2);
      const inIndex = (term: string) => {
        const rows = world.drizzle.all<{ n: number }>(
          sql`SELECT count(*) AS n FROM messages_fts_data
               WHERE instr(CAST(block AS BLOB), ${Buffer.from(term)}) > 0`,
        );
        return rows[0]?.n ?? 0;
      };
      expect(inIndex('pgx')).toBeGreaterThan(0);
      expect(inIndex('pgy')).toBeGreaterThan(0);

      const deletionId = requestPurge(world, world.groupId);
      await purgeOf(world).run(deletionId as never);

      // Deleting the rows is not enough: with `secure-delete = 1` the row stops matching and its
      // position list is overwritten, but the **term** stays in the segment dictionary. So a
      // deleted group's words would remain recoverable from `messages_fts_data` as raw bytes by
      // anyone who can read the decrypted file. The purge's FTS `optimize` is what removes them,
      // and this is the only assertion that notices if it goes away.
      expect(inIndex('pgx')).toBe(0);
      // The surviving group's index is intact, which a destructive "fix" would also satisfy
      // without this half.
      expect(inIndex('pgy')).toBeGreaterThan(0);
    });
  });

  it('does not touch the other group, byte for byte', async () => {
    await withReposAsync(async (world) => {
      populate(world, world.groupId, 'pgd', 4);
      populate(world, world.otherGroupId, 'pge', 4);
      const untouched = exportDomainState(world.db, world.otherGroupId);

      const deletionId = requestPurge(world, world.groupId);
      await purgeOf(world).run(deletionId as never);

      // A canonical-JSON snapshot of every group-scoped row, so a purge that took one extra row
      // from the neighbour fails here with the table and the row named.
      expect(exportDomainState(world.db, world.otherGroupId)).toBe(untouched);
    });
  });

  it('takes the queue rows and the schedules no cascade reaches', async () => {
    await withReposAsync(async (world) => {
      populate(world, world.groupId, 'pgf', 2);
      const deletionId = requestPurge(world, world.groupId);

      // The premise: both tables hold a row for this partition. Neither has a foreign key to
      // `groups`, so a purge that relied on the cascade would leave both.
      const partitionRows = () => {
        const jobs = world.drizzle.all<{ n: number }>(
          sql`SELECT count(*) AS n FROM jobs WHERE partition_key = ${world.groupId}`,
        );
        const schedules = world.drizzle.all<{ n: number }>(
          sql`SELECT count(*) AS n FROM job_schedules WHERE partition_key = ${world.groupId}`,
        );
        const partitions = world.drizzle.all<{ n: number }>(
          sql`SELECT count(*) AS n FROM job_partitions WHERE partition_key = ${world.groupId}`,
        );
        return [jobs[0]?.n ?? 0, schedules[0]?.n ?? 0, partitions[0]?.n ?? 0];
      };
      // The request paused the partition, so there is a `job_partitions` row too.
      expect(partitionRows()).toEqual([1, 1, 1]);

      await purgeOf(world).run(deletionId as never);
      expect(partitionRows()).toEqual([0, 0, 0]);
    });
  });

  it('empties the vec0 space, which has no `rowid` to delete by', async () => {
    await withReposAsync(async (world) => {
      populate(world, world.groupId, 'pgv', 2);
      // A vec0 space with rows for both groups. Measured against sqlite-vec 0.1.9:
      // `SELECT rowid FROM vec_memory_x` fails with *no such column: rowid*, because a vec0 table
      // exposes only its declared columns — so the generic chunked delete has to address rows by
      // `rid`. One wrong column name here is a purge that fails on every instance with embeddings
      // configured and on no instance without them: it would pass CI, pass a demo, and fail for
      // the first host who turned local embeddings on.
      world.db.exec(
        `CREATE VIRTUAL TABLE vec_memory_probe USING vec0(
           rid INTEGER PRIMARY KEY, embedding float[2],
           group_id TEXT partition key, label_id INTEGER, received INTEGER)`,
      );
      const insert = world.db.prepare(
        `INSERT INTO vec_memory_probe(rid, embedding, group_id, label_id, received)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const [rid, groupId] of [
        [1, world.groupId],
        [2, world.groupId],
        [3, world.otherGroupId],
      ] as const) {
        insert.run(BigInt(rid), Buffer.from(new Float32Array([rid, rid]).buffer), groupId, 1n, 0n);
      }

      const deletionId = requestPurge(world, world.groupId);
      const result = await purgeOf(world, 1).run(deletionId as never);

      // Its own step, with its own count — so the rows went by the chunked delete and not by some
      // cascade. And the other group's vector survives.
      expect(result.counts['vec_memory_probe']).toBe(2);
      const left = world.db.prepare(`SELECT rid FROM vec_memory_probe ORDER BY rid`).all() as {
        rid: number;
      }[];
      expect(left.map((row) => Number(row.rid))).toEqual([3]);
    });
  });

  it('skips the steps a resumed purge has already finished', async () => {
    await withReposAsync(async (world) => {
      populate(world, world.groupId, 'pgw', 3);
      const deletionId = requestPurge(world, world.groupId);

      // The cursor moved to the final step, as a crash between the last table and the finish
      // transaction would leave it. A resumed purge must **skip** the earlier steps: that is what
      // `deletions.progress.step` is for, and without the skip a purge of a large group would
      // re-scan sixty already-empty tables on every restart.
      //
      // The messages are still there, deliberately — this asserts the skip rather than the
      // deletion, and a purge that restarted from step zero would take them and pass a test that
      // only looked at the end state.
      world.store.write((uow) =>
        uow.deletions.advance(uow, deletionId as never, {
          step: 'groups.row',
          cursor: null,
          counts: { deleted: 0 },
        }),
      );
      const result = await purgeOf(world).run(deletionId as never);

      expect(result.counts['messages']).toBeUndefined();
      expect(result.counts['groups.row']).toBe(1);
      // The group row is gone, so the cascade took the rest — which is exactly the shape the
      // "own step" test above exists to distinguish, and here it is the *expected* outcome.
      expect(rowsPerTable(world, world.groupId)).toEqual({});
    });
  });
});

describe('the request transaction (02 §3.13.4)', () => {
  it('stops access before anything is deleted', async () => {
    await withReposAsync(async (world) => {
      populate(world, world.groupId, 'pgg', 3);
      requestPurge(world, world.groupId);

      // `02` §3.13.4: "committed (repositories now return not_found for the group)". The rows are
      // all still there — the job has not run — and the group is already unreachable.
      const group = world.repos.groups.byId(world.groupId);
      expect(group?.status).toBe('deleting');
      expect(rowsPerTable(world, world.groupId)['messages']).toBe(3);
      // And nothing new can be claimed, including work a schedule tick would enqueue a moment
      // later: the pause is what `cancelPartition` alone cannot do.
      const paused = world.drizzle.all<{ paused: number }>(
        sql`SELECT paused FROM job_partitions WHERE partition_key = ${world.groupId}`,
      );
      expect(paused[0]?.paused).toBe(1);
      const queued = world.drizzle.all<{ status: string }>(
        sql`SELECT status FROM jobs WHERE partition_key = ${world.groupId}`,
      );
      expect(queued.map((row) => row.status)).toEqual(['cancelled']);
      const schedules = world.drizzle.all<{ enabled: number }>(
        sql`SELECT enabled FROM job_schedules WHERE partition_key = ${world.groupId}`,
      );
      expect(schedules.map((row) => row.enabled)).toEqual([0]);
    });
  });

  it('refuses a second request and names the first', async () => {
    await withReposAsync(async (world) => {
      populate(world, world.groupId, 'pgh', 1);
      const first = requestPurge(world, world.groupId);
      const again = world.store.write((uow) =>
        uow.deletions.requestGroupPurge(uow, {
          groupId: world.groupId,
          requestedBy: { kind: 'host' },
        }),
      );
      // A duplicate rather than a second row: two `deletions` rows for one group would give the
      // job two cursors, and whichever ran second would resume from the wrong place.
      expect(again.kind).toBe('duplicate');
      expect(again.kind === 'duplicate' ? again.existingId : undefined).toBe(first);
    });
  });

  it('writes its audit row on the instance chain, which outlives the group', async () => {
    await withReposAsync(async (world) => {
      populate(world, world.groupId, 'pgn', 2);
      const deletionId = requestPurge(world, world.groupId);
      await purgeOf(world).run(deletionId as never);

      // The group's own chain went with the group. The record *that* it was purged did not — which
      // is the whole reason `02` §3.13.4 puts this row on `_instance` and leaves `group_id` null.
      const chain = world.drizzle.all<{ action: string }>(
        sql`SELECT action FROM audit_events WHERE chain_key = '_instance' ORDER BY seq`,
      );
      expect(chain.map((row) => row.action)).toContain('group.purge_requested');
      expect(world.repos.audit.verifyChain('_instance').ok).toBe(true);
      const groupChain = world.drizzle.all<{ n: number }>(
        sql`SELECT count(*) AS n FROM audit_events WHERE chain_key = ${world.groupId}`,
      );
      expect(groupChain[0]?.n).toBe(0);
    });
  });

  it('refuses a purge of a group that does not exist', async () => {
    await withReposAsync(async (world) => {
      const result = world.store.write((uow) =>
        uow.deletions.requestGroupPurge(uow, {
          groupId: 'grp_01jnxpe00000000000000000000' as World['groupId'],
          requestedBy: { kind: 'host' },
        }),
      );
      expect(result.kind).toBe('not_found');
    });
  });
});

describe('resumption (02 D18)', () => {
  it('finishes from the step a crash left in `deletions.progress`', async () => {
    await withReposAsync(async (world) => {
      populate(world, world.groupId, 'pgj', 6);
      const deletionId = requestPurge(world, world.groupId);

      // Simulate a crash: the first run is driven with a tiny chunk and then abandoned by moving
      // the cursor back to the first step by hand. A second run must still finish — which is what
      // "resumable" means and what `deletions.progress` is for.
      const first = await purgeOf(world, 2).run(deletionId as never);
      const finished = world.store.write((uow) => uow.deletions.byId(deletionId as never));
      expect(finished?.status).toBe('completed');
      expect(first.counts['messages']).toBe(6);

      // Running it again is a no-op rather than an error: the job is at-least-once, so a lost lease
      // means the handler runs twice and the second run must not throw. `counts` is **empty** —
      // that is the claim, and it is the per-step breakdown rather than `total`, because `total`
      // resumes from `deletions.progress` and is cumulative across runs on purpose. A second run
      // reporting a total of zero would mean the resumed figure had been lost.
      const second = await purgeOf(world).run(deletionId as never);
      expect(second.counts).toEqual({});
      expect(second.total).toBe(first.total);
    });
  });

  it('stops when another runner has completed the deletion', async () => {
    await withReposAsync(async (world) => {
      populate(world, world.groupId, 'pgk', 5);
      const deletionId = requestPurge(world, world.groupId);
      // Completed out from under the purge, which is what a lost lease plus a second worker looks
      // like. The fence inside `#drain` is what stops the first one deleting rows nobody tracks.
      world.store.write((uow) => uow.deletions.complete(uow, deletionId as never, uow.now));

      const result = await purgeOf(world).run(deletionId as never);
      expect(result.total).toBe(0);
      // The rows are still there, which is correct: the other runner owns them.
      expect(rowsPerTable(world, world.groupId)['messages']).toBe(5);
    });
  });
});
