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
import { describe } from 'vitest';
import { anthropicSubject } from './anthropic/testing/contract-subject.js';
import { googleSubject } from './google/testing/contract-subject.js';
import { openaiSubject } from './openai/testing/contract-subject.js';
import { localSubject } from './openai-compatible/testing/contract-subject.js';
import { runAdapterContract } from './testing/adapter-contract.js';

/**
 * Every adapter, as `01` §2.1's four providers.
 *
 * A list rather than four `describe` blocks written out: the count is asserted in
 * `adapter-contract.test.ts`, so an adapter that shipped without registering here fails a test
 * instead of quietly running three-quarters of the contract.
 */
export const CONTRACT_SUBJECTS = [
  anthropicSubject,
  openaiSubject,
  googleSubject,
  localSubject,
] as const;

for (const makeSubject of CONTRACT_SUBJECTS) {
  const subject = makeSubject();
  describe(`${subject.provider}: 01 §2.1 on every captured request`, () => {
    runAdapterContract(subject);
  });
}
