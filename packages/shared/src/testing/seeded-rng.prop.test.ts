/**
 * `SeededRng` properties (`11` §3.1.6, §3.1.7).
 *
 * The one that matters most is **fork stability**: a child's stream depends only on
 * `(parentSeed, label)`, never on how much the parent has drawn. Without that, inserting a single
 * `rng.next()` anywhere would shift every subsequent draw and break every golden transcript at
 * once — so a one-line change to the proactivity sampler would present as a regression in forty
 * unrelated scenarios.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fcConfig } from './fc-config.js';
import { childSeed, fnv1a32, SeededRng } from './seeded-rng.js';

const seeds = fc.integer({ min: 0, max: 0xffff_ffff });
const labels = fc.string({ minLength: 1, maxLength: 24 });

describe('SeededRng properties', { tags: ['prop'] }, () => {
  it('is fully determined by its seed', () => {
    fc.assert(
      fc.property(seeds, fc.integer({ min: 1, max: 50 }), (seed, draws) => {
        const a = new SeededRng(seed);
        const b = new SeededRng(seed);
        for (let i = 0; i < draws; i += 1) expect(a.next()).toBe(b.next());
      }),
      fcConfig(),
    );
  });

  it('forks identically regardless of how much the parent has drawn', () => {
    // THE property. Fork must not depend on parent position, or adding a consumer perturbs
    // every existing one.
    fc.assert(
      fc.property(seeds, labels, fc.integer({ min: 0, max: 100 }), (seed, label, parentDraws) => {
        const early = new SeededRng(seed).fork(label);

        const parent = new SeededRng(seed);
        for (let i = 0; i < parentDraws; i += 1) parent.next();
        const late = parent.fork(label);

        expect(late.seed).toBe(early.seed);
        for (let i = 0; i < 10; i += 1) expect(late.next()).toBe(early.next());
      }),
      fcConfig(),
    );
  });

  it('gives different labels different streams', () => {
    fc.assert(
      fc.property(seeds, labels, labels, (seed, a, b) => {
        fc.pre(a !== b);
        const root = new SeededRng(seed);
        // Not a guarantee of the algorithm, but a collision rate high enough to matter would make
        // two consumers share a stream — worth noticing.
        expect(root.fork(a).seed).not.toBe(root.fork(b).seed);
      }),
      fcConfig(),
    );
  });

  it('produces floats strictly inside [0, 1)', () => {
    fc.assert(
      fc.property(seeds, (seed) => {
        const rng = new SeededRng(seed);
        for (let i = 0; i < 100; i += 1) {
          const value = rng.next();
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(1);
        }
      }),
      fcConfig(),
    );
  });

  it('keeps nextInt inside its bound', () => {
    fc.assert(
      fc.property(seeds, fc.integer({ min: 1, max: 1000 }), (seed, bound) => {
        const rng = new SeededRng(seed);
        for (let i = 0; i < 50; i += 1) {
          const value = rng.nextInt(bound);
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThan(bound);
        }
      }),
      fcConfig(),
    );
  });

  it('shuffles to a permutation, never losing or duplicating an element', () => {
    fc.assert(
      fc.property(seeds, fc.array(fc.integer(), { maxLength: 30 }), (seed, items) => {
        const shuffled = new SeededRng(seed).shuffle(items);
        expect(shuffled).toHaveLength(items.length);
        expect([...shuffled].sort((a, b) => a - b)).toEqual([...items].sort((a, b) => a - b));
      }),
      fcConfig(),
    );
  });

  it('clones to a generator that continues the same stream', () => {
    fc.assert(
      fc.property(seeds, fc.integer({ min: 0, max: 30 }), (seed, draws) => {
        const original = new SeededRng(seed);
        for (let i = 0; i < draws; i += 1) original.next();
        const copy = original.clone();
        for (let i = 0; i < 10; i += 1) expect(copy.next()).toBe(original.next());
      }),
      fcConfig(),
    );
  });
});

describe('fnv1a32', () => {
  it('matches the published vectors for the 32-bit variant', () => {
    // Known answers, so a refactor cannot silently change every derived seed in the project.
    expect(fnv1a32('')).toBe(0x811c_9dc5);
    expect(fnv1a32('a')).toBe(0xe40c_292c);
    expect(fnv1a32('foobar')).toBe(0xbf9c_f968);
  });

  it('stays inside 32 unsigned bits for any input', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const hash = fnv1a32(text);
        expect(Number.isInteger(hash)).toBe(true);
        expect(hash).toBeGreaterThanOrEqual(0);
        expect(hash).toBeLessThanOrEqual(0xffff_ffff);
      }),
      fcConfig(),
    );
  });
});

describe('childSeed', () => {
  it('depends on both the parent seed and the label', () => {
    expect(childSeed(1, 'ids')).not.toBe(childSeed(2, 'ids'));
    expect(childSeed(1, 'ids')).not.toBe(childSeed(1, 'model'));
  });

  it('is stable across calls, which is what makes replay possible', () => {
    expect(childSeed(99, 'persona:ava')).toBe(childSeed(99, 'persona:ava'));
  });
});
