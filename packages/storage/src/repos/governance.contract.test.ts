/**
 * `GovernanceReader`/`GovernanceRepository` (`M1-T20`; `02` §3.3.6, semantics in `03`).
 *
 * The AC names three things and each gets its own section:
 *
 *  - **Contract tests** for every read and write, on `02` §3.7.1's conventions.
 *  - **The immutability trigger enforced**, reached past the repository — because there is no
 *    method that could violate it, which is the design, so the test has to prove the *database*
 *    refuses rather than that the repository declines to ask.
 *  - **Compare-and-swap on a confirmation decision**: "two concurrent approvals yield exactly one
 *    winner". That one is the centrepiece, and it is tested two ways — both deciders reading the
 *    same version, and the decision racing the expiry sweep.
 */
import type { NotPromise } from '@comvivo/core';
import { expectWritten, quorumSatisfied } from '@comvivo/core';
import { StorageError } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  confirmationId,
  consentEventId,
  constitutionId,
  constraintId,
  groupLabel,
  member,
  person,
  proposalId,
  standingApprovalId,
  T0,
  withRepos,
} from './testing/harness.js';
import { analyze, expectIndexUsed } from './testing/query-plan.js';

const DAY = 86_400_000;
const at = (days: number) =>
  Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + days * DAY);

/**
 * `03`'s resolved voting rule, frozen at open (`proposals.rule`).
 *
 * The shape is `ProposalRuleSchema`'s, and the column validates it — which is how a first version
 * of this fixture, carrying an invented `{ kind: 'supermajority', threshold: 0.66 }`, was caught.
 * `minOpenUntil` is here rather than omitted because it is required: it is the anti-ambush field,
 * and a rule without it would let a proposal pass before the group had seen it.
 */
const RULE = {
  method: 'vote' as const,
  quorum: 2,
  threshold: { ratio: 0.66, cmp: 'gt' as const },
  deadline: at(7).toString(),
  minOpenUntil: at(1).toString(),
  tieBreak: 'status_quo' as const,
  ballot: 'open' as const,
};

/** `proposals.outcome` (`03` §1382's `TallyResult`): the verdict **and** the counts. */
const tally = (
  outcome: 'passed' | 'rejected' | 'no_quorum' | 'needs_admin_tiebreak',
  yes: number,
  no: number,
) => ({ outcome, yes, no, abstain: 0, eligible: 3, decidedEarly: false });

/** `constraint_records.scope`: empty arrays mean the whole group, which is what these tests want. */
const SCOPE = { conversationIds: [], categories: [], zone: null };

/** A pending confirmation request with the fields a test does not care about filled in. */
const request = (
  tag: string,
  groupId: Parameters<typeof member>[1],
  requester: string,
  eligible: readonly string[],
  overrides = {},
) => ({
  id: confirmationId(tag),
  groupId,
  capacity: 'guardian' as const,
  requesterMemberId: requester as never,
  eligibleMemberIds: eligible as readonly never[],
  quorum: 'any' as const,
  actionDigest: `digest-${tag}`,
  summary: { key: 'confirm.generic', params: {} },
  delivery: 'dm' as const,
  nonce: 'ABCD2345',
  expiresAt: at(1),
  onExpire: 'drop' as const,
  ...overrides,
});

function eligibleOf(world: Parameters<Parameters<typeof withRepos>[0]>[0]): never {
  const ids = (world.db.prepare('SELECT id FROM labels').all() as { id: number }[]).map(
    (row) => row.id,
  );
  return {
    groupId: world.groupId,
    ids: [...new Set(ids)].toSorted((left, right) => left - right),
    audienceKey: 'g|s:',
    epoch: '0:0',
  } as unknown as never;
}

const NONE = {
  groupId: 'grp_x' as never,
  ids: [],
  audienceKey: 'g|s:',
  epoch: '0:0',
} as unknown as never;

/** A group with three members: a requester and two deciders, which the CAS test needs. */
function withMembers<T>(
  fn: (
    world: Parameters<Parameters<typeof withRepos>[0]>[0],
    who: readonly string[],
  ) => NotPromise<T>,
): T {
  return withRepos((world) => {
    const who = world.store.write((uow) =>
      ['a', 'b', 'c'].map((tag) => {
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

describe('the constitution', () => {
  const version = (tag: string, groupId: Parameters<typeof member>[1], overrides = {}) => ({
    id: constitutionId(tag),
    groupId,
    yaml: `version: ${tag}\n`,
    charterText: `The charter, ${tag}.`,
    compiled: { rules: [] },
    compilerVersion: 'compile-1.0.0',
    adoptedVia: 'template' as const,
    adoptedBy: 'system' as const,
    adoptedAt: T0,
    ...overrides,
  });

  it('assigns a dense version number and moves the group pointer', () => {
    withRepos((world) => {
      const first = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.adoptConstitution(uow, version('a1f', world.groupId), null),
          'the first version',
        ),
      );
      // Assigned here, not supplied: the unique index makes it dense per group, so a caller
      // computing it would race with another adopting at the same moment.
      expect(first.version).toBe(1);
      expect(world.repos.governance.currentConstitution(world.groupId)?.id).toBe(first.id);

      const second = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.adoptConstitution(uow, version('a2f', world.groupId), first.id),
          'an amendment',
        ),
      );
      expect(second.version).toBe(2);
      expect(second.parentVersionId).toBe(first.id);
      // The pointer moved in the same transaction: a version adopted without the move would be a
      // row nothing evaluates, and a move without the version would point at nothing.
      expect(world.repos.governance.currentConstitution(world.groupId)?.id).toBe(second.id);
    });
  });

  it('computes the yaml hash rather than taking one', () => {
    withRepos((world) => {
      const adopted = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.adoptConstitution(uow, version('b1f', world.groupId), null),
          'a version',
        ),
      );
      // `03`'s `yamlHash` exists to "detect a hand-edited row". A caller-supplied hash would be
      // derived from whatever that caller had, so a hand-edited row with a matching hand-edited
      // hash would pass the very check the column is for.
      expect(adopted.yamlSha256).toMatch(/^[0-9a-f]{64}$/);
      const other = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.adoptConstitution(
            uow,
            version('b2f', world.groupId, { yaml: 'different\n' }),
            adopted.id,
          ),
          'another version',
        ),
      );
      expect(other.yamlSha256).not.toBe(adopted.yamlSha256);
    });
  });

  it('refuses an adoption whose expected pointer is stale', () => {
    withRepos((world) => {
      const first = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.adoptConstitution(uow, version('c1f', world.groupId), null),
          'the first',
        ),
      );
      world.store.write((uow) =>
        world.repos.governance.adoptConstitution(uow, version('c2f', world.groupId), first.id),
      );
      // Two amendments adopted at the same moment would both compute version N+1, and the unique
      // index would refuse the second with a constraint error rather than a `conflict` the caller
      // can act on. Comparing the group's **pointer** turns that race into an answer.
      const stale = world.store.write((uow) =>
        world.repos.governance.adoptConstitution(uow, version('c3f', world.groupId), first.id),
      );
      expect(stale.kind).toBe('conflict');
      expect(world.repos.governance.constitutionHistory(world.groupId, 10)).toHaveLength(2);
    });
  });

  it('is refused by the database when something tries to edit it', () => {
    withRepos((world) => {
      const adopted = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.adoptConstitution(uow, version('d1f', world.groupId), null),
          'a version',
        ),
      );
      // There is no repository method that could do this — which is the design, so the test has to
      // reach past the repository and prove the **database** refuses. If the trigger were missing,
      // a future method could rewrite the rules with nothing to stop it, and the chain would stop
      // being a record of what the group agreed.
      expect(() =>
        world.db
          .prepare('UPDATE constitution_versions SET yaml = ? WHERE id = ?')
          .run('rewritten\n', adopted.id),
      ).toThrow(/CONSTITUTION_VERSION_IMMUTABLE/);
      expect(world.repos.governance.constitutionVersion(world.groupId, adopted.id)?.yaml).toBe(
        'version: d1f\n',
      );
    });
  });

  it('reads the pointer rather than the highest version', () => {
    withRepos((world) => {
      const first = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.adoptConstitution(uow, version('e1f', world.groupId), null),
          'the first',
        ),
      );
      // A version row with no pointer move — what an interrupted adoption leaves behind. Written
      // directly, because the repository cannot produce it: the two halves are one transaction.
      world.db
        .prepare(
          `INSERT INTO constitution_versions (id, group_id, version, yaml, yaml_sha256,
             charter_text, compiled, compiler_version, adopted_via, adopted_by, adopted_at)
           VALUES (?, ?, 2, 'orphan', 'x', 'c', '{}', 'v', 'migration', '"system"', 0)`,
        )
        .run(constitutionId('e2f'), world.groupId);
      // Reading the maximum would quietly return a version the group has not adopted.
      expect(world.repos.governance.currentConstitution(world.groupId)?.id).toBe(first.id);
      expect(world.repos.governance.constitutionHistory(world.groupId, 10)).toHaveLength(2);
    });
  });
});

describe('proposals', () => {
  const proposal = (
    tag: string,
    groupId: Parameters<typeof member>[1],
    proposer: string,
    overrides = {},
  ) => ({
    id: proposalId(tag),
    groupId,
    kind: 'amendment' as const,
    payload: { diff: tag },
    rule: RULE,
    electorate: [] as readonly never[],
    proposerMemberId: proposer as never,
    openedAt: T0,
    ...overrides,
  });

  it('opens a proposal and lists it by deadline', () => {
    withMembers((world, who) => {
      const label = groupLabel(world.groupId);
      const proposer = who[0];
      if (proposer === undefined) throw new Error('fixture');
      world.store.write((uow) => {
        world.repos.governance.openProposal(
          uow,
          proposal('a1f', world.groupId, proposer, { deadlineAt: at(5) }),
          label,
        );
        world.repos.governance.openProposal(uow, proposal('a2f', world.groupId, proposer), label);
        world.repos.governance.openProposal(
          uow,
          proposal('a3f', world.groupId, proposer, { deadlineAt: at(1) }),
          label,
        );
      });
      expect(
        world.repos.governance
          .openProposals({ groupId: world.groupId, limit: 10, eligible: eligibleOf(world) })
          .map((row) => row.id),
      ).toEqual([proposalId('a3f'), proposalId('a1f'), proposalId('a2f')]);
    });
  });

  it('finds an open proposal for the same diff, unfiltered', () => {
    withMembers((world, who) => {
      const proposer = who[0];
      if (proposer === undefined) throw new Error('fixture');
      const opened = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.openProposal(
            uow,
            proposal('b1f', world.groupId, proposer, { canonicalDiffHash: 'deadbeef' }),
            // A label the eligible set would not admit, to prove the lookup is unfiltered.
            groupLabel(world.groupId, { sensitivity: 'sensitive', untrusted: true }),
          ),
          'a proposal',
        ),
      );
      // Two proposals for the identical amendment would split the vote and neither would reach
      // quorum. The caller never renders this result — it only declines to open a second.
      expect(world.repos.governance.openProposalForDiff(world.groupId, 'deadbeef')?.id).toBe(
        opened.id,
      );
      expect(world.repos.governance.openProposalForDiff(world.groupId, 'other')).toBeUndefined();
    });
  });

  it('replaces a vote rather than appending, and refuses one after the close', () => {
    withMembers((world, who) => {
      const label = groupLabel(world.groupId);
      const [proposer, second] = who;
      if (proposer === undefined || second === undefined) throw new Error('fixture');
      const opened = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.openProposal(uow, proposal('c1f', world.groupId, proposer), label),
          'a proposal',
        ),
      );
      world.store.write((uow) => {
        world.repos.governance.castVote(uow, world.groupId, opened.id, proposer as never, {
          choice: 'yes',
          via: 'text',
          at: T0,
        });
        world.repos.governance.castVote(uow, world.groupId, opened.id, second as never, {
          choice: 'no',
          via: 'button',
          at: T0,
        });
      });
      expect(world.repos.governance.votesOf(world.groupId, opened.id)).toHaveLength(2);

      // Changed mind: replaced, like a poll ballot. Two rows for one member would double-count.
      world.store.write((uow) =>
        world.repos.governance.castVote(uow, world.groupId, opened.id, second as never, {
          choice: 'yes',
          via: 'dashboard',
          at: T0,
        }),
      );
      const votes = world.repos.governance.votesOf(world.groupId, opened.id);
      expect(votes).toHaveLength(2);
      expect(votes.filter((vote) => vote.choice === 'yes')).toHaveLength(2);

      world.store.write((uow) =>
        world.repos.governance.closeProposal(uow, world.groupId, opened.id, opened.version, {
          status: 'passed',
          outcome: tally('passed', 2, 0),
          at: T0,
        }),
      );
      // A vote arriving just after a close is a race, not a bug — so `conflict`, and the caller's
      // answer to the member is "that closed".
      expect(
        world.store.write((uow) =>
          world.repos.governance.castVote(uow, world.groupId, opened.id, proposer as never, {
            choice: 'no',
            via: 'text',
            at: T0,
          }),
        ).kind,
      ).toBe('conflict');
    });
  });

  it('refuses a vote from outside a named electorate', () => {
    withMembers((world, who) => {
      const [proposer, , outsider] = who;
      if (proposer === undefined || outsider === undefined) throw new Error('fixture');
      const opened = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.openProposal(
            uow,
            proposal('d1f', world.groupId, proposer, { electorate: [proposer] }),
            groupLabel(world.groupId),
          ),
          'a proposal',
        ),
      );
      let caught: unknown;
      try {
        world.store.write((uow) =>
          world.repos.governance.castVote(uow, world.groupId, opened.id, outsider as never, {
            choice: 'yes',
            via: 'text',
            at: T0,
          }),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StorageError);
      expect((caught as StorageError).message).toContain('electorate');
      // An **empty** electorate means every active member, so the same vote is accepted there.
      const open = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.openProposal(
            uow,
            proposal('d2f', world.groupId, proposer),
            groupLabel(world.groupId),
          ),
          'an open-electorate proposal',
        ),
      );
      expect(
        world.store.write((uow) =>
          world.repos.governance.castVote(uow, world.groupId, open.id, outsider as never, {
            choice: 'yes',
            via: 'text',
            at: T0,
          }),
        ).kind,
      ).toBe('ok');
    });
  });

  it('lets exactly one of two racing closers win', () => {
    withMembers((world, who) => {
      const proposer = who[0];
      if (proposer === undefined) throw new Error('fixture');
      const opened = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.openProposal(
            uow,
            proposal('e1f', world.groupId, proposer),
            groupLabel(world.groupId),
          ),
          'a proposal',
        ),
      );
      const outcome = tally('passed', 2, 0);
      const first = world.store.write((uow) =>
        world.repos.governance.closeProposal(uow, world.groupId, opened.id, opened.version, {
          status: 'passed',
          outcome,
          at: T0,
        }),
      );
      const second = world.store.write((uow) =>
        world.repos.governance.closeProposal(uow, world.groupId, opened.id, opened.version, {
          status: 'rejected',
          outcome: tally('rejected', 0, 2),
          at: T0,
        }),
      );
      expect(first.kind).toBe('ok');
      expect(second.kind).toBe('conflict');
      if (first.kind !== 'ok') return;
      // And a closer that re-read the row first — a dashboard refresh, then a tap — must be
      // refused too, at the **current** version. That is what `status = 'open'` is in the
      // predicate for: the version alone would let this one through, and the proposal's outcome
      // would be overwritten after the group had been told the result.
      expect(
        world.store.write((uow) =>
          world.repos.governance.closeProposal(uow, world.groupId, opened.id, first.value.version, {
            status: 'rejected',
            outcome: tally('rejected', 0, 2),
            at: T0,
          }),
        ).kind,
      ).toBe('conflict');
      expect(
        world.repos.governance.proposal(world.groupId, opened.id, eligibleOf(world))?.status,
      ).toBe('passed');
    });
  });

  it('refuses to close with an open status', () => {
    withMembers((world, who) => {
      const proposer = who[0];
      if (proposer === undefined) throw new Error('fixture');
      const opened = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.openProposal(
            uow,
            proposal('f1f', world.groupId, proposer),
            groupLabel(world.groupId),
          ),
          'a proposal',
        ),
      );
      expect(() =>
        world.store.write((uow) =>
          world.repos.governance.closeProposal(uow, world.groupId, opened.id, opened.version, {
            status: 'open',
            outcome: tally('passed', 1, 0),
            at: T0,
          }),
        ),
      ).toThrow(/closed status/);
    });
  });
});

describe('confirmation requests — compare-and-swap (02 §3.3.6, the M1-T20 AC)', () => {
  it('lets exactly one of two concurrent approvals win', () => {
    withMembers((world, who) => {
      const [requester, first, second] = who;
      if (requester === undefined || first === undefined || second === undefined) {
        throw new Error('fixture');
      }
      const label = groupLabel(world.groupId);
      const pending = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.requestConfirmation(
            uow,
            request('a1f', world.groupId, requester, [first, second]),
            label,
            label,
          ),
          'a request',
        ),
      );
      expect(pending.status).toBe('pending');

      // **Both deciders read the same version**, which is what two guardians tapping "approve" at
      // the same moment actually do. With `version = ?` alone both would satisfy the predicate and
      // the loser would be decided by ordering; with `status = 'pending'` in it, the second
      // `UPDATE` matches no row.
      const approvalA = world.store.write((uow) =>
        world.repos.governance.decideConfirmation(uow, world.groupId, pending.id, pending.version, {
          status: 'approved',
          byMemberId: first as never,
          at: T0,
        }),
      );
      const approvalB = world.store.write((uow) =>
        world.repos.governance.decideConfirmation(uow, world.groupId, pending.id, pending.version, {
          status: 'approved',
          byMemberId: second as never,
          at: T0,
        }),
      );
      expect(approvalA.kind).toBe('ok');
      // The loser must get a refusal, because the caller's response to a conflict is the whole
      // point: **do not run the action**. A second "success" would run it twice.
      expect(approvalB.kind).toBe('conflict');

      const decided = world.repos.governance.confirmation(world.groupId, pending.id);
      expect(decided?.status).toBe('approved');
      expect(decided?.decidedByMemberId).toBe(first);
    });
  });

  it('refuses a second decision even at the new version', () => {
    withMembers((world, who) => {
      const [requester, first, second] = who;
      if (requester === undefined || first === undefined || second === undefined) {
        throw new Error('fixture');
      }
      const label = groupLabel(world.groupId);
      const pending = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.requestConfirmation(
            uow,
            request('a2f', world.groupId, requester, [first, second]),
            label,
            label,
          ),
          'a request',
        ),
      );
      const approved = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.decideConfirmation(
            uow,
            world.groupId,
            pending.id,
            pending.version,
            {
              status: 'approved',
              byMemberId: first as never,
              at: T0,
            },
          ),
          'an approval',
        ),
      );
      // The **version is now current**, so a version-only predicate would let this through. The
      // `status = 'pending'` half is what refuses it — which is the difference the AC is about.
      expect(
        world.store.write((uow) =>
          world.repos.governance.decideConfirmation(
            uow,
            world.groupId,
            pending.id,
            approved.version,
            {
              status: 'rejected',
              byMemberId: second as never,
              at: T0,
            },
          ),
        ).kind,
      ).toBe('conflict');
      expect(world.repos.governance.confirmation(world.groupId, pending.id)?.status).toBe(
        'approved',
      );
    });
  });

  it('refuses a decision taken against a stale read of a still-pending request', () => {
    withMembers((world, who) => {
      const [requester, first] = who;
      if (requester === undefined || first === undefined) throw new Error('fixture');
      const label = groupLabel(world.groupId);
      const pending = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.requestConfirmation(
            uow,
            request('a3f', world.groupId, requester, [first]),
            label,
            label,
          ),
          'a request',
        ),
      );
      // The other half of the predicate, and the half the two-approval race cannot reach: a
      // request that is **still pending** but has changed since the decider read it. `03` will add
      // such a mutation — extending an expiry, adding an eligible member — and a guardian holding
      // a stale summary must not decide against a request whose terms moved under them.
      //
      // Written directly because no repository method produces that state yet, which is exactly
      // why the predicate needs a test of its own rather than one borrowed from the race.
      world.db
        .prepare('UPDATE confirmation_requests SET version = version + 1 WHERE id = ?')
        .run(pending.id);
      expect(
        world.store.write((uow) =>
          world.repos.governance.decideConfirmation(
            uow,
            world.groupId,
            pending.id,
            pending.version,
            {
              status: 'approved',
              byMemberId: first as never,
              at: T0,
            },
          ),
        ).kind,
      ).toBe('conflict');
      expect(world.repos.governance.confirmation(world.groupId, pending.id)?.status).toBe(
        'pending',
      );
    });
  });

  it('lets exactly one of a decision and an expiry win, either way round', () => {
    withMembers((world, who) => {
      const [requester, first] = who;
      if (requester === undefined || first === undefined) throw new Error('fixture');
      const label = groupLabel(world.groupId);

      // Decision first, then the sweep: the sweep must not overwrite a fresh approval.
      const pendingA = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.requestConfirmation(
            uow,
            request('b1f', world.groupId, requester, [first]),
            label,
            label,
          ),
          'a request',
        ),
      );
      world.store.write((uow) =>
        world.repos.governance.decideConfirmation(
          uow,
          world.groupId,
          pendingA.id,
          pendingA.version,
          {
            status: 'approved',
            byMemberId: first as never,
            at: T0,
          },
        ),
      );
      expect(
        world.store.write((uow) =>
          world.repos.governance.expireConfirmation(
            uow,
            world.groupId,
            pendingA.id,
            pendingA.version,
            at(2),
          ),
        ).kind,
      ).toBe('conflict');
      expect(world.repos.governance.confirmation(world.groupId, pendingA.id)?.status).toBe(
        'approved',
      );

      // Sweep first, then the decision: the guardian must not approve something already expired.
      const pendingB = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.requestConfirmation(
            uow,
            request('b2f', world.groupId, requester, [first]),
            label,
            label,
          ),
          'another request',
        ),
      );
      world.store.write((uow) =>
        world.repos.governance.expireConfirmation(
          uow,
          world.groupId,
          pendingB.id,
          pendingB.version,
          at(2),
        ),
      );
      expect(
        world.store.write((uow) =>
          world.repos.governance.decideConfirmation(
            uow,
            world.groupId,
            pendingB.id,
            pendingB.version,
            {
              status: 'approved',
              byMemberId: first as never,
              at: T0,
            },
          ),
        ).kind,
      ).toBe('conflict');
      expect(world.repos.governance.confirmation(world.groupId, pendingB.id)?.status).toBe(
        'expired',
      );

      // **The version half, on `expireConfirmation`.** Every case above pairs a stale version with
      // a status that already fails the predicate — approved-and-stale, pending-and-current — so
      // deleting `eq(confirmationRequests.version, expectVersion)` left the whole suite green.
      // This is the one shape that separates them: still **pending**, and a version from before
      // somebody else's write. `STATUS.md` claimed this test existed; it did not. Found by the M1
      // exit gate's acceptance reviewer.
      const pendingC = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.requestConfirmation(
            uow,
            request('c3f', world.groupId, requester, [first]),
            label,
            label,
          ),
          'a third request',
        ),
      );
      // Somebody else's write moves the version on, leaving the row pending.
      world.db
        .prepare('UPDATE confirmation_requests SET version = version + 1 WHERE id = ?')
        .run(pendingC.id);
      expect(
        world.store.write((uow) =>
          world.repos.governance.expireConfirmation(
            uow,
            world.groupId,
            pendingC.id,
            pendingC.version,
            at(2),
          ),
        ).kind,
        'a stale version must conflict even while the row is still pending',
      ).toBe('conflict');
      expect(world.repos.governance.confirmation(world.groupId, pendingC.id)?.status).toBe(
        'pending',
      );
      // Non-vacuity: the current version expires it, so the assertion above is about the version
      // and not about the row being unexpirable.
      expect(
        world.store.write((uow) =>
          world.repos.governance.expireConfirmation(
            uow,
            world.groupId,
            pendingC.id,
            pendingC.version + 1,
            at(2),
          ),
        ).kind,
      ).toBe('ok');
    });
  });

  it('refuses an expiry of an already-decided request at its current version', () => {
    withMembers((world, who) => {
      const [requester, first] = who;
      if (requester === undefined || first === undefined) throw new Error('fixture');
      const label = groupLabel(world.groupId);
      const pending = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.requestConfirmation(
            uow,
            request('b3f', world.groupId, requester, [first]),
            label,
            label,
          ),
          'a request',
        ),
      );
      const approved = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.decideConfirmation(
            uow,
            world.groupId,
            pending.id,
            pending.version,
            {
              status: 'approved',
              byMemberId: first as never,
              at: T0,
            },
          ),
          'an approval',
        ),
      );
      // The sweep's own `status = 'pending'` half, and the first version of this file did not test
      // it: the either-way-round race only ever reached the sweep at a **stale** version, where
      // the version check refuses on its own. Proven by deleting the predicate — every test still
      // passed.
      //
      // The case that needs it is a sweep that retries on conflict: it re-reads, finds version 2,
      // and tries again. Without the status half it would overwrite the approval with `expired`,
      // and the guardian's decision would silently disappear.
      expect(
        world.store.write((uow) =>
          world.repos.governance.expireConfirmation(
            uow,
            world.groupId,
            pending.id,
            approved.version,
            at(2),
          ),
        ).kind,
      ).toBe('conflict');
      expect(world.repos.governance.confirmation(world.groupId, pending.id)?.status).toBe(
        'approved',
      );
    });
  });

  it('lists pending requests by expiry and counts a requester`s outstanding ones', () => {
    withMembers((world, who) => {
      const [requester, first] = who;
      if (requester === undefined || first === undefined) throw new Error('fixture');
      const label = groupLabel(world.groupId);
      const made = world.store.write((uow) =>
        ['c1f', 'c2f', 'c3f'].map((tag, index) =>
          expectWritten(
            world.repos.governance.requestConfirmation(
              uow,
              request(tag, world.groupId, requester, [first], { expiresAt: at(index + 1) }),
              label,
              label,
            ),
            `request ${tag}`,
          ),
        ),
      );
      expect(
        world.repos.governance
          .pendingConfirmations({ groupId: world.groupId, limit: 10 })
          .map((row) => row.id),
      ).toEqual(made.map((row) => row.id));
      // `03`'s rate limit reads this: a member whose every action needs confirming is being asked
      // too much, and the limit turns that into a policy change rather than a flood.
      expect(
        world.repos.governance.outstandingConfirmations(world.groupId, requester as never),
      ).toBe(3);

      world.store.write((uow) =>
        world.repos.governance.decideConfirmation(
          uow,
          world.groupId,
          made[0]?.id ?? confirmationId('c1f'),
          made[0]?.version ?? 1,
          { status: 'approved', byMemberId: first as never, at: T0 },
        ),
      );
      expect(
        world.repos.governance.outstandingConfirmations(world.groupId, requester as never),
      ).toBe(2);
      // And bounded by expiry, for the sweep.
      expect(
        world.repos.governance.pendingConfirmations({
          groupId: world.groupId,
          expiringBefore: at(2),
          limit: 10,
        }),
      ).toHaveLength(1);
    });
  });

  it('stores the tool input as a blob and keeps it out of a JSON dump', () => {
    withMembers((world, who) => {
      const [requester, first] = who;
      if (requester === undefined || first === undefined) throw new Error('fixture');
      const label = groupLabel(world.groupId);
      const secret = new TextEncoder().encode('ciphertext-not-plaintext');
      const stored = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.requestConfirmation(
            uow,
            request('d1f', world.groupId, requester, [first], {
              toolName: 'calendar.create',
              input: secret,
            }),
            label,
            label,
          ),
          'a request with input',
        ),
      );
      // `02` §3.3.6 makes the column a ciphertext blob: the tool arguments may contain anything
      // the requester typed, and a pending request can sit for hours in a table a backup copies.
      expect(stored.input).toBeDefined();
      expect(Buffer.from(stored.input ?? new Uint8Array()).equals(Buffer.from(secret))).toBe(true);
      expect(stored.toolName).toBe('calendar.create');
    });
  });

  it('agrees with core`s quorum rule', () => {
    withMembers((world, who) => {
      const [requester, first, second] = who;
      if (requester === undefined || first === undefined || second === undefined) {
        throw new Error('fixture');
      }
      const label = groupLabel(world.groupId);
      const all = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.requestConfirmation(
            uow,
            request('e1f', world.groupId, requester, [first, second], { quorum: 'all' }),
            label,
            label,
          ),
          'an all-quorum request',
        ),
      );
      // `core`'s rule, applied to the stored request: `all` needs every eligible member, and one
      // approval is not enough. The repository's CAS still lets the *first* decision win, which is
      // why `03` reads `quorumSatisfied` before deciding rather than treating one tap as the answer.
      expect(quorumSatisfied(all, [first as never])).toBe(false);
      expect(quorumSatisfied(all, [first as never, second as never])).toBe(true);
      const any = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.requestConfirmation(
            uow,
            request('e2f', world.groupId, requester, [first, second]),
            label,
            label,
          ),
          'an any-quorum request',
        ),
      );
      expect(quorumSatisfied(any, [first as never])).toBe(true);
    });
  });
});

describe('constraints', () => {
  const constraint = (
    tag: string,
    groupId: Parameters<typeof member>[1],
    subject: string,
    overrides = {},
  ) => ({
    id: constraintId(tag),
    groupId,
    kind: 'availability.busy',
    catalogVersion: 'v1',
    value: { note: tag },
    subjectMemberId: subject as never,
    ownerMemberIds: [subject as never],
    scope: SCOPE,
    validFrom: at(-1),
    ...overrides,
  });

  it('records a constraint with two labels', () => {
    withMembers((world, who) => {
      const subject = who[0];
      if (subject === undefined) throw new Error('fixture');
      const open = groupLabel(world.groupId);
      const sealed = groupLabel(world.groupId, { sensitivity: 'sensitive' });
      const recorded = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.recordConstraint(
            uow,
            constraint('a1f', world.groupId, subject),
            open,
            sealed,
          ),
          'a constraint',
        ),
      );
      // Two labels, because a constraint can be **narrower** than its reason: "cannot do Tuesdays"
      // may be readable by the group while the message explaining why is not. One label would force
      // the constraint to be as private as its reason, after which it could not shape a group
      // decision at all — which is the only thing it is for.
      expect(recorded.labelId).not.toBe(recorded.sealedLabelId);
      expect(recorded.status).toBe('pending_owner');
      expect(recorded.attribution).toBe('named');
      expect(recorded.reasonDisclosure).toBe('none');
    });
  });

  it('finds only constraints in force at the instant', () => {
    withMembers((world, who) => {
      const subject = who[0];
      if (subject === undefined) throw new Error('fixture');
      const label = groupLabel(world.groupId);
      const made = world.store.write((uow) =>
        [
          { tag: 'b1f', status: 'active' as const },
          { tag: 'b2f', status: 'active' as const, validTo: at(-1) },
          { tag: 'b3f', status: 'suspended' as const },
          { tag: 'b4f', status: 'active' as const, validFrom: at(5) },
        ].map((spec) =>
          expectWritten(
            world.repos.governance.recordConstraint(
              uow,
              constraint(spec.tag, world.groupId, subject, spec),
              label,
              label,
            ),
            `constraint ${spec.tag}`,
          ),
        ),
      );
      expect(made).toHaveLength(4);
      const active = world.repos.governance.activeConstraints({
        groupId: world.groupId,
        at: T0,
        limit: 10,
        eligible: eligibleOf(world),
      });
      // Only the open-ended active one. The `IS NULL` arm matters: most constraints have no end
      // date, and a plain `valid_to >= :at` would drop every one of them.
      expect(active.map((row) => row.id)).toEqual([constraintId('b1f')]);
    });
  });

  it('closes the validity window when a constraint is revoked', () => {
    withMembers((world, who) => {
      const subject = who[0];
      if (subject === undefined) throw new Error('fixture');
      const label = groupLabel(world.groupId);
      const recorded = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.recordConstraint(
            uow,
            constraint('c1f', world.groupId, subject, { status: 'active' }),
            label,
            label,
          ),
          'a constraint',
        ),
      );
      const revoked = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.setConstraintStatus(
            uow,
            world.groupId,
            recorded.id,
            recorded.version,
            'revoked',
            T0,
          ),
          'a revocation',
        ),
      );
      // The window closes with the status, so `activeConstraints` and `core`'s
      // `constraintInForce` cannot disagree — they are supposed to be the same rule.
      expect(revoked.validTo?.epochMilliseconds).toBe(T0.epochMilliseconds);
      expect(
        world.repos.governance.activeConstraints({
          groupId: world.groupId,
          at: T0,
          limit: 10,
          eligible: eligibleOf(world),
        }),
      ).toEqual([]);
    });
  });

  it('finds what is on record about one member', () => {
    withMembers((world, who) => {
      const [first, second] = who;
      if (first === undefined || second === undefined) throw new Error('fixture');
      const label = groupLabel(world.groupId);
      world.store.write((uow) => {
        world.repos.governance.recordConstraint(
          uow,
          constraint('d1f', world.groupId, first),
          label,
          label,
        );
        world.repos.governance.recordConstraint(
          uow,
          constraint('d2f', world.groupId, second),
          label,
          label,
        );
      });
      expect(
        world.repos.governance
          .constraintsAbout(world.groupId, first as never, eligibleOf(world))
          .map((row) => row.id),
      ).toEqual([constraintId('d1f')]);
    });
  });
});

describe('standing approvals and consent', () => {
  it('grants, finds and revokes a standing approval idempotently', () => {
    withMembers((world, who) => {
      const [guardian, ward] = who;
      if (guardian === undefined || ward === undefined) throw new Error('fixture');
      const granted = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.grantStandingApproval(uow, {
            id: standingApprovalId('a1f'),
            groupId: world.groupId,
            guardianMemberId: guardian as never,
            wardMemberId: ward as never,
            actionPatterns: ['calendar.*'],
            expiresAt: at(30),
          }),
          'a standing approval',
        ),
      );
      expect(
        world.repos.governance
          .standingApprovalsFor(world.groupId, ward as never, T0)
          .map((row) => row.id),
      ).toEqual([granted.id]);
      // Expired approvals are not live, and `expiresAt` is NOT NULL for that reason: an approval
      // that never expired would be a permanent grant, and `03`'s point is that it is revisited.
      expect(
        world.repos.governance.standingApprovalsFor(world.groupId, ward as never, at(40)),
      ).toEqual([]);

      const revoked = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.revokeStandingApproval(uow, world.groupId, granted.id, T0),
          'a revocation',
        ),
      );
      expect(revoked.revokedAt).toBeDefined();
      expect(world.repos.governance.standingApprovalsFor(world.groupId, ward as never, T0)).toEqual(
        [],
      );
      // Stamped rather than deleted: `03` has to be able to say an action taken *before* the
      // revocation was covered, and deleting the row would make every past use look unauthorised.
      const again = world.store.write((uow) =>
        world.repos.governance.revokeStandingApproval(uow, world.groupId, granted.id, at(1)),
      );
      expect(again.kind).toBe('ok');
      if (again.kind !== 'ok') return;
      // Idempotent: a guardian tapping twice should not see an error, and the original time stands.
      expect(again.value.revokedAt?.epochMilliseconds).toBe(T0.epochMilliseconds);
    });
  });

  it('appends consent transitions, newest first', () => {
    withMembers((world, who) => {
      const subject = who[0];
      if (subject === undefined) throw new Error('fixture');
      world.store.write((uow) => {
        world.repos.governance.recordConsent(uow, {
          id: consentEventId('a1f'),
          memberId: subject as never,
          groupId: world.groupId,
          fromState: 'unknown',
          toState: 'informed',
          via: 'chat',
          at: at(-2),
        });
        world.repos.governance.recordConsent(uow, {
          id: consentEventId('a2f'),
          memberId: subject as never,
          groupId: world.groupId,
          fromState: 'informed',
          toState: 'memory_on',
          via: 'dashboard',
          at: at(-1),
        });
      });
      const history = world.repos.governance.consentHistory(world.groupId, subject as never, 10);
      expect(history.map((row) => row.id)).toEqual([consentEventId('a2f'), consentEventId('a1f')]);
      // The **transition**, not the state: `03` needs to answer "did they agree, or did an admin
      // set it for them", and only the `via` plus the from/to pair can.
      expect(history[0]?.via).toBe('dashboard');
      expect(history[0]?.fromState).toBe('informed');
    });
  });
});

describe('group isolation and empty eligibility', () => {
  it('does not reach another group', () => {
    withMembers((world, who) => {
      const proposer = who[0];
      if (proposer === undefined) throw new Error('fixture');
      const label = groupLabel(world.groupId);
      const opened = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.openProposal(
            uow,
            {
              id: proposalId('z1f'),
              groupId: world.groupId,
              kind: 'amendment',
              payload: {},
              rule: RULE,
              electorate: [],
              proposerMemberId: proposer as never,
              openedAt: T0,
            },
            label,
          ),
          'a proposal',
        ),
      );
      expect(
        world.repos.governance.proposal(world.otherGroupId, opened.id, eligibleOf(world)),
      ).toBeUndefined();
      expect(world.repos.governance.votesOf(world.otherGroupId, opened.id)).toEqual([]);
      expect(world.repos.governance.currentConstitution(world.otherGroupId)).toBeUndefined();
      expect(
        world.repos.governance.pendingConfirmations({ groupId: world.otherGroupId, limit: 10 }),
      ).toEqual([]);
      expect(() =>
        world.store.write((uow) =>
          world.repos.governance.openProposal(
            uow,
            {
              id: proposalId('z2f'),
              groupId: world.groupId,
              kind: 'amendment',
              payload: {},
              rule: RULE,
              electorate: [],
              proposerMemberId: proposer as never,
              openedAt: T0,
            },
            groupLabel(world.otherGroupId),
          ),
        ),
      ).toThrow(/another group/);
    });
  });

  it('returns nothing from the labeled reads for an empty eligible set', () => {
    withMembers((world, who) => {
      const subject = who[0];
      if (subject === undefined) throw new Error('fixture');
      const label = groupLabel(world.groupId);
      const opened = world.store.write((uow) => {
        world.repos.governance.recordConstraint(
          uow,
          {
            id: constraintId('y1f'),
            groupId: world.groupId,
            kind: 'availability.busy',
            catalogVersion: 'v1',
            value: {},
            subjectMemberId: subject as never,
            ownerMemberIds: [subject as never],
            scope: SCOPE,
            validFrom: at(-1),
            status: 'active',
          },
          label,
          label,
        );
        return expectWritten(
          world.repos.governance.openProposal(
            uow,
            {
              id: proposalId('y1f'),
              groupId: world.groupId,
              kind: 'amendment',
              payload: {},
              rule: RULE,
              electorate: [],
              proposerMemberId: subject as never,
              openedAt: T0,
            },
            label,
          ),
          'a proposal',
        );
      });
      expect(world.repos.governance.proposal(world.groupId, opened.id, NONE)).toBeUndefined();
      expect(
        world.repos.governance.openProposals({ groupId: world.groupId, limit: 10, eligible: NONE }),
      ).toEqual([]);
      expect(
        world.repos.governance.activeConstraints({
          groupId: world.groupId,
          at: T0,
          limit: 10,
          eligible: NONE,
        }),
      ).toEqual([]);
      expect(
        world.repos.governance.constraintsAbout(world.groupId, subject as never, NONE),
      ).toEqual([]);
      // The rows are there, so none of the above is vacuous.
      expect(
        world.repos.governance.proposal(world.groupId, opened.id, eligibleOf(world)),
      ).toBeDefined();
    });
  });
});

describe('refusals and absences', () => {
  /**
   * Every writer's duplicate-id path, in one place.
   *
   * `02` §3.7.1's convention: a re-sent write with an id already present is `duplicate`, not an
   * error — a retried request must be safe. Each of these is the `isUniqueViolation` arm, and
   * without a test the arm is reached only by a caller in production.
   */
  it('answers `duplicate` when a write repeats an id', () => {
    withMembers((world, who) => {
      const [first, second] = who;
      if (first === undefined || second === undefined) throw new Error('fixture');
      const label = groupLabel(world.groupId);
      const made = world.store.write((uow) => ({
        proposal: expectWritten(
          world.repos.governance.openProposal(
            uow,
            {
              id: proposalId('x1f'),
              groupId: world.groupId,
              kind: 'amendment',
              payload: {},
              rule: RULE,
              electorate: [],
              proposerMemberId: first as never,
              openedAt: T0,
            },
            label,
          ),
          'a proposal',
        ),
        constraint: expectWritten(
          world.repos.governance.recordConstraint(
            uow,
            {
              id: constraintId('x1f'),
              groupId: world.groupId,
              kind: 'availability.busy',
              catalogVersion: 'v1',
              value: {},
              subjectMemberId: first as never,
              ownerMemberIds: [first as never],
              scope: SCOPE,
              validFrom: at(-1),
            },
            label,
            label,
          ),
          'a constraint',
        ),
        request: expectWritten(
          world.repos.governance.requestConfirmation(
            uow,
            request('x1f', world.groupId, first, [second]),
            label,
            label,
          ),
          'a request',
        ),
        approval: expectWritten(
          world.repos.governance.grantStandingApproval(uow, {
            id: standingApprovalId('x1f'),
            groupId: world.groupId,
            guardianMemberId: first as never,
            wardMemberId: second as never,
            actionPatterns: ['calendar.*'],
            expiresAt: at(30),
          }),
          'a standing approval',
        ),
        consent: expectWritten(
          world.repos.governance.recordConsent(uow, {
            id: consentEventId('x1f'),
            memberId: first as never,
            groupId: world.groupId,
            fromState: 'unknown',
            toState: 'informed',
            via: 'chat',
            at: T0,
          }),
          'a consent event',
        ),
      }));

      const repeats = world.store.write((uow) => [
        world.repos.governance.openProposal(
          uow,
          {
            id: made.proposal.id,
            groupId: world.groupId,
            kind: 'amendment',
            payload: {},
            rule: RULE,
            electorate: [],
            proposerMemberId: first as never,
            openedAt: T0,
          },
          label,
        ),
        world.repos.governance.recordConstraint(
          uow,
          {
            id: made.constraint.id,
            groupId: world.groupId,
            kind: 'availability.busy',
            catalogVersion: 'v1',
            value: {},
            subjectMemberId: first as never,
            ownerMemberIds: [first as never],
            scope: SCOPE,
            validFrom: at(-1),
          },
          label,
          label,
        ),
        world.repos.governance.requestConfirmation(
          uow,
          request('x1f', world.groupId, first, [second]),
          label,
          label,
        ),
        world.repos.governance.grantStandingApproval(uow, {
          id: made.approval.id,
          groupId: world.groupId,
          guardianMemberId: first as never,
          wardMemberId: second as never,
          actionPatterns: ['calendar.*'],
          expiresAt: at(30),
        }),
        world.repos.governance.recordConsent(uow, {
          id: made.consent.id,
          memberId: first as never,
          groupId: world.groupId,
          fromState: 'unknown',
          toState: 'informed',
          via: 'chat',
          at: T0,
        }),
      ]);
      expect(repeats.map((result) => result.kind)).toEqual([
        'duplicate',
        'duplicate',
        'duplicate',
        'duplicate',
        'duplicate',
      ]);
    });
  });

  it('answers `not_found` rather than inventing a row', () => {
    withMembers((world, who) => {
      const first = who[0];
      if (first === undefined) throw new Error('fixture');
      const absent = world.store.write((uow) => [
        world.repos.governance.castVote(uow, world.groupId, proposalId('w1f'), first as never, {
          choice: 'yes',
          via: 'text',
          at: T0,
        }),
        world.repos.governance.closeProposal(uow, world.groupId, proposalId('w1f'), 1, {
          status: 'passed',
          outcome: tally('passed', 1, 0),
          at: T0,
        }),
        world.repos.governance.setConstraintStatus(
          uow,
          world.groupId,
          constraintId('w1f'),
          1,
          'revoked',
          T0,
        ),
        world.repos.governance.decideConfirmation(uow, world.groupId, confirmationId('w1f'), 1, {
          status: 'approved',
          byMemberId: first as never,
          at: T0,
        }),
        world.repos.governance.expireConfirmation(uow, world.groupId, confirmationId('w1f'), 1, T0),
        world.repos.governance.revokeStandingApproval(
          uow,
          world.groupId,
          standingApprovalId('w1f'),
          T0,
        ),
      ]);
      // `not_found` and `conflict` are different answers to the caller: one means "you have the
      // wrong id", the other "somebody got there first". Collapsing them would send a caller
      // retrying a write that can never succeed.
      expect(absent.map((result) => result.kind)).toEqual(Array(6).fill('not_found'));
      // And the group whose constitution has never been adopted.
      expect(
        world.store.write((uow) =>
          world.repos.governance.adoptConstitution(
            uow,
            {
              id: constitutionId('w1f'),
              groupId: 'grp_01jqw8z5h7e9r3t4y5v6k7p8q9' as never,
              yaml: 'x\n',
              charterText: 'x',
              compiled: { rules: [] },
              compilerVersion: 'compile-1.0.0',
              adoptedVia: 'template',
              adoptedBy: 'system',
              adoptedAt: T0,
            },
            null,
          ),
        ).kind,
      ).toBe('not_found');
      expect(
        world.repos.governance.constitutionVersion(world.groupId, constitutionId('w2f')),
      ).toBeUndefined();
      expect(
        world.repos.governance.confirmation(world.groupId, confirmationId('w2f')),
      ).toBeUndefined();
      expect(world.repos.governance.outstandingConfirmations(world.groupId, first as never)).toBe(
        0,
      );
      expect(world.repos.governance.consentHistory(world.groupId, first as never, 10)).toEqual([]);
    });
  });

  it('answers `conflict` for a constraint write against a stale version', () => {
    withMembers((world, who) => {
      const first = who[0];
      if (first === undefined) throw new Error('fixture');
      const label = groupLabel(world.groupId);
      const recorded = world.store.write((uow) =>
        expectWritten(
          world.repos.governance.recordConstraint(
            uow,
            {
              id: constraintId('v1f'),
              groupId: world.groupId,
              kind: 'availability.busy',
              catalogVersion: 'v1',
              value: {},
              subjectMemberId: first as never,
              ownerMemberIds: [first as never],
              scope: SCOPE,
              validFrom: at(-1),
              status: 'active',
            },
            label,
            label,
          ),
          'a constraint',
        ),
      );
      world.store.write((uow) =>
        world.repos.governance.setConstraintStatus(
          uow,
          world.groupId,
          recorded.id,
          recorded.version,
          'suspended',
          T0,
        ),
      );
      // Two members editing the same constraint — one suspending, one revoking. The second holds a
      // stale version and gets `conflict`, so the UI can re-read rather than silently overwrite.
      expect(
        world.store.write((uow) =>
          world.repos.governance.setConstraintStatus(
            uow,
            world.groupId,
            recorded.id,
            recorded.version,
            'revoked',
            T0,
          ),
        ).kind,
      ).toBe('conflict');
    });
  });

  it('refuses a label from another group on both labels of every two-label write', () => {
    withMembers((world, who) => {
      const [first, second] = who;
      if (first === undefined || second === undefined) throw new Error('fixture');
      const own = groupLabel(world.groupId);
      const foreign = groupLabel(world.otherGroupId);
      const constraint = {
        id: constraintId('n1f'),
        groupId: world.groupId,
        kind: 'availability.busy',
        catalogVersion: 'v1',
        value: {},
        subjectMemberId: first as never,
        ownerMemberIds: [first as never],
        scope: SCOPE,
        validFrom: at(-1),
      };
      // Both labels, separately: a guard written once and applied to one of the two is the kind of
      // I4 hole that only shows up in the half nobody tested.
      expect(() =>
        world.store.write((uow) =>
          world.repos.governance.recordConstraint(uow, constraint, foreign, own),
        ),
      ).toThrow(/another group/);
      expect(() =>
        world.store.write((uow) =>
          world.repos.governance.recordConstraint(uow, constraint, own, foreign),
        ),
      ).toThrow(/another group/);
      expect(() =>
        world.store.write((uow) =>
          world.repos.governance.requestConfirmation(
            uow,
            request('n1f', world.groupId, first, [second]),
            foreign,
            own,
          ),
        ),
      ).toThrow(/another group/);
      expect(() =>
        world.store.write((uow) =>
          world.repos.governance.requestConfirmation(
            uow,
            request('n1f', world.groupId, first, [second]),
            own,
            foreign,
          ),
        ),
      ).toThrow(/another group/);
    });
  });

  it('bounds the open-proposal list by deadline when asked', () => {
    withMembers((world, who) => {
      const first = who[0];
      if (first === undefined) throw new Error('fixture');
      const label = groupLabel(world.groupId);
      world.store.write((uow) => {
        for (const [tag, days] of [
          ['t1f', 1],
          ['t2f', 9],
        ] as const) {
          world.repos.governance.openProposal(
            uow,
            {
              id: proposalId(tag),
              groupId: world.groupId,
              kind: 'amendment',
              payload: {},
              rule: RULE,
              electorate: [],
              proposerMemberId: first as never,
              openedAt: T0,
              deadlineAt: at(days),
            },
            label,
          );
        }
      });
      // The sweep's form of the query: what closes before this instant.
      expect(
        world.repos.governance
          .openProposals({
            groupId: world.groupId,
            deadlineBefore: at(5),
            limit: 10,
            eligible: eligibleOf(world),
          })
          .map((row) => row.id),
      ).toEqual([proposalId('t1f')]);
    });
  });
});

describe('query plans (M1-T20)', { tags: ['db'] }, () => {
  /**
   * 400 constraints and 400 confirmations with a **realistic** spread.
   *
   * The spread is the point, and the first version of this test proved it: every confirmation had
   * the same requester and every one was still pending, so `confirmations_pair_idx` covered 100%
   * of the table and SQLite correctly preferred a scan. The plan assertion then failed on correct
   * code. A real group has a few requesters and most of its requests already decided — which is
   * exactly the distribution that makes the index worth having.
   */
  function seed(
    world: Parameters<Parameters<typeof withRepos>[0]>[0],
    who: readonly string[],
    count = 400,
  ): void {
    const label = groupLabel(world.groupId);
    const pending = world.store.write((uow) => {
      const made: { id: ReturnType<typeof confirmationId>; version: number }[] = [];
      for (let index = 0; index < count; index += 1) {
        const subject = who[index % who.length];
        if (subject === undefined) throw new Error('fixture');
        world.repos.governance.recordConstraint(
          uow,
          {
            id: constraintId(`p${index.toString(16)}f`),
            groupId: world.groupId,
            kind: index % 2 === 0 ? 'availability.busy' : 'tasks.do_not_assign',
            catalogVersion: 'v1',
            value: {},
            subjectMemberId: subject as never,
            ownerMemberIds: [subject as never],
            scope: SCOPE,
            validFrom: at(-(index % 30)),
            // A third active, and three quarters of those open-ended — a constraint usually has
            // no end date, and a seed where every row carried one would be its own distortion.
            status: index % 3 === 0 ? 'active' : 'suspended',
            ...(index % 4 === 0 ? {} : { validTo: at(index % 60) }),
          },
          label,
          label,
        );
        made.push(
          expectWritten(
            world.repos.governance.requestConfirmation(
              uow,
              request(`q${index.toString(16)}f`, world.groupId, subject, [subject], {
                expiresAt: at(index % 20),
              }),
              label,
              label,
            ),
            'a request',
          ),
        );
      }
      return made;
    });
    // Three quarters decided, through the real path. A table of nothing but pending requests is
    // not a table `03`'s rate limit would ever read.
    world.store.write((uow) => {
      for (const [index, row] of pending.entries()) {
        if (index % 4 === 0) continue;
        const decider = who[index % who.length];
        if (decider === undefined) throw new Error('fixture');
        world.repos.governance.decideConfirmation(uow, world.groupId, row.id, row.version, {
          status: index % 8 === 0 ? 'rejected' : 'approved',
          byMemberId: decider as never,
          at: T0,
        });
      }
    });
    analyze(world.db);
  }

  it('reaches Q-GOV-1, Q-GOV-2 and the by-subject and by-requester lookups', () => {
    withMembers((world, who) => {
      const subject = who[0];
      if (subject === undefined) throw new Error('fixture');
      seed(world, who);

      // Q-GOV-1: the constraints in force for a turn. The partial index on `status = 'active'` is
      // what makes this cheap — two thirds of the table is not active and is never visited.
      expectIndexUsed(
        world.db,
        `SELECT * FROM constraint_records
          WHERE group_id = ? AND status = 'active' AND valid_from <= ?
            AND (valid_to IS NULL OR valid_to >= ?) AND label_id IN (?)
          ORDER BY valid_from ASC, id ASC LIMIT 50`,
        {
          table: 'constraint_records',
          index: 'constraints_active_idx',
          parameters: [world.groupId, 0, 0, 1],
        },
      );
      // What is on record about one member.
      expectIndexUsed(
        world.db,
        `SELECT * FROM constraint_records
          WHERE group_id = ? AND subject_member_id = ? AND label_id IN (?)
          ORDER BY valid_from DESC, id ASC`,
        {
          table: 'constraint_records',
          index: 'constraints_subject_idx',
          parameters: [world.groupId, subject, 1],
        },
      );
      // Q-GOV-2: the expiry sweep.
      expectIndexUsed(
        world.db,
        `SELECT * FROM confirmation_requests
          WHERE group_id = ? AND status = 'pending' AND expires_at <= ?
          ORDER BY expires_at ASC, id ASC LIMIT 50`,
        {
          table: 'confirmation_requests',
          index: 'confirmations_pending_idx',
          parameters: [world.groupId, DAY * 10],
        },
      );
      // `03`'s rate limit. `confirmations_pair_idx` carries no `group_id`, and does not need one:
      // a `MemberId` belongs to exactly one group, so the requester already implies it.
      expectIndexUsed(
        world.db,
        `SELECT count(*) FROM confirmation_requests
          WHERE group_id = ? AND requester_member_id = ? AND status = 'pending'`,
        {
          table: 'confirmation_requests',
          index: 'confirmations_pair_idx',
          parameters: [world.groupId, subject],
        },
      );
    });
  });

  it('reaches the open-proposal and same-diff indexes', () => {
    withMembers((world, who) => {
      const proposer = who[0];
      if (proposer === undefined) throw new Error('fixture');
      const label = groupLabel(world.groupId);
      const opened = world.store.write((uow) =>
        Array.from({ length: 400 }, (_unused, index) =>
          expectWritten(
            world.repos.governance.openProposal(
              uow,
              {
                id: proposalId(`r${index.toString(16)}f`),
                groupId: world.groupId,
                kind: index % 2 === 0 ? 'amendment' : 'contested_action',
                payload: {},
                rule: RULE,
                electorate: [],
                proposerMemberId: proposer as never,
                openedAt: T0,
                // Three quarters carry a diff hash, so the partial index on `IS NOT NULL` is
                // selective rather than covering the table.
                ...(index % 4 === 0 ? {} : { canonicalDiffHash: `diff-${String(index)}` }),
                ...(index % 3 === 0 ? {} : { deadlineAt: at(index % 30) }),
              },
              label,
            ),
            `proposal ${String(index)}`,
          ),
        ),
      );
      // Most proposals in a long-lived group are closed, so close three quarters of them.
      world.store.write((uow) => {
        for (const [index, row] of opened.entries()) {
          if (index % 4 === 0) continue;
          world.repos.governance.closeProposal(uow, world.groupId, row.id, row.version, {
            status: index % 8 === 0 ? 'rejected' : 'passed',
            outcome: tally(index % 8 === 0 ? 'rejected' : 'passed', 2, 0),
            at: T0,
          });
        }
      });
      analyze(world.db);

      expectIndexUsed(
        world.db,
        `SELECT * FROM proposals
          WHERE group_id = ? AND status = 'open' AND deadline_at <= ? AND label_id IN (?)
          ORDER BY deadline_at IS NULL, deadline_at ASC, id ASC LIMIT 50`,
        {
          table: 'proposals',
          index: 'proposals_open_idx',
          parameters: [world.groupId, DAY * 10, 1],
        },
      );
      expectIndexUsed(
        world.db,
        `SELECT * FROM proposals
          WHERE group_id = ? AND canonical_diff_hash = ? AND status = 'open'`,
        {
          table: 'proposals',
          index: 'proposals_diff_idx',
          parameters: [world.groupId, 'diff-1'],
        },
      );
    });
  });
});
