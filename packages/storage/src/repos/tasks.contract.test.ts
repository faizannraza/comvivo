/**
 * `TaskReader`/`TaskRepository`, the fairness ledger, and the Q-CTX-7 plans (`M1-T19`).
 *
 * The behaviour worth most of this file is the **ledger**: `complete` posts it in the same
 * transaction as the completion, only for a chore, crediting the **completer** rather than the
 * assignee. Each of those three is a decision whose wrong form is quiet — a task charged as a
 * chore inflates somebody's share, a ledger posted separately can disagree with the task that
 * caused it, and crediting the assignee would miss exactly the case fairness exists to see:
 * somebody covering for an absent member.
 */
import type { NotPromise } from '@comvivo/core';
import { expectWritten } from '@comvivo/core';
import { StorageError } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  eligibleAll,
  eligibleNone,
  groupLabel,
  ledgerEntryId,
  member,
  memberId,
  person,
  T0,
  taskId,
  withRepos,
} from './testing/harness.js';
import { analyze, expectIndexUsed } from './testing/query-plan.js';

const DAY = 86_400_000;

function at(offsetDays: number): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + offsetDays * DAY);
}

/** A task with the fields a test does not care about filled in. */
function task(
  tag: string,
  groupId: Parameters<typeof member>[1],
  overrides: Record<string, unknown> = {},
) {
  return {
    id: taskId(tag),
    groupId,
    title: `task ${tag}`,
    due: { kind: 'none' as const },
    ...overrides,
  };
}

/**
 * 400 tasks with a realistic spread of status, assignee and due date.
 *
 * Extracted rather than inlined because the plan tests need it twice and Biome's complexity score
 * was right that the test function had grown too branchy to read. The **spread** is the point: a
 * degenerate distribution makes the planner choose differently and a plan assertion then fails on
 * correct code (see `query-plan.ts`).
 */
function seedTasks(
  world: Parameters<Parameters<typeof withRepos>[0]>[0],
  assignee: string,
  count = 400,
): void {
  const label = groupLabel(world.groupId);
  world.store.write((uow) => {
    for (let index = 0; index < count; index += 1) {
      world.repos.tasks.create(
        uow,
        task(`t${index.toString(16)}f`, world.groupId, {
          status: index % 4 === 0 ? 'done' : 'open',
          ...(index % 3 === 0 ? { assigneeMemberId: assignee, assignmentState: 'direct' } : {}),
          ...(index % 5 === 0 ? {} : { dueAt: at(index % 60) }),
        }),
        label,
      );
    }
  });
}

/** A group with two members, so an assignment can move between them. */
function withMembers<T>(
  fn: (
    world: Parameters<Parameters<typeof withRepos>[0]>[0],
    who: readonly string[],
  ) => NotPromise<T>,
): T {
  return withRepos((world) => {
    const who = world.store.write((uow) =>
      ['a', 'b'].map((tag) => {
        expectWritten(world.repos.persons.create(uow, person(tag)), `person ${tag}`);
        return expectWritten(
          world.repos.members.add(uow, member(tag, world.groupId)),
          `member ${tag}`,
        ).id;
      }),
    );
    return fn(world, who);
  });
}

describe('TaskRepository', () => {
  it('creates a task with the schema defaults', () => {
    withRepos((world) => {
      const created = world.store.write((uow) =>
        expectWritten(
          world.repos.tasks.create(uow, task('a1f', world.groupId), groupLabel(world.groupId)),
          'a task',
        ),
      );
      expect(created.kind).toBe('task');
      expect(created.status).toBe('open');
      expect(created.assignmentState).toBe('unassigned');
      expect(created.effortPoints).toBe(1);
      expect(created.proofPolicy).toBe('off');
      expect(created.nudgeCount).toBe(0);
      expect(created.completedAt).toBeUndefined();
    });
  });

  describe('the fairness ledger (03 §3.9.3)', () => {
    it('posts an entry when a chore is completed, crediting the completer', () => {
      withMembers((world, who) => {
        const [assignee, coverer] = who;
        if (assignee === undefined || coverer === undefined) throw new Error('fixture');
        const chore = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.create(
              uow,
              task('b1f', world.groupId, {
                kind: 'chore',
                effortPoints: 3,
                category: 'kitchen',
                assigneeMemberId: assignee,
                assignmentState: 'direct',
              }),
              groupLabel(world.groupId),
            ),
            'a chore',
          ),
        );
        world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.complete(uow, world.groupId, chore.id, chore.version, {
              // Somebody **else** did it, which is the case fairness has to see.
              completedByMemberId: coverer as never,
              at: T0,
              ledgerEntryId: ledgerEntryId('b1f'),
            }),
            'a completion',
          ),
        );
        const entries = world.repos.tasks.ledgerFor({
          groupId: world.groupId,
          memberId: coverer as never,
          from: at(-1),
          to: at(1),
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]?.kind).toBe('task_done');
        expect(entries[0]?.points).toBe(3);
        expect(entries[0]?.category).toBe('kitchen');
        expect(entries[0]?.taskId).toBe(chore.id);
        // Nothing for the assignee, who did not do it.
        expect(
          world.repos.tasks.ledgerFor({
            groupId: world.groupId,
            memberId: assignee as never,
            from: at(-1),
            to: at(1),
          }),
        ).toHaveLength(0);
      });
    });

    it('posts nothing for a completed one-off task', () => {
      withMembers((world, who) => {
        const doer = who[0];
        if (doer === undefined) throw new Error('fixture');
        const one = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.create(uow, task('b2f', world.groupId), groupLabel(world.groupId)),
            'a task',
          ),
        );
        world.store.write((uow) =>
          world.repos.tasks.complete(uow, world.groupId, one.id, one.version, {
            completedByMemberId: doer as never,
            at: T0,
            ledgerEntryId: ledgerEntryId('b2f'),
          }),
        );
        // A one-off task is somebody doing a favour; a chore is a share of recurring work.
        // Charging a favour would make it look like an obligation met.
        expect(
          world.repos.tasks.ledgerFor({
            groupId: world.groupId,
            memberId: doer as never,
            from: at(-1),
            to: at(1),
          }),
        ).toHaveLength(0);
      });
    });

    it('posts nothing for a skipped or cancelled chore', () => {
      withMembers((world, who) => {
        const doer = who[0];
        if (doer === undefined) throw new Error('fixture');
        for (const [tag, status] of [
          ['b3f', 'skipped'],
          ['b4f', 'cancelled'],
        ] as const) {
          const chore = world.store.write((uow) =>
            expectWritten(
              world.repos.tasks.create(
                uow,
                task(tag, world.groupId, { kind: 'chore' }),
                groupLabel(world.groupId),
              ),
              'a chore',
            ),
          );
          world.store.write((uow) =>
            world.repos.tasks.setStatus(uow, world.groupId, chore.id, chore.version, status),
          );
        }
        // Skipping a chore must not credit the member who skipped it.
        expect(
          world.repos.tasks.ledgerFor({
            groupId: world.groupId,
            memberId: doer as never,
            from: at(-1),
            to: at(1),
          }),
        ).toHaveLength(0);
      });
    });

    it('rolls the ledger back with the completion', () => {
      withMembers((world, who) => {
        const doer = who[0];
        if (doer === undefined) throw new Error('fixture');
        const chore = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.create(
              uow,
              task('b5f', world.groupId, { kind: 'chore' }),
              groupLabel(world.groupId),
            ),
            'a chore',
          ),
        );
        expect(() =>
          world.store.write((uow) => {
            world.repos.tasks.complete(uow, world.groupId, chore.id, chore.version, {
              completedByMemberId: doer as never,
              at: T0,
              ledgerEntryId: ledgerEntryId('b5f'),
            });
            throw new Error('the caller changed its mind');
          }),
        ).toThrow('the caller changed its mind');
        // Both or neither. A ledger posted in a separate transaction could record work for a
        // completion that rolled back — and `03` §3.9.3 reads the ledger as *the* record.
        expect(world.repos.tasks.byId(world.groupId, chore.id, eligibleAll(world))?.status).toBe(
          'open',
        );
        expect(
          world.repos.tasks.ledgerFor({
            groupId: world.groupId,
            memberId: doer as never,
            from: at(-1),
            to: at(1),
          }),
        ).toHaveLength(0);
      });
    });

    it('does not double-charge a retried completion', () => {
      withMembers((world, who) => {
        const doer = who[0];
        if (doer === undefined) throw new Error('fixture');
        const chore = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.create(
              uow,
              task('b6f', world.groupId, { kind: 'chore' }),
              groupLabel(world.groupId),
            ),
            'a chore',
          ),
        );
        const done = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.complete(uow, world.groupId, chore.id, chore.version, {
              completedByMemberId: doer as never,
              at: T0,
              ledgerEntryId: ledgerEntryId('b6f'),
            }),
            'the first completion',
          ),
        );
        // A retry with the **new** version and the same ledger id: the version guard would let
        // this through, so the ledger's own idempotency is what stops a double charge. A
        // double-charged ledger is a fairness claim that is simply wrong.
        world.store.write((uow) =>
          world.repos.tasks.complete(uow, world.groupId, chore.id, done.version, {
            completedByMemberId: doer as never,
            at: T0,
            ledgerEntryId: ledgerEntryId('b6f'),
          }),
        );
        expect(
          world.repos.tasks.ledgerFor({
            groupId: world.groupId,
            memberId: doer as never,
            from: at(-1),
            to: at(1),
          }),
        ).toHaveLength(1);
      });
    });

    it('appends a reversal rather than editing an entry', () => {
      withMembers((world, who) => {
        const doer = who[0];
        if (doer === undefined) throw new Error('fixture');
        const first = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.postLedger(
              uow,
              {
                id: ledgerEntryId('c1f'),
                groupId: world.groupId,
                memberId: doer as never,
                kind: 'self_logged',
                points: 2,
                at: T0,
              },
              groupLabel(world.groupId),
            ),
            'a self-logged entry',
          ),
        );
        world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.postLedger(
              uow,
              {
                id: ledgerEntryId('c2f'),
                groupId: world.groupId,
                memberId: doer as never,
                kind: 'reversal',
                points: -2,
                reversesId: first.id,
                at: T0,
              },
              groupLabel(world.groupId),
            ),
            'a reversal',
          ),
        );
        const entries = world.repos.tasks.ledgerFor({
          groupId: world.groupId,
          memberId: doer as never,
          from: at(-1),
          to: at(1),
        });
        // Both rows, summing to zero. A ledger you can edit is a ledger nobody trusts, so a
        // correction points at what it undoes and leaves the original standing.
        expect(entries).toHaveLength(2);
        expect(entries.reduce((sum, entry) => sum + entry.points, 0)).toBe(0);
        expect(entries.find((entry) => entry.kind === 'reversal')?.reversesId).toBe(first.id);
      });
    });

    it('keeps one group`s ledger out of another`s', () => {
      withMembers((world, who) => {
        const doer = who[0];
        if (doer === undefined) throw new Error('fixture');
        world.store.write((uow) =>
          world.repos.tasks.postLedger(
            uow,
            {
              id: ledgerEntryId('c3f'),
              groupId: world.groupId,
              memberId: doer as never,
              kind: 'self_logged',
              points: 1,
              at: T0,
            },
            groupLabel(world.groupId),
          ),
        );
        expect(
          world.repos.tasks.ledgerFor({
            groupId: world.otherGroupId,
            memberId: doer as never,
            from: at(-1),
            to: at(1),
          }),
        ).toHaveLength(0);
      });
    });

    it('bounds the window at both ends', () => {
      withMembers((world, who) => {
        const doer = who[0];
        if (doer === undefined) throw new Error('fixture');
        world.store.write((uow) => {
          for (const [tag, offset] of [
            ['d1f', -10],
            ['d2f', 0],
            ['d3f', 10],
          ] as const) {
            world.repos.tasks.postLedger(
              uow,
              {
                id: ledgerEntryId(tag),
                groupId: world.groupId,
                memberId: doer as never,
                kind: 'self_logged',
                points: 1,
                at: at(offset),
              },
              groupLabel(world.groupId),
            );
          }
        });
        const window = world.repos.tasks.ledgerFor({
          groupId: world.groupId,
          memberId: doer as never,
          from: at(-1),
          to: at(1),
        });
        expect(window).toHaveLength(1);
        expect(window[0]?.id).toBe(ledgerEntryId('d2f'));
      });
    });
  });

  describe('assignment', () => {
    it('moves the assignee and the state together', () => {
      withMembers((world, who) => {
        const [first, second] = who;
        if (first === undefined || second === undefined) throw new Error('fixture');
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.create(uow, task('e1f', world.groupId), groupLabel(world.groupId)),
            'a task',
          ),
        );
        const requested = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.assign(uow, world.groupId, created.id, created.version, {
              assigneeMemberId: first as never,
              assignmentState: 'requested',
            }),
            'a request',
          ),
        );
        expect(requested.assigneeMemberId).toBe(first);
        // `requested` is not yet work they owe — `03`'s fairness rules read the state, so it has
        // to travel with the assignee rather than be set separately.
        expect(requested.assignmentState).toBe('requested');

        const accepted = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.assign(uow, world.groupId, requested.id, requested.version, {
              assigneeMemberId: second as never,
              assignmentState: 'accepted',
            }),
            'a reassignment',
          ),
        );
        expect(accepted.assigneeMemberId).toBe(second);
        expect(accepted.assignmentState).toBe('accepted');
      });
    });

    it('refuses to clear the assignee while claiming an assigned state', () => {
      withMembers((world, who) => {
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.create(uow, task('e2f', world.groupId), groupLabel(world.groupId)),
            'a task',
          ),
        );
        void who;
        let caught: unknown;
        try {
          world.store.write((uow) =>
            world.repos.tasks.assign(uow, world.groupId, created.id, created.version, {
              assigneeMemberId: null,
              assignmentState: 'accepted',
            }),
          );
        } catch (error) {
          caught = error;
        }
        // An unassigned task in an `accepted` state is a row `03`'s fairness rules would read as
        // work somebody owes, with nobody to owe it.
        expect(caught).toBeInstanceOf(StorageError);
        expect((caught as StorageError).message).toContain("'unassigned'");
      });
    });

    it('clears the assignee when the state says unassigned', () => {
      withMembers((world, who) => {
        const first = who[0];
        if (first === undefined) throw new Error('fixture');
        const assigned = world.store.write((uow) => {
          const created = expectWritten(
            world.repos.tasks.create(
              uow,
              task('e3f', world.groupId, {
                assigneeMemberId: first,
                assignmentState: 'direct',
              }),
              groupLabel(world.groupId),
            ),
            'a task',
          );
          return created;
        });
        const cleared = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.assign(uow, world.groupId, assigned.id, assigned.version, {
              assigneeMemberId: null,
              assignmentState: 'unassigned',
            }),
            'an unassignment',
          ),
        );
        expect(cleared.assigneeMemberId).toBeUndefined();
        expect(cleared.assignmentState).toBe('unassigned');
      });
    });
  });

  describe('reads (Q-CTX-7, Q-CTX-7b)', () => {
    it('sorts undated tasks last, not first', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        world.store.write((uow) => {
          world.repos.tasks.create(uow, task('f1f', world.groupId, { dueAt: at(5) }), label);
          world.repos.tasks.create(uow, task('f2f', world.groupId), label);
          world.repos.tasks.create(uow, task('f3f', world.groupId, { dueAt: at(1) }), label);
        });
        const open = world.repos.tasks.openByDue({
          groupId: world.groupId,
          limit: 10,
          eligible: eligibleAll(world),
        });
        // `NULL` sorts before everything in SQLite, so a plain `ORDER BY due_at` would put every
        // undated task at the top of "what is due soonest" — the opposite of useful.
        expect(open.map((entry) => entry.id)).toEqual([
          taskId('f3f'),
          taskId('f1f'),
          taskId('f2f'),
        ]);
      });
    });

    it('excludes an undated task from a bounded window', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        world.store.write((uow) => {
          world.repos.tasks.create(uow, task('g1f', world.groupId, { dueAt: at(1) }), label);
          world.repos.tasks.create(uow, task('g2f', world.groupId), label);
        });
        // An undated task is not "due before" anything, which is different from the unbounded
        // form where it sorts last but is still listed.
        expect(
          world.repos.tasks
            .openByDue({
              groupId: world.groupId,
              dueBefore: at(3),
              limit: 10,
              eligible: eligibleAll(world),
            })
            .map((entry) => entry.id),
        ).toEqual([taskId('g1f')]);
      });
    });

    it('asks for open only, matching its partial index', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const proposed = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.create(
              uow,
              task('h1f', world.groupId, { status: 'proposed', dueAt: at(1) }),
              label,
            ),
            'a proposal',
          ),
        );
        // `tasks_open_due_idx` is partial on `status = 'open'`, so this query asks for `open`
        // only — a query that also wanted `proposed` could not use it. `07`'s "what is
        // outstanding" view, which includes proposals, is `byAssignee` with `open_like`.
        expect(
          world.repos.tasks.openByDue({
            groupId: world.groupId,
            limit: 10,
            eligible: eligibleAll(world),
          }),
        ).toEqual([]);
        expect(proposed.status).toBe('proposed');
      });
    });

    it('finds a member`s outstanding tasks, proposals included', () => {
      withMembers((world, who) => {
        const first = who[0];
        if (first === undefined) throw new Error('fixture');
        const label = groupLabel(world.groupId);
        world.store.write((uow) => {
          world.repos.tasks.create(
            uow,
            task('j1f', world.groupId, { assigneeMemberId: first, assignmentState: 'accepted' }),
            label,
          );
          world.repos.tasks.create(
            uow,
            task('j2f', world.groupId, {
              assigneeMemberId: first,
              assignmentState: 'requested',
              status: 'proposed',
            }),
            label,
          );
          world.repos.tasks.create(
            uow,
            task('j3f', world.groupId, {
              assigneeMemberId: first,
              assignmentState: 'accepted',
              status: 'done',
            }),
            label,
          );
        });
        const outstanding = world.repos.tasks.byAssignee({
          groupId: world.groupId,
          assigneeMemberId: first as never,
          limit: 10,
          eligible: eligibleAll(world),
        });
        // `open_like` is the default and includes `proposed`: `07` treats a proposed chore as
        // something the group has not settled, and leaving it out would make a proposal invisible
        // until somebody accepted it — exactly when it needs to be visible.
        expect(outstanding.map((entry) => entry.id).toSorted()).toEqual(
          [taskId('j1f'), taskId('j2f')].toSorted(),
        );
        expect(
          world.repos.tasks.byAssignee({
            groupId: world.groupId,
            assigneeMemberId: first as never,
            status: 'done',
            limit: 10,
            eligible: eligibleAll(world),
          }),
        ).toHaveLength(1);
      });
    });

    it('finds a rotation turn without a label filter, so a re-run cannot double-stamp', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const rotation = 'rot_01jrxt00000000000000000001' as never;
        // The rotation row needs a `label_id`, and `withRepos` builds its world through the
        // repositories — so nothing has interned a label yet. Interning one first is what makes
        // the raw `INSERT` possible; `rotations` has no repository until `M7`.
        const rotationLabelId = world.store.write((uow) =>
          world.repos.labels.intern(uow, groupLabel(world.groupId)),
        );
        world.db
          .prepare(
            `INSERT INTO rotations (id, group_id, name, task_template, strategy, assignment_mode,
               announce, cursor, status, label_id, created_at, updated_at, version)
             VALUES (?, ?, 'dishes', ?, 'round_robin',
                     'direct', 'group', ?, 'active', ?, 0, 0, 1)`,
          )
          .run(
            rotation,
            world.groupId,
            JSON.stringify({ title: 'dishes', effortPoints: 1 }),
            JSON.stringify({ index: 0 }),
            rotationLabelId,
          );
        const first = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.create(
              uow,
              task('k1f', world.groupId, {
                kind: 'chore',
                rotationId: rotation,
                occurrenceKey: '2026-W46',
              }),
              label,
            ),
            'a rotation task',
          ),
        );
        expect(world.repos.tasks.byOccurrence(world.groupId, rotation, '2026-W46')?.id).toBe(
          first.id,
        );
        // The scheduler is a job, not an audience. A re-run must find the task that exists rather
        // than create a second one for the same turn.
        const again = world.store.write((uow) =>
          world.repos.tasks.create(
            uow,
            task('k2f', world.groupId, {
              kind: 'chore',
              rotationId: rotation,
              occurrenceKey: '2026-W46',
            }),
            label,
          ),
        );
        expect(again.kind).toBe('duplicate');
        if (again.kind !== 'duplicate') return;
        expect(again.existingId).toBe(first.id);
      });
    });

    it('returns nothing from every labeled read for an empty eligible set', () => {
      withMembers((world, who) => {
        const first = who[0];
        if (first === undefined) throw new Error('fixture');
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.create(
              uow,
              task('m1f', world.groupId, { assigneeMemberId: first, assignmentState: 'direct' }),
              groupLabel(world.groupId),
            ),
            'a task',
          ),
        );
        const none = eligibleNone(world);
        expect(world.repos.tasks.byId(world.groupId, created.id, none)).toBeUndefined();
        expect(
          world.repos.tasks.openByDue({ groupId: world.groupId, limit: 10, eligible: none }),
        ).toEqual([]);
        expect(
          world.repos.tasks.byAssignee({
            groupId: world.groupId,
            assigneeMemberId: first as never,
            limit: 10,
            eligible: none,
          }),
        ).toEqual([]);
        // The row is there, so none of the above is vacuous.
        expect(world.repos.tasks.byId(world.groupId, created.id, eligibleAll(world))).toBeDefined();
      });
    });
  });

  describe('refusals and isolation', () => {
    it('reports a missing task as not_found and a stale version as conflict', () => {
      withRepos((world) => {
        expect(
          world.store.write((uow) =>
            world.repos.tasks.setStatus(uow, world.groupId, taskId('nxf'), 1, 'done'),
          ).kind,
        ).toBe('not_found');
        expect(
          world.store.write((uow) =>
            world.repos.tasks.recordNudge(uow, world.groupId, taskId('nxf')),
          ).kind,
        ).toBe('not_found');

        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.create(uow, task('n1f', world.groupId), groupLabel(world.groupId)),
            'a task',
          ),
        );
        world.store.write((uow) =>
          world.repos.tasks.setStatus(uow, world.groupId, created.id, created.version, 'skipped'),
        );
        expect(
          world.store.write((uow) =>
            world.repos.tasks.setStatus(uow, world.groupId, created.id, created.version, 'done'),
          ).kind,
        ).toBe('conflict');
      });
    });

    it('counts a nudge without a version', () => {
      withRepos((world) => {
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.create(uow, task('p1f', world.groupId), groupLabel(world.groupId)),
            'a task',
          ),
        );
        const nudged = world.store.write((uow) =>
          expectWritten(world.repos.tasks.recordNudge(uow, world.groupId, created.id), 'a nudge'),
        );
        // A nudge is something *we* did, not something a member changed — versioning it would make
        // the record of the nudge conflict with whatever the member was doing at the time.
        expect(nudged.nudgeCount).toBe(1);
        expect(nudged.version).toBe(created.version);
      });
    });

    it('does not find a task from another group, and refuses its label', () => {
      withRepos((world) => {
        const elsewhere = world.store.write((uow) =>
          expectWritten(
            world.repos.tasks.create(
              uow,
              task('q1f', world.otherGroupId, { groupId: world.otherGroupId }),
              groupLabel(world.otherGroupId),
            ),
            'a task elsewhere',
          ),
        );
        // A label in **this** group, so the eligible set is non-empty and the assertion is about
        // the `group_id` predicate rather than about `02` §3.7.1's empty-set early return. Before
        // this the group had only the *other* group's label, so `eligibleAll` was the empty set and
        // the read answered `1 = 0`: the test passed whether or not the scoping existed. Found by
        // the M1 exit gate's reviewer, and the harness now refuses to build such a set at all.
        world.store.write((uow) => world.repos.labels.intern(uow, groupLabel(world.groupId)));
        expect(
          world.repos.tasks.byId(world.groupId, elsewhere.id, eligibleAll(world)),
        ).toBeUndefined();
        expect(() =>
          world.store.write((uow) =>
            world.repos.tasks.create(
              uow,
              task('q2f', world.groupId),
              groupLabel(world.otherGroupId),
            ),
          ),
        ).toThrow(/another group/);
        expect(() =>
          world.store.write((uow) =>
            world.repos.tasks.postLedger(
              uow,
              {
                id: ledgerEntryId('q3f'),
                groupId: world.groupId,
                memberId: memberId('a'),
                kind: 'self_logged',
                points: 1,
                at: T0,
              },
              groupLabel(world.otherGroupId),
            ),
          ),
        ).toThrow(/another group/);
      });
    });
  });

  describe('query plans (M1-T19 AC)', { tags: ['db'] }, () => {
    it('reaches Q-CTX-7 and Q-CTX-7b and Q-FAIR-2 through their indexes', () => {
      withMembers((world, who) => {
        const first = who[0];
        if (first === undefined) throw new Error('fixture');
        seedTasks(world, first);
        analyze(world.db);

        // Q-CTX-7: a **partial** index on `status = 'open'`, so the predicate has to be in the
        // query for SQLite to consider it at all.
        expectIndexUsed(
          world.db,
          `SELECT * FROM tasks
            WHERE group_id = ? AND status = 'open' AND label_id IN (?)
            ORDER BY due_at IS NULL, due_at ASC, rid ASC LIMIT 50`,
          { table: 'tasks', index: 'tasks_open_due_idx', parameters: [world.groupId, 1] },
        );
        // Q-CTX-7b / Q-FAIR-1.
        expectIndexUsed(
          world.db,
          `SELECT * FROM tasks
            WHERE group_id = ? AND assignee_member_id = ? AND status IN ('proposed','open')
              AND label_id IN (?)
            LIMIT 50`,
          {
            table: 'tasks',
            index: 'tasks_assignee_idx',
            parameters: [world.groupId, first, 1],
          },
        );
      });
    });

    it('reaches the ledger window through ledger_group_member_at_idx', () => {
      withMembers((world, who) => {
        const first = who[0];
        if (first === undefined) throw new Error('fixture');
        world.store.write((uow) => {
          for (let index = 0; index < 400; index += 1) {
            world.repos.tasks.postLedger(
              uow,
              {
                id: ledgerEntryId(`w${index.toString(16)}f`),
                groupId: world.groupId,
                memberId: first as never,
                kind: 'self_logged',
                points: 1,
                at: at(index % 120),
              },
              groupLabel(world.groupId),
            );
          }
        });
        analyze(world.db);
        expectIndexUsed(
          world.db,
          `SELECT * FROM ledger_entries
            WHERE group_id = ? AND member_id = ? AND at BETWEEN ? AND ?
            ORDER BY at ASC, id ASC`,
          {
            table: 'ledger_entries',
            index: 'ledger_group_member_at_idx',
            parameters: [world.groupId, first, 0, DAY * 30],
          },
        );
      });
    });
  });
});
