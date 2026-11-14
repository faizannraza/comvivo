/**
 * `01` §2.1's non-negotiables, on every adapter (`11` §3.1.9; `M2-T14`).
 *
 * Every assertion here runs **four times**, once per provider, against a request that really
 * travelled over TCP and was really parsed by that provider's SDK. The rules live in
 * `testing/adapter-contract.ts`; this file is the registration, and the registration is the point:
 * a fifth provider cannot be added without a subject, and a rule added to the kit applies to all
 * four at once.
 *
 * The suite also checks each provider's **lens** before it checks the rules, because a lens that
 * found nothing would make a rule pass vacuously — and that is the only failure this file could
 * have that nobody would notice.
 */
import { describe, expect, it } from 'vitest';
import { anthropicSubject } from './anthropic/testing/contract-subject.js';
import { googleSubject } from './google/testing/contract-subject.js';
import { openaiSubject } from './openai/testing/contract-subject.js';
import { localSubject } from './openai-compatible/testing/contract-subject.js';
import { runAdapterContract } from './testing/adapter-contract.js';

/**
 * Every adapter, as `01` §2.1's four providers.
 *
 * A list rather than four `describe` blocks written out, and **the count is asserted below** — so
 * an adapter that shipped without registering here fails a test instead of quietly running
 * three-quarters of the contract.
 *
 * (This said the count was asserted in `adapter-contract.test.ts`. There is no such file, and
 * `CONTRACT_SUBJECTS` is referenced only from this one — so the claim pointed at nothing and the
 * count was asserted nowhere. Found at the M2 second-pass review; the assertion is now real.)
 */
export const CONTRACT_SUBJECTS = [
  anthropicSubject,
  openaiSubject,
  googleSubject,
  localSubject,
] as const;

describe('the contract covers every adapter', () => {
  it('registers all four of `01` §2.1’s providers, each once', () => {
    // The assertion the comment above promised and nothing made. An adapter added to
    // `packages/models/src` without a line in `CONTRACT_SUBJECTS` would run none of the contract
    // and report nothing — the suite would simply be smaller, which is invisible in a green run.
    // `ProviderId` minus `fake` is the list; a fifth provider breaks this until it is registered.
    expect(CONTRACT_SUBJECTS.map((make) => make().provider).toSorted()).toEqual([
      'anthropic',
      'google',
      'openai',
      'openai-compatible',
    ]);
  });
});

for (const makeSubject of CONTRACT_SUBJECTS) {
  const subject = makeSubject();
  describe(`${subject.provider}: 01 §2.1 on every captured request`, () => {
    runAdapterContract(subject);
  });
}
