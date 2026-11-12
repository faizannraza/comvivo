/**
 * Audit decision and detail payloads (`02` §3.3.7, `03` §Audit).
 *
 * `02` §3.3.9 states the rule these two schemas exist to enforce: audit details hold
 * **"ids/enums only, NEVER content"**. `audit_events` is hash-chained and append-only, retained
 * through erasure (`02` §3.13.5 step 8) on the explicit grounds that its ids carry no personal
 * data once `persons` is erased. A free-text field here would break that reasoning — the chain
 * cannot be rewritten, so content written into it could never be removed.
 */
import { capped, z } from '@comvivo/shared';
import { PolicyReasonSchema } from '../governance/policy.js';

/** `02` §3.3.9: the audit columns are capped at 4 KiB. */
const AUDIT_JSON_MAX_BYTES = 4 * 1024;

/** `audit_events.decision`: what the policy engine concluded, in its own vocabulary. */
export const AuditDecisionSchema = capped(
  z.object({
    outcome: z.enum(['allow', 'deny', 'needs_confirmation', 'not_applicable']),
    /** `null` for an allow; a closed enum otherwise, never a sentence. */
    reason: PolicyReasonSchema.nullable(),
    /** Which capability was being exercised, e.g. `calendar.write`. */
    capability: z.string().max(80).nullable(),
    /** The constitution version the decision was made under. */
    constitutionVersionId: z.string().max(40).nullable(),
  }),
  AUDIT_JSON_MAX_BYTES,
  'audit decision',
);

export type AuditDecision = z.infer<typeof AuditDecisionSchema>;

/**
 * `audit_events.details`: ids, enums and counts. No free text.
 *
 * The value union is deliberately narrow. A `string` is permitted because ids and enum tokens are
 * strings, and it is bounded at 120 characters — long enough for a TypeID or a capability name,
 * far too short for a message. That bound is the enforcement: it makes the column structurally
 * unable to hold a sentence, rather than relying on every call site to remember the rule.
 */
export const AuditDetailsSchema = capped(
  z.record(z.string().max(60), z.union([z.string().max(120), z.number(), z.boolean(), z.null()])),
  AUDIT_JSON_MAX_BYTES,
  'audit details',
);

export type AuditDetails = z.infer<typeof AuditDetailsSchema>;
