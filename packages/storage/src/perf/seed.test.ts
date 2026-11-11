/**
 * The fixture generator's distributions (`02` §3.16.5).
 *
 * A perf fixture is a measuring instrument like the harness that runs against it: if the text is
 * not Zipf-distributed, the FTS numbers are about a vocabulary nobody has; if the vectors are not
 * clustered, the KNN numbers are about a geometry nobody has. So the distributions are asserted,
 * not assumed — and the **vocabulary is pinned**, because `02` §3.16.5's words are generated from
 * the seed rather than committed, and a silent change to the generator would move every text
 * measurement at once.
 */

import { SeededRng } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import {
  at,
  diurnalWeights,
  drawFrom,
  pick,
  pickWeighted,
  SEED_PROFILES,
  standardNormal,
  vocabularyFor,
  zipfTable,
} from './seed.js';

describe('02 §3.16.5’s profiles', () => {
  it('are the four the section names, plus knn-50k', () => {
    expect(Object.keys(SEED_PROFILES).toSorted()).toEqual([
      'busy-3y',
      'family-1y',
      'knn-50k',
      'release-small',
      'stress-50k-1m',
    ]);
  });

  it('give the stress profile the shape §3.16.5 specifies', () => {
    const stress = SEED_PROFILES['stress-50k-1m'];
    // "5 groups; group 0 = 600k msgs / 30k memories / 150 members; others 100k msgs / 5k memories".
    expect(stress.groups).toHaveLength(5);
    const [first, ...rest] = stress.groups;
    expect(first?.members).toBe(150);
    expect((first?.days ?? 0) * (first?.msgsPerDay ?? 0)).toBe(600_000);
    expect(first?.memoriesTotal).toBe(30_000);
    for (const group of rest) {
      expect(group.days * group.msgsPerDay).toBe(100_000);
      expect(group.memoriesTotal).toBe(5_000);
    }
    // One million messages and fifty thousand memories in total, which is what §3.16.4's data-size
    // column means by "1M msgs / 50k memories".
    const messages = stress.groups.reduce((sum, group) => sum + group.days * group.msgsPerDay, 0);
    const memories = stress.groups.reduce((sum, group) => sum + group.memoriesTotal, 0);
    expect([messages, memories]).toEqual([1_000_000, 50_000]);
  });

  it('puts all 50k memories of knn-50k in one group', () => {
    // The reason this profile exists: a vec0 partition key *is* the group, so "50k vectors in one
    // partition" is a different query from 50k spread across five.
    const knn = SEED_PROFILES['knn-50k'];
    expect(knn.groups).toHaveLength(1);
    expect(knn.groups[0]?.memoriesTotal).toBe(50_000);
  });

  it('shares one seed and one embedding shape', () => {
    for (const profile of Object.values(SEED_PROFILES)) {
      expect(profile.seed, profile.name).toBe(42);
      expect(profile.embedding, profile.name).toEqual({
        dims: 384,
        clustersPerGroup: 64,
        noiseSigma: 0.35,
      });
      // The language weights sum to one, or the mix is not the mix the section describes.
      const total = profile.languages.reduce((sum, entry) => sum + entry.weight, 0);
      expect(total, profile.name).toBeCloseTo(1, 10);
    }
  });
});

describe('the Zipf sampler', () => {
  it('is a cumulative distribution with the right skew', () => {
    const table = zipfTable(5_000, 1.1);
    expect(table).toHaveLength(5_000);
    expect(table.at(-1)).toBeCloseTo(1, 10);
    // Measured, not guessed: Zipf(1.1) over 5,000 terms gives the first term **15.8%** and the
    // top ten **42.4%**. The shape is what matters — a flat distribution would make every FTS
    // query hit the same number of rows, which is the thing an index is sensitive to — but the
    // figures are pinned because they are what the measured FTS latencies were taken against.
    expect(table[0]).toBeCloseTo(0.158, 2);
    expect(table[9]).toBeCloseTo(0.424, 2);
    // A flat table would put the tenth term at 0.002; this is 200× that.
    expect(table[9]).toBeGreaterThan(10 / 5_000);
  });

  it('draws the common terms far more often than the rare ones', () => {
    const table = zipfTable(1_000);
    const rng = new SeededRng(42);
    const counts = new Map<number, number>();
    for (let draw = 0; draw < 20_000; draw += 1) {
      const index = drawFrom(table, rng.next());
      counts.set(index, (counts.get(index) ?? 0) + 1);
    }
    const first = counts.get(0) ?? 0;
    const hundredth = counts.get(99) ?? 0;
    expect(first).toBeGreaterThan(hundredth * 10);
  });

  it('is deterministic for a seed', () => {
    const table = zipfTable(100);
    const draws = (seed: number): number[] => {
      const rng = new SeededRng(seed);
      return Array.from({ length: 20 }, () => drawFrom(table, rng.next()));
    };
    // The whole point of a seeded fixture: a measurement taken today is comparable with one taken
    // next month because the data is the same data.
    expect(draws(42)).toEqual(draws(42));
    expect(draws(42)).not.toEqual(draws(43));
  });
});

describe('the index guards', () => {
  // Every index in the generator is derived from the length of the list it indexes, so these
  // throws are unreachable from `seedPerfDatabase`. They exist as *one* guard in place of a dozen
  // `?? fallback` arms that could never run, and they throw rather than substitute because each
  // call site feeds a distribution that a published measurement is a statement about: a quietly
  // substituted member would bias the sender mix, and a quietly substituted label would make the
  // eligibility predicate cheaper than production's.
  it('return the element an in-range index names', () => {
    expect(at(['a', 'b', 'c'], 1)).toBe('b');
    expect(pick(['only'], new SeededRng(42))).toBe('only');
    expect(pickWeighted(['a', 'b'], [0.5, 1], new SeededRng(42))).toBeOneOf(['a', 'b']);
  });

  it('throw rather than substitute when the fixture is malformed', () => {
    expect(() => at(['a'], 3)).toThrow(/index 3 is outside a list of 1/);
    expect(() => at([], 0)).toThrow(RangeError);
    expect(() => pick([], new SeededRng(42))).toThrow(RangeError);
    // A table longer than its list: the draw lands past the end, which is the mismatch the
    // weighted helper's own doc comment is about.
    expect(() => pickWeighted(['a', 'b'], [0.2, 0.4, 0.6, 0.8, 1], new SeededRng(7))).toThrow(
      /outside a list of 2/,
    );
    // A hole in the cumulative table, which `drawFrom`'s binary search reads directly.
    const holed = [undefined, 1] as unknown as readonly number[];
    expect(() => drawFrom(holed, 0.9)).toThrow(/cumulative table cannot have a hole/);
  });
});

describe('the generated vocabulary', () => {
  it('is pinned per language, so a generator change is visible', () => {
    // `02` §3.16.5 asks for committed word lists; `M1-T33` generates them from the seed instead
    // and pins the head of each here. If these change, every text measurement in
    // `docs/architecture/storage-benchmarks.md` was taken against a different corpus.
    const head = (language: Parameters<typeof vocabularyFor>[0]): readonly string[] =>
      vocabularyFor(language, new SeededRng(42), 50).slice(0, 3);
    expect(head('en')).toEqual(['enlyberlinful', 'enfulinglin', 'enberingber']);
    expect(head('ja')).toEqual(['jahonshitsukyo', 'jakyosatsu', 'jashisashi']);
    expect(head('ar')).toEqual(['arkranabmadtun', 'artunshumad', 'arabshuab']);
  });

  it('gives each language distinct, non-repeating words', () => {
    for (const language of ['en', 'es', 'de', 'fr', 'pt', 'hi-Latn', 'ar', 'ja'] as const) {
      const words = vocabularyFor(language, new SeededRng(42), 5_000);
      // 5,000 **distinct** terms: an FTS vocabulary with duplicates has fewer distinct terms than
      // the number says, and the number is what the index size is reasoned about from.
      expect(new Set(words).size, language).toBe(5_000);
      expect(
        words.every((word) => word.startsWith(language.replace('-', ''))),
        language,
      ).toBe(true);
    }
    // And no two languages share a term, so a per-language query is really per-language.
    const english = new Set(vocabularyFor('en', new SeededRng(42), 200));
    const japanese = vocabularyFor('ja', new SeededRng(42), 200);
    expect(japanese.some((word) => english.has(word))).toBe(false);
  });
});

describe('the clock and the noise', () => {
  it('peaks at 08:00 and 20:00', () => {
    const weights = diurnalWeights();
    expect(weights).toHaveLength(24);
    const peak = Math.max(...weights);
    expect(weights.indexOf(peak)).toBeOneOf([8, 20]);
    expect(weights[8]).toBeGreaterThan((weights[3] ?? 0) * 2);
    expect(weights[20]).toBeGreaterThan((weights[3] ?? 0) * 2);
    // Never zero: a message at 03:00 is unusual, not impossible, and a zero-weight hour would
    // leave a gap no retention or catch-up query ever sees.
    expect(Math.min(...weights)).toBeGreaterThan(0);
  });

  it('draws a standard normal', () => {
    const rng = new SeededRng(42);
    const samples = Array.from({ length: 20_000 }, () => standardNormal(rng));
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const variance =
      samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1);
    expect(mean).toBeCloseTo(0, 1);
    expect(variance).toBeCloseTo(1, 1);
    // Box–Muller's failure mode is `log(0)`: `next()` can return exactly zero, and the guard is
    // what keeps an `Infinity` out of a vector that would then poison a whole partition.
    expect(samples.every((value) => Number.isFinite(value))).toBe(true);
  });
});
