/**
 * Confirmation requests (`03` §3.3.12, `05` §3.6.6).
 */
import { capped, idSchema, z } from '@comvivo/shared';
import { EntityRefSchema } from '../domain/entity-ref.js';
import { jsonObjectShape, storageContract } from '../domain/storage-contract.js';

/** `02` §3.3.9: the `03`-owned confirmation columns are capped at 16 KiB. */
const CONFIRMATION_JSON_MAX_BYTES = 16 * 1024;

/**
 * `confirmation_requests.summary` (`03` §1596): a template key plus typed parameters.
 *
 * **Never free model text**, and that is the point of the type. A confirmation prompt is the one
 * message where a user is being asked to authorise something, so it must say what will happen in
 * the product's own words — a model-generated summary is exactly where an injected instruction
 * would try to describe a different action than the one about to run.
 *
 * `02` `CLAUDE.md` §2's "copy is product" rule has the same shape: the key refers to a versioned
 * template file, and the params are ids and formatted values.
 */
export const CopyRefSchema = capped(
  z.object({
    /** A key into a versioned copy file, e.g. `confirm.calendar.delete`. */
    key: z.string().min(1).max(120),
    /** Typed params only: entity refs and formatted values, never a sentence from a model. */
    params: z.record(
      z.string().max(60),
      z.union([z.string().max(300), z.number(), z.boolean(), EntityRefSchema]),
    ),
  }),
  CONFIRMATION_JSON_MAX_BYTES,
  'copy ref',
);

export type CopyRef = z.infer<typeof CopyRefSchema>;

/** `confirmation_requests.responses` (`03` §1603): who answered, how, and through what surface. */
export const ConfirmationResponseSchema = z.object({
  memberId: idSchema('mbr'),
  option: z.enum(['approve', 'reject', 'approve_always', 'edit']),
  via: z.enum(['button', 'reaction', 'text', 'dashboard']),
  at: z.iso.datetime({ offset: true }),
});

export type ConfirmationResponse = z.infer<typeof ConfirmationResponseSchema>;

/**
 * `confirmation_requests.action_request` — a **storage contract**.
 *
 * The snapshot of the action awaiting approval, so a resume replays *what was agreed to* rather
 * than re-deriving it from a conversation that has moved on. Its shape is `05` §3.6.6's
 * `ActionRequest`, which `M5` defines; the tool input itself is already stored separately and
 * encrypted in `input_ciphertext`. Pinned here: a JSON object capped at 16 KiB.
 */
export const ActionRequestSnapshotSchema = storageContract(
  'ActionRequestSnapshotSchema',
  jsonObjectShape,
  'action request snapshot',
);
