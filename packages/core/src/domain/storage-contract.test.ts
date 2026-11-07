/**
 * The storage-contract registry (`M1-T12`).
 *
 * This suite is the thing that keeps a deferred interior from being a silent stub. `M1-T12`
 * declares every JSON column of `02` §3.3.4–§3.3.8; a handful of their schemas pin only the outer
 * shape and the size cap, because their interior *is* the deliverable of a task that is already
 * scheduled. Asserting the exact list here means:
 *
 *  - the set is visible in one place and in the milestone report;
 *  - adding one fails this test, so it cannot be done quietly;
 *  - removing one, when `M4`/`M5`/`M3` tightens it, also fails here — so the list cannot rot into
 *    a permanent excuse.
 */
import { describe, expect, it } from 'vitest';
import { jsonObjectShape, storageContract, storageContracts } from './storage-contract.js';

describe('the registered contracts', () => {
  it('is exactly this list, each with an owning milestone and a cap', () => {
    expect(storageContracts().map((entry) => `${entry.name} → ${entry.owner}`)).toEqual([
      'ActionRequestSnapshotSchema → M5 (05 §3.6.6 ActionRequest)',
      'CompiledPolicySchema → M4 (03 §3.2.6 constitution compiler)',
      'ConstraintValueSchema → M5-T7 (03 §3.5.4 constraint catalog v1)',
      'GuardResultTraceSchema → M5 (05 §3.8 disclosure guard records)',
      'ModelCallTraceSchema → M5 (05 §3.10 model call trace)',
      'OutboundPayloadSchema → M3 (06 §8 OutboundMessage and its channel-SDK member types)',
      'PolicyDecisionTraceSchema → M4 (03 §3.3 authorize() decision trace)',
      'ProposalPayloadSchema → M4 (03 §3.3.6 amendment and contested-action payloads)',
      'ToolCallTraceSchema → M5 (05 §3.6 tool call trace)',
      'TraceTriggerSchema → M5 (05 §3.2 router trigger classification)',
    ]);
  });

  it('gives every contract a positive cap and a description of what is pinned', () => {
    for (const entry of storageContracts()) {
      expect(entry.maxBytes, entry.name).toBeGreaterThan(0);
      expect(entry.pinned, entry.name).toMatch(/capped at/);
      expect(entry.owner, entry.name).toMatch(/^M\d/);
    }
  });

  it('names the 02 §3.3.9 cap for the two largest columns', () => {
    const byName = new Map(storageContracts().map((entry) => [entry.name, entry]));
    // `constitution_versions.compiled` is 256 KiB; `outbox_messages.payload` is 64 KiB.
    expect(byName.get('CompiledPolicySchema')?.maxBytes).toBe(256 * 1024);
    expect(byName.get('OutboundPayloadSchema')?.maxBytes).toBe(64 * 1024);
  });
});

describe('what a contract still enforces today', () => {
  // `CompiledPolicySchema`'s own entry, used as the subject: there is no way to register a
  // throwaway name any more, which is the point of the literal inventory.
  const schema = storageContract('CompiledPolicySchema', jsonObjectShape, 'probe');

  it('accepts an object of any interior', () => {
    // The deferral is real: the interior is not validated, and this test says so plainly rather
    // than implying a check that is not there.
    expect(schema.parse({ anything: 1, nested: { deep: true } })).toEqual({
      anything: 1,
      nested: { deep: true },
    });
  });

  it('refuses what is not a JSON object', () => {
    // The weakest outer shape used here, and still not nothing: a column holding a scalar, a
    // string, `null` or an array is caught as corruption on read rather than handed to a caller
    // that expects an object.
    for (const value of [null, 42, 'text', true, ['a']]) {
      expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it('enforces the cap, which is the half that protects the database', () => {
    const outcome = schema.safeParse({ key: 'x'.repeat(300_000) });
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.error.issues.some((issue) => issue.message.includes('262144-byte limit'))).toBe(
      true,
    );
  });

  it('refuses a name the inventory does not list, at module load', () => {
    // This is what makes the list authoritative rather than advisory: a deferred schema has to be
    // declared in `DEFERRED_INTERIORS` before it can exist, and the failure is a throw during
    // import rather than a missing entry nobody notices.
    expect(() => storageContract('NotDeclaredSchema', jsonObjectShape, 'probe')).toThrow(
      /not in DEFERRED_INTERIORS/,
    );
  });
});
