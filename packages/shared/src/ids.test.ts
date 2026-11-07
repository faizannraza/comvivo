/**
 * The id registry and parser (`02` §3.1, ADR-019).
 *
 * Two things are being protected here. The obvious one is that a malformed id is rejected. The
 * one that actually matters is that the registry is **complete and consistent**: every prefix in
 * `02` §3.1 present, every one of them legal under TypeID's own rule, and no two entities sharing
 * a prefix — because a shared prefix means two entity types whose ids are mutually assignable at
 * runtime, and this product's worst bug is operating on the wrong group or the wrong member.
 */
import { TypeID } from 'typeid-js';
import { describe, expect, it } from 'vitest';
import {
  type GroupId,
  ID_PREFIX,
  type IdPrefix,
  idSchema,
  isId,
  isValidPrefix,
  KNOWN_PREFIXES,
  parseId,
  prefixOf,
  unwrapId,
} from './ids.js';

/** A well-formed 26-character Crockford base32 suffix. */
const SUFFIX = '01j8kqd7h3f9z2m4n6p8r0t2vw';

describe('the prefix registry', () => {
  it('holds every prefix `02` §3.1 lists', () => {
    // Spot-checked against the spec's own list rather than counted, so a prefix removed by
    // accident fails on the name rather than on an arithmetic coincidence.
    for (const [entity, prefix] of [
      ['group', 'grp'],
      ['member', 'mbr'],
      ['message', 'msg'],
      ['memory', 'mem'],
      ['turn', 'trn'],
      ['outbox', 'obx'],
      ['job', 'job'],
      ['audit', 'aud'],
      ['listItem', 'lsti'],
      ['planStep', 'plns'],
      ['constitutionVersion', 'cnst'],
      ['calendarSubscription', 'csub'],
      ['mcpToken', 'mtk'],
      ['feedback', 'fbk'],
    ] as const) {
      expect(ID_PREFIX[entity], entity).toBe(prefix);
    }
  });

  it('has 61 entries, so a silent deletion is a failing test', () => {
    // A count as well as the names above: together they catch both a removal and an addition that
    // nobody meant to make. 61 is `02` §3.1's list verbatim — if a future spec section adds an
    // entity, this number moves in the same commit as the prefix.
    expect(Object.keys(ID_PREFIX)).toHaveLength(61);
  });

  it('gives every entity a distinct prefix', () => {
    // A duplicate would make two entity types' ids mutually assignable at runtime and
    // indistinguishable in `prefixOf`, which is what the polymorphic `target_ref` columns rely on.
    const seen = new Map<string, string>();
    for (const [entity, prefix] of Object.entries(ID_PREFIX)) {
      const previous = seen.get(prefix);
      expect(previous, `${entity} and ${String(previous)} both use the prefix "${prefix}"`).toBe(
        undefined,
      );
      seen.set(prefix, entity);
    }
  });

  it('keeps every prefix legal under TypeID’s own rule', () => {
    // `[a-z]([a-z_]{0,61}[a-z])?`. An illegal prefix would be accepted by our parser and refused
    // by `typeid-js`, so ids would be written and then fail to read back.
    for (const prefix of KNOWN_PREFIXES) {
      expect(isValidPrefix(prefix), prefix).toBe(true);
    }
  });

  it.each(['', 'A', 'grp1', 'grp_', '_grp', 'Grp', 'g-rp', 'ab_'])(
    'refuses "%s" as a prefix',
    (candidate) => {
      expect(isValidPrefix(candidate)).toBe(false);
    },
  );

  it('is frozen, so nothing can add a prefix at run time', () => {
    expect(Object.isFrozen(KNOWN_PREFIXES)).toBe(true);
  });
});

describe('parseId', () => {
  it('accepts a well-formed id and returns it branded', () => {
    const parsed = parseId('grp', `grp_${SUFFIX}`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toBe(`grp_${SUFFIX}`);
  });

  it.each([
    ['empty', '', 'empty'],
    ['no separator', `grp${SUFFIX}`, 'missing_separator'],
    ['the wrong prefix', `mbr_${SUFFIX}`, 'wrong_prefix'],
    ['no prefix', SUFFIX, 'missing_separator'],
    ['too short', `grp_${SUFFIX.slice(0, 25)}`, 'suffix_length'],
    ['too long', `grp_${SUFFIX}x`, 'suffix_length'],
    ['uppercase', `grp_${SUFFIX.toUpperCase()}`, 'suffix_charset'],
    ['an excluded letter (i)', `grp_01j8kqd7h3f9z2m4n6p8r0t2vi`, 'suffix_charset'],
    ['an excluded letter (l)', `grp_01j8kqd7h3f9z2m4n6p8r0t2vl`, 'suffix_charset'],
    ['an excluded letter (o)', `grp_01j8kqd7h3f9z2m4n6p8r0t2vo`, 'suffix_charset'],
    ['an excluded letter (u)', `grp_01j8kqd7h3f9z2m4n6p8r0t2vu`, 'suffix_charset'],
    ['a suffix past 128 bits', `grp_81j8kqd7h3f9z2m4n6p8r0t2vw`, 'suffix_overflow'],
    ['a suffix past 128 bits (z)', `grp_z1j8kqd7h3f9z2m4n6p8r0t2vw`, 'suffix_overflow'],
  ])('rejects %s with kind %s', (_label, value, kind) => {
    const parsed = parseId('grp', value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.kind).toBe(kind);
  });

  it('distinguishes an overflowing suffix from a mistyped one', () => {
    // Different mistakes: a bad character is usually a transcription error (`l` for `1`), while a
    // leading `8`–`z` is usually a 26-character string that was never a TypeID. Telling them
    // apart is the difference between "check your copy-paste" and "this is not an id".
    const mistyped = parseId('grp', `grp_01j8kqd7h3f9z2m4n6p8r0t2vl`);
    const overflow = parseId('grp', `grp_91j8kqd7h3f9z2m4n6p8r0t2vw`);
    expect(mistyped.ok || overflow.ok).toBe(false);
    if (!mistyped.ok) expect(mistyped.error.message).toContain('Crockford');
    if (!overflow.ok) expect(overflow.error.message).toContain('130 bits');
  });

  it('never echoes the whole input, because a malformed id is often a pasted token', () => {
    // `08` §3.10 S2. The commonest cause of "this is not an id" is a copy-paste of something
    // else, and at a security boundary "something else" is frequently a credential.
    const token = ['sk-ant-api03', 'NOTAREALKEYjustshapedlikeone0000000'].join('-');
    const parsed = parseId('grp', token);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).not.toContain(token);
      expect(JSON.stringify(parsed.error)).not.toContain('NOTAREALKEY');
    }
  });

  it('names the expected prefix, which is a constant and safe to echo', () => {
    const parsed = parseId('mbr', `grp_${SUFFIX}`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.expected).toBe('mbr');
      expect(parsed.error.message).toContain('mbr');
    }
  });

  it('accepts every prefix in the registry', () => {
    for (const prefix of KNOWN_PREFIXES) {
      expect(parseId(prefix, `${prefix}_${SUFFIX}`).ok, prefix).toBe(true);
    }
  });

  it('agrees with typeid-js on every registry prefix', () => {
    // The cross-check that matters: our parser and the library that will read these ids back must
    // accept exactly the same strings, or ids get written and then fail to parse.
    for (const prefix of KNOWN_PREFIXES) {
      const value = `${prefix}_${SUFFIX}`;
      expect(parseId(prefix, value).ok, prefix).toBe(true);
      expect(() => TypeID.fromString(value), prefix).not.toThrow();
    }
  });

  it('rejects what typeid-js rejects', () => {
    for (const value of [
      `grp_${SUFFIX.toUpperCase()}`,
      `grp_81j8kqd7h3f9z2m4n6p8r0t2vw`,
      `grp_${SUFFIX}x`,
    ]) {
      expect(parseId('grp', value).ok, value).toBe(false);
      expect(() => TypeID.fromString(value), value).toThrow();
    }
  });
});

describe('isId and prefixOf', () => {
  it('narrows a string to a branded id', () => {
    const candidate: string = `grp_${SUFFIX}`;
    if (isId('grp', candidate)) {
      // The narrowing is the point: this assignment is what fails to compile without it.
      const id: GroupId = candidate;
      expect(id).toBe(candidate);
    } else {
      expect.unreachable('a well-formed id should narrow');
    }
  });

  it('reads the prefix off a polymorphic reference', () => {
    // `02` §3.1: `target_ref`, `source_ref` and `entity_refs` have no foreign key, so the prefix
    // is the only thing that says what the row points at.
    expect(prefixOf(`msg_${SUFFIX}`)).toBe('msg');
    expect(prefixOf(`mem_${SUFFIX}`)).toBe('mem');
  });

  it('returns undefined for a prefix that is not in the registry', () => {
    // An unknown prefix in a polymorphic column means the row points at an entity type this build
    // does not know about — a downgrade, or corruption. Guessing would be worse than `undefined`.
    expect(prefixOf(`zzz_${SUFFIX}`)).toBeUndefined();
    expect(prefixOf(SUFFIX)).toBeUndefined();
    expect(prefixOf('')).toBeUndefined();
  });
});

describe('idSchema', () => {
  const groupId = idSchema('grp');

  it('accepts a well-formed id', () => {
    expect(groupId.safeParse(`grp_${SUFFIX}`).success).toBe(true);
  });

  it.each([
    ['the wrong prefix', `mbr_${SUFFIX}`],
    ['uppercase', `grp_${SUFFIX.toUpperCase()}`],
    ['a suffix past 128 bits', `grp_81j8kqd7h3f9z2m4n6p8r0t2vw`],
    ['empty', ''],
    ['a number', 42],
  ])('rejects %s', (_label, value) => {
    expect(groupId.safeParse(value).success).toBe(false);
  });

  it('reports the same message parseId does, so storage and the API agree', () => {
    const viaSchema = groupId.safeParse(`grp_${SUFFIX}x`);
    const viaParse = parseId('grp', `grp_${SUFFIX}x`);
    expect(viaSchema.success).toBe(false);
    expect(viaParse.ok).toBe(false);
    if (!viaSchema.success && !viaParse.ok) {
      expect(viaSchema.error.issues[0]?.message).toBe(viaParse.error.message);
    }
  });

  it('keeps two entity ids mutually unassignable at compile time', () => {
    // The runtime value is just a string; the brand is what stops a MemberId reaching a parameter
    // that wants a GroupId. Operating on the wrong group IS invariant I4 failing.
    const g = groupId.parse(`grp_${SUFFIX}`);
    const m = idSchema('mbr').parse(`mbr_${SUFFIX}`);
    // @ts-expect-error a MemberId must not be assignable to a GroupId
    const wrong: typeof g = m;
    expect(typeof wrong).toBe('string');
  });

  it('refuses a prefix that is not in the registry, at compile time', () => {
    // @ts-expect-error 'zzz' is not an IdPrefix
    const schema = idSchema('zzz');
    expect(schema).toBeDefined();
  });
});

describe('unwrapId', () => {
  it('returns the id when the parse succeeded', () => {
    expect(unwrapId(parseId('grp', `grp_${SUFFIX}`), 'STORAGE_ID_INVALID')).toBe(`grp_${SUFFIX}`);
  });

  it('throws with the code when it failed, because the database is then corrupt', () => {
    // This is the storage mapper's path (`02` §3.1's `tid`), reading a value this process wrote.
    // Continuing with a bad value is worse than crashing.
    expect(() => unwrapId(parseId('grp', 'nope'), 'STORAGE_ID_INVALID')).toThrow(
      /STORAGE_ID_INVALID/,
    );
  });
});

describe('the registry is usable as a type', () => {
  it('accepts a prefix from the registry where IdPrefix is wanted', () => {
    const prefix: IdPrefix = ID_PREFIX.group;
    expect(prefix).toBe('grp');
  });

  it('refuses a string that is not a registry prefix', () => {
    // @ts-expect-error 'nope' is not one of the registry's values
    const prefix: IdPrefix = 'nope';
    expect(prefix).toBe('nope');
  });
});
