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
    const id = make().generate('grp');
    expect(() => TypeID.fromString(id)).not.toThrow();
    expect(TypeID.fromString(id).getType()).toBe('grp');
  });

  it.each(['grp', 'mbr', 'mem', 'turn', 'msg', 'evt'])('works for the %s prefix', (prefix) => {
    const id = make().generate(prefix);
    expect(id.startsWith(`${prefix}_`)).toBe(true);
    expect(TypeID.fromString(id).getType()).toBe(prefix);
  });

  it('has a 26-character Crockford base32 suffix', () => {
    const suffix = make().generate('grp').split('_')[1];
    expect(suffix).toHaveLength(26);
    expect(suffix).toMatch(/^[0-9a-hjkmnp-tv-z]{26}$/);
  });

  it('encodes UUID version 7 and the RFC 9562 variant bits', () => {
    const uuid = TypeID.fromString(make().generate('grp')).toUUID();
    // xxxxxxxx-xxxx-7xxx-[89ab]xxx-xxxxxxxxxxxx
    expect(uuid[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(uuid[19]);
  });

  it("encodes the clock's millisecond in the timestamp field", () => {
    const clock = new VirtualClock(START);
    const ids = new DeterministicIdGenerator(clock, new SeededRng(1));
    const uuid = TypeID.fromString(ids.generate('grp')).toUUID();
    const ms = Number.parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);
    expect(ms).toBe(clock.now().epochMilliseconds);
  });
});

describe('determinism', () => {
  it('gives the same id for the same seed, clock and prefix', () => {
    expect(make(42).generate('grp')).toBe(make(42).generate('grp'));
  });

  it('gives a different id for a different seed', () => {
    expect(make(42).generate('grp')).not.toBe(make(43).generate('grp'));
  });

  it('gives a different id at a different instant', () => {
    expect(make(42, START).generate('grp')).not.toBe(
      make(42, '2026-06-01T12:00:01Z').generate('grp'),
    );
  });

  it('reproduces a whole sequence, which is what a golden transcript compares', () => {
    const first = make(7);
    const second = make(7);
    for (let i = 0; i < 20; i += 1) {
      expect(second.generate('msg')).toBe(first.generate('msg'));
    }
  });

  it('keeps sequences independent per generator instance', () => {
    const a = make(7);
    const b = make(7);
    a.generate('msg');
    // `b` has not advanced, so its first id still matches `a`'s first.
    expect(b.generate('msg')).toBe(make(7).generate('msg'));
  });
});

describe('monotonicity', () => {
  it('sorts in creation order within a single millisecond', () => {
    // The turn journal and the outbox take id order AS creation order, so this is not cosmetic.
    const ids = make();
    const generated = Array.from({ length: 200 }, () => ids.generate('turn'));
    expect(generated).toEqual([...generated].sort());
  });

  it('never repeats an id within a millisecond', () => {
    const ids = make();
    const generated = Array.from({ length: 500 }, () => ids.generate('msg'));
    expect(new Set(generated).size).toBe(500);
  });

  it('sorts in creation order across milliseconds', async () => {
    const clock = new VirtualClock(START);
    const ids = new DeterministicIdGenerator(clock, new SeededRng(3));
    const generated: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      generated.push(ids.generate('evt'));
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
      for (let i = 0; i < 5000; i += 1) ids.generate('msg');
    }).toThrow(/Advance the VirtualClock/);
  });
});
