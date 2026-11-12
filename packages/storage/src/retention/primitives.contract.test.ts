/**
 * `DeletionPrimitives` at the primitive level (`M1-T26`; `02` §3.13.3).
 *
 * The three acceptance criteria — `retention.cascade`, `group.purge`, `erasure.person` — all drive
 * these through a job, which is the right way to test what the product does and the wrong way to
 * test what each primitive promises. A mutation run over the first draft of this task made the
 * difference concrete: deleting the `derived_from` loop from `redactMessage`, the attachment delete
 * from the same method, the `status = 'open'` filter from `tasks.unassign`, the group scope from
 * `deleteMemory`, the completed fence from `complete` and the reader-set kind from the private-label
 * filter were **all** invisible to the three job-level suites, because none of their fixtures
 * reached the inputs those lines exist for.
 *
 * So this file is one case per promise, with the input that reaches it.
 */
import { expectWritten } from '@comvivo/core';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  conversationId,
  deletionId,
  fingerprintFor,
  groupLabel,
  memberId as memberIdOf,
  memoryId,
  memoryItem,
  messageId,
  person,
  personId,
  T0,
  type World,
  withRepos,
} from '../repos/testing/harness.js';

const BLOB_SHA = 'c'.repeat(64);

/** A member of the primary group, plus a conversation to hang messages on. */
function withMember(world: World): {
  readonly mine: ReturnType<typeof memberIdOf>;
  readonly convId: ReturnType<typeof conversationId>;
} {
  const mine = memberIdOf('dpa');
  const convId = conversationId('dpcv');
  world.store.write((uow) => {
    expectWritten(world.repos.persons.create(uow, person('dpp')), 'the person');
    expectWritten(
      world.repos.members.add(uow, {
        id: mine,
        groupId: world.groupId,
        personId: personId('dpp'),
        role: 'member',
        status: 'active',
        joinedAt: T0,
      }),
      'the member',
    );
    expectWritten(
      world.repos.conversations.create(uow, {
        id: convId,
        groupId: world.groupId,
        channel: 'simulator',
        platformChatId: 'chat-dp',
        kind: 'group',
        boundAt: T0,
      }),
      'the conversation',
    );
  });
  return { mine, convId };
}

/**
 * Run `deleteByLabelOwnerChunk` to exhaustion.
 *
 * Bounded by a step count rather than by `remaining` alone: each call strictly reduces the number
 * of matching rows, so a loop that does not terminate means that invariant is broken — and a test
 * that hangs says much less than one that fails.
 */
function drain(
  world: World,
  memberId: ReturnType<typeof memberIdOf>,
  scope: 'private_only' | 'all',
): void {
  for (let step = 0; step < 50; step += 1) {
    const chunk = world.store.write((uow) =>
      uow.deletions.deleteByLabelOwnerChunk(uow, world.groupId, memberId, scope, 10),
    );
    if (!chunk.remaining) return;
  }
  throw new Error(`deleteByLabelOwnerChunk did not finish in 50 chunks (${scope})`);
}

function countOf(world: World, table: string, where = sql`1 = 1`): number {
  const rows = world.drizzle.all<{ n: number }>(
    sql`SELECT count(*) AS n FROM ${sql.identifier(table)} WHERE ${where}`,
  );
  return rows[0]?.n ?? 0;
}

describe('redactMessage (02 §3.13.3)', () => {
  it('redacts the message and everything derived from it', () => {
    withRepos((world) => {
      const { mine, convId } = withMember(world);
      world.store.write((uow) => {
        expectWritten(
          world.repos.messages.insert(
            uow,
            {
              id: messageId('dpvn'),
              groupId: world.groupId,
              conversationId: convId,
              kind: 'member',
              senderMemberId: mine,
              text: 'a voice note',
              sentAt: T0,
              receivedAt: T0,
            },
            groupLabel(world.groupId),
          ),
          'the voice note',
        );
        // A transcription. **This is the input the `derived_from` loop exists for**, and no
        // job-level fixture produced one — so deleting that loop changed no test while leaving the
        // content of a redacted voice note sitting in the conversation as a separate message.
        expectWritten(
          world.repos.messages.insert(
            uow,
            {
              id: messageId('dptr'),
              groupId: world.groupId,
              conversationId: convId,
              kind: 'derived',
              derivedFromMessageId: messageId('dpvn'),
              text: 'the words that were said',
              sentAt: T0,
              receivedAt: T0,
            },
            groupLabel(world.groupId),
          ),
          'the transcription',
        );
      });

      const stamped = world.store.write((uow) =>
        expectWritten(
          uow.deletions.redactMessage(uow, world.groupId, messageId('dpvn')),
          'the redaction',
        ),
      );
      // Two: the message and its child. The count is the assertion — a method that redacted only
      // the parent would return 1 and leave the transcription readable.
      expect(stamped).toBe(2);
      const rows = world.drizzle.all<{ id: string; text: string; redacted: number | null }>(
        sql`SELECT id, text, redacted_at AS redacted FROM messages ORDER BY rid`,
      );
      expect(rows.map((row) => row.text)).toEqual(['', '']);
      expect(rows.every((row) => row.redacted !== null)).toBe(true);
    });
  });

  it('deletes the attachments, which is what unreferences the blob', () => {
    withRepos((world) => {
      const { mine, convId } = withMember(world);
      world.store.write((uow) => {
        expectWritten(
          world.repos.messages.insert(
            uow,
            {
              id: messageId('dpat'),
              groupId: world.groupId,
              conversationId: convId,
              kind: 'member',
              senderMemberId: mine,
              text: 'see attached',
              sentAt: T0,
              receivedAt: T0,
            },
            groupLabel(world.groupId),
          ),
          'the message',
        );
        world.drizzle.run(
          sql`INSERT INTO blobs (group_id, sha256, size_bytes, mime, storage_addr, wrapped_dek,
                                 wrap_nonce, kek_version, state, created_at)
              VALUES (${world.groupId}, ${BLOB_SHA}, 7, 'image/png', ${'d'.repeat(64)},
                      ${Buffer.alloc(48, 1)}, ${Buffer.alloc(24, 2)}, 1, 'stored',
                      ${T0.epochMilliseconds})`,
        );
        world.drizzle.run(
          sql`INSERT INTO message_attachments
                (id, message_id, group_id, kind, platform_ref, mime, size_bytes, blob_sha256,
                 status, label_id, created_at)
              SELECT 'att_01jdpat0000000000000000000', ${messageId('dpat')}, ${world.groupId},
                     'image', 'platform:att:9', 'image/png', 7, ${BLOB_SHA}, 'stored', label_id,
                     ${T0.epochMilliseconds}
                FROM messages WHERE id = ${messageId('dpat')}`,
        );
      });
      expect(countOf(world, 'message_attachments')).toBe(1);

      world.store.write((uow) =>
        uow.deletions.redactMessage(uow, world.groupId, messageId('dpat')),
      );

      // The row carries a mime type and a size and no content — but the file it points at *is* the
      // content, so keeping the pointer keeps the file: `02` §3.11's GC collects a blob only once
      // nothing references it. Tombstoning the message and keeping the attachment would leave the
      // picture on disk forever.
      expect(countOf(world, 'message_attachments')).toBe(0);
      expect(countOf(world, 'blobs')).toBe(1);
    });
  });

  it('refuses a message of another group', () => {
    withRepos((world) => {
      const { mine, convId } = withMember(world);
      world.store.write((uow) =>
        expectWritten(
          world.repos.messages.insert(
            uow,
            {
              id: messageId('dpxg'),
              groupId: world.groupId,
              conversationId: convId,
              kind: 'member',
              senderMemberId: mine,
              text: 'ours',
              sentAt: T0,
              receivedAt: T0,
            },
            groupLabel(world.groupId),
          ),
          'the message',
        ),
      );
      const result = world.store.write((uow) =>
        uow.deletions.redactMessage(uow, world.otherGroupId, messageId('dpxg')),
      );
      expect(result.kind).toBe('not_found');
    });
  });
});

describe('deleteMemory (02 §3.13.3)', () => {
  it('deletes the item and lets the schema take the rest', () => {
    withRepos((world) => {
      world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('dpm', world.groupId, {
              subjects: [{ ref: memberIdOf('dpa'), role: 'about' }],
            }),
            groupLabel(world.groupId),
            fingerprintFor('dpm'),
          ),
          'the memory',
        ),
      );
      expect(countOf(world, 'memory_subjects')).toBe(1);

      const result = world.store.write((uow) =>
        uow.deletions.deleteMemory(uow, world.groupId, memoryId('dpm')),
      );
      expect(result.kind).toBe('ok');
      expect(countOf(world, 'memory_items')).toBe(0);
      // Cascaded, not deleted here. A primitive that did this itself would be a second
      // implementation of a constraint the database already enforces — and the one that drifts.
      expect(countOf(world, 'memory_subjects')).toBe(0);
    });
  });

  it('refuses an item of another group, however valid the id', () => {
    withRepos((world) => {
      world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('dpn', world.groupId),
            groupLabel(world.groupId),
            fingerprintFor('dpn'),
          ),
          'the memory',
        ),
      );
      // `I4`. The id is unique instance-wide, so a primitive that deleted by id alone is a
      // primitive a caller can point at a neighbour's row — and the caller here is a job handler
      // reading an id out of a payload.
      const result = world.store.write((uow) =>
        uow.deletions.deleteMemory(uow, world.otherGroupId, memoryId('dpn')),
      );
      expect(result.kind).toBe('not_found');
      expect(countOf(world, 'memory_items')).toBe(1);
    });
  });
});

describe('deleteByLabelOwner scopes (02 §3.13.3, Q-PRV-3)', () => {
  /** A member-owned label whose readers are the whole group, and one whose readers are just them. */
  function seedOwnedLabels(world: World, mine: ReturnType<typeof memberIdOf>): void {
    world.store.write((uow) => {
      expectWritten(
        world.repos.memories.insert(
          uow,
          memoryItem('dpsh', world.groupId, { statement: 'a list the group can read' }),
          // Owned by the member, readable by everyone: data they *created*, not data about them.
          groupLabel(world.groupId, { owner: mine }),
          fingerprintFor('dpsh'),
        ),
        'the shared memory',
      );
      expectWritten(
        world.repos.memories.insert(
          uow,
          memoryItem('dpsc', world.groupId, { statement: 'a note only they can read' }),
          groupLabel(world.groupId, {
            owner: mine,
            readers: { kind: 'members', groupId: world.groupId, memberIds: [mine] },
            sensitivity: 'personal',
          }),
          fingerprintFor('dpsc'),
        ),
        'the private memory',
      );
    });
  }

  it('`private_only` takes the private row and leaves the group-readable one', () => {
    withRepos((world) => {
      const { mine } = withMember(world);
      seedOwnedLabels(world, mine);

      drain(world, mine, 'private_only');

      // `02` §3.13.3's `readers ⊆ {m}` example, which is `03`'s default on a **departure**: a
      // label the member owns that the whole group can read is group data they happened to create,
      // and taking it would delete the shopping list along with the person who started it.
      expect(countOf(world, 'memory_items', sql`id = ${memoryId('dpsc')}`)).toBe(0);
      expect(countOf(world, 'memory_items', sql`id = ${memoryId('dpsh')}`)).toBe(1);
    });
  });

  it('`all` takes both, which is what an erasure needs', () => {
    withRepos((world) => {
      const { mine } = withMember(world);
      seedOwnedLabels(world, mine);

      drain(world, mine, 'all');
      // An erasure is not a departure. `02` §3.13.5 step 2 says "covering private memories,
      // constraint policies and DM-only data", and the right to be forgotten does not stop at the
      // reader set.
      expect(countOf(world, 'memory_items')).toBe(0);
    });
  });

  it('leaves a group-owned label alone under either scope', () => {
    withRepos((world) => {
      const { mine } = withMember(world);
      world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('dpgw', world.groupId),
            // `owner: 'group'` — nobody's private data, so no member's erasure touches it.
            groupLabel(world.groupId),
            fingerprintFor('dpgw'),
          ),
          'the group memory',
        ),
      );
      for (const scope of ['private_only', 'all'] as const) {
        const chunk = world.store.write((uow) =>
          uow.deletions.deleteByLabelOwnerChunk(uow, world.groupId, mine, scope, 10),
        );
        expect(chunk, scope).toEqual({ deleted: 0, remaining: false });
      }
      expect(countOf(world, 'memory_items')).toBe(1);
    });
  });
});

describe('the deletion record (02 §3.3.8)', () => {
  function requested(world: World): ReturnType<typeof deletionId> {
    const record = world.store.write((uow) =>
      expectWritten(
        uow.deletions.requestPersonErasure(uow, {
          personId: personId('dprq'),
          requestedBy: { kind: 'host' },
        }),
        'the request',
      ),
    );
    return record.id;
  }

  it('completes once and reports a duplicate after that', () => {
    withRepos((world) => {
      const id = requested(world);
      const first = world.store.write((uow) => uow.deletions.complete(uow, id, uow.now));
      expect(first.kind).toBe('ok');

      // The job is at-least-once, so a lost lease means the handler finishes twice. The second
      // call has to be distinguishable from the first: a handler treating `ok` as "I finished it"
      // would log a second completion and emit a second audit event for one deletion.
      const second = world.store.write((uow) => uow.deletions.complete(uow, id, uow.now));
      expect(second.kind).toBe('duplicate');
    });
  });

  it('refuses to advance a completed deletion', () => {
    withRepos((world) => {
      const id = requested(world);
      world.store.write((uow) => uow.deletions.complete(uow, id, uow.now));

      // A fence, not a filter: a handler whose lease expired mid-step can wake after another
      // runner finished the job, and advancing a completed row would reopen it — leaving a
      // `running` deletion nobody is working on and a cursor pointing at a step already done.
      const result = world.store.write((uow) =>
        uow.deletions.advance(uow, id, { step: 'messages', cursor: null, counts: {} }),
      );
      expect(result.kind).toBe('not_found');
      expect(world.store.write((uow) => uow.deletions.byId(id))?.status).toBe('completed');
    });
  });

  it('reports not_found for an id that was never written', () => {
    withRepos((world) => {
      const result = world.store.write((uow) =>
        uow.deletions.complete(uow, deletionId('dpzz'), uow.now),
      );
      expect(result.kind).toBe('not_found');
    });
  });
});
