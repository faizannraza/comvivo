/**
 * The ingestion transaction's p95 (`M1-T17` AC: "Ingestion transaction p95 ≤ 3 ms on the x64 bench").
 *
 * ## What is measured
 *
 * One **whole** ingestion transaction, as `02` §3.3.10's Q-ING queries describe it and as `06`'s
 * adapter will drive it:
 *
 *  1. Q-ING-2 — resolve the conversation by `(group, channel, chatId)`.
 *  2. Q-ING-3 — resolve the identity by `(channel, platformUserId)`.
 *  3. Q-ING-4 — resolve the member by `(group, person)`.
 *  4. Intern the label (`02` §3.2).
 *  5. Insert the message, which itself re-reads the conversation to derive the dedupe key.
 *
 * All inside one `store.write`, which is `BEGIN IMMEDIATE … COMMIT`. Measuring only the `INSERT`
 * would measure the cheapest step and miss the three lookups and the commit — and the commit is
 * the part that touches the disk.
 *
 * ## Who enforces the budget — amended at the M1 exit gate
 *
 * This file used to assert the AC's 3 ms with a 4× tolerance, as the strongest substitute
 * available while `M1-T32`'s harness did not exist. It exists now, and `B1` in
 * `packages/storage/bench/storage.bench.ts` measures the same transaction with `11` §3.9.2's
 * protocol — warm-up, 200 iterations into an HDR histogram, five repetitions, the median of their
 * p95s — against a declared 3 ms budget that `pnpm bench --gate` fails on. **That is the AC's
 * check**, and it measured 0.93 ms p95 on the stress fixture.
 *
 * So the bound here is no longer the budget. It is a "broken, not slow" bound at `storage.slowTxMs`
 * (50 ms), the threshold `02` §3.7.2 already calls a problem worth logging. The reason is a
 * measurement, not a preference: this assertion failed at the exit gate at **12.3 ms p95** while
 * three other processes were saturating the machine, with the same code that benches at 0.93 ms.
 * An absolute latency bound inside a test suite measures the machine's spare capacity as much as
 * the code, and a perf gate that flakes gets deleted rather than fixed — which is how a budget
 * stops being enforced at all. The distribution is still printed on every run, so a regression is
 * visible in the output, and the gate that fails on it is the one built to.
 */
import { expectWritten } from '@comvivo/core';
import { describe, expect, it } from 'vitest';
import {
  conversationId,
  groupLabel,
  identityId,
  member,
  messageId,
  person,
  T0,
  withRepos,
} from './testing/harness.js';

/** `M1-T17`'s acceptance criterion. */
/**
 * `02` §3.7.2's `storage.slowTxMs`: the point at which a transaction is a problem rather than a
 * slow moment. The *budget* is `B1`'s 3 ms in the benchmark suite; this is the bound that says the
 * transaction is broken.
 */
const SLOW_TX_MS = 50;

/** Enough samples for a p95 to mean something, and few enough to stay inside a test. */
const SAMPLES = 400;

/** The warm-up discards the first few, where the statements are still being prepared. */
const WARMUP = 50;

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  // Nearest-rank, which for a fixed sample count is unambiguous and needs no interpolation.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}

describe('the ingestion transaction (M1-T17 AC)', { tags: ['slow'] }, () => {
  it(`completes ${String(SAMPLES)} transactions and reports the distribution`, () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member a');
        expectWritten(
          world.repos.identities.create(uow, {
            id: identityId('a'),
            channel: 'simulator',
            platformUserId: 'u-1',
            personId: person('a').id,
            displayNameSnapshot: 'Ana',
          }),
          'an identity',
        );
        expectWritten(
          world.repos.conversations.create(uow, {
            id: conversationId('a'),
            groupId: world.groupId,
            channel: 'simulator',
            platformChatId: 'chat-a',
            kind: 'group',
            boundAt: T0,
          }),
          'a conversation',
        );
      });

      const samples: number[] = [];
      for (let index = 0; index < SAMPLES + WARMUP; index += 1) {
        // A distinct id and platform id per message, because a duplicate would take the cheap
        // path and the measurement would be of the dedupe index rather than of an insert.
        //
        // **Hex**, not base36: Crockford base32 excludes `i`, `l`, `o` and `u`, and
        // `(18).toString(36)` is `'i'` — so a base36 counter would produce a malformed id on the
        // nineteenth message. The trailing `f` is what keeps `1` and `10` apart, since the fixture
        // pads with `'0'`; `suffix` refuses a tag ending in `'0'` for exactly that reason.
        const tag = `g${index.toString(16)}f`;
        const started = performance.now();
        world.store.write(
          (uow) => {
            // Q-ING-2, Q-ING-3, Q-ING-4: what `06`'s adapter resolves before it can write.
            const conversation = world.repos.conversations.byPlatform(
              world.groupId,
              'simulator',
              'chat-a',
            );
            const identity = world.repos.identities.byPlatform('simulator', 'u-1');
            if (conversation === undefined || identity === undefined) {
              throw new Error('fixture: the ingestion lookups found nothing');
            }
            const sender = world.repos.members.byPerson(world.groupId, identity.personId);
            if (sender === undefined) throw new Error('fixture: no member');
            return expectWritten(
              world.repos.messages.insert(
                uow,
                {
                  id: messageId(tag),
                  groupId: world.groupId,
                  conversationId: conversation.id,
                  kind: 'member',
                  senderMemberId: sender.id,
                  senderIdentityId: identity.id,
                  platformMessageId: `p-${tag}`,
                  text: 'who is picking up the kids tomorrow',
                  sentAt: T0,
                  receivedAt: T0,
                },
                label,
              ),
              'an ingested message',
            );
          },
          { op: 'ingest.message' },
        );
        if (index >= WARMUP) samples.push(performance.now() - started);
      }

      const sorted = samples.toSorted((a, b) => a - b);
      const p50 = percentile(sorted, 50);
      const p95 = percentile(sorted, 95);
      const p99 = percentile(sorted, 99);
      const report = `ingestion: p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms over ${String(samples.length)} transactions on ${process.arch}`;
      // Printed rather than only asserted, so the measurement is in the run's output and a
      // milestone report can quote a number that was actually taken.
      console.info(report);

      // Non-vacuity: a loop that silently did nothing would have a p95 of zero and pass.
      expect(samples).toHaveLength(SAMPLES);
      expect(p50).toBeGreaterThan(0);
      expect(
        world.repos.messagesUnfiltered.windowUnfiltered({
          conversationId: conversationId('a'),
          limit: SAMPLES + WARMUP + 1,
        }),
      ).toHaveLength(SAMPLES + WARMUP);

      // Not the budget — see the header. `B1` in `bench/storage.bench.ts` owns the 3 ms, with the
      // protocol and the `--gate` to enforce it; this catches a transaction that has become
      // broken rather than one that is briefly slow on a loaded machine.
      expect(p95, report).toBeLessThanOrEqual(SLOW_TX_MS);
    });
  });
});
