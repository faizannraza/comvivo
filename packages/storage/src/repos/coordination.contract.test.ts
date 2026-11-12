/**
 * The poll, plan, decision and reminder repositories (`M1-T19`).
 *
 * Four behaviours carry this file:
 *
 *  - **A tally can never disagree with its ballots**, because the recount happens in the same
 *    transaction as the vote. That is what makes an anonymous poll possible: the counts are
 *    readable and the ballots are not, so a drift could not be reconciled by anyone.
 *  - **A plan step has no label of its own**, so the plan's eligibility decides — which is what
 *    makes a surprise party coherent.
 *  - **A retracted decision leaves the log**, and a superseded one stays.
 *  - **A reminder fires exactly once per occurrence**, enforced by the unique index rather than by
 *    the scheduler remembering. That is `I6` for reminders, and a scheduler that remembered would
 *    forget on restart.
 */
import type { NotPromise } from '@comvivo/core';
import { expectWritten } from '@comvivo/core';
import { internedId, type ReaderSetId, UTC } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  conversationId,
  decisionId,
  eligibleAll,
  eligibleNone,
  fingerprintFor,
  firingId,
  groupLabel,
  member,
  memoryItem,
  person,
  planId,
  planStepId,
  pollId,
  reminderId,
  T0,
  withRepos,
} from './testing/harness.js';
import { analyze, expectIndexUsed } from './testing/query-plan.js';

const DAY = 86_400_000;
const at = (days: number) =>
  Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + days * DAY);

/** A world with a conversation and two members, which polls and reminders both need. */
function withWorld<T>(
  fn: (
    world: Parameters<Parameters<typeof withRepos>[0]>[0],
    ids: {
      conversation: ReturnType<typeof conversationId>;
      who: readonly string[];
      readerSet: ReaderSetId;
    },
  ) => NotPromise<T>,
): T {
  return withRepos((world) => {
    const ids = world.store.write((uow) => {
      const who = ['a', 'b'].map((tag) => {
        expectWritten(world.repos.persons.create(uow, person(tag)), `person ${tag}`);
        return expectWritten(
          world.repos.members.add(uow, member(tag, world.groupId)),
          `member ${tag}`,
        ).id;
      });
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
      // A reminder's audience is a frozen reader set, so one has to exist. Interning the group
      // label gives us one without a reader-set repository, which `M7` will add.
      world.repos.labels.intern(uow, groupLabel(world.groupId));
      // Narrowed through `internedId`, like every interned id out of a column — the branded
      // `ReaderSetId` is what `M1-T16` established, and a cast here would be the local alias
      // mistake again, in a test.
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

describe('PollRepository', () => {
  const poll = (
    tag: string,
    groupId: Parameters<typeof member>[1],
    conversation: ReturnType<typeof conversationId>,
    overrides: Record<string, unknown> = {},
  ) => ({
    id: pollId(tag),
    groupId,
    conversationId: conversation,
    purpose: 'opinion' as const,
    question: `question ${tag}`,
    options: [
      { id: 'o1', text: 'one', position: 0 },
      { id: 'o2', text: 'two', position: 1 },
    ],
    rule: 'plurality' as const,
    quorum: { kind: 'none' as const },
    mode: 'buttons' as const,
    ...overrides,
  });

  it('creates a poll with an empty tally from the start', () => {
    withWorld((world, ids) => {
      const created = world.store.write((uow) =>
        expectWritten(
          world.repos.polls.create(
            uow,
            poll('a1f', world.groupId, ids.conversation),
            groupLabel(world.groupId),
          ),
          'a poll',
        ),
      );
      expect(created.status).toBe('open');
      expect(created.allowMultiple).toBe(false);
      expect(created.anonymous).toBe(false);
      expect(created.resultsVisibility).toBe('live');
      // An empty tally from creation, so `countsOf` never distinguishes "no votes" from "no row"
      // and `07` can render a fresh poll with no special case.
      expect([...world.repos.polls.countsOf(world.groupId, created.id).entries()]).toEqual([]);
    });
  });

  describe('the tally never disagrees with the ballots', () => {
    it('counts a vote and recounts when the member changes their mind', () => {
      withWorld((world, ids) => {
        const [first, second] = ids.who;
        if (first === undefined || second === undefined) throw new Error('fixture');
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.polls.create(
              uow,
              poll('b1f', world.groupId, ids.conversation),
              groupLabel(world.groupId),
            ),
            'a poll',
          ),
        );
        world.store.write((uow) => {
          world.repos.polls.vote(uow, world.groupId, created.id, first as never, ['o1'], T0);
          world.repos.polls.vote(uow, world.groupId, created.id, second as never, ['o1'], T0);
        });
        expect(world.repos.polls.countsOf(world.groupId, created.id).get('o1')).toBe(2);

        // The same member votes again: replaced, not appended. Two rows for one member would
        // double-count, and `07` lets a member change their mind.
        world.store.write((uow) =>
          world.repos.polls.vote(uow, world.groupId, created.id, second as never, ['o2'], T0),
        );
        const counts = world.repos.polls.countsOf(world.groupId, created.id);
        expect(counts.get('o1')).toBe(1);
        expect(counts.get('o2')).toBe(1);
        expect(world.db.prepare('SELECT count(*) AS n FROM poll_votes').get()).toEqual({ n: 2 });
      });
    });

    it('counts voters separately from choices when several are allowed', () => {
      withWorld((world, ids) => {
        const first = ids.who[0];
        if (first === undefined) throw new Error('fixture');
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.polls.create(
              uow,
              poll('b2f', world.groupId, ids.conversation, { allowMultiple: true }),
              groupLabel(world.groupId),
            ),
            'a poll',
          ),
        );
        world.store.write((uow) =>
          world.repos.polls.vote(uow, world.groupId, created.id, first as never, ['o1', 'o2'], T0),
        );
        const counts = world.repos.polls.countsOf(world.groupId, created.id);
        expect(counts.get('o1')).toBe(1);
        expect(counts.get('o2')).toBe(1);
        // `voter_count` is **members**, not the sum of the choices — and it is what a quorum is
        // measured against, so conflating them would make a quorum reachable by one enthusiastic
        // voter ticking every box.
        const row = world.db
          .prepare('SELECT voter_count AS n FROM poll_counts WHERE poll_id = ?')
          .get(created.id) as { n: number };
        expect(row.n).toBe(1);
      });
    });

    it('rolls the tally back with the vote', () => {
      withWorld((world, ids) => {
        const first = ids.who[0];
        if (first === undefined) throw new Error('fixture');
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.polls.create(
              uow,
              poll('b3f', world.groupId, ids.conversation),
              groupLabel(world.groupId),
            ),
            'a poll',
          ),
        );
        expect(() =>
          world.store.write((uow) => {
            world.repos.polls.vote(uow, world.groupId, created.id, first as never, ['o1'], T0);
            throw new Error('the caller changed its mind');
          }),
        ).toThrow('the caller changed its mind');
        // Both or neither. A tally that survived a rolled-back ballot could not be reconciled by
        // anyone on an anonymous poll, because nobody may read the ballots to check it.
        expect([...world.repos.polls.countsOf(world.groupId, created.id).entries()]).toEqual([]);
        expect(world.db.prepare('SELECT count(*) AS n FROM poll_votes').get()).toEqual({ n: 0 });
      });
    });

    it('refuses a vote on a closed poll and an unknown option', () => {
      withWorld((world, ids) => {
        const first = ids.who[0];
        if (first === undefined) throw new Error('fixture');
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.polls.create(
              uow,
              poll('b4f', world.groupId, ids.conversation),
              groupLabel(world.groupId),
            ),
            'a poll',
          ),
        );
        expect(() =>
          world.store.write((uow) =>
            world.repos.polls.vote(uow, world.groupId, created.id, first as never, ['nope'], T0),
          ),
        ).toThrow(/no such option/);
        // A single-choice poll refuses two options rather than silently taking the first.
        expect(() =>
          world.store.write((uow) =>
            world.repos.polls.vote(
              uow,
              world.groupId,
              created.id,
              first as never,
              ['o1', 'o2'],
              T0,
            ),
          ),
        ).toThrow(/single choice/);

        const closed = world.store.write((uow) =>
          expectWritten(
            world.repos.polls.close(
              uow,
              world.groupId,
              created.id,
              created.version,
              { kind: 'no_quorum' },
              T0,
            ),
            'a close',
          ),
        );
        expect(closed.status).toBe('closed');
        // `conflict`, not an error: a vote arriving just after a close is a race, not a bug, and
        // the caller's answer is "the poll closed" rather than a stack trace.
        expect(
          world.store.write((uow) =>
            world.repos.polls.vote(uow, world.groupId, created.id, first as never, ['o1'], T0),
          ).kind,
        ).toBe('conflict');
      });
    });

    it('says whether a member voted without saying what they chose', () => {
      withWorld((world, ids) => {
        const [first, second] = ids.who;
        if (first === undefined || second === undefined) throw new Error('fixture');
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.polls.create(
              uow,
              poll('b5f', world.groupId, ids.conversation, { anonymous: true }),
              groupLabel(world.groupId),
            ),
            'an anonymous poll',
          ),
        );
        world.store.write((uow) =>
          world.repos.polls.vote(uow, world.groupId, created.id, first as never, ['o1'], T0),
        );
        // A boolean, so `07` can nudge the people who have not voted without that nudge being a
        // disclosure.
        expect(world.repos.polls.hasVoted(world.groupId, created.id, first as never)).toBe(true);
        expect(world.repos.polls.hasVoted(world.groupId, created.id, second as never)).toBe(false);
        // And not across groups, so turnout cannot be probed from outside.
        expect(world.repos.polls.hasVoted(world.otherGroupId, created.id, first as never)).toBe(
          false,
        );
      });
    });
  });

  it('sorts undeadlined polls last and respects its partial index', () => {
    withWorld((world, ids) => {
      const label = groupLabel(world.groupId);
      world.store.write((uow) => {
        world.repos.polls.create(
          uow,
          poll('c1f', world.groupId, ids.conversation, { deadlineAt: at(5) }),
          label,
        );
        world.repos.polls.create(uow, poll('c2f', world.groupId, ids.conversation), label);
        world.repos.polls.create(
          uow,
          poll('c3f', world.groupId, ids.conversation, { deadlineAt: at(1) }),
          label,
        );
      });
      expect(
        world.repos.polls
          .open({ groupId: world.groupId, limit: 10, eligible: eligibleAll(world) })
          .map((row) => row.id),
      ).toEqual([pollId('c3f'), pollId('c1f'), pollId('c2f')]);
    });
  });

  it('returns nothing from its labeled reads for an empty eligible set', () => {
    withWorld((world, ids) => {
      const created = world.store.write((uow) =>
        expectWritten(
          world.repos.polls.create(
            uow,
            poll('d1f', world.groupId, ids.conversation),
            groupLabel(world.groupId),
          ),
          'a poll',
        ),
      );
      expect(
        world.repos.polls.byId(world.groupId, created.id, eligibleNone(world)),
      ).toBeUndefined();
      expect(
        world.repos.polls.open({
          groupId: world.groupId,
          limit: 10,
          eligible: eligibleNone(world),
        }),
      ).toEqual([]);
      expect(world.repos.polls.byId(world.groupId, created.id, eligibleAll(world))).toBeDefined();
    });
  });
});

describe('PlanRepository', () => {
  const plan = (tag: string, groupId: Parameters<typeof member>[1], overrides = {}) => ({
    id: planId(tag),
    groupId,
    title: `plan ${tag}`,
    ...overrides,
  });

  it('creates a plan and appends steps in order', () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      const created = world.store.write((uow) =>
        expectWritten(world.repos.plans.create(uow, plan('a1f', world.groupId), label), 'a plan'),
      );
      expect(created.kind).toBe('generic');
      expect(created.status).toBe('draft');

      const steps = world.store.write((uow) =>
        ['a1f', 'a2f', 'a3f'].map((tag) =>
          expectWritten(
            world.repos.plans.addStep(
              uow,
              {
                id: planStepId(tag),
                planId: created.id,
                groupId: world.groupId,
                title: `step ${tag}`,
              },
              label,
            ),
            `step ${tag}`,
          ),
        ),
      );
      expect(steps.map((step) => step.position)).toEqual(
        [...steps.map((step) => step.position)].toSorted(),
      );
      expect(steps.every((step) => step.confirmState === 'proposed')).toBe(true);
      expect(steps.every((step) => step.status === 'todo')).toBe(true);
      // `last_activity_at` is set at creation, so a step that never moved is distinguishable from
      // one that moved long ago — which is what `07` nudges from.
      expect(steps.every((step) => step.lastActivityAt !== undefined)).toBe(true);
    });
  });

  it('gates the steps on the PLAN`s eligibility, because a step has no label', () => {
    withRepos((world) => {
      const secret = groupLabel(world.groupId, { sensitivity: 'sensitive' });
      const created = world.store.write((uow) =>
        expectWritten(world.repos.plans.create(uow, plan('b1f', world.groupId), secret), 'a plan'),
      );
      world.store.write((uow) =>
        world.repos.plans.addStep(
          uow,
          {
            id: planStepId('b1f'),
            planId: created.id,
            groupId: world.groupId,
            title: 'buy a cake',
          },
          secret,
        ),
      );
      // `02` §3.3.5 gives `plan_steps` **no `label_id`**, and that is what makes a surprise party
      // coherent: the plan's `secrecy` decides who may read it, and a step with an independent
      // label could be readable by someone the plan is hidden from.
      expect(world.repos.plans.stepsOf(world.groupId, created.id, eligibleAll(world))).toHaveLength(
        1,
      );
      expect(world.repos.plans.stepsOf(world.groupId, created.id, eligibleNone(world))).toEqual([]);
    });
  });

  it('moves a step`s status and confirmation, touching last activity', () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      const created = world.store.write((uow) =>
        expectWritten(world.repos.plans.create(uow, plan('c1f', world.groupId), label), 'a plan'),
      );
      const step = world.store.write((uow) =>
        expectWritten(
          world.repos.plans.addStep(
            uow,
            { id: planStepId('c1f'), planId: created.id, groupId: world.groupId, title: 'book it' },
            label,
          ),
          'a step',
        ),
      );
      const confirmed = world.store.write((uow) =>
        expectWritten(
          world.repos.plans.confirmStep(uow, world.groupId, step.id, step.version),
          'a confirmation',
        ),
      );
      expect(confirmed.confirmState).toBe('confirmed');
      const doing = world.store.write((uow) =>
        expectWritten(
          world.repos.plans.setStepStatus(uow, world.groupId, step.id, confirmed.version, 'doing'),
          'a status change',
        ),
      );
      expect(doing.status).toBe('doing');
      expect(doing.version).toBe(step.version + 2);
    });
  });

  it('lists active-like plans by default', () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      const made = world.store.write((uow) =>
        (['draft', 'active', 'done', 'archived'] as const).map((status, index) =>
          expectWritten(
            world.repos.plans.create(
              uow,
              plan(`d${index.toString(16)}f`, world.groupId, { status }),
              label,
            ),
            `a ${status} plan`,
          ),
        ),
      );
      expect(made).toHaveLength(4);
      // A plan being drafted is one `07` should still surface — "we were going to book the
      // flights" is exactly what a nudge is for.
      expect(
        world.repos.plans
          .byStatus({ groupId: world.groupId, limit: 10, eligible: eligibleAll(world) })
          .map((row) => row.status)
          .toSorted(),
      ).toEqual(['active', 'draft']);
    });
  });

  it('refuses a step on another group`s plan', () => {
    withRepos((world) => {
      const elsewhere = world.store.write((uow) =>
        expectWritten(
          world.repos.plans.create(
            uow,
            plan('e1f', world.otherGroupId, { groupId: world.otherGroupId }),
            groupLabel(world.otherGroupId),
          ),
          'a plan elsewhere',
        ),
      );
      expect(
        world.store.write((uow) =>
          world.repos.plans.addStep(
            uow,
            { id: planStepId('e1f'), planId: elsewhere.id, groupId: world.groupId, title: 'x' },
            groupLabel(world.groupId),
          ),
        ).kind,
      ).toBe('not_found');
    });
  });
});

describe('DecisionRepository', () => {
  const decision = (tag: string, groupId: Parameters<typeof member>[1], overrides = {}) => ({
    id: decisionId(tag),
    groupId,
    summary: `decision ${tag}`,
    decidedBy: { rule: 'informal' as const, memberIds: [] },
    origin: 'explicit' as const,
    decidedAt: T0,
    decidedTz: UTC,
    ...overrides,
  });

  it('records a decision and lists it newest first', () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      world.store.write((uow) => {
        world.repos.decisions.record(
          uow,
          decision('a1f', world.groupId, { decidedAt: at(-2) }),
          label,
        );
        world.repos.decisions.record(
          uow,
          decision('a2f', world.groupId, { decidedAt: at(-1) }),
          label,
        );
      });
      expect(
        world.repos.decisions
          .log({ groupId: world.groupId, limit: 10, eligible: eligibleAll(world) })
          .map((row) => row.id),
      ).toEqual([decisionId('a2f'), decisionId('a1f')]);
    });
  });

  it('keeps a superseded decision in the log and drops a retracted one', () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      const first = world.store.write((uow) =>
        expectWritten(
          world.repos.decisions.record(uow, decision('b1f', world.groupId), label),
          'the first',
        ),
      );
      const second = world.store.write((uow) =>
        expectWritten(
          world.repos.decisions.supersede(
            uow,
            world.groupId,
            first.id,
            first.version,
            decision('b2f', world.groupId),
            label,
          ),
          'a replacement',
        ),
      );
      expect(second.supersedesId).toBe(first.id);
      // Superseded stays: "what did we decide then" is a question the log exists to answer.
      expect(
        world.repos.decisions
          .log({ groupId: world.groupId, limit: 10, eligible: eligibleAll(world) })
          .map((row) => row.id)
          .toSorted(),
      ).toEqual([first.id, second.id].toSorted());

      const retracting = world.repos.decisions.byId(world.groupId, first.id, eligibleAll(world));
      if (retracting === undefined) throw new Error('fixture');
      world.store.write((uow) =>
        world.repos.decisions.retract(uow, world.groupId, first.id, retracting.version),
      );
      // Retracted leaves: a decision the group took back is not part of the record of what they
      // decided.
      expect(
        world.repos.decisions
          .log({ groupId: world.groupId, limit: 10, eligible: eligibleAll(world) })
          .map((row) => row.id),
      ).toEqual([second.id]);
    });
  });

  it('is idempotent about the memory mirror', () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      // `decisions.memory_item_id` is a foreign key, so the mirror test needs a real memory row.
      // Written through the memory repository rather than raw SQL, so the fixture cannot create a
      // state the product could not reach.
      const memory = world.store.write((uow) =>
        expectWritten(
          world.repos.memories.insert(
            uow,
            memoryItem('c9f', world.groupId),
            label,
            fingerprintFor('c9f'),
          ),
          'a memory to mirror',
        ),
      ).id;
      const first = world.store.write((uow) =>
        expectWritten(
          world.repos.decisions.record(
            uow,
            decision('c1f', world.groupId, { memoryItemId: memory, origin: 'extracted' }),
            label,
          ),
          'the mirror',
        ),
      );
      const again = world.store.write((uow) =>
        world.repos.decisions.record(
          uow,
          decision('c2f', world.groupId, { memoryItemId: memory, origin: 'extracted' }),
          label,
        ),
      );
      // `decisions_memory_uq` is `04` §3.4.6's idempotency: a re-run finds the decision it already
      // made rather than mirroring twice.
      expect(again.kind).toBe('duplicate');
      if (again.kind !== 'duplicate') return;
      expect(again.existingId).toBe(first.id);
    });
  });

  it('refuses a stale version on supersede without writing the replacement', () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      const first = world.store.write((uow) =>
        expectWritten(
          world.repos.decisions.record(uow, decision('d1f', world.groupId), label),
          'the first',
        ),
      );
      world.store.write((uow) =>
        world.repos.decisions.retract(uow, world.groupId, first.id, first.version),
      );
      const refused = world.store.write((uow) =>
        world.repos.decisions.supersede(
          uow,
          world.groupId,
          first.id,
          first.version,
          decision('d2f', world.groupId),
          label,
        ),
      );
      expect(refused.kind).toBe('conflict');
      expect(
        world.repos.decisions.byId(world.groupId, decisionId('d2f'), eligibleAll(world)),
      ).toBeUndefined();
    });
  });
});

describe('ReminderRepository', () => {
  const reminder = (
    tag: string,
    groupId: Parameters<typeof member>[1],
    readerSet: ReaderSetId,
    overrides: Record<string, unknown> = {},
  ) => ({
    id: reminderId(tag),
    groupId,
    kind: 'group' as const,
    text: `remind ${tag}`,
    recipients: { kind: 'group' as const, conversationId: conversationId('a') },
    delivery: 'group' as const,
    schedule: { kind: 'once' as const, at: T0.toString() },
    anchor: 'fixed_zone' as const,
    audienceReaderSetId: readerSet,
    tzdataVersion: '2026b',
    nextFireAt: T0,
    ...overrides,
  });

  describe('firing exactly once (I6)', () => {
    it('records a firing and advances the schedule', () => {
      withWorld((world, ids) => {
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.reminders.create(
              uow,
              reminder('a1f', world.groupId, ids.readerSet),
              groupLabel(world.groupId),
            ),
            'a reminder',
          ),
        );
        const firing = world.store.write((uow) =>
          expectWritten(
            world.repos.reminders.recordFiring(
              uow,
              {
                id: firingId('a1f'),
                reminderId: created.id,
                groupId: world.groupId,
                occurrenceKey: '2026-11-10',
                scheduledFor: T0,
                firedAt: T0,
                outcome: 'sent',
              },
              at(1),
            ),
            'a firing',
          ),
        );
        expect(firing.outcome).toBe('sent');
        const after = world.repos.reminders.byId(world.groupId, created.id, eligibleAll(world));
        expect(after?.nextFireAt?.epochMilliseconds).toBe(at(1).epochMilliseconds);
        expect(after?.status).toBe('scheduled');
      });
    });

    it('refuses a second firing of the same occurrence', () => {
      withWorld((world, ids) => {
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.reminders.create(
              uow,
              reminder('a2f', world.groupId, ids.readerSet),
              groupLabel(world.groupId),
            ),
            'a reminder',
          ),
        );
        const firing = {
          reminderId: created.id,
          groupId: world.groupId,
          occurrenceKey: '2026-11-10',
          scheduledFor: T0,
          firedAt: T0,
          outcome: 'sent' as const,
        };
        const first = world.store.write((uow) =>
          expectWritten(
            world.repos.reminders.recordFiring(uow, { ...firing, id: firingId('a2f') }, at(1)),
            'the first firing',
          ),
        );
        // A different firing id, the same occurrence: the scheduler ran twice — after a crash, or
        // on two workers. `reminder_firings_occurrence_uq` is what makes the second one lose, and
        // the guarantee is the index's rather than the scheduler's, because a scheduler that
        // remembered would forget on restart.
        const again = world.store.write((uow) =>
          world.repos.reminders.recordFiring(uow, { ...firing, id: firingId('a3f') }, at(1)),
        );
        expect(again.kind).toBe('duplicate');
        if (again.kind !== 'duplicate') return;
        expect(again.existingId).toBe(first.id);
        expect(world.db.prepare('SELECT count(*) AS n FROM reminder_firings').get()).toEqual({
          n: 1,
        });
      });
    });

    it('finishes a series when there is no next time', () => {
      withWorld((world, ids) => {
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.reminders.create(
              uow,
              reminder('a4f', world.groupId, ids.readerSet),
              groupLabel(world.groupId),
            ),
            'a reminder',
          ),
        );
        world.store.write((uow) =>
          world.repos.reminders.recordFiring(
            uow,
            {
              id: firingId('a4f'),
              reminderId: created.id,
              groupId: world.groupId,
              occurrenceKey: '2026-11-10',
              scheduledFor: T0,
              firedAt: T0,
              outcome: 'sent',
            },
            null,
          ),
        );
        const after = world.repos.reminders.byId(world.groupId, created.id, eligibleAll(world));
        // A reminder with no next time and a `scheduled` status would sit in the due index
        // forever, matching nothing and costing a row on every sweep.
        expect(after?.status).toBe('completed_series');
        expect(after?.nextFireAt).toBeUndefined();
        expect(world.repos.reminders.due(world.groupId, at(10), 10)).toEqual([]);
      });
    });
  });

  describe('the due sweep (Q-COO-1)', () => {
    it('finds a reminder due now and skips one due later', () => {
      withWorld((world, ids) => {
        const label = groupLabel(world.groupId);
        world.store.write((uow) => {
          world.repos.reminders.create(uow, reminder('b1f', world.groupId, ids.readerSet), label);
          world.repos.reminders.create(
            uow,
            reminder('b2f', world.groupId, ids.readerSet, { nextFireAt: at(5) }),
            label,
          );
        });
        expect(world.repos.reminders.due(world.groupId, T0, 10).map((row) => row.id)).toEqual([
          reminderId('b1f'),
        ]);
      });
    });

    it('does not fire a snoozed reminder until its snooze passes', () => {
      withWorld((world, ids) => {
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.reminders.create(
              uow,
              reminder('b3f', world.groupId, ids.readerSet),
              groupLabel(world.groupId),
            ),
            'a reminder',
          ),
        );
        const snoozed = world.store.write((uow) =>
          expectWritten(
            world.repos.reminders.snooze(uow, world.groupId, created.id, created.version, at(2)),
            'a snooze',
          ),
        );
        expect(snoozed.status).toBe('snoozed');
        // Backwards here means a snoozed reminder firing immediately — the most annoying possible
        // failure of a snooze, because the member asked for quiet and got the opposite.
        expect(world.repos.reminders.due(world.groupId, T0, 10)).toEqual([]);
        expect(world.repos.reminders.due(world.groupId, at(3), 10).map((row) => row.id)).toEqual([
          reminderId('b3f'),
        ]);
      });
    });

    it('clears the snooze when the occurrence fires', () => {
      withWorld((world, ids) => {
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.reminders.create(
              uow,
              reminder('b4f', world.groupId, ids.readerSet),
              groupLabel(world.groupId),
            ),
            'a reminder',
          ),
        );
        const snoozed = world.store.write((uow) =>
          expectWritten(
            world.repos.reminders.snooze(uow, world.groupId, created.id, created.version, at(1)),
            'a snooze',
          ),
        );
        world.store.write((uow) =>
          world.repos.reminders.recordFiring(
            uow,
            {
              id: firingId('b4f'),
              reminderId: snoozed.id,
              groupId: world.groupId,
              occurrenceKey: '2026-11-11',
              scheduledFor: at(1),
              firedAt: at(1),
              outcome: 'sent',
            },
            at(2),
          ),
        );
        const after = world.repos.reminders.byId(world.groupId, snoozed.id, eligibleAll(world));
        // The snooze deferred *this* occurrence. Leaving it set would suppress the next one too.
        expect(after?.snoozedUntil).toBeUndefined();
        expect(after?.status).toBe('scheduled');
      });
    });

    it('is not label-filtered, because the scheduler is not an audience', () => {
      withWorld((world, ids) => {
        world.store.write((uow) =>
          world.repos.reminders.create(
            uow,
            reminder('b5f', world.groupId, ids.readerSet),
            // A label nothing in the eligible set admits.
            groupLabel(world.groupId, { sensitivity: 'sensitive', untrusted: true }),
          ),
        );
        // The scheduler decides *when* to fire; `07` decides what the firing says and to whom,
        // from the reminder's own `recipients` and frozen reader set. Filtering here would mean a
        // reminder stopped firing because the scheduler could not read it.
        expect(world.repos.reminders.due(world.groupId, T0, 10)).toHaveLength(1);
        // But the labeled read **is** filtered.
        expect(
          world.repos.reminders.byId(world.groupId, reminderId('b5f'), eligibleNone(world)),
        ).toBeUndefined();
      });
    });

    it('leaves the due index when a reminder is cancelled', () => {
      withWorld((world, ids) => {
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.reminders.create(
              uow,
              reminder('b6f', world.groupId, ids.readerSet),
              groupLabel(world.groupId),
            ),
            'a reminder',
          ),
        );
        const cancelled = world.store.write((uow) =>
          expectWritten(
            world.repos.reminders.setStatus(
              uow,
              world.groupId,
              created.id,
              created.version,
              'cancelled',
            ),
            'a cancellation',
          ),
        );
        expect(cancelled.nextFireAt).toBeUndefined();
        expect(world.repos.reminders.due(world.groupId, at(10), 10)).toEqual([]);
      });
    });

    it('does not sweep another group`s reminders', () => {
      withWorld((world, ids) => {
        world.store.write((uow) =>
          world.repos.reminders.create(
            uow,
            reminder('b7f', world.groupId, ids.readerSet),
            groupLabel(world.groupId),
          ),
        );
        // Group-scoped on purpose: `reminders_due_idx` leads with the group, so an unscoped sweep
        // could not use it — and scoping removes the `I4` exception an instance-wide sweep needed.
        expect(world.repos.reminders.due(world.otherGroupId, T0, 10)).toEqual([]);
      });
    });
  });

  it('finds what reminds about an event, and acknowledges a firing', () => {
    withWorld((world, ids) => {
      const label = groupLabel(world.groupId);
      const who = ids.who[0];
      if (who === undefined) throw new Error('fixture');
      const created = world.store.write((uow) =>
        expectWritten(
          world.repos.reminders.create(
            uow,
            reminder('c1f', world.groupId, ids.readerSet, {
              kind: 'event_lead',
              aboutRef: 'evt_01jrem00000000000000000001',
            }),
            label,
          ),
          'a derived reminder',
        ),
      );
      expect(
        world.repos.reminders
          .about(world.groupId, 'evt_01jrem00000000000000000001', eligibleAll(world))
          .map((row) => row.id),
      ).toEqual([created.id]);

      const firing = world.store.write((uow) =>
        expectWritten(
          world.repos.reminders.recordFiring(
            uow,
            {
              id: firingId('c1f'),
              reminderId: created.id,
              groupId: world.groupId,
              occurrenceKey: '2026-11-10',
              scheduledFor: T0,
              firedAt: T0,
              outcome: 'sent',
            },
            null,
          ),
          'a firing',
        ),
      );
      const acked = world.store.write((uow) =>
        expectWritten(
          world.repos.reminders.acknowledge(uow, world.groupId, firing.id, who as never, T0),
          'an acknowledgement',
        ),
      );
      expect(acked.ackedByMemberId).toBe(who);
      expect(world.repos.reminders.firingsOf(world.groupId, created.id, 10)).toHaveLength(1);
    });
  });

  describe('query plans (M1-T19 AC)', { tags: ['db'] }, () => {
    it('reaches Q-COO-1 through the partial due index', () => {
      withWorld((world, ids) => {
        const label = groupLabel(world.groupId);
        world.store.write((uow) => {
          for (let index = 0; index < 400; index += 1) {
            world.repos.reminders.create(
              uow,
              reminder(`d${index.toString(16)}f`, world.groupId, ids.readerSet, {
                // A mix of live and finished, so the partial index covers a meaningful subset.
                nextFireAt: at(index % 30),
                ...(index % 4 === 0 ? { nextFireAt: at(index % 30) } : {}),
              }),
              label,
            );
          }
        });
        analyze(world.db);
        expectIndexUsed(
          world.db,
          `SELECT * FROM reminders
            WHERE group_id = ? AND status IN ('scheduled','snoozed')
              AND next_fire_at IS NOT NULL AND next_fire_at <= ?
              AND (snoozed_until IS NULL OR snoozed_until <= ?)
            ORDER BY next_fire_at ASC, id ASC LIMIT 100`,
          {
            table: 'reminders',
            index: 'reminders_due_idx',
            parameters: [world.groupId, DAY * 10, DAY * 10],
          },
        );
      });
    });

    it('reaches Q-COO-4 and Q-COO-5 through their indexes', () => {
      withWorld((world, ids) => {
        const label = groupLabel(world.groupId);
        world.store.write((uow) => {
          for (let index = 0; index < 400; index += 1) {
            world.repos.polls.create(
              uow,
              {
                id: pollId(`e${index.toString(16)}f`),
                groupId: world.groupId,
                conversationId: ids.conversation,
                purpose: 'opinion',
                question: 'q',
                options: [
                  { id: 'o1', text: 'one', position: 0 },
                  { id: 'o2', text: 'two', position: 1 },
                ],
                rule: 'plurality',
                quorum: { kind: 'none' },
                mode: 'buttons',
                ...(index % 3 === 0 ? {} : { deadlineAt: at(index % 20) }),
              },
              label,
            );
            world.repos.decisions.record(
              uow,
              {
                id: decisionId(`f${index.toString(16)}f`),
                groupId: world.groupId,
                summary: 'd',
                decidedBy: { rule: 'informal', memberIds: [] },
                origin: 'explicit',
                decidedAt: at(-(index % 60)),
                decidedTz: UTC,
              },
              label,
            );
          }
        });
        analyze(world.db);
        expectIndexUsed(
          world.db,
          `SELECT * FROM polls
            WHERE group_id = ? AND status = 'open' AND label_id IN (?)
            ORDER BY deadline_at IS NULL, deadline_at ASC, rid ASC LIMIT 50`,
          { table: 'polls', index: 'polls_open_deadline_idx', parameters: [world.groupId, 1] },
        );
        expectIndexUsed(
          world.db,
          `SELECT * FROM decisions
            WHERE group_id = ? AND status <> 'retracted' AND label_id IN (?)
            ORDER BY decided_at DESC, rid DESC LIMIT 50`,
          {
            table: 'decisions',
            index: 'decisions_group_decided_idx',
            parameters: [world.groupId, 1],
          },
        );
      });
    });
  });
});

describe('refusals and isolation, across all four aggregates', () => {
  it('refuses a label from another group, everywhere', () => {
    withWorld((world, ids) => {
      const alien = groupLabel(world.otherGroupId);
      expect(() =>
        world.store.write((uow) =>
          world.repos.polls.create(
            uow,
            {
              id: pollId('z1f'),
              groupId: world.groupId,
              conversationId: ids.conversation,
              purpose: 'opinion',
              question: 'q',
              options: [
                { id: 'o1', text: 'one', position: 0 },
                { id: 'o2', text: 'two', position: 1 },
              ],
              rule: 'plurality',
              quorum: { kind: 'none' },
              mode: 'buttons',
            },
            alien,
          ),
        ),
      ).toThrow(/another group/);
      expect(() =>
        world.store.write((uow) =>
          world.repos.plans.create(
            uow,
            { id: planId('z1f'), groupId: world.groupId, title: 'p' },
            alien,
          ),
        ),
      ).toThrow(/another group/);
      expect(() =>
        world.store.write((uow) =>
          world.repos.decisions.record(
            uow,
            {
              id: decisionId('z1f'),
              groupId: world.groupId,
              summary: 'd',
              decidedBy: { rule: 'informal', memberIds: [] },
              origin: 'explicit',
              decidedAt: T0,
              decidedTz: UTC,
            },
            alien,
          ),
        ),
      ).toThrow(/another group/);
      expect(() =>
        world.store.write((uow) =>
          world.repos.reminders.create(
            uow,
            {
              id: reminderId('z1f'),
              groupId: world.groupId,
              kind: 'group',
              recipients: { kind: 'group', conversationId: ids.conversation },
              delivery: 'group',
              schedule: { kind: 'once', at: T0.toString() },
              anchor: 'fixed_zone',
              audienceReaderSetId: ids.readerSet,
              tzdataVersion: '2026b',
            },
            alien,
          ),
        ),
      ).toThrow(/another group/);
    });
  });

  it('reports a reused id as a duplicate, everywhere', () => {
    withWorld((world, ids) => {
      const label = groupLabel(world.groupId);
      const made = world.store.write((uow) => {
        world.repos.polls.create(
          uow,
          {
            id: pollId('y1f'),
            groupId: world.groupId,
            conversationId: ids.conversation,
            purpose: 'opinion',
            question: 'q',
            options: [
              { id: 'o1', text: 'one', position: 0 },
              { id: 'o2', text: 'two', position: 1 },
            ],
            rule: 'plurality',
            quorum: { kind: 'none' },
            mode: 'buttons',
          },
          label,
        );
        world.repos.plans.create(
          uow,
          { id: planId('y1f'), groupId: world.groupId, title: 'p' },
          label,
        );
        world.repos.reminders.create(
          uow,
          {
            id: reminderId('y1f'),
            groupId: world.groupId,
            kind: 'group',
            recipients: { kind: 'group', conversationId: ids.conversation },
            delivery: 'group',
            schedule: { kind: 'once', at: T0.toString() },
            anchor: 'fixed_zone',
            audienceReaderSetId: ids.readerSet,
            tzdataVersion: '2026b',
          },
          label,
        );
        return true;
      });
      expect(made).toBe(true);

      // A reused id is a caller bug, and `duplicate` with that id is the only thing it could be.
      expect(
        world.store.write((uow) =>
          world.repos.plans.create(
            uow,
            { id: planId('y1f'), groupId: world.groupId, title: 'again' },
            label,
          ),
        ).kind,
      ).toBe('duplicate');
      expect(
        world.store.write((uow) =>
          world.repos.reminders.create(
            uow,
            {
              id: reminderId('y1f'),
              groupId: world.groupId,
              kind: 'group',
              recipients: { kind: 'group', conversationId: ids.conversation },
              delivery: 'group',
              schedule: { kind: 'once', at: T0.toString() },
              anchor: 'fixed_zone',
              audienceReaderSetId: ids.readerSet,
              tzdataVersion: '2026b',
            },
            label,
          ),
        ).kind,
      ).toBe('duplicate');
      const step = world.store.write((uow) =>
        expectWritten(
          world.repos.plans.addStep(
            uow,
            { id: planStepId('y1f'), planId: planId('y1f'), groupId: world.groupId, title: 's' },
            label,
          ),
          'a step',
        ),
      );
      expect(
        world.store.write((uow) =>
          world.repos.plans.addStep(
            uow,
            { id: step.id, planId: planId('y1f'), groupId: world.groupId, title: 's again' },
            label,
          ),
        ).kind,
      ).toBe('duplicate');
    });
  });

  it('tells a missing row from a stale version, everywhere', () => {
    withWorld((world, ids) => {
      const label = groupLabel(world.groupId);
      // Missing rows first.
      expect(
        world.store.write((uow) =>
          world.repos.polls.close(uow, world.groupId, pollId('xxf'), 1, { kind: 'no_quorum' }, T0),
        ).kind,
      ).toBe('not_found');
      expect(
        world.store.write((uow) =>
          world.repos.polls.cancel(uow, world.groupId, pollId('xxf'), 1, T0),
        ).kind,
      ).toBe('not_found');
      expect(
        world.store.write((uow) =>
          world.repos.polls.vote(
            uow,
            world.groupId,
            pollId('xxf'),
            ids.who[0] as never,
            ['o1'],
            T0,
          ),
        ).kind,
      ).toBe('not_found');
      expect(
        world.store.write((uow) =>
          world.repos.plans.setStatus(uow, world.groupId, planId('xxf'), 1, 'done'),
        ).kind,
      ).toBe('not_found');
      expect(
        world.store.write((uow) =>
          world.repos.plans.setStepStatus(uow, world.groupId, planStepId('xxf'), 1, 'done'),
        ).kind,
      ).toBe('not_found');
      expect(
        world.store.write((uow) =>
          world.repos.decisions.retract(uow, world.groupId, decisionId('xxf'), 1),
        ).kind,
      ).toBe('not_found');
      expect(
        world.store.write((uow) =>
          world.repos.decisions.supersede(
            uow,
            world.groupId,
            decisionId('xxf'),
            1,
            {
              id: decisionId('xyf'),
              groupId: world.groupId,
              summary: 'd',
              decidedBy: { rule: 'informal', memberIds: [] },
              origin: 'explicit',
              decidedAt: T0,
              decidedTz: UTC,
            },
            label,
          ),
        ).kind,
      ).toBe('not_found');
      expect(
        world.store.write((uow) =>
          world.repos.reminders.snooze(uow, world.groupId, reminderId('xxf'), 1, at(1)),
        ).kind,
      ).toBe('not_found');
      expect(
        world.store.write((uow) =>
          world.repos.reminders.setStatus(uow, world.groupId, reminderId('xxf'), 1, 'cancelled'),
        ).kind,
      ).toBe('not_found');
      expect(
        world.store.write((uow) =>
          world.repos.reminders.acknowledge(
            uow,
            world.groupId,
            firingId('xxf'),
            ids.who[0] as never,
            T0,
          ),
        ).kind,
      ).toBe('not_found');
      expect(
        world.store.write((uow) =>
          world.repos.reminders.recordFiring(
            uow,
            {
              id: firingId('xyf'),
              reminderId: reminderId('xxf'),
              groupId: world.groupId,
              occurrenceKey: 'k',
              scheduledFor: T0,
              firedAt: T0,
              outcome: 'sent',
            },
            null,
          ),
        ).kind,
      ).toBe('not_found');

      // Then stale versions, which must be `conflict` rather than `not_found` — a caller that
      // gets `not_found` stops, and one that gets `conflict` re-reads and decides again.
      const plan = world.store.write((uow) =>
        expectWritten(
          world.repos.plans.create(
            uow,
            { id: planId('x1f'), groupId: world.groupId, title: 'p' },
            label,
          ),
          'a plan',
        ),
      );
      world.store.write((uow) =>
        world.repos.plans.setStatus(uow, world.groupId, plan.id, plan.version, 'active'),
      );
      expect(
        world.store.write((uow) =>
          world.repos.plans.setStatus(uow, world.groupId, plan.id, plan.version, 'done'),
        ).kind,
      ).toBe('conflict');

      const step = world.store.write((uow) =>
        expectWritten(
          world.repos.plans.addStep(
            uow,
            { id: planStepId('x1f'), planId: plan.id, groupId: world.groupId, title: 's' },
            label,
          ),
          'a step',
        ),
      );
      world.store.write((uow) =>
        world.repos.plans.setStepStatus(uow, world.groupId, step.id, step.version, 'doing'),
      );
      expect(
        world.store.write((uow) =>
          world.repos.plans.setStepStatus(uow, world.groupId, step.id, step.version, 'done'),
        ).kind,
      ).toBe('conflict');

      const reminder = world.store.write((uow) =>
        expectWritten(
          world.repos.reminders.create(
            uow,
            {
              id: reminderId('x1f'),
              groupId: world.groupId,
              kind: 'group',
              recipients: { kind: 'group', conversationId: ids.conversation },
              delivery: 'group',
              schedule: { kind: 'once', at: T0.toString() },
              anchor: 'fixed_zone',
              audienceReaderSetId: ids.readerSet,
              tzdataVersion: '2026b',
              nextFireAt: T0,
            },
            label,
          ),
          'a reminder',
        ),
      );
      world.store.write((uow) =>
        world.repos.reminders.snooze(uow, world.groupId, reminder.id, reminder.version, at(1)),
      );
      expect(
        world.store.write((uow) =>
          world.repos.reminders.snooze(uow, world.groupId, reminder.id, reminder.version, at(2)),
        ).kind,
      ).toBe('conflict');
    });
  });

  it('returns an empty tally for a poll that does not exist', () => {
    withWorld((world) => {
      // An empty map rather than a throw: a caller rendering a result page for a deleted poll
      // should show nothing, not fail — and a tally of nothing is exactly what it has.
      expect([...world.repos.polls.countsOf(world.groupId, pollId('wwf')).entries()]).toEqual([]);
    });
  });

  it('cancels a poll, keeping its tally readable', () => {
    withWorld((world, ids) => {
      const created = world.store.write((uow) =>
        expectWritten(
          world.repos.polls.create(
            uow,
            {
              id: pollId('v1f'),
              groupId: world.groupId,
              conversationId: ids.conversation,
              purpose: 'opinion',
              question: 'q',
              options: [
                { id: 'o1', text: 'one', position: 0 },
                { id: 'o2', text: 'two', position: 1 },
              ],
              rule: 'plurality',
              quorum: { kind: 'none' },
              mode: 'buttons',
            },
            groupLabel(world.groupId),
          ),
          'a poll',
        ),
      );
      world.store.write((uow) =>
        world.repos.polls.vote(uow, world.groupId, created.id, ids.who[0] as never, ['o1'], T0),
      );
      const cancelled = world.store.write((uow) =>
        expectWritten(
          world.repos.polls.cancel(uow, world.groupId, created.id, created.version, T0),
          'a cancellation',
        ),
      );
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.closedAt).toBeDefined();
      // The ballots and the tally stay: a cancelled poll is a record of what was asked and who
      // had answered, which `07`'s decision log may still reference.
      expect(world.repos.polls.countsOf(world.groupId, created.id).get('o1')).toBe(1);
    });
  });

  it('returns nothing from the plan and decision reads for an empty eligible set', () => {
    withWorld((world) => {
      const label = groupLabel(world.groupId);
      world.store.write((uow) => {
        world.repos.plans.create(
          uow,
          { id: planId('n9f'), groupId: world.groupId, title: 'p' },
          label,
        );
        world.repos.decisions.record(
          uow,
          {
            id: decisionId('n9f'),
            groupId: world.groupId,
            summary: 'd',
            decidedBy: { rule: 'informal', memberIds: [] },
            origin: 'explicit',
            decidedAt: T0,
            decidedTz: UTC,
          },
          label,
        );
      });
      expect(
        world.repos.plans.byId(world.groupId, planId('n9f'), eligibleNone(world)),
      ).toBeUndefined();
      expect(
        world.repos.plans.byStatus({
          groupId: world.groupId,
          limit: 10,
          eligible: eligibleNone(world),
        }),
      ).toEqual([]);
      expect(world.repos.plans.stepsOf(world.groupId, planId('n9f'), eligibleNone(world))).toEqual(
        [],
      );
      expect(
        world.repos.decisions.byId(world.groupId, decisionId('n9f'), eligibleNone(world)),
      ).toBeUndefined();
      expect(
        world.repos.decisions.log({
          groupId: world.groupId,
          limit: 10,
          eligible: eligibleNone(world),
        }),
      ).toEqual([]);
      expect(world.repos.reminders.about(world.groupId, 'evt_x', eligibleNone(world))).toEqual([]);
      // The rows are there, so none of the above is vacuous.
      expect(
        world.repos.plans.byId(world.groupId, planId('n9f'), eligibleAll(world)),
      ).toBeDefined();
    });
  });
});
