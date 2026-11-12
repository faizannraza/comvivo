/**
 * `EntityRefSchema`: the `kind` must agree with the `id`'s TypeID prefix.
 *
 * That agreement is the whole value of the type. Without it the `kind` field is redundant with the
 * prefix and a mismatch produces a dead link in the dashboard — a turn effect that says it created
 * an event, pointing at a task.
 */
import { ID_PREFIX } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import {
  ENTITY_REF_KINDS,
  ENTITY_REF_MAX_PER_LIST,
  EntityRefListSchema,
  EntityRefSchema,
} from './entity-ref.js';

/** A valid 26-character Crockford base32 suffix. */
const SUFFIX = '01jqw8z5h7e9r3t4y5v6k7p8q9';

/**
 * The kind-to-prefix map, written out.
 *
 * Every test below built its id as `${ID_PREFIX[kind]}_${SUFFIX}` and `EntityRefSchema`
 * validates by calling `parseId(ID_PREFIX[ref.kind], ref.id)` — so the expected prefix came from
 * **the same map the implementation consults**, and changing `ID_PREFIX.task` from `tsk` to
 * anything at all left the whole suite green while the suite's stated purpose ("the `kind` must
 * agree with the `id`'s TypeID prefix") went unverified. Of the 21 kinds, only seven were pinned
 * literally anywhere in the repository. Found by the M1 independent review.
 *
 * A prefix is a wire constant: it appears in ids stored in every table, printed in logs and
 * carried in API payloads, so changing one is a data migration rather than a rename. That is the
 * reason to write them down rather than read them back.
 */
const EXPECTED_PREFIX: Readonly<Record<(typeof ENTITY_REF_KINDS)[number], string>> = {
  person: 'prs',
  member: 'mbr',
  group: 'grp',
  conversation: 'cnv',
  message: 'msg',
  attachment: 'att',
  memory: 'mem',
  entity: 'ent',
  event: 'evt',
  reminder: 'rem',
  task: 'tsk',
  rotation: 'rot',
  list: 'lst',
  listItem: 'lsti',
  poll: 'pol',
  plan: 'pln',
  planStep: 'plns',
  decision: 'dec',
  constraint: 'cst',
  proposal: 'prp',
  declassification: 'dcl',
};

describe('every kind the constant lists', () => {
  it('is exactly the 21 kinds, each with the prefix 02 §3.1 assigns', () => {
    expect(ENTITY_REF_KINDS).toEqual(Object.keys(EXPECTED_PREFIX));
    for (const kind of ENTITY_REF_KINDS) {
      expect(ID_PREFIX[kind], kind).toBe(EXPECTED_PREFIX[kind]);
    }
    // `it.each` over an empty list runs no cases and passes, so the length is pinned too.
    expect(ENTITY_REF_KINDS).toHaveLength(21);
  });

  it.each(ENTITY_REF_KINDS)('accepts a %s reference with the right prefix', (kind) => {
    // The literal map, not `ID_PREFIX`: building the id from the same source the validator reads
    // makes the test agree with the implementation by construction.
    const id = `${EXPECTED_PREFIX[kind]}_${SUFFIX}`;
    expect(EntityRefSchema.parse({ kind, id })).toEqual({ kind, id });
  });

  it.each(ENTITY_REF_KINDS)('refuses a %s reference carrying another prefix', (kind) => {
    // `turn` is never an entity-ref kind, so its prefix is wrong for every case here.
    const wrong = `${ID_PREFIX.turn}_${SUFFIX}`;
    const outcome = EntityRefSchema.safeParse({ kind, id: wrong });
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.error.issues[0]?.path).toEqual(['id']);
    expect(outcome.error.issues[0]?.message).toContain(EXPECTED_PREFIX[kind]);
  });

  it('names a kind that is registered in ID_PREFIX', () => {
    // `toBeTypeOf('string')` was the assertion here, which the `satisfies readonly IdEntity[]` on
    // the constant already guarantees at compile time — and as a runtime matcher it accepted any
    // string, `''` included. The literal comparison above is the real check; this keeps the
    // non-empty half, which the type cannot express.
    for (const kind of ENTITY_REF_KINDS) {
      expect(ID_PREFIX[kind], kind).toMatch(/^[a-z]{2,5}$/);
    }
  });
});

describe('kinds it deliberately excludes', () => {
  it.each(['session', 'loginToken', 'stepUp', 'inviteCode'])('refuses %s', (kind) => {
    // These have ids in `ID_PREFIX` but are not domain entities: a declassification subject or a
    // turn effect is never about a login token.
    expect(EntityRefSchema.safeParse({ kind, id: `ltk_${SUFFIX}` }).success).toBe(false);
  });
});

describe('malformed references', () => {
  it.each([
    { kind: 'event', id: 'evt_not-base32' },
    { kind: 'event', id: 'evt_' },
    { kind: 'event', id: SUFFIX },
    { kind: 'event' },
    { id: `evt_${SUFFIX}` },
  ])('refuses %o', (value) => {
    expect(EntityRefSchema.safeParse(value).success).toBe(false);
  });

  it('reports the same distinction parseId does', () => {
    const outcome = EntityRefSchema.safeParse({ kind: 'event', id: 'evt_tooshort' });
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.error.issues[0]?.message).toContain('26');
  });
});

describe('the bounded list (02 §3.3.9)', () => {
  const ref = (index: number) => ({
    kind: 'event' as const,
    id: `evt_${SUFFIX.slice(0, 24)}${String(index).padStart(2, '0')}`,
  });

  it('accepts the maximum', () => {
    // `02` §3.3.9's 50, pinned. Every assertion about this bound was parameterised by the bound,
    // so it could move freely.
    expect(ENTITY_REF_MAX_PER_LIST).toBe(50);
    const list = Array.from({ length: ENTITY_REF_MAX_PER_LIST }, (_, index) => ref(index));
    expect(EntityRefListSchema.parse(list)).toHaveLength(50);
  });

  it('refuses one more', () => {
    const list = Array.from({ length: ENTITY_REF_MAX_PER_LIST + 1 }, (_, index) => ref(index));
    expect(EntityRefListSchema.safeParse(list).success).toBe(false);
  });

  it('accepts an empty list', () => {
    expect(EntityRefListSchema.parse([])).toEqual([]);
  });
});
