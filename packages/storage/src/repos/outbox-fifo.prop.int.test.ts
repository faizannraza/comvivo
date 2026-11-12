/**
 * `outbox.fifo.property` (`M1-T22`; `02` §3.9, §9.2).
 *
 * The property, verbatim from `02` §9.2: **per conversation, `sent` order == `seq` order under
 * random failures and retries.**
 *
 * Stating it over a *random* sequence of failures is the whole point. Any single happy path sends
 * in order; what has to hold is that no reachable mixture of timeouts, rate limits, lost leases and
 * permanent failures can let a conversation's third message land before its second. The failure
 * mode is specific and bad: `06` splits a long reply into several rows, and a reply whose parts
 * arrive 2, 1, 3 is worse than no reply at all — the group reads nonsense and has no way to tell
 * that something went wrong.
 *
 * The model is a dispatcher: recover expired leases, claim, then succeed or fail each claimed row
 * according to the generated script. It records the order in which receipts were taken, which is
 * the "`sent` order" the property is about — the platform's own ordering is `06`'s problem, and
 * storage's guarantee is that it never *offers* a send out of turn.
 */
import type { OutboxMessage } from '@comvivo/core';
import { expectWritten } from '@comvivo/core';
import { internedId, type ReaderSetId } from '@comvivo/shared';
import { fcConfig } from '@comvivo/shared/testing';
import fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LEASE_MS } from '../outbox/repository.js';
import {
  conversationId,
  groupLabel,
  member,
  messageId,
  outboxId,
  person,
  T0,
  withRepos,
} from './testing/harness.js';

/** What the dispatcher does with a claimed row on this tick. */
type Outcome = 'sent' | 'retryable' | 'ambiguous' | 'permanent' | 'abandon';

const outcome = fc.constantFrom<Outcome>(
  // Weighted towards success, because a run where nothing ever succeeds proves only that nothing
  // was sent. `abandon` is the dropped lease: the dispatcher claimed and then vanished.
  'sent',
  'sent',
  'sent',
  'retryable',
  'ambiguous',
  'permanent',
  'abandon',
);

const script = fc.record({
  /** How many sends to enqueue, split across two conversations. */
  sends: fc.integer({ min: 2, max: 8 }),
  /** How many rows the dispatcher may take per tick — 1 exercises strict head-of-line order. */
  batch: fc.integer({ min: 1, max: 3 }),
  outcomes: fc.array(outcome, { minLength: 10, maxLength: 40 }),
});

/**
 * Apply one generated outcome to one claimed row, returning the `seq` if it was delivered.
 *
 * Extracted because the dispatcher loop was deciding, writing and recording in one function, and
 * Biome's complexity score was right that it had stopped being readable — which matters more here
 * than usual: the loop *is* the model the property is checked against, so an unreadable one makes
 * the property unverifiable by inspection.
 */
function settle(
  world: Parameters<Parameters<typeof withRepos>[0]>[0],
  uow: Parameters<Parameters<(typeof world)['store']['write']>[0]>[0],
  row: OutboxMessage,
  decision: Outcome,
  now: Temporal.Instant,
  tick: number,
  label: ReturnType<typeof groupLabel>,
): number | undefined {
  // `abandon` is the dropped lease: the dispatcher claimed and then vanished, so nothing is
  // written and the next tick's `recoverSending` picks the row up.
  if (decision === 'abandon') return undefined;
  if (decision === 'sent') {
    expectWritten(
      world.repos.outbox.markSent(
        uow,
        row.id,
        row.attempts,
        { platformMessageId: `plat-${row.id}`, at: now },
        {
          message: {
            id: messageId(`m${tick.toString(16)}${row.seq.toString(16)}f`),
            groupId: world.groupId,
            conversationId: row.conversationId,
            kind: 'assistant',
            text: `part ${String(row.seq)}`,
            sentAt: now,
            receivedAt: now,
          },
          label,
        },
      ),
      'the receipt',
    );
    return row.seq;
  }
  world.repos.outbox.markFailed(
    uow,
    row.id,
    row.attempts,
    {
      error: {
        code: decision === 'permanent' ? 'CHAT_ACCESS_LOST' : 'RATE_LIMITED',
        message: 'generated',
        retryable: decision !== 'permanent',
        at: now.toString(),
      },
      maybeSent: decision === 'ambiguous',
    },
    now,
  );
  return undefined;
}

describe('outbox.fifo.property (02 §9.2)', { tags: ['prop', 'db'] }, () => {
  it('sends each conversation in seq order under random failures and retries', () => {
    let receipts = 0;
    fc.assert(
      fc.property(script, (plan) => {
        withRepos((world) => {
          const ids = seed(world);
          const label = groupLabel(world.groupId);
          // Alternating conversations, so a run always has two queues to interleave — the case
          // where a stuck head in one must not block the other, and must not let its own second
          // message overtake.
          world.store.write((uow) => {
            for (let index = 0; index < plan.sends; index += 1) {
              world.repos.outbox.enqueue(uow, {
                id: outboxId(`p${index.toString(16)}f`),
                groupId: world.groupId,
                conversationId: index % 2 === 0 ? ids.first : ids.second,
                idempotencyKey: `trn:p${String(index)}`,
                messageClass: 'reply',
                payload: { text: `part ${String(index)}` },
                contentHash: new Uint8Array(32).fill(index + 1),
                audienceReaderSetId: ids.readerSet,
                guardRef: 'grd-1',
                manifestLabelIds: [],
                nextAttemptAt: T0,
              });
            }
          });

          /** The receipts taken, per conversation, in the order the dispatcher took them. */
          const delivered = new Map<string, number[]>();
          let clock = T0.epochMilliseconds;

          for (const [tick, decision] of plan.outcomes.entries()) {
            // Always far enough ahead that a dropped lease from the previous tick has expired, so
            // `abandon` is reachable rather than theoretical.
            clock += DEFAULT_LEASE_MS * 2;
            const now = Temporal.Instant.fromEpochMilliseconds(clock);
            const claimed = world.store.write((uow) => {
              world.repos.outbox.recoverSending(uow, { now, before: now });
              return world.repos.outbox.claim(uow, {
                now,
                leaseMs: DEFAULT_LEASE_MS,
                limit: plan.batch,
              });
            });
            if (claimed.length === 0) continue;

            world.store.write((uow) => {
              for (const row of claimed) {
                const seq = settle(world, uow, row, decision, now, tick, label);
                if (seq === undefined) continue;
                const taken = delivered.get(row.conversationId) ?? [];
                taken.push(seq);
                delivered.set(row.conversationId, taken);
              }
            });
          }

          // ── The property.
          for (const [conversation, seqs] of delivered) {
            // Strictly increasing: each receipt was for a later position than the one before it.
            expect(seqs, `conversation ${conversation} received its sends out of order`).toEqual(
              [...seqs].toSorted((left, right) => left - right),
            );
            // And no position twice, which a FIFO claim also has to guarantee — a row claimed
            // again after a receipt would be a duplicate send, not merely a reordering.
            expect(new Set(seqs).size).toBe(seqs.length);
          }
          receipts += [...delivered.values()].reduce((sum, seqs) => sum + seqs.length, 0);
        });
      }),
      fcConfig(),
    );
    // Non-vacuity, asserted over the **whole** run rather than per case. A single generated script
    // can legitimately deliver nothing — `sends: 4, batch: 3` with three `permanent` outcomes kills
    // every head before any receipt, which is a real sequence and not a bug. Asserting it per case
    // failed on exactly that counterexample; asserting it here still catches the thing that
    // matters, which is a dispatcher model that never sends anything and an ordering property that
    // is therefore about an empty list.
    expect(receipts).toBeGreaterThan(20);
  });

  it('never offers a send while an earlier one in its conversation is unresolved', () => {
    withRepos((world) => {
      const ids = seed(world);
      world.store.write((uow) => {
        for (const [index, tag] of ['a1f', 'a2f', 'a3f'].entries()) {
          world.repos.outbox.enqueue(uow, {
            id: outboxId(tag),
            groupId: world.groupId,
            conversationId: ids.first,
            idempotencyKey: `trn:${tag}`,
            messageClass: 'reply',
            payload: { text: `part ${String(index)}` },
            contentHash: new Uint8Array(32).fill(index + 1),
            audienceReaderSetId: ids.readerSet,
            guardRef: 'grd-1',
            manifestLabelIds: [],
            nextAttemptAt: T0,
          });
        }
      });
      // The head is claimed and then fails, over and over. The property the `seq = min(seq)`
      // subquery buys is that the *second* part is never offered meanwhile — not even once, and
      // not even when the head has been pending for an hour. A dispatcher that skipped a
      // persistently failing head would deliver a reply's second half on its own.
      let now = T0;
      for (let round = 0; round < 5; round += 1) {
        const claimed = world.store.write((uow) =>
          world.repos.outbox.claim(uow, { now, leaseMs: DEFAULT_LEASE_MS, limit: 10 }),
        );
        expect(claimed.map((row) => row.id)).toEqual([outboxId('a1f')]);
        const row = claimed[0];
        if (row === undefined) throw new Error('fixture');
        const failed = world.store.write((uow) =>
          expectWritten(
            world.repos.outbox.markFailed(
              uow,
              row.id,
              row.attempts,
              {
                error: {
                  code: 'RATE_LIMITED',
                  message: 'slow down',
                  retryable: true,
                  at: now.toString(),
                },
              },
              now,
            ),
            'the failure',
          ),
        );
        now = failed.nextAttemptAt;
      }
      expect(world.repos.outbox.queued(ids.first, 10).map((row) => row.seq)).toEqual([1, 2, 3]);
    });
  });
});

/** A group with two conversations and an interned audience. */
function seed(world: Parameters<Parameters<typeof withRepos>[0]>[0]): {
  first: ReturnType<typeof conversationId>;
  second: ReturnType<typeof conversationId>;
  readerSet: ReaderSetId;
} {
  return world.store.write((uow) => {
    expectWritten(world.repos.persons.create(uow, person('a')), 'a person');
    expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'a member');
    const made = (['a', 'b'] as const).map(
      (tag) =>
        expectWritten(
          world.repos.conversations.create(uow, {
            id: conversationId(tag),
            groupId: world.groupId,
            channel: 'simulator',
            platformChatId: `chat-${tag}`,
            kind: 'group',
            boundAt: T0,
          }),
          `conversation ${tag}`,
        ).id,
    );
    world.repos.labels.intern(uow, groupLabel(world.groupId));
    const readerSet = internedId(
      (world.db.prepare('SELECT id FROM reader_sets ORDER BY id LIMIT 1').get() as { id: number })
        .id,
      'reader_sets',
    );
    const [first, second] = made;
    if (first === undefined || second === undefined) throw new Error('fixture');
    return { first, second, readerSet };
  });
}
