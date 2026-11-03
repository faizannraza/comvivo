/**
 * The `Rng` port.
 *
 * `01` §4 bans `Math.random` in `core`. Randomness is injected so that anything random is
 * reproducible, and in this product several of those things are consequential:
 *
 *  - fair chore assignment and rotation, where a member may reasonably ask *why* it was their turn;
 *  - tie-breaking in conflict resolution, which the audit trail has to be able to explain;
 *  - the proactivity sampler that decides whether a borderline interjection is worth the budget.
 *
 * `00` §3.6 promises every action has a "why" trail. An unseeded `Math.random()` in any of the
 * above makes that promise unkeepable — the answer becomes "chance", with no way to replay it.
 *
 * This port is **not** for cryptography. Tokens, keys and nonces come from `shared/crypto`, which
 * uses a CSPRNG; `Rng` is explicitly allowed to be a fast seedable PRNG and must never be used
 * where unpredictability is a security property.
 *
 * Implementations: `SystemRng` in `M1-T3`, `SeededRng` (xoroshiro128+) in `M0-T7`.
 */
export interface Rng {
  /** A float in `[0, 1)`. */
  next(): number;

  /** An integer in `[0, maxExclusive)`. Uniform; no modulo bias. */
  nextInt(maxExclusive: number): number;

  /**
   * A child generator, derived from a label.
   *
   * Child seeds are derived from `(seed, label)`, so adding a new consumer never perturbs the
   * existing ones. Without that, inserting one `rng.next()` call anywhere would change every
   * downstream draw and break every golden transcript at once (`11` §3.1.7).
   */
  fork(label: string): Rng;
}
