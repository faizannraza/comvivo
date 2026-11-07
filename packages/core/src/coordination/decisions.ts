/**
 * Decision JSON columns (`02` §3.3.5; `07` §3.6, `03` §3.9).
 */
import { idSchema, z } from '@comvivo/shared';

/**
 * `decisions.decided_by` (`02` §3.3.9): the rule that settled it, and who took part.
 *
 * `rule` is `03`'s `ConflictStrategy` plus `informal`, and the extra value is the point: most group
 * decisions are not votes. "We agreed in chat" is `informal`, and recording it as `consensus`
 * would claim a process that did not happen — which matters because `03`'s amendment workflow
 * treats a recorded strategy as precedent.
 */
export const DecidedBySchema = z.object({
  rule: z.enum([
    'last_writer_with_notice',
    'ask_owner',
    'vote',
    'role_precedence',
    'consensus',
    'informal',
  ]),
  memberIds: z.array(idSchema('mbr')).max(64),
  /** Set when the decision came from a poll close (`07` §3.5.3). */
  pollId: idSchema('pol').optional(),
});

export type DecidedBy = z.infer<typeof DecidedBySchema>;

/** `decisions.alternatives_rejected`: what was considered and why it lost. */
export const DecisionAlternativesSchema = z
  .array(
    z.object({
      option: z.string().min(1).max(120),
      reason: z.string().max(200).nullable(),
    }),
  )
  .max(8);

export type DecisionAlternatives = z.infer<typeof DecisionAlternativesSchema>;

/**
 * `decisions.source_refs` (`07` §1334): the messages a decision was read from.
 *
 * `excerptHash` rather than the excerpt. `07` §1334 is explicit that excerpts are **re-read from
 * the message at render time**, so an expired message shows "source expired" instead of the
 * product keeping a private copy of text the platform was asked to forget. The hash is what
 * confirms the message still says what the citation claims.
 */
export const DecisionSourceRefsSchema = z
  .array(
    z.object({
      messageId: idSchema('msg'),
      /** The platform's own reference, for a permalink. */
      platformMessageRef: z.string().max(200).nullable(),
      authorMemberId: idSchema('mbr').nullable(),
      sentAt: z.iso.datetime({ offset: true }),
      /** Confirms the re-read excerpt is the one cited; never the excerpt itself. */
      excerptHash: z.string().max(64),
    }),
  )
  .max(20);

export type DecisionSourceRefs = z.infer<typeof DecisionSourceRefsSchema>;
