/**
 * `turn-journal.recovery.test` and the turn journal's contract (`M1-T21`).
 *
 * The file carries the `.contract.` infix because `02` §9.3 lists this test under
 * **"Contract / integration"** and `vitest.config.ts` picks the pool from the filename: the `unit`
 * project runs on `threads`, which is reserved for pure code, while `contract` and `integration`
 * run on `forks` "because these load native modules (SQLCipher, sqlite-vec, onnxruntime)". Named
 * literally, this test would have been the only database-touching file in the threads pool — and
 * the same realisation as `store.tx-async-guard.test`, which `02` §9.3 also names bare and which
 * lives in `db/tx.int.test.ts`.
 *
 * `02` §2967 states the acceptance criterion as a sequence, and the first `describe` below is that
 * sequence, step by step: **effects without completion -> the recovery query finds them ->
 * `recover()` acks all -> the I7 query is empty**. The rest of the file covers the two invariants
 * the journal carries — I6 on the effect idempotency key, I7 on `ack_outbox_id` — and the
 * conventions `02` §3.7.1 requires of every repository.
 */
import { expectWritten, isOrphaned } from '@comvivo/core';
import { internedId, type ReaderSetId, StorageError } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { enqueueOutbox, outboxById, pendingForConversation } from '../outbox/enqueue.js';
import {
  conversationId,
  effectId,
  groupLabel,
  member,
  outboxId,
  person,
  T0,
  turnId,
  withRepos,
} from './testing/harness.js';
import { effectIdempotencyKey, ORPHANED_NO_EFFECTS } from './turns.js';

const DAY = 86_400_000;
const at = (days: number) =>
  Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + days * DAY);

const BOOT = 'boot-01';

/** A world with a conversation, a member and a frozen audience, which every turn needs. */
function withJournal<T>(
  fn: (
    world: Parameters<Parameters<typeof withRepos>[0]>[0],
    ids: { conversation: ReturnType<typeof conversationId>; who: string; readerSet: ReaderSetId },
  ) => T,
): T {
  return withRepos((world) => {
    const ids = world.store.write((uow) => {
      expectWritten(world.repos.persons.create(uow, person('a')), 'a person');
      const who = expectWritten(
        world.repos.members.add(uow, member('a', world.groupId)),
        'a member',
      ).id;
      const conversation = expectWritten(
        world.repos.conversations.create(uow, {
          id: conversationId('a'),
          groupId: world.groupId,
          channel: 'simulator',
          platformChatId: 'chat-a',
          kind: 'group',
          boundAt: T0,
        }),
        'a conversation',
      ).id;
      world.repos.labels.intern(uow, groupLabel(world.groupId));
      const readerSet = internedId(
        (world.db.prepare('SELECT id FROM reader_sets ORDER BY id LIMIT 1').get() as { id: number })
          .id,
        'reader_sets',
      );
      return { conversation, who, readerSet };
    });
    return fn(world, ids);
  });
}

type World = Parameters<Parameters<typeof withJournal>[0]>[0];
type Ids = Parameters<Parameters<typeof withJournal>[0]>[1];

const turn = (tag: string, world: World, ids: Ids, overrides = {}) => ({
  id: turnId(tag),
  groupId: world.groupId,
  conversationId: ids.conversation,
  kind: 'respond' as const,
  triggerMessageIds: [],
  requesterMemberId: ids.who as never,
  audienceReaderSetId: ids.readerSet,
  bootId: BOOT,
  startedAt: T0,
  deadlineAt: at(1),
  ...overrides,
});

const effect = (tag: string, turnOf: ReturnType<typeof turnId>, overrides = {}) => ({
  id: effectId(tag),
  turnId: turnOf,
  toolName: 'calendar.create',
  input: { title: `event ${tag}` },
  summaryKey: 'effect.calendar.created',
  summaryParams: { title: `event ${tag}` },
  ...overrides,
});

/** A send, already rendered and guarded by `05` before it reaches the journal. */
const send = (tag: string, world: World, ids: Ids, overrides = {}) => ({
  id: outboxId(tag),
  groupId: world.groupId,
  conversationId: ids.conversation,
  idempotencyKey: `rec:${tag}`,
  messageClass: 'system' as const,
  payload: { key: 'recovery.summary' },
  contentHash: new Uint8Array(32).fill(7),
  audienceReaderSetId: ids.readerSet,
  guardRef: 'grd-1',
  manifestLabelIds: [],
  nextAttemptAt: T0,
  ...overrides,
});

describe('turn-journal.recovery.test (02 §2967)', () => {
  it('finds a crashed turn`s effects, acks them all, and leaves the I7 query empty', () => {
    withJournal((world, ids) => {
      const label = groupLabel(world.groupId);
      // -- Step 1: effects without completion. A turn that journaled two effects and then died.
      const started = world.store.write((uow) => {
        const row = expectWritten(
          world.repos.journal.start(uow, turn('a1f', world, ids)),
          'a turn',
        );
        for (const tag of ['a1f', 'a2f']) {
          const journaled = expectWritten(
            world.repos.journal.journalEffect(uow, effect(tag, row.id), label),
            `effect ${tag}`,
          );
          // A23: journaled as `intent` *before* the tool runs, then settled after it returned.
          expect(journaled.status).toBe('intent');
          world.repos.journal.settleEffect(uow, row.id, journaled.id, {
            status: 'committed',
            at: T0,
          });
        }
        return row;
      });
      // The crash: the process went away with the turn still `running`. Nothing updated the row,
      // which is exactly why `boot_id` is a column.
      expect(world.repos.journal.turn(world.groupId, started.id)?.status).toBe('running');

      // -- Step 2: the recovery query finds them. Q-TRN-1, from a new process incarnation.
      const orphans = world.repos.journal.orphanedTurns({
        bootId: 'boot-02',
        now: T0,
        limit: 10,
      });
      expect(orphans.map((row) => row.id)).toEqual([started.id]);
      // And `core`'s rule agrees about the same row, from the same two halves.
      expect(isOrphaned(orphans[0] ?? started, 'boot-02', T0, Temporal.Instant.compare)).toBe(true);
      expect(world.repos.journal.unackedEffects(started.id)).toHaveLength(2);

      // -- Step 3: `recover()` acks all. One transaction: the summary, the acks, the status.
      const recovered = world.store.write((uow) =>
        expectWritten(
          world.repos.journal.recover(uow, started.id, send('a1f', world, ids)),
          'the recovery',
        ),
      );
      expect(recovered.status).toBe('recovered');
      expect(recovered.recoveryDone).toBe(true);

      // -- Step 4: the I7 query is empty.
      expect(world.repos.journal.unackedEffects(started.id)).toEqual([]);
      expect(world.repos.journal.failedWithUnackedEffects(10)).toEqual([]);
      expect(world.repos.journal.effectsAckedByDeadSends(10)).toEqual([]);
      // And every effect points at a send that is actually in the table. An ack pointing at
      // nothing would satisfy the query above while telling nobody anything.
      for (const row of world.repos.journal.effectsOf(started.id)) {
        expect(row.ackOutboxId).toBeDefined();
        expect(outboxById(world.drizzle, row.ackOutboxId ?? outboxId('zzf'))).toBeDefined();
      }
      expect(pendingForConversation(world.drizzle, ids.conversation, 10)).toHaveLength(1);
      // The turn is no longer orphaned, so a second boot does not recover it twice.
      expect(world.repos.journal.orphanedTurns({ bootId: 'boot-03', now: T0, limit: 10 })).toEqual(
        [],
      );
    });
  });

  it('finds a failed turn`s unacked effects too, which is the other half of 02 §3.8', () => {
    withJournal((world, ids) => {
      const label = groupLabel(world.groupId);
      const started = world.store.write((uow) => {
        const row = expectWritten(
          world.repos.journal.start(uow, turn('b1f', world, ids)),
          'a turn',
        );
        world.repos.journal.journalEffect(uow, effect('b1f', row.id), label);
        world.repos.journal.fail(uow, world.groupId, row.id, {
          code: 'TOOL_FAILED',
          message: 'the calendar refused',
          phase: 'tools',
          retryable: true,
          at: T0.toString(),
        });
        return row;
      });
      // `02` §3.8's failure row: "Unacked effects remain, and recovery covers them". A failed turn
      // is not found by Q-TRN-1 — its status is no longer `running` — so without this second query
      // its effects would be lost rather than deferred.
      expect(world.repos.journal.orphanedTurns({ bootId: 'boot-02', now: T0, limit: 10 })).toEqual(
        [],
      );
      expect(world.repos.journal.failedWithUnackedEffects(10).map((row) => row.id)).toEqual([
        started.id,
      ]);
      world.store.write((uow) =>
        world.repos.journal.recover(uow, started.id, send('b1f', world, ids)),
      );
      expect(world.repos.journal.failedWithUnackedEffects(10)).toEqual([]);
    });
  });

  it('abandons an orphan with no effects and sends nothing', () => {
    withJournal((world, ids) => {
      const started = world.store.write((uow) =>
        expectWritten(world.repos.journal.start(uow, turn('c1f', world, ids)), 'a turn'),
      );
      const abandoned = world.store.write((uow) =>
        expectWritten(world.repos.journal.abandon(uow, started.id, at(2)), 'the abandonment'),
      );
      // `02` §3.8: "Turns with zero effects are marked `failed` with
      // `failure.code='ORPHANED_NO_EFFECTS'`, and nothing is sent." The distinction is a product
      // one: a recovery summary for a turn that did nothing would tell the group about an event
      // with no consequences.
      expect(abandoned.status).toBe('failed');
      expect(abandoned.failure?.code).toBe(ORPHANED_NO_EFFECTS);
      expect(pendingForConversation(world.drizzle, ids.conversation, 10)).toEqual([]);
      expect(world.repos.journal.failedWithUnackedEffects(10)).toEqual([]);
    });
  });

  it('refuses to abandon a turn that has effects, and to recover one that has none', () => {
    withJournal((world, ids) => {
      const label = groupLabel(world.groupId);
      const withEffects = world.store.write((uow) => {
        const row = expectWritten(
          world.repos.journal.start(uow, turn('d1f', world, ids)),
          'a turn',
        );
        world.repos.journal.journalEffect(uow, effect('d1f', row.id), label);
        return row;
      });
      const without = world.store.write((uow) =>
        expectWritten(world.repos.journal.start(uow, turn('d2f', world, ids)), 'another turn'),
      );
      // The two paths are not interchangeable in either direction, and both wrong forms are quiet:
      // abandoning a turn with effects leaves the group never told about something that happened,
      // and recovering one without effects tells them about nothing.
      expect(() =>
        world.store.write((uow) => world.repos.journal.abandon(uow, withEffects.id, T0)),
      ).toThrow(/effects to acknowledge/);
      expect(() =>
        world.store.write((uow) =>
          world.repos.journal.recover(uow, without.id, send('d1f', world, ids)),
        ),
      ).toThrow(/nothing to acknowledge/);
    });
  });

  it('refuses a second recovery of an already-recovered turn', () => {
    withJournal((world, ids) => {
      const label = groupLabel(world.groupId);
      const started = world.store.write((uow) => {
        const row = expectWritten(
          world.repos.journal.start(uow, turn('e1f', world, ids)),
          'a turn',
        );
        world.repos.journal.journalEffect(uow, effect('e1f', row.id), label);
        return row;
      });
      world.store.write((uow) =>
        expectWritten(
          world.repos.journal.recover(uow, started.id, send('e1f', world, ids)),
          'the recovery',
        ),
      );
      const acked = world.repos.journal.effectsOf(started.id)[0]?.ackOutboxId;
      expect(acked).toBe(outboxId('e1f'));

      // A boot that crashed mid-recovery runs the pass again. The effects are already acked, so
      // there is nothing to do and nothing to send — and a second recovery summary would tell the
      // group twice about one failure.
      const second = world.store.write((uow) =>
        world.repos.journal.recover(
          uow,
          started.id,
          send('e2f', world, ids, { idempotencyKey: 'rec:e2f' }),
        ),
      );
      expect(second.kind).toBe('conflict');
      expect(world.repos.journal.effectsOf(started.id)[0]?.ackOutboxId).toBe(acked);
      expect(pendingForConversation(world.drizzle, ids.conversation, 10)).toHaveLength(1);
    });
  });
});

describe('I6: the effect idempotency key', () => {
  it('is the same for two orderings of the same input', () => {
    const root = turnId('a1f');
    // RFC 8785: `{a,b}` and `{b,a}` are the same call. A key that disagreed would run the tool
    // twice for a retry reconstructed from a different object ordering, which is the failure I6
    // names — and object key order is not something a caller controls.
    expect(effectIdempotencyKey(root, 'calendar.create', { a: 1, b: 2 })).toBe(
      effectIdempotencyKey(root, 'calendar.create', { b: 2, a: 1 }),
    );
    expect(effectIdempotencyKey(root, 'calendar.create', { a: 1 })).not.toBe(
      effectIdempotencyKey(root, 'calendar.create', { a: 2 }),
    );
    expect(effectIdempotencyKey(root, 'calendar.create', { a: 1 })).not.toBe(
      effectIdempotencyKey(root, 'calendar.delete', { a: 1 }),
    );
    expect(effectIdempotencyKey(root, 'calendar.create', { a: 1 })).not.toBe(
      effectIdempotencyKey(turnId('a2f'), 'calendar.create', { a: 1 }),
    );
  });

  it('does not let a separator in the tool name forge a collision', () => {
    const root = turnId('b1f');
    const nul = String.fromCodePoint(0);
    // The three parts are joined, so a tool name containing the separator could otherwise shift
    // the boundary and make two different calls hash identically. Checked with the **actual**
    // separator rather than a plausible one: a test using `:` would pass against a NUL-joined key
    // and prove nothing about it.
    expect(effectIdempotencyKey(root, `a${nul}b`, null)).not.toBe(
      effectIdempotencyKey(root, 'a', `${nul}b`),
    );
  });

  it('answers `duplicate` with the existing effect rather than running the tool again', () => {
    withJournal((world, ids) => {
      const label = groupLabel(world.groupId);
      const started = world.store.write((uow) =>
        expectWritten(world.repos.journal.start(uow, turn('f1f', world, ids)), 'a turn'),
      );
      const journaled = world.store.write((uow) =>
        expectWritten(
          world.repos.journal.journalEffect(uow, effect('f1f', started.id), label),
          'an effect',
        ),
      );
      // The same call under a **different effect id** — a retry that minted a new id, which is what
      // a restarted tool executor does. I6 says this is the same intent, so the caller must get the
      // id that is already journaled and must not run the tool.
      const retry = world.store.write((uow) =>
        world.repos.journal.journalEffect(
          uow,
          { ...effect('f1f', started.id), id: effectId('f2f') },
          label,
        ),
      );
      expect(retry.kind).toBe('duplicate');
      if (retry.kind !== 'duplicate') return;
      expect(retry.existingId).toBe(journaled.id);
      expect(world.repos.journal.effectsOf(started.id)).toHaveLength(1);
      // And the lookup `05` S2 uses before calling a tool finds it.
      expect(
        world.repos.journal.effectByKey(started.id, 'calendar.create', { title: 'event f1f' })?.id,
      ).toBe(journaled.id);
      expect(
        world.repos.journal.effectByKey(started.id, 'calendar.create', { title: 'other' }),
      ).toBeUndefined();
    });
  });

  it('numbers effects from zero, densely, per turn', () => {
    withJournal((world, ids) => {
      const label = groupLabel(world.groupId);
      const seqs = world.store.write((uow) => {
        const row = expectWritten(
          world.repos.journal.start(uow, turn('g1f', world, ids)),
          'a turn',
        );
        return ['g1f', 'g2f', 'g3f'].map(
          (tag) =>
            expectWritten(
              world.repos.journal.journalEffect(uow, effect(tag, row.id), label),
              `effect ${tag}`,
            ).seq,
        );
      });
      expect(seqs).toEqual([0, 1, 2]);
    });
  });

  it('does not reuse a position after one is gone', () => {
    withJournal((world, ids) => {
      const label = groupLabel(world.groupId);
      const started = world.store.write((uow) => {
        const row = expectWritten(
          world.repos.journal.start(uow, turn('g2f', world, ids)),
          'a turn',
        );
        for (const tag of ['g4f', 'g5f', 'g6f']) {
          world.repos.journal.journalEffect(uow, effect(tag, row.id), label);
        }
        return row;
      });
      // A gap, however it arose — a retention sweep, a repair. This is what makes the choice
      // between `max + 1` and `count` observable: `count` would be 2, which is taken, and
      // `turn_effects_turn_seq_uq` would refuse the insert. Written directly because no repository
      // method deletes an effect, which is exactly why the arithmetic needs a test of its own.
      world.db.prepare('DELETE FROM turn_effects WHERE seq = 1 AND turn_id = ?').run(started.id);
      const next = world.store.write((uow) =>
        expectWritten(
          world.repos.journal.journalEffect(uow, effect('g7f', started.id), label),
          'another effect',
        ),
      );
      expect(next.seq).toBe(3);
      expect(world.repos.journal.effectsOf(started.id).map((row) => row.seq)).toEqual([0, 2, 3]);
    });
  });
});

describe('the enqueue primitive the journal writes through (02 §3.9)', () => {
  it('numbers sends from one, per conversation, inside the transaction', () => {
    withJournal((world, ids) => {
      const sends = world.store.write((uow) =>
        ['y1f', 'y2f', 'y3f'].map(
          (tag) =>
            expectWritten(
              enqueueOutbox(world.drizzle, send(tag, world, ids, { idempotencyKey: tag }), uow.now),
              `send ${tag}`,
            ).seq,
        ),
      );
      // `02` §3.9: "`seq = coalesce((SELECT max(seq) …), 0) + 1`, computed inside the write
      // transaction". `seq` is the FIFO order a multi-part reply is sent in, so three parts
      // enqueued together must take three positions — all of them sharing one would leave the
      // dispatcher to pick an order, and a reply would arrive in pieces out of sequence.
      expect(sends).toEqual([1, 2, 3]);
      expect(
        pendingForConversation(world.drizzle, ids.conversation, 10).map((row) => row.id),
      ).toEqual([outboxId('y1f'), outboxId('y2f'), outboxId('y3f')]);
    });
  });

  it('answers `duplicate` with the row already under that key (I6)', () => {
    withJournal((world, ids) => {
      const first = world.store.write((uow) =>
        expectWritten(enqueueOutbox(world.drizzle, send('z1f', world, ids), uow.now), 'a send'),
      );
      // `02` §3.9(a): "a missing row means it was already enqueued". The caller needs the id that
      // is **in the table**, because that is what it will ack with — its own id points at nothing.
      const again = world.store.write((uow) =>
        enqueueOutbox(
          world.drizzle,
          send('z2f', world, ids, { idempotencyKey: 'rec:z1f' }),
          uow.now,
        ),
      );
      expect(again.kind).toBe('duplicate');
      if (again.kind !== 'duplicate') return;
      expect(again.existingId).toBe(first.id);
      expect(pendingForConversation(world.drizzle, ids.conversation, 10)).toHaveLength(1);
      expect(outboxById(world.drizzle, first.id)?.guardRef).toBe('grd-1');
      expect(outboxById(world.drizzle, outboxId('z9f'))).toBeUndefined();
    });
  });
});

describe('I7: acknowledged effects', () => {
  it('refuses to complete a turn whose effects nobody has been told about', () => {
    withJournal((world, ids) => {
      const label = groupLabel(world.groupId);
      const started = world.store.write((uow) => {
        const row = expectWritten(
          world.repos.journal.start(uow, turn('h1f', world, ids)),
          'a turn',
        );
        world.repos.journal.journalEffect(uow, effect('h1f', row.id), label);
        return row;
      });
      // `02` §3.8's "no reply" row: effects must be zero, or the engine must send an
      // acknowledgement. Refused rather than recorded, because a **completed** turn with unacked
      // effects is invisible to both recovery queries — they look at `running` and `failed` turns —
      // so accepting it would lose the effects instead of deferring them.
      expect(() =>
        world.store.write((uow) =>
          world.repos.journal.complete(uow, world.groupId, started.id, { at: T0 }),
        ),
      ).toThrow(/unacknowledged effects/);
      expect(world.repos.journal.turn(world.groupId, started.id)?.status).toBe('running');
    });
  });

  it('completes a turn with no effects and no reply', () => {
    withJournal((world, ids) => {
      const started = world.store.write((uow) =>
        expectWritten(world.repos.journal.start(uow, turn('j1f', world, ids)), 'a turn'),
      );
      // The `observe` case: nothing happened, so nothing needs acknowledging.
      const completed = world.store.write((uow) =>
        expectWritten(
          world.repos.journal.complete(uow, world.groupId, started.id, { at: at(1) }),
          'the completion',
        ),
      );
      expect(completed.status).toBe('completed');
      expect(completed.phase).toBeUndefined();
      expect(completed.completedAt?.epochMilliseconds).toBe(at(1).epochMilliseconds);
    });
  });

  it('acks every effect with the reply, in one transaction', () => {
    withJournal((world, ids) => {
      const label = groupLabel(world.groupId);
      const completed = world.store.write((uow) => {
        const row = expectWritten(
          world.repos.journal.start(uow, turn('k1f', world, ids)),
          'a turn',
        );
        for (const tag of ['k1f', 'k2f']) {
          world.repos.journal.journalEffect(uow, effect(tag, row.id), label);
        }
        // `02` §3.8's turn-end row: the sends are enqueued, then the effects are acked with the
        // **first** of them, then the turn completes — all in the one transaction.
        const reply = expectWritten(
          enqueueOutbox(world.drizzle, send('k1f', world, ids, { messageClass: 'reply' }), uow.now),
          'the reply',
        );
        return expectWritten(
          world.repos.journal.complete(uow, world.groupId, row.id, {
            ackOutboxId: reply.id,
            at: at(1),
          }),
          'the completion',
        );
      });
      expect(completed.status).toBe('completed');
      expect(world.repos.journal.unackedEffects(completed.id)).toEqual([]);
      expect(world.repos.journal.effectsOf(completed.id).map((row) => row.ackOutboxId)).toEqual([
        outboxId('k1f'),
        outboxId('k1f'),
      ]);
    });
  });

  it('finds effects acked only by a dead send', () => {
    withJournal((world, ids) => {
      const label = groupLabel(world.groupId);
      const completed = world.store.write((uow) => {
        const row = expectWritten(
          world.repos.journal.start(uow, turn('w1f', world, ids)),
          'a turn',
        );
        world.repos.journal.journalEffect(uow, effect('w1f', row.id), label);
        const reply = expectWritten(
          enqueueOutbox(world.drizzle, send('w1f', world, ids, { messageClass: 'reply' }), uow.now),
          'the reply',
        );
        return expectWritten(
          world.repos.journal.complete(uow, world.groupId, row.id, {
            ackOutboxId: reply.id,
            at: at(1),
          }),
          'the completion',
        );
      });
      expect(world.repos.journal.effectsAckedByDeadSends(10)).toEqual([]);
      // The send gave up. `M1-T22` owns the state machine that does this; written directly here
      // because the question is about the **journal's** audit, not about how a row died.
      world.db
        .prepare("UPDATE outbox_messages SET status = 'dead' WHERE id = ?")
        .run(outboxId('w1f'));
      // `02` §3.8's I7 audit. Worse than an unacked effect: the journal says the group was told,
      // so `unackedEffects` skips it and recovery would never look at it again.
      expect(world.repos.journal.effectsAckedByDeadSends(10).map((row) => row.id)).toEqual([
        effectId('w1f'),
      ]);
      expect(world.repos.journal.unackedEffects(completed.id)).toEqual([]);
    });
  });
});

describe('the journal`s conventions (02 §3.7.1)', () => {
  it('starts a turn as its own root unless told otherwise', () => {
    withJournal((world, ids) => {
      const [root, child] = world.store.write((uow) => {
        const first = expectWritten(
          world.repos.journal.start(uow, turn('m1f', world, ids)),
          'a root turn',
        );
        const second = expectWritten(
          world.repos.journal.start(
            uow,
            turn('m2f', world, ids, { rootTurnId: first.id, parentTurnId: first.id }),
          ),
          'a child turn',
        );
        return [first, second];
      });
      // `05` S2 scopes idempotency to the root, so a continuation's effects collide with the
      // original's rather than running again. A caller that had to set `rootTurnId = id` by hand
      // would eventually not, and the collision would stop happening silently.
      expect(root?.rootTurnId).toBe(root?.id);
      expect(child?.rootTurnId).toBe(root?.id);
      expect(child?.parentTurnId).toBe(root?.id);
    });
  });

  it('journals the effect under the root`s key, not the child`s', () => {
    withJournal((world, ids) => {
      const label = groupLabel(world.groupId);
      const journaled = world.store.write((uow) => {
        const root = expectWritten(
          world.repos.journal.start(uow, turn('n1f', world, ids)),
          'a root turn',
        );
        const child = expectWritten(
          world.repos.journal.start(uow, turn('n2f', world, ids, { rootTurnId: root.id })),
          'a child turn',
        );
        return expectWritten(
          world.repos.journal.journalEffect(uow, effect('n1f', child.id), label),
          'an effect',
        );
      });
      expect(journaled.rootTurnId).toBe(turnId('n1f'));
      expect(journaled.idempotencyKey).toBe(
        effectIdempotencyKey(turnId('n1f'), 'calendar.create', { title: 'event n1f' }),
      );
    });
  });

  it('settles an effect once, and refuses a second settle', () => {
    withJournal((world, ids) => {
      const label = groupLabel(world.groupId);
      const journaled = world.store.write((uow) => {
        const row = expectWritten(
          world.repos.journal.start(uow, turn('p1f', world, ids)),
          'a turn',
        );
        return expectWritten(
          world.repos.journal.journalEffect(uow, effect('p1f', row.id), label),
          'an effect',
        );
      });
      expect(journaled.committedAt).toBeUndefined();
      const settled = world.store.write((uow) =>
        expectWritten(
          world.repos.journal.settleEffect(uow, turnId('p1f'), journaled.id, {
            status: 'committed',
            resultCiphertext: new Uint8Array([1, 2, 3]),
            at: at(1),
          }),
          'the settlement',
        ),
      );
      expect(settled.status).toBe('committed');
      expect(settled.committedAt?.epochMilliseconds).toBe(at(1).epochMilliseconds);
      // The result is stored as a blob: `05`'s `resultJson`, field-encrypted, because a tool result
      // can contain anything the tool was asked about.
      expect(Buffer.from(settled.resultCiphertext ?? new Uint8Array()).toString('hex')).toBe(
        '010203',
      );
      // A second settle would overwrite the first outcome, and a tool that ran twice is exactly
      // what A23's `intent` row exists to make visible.
      expect(
        world.store.write((uow) =>
          world.repos.journal.settleEffect(uow, turnId('p1f'), journaled.id, {
            status: 'failed',
            at: at(2),
          }),
        ).kind,
      ).toBe('conflict');
    });
  });

  it('leaves committed_at unset for a failed effect', () => {
    withJournal((world, ids) => {
      const label = groupLabel(world.groupId);
      const settled = world.store.write((uow) => {
        const row = expectWritten(
          world.repos.journal.start(uow, turn('p2f', world, ids)),
          'a turn',
        );
        const journaled = expectWritten(
          world.repos.journal.journalEffect(uow, effect('p2f', row.id), label),
          'an effect',
        );
        return expectWritten(
          world.repos.journal.settleEffect(uow, row.id, journaled.id, {
            status: 'failed',
            at: at(1),
          }),
          'the settlement',
        );
      });
      // `committed_at` moves with the status, so the two cannot disagree about whether the effect
      // happened — which is the question A23's journal exists to answer after a crash.
      expect(settled.status).toBe('failed');
      expect(settled.committedAt).toBeUndefined();
    });
  });

  it('records a timeout distinctly from a failure', () => {
    withJournal((world, ids) => {
      const started = world.store.write((uow) =>
        expectWritten(world.repos.journal.start(uow, turn('q1f', world, ids)), 'a turn'),
      );
      const timedOut = world.store.write((uow) =>
        expectWritten(
          world.repos.journal.fail(
            uow,
            world.groupId,
            started.id,
            {
              code: 'DEADLINE',
              message: 'the turn outlived its deadline',
              phase: 'model_step',
              retryable: false,
              at: at(2).toString(),
            },
            'timed_out',
          ),
          'the timeout',
        ),
      );
      // The deadline passing is not an error anybody can fix, and `05` renders it differently —
      // so `timed_out_at` is stamped and the status is its own.
      expect(timedOut.status).toBe('timed_out');
      expect(timedOut.timedOutAt?.epochMilliseconds).toBe(at(2).epochMilliseconds);
      expect(timedOut.failure?.code).toBe('DEADLINE');
      // And a plain failure does not stamp it, or the column would stop meaning anything.
      const failed = world.store.write((uow) => {
        const row = expectWritten(
          world.repos.journal.start(uow, turn('q2f', world, ids)),
          'a turn',
        );
        return expectWritten(
          world.repos.journal.fail(uow, world.groupId, row.id, {
            code: 'TOOL_FAILED',
            message: 'x',
            phase: 'tools',
            retryable: true,
            at: T0.toString(),
          }),
          'the failure',
        );
      });
      expect(failed.status).toBe('failed');
      expect(failed.timedOutAt).toBeUndefined();
    });
  });

  it('moves the phase while running, and clears it at the end', () => {
    withJournal((world, ids) => {
      const started = world.store.write((uow) =>
        expectWritten(world.repos.journal.start(uow, turn('r2f', world, ids)), 'a turn'),
      );
      // Started in `building_context`: `05` S1's recovery reads the phase to know what to check,
      // and a turn that died before any phase was set would be indistinguishable from an idle one.
      expect(started.phase).toBe('building_context');
      const moved = world.store.write((uow) =>
        expectWritten(
          world.repos.journal.setPhase(uow, world.groupId, started.id, 'tools', 2),
          'the phase',
        ),
      );
      expect(moved.phase).toBe('tools');
      expect(moved.phaseStep).toBe(2);
    });
  });

  it('refuses a phase change, an effect and a completion on a finished turn', () => {
    withJournal((world, ids) => {
      const label = groupLabel(world.groupId);
      const started = world.store.write((uow) =>
        expectWritten(world.repos.journal.start(uow, turn('r1f', world, ids)), 'a turn'),
      );
      world.store.write((uow) =>
        world.repos.journal.complete(uow, world.groupId, started.id, { at: T0 }),
      );
      const after = world.store.write((uow) => [
        world.repos.journal.setPhase(uow, world.groupId, started.id, 'tools', 1),
        world.repos.journal.journalEffect(uow, effect('r1f', started.id), label),
        world.repos.journal.complete(uow, world.groupId, started.id, { at: T0 }),
        world.repos.journal.fail(uow, world.groupId, started.id, {
          code: 'X',
          message: 'x',
          phase: null,
          retryable: false,
          at: T0.toString(),
        }),
      ]);
      // An effect against a finished turn would never be acknowledged by it, so I7 would be broken
      // by a row the engine could not see it had created.
      expect(after.map((result) => result.kind)).toEqual([
        'conflict',
        'conflict',
        'conflict',
        'conflict',
      ]);
    });
  });

  it('answers `not_found` and `duplicate` the way 02 §3.7.1 requires', () => {
    withJournal((world, ids) => {
      const started = world.store.write((uow) =>
        expectWritten(world.repos.journal.start(uow, turn('s1f', world, ids)), 'a turn'),
      );
      const answers = world.store.write((uow) => [
        world.repos.journal.start(uow, turn('s1f', world, ids)),
        world.repos.journal.setPhase(uow, world.groupId, turnId('s9f'), 'tools', 1),
        world.repos.journal.journalEffect(
          uow,
          effect('s1f', turnId('s9f')),
          groupLabel(world.groupId),
        ),
        world.repos.journal.settleEffect(uow, started.id, effectId('s9f'), {
          status: 'committed',
          at: T0,
        }),
        world.repos.journal.complete(uow, world.groupId, turnId('s9f'), { at: T0 }),
        world.repos.journal.abandon(uow, turnId('s9f'), T0),
      ]);
      expect(answers.map((result) => result.kind)).toEqual([
        'duplicate',
        'not_found',
        'not_found',
        'not_found',
        'not_found',
        'not_found',
      ]);
      expect(world.repos.journal.turn(world.groupId, turnId('s9f'))).toBeUndefined();
      expect(world.repos.journal.effectsOf(turnId('s9f'))).toEqual([]);
    });
  });

  it('does not reach another group', () => {
    withJournal((world, ids) => {
      const started = world.store.write((uow) =>
        expectWritten(world.repos.journal.start(uow, turn('t1f', world, ids)), 'a turn'),
      );
      expect(world.repos.journal.turn(world.otherGroupId, started.id)).toBeUndefined();
      expect(
        world.repos.journal.recentTurns({
          groupId: world.otherGroupId,
          conversationId: ids.conversation,
          limit: 10,
        }),
      ).toEqual([]);
      let caught: unknown;
      try {
        world.store.write((uow) =>
          world.repos.journal.journalEffect(
            uow,
            effect('t1f', started.id),
            groupLabel(world.otherGroupId),
          ),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StorageError);
      expect((caught as StorageError).message).toMatch(/another group/);
    });
  });

  it('lists a conversation`s turns newest first (Q-TRN-3)', () => {
    withJournal((world, ids) => {
      world.store.write((uow) => {
        for (const [tag, day] of [
          ['x1f', 0],
          ['x2f', 2],
          ['x3f', 1],
        ] as const) {
          world.repos.journal.start(uow, turn(tag, world, ids, { startedAt: at(day) }));
        }
      });
      expect(
        world.repos.journal
          .recentTurns({ groupId: world.groupId, conversationId: ids.conversation, limit: 10 })
          .map((row) => row.id),
      ).toEqual([turnId('x2f'), turnId('x3f'), turnId('x1f')]);
    });
  });

  it('finds an orphan by its deadline as well as by its boot', () => {
    withJournal((world, ids) => {
      world.store.write((uow) =>
        world.repos.journal.start(uow, turn('v1f', world, ids, { deadlineAt: at(1) })),
      );
      // The same boot, still running it — but past the deadline, so it should not be. Either half
      // alone would miss a real case: a different boot catches a crash, and a passed deadline
      // catches a turn this process has wedged.
      expect(world.repos.journal.orphanedTurns({ bootId: BOOT, now: T0, limit: 10 })).toEqual([]);
      expect(
        world.repos.journal.orphanedTurns({ bootId: BOOT, now: at(2), limit: 10 }).map((r) => r.id),
      ).toEqual([turnId('v1f')]);
      expect(
        isOrphaned(
          { status: 'completed', bootId: 'other', deadlineAt: T0 },
          BOOT,
          at(2),
          Temporal.Instant.compare,
        ),
      ).toBe(false);
    });
  });
});
