/**
 * `sec.callbacks.forged`, run against the reference resolver (`08` T-S06; `M3-T10`).
 *
 * Same argument as `conformance.test.ts`: a harness nothing has ever passed is a description. The
 * reference resolver is a map and `decideClick`, which is the smallest thing that can satisfy the
 * scenarios — and `M3-T24`'s engine resolver, which does the database lookup, the identity
 * resolution and the policy re-check, runs the same function with its own store.
 */
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { decideClick } from '../interactions/resolve.js';
import { interactionTokenHash } from '../interactions/token.js';
import {
  type ClickResolver,
  forgedCallbackChecks,
  referenceClickResolver,
  type SeededToken,
  seedToken,
} from './callbacks.js';

const FIXTURES = {
  now: Temporal.Instant.from('2026-11-15T12:00:00Z'),
  past: Temporal.Instant.from('2026-11-14T12:00:00Z'),
  eligible: 'mbr_ana',
  other: 'mbr_sam',
};

describe('the reference resolver passes the harness', () => {
  it('runs every scenario T-S06 names', async () => {
    await expect(forgedCallbackChecks(referenceClickResolver, FIXTURES)).resolves.toBeUndefined();
  });
});

describe('the harness catches a resolver that gets it wrong', () => {
  /** A resolver with one rule removed, which is what a planted break looks like here. */
  const broken = (
    mutate: (seeded: readonly SeededToken[]) => ClickResolver,
  ): ((seeded: readonly SeededToken[]) => ClickResolver) => mutate;

  it('a resolver that trusts the payload’s shape instead of the row', async () => {
    // The whole of T-S06 in one line: if a well-formed token resolves without a row behind it, a
    // member can mint their own.
    await expect(
      forgedCallbackChecks(
        broken((seeded) => ({
          resolve: (attempt) =>
            Promise.resolve(
              attempt.token.startsWith('v1.')
                ? {
                    outcome: 'ok',
                    action: seeded[0]?.record.action ?? { kind: 'x', params: {} },
                    createdByTurnId: 'trn_1',
                  }
                : { outcome: 'unknown' },
            ),
        })),
        FIXTURES,
      ),
    ).rejects.toThrow(/must be `unknown`/);
  });

  it('a resolver that checks eligibility before expiry', async () => {
    // The oracle. A refusal that says "not allowed" on a dead button tells an ineligible member it
    // had been a live one.
    await expect(
      forgedCallbackChecks(
        broken((seeded) => {
          const rows = new Map(
            seeded.map((entry) => [hex(entry.record.tokenHash), entry.record] as const),
          );
          return {
            resolve: (attempt) => {
              const record = rows.get(hex(interactionTokenHash(attempt.token))) ?? null;
              if (record === null) return Promise.resolve({ outcome: 'unknown' as const });
              if (
                record.allowedClickers !== 'any_member' &&
                !record.allowedClickers.includes(attempt.clickerMemberId)
              ) {
                return Promise.resolve({ outcome: 'not_allowed' as const });
              }
              return Promise.resolve(decideClick(record, attempt));
            },
          };
        }),
        FIXTURES,
      ),
    ).rejects.toThrow(/Check expiry before eligibility/);
  });

  it('a resolver that never records a single use', async () => {
    await expect(
      forgedCallbackChecks(
        broken((seeded) => {
          const rows = new Map(
            seeded.map((entry) => [hex(entry.record.tokenHash), entry.record] as const),
          );
          return {
            resolve: (attempt) =>
              Promise.resolve(
                decideClick(rows.get(hex(interactionTokenHash(attempt.token))) ?? null, attempt),
              ),
          };
        }),
        FIXTURES,
      ),
    ).rejects.toThrow(/single-use token resolved twice/);
  });

  it('a resolver that refuses everything', async () => {
    // The control the harness needs on itself: without the genuine-press check first, every
    // refusal below would pass against a resolver that says no to all of it.
    await expect(
      forgedCallbackChecks(
        broken(() => ({ resolve: () => Promise.resolve({ outcome: 'unknown' as const }) })),
        FIXTURES,
      ),
    ).rejects.toThrow(/genuine token pressed by an eligible member was refused/);
  });
});

describe('seedToken', () => {
  it('links the row to the token only by its hash', () => {
    // The thing every scenario rests on: a seeder that stored the token itself, or a digest of
    // something else, would make the forgery cases pass for the wrong reason.
    const { token, record } = seedToken({
      action: { kind: 'confirm', params: {} },
      allowedClickers: 'any_member',
      singleUse: false,
      expiresAt: FIXTURES.now.add({ hours: 1 }),
    });
    expect([...record.tokenHash]).toEqual([...interactionTokenHash(token)]);
    expect(hex(record.tokenHash)).not.toContain(token.slice(3, 11));
  });

  it('mints a different token every time', () => {
    const base = {
      action: { kind: 'confirm', params: {} },
      allowedClickers: 'any_member' as const,
      singleUse: false,
      expiresAt: FIXTURES.now,
    };
    const tokens = new Set(Array.from({ length: 200 }, () => seedToken(base).token));
    expect(tokens.size).toBe(200);
  });
});

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
