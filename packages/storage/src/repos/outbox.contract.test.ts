/**
 * The outbox state machine (`M1-T22`; `02` §3.9, `06` §4.3).
 *
 * `02` §3.9 draws a state machine, and this file walks every arrow in it. Three of them are where
 * the correctness lives:
 *
 *  - **the claim is FIFO per conversation**, so a split reply leaves in order;
 *  - **the receipt writes the assistant message in the same transaction**, because Q-ING-5 is how
 *    the router recognises a reply to the bot;
 *  - **every settling write is fenced on `attempts`**, so a dispatcher whose lease expired cannot
 *    report a stale outcome over a live send.
 */
import { expectWritten, type NotPromise, OUTBOX_BACKOFF } from '@comvivo/core';
import { internedId, type ReaderSetId, StorageError } from '@comvivo/shared';
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

const MINUTE = 60_000;
const at = (ms: number) => Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + ms);

/** A world with two conversations, so a FIFO claim has something to interleave. */
function withOutbox<T>(
  fn: (
    world: Parameters<Parameters<typeof withRepos>[0]>[0],
    ids: {
      first: ReturnType<typeof conversationId>;
      second: ReturnType<typeof conversationId>;
      readerSet: ReaderSetId;
    },
  ) => NotPromise<T>,
): T {
  return withRepos((world) => {
    const ids = world.store.write((uow) => {
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
    return fn(world, ids);
  });
}

type World = Parameters<Parameters<typeof withOutbox>[0]>[0];
type Ids = Parameters<Parameters<typeof withOutbox>[0]>[1];

const send = (tag: string, world: World, ids: Ids, overrides: Record<string, unknown> = {}) => ({
  id: outboxId(tag),
  groupId: world.groupId,
  conversationId: ids.first,
  idempotencyKey: `trn:${tag}`,
  messageClass: 'reply' as const,
  payload: { text: `reply ${tag}` },
  contentHash: hashOf(tag),
  audienceReaderSetId: ids.readerSet,
  guardRef: `grd-${tag}`,
  manifestLabelIds: [],
  nextAttemptAt: T0,
  ...overrides,
});

/** A distinct content hash per tag, so Q-OBX-3's dedupe has something to distinguish. */
function hashOf(tag: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (const [index, code] of [...tag].entries()) bytes[index] = code.codePointAt(0) ?? 0;
  return bytes;
}

/** The assistant message a receipt writes, as `02` §3.9's receipt row requires. */
const reply = (tag: string, world: World, ids: Ids) => ({
  message: {
    id: messageId(tag),
    groupId: world.groupId,
    conversationId: ids.first,
    kind: 'assistant' as const,
    text: `reply ${tag}`,
    sentAt: T0,
    receivedAt: T0,
  },
  label: groupLabel(world.groupId),
});

const RETRYABLE = {
  code: 'RATE_LIMITED',
  message: 'the platform asked us to slow down',
  retryable: true,
  at: T0.toString(),
} as const;

const PERMANENT = {
  code: 'CHAT_ACCESS_LOST',
  message: 'the bot is no longer in that chat',
  retryable: false,
  at: T0.toString(),
} as const;

describe('enqueue → claim (02 §3.9)', () => {
  it('claims the FIFO head per conversation, not merely the oldest due row', () => {
    withOutbox((world, ids) => {
      world.store.write((uow) => {
        // Three parts of one reply in the first conversation, one in the second. The second
        // conversation's row is **due earlier**, so an implementation that ordered only by
        // `next_attempt_at` would send it between the parts of the split reply.
        for (const tag of ['a1f', 'a2f', 'a3f']) {
          world.repos.outbox.enqueue(uow, send(tag, world, ids, { nextAttemptAt: at(MINUTE) }));
        }
        world.repos.outbox.enqueue(
          uow,
          send('a4f', world, ids, { conversationId: ids.second, idempotencyKey: 'trn:a4f' }),
        );
      });
      const claimed = world.store.write((uow) =>
        world.repos.outbox.claim(uow, {
          now: at(2 * MINUTE),
          leaseMs: DEFAULT_LEASE_MS,
          limit: 10,
        }),
      );
      // One row per conversation: the head of each. `02` §3.9's inner
      // `seq = (SELECT min(seq) …)` is what does it, and without it all four would come back and a
      // three-part reply could arrive 2, 1, 3.
      expect(claimed.map((row) => row.id)).toEqual([outboxId('a1f'), outboxId('a4f')]);
      expect(claimed.map((row) => row.status)).toEqual(['sending', 'sending']);
      // `attempts` is the fencing token, so the claim increments it.
      expect(claimed.map((row) => row.attempts)).toEqual([1, 1]);
      expect(claimed[0]?.leaseUntil?.epochMilliseconds).toBe(
        at(2 * MINUTE).epochMilliseconds + DEFAULT_LEASE_MS,
      );
      expect(claimed[0]?.inFlightSince?.epochMilliseconds).toBe(at(2 * MINUTE).epochMilliseconds);
      // The second part is still queued behind the first, which is now `sending`.
      expect(world.repos.outbox.queued(ids.first, 10).map((row) => [row.seq, row.status])).toEqual([
        [1, 'sending'],
        [2, 'pending'],
        [3, 'pending'],
      ]);
    });
  });

  it('does not offer the second part while the first is in flight', () => {
    withOutbox((world, ids) => {
      world.store.write((uow) => {
        for (const tag of ['a5f', 'a6f'] as const) {
          world.repos.outbox.enqueue(uow, send(tag, world, ids, { idempotencyKey: `trn:${tag}` }));
        }
      });
      const first = world.store.write((uow) =>
        world.repos.outbox.claim(uow, { now: T0, leaseMs: DEFAULT_LEASE_MS, limit: 10 }),
      );
      expect(first.map((row) => row.id)).toEqual([outboxId('a5f')]);
      // The head is `sending` — claimed, not yet settled — and the second part must stay put. This
      // is the case the `h.status IN ('pending','sending')` half of the subquery buys: with only
      // `'pending'` the in-flight head stops counting, the second row becomes the minimum, and a
      // second dispatcher slot sends part two while part one is still on the wire. Deleting that
      // half left every other test green, because they all settle the head before claiming again.
      expect(
        world.store.write((uow) =>
          world.repos.outbox.claim(uow, {
            now: at(1_000),
            leaseMs: DEFAULT_LEASE_MS,
            limit: 10,
          }),
        ),
      ).toEqual([]);
      expect(world.repos.outbox.byId(outboxId('a6f'))?.status).toBe('pending');
      expect(world.repos.outbox.byId(outboxId('a6f'))?.attempts).toBe(0);
    });
  });

  it('does not claim a row that is not due yet', () => {
    withOutbox((world, ids) => {
      world.store.write((uow) =>
        world.repos.outbox.enqueue(uow, send('b1f', world, ids, { nextAttemptAt: at(MINUTE) })),
      );
      expect(
        world.store.write((uow) =>
          world.repos.outbox.claim(uow, { now: T0, leaseMs: DEFAULT_LEASE_MS, limit: 10 }),
        ),
      ).toEqual([]);
      expect(
        world.store
          .write((uow) =>
            world.repos.outbox.claim(uow, {
              now: at(MINUTE),
              leaseMs: DEFAULT_LEASE_MS,
              limit: 10,
            }),
          )
          .map((row) => row.id),
      ).toEqual([outboxId('b1f')]);
    });
  });

  it('claims nothing twice, so two dispatchers cannot take the same send', () => {
    withOutbox((world, ids) => {
      world.store.write((uow) => {
        world.repos.outbox.enqueue(uow, send('c1f', world, ids));
        world.repos.outbox.enqueue(
          uow,
          send('c2f', world, ids, { conversationId: ids.second, idempotencyKey: 'trn:c2f' }),
        );
      });
      const first = world.store.write((uow) =>
        world.repos.outbox.claim(uow, { now: T0, leaseMs: DEFAULT_LEASE_MS, limit: 10 }),
      );
      const second = world.store.write((uow) =>
        world.repos.outbox.claim(uow, { now: T0, leaseMs: DEFAULT_LEASE_MS, limit: 10 }),
      );
      // The claim is one `UPDATE … RETURNING`, so the rows it returns are the rows it moved. A
      // select-then-update would hand the same send to both.
      expect(first).toHaveLength(2);
      expect(second).toEqual([]);
    });
  });

  it('honours its limit, and returns the rows in send order', () => {
    withOutbox((world, ids) => {
      world.store.write((uow) => {
        for (const [index, tag] of ['d1f', 'd2f', 'd3f'].entries()) {
          world.repos.outbox.enqueue(
            uow,
            send(tag, world, ids, {
              conversationId: index === 0 ? ids.first : ids.second,
              idempotencyKey: `trn:${tag}`,
            }),
          );
        }
      });
      const claimed = world.store.write((uow) =>
        world.repos.outbox.claim(uow, { now: T0, leaseMs: DEFAULT_LEASE_MS, limit: 1 }),
      );
      expect(claimed).toHaveLength(1);
      // Sorted by `seq` in the repository, because SQLite's `RETURNING` makes no ordering promise
      // — a dispatcher that sent in the order it received would undo the FIFO the claim
      // established.
      const rest = world.store.write((uow) =>
        world.repos.outbox.claim(uow, { now: T0, leaseMs: DEFAULT_LEASE_MS, limit: 10 }),
      );
      expect(rest.map((row) => row.seq)).toEqual([...rest.map((row) => row.seq)].toSorted());
    });
  });
});

describe('sending → sent (02 §3.9)', () => {
  it('records the receipt and writes the assistant message in one transaction', () => {
    withOutbox((world, ids) => {
      const claimed = world.store.write((uow) => {
        world.repos.outbox.enqueue(uow, send('e1f', world, ids));
        return world.repos.outbox.claim(uow, {
          now: T0,
          leaseMs: DEFAULT_LEASE_MS,
          limit: 1,
        })[0];
      });
      if (claimed === undefined) throw new Error('fixture');
      const settled = world.store.write((uow) =>
        expectWritten(
          world.repos.outbox.markSent(
            uow,
            claimed.id,
            claimed.attempts,
            { platformMessageId: 'plat-1', at: at(1_000) },
            reply('e1f', world, ids),
          ),
          'the receipt',
        ),
      );
      expect(settled.sent.status).toBe('sent');
      expect(settled.sent.platformMessageId).toBe('plat-1');
      expect(settled.sent.sentAt?.epochMilliseconds).toBe(at(1_000).epochMilliseconds);
      expect(settled.sent.leaseUntil).toBeUndefined();
      // Q-ING-5: the router recognises "a reply to a Village message" by finding it in `messages`,
      // so a receipt without the message leaves the bot unable to recognise its own words. The
      // platform id on the message is what the lookup keys on.
      expect(settled.message.kind).toBe('assistant');
      expect(world.repos.messages.byPlatformId(ids.first, 'plat-1')?.id).toBe(messageId('e1f'));
    });
  });

  it('refuses a receipt under a different label than the send', () => {
    withOutbox((world, ids) => {
      const claimed = world.store.write((uow) => {
        world.repos.outbox.enqueue(
          uow,
          send('f1f', world, ids, {
            labelId: world.repos.labels.intern(uow, groupLabel(world.groupId)),
          }),
        );
        return world.repos.outbox.claim(uow, {
          now: T0,
          leaseMs: DEFAULT_LEASE_MS,
          limit: 1,
        })[0];
      });
      if (claimed === undefined) throw new Error('fixture');
      // A message written under a label the guard never approved it for would be an I1 hole that
      // no later read could detect — every read would honour the stored label as if it had been
      // checked. So the repository compares rather than trusts.
      let caught: unknown;
      try {
        world.store.write((uow) =>
          world.repos.outbox.markSent(
            uow,
            claimed.id,
            claimed.attempts,
            { platformMessageId: 'plat-2', at: T0 },
            {
              ...reply('f1f', world, ids),
              label: groupLabel(world.groupId, { sensitivity: 'sensitive' }),
            },
          ),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StorageError);
      expect((caught as StorageError).message).toMatch(/different label/);
      // And a label from another group is refused before the comparison, as an I4 violation.
      expect(() =>
        world.store.write((uow) =>
          world.repos.outbox.markSent(
            uow,
            claimed.id,
            claimed.attempts,
            { platformMessageId: 'plat-3', at: T0 },
            { ...reply('f1f', world, ids), label: groupLabel(world.otherGroupId) },
          ),
        ),
      ).toThrow(/another group/);
    });
  });

  it('refuses a receipt at a stale attempt count (the fence)', () => {
    withOutbox((world, ids) => {
      const claimed = world.store.write((uow) => {
        world.repos.outbox.enqueue(uow, send('g1f', world, ids));
        return world.repos.outbox.claim(uow, {
          now: T0,
          leaseMs: DEFAULT_LEASE_MS,
          limit: 1,
        })[0];
      });
      if (claimed === undefined) throw new Error('fixture');
      // The dispatcher's lease expired and another worker retried: the row is now at attempt 2.
      world.store.write((uow) => {
        world.repos.outbox.recoverSending(uow, {
          now: at(DEFAULT_LEASE_MS + 1),
          before: at(DEFAULT_LEASE_MS + 1),
        });
        return world.repos.outbox.claim(uow, {
          now: at(DEFAULT_LEASE_MS + 2),
          leaseMs: DEFAULT_LEASE_MS,
          limit: 1,
        });
      });
      // The first dispatcher comes back and reports success for attempt 1. Without the fence it
      // would overwrite a live send's state with a stale receipt — and the message it wrote would
      // claim a platform id the second attempt never produced.
      const late = world.store.write((uow) =>
        world.repos.outbox.markSent(
          uow,
          claimed.id,
          claimed.attempts,
          { platformMessageId: 'plat-stale', at: T0 },
          reply('g1f', world, ids),
        ),
      );
      expect(late.kind).toBe('conflict');
      expect(world.repos.outbox.byId(claimed.id)?.status).toBe('sending');
      expect(world.repos.outbox.byId(claimed.id)?.attempts).toBe(2);
    });
  });

  it('refuses a receipt for a send that is no longer in flight', () => {
    withOutbox((world, ids) => {
      const claimed = world.store.write((uow) => {
        world.repos.outbox.enqueue(uow, send('g2f', world, ids));
        world.repos.outbox.enqueue(
          uow,
          send('g3f', world, ids, { conversationId: ids.second, idempotencyKey: 'trn:g3f' }),
        );
        return world.repos.outbox.claim(uow, { now: T0, leaseMs: DEFAULT_LEASE_MS, limit: 10 });
      });
      const [retried, killed] = claimed;
      if (retried === undefined || killed === undefined) throw new Error('fixture');
      // Two rows settled by a failure, which leaves `attempts` where the claim put it: one back to
      // `pending`, one `dead`. A late receipt arrives for each, carrying the **same** attempt
      // number the fence was given — so the `attempts = ?` half matches, and only
      // `status = 'sending'` refuses it.
      world.store.write((uow) => {
        world.repos.outbox.markFailed(uow, retried.id, retried.attempts, { error: RETRYABLE }, T0);
        world.repos.outbox.markFailed(uow, killed.id, killed.attempts, { error: PERMANENT }, T0);
      });
      const late = world.store.write((uow) => [
        world.repos.outbox.markSent(
          uow,
          retried.id,
          retried.attempts,
          { platformMessageId: 'plat-late-1', at: T0 },
          reply('g2f', world, ids),
        ),
        world.repos.outbox.markSent(
          uow,
          killed.id,
          killed.attempts,
          { platformMessageId: 'plat-late-2', at: T0 },
          {
            ...reply('g2f', world, ids),
            message: {
              ...reply('g2f', world, ids).message,
              id: messageId('g3f'),
              conversationId: ids.second,
            },
          },
        ),
      ]);
      // Without the status half, the first would mark a **pending** row sent — and the dispatcher
      // would still claim and send it again, which is the duplicate the whole fence exists to
      // prevent. The second would revive a dead row into `sent` with nothing having gone out.
      expect(late.map((result) => result.kind)).toEqual(['conflict', 'conflict']);
      expect(world.repos.outbox.byId(retried.id)?.status).toBe('pending');
      expect(world.repos.outbox.byId(killed.id)?.status).toBe('dead');
      expect(world.repos.messages.byPlatformId(ids.first, 'plat-late-1')).toBeUndefined();
    });
  });

  it('clears `maybe_sent` once the platform confirms', () => {
    withOutbox((world, ids) => {
      const recovered = world.store.write((uow) => {
        world.repos.outbox.enqueue(uow, send('h1f', world, ids));
        world.repos.outbox.claim(uow, { now: T0, leaseMs: DEFAULT_LEASE_MS, limit: 1 });
        world.repos.outbox.recoverSending(uow, {
          now: at(DEFAULT_LEASE_MS + 1),
          before: at(DEFAULT_LEASE_MS + 1),
        });
        return world.repos.outbox.claim(uow, {
          now: at(DEFAULT_LEASE_MS + 2),
          leaseMs: DEFAULT_LEASE_MS,
          limit: 1,
        })[0];
      });
      if (recovered === undefined) throw new Error('fixture');
      expect(recovered.maybeSent).toBe(true);
      const settled = world.store.write((uow) =>
        expectWritten(
          world.repos.outbox.markSent(
            uow,
            recovered.id,
            recovered.attempts,
            { platformMessageId: 'plat-4', at: at(99_000) },
            reply('h1f', world, ids),
          ),
          'the receipt',
        ),
      );
      // The ambiguity is resolved. A row that stayed `maybe_sent` after a receipt would send
      // `06` §3.13's duplicate probe looking for a message we already have the id of.
      expect(settled.sent.maybeSent).toBe(false);
    });
  });
});

describe('sending → pending / dead (02 §3.9)', () => {
  it('backs a retryable failure off, with the jitter 02 §3.10.3 specifies', () => {
    withOutbox((world, ids) => {
      const claimed = world.store.write((uow) => {
        world.repos.outbox.enqueue(uow, send('j1f', world, ids));
        return world.repos.outbox.claim(uow, {
          now: T0,
          leaseMs: DEFAULT_LEASE_MS,
          limit: 1,
        })[0];
      });
      if (claimed === undefined) throw new Error('fixture');
      const failed = world.store.write((uow) =>
        expectWritten(
          world.repos.outbox.markFailed(
            uow,
            claimed.id,
            claimed.attempts,
            { error: RETRYABLE },
            T0,
          ),
          'the failure',
        ),
      );
      expect(failed.status).toBe('pending');
      expect(failed.lastError?.code).toBe('RATE_LIMITED');
      expect(failed.leaseUntil).toBeUndefined();
      // Equal jitter: the first retry waits between half the base and the whole of it, never
      // zero. A full-jitter formula could return nearly nothing here, which turns a backoff into a
      // hot loop against a platform that just rate-limited us.
      const waited = failed.nextAttemptAt.epochMilliseconds - T0.epochMilliseconds;
      expect(waited).toBeGreaterThanOrEqual(OUTBOX_BACKOFF.baseMs / 2);
      expect(waited).toBeLessThanOrEqual(OUTBOX_BACKOFF.baseMs);
    });
  });

  it('takes a platform retry-after when it asks for longer', () => {
    withOutbox((world, ids) => {
      const claimed = world.store.write((uow) => {
        world.repos.outbox.enqueue(uow, send('k1f', world, ids));
        return world.repos.outbox.claim(uow, {
          now: T0,
          leaseMs: DEFAULT_LEASE_MS,
          limit: 1,
        })[0];
      });
      if (claimed === undefined) throw new Error('fixture');
      const failed = world.store.write((uow) =>
        expectWritten(
          world.repos.outbox.markFailed(
            uow,
            claimed.id,
            claimed.attempts,
            { error: RETRYABLE, retryAfterMs: 5 * MINUTE },
            T0,
          ),
          'the failure',
        ),
      );
      // A server asking for longer is telling us something we do not know. One asking for shorter
      // would let a client talk itself out of its own backoff, which is how a rate limit becomes a
      // ban — so `02` §3.10.3 takes the override only when it is larger.
      expect(failed.nextAttemptAt.epochMilliseconds).toBe(T0.epochMilliseconds + 5 * MINUTE);
    });
  });

  it('kills a permanent failure on the first attempt', () => {
    withOutbox((world, ids) => {
      const claimed = world.store.write((uow) => {
        world.repos.outbox.enqueue(uow, send('m1f', world, ids));
        return world.repos.outbox.claim(uow, {
          now: T0,
          leaseMs: DEFAULT_LEASE_MS,
          limit: 1,
        })[0];
      });
      if (claimed === undefined) throw new Error('fixture');
      const failed = world.store.write((uow) =>
        expectWritten(
          world.repos.outbox.markFailed(
            uow,
            claimed.id,
            claimed.attempts,
            { error: PERMANENT },
            T0,
          ),
          'the failure',
        ),
      );
      // Retrying a `410 Gone` is a loop with no exit, so `retryable: false` is terminal
      // immediately rather than after ten attempts.
      expect(failed.status).toBe('dead');
      expect(world.repos.outbox.dead(10).map((row) => row.id)).toEqual([outboxId('m1f')]);
      // And it is no longer claimable, which is what makes `dead` a resting state.
      expect(
        world.store.write((uow) =>
          world.repos.outbox.claim(uow, { now: at(MINUTE), leaseMs: DEFAULT_LEASE_MS, limit: 10 }),
        ),
      ).toEqual([]);
    });
  });

  it('kills a retryable failure once its attempts are spent', () => {
    withOutbox((world, ids) => {
      world.store.write((uow) => world.repos.outbox.enqueue(uow, send('n1f', world, ids)));
      let last = world.repos.outbox.byId(outboxId('n1f'));
      // Ten attempts, which is `02` §3.9's `maxAttempts`. The tenth must be the last — an
      // off-by-one here is a row that retries forever, and nothing else in the system would notice
      // because each individual retry looks reasonable.
      for (let attempt = 1; attempt <= OUTBOX_BACKOFF.maxAttempts; attempt += 1) {
        const claimed = world.store.write((uow) =>
          world.repos.outbox.claim(uow, {
            now: last?.nextAttemptAt ?? T0,
            leaseMs: DEFAULT_LEASE_MS,
            limit: 1,
          }),
        )[0];
        expect(claimed?.attempts).toBe(attempt);
        if (claimed === undefined) throw new Error('fixture');
        last = world.store.write((uow) =>
          expectWritten(
            world.repos.outbox.markFailed(
              uow,
              claimed.id,
              claimed.attempts,
              { error: RETRYABLE },
              claimed.nextAttemptAt,
            ),
            `failure ${String(attempt)}`,
          ),
        );
        expect(last.status).toBe(attempt < OUTBOX_BACKOFF.maxAttempts ? 'pending' : 'dead');
      }
      expect(last?.attempts).toBe(OUTBOX_BACKOFF.maxAttempts);
    });
  });

  it('records an ambiguous failure as maybe-sent', () => {
    withOutbox((world, ids) => {
      const claimed = world.store.write((uow) => {
        world.repos.outbox.enqueue(uow, send('p1f', world, ids));
        return world.repos.outbox.claim(uow, {
          now: T0,
          leaseMs: DEFAULT_LEASE_MS,
          limit: 1,
        })[0];
      });
      if (claimed === undefined) throw new Error('fixture');
      const failed = world.store.write((uow) =>
        expectWritten(
          world.repos.outbox.markFailed(
            uow,
            claimed.id,
            claimed.attempts,
            {
              error: { ...RETRYABLE, code: 'TIMEOUT', message: 'no answer after 30 s' },
              maybeSent: true,
            },
            T0,
          ),
          'the failure',
        ),
      );
      // `06` §3.13: a timeout after the request was written may or may not have been delivered.
      // Storage records the ambiguity; the platform's capability class decides what to do with it.
      expect(failed.maybeSent).toBe(true);
      expect(failed.status).toBe('pending');
    });
  });

  it('re-queues a dead row with its full budget', () => {
    withOutbox((world, ids) => {
      const claimed = world.store.write((uow) => {
        world.repos.outbox.enqueue(uow, send('q1f', world, ids));
        return world.repos.outbox.claim(uow, {
          now: T0,
          leaseMs: DEFAULT_LEASE_MS,
          limit: 1,
        })[0];
      });
      if (claimed === undefined) throw new Error('fixture');
      world.store.write((uow) =>
        world.repos.outbox.markFailed(uow, claimed.id, claimed.attempts, { error: PERMANENT }, T0),
      );
      const retried = world.store.write((uow) =>
        expectWritten(world.repos.outbox.retryDead(uow, claimed.id, at(MINUTE)), 'the retry'),
      );
      // `attempts = 0`, because a host asking for a retry means they fixed the cause — a row that
      // came back with nine attempts spent would die again on the first hiccup.
      expect(retried.status).toBe('pending');
      expect(retried.attempts).toBe(0);
      expect(
        world.store.write((uow) => world.repos.outbox.retryDead(uow, claimed.id, at(MINUTE))).kind,
      ).toBe('conflict');
      expect(
        world.store.write((uow) => world.repos.outbox.retryDead(uow, outboxId('z9f'), T0)).kind,
      ).toBe('not_found');
    });
  });
});

describe('duplicate defence (02 §3.9 a–c)', () => {
  it('answers `duplicate` for a repeated idempotency key (I6)', () => {
    withOutbox((world, ids) => {
      const first = world.store.write((uow) =>
        expectWritten(world.repos.outbox.enqueue(uow, send('r1f', world, ids)), 'a send'),
      );
      const again = world.store.write((uow) =>
        world.repos.outbox.enqueue(uow, send('r2f', world, ids, { idempotencyKey: 'trn:r1f' })),
      );
      expect(again.kind).toBe('duplicate');
      if (again.kind !== 'duplicate') return;
      // The id **in the table**, because that is what the turn journal will acknowledge its
      // effects with — the caller's own id points at nothing.
      expect(again.existingId).toBe(first.id);
      expect(world.repos.outbox.queued(ids.first, 10)).toHaveLength(1);
    });
  });

  it('finds a recently sent row with the same content (Q-OBX-3)', () => {
    withOutbox((world, ids) => {
      const claimed = world.store.write((uow) => {
        world.repos.outbox.enqueue(uow, send('s1f', world, ids));
        return world.repos.outbox.claim(uow, {
          now: T0,
          leaseMs: DEFAULT_LEASE_MS,
          limit: 1,
        })[0];
      });
      if (claimed === undefined) throw new Error('fixture');
      world.store.write((uow) =>
        world.repos.outbox.markSent(
          uow,
          claimed.id,
          claimed.attempts,
          { platformMessageId: 'plat-5', at: at(MINUTE) },
          reply('s1f', world, ids),
        ),
      );
      // The same text again, which is what a retried turn or a double-triggered digest produces.
      // `02` §3.9(b) is the second line of defence after the idempotency key, because the two
      // sends have different keys and the same words.
      expect(world.repos.outbox.recentlySent(ids.first, hashOf('s1f'), at(0))?.id).toBe(
        outboxId('s1f'),
      );
      // Outside the window, the same words are a legitimate repeat — "ok" twice in an hour is not
      // a bug, and suppressing it would make the bot look broken.
      expect(
        world.repos.outbox.recentlySent(ids.first, hashOf('s1f'), at(2 * MINUTE)),
      ).toBeUndefined();
      // Different content, and a different conversation, are both not duplicates.
      expect(world.repos.outbox.recentlySent(ids.first, hashOf('zzz'), at(0))).toBeUndefined();
      expect(world.repos.outbox.recentlySent(ids.second, hashOf('s1f'), at(0))).toBeUndefined();
    });
  });

  it('cancels a row that has not been delivered, and refuses to cancel one that has', () => {
    withOutbox((world, ids) => {
      const claimed = world.store.write((uow) => {
        world.repos.outbox.enqueue(uow, send('t1f', world, ids));
        world.repos.outbox.enqueue(
          uow,
          send('t2f', world, ids, { conversationId: ids.second, idempotencyKey: 'trn:t2f' }),
        );
        return world.repos.outbox.claim(uow, {
          now: T0,
          leaseMs: DEFAULT_LEASE_MS,
          limit: 1,
        })[0];
      });
      if (claimed === undefined) throw new Error('fixture');
      const duplicate = {
        code: 'DUPLICATE_CONTENT',
        message: 'the same text was sent moments ago',
        retryable: false,
        at: T0.toString(),
      } as const;
      // A pending row cancels (the Q-OBX-3 case), and so does an in-flight one (`06` F1's detach).
      const cancelled = world.store.write((uow) =>
        expectWritten(world.repos.outbox.cancel(uow, outboxId('t2f'), duplicate), 'the cancel'),
      );
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.lastError?.code).toBe('DUPLICATE_CONTENT');
      expect(
        world.store.write((uow) => world.repos.outbox.cancel(uow, claimed.id, duplicate)).kind,
      ).toBe('ok');

      // A **sent** row cannot be cancelled: the message is in the chat, and pretending otherwise
      // would make `messages` and the outbox disagree about what the group was told.
      const sent = world.store.write((uow) => {
        world.repos.outbox.enqueue(uow, send('t3f', world, ids, { idempotencyKey: 'trn:t3f' }));
        const row = world.repos.outbox.claim(uow, {
          now: at(MINUTE),
          leaseMs: DEFAULT_LEASE_MS,
          limit: 1,
        })[0];
        if (row === undefined) throw new Error('fixture');
        return expectWritten(
          world.repos.outbox.markSent(
            uow,
            row.id,
            row.attempts,
            { platformMessageId: 'plat-6', at: at(MINUTE) },
            reply('t3f', world, ids),
          ),
          'the receipt',
        ).sent;
      });
      expect(
        world.store.write((uow) => world.repos.outbox.cancel(uow, sent.id, duplicate)).kind,
      ).toBe('conflict');
      expect(
        world.store.write((uow) => world.repos.outbox.cancel(uow, outboxId('z9f'), duplicate)).kind,
      ).toBe('not_found');
    });
  });
});

describe('recovery and expiry', () => {
  it('returns an expired lease to the queue, marked maybe-sent', () => {
    withOutbox((world, ids) => {
      world.store.write((uow) => {
        world.repos.outbox.enqueue(uow, send('v1f', world, ids));
        world.repos.outbox.claim(uow, { now: T0, leaseMs: DEFAULT_LEASE_MS, limit: 1 });
      });
      // Before the lease expires there is nothing to recover: the dispatcher is still working.
      expect(world.repos.outbox.staleSending(at(1_000), 10)).toEqual([]);
      expect(
        world.store.write((uow) =>
          world.repos.outbox.recoverSending(uow, { now: at(1_000), before: at(1_000) }),
        ),
      ).toBe(0);

      const after = at(DEFAULT_LEASE_MS + 1);
      expect(world.repos.outbox.staleSending(after, 10).map((row) => row.id)).toEqual([
        outboxId('v1f'),
      ]);
      expect(
        world.store.write((uow) =>
          world.repos.outbox.recoverSending(uow, { now: after, before: after }),
        ),
      ).toBe(1);
      const recovered = world.repos.outbox.byId(outboxId('v1f'));
      expect(recovered?.status).toBe('pending');
      // Unconditionally `maybe_sent`: the whole point of the flag is that we do not know, and a
      // heuristic ("it was only two seconds, probably not sent") would be a guess recorded as a
      // fact. `06` §3.13 resolves it per platform.
      expect(recovered?.maybeSent).toBe(true);
      // `next_attempt_at` is now, not a backoff: the send never got an answer, so there is nothing
      // to back off from — the process may simply have been restarted by a deploy.
      expect(recovered?.nextAttemptAt.epochMilliseconds).toBe(after.epochMilliseconds);
      expect(recovered?.leaseUntil).toBeUndefined();
      expect(recovered?.inFlightSince).toBeUndefined();
    });
  });

  it('expires a timely row and never a must_deliver one (06 §4.3)', () => {
    withOutbox((world, ids) => {
      world.store.write((uow) => {
        for (const [tag, expiryClass] of [
          ['w1f', 'timely'],
          ['w2f', 'best_effort'],
          ['w3f', 'must_deliver'],
        ] as const) {
          world.repos.outbox.enqueue(
            uow,
            send(tag, world, ids, {
              conversationId: tag === 'w1f' ? ids.first : ids.second,
              idempotencyKey: `trn:${tag}`,
              expiryClass,
            }),
          );
        }
      });
      // Measured from the row's **own** `created_at`, which the transaction clock sets — not from
      // the fixture's `T0`. `06` §4.3's deadlines are "how long this send has been waiting", so a
      // test that compared against a fixed instant would be asserting about a different question.
      const created = world.repos.outbox.byId(outboxId('w1f'))?.createdAt;
      if (created === undefined) throw new Error('fixture');
      const after = (ms: number) =>
        Temporal.Instant.fromEpochMilliseconds(created.epochMilliseconds + ms);

      // 31 minutes: past `timely`'s 30, inside `best_effort`'s 6 hours.
      expect(world.store.write((uow) => world.repos.outbox.expire(uow, after(31 * MINUTE)))).toBe(
        1,
      );
      expect(world.repos.outbox.byId(outboxId('w1f'))?.status).toBe('expired');
      expect(world.repos.outbox.byId(outboxId('w2f'))?.status).toBe('pending');

      // Seven hours: past `best_effort` too. `must_deliver` still stands, and that is the whole
      // point — a reply carrying an I7 acknowledgement has to arrive or be visibly dead, and
      // dropping it quietly is the one outcome the invariant forbids.
      expect(world.store.write((uow) => world.repos.outbox.expire(uow, after(7 * 3_600_000)))).toBe(
        1,
      );
      expect(world.repos.outbox.byId(outboxId('w2f'))?.status).toBe('expired');
      expect(world.repos.outbox.byId(outboxId('w3f'))?.status).toBe('pending');
      expect(
        world.store.write((uow) => world.repos.outbox.expire(uow, after(99 * 3_600_000))),
      ).toBe(0);
    });
  });

  it('does not expire a send somebody is in the middle of', () => {
    withOutbox((world, ids) => {
      world.store.write((uow) => {
        world.repos.outbox.enqueue(uow, send('x1f', world, ids, { expiryClass: 'timely' }));
        world.repos.outbox.claim(uow, { now: T0, leaseMs: DEFAULT_LEASE_MS, limit: 1 });
      });
      const created = world.repos.outbox.byId(outboxId('x1f'))?.createdAt;
      if (created === undefined) throw new Error('fixture');
      // A `sending` row is somebody's live attempt, and expiring it under them would race the
      // receipt — the platform could accept the message a moment after the row said it had given
      // up, and then nothing would record what was sent.
      expect(
        world.store.write((uow) =>
          world.repos.outbox.expire(
            uow,
            Temporal.Instant.fromEpochMilliseconds(created.epochMilliseconds + 31 * MINUTE),
          ),
        ),
      ).toBe(0);
      expect(world.repos.outbox.byId(outboxId('x1f'))?.status).toBe('sending');
    });
  });

  it('counts sent rows by class for 07`s attention budget (Q-OBX-5)', () => {
    withOutbox((world, ids) => {
      for (const [tag, messageClass] of [
        ['y1f', 'proactive'],
        ['y2f', 'proactive'],
        ['y3f', 'reply'],
      ] as const) {
        world.store.write((uow) => {
          world.repos.outbox.enqueue(
            uow,
            send(tag, world, ids, { idempotencyKey: `trn:${tag}`, messageClass }),
          );
          const row = world.repos.outbox.claim(uow, {
            now: at(MINUTE),
            leaseMs: DEFAULT_LEASE_MS,
            limit: 1,
          })[0];
          if (row === undefined) throw new Error('fixture');
          world.repos.outbox.markSent(
            uow,
            row.id,
            row.attempts,
            { platformMessageId: `plat-${tag}`, at: at(MINUTE) },
            {
              message: { ...reply(tag, world, ids).message, id: messageId(tag) },
              label: groupLabel(world.groupId),
            },
          );
        });
      }
      // `07` counts `proactive` sends rather than keeping a second ledger, which is why the class
      // is a column and the index is partial on `status = 'sent'`.
      expect(
        world.repos.outbox.sentCount({
          groupId: world.groupId,
          messageClass: 'proactive',
          since: T0,
        }),
      ).toBe(2);
      expect(
        world.repos.outbox.sentCount({ groupId: world.groupId, messageClass: 'reply', since: T0 }),
      ).toBe(1);
      expect(
        world.repos.outbox.sentCount({
          groupId: world.groupId,
          messageClass: 'proactive',
          since: at(2 * MINUTE),
        }),
      ).toBe(0);
      expect(
        world.repos.outbox.sentCount({
          groupId: world.otherGroupId,
          messageClass: 'proactive',
          since: T0,
        }),
      ).toBe(0);
    });
  });

  it('answers `not_found` for a send that is not there', () => {
    withOutbox((world, ids) => {
      void ids;
      const answers = world.store.write((uow) => [
        world.repos.outbox.markFailed(uow, outboxId('z9f'), 1, { error: RETRYABLE }, T0),
        world.repos.outbox.cancel(uow, outboxId('z9f'), PERMANENT),
      ]);
      expect(answers.map((result) => result.kind)).toEqual(['not_found', 'not_found']);
      expect(world.repos.outbox.byId(outboxId('z9f'))).toBeUndefined();
    });
  });
});
