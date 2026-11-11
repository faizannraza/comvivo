/**
 * `erasure.person` (`M1-T26` AC; `02` §9.3, §3.13.5).
 *
 * `02` §9.3 words the criterion as:
 *
 * > seed canary content across every table plus blobs, run `erasePerson`, then `assertNoCanary`
 * > passes, kept pseudonymous tables contain only ids, and the job is resumable (killed at each
 * > step and restarted).
 *
 * The canary is the whole method, and it is the only honest way to test an erasure: a test that
 * checked the tables the implementation walks could only ever confirm the implementation's own
 * list. `assertNoCanary` instead searches **every** text and blob column of every table, the FTS
 * doclists, the vec rows, the blob files and the raw database with its WAL — in four spellings —
 * and reports where the string survived. A table a later milestone adds is searched without anyone
 * remembering to add it.
 *
 * The three clauses after it are each a different failure this suite has to be able to see:
 *
 *  - **"kept pseudonymous tables contain only ids"** — `02` §3.13.5 step 8 keeps `audit_events`,
 *    `ledger_entries` and `usage_records` on the explicit grounds that their ids carry no personal
 *    data once `persons` is erased. That reasoning is only true if those tables hold no content,
 *    so the canary search covering them *is* the check: they are not excluded from it.
 *  - **Resumability** — driven here by completing an erasure in small chunks and running it twice,
 *    since the job is at-least-once and a lost lease means the handler runs again.
 *  - **The person's own row survives, renamed.** `members.person_id` is a foreign key, and a
 *    dashboard rendering a three-year-old decision needs something to print.
 */
import { expectWritten } from '@comvivo/core';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  conversationId,
  fingerprintFor,
  groupLabel,
  memberId,
  memoryId,
  memoryItem,
  messageId,
  person,
  personId,
  silentLogger,
  T0,
  taskId,
  usageId,
  type World,
  withReposAsync,
} from '../repos/testing/harness.js';
import { ERASED_DISPLAY_NAME, PersonErasure } from './erase-person.js';
import { findCanary } from './testing/canary.js';

/**
 * A string that exists nowhere else.
 *
 * Deliberately not a word: `assertNoCanary` searches four spellings and an FTS tokenizer would
 * split a phrase, so one unbroken token is what survives every encoding it is looked for in.
 */
const CANARY = 'ZarquonBrambleWhistle42';

/** The person being erased, and a second person who must be untouched. */
const SUBJECT = 'ersa';
const BYSTANDER = 'ersb';

interface Seeded {
  readonly memberId: ReturnType<typeof memberId>;
  readonly otherMemberId: ReturnType<typeof memberId>;
  readonly dmId: ReturnType<typeof conversationId>;
  readonly groupConvId: ReturnType<typeof conversationId>;
}

/**
 * Put the canary everywhere a person's data can live.
 *
 * Through the repositories where one exists, and with direct SQL for the participation tables that
 * have none until M4–M6. A fixture that could not represent a poll vote could not test that an
 * erasure takes it.
 */
function seed(world: World): Seeded {
  const mine = memberId(`${SUBJECT}m`);
  const theirs = memberId(`${BYSTANDER}m`);
  const dmId = conversationId('ersdm');
  const groupConvId = conversationId('ersgc');

  world.store.write((uow) => {
    for (const [tag, id] of [
      [SUBJECT, mine],
      [BYSTANDER, theirs],
    ] as const) {
      expectWritten(world.repos.persons.create(uow, person(`${tag}p`)), 'the person');
      expectWritten(
        world.repos.members.add(uow, {
          id,
          groupId: world.groupId,
          personId: personId(`${tag}p`),
          role: 'member',
          status: 'active',
          joinedAt: T0,
        }),
        'the member',
      );
    }
    // A channel identity, which is what makes the person reachable — and the row whose deletion is
    // what makes an erasure take effect for the product rather than only for the database.
    world.drizzle.run(
      sql`INSERT INTO channel_identities (id, channel, platform_user_id, person_id,
                                          display_name_snapshot, is_bot, dm_reachable, created_at)
          VALUES ('chid_01jersa00000000000000000000', 'simulator', ${`user-${CANARY}`},
                  ${personId(`${SUBJECT}p`)}, ${CANARY}, 0, 1, ${T0.epochMilliseconds})`,
    );

    for (const [id, kind, memberRef] of [
      [groupConvId, 'group', null],
      [dmId, 'dm', mine],
    ] as const) {
      expectWritten(
        world.repos.conversations.create(uow, {
          id,
          groupId: world.groupId,
          channel: 'simulator',
          platformChatId: `chat-${id}`,
          kind,
          boundAt: T0,
          ...(memberRef === null ? {} : { memberId: memberRef }),
        }),
        'the conversation',
      );
    }

    // A group message the subject sent, a DM they sent, and a message from the bystander that must
    // survive untouched — the last is what distinguishes an erasure from a truncation.
    for (const [tag, convId, sender] of [
      ['ersg1', groupConvId, mine],
      ['ersd1', dmId, mine],
      ['ersb1', groupConvId, theirs],
    ] as const) {
      expectWritten(
        world.repos.messages.insert(
          uow,
          {
            id: messageId(tag),
            groupId: world.groupId,
            conversationId: convId,
            kind: 'member',
            senderMemberId: sender,
            text: sender === mine ? `I said ${CANARY}` : 'nothing to see here',
            sentAt: T0,
            receivedAt: T0,
          },
          groupLabel(world.groupId),
        ),
        `message ${tag}`,
      );
    }

    // A memory whose only subject is the subject: deleted outright (§3.13.5 step 5).
    expectWritten(
      world.repos.memories.insert(
        uow,
        memoryItem('erssm', world.groupId, {
          statement: `the subject likes ${CANARY}`,
          // Subjects are written with the item (`02` §3.3.4): they are part of what the memory
          // *is*, so there is no `addSubjects` — a memory about nobody in particular is a
          // different memory, not the same one awaiting an update.
          subjects: [{ ref: mine, role: 'about' }],
        }),
        groupLabel(world.groupId),
        fingerprintFor('erssm'),
      ),
      'the sole-subject memory',
    );
    // A memory about both: kept, because it is as much about the bystander (§3.13.5 step 5 says
    // "the memories whose **only** subject is the member").
    expectWritten(
      world.repos.memories.insert(
        uow,
        memoryItem('ersbm', world.groupId, {
          statement: 'they both like tea',
          subjects: [
            { ref: mine, role: 'about' },
            { ref: theirs, role: 'about' },
          ],
        }),
        groupLabel(world.groupId),
        fingerprintFor('ersbm'),
      ),
      'the shared memory',
    );

    // A private memory under a label the subject owns, which is what §3.13.5 step 2 takes.
    expectWritten(
      world.repos.memories.insert(
        uow,
        memoryItem('ersprv', world.groupId, { statement: `a secret about ${CANARY}` }),
        groupLabel(world.groupId, {
          owner: mine,
          readers: { kind: 'members', groupId: world.groupId, memberIds: [mine] },
          sensitivity: 'personal',
        }),
        fingerprintFor('ersprv'),
      ),
      'the private memory',
    );
    // And one under a label they own that the **whole group** can read. An erasure takes this too
    // (§3.13.5 step 2 passes `all`), where a departure would not (`03`'s `onLeave` default is
    // `delete_private`). Without this row the erasure's choice of scope is untestable: the private
    // memory above matches either scope, so swapping `all` for `private_only` changed no test.
    expectWritten(
      world.repos.memories.insert(
        uow,
        memoryItem('erswn', world.groupId, { statement: `a note mentioning ${CANARY}` }),
        groupLabel(world.groupId, { owner: mine }),
        fingerprintFor('erswn'),
      ),
      'the member-owned group-readable memory',
    );

    // Participation rows, each named by `02` §3.13.5 steps 6 and 7.
    world.drizzle.run(
      sql`INSERT INTO consent_events (id, member_id, group_id, from_state, to_state, via, at)
          VALUES ('cev_01jersa00000000000000000000', ${mine}, ${world.groupId},
                  'unknown', 'memory_on', 'chat', ${T0.epochMilliseconds})`,
    );
    world.drizzle.run(
      sql`INSERT INTO message_reactions (message_rid, member_id, emoji, group_id, at)
          SELECT rid, ${mine}, '👍', ${world.groupId}, ${T0.epochMilliseconds}
            FROM messages WHERE id = ${messageId('ersb1')}`,
    );
    world.drizzle.run(
      sql`INSERT INTO catchup_cursors (member_id, conversation_id, last_interaction_at)
          VALUES (${mine}, ${groupConvId}, ${T0.epochMilliseconds})`,
    );
    // A usage record, which §3.13.5 step 8 keeps: ids and numbers only. Written through the
    // repository rather than with raw SQL, so the row is one the product could actually produce —
    // a hand-built insert here drifted from the schema twice before this comment existed.
    expectWritten(
      world.repos.usage.record(uow, {
        id: usageId('ersz'),
        groupId: world.groupId,
        route: 'chat',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        servedModel: 'claude-opus-5-5',
        purpose: 'reply',
        inputTokens: 10,
        cachedReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 5,
        costMicros: 100,
        priceTableVersion: 'v1',
        at: T0,
        dayLocal: '2026-11-08',
      }),
      'the usage record',
    );
  });
  return { memberId: mine, otherMemberId: theirs, dmId, groupConvId };
}

function erasureOf(world: World, chunkRows = 2): PersonErasure {
  return new PersonErasure({
    store: world.store,
    db: world.drizzle,
    connection: world.db,
    logger: silentLogger,
    chunkRows,
  });
}

function requestErasure(world: World): string {
  const record = world.store.write((uow) =>
    expectWritten(
      uow.deletions.requestPersonErasure(uow, {
        personId: personId(`${SUBJECT}p`),
        requestedBy: { kind: 'host' },
      }),
      'the erasure request',
    ),
  );
  return record.id;
}

function countOf(world: World, table: string, where = sql`1 = 1`): number {
  const rows = world.drizzle.all<{ n: number }>(
    sql`SELECT count(*) AS n FROM ${sql.identifier(table)} WHERE ${where}`,
  );
  return rows[0]?.n ?? 0;
}

describe('erasure.person (02 §9.3)', () => {
  it('leaves no trace of the canary anywhere', async () => {
    await withReposAsync(async (world) => {
      seed(world);
      // The premise, and it is not a formality: `findCanary` searching nothing would make the
      // assertion below vacuous, and this is the only thing that proves it searches at all.
      const before = findCanary(world.db, CANARY);
      expect(before.length).toBeGreaterThan(3);

      const deletionId = requestErasure(world);
      await erasureOf(world).run(deletionId as never);

      // Every place `02` §9.3 names, in four spellings. A surviving hit prints its table, column
      // and spelling, because "found in the WAL" and "found in a table" need different fixes.
      expect(findCanary(world.db, CANARY)).toEqual([]);
    });
  });

  it('renames the person rather than deleting the row', async () => {
    await withReposAsync(async (world) => {
      seed(world);
      const deletionId = requestErasure(world);
      await erasureOf(world).run(deletionId as never);

      const subject = world.repos.persons.byId(personId(`${SUBJECT}p`));
      // The row survives because `members.person_id` is a foreign key and a three-year-old
      // decision still has to render. What is gone is everything that identifies them.
      expect(subject?.displayName).toBe(ERASED_DISPLAY_NAME);
      expect(subject?.erasedAt).toBeDefined();
      expect(subject?.locale).toBeUndefined();
      expect(subject?.timezone).toBeUndefined();
      // And no identity resolves to them, which is what stops the router routing.
      expect(countOf(world, 'channel_identities')).toBe(0);
    });
  });

  it('marks every membership left, and leaves the bystander active', async () => {
    await withReposAsync(async (world) => {
      const seeded = seed(world);
      const deletionId = requestErasure(world);
      await erasureOf(world).run(deletionId as never);

      expect(world.repos.members.byId(world.groupId, seeded.memberId)?.status).toBe('left');
      expect(world.repos.members.byId(world.groupId, seeded.otherMemberId)?.status).toBe('active');
    });
  });

  it('redacts the sent messages and keeps the rows', async () => {
    await withReposAsync(async (world) => {
      seed(world);
      const deletionId = requestErasure(world);
      await erasureOf(world).run(deletionId as never);

      // `02` §3.3.3: a message anchors replies, reactions, a turn's trigger and a decision's
      // provenance. Deleting the row would make "Ana suggested Thursday" a decision nobody
      // proposed, so the text goes and the row stays.
      const sent = world.drizzle.all<{ text: string; redacted: number | null }>(
        sql`SELECT text, redacted_at AS redacted FROM messages WHERE id = ${messageId('ersg1')}`,
      );
      expect(sent[0]?.text).toBe('');
      expect(sent[0]?.redacted).not.toBeNull();
      // The bystander's message is untouched.
      const other = world.drizzle.all<{ text: string }>(
        sql`SELECT text FROM messages WHERE id = ${messageId('ersb1')}`,
      );
      expect(other[0]?.text).toBe('nothing to see here');
    });
  });

  it('deletes the DM conversation outright', async () => {
    await withReposAsync(async (world) => {
      const seeded = seed(world);
      const deletionId = requestErasure(world);
      await erasureOf(world).run(deletionId as never);

      // A DM has no other participant, so there is nothing for a redaction to preserve: §3.13.5
      // step 3 deletes the conversation and its messages.
      expect(world.repos.conversations.byId(world.groupId, seeded.dmId)).toBeUndefined();
      expect(countOf(world, 'messages', sql`conversation_id = ${seeded.dmId}`)).toBe(0);
      // The group conversation survives — it belongs to the group, not to the person.
      expect(world.repos.conversations.byId(world.groupId, seeded.groupConvId)).toBeDefined();
    });
  });

  it('deletes the sole-subject memory and keeps the shared one', async () => {
    await withReposAsync(async (world) => {
      seed(world);
      const deletionId = requestErasure(world);
      await erasureOf(world).run(deletionId as never);

      expect(countOf(world, 'memory_items', sql`id = ${memoryId('erssm')}`)).toBe(0);
      // Kept, and this is the clause most easily got wrong: `02` §3.13.5 step 5 says the memories
      // whose **only** subject is the member. One about two people is about the other one too.
      expect(countOf(world, 'memory_items', sql`id = ${memoryId('ersbm')}`)).toBe(1);
      // Its subject rows now name only the bystander.
      const subjects = world.drizzle.all<{ ref: string }>(
        sql`SELECT subject_ref AS ref FROM memory_subjects`,
      );
      expect(subjects.map((row) => row.ref)).toEqual([memberId(`${BYSTANDER}m`)]);
    });
  });

  it('deletes everything under a label the member owned', async () => {
    await withReposAsync(async (world) => {
      seed(world);
      expect(countOf(world, 'memory_items', sql`id = ${memoryId('ersprv')}`)).toBe(1);
      expect(countOf(world, 'memory_items', sql`id = ${memoryId('erswn')}`)).toBe(1);

      const deletionId = requestErasure(world);
      await erasureOf(world).run(deletionId as never);

      // Q-PRV-3: the label's owner is the member, so an erasure takes what is under it **whatever
      // its reader set says** — which is the difference from a departure, where `03`'s default
      // keeps the group-readable half. Both rows go here, and the second is the one that makes the
      // scope choice testable.
      expect(countOf(world, 'memory_items', sql`id = ${memoryId('ersprv')}`)).toBe(0);
      expect(countOf(world, 'memory_items', sql`id = ${memoryId('erswn')}`)).toBe(0);
    });
  });

  it('takes the participation rows and keeps the pseudonymous ones', async () => {
    await withReposAsync(async (world) => {
      seed(world);
      const deletionId = requestErasure(world);
      await erasureOf(world).run(deletionId as never);

      for (const table of ['consent_events', 'message_reactions', 'catchup_cursors']) {
        expect(countOf(world, table), `${table} is emptied`).toBe(0);
      }
      // `02` §3.13.5 step 8: kept, because the row is ids and numbers. The canary assertion above
      // is what makes that reasoning checkable rather than asserted.
      expect(countOf(world, 'usage_records')).toBe(1);
    });
  });

  it('unassigns an open task and leaves a finished one assigned', async () => {
    await withReposAsync(async (world) => {
      const seeded = seed(world);
      world.store.write((uow) => {
        for (const [tag, status] of [
          ['erst', 'open'],
          ['ersd', 'done'],
        ] as const) {
          expectWritten(
            world.repos.tasks.create(
              uow,
              {
                id: taskId(tag),
                groupId: world.groupId,
                title: `task ${tag}`,
                due: { kind: 'none' },
                assigneeMemberId: seeded.memberId,
                assignmentState: 'direct',
                status,
              },
              groupLabel(world.groupId),
            ),
            `task ${tag}`,
          );
        }
      });

      const deletionId = requestErasure(world);
      await erasureOf(world).run(deletionId as never);

      const rows = world.drizzle.all<{ id: string; assignee: string | null }>(
        sql`SELECT id, assignee_member_id AS assignee FROM tasks ORDER BY id`,
      );
      const byId = new Map(rows.map((row) => [row.id, row.assignee]));
      // `02` §3.13.5 step 7: "`tasks.assignee_member_id` → NULL for **open** tasks". A finished
      // task records who did it, and `07`'s fairness ledger reads exactly that — nulling it would
      // rewrite the group's history of who did the washing up. The fixture had no finished task
      // until a mutation showed that removing the status filter changed nothing.
      expect(byId.get(taskId('erst'))).toBeNull();
      expect(byId.get(taskId('ersd'))).toBe(seeded.memberId);
    });
  });

  it('refuses a second request and names the first', async () => {
    await withReposAsync(async (world) => {
      seed(world);
      const first = requestErasure(world);
      const again = world.store.write((uow) =>
        uow.deletions.requestPersonErasure(uow, {
          personId: personId(`${SUBJECT}p`),
          requestedBy: { kind: 'host' },
        }),
      );
      expect(again.kind).toBe('duplicate');
      expect(again.kind === 'duplicate' ? again.existingId : undefined).toBe(first);
    });
  });
});

describe('resumability (02 §9.3, D18)', () => {
  it('finishes when run twice, which is what at-least-once means', async () => {
    await withReposAsync(async (world) => {
      seed(world);
      const deletionId = requestErasure(world);

      // One row at a time, so every step loops and the progress cursor moves through all of them.
      const first = await erasureOf(world, 1).run(deletionId as never);
      expect(first.total).toBeGreaterThan(5);
      expect(findCanary(world.db, CANARY)).toEqual([]);

      // A lost lease means the handler runs again. Nothing may throw, and nothing may change.
      const second = await erasureOf(world, 1).run(deletionId as never);
      expect(second.counts).toEqual({});
      expect(second.total).toBe(first.total);
    });
  });

  it('records the step it reached, so a crash resumes rather than restarts', async () => {
    await withReposAsync(async (world) => {
      seed(world);
      const deletionId = requestErasure(world);
      await erasureOf(world, 1).run(deletionId as never);

      const record = world.store.write((uow) => uow.deletions.byId(deletionId as never));
      expect(record?.status).toBe('completed');
      // The cursor is the finish step and the counter is the running total — the two fields
      // `02` D18 needs, and the only two, because a per-table counter would exceed the column's
      // 64-key cap on a database with a few more tables.
      expect(record?.progress.step).toBe('finish');
      expect(record?.progress.counts['deleted']).toBeGreaterThan(5);
    });
  });
});
