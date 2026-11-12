/**
 * Read eligibility — the one mechanism (`02` §3.2, `01` §7.2, `01` §14 A5).
 *
 * `02` §3.2 is emphatic about this and the sentence is worth repeating: **"This is the only
 * eligibility mechanism in the plan. Any other document that describes per-row reader columns or
 * SQL reader predicates (e.g. `readers_kind`, `item_readers`, 'ReaderPrefilter') means this
 * `label_id IN (eligible)` filter."** So every labeled read in the product funnels through an
 * `EligibleLabelSet` computed here, and there is no second path to keep in step with it.
 *
 * ## Why the set is branded
 *
 * A storage read that takes `readonly LabelId[]` can be called with a hand-built list, and the
 * caller who builds one has — by construction — skipped the eligibility computation. That is
 * invariant **I1** (no read-up) deleted in one argument, and it would look like a convenience. The
 * brand makes `computeEligible` the only way to obtain the value a labeled read demands.
 *
 * ## Why `epoch` is part of it
 *
 * `engine/context` caches sets per `(groupId, audienceKey, epoch)`, and the epoch has two parts
 * because two different things invalidate a set: a membership change (which moves who the `group`
 * audience resolves to) and a new label (which may be eligible and was not in the set). Caching on
 * the membership epoch alone would serve a stale set that silently omits newly created labels;
 * caching on the label count alone would serve one that admits a member who has just left.
 */
import { BugError, type GroupId, type LabelId, type MemberId } from '@comvivo/shared';

/** `01` §7.2. `sensitive` covers health, finances, relationships, legal, precise location, minors. */
export type Sensitivity = 'normal' | 'personal' | 'sensitive';

/** Whether a datum may shape group-facing behaviour through typed constraints (`01` §7.2). */
export type Influence = 'none' | 'constraints';

/**
 * Who may see a datum verbatim.
 *
 * `seats` is `01` §14 A5: per-conversation outsider seats for lurkers, foreign bots and
 * removed-but-present users. A seat is a conversation rather than a member precisely because the
 * occupant is **not** a member — there is no member id to name, and what the audience actually
 * includes is "whoever is in that conversation".
 *
 * `kind: 'group'` resolves at check time rather than naming members, so a datum readable by the
 * group stays readable as the group changes. That is why `GroupSnapshot.membershipEpoch` is part
 * of the cache key and not of the audience.
 */
export type Audience =
  | {
      readonly kind: 'group';
      readonly groupId: GroupId;
      readonly seats?: readonly string[];
    }
  | {
      readonly kind: 'members';
      readonly groupId: GroupId;
      readonly memberIds: readonly MemberId[];
      readonly seats?: readonly string[];
    };

/**
 * An IFC label (`01` §7.2 as amended by A5).
 *
 * `owner` is `'group'` rather than `undefined` for the group case, matching `01` §7.2 — the
 * storage column is nullable, and `LabelStore` maps between the two. A sentinel reads better in
 * core, where `owner === 'group'` is a case to handle rather than a value that might be missing.
 *
 * `coOwners` excludes the owner and is sorted, so one ownership set has exactly one encoding
 * (`02` §3.3.2). That is what makes interning work: two labels that mean the same thing must
 * produce the same canonical key.
 */
export interface Label {
  readonly groupId: GroupId;
  readonly readers: Audience;
  readonly owner: MemberId | 'group';
  readonly coOwners: readonly MemberId[];
  readonly sensitivity: Sensitivity;
  readonly influence: Influence;
  readonly untrusted: boolean;
}

/** The group state an eligibility decision is made against (`01` §7.2). */
export interface GroupSnapshot {
  readonly groupId: GroupId;
  /** Incremented in the same transaction as any member status or role change (`02` §3.2). */
  readonly membershipEpoch: number;
  /** Members whose status admits them to the `group` audience, sorted. */
  readonly memberIds: readonly MemberId[];
}

/**
 * The narrowest port `computeEligible` needs.
 *
 * `01` §7.2's `InformationFlow` also has `join` and `checkWrite`, and both arrive with `M5-T2`.
 * Depending on the whole interface here would mean shipping a stub whose other two methods throw,
 * which `CLAUDE.md` §8 rules out — and it would be the wrong dependency anyway: this function
 * needs one question answered.
 */
export interface ReadEligibility {
  canRead(label: Label, audience: Audience, snapshot: GroupSnapshot): boolean;
}

declare const eligibleBrand: unique symbol;

/**
 * The value every labeled storage read requires (`02` §3.2).
 *
 * `ids` is sorted ascending, which matters twice: `json_each` binding is one prepared statement
 * for any length, and two sets with the same members compare equal as strings for the cache.
 */
export type EligibleLabelSet = {
  readonly groupId: GroupId;
  readonly ids: readonly LabelId[];
  readonly audienceKey: string;
  readonly epoch: string;
} & { readonly [eligibleBrand]: true };

/**
 * A canonical, **unhashed** key for an audience.
 *
 * Unhashed on purpose. `02` §3.2's `reader_sets.canonical_key` hashes the member and seat lists
 * with sha256 to bound a stored column's length — and hashing belongs in storage, because
 * `@comvivo/core` is pure and has no `node:crypto` (`CLAUDE.md` §2). This key is only ever an
 * in-memory `Map` key in `engine/context`, where length costs nothing and legibility in a debug
 * dump is worth something.
 *
 * Sorted and de-duplicated, so two audiences that mean the same thing key the same.
 */
export function audienceKey(audience: Audience): string {
  // The separator is load-bearing for **seats**, which are conversation ids of any length:
  // joining `['a', 'bc']` and `['ab', 'c']` without one gives the same key for two different
  // audiences, and a shared cache key is a shared context. `eligible.test.ts` pins that case.
  const seats = [...new Set(audience.seats ?? [])].toSorted().join(',');
  // Narrowed by elimination rather than by an exhaustive chain ending in `assertNever`: the union
  // has two members, so a second `kind ===` check is a comparison the compiler already knows the
  // answer to and `no-unnecessary-condition` rejects it. `assert-never.ts` records the same
  // conclusion for switches.
  if (audience.kind === 'group') return `g|s:${seats}`;
  // Stryker disable next-line StringLiteral: member ids are fixed-length typeids, so no two
  // distinct sorted sets concatenate to the same string and the separator cannot change a key.
  // It stays for symmetry with the seats above, where it *is* load-bearing.
  const members = [...new Set(audience.memberIds)].toSorted().join(',');
  return `m:${members}|s:${seats}`;
}

/**
 * The labels a context for `audience` may include.
 *
 * Every label in `labels` is considered, so the caller decides the candidate set — in practice the
 * group's whole label map, which `02` §3.2 expects to be ≤ 500 and warns above 2,000.
 *
 * @throws a {@link BugError} when the audience or a label belongs to another group. That would be
 * invariant **I4** failing, and the one thing worse than refusing is returning a set that quietly
 * spans two groups: the brand would then certify it.
 */
export function computeEligible(
  labels: ReadonlyMap<LabelId, Label>,
  audience: Audience,
  snapshot: GroupSnapshot,
  flow: ReadEligibility,
): EligibleLabelSet {
  if (audience.groupId !== snapshot.groupId) {
    throw new BugError(
      `an audience for ${audience.groupId} cannot be eligible in ${snapshot.groupId}`,
    );
  }

  const ids: LabelId[] = [];
  let maxId = 0;
  for (const [id, label] of labels) {
    if (label.groupId !== snapshot.groupId) {
      throw new BugError(
        `label ${String(id)} belongs to ${label.groupId}, not ${snapshot.groupId}`,
      );
    }
    maxId = Math.max(maxId, id);
    if (flow.canRead(label, audience, snapshot)) ids.push(id);
  }

  // `maxId` over **every** candidate, not just the eligible ones: a new label that is *not*
  // eligible still has to invalidate the cache, because the next audience asking may be one it
  // admits. Keying on the eligible maximum would serve that audience a set computed before the
  // label existed.
  return {
    groupId: snapshot.groupId,
    ids: ids.toSorted((left, right) => left - right),
    audienceKey: audienceKey(audience),
    epoch: `${String(snapshot.membershipEpoch)}:${String(maxId)}`,
    // `as unknown as` because the brand is a phantom property no runtime value carries: a direct
    // assertion is rejected for not overlapping, which is the type system correctly pointing out
    // that this is the one place allowed to mint the value. Matching `shared/src/ids.ts`'s
    // treatment of `InternedId`.
  } as unknown as EligibleLabelSet;
}

/**
 * Read eligibility by audience containment, which is the whole of `canRead` (`01` §7.2).
 *
 * Named, and named as a stub, because `M5-T2` replaces it with the real `InformationFlow` —
 * `02` §3.2's `M1-T16` asks for exactly that. What it is **not** is a placeholder: audience
 * containment is fully determined by `01` §7.2 ("`readers`: who may see it verbatim"), and this
 * implements it rather than approximating it.
 *
 * What `M5-T2` adds is the judgements `03` §3.4 layers on top — sensitivity against a requester's
 * clearance, influence, untrusted handling, declassification. Those are policy decisions about
 * *what may be done* with a datum the reader is already permitted to see, and inventing them here
 * would be guessing at another document's spec.
 *
 * The rule, and why it is this direction: a context assembled for `audience` may be shown to
 * everyone that audience reaches. A datum is eligible only if its own readers include all of them
 * — so the datum's audience must **contain** the requesting one. A group-readable datum is
 * eligible for any audience inside the group; a datum readable by two members is not eligible for
 * a context the whole group can see. That is **I2** (no write-down) enforced on the way in.
 */
export const StubInformationFlow: ReadEligibility = {
  canRead(label: Label, audience: Audience, snapshot: GroupSnapshot): boolean {
    if (label.groupId !== snapshot.groupId || audience.groupId !== snapshot.groupId) return false;
    if (!containsSeats(label.readers, audience)) return false;

    if (label.readers.kind === 'group') {
      // Readable by the whole group, so readable by any audience within it. The membership epoch
      // is what makes "the whole group" mean today's members rather than the ones present when
      // the label was interned.
      return true;
    }

    const permitted = new Set(label.readers.memberIds);
    if (audience.kind === 'group') {
      // The group audience is every current member. A narrower label is eligible only if it
      // happens to admit all of them — unusual, and still correct.
      return snapshot.memberIds.every((member) => permitted.has(member));
    }
    return audience.memberIds.every((member) => permitted.has(member));
  },
};

/**
 * Every seat the requesting audience reaches must also be a seat the label admits.
 *
 * No early return for the seatless case: `[].every(…)` is already `true`, so a
 * `if (requested.length === 0) return true` was a branch that could not change an answer — which
 * `M1-T34`'s mutation run found by surviving its removal. An unkillable mutant is usually a sign
 * of code that does nothing, and it was.
 */
function containsSeats(readers: Audience, audience: Audience): boolean {
  const requested = audience.seats ?? [];
  // A label with no seats admits no outsider, so any requested seat is outside it. Seats are
  // per-conversation and an occupant is by definition not a member (`01` §14 A5), so they are
  // never covered by the member comparison above.
  //
  // Stryker disable next-line ArrayDeclaration: the fallback is reached only when the label has no
  // seats, and the mutant replaces it with a sentinel string no conversation id can equal — so it
  // cannot change an answer. Equivalent mutant, annotated rather than left for the next reader.
  const permitted = new Set(readers.seats ?? []);
  return requested.every((seat) => permitted.has(seat));
}
