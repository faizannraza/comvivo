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

describe('every kind the constant lists', () => {
  it.each(ENTITY_REF_KINDS)('accepts a %s reference with the right prefix', (kind) => {
    const id = `${ID_PREFIX[kind]}_${SUFFIX}`;
    expect(EntityRefSchema.parse({ kind, id })).toEqual({ kind, id });
  });

  it.each(ENTITY_REF_KINDS)('refuses a %s reference carrying another prefix', (kind) => {
    // `turn` is never an entity-ref kind, so its prefix is wrong for every case here.
    const wrong = `${ID_PREFIX.turn}_${SUFFIX}`;
    const outcome = EntityRefSchema.safeParse({ kind, id: wrong });
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.error.issues[0]?.path).toEqual(['id']);
    expect(outcome.error.issues[0]?.message).toContain(ID_PREFIX[kind]);
  });

  it('names a kind that is registered in ID_PREFIX', () => {
    // The `satisfies readonly IdEntity[]` on the constant makes this a type error too; this is the
    // runtime half, so a prefix removed from the registry fails here rather than at a call site.
    for (const kind of ENTITY_REF_KINDS) {
      expect(ID_PREFIX[kind]).toBeTypeOf('string');
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
    const list = Array.from({ length: ENTITY_REF_MAX_PER_LIST }, (_, index) => ref(index));
    expect(EntityRefListSchema.parse(list)).toHaveLength(ENTITY_REF_MAX_PER_LIST);
  });

  it('refuses one more', () => {
    const list = Array.from({ length: ENTITY_REF_MAX_PER_LIST + 1 }, (_, index) => ref(index));
    expect(EntityRefListSchema.safeParse(list).success).toBe(false);
  });

  it('accepts an empty list', () => {
    expect(EntityRefListSchema.parse([])).toEqual([]);
  });
});
