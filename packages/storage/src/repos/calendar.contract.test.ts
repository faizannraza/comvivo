/**
 * `CalendarReader`/`CalendarRepository`, and the Q-CTX-6 query plans (`M1-T19`).
 *
 * The behaviour worth most of this file is the **one-off / series split**. `02` §3.3.10 separates
 * Q-CTX-6 from Q-CTX-6b because a recurring event is one row whose `start_at` is its *first*
 * occurrence — so a range scan finds the one-offs and misses the weekly dinner that started last
 * year, which is most of a real calendar. A reader that conflated them would return a plausible,
 * badly incomplete answer.
 */
import { expectWritten } from '@comvivo/core';
import { UTC } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  eligibleAll,
  eligibleNone,
  eventId,
  groupLabel,
  member,
  memberId,
  person,
  subscriptionId,
  T0,
  withRepos,
} from './testing/harness.js';
import { analyze, expectIndexUsed, expectNoFullScan } from './testing/query-plan.js';

const DAY = 86_400_000;

function at(offsetDays: number): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + offsetDays * DAY);
}

/** A one-off event. `startLocal` and `startAt` are the same moment, as `02` D3 requires. */
function oneOff(
  tag: string,
  groupId: Parameters<typeof member>[1],
  offsetDays: number,
  overrides: Record<string, unknown> = {},
) {
  const startAt = at(offsetDays);
  return {
    id: eventId(tag),
    groupId,
    title: `event ${tag}`,
    tz: UTC,
    startLocal: startAt.toZonedDateTimeISO('UTC').toPlainDateTime().toString(),
    startAt,
    busy: true,
    source: { kind: 'native' as const },
    icsUid: `${tag}@test`,
    tzdataVersion: '2026b',
    ...overrides,
  };
}

describe('CalendarRepository', () => {
  it('creates an event that is its own series', () => {
    withRepos((world) => {
      const event = world.store.write((uow) =>
        expectWritten(
          world.repos.calendar.create(
            uow,
            oneOff('a1f', world.groupId, 1),
            groupLabel(world.groupId),
          ),
          'an event',
        ),
      );
      // An unsplit event **is** its own series, so a caller never supplies `seriesId` — and this
      // is what makes `bySeries` work from either end of a later split.
      expect(event.seriesId).toBe(event.id);
      expect(event.splitFromEventId).toBeUndefined();
      expect(event.status).toBe('confirmed');
      expect(event.attendeesMode).toBe('none');
      expect(event.rruleInvalid).toBe(false);
    });
  });

  describe('the one-off / series split (Q-CTX-6, Q-CTX-6b)', () => {
    it('finds one-off events in a window and excludes the series', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        world.store.write((uow) => {
          expectWritten(
            world.repos.calendar.create(uow, oneOff('b1f', world.groupId, 1), label),
            'soon',
          );
          expectWritten(
            world.repos.calendar.create(uow, oneOff('b2f', world.groupId, 40), label),
            'later',
          );
          expectWritten(
            world.repos.calendar.create(
              uow,
              oneOff('b3f', world.groupId, -400, { rrule: 'FREQ=WEEKLY' }),
              label,
            ),
            'a weekly series that started long ago',
          );
        });
        const eligible = eligibleAll(world);
        const window = world.repos.calendar.upcomingOneOff({
          groupId: world.groupId,
          from: at(0),
          to: at(7),
          limit: 50,
          eligible,
        });
        // Only the one in the window. The series is excluded because its `start_at` is 400 days
        // ago — which is exactly why it needs its own query rather than a wider range.
        expect(window.map((event) => event.id)).toEqual([eventId('b1f')]);
      });
    });

    it('finds a series whose recurrence is still live, however old its start is', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        world.store.write((uow) => {
          expectWritten(
            world.repos.calendar.create(
              uow,
              oneOff('c1f', world.groupId, -400, { rrule: 'FREQ=WEEKLY' }),
              label,
            ),
            'open-ended',
          );
          expectWritten(
            world.repos.calendar.create(
              uow,
              oneOff('c2f', world.groupId, -400, {
                rrule: 'FREQ=WEEKLY',
                recurrenceUntilAt: at(-200),
              }),
              label,
            ),
            'finished',
          );
          expectWritten(
            world.repos.calendar.create(
              uow,
              oneOff('c3f', world.groupId, -400, {
                rrule: 'FREQ=WEEKLY',
                recurrenceUntilAt: at(200),
              }),
              label,
            ),
            'still running',
          );
          expectWritten(
            world.repos.calendar.create(uow, oneOff('c4f', world.groupId, 1), label),
            'one-off',
          );
        });
        const live = world.repos.calendar.activeSeries({
          groupId: world.groupId,
          at: at(0),
          limit: 50,
          eligible: eligibleAll(world),
        });
        // The open-ended one **and** the one that has not finished. The `IS NULL` arm is the case
        // a plain `recurrence_until_at >= :at` would drop, and an open-ended weekly event is the
        // common case — so that version would hide most of a group's recurring calendar.
        // Sorted here because `activeSeries` returns rows **unordered** on purpose — see its
        // docstring: an `ORDER BY start_at` would cost the partial index, and ordering series by
        // their first occurrence is meaningless anyway.
        expect(live.map((event) => event.id).toSorted()).toEqual(
          [eventId('c1f'), eventId('c3f')].toSorted(),
        );
      });
    });

    it('excludes cancelled events from both', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const event = world.store.write((uow) =>
          expectWritten(
            world.repos.calendar.create(uow, oneOff('d1f', world.groupId, 1), label),
            'an event',
          ),
        );
        world.store.write((uow) =>
          world.repos.calendar.setStatus(uow, world.groupId, event.id, event.version, 'cancelled'),
        );
        expect(
          world.repos.calendar.upcomingOneOff({
            groupId: world.groupId,
            from: at(0),
            to: at(7),
            limit: 50,
            eligible: eligibleAll(world),
          }),
        ).toEqual([]);
      });
    });
  });

  describe('splitting an occurrence', () => {
    it('keeps the series and records where the split came from', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const series = world.store.write((uow) =>
          expectWritten(
            world.repos.calendar.create(
              uow,
              oneOff('e1f', world.groupId, -7, { rrule: 'FREQ=WEEKLY' }),
              label,
            ),
            'a series',
          ),
        );
        const moved = world.store.write((uow) =>
          expectWritten(
            world.repos.calendar.splitOccurrence(
              uow,
              world.groupId,
              series.id,
              series.version,
              oneOff('e2f', world.groupId, 2, { title: 'dinner, moved' }),
              label,
            ),
            'a split occurrence',
          ),
        );
        expect(moved.seriesId).toBe(series.id);
        expect(moved.splitFromEventId).toBe(series.id);
        expect(moved.rrule).toBeUndefined();

        const eligible = eligibleAll(world);
        // Both ends of the chain: `bySeries` finds the series row and the split.
        expect(
          world.repos.calendar
            .bySeries(world.groupId, series.id, eligible)
            .map((event) => event.id)
            .toSorted(),
        ).toEqual([series.id, moved.id].toSorted());
        // And the series itself is untouched, so next week still recurs.
        expect(world.repos.calendar.byId(world.groupId, series.id, eligible)?.rrule).toBe(
          'FREQ=WEEKLY',
        );
      });
    });

    it('refuses a stale version without creating the occurrence', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const series = world.store.write((uow) =>
          expectWritten(
            world.repos.calendar.create(
              uow,
              oneOff('f1f', world.groupId, -7, { rrule: 'FREQ=WEEKLY' }),
              label,
            ),
            'a series',
          ),
        );
        world.store.write((uow) =>
          world.repos.calendar.setStatus(
            uow,
            world.groupId,
            series.id,
            series.version,
            'tentative',
          ),
        );
        const refused = world.store.write((uow) =>
          world.repos.calendar.splitOccurrence(
            uow,
            world.groupId,
            series.id,
            series.version,
            oneOff('f2f', world.groupId, 2),
            label,
          ),
        );
        expect(refused.kind).toBe('conflict');
        // Checked before the occurrence is written, so a conflict leaves no orphan event claiming
        // to belong to a series it never joined.
        expect(
          world.repos.calendar.byId(world.groupId, eventId('f2f'), eligibleAll(world)),
        ).toBeUndefined();
      });
    });
  });

  describe('the subscription feed (Q-COO-6)', () => {
    it('finds a feed row by uid, and keeps the recurrence variants apart', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const subscription = subscriptionId('sbx1');
        world.store.write((uow) => {
          expectWritten(
            world.repos.calendar.create(
              uow,
              oneOff('g1f', world.groupId, 1, {
                subscriptionId: subscription,
                sourceUid: 'uid-1',
                source: {
                  kind: 'subscription' as const,
                  subscriptionId: subscription,
                  uid: 'uid-1',
                  recurrenceId: null,
                  sequence: 0,
                },
              }),
              label,
            ),
            'the base event',
          );
          expectWritten(
            world.repos.calendar.create(
              uow,
              oneOff('g2f', world.groupId, 2, {
                subscriptionId: subscription,
                sourceUid: 'uid-1',
                sourceRecurrenceId: '20261110T180000Z',
                source: {
                  kind: 'subscription' as const,
                  subscriptionId: subscription,
                  uid: 'uid-1',
                  recurrenceId: null,
                  sequence: 0,
                },
              }),
              label,
            ),
            'an overridden occurrence',
          );
        });
        // The two disjoint partial unique indexes: a feed event is identified by its uid, plus its
        // recurrence id when it has one. Without the split, `NULL IS NOT NULL` in a unique index
        // would let two base events with the same uid both exist and the diff would duplicate them
        // on every refresh.
        expect(
          world.repos.calendar.bySourceUid({ subscriptionId: subscription, sourceUid: 'uid-1' })
            ?.id,
        ).toBe(eventId('g1f'));
        expect(
          world.repos.calendar.bySourceUid({
            subscriptionId: subscription,
            sourceUid: 'uid-1',
            sourceRecurrenceId: '20261110T180000Z',
          })?.id,
        ).toBe(eventId('g2f'));
      });
    });

    it('reports a re-imported feed event as a duplicate, naming the stored one', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const subscription = subscriptionId('sbx1');
        const first = world.store.write((uow) =>
          expectWritten(
            world.repos.calendar.create(
              uow,
              oneOff('h1f', world.groupId, 1, {
                subscriptionId: subscription,
                sourceUid: 'uid-1',
                source: {
                  kind: 'subscription' as const,
                  subscriptionId: subscription,
                  uid: 'uid-1',
                  recurrenceId: null,
                  sequence: 0,
                },
              }),
              label,
            ),
            'the first import',
          ),
        );
        const again = world.store.write((uow) =>
          world.repos.calendar.create(
            uow,
            oneOff('h2f', world.groupId, 1, {
              subscriptionId: subscription,
              sourceUid: 'uid-1',
              source: {
                kind: 'subscription' as const,
                subscriptionId: subscription,
                uid: 'uid-1',
                recurrenceId: null,
                sequence: 0,
              },
            }),
            label,
          ),
        );
        expect(again.kind).toBe('duplicate');
        if (again.kind !== 'duplicate') return;
        // The stored row, so the refresher can diff against it rather than insert a copy — which
        // is the routine case on every feed refresh.
        expect(again.existingId).toBe(first.id);
      });
    });
  });

  it('records an RSVP and replaces it when the member changes their mind', () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      const { event, who } = world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        const added = expectWritten(
          world.repos.members.add(uow, member('a', world.groupId)),
          'member',
        );
        return {
          event: expectWritten(
            world.repos.calendar.create(
              uow,
              oneOff('x1f', world.groupId, 1, { attendeesMode: 'rsvp' }),
              label,
            ),
            'an event',
          ),
          who: added.id,
        };
      });
      world.store.write((uow) =>
        world.repos.calendar.setRsvp(uow, world.groupId, event.id, who, 'accepted', T0),
      );
      world.store.write((uow) =>
        world.repos.calendar.setRsvp(uow, world.groupId, event.id, who, 'declined', T0),
      );
      const attendees = world.repos.calendar.attendeesOf(world.groupId, event.id);
      // One row, upserted: the key is `(event, member)`, so changing an answer replaces it rather
      // than adding a second RSVP that would double-count.
      expect(attendees).toHaveLength(1);
      expect(attendees[0]?.response).toBe('declined');
    });
  });

  it('refuses an RSVP to another group`s event', () => {
    withRepos((world) => {
      const elsewhere = world.store.write((uow) =>
        expectWritten(
          world.repos.calendar.create(
            uow,
            oneOff('y1f', world.otherGroupId, 1),
            groupLabel(world.otherGroupId),
          ),
          'an event elsewhere',
        ),
      );
      // `event_attendees` has **no `group_id`** — its isolation comes from the foreign key — so
      // without the scope check a caller could RSVP to another group's event through its id alone.
      const refused = world.store.write((uow) =>
        world.repos.calendar.setRsvp(
          uow,
          world.groupId,
          elsewhere.id,
          memberId('a'),
          'accepted',
          T0,
        ),
      );
      expect(refused.kind).toBe('not_found');
      expect(world.repos.calendar.attendeesOf(world.groupId, elsewhere.id)).toEqual([]);
    });
  });

  it('records an unparseable rrule without a version, so the finding can always land', () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      const event = world.store.write((uow) =>
        expectWritten(
          world.repos.calendar.create(
            uow,
            oneOff('z1f', world.groupId, 1, { rrule: 'FREQ=NONSENSE' }),
            label,
          ),
          'an event',
        ),
      );
      // Unversioned on purpose: `07` meets the bad rule while expanding, and versioning the
      // recording would make it conflict with whatever edit produced the bad rule — so the one
      // write that explains the problem would be the one that cannot land.
      const marked = world.store.write((uow) =>
        expectWritten(
          world.repos.calendar.markRruleInvalid(uow, world.groupId, event.id),
          'the finding',
        ),
      );
      expect(marked.rruleInvalid).toBe(true);
      expect(marked.version).toBe(event.version);
    });
  });

  describe('group isolation (I4)', () => {
    it('does not find an event from another group', () => {
      withRepos((world) => {
        const elsewhere = world.store.write((uow) =>
          expectWritten(
            world.repos.calendar.create(
              uow,
              oneOff('w1f', world.otherGroupId, 1),
              groupLabel(world.otherGroupId),
            ),
            'an event elsewhere',
          ),
        );
        // A label in **this** group, so the eligible set below is non-empty: `02` §3.7.1's labeled
        // reads return early on an empty set, and an empty one would satisfy these three
        // assertions without the `group_id` predicate they are about ever running. The other
        // group's label cannot be in a set for this group — `computeEligible` refuses it, which is
        // the containment the forged helper this replaced could not express.
        world.store.write((uow) => world.repos.labels.intern(uow, groupLabel(world.groupId)));
        const eligible = eligibleAll(world);
        expect(world.repos.calendar.byId(world.groupId, elsewhere.id, eligible)).toBeUndefined();
        expect(world.repos.calendar.bySeries(world.groupId, elsewhere.seriesId, eligible)).toEqual(
          [],
        );
        expect(world.repos.calendar.attendeesOf(world.groupId, elsewhere.id)).toEqual([]);
      });
    });

    it('refuses a label from another group', () => {
      withRepos((world) => {
        expect(() =>
          world.store.write((uow) =>
            world.repos.calendar.create(
              uow,
              oneOff('v1f', world.groupId, 1),
              groupLabel(world.otherGroupId),
            ),
          ),
        ).toThrow(/another group/);
      });
    });
  });

  describe('refusals', () => {
    it('reports a missing event as not_found from every write', () => {
      withRepos((world) => {
        const absent = eventId('nxf');
        expect(
          world.store.write((uow) =>
            world.repos.calendar.setStatus(uow, world.groupId, absent, 1, 'cancelled'),
          ).kind,
        ).toBe('not_found');
        expect(
          world.store.write((uow) =>
            world.repos.calendar.markRruleInvalid(uow, world.groupId, absent),
          ).kind,
        ).toBe('not_found');
        expect(
          world.store.write((uow) =>
            world.repos.calendar.splitOccurrence(
              uow,
              world.groupId,
              absent,
              1,
              oneOff('nyf', world.groupId, 1),
              groupLabel(world.groupId),
            ),
          ).kind,
        ).toBe('not_found');
      });
    });

    it('tells a stale version apart from a missing row', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const event = world.store.write((uow) =>
          expectWritten(
            world.repos.calendar.create(uow, oneOff('m1f', world.groupId, 1), label),
            'an event',
          ),
        );
        world.store.write((uow) =>
          world.repos.calendar.setStatus(uow, world.groupId, event.id, event.version, 'tentative'),
        );
        // The distinction matters: a caller that gets `conflict` re-reads and decides again, and
        // against a row that does not exist that is an infinite loop.
        expect(
          world.store.write((uow) =>
            world.repos.calendar.setStatus(
              uow,
              world.groupId,
              event.id,
              event.version,
              'cancelled',
            ),
          ).kind,
        ).toBe('conflict');
        expect(world.repos.calendar.byId(world.groupId, event.id, eligibleAll(world))?.status).toBe(
          'tentative',
        );
      });
    });

    it('returns nothing from every labeled read for an empty eligible set', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const event = world.store.write((uow) =>
          expectWritten(
            world.repos.calendar.create(uow, oneOff('k1f', world.groupId, 1), label),
            'an event',
          ),
        );
        const none = eligibleNone(world);
        expect(world.repos.calendar.byId(world.groupId, event.id, none)).toBeUndefined();
        expect(
          world.repos.calendar.upcomingOneOff({
            groupId: world.groupId,
            from: at(0),
            to: at(7),
            limit: 10,
            eligible: none,
          }),
        ).toEqual([]);
        expect(
          world.repos.calendar.activeSeries({
            groupId: world.groupId,
            at: at(0),
            limit: 10,
            eligible: none,
          }),
        ).toEqual([]);
        expect(world.repos.calendar.bySeries(world.groupId, event.seriesId, none)).toEqual([]);
        // The row is there, so none of the above is vacuous.
        expect(
          world.repos.calendar.byId(world.groupId, event.id, eligibleAll(world)),
        ).toBeDefined();
      });
    });
  });

  it('stores every optional field it was given', () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      const event = world.store.write((uow) =>
        expectWritten(
          world.repos.calendar.create(
            uow,
            oneOff('j1f', world.groupId, 1, {
              notes: 'bring the cake',
              url: 'https://example.invalid/e',
              location: { text: 'the kitchen' },
              allDay: true,
              endLocal: '2026-11-09T20:00',
              endAt: at(2),
              rrule: 'FREQ=WEEKLY',
              rdates: ['20261117T180000Z'],
              exdates: ['20261124T180000Z'],
              recurrenceUntilAt: at(90),
              status: 'tentative',
              attendeesMode: 'rsvp',
              leadTimes: ['PT1H'],
            }),
            label,
          ),
          'a fully specified event',
        ),
      );
      expect(event.notes).toBe('bring the cake');
      expect(event.url).toBe('https://example.invalid/e');
      expect(event.location?.text).toBe('the kitchen');
      expect(event.allDay).toBe(true);
      expect(event.endAt?.epochMilliseconds).toBe(at(2).epochMilliseconds);
      expect(event.rdates).toEqual(['20261117T180000Z']);
      expect(event.exdates).toEqual(['20261124T180000Z']);
      expect(event.status).toBe('tentative');
      expect(event.attendeesMode).toBe('rsvp');
      // `lead_times` is `jsonOf(… .nullable())`, so the column can hold a JSON `null` as a value —
      // which the mapper normalises to `undefined` like every other absence.
      expect(event.leadTimes).toEqual(['PT1H']);
      const bare = world.store.write((uow) =>
        expectWritten(
          world.repos.calendar.create(uow, oneOff('j2f', world.groupId, 1), label),
          'a bare event',
        ),
      );
      expect(bare.leadTimes).toBeUndefined();
      expect(bare.rdates).toEqual([]);
    });
  });

  describe('query plans (M1-T19 AC)', { tags: ['db'] }, () => {
    it('reaches Q-CTX-6 through events_group_start_idx, with no scan and no temp sort', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        // Enough rows that the planner prefers the index. On a 3-row table it correctly prefers a
        // scan, so a small fixture would fail on correct code — see `query-plan.ts`.
        world.store.write((uow) => {
          for (let index = 0; index < 400; index += 1) {
            world.repos.calendar.create(
              uow,
              oneOff(`p${index.toString(16)}f`, world.groupId, index % 90),
              label,
            );
          }
        });
        analyze(world.db);

        expectIndexUsed(
          world.db,
          `SELECT * FROM events
            WHERE group_id = ? AND start_at >= ? AND start_at <= ? AND rrule IS NULL
              AND status <> 'cancelled' AND label_id IN (?)
            ORDER BY start_at ASC, rid ASC LIMIT 50`,
          {
            table: 'events',
            index: 'events_group_start_idx',
            parameters: [world.groupId, 0, DAY * 7, 1],
          },
        );
      });
    });

    it('reaches Q-CTX-6b through the partial recurring index', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        world.store.write((uow) => {
          for (let index = 0; index < 400; index += 1) {
            world.repos.calendar.create(
              uow,
              oneOff(`q${index.toString(16)}f`, world.groupId, index % 90, {
                // Half recurring, so the partial index covers a meaningful subset — and of those,
                // a **mix** of open-ended and dated recurrence ends.
                //
                // The mix is what makes this test meaningful rather than lucky. A first version
                // left every `recurrence_until_at` NULL, and SQLite then chose
                // `events_group_start_idx` instead — correctly, because with the column uniformly
                // NULL the `IS NULL` arm matches everything and the `group_id` prefix of either
                // index is equally good. The plan a query gets depends on the **statistics**, so a
                // fixture with a degenerate distribution tests a database no host will have.
                ...(index % 2 === 0 ? { rrule: 'FREQ=WEEKLY' } : {}),
                ...(index % 3 === 0 ? {} : { recurrenceUntilAt: at(index % 180) }),
              }),
              label,
            );
          }
        });
        analyze(world.db);

        // A **partial** index on `rrule IS NOT NULL`, so the predicate has to be in the query for
        // SQLite to use it — easy to lose in a refactor and invisible afterwards, because the
        // results stay correct.
        //
        // **No `ORDER BY`**, and that is the other half. Measured: adding `ORDER BY start_at`
        // makes SQLite pick `events_group_start_idx`, which satisfies the group filter and the
        // sort together. So this assertion is what stops a later "tidy-up" from quietly
        // un-indexing Q-CTX-6b.
        expectIndexUsed(
          world.db,
          `SELECT * FROM events
            WHERE group_id = ? AND rrule IS NOT NULL
              AND (recurrence_until_at IS NULL OR recurrence_until_at >= ?)
              AND status <> 'cancelled' AND label_id IN (?)
            LIMIT 50`,
          {
            table: 'events',
            index: 'events_group_recurring_idx',
            parameters: [world.groupId, 0, 1],
          },
        );
      });
    });

    it('reaches the series and the feed lookups through their own indexes', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        world.store.write((uow) => {
          for (let index = 0; index < 400; index += 1) {
            world.repos.calendar.create(
              uow,
              oneOff(`r${index.toString(16)}f`, world.groupId, index % 90),
              label,
            );
          }
        });
        analyze(world.db);

        expectIndexUsed(
          world.db,
          'SELECT * FROM events WHERE group_id = ? AND series_id = ? AND label_id IN (?)',
          {
            table: 'events',
            index: 'events_series_idx',
            parameters: [world.groupId, eventId('r1f'), 1],
          },
        );
        expectNoFullScan(
          world.db,
          `SELECT * FROM events
            WHERE subscription_id = ? AND source_uid = ? AND source_recurrence_id IS NULL`,
          ['events'],
          [subscriptionId('sbx1'), 'uid-1'],
        );
      });
    });
  });
});
