/**
 * `labels.eligibility-equivalence.property` (`M1-T18`; `02` §3.2, `01` §7.2, invariant **I1**).
 *
 * ## What this proves
 *
 * Storage filters labeled reads with `label_id IN (eligible)`. `core`'s `canRead` is the single
 * source of truth about who may read what (`01` §7.2, `02` §3.2: "This is the only eligibility
 * mechanism in the plan"). Those are two different mechanisms, in two different languages, and
 * **I1 holds only if they agree exactly**.
 *
 * So the property is an equivalence, checked in both directions over generated worlds:
 *
 *  - every row the SQL filter returns, `canRead` admits — otherwise storage leaks;
 *  - every row `canRead` admits, the SQL filter returns — otherwise storage hides data from
 *    someone entitled to it, which is not a security failure but is a correctness one, and is the
 *    direction a filter that is "safe by being too strict" fails in.
 *
 * The oracle is `canRead` applied **row by row** in TypeScript. Deliberately not
 * `computeEligible` — that is the function under test on the other side of the comparison, and
 * using it as the oracle would make the property restate the implementation. This is the lesson
 * `M1-T16` recorded: a test that decides which values are "the same" using the code it checks
 * agrees by construction.
 *
 * ## Both tables, because the filter is written twice
 *
 * `messages.ts` and `memory.ts` each build their own `label_id IN (…)`, and `memory-search.ts`
 * builds four more in raw SQL. The AC asks for "memory + messages" for exactly that reason: one
 * proven filter says nothing about the other five.
 */
import {
  type Audience,
  computeEligible,
  type EligibleLabelSet,
  expectWritten,
  type GroupSnapshot,
  type Label,
  StubInformationFlow,
} from '@comvivo/core';
import type { LabelId, MemberId } from '@comvivo/shared';
import { fcConfig } from '@comvivo/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  conversationId,
  fingerprintFor,
  member,
  memoryId,
  messageId,
  person,
  T0,
  withRepos,
} from './testing/harness.js';

/** `01` §7.2's `canRead`, as the oracle. The thing the SQL filter has to agree with. */
const flow = StubInformationFlow;

describe('labels.eligibility-equivalence.property', { tags: ['prop', 'db'] }, () => {
  it('returns exactly the rows core canRead admits, for messages and memories', () => {
    withRepos((world) => {
      // Three real members, so an explicit audience can name a proper subset of the group.
      const members = world.store.write((uow) =>
        ['a', 'b', 'c'].map((tag) => {
          expectWritten(world.repos.persons.create(uow, person(tag)), `person ${tag}`);
          return expectWritten(
            world.repos.members.add(uow, member(tag, world.groupId)),
            `member ${tag}`,
          ).id;
        }),
      );
      const conversation = world.store.write((uow) =>
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
        ),
      ).id;

      /** Every reader set a row might carry, including the two that are easy to conflate. */
      const audiences: readonly Audience[] = [
        { kind: 'group', groupId: world.groupId },
        // An **explicit** list of everyone: the same people as `group`, and a different value.
        { kind: 'members', groupId: world.groupId, memberIds: members },
        { kind: 'members', groupId: world.groupId, memberIds: [members[0] as MemberId] },
        { kind: 'members', groupId: world.groupId, memberIds: members.slice(0, 2) as MemberId[] },
        { kind: 'members', groupId: world.groupId, memberIds: [members[2] as MemberId] },
        { kind: 'group', groupId: world.groupId, seats: [conversation] },
      ];

      const labels: Label[] = audiences.flatMap((readers, index) => [
        {
          groupId: world.groupId,
          readers,
          owner: index % 2 === 0 ? 'group' : (members[0] as MemberId),
          coOwners: [],
          sensitivity: 'normal',
          influence: 'none',
          untrusted: false,
        },
        // A second label on the same reader set, differing above it — so the property sees labels
        // that `canRead` treats identically and interning keeps apart.
        {
          groupId: world.groupId,
          readers,
          owner: 'group',
          coOwners: [],
          sensitivity: 'sensitive',
          influence: 'constraints',
          untrusted: true,
        },
      ]);

      // One message and one memory per label, so every label is exercised in both tables.
      const written = world.store.write((uow) =>
        labels.map((label, index) => {
          const tag = `e${index.toString(16)}f`;
          const message = expectWritten(
            world.repos.messages.insert(
              uow,
              {
                id: messageId(tag),
                groupId: world.groupId,
                conversationId: conversation,
                kind: 'member',
                senderMemberId: members[0],
                text: `message ${tag}`,
                sentAt: T0,
                receivedAt: T0,
              },
              label,
            ),
            `message ${tag}`,
          );
          const memory = expectWritten(
            world.repos.memories.insert(
              uow,
              {
                id: memoryId(tag),
                groupId: world.groupId,
                kind: 'fact',
                content: { kind: 'fact', attribute: 'a', value: tag, polarity: 'affirm' },
                statement: `fact ${tag}`,
                searchTerms: [tag],
                language: 'en',
                provenance: {
                  source: 'extraction',
                  sourceMessageIds: [],
                  windowKey: null,
                  extractor: null,
                  assertion: 'explicit',
                  assertedBy: 'system',
                  rawConfidence: null,
                  calibration: null,
                  confirmedBy: [],
                  derivedFrom: [],
                  turnId: null,
                },
                confidence: 0.9,
                status: 'active',
                validFrom: T0,
              },
              label,
              fingerprintFor(tag),
            ),
            `memory ${tag}`,
          );
          return { label, messageId: message.id, memoryId: memory.id, labelId: message.labelId };
        }),
      );

      const snapshot = world.repos.groups.snapshot(world.groupId);
      expect(snapshot).toBeDefined();
      if (snapshot === undefined) return;

      const labelsById = new Map<LabelId, Label>(
        written.map((row) => [row.labelId, row.label] as const),
      );
      let checked = 0;
      let admittedTotal = 0;

      fc.assert(
        fc.property(audienceArbitrary(world.groupId, members, conversation), (audience) => {
          const eligible: EligibleLabelSet = computeEligible(labelsById, audience, snapshot, flow);

          // The oracle: `canRead`, row by row, with no reference to the eligible set.
          const admitted = new Set(
            written
              .filter((row) => flow.canRead(row.label, audience, snapshot as GroupSnapshot))
              .map((row) => row.messageId),
          );
          const admittedMemories = new Set(
            written
              .filter((row) => flow.canRead(row.label, audience, snapshot as GroupSnapshot))
              .map((row) => row.memoryId),
          );

          const fromSql = new Set(
            world.repos.messages
              .window({ conversationId: conversation, limit: 200 }, eligible)
              .map((message) => message.id),
          );
          const memoriesFromSql = new Set(
            world.repos.memorySearch
              .recent({ groupId: world.groupId, limit: 200, maxState: 1, eligible })
              .map((item) => item.id),
          );

          // Both directions, as sets: no leak, and no over-strictness.
          expect([...fromSql].toSorted()).toEqual([...admitted].toSorted());
          expect([...memoriesFromSql].toSorted()).toEqual([...admittedMemories].toSorted());

          // And the other labeled reads agree with the same oracle.
          const hydratedMessages = new Set(
            world.repos.messages
              .hydrate(
                written.map((row) => row.messageId),
                eligible,
              )
              .map((message) => message.id),
          );
          expect([...hydratedMessages].toSorted()).toEqual([...admitted].toSorted());
          const hydratedMemories = new Set(
            world.repos.memorySearch
              .hydrate(
                written.map((row) => row.memoryId),
                eligible,
              )
              .map((item) => item.id),
          );
          expect([...hydratedMemories].toSorted()).toEqual([...admittedMemories].toSorted());

          checked += 1;
          admittedTotal += admitted.size;
        }),
        fcConfig(),
      );

      // Non-vacuity, in both directions. A generator that produced only audiences admitting
      // nothing would satisfy every assertion above over empty sets, and one that produced only
      // audiences admitting everything would never exercise the filter at all.
      expect(checked).toBeGreaterThan(20);
      expect(admittedTotal).toBeGreaterThan(0);
      expect(admittedTotal).toBeLessThan(checked * written.length);
    });
  });

  it('returns nothing for an audience that may read nothing, from every labeled read', () => {
    withRepos((world) => {
      const owner = world.store.write((uow) => {
        expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
        return expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member').id;
      });
      const conversation = world.store.write((uow) =>
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
        ),
      ).id;
      const label: Label = {
        groupId: world.groupId,
        readers: { kind: 'members', groupId: world.groupId, memberIds: [owner] },
        owner,
        coOwners: [],
        sensitivity: 'sensitive',
        influence: 'none',
        untrusted: false,
      };
      world.store.write((uow) => {
        world.repos.messages.insert(
          uow,
          {
            id: messageId('zf'),
            groupId: world.groupId,
            conversationId: conversation,
            kind: 'member',
            text: 'private',
            sentAt: T0,
            receivedAt: T0,
          },
          label,
        );
        world.repos.memories.insert(
          uow,
          {
            id: memoryId('zf'),
            groupId: world.groupId,
            kind: 'fact',
            content: { kind: 'fact', attribute: 'a', value: 'z', polarity: 'affirm' },
            statement: 'a private fact',
            searchTerms: ['private'],
            language: 'en',
            provenance: {
              source: 'extraction',
              sourceMessageIds: [],
              windowKey: null,
              extractor: null,
              assertion: 'explicit',
              assertedBy: 'system',
              rawConfidence: null,
              calibration: null,
              confirmedBy: [],
              derivedFrom: [],
              turnId: null,
            },
            confidence: 0.9,
            status: 'active',
            validFrom: T0,
          },
          label,
          fingerprintFor('zf'),
        );
      });

      const snapshot = world.repos.groups.snapshot(world.groupId);
      if (snapshot === undefined) throw new Error('fixture');
      // An empty eligible set, built the way the production path builds one: a flow that admits
      // nothing, not a hand-made empty object.
      const none = computeEligible(new Map(), { kind: 'group', groupId: world.groupId }, snapshot, {
        canRead: () => false,
      });
      expect(none.ids).toHaveLength(0);

      // Every labeled read, including the four in `memory-search.ts` that build their own `IN`
      // list in raw SQL — the case where a wrong empty-list rendering becomes "read everything".
      expect(
        world.repos.messages.window({ conversationId: conversation, limit: 10 }, none),
      ).toEqual([]);
      expect(world.repos.messages.hydrate([messageId('zf')], none)).toEqual([]);
      expect(
        world.repos.memorySearch.recent({
          groupId: world.groupId,
          limit: 10,
          maxState: 1,
          eligible: none,
        }),
      ).toEqual([]);
      expect(world.repos.memorySearch.hydrate([memoryId('zf')], none)).toEqual([]);
      expect(
        world.repos.memorySearch.text({
          groupId: world.groupId,
          query: 'private',
          mode: 'word',
          limit: 10,
          maxState: 1,
          eligible: none,
        }),
      ).toEqual([]);
      expect(
        world.repos.memorySearch.bySubjects({
          groupId: world.groupId,
          subjectRefs: [{ type: 'group' }],
          limit: 10,
          maxState: 1,
          eligible: none,
        }),
      ).toEqual([]);
      expect(
        world.repos.memorySearch.byEntities({
          groupId: world.groupId,
          entityIds: [],
          limit: 10,
          maxState: 1,
          eligible: none,
        }),
      ).toEqual([]);
      expect(
        world.repos.memorySearch.aliases({
          groupId: world.groupId,
          aliasNorms: ['x'],
          eligible: none,
        }),
      ).toEqual([]);
      // And the rows are there, so none of the above is vacuous.
      expect(
        world.repos.messagesUnfiltered.windowUnfiltered({
          conversationId: conversation,
          limit: 10,
        }),
      ).toHaveLength(1);
    });
  });
});

/** Audiences a context build could plausibly ask about, including the degenerate ones. */
function audienceArbitrary(
  groupId: Audience['groupId'],
  members: readonly MemberId[],
  seat: string,
): fc.Arbitrary<Audience> {
  return fc
    .record({
      kind: fc.constantFrom('group' as const, 'members' as const),
      memberIds: fc.subarray([...members], { minLength: 0 }),
      seats: fc.subarray([seat], { minLength: 0 }),
    })
    .map((parts) =>
      parts.kind === 'group'
        ? ({ kind: 'group', groupId, seats: parts.seats } satisfies Audience)
        : ({
            kind: 'members',
            groupId,
            memberIds: parts.memberIds,
            seats: parts.seats,
          } satisfies Audience),
    );
}
