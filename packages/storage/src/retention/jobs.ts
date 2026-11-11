/**
 * The job kinds retention owns (`02` §3.10.1, §3.13.2, §3.13.4, §3.13.5).
 *
 * `02` §3.10.1's catalog already fixes each kind's pool, partition scope, seriality and priority —
 * those are the global concurrency budget and not an owner's to choose. What an owner supplies is
 * the **payload schema**, which is the part the catalog does not know, and `JobKindRegistry.register`
 * is where the two meet.
 *
 * ## Why the payload is an id and nothing else
 *
 * A purge's payload could carry the group id, the requester and the step to resume from. It carries
 * a `deletionId`, because all three of those live in the `deletions` row and that row is the thing
 * the handler must read anyway: `02` D18 makes the purge resumable through `deletions.progress`, so
 * a payload that duplicated any of it would be a second copy that a crash can leave stale. The
 * payload's only job is to say *which* deletion.
 *
 * It also makes the handler's recovery path trivial. A job row can outlive the code that wrote it
 * (`02` §3.10.1 validates the payload again on claim), and a one-field payload is one field that
 * can fail to parse.
 */
import type { JobKindDef } from '@comvivo/core';
import { type DeletionId, idSchema, z } from '@comvivo/shared';
import type { JobKindRegistry } from '../queue/kinds.js';

/** `02` §3.10.1's `group.purge`. */
export const PURGE_JOB_KIND = 'group.purge';

/** `02` §3.10.1's `privacy.erase_person`. */
export const ERASE_JOB_KIND = 'privacy.erase_person';

/** `02` §3.10.1's `retention.sweep`. */
export const SWEEP_JOB_KIND = 'retention.sweep';

/** Both long deletions take the same payload: which `deletions` row to work on. */
export const DeletionJobPayloadSchema = z.object({ deletionId: idSchema('del') });

export interface DeletionJobPayload {
  readonly deletionId: DeletionId;
}

/**
 * The daily sweep takes no payload at all.
 *
 * An empty object rather than `z.void()`: `02` §3.10.1 stores a payload as text and a schedule tick
 * enqueues `{}`, so the schema has to accept that. `.strict()` by `z.object`'s default here means a
 * payload that grew a field — a table name, a limit — fails on claim rather than being ignored,
 * which is the right direction for a job whose whole contract is "sweep everything".
 */
export const SweepJobPayloadSchema = z.object({});

export interface RetentionJobKinds {
  readonly purge: JobKindDef<{ deletionId: DeletionId }>;
  readonly erase: JobKindDef<{ deletionId: DeletionId }>;
  readonly sweep: JobKindDef<Record<string, never>>;
}

/**
 * Register retention's three kinds and return their definitions.
 *
 * Called once per connection, at the composition root, so the worker loop and the primitives share
 * one registry — two registries would mean a kind the primitives can enqueue and the worker cannot
 * claim, which is a job that sits in `queued` forever with nothing wrong anywhere.
 */
export function registerRetentionKinds(registry: JobKindRegistry): RetentionJobKinds {
  return {
    purge: registry.register(PURGE_JOB_KIND, DeletionJobPayloadSchema),
    erase: registry.register(ERASE_JOB_KIND, DeletionJobPayloadSchema),
    sweep: registry.register(SWEEP_JOB_KIND, SweepJobPayloadSchema),
  };
}
