/**
 * Policy reasons and the compiled constitution (`03` §3.2, §3.3).
 */
import { z } from '@comvivo/shared';
import { jsonObjectShape, storageContract } from '../domain/storage-contract.js';

/**
 * `03` §1207: why an action was denied or needs confirmation.
 *
 * A closed enum, not a message. `03` pairs each code with `DENY_COPY_EN`, so the user-facing
 * sentence is a template lookup and the stored reason is a token — which is what lets
 * `confirmation_requests.reasons` and `audit_events.decision` record *why* without putting model
 * or user text into a column (`02` §3.3.9: audit details hold "ids/enums only, NEVER content").
 */
export const PolicyReasonSchema = z.enum([
  'wrong_group',
  'not_a_member',
  'member_inactive',
  'host_not_group_principal',
  'capability_missing',
  'floor_violation',
  'last_admin',
  'system_not_preauthorized',
  'proposal_not_passed',
  'deferred_intent_revoked',
  'flow_violation',
  'declassification_required',
  'cross_group',
  'untrusted_context',
  'untrusted_context_high_risk',
  'high_risk',
  'guardian_approval_required',
  'claimed_authorization',
  'owner_approval_required',
  'role_precedence',
  'contested_vote',
  'contested_consensus',
  'target_missing',
  'target_stale',
  'rate_limited',
  'plugin_not_approved',
]);

export type PolicyReason = z.infer<typeof PolicyReasonSchema>;

/**
 * `constitution_versions.compiled` — a **storage contract** (see `domain/storage-contract.ts`).
 *
 * `CompiledPolicy` is the output of `03` §3.2.6's constitution compiler, which `M4` builds. `02`
 * pins two things about the column and this schema enforces both: it holds a JSON **object**, and
 * it is capped at 256 KiB. The interior — roles, capability grants, conflict strategies, the
 * matcher tables `authorize()` evaluates — is `M4`'s to define, with `03`'s own compiler tests.
 */
export const CompiledPolicySchema = storageContract(
  'CompiledPolicySchema',
  jsonObjectShape,
  'compiled policy',
);
