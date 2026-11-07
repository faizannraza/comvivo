/**
 * Turn journal payloads (`02` §3.3.7; `05` §3.3).
 */
import { capped, idSchema, z } from '@comvivo/shared';

/** `02` §3.3.9 gives `turns.failure` no byte cap; the field bounds are the bound. */
const TURN_JSON_MAX_BYTES = 4 * 1024;

/**
 * `turns.failure`: why a turn did not complete.
 *
 * `retryable` is stored rather than derived for the same reason as `ErrorInfo`'s: the code that
 * saw the failure knew whether it could be retried, and the recovery pass that reads this row
 * (`05` S1) no longer does. `phase` is kept because a turn that died while *committing* needs a
 * different recovery than one that died building context — the first may have external effects
 * journaled as intent (`01` §14 A23), the second cannot.
 */
export const TurnFailureSchema = capped(
  z.object({
    code: z.string().min(1).max(80),
    /** Bounded, and never the model's text or the user's: `01` §11.7. */
    message: z.string().max(500),
    /** Where it died, which decides what recovery has to check. */
    phase: z.enum(['building_context', 'model_step', 'tools', 'guarding', 'committing']).nullable(),
    retryable: z.boolean(),
    at: z.iso.datetime({ offset: true }),
  }),
  TURN_JSON_MAX_BYTES,
  'turn failure',
);

export type TurnFailure = z.infer<typeof TurnFailureSchema>;

/**
 * `turn_effects.summary_params` (`02` §3.3.9: `Record<string, string | number | boolean>`, ≤ 20).
 *
 * The parameters of `summary_key`'s template — "added *Soccer practice* to the calendar" is a key
 * plus `{title}`. Typed and bounded rather than free-form because an effect summary is replayed
 * into an acknowledgement message, and `05`'s acknowledged-effects invariant (**I7**) means that
 * message must say what actually happened, in the product's words.
 */
export const EffectSummaryParamsSchema = capped(
  z
    .record(z.string().max(60), z.union([z.string().max(300), z.number(), z.boolean()]))
    .refine(
      (params) => Object.keys(params).length <= 20,
      'an effect summary takes at most 20 parameters',
    ),
  TURN_JSON_MAX_BYTES,
  'effect summary params',
);

export type EffectSummaryParams = z.infer<typeof EffectSummaryParamsSchema>;

/**
 * `outbox_messages.parts` (`02` §3.3.5, `06`): what was actually sent, part by part.
 *
 * A long reply is split across several platform messages, and this records each one as it lands.
 * `possibleDuplicate` is the honest flag for the case that cannot be resolved: the send timed out,
 * so the platform may or may not have delivered it. `06` sets it, the recovery pass reads it, and
 * the alternative — assuming either outcome — breaks exactly-once in one direction or the other.
 */
export const OutboxPartsSchema = z
  .array(
    z.object({
      index: z.int().min(0).max(100),
      platformMessageId: z.string().max(200).nullable(),
      sentAt: z.iso.datetime({ offset: true }).nullable(),
      /** The send timed out; delivery is unknown. */
      possibleDuplicate: z.boolean().optional(),
    }),
  )
  .max(101);

export type OutboxParts = z.infer<typeof OutboxPartsSchema>;

/** `turns.trigger_message_ids` (`02` §3.3.9: `MessageId[] ≤ 50`). */
export const TriggerMessageIdsSchema = z.array(idSchema('msg')).max(50);
