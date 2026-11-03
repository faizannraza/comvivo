/**
 * `SeededRng` — a reproducible `Rng` for tests, scenarios and property runs.
 *
 * `11` §3.1.7. The generator is xoroshiro128+ from `pure-rand`, the same family fast-check uses, so
 * a counterexample found by a property test and a scenario replayed from a seed draw from the same
 * sequence.
 *
 * The important design choice is **`fork`**. A child's seed is derived from `(parentSeed, label)`,
 * which means adding a new consumer never perturbs the existing ones. Without that, inserting a
 * single `rng.next()` anywhere would shift every subsequent draw and break every golden transcript
 * in the suite at once — so a one-line change to the proactivity sampler would look like a
 * regression in forty unrelated scenarios.
 *
 * Not for cryptography. Tokens, keys and nonces come from `shared/crypto`, which uses a CSPRNG.
 */
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import type { Rng } from '../ports/rng.js';

/** FNV-1a (32-bit). Small, fast, and good enough to spread labels across the seed space. */
export function fnv1a32(text: string, seed = 0x811c_9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // The FNV prime, 16777619, via shifts: Math.imul keeps this exact in 32 bits.
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash >>> 0;
}

/** The documented derivation for a child seed (`11` §3.1.7). */
export function childSeed(parentSeed: number, label: string): number {
  return fnv1a32(label, parentSeed >>> 0);
}

export class SeededRng implements Rng {
  readonly seed: number;
  #generator: ReturnType<typeof xoroshiro128plus>;
  #draws = 0;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.#generator = xoroshiro128plus(this.seed);
  }

  /** How many 32-bit draws have been taken. Useful when a replay diverges and you need to know where. */
  get draws(): number {
    return this.#draws;
  }

  /** A raw unsigned 32-bit draw. */
  nextUint32(): number {
    this.#draws += 1;
    return this.#generator.next() >>> 0;
  }

  /**
   * A float in `[0, 1)` with 53 bits of precision.
   *
   * Two draws rather than one: a single 32-bit value gives only ~4.3 billion distinct floats, which
   * shows up as visible collisions once a scenario samples a few thousand times.
   */
  next(): number {
    const high = this.nextUint32() >>> 5; // 27 bits
    const low = this.nextUint32() >>> 6; // 26 bits
    return (high * 67_108_864 + low) / 9_007_199_254_740_992;
  }

  /**
   * An integer in `[0, maxExclusive)`, uniform.
   *
   * Rejection sampling, not modulo. `next() % n` is biased toward the low values whenever `n` does
   * not divide 2³², and for a fairness algorithm that bias is exactly the bug the algorithm exists
   * to avoid — the member who sorts first would get marginally more chores forever.
   */
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`nextInt needs a positive integer bound, got ${String(maxExclusive)}`);
    }
    if (maxExclusive === 1) return 0;
    // Largest multiple of the bound that fits in 32 bits; anything above it is rejected.
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    let draw = this.nextUint32();
    while (draw >= limit) draw = this.nextUint32();
    return draw % maxExclusive;
  }

  /**
   * A child generator for `label`.
   *
   * Independent of how many draws the parent has taken, so two consumers that fork the same label
   * get the same stream regardless of call order — which is what makes a scenario's output stable
   * while it is still being written.
   */
  fork(label: string): SeededRng {
    return new SeededRng(childSeed(this.seed, label));
  }

  /** A copy at exactly this point in the stream, for exploring two branches from one state. */
  clone(): SeededRng {
    const copy = new SeededRng(this.seed);
    copy.#generator = this.#generator.clone();
    copy.#draws = this.#draws;
    return copy;
  }

  /** Pick one element. Throws on an empty array rather than returning undefined. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick needs a non-empty array');
    return items[this.nextInt(items.length)] as T;
  }

  /** A Fisher–Yates shuffle into a new array. Deterministic for a given seed. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(i + 1);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }
}

/** A scenario's default seed, derived from its id so it is stable without being written down. */
export function seedForScenario(scenarioId: string): number {
  return fnv1a32(scenarioId);
}
