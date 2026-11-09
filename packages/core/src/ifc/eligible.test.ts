/**
 * Read eligibility (`02` §3.2, `01` §7.2, A5).
 *
 * The two things worth testing hardest are the brand — because it is what stops a caller handing a
 * storage read a list it built itself — and the **direction** of containment, because getting it
 * backwards would admit a two-member datum into a group-wide context and look like a passing test
 * either way.
 */

import type { GroupId, LabelId, MemberId } from '@comvivo/shared';
import { idSchema } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import {
  type Audience,
  audienceKey,
  computeEligible,
  type GroupSnapshot,
  type Label,
  type ReadEligibility,
  StubInformationFlow,
} from './eligible.js';

const GROUP = idSchema('grp').parse('grp_01jqw8z5h7e9r3t4y5v6k7p8q9') as GroupId;
const OTHER_GROUP = idSchema('grp').parse('grp_01jqw8z5h7e9r3t4y5v6k7p8r0') as GroupId;
const member = (n: number): MemberId =>
  idSchema('mbr').parse(`mbr_01jqw8z5h7e9r3t4y5v6k7p${String(n).padStart(3, '0')}`) as MemberId;

const ANA = member(1);
const BEN = member(2);
const CAT = member(3);

const labelId = (n: number): LabelId => n as LabelId;

function snapshot(members: readonly MemberId[] = [ANA, BEN, CAT]): GroupSnapshot {
  return { groupId: GROUP, membershipEpoch: 7, memberIds: members };
}

function label(readers: Audience, overrides: Partial<Label> = {}): Label {
  return {
    groupId: GROUP,
    readers,
    owner: 'group',
    coOwners: [],
    sensitivity: 'normal',
    influence: 'none',
    untrusted: false,
    ...overrides,
  };
}

const groupAudience: Audience = { kind: 'group', groupId: GROUP };
const pair: Audience = { kind: 'members', groupId: GROUP, memberIds: [ANA, BEN] };

describe('audienceKey', () => {
  it('is stable under ordering and duplication', () => {
    // Two audiences that mean the same thing must key the same, or `engine/context` caches two
    // entries for one audience and the second is a silent miss on every turn.
    expect(audienceKey({ kind: 'members', groupId: GROUP, memberIds: [BEN, ANA, ANA] })).toBe(
      audienceKey({ kind: 'members', groupId: GROUP, memberIds: [ANA, BEN] }),
    );
    expect(audienceKey({ kind: 'group', groupId: GROUP, seats: ['cnv_b', 'cnv_a', 'cnv_a'] })).toBe(
      audienceKey({ kind: 'group', groupId: GROUP, seats: ['cnv_a', 'cnv_b'] }),
    );
  });

  it('distinguishes the group audience from an explicit set of everyone', () => {
    // They are not the same audience: `group` resolves at check time, so it keeps admitting a
    // member who joins tomorrow. An explicit set of today's members does not.
    expect(audienceKey(groupAudience)).not.toBe(
      audienceKey({ kind: 'members', groupId: GROUP, memberIds: [ANA, BEN, CAT] }),
    );
  });

  it('distinguishes audiences that differ only in seats', () => {
    expect(audienceKey({ kind: 'group', groupId: GROUP, seats: ['cnv_a'] })).not.toBe(
      audienceKey(groupAudience),
    );
  });

  it('is unhashed, so a debug dump is readable', () => {
    // Deliberate: `02` §3.2's `canonical_key` hashes with sha256 to bound a stored column, and
    // hashing cannot happen here because `@comvivo/core` is pure and has no `node:crypto`.
    expect(audienceKey(pair)).toContain(ANA);
    expect(audienceKey(groupAudience)).toBe('g|s:');
  });
});

describe('StubInformationFlow — containment is the whole of canRead', () => {
  it('admits a group-readable datum into any audience inside the group', () => {
    const readable = label(groupAudience);
    expect(StubInformationFlow.canRead(readable, groupAudience, snapshot())).toBe(true);
    expect(StubInformationFlow.canRead(readable, pair, snapshot())).toBe(true);
  });

  it('refuses a two-member datum in a group-wide context', () => {
    // The direction that matters. A context assembled for the whole group may be shown to everyone
    // in it, so a datum only two of them may see must not be in it — `I2`, no write-down,
    // enforced on the way in. Reversing the comparison would pass the test above and fail here,
    // which is why both are needed.
    const narrow = label({ kind: 'members', groupId: GROUP, memberIds: [ANA, BEN] });
    expect(StubInformationFlow.canRead(narrow, groupAudience, snapshot())).toBe(false);
    expect(StubInformationFlow.canRead(narrow, pair, snapshot())).toBe(true);
    // And a context for a third member is not covered either.
    expect(
      StubInformationFlow.canRead(
        narrow,
        { kind: 'members', groupId: GROUP, memberIds: [CAT] },
        snapshot(),
      ),
    ).toBe(false);
  });

  it('admits a narrow datum into a group context when it happens to cover everyone', () => {
    // Unusual and still correct: if the label names every current member, the group audience adds
    // nobody. This is also why the decision needs the snapshot rather than only the two audiences.
    const everyone = label({ kind: 'members', groupId: GROUP, memberIds: [ANA, BEN, CAT] });
    expect(StubInformationFlow.canRead(everyone, groupAudience, snapshot())).toBe(true);
    // …and stops covering it the moment a fourth member joins.
    expect(
      StubInformationFlow.canRead(everyone, groupAudience, snapshot([ANA, BEN, CAT, member(4)])),
    ).toBe(false);
  });

  it('refuses a seat the label does not admit (A5)', () => {
    // A seat occupant is not a member, so the member comparison can never cover them. A label with
    // no seats admits no outsider.
    const readable = label(groupAudience);
    const withSeat: Audience = { kind: 'group', groupId: GROUP, seats: ['cnv_guest'] };
    expect(StubInformationFlow.canRead(readable, withSeat, snapshot())).toBe(false);

    const seated = label({ kind: 'group', groupId: GROUP, seats: ['cnv_guest'] });
    expect(StubInformationFlow.canRead(seated, withSeat, snapshot())).toBe(true);
    // A label that admits one seat does not admit another.
    expect(
      StubInformationFlow.canRead(
        seated,
        { kind: 'group', groupId: GROUP, seats: ['cnv_other'] },
        snapshot(),
      ),
    ).toBe(false);
  });

  it('refuses anything from another group (I4)', () => {
    expect(
      StubInformationFlow.canRead(
        label(groupAudience, { groupId: OTHER_GROUP }),
        groupAudience,
        snapshot(),
      ),
    ).toBe(false);
    expect(
      StubInformationFlow.canRead(
        label(groupAudience),
        { kind: 'group', groupId: OTHER_GROUP },
        snapshot(),
      ),
    ).toBe(false);
  });

  it('ignores sensitivity, influence and untrusted, which M5-T2 owns', () => {
    // Stated as a test rather than only in a comment, so the boundary is visible: these three
    // fields do not affect **read** eligibility in `01` §7.2, and `03` §3.4's judgements about
    // them arrive with the real `InformationFlow`.
    for (const overrides of [
      { sensitivity: 'sensitive' } as const,
      { influence: 'constraints' } as const,
      { untrusted: true } as const,
    ]) {
      expect(
        StubInformationFlow.canRead(label(groupAudience, overrides), pair, snapshot()),
        JSON.stringify(overrides),
      ).toBe(true);
    }
  });
});

describe('computeEligible', () => {
  const labels = new Map<LabelId, Label>([
    [labelId(1), label(groupAudience)],
    [labelId(2), label({ kind: 'members', groupId: GROUP, memberIds: [ANA, BEN] })],
    [labelId(3), label({ kind: 'members', groupId: GROUP, memberIds: [CAT] })],
  ]);

  it('returns the eligible ids, sorted ascending', () => {
    const set = computeEligible(labels, pair, snapshot(), StubInformationFlow);
    expect(set.ids).toEqual([labelId(1), labelId(2)]);
    expect(set.groupId).toBe(GROUP);
    expect(set.audienceKey).toBe(audienceKey(pair));
  });

  it('sorts numerically, not lexicographically', () => {
    // `[2, 10].sort()` is `[10, 2]` by default, and the list is bound as JSON for
    // `label_id IN (SELECT value FROM json_each(?))` — order is what makes two equal sets compare
    // equal as strings for the cache.
    const many = new Map<LabelId, Label>(
      [10, 2, 1].map((n) => [labelId(n), label(groupAudience)] as const),
    );
    expect(computeEligible(many, pair, snapshot(), StubInformationFlow).ids).toEqual([1, 2, 10]);
  });

  it('keys the epoch on the membership epoch and the highest label id', () => {
    const set = computeEligible(labels, pair, snapshot(), StubInformationFlow);
    expect(set.epoch).toBe('7:3');
    // A membership change moves it, because the `group` audience resolves to different people.
    expect(
      computeEligible(labels, pair, { ...snapshot(), membershipEpoch: 8 }, StubInformationFlow)
        .epoch,
    ).toBe('8:3');
  });

  it('counts a label the audience cannot read toward the epoch', () => {
    // The subtle half. Label 3 is **not** eligible for this audience, and it still has to move the
    // epoch: the next audience to ask may be one it admits, and a cache keyed on the eligible
    // maximum would serve that audience a set computed before the label existed.
    const withNew = new Map(labels).set(
      labelId(9),
      label({ kind: 'members', groupId: GROUP, memberIds: [CAT] }),
    );
    const before = computeEligible(labels, pair, snapshot(), StubInformationFlow);
    const after = computeEligible(withNew, pair, snapshot(), StubInformationFlow);
    expect(after.ids).toEqual(before.ids);
    expect(after.epoch).not.toBe(before.epoch);
  });

  it('is empty, with a stable epoch, when nothing is eligible', () => {
    const onlyOthers = new Map<LabelId, Label>([
      [labelId(4), label({ kind: 'members', groupId: GROUP, memberIds: [CAT] })],
    ]);
    const set = computeEligible(onlyOthers, pair, snapshot(), StubInformationFlow);
    expect(set.ids).toEqual([]);
    expect(set.epoch).toBe('7:4');
  });

  it('handles an empty label map', () => {
    const set = computeEligible(new Map(), pair, snapshot(), StubInformationFlow);
    expect(set.ids).toEqual([]);
    // `0` is the sentinel vec0 pads with, and no label has id 0 — so an empty set's epoch is
    // unambiguous rather than colliding with "one label, id 0".
    expect(set.epoch).toBe('7:0');
  });

  it('refuses an audience from another group (I4)', () => {
    expect(() =>
      computeEligible(
        labels,
        { kind: 'group', groupId: OTHER_GROUP },
        snapshot(),
        StubInformationFlow,
      ),
    ).toThrow(/cannot be eligible/);
  });

  it('refuses a label from another group (I4)', () => {
    // The one thing worse than refusing is returning a set that spans two groups: the brand would
    // then certify it, and every labeled read downstream trusts the brand.
    const mixed = new Map(labels).set(labelId(5), label(groupAudience, { groupId: OTHER_GROUP }));
    expect(() => computeEligible(mixed, pair, snapshot(), StubInformationFlow)).toThrow(
      /belongs to/,
    );
  });

  it('asks the flow about every candidate, so the set is the flow’s answer', () => {
    // Non-vacuity, and it also pins the contract: a flow that admits nothing yields an empty set,
    // and one that admits everything yields all of them. Without this, a `computeEligible` that
    // ignored `flow` entirely would pass every test above that uses the stub.
    const asked: LabelId[] = [];
    const denyAll: ReadEligibility = { canRead: () => false };
    const allowAll: ReadEligibility = {
      canRead: () => true,
    };
    const recording: ReadEligibility = {
      canRead: (candidate) => {
        asked.push([...labels].find(([, value]) => value === candidate)?.[0] ?? labelId(0));
        return true;
      },
    };

    expect(computeEligible(labels, pair, snapshot(), denyAll).ids).toEqual([]);
    expect(computeEligible(labels, pair, snapshot(), allowAll).ids).toEqual([1, 2, 3]);
    computeEligible(labels, pair, snapshot(), recording);
    expect(asked.toSorted((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});
