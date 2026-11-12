/**
 * The job-kind catalog and registry (`02` §3.10.1; ADR-012).
 *
 * `02` §3.10.1 calls its table **authoritative** — "every kind proposed anywhere in the plan" —
 * and adds the rule that makes it worth having: "a kind not in this table must not be enqueued
 * (registry assertion at boot)". This module is that table and that assertion.
 *
 * ## Why the catalog and the definition are separate
 *
 * The catalog is the half `02` owns: the kind's name, its partition scope, its pool, whether it is
 * serial, and the limits. The **payload schema** is the half the owning milestone owns — `04`
 * knows what an `extract.conversation` payload is and this module must not guess — so a
 * `JobKindDef` is *registered* by its owner rather than declared here.
 *
 * That split is what lets the assertion be real. A catalog carrying placeholder payload schemas
 * would be a set of stubs (`CLAUDE.md` §8), and a registry with no catalog would accept any string
 * a caller invented — which is how a typo becomes a job nothing ever runs, queued forever,
 * invisible except as a number in a gauge.
 *
 * ## The partition scope is a property of the kind, not of the caller
 *
 * `02` §3.10.1 marks each kind `G` or `I`, and `register` checks the partition key against it on
 * every enqueue. A group-scoped kind enqueued on `'_instance'` would serialise the whole host
 * against one group's work; an instance kind enqueued per group would run the nightly backup once
 * per group.
 */
import type { JobKindDef, JobPool, PartitionKey } from '@comvivo/core';
import { INSTANCE_PARTITION, JOB_BACKOFF } from '@comvivo/core';
import { isId, StorageError, type z } from '@comvivo/shared';

/** Whether a kind's partition is a group or the instance (`02` §3.10.1's `G` / `I`). */
export type PartitionScope = 'group' | 'instance';

/** One row of `02` §3.10.1's catalog: everything about a kind that is not its payload. */
export interface JobKindSpec {
  readonly kind: string;
  readonly scope: PartitionScope;
  readonly pool: JobPool;
  readonly serial: boolean;
  readonly singleFlightByKey?: boolean | undefined;
  /** `02` §3.10.1's defaults unless the table says otherwise. */
  readonly priority?: number | undefined;
  readonly leaseMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly concurrency?: number | undefined;
}

const DEFAULT_LEASE_MS = 60_000;
/** `02` §3.10.1: the timeout must be at or under 80% of the lease, so a heartbeat can still land. */
const TIMEOUT_RATIO = 0.8;

/**
 * `02` §3.10.1's catalog, transcribed row by row.
 *
 * Order follows the spec's table so the two can be diffed by eye. The `/`-separated rows in the
 * spec are expanded into one entry each, because a registry keyed by name cannot hold a slash.
 */
export const JOB_KIND_CATALOG: readonly JobKindSpec[] = [
  // `04`: memory.
  {
    kind: 'extract.conversation',
    scope: 'group',
    pool: 'model',
    serial: true,
    // `04` R11: one extraction per conversation at a time, or two would consolidate the same
    // messages into two different memory sets.
    singleFlightByKey: true,
  },
  { kind: 'embed.items', scope: 'group', pool: 'embed', serial: false, singleFlightByKey: true },
  { kind: 'memory.reembed', scope: 'instance', pool: 'embed', serial: true },
  { kind: 'consolidate.nightly', scope: 'group', pool: 'model', serial: true },
  { kind: 'consolidate.section', scope: 'group', pool: 'model', serial: true },
  { kind: 'consolidate.poll', scope: 'instance', pool: 'io', serial: false },
  { kind: 'memory.forget', scope: 'group', pool: 'io', serial: true },
  { kind: 'memory.proposals.ask', scope: 'group', pool: 'io', serial: false },

  // `06`: channels and media.
  { kind: 'attachment.fetch', scope: 'group', pool: 'media', serial: false },
  { kind: 'media.transcribe', scope: 'group', pool: 'media', serial: false },
  { kind: 'media.vision', scope: 'group', pool: 'media', serial: false },
  { kind: 'media.pdf', scope: 'group', pool: 'media', serial: false },
  { kind: 'chat.unclaimed.leave', scope: 'instance', pool: 'io', serial: false },
  { kind: 'chat.reprobe', scope: 'instance', pool: 'io', serial: false },
  { kind: 'channel.auth_check', scope: 'instance', pool: 'io', serial: false },
  { kind: 'email.poll', scope: 'group', pool: 'io', serial: false },

  // `03`: governance and declassification.
  { kind: 'declassify.item', scope: 'group', pool: 'model', serial: false },
  { kind: 'proposal.deadline', scope: 'group', pool: 'io', serial: false },
  { kind: 'confirmation.expire', scope: 'group', pool: 'io', serial: false },
  { kind: 'consent.grace', scope: 'group', pool: 'io', serial: false },
  { kind: 'constraint.expire', scope: 'group', pool: 'io', serial: false },
  { kind: 'fairness.ledger.rollup', scope: 'group', pool: 'maintenance', serial: true },
  { kind: 'privacy.debug_banner', scope: 'instance', pool: 'io', serial: false },

  // `05`: the turn runtime.
  {
    kind: 'route.interjection',
    scope: 'group',
    pool: 'model',
    serial: false,
    singleFlightByKey: true,
  },
  { kind: 'turn.continue', scope: 'group', pool: 'model', serial: true },
  { kind: 'notify.members', scope: 'group', pool: 'io', serial: false },

  // `07`: coordination.
  // `reminder.fire` is priority 10, the highest in the plan: a reminder that arrives late is the
  // one failure a member notices immediately, and `02` §3.10.1 says so.
  { kind: 'reminder.fire', scope: 'group', pool: 'io', serial: false, priority: 10 },
  { kind: 'calendar.subscription.refresh', scope: 'group', pool: 'io', serial: false },
  { kind: 'chores.materialize', scope: 'group', pool: 'io', serial: true },
  { kind: 'task.request_expiry', scope: 'group', pool: 'io', serial: false },
  { kind: 'swap.expire', scope: 'group', pool: 'io', serial: false },
  { kind: 'poll.close', scope: 'group', pool: 'io', serial: false },
  { kind: 'digest.morning', scope: 'group', pool: 'model', serial: false, priority: 5 },
  { kind: 'digest.weekly', scope: 'group', pool: 'model', serial: false, priority: 5 },
  { kind: 'proactive.evaluate', scope: 'group', pool: 'model', serial: false },
  { kind: 'proactive.sweep', scope: 'group', pool: 'io', serial: false },
  { kind: 'time.tzdata_changed', scope: 'instance', pool: 'maintenance', serial: true },

  // `10`, `11`: extensions and quality.
  { kind: 'plugin.job', scope: 'group', pool: 'io', serial: false },
  { kind: 'feedback.survey', scope: 'group', pool: 'io', serial: false },

  // `02`: storage maintenance. All `-5`, because none of it is anybody waiting.
  { kind: 'export.build', scope: 'group', pool: 'maintenance', serial: false, priority: -5 },
  { kind: 'export.cleanup', scope: 'instance', pool: 'maintenance', serial: false, priority: -5 },
  { kind: 'retention.sweep', scope: 'instance', pool: 'maintenance', serial: true, priority: -5 },
  { kind: 'group.purge', scope: 'instance', pool: 'maintenance', serial: true, priority: -5 },
  {
    kind: 'privacy.erase_person',
    scope: 'instance',
    pool: 'maintenance',
    serial: true,
    priority: -5,
  },
  { kind: 'blob.gc', scope: 'instance', pool: 'maintenance', serial: true, priority: -5 },
  { kind: 'blob.rewrap', scope: 'instance', pool: 'maintenance', serial: true, priority: -5 },
  { kind: 'search.verify', scope: 'instance', pool: 'maintenance', serial: false, priority: -5 },
  {
    kind: 'maintenance.fts_optimize',
    scope: 'instance',
    pool: 'maintenance',
    serial: false,
    priority: -5,
  },
  {
    kind: 'maintenance.labels_gc',
    scope: 'instance',
    pool: 'maintenance',
    serial: false,
    priority: -5,
  },
  {
    kind: 'maintenance.vec_reconcile',
    scope: 'instance',
    pool: 'maintenance',
    serial: false,
    priority: -5,
  },
  {
    kind: 'maintenance.vec_drop_retired',
    scope: 'instance',
    pool: 'maintenance',
    serial: false,
    priority: -5,
  },
  { kind: 'backup.snapshot', scope: 'instance', pool: 'maintenance', serial: true, priority: -5 },
  { kind: 'backup.verify', scope: 'instance', pool: 'maintenance', serial: true, priority: -5 },
  // `02` §3.10.1 gives this one a 900 s timeout, so its lease has to be longer than the default.
  {
    kind: 'backup.offsite',
    scope: 'instance',
    pool: 'maintenance',
    serial: true,
    priority: -5,
    leaseMs: 1_200_000,
    timeoutMs: 900_000,
  },
];

const BY_KIND = new Map(JOB_KIND_CATALOG.map((spec) => [spec.kind, spec]));

/** The catalog as a lookup, for the registry and for `comvivo doctor --check jobs`. */
export function catalogEntry(kind: string): JobKindSpec | undefined {
  return BY_KIND.get(kind);
}

/**
 * The live registry: the catalog's metadata joined with each owner's payload schema.
 *
 * Built at boot by the subsystem that owns each kind. A kind nobody registered cannot be enqueued,
 * and a kind not in the catalog cannot be registered — the two checks together are what `02`
 * §3.10.1's "registry assertion at boot" means.
 */
export class JobKindRegistry {
  readonly #defs = new Map<string, JobKindDef<unknown>>();

  /**
   * Register a kind's definition.
   *
   * The limits come from the catalog, not from the caller: a kind's pool and seriality are `02`'s
   * to decide, and letting an owner override them would make the global concurrency budget a
   * suggestion. What the owner supplies is the payload schema, which is the part `02` does not know.
   */
  register<P>(kind: string, payload: z.ZodType<P>): JobKindDef<P> {
    const spec = BY_KIND.get(kind);
    if (spec === undefined) {
      throw new StorageError('STORAGE_CONSTRAINT', `${kind} is not a job kind`, {
        hint: '`02` §3.10.1’s catalog is authoritative. Add the kind there, with its partition scope and pool, before registering it.',
        category: 'bug',
      });
    }
    if (this.#defs.has(kind)) {
      throw new StorageError('STORAGE_CONSTRAINT', `${kind} is already registered`, {
        hint: 'Two registrations mean two payload schemas for one kind, and the second would silently win.',
        category: 'bug',
      });
    }
    const leaseMs = spec.leaseMs ?? DEFAULT_LEASE_MS;
    const def: JobKindDef<P> = {
      kind,
      payload,
      serial: spec.serial,
      singleFlightByKey: spec.singleFlightByKey,
      concurrency: spec.concurrency ?? 1,
      pool: spec.pool,
      leaseMs,
      timeoutMs: spec.timeoutMs ?? Math.floor(leaseMs * TIMEOUT_RATIO),
      maxAttempts: spec.maxAttempts ?? JOB_BACKOFF.maxAttempts,
      backoff: { baseMs: JOB_BACKOFF.baseMs, capMs: JOB_BACKOFF.capMs },
      priority: spec.priority ?? 0,
    };
    this.#defs.set(kind, def);
    return def;
  }

  def(kind: string): JobKindDef<unknown> | undefined {
    return this.#defs.get(kind);
  }

  /** Every registered kind in a pool, which is what the worker loop claims by. */
  kindsInPool(pool: JobPool): readonly string[] {
    return [...this.#defs.values()]
      .filter((def) => def.pool === pool)
      .map((def) => def.kind)
      .toSorted();
  }

  registered(): readonly string[] {
    return [...this.#defs.keys()].toSorted();
  }

  /**
   * `02` §3.10.1's boot assertion, in the direction that catches a missing handler.
   *
   * Returns the catalog kinds nobody registered. Not a throw: `M1` registers none of them, and a
   * boot that refused to start until every one of forty kinds had an owner would make the queue
   * unusable until `M11`. `apps/server` reports the list at boot and `comvivo doctor --check jobs`
   * shows it, so a kind whose owner forgot to register it is visible rather than silent.
   */
  unregistered(): readonly string[] {
    return JOB_KIND_CATALOG.filter((spec) => !this.#defs.has(spec.kind))
      .map((spec) => spec.kind)
      .toSorted();
  }
}

/**
 * Check a partition key against the kind's scope (`02` §3.10.1's `G` / `I`).
 *
 * Both directions are mistakes with consequences. A group-scoped kind on `'_instance'` would make
 * every group's work serialise against one partition — so one group's backlog would stall the
 * host. An instance kind enqueued per group would run the nightly backup once per group.
 */
export function assertPartition(def: JobKindDef<unknown>, partitionKey: PartitionKey): void {
  const spec = BY_KIND.get(def.kind);
  if (spec === undefined) return;
  const isInstance = partitionKey === INSTANCE_PARTITION;
  if (spec.scope === 'instance' && !isInstance) {
    throw new StorageError(
      'STORAGE_CONSTRAINT',
      `${def.kind} is an instance kind and cannot be enqueued for a group`,
      {
        hint: `Enqueue it on '${INSTANCE_PARTITION}'. \`02\` §3.10.1 marks it \`I\`, and a per-group copy would run the host's work once per group.`,
        category: 'bug',
      },
    );
  }
  if (spec.scope === 'group' && (isInstance || !isId('grp', partitionKey))) {
    throw new StorageError(
      'STORAGE_CONSTRAINT',
      `${def.kind} is a group kind and needs a group's partition key`,
      {
        hint: '`02` §3.10.1 marks it `G`. On the instance partition it would serialise every group against one key.',
        category: 'bug',
      },
    );
  }
}
