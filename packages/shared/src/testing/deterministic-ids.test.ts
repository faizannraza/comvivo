/**
 * `DeterministicIdGenerator` (`11` §3.1.7, ADR-019).
 *
 * Three properties, each load-bearing somewhere specific:
 *
 *  - **Valid TypeIDs**, cross-checked against `typeid-js`'s own parser.
 *  - **Deterministic per seed**, so golden transcripts (`11` §3.5) can compare whole conversations
 *    rather than normalising ids away — which is what keeps them able to catch the bug where the
 *    *wrong* id is used, and that bug is invariant **I4** failing.
 *  - **Monotonic**, because the turn journal and the outbox take id order as creation order
 *    (`01` §6.2, invariants I6 and I7).
 */
import { TypeID } from 'typeid-js';
import { describe, expect, it } from 'vitest';
import { TypeIdGenerator } from '../id-generator.js';
import { isId, KNOWN_PREFIXES, parseId } from '../ids.js';
import { DeterministicIdGenerator } from './deterministic-ids.js';
import { SeededRng } from './seeded-rng.js';
import { VirtualClock } from './virtual-clock.js';

const START = '2026-06-01T12:00:00Z';
const make = (seed = 42, start = START): DeterministicIdGenerator =>
  new DeterministicIdGenerator(new VirtualClock(start), new SeededRng(seed));

describe('format', () => {
  it('produces a TypeID that typeid-js itself accepts', () => {
    // Everything here goes through typeid-js's own parser rather than a regex of my own, so a
    // mistake in my byte layout cannot pass by agreeing with itself. (Its `getType` free function
    // wants its own branded type, so the parser instance is used instead — which is the stricter
    // check anyway, since it has to decode the suffix to answer.)
    const id = make().next('grp');
    expect(() => TypeID.fromString(id)).not.toThrow();
    expect(TypeID.fromString(id).getType()).toBe('grp');
  });

  // `'turn'` was in this list until `M1-T3`, and it is the **entity name** — the prefix is `trn`.
  // The old port took `prefix: string`, so it minted `turn_01jd8…` ids that no parser would ever
  // accept, and nothing noticed. The closed `IdPrefix` union turned that into a compile error.
  it.each(['grp', 'mbr', 'mem', 'trn', 'msg', 'evt'] as const)(
    'works for the %s prefix',
    (prefix) => {
      const id = make().next(prefix);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(TypeID.fromString(id).getType()).toBe(prefix);
    },
  );

  it('has a 26-character Crockford base32 suffix', () => {
    const suffix = make().next('grp').split('_')[1];
    expect(suffix).toHaveLength(26);
    expect(suffix).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
  });

  it('encodes UUID version 7 and the RFC 9562 variant bits', () => {
    const uuid = TypeID.fromString(make().next('grp')).toUUID();
    // xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx
    expect(uuid[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(uuid[19]);
  });

  it("encodes the clock's millisecond in the timestamp field", () => {
    const clock = new VirtualClock(START);
    const ids = new DeterministicIdGenerator(clock, new SeededRng(1));
    const uuid = TypeID.fromString(ids.next('grp')).toUUID();
    const ms = Number.parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);
    expect(ms).toBe(clock.now().epochMilliseconds);
  });
});

describe('determinism', () => {
  it('gives the same id for the same seed, clock and prefix', () => {
    expect(make(42).next('grp')).toBe(make(42).next('grp'));
  });

  it('gives a different id for a different seed', () => {
    expect(make(42).next('grp')).not.toBe(make(43).next('grp'));
  });

  it('gives a different id at a different instant', () => {
    expect(make(42, START).next('grp')).not.toBe(make(42, '2026-06-01T12:00:01Z').next('grp'));
  });

  it('reproduces a whole sequence, which is what a golden transcript compares', () => {
    const first = make(7);
    const second = make(7);
    for (let i = 0; i < 20; i += 1) {
      expect(second.next('msg')).toBe(first.next('msg'));
    }
  });

  it('keeps sequences independent per generator instance', () => {
    const a = make(7);
    const b = make(7);
    a.next('msg');
    // `b` has not advanced, so its first id still matches `a`'s first.
    expect(b.next('msg')).toBe(make(7).next('msg'));
  });
});

describe('monotonicity', () => {
  it('sorts in creation order within a single millisecond', () => {
    // The turn journal and the outbox take id order AS creation order, so this is not cosmetic.
    const ids = make();
    const generated = Array.from({ length: 200 }, () => ids.next('trn'));
    expect(generated).toEqual([...generated].sort());
  });

  it('never repeats an id within a millisecond', () => {
    const ids = make();
    const generated = Array.from({ length: 500 }, () => ids.next('msg'));
    expect(new Set(generated).size).toBe(500);
  });

  it('sorts in creation order across milliseconds', async () => {
    const clock = new VirtualClock(START);
    const ids = new DeterministicIdGenerator(clock, new SeededRng(3));
    const generated: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      generated.push(ids.next('evt'));
      await clock.advance('PT0.001S');
    }
    expect(generated).toEqual([...generated].sort());
  });

  it('fails loudly rather than minting out-of-order ids when the clock never moves', () => {
    // 4096 ids in one virtual millisecond means the test forgot to advance the clock. Silently
    // wrapping the counter would produce ids that sort wrongly, and the resulting outbox bug would
    // be very hard to trace back to here.
    const ids = make();
    expect(() => {
      for (let i = 0; i < 5000; i += 1) ids.next('msg');
    }).toThrow(/Advance the clock between batches/);
  });
});

describe('re-validated against the prefix registry (M1-T3)', () => {
  /**
   * `M1-T3`'s acceptance criterion: the `M0-T7` deterministic generator has to agree with the
   * registry that arrived later.
   *
   * It matters because this generator is what every golden transcript, scenario and property test
   * uses. If it produced ids the real parser rejected, the entire suite would be running against
   * values that could never exist in production — green, and testing a fiction.
   */
  it('produces a parseable id for every prefix in the registry', () => {
    const ids = make();
    for (const prefix of KNOWN_PREFIXES) {
      const id = ids.next(prefix);
      expect(parseId(prefix, id).ok, prefix).toBe(true);
      expect(isId(prefix, id), prefix).toBe(true);
    }
  });

  it('produces ids typeid-js also accepts, for every prefix', () => {
    const ids = make();
    for (const prefix of KNOWN_PREFIXES) {
      const id = ids.next(prefix);
      expect(() => TypeID.fromString(id), prefix).not.toThrow();
      expect(TypeID.fromString(id).getType(), prefix).toBe(prefix);
    }
  });

  it('shares the UUIDv7 layout with the production generator', () => {
    // One `UuidV7Source` for both, since `M1-T3`. Two copies of the RFC 9562 layout could drift so
    // that test ids sorted and production ids did not — or the reverse, which is worse, because
    // the suite would be green.
    const clock = new VirtualClock(START);
    const deterministic = new DeterministicIdGenerator(clock, new SeededRng(42));
    const production = new TypeIdGenerator(clock);
    const a = TypeID.fromString(deterministic.next('grp')).toUUIDBytes();
    const b = TypeID.fromString(production.next('grp')).toUUIDBytes();
    // Same timestamp, same version and variant bits; only the random tail differs.
    expect(a.slice(0, 6)).toEqual(b.slice(0, 6));
    expect((a[6] ?? 0) & 0xf0).toBe((b[6] ?? 0) & 0xf0);
    expect((a[8] ?? 0) & 0xc0).toBe((b[8] ?? 0) & 0xc0);
  });

  it('brands on the prefix, so a group id is not a member id', () => {
    const ids = make();
    const group = ids.next('grp');
    expect(isId('grp', group)).toBe(true);
    expect(isId('mbr', group)).toBe(false);
  });
});
