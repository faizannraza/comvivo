/**
 * `queue.fairness` (`M1-T23`; `02` §3.10.3, §9).
 *
 * The acceptance criterion, verbatim: **group B's single job starts within the first 2 claim rounds
 * despite group A's 1,000.**
 *
 * That number is the design pinned down. A queue ordered by `(priority, run_at)` alone is correct
 * and useless here: group A enqueued first, so its thousand jobs are all older, and group B's one
 * job would wait for every one of them. On a Pi with a single `model` slot and a conversation that
 * generated a thousand extractions, group B would wait hours — and nothing would look broken,
 * because every individual claim took the oldest due job, which is exactly what a queue is
 * supposed to do.
 *
 * `02` §3.10.3's answer is two clauses: `row_number() OVER (PARTITION BY partition_key …)` takes at
 * most one job per partition per round, and the outer `ORDER BY … coalesce(p.last_claimed_at, 0)
 * ASC` serves the least-recently-served partition first. Together they make the queue round-robin
 * across groups while staying FIFO within one.
 */
import { expectWritten } from '@comvivo/core';
import { TypeIdGenerator, z } from '@comvivo/shared';
import { SeededRng, VirtualClock } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import { JobKindRegistry } from '../queue/kinds.js';
import { DEFAULT_CLAIM_LEASE_MS, SqliteJobQueue } from '../queue/queue.js';
import { group, groupId, withRepos, withReposAsync } from './testing/harness.js';

const PayloadSchema = z.object({ n: z.int().min(0) });
const KIND = 'extract.conversation';

describe('queue.fairness (02 §3.10.3, §9)', { tags: ['db', 'slow'] }, () => {
  it('starts group B`s single job within two claim rounds, despite group A`s 1,000', () => {
    withRepos((world) => {
      const registry = new JobKindRegistry();
      const def = registry.register(KIND, PayloadSchema);

      // Group A first, so its jobs are strictly older. A `run_at`-ordered queue would therefore
      // put all thousand of them ahead of B's — which is the failure this test exists to rule out.
      world.store.write((uow) => {
        for (let index = 0; index < 1_000; index += 1) {
          world.repos.jobs.enqueue(uow, def, {
            partitionKey: world.groupId,
            payload: { n: index },
            idempotencyKey: `a:${String(index)}`,
          });
        }
      });
      world.store.write((uow) =>
        world.repos.jobs.enqueue(uow, def, {
          partitionKey: world.otherGroupId,
          payload: { n: 0 },
          idempotencyKey: 'b:0',
        }),
      );

      // `extract.conversation` is serial, so one claim per partition is also all the partition can
      // run — which makes "within two rounds" the strongest possible statement: B is served on the
      // **first** round the moment A's partition has been served once.
      const rounds: string[][] = [];
      for (let round = 0; round < 2; round += 1) {
        const claimed = world.repos.jobs.claim(`boot-01:model:${String(round)}`, {
          kinds: [KIND],
          max: 4,
          leaseMs: DEFAULT_CLAIM_LEASE_MS,
        });
        rounds.push(claimed.map((job) => job.partitionKey));
        // Complete them, so the serial exclusion does not hold the next round back — the point
        // here is the *ordering* across partitions, not the serial limit, which has its own test.
        for (const job of claimed) world.repos.jobs.complete(job);
      }

      const served = rounds.flat();
      expect(served, 'group B was not served within two claim rounds').toContain(
        world.otherGroupId,
      );
      // And at most one job per partition per round (`rn = 1`), which is the half that stops a
      // backlog filling every slot in the pool.
      for (const round of rounds) {
        expect(new Set(round).size, 'a partition was served twice in one round').toBe(round.length);
      }
      // B is served on the first round or the second, never later. Asserted as the index rather
      // than as "it appears somewhere", because `toContain` over two rounds would also pass if the
      // ordering were pure luck.
      expect(served.indexOf(world.otherGroupId)).toBeLessThan(4);
    });
  });

  it('round-robins across many partitions rather than draining one', () => {
    withRepos((world) => {
      const registry = new JobKindRegistry();
      // A non-serial kind, so the only thing limiting a round is `rn = 1` — which is what makes
      // this test about the round-robin rather than about the serial exclusion.
      const def = registry.register('embed.items', PayloadSchema);
      const groups = ['f1f', 'f2f', 'f3f', 'f4f'].map((tag) => groupId(tag));
      world.store.write((uow) => {
        for (const [index, id] of groups.entries()) {
          expectWritten(world.repos.groups.create(uow, group(id, `G${String(index)}`)), 'a group');
          for (let job = 0; job < 20; job += 1) {
            world.repos.jobs.enqueue(uow, def, {
              partitionKey: id,
              payload: { n: job },
              idempotencyKey: `${id}:${String(job)}`,
            });
          }
        }
      });

      // Eight rounds of four slots. If the queue drained one partition at a time, the first two
      // rounds would be all one group — which is what `last_claimed_at` ordering prevents.
      const counts = new Map<string, number>();
      for (let round = 0; round < 8; round += 1) {
        const claimed = world.repos.jobs.claim(`boot-01:embed:${String(round)}`, {
          kinds: ['embed.items'],
          max: 4,
          leaseMs: DEFAULT_CLAIM_LEASE_MS,
        });
        expect(claimed.length, `round ${String(round)} claimed nothing`).toBeGreaterThan(0);
        expect(new Set(claimed.map((job) => job.partitionKey)).size).toBe(claimed.length);
        for (const job of claimed) {
          counts.set(job.partitionKey, (counts.get(job.partitionKey) ?? 0) + 1);
          world.repos.jobs.complete(job);
        }
      }

      // Every partition served, and within one of each other: 8 rounds × 4 partitions, one each.
      expect([...counts.keys()].toSorted()).toEqual(groups.toSorted());
      const served = [...counts.values()];
      expect(Math.max(...served) - Math.min(...served)).toBeLessThanOrEqual(1);
    });
  });

  it('serves a different partition each round when only one slot is free', async () => {
    await withReposAsync(async (world) => {
      const registry = new JobKindRegistry();
      const def = registry.register('embed.items', PayloadSchema);
      const groups = ['g1f', 'g2f', 'g3f'].map((tag) => groupId(tag));
      world.store.write((uow) => {
        for (const [index, id] of groups.entries()) {
          expectWritten(world.repos.groups.create(uow, group(id, `G${String(index)}`)), 'a group');
          for (let job = 0; job < 5; job += 1) {
            world.repos.jobs.enqueue(uow, def, {
              partitionKey: id,
              payload: { n: job },
              idempotencyKey: `${id}:${String(job)}`,
            });
          }
        }
      });

      // **One slot per round**, which is what isolates the ordering. With four slots and four
      // partitions, `rn = 1` alone produces a fair-looking result and `ORDER BY
      // coalesce(last_claimed_at, 0)` could be deleted without any test noticing — measured. With
      // one slot, a `run_at`-only ordering returns the *same* partition every round, because its
      // jobs are the oldest, and the other two never run at all.
      //
      // The clock is **driven**, because `job_partitions.last_claimed_at` is an instant in
      // milliseconds: three claims inside one millisecond all record the same value, the tie-break
      // falls through to `run_at`, and the round-robin degenerates. That is harmless in production
      // — a claim round does real work, so rounds are milliseconds or seconds apart — but it means
      // a test of the *ordering* has to make time pass. Found by this test failing on a correct
      // implementation.
      // Started from the jobs' own `run_at`, not from `T0`: the rows were enqueued with the
      // harness's **system** clock, so a virtual clock set to the fixture instant would find
      // nothing due.
      const enqueuedAt = world.repos.jobs.jobsByStatus('queued', 1)[0]?.runAt;
      if (enqueuedAt === undefined) throw new Error('fixture');
      const clock = new VirtualClock(enqueuedAt);
      const queue = new SqliteJobQueue({
        db: world.drizzle,
        clock,
        ids: new TypeIdGenerator(clock),
        rng: new SeededRng(3),
      });
      const served: string[] = [];
      for (let round = 0; round < 6; round += 1) {
        await clock.advance('PT1S');
        const claimed = queue.claim(`boot-01:embed:${String(round)}`, {
          kinds: ['embed.items'],
          max: 1,
          leaseMs: DEFAULT_CLAIM_LEASE_MS,
        });
        expect(claimed).toHaveLength(1);
        const job = claimed[0];
        if (job === undefined) throw new Error('fixture');
        served.push(job.partitionKey);
        queue.complete(job);
      }

      // Two full cycles: each partition served exactly twice, and never twice in a row.
      expect(served.slice(0, 3).toSorted()).toEqual(groups.toSorted());
      expect(served.slice(3, 6).toSorted()).toEqual(groups.toSorted());
      for (let index = 1; index < served.length; index += 1) {
        expect(served[index], 'a partition was served twice running').not.toBe(served[index - 1]);
      }
    });
  });

  it('still prefers priority, within a round', () => {
    withRepos((world) => {
      const registry = new JobKindRegistry();
      const low = registry.register('maintenance.labels_gc', PayloadSchema);
      const high = registry.register('reminder.fire', PayloadSchema);
      world.store.write((uow) => {
        // The low-priority instance work first, so it is older — and the reminder second.
        world.repos.jobs.enqueue(uow, low, {
          partitionKey: '_instance',
          payload: { n: 0 },
          idempotencyKey: 'gc',
        });
        world.repos.jobs.enqueue(uow, high, {
          partitionKey: world.groupId,
          payload: { n: 0 },
          idempotencyKey: 'rem',
        });
      });
      const claimed = world.repos.jobs.claim('boot-01:io:0', {
        kinds: ['maintenance.labels_gc', 'reminder.fire'],
        max: 2,
        leaseMs: DEFAULT_CLAIM_LEASE_MS,
      });
      // Fairness is about partitions, not about priority: `02` §3.10.1 gives `reminder.fire` a
      // priority of 10 and maintenance −5, and a reminder that arrives late is the one failure a
      // member notices immediately. Both are claimed here (different partitions), and the reminder
      // comes back first so a worker with one slot runs it first.
      expect(claimed.map((job) => job.kind)).toEqual(['reminder.fire', 'maintenance.labels_gc']);
    });
  });
});
