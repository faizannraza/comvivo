/**
 * `DeterministicIdGenerator` — reproducible TypeIDs.
 *
 * `11` §3.1.7: valid TypeIDs, with the timestamp taken from the injected `Clock` and the random
 * bits from the injected `Rng`, monotonic within a millisecond.
 *
 * Why it has to be deterministic: golden transcripts (`11` §3.5) compare whole conversations, and
 * an id appears in a turn trace, an audit event, an outbox row and a permalink. A random id would
 * make every transcript differ on every run, so the goldens would have to normalise ids away — and
 * then they would stop catching the bug where the *wrong* id is used, which for this product is
 * invariant **I4** failing.
 *
 * Monotonicity is not cosmetic either. The turn journal and the outbox rely on id order being
 * creation order (`01` §6.2, invariants I6 and I7), so two ids minted in the same millisecond must
 * still sort correctly.
 *
 * The UUIDv7 byte layout itself lives in `../uuidv7.ts` and is shared with `TypeIdGenerator`
 * (`M1-T3`). Before that it was duplicated here, which is a hazard rather than untidiness: the
 * whole point of this class is to behave like the real generator.
 */
import { encodeTypeIdSuffix } from '../id-generator.js';
import type { Id, IdPrefix } from '../ids.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/ids.js';
import { COUNTER_MAX, UuidV7Source } from '../uuidv7.js';
import type { SeededRng } from './seeded-rng.js';

export class DeterministicIdGenerator implements IdGenerator {
  readonly #clock: Clock;
  readonly #source: UuidV7Source;

  constructor(clock: Clock, rng: SeededRng) {
    this.#clock = clock;
    // The same `UuidV7Source` the production generator uses, with the randomness and the counter
    // seed coming from the seeded RNG instead of a CSPRNG. One implementation of the RFC 9562
    // layout for both: two copies could drift so that test ids sorted and production ids did not,
    // or the reverse — which is worse, because the suite would be green.
    this.#source = new UuidV7Source(
      (target) => {
        for (let i = 0; i < target.length; i += 1) target[i] = rng.nextInt(256);
      },
      () => rng.nextInt(COUNTER_MAX + 1),
    );
  }

  next<P extends IdPrefix>(prefix: P): Id<P> {
    const bytes = this.#source.next(this.#clock.now().epochMilliseconds);
    return `${prefix}_${encodeTypeIdSuffix(bytes)}` as Id<P>;
  }
}
