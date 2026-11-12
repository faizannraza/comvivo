/**
 * The job queue's contract (`M1-T23`; `02` §3.10, ADR-012).
 *
 * The acceptance criterion names three things and each has its own `describe`:
 *
 *  - **the kinds registry is `02` §3.10.1's catalog** — and the assertion that a kind not in it
 *    cannot be enqueued, which is the whole reason a catalog exists;
 *  - **`enqueueDebounced` moves `runAt` forward** — and, more importantly, cannot move it past the
 *    deadline, which is what stops a never-quiet conversation from never being processed;
 *  - **`singleFlightByKey` never yields two concurrent leases per key.**
 *
 * The rest covers the lease, the fence and the dead letter, because those are where a queue goes
 * wrong in ways nothing else notices: a job that runs twice, or one that silently never runs again.
 */

import type { JobKindDef } from '@comvivo/core';
import { INSTANCE_PARTITION, JOB_POOLS, POOL_LIMITS } from '@comvivo/core';
import { StorageError, z } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { JOB_KIND_CATALOG, JobKindRegistry } from '../queue/kinds.js';
import { DEFAULT_CLAIM_LEASE_MS } from '../queue/queue.js';
import { groupId, T0, withRepos } from './testing/harness.js';

const WORKER = 'boot-01:io:0';
const PayloadSchema = z.object({ note: z.string().max(80), count: z.int().min(0).default(0) });

type Payload = z.infer<typeof PayloadSchema>;

const TEST_KINDS = [
  'reminder.fire',
  'poll.close',
  'extract.conversation',
  'embed.items',
  'retention.sweep',
  'backup.snapshot',
  'digest.morning',
] as const;

/**
 * A registry with the kinds these tests enqueue, and the **typed** definitions it returned.
 *
 * `register` returns `JobKindDef<P>` and `def(kind)` returns `JobKindDef<unknown>` — a lookup
 * cannot know the caller's payload type. Keeping the typed values is what lets a test's payload be
 * checked against the kind's schema at compile time, which is the point of the generic.
 *
 * Real catalog kinds throughout, so `02` §3.10.1's assertion is exercised rather than bypassed by
 * a kind invented for the test.
 */
function registryOf(): { registry: JobKindRegistry; def: (kind: string) => JobKindDef<Payload> } {
  const registry = new JobKindRegistry();
  const defs = new Map<string, JobKindDef<Payload>>();
  for (const kind of TEST_KINDS) defs.set(kind, registry.register(kind, PayloadSchema));
  return {
    registry,
    def: (kind) => {
      const found = defs.get(kind);
      if (found === undefined) throw new Error(`the fixture did not register ${kind}`);
      return found;
    },
  };
}

/**
 * Wind a lease into the past, which is what time passing does.
 *
 * Written directly because the harness's clock is the system one: a test that waited for a lease
 * to expire would be a test that sometimes does not, and one that granted a one-millisecond lease
 * races the recovery's own clock read.
 */
function expireLease(world: Parameters<Parameters<typeof withRepos>[0]>[0], id: string): void {
  world.db.prepare('UPDATE jobs SET lease_until = lease_until - 3600000 WHERE id = ?').run(id);
}

describe('the kinds catalog (02 §3.10.1)', () => {
  it('refuses a kind that is not in the catalog', () => {
    const registry = new JobKindRegistry();
    // `02` §3.10.1: "a kind not in this table must not be enqueued (registry assertion at boot)".
    // Without the check a typo becomes a job nothing ever runs — queued forever, invisible except
    // as a number in a gauge.
    expect(() => registry.register('extract.converstaion', PayloadSchema)).toThrow(
      /is not a job kind/,
    );
    expect(() => registry.register('reminder.fire', PayloadSchema)).not.toThrow();
    // And twice is refused too: two payload schemas for one kind, with the second silently winning.
    expect(() => registry.register('reminder.fire', PayloadSchema)).toThrow(/already registered/);
  });

  it('is complete, unique and internally consistent', () => {
    const kinds = JOB_KIND_CATALOG.map((spec) => spec.kind);
    expect(new Set(kinds).size, 'a kind appears twice in the catalog').toBe(kinds.length);
    for (const spec of JOB_KIND_CATALOG) {
      expect(JOB_POOLS, `${spec.kind} names an unknown pool`).toContain(spec.pool);
      // `02` §3.10.1: priority is −10..10, and `jobs_priority_ck` enforces it in the database — so
      // a catalog entry outside the range would be a row every enqueue refused.
      expect(spec.priority ?? 0).toBeGreaterThanOrEqual(-10);
      expect(spec.priority ?? 0).toBeLessThanOrEqual(10);
    }
    // The four kinds `02` §3.10.1 singles out, so a renamed or dropped entry fails here rather
    // than at the first enqueue in `M7`.
    expect(kinds).toContain('reminder.fire');
    expect(kinds).toContain('extract.conversation');
    expect(kinds).toContain('backup.offsite');
    expect(kinds).toContain('retention.sweep');
  });

  it('keeps every timeout inside its lease', () => {
    const registry = new JobKindRegistry();
    for (const spec of JOB_KIND_CATALOG) {
      const def = registry.register(spec.kind, PayloadSchema);
      // `02` §3.10.1: "`timeoutMs`: AbortSignal fires at timeout; ≤ leaseMs * 0.8". The margin is
      // what lets a timed-out handler record its own failure while the lease is still valid — a
      // timeout equal to the lease would race the recovery sweep, and the job would be re-claimed
      // while its first attempt was still unwinding.
      expect(def.timeoutMs, `${spec.kind} may time out after its lease`).toBeLessThanOrEqual(
        Math.floor(def.leaseMs * 0.8),
      );
      expect(def.maxAttempts).toBeGreaterThanOrEqual(1);
    }
  });

  it('lists what nobody has registered, rather than refusing to start', () => {
    const { registry } = registryOf();
    // `M1` registers none of the forty kinds, and a boot that refused to start until every one had
    // an owner would make the queue unusable until `M11`. So the gap is **reported** — `02`
    // §3.10.1's assertion in the direction that is actionable at this point in the plan.
    const missing = registry.unregistered();
    expect(missing.length).toBeGreaterThan(20);
    expect(missing).toContain('group.purge');
    expect(missing).not.toContain('reminder.fire');
    expect(registry.registered()).toContain('reminder.fire');
    // And the worker claims per pool, so the registry has to group them.
    expect(registry.kindsInPool('io')).toContain('poll.close');
    expect(registry.kindsInPool('model')).toContain('extract.conversation');
    expect(registry.kindsInPool('embed')).toEqual(['embed.items']);
  });

  it('refuses a partition that contradicts the kind`s scope', () => {
    withRepos((world) => {
      const registry = registryOf();
      const group = registry.def('reminder.fire');
      const instance = registry.def('retention.sweep');
      // Both directions are mistakes with consequences, which is why both are checked. A
      // group-scoped kind on `'_instance'` makes every group's work serialise against one
      // partition; an instance kind per group runs the nightly backup once per group.
      expect(() =>
        world.store.write((uow) =>
          world.repos.jobs.enqueue(uow, group, {
            partitionKey: INSTANCE_PARTITION,
            payload: { note: 'x', count: 0 },
          }),
        ),
      ).toThrow(/cannot be enqueued for a group|needs a group/);
      expect(() =>
        world.store.write((uow) =>
          world.repos.jobs.enqueue(uow, instance, {
            partitionKey: world.groupId,
            payload: { note: 'x', count: 0 },
          }),
        ),
      ).toThrow(/instance kind/);
    });
  });
});

describe('enqueue (02 §3.10.2)', () => {
  it('validates the payload at the boundary and stores it canonically', () => {
    withRepos((world) => {
      const def = registryOf().def('reminder.fire');
      const enqueued = world.store.write((uow) =>
        world.repos.jobs.enqueue(uow, def, {
          partitionKey: world.groupId,
          payload: { note: 'water the plants' } as never,
          enqueuedBy: 'cli',
        }),
      );
      expect(enqueued.kind).toBe('enqueued');
      const job = world.repos.jobs.job(enqueued.id);
      // Parsed, so the schema's default landed — the row holds what the handler will receive, not
      // what the caller happened to type. A row stored unparsed would make the claim-time parse
      // the first place a default appeared, and two readers would disagree.
      expect(JSON.parse(job?.payload ?? '{}')).toEqual({ note: 'water the plants', count: 0 });
      expect(job?.status).toBe('queued');
      expect(job?.priority).toBe(10);
      expect(job?.serial).toBe(false);
      expect(job?.maxAttempts).toBe(8);
      expect(job?.enqueuedBy).toBe('cli');
      // And a payload that does not parse is refused where the caller can see it.
      expect(() =>
        world.store.write((uow) =>
          world.repos.jobs.enqueue(uow, def, {
            partitionKey: world.groupId,
            payload: { note: 42 } as never,
          }),
        ),
      ).toThrow(/payload/);
    });
  });

  it('answers `duplicate` for a repeated idempotency key (Q-JOB-3)', () => {
    withRepos((world) => {
      const def = registryOf().def('reminder.fire');
      const args = {
        partitionKey: world.groupId,
        payload: { note: 'dinner', count: 0 },
        // `02` §3.10.2's own example shape: a key must name a logical unit that cannot recur
        // inside the retention window, so it carries the occurrence instant.
        idempotencyKey: 'rem:rem_01jqw8z5h7e9r3t4y5v6k7p8q9:1762450200000',
      };
      const first = world.store.write((uow) => world.repos.jobs.enqueue(uow, def, args));
      const again = world.store.write((uow) => world.repos.jobs.enqueue(uow, def, args));
      expect(first.kind).toBe('enqueued');
      expect(again.kind).toBe('duplicate');
      // The id **in the table**, because a caller threading a job id through a trace needs the one
      // that exists.
      expect(again.id).toBe(first.id);
      expect(world.repos.jobs.jobsByStatus('queued', 10)).toHaveLength(1);
    });
  });

  it('cancels a partition`s queued work without touching what is running', () => {
    withRepos((world) => {
      const registry = registryOf();
      const def = registry.def('poll.close');
      const other = registry.def('reminder.fire');
      world.store.write((uow) => {
        for (const note of ['a', 'b']) {
          world.repos.jobs.enqueue(uow, def, {
            partitionKey: world.groupId,
            payload: { note, count: 0 },
          });
        }
        world.repos.jobs.enqueue(uow, other, {
          partitionKey: world.otherGroupId,
          payload: { note: 'c', count: 0 },
        });
      });
      const claimed = world.repos.jobs.claim(WORKER, {
        kinds: ['poll.close'],
        max: 5,
        leaseMs: DEFAULT_CLAIM_LEASE_MS,
      });
      expect(claimed).toHaveLength(1);

      const cancelled = world.store.write((uow) =>
        world.repos.jobs.cancelPartition(uow, world.groupId),
      );
      // One: the queued sibling. The **leased** one is running right now, and cancelling the row
      // under its handler would make `completeIn` report `lease_lost` after the work was done.
      expect(cancelled).toBe(1);
      expect(world.repos.jobs.jobsByStatus('cancelled', 10)).toHaveLength(1);
      expect(world.repos.jobs.job(claimed[0]?.id ?? ('x' as never))?.status).toBe('leased');
      // And the other group's work is untouched, which is what makes the partition the unit.
      expect(world.repos.jobs.jobsByStatus('queued', 10).map((job) => job.partitionKey)).toEqual([
        world.otherGroupId,
      ]);
    });
  });
});

describe('enqueueDebounced (02 §3.10.2)', () => {
  const quiet = 90_000;
  const maxWait = 600_000;

  it('moves runAt forward and merges the payload', () => {
    withRepos((world) => {
      const def = registryOf().def('extract.conversation');
      const merge = (previous: { note: string; count: number }, next: typeof previous) => ({
        note: next.note,
        count: previous.count + next.count,
      });
      const first = world.store.write((uow) =>
        world.repos.jobs.enqueueDebounced(uow, def, {
          partitionKey: world.groupId,
          debounceKey: `extract:${world.groupId}:cnv_a`,
          payload: { note: 'm1', count: 1 },
          quietMs: quiet,
          maxWaitMs: maxWait,
          merge,
        }),
      );
      expect(first.kind).toBe('enqueued');
      const created = world.repos.jobs.job(first.id)?.createdAt;
      if (created === undefined) throw new Error('fixture');
      const firstRunAt = world.repos.jobs.job(first.id)?.runAt;
      expect(firstRunAt?.epochMilliseconds).toBe(created.epochMilliseconds + quiet);

      // A second message. `01` §6.1's debounce: the job moves forward, and the payloads merge
      // rather than one replacing the other — the extraction has to see both messages.
      const again = world.store.write((uow) =>
        world.repos.jobs.enqueueDebounced(uow, def, {
          partitionKey: world.groupId,
          debounceKey: `extract:${world.groupId}:cnv_a`,
          payload: { note: 'm2', count: 1 },
          quietMs: quiet,
          maxWaitMs: maxWait,
          merge,
        }),
      );
      expect(again.kind).toBe('duplicate');
      expect(again.id).toBe(first.id);
      const moved = world.repos.jobs.job(first.id);
      expect(JSON.parse(moved?.payload ?? '{}')).toEqual({ note: 'm2', count: 2 });
      // `>=`, not `>`: two enqueues inside one millisecond compute the same `now + quietMs`, and a
      // strict assertion flaked on exactly that. The forward movement is shown below, where the
      // starting point is controlled rather than whatever the wall clock happened to read.
      expect(moved?.runAt.epochMilliseconds).toBeGreaterThanOrEqual(
        firstRunAt?.epochMilliseconds ?? 0,
      );

      // Wind the row back, as a quiet minute would have done, and enqueue once more. Written
      // directly because the clock here is the system one — the arithmetic is what is being
      // tested, and a test that depended on time passing would be a test that sometimes does not.
      const wound = (firstRunAt?.epochMilliseconds ?? 0) - 60_000;
      world.db.prepare('UPDATE jobs SET run_at = ? WHERE id = ?').run(wound, first.id);
      world.store.write((uow) =>
        world.repos.jobs.enqueueDebounced(uow, def, {
          partitionKey: world.groupId,
          debounceKey: `extract:${world.groupId}:cnv_a`,
          payload: { note: 'm3', count: 1 },
          quietMs: quiet,
          maxWaitMs: maxWait,
          merge,
        }),
      );
      const pushed = world.repos.jobs.job(first.id);
      expect(pushed?.runAt.epochMilliseconds, 'the debounce did not move forward').toBeGreaterThan(
        wound,
      );
      expect(JSON.parse(pushed?.payload ?? '{}').count).toBe(3);
      // One row, not two: Q-JOB-4's unique index on the debounce key is what guarantees it.
      expect(world.repos.jobs.jobsByStatus('queued', 10)).toHaveLength(1);
    });
  });

  it('cannot push a job past its deadline, however busy the conversation', () => {
    withRepos((world) => {
      const def = registryOf().def('extract.conversation');
      const merge = (previous: { note: string; count: number }, next: typeof previous) => ({
        note: next.note,
        count: previous.count + next.count,
      });
      const args = {
        partitionKey: world.groupId,
        debounceKey: `extract:${world.groupId}:cnv_b`,
        quietMs: quiet,
        // A deadline **shorter** than the quiet window, which is the case that proves the `min`:
        // every push would otherwise land past it.
        maxWaitMs: 1_000,
        merge,
      };
      const first = world.store.write((uow) =>
        world.repos.jobs.enqueueDebounced(uow, def, { ...args, payload: { note: 'm1', count: 1 } }),
      );
      const deadline = world.repos.jobs.job(first.id)?.debounceDeadlineAt;
      if (deadline === undefined) throw new Error('fixture');
      for (let index = 0; index < 5; index += 1) {
        world.store.write((uow) =>
          world.repos.jobs.enqueueDebounced(uow, def, {
            ...args,
            payload: { note: `m${String(index)}`, count: 1 },
          }),
        );
      }
      // `02` §3.10.2: `run_at = min(debounce_deadline_at, now + quietMs)`. The deadline is fixed
      // when the **first** message arrives, so no amount of further activity can push past it —
      // without the `min`, a family chat that never goes quiet would never be extracted, and
      // `01` §6.1's "12 messages / 90 s" would be a rule the busiest case outruns.
      const row = world.repos.jobs.job(first.id);
      expect(row?.runAt.epochMilliseconds).toBe(deadline.epochMilliseconds);
      expect(JSON.parse(row?.payload ?? '{}').count).toBe(6);
    });
  });

  it('runs now when the caller passes a zero quiet window', () => {
    withRepos((world) => {
      const def = registryOf().def('extract.conversation');
      // `02` §3.10.2's threshold case: "if `payload.count ≥ threshold`, the caller passes
      // `quietMs = 0`, so `run_at = now`". No branch in the repository — the `min` already does it,
      // which is why the threshold is `04`'s policy and not a storage concern.
      const enqueued = world.store.write((uow) =>
        world.repos.jobs.enqueueDebounced(uow, def, {
          partitionKey: world.groupId,
          debounceKey: `extract:${world.groupId}:cnv_c`,
          payload: { note: 'burst', count: 12 },
          quietMs: 0,
          maxWaitMs: 600_000,
          merge: (_previous, next) => next,
        }),
      );
      const row = world.repos.jobs.job(enqueued.id);
      expect(row?.runAt.epochMilliseconds).toBe(row?.createdAt.epochMilliseconds);
      expect(
        world.repos.jobs.claim(WORKER, {
          kinds: ['extract.conversation'],
          max: 5,
          leaseMs: 60_000,
        }),
      ).toHaveLength(1);
    });
  });

  it('starts a new window once the job is leased, rather than merging into work in flight', () => {
    withRepos((world) => {
      const def = registryOf().def('extract.conversation');
      const args = {
        partitionKey: world.groupId,
        debounceKey: `extract:${world.groupId}:cnv_d`,
        quietMs: 0,
        maxWaitMs: 600_000,
        merge: (previous: { note: string; count: number }, next: typeof previous) => ({
          note: next.note,
          count: previous.count + next.count,
        }),
      };
      const first = world.store.write((uow) =>
        world.repos.jobs.enqueueDebounced(uow, def, { ...args, payload: { note: 'a', count: 1 } }),
      );
      world.repos.jobs.claim(WORKER, { kinds: ['extract.conversation'], max: 1, leaseMs: 60_000 });
      const second = world.store.write((uow) =>
        world.repos.jobs.enqueueDebounced(uow, def, { ...args, payload: { note: 'b', count: 1 } }),
      );
      // Q-JOB-4's unique index is scoped to `status = 'queued'`, so a leased job frees its key.
      // Merging into a job already running would be merging into a payload the handler has already
      // read — the new message would be dropped silently.
      expect(second.kind).toBe('enqueued');
      expect(second.id).not.toBe(first.id);
      expect(JSON.parse(world.repos.jobs.job(second.id)?.payload ?? '{}').count).toBe(1);
    });
  });
});

describe('claim, lease and fence (02 §3.10.3)', () => {
  it('leases a job, increments attempts and stamps the owner', () => {
    withRepos((world) => {
      const def = registryOf().def('poll.close');
      world.store.write((uow) =>
        world.repos.jobs.enqueue(uow, def, {
          partitionKey: world.groupId,
          payload: { note: 'a', count: 0 },
        }),
      );
      const [job] = world.repos.jobs.claim(WORKER, {
        kinds: ['poll.close'],
        max: 5,
        leaseMs: DEFAULT_CLAIM_LEASE_MS,
      });
      if (job === undefined) throw new Error('fixture');
      expect(job.leaseOwner).toBe(WORKER);
      // `attempts` is the fencing token: incremented by the claim, so it changes exactly when
      // ownership does.
      expect(job.attempts).toBe(1);
      expect(job.leaseUntil.epochMilliseconds).toBeGreaterThan(job.startedAt.epochMilliseconds);
      // And nothing else can claim it.
      expect(
        world.repos.jobs.claim('boot-01:io:1', { kinds: ['poll.close'], max: 5, leaseMs: 60_000 }),
      ).toEqual([]);
    });
  });

  it('refuses a complete, a heartbeat and a fail at a stale attempt', () => {
    withRepos((world) => {
      const def = registryOf().def('poll.close');
      world.store.write((uow) =>
        world.repos.jobs.enqueue(uow, def, {
          partitionKey: world.groupId,
          payload: { note: 'a', count: 0 },
        }),
      );
      const [job] = world.repos.jobs.claim(WORKER, {
        kinds: ['poll.close'],
        max: 1,
        leaseMs: DEFAULT_CLAIM_LEASE_MS,
      });
      if (job === undefined) throw new Error('fixture');
      // The lease expires and another worker takes it: the row is now at attempt 2.
      expect(world.repos.jobs.recoverExpiredLeases('boot-99')).toBe(1);
      const [retaken] = world.repos.jobs.claim('boot-99:io:0', {
        kinds: ['poll.close'],
        max: 1,
        leaseMs: 60_000,
      });
      expect(retaken?.attempts).toBe(2);

      // The first worker comes back. Every write it makes is fenced on `(owner, attempts)`, so
      // none of them lands — without that, it would complete a job somebody else is running, and
      // the other worker's `completeIn` would then find nothing and report `lease_lost` *after*
      // doing the work.
      expect(world.repos.jobs.complete(job)).toBe('lease_lost');
      expect(world.repos.jobs.heartbeat(job, 60_000)).toBe('lease_lost');
      expect(
        world.repos.jobs.fail(
          job,
          { code: 'X', message: 'x', retryable: true, at: T0.toString() },
          { retryable: true },
        ),
      ).toBe('lease_lost');
      expect(world.repos.jobs.job(job.id)?.status).toBe('leased');
      expect(world.repos.jobs.job(job.id)?.attempts).toBe(2);
    });
  });

  it('refuses each of the fence`s three clauses on its own', () => {
    withRepos((world) => {
      const def = registryOf().def('poll.close');
      const enqueueOne = (key: string) =>
        world.store.write((uow) =>
          world.repos.jobs.enqueue(uow, def, {
            partitionKey: world.groupId,
            payload: { note: key, count: 0 },
            idempotencyKey: key,
          }),
        );
      const claim = (worker: string, leaseMs = DEFAULT_CLAIM_LEASE_MS) =>
        world.repos.jobs.claim(worker, { kinds: ['poll.close'], max: 1, leaseMs });

      // ── `attempts` alone. The **same** worker id re-claims after its own lease expired, so the
      // owner matches and only the attempt number differs. Reachable through the API, and the
      // case a single-process product actually hits: a handler hung, the sweep requeued the job,
      // and the hung handler then finished.
      enqueueOne('fence-attempts');
      const [stale] = claim(WORKER);
      if (stale === undefined) throw new Error('fixture');
      expireLease(world, stale.id);
      expect(world.repos.jobs.recoverExpiredLeases('boot-01')).toBe(1);
      const [fresh] = claim(WORKER);
      expect(fresh?.leaseOwner).toBe(stale.leaseOwner);
      expect(fresh?.attempts).toBe(stale.attempts + 1);
      expect(world.repos.jobs.complete(stale)).toBe('lease_lost');
      expect(world.repos.jobs.job(stale.id)?.status).toBe('leased');
      if (fresh !== undefined) world.repos.jobs.complete(fresh);

      // ── `lease_owner` alone. Not reachable through the API — a different owner implies a later
      // claim, which implies a different attempt — so the row is written directly. `02` §3.10.3
      // requires the clause, and it is what makes the fence correct for a future multi-process
      // deployment rather than only for this one.
      enqueueOne('fence-owner');
      const [owned] = claim(WORKER);
      if (owned === undefined) throw new Error('fixture');
      world.db
        .prepare('UPDATE jobs SET lease_owner = ? WHERE id = ?')
        .run('boot-02:io:0', owned.id);
      expect(world.repos.jobs.complete(owned)).toBe('lease_lost');
      expect(world.repos.jobs.job(owned.id)?.status).toBe('leased');

      // ── `status = 'leased'` alone: owner and attempts intact, the job already finished. A
      // completion that landed on a `succeeded` row would be harmless; one that landed on a
      // `cancelled` or `dead` row would revive it as succeeded with nothing having run.
      enqueueOne('fence-status');
      const [finished] = claim(WORKER);
      if (finished === undefined) throw new Error('fixture');
      world.db.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(finished.id);
      expect(world.repos.jobs.complete(finished)).toBe('lease_lost');
      expect(world.repos.jobs.heartbeat(finished, 60_000)).toBe('lease_lost');
      expect(world.repos.jobs.job(finished.id)?.status).toBe('cancelled');
    });
  });

  it('recovers a lease that simply expired, under the same boot', () => {
    withRepos((world) => {
      const def = registryOf().def('poll.close');
      world.store.write((uow) =>
        world.repos.jobs.enqueue(uow, def, {
          partitionKey: world.groupId,
          payload: { note: 'a', count: 0 },
        }),
      );
      const [job] = world.repos.jobs.claim(WORKER, {
        kinds: ['poll.close'],
        max: 1,
        leaseMs: DEFAULT_CLAIM_LEASE_MS,
      });
      if (job === undefined) throw new Error('fixture');
      // The owner still matches this incarnation, so the **time** half of `02` §3.10.3's predicate
      // is the only thing that can recover it. Without that half, a handler that hung would hold
      // its job until the process restarted.
      //
      // The lease is wound back rather than granted short: a one-millisecond lease and the
      // recovery's own `clock.now()` can land in the same millisecond, which made a first version
      // of this flake. What is being tested is the comparison, not the clock.
      expireLease(world, job.id);
      expect(world.repos.jobs.recoverExpiredLeases('boot-01')).toBe(1);
      expect(world.repos.jobs.jobsByStatus('queued', 10)).toHaveLength(1);
    });
  });

  it('extends a lease for a worker that is still working', () => {
    withRepos((world) => {
      const def = registryOf().def('poll.close');
      world.store.write((uow) =>
        world.repos.jobs.enqueue(uow, def, {
          partitionKey: world.groupId,
          payload: { note: 'a', count: 0 },
        }),
      );
      const [job] = world.repos.jobs.claim(WORKER, {
        kinds: ['poll.close'],
        max: 1,
        leaseMs: 1_000,
      });
      if (job === undefined) throw new Error('fixture');
      expect(world.repos.jobs.heartbeat(job, 600_000)).toBe('ok');
      const extended = world.repos.jobs.job(job.id)?.leaseUntil;
      expect(extended?.epochMilliseconds).toBeGreaterThan(job.leaseUntil.epochMilliseconds);
      // Still leased, and still this worker's, so the recovery sweep leaves it alone.
      expect(world.repos.jobs.recoverExpiredLeases('boot-01')).toBe(0);
    });
  });

  it('keeps at most one leased serial job per partition (Q-JOB-1b)', () => {
    withRepos((world) => {
      const def = registryOf().def('backup.snapshot');
      expect(def.serial).toBe(true);
      world.store.write((uow) => {
        for (const note of ['a', 'b']) {
          world.repos.jobs.enqueue(uow, def, {
            partitionKey: INSTANCE_PARTITION,
            payload: { note, count: 0 },
            idempotencyKey: `snap:${note}`,
          });
        }
      });
      const first = world.repos.jobs.claim(WORKER, {
        kinds: ['backup.snapshot'],
        max: 5,
        leaseMs: DEFAULT_CLAIM_LEASE_MS,
      });
      expect(first).toHaveLength(1);
      // `01` §1: all writes to one group's state happen inside that group's actor, and the queue's
      // part of that is never leasing two serial jobs for one partition. Two concurrent backups
      // would interleave `VACUUM INTO` against the same file.
      expect(
        world.repos.jobs.claim('boot-01:m:1', {
          kinds: ['backup.snapshot'],
          max: 5,
          leaseMs: 60_000,
        }),
      ).toEqual([]);
      const job = first[0];
      if (job === undefined) throw new Error('fixture');
      expect(world.repos.jobs.complete(job)).toBe('ok');
      expect(
        world.repos.jobs.claim(WORKER, { kinds: ['backup.snapshot'], max: 5, leaseMs: 60_000 }),
      ).toHaveLength(1);
    });
  });

  it('never leases two jobs with the same debounce key (singleFlightByKey)', () => {
    withRepos((world) => {
      const { registry, def } = registryOf();
      const embed = def('embed.items');
      // Not serial, so the partition-level exclusion is **not** what is being tested — two
      // conversations in one group can and should embed at once. `04` R11 is about one key.
      expect(embed.serial).toBe(false);
      expect(embed.singleFlightByKey).toBe(true);
      const key = `embed:${world.groupId}`;
      const args = {
        partitionKey: world.groupId,
        debounceKey: key,
        quietMs: 0,
        maxWaitMs: 600_000,
        merge: (_previous: Payload, next: Payload) => next,
      };
      const first = world.store.write((uow) =>
        world.repos.jobs.enqueueDebounced(uow, embed, {
          ...args,
          payload: { note: 'a', count: 1 },
        }),
      );
      const single = registry
        .kindsInPool('embed')
        .filter((kind) => registry.def(kind)?.singleFlightByKey === true);
      const claimed = world.repos.jobs.claim(WORKER, {
        kinds: ['embed.items'],
        max: 5,
        leaseMs: DEFAULT_CLAIM_LEASE_MS,
        singleFlightKinds: single,
      });
      expect(claimed.map((job) => job.id)).toEqual([first.id]);

      // Q-JOB-4's index is scoped to `status = 'queued'`, so the leased job freed its key and a new
      // one queues under it. That is correct — a message that arrived during the embedding needs
      // its own run — and it is exactly the window `02` §3.10.3's extra exclusion covers.
      const second = world.store.write((uow) =>
        world.repos.jobs.enqueueDebounced(uow, embed, {
          ...args,
          payload: { note: 'b', count: 1 },
        }),
      );
      expect(second.id).not.toBe(first.id);
      expect(
        world.repos.jobs.claim('boot-01:embed:1', {
          kinds: ['embed.items'],
          max: 5,
          leaseMs: DEFAULT_CLAIM_LEASE_MS,
          singleFlightKinds: single,
        }),
        'two jobs with one debounce key were leased at once',
      ).toEqual([]);

      // Once the first finishes, the second runs. `04` R11's point is that they are serialised,
      // not that the second is dropped.
      const job = claimed[0];
      if (job === undefined) throw new Error('fixture');
      expect(world.repos.jobs.complete(job)).toBe('ok');
      expect(
        world.repos.jobs
          .claim('boot-01:embed:1', {
            kinds: ['embed.items'],
            max: 5,
            leaseMs: DEFAULT_CLAIM_LEASE_MS,
            singleFlightKinds: single,
          })
          .map((claimedJob) => claimedJob.id),
      ).toEqual([second.id]);
    });
  });

  it('lets two different keys of a single-flight kind run at once', () => {
    withRepos((world) => {
      const { def } = registryOf();
      const embed = def('embed.items');
      const args = {
        partitionKey: world.groupId,
        quietMs: 0,
        maxWaitMs: 600_000,
        merge: (_previous: Payload, next: Payload) => next,
      };
      world.store.write((uow) => {
        for (const conversation of ['cnv_a', 'cnv_b']) {
          world.repos.jobs.enqueueDebounced(uow, embed, {
            ...args,
            debounceKey: `embed:${world.groupId}:${conversation}`,
            payload: { note: conversation, count: 1 },
          });
        }
      });
      // Only one comes back, and **not** because of single-flight: `rn = 1` takes one job per
      // partition per round, which is the fairness clause. The distinction matters, because an
      // implementation that applied single-flight per *kind* rather than per *key* would look
      // identical here and would serialise every group's embedding behind one conversation's.
      const round = (worker: string) =>
        world.repos.jobs.claim(worker, {
          kinds: ['embed.items'],
          max: 5,
          leaseMs: DEFAULT_CLAIM_LEASE_MS,
          singleFlightKinds: ['embed.items'],
        });
      const first = round(WORKER);
      expect(first).toHaveLength(1);
      const job = first[0];
      if (job === undefined) throw new Error('fixture');
      expect(world.repos.jobs.complete(job)).toBe('ok');
      // The second conversation's job runs next round, under a different key.
      const second = round('boot-01:embed:1');
      expect(second).toHaveLength(1);
      expect(second[0]?.debounceKey).not.toBe(job.debounceKey);
    });
  });

  it('does not claim a job that is not due, or one in a paused partition', () => {
    withRepos((world) => {
      const def = registryOf().def('poll.close');
      const future = Temporal.Instant.fromEpochMilliseconds(Date.now() + 3_600_000);
      world.store.write((uow) => {
        world.repos.jobs.enqueue(uow, def, {
          partitionKey: world.groupId,
          payload: { note: 'later', count: 0 },
          runAt: future,
        });
        world.repos.jobs.enqueue(uow, def, {
          partitionKey: world.otherGroupId,
          payload: { note: 'paused', count: 0 },
        });
      });
      // `02` §3.10.3's `coalesce(p.paused, 0) = 0`: a paused partition keeps its jobs rather than
      // losing them — used while a group is being deleted, and by `05`'s budget guard. Cancelling
      // instead would lose work that should resume.
      world.db
        .prepare(
          'INSERT INTO job_partitions (partition_key, last_claimed_at, paused) VALUES (?, 0, 1)',
        )
        .run(world.otherGroupId);
      expect(
        world.repos.jobs.claim(WORKER, { kinds: ['poll.close'], max: 5, leaseMs: 60_000 }),
      ).toEqual([]);
      expect(world.repos.jobs.jobsByStatus('queued', 10)).toHaveLength(2);
    });
  });

  it('recovers a previous incarnation`s leases immediately', () => {
    withRepos((world) => {
      const def = registryOf().def('poll.close');
      world.store.write((uow) =>
        world.repos.jobs.enqueue(uow, def, {
          partitionKey: world.groupId,
          payload: { note: 'a', count: 0 },
        }),
      );
      // A long lease, so the time half of the predicate cannot be what recovers it.
      world.repos.jobs.claim(WORKER, { kinds: ['poll.close'], max: 1, leaseMs: 3_600_000 });
      expect(world.repos.jobs.recoverExpiredLeases('boot-01')).toBe(0);
      // `02` §3.10.3's `lease_owner NOT LIKE :bootId || ':%'`. Without it a restart would wait out
      // its predecessor's leases — an hour, for `backup.offsite` — before doing any work.
      expect(world.repos.jobs.recoverExpiredLeases('boot-02')).toBe(1);
      const recovered = world.repos.jobs.job(
        world.repos.jobs.jobsByStatus('queued', 1)[0]?.id ?? ('x' as never),
      );
      expect(recovered?.status).toBe('queued');
      expect(recovered?.leaseOwner).toBeUndefined();
      expect(recovered?.lastError?.code).toBe('LEASE_EXPIRED');
      // The attempt is **not** reset: the recovery is one of the job's attempts, or a job whose
      // handler reliably hangs would be retried forever.
      expect(recovered?.attempts).toBe(1);
    });
  });
});

describe('failure, backoff and the dead letter (02 §3.10.3)', () => {
  const retryable = {
    code: 'IO',
    message: 'the network blinked',
    retryable: true,
    at: T0.toString(),
  };
  const permanent = {
    code: 'BAD_INPUT',
    message: 'that will never work',
    retryable: false,
    at: T0.toString(),
  };

  function claimOne(world: Parameters<Parameters<typeof withRepos>[0]>[0], note = 'a') {
    const def = registryOf().def('poll.close');
    world.store.write((uow) =>
      world.repos.jobs.enqueue(uow, def, {
        partitionKey: world.groupId,
        payload: { note, count: 0 },
        idempotencyKey: `poll:${note}`,
      }),
    );
    const [job] = world.repos.jobs.claim(WORKER, {
      kinds: ['poll.close'],
      max: 1,
      leaseMs: DEFAULT_CLAIM_LEASE_MS,
    });
    if (job === undefined) throw new Error('fixture');
    return job;
  }

  it('requeues a retryable failure with an equal-jitter backoff', () => {
    withRepos((world) => {
      const job = claimOne(world);
      expect(world.repos.jobs.fail(job, retryable, { retryable: true })).toBe('requeued');
      const row = world.repos.jobs.job(job.id);
      expect(row?.status).toBe('queued');
      expect(row?.lastError?.code).toBe('IO');
      // `02` §3.10.3's job policy: base 5 s. Equal jitter, so the first retry waits between half
      // the base and the whole of it — never zero, which would be a hot loop.
      const waited = (row?.runAt.epochMilliseconds ?? 0) - (row?.createdAt.epochMilliseconds ?? 0);
      expect(waited).toBeGreaterThanOrEqual(2_500);
      expect(waited).toBeLessThanOrEqual(5_000 + 1_000);
      // `started_at` is cleared, so `job_wait_ms` measures *this* attempt's wait rather than the
      // first one's (`02` §3.10.4's histogram).
      expect(row?.startedAt).toBeUndefined();
      expect(row?.leaseOwner).toBeUndefined();
    });
  });

  it('kills a permanent failure on the first attempt, and a retryable one when spent', () => {
    withRepos((world) => {
      const permanentJob = claimOne(world, 'a');
      expect(world.repos.jobs.fail(permanentJob, permanent, { retryable: false })).toBe('dead');
      expect(world.repos.jobs.job(permanentJob.id)?.status).toBe('dead');
      expect(world.repos.jobs.job(permanentJob.id)?.finishedAt).toBeDefined();

      // Eight attempts, which is `02` §3.10.1's `maxAttempts`. The eighth must be the last: an
      // off-by-one is a job that retries forever, and each individual retry looks reasonable.
      let job = claimOne(world, 'b');
      for (let attempt = 1; attempt <= 8; attempt += 1) {
        expect(job.attempts).toBe(attempt);
        const outcome = world.repos.jobs.fail(job, retryable, { retryable: true });
        expect(outcome).toBe(attempt < 8 ? 'requeued' : 'dead');
        if (attempt === 8) break;
        const row = world.repos.jobs.job(job.id);
        if (row === undefined) throw new Error('fixture');
        // Claim it again at its own `run_at`, which is what the worker loop does.
        world.db
          .prepare('UPDATE jobs SET run_at = ? WHERE id = ?')
          .run(row.createdAt.epochMilliseconds, job.id);
        const [next] = world.repos.jobs.claim(WORKER, {
          kinds: ['poll.close'],
          max: 1,
          leaseMs: DEFAULT_CLAIM_LEASE_MS,
        });
        if (next === undefined) throw new Error('fixture');
        job = next;
      }
      expect(world.repos.jobs.jobsByStatus('dead', 10)).toHaveLength(2);
    });
  });

  it('takes a retry-after only when it asks for longer', () => {
    withRepos((world) => {
      const job = claimOne(world);
      world.repos.jobs.fail(job, retryable, { retryable: true, retryAfterMs: 3_600_000 });
      const row = world.repos.jobs.job(job.id);
      const waited = (row?.runAt.epochMilliseconds ?? 0) - (row?.createdAt.epochMilliseconds ?? 0);
      // A server asking for longer knows something we do not. One asking for shorter would let a
      // client talk itself out of its own backoff, which is how a rate limit becomes a ban.
      expect(waited).toBeGreaterThanOrEqual(3_600_000);
    });
  });

  it('re-queues a dead job with its full budget', () => {
    withRepos((world) => {
      const job = claimOne(world);
      world.repos.jobs.fail(job, permanent, { retryable: false });
      expect(world.repos.jobs.retryDead(job.id)).toBe('requeued');
      const row = world.repos.jobs.job(job.id);
      // `02` §3.10.3: "`retryDead` sets `queued`, `attempts=0`, `run_at=now`". The reset is the
      // point — a host asking for a retry has fixed the cause, and a job that came back with its
      // budget spent would die again on the first hiccup.
      expect(row?.status).toBe('queued');
      expect(row?.attempts).toBe(0);
      expect(row?.finishedAt).toBeUndefined();
      expect(world.repos.jobs.retryDead(job.id)).toBe('not_found');
    });
  });

  it('reports queue depth and the oldest due age (02 §3.10.4)', () => {
    withRepos((world) => {
      const registry = registryOf();
      const def = registry.def('poll.close');
      const other = registry.def('digest.morning');
      const now = Temporal.Instant.fromEpochMilliseconds(Date.now());
      world.store.write((uow) => {
        for (const note of ['a', 'b']) {
          world.repos.jobs.enqueue(uow, def, {
            partitionKey: world.groupId,
            payload: { note, count: 0 },
            runAt: now.subtract({ minutes: 5 }),
          });
        }
        world.repos.jobs.enqueue(uow, other, {
          partitionKey: world.groupId,
          payload: { note: 'c', count: 0 },
          // Not due, so it is in no gauge: a thousand jobs due in an hour is a healthy queue, and
          // counting them would make the alarm meaningless.
          runAt: now.add({ hours: 1 }),
        });
      });
      const depth = world.repos.jobs.queueDepth(now);
      expect(depth.map((row) => [row.kind, row.queued])).toEqual([['poll.close', 2]]);
      expect(depth[0]?.oldestDueAgeMs).toBeGreaterThanOrEqual(5 * 60_000);
    });
  });

  it('answers `not_found` for a job that is not there', () => {
    withRepos((world) => {
      expect(world.repos.jobs.job('job_01jqw8z5h7e9r3t4y5v6k7p8q9' as never)).toBeUndefined();
      expect(world.repos.jobs.retryDead('job_01jqw8z5h7e9r3t4y5v6k7p8q9' as never)).toBe(
        'not_found',
      );
      expect(world.repos.jobs.claim(WORKER, { kinds: [], max: 5, leaseMs: 60_000 })).toEqual([]);
      expect(
        world.repos.jobs.claim(WORKER, { kinds: ['poll.close'], max: 0, leaseMs: 60_000 }),
      ).toEqual([]);
      expect(world.repos.jobs.queueDepth(T0)).toEqual([]);
      // The catalog has an entry for every pool, so the limits are complete.
      for (const pool of JOB_POOLS) expect(POOL_LIMITS[pool]).toBeGreaterThan(0);
      expect(groupId('a1f')).toMatch(/^grp_/);
      expect(() => new JobKindRegistry().register('nope', PayloadSchema)).toThrow(StorageError);
    });
  });
});
