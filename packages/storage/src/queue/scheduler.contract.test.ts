/**
 * The scheduler (`M1-T24`; `02` §3.10.5).
 *
 * The acceptance criterion names two behaviours and both get their own `describe`:
 *
 *  - **`TzRef` resolution** — `{fixed}`, `{group}`, and `{member}` as
 *    `person.timezone ?? group.timezone`, resolved at fire time rather than stored;
 *  - **recompute on a timezone change**, in the same transaction as the change.
 *
 * The misfire policy and the catch-up bound are here too, because both are decisions whose wrong
 * form is quiet: a missed digest delivered at 3pm, or a fortnight of them delivered at once.
 */
import { expectWritten, type NotPromise, type ScheduleSpec, type TzRef } from '@comvivo/core';
import type { JobScheduleId, MemberId } from '@comvivo/shared';
import { parseTimeZoneId, TypeIdGenerator, z } from '@comvivo/shared';
import { SeededRng, VirtualClock } from '@comvivo/shared/testing';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { SqliteStore } from '../db/tx.js';
import {
  group,
  groupId,
  member,
  memberId,
  person,
  silentLogger,
  withRepos,
} from '../repos/testing/harness.js';
import { JobKindRegistry } from './kinds.js';

const PayloadSchema = z.object({ n: z.int().min(0) });
/**
 * A zone, narrowed through the parser rather than cast.
 *
 * `TimeZoneId` is branded, and the brand is what stops a typo like `Europe/Berln` reaching a column
 * — so a test that cast past it would be testing a value the product cannot store.
 */
function tz(name: string) {
  const parsed = parseTimeZoneId(name);
  if (parsed === undefined) throw new Error(`${name} is not a timezone`);
  return parsed;
}

const DIGEST = 'digest.morning';
const BACKUP = 'backup.snapshot';

type World = Parameters<Parameters<typeof withRepos>[0]>[0];

function scheduleId(tag: string): JobScheduleId {
  return `jsch_01j${tag}${'0'.repeat(23 - tag.length)}` as JobScheduleId;
}

function registryOf(): JobKindRegistry {
  const registry = new JobKindRegistry();
  registry.register(DIGEST, PayloadSchema);
  registry.register(BACKUP, PayloadSchema);
  return registry;
}

/** A group in `Europe/Berlin` with one member whose person has no zone of their own. */
function withSchedules<T>(fn: (world: World, ids: { who: MemberId }) => NotPromise<T>): T {
  return withRepos((world) => {
    const who = world.store.write((uow) => {
      expectWritten(world.repos.persons.create(uow, person('a')), 'a person');
      return expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'a member').id;
    });
    world.store.write((uow) =>
      world.repos.groups.update(uow, world.groupId, 1, { timezone: tz('Europe/Berlin') }),
    );
    return fn(world, { who });
  }) as T;
}

const daily = (at: string, tz: TzRef): ScheduleSpec => ({ kind: 'daily', at, tz });

function upsert(
  world: World,
  id: string,
  spec: ScheduleSpec,
  overrides: Partial<Parameters<World['repos']['schedules']['upsert']>[1]> = {},
) {
  return world.store.write((uow) =>
    world.repos.schedules.upsert(uow, {
      id: scheduleId(id),
      kind: DIGEST,
      partitionKey: world.groupId,
      spec,
      payload: JSON.stringify({ n: 0 }),
      misfire: 'skip',
      misfireGraceMs: 2 * 3_600_000,
      ownerRef: `${world.groupId}:${id}`,
      ...overrides,
    }),
  );
}

describe('TzRef resolution (02 §3.10.5)', () => {
  it('takes a fixed zone as given', () => {
    withSchedules((world) => {
      expect(world.repos.schedules.resolveTz({ fixed: tz('Asia/Kathmandu') })).toBe(
        'Asia/Kathmandu',
      );
    });
  });

  it('resolves a group reference to the group`s own zone', () => {
    withSchedules((world) => {
      expect(world.repos.schedules.resolveTz({ group: world.groupId })).toBe('Europe/Berlin');
      // A group that is gone falls back to UTC rather than throwing: the tick is a batch, and one
      // stale schedule must not stop the other ninety-nine. The row is the retention sweep's.
      expect(world.repos.schedules.resolveTz({ group: groupId('z9f') })).toBe('UTC');
    });
  });

  it('resolves a member reference as person.timezone ?? group.timezone', () => {
    withSchedules((world, ids) => {
      // The member's person has no zone, so the group's is used — a member who has never set one
      // should get the group's day, not UTC.
      expect(world.repos.schedules.resolveTz({ member: ids.who })).toBe('Europe/Berlin');

      world.store.write((uow) =>
        world.repos.persons.setPreferences(uow, person('a').id, { timezone: tz('America/Denver') }),
      );
      // Their own zone wins once they set one, and **at fire time**: storing it resolved would mean
      // a member who moves keeps getting their brief at their old local time until somebody
      // noticed, and nobody would — the schedule would look right in the dashboard.
      expect(world.repos.schedules.resolveTz({ member: ids.who })).toBe('America/Denver');
      expect(world.repos.schedules.resolveTz({ member: memberId('z9f') })).toBe('UTC');
    });
  });

  it('computes the first fire in the resolved zone', () => {
    withSchedules((world, ids) => {
      const created = upsert(world, 'a1f', daily('07:30', { member: ids.who }));
      expect(created.nextRunAt).toBeDefined();
      // 07:30 in Berlin, which is not 07:30 UTC — the test that a resolved zone was used at all.
      const local = created.nextRunAt?.toZonedDateTimeISO('Europe/Berlin');
      expect(local?.hour).toBe(7);
      expect(local?.minute).toBe(30);
      expect(created.nextRunAt?.toZonedDateTimeISO('UTC').hour).not.toBe(7);
    });
  });
});

describe('recompute on a timezone change (02 §3.10.5)', () => {
  it('moves every schedule pointing at the member who moved', () => {
    withSchedules((world, ids) => {
      // A **second** member with a schedule of their own. With only one, every `{member}` schedule
      // points at the mover and `pointsAt` could ignore the id entirely — measured: dropping the
      // `own.member === ref.member` comparison changed no test. One person moving must not reschedule
      // everybody else's morning brief.
      const other = world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('b')), 'another person');
        return expectWritten(
          world.repos.members.add(uow, member('b', world.groupId)),
          'another member',
        ).id;
      });
      const theirs = upsert(world, 'b4f', daily('07:30', { member: other }), {
        ownerRef: `${other}:digest.morning`,
      });
      const mine = upsert(world, 'b1f', daily('07:30', { member: ids.who }));
      const theGroup = upsert(world, 'b2f', daily('07:30', { group: world.groupId }));
      const fixed = upsert(world, 'b3f', daily('07:30', { fixed: tz('Asia/Tokyo') }));

      const moved = world.store.write((uow) => {
        world.repos.persons.setPreferences(uow, person('a').id, {
          timezone: tz('Pacific/Auckland'),
        });
        // In the **same transaction** as the change. Outside it there is a window where the stored
        // instant and the stored zone disagree, and a tick landing in it fires at the old local
        // time — once, silently, and only for whoever moved.
        return world.repos.schedules.recomputeFor(uow, { member: ids.who });
      });
      expect(moved).toBe(1);

      const after = world.repos.schedules.schedule(mine.id);
      expect(after?.nextRunAt?.epochMilliseconds).not.toBe(mine.nextRunAt?.epochMilliseconds);
      expect(after?.nextRunAt?.toZonedDateTimeISO('Pacific/Auckland').hour).toBe(7);
      // The other two are untouched, which is what makes the reference the unit: a group's
      // schedule and an instance backup have nothing to do with one member's move.
      expect(world.repos.schedules.schedule(theGroup.id)?.nextRunAt?.epochMilliseconds).toBe(
        theGroup.nextRunAt?.epochMilliseconds,
      );
      expect(world.repos.schedules.schedule(fixed.id)?.nextRunAt?.epochMilliseconds).toBe(
        fixed.nextRunAt?.epochMilliseconds,
      );
      // And the other member's, which is the one that catches a `pointsAt` that does not compare
      // the id.
      expect(world.repos.schedules.schedule(theirs.id)?.nextRunAt?.epochMilliseconds).toBe(
        theirs.nextRunAt?.epochMilliseconds,
      );
    });
  });

  it('moves every schedule pointing at the group when the group moves', () => {
    withSchedules((world, ids) => {
      const theGroup = upsert(world, 'c1f', daily('07:30', { group: world.groupId }));
      const mine = upsert(world, 'c2f', daily('07:30', { member: ids.who }));
      const moved = world.store.write((uow) => {
        world.repos.groups.update(uow, world.groupId, 2, { timezone: tz('America/Sao_Paulo') });
        return world.repos.schedules.recomputeFor(uow, { group: world.groupId });
      });
      expect(moved).toBe(1);
      expect(
        world.repos.schedules
          .schedule(theGroup.id)
          ?.nextRunAt?.toZonedDateTimeISO('America/Sao_Paulo').hour,
      ).toBe(7);
      // The member's schedule points at the **member**, so a group move does not match it even
      // though the member resolves through the group. `02` §3.10.5's `recomputeFor(ref)` is keyed
      // on the reference, and a caller changing a group timezone has to recompute both — which is
      // what the member's own fallback makes necessary and what this asserts is *not* automatic.
      expect(world.repos.schedules.schedule(mine.id)?.nextRunAt?.epochMilliseconds).toBe(
        mine.nextRunAt?.epochMilliseconds,
      );
      expect(
        world.store.write((uow) => world.repos.schedules.recomputeFor(uow, { member: ids.who })),
      ).toBe(1);
      expect(
        world.repos.schedules.schedule(mine.id)?.nextRunAt?.toZonedDateTimeISO('America/Sao_Paulo')
          .hour,
      ).toBe(7);
    });
  });

  it('leaves a disabled schedule alone', () => {
    withSchedules((world, ids) => {
      const created = upsert(world, 'd1f', daily('07:30', { member: ids.who }));
      world.store.write((uow) => world.repos.schedules.setEnabled(uow, created.id, false));
      expect(
        world.store.write((uow) => world.repos.schedules.recomputeFor(uow, { member: ids.who })),
      ).toBe(0);
      // Disabled is not "deleted": `02` §3.3.8 keeps the row, and re-enabling it should not have
      // to re-derive the spec. But recomputing it would be work for something that will not fire.
      expect(world.repos.schedules.schedule(created.id)?.enabled).toBe(false);
    });
  });
});

describe('the tick (02 §3.10.5)', () => {
  it('enqueues a due schedule once, keyed on the fire instant', () => {
    withSchedules((world) => {
      const registry = registryOf();
      const created = upsert(world, 'e1f', daily('07:30', { fixed: tz('UTC') }));
      // Wind the schedule into the past, which is what the clock reaching it does.
      const fire = windBack(world, created.id, 60_000);

      const first = world.store.write((uow) =>
        world.repos.schedules.tick(uow, (kind) => registry.def(kind)),
      );
      expect(first.fired.map((row) => row.scheduleId)).toEqual([created.id]);
      expect(first.fired[0]?.job.kind).toBe('enqueued');
      expect(world.repos.jobs.jobsByStatus('queued', 10)).toHaveLength(1);
      // `02` §3.10.5's key, on the **fire** instant rather than on `now`: two ticks a second apart
      // would otherwise mint two keys for one occurrence and run the digest twice.
      expect(world.repos.jobs.jobsByStatus('queued', 10)[0]?.idempotencyKey).toBe(
        `sched:${created.id}:${String(fire)}`,
      );
      // `last_fired_at` is the occurrence, and `next_run_at` has moved past it.
      const after = world.repos.schedules.schedule(created.id);
      expect(after?.lastFiredAt?.epochMilliseconds).toBe(fire);
      expect(after?.nextRunAt?.epochMilliseconds).toBeGreaterThan(fire);

      // A second tick finds nothing due, so nothing is enqueued twice.
      const second = world.store.write((uow) =>
        world.repos.schedules.tick(uow, (kind) => registry.def(kind)),
      );
      expect(second.fired).toEqual([]);
      expect(world.repos.jobs.jobsByStatus('queued', 10)).toHaveLength(1);
    });
  });

  it('is idempotent if the same occurrence is ticked twice', () => {
    withSchedules((world) => {
      const registry = registryOf();
      const created = upsert(world, 'f1f', daily('07:30', { fixed: tz('UTC') }));
      const fire = windBack(world, created.id, 60_000);
      world.store.write((uow) => world.repos.schedules.tick(uow, (kind) => registry.def(kind)));
      // Wind the schedule back to the **same** occurrence, which is what a crash between the
      // enqueue and the `next_run_at` write would leave behind.
      world.db
        .prepare('UPDATE job_schedules SET next_run_at = ? WHERE id = ?')
        .run(fire, created.id);
      const again = world.store.write((uow) =>
        world.repos.schedules.tick(uow, (kind) => registry.def(kind)),
      );
      // Enqueued again, and answered `duplicate` — one job for one occurrence, which is what the
      // idempotency key is for.
      expect(again.fired[0]?.job.kind).toBe('duplicate');
      expect(world.repos.jobs.jobsByStatus('queued', 10)).toHaveLength(1);
    });
  });

  it('skips a late occurrence when the policy says skip, and fires it when it says run_once', () => {
    withSchedules((world) => {
      const registry = registryOf();
      const digest = upsert(world, 'g1f', daily('07:30', { fixed: tz('UTC') }), {
        misfire: 'skip',
        misfireGraceMs: 2 * 3_600_000,
      });
      const backup = upsert(world, 'g2f', daily('03:30', { fixed: tz('UTC') }), {
        kind: BACKUP,
        misfire: 'run_once',
        misfireGraceMs: 0,
        ownerRef: 'instance:backup',
        partitionKey: '_instance',
      });
      // Both three hours late: past the digest's two-hour grace, and past the backup's zero.
      windBack(world, digest.id, 3 * 3_600_000);
      const backupFire = windBack(world, backup.id, 3 * 3_600_000);

      const result = world.store.write((uow) =>
        world.repos.schedules.tick(uow, (kind) => registry.def(kind)),
      );
      // `02` §3.10.5's defaults say why: delivering yesterday morning's brief at 3pm is worse than
      // not delivering it, and a missed nightly backup should run when the machine comes back.
      expect(result.skipped).toContain(digest.id);
      expect(result.fired.map((row) => row.scheduleId)).toEqual([backup.id]);
      // A skipped occurrence still advances: `last_fired_at` records the occurrence that was
      // considered, so the schedule does not re-examine it on the next tick.
      expect(world.repos.schedules.schedule(digest.id)?.lastFiredAt).toBeDefined();
      expect(world.repos.schedules.schedule(backup.id)?.lastFiredAt?.epochMilliseconds).toBe(
        backupFire,
      );
    });
  });

  it('catches up at most once after a long outage', () => {
    withSchedules((world) => {
      const registry = registryOf();
      const created = upsert(world, 'h1f', daily('07:30', { fixed: tz('UTC') }), {
        misfire: 'run_once',
        misfireGraceMs: 30 * 86_400_000,
      });
      // A fortnight in the past, which is what a two-week outage leaves behind.
      windBack(world, created.id, 14 * 86_400_000);
      const result = world.store.write((uow) =>
        world.repos.schedules.tick(uow, (kind) => registry.def(kind)),
      );
      // **One** job, not fourteen. `02` §3.10.5's `max(fire, now − 1 ms)` is what does it: the
      // schedule resumes from now rather than walking forward through every missed occurrence —
      // which would enqueue a fortnight of digests and deliver them all at once.
      expect(result.fired).toHaveLength(1);
      expect(world.repos.jobs.jobsByStatus('queued', 100)).toHaveLength(1);
      const after = world.repos.schedules.schedule(created.id);
      // And the next one is in the future, within a day.
      const ahead =
        (after?.nextRunAt?.epochMilliseconds ?? 0) - (after?.lastFiredAt?.epochMilliseconds ?? 0);
      expect(ahead).toBeGreaterThan(0);
      expect(ahead).toBeLessThanOrEqual(15 * 86_400_000);
      const second = world.store.write((uow) =>
        world.repos.schedules.tick(uow, (kind) => registry.def(kind)),
      );
      expect(second.fired).toEqual([]);
    });
  });

  it('advances past a punctual occurrence rather than offering it again', () => {
    withSchedules((world) => {
      const registry = registryOf();
      const created = upsert(world, 'p1f', daily('07:30', { fixed: tz('UTC') }));
      const fire = created.nextRunAt;
      if (fire === undefined) throw new Error('fixture');

      // A clock set **exactly** to the occurrence, which is the case `max(fire, now − 1 ms)`
      // exists for. The store is rebuilt around a `VirtualClock` over the same repositories, so
      // `uow.now` is the occurrence instant rather than whatever the system clock reads.
      const punctual = new SqliteStore({
        db: world.db,
        clock: new VirtualClock(fire),
        logger: silentLogger,
        ids: new TypeIdGenerator(new VirtualClock(fire)),
        rng: new SeededRng(5),
        repositories: world.repos,
      });
      const result = punctual.write((uow) =>
        world.repos.schedules.tick(uow, (kind) => registry.def(kind)),
      );
      expect(result.fired.map((row) => row.scheduleId)).toEqual([created.id]);

      const after = world.repos.schedules.schedule(created.id);
      expect(after?.lastFiredAt?.epochMilliseconds).toBe(fire.epochMilliseconds);
      // **Strictly** after the occurrence that just fired. With the base at `now − 1 ms` alone,
      // the strict search returns `fire` itself — `next_run_at` never moves, and the schedule is
      // stuck one occurrence behind, re-enqueuing a duplicate on every tick forever. The
      // idempotency key would hide it: no digest arrives twice, and nothing looks wrong.
      expect(after?.nextRunAt?.epochMilliseconds).toBeGreaterThan(fire.epochMilliseconds);
      expect(after?.nextRunAt?.toZonedDateTimeISO('UTC').hour).toBe(7);

      // And a second punctual tick at the same instant finds nothing due, which is the property
      // that was actually broken.
      expect(
        punctual.write((uow) => world.repos.schedules.tick(uow, (kind) => registry.def(kind)))
          .fired,
      ).toEqual([]);
    });
  });

  it('skips a kind nobody registered without stopping the batch', () => {
    withSchedules((world) => {
      const registry = new JobKindRegistry();
      registry.register(BACKUP, PayloadSchema);
      const digest = upsert(world, 'j1f', daily('07:30', { fixed: tz('UTC') }));
      const backup = upsert(world, 'j2f', daily('03:30', { fixed: tz('UTC') }), {
        kind: BACKUP,
        ownerRef: 'instance:backup',
        partitionKey: '_instance',
      });
      windBack(world, digest.id, 60_000);
      windBack(world, backup.id, 120_000);
      const result = world.store.write((uow) =>
        world.repos.schedules.tick(uow, (kind) => registry.def(kind)),
      );
      // One registered kind, one not. The tick is a batch, so an unregistered kind is skipped and
      // advanced rather than thrown — otherwise one stale schedule would stop every other schedule
      // in the same tick, which on a nightly batch means nothing runs at all.
      expect(result.skipped).toContain(digest.id);
      expect(result.fired.map((row) => row.scheduleId)).toEqual([backup.id]);
      expect(
        world.repos.schedules.schedule(digest.id)?.nextRunAt?.epochMilliseconds,
      ).toBeGreaterThan(Date.now() - 60_000);
    });
  });

  it('does not tick a disabled schedule', () => {
    withSchedules((world) => {
      const registry = registryOf();
      const created = upsert(world, 'k1f', daily('07:30', { fixed: tz('UTC') }));
      windBack(world, created.id, 60_000);
      world.store.write((uow) => world.repos.schedules.setEnabled(uow, created.id, false));
      expect(
        world.store.write((uow) => world.repos.schedules.tick(uow, (kind) => registry.def(kind)))
          .fired,
      ).toEqual([]);
      expect(world.repos.schedules.due(Temporal.Instant.fromEpochMilliseconds(Date.now()))).toEqual(
        [],
      );
      // Re-enabling makes it due again, which is what makes `enabled` a pause rather than a delete.
      world.store.write((uow) => world.repos.schedules.setEnabled(uow, created.id, true));
      expect(
        world.store.write((uow) => world.repos.schedules.tick(uow, (kind) => registry.def(kind)))
          .fired,
      ).toHaveLength(1);
    });
  });
});

describe('upsert and owner_ref (02 §3.3.8)', () => {
  it('replaces a schedule under the same owner rather than adding one', () => {
    withSchedules((world, ids) => {
      const first = upsert(world, 'm1f', daily('07:30', { member: ids.who }), {
        ownerRef: `${ids.who}:digest.morning`,
      });
      const second = upsert(world, 'm2f', daily('09:00', { member: ids.who }), {
        ownerRef: `${ids.who}:digest.morning`,
      });
      // `job_schedules_owner_uq`: `'mbr_…:digest.morning'` identifies "this member's morning
      // brief", so re-running setup updates it. Without that, a member who went through onboarding
      // twice would get two briefs every morning and nothing would look wrong.
      expect(second.id).toBe(first.id);
      expect(second.spec).toMatchObject({ at: '09:00' });
      expect(world.repos.schedules.byOwner(`${ids.who}:digest.morning`)?.id).toBe(first.id);
      expect(world.db.prepare('SELECT count(*) AS n FROM job_schedules').get()).toEqual({ n: 1 });
    });
  });

  it('reports nothing for an id or owner that is not there', () => {
    withSchedules((world) => {
      expect(world.repos.schedules.schedule(scheduleId('z9f'))).toBeUndefined();
      expect(world.repos.schedules.byOwner('nobody')).toBeUndefined();
      expect(
        world.store.write((uow) => world.repos.schedules.setEnabled(uow, scheduleId('z9f'), true)),
      ).toBeUndefined();
      expect(
        world.store.write((uow) => world.repos.schedules.recomputeFor(uow, { fixed: tz('UTC') })),
      ).toBe(0);
      expect(group(groupId('n1f'), 'x').name).toBe('x');
    });
  });

  it('gives an interval schedule no zone to resolve', () => {
    withSchedules((world) => {
      const registry = registryOf();
      const created = upsert(world, 'n1f', { kind: 'interval', everyMs: 300_000 });
      expect(created.nextRunAt).toBeDefined();
      windBack(world, created.id, 1_000);
      const result = world.store.write((uow) =>
        world.repos.schedules.tick(uow, (kind) => registry.def(kind)),
      );
      expect(result.fired).toHaveLength(1);
      const after = world.repos.schedules.schedule(created.id);
      // Five minutes after the catch-up floor, not after the stale occurrence: `interval` is
      // elapsed time, and resuming from a fortnight ago would make it fire immediately again.
      const ahead =
        (after?.nextRunAt?.epochMilliseconds ?? 0) - (after?.lastFiredAt?.epochMilliseconds ?? 0);
      expect(ahead).toBeGreaterThanOrEqual(299_000);
      expect(ahead).toBeLessThanOrEqual(301_000);
      // A recompute never matches an interval schedule: it has no `TzRef` to point at anything.
      expect(
        world.store.write((uow) => world.repos.schedules.recomputeFor(uow, { fixed: tz('UTC') })),
      ).toBe(0);
    });
  });
});

/**
 * Wind a schedule's `next_run_at` into the past and return the instant, in epoch milliseconds.
 *
 * Written directly because the harness's clock is the system one: a test that waited for a daily
 * schedule to come due would wait up to a day.
 */
function windBack(world: World, id: JobScheduleId, agoMs: number): number {
  const fire = Date.now() - agoMs;
  world.db.prepare('UPDATE job_schedules SET next_run_at = ? WHERE id = ?').run(fire, id);
  return fire;
}
