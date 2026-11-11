/**
 * One row in every table an export reads (`02` §3.15).
 *
 * This exists for one test — `format.contract.int.test.ts` — and the reason it is worth a file of
 * its own is that the test it serves is the only proof that the eighteen sources *work*. A source
 * is a table, an ordering key and a mapper, and a mapper is called through a cast (`sources.ts`'s
 * `mapper`), so a source whose row shape and mapper disagree produces a record of `undefined`
 * fields and no type error at all. That happened during `M1-T28` and a test asserting on ids
 * passed anyway.
 *
 * So the fixture is deliberately **complete** rather than minimal: one row per source, written
 * through the repositories, so that "every record validates against its published schema" is a
 * statement about all of them and not about the two a smaller fixture happened to reach.
 *
 * The shapes match the fixtures in each repository's own contract test, which is where the required
 * fields are established.
 */
import { expectWritten, type Label } from '@comvivo/core';
import { internedId, type MemberId, type ReaderSetId, UTC } from '@comvivo/shared';
import {
  auditId,
  consentEventId,
  constitutionId,
  conversationId,
  decisionId,
  eventId,
  fingerprintFor,
  groupLabel,
  identityId,
  listId,
  listItemId,
  memberId,
  memoryItem,
  messageId,
  person,
  personId,
  planId,
  planStepId,
  pollId,
  proposalId,
  reminderId,
  T0,
  taskId,
  type World,
} from '../../repos/testing/harness.js';
import { privateConstraintPolicies } from '../../schema/governance.js';

/** The tag every seeded row shares, so a failure message says where the row came from. */
const TAG = 'xpf';

export interface Seeded {
  readonly label: Label;
  readonly memberId: MemberId;
  readonly personId: string;
  readonly readerSet: ReaderSetId;
}

/**
 * Seed one row per export source, and return what a caller needs to export it.
 *
 * Everything is written under **one group-readable label**, because this fixture is about the
 * record shapes; `member-scope.prop.int.test.ts` is where the filter is proven.
 */
export function seedEverySource(world: World): Seeded {
  const label = groupLabel(world.groupId);
  const convId = conversationId(TAG);

  world.store.write((uow) => {
    expectWritten(world.repos.persons.create(uow, person(TAG)), 'the person');
    expectWritten(
      world.repos.members.add(uow, {
        id: memberId(TAG),
        groupId: world.groupId,
        personId: personId(TAG),
        role: 'admin',
        status: 'active',
        joinedAt: T0,
      }),
      'the member',
    );
    expectWritten(
      world.repos.identities.create(uow, {
        id: identityId(TAG),
        channel: 'simulator',
        platformUserId: `u-${TAG}`,
        personId: personId(TAG),
        displayNameSnapshot: 'Ana',
      }),
      'the channel identity',
    );
    expectWritten(
      world.repos.conversations.create(uow, {
        id: convId,
        groupId: world.groupId,
        channel: 'simulator',
        platformChatId: `chat-${TAG}`,
        kind: 'group',
        boundAt: T0,
      }),
      'the conversation',
    );
    expectWritten(
      world.repos.messages.insert(
        uow,
        {
          id: messageId(TAG),
          groupId: world.groupId,
          conversationId: convId,
          kind: 'member',
          senderMemberId: memberId(TAG),
          text: 'one message',
          sentAt: T0,
          receivedAt: T0,
        },
        label,
      ),
      'the message',
    );
    expectWritten(
      world.repos.memories.insert(
        uow,
        memoryItem(TAG, world.groupId, { statement: 'a remembered fact' }),
        label,
        fingerprintFor(TAG),
      ),
      'the memory',
    );
    expectWritten(
      world.repos.calendar.create(
        uow,
        {
          id: eventId(TAG),
          groupId: world.groupId,
          title: 'an event',
          tz: UTC,
          startLocal: T0.toZonedDateTimeISO('UTC').toPlainDateTime().toString(),
          startAt: T0,
          busy: true,
          source: { kind: 'native' },
          icsUid: `${TAG}@export`,
          tzdataVersion: '2026b',
        },
        label,
      ),
      'the event',
    );
    expectWritten(
      world.repos.tasks.create(
        uow,
        { id: taskId(TAG), groupId: world.groupId, title: 'a task', due: { kind: 'none' } },
        label,
      ),
      'the task',
    );
    expectWritten(
      world.repos.lists.create(
        uow,
        { id: listId(TAG), groupId: world.groupId, name: 'a list' },
        label,
      ),
      'the list',
    );
    expectWritten(
      world.repos.lists.addItem(
        uow,
        {
          id: listItemId(TAG),
          listId: listId(TAG),
          groupId: world.groupId,
          text: 'an item',
          normalizedKey: `key-${TAG}`,
        },
        label,
      ),
      'the list item',
    );
    expectWritten(
      world.repos.polls.create(
        uow,
        {
          id: pollId(TAG),
          groupId: world.groupId,
          conversationId: convId,
          purpose: 'opinion',
          question: 'a question',
          options: [
            { id: 'o1', text: 'one', position: 0 },
            { id: 'o2', text: 'two', position: 1 },
          ],
          rule: 'plurality',
          quorum: { kind: 'none' },
          mode: 'buttons',
        },
        label,
      ),
      'the poll',
    );
    const plan = expectWritten(
      world.repos.plans.create(
        uow,
        { id: planId(TAG), groupId: world.groupId, title: 'a plan' },
        label,
      ),
      'the plan',
    );
    expectWritten(
      world.repos.plans.addStep(
        uow,
        { id: planStepId(TAG), planId: plan.id, groupId: world.groupId, title: 'a step' },
        label,
      ),
      'the plan step',
    );
    expectWritten(
      world.repos.decisions.record(
        uow,
        {
          id: decisionId(TAG),
          groupId: world.groupId,
          summary: 'a decision',
          decidedBy: { rule: 'informal', memberIds: [] },
          origin: 'explicit',
          decidedAt: T0,
          decidedTz: UTC,
        },
        label,
      ),
      'the decision',
    );
    expectWritten(
      world.repos.governance.adoptConstitution(
        uow,
        {
          id: constitutionId(TAG),
          groupId: world.groupId,
          yaml: 'version: one\n',
          charterText: 'The charter.',
          compiled: { rules: [] },
          compilerVersion: 'compile-1.0.0',
          adoptedVia: 'template',
          adoptedBy: 'system',
          adoptedAt: T0,
        },
        null,
      ),
      'the constitution version',
    );
    expectWritten(
      world.repos.governance.openProposal(
        uow,
        {
          id: proposalId(TAG),
          groupId: world.groupId,
          kind: 'amendment',
          payload: { diff: 'one' },
          rule: {
            method: 'vote',
            quorum: 2,
            threshold: { ratio: 0.66, cmp: 'gt' },
            deadline: T0.add({ hours: 24 }).toString(),
            minOpenUntil: T0.add({ hours: 1 }).toString(),
            tieBreak: 'status_quo',
            ballot: 'open',
          },
          electorate: [memberId(TAG)],
          proposerMemberId: memberId(TAG),
          openedAt: T0,
        },
        label,
      ),
      'the proposal',
    );
    expectWritten(
      world.repos.governance.recordConsent(uow, {
        id: consentEventId(TAG),
        memberId: memberId(TAG),
        groupId: world.groupId,
        fromState: 'unknown',
        toState: 'informed',
        via: 'chat',
        at: T0,
      }),
      'the consent event',
    );
    expectWritten(
      world.repos.audit.append(uow, {
        id: auditId(TAG),
        groupId: world.groupId,
        actor: { kind: 'system' },
        action: 'export.create',
        decision: {
          outcome: 'allow',
          reason: null,
          capability: 'export.run',
          constitutionVersionId: null,
        },
        details: { files: 1 },
        at: T0,
      }),
      'the audit event',
    );

    // A reminder's audience is a frozen reader set, and interning the label above made one. Read
    // the way `coordination.contract.test.ts` reads it — `M7` adds the reader-set repository.
    const readerSet = internedId(
      (world.db.prepare('SELECT id FROM reader_sets ORDER BY id LIMIT 1').get() as { id: number })
        .id,
      'reader_sets',
    );
    expectWritten(
      world.repos.reminders.create(
        uow,
        {
          id: reminderId(TAG),
          groupId: world.groupId,
          kind: 'group',
          text: 'a reminder',
          recipients: { kind: 'group', conversationId: convId },
          delivery: 'group',
          schedule: { kind: 'once', at: T0.toString() },
          anchor: 'fixed_zone',
          audienceReaderSetId: readerSet,
          tzdataVersion: '2026b',
          nextFireAt: T0,
        },
        label,
      ),
      'the reminder',
    );

    // No repository owns `private_constraint_policies` yet — `03` writes it at `M3` — so this one
    // row is inserted directly. The column is a validated `PrivateConstraintPolicySchema`, so the
    // value here is the same domain object a reader gets back.
    world.drizzle
      .insert(privateConstraintPolicies)
      .values({
        memberId: memberId(TAG),
        groupId: world.groupId,
        policy: {
          memberId: memberId(TAG),
          version: 1,
          kinds: {},
          allowStandingForSensitive: false,
          approvalTtlHours: 24,
          paused: false,
        },
        labelId: world.repos.labels.intern(uow, label),
        updatedAt: T0,
      })
      .run();
  });

  const readerSet = internedId(
    (world.db.prepare('SELECT id FROM reader_sets ORDER BY id LIMIT 1').get() as { id: number }).id,
    'reader_sets',
  );
  return { label, memberId: memberId(TAG), personId: personId(TAG), readerSet };
}
