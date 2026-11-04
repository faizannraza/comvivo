/**
 * `DeterministicIdGenerator` properties (`11` §3.1.7, ADR-019).
 *
 * Two of these are load-bearing far beyond the test suite.
 *
 * **Distinctness** is obvious. **Lexicographic monotonicity** is the one that is easy to lose and
 * expensive to lose: the turn journal and the outbox read id order *as* order (`02`, `05`), so a
 * generator that minted an id sorting before its predecessor would reorder a member's reminders
 * without anything appearing to fail. UUIDv7 gives that property only if the timestamp and counter
 * are laid out correctly, which is exactly the kind of bit-fiddling a property test is for.
 */
import fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';
import { TypeID } from 'typeid-js';
import { describe, expect, it } from 'vitest';
import { DeterministicIdGenerator } from './deterministic-ids.js';
import { fcConfig } from './fc-config.js';
import { SeededRng } from './seeded-rng.js';
import { VirtualClock } from './virtual-clock.js';

/** A plan: at each step, advance some milliseconds and mint some ids. */
const plans = fc.array(
  fc.record({
    advanceMs: fc.integer({ min: 0, max: 5_000 }),
    // Well under the 4,096-per-millisecond counter ceiling, which is a deliberate hard failure
    // rather than a wrap (see `deterministic-ids.ts`).
    count: fc.integer({ min: 1, max: 12 }),
  }),
  { minLength: 1, maxLength: 25 },
);

const prefixes = fc.constantFrom('grp', 'mbr', 'mem', 'msg', 'trn', 'job', 'out');

async function run(
  plan: readonly { advanceMs: number; count: number }[],
  prefix: string,
  seed: number,
): Promise<string[]> {
  const clock = new VirtualClock('2026-01-01T00:00:00Z');
  const ids = new DeterministicIdGenerator(clock, new SeededRng(seed));
  const out: string[] = [];
  for (const step of plan) {
    await clock.advance(Temporal.Duration.from({ milliseconds: step.advanceMs }));
    for (let i = 0; i < step.count; i += 1) out.push(ids.generate(prefix));
  }
  return out;
}

describe('DeterministicIdGenerator properties', { tags: ['prop'] }, () => {
  it('never mints the same id twice', async () => {
    await fc.assert(
      fc.asyncProperty(plans, prefixes, fc.nat(), async (plan, prefix, seed) => {
        const ids = await run(plan, prefix, seed);
        expect(new Set(ids).size).toBe(ids.length);
      }),
      fcConfig(),
    );
  });

  it('mints ids that sort lexicographically in creation order', async () => {
    // The property the turn journal and the outbox depend on. If this breaks, a member's
    // reminders reorder and nothing reports an error.
    await fc.assert(
      fc.asyncProperty(plans, prefixes, fc.nat(), async (plan, prefix, seed) => {
        const ids = await run(plan, prefix, seed);
        const sorted = [...ids].sort();
        expect(sorted).toEqual(ids);
      }),
      fcConfig(),
    );
  });

  it('mints ids the TypeID parser accepts, with the requested prefix', async () => {
    // Cross-checked against typeid-js rather than our own encoder, so a mistake in the bit layout
    // cannot agree with itself.
    await fc.assert(
      fc.asyncProperty(plans, prefixes, fc.nat(), async (plan, prefix, seed) => {
        for (const id of await run(plan, prefix, seed)) {
          const parsed = TypeID.fromString(id);
          expect(parsed.getType()).toBe(prefix);
          // Version 7 and the RFC 9562 variant bits.
          const uuid = parsed.toUUID();
          expect(uuid[14]).toBe('7');
          expect(['8', '9', 'a', 'b']).toContain(uuid[19]);
        }
      }),
      fcConfig(),
    );
  });

  it('is fully determined by its clock and seed', async () => {
    // Reproducibility is what makes a golden transcript possible at all: the same scenario must
    // mint the same ids on every machine and every run.
    await fc.assert(
      fc.asyncProperty(plans, prefixes, fc.nat(), async (plan, prefix, seed) => {
        expect(await run(plan, prefix, seed)).toEqual(await run(plan, prefix, seed));
      }),
      fcConfig(),
    );
  });

  it('mints a different stream for a different seed', async () => {
    // The flip side: if the seed were ignored, every scenario would share one id stream and a
    // collision across two simulated groups would look like a real duplicate.
    await fc.assert(
      fc.asyncProperty(plans, prefixes, fc.nat(), async (plan, prefix, seed) => {
        const a = await run(plan, prefix, seed);
        const b = await run(plan, prefix, seed + 1);
        expect(a).not.toEqual(b);
      }),
      fcConfig(),
    );
  });

  it('refuses to mint more than the counter allows inside one virtual millisecond', async () => {
    // 4,096 ids in one virtual millisecond means the clock is not being advanced. Failing loudly
    // beats silently minting out-of-order ids.
    const clock = new VirtualClock('2026-01-01T00:00:00Z');
    const ids = new DeterministicIdGenerator(clock, new SeededRng(1));
    expect(() => {
      for (let i = 0; i < 5_000; i += 1) ids.generate('grp');
    }).toThrow();
  });
});
