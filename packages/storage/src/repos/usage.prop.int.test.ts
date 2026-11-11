/**
 * `usage.rollup-equals-records.property` (`M1-T21`; `02` §3.3.7).
 *
 * The property: **after any sequence of recorded calls, `usage_daily` equals the sum of
 * `usage_records`** — per `(groupKey, dayLocal, route)`, for calls, cost and all three token
 * columns.
 *
 * Stated that way because the rollup is not a cache that can be rebuilt on demand. `05`'s budget
 * guard reads `spend()` on **every turn** (Q-USE-1), and a scan of `usage_records` would grow
 * without bound over a year — so the guard reads the rollup and nothing re-derives it. If the two
 * can drift, the product either refuses turns it should allow or allows spend it should refuse, and
 * nothing in the system notices either way.
 *
 * The sequence matters as much as the arithmetic. Any single `record` is obviously right; what has
 * to hold is that **no reachable sequence** — the same day twice, two routes on one day, a retried
 * id, an instance-level call mixed with a group's, a rolled-back transaction — leaves the two
 * disagreeing. Four of those five are cases a read-modify-write rollup or a non-transactional one
 * would get wrong.
 */
import { expectWritten } from '@comvivo/core';
import { fcConfig } from '@comvivo/shared/testing';
import fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { groupId, T0, usageId, withRepos } from './testing/harness.js';

const DAY = 86_400_000;

const call = fc.record({
  // Three days and three routes, so collisions on the primary key are frequent rather than rare —
  // a generator with 1 000 distinct keys would make every rollup row a fresh insert and never
  // exercise the `ON CONFLICT` arithmetic that is the whole mechanism.
  day: fc.nat(2),
  route: fc.constantFrom('chat', 'route', 'extract'),
  instance: fc.boolean(),
  inputTokens: fc.nat(10_000),
  cachedReadTokens: fc.nat(10_000),
  outputTokens: fc.nat(10_000),
  costMicros: fc.nat(1_000_000),
  retry: fc.boolean(),
});

const dayOf = (day: number) =>
  Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + day * DAY)
    .toZonedDateTimeISO('UTC')
    .toPlainDate()
    .toString();

/**
 * One generated call as a `NewUsageRecord`.
 *
 * Extracted because the property's loop body was doing three things at once — choosing the id,
 * building the record, threading the result — and Biome's complexity score was right that it had
 * stopped being readable. The `retry` arm is the interesting part: it reuses an id already written,
 * which must come back `duplicate` and must be counted exactly once.
 */
function asRecord(
  world: Parameters<Parameters<typeof withRepos>[0]>[0],
  item: {
    readonly day: number;
    readonly route: string;
    readonly instance: boolean;
    readonly inputTokens: number;
    readonly cachedReadTokens: number;
    readonly outputTokens: number;
    readonly costMicros: number;
    readonly retry: boolean;
  },
  index: number,
  written: readonly string[],
) {
  const previous = written[index % Math.max(1, written.length)];
  const id = item.retry && previous !== undefined ? previous : usageId(`c${index.toString(16)}f`);
  return {
    id: id as ReturnType<typeof usageId>,
    // Spread rather than `groupId: undefined`, because an instance-level call has **no** group and
    // `02` §3.3.7 keys its rollup on `'_instance'` — see the test that separates the two.
    ...(item.instance ? {} : { groupId: world.groupId }),
    route: item.route,
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    servedModel: 'claude-opus-5-5',
    purpose: 'chat',
    inputTokens: item.inputTokens,
    cachedReadTokens: item.cachedReadTokens,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: item.outputTokens,
    costMicros: item.costMicros,
    priceTableVersion: 'p1',
    at: Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + item.day * DAY),
    dayLocal: dayOf(item.day),
  };
}

describe('usage.rollup-equals-records.property (02 §3.3.7)', { tags: ['prop', 'db'] }, () => {
  it('keeps usage_daily equal to the sum of usage_records, for any sequence of calls', () => {
    fc.assert(
      fc.property(fc.array(call, { minLength: 1, maxLength: 40 }), (calls) => {
        withRepos((world) => {
          const written: string[] = [];
          world.store.write((uow) => {
            for (const [index, item] of calls.entries()) {
              const result = world.repos.usage.record(uow, asRecord(world, item, index, written));
              if (result.kind === 'ok') written.push(result.value.id);
            }
          });

          // The oracle: the sum straight from `usage_records`, grouped the way the rollup is keyed.
          // Read with SQL rather than by re-running the repository's arithmetic, because an oracle
          // that shared the implementation's code would prove only that it agreed with itself.
          const expected = world.db
            .prepare(
              `SELECT coalesce(group_id, '_instance') AS group_key,
                      date(at / 1000, 'unixepoch') AS day_local,
                      route,
                      count(*) AS calls,
                      sum(cost_micros) AS cost_micros,
                      sum(input_tokens) AS input_tokens,
                      sum(output_tokens) AS output_tokens,
                      sum(cached_read_tokens) AS cached_read_tokens
                 FROM usage_records
                GROUP BY group_key, day_local, route
                ORDER BY group_key, day_local, route`,
            )
            .all();
          const actual = world.db
            .prepare(
              `SELECT group_key, day_local, route, calls, cost_micros, input_tokens,
                      output_tokens, cached_read_tokens
                 FROM usage_daily
                ORDER BY group_key, day_local, route`,
            )
            .all();
          expect(actual).toEqual(expected);
        });
      }),
      fcConfig(),
    );
  });

  it('keeps spend() equal to the rollup it reads, including an empty window', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        for (const [index, spec] of [
          { day: 0, route: 'chat', cost: 100 },
          { day: 0, route: 'chat', cost: 250 },
          { day: 0, route: 'extract', cost: 7 },
          { day: 1, route: 'chat', cost: 1 },
        ].entries()) {
          expectWritten(
            world.repos.usage.record(uow, {
              id: usageId(`s${index.toString(16)}f`),
              groupId: world.groupId,
              route: spec.route,
              provider: 'anthropic',
              model: 'claude-opus-5-5',
              servedModel: 'claude-opus-5-5',
              purpose: 'chat',
              inputTokens: 10,
              cachedReadTokens: 2,
              cacheWrite5mTokens: 0,
              cacheWrite1hTokens: 0,
              outputTokens: 3,
              costMicros: spec.cost,
              priceTableVersion: 'p1',
              at: Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + spec.day * DAY),
              dayLocal: dayOf(spec.day),
            }),
            `usage ${String(index)}`,
          );
        }
      });
      // One day, both routes: 100 + 250 + 7.
      expect(
        world.repos.usage.spend(world.groupId, { fromDay: dayOf(0), toDay: dayOf(0) }),
      ).toEqual({
        calls: 3,
        costMicros: 357,
        inputTokens: 30,
        outputTokens: 9,
        cachedReadTokens: 6,
      });
      // Both days.
      expect(
        world.repos.usage.spend(world.groupId, { fromDay: dayOf(0), toDay: dayOf(1) }).costMicros,
      ).toBe(358);
      // A window with nothing in it reads as zero rather than as `undefined`: `05`'s guard
      // compares a number, and a group that has spent nothing is the first turn of every install.
      expect(
        world.repos.usage.spend(world.groupId, { fromDay: dayOf(5), toDay: dayOf(6) }),
      ).toEqual({ calls: 0, costMicros: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0 });
      expect(
        world.repos.usage.spend('_instance', { fromDay: dayOf(0), toDay: dayOf(9) }).calls,
      ).toBe(0);
      // Per-route, for the dashboard's breakdown.
      expect(
        world.repos.usage
          .daily({ groupKey: world.groupId, fromDay: dayOf(0), toDay: dayOf(1) })
          .map((row) => [row.dayLocal, row.route, row.calls, row.costMicros]),
      ).toEqual([
        [dayOf(0), 'chat', 2, 350],
        [dayOf(0), 'extract', 1, 7],
        [dayOf(1), 'chat', 1, 1],
      ]);
    });
  });

  it('rolls nothing up when the transaction rolls back', () => {
    withRepos((world) => {
      expect(() =>
        world.store.write((uow) => {
          expectWritten(
            world.repos.usage.record(uow, {
              id: usageId('r1f'),
              groupId: world.groupId,
              route: 'chat',
              provider: 'anthropic',
              model: 'claude-opus-5-5',
              servedModel: 'claude-opus-5-5',
              purpose: 'chat',
              inputTokens: 1,
              cachedReadTokens: 0,
              cacheWrite5mTokens: 0,
              cacheWrite1hTokens: 0,
              outputTokens: 1,
              costMicros: 999,
              priceTableVersion: 'p1',
              at: T0,
              dayLocal: dayOf(0),
            }),
            'a usage record',
          );
          throw new Error('the turn failed after the model call');
        }),
      ).toThrow(/the turn failed/);
      // The rollup is in the **same** transaction as the record, so both went. A rollup written
      // outside it would have left the guard believing the group had spent 999 micros on a call
      // whose record does not exist — which is how a budget starts refusing turns for no reason.
      expect(
        world.repos.usage.spend(world.groupId, { fromDay: dayOf(0), toDay: dayOf(0) }).costMicros,
      ).toBe(0);
      expect(world.repos.usage.byId(usageId('r1f'))).toBeUndefined();
    });
  });

  it('counts a retried record once', () => {
    withRepos((world) => {
      const once = {
        id: usageId('t1f'),
        groupId: world.groupId,
        route: 'chat',
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        servedModel: 'claude-opus-5-5',
        purpose: 'chat',
        inputTokens: 5,
        cachedReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        outputTokens: 5,
        costMicros: 42,
        priceTableVersion: 'p1',
        at: T0,
        dayLocal: dayOf(0),
      } as const;
      const results = world.store.write((uow) => [
        world.repos.usage.record(uow, once),
        world.repos.usage.record(uow, once),
      ]);
      expect(results.map((result) => result.kind)).toEqual(['ok', 'duplicate']);
      // The duplicate path must not touch the rollup, or a retry would charge the group twice for
      // one model call — which is the specific way a non-idempotent rollup overcounts.
      expect(
        world.repos.usage.spend(world.groupId, { fromDay: dayOf(0), toDay: dayOf(0) }),
      ).toEqual({ calls: 1, costMicros: 42, inputTokens: 5, outputTokens: 5, cachedReadTokens: 0 });
    });
  });

  it('reads one record back, and nothing for an id that is not there', () => {
    withRepos((world) => {
      const written = world.store.write((uow) =>
        expectWritten(
          world.repos.usage.record(uow, {
            id: usageId('w1f'),
            groupId: world.groupId,
            route: 'chat',
            provider: 'anthropic',
            model: 'claude-opus-5-5',
            servedModel: 'claude-haiku-5-5',
            purpose: 'chat',
            via: 'dashboard',
            effort: 'high',
            kind: 'fallback_message',
            inputTokens: 11,
            cachedReadTokens: 3,
            cacheWrite5mTokens: 4,
            cacheWrite1hTokens: 5,
            outputTokens: 6,
            costMicros: 70,
            priceTableVersion: 'p2',
            batch: true,
            at: T0,
            dayLocal: dayOf(0),
          }),
          'a usage record',
        ),
      );
      const reread = world.repos.usage.byId(written.id);
      // `served_model` is separate from `model` because `05` S9's refusal fallback means the model
      // that answered may not be the one asked — and a cost report that conflated them would
      // misattribute spend and hide how often the fallback fires. Likewise the four token columns:
      // `02`'s price table charges cache writes by TTL and reads at a tenth of input, so a single
      // `inputTokens` would make `costMicros` unreproducible from the record.
      expect(reread?.servedModel).toBe('claude-haiku-5-5');
      expect(reread?.kind).toBe('fallback_message');
      expect(reread?.via).toBe('dashboard');
      expect(reread?.effort).toBe('high');
      expect(reread?.batch).toBe(true);
      expect(reread?.cacheWrite5mTokens).toBe(4);
      expect(reread?.cacheWrite1hTokens).toBe(5);
      expect(reread?.priceTableVersion).toBe('p2');
      expect(world.repos.usage.byId(usageId('w9f'))).toBeUndefined();
    });
  });

  it('does not swallow an error that is not a duplicate', () => {
    withRepos((world) => {
      // A usage record for a group that does not exist. `group_id` is a foreign key, so this is a
      // constraint error of a **different** kind — and the duplicate arm must not catch it, or a
      // real integrity failure would be reported to the caller as "already recorded" and the
      // rollup would be the only trace that anything went wrong.
      expect(() =>
        world.store.write((uow) =>
          world.repos.usage.record(uow, {
            id: usageId('y1f'),
            groupId: groupId('y9f'),
            route: 'chat',
            provider: 'anthropic',
            model: 'claude-opus-5-5',
            servedModel: 'claude-opus-5-5',
            purpose: 'chat',
            inputTokens: 1,
            cachedReadTokens: 0,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0,
            outputTokens: 1,
            costMicros: 1,
            priceTableVersion: 'p1',
            at: T0,
            dayLocal: dayOf(0),
          }),
        ),
      ).toThrow();
      expect(world.repos.usage.byId(usageId('y1f'))).toBeUndefined();
    });
  });

  it('separates an instance-level call from a group`s', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        for (const [index, groupId] of [world.groupId, undefined].entries()) {
          world.repos.usage.record(uow, {
            id: usageId(`v${index.toString(16)}f`),
            groupId,
            route: 'chat',
            provider: 'anthropic',
            model: 'claude-haiku-5-5',
            servedModel: 'claude-haiku-5-5',
            purpose: 'boot.healthcheck',
            via: 'job',
            inputTokens: 1,
            cachedReadTokens: 0,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0,
            outputTokens: 1,
            costMicros: index === 0 ? 10 : 20,
            priceTableVersion: 'p1',
            at: T0,
            dayLocal: dayOf(0),
          });
        }
      });
      // `02` §3.3.7 makes `group_id` nullable for instance-level calls and keys the rollup on
      // `'_instance'`. Reading them with `group_id = NULL` would match nothing, so instance spend
      // would be invisible to every report — the mistake the `IS NULL` arm in `records` avoids.
      expect(
        world.repos.usage.spend(world.groupId, { fromDay: dayOf(0), toDay: dayOf(0) }).costMicros,
      ).toBe(10);
      expect(
        world.repos.usage.spend('_instance', { fromDay: dayOf(0), toDay: dayOf(0) }).costMicros,
      ).toBe(20);
      expect(
        world.repos.usage.records({ from: T0, to: T0, limit: 10 }).map((row) => row.costMicros),
      ).toEqual([20]);
      expect(
        world.repos.usage
          .records({ groupId: world.groupId, from: T0, to: T0, limit: 10 })
          .map((row) => row.costMicros),
      ).toEqual([10]);
    });
  });
});
