/**
 * Schemas whose **interior** belongs to a later milestone.
 *
 * `M1-T12` declares every JSON column of `02` §3.3.4–§3.3.8. Most of their schemas are fully
 * specified somewhere and are transcribed in full. A handful are not, and for a specific reason:
 * their interior *is* the core deliverable of a task that is already scheduled with its own
 * acceptance criteria — `CompiledPolicy` is what `M4`'s constitution compiler produces, the
 * constraint value catalog is `M5-T7` ("one file per kind, envelope, `CONSTRAINT_KINDS_V1`,
 * `render.ts`, `validate.ts`", with `declassify.prop.closed_schema` to prove it), the turn-trace
 * internals are `M5`'s, and `OutboundPayload` is `M3`'s.
 *
 * Writing those interiors here would duplicate work those tasks will redo under their own tests,
 * and would front-load design their specs still refine. Leaving the columns as `z.unknown()` is
 * the other extreme and the worse one: `jsonOf` validates on **read** as well as write, so an
 * unvalidated column cannot report corruption, and an **uncapped** one is a column that can be
 * grown until it breaks a context window or a backup.
 *
 * So each of these is a *storage contract*: the tightest outer shape its spec pins, plus the
 * `02` §3.3.9 byte cap, declared in {@link DEFERRED_INTERIORS} below.
 *
 * ## Why the inventory is a literal and not a side-effect registry
 *
 * The first version collected entries as the modules were imported, which made
 * `storageContracts()` depend on import order — a test that imported only this module saw an empty
 * list, and would have passed an assertion about "no deferred interiors". A static literal is the
 * inventory; `storageContract()` looks its caller up in it and throws if the name is absent, so a
 * schema cannot quietly opt out and the caps have one source of truth.
 */
import { capped, z } from '@comvivo/shared';

/** One JSON column schema whose interior a later task will tighten. */
export interface StorageContract {
  /** The schema's exported name, e.g. `CompiledPolicySchema`. */
  readonly name: string;
  /** The task that owns the interior, e.g. `M5-T7`. */
  readonly owner: string;
  /** The `02` §3.3.9 cap this already enforces, in bytes. */
  readonly maxBytes: number;
  /** What the outer shape pins today. */
  readonly pinned: string;
}

const KIB = 1024;

/**
 * Every schema still carrying a deferred interior.
 *
 * Sorted by name, and asserted verbatim by `storage-contract.test.ts` — so this list appears in
 * the milestone report, cannot grow silently, and fails the suite when a milestone tightens one
 * and forgets to remove it.
 */
export const DEFERRED_INTERIORS = [
  {
    name: 'ActionRequestSnapshotSchema',
    owner: 'M5 (05 §3.6.6 ActionRequest)',
    maxBytes: 16 * KIB,
    pinned: 'a JSON object, capped at 16 KiB',
  },
  {
    name: 'CompiledPolicySchema',
    owner: 'M4 (03 §3.2.6 constitution compiler)',
    maxBytes: 256 * KIB,
    pinned: 'a JSON object, capped at 256 KiB',
  },
  {
    name: 'ConstraintValueSchema',
    owner: 'M5-T7 (03 §3.5.4 constraint catalog v1)',
    maxBytes: 16 * KIB,
    pinned: 'a JSON object, capped at 16 KiB; dispatched on the `kind` column',
  },
  {
    name: 'GuardResultTraceSchema',
    owner: 'M5 (05 §3.8 disclosure guard records)',
    maxBytes: 128 * KIB,
    pinned: 'a JSON object; the column holds at most 50, capped at 128 KiB',
  },
  {
    name: 'ModelCallTraceSchema',
    owner: 'M5 (05 §3.10 model call trace)',
    maxBytes: 128 * KIB,
    pinned: 'a JSON object; the column holds at most 50, capped at 128 KiB',
  },
  {
    name: 'OutboundPayloadSchema',
    owner: 'M3 (06 §8 OutboundMessage and its channel-SDK member types)',
    maxBytes: 64 * KIB,
    pinned: 'a JSON object, capped at 64 KiB',
  },
  {
    name: 'PolicyDecisionTraceSchema',
    owner: 'M4 (03 §3.3 authorize() decision trace)',
    maxBytes: 128 * KIB,
    pinned: 'a JSON object; the column holds at most 100, capped at 128 KiB',
  },
  {
    name: 'ProposalPayloadSchema',
    owner: 'M4 (03 §3.3.6 amendment and contested-action payloads)',
    maxBytes: 64 * KIB,
    pinned: 'a JSON object, capped at 64 KiB',
  },
  {
    name: 'ToolCallTraceSchema',
    owner: 'M5 (05 §3.6 tool call trace)',
    maxBytes: 128 * KIB,
    pinned: 'a JSON object; the column holds at most 100, capped at 128 KiB',
  },
  {
    name: 'TraceTriggerSchema',
    owner: 'M5 (05 §3.2 router trigger classification)',
    maxBytes: 128 * KIB,
    pinned: 'a JSON object, capped at 128 KiB',
  },
] as const satisfies readonly StorageContract[];

/** The deferred-interior inventory, independent of which modules have been imported. */
export function storageContracts(): readonly StorageContract[] {
  return DEFERRED_INTERIORS;
}

/**
 * Wrap `shape` with the cap {@link DEFERRED_INTERIORS} records for `name`.
 *
 * Throws when `name` is not in the inventory, which is what makes the list authoritative: a new
 * deferred schema has to be declared above before it can exist, and the throw happens at module
 * load so it cannot be missed.
 *
 * @param shape the tightest outer shape the spec pins — never `z.unknown()`
 */
export function storageContract<S extends z.ZodType>(name: string, shape: S, what: string): S {
  const entry = DEFERRED_INTERIORS.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(
      `${name} is not in DEFERRED_INTERIORS. Add it there, with the task that owns its interior, ` +
        'so the deferred set stays reviewable.',
    );
  }
  return capped(shape, entry.maxBytes, what);
}

/**
 * A JSON object of bounded size: the weakest outer shape used here, and still not nothing.
 *
 * It refuses a scalar, a string, `null` and an array — so a column holding one of those is caught
 * as corruption on read rather than handed to a caller that expects an object.
 */
export const jsonObjectShape = z.record(z.string().max(120), z.unknown());
