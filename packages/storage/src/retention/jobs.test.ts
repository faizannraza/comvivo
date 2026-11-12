/**
 * The payload schemas retention's three job kinds are registered with (`02` §3.10.1).
 *
 * A job payload is text in a row, written by one version of the product and claimed by another, so
 * "what happens to a field this build does not know" is a real question rather than a hypothetical.
 * The answer here is **refuse on claim**, which these tests pin — and which the code did not
 * actually do until `M1-T29` measured zod 4.6's `z.object` and found it *strips* unknown keys and
 * succeeds. The comment in `jobs.ts` had described the behaviour it wanted rather than the
 * behaviour it had.
 */
import { describe, expect, it } from 'vitest';
import {
  DeletionJobPayloadSchema,
  ERASE_JOB_KIND,
  PURGE_JOB_KIND,
  SWEEP_JOB_KIND,
  SweepJobPayloadSchema,
} from './jobs.js';

const DELETION_ID = 'del_01jxpf00000000000000000000';

describe('02 §3.10.1’s retention job kinds', () => {
  it('names each kind as the spec does', () => {
    // The kind string is what a queued row carries, so a rename is a job nothing can claim.
    expect([PURGE_JOB_KIND, ERASE_JOB_KIND, SWEEP_JOB_KIND]).toEqual([
      'group.purge',
      'privacy.erase_person',
      'retention.sweep',
    ]);
  });

  it('accepts the payload each kind is enqueued with', () => {
    expect(DeletionJobPayloadSchema.safeParse({ deletionId: DELETION_ID }).success).toBe(true);
    // A schedule tick enqueues `{}`, so the sweep's schema has to accept exactly that.
    expect(SweepJobPayloadSchema.safeParse({}).success).toBe(true);
  });

  it('refuses a payload carrying a field this version does not know', () => {
    // A purge is irreversible, and a field meant to narrow it that was silently discarded is the
    // worst outcome available: the job runs, wider than its author intended, and nothing says so.
    expect(
      DeletionJobPayloadSchema.safeParse({ deletionId: DELETION_ID, limitTables: ['messages'] })
        .success,
    ).toBe(false);
    expect(SweepJobPayloadSchema.safeParse({ table: 'messages' }).success).toBe(false);
    expect(SweepJobPayloadSchema.safeParse({ limit: 100 }).success).toBe(false);
  });

  it('refuses a deletion payload with no id, or a malformed one', () => {
    expect(DeletionJobPayloadSchema.safeParse({}).success).toBe(false);
    // Validated as a `del_` id rather than as a string: the row it names is the one being deleted.
    expect(DeletionJobPayloadSchema.safeParse({ deletionId: 'del_short' }).success).toBe(false);
    expect(
      DeletionJobPayloadSchema.safeParse({ deletionId: 'grp_01jrep10000000000000000000' }).success,
    ).toBe(false);
  });
});
