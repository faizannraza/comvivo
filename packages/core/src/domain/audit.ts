/**
 * `AuditActor` — who caused a recorded effect (`02` §3.3.6, §3.3.8; `03` §Audit).
 *
 * `02` §3.3.6 gives the shape inline: `{kind:'member',memberId} | {kind:'system'} | {kind:'host'}`.
 * The three arms are a real distinction rather than a tidy enum, and `08`'s audit story depends on
 * it:
 *
 *  - **`member`** — a person in the group asked for this. It is attributable, and it is the only
 *    arm that carries an id, so an erasure can find every row about a person (`02` §3.13.5 step 8
 *    keeps these rows precisely because the id carries no content once `persons` is erased).
 *  - **`system`** — the product did it on its own: a retention sweep, a scheduled digest, a
 *    consolidation job. No one to attribute it to, and nothing to ask.
 *  - **`host`** — whoever runs the server did it from outside the group's own governance: a CLI
 *    command, a `doctor` repair, a settings change in the dashboard's instance scope. Separate
 *    from `system` because a host action is a *human* acting with authority the constitution does
 *    not grant, which is the one case an audit reader most needs to see.
 *
 * This is the schema for `audit_events.actor`, `memory_events.actor` and `deletions.requested_by`.
 */
import { capped, idSchema, type MemberId, z } from '@comvivo/shared';

/** Who caused a recorded effect. Only `member` is attributable to a person. */
export type AuditActor =
  | { kind: 'member'; memberId: MemberId }
  | { kind: 'system' }
  | { kind: 'host' };

/** `02` §3.3.9: `audit_events.actor` and its siblings are capped at 4 KiB. */
export const AUDIT_ACTOR_MAX_BYTES = 4 * 1024;

export const AuditActorSchema = capped(
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('member'), memberId: idSchema('mbr') }),
    z.object({ kind: z.literal('system') }),
    z.object({ kind: z.literal('host') }),
  ]),
  AUDIT_ACTOR_MAX_BYTES,
  'audit actor',
);
